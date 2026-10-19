import type { MessageDTO } from '@nobot/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { keys } from '../../api/queries'

export function useCgRefresh(chatId: string, message: MessageDTO | null | undefined) {
  const qc = useQueryClient()
  const pending = !!message?.meta.cg?.some((entry) => entry.status === 'pending')
  useEffect(() => {
    if (!pending) return
    const timer = setInterval(() => void qc.invalidateQueries({ queryKey: keys.chat(chatId) }), 2500)
    return () => clearInterval(timer)
  }, [pending, qc, chatId])
}
