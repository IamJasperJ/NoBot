import type { BookmarkDTO, MessageDTO } from '@nobot/shared'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client'
import { keys, replaceMessage } from '../../api/queries'
import type { useMessageTranslation, useTranslationView } from '../../api/translation'
import {
  BookmarkIcon,
  BranchIcon,
  ChevronRightIcon,
  CopyIcon,
  DotsIcon,
  EditIcon,
  EyeIcon,
  EyeOffIcon,
  ListCheckIcon,
  LogIcon,
  RefreshIcon,
  TranslateIcon,
  TrashIcon,
} from '../../components/icons'
import { IconButton } from '../../components/ui'
import { Slot } from '../../extensions/Slot'
import { t } from '../../i18n'
import { useChatOps } from '../../stores/chatOps'
import { errorMessage, toast } from '../../stores/toast'
import { useUi } from '../../stores/ui'
import type { runGeneration } from './generate'
import { deleteMessage, MenuItem } from './MessageParts'

interface Props {
  msg: MessageDTO
  chatId: string
  busy: boolean
  /** 最后一条角色回复：可以重新生成、续写 */
  canRegenerate: boolean
  bookmark: BookmarkDTO | undefined
  translateEnabled: boolean
  translation: ReturnType<typeof useMessageTranslation>
  view: ReturnType<typeof useTranslationView>
  onEdit: () => void
  onRun: (input: Parameters<typeof runGeneration>[2]) => void
}

/** 消息右上角的操作：编辑、重新生成，以及「⋯」菜单。鼠标移上来才显示；触屏设备上一直显示 */
export function MessageActions({
  msg,
  chatId,
  busy,
  canRegenerate,
  bookmark,
  translateEnabled,
  translation,
  view,
  onEdit,
  onRun,
}: Props) {
  const qc = useQueryClient()

  const setExcluded = async (excluded: boolean) => {
    try {
      for (const m of await api.excludeMessages(chatId, [msg.id], excluded)) replaceMessage(qc, chatId, m)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const toggleBookmark = async () => {
    try {
      if (bookmark) {
        await api.deleteBookmark(bookmark.id)
        toast.info(t('已移除书签'))
      } else {
        const created = await api.createBookmark(chatId, msg.id)
        toast.info(t('已加书签「{name}」', { name: created.name }))
      }
      await qc.invalidateQueries({ queryKey: keys.bookmarks(chatId) })
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const branch = async () => {
    try {
      const chat = await api.branch(chatId, msg.id)
      const owner = chat.groupId ? { groupId: chat.groupId } : { characterId: chat.characterId as string }
      await qc.invalidateQueries({ queryKey: keys.chats(owner) })
      useUi.getState().openChat(owner, chat.id)
      toast.info(t('已创建分支会话'))
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  return (
    <div className="ml-auto flex items-center opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:has-[details[open]]:opacity-100">
      <IconButton label={t('编辑')} onClick={onEdit} disabled={busy}>
        <EditIcon />
      </IconButton>
      {canRegenerate && (
        <IconButton
          label={t('重新生成')}
          onClick={() => onRun({ mode: 'regenerate', targetId: msg.id })}
          disabled={busy}
        >
          <RefreshIcon />
        </IconButton>
      )}
      <details className="message-actions relative">
        <summary className="list-none">
          <span className="inline-flex size-8 cursor-pointer items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-800">
            <DotsIcon />
          </span>
        </summary>
        <div className="absolute right-0 z-20 mt-1 w-44 rounded-lg border border-zinc-200 bg-white py-1 text-sm shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
          {canRegenerate && (
            <MenuItem
              icon={<ChevronRightIcon />}
              label={t('续写')}
              disabled={busy}
              onClick={() => onRun({ mode: 'continue', targetId: msg.id })}
            />
          )}
          <MenuItem icon={<BranchIcon />} label={t('从这里开分支')} disabled={busy} onClick={branch} />
          <MenuItem
            icon={msg.meta.excluded ? <EyeIcon /> : <EyeOffIcon />}
            label={msg.meta.excluded ? t('恢复发送') : t('不发给模型')}
            onClick={() => void setExcluded(!msg.meta.excluded)}
          />
          <MenuItem
            icon={<BookmarkIcon />}
            label={bookmark ? t('移除书签') : t('加书签')}
            onClick={() => void toggleBookmark()}
          />
          <MenuItem
            icon={<ListCheckIcon />}
            label={t('多选…')}
            onClick={() => useChatOps.getState().startSelect(chatId, msg.id)}
          />
          {translateEnabled && msg.content.trim() && (
            <MenuItem
              icon={<TranslateIcon />}
              label={view.hasTranslation ? t('重新翻译') : t('翻译')}
              disabled={translation.busy}
              onClick={() => void translation.translate().catch((e: unknown) => toast.error(errorMessage(e)))}
            />
          )}
          {translateEnabled && view.hasTranslation && (
            <MenuItem
              icon={<TranslateIcon />}
              label={msg.meta.translation?.direction === 'source' ? t('撤销翻译（恢复原文发送）') : t('移除译文')}
              disabled={translation.busy}
              onClick={() => void translation.remove().catch((e: unknown) => toast.error(errorMessage(e)))}
            />
          )}
          <MenuItem
            icon={<CopyIcon />}
            label={t('复制文本')}
            onClick={() =>
              // 浏览器不给剪贴板权限时会拒绝，提示原因而不是留下未捕获的异常
              void navigator.clipboard.writeText(msg.content).then(
                () => toast.info(t('已复制')),
                (e: unknown) => toast.error(errorMessage(e)),
              )
            }
          />
          {msg.meta.logId && (
            <MenuItem
              icon={<LogIcon />}
              label={t('查看请求')}
              onClick={() => useUi.getState().openView('logs', msg.meta.logId)}
            />
          )}
          <Slot name="chat.message.actions" props={{ chatId, message: msg }} />
          <MenuItem
            icon={<TrashIcon />}
            label={t('删除')}
            danger
            disabled={busy}
            onClick={() => void deleteMessage(qc, chatId, msg.id)}
          />
        </div>
      </details>
    </div>
  )
}
