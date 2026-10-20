import type { UserDTO } from '@nobot/shared'
import { type FormEvent, type ReactNode, useState } from 'react'
import {
  useChangePassword,
  useCreateUser,
  useDeleteUser,
  useLogout,
  useSession,
  useUpdateUser,
  useUsers,
} from '../../api/auth'
import { Section } from '../../components/form'
import { Menu, MenuDivider, MenuEntry } from '../../components/menu'
import { Avatar, Button, badgeClass, controlClass, cx, Dialog, Field } from '../../components/ui'
import { t } from '../../i18n'
import { errorMessage, toast } from '../../stores/toast'

/** 设置页里的「账号」分组：当前用户、改密码、退出登录；管理员多一个用户管理入口 */
export function AccountSection() {
  const { user } = useSession()
  const logout = useLogout()
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [usersOpen, setUsersOpen] = useState(false)
  if (!user) return null

  return (
    <Section title={t('账号')}>
      <div className="flex flex-wrap items-center gap-3">
        <Avatar name={user.name} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <span className="truncate">{user.name}</span>
            {user.isAdmin && <span className={badgeClass}>{t('管理员')}</span>}
          </div>
          <div className="truncate text-xs text-zinc-500">@{user.handle}</div>
        </div>
        <div className="flex gap-2">
          {user.isAdmin && (
            <Button size="sm" onClick={() => setUsersOpen(true)}>
              {t('用户管理…')}
            </Button>
          )}
          <Button size="sm" onClick={() => setPasswordOpen(true)}>
            {t('修改密码')}
          </Button>
          <Button
            size="sm"
            disabled={logout.isPending}
            onClick={() => logout.mutate(undefined, { onError: (e) => toast.error(errorMessage(e)) })}
          >
            {t('退出登录')}
          </Button>
        </div>
      </div>
      <ChangePasswordDialog open={passwordOpen} onClose={() => setPasswordOpen(false)} />
      {user.isAdmin && <UsersDialog open={usersOpen} onClose={() => setUsersOpen(false)} />}
    </Section>
  )
}

/** 对话框底部的操作行：取消 + 主按钮 */
function DialogActions({ children, onCancel }: { children: ReactNode; onCancel: () => void }) {
  return (
    <div className="flex justify-end gap-2 pt-1">
      <Button onClick={onCancel}>{t('取消')}</Button>
      {children}
    </div>
  )
}

function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const change = useChangePassword()
  const [oldPassword, setOld] = useState('')
  const [newPassword, setNew] = useState('')
  const [confirm, setConfirm] = useState('')
  const mismatch = confirm !== '' && confirm !== newPassword
  const tooShort = newPassword !== '' && newPassword.length < 8

  const close = () => {
    setOld('')
    setNew('')
    setConfirm('')
    change.reset()
    onClose()
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!oldPassword || newPassword.length < 8 || mismatch) return
    change.mutate(
      { oldPassword, newPassword },
      {
        onSuccess: () => {
          toast.info(t('密码已修改，其他设备需要重新登录'))
          close()
        },
      },
    )
  }

  return (
    <Dialog open={open} onClose={close} title={t('修改密码')} className="w-[min(420px,calc(100vw-32px))]">
      <form onSubmit={submit} className="space-y-4">
        <Field label={t('当前密码')}>
          <input
            className={controlClass}
            type="password"
            autoComplete="current-password"
            value={oldPassword}
            onChange={(e) => setOld(e.target.value)}
          />
        </Field>
        <Field label={t('新密码')} hint={tooShort ? t('至少 8 位') : undefined}>
          <input
            className={controlClass}
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNew(e.target.value)}
          />
        </Field>
        <Field label={t('再输入一次新密码')} hint={mismatch ? t('两次输入的密码不一致') : undefined}>
          <input
            className={controlClass}
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
        {change.error && <p className="text-[13px] text-red-600 dark:text-red-400">{change.error.message}</p>}
        <DialogActions onCancel={close}>
          <Button
            type="submit"
            variant="primary"
            disabled={change.isPending || !oldPassword || newPassword.length < 8 || confirm !== newPassword}
          >
            {t('保存')}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

const formatTime = (time: number) => new Date(time).toLocaleString()

