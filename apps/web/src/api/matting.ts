import type { MattingStatus } from '@nobot/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './client'

export const mattingStatusKey = ['matting-status'] as const

export function useMattingStatus(enabled: boolean) {
  return useQuery({
    queryKey: mattingStatusKey,
    enabled,
    queryFn: api.mattingStatus,
    refetchInterval: (query) => {
      const data = query.state.data
      return data?.runtime.state === 'installing' || data?.model.state === 'installing' ? 1000 : false
    },
  })
}

export function useInstallMatting() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.installMatting,
    onSuccess: (status: MattingStatus) => qc.setQueryData(mattingStatusKey, status),
  })
}

export function useRemoveMatting() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.removeMatting,
    onSuccess: (status: MattingStatus) => qc.setQueryData(mattingStatusKey, status),
  })
}
