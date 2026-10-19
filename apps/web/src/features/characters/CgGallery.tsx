import type { CharacterCgDTO } from '@nobot/shared'
import { useState } from 'react'
import { useCharacterCgs, useSetAttachmentCg } from '../../api/queries'
import { Section } from '../../components/form'
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from '../../components/icons'
import { Button, Dialog, IconButton } from '../../components/ui'
import { getLanguage, t } from '../../i18n'
import { useChatOps } from '../../stores/chatOps'
import { errorMessage, toast } from '../../stores/toast'
import { useUi } from '../../stores/ui'

/**
 * CG 画廊：这个角色所有会话里标记为 CG 的图片（舞台指令 <cg> 画的会自动标记，聊天里的图片也可以手动标记）。
 * 点开大图，可以左右翻、跳到所在会话、取消标记
 */
export function CgGallery({ characterId }: { characterId: string }) {
  const openChat = useUi((s) => s.openChat)
  const cgs = useCharacterCgs(characterId)
  const setCg = useSetAttachmentCg()
  const [opened, setOpened] = useState<number | null>(null)
  const list = cgs.data ?? []
  const current: CharacterCgDTO | undefined = opened === null ? undefined : list[opened]

  return (
    <Section
      title={t('CG 画廊')}
      description={t('舞台指令画的 CG 会自动收进来；聊天里的图片在图片菜单里也能「收进 CG 画廊」')}
      defaultOpen={false}
    >
      {cgs.isPending ? (
        <p className="text-sm text-zinc-500">{t('加载中…')}</p>
      ) : cgs.isError ? (
        <p className="text-sm text-red-600">{errorMessage(cgs.error)}</p>
      ) : list.length === 0 ? (
        <p className="py-4 text-center text-sm text-zinc-400">{t('还没有 CG')}</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-2">
          {list.map((cg, i) => (
            <button
              key={cg.id}
              type="button"
              onClick={() => setOpened(i)}
              className="group overflow-hidden rounded-lg bg-zinc-100 ring-2 ring-transparent ring-offset-2 ring-offset-white hover:ring-zinc-200 dark:bg-zinc-800 dark:ring-offset-zinc-950 dark:hover:ring-zinc-700"
            >
              <img src={cg.url} alt="" loading="lazy" className="aspect-video w-full object-cover" />
            </button>
          ))}
        </div>
      )}
      <Dialog open={!!current} onClose={() => setOpened(null)} title={t('CG')} className="max-w-4xl">
        {current && opened !== null && (
          <div className="space-y-3">
            <div className="relative overflow-hidden rounded-lg bg-black">
              <img src={current.url} alt="" className="max-h-[70vh] w-full object-contain" />
              {opened > 0 && (
                <IconButton
                  label={t('上一张')}
                  className="absolute top-1/2 left-2 -translate-y-1/2 bg-black/40 text-white hover:bg-black/60"
                  onClick={() => setOpened(opened - 1)}
                >
                  <ChevronLeftIcon />
                </IconButton>
              )}
              {opened < list.length - 1 && (
                <IconButton
                  label={t('下一张')}
                  className="absolute top-1/2 right-2 -translate-y-1/2 bg-black/40 text-white hover:bg-black/60"
                  onClick={() => setOpened(opened + 1)}
                >
                  <ChevronRightIcon />
                </IconButton>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="mr-auto text-xs text-zinc-500">
                {opened + 1} / {list.length} ·{' '}
                {new Date(current.createdAt).toLocaleString(getLanguage() === 'en' ? 'en-US' : 'zh-CN')}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setCg.mutate(
                    { id: current.id, isCg: false },
                    {
                      onSuccess: () => setOpened(null),
                      onError: (e) => toast.error(errorMessage(e)),
                    },
                  )
                }
              >
                <XIcon />
                {t('移出画廊')}
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  // 角色页在主区域；先切回聊天视图再打开会话，否则只是悄悄换了会话
                  useUi.getState().openView('chat')
                  openChat({ characterId }, current.chatId)
                  useChatOps.getState().jumpTo(current.chatId, current.messageId)
                  setOpened(null)
                }}
              >
                {t('打开所在会话')}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </Section>
  )
}
