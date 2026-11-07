import type { ChannelAccountConfig, ChannelAccountDTO, ChannelCapabilities, ExtensionSettingField } from '@nobot/shared'
import { t } from '../../../i18n'
import { currentContext } from '../../../user-context'
import type { ChannelProviderDefinition } from '../../types'
import { decodeOneBot } from './adapters/onebot11/receive'
import { TelegramClient } from './adapters/telegram/client'
import { decodeTelegram, type TelegramEvent } from './adapters/telegram/receive'
import type { ChannelClient } from './adapters/types'
import { providerCapabilities } from './capabilities'
import type { ChannelRuntime } from './runtime'
import { qqStickerMeaning } from './stickers'

export interface RegisteredProvider {
  id: string
  name: string
  riskNotice: string | null
  accountFields: ExtensionSettingField[]
  capabilities: ChannelCapabilities
  presenceLimits: { name: number; description: number; shortDescription: number }
  definition?: ChannelProviderDefinition
  extensionId?: string
  /** 提供平台的扩展显示名；内置平台为空。 */
  extensionName?: string | null
  /** 账号由扩展托管，界面不显示手动添加。 */
  managed?: boolean
  start(
    runtime: ChannelRuntime,
    id: string,
    controller: AbortController,
  ): Promise<ChannelAccountDTO> | ChannelAccountDTO
  createAccount(
    runtime: ChannelRuntime,
    config: ChannelAccountConfig,
    expectedBotId?: number,
  ): Promise<ChannelAccountDTO>
  createClient(runtime: ChannelRuntime, config: ChannelAccountConfig): ChannelClient
  decode(
    input: unknown,
    client: ChannelClient,
    bot: { id: string | null; username: string | null },
    accountId: string,
  ): TelegramEvent | null
}
const pluginProviders = new WeakMap<object, Map<string, RegisteredProvider>>()
function plugins() {
  const key = currentContext().sqlite
  let entries = pluginProviders.get(key)
  if (!entries) {
    entries = new Map()
    pluginProviders.set(key, entries)
  }
  return entries
}
function builtins(): RegisteredProvider[] {
  return [
    {
      start: (runtime, id, controller) => runtime.startTelegram(id, controller),
      createAccount: (runtime, config, expectedBotId) => runtime.createTelegram(config, expectedBotId),
      id: 'telegram',
      name: 'Telegram',
      riskNotice: null,
      accountFields: [],
      capabilities: providerCapabilities.telegram!,
      presenceLimits: { name: 64, description: 512, shortDescription: 120 },
      createClient: (runtime, config) =>
        new TelegramClient({ token: config.credentials.token, baseUrl: config.baseUrl, fetch: runtime.fetch }),
      decode: (input, _client, bot) => decodeTelegram(input, bot),
    },
    {
      start: (runtime, id, controller) => runtime.startOneBot(id, controller),
      createAccount: (runtime, config) => runtime.createOneBot(config),
      id: 'onebot11',
      name: 'QQ (OneBot 11)',
      riskNotice: t('QQ 非官方协议存在风控和封号风险，限速不能保证账号安全'),
      accountFields: [],
      capabilities: providerCapabilities.onebot11!,
      presenceLimits: { name: 24, description: 80, shortDescription: 0 },
      createClient: (runtime, config) => runtime.oneBotClient(config),
      decode: (input, client, _bot, accountId) =>
        decodeOneBot(input, client as import('./adapters/onebot11/client').OneBotClient, (segment) =>
          qqStickerMeaning(accountId, segment),
        ),
    },
  ]
}
export function getProvider(id: string) {
  return plugins().get(id) ?? builtins().find((entry) => entry.id === id)
}
export function listProviders() {
  return [...builtins(), ...plugins().values()]
}
export function addProvider(provider: RegisteredProvider) {
  if (getProvider(provider.id)) throw new Error('CHANNEL_PROVIDER_DUPLICATE')
  plugins().set(provider.id, provider)
}
export function removeProvider(id: string, expected: RegisteredProvider) {
  if (plugins().get(id) === expected) plugins().delete(id)
}
