import { toDisplayText } from '@nobot/core/stage'
import type { MessageDTO, PlayPresetData } from '@nobot/shared'
import { useEffect, useRef } from 'react'
import { RefreshIcon, XIcon } from '../../components/icons'
import { cx } from '../../components/ui'
import { t } from '../../i18n'
import type { ChatCast } from '../chat/MessageItem'

/** 回想：最近的对话记录（去掉指令后的文字），角色回复可以「从这里重演」 */
export function VnBacklog({
  messages,
  play,
  cast,
  currentId,
  onReplay,
  onClose,
}: {
  messages: MessageDTO[]
  play: PlayPresetData
  cast: ChatCast
  currentId: string | null
  onReplay: (id: string) => void
  onClose: () => void
}) {
  const knownNames = cast.stage?.knownNames ?? []
  const list = messages.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-60)
  // 打开时停在最新的记录（像 VN 的回想一样从下往上翻）
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [])
  return (
    <div className="absolute inset-0 z-30 flex justify-end">
      {/* 点抽屉外面的暗处关闭 */}
      <button type="button" aria-label={t('关闭回想')} className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div role="dialog" aria-label={t('回想')} className="vn-backlog relative flex h-full w-full max-w-xl flex-col">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-white/10 px-4">
          <h2 className="flex-1 font-semibold">{t('回想')}</h2>
          <button
            type="button"
            aria-label={t('关闭回想')}
            className="vn-chip flex size-8 items-center justify-center rounded-full"
            onClick={onClose}
          >
            <XIcon className="size-4" />
          </button>
        </div>
        <div ref={scroller} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 select-text">
          {list.map((m) => {
            const user = m.role === 'user'
            const name = user ? cast.user.name : (m.speakerId && cast.speakers[m.speakerId]?.name) || m.meta.name || ''
            const body = user
              ? m.content
              : toDisplayText(m.content, {
                  knownNames,
                  narratorNames: play.trpg.gmName ? [play.trpg.gmName] : [],
                  speaker: 'plain',
                })
            return (
              <div key={m.id} className={cx('rounded-xl p-3', m.id === currentId ? 'bg-white/15' : 'bg-white/5')}>
                <div className="mb-1 flex items-center gap-2 text-xs opacity-70">
                  <span className="font-semibold">{name}</span>
                  {!user && (
                    <button
                      type="button"
                      className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-white/10"
                      onClick={() => onReplay(m.id)}
                    >
                      <RefreshIcon className="size-3" />
                      {t('从这里重演')}
                    </button>
                  )}
                </div>
                <p className="text-sm leading-relaxed whitespace-pre-wrap">{body || t('（图片或空内容）')}</p>
              </div>
            )
          })}
          {list.length === 0 && <p className="text-sm opacity-60">{t('还没有对话。')}</p>}
        </div>
      </div>
    </div>
  )
}
