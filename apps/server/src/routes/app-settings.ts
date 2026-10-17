import { appSettingsSchema } from '@ai-parter/shared'
import { Hono } from 'hono'
import { validate } from '../lib/validate'
import { getAppSettings, setAppSettings } from '../services/settings'

/** 应用级设置（界面语言等） */
export const appSettingsRoutes = new Hono()
  .get('/', (c) => c.json(getAppSettings()))
  .put('/', validate('json', appSettingsSchema), (c) => c.json(setAppSettings(c.req.valid('json'))))
