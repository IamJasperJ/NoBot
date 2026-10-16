export class STFormatError extends Error {}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function object(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {}
}

export function requireObject(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new STFormatError('酒馆文件内容必须是 JSON 对象')
  return value
}

export function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined
}

export function enumValue<T extends string>(value: unknown, values: readonly T[]): T | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? values[value] : undefined
}

/** 逐字段验证，避免一个损坏字段使整份文件无法导入；最后统一补默认值。 */
export function sanitize<T>(
  schema: {
    shape: Record<string, { safeParse: (value: unknown) => { success: boolean; data?: unknown } }>
    parse: (value: unknown) => T
  },
  input: Record<string, unknown>,
): T {
  const clean: Record<string, unknown> = {}
  for (const [key, validator] of Object.entries(schema.shape)) {
    const result = validator.safeParse(input[key])
    if (result.success) clean[key] = result.data
  }
  return schema.parse(clean)
}

export function readMap(input: Record<string, unknown>, map: Record<string, string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(map).map(([ours, theirs]) => [ours, input[theirs]]))
}

export function writeMap(input: Record<string, unknown>, map: Record<string, string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(map).map(([ours, theirs]) => [theirs, input[ours]]))
}
