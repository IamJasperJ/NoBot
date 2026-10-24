interface TelegramWebApp {
  initData: string
  ready(): void
  expand(): void
  close(): void
  themeParams: Record<string, string>
  onEvent(name: string, callback: () => void): void
  offEvent(name: string, callback: () => void): void
  BackButton: { show(): void; onClick(callback: () => void): void; offClick(callback: () => void): void }
  HapticFeedback?: { selectionChanged(): void }
}
declare global {
  interface Window {
    Telegram?: { WebApp: TelegramWebApp }
  }
}
let loading: Promise<TelegramWebApp> | undefined
export function loadTelegram() {
  loading ??= new Promise<TelegramWebApp>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://telegram.org/js/telegram-web-app.js'
    script.onload = () =>
      window.Telegram?.WebApp ? resolve(window.Telegram.WebApp) : reject(new Error('Telegram WebApp'))
    script.onerror = reject
    document.head.append(script)
  })
  return loading
}
export function useMiniAppHaptic() {
  return () => {
    if (typeof window !== 'undefined') window.Telegram?.WebApp.HapticFeedback?.selectionChanged()
  }
}
