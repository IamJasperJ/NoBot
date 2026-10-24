import type { MessageDTO, RoomDTO } from '@nobot/shared'
import { useDeleteRoomMessage, useSuggestRegenerate } from '../../api/rooms'
import { CopyIcon, EditIcon, RefreshIcon, TrashIcon } from '../../components/icons'
import { IconButton } from '../../components/ui'
import { t } from '../../i18n'
import { useRoomLive } from '../../stores/room'
import { errorMessage, toast } from '../../stores/toast'

const fail = (e: unknown) => toast.error(errorMessage(e))
// 选择器必须返回稳定引用：每次新建 [] 会让 React 认为状态一直在变而无限重渲染
const NONE: string[] = []

/**
 * 房间里非房主看到的消息操作（房主仍用完整的 MessageActions）：
 * 复制；自己还没被 AI 回应的发言可以改、撤回；最后一条 AI 回复可以「建议重新生成」（由房主 / 主持决定）。
 */
export function RoomMessageActions({
  room,
  msg,
  isLast,
  consumed,
  onEdit,
}: {
  room: RoomDTO
  msg: MessageDTO
  isLast: boolean
  /** 这条消息之后已经有 AI 回复了 */
  consumed: boolean
  onEdit: () => void
}) {
  const remove = useDeleteRoomMessage()
  const suggest = useSuggestRegenerate()
  const suggested = useRoomLive((s) => s.suggestions[room.id]?.[msg.id] ?? NONE)
  const mine = msg.role === 'user' && msg.meta.author?.userId === room.myUserId
  const editable = mine && !consumed
  const canSuggest = isLast && msg.role === 'assistant' && !room.permissions.canRegenerate
  return (
    <div className="ml-auto flex items-center opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100">
      <IconButton
        label={t('复制文本')}
        onClick={() =>
          void navigator.clipboard.writeText(msg.content).then(
            () => toast.info(t('已复制')),
            (e: unknown) => fail(e),
          )
        }
      >
        <CopyIcon />
      </IconButton>
      {editable && (
        <>
          <IconButton label={t('编辑')} onClick={onEdit}>
            <EditIcon />
          </IconButton>
          <IconButton
            label={t('撤回')}
            variant="danger"
            onClick={() =>
              void remove
                .mutateAsync({ id: room.id, messageId: msg.id })
                .then(() => toast.info(t('已撤回')))
                .catch(fail)
            }
          >
            <TrashIcon />
          </IconButton>
        </>
      )}
      {canSuggest && (
        <IconButton
          label={suggested.includes(room.myUserId) ? t('已建议重新生成') : t('建议重新生成（由房主或主持决定）')}
          disabled={suggested.includes(room.myUserId) || suggest.isPending}
          onClick={() =>
            void suggest
              .mutateAsync({ id: room.id, messageId: msg.id })
              .then(() => toast.info(t('已告诉房主你想换一个回复')))
              .catch(fail)
          }
        >
          <RefreshIcon />
        </IconButton>
      )}
    </div>
  )
}

/** 房主 / 主持在回复下方看到有几个人想换一个回复 */
export function SuggestionCount({ room, messageId }: { room: RoomDTO; messageId: string }) {
  const suggested = useRoomLive((s) => s.suggestions[room.id]?.[messageId] ?? NONE)
  if (!suggested.length || !room.permissions.canRegenerate) return null
  const names = suggested.map((id) => room.members.find((m) => m.userId === id)?.personaName ?? '?')
  return (
    <span
      title={t('{names} 建议重新生成', { names: names.join('、') })}
      className="rounded-md bg-violet-50 px-1.5 py-0.5 text-[11px] text-violet-700 dark:bg-violet-950/60 dark:text-violet-300"
    >
      {t('{count} 人想换一个', { count: suggested.length })}
    </span>
  )
}
