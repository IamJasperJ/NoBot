import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/system-schema.ts',
  out: './drizzle-system',
})
