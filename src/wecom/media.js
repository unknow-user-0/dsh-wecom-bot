// 企微媒体解密 + 魔数识别
//
// 协议事实（企微文档 path/101463「机器人长连接」媒体资源段）：
//   回调体 { "msgtype": "image", "image": { "url": "...", "aeskey": "..." } }
//   url      : 资源下载地址，5 分钟内有效
//   aeskey   : 每个下载链接唯一（≠ 回调模式的 EncodingAESKey）
//   加密方式 : AES-256-CBC，PKCS#7 填充至 **32 字节** 的倍数
//              IV = aeskey 前 16 字节；key = base64(aeskey 补齐 '=') → 32 字节
//
// 两个必须踩住的坑：
//   1. 官方 pad 值可达 32，Node 的自动去填充只认 16，会抛 → 必须 setAutoPadding(false) 手动 strip
//   2. 解不出真内容就返回 undefined，绝不把密文当图片/文件喂给下游（否则模型会「看到」一张乱码图）

import { createDecipheriv } from 'node:crypto'

/** 密钥候选：官方口径 aeskey = base64(32 字节 key)；另把原串 / 补 '==' / hex / utf8 截 32 都试一遍 */
export function mediaKeys(aeskey) {
  const keys = []
  const push = (key) => {
    if (key.length === 32 && !keys.some((k) => k.equals(key))) keys.push(key)
  }
  const raw = String(aeskey || '')
  if (raw === '') return keys
  for (const spec of [`${raw}=`, raw, `${raw}==`]) {
    try { push(Buffer.from(spec, 'base64')) } catch {}
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) push(Buffer.from(raw, 'hex'))
  push(Buffer.from(raw, 'utf8').subarray(0, 32))
  return keys
}

/** 官方填充是「补到 32 字节倍数」，pad 值可达 32 —— 超出 16 时 node 自动去填充会抛，故手动去 */
export function stripPkcs7(plain) {
  if (plain.length === 0) return undefined
  const pad = plain[plain.length - 1]
  if (pad < 1 || pad > 32 || pad > plain.length) return plain
  for (let i = plain.length - pad; i < plain.length; i += 1) {
    if (plain[i] !== pad) return plain
  }
  return plain.subarray(0, plain.length - pad)
}

/**
 * 文件（docx/pdf/zip…）不能用图片魔数校验，改用「严格 PKCS#7」判定：
 * 末字节 pad ∈ [1,32] 且末 pad 字节全等于 pad，且确实被裁掉了。
 */
export function stripPkcs7Strict(plain) {
  const out = stripPkcs7(plain)
  if (out === undefined || out.length === 0) return undefined
  return out.length < plain.length ? out : undefined
}

/**
 * @param {Buffer|Uint8Array} blob 下载到的原始字节
 * @param {string} aeskey
 * @param {(buf: Buffer) => boolean} validate 明文校验（图片用魔数，文件用 () => true）
 * @param {boolean} allowPlain 是否允许明文兜底（图片可以；文件只在没 aeskey 时）
 */
export function mediaDecrypt(blob, aeskey, validate = looksLikeImage, allowPlain = true) {
  const raw = Buffer.from(blob)
  const sources = [raw]
  // 有的下载结果是 base64 文本而非二进制密文，一并当候选
  const text = raw.toString('utf8').trim()
  if (text !== '' && text.length % 4 === 0 && /^[A-Za-z0-9+/=\s]+$/.test(text)) {
    try {
      const decoded = Buffer.from(text, 'base64')
      if (decoded.length > 0 && decoded.length % 16 === 0 && !decoded.equals(raw)) sources.push(decoded)
    } catch {}
  }
  for (const source of sources) {
    for (const key of mediaKeys(aeskey)) {
      try {
        const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16))
        decipher.setAutoPadding(false)
        const padded = Buffer.concat([decipher.update(source), decipher.final()])
        const plain = stripPkcs7Strict(padded)
        if (plain !== undefined && validate(plain)) return plain
      } catch {}
    }
    if (allowPlain && validate(source)) return source
  }
  return undefined
}

