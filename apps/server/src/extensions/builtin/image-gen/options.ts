export interface Option {
  value: string
  label: string
}

export function isImageModel(name: string): boolean {
  return /image|dall-e|flux|sd|stable|kolors|seedream|imagen|midjourney|cogview|wanx|qwen-image|hidream|recraft|ideogram/i.test(
    name,
  )
}
export function imageModelOptions(names: string[], imageOnly = false): Option[] {
  return [...new Set(names)]
    .filter((name) => !imageOnly || isImageModel(name))
    .sort((a, b) => Number(isImageModel(b)) - Number(isImageModel(a)) || a.localeCompare(b))
    .map((value) => ({ value, label: value + (isImageModel(value) ? '（图片）' : '') }))
}
const presets: [number, number, string][] = [
  [512, 512, '1:1，图标/头像'],
  [600, 600, '1:1，图标/头像'],
  [512, 768, '2:3，竖向角色卡'],
  [768, 512, '3:2，横向电影胶片'],
  [960, 540, '16:9，横向壁纸'],
  [540, 960, '9:16，竖向壁纸'],
  [1920, 1088, '16:9，1080p 横向壁纸'],
  [1088, 1920, '9:16，1080p 竖向壁纸'],
  [1280, 720, '16:9，720p 横向壁纸'],
  [720, 1280, '9:16，720p 竖向壁纸'],
  [1024, 1024, '1:1，SDXL'],
  [1152, 896, '9:7，SDXL 横图'],
  [896, 1152, '7:9，SDXL 竖图'],
  [1216, 832, '19:13，SDXL 横图'],
  [832, 1216, '13:19，SDXL 竖图'],
  [1344, 768, '7:4，SDXL 横图'],
  [768, 1344, '4:7，SDXL 竖图'],
  [1536, 640, '24:10，SDXL 横图'],
  [640, 1536, '10:24，SDXL 竖图'],
  [1536, 1024, '3:2，ChatGPT'],
  [1024, 1536, '2:3，ChatGPT'],
  [1024, 1792, '4:7，DALL-E'],
  [1792, 1024, '7:4，DALL-E'],
  [1280, 1280, '1:1，Z.AI'],
  [1568, 1056, '3:2，Z.AI'],
  [1056, 1568, '2:3，Z.AI'],
  [1472, 1088, '4:3，Z.AI'],
  [1088, 1472, '3:4，Z.AI'],
  [1728, 960, '16:9，Z.AI'],
  [960, 1728, '9:16，Z.AI'],
]
export const resolutionOptions = presets.map(([width, height, label]) => ({
  value: `${width}x${height}`,
  label: `${width}×${height}（${label}）`,
  width,
  height,
}))
export function orientResolution(width: number, height: number, orientation?: 'portrait' | 'landscape', snap = false) {
  const swapped = orientation === 'portrait' ? width > height : orientation === 'landscape' && width < height
  if (swapped) [width, height] = [height, width]
  if (swapped && snap) {
    const candidates = resolutionOptions.filter((r) => Math.sign(r.width - r.height) === Math.sign(width - height))
    const score = (r: { width: number; height: number }) =>
      Math.abs(Math.log((r.width * r.height) / (width * height))) * 2 +
      Math.abs(Math.log(r.width / r.height / (width / height)))
    const nearest = candidates.sort((a, b) => score(a) - score(b))[0]
    if (nearest) return { width: nearest.width, height: nearest.height }
  }
  return { width, height }
}
export function openaiSize(model: string, width: number, height: number) {
  if (/gpt-image-/i.test(model)) return width === height ? '1024x1024' : width > height ? '1536x1024' : '1024x1536'
  if (/dall-e-3/i.test(model)) return width === height ? '1024x1024' : width > height ? '1792x1024' : '1024x1792'
  if (/dall-e-2/i.test(model)) return width <= 512 && height <= 512 ? '512x512' : '1024x1024'
  return `${width}x${height}`
}
