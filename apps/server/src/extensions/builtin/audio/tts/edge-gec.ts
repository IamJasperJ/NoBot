// GEC v2 摘要参照 edge-tts 7.3.1 的 drm.py；微软协议使用定制 SHA-256 状态和 CS64。
const initial = [1779033703, 3144134277, 1013904242, 2773480762, 1359893119, 2600822924, 528734635, 1541459225]
const initialWorking = [4255104674, 2435071207, 3192492180, 3442351626, 1811967817, 79508907, 4272990180, 66059218]
const schedule = [
  3945054110, 358115615, 2696978146, 217723578, 2787307148, 3520959633, 3235718560, 4192668342, 4039316851, 1884868174,
  1904797190, 15051571, 3529027680, 1920361828,
]
const constants = [
  1116352408, 1899447441, 3049323471, 3921009573, 961987163, 1508970993, 2453635748, 2870763221, 3624381080, 310598401,
  607225278, 1426881987, 1925078388, 2162078206, 2614888103, 3248222580, 3835390401, 4022224774, 264347078, 604807628,
  770255983, 1249150122, 1555081692, 1996064986, 2554220882, 2821834349, 2952996808, 3210313671, 3336571891, 3584528711,
  113926993, 338241895, 666307205, 773529912, 1294757372, 1396182291, 1695183700, 1986661051, 2177026350, 2456956037,
  2730485921, 2820302411, 3259730800, 3345764771, 3516065817, 3600352804, 4094571909, 275423344, 430227734, 506948616,
  659060556, 883997877, 958139571, 1322822218, 1537002063, 1747873779, 1955562222, 2024104815, 2227730452, 2361852424,
  2428436474, 2756734187, 3204031479, 3329325298,
]
const coefficients = [
  [3895366065, 3005677776],
  [1155409094, 2296378653],
  [1005282748, 693190712],
  [3365689651, 3005795295],
  [2367603217, 3557143765],
  [827258325, 652566332],
  [3911487921, 1618477510],
  [4037392853, 2192753147],
  [101076211, 4199654362],
  [3665427040, 545047652],
  [3201434976, 1010595059],
  [2314848760, 3536931681],
  [905590982, 3137643201],
  [3410617286, 3311559015],
]

