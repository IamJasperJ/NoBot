import { createHash } from 'node:crypto'
import type { ChannelPresencePreview, CharacterDTO } from '@nobot/shared'
import { eq } from 'drizzle-orm'
import sharp from 'sharp'
import { db } from '../../../db/client'
import { channelAccounts, chats } from '../../../db/schema'
import { HttpError } from '../../../errors'
import { t } from '../../../i18n'
import { readAvatar } from '../../../lib/files'
import { isGenerating } from '../../../services/generation/generation'
import { getLanguage } from '../../../services/settings'
import { currentContext } from '../../../user-context'
import type { ExtensionHost } from '../../types'
import { OneBotClient } from './adapters/onebot11/client'
import { TelegramError } from './adapters/telegram/client'
import type { ChannelClient } from './adapters/types'
import {
  cleanIntro,
  creatorIntro,
  type GeneratedIntro,
  type IntroCharacter,
  introHash,
  introInputs,
  introPrompt,
  parseIntro,
  rulesIntro,
  trimIntro,
} from './public-intro'
import { type AccountRow, accountRow } from './store'

const fields = {
  name: ['MyName', 'name', 64],
  description: ['MyDescription', 'description', 512],
  shortDescription: ['MyShortDescription', 'short_description', 120],
} as const
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const truncate = (value: string, length: number) => Array.from(value).slice(0, length).join('')
export function publicIntro(character: IntroCharacter, short: boolean, limit: number) {
  return selectIntro(character, short, limit, 'auto', getLanguage()).value
}
function selectIntro(character: IntroCharacter, short: boolean, limit: number, mode: string, language: 'zh' | 'en') {
  const nobot = character.extensions.nobot as Record<string, unknown> | undefined
  const explicit = nobot?.[short ? 'publicShortIntro' : 'publicIntro']
  if (mode === 'auto' && typeof explicit === 'string' && explicit.trim())
    return {
      value: truncate(
        explicit
          .replace(/{{\s*char\s*}}/gi, character.name)
          .replace(/{{[\s\S]*?}}/g, '')
          .trim(),
        limit,
      ),
      source: 'explicit' as const,
      language,
    }
  if (mode === 'auto' || mode === 'creator-notes') {
    const notes = creatorIntro(character, short, limit)
    if (notes) return { value: notes, source: 'creator-notes' as const, language }
  }
  if (mode === 'auto' || mode === 'model') {
    const generated = nobot?.generatedIntro as GeneratedIntro | undefined
    if (generated?.hash === introHash(character)) {
      const parsed = parseIntro(JSON.stringify(generated), character.name)
      if (parsed)
        return {
          value: trimIntro(parsed[language][short ? 'short' : 'long'], limit),
          source: 'generated' as const,
          language,
        }
    }
  }
  return {
    value: rulesIntro(character, short, limit),
    source: cleanIntro(character.description, character.name) ? ('description' as const) : ('rules' as const),
    language,
  }
}
export function presenceValues(account: AccountRow, character?: CharacterDTO, language = getLanguage()) {
  const result: Record<string, import('@nobot/shared').ChannelPresenceValue> = {}
  for (const [field, [, , limit]] of Object.entries(fields)) {
    const key = field as keyof typeof fields
    const onebot = account.config.provider === 'onebot11'
    if (onebot && key === 'shortDescription') continue
    const effectiveLimit = onebot ? (key === 'name' ? 24 : 80) : limit
    const config = account.config.presence[key]
    if (config.mode === 'unmanaged') continue
    const value =
      config.mode === 'custom'
        ? { value: truncate(config.value, effectiveLimit), source: 'custom' as const }
        : !character
          ? undefined
          : key === 'name'
            ? { value: truncate(character.name, effectiveLimit), source: 'rules' as const }
            : selectIntro(
                character,
                key === 'shortDescription',
                effectiveLimit,
                'introSource' in config ? config.introSource : 'auto',
                language,
              )
    if (!value) continue
    result[`${key}:`] = value
    if (onebot) continue
    for (const lang of ['zh', 'en'] as const) {
      const override = config.languages[lang]
      if (override !== undefined)
        result[`${key}:${lang}`] = { value: truncate(override, limit), source: 'custom', language: lang }
      else if (key !== 'name' && character && config.mode === 'follow-character')
        result[`${key}:${lang}`] = selectIntro(
          character,
          key === 'shortDescription',
          limit,
          'introSource' in config ? config.introSource : 'auto',
          lang,
        )
    }
  }
  return result
}
export function desiredPresence(account: AccountRow, character?: CharacterDTO): Record<string, string> {
  return Object.fromEntries(
    Object.entries(presenceValues(account, character)).map(([key, value]) => [key, value.value]),
  )
}
const introTasks = new WeakMap<object, Map<string, Promise<void>>>()
const syncQueues = new WeakMap<object, Map<string, Promise<unknown>>>()
export class PresenceSync {
  constructor(
    private host: ExtensionHost,
    private client: ChannelClient,
    private id: string,
    private signal: AbortSignal,
    private now = Date.now,
  ) {}
  private character(account: AccountRow) {
    const id =
      account.config.characterMode === 'fixed' ? account.config.characterId : account.config.presence.characterId
    return id ? this.host.getCharacter(id) : undefined
  }
  private async ensureIntro(force = false) {
    const row = accountRow(this.id)
    const character = this.character(row)
    if (!character) return
    const needsModel =
      force ||
      (['description', 'shortDescription'] as const).some((key) => {
        const field = row.config.presence[key]
        if (field.mode !== 'follow-character' || (row.config.provider === 'onebot11' && key === 'shortDescription'))
          return false
        if (field.introSource === 'model') return true
        if (field.introSource !== 'auto') return false
        return (
          ['rules', 'description'].includes(
            selectIntro(
              character,
              key === 'shortDescription',
              row.config.provider === 'onebot11' ? 80 : key === 'description' ? 512 : 120,
              'auto',
              getLanguage(),
            ).source,
          ) &&
          !creatorIntro(
            character,
            key === 'shortDescription',
            row.config.provider === 'onebot11' ? 80 : key === 'description' ? 512 : 120,
          )
        )
      })
    if (!needsModel) return
    const hash = introHash(character)
    const nobot = character.extensions.nobot as Record<string, unknown> | undefined
    if (
      !force &&
      (nobot?.generatedIntro as GeneratedIntro | undefined)?.hash === hash &&
      parseIntro(JSON.stringify(nobot?.generatedIntro), character.name)
    )
      return
    // 与同角色的简介生成合并，已有聊天生成时跳过静默任务。
    if (
      db
        .select({ id: chats.id })
        .from(chats)
        .all()
        .some((chat) => isGenerating(chat.id))
    )
      return
    const database = currentContext().sqlite
    let tasks = introTasks.get(database)
    if (!tasks) {
      tasks = new Map()
      introTasks.set(database, tasks)
    }
    const old = tasks.get(character.id)
    if (old) {
      await old
      return
    }
    const task = (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (this.signal.aborted) return
        try {
          const text = await this.host.complete({
            messages: [
              { role: 'system', content: introPrompt },
              { role: 'user', content: JSON.stringify(introInputs(character)) },
            ],
            summary: 'Public bot bio',
            maxTokens: 1400,
            signal: this.signal,
          })
          const parsed = parseIntro(text, character.name)
          if (!parsed) continue
          const fresh = this.host.getCharacter(character.id)
          if (this.signal.aborted || introHash(fresh) !== hash) return
          this.host.updateCharacterExtensions(character.id, {
            nobot: {
              ...((fresh.extensions.nobot as Record<string, unknown>) ?? {}),
              generatedIntro: { hash, ...parsed, generatedAt: this.now() },
            },
          })
          return
        } catch {
          /* 无连接或请求失败时保持规则回退，不阻断平台资料预览。 */
        }
      }
      if (force && !this.signal.aborted) {
        const fresh = this.host.getCharacter(character.id)
        if (introHash(fresh) !== hash) return
        // 强制重新生成失败也必须回退规则，不能把旧缓存伪装成本次生成结果。
        const nobot = { ...((fresh.extensions.nobot as Record<string, unknown>) ?? {}) }
        delete nobot.generatedIntro
        this.host.updateCharacterExtensions(character.id, { nobot })
      }
    })()
    tasks.set(character.id, task)
    try {
      await task
    } finally {
      if (tasks.get(character.id) === task) tasks.delete(character.id)
    }
  }
  async regenerateIntro() {
    await this.ensureIntro(true)
    return this.preview(false)
  }
  async preview(generate = true): Promise<ChannelPresencePreview> {
    if (generate) await this.ensureIntro()
    const row = accountRow(this.id)
    const character = this.character(row)
    const values = desiredPresence(row, character)
    const bot = await this.client.call<{ id: number; first_name: string }>('getMe', {}, this.signal)
    const current: Record<string, string> = {
      name: bot.first_name ?? '',
      description: '',
      shortDescription: '',
      avatar: '',
    }
    for (const [field, [method, parameter]] of Object.entries(fields)) {
      if (this.client instanceof OneBotClient) continue
      const value = await this.client.call<Record<string, string>>(`get${method}`, {}, this.signal)
      current[field] = value[parameter] ?? current[field] ?? ''
    }
    const photos =
      this.client instanceof OneBotClient
        ? { photos: [] }
        : await this.client.call<{ photos: { file_id: string }[][] }>(
            'getUserProfilePhotos',
            { user_id: bot.id, limit: 1 },
            this.signal,
          )
    const photo = photos.photos?.[0]?.at(-1)
    if (photo) {
      // 代理获取图片，不能把含 bot token 的 Telegram 文件 URL 暴露给浏览器。
      const file = await this.client.call<{ file_path?: string }>('getFile', { file_id: photo.file_id }, this.signal)
      if (file.file_path) current.avatar = await this.client.fileDataHint(file.file_path, this.signal)
    }
    const desired = { ...current }
    for (const field of Object.keys(fields)) desired[field] = values[`${field}:`] ?? current[field]!
    const avatar = row.config.presence.avatar
    if (avatar.mode === 'follow-character' && character)
      desired.avatar = `/api/characters/${encodeURIComponent(character.id)}/avatar`
    if (avatar.mode === 'custom') {
      desired.avatar =
        avatar.value.startsWith('/api/') || avatar.value.startsWith('data:')
          ? avatar.value
          : /^[A-Za-z0-9_-]+\.(png|webp|jpe?g)$/.test(avatar.value)
            ? `/api/assets/avatars/${avatar.value}`
            : avatar.value
              ? `/api/characters/${encodeURIComponent(avatar.value)}/avatar`
              : ''
    }
    const details = presenceValues(row, character)
    const fieldValues = Object.fromEntries(
      Object.entries(details)
        .filter(([key]) => key.endsWith(':'))
        .map(([key, value]) => [key.slice(0, -1), value]),
    )
    if (avatar.mode !== 'unmanaged')
      fieldValues.avatar = { value: desired.avatar!, source: avatar.mode === 'custom' ? 'custom' : 'rules' }
    const languages = Object.fromEntries(
      (['zh', 'en'] as const).map((lang) => [
        lang,
        Object.fromEntries(
          Object.entries(details)
            .filter(([key]) => key.endsWith(`:${lang}`))
            .map(([key, value]) => [key.split(':')[0], value]),
        ),
      ]),
    ) as ChannelPresencePreview['languages']
    return { current, desired, fields: fieldValues, languages, confirmed: row.config.presence.confirmed }
  }
  apply(confirm: boolean) {
    if (!confirm) throw new HttpError(409, 'CONFIRM_REQUIRED', t('请先确认资料同步预览'))
    const row = accountRow(this.id)
    db.update(channelAccounts)
      .set({ presence: { ...row.config.presence, confirmed: true } })
      .where(eq(channelAccounts.id, this.id))
      .run()
    return this.sync()
  }
  sync(force = false) {
    const database = currentContext().sqlite
    let queues = syncQueues.get(database)
    if (!queues) {
      queues = new Map()
      syncQueues.set(database, queues)
    }
    const pending = (queues.get(this.id) ?? Promise.resolve()).catch(() => {}).then(() => this.perform(force))
    queues.set(this.id, pending)
    void pending
      .finally(() => {
        if (queues.get(this.id) === pending) queues.delete(this.id)
      })
      .catch(() => {})
    return pending
  }
  private async perform(force: boolean) {
    let row = accountRow(this.id)
    if (!row.config.presence.confirmed) throw new HttpError(409, 'CONFIRM_REQUIRED', t('请先确认资料同步预览'))
    await this.ensureIntro()
    const character = this.character(row)
    const desired = desiredPresence(row, character)
    let avatar: Uint8Array | undefined
    const config = row.config.presence.avatar
    const avatarId = config.mode === 'custom' ? config.value : character?.id
    if (config.mode !== 'unmanaged' && avatarId) {
      const file = config.mode === 'custom' ? avatarId.replace(/^\/api\/assets\/avatars\//, '').split('?')[0]! : ''
      const safeFile = /^[A-Za-z0-9_-]+\.(png|webp|jpe?g)$/.test(file)
      const source = safeFile ? readAvatar(file) : null
      const raw = source
        ? (await source.exists())
          ? new Uint8Array(await source.arrayBuffer())
          : null
        : await this.host.readAvatar('character', avatarId)
      if (raw) {
        avatar = await sharp(raw).resize(640, 640, { fit: 'cover' }).jpeg({ quality: 90 }).toBuffer()
        desired.avatar = hash(avatar)
      }
    }
    for (const [key, value] of Object.entries(desired)) {
      if (this.signal.aborted) return
      row = accountRow(this.id)
      const desiredHash = hash(value)
      const old = row.presenceSync[key]
      if (old?.appliedHash === desiredHash) continue
      if (!force && old?.desiredHash === desiredHash && old.nextRetryAt && old.nextRetryAt > this.now()) continue
      if (!force && old?.desiredHash === desiredHash && (old.attempts ?? 0) >= 3) continue
      const state = {
        desiredHash,
        attempts: force || old?.desiredHash !== desiredHash ? 1 : (old.attempts ?? 0) + 1,
        appliedHash: old?.appliedHash ?? null,
        lastAttemptAt: this.now(),
        error: null as string | null,
        nextRetryAt: null as number | null,
      }
      try {
        if (key === 'avatar' && avatar) {
          if (this.client instanceof OneBotClient) {
            if (!this.client.napcat) throw new Error('UNKNOWN_CAPABILITY')
            await this.client.action(
              'set_qq_avatar',
              { file: `base64://${Buffer.from(avatar).toString('base64')}` },
              this.signal,
            )
          } else {
            const form = new FormData()
            form.set('photo', JSON.stringify({ type: 'static', photo: 'attach://avatar' }))
            form.set('avatar', new Blob([new Uint8Array(avatar)], { type: 'image/jpeg' }), 'avatar.jpg')
            await this.client.call('setMyProfilePhoto', form, this.signal)
          }
        } else {
          const [field, language] = key.split(':')
          const [method, parameter] = fields[field as keyof typeof fields]
          if (this.client instanceof OneBotClient) {
            if (!this.client.napcat) throw new Error('UNKNOWN_CAPABILITY')
            // longNick 与 personal_note 不混用；80 字是保守的本地截断，QQ 实际约束未公开。
            // https://napneko.github.io/onebot/api
            await this.client.action(
              field === 'name' ? 'set_qq_profile' : 'set_self_longnick',
              field === 'name' ? { nickname: value } : { longNick: value },
              this.signal,
            )
          } else
            await this.client.call(
              `set${method}`,
              { [parameter]: value, ...(language ? { language_code: language } : {}) },
              this.signal,
            )
        }
        state.appliedHash = desiredHash
      } catch (error) {
        if (this.signal.aborted) return
        state.error = t('渠道请求失败')
        state.nextRetryAt =
          state.attempts >= 3
            ? null
            : this.now() + (error instanceof TelegramError && error.retryAfter ? error.retryAfter * 1000 : 60000)
      }
      if (this.signal.aborted) return
      const fresh = accountRow(this.id)
      db.update(channelAccounts)
        .set({ presenceSync: { ...fresh.presenceSync, [key]: state } })
        .where(eq(channelAccounts.id, this.id))
        .run()
    }
    return accountRow(this.id).presenceSync
  }
}
