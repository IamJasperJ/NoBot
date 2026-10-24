import type { ChannelAccountConfig, ChannelLogEntry } from '@nobot/shared'
import { and, eq } from 'drizzle-orm'
import { db, newId } from '../../../db/client'
import { channelAccounts } from '../../../db/schema'
import { systemDatabase } from '../../../db/system-client'
import { channelRegistry } from '../../../db/system-schema'
import { HttpError } from '../../../errors'
import { t } from '../../../i18n'
import { liveHub } from '../../../services/live/hub'
import { currentUser } from '../../../user-context'
import type { ExtensionHost } from '../../types'
import { allowedUpdates, TelegramClient, TelegramError, type TelegramFetch } from './adapters/telegram/client'
import { syncCommands } from './adapters/telegram/commands'
import { PresenceSync } from './presence'
import { sealCredentials } from './secrets'
import { accountDTO, accountRow, channelLog } from './store'

export interface AccountRuntime {
  client: TelegramClient
  controller: AbortController
  presence: PresenceSync
  task?: Promise<void>
}
export class ChannelRuntime {
  private manualPresence = new Map<string, AbortController>()
  readonly accounts = new Map<string, AccountRuntime>()
  readonly logs: ChannelLogEntry[] = []
  fetch?: TelegramFetch
  constructor(
    readonly host: ExtensionHost,
    readonly receive: (id: string, update: unknown) => Promise<void>,
  ) {}
  client(config: ChannelAccountConfig) {
    return new TelegramClient({ token: config.credentials.token, baseUrl: config.baseUrl, fetch: this.fetch })
  }
  presence(id: string) {
    const running = this.accounts.get(id)
    if (running) return running.presence
    let controller = this.manualPresence.get(id)
    if (!controller || controller.signal.aborted) {
      controller = new AbortController()
      this.manualPresence.set(id, controller)
    }
    return new PresenceSync(this.host, this.client(accountRow(id).config), id, controller.signal)
  }
  async start(id: string) {
    await this.stop(id, false)
    const row = accountRow(id)
    const controller = new AbortController()
    const client = this.client(row.config)
    client.draftSupported = row.botSnapshot.channelDraftSupported !== false
    client.onDraftUnsupported = () => {
      if (controller.signal.aborted) return
      const fresh = accountRow(id)
      db.update(channelAccounts)
        .set({ botSnapshot: { ...fresh.botSnapshot, channelDraftSupported: false } })
        .where(eq(channelAccounts.id, id))
        .run()
    }
    const presence = new PresenceSync(this.host, client, id, controller.signal)
    const entry = { client, controller, presence } as AccountRuntime
    this.accounts.set(id, entry)
    this.status(id, 'connecting')
    this.index(id, true)
    try {
      await client.call('deleteWebhook', {}, controller.signal)
      if (row.config.receiveMode === 'webhook') {
        if (!row.config.webhookUrl || !row.config.credentials.webhookSecret) throw new Error('webhook')
        await client.call(
          'setWebhook',
          {
            url: row.config.webhookUrl,
            secret_token: row.config.credentials.webhookSecret,
            allowed_updates: allowedUpdates,
          },
          controller.signal,
        )
      } else {
        entry.task = client
          .poll({
            cursor: row.cursor,
            signal: controller.signal,
            handle: (update) => this.receive(id, update),
            persist: (cursor) => {
              if (!controller.signal.aborted)
                db.update(channelAccounts).set({ cursor }).where(eq(channelAccounts.id, id)).run()
            },
          })
          .catch(() => {
            if (!controller.signal.aborted) this.status(id, 'error')
          })
      }
      await syncCommands(client, controller.signal)
      this.status(id, 'online')
      if (row.config.presence.confirmed) void presence.sync().catch(() => {})
    } catch {
      controller.abort()
      this.accounts.delete(id)
      this.status(id, 'error')
    }
    return accountDTO(accountRow(id))
  }
  index(id: string, enabled: boolean) {
    const config = accountRow(id).config
    systemDatabase()
      .insert(channelRegistry)
      .values({
        userHandle: currentUser().handle,
        accountId: id,
        provider: config.provider,
        receiveMode: config.receiveMode,
        enabled,
      })
      .onConflictDoUpdate({
        target: [channelRegistry.userHandle, channelRegistry.accountId],
        set: { provider: config.provider, receiveMode: config.receiveMode, enabled },
      })
      .run()
  }
  async stop(id: string, persist = true) {
    this.manualPresence.get(id)?.abort()
    this.manualPresence.delete(id)
    const entry = this.accounts.get(id)
    entry?.controller.abort()
    if (entry) this.accounts.delete(id)
    await entry?.task
    if (persist) {
      this.index(id, false)
      this.status(id, 'stopped')
    }
  }
  dispose() {
    for (const controller of this.manualPresence.values()) controller.abort()
    this.manualPresence.clear()
    for (const entry of this.accounts.values()) entry.controller.abort()
    this.accounts.clear()
  }
  status(id: string, status: 'stopped' | 'connecting' | 'online' | 'error') {
    channelLog({ at: Date.now(), accountId: id, code: `status.${status}`, message: t('渠道状态已更新') })
    db.update(channelAccounts)
      .set({ status, lastError: status === 'error' ? 'CHANNEL_UNAVAILABLE' : null })
      .where(eq(channelAccounts.id, id))
      .run()
    liveHub.publishToUser(currentUser().id, {
      type: 'channel.account',
      topic: `user:${currentUser().id}`,
      data: accountDTO(accountRow(id)),
    })
  }
  async resume() {
    const rows = systemDatabase()
      .select()
      .from(channelRegistry)
      .where(and(eq(channelRegistry.userHandle, currentUser().handle), eq(channelRegistry.enabled, true)))
      .all()
    for (const row of rows) await this.start(row.accountId)
  }
  log(id: string, code: string) {
    channelLog({ at: Date.now(), accountId: id, code, message: code })
  }
  async create(config: ChannelAccountConfig) {
    const client = this.client(config)
    const bot = await client.call<Record<string, unknown>>('getMe').catch((error: unknown) => {
      if (error instanceof TelegramError && [401, 404].includes(error.code))
        throw new HttpError(400, 'INVALID_BOT_TOKEN', t('Bot Token 无效，请检查后重试'))
      throw new HttpError(502, 'CHANNEL_UNAVAILABLE', t('无法连接机器人平台，请检查网络后重试'))
    })
    if (!bot.is_bot || typeof bot.id !== 'number') throw new Error('getMe')
    const id = newId()
    const row = db
      .insert(channelAccounts)
      .values({
        id,
        ...config,
        credentials: sealCredentials(config.credentials),
        botId: String(bot.id),
        botUsername: typeof bot.username === 'string' ? bot.username : null,
        botSnapshot: bot,
      })
      .returning()
      .get()
    this.index(id, false)
    return accountDTO(row)
  }
}
