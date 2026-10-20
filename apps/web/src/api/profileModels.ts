import { type ProfileImage, profileImageSchema } from '@nobot/shared'
import { useQuery } from '@tanstack/react-query'
import { api } from './client'
import { keys } from './queries'

const staleTime = 5 * 60 * 1000

export function useConnectionModels(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['connectionModels', id],
    queryFn: () => (id ? api.connectionModels(id) : Promise.resolve([])),
    enabled: enabled && !!id,
    staleTime,
  })
}

export function useImageModels(image: ProfileImage | null, enabled: boolean) {
  const extensions = useQuery({
    queryKey: keys.extensions,
    queryFn: api.listExtensions,
    enabled: enabled && image === null,
  })
  const extension = extensions.data?.find((item) => item.id === 'image-gen')
  const source = image?.source ?? profileImageSchema.shape.source.safeParse(extension?.settings.source).data ?? 'openai'
  return useQuery({
    // 其余覆盖也进入缓存键，避免切换工作流后仍然显示旧结果。
    queryKey: ['imageModels', source, image?.connectionId, image?.url, image, extension?.settings],
    queryFn: () => api.imageModels(image, undefined, source),
    enabled: enabled && (image !== null || !!extension),
    staleTime,
  })
}

export function useComfyWorkflowOptions() {
  return useQuery({ queryKey: ['comfyWorkflowOptions'], queryFn: api.comfyWorkflowOptions })
}

export function useImageStyleOptions() {
  return useQuery({ queryKey: ['imageStyleOptions'], queryFn: api.imageStyleOptions })
}
