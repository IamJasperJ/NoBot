import { channelAccountInput } from '@nobot/shared'
import { and, eq } from 'drizzle-orm'
import { db } from '../../../db/client'
import { channelAccounts, channelActorLocations, channelActors, channelBindings } from '../../../db/schema'
import { systemDatabase } from '../../../db/system-client'
import { channelRegistry } from '../../../db/system-schema'
import { HttpError } from '../../../errors'
import { t } from '../../../i18n'
import { currentUser, runAsUser } from '../../../user-context'
import {
  type ChannelProviderDefinition,
  ChannelProviderStoppedError,
  type ExtensionChannels,
  type ExtensionHost,
} from '../../types'
import { PluginChannelClient } from './adapters/plugin'
import { channelService } from './index'
import { PresenceSync } from './presence'
import { addProvider, getProvider, type RegisteredProvider, removeProvider } from './providers'
import type { ChannelRuntime } from './runtime'
import { accountDTO, accountRow } from './store'

export function lookupAll(chatId: string) {
  return db
    .select()
    .from(channelBindings)
    .where(eq(channelBindings.chatId, chatId))
    .all()
    .map((binding) => {
      const provider = accountRow(binding.accountId).provider
      const seen = db
        .select()
        .from(channelActorLocations)
        .where(
          and(eq(channelActorLocations.accountId, binding.accountId), eq(channelActorLocations.chat, binding.chat)),
        )
        .all()
      const actors = db
        .select()
        .from(channelActors)
        .where(eq(channelActors.provider, provider))
        .all()
        .filter(
          (actor) =>
            seen.some(
              (location) =>
                location.actorId === actor.id &&
                (binding.isolation !== 'per-topic' || location.thread === binding.thread),
            ) &&
            (binding.isolation !== 'per-user' || actor.externalId === binding.actor),
        )
        .map((actor) => ({
          externalId: actor.externalId,
          name: actor.displayName,
          role: actor.role,
          paired: !!actor.linkedUserId,
        }))
      return {
        provider,
        accountId: binding.accountId,
        bindingId: binding.id,
        scope: binding.scope,
        external: { chat: binding.chat, title: binding.title },
        actors,
        ownerPresent: actors.some((actor) => actor.role === 'owner'),
      }
    })
}

export function startPluginAccount(
  runtime: ChannelRuntime,
  id: string,
  definition: ChannelProviderDefinition,
  controller: AbortController,
) {
  const owner = currentUser()
  const row = accountRow(id)
  const account: import('../../types').ChannelProviderAccount = {
    id,
    config: row.config.credentials,
    cursor: row.providerState.cursor ?? null,
  }
  db.update(channelAccounts)
    .set({
      botSnapshot: {
        ...row.botSnapshot,
        providerName: definition.name,
        providerRiskNotice: definition.riskNotice ?? null,
      },
    })
    .where(eq(channelAccounts.id, id))
    .run()
  const client = new PluginChannelClient(definition, account, row.config, controller.signal)
  runtime.accounts.set(id, {
    client,
    controller,
    presence: new PresenceSync(runtime.host, client, id, controller.signal),
  })
  runtime.index(id, true)
  runtime.status(id, 'connecting')
  const use = <T>(fn: () => T): T => {
    if (controller.signal.aborted) throw new ChannelProviderStoppedError()
    return runAsUser(owner, fn)
  }
  const io = {
    emit: (message: import('../../types').ChannelInboundMessage) =>
      use(async () => {
        const input = client.inbound(message, () => runtime.log(id, 'inbound.image.rejected'))
        try {
          if (input) await runtime.receive(id, input)
        } finally {
          for (const photo of input?.message.photo ?? []) client.files.delete(photo.file_id)
        }
      }),
    status: (status: 'connecting' | 'online' | 'offline' | 'paused', reason?: string) =>
      use(() => runtime.status(id, status, reason)),
    saveCursor: (cursor: unknown) =>
      use(() => {
        account.cursor = cursor
        db.update(channelAccounts)
          .set({ providerState: { ...accountRow(id).providerState, cursor } })
          .where(eq(channelAccounts.id, id))
          .run()
      }),
    setOwner: (externalId: string | null) =>
      use(() => {
        const provider = row.provider
        const previous = accountRow(id).providerState.ownerExternalId
        db.update(channelAccounts)
          .set({ providerState: { ...accountRow(id).providerState, ownerExternalId: externalId } })
          .where(eq(channelAccounts.id, id))
          .run()
        const old = db
          .select()
          .from(channelActors)
          .where(and(eq(channelActors.provider, provider), eq(channelActors.role, 'owner')))
          .all()
        for (const actor of old.filter(
          (actor) =>
            actor.externalId === previous &&
            !db
              .select()
              .from(channelAccounts)
              .where(eq(channelAccounts.provider, provider))
              .all()
              .some((account) => account.id !== id && account.providerState.ownerExternalId === actor.externalId),
        ))
          db.update(channelActors)
            .set({ role: 'player', linkedUserId: null })
            .where(eq(channelActors.id, actor.id))
            .run()
        if (externalId === null) return
        const actor = db
          .select()
          .from(channelActors)
          .where(and(eq(channelActors.provider, provider), eq(channelActors.externalId, externalId)))
          .get()
        if (actor)
          db.update(channelActors)
            .set({ role: 'owner', linkedUserId: owner.id, accountIds: [...new Set([...actor.accountIds, id])] })
            .where(eq(channelActors.id, actor.id))
            .run()
        else
          db.insert(channelActors)
            .values({
              id: crypto.randomUUID(),
              provider,
              externalId,
              displayName: externalId,
              role: 'owner',
              linkedUserId: owner.id,
              accountIds: [id],
            })
            .run()
      }),
  }
  // 后台可能一直等待 signal；启动账号不等待插件轮询循环结束。
  try {
    Promise.resolve(use(() => definition.start(account, io, controller.signal))).catch(() => {
      if (!controller.signal.aborted) use(() => runtime.status(id, 'error'))
    })
  } catch {
    runtime.status(id, 'error')
  }
  return accountDTO(accountRow(id))
}