export function looksLikeImage(buf) {
  return sniffImageMime(buf) !== undefined
}

// ISO BMFF（ftyp）容器里图片和视频共用同一个盒子头，只能看 brand 区分。
// 曾经这里只判 b[4..8]==='ftyp' 就返回 image/heic —— 而**所有 mp4/mov 都是 ftyp**，
// 结果私聊发的视频被当成 heic 图片落盘，模型拿到的是一张读不出来的「图」。
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'])
const AVIF_BRANDS = new Set(['avif', 'avis'])
const MOV_BRANDS = new Set(['qt  '])

/**
 * 取 ftyp 盒里的 brand 列表（major brand + compatible brands）。
 * 不是 ftyp 容器返回 null。
 */
export function ftypBrands(buffer) {
  const b = Buffer.from(buffer.buffer ?? buffer, buffer.byteOffset ?? 0, buffer.byteLength ?? buffer.length)
  if (b.length < 12) return null
  if (b.subarray(4, 8).toString('latin1') !== 'ftyp') return null
  const size = b.readUInt32BE(0)
  // box size 不可信时按 64 字节封顶，够放 12 个 brand
  const end = size >= 16 && size <= b.length ? size : Math.min(b.length, 64)
  const brands = []
  const major = b.subarray(8, 12).toString('latin1')
  if (/^[\x20-\x7e]{4}$/.test(major)) brands.push(major)
  // 12..16 是 minor version（二进制数字），兼容 brand 从 16 开始
  for (let i = 16; i + 4 <= end; i += 4) {
    const tag = b.subarray(i, i + 4).toString('latin1')
    if (!/^[\x20-\x7e]{4}$/.test(tag)) break
    brands.push(tag)
  }
  return brands.length > 0 ? brands : null
}

/** ftyp 容器是视频还是图片：返回 'image' | 'video'，不是 ftyp 返回 null */
export function ftypKind(buffer) {
  const brands = ftypBrands(buffer)
  if (brands === null) return null
  if (brands.some((t) => AVIF_BRANDS.has(t) || HEIF_BRANDS.has(t))) return 'image'
  return 'video'
}

export function sniffImageMime(buffer) {
  const b = Buffer.from(buffer.buffer ?? buffer, buffer.byteOffset ?? 0, buffer.byteLength ?? buffer.length)
  if (b.length < 12) return undefined
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif'
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  if (b.subarray(0, 2).toString('latin1') === 'BM') return 'image/bmp'
  if (b.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brands = ftypBrands(b) || []
    if (brands.some((t) => AVIF_BRANDS.has(t))) return 'image/avif'
    if (brands.some((t) => HEIF_BRANDS.has(t))) return 'image/heic'
    return undefined // mp4 / mov / m4v 等视频容器：不是图片
  }
  return undefined
}

/**
 * 文件回调不一定带 filename，靠魔数补扩展名 —— 否则文件名只剩 msgid 哈希，
 * 模型看不出这是什么，只能猜。
 */
export function sniffFileExt(buffer) {
  const b = Buffer.from(buffer.buffer ?? buffer, buffer.byteOffset ?? 0, buffer.byteLength ?? buffer.length)
  if (b.length < 8) return ''
  const image = sniffImageMime(b)
  if (image !== undefined) return imageExt(image)
  // 视频容器：以前没有分支，mp4 被 sniffImageMime 误判成 heic 时侥幸有扩展名，
  // 修正嗅探后必须补上，否则文件名只剩 msgid 哈希。
  const kind = ftypKind(b)
  if (kind === 'video') {
    const brands = ftypBrands(b) || []
    if (brands.some((t) => MOV_BRANDS.has(t))) return '.mov'
    if (brands.some((t) => t === 'M4V ' || t === 'M4VH' || t === 'M4VP')) return '.m4v'
    return '.mp4'
  }
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'AVI ') return '.avi'
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return '.mkv'
  const head = b.subarray(0, 4).toString('latin1')
  if (head === 'PK\u0003\u0004' || head === 'PK\u0005\u0006') return '.zip'
  if (b.subarray(0, 5).toString('latin1') === '%PDF-') return '.pdf'
  if (b[0] === 0x1f && b[1] === 0x8b) return '.gz'
  if (b[0] === 0x37 && b[1] === 0x7a && b[2] === 0xbc && b[3] === 0xaf) return '.7z'
  if (head === 'Rar!') return '.rar'
  // docx/xlsx/pptx 都是 zip，上面已归到 .zip；WPS/Office 旧格式是 OLE 复合文档
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return '.doc'
  return ''
}

