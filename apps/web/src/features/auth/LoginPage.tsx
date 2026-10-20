import { type FormEvent, useState } from 'react'
import { useLogin, useSession } from '../../api/auth'
import { Button, controlClass, Field } from '../../components/ui'
import { t } from '../../i18n'

/** 登录页：未登录时整页显示，登录成功后整页刷新进入应用 */
export function LoginPage() {
  const login = useLogin()
  const { setupRequired } = useSession()
  const [handle, setHandle] = useState('')
  const [password, setPassword] = useState('')

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!handle.trim() || !password) return
    login.mutate({ handle: handle.trim(), password })
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-zinc-50 px-4 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-5 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
      >
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">NoBot</h1>
          <p className="text-sm text-zinc-500">{t('登录后继续')}</p>
        </div>

        {setupRequired && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] leading-relaxed text-amber-800 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300">
            {t('还没有管理员账号：请在服务器上设置环境变量 NOBOT_ADMIN_PASSWORD 后重启服务。')}
          </p>
        )}

        <Field label={t('用户名')}>
          <input
            className={controlClass}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            // biome-ignore lint/a11y/noAutofocus: 登录页只有这一个表单，打开就该能直接输入
            autoFocus
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
          />
        </Field>
        <Field label={t('密码')}>
          <input
            className={controlClass}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>

        {login.error && !setupRequired && (
          <p className="text-[13px] text-red-600 dark:text-red-400">{login.error.message}</p>
        )}

        <Button
          type="submit"
          variant="primary"
          className="w-full"
          disabled={login.isPending || !handle.trim() || !password}
        >
          {login.isPending ? t('登录中…') : t('登录')}
        </Button>
      </form>
    </div>
  )
}
