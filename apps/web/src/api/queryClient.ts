import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 本地应用，数据只会被自己改，不需要切回窗口就重新拉取
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})
