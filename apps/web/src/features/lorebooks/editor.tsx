import { type RefObject, useEffect } from 'react'
import { Button } from '../../components/ui'
import { t } from '../../i18n'

export type LeaveGuard = RefObject<() => boolean>

export const isDifferent = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b)

export function useLeaveGuard(guard: LeaveGuard, dirty: boolean, pending: boolean) {
  useEffect(() => {
    guard.current = () => !pending && (!dirty || confirm(t('有未保存的修改，确定放弃这些修改吗？')))
    return () => {
      guard.current = () => true
    }
  }, [guard, dirty, pending])
  useEffect(() => {
    if (!dirty) return
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', prevent)
    return () => window.removeEventListener('beforeunload', prevent)
  }, [dirty])
}

export function SaveActions({
  dirty,
  pending,
  save,
  reset,
}: {
  dirty: boolean
  pending: boolean
  save: () => void
  reset: () => void
}) {
  return (
    <div className="flex shrink-0 gap-1">
      <Button variant="primary" disabled={!dirty || pending} onClick={save}>
        {t('保存')}
      </Button>
      <Button disabled={!dirty || pending} onClick={reset}>
        {t('撤销修改')}
      </Button>
    </div>
  )
}