export function extensionChannels(
  extensionId: string,
  host: ExtensionHost,
  allowed = false,
  signal?: AbortSignal,
): ExtensionChannels {
  const runtime = () => channelService({ host }).runtime
  const owned = new Set<string>()
  const check = () => {
    if (signal?.aborted) throw new ChannelProviderStoppedError()
    if (!allowed || !signal) throw new HttpError(403, 'CHANNEL_PERMISSION_REQUIRED', t('没有渠道操作权限'))
  }
  return {
    lookup: (chatId) => lookupAll(chatId)[0] ?? null,
    lookupAll,
    registerProvider(definition) {
      check()
      if (
        !/^[a-z0-9-]+$/.test(definition.id) ||
        !definition.scopes.length ||
        !Number.isInteger(definition.limits.maxTextLength) ||
        definition.limits.maxTextLength < 1 ||
        (definition.limits.minIntervalMs !== undefined &&
          (!Number.isFinite(definition.limits.minIntervalMs) || definition.limits.minIntervalMs < 0)) ||
        (definition.limits.perMinute !== undefined &&
          (!Number.isInteger(definition.limits.perMinute) || definition.limits.perMinute < 1))
      )
        throw new Error('INVALID_CHANNEL_PROVIDER')
      const id = `${extensionId}.${definition.id}`
      const provider: RegisteredProvider = {
        id,
        name: definition.name,
        riskNotice: definition.riskNotice ?? null,
        accountFields: definition.accountFields,
        definition,
        extensionId,
        capabilities: Object.fromEntries(
          [
            'draftStreaming',
            'menuButton',
            'managedBots',
            'avatar',
            'name',
            'description',
            'shortDescription',
            'reactions',
            'pin',
            'topic',
            'voice',
            'outboundImages',
          ].map((key) => [key, 'unsupported' as const]),
        ),
        presenceLimits: { name: 0, description: 0, shortDescription: 0 },
        start: (runtime, accountId, controller) => startPluginAccount(runtime, accountId, definition, controller),
        createAccount: (runtime, config) => runtime.createPlugin(config),
        createClient: () => {
          throw new Error('CHANNEL_ACCOUNT_NOT_RUNNING')
        },
        decode: (input, client) => (client as PluginChannelClient).decode(input),
      }
      addProvider(provider)
      owned.add(id)
      const owner = currentUser()
      const value = runtime()
      let stopped = false
      const unregister = () => {
        if (stopped) return
        stopped = true
        signal!.removeEventListener('abort', unregister)
        runAsUser(owner, () => {
          // 只清理本次注册，旧句柄或旧后台不能影响后来恢复的平台。
          if (getProvider(id) !== provider) return
          removeProvider(id, provider)
          owned.delete(id)
          for (const row of db.select().from(channelAccounts).where(eq(channelAccounts.provider, id)).all()) {
            void value.stop(row.id, false).catch(() => value.log(row.id, 'provider.stop.failed'))
            value.unavailable(row.id)
          }
        })
      }
      signal!.addEventListener('abort', unregister, { once: true })
      const enabled = systemDatabase()
        .select()
        .from(channelRegistry)
        .where(
          and(
            eq(channelRegistry.userHandle, owner.handle),
            eq(channelRegistry.provider, id),
            eq(channelRegistry.enabled, true),
          ),
        )
        .all()
      for (const row of enabled) void value.start(row.accountId).catch(() => {})
      return { unregister }
    },
    async ensureAccount(providerId, options) {
      check()
      const id = providerId.startsWith(`${extensionId}.`) ? providerId : `${extensionId}.${providerId}`
      const provider = getProvider(id)
      if (!owned.has(id) || provider?.extensionId !== extensionId)
        throw new HttpError(403, 'CHANNEL_PERMISSION_REQUIRED', t('没有渠道操作权限'))
      const existing = db.select().from(channelAccounts).where(eq(channelAccounts.provider, id)).get()
      if (existing) {
        const characterFollowed =
          options.characterId !== undefined &&
          existing.characterMode === 'fixed' &&
          existing.characterId === existing.providerState.ensuredCharacterId
        if (characterFollowed) {
          host.getCharacter(options.characterId!)
          db.update(channelAccounts)
            .set({
              characterId: options.characterId,
              providerState: { ...existing.providerState, ensuredCharacterId: options.characterId },
            })
            .where(eq(channelAccounts.id, existing.id))
            .run()
        }
        return { accountId: existing.id, characterFollowed }
      }
      if (options.characterId && options.groupId) throw new HttpError(400, 'INVALID_INPUT', t('渠道设置无效'))
      if (options.characterId) host.getCharacter(options.characterId)
      const value = runtime()
      const account = await value.create(
        channelAccountInput.parse({
          provider: id,
          ...options,
          characterMode: options.characterId || options.groupId ? 'fixed' : 'generic',
          policies: { newLocation: provider.definition?.defaults?.newLocation },
        }),
      )
      db.update(channelAccounts)
        .set({ providerState: { ...accountRow(account.id).providerState, ensuredCharacterId: options.characterId } })
        .where(eq(channelAccounts.id, account.id))
        .run()
      await value.start(account.id)
      return { accountId: account.id, characterFollowed: options.characterId !== undefined }
    },
  }
}
