import type { ChannelAccountConfig, ChannelAccountDTO, ChannelLogEntry } from '@nobot/shared'
import { and, eq } from 'drizzle-orm'
import { db, getSetting, newId } from '../../../db/client'
import { channelAccounts } from '../../../db/schema'
import { systemDatabase } from '../../../db/system-client'
import { channelRegistry } from '../../../db/system-schema'
import { HttpError } from '../../../errors'
import { t } from '../../../i18n'
import { liveHub } from '../../../services/live/hub'
import { notify } from '../../../services/social'
import { currentUser, runAsUser } from '../../../user-context'
import type { ExtensionHost } from '../../types'
import { OneBotClient } from './adapters/onebot11/client'
import { type OneBotDial, type OneBotSendQueue, OneBotTransport } from './adapters/onebot11/transport'
import { PluginChannelClient } from './adapters/plugin'
import { allowedUpdates, TelegramClient, TelegramError, type TelegramFetch } from './adapters/telegram/client'
import { syncCommands } from './adapters/telegram/commands'
import type { ChannelClient } from './adapters/types'
import { miniAppUrl, publicBaseUrl } from './miniapp'
import { PresenceSync } from './presence'
import { getProvider } from './providers'
import { sealCredentials } from './secrets'
import { resolveChannelSettings } from './settings'
import { refreshQqFaces } from './stickers'
import { accountDTO, accountRow, channelLog } from './store'