export function imageExt(mimeType) {
  if (mimeType === 'image/jpeg') return '.jpg'
  if (mimeType === 'image/gif') return '.gif'
  if (mimeType === 'image/webp') return '.webp'
  if (mimeType === 'image/bmp') return '.bmp'
  if (mimeType === 'image/heic') return '.heic'
  if (mimeType === 'image/avif') return '.avif'
  return '.png'
}

/** 明文是不是视频容器（mp4/mov/m4v/avi/mkv）—— 入站附件据此决定当视频还是当文件 */
export function looksLikeVideo(buffer) {
  const b = Buffer.from(buffer.buffer ?? buffer, buffer.byteOffset ?? 0, buffer.byteLength ?? buffer.length)
  if (b.length < 12) return false
  if (ftypKind(b) === 'video') return true
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'AVI ') return true
  return b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3
}

/** 引擎单图预算 2 MiB，手机直出照片动辄十几 MB，不压就会被整张丢掉 */
const IMAGE_FIT_TARGET = 1_400_000
let sharpLib
let sharpProbed = false
function getSharp(requireFn) {
  if (sharpProbed) return sharpLib
  sharpProbed = true
  try { sharpLib = requireFn ? requireFn('sharp') : undefined } catch { sharpLib = undefined }
  return sharpLib
}

/** 多于一页 = 动图（GIF / 动画 WebP） */
async function isAnimated(sharp, buffer) {
  try {
    const meta = await sharp(buffer, { animated: true }).metadata()
    return Number(meta.pages || 1) > 1
  } catch {
    return false
  }
}

/**
 * 动图压缩：只缩尺寸 + 抽帧，始终输出 GIF，绝不转静图。
 *
 * 为什么要抽帧：GIF 不像 JPEG 那样有质量旋钮，缩边会重采样出更多颜色，
 * 常常【越压越大】（实测 2.0 MB 缩到 0.7 倍变成 6.4 MB）。
 * 真正的体积杠杆只有「帧数 × 像素数」两个。
 *
 * @returns {Promise<{data: Buffer, mimeType: string}|null>} null = 压不进预算
 */
async function fitAnimatedToBudget(sharp, buffer, mimeType) {
  let meta
  try {
    meta = await sharp(buffer, { animated: true }).metadata()
  } catch {
    return null
  }
  const pages = Number(meta.pages || 1)
  if (pages <= 1) return null
  const delays = await readDelays(buffer, pages)

  // 先缩边（保帧），再抽帧（保尺寸）。两步都试，取第一个进预算的。
  const widthSteps = [1, 0.8, 0.66, 0.5, 0.4]
  const frameSteps = [1, 2, 3, 4, 6, 8]

  for (const fs of frameSteps) {
    for (const ws of widthSteps) {
      try {
        const keep = pickFrames(pages, fs)
        if (keep.length < 2) continue // 只剩 1 帧就不是动图了，别假装
        const slices = []
        for (const page of keep) {
          slices.push(await sharp(buffer, { page, pages: 1 }).png().toBuffer())
        }
        const width = ws === 1 ? undefined : Math.max(48, Math.round((meta.width || 0) * ws))
        let enc = sharp(slices, { join: { animated: true } })
        if (width) enc = enc.resize({ width, withoutEnlargement: true })
        // ⚠ 抽帧必须补偿延时，否则总时长被砍掉，动图播放快好几倍。
        //   每帧延时要乘上被抽掉的倍数，让「总播放时长」保持不变。
        const delaysOut = keep.map((p, idx) => {
          const orig = delays[p] || 100
          // 末帧要覆盖「原图最后一帧到结尾」的那一段，不能按 1 算，
          // 否则总时长会比原图短一截（实测 30 帧 2400ms 会变成 2320ms）。
          const next = idx + 1 < keep.length ? keep[idx + 1] : pages
          const span = Math.max(1, next - p)
          return Math.max(20, Math.round(orig * span))
        })
        const out = await enc.gif({
          delay: delaysOut,
          loop: 0,
          effort: 7,
          dither: 1,
        }).toBuffer()
        if (out.length <= IMAGE_FIT_TARGET && out.length < buffer.length) {
          const check = await sharp(out, { animated: true }).metadata()
          if (Number(check.pages || 1) === keep.length) {
            return { data: out, mimeType: 'image/gif' }
          }
        }
      } catch {}
    }
  }
  return null
}

