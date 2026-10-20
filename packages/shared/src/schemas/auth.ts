import { z } from 'zod'

/**
 * 多用户账号。每个用户的数据放在 DATA_DIR/users/<handle>/ 下（独立的 app.db 和资源文件），
 * 账号和会话存在 DATA_DIR/system.db。所有接口都要登录，cookie 会话。
 */

/** 用户名同时是数据目录名，所以只允许小写字母、数字、- 和 _，创建后不能改 */
export const userHandleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_-]{1,31}$/)

export const passwordSchema = z.string().min(8).max(256)

/** 当前登录的用户（GET /api/auth/me） */
export interface CurrentUserDTO {
  id: string
  handle: string
  name: string
  isAdmin: boolean
}

/** 管理员看到的用户列表项（GET /api/admin/users） */
export interface UserDTO extends CurrentUserDTO {
  disabled: boolean
  createdAt: number
  /** 最后一次登录的时间；没登录过为 null */
  lastLoginAt: number | null
}

export const loginInput = z.object({
  handle: userHandleSchema,
  password: z.string().min(1).max(256),
})
export type LoginInput = z.input<typeof loginInput>

/** 用户自己改密码：必须带上旧密码；改完后踢掉自己其他设备的会话 */
export const changePasswordInput = z.object({
  oldPassword: z.string().min(1).max(256),
  newPassword: passwordSchema,
})
export type ChangePasswordInput = z.input<typeof changePasswordInput>

/** 管理员新建用户 */
export const createUserInput = z.object({
  handle: userHandleSchema,
  name: z.string().trim().min(1).max(64),
  password: passwordSchema,
  isAdmin: z.boolean().default(false),
})
export type CreateUserInput = z.input<typeof createUserInput>

/**
 * 管理员修改用户：改显示名、禁用 / 启用、设为管理员、重置密码。
 * 禁用或重置密码时踢掉该用户全部会话。不能禁用自己、不能取消自己的管理员（避免没有管理员）。
 */
export const updateUserInput = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  disabled: z.boolean().optional(),
  isAdmin: z.boolean().optional(),
  password: passwordSchema.optional(),
})
export type UpdateUserInput = z.input<typeof updateUserInput>
