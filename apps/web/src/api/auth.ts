import type { CurrentUserDTO, UpdateUserInput } from '@nobot/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSessionStore } from '../stores/session'
import { type ApiRequestError, api } from './client'
import { stopLive } from './live'

/** 界面可以直接订阅会话状态、当前用户、初始化错误和首次配置提示。 */
export function useSession() {
  return useSessionStore()
}

export function useLogin() {
  return useMutation<CurrentUserDTO, ApiRequestError, Parameters<typeof api.login>[0]>({
    mutationFn: api.login,
    onSuccess: () => window.location.reload(),
    onMutate: () => useSessionStore.setState({ setupRequired: false, error: null }),
    onError: (error) => useSessionStore.setState({ setupRequired: error.code === 'SETUP_REQUIRED', error }),
  })
}

export function useLogout() {
  return useMutation<Awaited<ReturnType<typeof api.logout>>, ApiRequestError, void>({
    mutationFn: api.logout,
    onSuccess: () => {
      stopLive()
      window.location.reload()
    },
  })
}

export function useChangePassword() {
  return useMutation<
    Awaited<ReturnType<typeof api.changePassword>>,
    ApiRequestError,
    Parameters<typeof api.changePassword>[0]
  >({ mutationFn: api.changePassword })
}

export const usersKey = ['admin', 'users'] as const

export function useUsers() {
  const { status, user } = useSession()
  return useQuery<Awaited<ReturnType<typeof api.listUsers>>, ApiRequestError>({
    queryKey: usersKey,
    queryFn: api.listUsers,
    enabled: status === 'authenticated' && user?.isAdmin === true,
  })
}

function useUsersMutation<T, R>(mutationFn: (input: T) => Promise<R>) {
  const qc = useQueryClient()
  return useMutation<R, ApiRequestError, T>({
    mutationFn,
    onSuccess: () => qc.invalidateQueries({ queryKey: usersKey }),
  })
}

export const useCreateUser = () => useUsersMutation(api.createUser)
export const useUpdateUser = () =>
  useUsersMutation(({ id, input }: { id: string; input: UpdateUserInput }) => api.updateUser(id, input))
export const useDeleteUser = () => useUsersMutation(api.deleteUser)
