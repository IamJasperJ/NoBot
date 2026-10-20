import type { TemporaryActorDTO } from '@nobot/shared'
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './client'
import { keys } from './queries'

export const temporaryActorsKey = (chatId: string) => ['temporaryActors', chatId] as const

function refreshStage(qc: QueryClient, chatId: string) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: keys.chat(chatId) }),
    qc.invalidateQueries({ queryKey: ['vn-stage', chatId] }),
  ])
}

export function useTemporaryActors(chatId: string) {
  const qc = useQueryClient()
  return useQuery({
    queryKey: temporaryActorsKey(chatId),
    enabled: !!chatId,
    queryFn: async () => {
      const previous = qc.getQueryData<TemporaryActorDTO[]>(temporaryActorsKey(chatId))
      const records = await api.listTemporaryActors(chatId)
      // 在查询完成时比较缓存，轮询和手动刷新都会触发舞台更新。
      if (
        previous?.some(
          (old) => old.status === 'pending' && records.find((record) => record.key === old.key)?.status !== 'pending',
        )
      ) {
        await refreshStage(qc, chatId)
      }
      return records
    },
    refetchInterval: (query) => (query.state.data?.some((record) => record.status === 'pending') ? 2000 : false),
  })
}

function refreshActors(qc: QueryClient, chatId: string, record?: TemporaryActorDTO) {
  // 先缓存 pending，后台任务即使在下一次列表请求前完成，也不会漏掉完成通知。
  if (record)
    qc.setQueryData<TemporaryActorDTO[]>(temporaryActorsKey(chatId), (old) => [
      record,
      ...(old ?? []).filter((item) => item.key !== record.key),
    ])
  return Promise.all([qc.invalidateQueries({ queryKey: temporaryActorsKey(chatId) }), refreshStage(qc, chatId)])
}

export function useRegenerateTemporaryActor() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.regenerateTemporaryActor,
    onSuccess: (record, input) => refreshActors(qc, input.chatId, record),
  })
}

export function useUploadTemporaryActor() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.uploadTemporaryActor,
    onSuccess: (record, input) => refreshActors(qc, input.chatId, record),
  })
}

export function useRemoveTemporaryActor() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.removeTemporaryActor,
    onSuccess: (_result, input) => refreshActors(qc, input.chatId),
  })
}

export function useCutoutTemporaryActor(chatId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: Omit<Parameters<typeof api.cutoutTemporaryActor>[0], 'chatId'>) =>
      api.cutoutTemporaryActor({ ...input, chatId }),
    onSuccess: (record) => refreshActors(qc, chatId, record),
  })
}