/** 管理员的用户列表：新建、禁用 / 启用、设为管理员、重置密码、删除 */
function UsersDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user: me } = useSession()
  const users = useUsers()
  const update = useUpdateUser()
  const remove = useDeleteUser()
  const [creating, setCreating] = useState(false)
  const [resetting, setResetting] = useState<UserDTO | null>(null)

  const patch = (target: UserDTO, input: Parameters<typeof update.mutate>[0]['input']) =>
    update.mutate({ id: target.id, input }, { onError: (e) => toast.error(errorMessage(e)) })

  // 子对话框放在用户管理对话框外面：嵌套时子对话框的 close 事件会沿 React 树冒泡，把外层一起关掉
  return (
    <>
      <Dialog open={open} onClose={onClose} title={t('用户管理')}>
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-zinc-500">{t('每个用户的角色、会话、世界书、预设、连接和设置都相互独立。')}</p>
            <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
              {t('新建用户')}
            </Button>
          </div>

          {users.error && <p className="text-[13px] text-red-600 dark:text-red-400">{users.error.message}</p>}

          <ul className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
            {users.data?.map((u) => {
              const self = u.id === me?.id
              return (
                <li key={u.id} className={cx('flex items-center gap-3 px-3 py-2.5', u.disabled && 'opacity-60')}>
                  <Avatar name={u.name} size={32} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                      <span className="truncate">{u.name}</span>
                      <span className="text-xs font-normal text-zinc-500">@{u.handle}</span>
                      {u.isAdmin && <span className={badgeClass}>{t('管理员')}</span>}
                      {u.disabled && <span className={badgeClass}>{t('已禁用')}</span>}
                      {self && <span className={badgeClass}>{t('我')}</span>}
                    </div>
                    <div className="truncate text-xs text-zinc-500">
                      {u.lastLoginAt ? t('上次登录 {time}', { time: formatTime(u.lastLoginAt) }) : t('还没登录过')}
                    </div>
                  </div>
                  <Menu>
                    <MenuEntry onClick={() => setResetting(u)}>{t('重置密码…')}</MenuEntry>
                    <MenuEntry disabled={self} onClick={() => patch(u, { isAdmin: !u.isAdmin })}>
                      {u.isAdmin ? t('取消管理员') : t('设为管理员')}
                    </MenuEntry>
                    <MenuEntry disabled={self} onClick={() => patch(u, { disabled: !u.disabled })}>
                      {u.disabled ? t('启用') : t('禁用')}
                    </MenuEntry>
                    <MenuDivider />
                    <MenuEntry
                      danger
                      disabled={self}
                      onClick={() => {
                        if (
                          !confirm(
                            t('删除用户「{name}」？该用户的数据会移到 deleted-users 目录，不会立即清除。', {
                              name: u.name,
                            }),
                          )
                        )
                          return
                        remove.mutate(u.id, { onError: (e) => toast.error(errorMessage(e)) })
                      }}
                    >
                      {t('删除')}
                    </MenuEntry>
                  </Menu>
                </li>
              )
            })}
          </ul>
        </div>
      </Dialog>
      <CreateUserDialog open={creating} onClose={() => setCreating(false)} />
      <ResetPasswordDialog target={resetting} onClose={() => setResetting(null)} />
    </>
  )
}

function CreateUserDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateUser()
  const [handle, setHandle] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [isAdmin, setIsAdmin] = useState(false)
  const handleValid = /^[a-z0-9][a-z0-9_-]{1,31}$/.test(handle.trim().toLowerCase())

  const close = () => {
    setHandle('')
    setName('')
    setPassword('')
    setIsAdmin(false)
    create.reset()
    onClose()
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!handleValid || password.length < 8) return
    create.mutate(
      { handle: handle.trim().toLowerCase(), name: name.trim() || handle.trim(), password, isAdmin },
      {
        onSuccess: () => {
          toast.info(t('已创建用户'))
          close()
        },
      },
    )
  }

  return (
    <Dialog open={open} onClose={close} title={t('新建用户')} className="w-[min(420px,calc(100vw-32px))]">
      <form onSubmit={submit} className="space-y-4">
        <Field label={t('用户名')} hint={t('登录用，也是数据目录名：小写字母、数字、- 和 _，2–32 位，创建后不能改')}>
          <input
            className={controlClass}
            autoCapitalize="none"
            spellCheck={false}
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
          />
        </Field>
        <Field label={t('显示名')}>
          <input className={controlClass} value={name} placeholder={handle} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('初始密码')} hint={t('至少 8 位；用户登录后可以自己修改')}>
          <input
            className={controlClass}
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
          {t('设为管理员')}
        </label>
        {create.error && <p className="text-[13px] text-red-600 dark:text-red-400">{create.error.message}</p>}
        <DialogActions onCancel={close}>
          <Button type="submit" variant="primary" disabled={create.isPending || !handleValid || password.length < 8}>
            {t('创建')}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

function ResetPasswordDialog({ target, onClose }: { target: UserDTO | null; onClose: () => void }) {
  const update = useUpdateUser()
  const [password, setPassword] = useState('')

  const close = () => {
    setPassword('')
    update.reset()
    onClose()
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!target || password.length < 8) return
    update.mutate(
      { id: target.id, input: { password } },
      {
        onSuccess: () => {
          toast.info(t('密码已重置，该用户需要重新登录'))
          close()
        },
      },
    )
  }

  return (
    <Dialog
      open={!!target}
      onClose={close}
      title={t('重置「{name}」的密码', { name: target?.name ?? '' })}
      className="w-[min(420px,calc(100vw-32px))]"
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label={t('新密码')} hint={t('至少 8 位；重置后该用户所有设备都要重新登录')}>
          <input
            className={controlClass}
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {update.error && <p className="text-[13px] text-red-600 dark:text-red-400">{update.error.message}</p>}
        <DialogActions onCancel={close}>
          <Button type="submit" variant="primary" disabled={update.isPending || password.length < 8}>
            {t('重置')}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}
