import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 开发时前端跑在 5173，/api 请求转发给后端（默认 3000；API_PORT 可以改，方便和另一个正在运行的实例错开）
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': `http://127.0.0.1:${process.env.API_PORT ?? 3000}`,
    },
  },
})