/** 读出每帧原始延时（毫秒），读不到就给 100ms */
async function readDelays(buffer, pages) {
  try {
    const meta = await sharpLib(buffer, { animated: true }).metadata()
    if (Array.isArray(meta.delay) && meta.delay.length) return meta.delay
  } catch {}
  return Array(pages).fill(100)
}

/** 按步长抽帧，索引均匀分布，尽量保住首尾帧 */
function pickFrames(pages, step) {
  if (step <= 1) return Array.from({ length: pages }, (_, i) => i)
  const out = []
  for (let i = 0; i < pages; i += step) out.push(i)
  const last = pages - 1
  if (out[out.length - 1] !== last && last > 0) {
    // 末帧很可能是关键动作，补进来（若和倒数第二帧挨太近就不补）
    if (last - out[out.length - 1] > 1) out.push(last)
  }
  return out
}

/** 用 sharp 逐级缩边 + 降质量，压到预算内；压不动就交回原图让上层提示 */
export async function fitImageToBudget(buffer, mimeType, requireFn) {
  if (buffer.length <= IMAGE_FIT_TARGET) return { data: buffer, mimeType }
  const sharp = getSharp(requireFn)
  if (!sharp) return { data: buffer, mimeType }

  // 动图单独走一条路：GIF 是有损缩放的，直接按静态图处理会把动画压没。
  // 以前所有格式一律输出 jpeg，等于「GIF 一旦超预算就变静图」，
  // 而且因为出站压缩长期失效（__wecomRequire 从未赋值），这个 bug 一直藏着。
  if (await isAnimated(sharp, buffer)) {
    const anim = await fitAnimatedToBudget(sharp, buffer, mimeType)
    if (anim) return anim
    // 压不动：原样交回。上层照发，企微那边可能因为太大拒收，
    // 但那比「悄悄把动画换成一张静图」诚实 —— 用户以为发了动图。
    return { data: buffer, mimeType }
  }

  const plans = []
  for (const width of [2048, 1600, 1280, 1024, 800]) {
    for (const quality of [82, 72]) plans.push({ width, quality })
  }
  for (const plan of plans) {
    try {
      const out = await sharp(buffer, { failOn: 'none' })
        .rotate()
        .flatten({ background: '#ffffff' })
        .resize({ width: plan.width, height: plan.width, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: plan.quality, mozjpeg: true })
        .toBuffer()
      if (out.length <= IMAGE_FIT_TARGET && out.length < buffer.length) {
        return { data: out, mimeType: 'image/jpeg' }
      }
    } catch {}
  }
  return { data: buffer, mimeType }
}

