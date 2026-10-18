import { useEffect, useRef, useState } from 'react'
import { useBackgrounds, useResolvedBackgroundId } from '../api/queries'
import { useAppearance } from '../stores/appearance'
import { useStageTransition } from '../stores/vn'

type Layer = { url: string; video: boolean }

/** 保留上一层，图片或视频首帧加载后再淡入。 */
export function Background({ chatId }: { chatId: string | null }) {
  const backgrounds = useBackgrounds()
  const id = useResolvedBackgroundId(chatId)
  const background = backgrounds.data?.find((b) => b.id === id)
  const { bgDim, bgBlur, bgFit, bgAnimate } = useAppearance()
  // 转场按会话的玩法预设（没开舞台指令的会话是默认的 300ms 溶解）
  const transition = useStageTransition((s) => s.value)
  const ms = transition.kind === 'none' ? 0 : transition.ms
  const duration = useRef(ms)
  duration.current = ms
  const url = background && (!bgAnimate && background.mime === 'image/gif' ? background.thumbUrl : background.url)
  const video = background?.mime.startsWith('video/') ?? false
  const [layers, setLayers] = useState<{ previous?: Layer; current?: Layer }>({})
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    let cancelled = false
    let frame = 0
    if (!url) {
      setVisible(false)
      return
    }
    const media = video ? document.createElement('video') : new Image()
    const loaded = () => {
      if (cancelled) return
      setLayers((old) => ({
        previous: duration.current === 0 || old.current?.url === url ? undefined : old.current,
        current: { url, video },
      }))
      if (duration.current === 0) {
        setVisible(true)
        return
      }
      setVisible(false)
      // 两帧之间提交透明层，保证缓存命中时仍有淡入效果。
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => setVisible(true))
      })
    }
    if (media instanceof HTMLVideoElement) {
      media.muted = true
      media.preload = 'auto'
      media.onloadeddata = loaded
    } else media.onload = loaded
    media.src = url
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      if (media instanceof HTMLVideoElement) {
        media.removeAttribute('src')
        media.load()
      } else media.onload = null
    }
  }, [url, video])

  useEffect(() => {
    if (!visible) return
    // 过渡完成后释放旧资源，避免透明区域透出上一张背景或继续解码旧动画。
    const timer = setTimeout(() => setLayers((old) => ({ current: old.current })), ms)
    return () => clearTimeout(timer)
  }, [visible, ms])

  const active = !!url && !!layers.current
  useEffect(() => {
    document.documentElement.toggleAttribute('data-has-bg', active)
    return () => document.documentElement.removeAttribute('data-has-bg')
  }, [active])

  const fit = { cover: 'cover', contain: 'contain', stretch: 'fill', center: 'none' } as const
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden transition-opacity duration-300"
      style={{ opacity: active ? 1 : 0, transitionDuration: `${ms}ms` }}
    >
      {transition.kind === 'fade' && <div className="absolute inset-0 bg-black" />}
      {[layers.previous, layers.current].map(
        (layer, index) =>
          layer && (
            <div
              key={layer.url}
              className="absolute inset-0 transition-opacity"
              style={{
                transitionDuration: `${ms}ms`,
                filter: `blur(${bgBlur}px)`,
                transform: bgBlur ? 'scale(1.05)' : undefined,
                // 溶解：旧图一直在下面，新图淡入；淡入淡出：旧图同时淡出，中间露出黑底
                opacity: index === 0 ? (transition.kind === 'fade' && visible ? 0 : 1) : visible ? 1 : 0,
              }}
            >
              {layer.video ? (
                <BackgroundVideo
                  url={layer.url}
                  animate={active && bgAnimate && (index === 1 || !visible)}
                  fit={fit[bgFit]}
                />
              ) : (
                <img src={layer.url} alt="" className="h-full w-full" style={{ objectFit: fit[bgFit] }} />
              )}
            </div>
          ),
      )}
      {bgDim > 0 && <div className="absolute inset-0 bg-white dark:bg-zinc-950" style={{ opacity: bgDim / 100 }} />}
    </div>
  )
}

function BackgroundVideo({
  url,
  animate,
  fit,
}: {
  url: string
  animate: boolean
  fit: React.CSSProperties['objectFit']
}) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const video = ref.current
    if (!video) return
    if (animate) void video.play().catch(() => {})
    else {
      video.pause()
      video.currentTime = 0
    }
  }, [animate])
  return (
    <video
      ref={ref}
      src={url}
      autoPlay={animate}
      loop
      muted
      playsInline
      preload="auto"
      className="h-full w-full"
      style={{ objectFit: fit }}
    />
  )
}
