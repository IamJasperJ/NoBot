import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { type ChannelAccountConfig, channelAccountInput } from '@nobot/shared'
import { HttpError } from '../../../errors'
import { t } from '../../../i18n'
import { currentContext } from '../../../user-context'

const keys = new WeakMap<object, Buffer>()
function encryptionKey() {
  const context = currentContext()
  let key = keys.get(context.sqlite)
  if (key) return key
  // 密钥和用户库一起备份，但不放在可经资源接口读取的 assets 目录。
  const file = join(dirname(context.paths.db), 'channel-key')
  if (!existsSync(file)) {
    try {
      writeFileSync(file, randomBytes(32), { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if (!existsSync(file)) throw error
    }
  }
  key = readFileSync(file)
  if (key.length !== 32) throw new HttpError(500, 'CREDENTIALS_UNAVAILABLE', t('无法读取渠道凭据'))
  keys.set(context.sqlite, key)
  return key
}
/** 每次写入使用新的随机 nonce；认证标签防止损坏的密文被误当作平台凭据。 */
export function sealCredentials(value: ChannelAccountConfig['credentials']) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.')
}
export function openCredentials(value: string): ChannelAccountConfig['credentials'] {
  try {
    const [version, iv, tag, encrypted, extra] = value.split('.')
    if (version !== 'v1' || !iv || !tag || !encrypted || extra !== undefined) throw new Error('format')
    const nonce = Buffer.from(iv, 'base64url'),
      auth = Buffer.from(tag, 'base64url')
    if (nonce.length !== 12 || auth.length !== 16) throw new Error('format')
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), nonce)
    decipher.setAuthTag(auth)
    const bytes = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()])
    const decoded: unknown = JSON.parse(bytes.toString('utf8'))
    return channelAccountInput.shape.credentials.parse(decoded)
  } catch {
    // 不附原始异常或解密结果，避免错误日志带出凭据。
    throw new HttpError(500, 'CREDENTIALS_UNAVAILABLE', t('无法读取渠道凭据'))
  }
}
