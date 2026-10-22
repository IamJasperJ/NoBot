import type { ImageGenRuntime } from './runtime'
import { SettingsFooter } from './settings'

export function createImageSettingsFooter(runtime: ImageGenRuntime) {
  const { api, R, h, request } = runtime
  function ImageSettingsFooter(props: {
    settings: Record<string, unknown>
    onSettingsChange?: (settings: Record<string, unknown>) => void
  }) {
    const current = R.useRef(props)
    current.current = props
    const source = props.settings.source
    const url = props.settings.a1111Url
    const auth = props.settings.a1111Auth
    R.useEffect(() => {
      if (source !== 'a1111') return
      let active = true
      // 探测只修改草稿中的能力标记，不自动保存用户的设置。
      current.current.onSettingsChange?.({
        ...current.current.settings,
        a1111HasSchedulers: false,
        a1111HasADetailer: false,
      })
      void request('a1111/capabilities', { settings: current.current.settings })
        .then((result) => {
          if (!active) return
          current.current.onSettingsChange?.({
            ...current.current.settings,
            a1111HasSchedulers: !!result.schedulers?.length,
            a1111HasADetailer: result.adetailer === true,
          })
        })
        .catch(() => {
          // 测试连接按钮负责显示错误，能力探测失败时保留隐藏状态。
        })
      return () => {
        active = false
      }
    }, [source, url, auth])
    return h(SettingsFooter, { api, settings: props.settings })
  }
  return ImageSettingsFooter
}