const rol16 = (value: number) => ((value << 16) | (value >>> 16)) >>> 0
const sigma0 = (v: number) => ((v >>> 7) ^ (v << 25) ^ (v >>> 18) ^ (v << 14) ^ (v >>> 3)) >>> 0
const sigma1 = (v: number) => ((v >>> 17) ^ (v << 15) ^ (v >>> 19) ^ (v << 13) ^ (v >>> 10)) >>> 0
function expand(words: number[], start = 16) {
  for (let i = start; i < 64; i++)
    words[i] = (sigma1(words[i - 2]!) + words[i - 7]! + sigma0(words[i - 15]!) + words[i - 16]!) >>> 0
}
function rounds(state: number[], words: number[], start = 0) {
  let [a, b, c, d, e, f, g, h] = state as [number, number, number, number, number, number, number, number]
  for (let i = start; i < 64; i++) {
    const s1 = (e >>> 6) ^ (e << 26) ^ (e >>> 11) ^ (e << 21) ^ (e >>> 25) ^ (e << 7)
    const s0 = (a >>> 2) ^ (a << 30) ^ (a >>> 13) ^ (a << 19) ^ (a >>> 22) ^ (a << 10)
    const k = start === 14 && i === 14 ? 0xc9dc06a7 : constants[i]!
    const t1 = (h + s1 + (g ^ (e & (f ^ g))) + k + words[i]!) >>> 0
    const t2 = (s0 + ((a & b) | (c & (a | b)))) >>> 0
    h = g
    g = f
    f = e
    e = (d + t1) >>> 0
    d = c
    c = b
    b = a
    a = (t1 + t2) >>> 0
  }
  return [a, b, c, d, e, f, g, h]
}
export function edgeTokenHash(text: string) {
  const data = Buffer.from(text, 'ascii')
  // 上游预计算了固定前缀的状态，从首个块第 14 轮继续；这不是标准 SHA-256 的初始状态。
  const words = Array<number>(14).fill(0)
  words.push(data.readUIntBE(0, 3), data.readUInt32BE(3))
  for (let i = 16; i < 30; i++) {
    let value = schedule[i - 16]!
    if (i - 2 >= 14) value += (sigma1(words[i - 2]!) ^ (i === 16 ? 0x000b92c0 : 0)) >>> 0
    if (i - 7 >= 14) value += words[i - 7]!
    if (i - 15 >= 14) value += (sigma0(words[i - 15]!) ^ (i === 29 ? 0x059c0b80 : 0)) >>> 0
    words.push(value >>> 0)
  }
  words.push((sigma1(words[28]!) + words[23]! + sigma0(words[15]!) + words[14]! + 0xc9dc06a7 - constants[14]!) >>> 0)
  expand(words, 31)
  let state = rounds(initialWorking, words, 14).map((value, i) => (value + initial[i]!) >>> 0)
  const length = 57 + data.length
  const padded = Buffer.alloc(data.length - 7 + 1 + ((((55 - length) % 64) + 64) % 64) + 8)
  data.copy(padded, 0, 7)
  padded[data.length - 7] = 0x80
  padded.writeBigUInt64BE(BigInt(length * 8), padded.length - 8)
  for (let offset = 0; offset < padded.length; offset += 64) {
    const block = Array.from({ length: 16 }, (_, i) => padded.readUInt32BE(offset + i * 4))
    expand(block)
    state = rounds(state, block).map((value, i) => (value + state[i]!) >>> 0)
  }
  const digest = Buffer.alloc(32)
  state.forEach((value, i) => {
    digest.writeUInt32BE(value, i * 4)
  })
  // Math.imul 保留 32 位乘法低位，避免 JS 浮点乘法丢失 CS64 的有效位。
  const keys = [digest.readUInt32LE(0) | 1, digest.readUInt32LE(4) | 1]
  const factors = keys.map((key) => Math.imul(key, 0x82893933))
  const terms = coefficients.map(([coefficient], i) => Math.imul(coefficient!, factors[i % 2]!))
  const offsets = coefficients.map((pair) => pair[1]!)
  const little = Buffer.alloc(Math.ceil((data.length + 1) / 8) * 8)
  data.copy(little, 1)
  for (let i = 0; i < little.length / 4; i++) {
    const word = little.readUInt32LE(i * 4)
    let term = Math.imul(word, keys[i % 2]!)
    let offset = Math.imul(rol16(word), i % 2 === 0 ? 0xef0569fb : 0xc31713db)
    if (i === 0) {
      term = (term + Math.imul(0xf2f90b1a, factors[0]!)) >>> 0
      offset = (offset + 0x0b1a0000) >>> 0
    }
    terms.push(term)
    offsets.push(offset)
  }
  let swapAcc = 0,
    swapLast = 0,
    current = 0,
    acc = 0
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i]!,
      y = terms[i + 1]!
    let q = Math.imul(rol16(offsets[i]! + x), 0x76f50f34)
    swapAcc = (swapAcc + Math.imul(rol16(q), 0xc3efea97) + q) >>> 0
    q = Math.imul(rol16(offsets[i + 1]! + y), 0x1881ce3c)
    swapLast = (Math.imul(rol16(q), 0x35bd1ec9) + q) >>> 0
    swapAcc = (swapAcc + swapLast) >>> 0
    current = (Math.imul(current, keys[0]!) + x) >>> 0
    for (const factor of [0xcf98b111, 0x87085b9f, 0x12ceb96d, 0x257e1d83]) current = Math.imul(rol16(current), factor)
    acc = (acc + current) >>> 0
    current = (Math.imul(current, keys[1]!) + y) >>> 0
    for (const factor of [0xa27416f5, 0xd38396ff, 0x7c932b89, 0xbfa49f69]) current = Math.imul(rol16(current), factor)
    acc = (acc + current) >>> 0
  }
  const cs64 = Buffer.alloc(8)
  cs64.writeUInt32LE((swapLast ^ current) >>> 0)
  cs64.writeUInt32LE((swapAcc ^ acc) >>> 0, 4)
  return `${cs64.toString('hex')}-${digest.toString('hex')}`.toUpperCase()
}
