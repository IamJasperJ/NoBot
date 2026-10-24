import type { ExtensionPermissions } from '@nobot/shared'
import { t } from '../i18n'
import type { Extension, ExtensionManifest } from './types'

export const capabilities = ['server', 'client', 'routes', 'tools', 'hooks'] as const

export function detectPermissions(extension: Extension, manifest?: ExtensionManifest, server = false) {
  return {
    server,
    client: !!(manifest?.client || manifest?.style),
    routes: !!extension.routes || !!extension.publicRoutes || !!extension.commands?.length,
    tools: typeof extension.tools === 'function' || !!extension.tools?.length,
    hooks: Object.values(extension.hooks ?? {}).some((hook) => typeof hook === 'function'),
  }
}

/** 保存集合而不是哈希，才能判断权限减少无需再次确认。 */
export function permissionFingerprint(
  permissions: ExtensionPermissions | null,
  detected: Partial<Omit<ExtensionPermissions, 'network'>>,
): string {
  return JSON.stringify(
    [
      ...capabilities.filter((key) => permissions?.[key] || detected[key]),
      ...new Set((permissions?.network ?? []).map((domain) => `network:${domain.trim().toLowerCase()}`)),
    ].sort(),
  )
}

export function isApproved(fingerprint: string, approved?: string): boolean {
  if (!approved) return false
  try {
    const values: unknown = JSON.parse(approved)
    return Array.isArray(values) && (JSON.parse(fingerprint) as string[]).every((value) => values.includes(value))
  } catch {
    return false
  }
}

export function permissionWarnings(
  permissions: ExtensionPermissions | null,
  detected: Partial<Omit<ExtensionPermissions, 'network'>>,
): string[] {
  return [
    ...(!permissions ? [t('扩展未声明权限，请确认检测到的能力')] : []),
    ...capabilities
      .filter((key) => detected[key] && !permissions?.[key])
      .map((key) => t('检测到未声明的扩展能力：{capability}', { capability: key })),
  ]
}
