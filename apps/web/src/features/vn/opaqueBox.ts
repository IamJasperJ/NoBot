import { useEffect, useState } from 'react'

/**
 * 立绘图里「真正有内容」的区域（去掉四周透明的边），用比例表示：left / top / right / bottom 都是 0–1。
 * 立绘 PNG 往往四周留了很多透明边，拖动框如果跟着整张图会比人物大一圈，不好操作，所以框按这个区域画。
 * 做法：把图缩到最长边 160px 画进 canvas，找 alpha 超过阈值的像素范围。每张图只算一次，结果缓存。
 * 图片跨域或解码失败时返回整张图（0,0,1,1）。
 */
export interface OpaqueBox {
  left: number
  top: number
  right: number
  bottom: number
}

const FULL: OpaqueBox = { left: 0, top: 0, right: 1, bottom: 1 }
const cache = new Map<string, Promise<OpaqueBox>>()

function measure(src: string): Promise<OpaqueBox> {
  return new Promise((resolve) => {
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => {
      try {
        const ratio = 160 / Math.max(img.naturalWidth, img.naturalHeight, 1)
        const w = Math.max(1, Math.round(img.naturalWidth * ratio))
        const h = Math.max(1, Math.round(img.naturalHeight * ratio))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) return resolve(FULL)
        ctx.drawImage(img, 0, 0, w, h)
        const data = ctx.getImageData(0, 0, w, h).data
        let minX = w
        let minY = h
        let maxX = -1
        let maxY = -1
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            // alpha 超过约 8% 才算内容，忽略抗锯齿留下的极淡像素
            if ((data[(y * w + x) * 4 + 3] ?? 0) > 20) {
              if (x < minX) minX = x
              if (x > maxX) maxX = x
              if (y < minY) minY = y
              if (y > maxY) maxY = y
            }
          }
        }
        if (maxX < 0) return resolve(FULL)
        resolve({ left: minX / w, top: minY / h, right: (maxX + 1) / w, bottom: (maxY + 1) / h })
      } catch {
        resolve(FULL)
      }
    }
    img.onerror = () => resolve(FULL)
    img.src = src
  })
}

/** 立绘有内容的区域；还没算出来时是整张图 */
export function useOpaqueBox(src: string | null | undefined): OpaqueBox {
  const [box, setBox] = useState<OpaqueBox>(FULL)
  useEffect(() => {
    if (!src) return
    let alive = true
    let pending = cache.get(src)
    if (!pending) {
      pending = measure(src)
      cache.set(src, pending)
    }
    void pending.then((value) => {
      if (alive) setBox(value)
    })
    return () => {
      alive = false
    }
  }, [src])
  return src ? box : FULL
}
