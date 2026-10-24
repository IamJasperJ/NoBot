import { useEffect, useRef, useState } from 'react'
import { useTranscribe } from '../api/audio'

/** 录音结束即识别；取消与卸载均释放麦克风，旧请求不能覆盖新录音的文本。 */
export function useVoiceRecorder(maxDurationMs = 120000) {
  const mutation = useTranscribe()
  const [state, setState] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const [text, setText] = useState('')
  const [error, setError] = useState<unknown>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const revision = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const cancel = () => {
    revision.current++
    clearTimeout(timer.current)
    if (recorder.current) recorder.current.onstop = null
    if (recorder.current?.state === 'recording') recorder.current.stop()
    stream.current?.getTracks().forEach((track) => {
      track.stop()
    })
    recorder.current = null
    stream.current = null
    setState('idle')
  }
  useEffect(
    () => () => {
      revision.current++
      clearTimeout(timer.current)
      if (recorder.current) recorder.current.onstop = null
      if (recorder.current?.state === 'recording') recorder.current.stop()
      stream.current?.getTracks().forEach((track) => {
        track.stop()
      })
    },
    [],
  )
  const start = async () => {
    cancel()
    const version = revision.current
    setError(null)
    setText('')
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (version !== revision.current) {
        media.getTracks().forEach((track) => {
          track.stop()
        })
        return
      }
      stream.current = media
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4'].find((mime) => MediaRecorder.isTypeSupported(mime))
      const active = new MediaRecorder(media, mimeType ? { mimeType } : undefined)
      recorder.current = active
      const chunks: Blob[] = []
      const started = performance.now()
      active.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data)
      }
      active.onstop = async () => {
        clearTimeout(timer.current)
        media.getTracks().forEach((track) => {
          track.stop()
        })
        if (version !== revision.current) return
        setState('transcribing')
        try {
          const result = await mutation.mutateAsync({
            file: new Blob(chunks, { type: active.mimeType }),
            durationMs: Math.round(performance.now() - started),
          })
          if (version === revision.current) setText(result.text)
        } catch (err) {
          if (version === revision.current) setError(err)
        } finally {
          if (version === revision.current) setState('idle')
        }
      }
      active.onerror = (event) => {
        if (version === revision.current) {
          cancel()
          setError(event)
        }
      }
      active.start()
      timer.current = setTimeout(() => {
        if (active.state === 'recording') active.stop()
      }, maxDurationMs)
      setState('recording')
    } catch (err) {
      if (version === revision.current) {
        stream.current?.getTracks().forEach((track) => {
          track.stop()
        })
        setError(err)
        setState('idle')
      }
    }
  }
  return {
    state,
    text,
    error,
    start,
    stop: () => {
      if (recorder.current?.state === 'recording') recorder.current.stop()
    },
    cancel,
  }
}