export interface AccountRuntime {
  client: ChannelClient
  controller: AbortController
  presence: PresenceSync
  task?: Promise<void>
  menuTimer?: ReturnType<typeof setInterval>
}
export class ChannelRuntime {
  private starts = new Map<string, Promise<ChannelAccountDTO>>()
  private stopVersions = new Map<string, number>()
  private manualPresence = new Map<string, AbortController>()
  readonly accounts = new Map<string, AccountRuntime>()
  readonly logs: ChannelLogEntry[] = []
  started?: (id: string) => void
  fetch?: TelegramFetch
  dial?: OneBotDial
  oneBotQueue?: (config: ChannelAccountConfig) => OneBotSendQueue
  constructor(
    readonly host: ExtensionHost,
    readonly receive: (id: string, update: unknown) => Promise<void>,
  ) {}
  client(config: ChannelAccountConfig): ChannelClient {
    const provider = getProvider(config.provider)
    if (!provider) throw new HttpError(409, 'PROVIDER_UNAVAILABLE', t('平台不可用'))
    return provider.createClient(this, config)
  }
  oneBotClient(config: ChannelAccountConfig) {
    const owner = currentUser()
    let client!: OneBotClient
    const transport = new OneBotTransport({
      token: config.credentials.accessToken ?? config.credentials.token,
      dial: this.dial,
      onEvent: (event) =>
        runAsUser(owner, () => {
          const id = this.oneBotId(client)
          if (id) void this.receive(id, event).catch(() => this.log(id, 'onebot.event.failed'))
        }),
      onConnect: () =>
        runAsUser(owner, async () => {
          await client.connected()
          const id = this.oneBotId(client)
          if (!id) return
          const row = accountRow(id)
          if (row.botId && row.botId !== client.selfId) {
            transport.stop()
            throw new Error('IDENTITY_CHANGED')
          }
          db.update(channelAccounts)
            .set({
              botId: client.selfId,
              botUsername: client.nickname,
              botSnapshot: { ...row.botSnapshot, implementation: client.implementation },
            })
            .where(eq(channelAccounts.id, id))
            .run()
          if (client.napcat)
            void refreshQqFaces(id, client, this.host, this.fetch).catch(() => this.log(id, 'stickers.refresh.failed'))
          if (row.config.presence.confirmed)
            void this.accounts
              .get(id)
              ?.presence.sync()
              .catch(() => {})
        }),
      onStatus: (status) =>
        runAsUser(owner, () => {
          const id = this.oneBotId(client)
          if (id) this.status(id, status)
        }),
      onBreaker: () =>
        runAsUser(owner, () => {
          const id = this.oneBotId(client)
          if (!id) return
          this.status(id, 'error')
          this.index(id, false)
          db.update(channelAccounts).set({ lastError: 'CHANNEL_RISK_PAUSED' }).where(eq(channelAccounts.id, id)).run()
          notify(currentUser().id, 'channel.risk.paused', null, { accountId: id })
          client.stop()
        }),
    })
    client = new OneBotClient(transport, config, this.fetch, undefined, this.oneBotQueue?.(config))
    return client
  }
  private oneBotId(client: OneBotClient) {
    for (const [id, entry] of this.accounts) if (entry.client === client) return id
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
  async startOneBot(id: string, controller: AbortController) {
    const row = accountRow(id)
    const client = this.oneBotClient(row.config)
    const entry: AccountRuntime = {
      client,
      controller,
      presence: new PresenceSync(this.host, client, id, controller.signal),
    }
    this.accounts.set(id, entry)
    this.status(id, 'connecting')
    this.index(id, true)
    if (row.config.connection?.mode === 'ws-forward')
      entry.task = client.transport.forward(row.config.connection.url, controller.signal)
    return accountDTO(accountRow(id))
  }
  start(id: string): Promise<ChannelAccountDTO> {
    const existing = this.starts.get(id)
    if (existing) return existing
    const pending = this.startNow(id)
    this.starts.set(id, pending)
    void pending
      .finally(() => {
        if (this.starts.get(id) === pending) this.starts.delete(id)
      })
      .catch(() => {})
    return pending
  }
  private async startNow(id: string) {
    const version = this.stopVersions.get(id) ?? 0
    await this.stop(id, false, false)
    if (version !== (this.stopVersions.get(id) ?? 0)) return accountDTO(accountRow(id))
    const row = accountRow(id)
    const controller = new AbortController()
    const provider = getProvider(row.provider)
    if (!provider) {
      this.unavailable(id)
      throw new HttpError(409, 'PROVIDER_UNAVAILABLE', t('平台不可用'))
    }
    const result = await provider.start(this, id, controller)
    this.started?.(id)
    return result
  }
  async startTelegram(id: string, controller: AbortController) {
    const row = accountRow(id)
    const client = this.client(row.config)
    if (!(client instanceof TelegramClient)) throw new Error('CHANNEL_CLIENT_INVALID')
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
      const bot = await client.call<Record<string, unknown>>('getMe', {}, controller.signal)
      if (String(bot.id) !== row.botId || bot.is_bot !== true) throw new Error('getMe')
      db.update(channelAccounts)
        .set({
          botSnapshot: { ...row.botSnapshot, ...bot },
          botUsername: typeof bot.username === 'string' ? bot.username : row.botUsername,
        })
        .where(eq(channelAccounts.id, id))
        .run()
      await client.call('deleteWebhook', {}, controller.signal)
      if (row.config.receiveMode === 'webhook') {
        const base = publicBaseUrl()
        const webhookUrl = base
          ? `${base}/hooks/channels/${encodeURIComponent(currentUser().handle)}/${id}`
          : row.config.webhookUrl
        if (!webhookUrl || !row.config.credentials.webhookSecret) throw new Error('webhook')
        await client.call(
          'setWebhook',
          {
            url: webhookUrl,
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
      const syncMenu = async () => {
        const url = miniAppUrl(id)
        const enabled = resolveChannelSettings(accountRow(id).config, undefined, getSetting('ext:channels')).values
          .miniAppMenuButton
        await client.call(
          'setChatMenuButton',
          {
            menu_button:
              url && enabled ? { type: 'web_app', text: t('打开 VN'), web_app: { url } } : { type: 'default' },
          },
          controller.signal,
        )
      }
      await syncMenu()
      // 菜单令牌也只有 24 小时有效，常驻长轮询必须定期更新菜单。
      entry.menuTimer = setInterval(() => {
        void syncMenu().catch(() => this.log(id, 'miniapp.menu.failed'))
      }, 12 * 3600000)
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
  async stop(id: string, persist = true, cancelStart = true) {
    if (cancelStart) {
      // 注销后立即重注册时，新启动不能复用尚未退出的旧启动任务。
      this.stopVersions.set(id, (this.stopVersions.get(id) ?? 0) + 1)
      this.starts.delete(id)
    }
    this.manualPresence.get(id)?.abort()
    this.manualPresence.delete(id)
    const entry = this.accounts.get(id)
    if (entry?.menuTimer) clearInterval(entry.menuTimer)
    if (entry?.client instanceof OneBotClient) {
      await entry.client
        .prepareStop(
          resolveChannelSettings(accountRow(id).config, undefined, getSetting('ext:channels')).values.onlineStatus ===
            'follow',
        )
        .catch(() => {})
      entry.client.stop()
    }
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
    for (const entry of this.accounts.values()) {
      if (entry.menuTimer) clearInterval(entry.menuTimer)
      if (entry.client instanceof OneBotClient) entry.client.stop()
      entry.controller.abort()
    }
    this.accounts.clear()
  }
  unavailable(id: string) {
    db.update(channelAccounts)
      .set({ status: 'error', lastError: 'PROVIDER_UNAVAILABLE' })
      .where(eq(channelAccounts.id, id))
      .run()
  }
  status(id: string, status: 'stopped' | 'connecting' | 'online' | 'offline' | 'paused' | 'error', reason?: string) {
    const entry = this.accounts.get(id)
    if (entry?.client instanceof PluginChannelClient) entry.client.status(status)
    const lastError = reason ?? (status === 'error' ? 'CHANNEL_UNAVAILABLE' : null)
    const previous = accountRow(id)
    if (previous.status === status && previous.lastError === lastError) return
    channelLog({ at: Date.now(), accountId: id, code: `status.${status}`, message: t('渠道状态已更新') })
    db.update(channelAccounts).set({ status, lastError }).where(eq(channelAccounts.id, id)).run()
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
    for (const row of rows) {
      if (!getProvider(row.provider)) this.unavailable(row.accountId)
      else await this.start(row.accountId)
    }
  }
  log(id: string, code: string, message?: string) {
    channelLog({
      at: Date.now(),
      accountId: id,
      code,
      message: message ?? (code === 'delivery.uncertain' ? t('结果不确定') : code),
    })
  }
  async create(config: ChannelAccountConfig, expectedBotId?: number) {
    const provider = getProvider(config.provider)
    if (!provider) throw new HttpError(409, 'PROVIDER_UNAVAILABLE', t('平台不可用'))
    return provider.createAccount(this, config, expectedBotId)
  }
  async createPlugin(config: ChannelAccountConfig) {
    const id = newId()
    const provider = getProvider(config.provider)
    const row = db
      .insert(channelAccounts)
      .values({
        id,
        ...config,
        credentials: sealCredentials(config.credentials),
        botSnapshot: { providerName: provider?.name, providerRiskNotice: provider?.riskNotice },
      })
      .returning()
      .get()
    this.index(id, false)
    return accountDTO(row)
  }
  async createOneBot(config: ChannelAccountConfig) {
    const connection = config.connection
    if (!connection || !(config.credentials.accessToken ?? config.credentials.token))
      throw new HttpError(400, 'INVALID_INPUT', t('渠道设置无效'))
    if (connection.mode === 'ws-forward') {
      const url = new URL(connection.url)
      if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
        throw new HttpError(400, 'INVALID_INPUT', t('渠道设置无效'))
    }
    config.receiveMode = connection.mode
    const id = newId()
    const row = db
      .insert(channelAccounts)
      .values({ id, ...config, credentials: sealCredentials(config.credentials) })
      .returning()
      .get()
    this.index(id, false)
    return accountDTO(row)
  }
  async createTelegram(config: ChannelAccountConfig, expectedBotId?: number) {
    const client = this.client(config)
    const bot = await client.call<Record<string, unknown>>('getMe').catch((error: unknown) => {
      if (error instanceof TelegramError && [401, 404].includes(error.code))
        throw new HttpError(400, 'INVALID_BOT_TOKEN', t('Bot Token 无效，请检查后重试'))
      throw new HttpError(502, 'CHANNEL_UNAVAILABLE', t('无法连接机器人平台，请检查网络后重试'))
    })
    if (expectedBotId !== undefined && bot.id !== expectedBotId)
      throw new HttpError(400, 'INVALID_BOT_TOKEN', t('Bot Token 无效，请检查后重试'))
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