/**
 * 预演：这张图真发出去会长什么样？
 *
 * 面板选完图就调一次，把「会不会被抽帧、抽到几帧、总时长还对不对、压没压进预算」
 * 直接摆给用户看。不这么做的话，用户选了一张 30 帧的表情包，发出去变成 15 帧
 * 才发现 —— 那时候已经在对面的聊天窗里了。
 *
 * @returns {Promise<{
 *   bytes: number, width: number, height: number, animated: boolean, pages: number,
 *   durationMs: number, finalBytes: number, finalPages: number, finalDurationMs: number,
 *   finalWidth: number, finalMime: string, dropped: boolean, droppedFrames: number,
 *   fitsBudget: boolean, note: string
 * }|null>} null = 解不开（不是图片 / 没装 sharp）
 */
export async function describeImage(buffer, mimeType, requireFn) {
  const sharp = getSharp(requireFn)
  const base = {
    bytes: buffer.length,
    width: 0, height: 0, animated: false, pages: 1, durationMs: 0,
    finalBytes: buffer.length, finalPages: 1, finalDurationMs: 0, finalWidth: 0,
    finalMime: mimeType, dropped: false, droppedFrames: 0,
    fitsBudget: buffer.length <= IMAGE_FIT_TARGET, note: '',
  }
  if (!sharp) {
    base.note = '没装 sharp，发之前不会压缩（超预算的图可能被企微拒收）'
    return base
  }

  let meta
  try {
    meta = await sharp(buffer, { animated: true }).metadata()
  } catch {
    return null
  }
  const pages = Number(meta.pages || 1)
  const delays = pages > 1 ? await readDelays(buffer, pages) : []
  const durationMs = delays.reduce((a, b) => a + (b || 0), 0)
  Object.assign(base, {
    width: meta.width || 0,
    height: meta.pageHeight || meta.height || 0,
    animated: pages > 1,
    pages,
    durationMs,
  })

  if (buffer.length <= IMAGE_FIT_TARGET) {
    base.finalWidth = meta.width || 0
    // 不压缩时「最终形态」就是原图本身，别漏赋值 —— 否则面板会显示成
    // 「8 帧动图 → 1 帧」，用户以为动画没了，其实根本没动过。
    base.finalPages = pages
    base.finalDurationMs = durationMs
    base.note = pages > 1
      ? `动图 ${pages} 帧，${(durationMs / 1000).toFixed(1)} 秒，不用压`
      : '大小在预算内，原样发'
    return base
  }

  // 真压一遍看结果（这是用户最后真的会发出去的那个东西）
  const fit = await fitImageToBudget(buffer, mimeType, requireFn)
  let fm = null
  try { fm = await sharp(fit.data, { animated: true }).metadata() } catch {}
  const fPages = Number(fm?.pages || 1)
  const fDelays = fPages > 1 ? await readDelays(fit.data, fPages) : []
  const fDur = fDelays.reduce((a, b) => a + (b || 0), 0)

  Object.assign(base, {
    finalBytes: fit.data.length,
    finalPages: fPages,
    finalDurationMs: fDur,
    finalWidth: fm?.width || meta.width || 0,
    finalMime: fit.mimeType,
    dropped: pages > 1 && fPages < pages,
    droppedFrames: Math.max(0, pages - fPages),
    fitsBudget: fit.data.length <= IMAGE_FIT_TARGET,
  })

  if (pages > 1 && fPages > 1) {
    base.note = base.dropped
      ? `动图 ${pages} 帧太大（${(buffer.length / 1048576).toFixed(1)} MB），会自动抽成 ${fPages} 帧，`
        + `总时长还是 ${(fDur / 1000).toFixed(1)} 秒，播放速度不变`
      : `动图 ${pages} 帧已经压进预算（${(fit.data.length / 1048576).toFixed(1)} MB），帧数没动`
  } else if (pages > 1 && fPages <= 1) {
    base.note = '⚠ 这张动图压不进预算，又没法安全抽帧，可能会被企微拒收'
  } else if (base.fitsBudget) {
    base.note = `会压缩到 ${(fit.data.length / 1048576).toFixed(1)} MB 再发`
  } else {
    base.note = '⚠ 压不进预算，可能会被企微拒收'
  }
  return base
}
