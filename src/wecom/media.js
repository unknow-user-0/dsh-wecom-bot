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

export function sniffImageMime(buffer) {
  const b = Buffer.from(buffer.buffer ?? buffer, buffer.byteOffset ?? 0, buffer.byteLength ?? buffer.length)
  if (b.length < 12) return undefined
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif'
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  if (b.subarray(0, 2).toString('latin1') === 'BM') return 'image/bmp'
  if (b.subarray(4, 8).toString('latin1') === 'ftyp') return 'image/heic'
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
  return '.png'
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

/** 用 sharp 逐级缩边 + 降质量，压到预算内；压不动就交回原图让上层提示 */
export async function fitImageToBudget(buffer, mimeType, requireFn) {
  if (buffer.length <= IMAGE_FIT_TARGET) return { data: buffer, mimeType }
  const sharp = getSharp(requireFn)
  if (!sharp) return { data: buffer, mimeType }
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
