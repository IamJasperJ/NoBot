import { defineConfig } from 'drizzle-kit'

// 改完 src/db/schema.ts 后运行 `bun run db:generate` 生成迁移文件
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
})
