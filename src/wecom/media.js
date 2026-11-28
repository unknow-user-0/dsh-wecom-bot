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
import { tryRequire } from '../core/deps.js'

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
/**
 * 动图压缩的总时间预算。
 * 用户选了张表情包，面板上转几十秒他只会以为程序卡死了。
 * 与其精确预测「这张图到底能不能压下去」，不如给个上限 —— 超过就当压不动，
 * 明说发不出去，比让人干等更诚实。
 */
const COMPRESS_BUDGET_MS = 8000
// 能不能压图只取决于「这台机器上有没有 sharp」，跟调用方在哪个目录无关。
// 以前要每个调用点各传一个 require 函数进来，而且结论只探一次就写死：
// host.js 传的 createRequire(import.meta.url) 从 src/ 往外找，插件自己没有
// node_modules，于是第一次调用就把 sharpLib 钉死成 undefined，之后连出站那
// 边传了正确 require 的调用也一起失效 —— 面板预告、入站、出站三处全废。
// 现在默认走 deps.tryRequire（自己会翻插件目录、DSH profiles、cwd），
// 只有测试要注入假 sharp 时才显式传一个函数进来（传了就每次现调，不缓存）。
let sharpLib
let sharpProbed = false
function getSharp(requireFn) {
  if (typeof requireFn === 'function') {
    try { return requireFn('sharp') } catch { return undefined }
  }
  if (sharpProbed) return sharpLib
  sharpProbed = true
  try { sharpLib = tryRequire('sharp') } catch { sharpLib = undefined }
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
 * 动图压缩：只缩尺寸 + 抽帧 + 降色，始终输出 GIF，绝不转静图。
 *
 * 为什么要抽帧：GIF 不像 JPEG 那样有质量旋钮，缩边会重采样出更多颜色，
 * 常常【越压越大】（实测 2.0 MB 缩到 0.7 倍变成 6.4 MB）。
 * 真正的体积杠杆只有「帧数 × 像素数 × 颜色数」。
 *
 * @param {number} [budgetMsOverride] 只给测试用：把时间预算压到极小以走到超时分支
 * @returns {Promise<{data: Buffer, mimeType: string}|null>} null = 压不进预算
 */
async function fitAnimatedToBudget(sharp, buffer, mimeType, budgetMsOverride) {
  let meta
  try {
    meta = await sharp(buffer, { animated: true }).metadata()
  } catch {
    return null
  }
  const pages = Number(meta.pages || 1)
  if (pages <= 1) return null
  const delays = await readDelays(buffer, pages, sharp)

  // 为什么这个顺序（先高质量、失败再降）：
  //   用户选表情包是为了「会动」，两帧一闪而过就不算动图了。
  //   所以质量优先 —— 先试保留最多帧数、最大尺寸的组合，压不下才逐档往下退。
  //   反过来（先试最便宜的组合）永远能秒答，但答案质量是最差的，方向错了。
  //
  // 为什么不是「一档一档往下试」：encode 耗时正比于「像素 × 帧数」，
  //   40 帧的图从头试到尾要累加编码七八次，面板上转 30 秒用户以为卡死。
  //   GIF 体积基本正比于「像素数 × 帧数」，所以按目标体积反推，
  //   第一枪就该落在「刚好能进预算」的那一档附近，而不是从最大那档慢慢降。
  // 下界一路给到 0.2：20~25 MB 的巨图（4K 录屏转的 GIF）实测必须缩到 0.3 才进预算，
  //   原来最细只到 0.4，于是「明明能压」被判成压不动 —— 下限本身就是个误杀源。
  const widthSteps = [1, 0.8, 0.66, 0.5, 0.4, 0.3, 0.25, 0.2]
  // 牺牲顺序（按用户痛感从低到高）：
  //   1. 降色：GIF 本来就只有 256 色，降到 128 肉眼几乎看不出来，体积却直接减半
  //      （实测同一张图 256 色 2.57MB → 128 色 1.27MB）。这是最划算的一刀。
  //   2. 缩边：掉分辨率，肉眼一眼能看出糊。
  //   3. 抽帧：丢的是「会动」这件事本身，表情包的命根子，最后才动。
  // 所以内层是「同一分辨率下先把颜色降下来，实在不行才缩边」，
  // 而不是反过来 —— 保住大尺寸的 128 色，比缩一半的 256 色好看得多。
  const colourSteps = [256, 128]
  const efforts = [3, 7]
  // 帧数下限：少于 4 帧就不算动图了，用户要的「会动」直接没了 ——
  // 与其交一个几乎不动的 GIF，不如判定压缩失败、明说发不出去。
  // 但不能超过原帧数：3 帧的图保 3 帧是正常的（不抽帧），
  // 写成绝对 4 会把「任何抽帧档」全排掉，连不抽帧那一档也一起死了。
  const minKeep = Math.min(pages, 4)
  // roughPages = 按抽帧估算「大概剩几帧能放进预算」。
  // 这是第一枪的位置，不是否决线 —— 它没考虑缩边，所以可能偏保守，
  // 因此附近几档也要试。
  const roughPages = Math.floor((pages * IMAGE_FIT_TARGET * 0.92) / buffer.length)
  const guessSteps = []
  for (const p of [roughPages, Math.ceil(roughPages * 1.4), Math.floor(roughPages * 0.7), Math.floor(roughPages * 0.5)]) {
    const s = Math.max(2, Math.ceil(pages / Math.max(1, p)))
    if (s > 1 && !guessSteps.includes(s)) guessSteps.push(s)
  }
  // guessSteps 按帧数从多到少排（步长小的排前面 = 帧数多的优先 = 质量高优先）
  guessSteps.sort((a, b) => a - b)
  // 兜底：估算失准时把常用的几档也排进去，仍然保持「帧多的在前」
  const frameSteps = [...guessSteps, 1, 2, 3, 4, 6, 8].filter((v, i, a) => a.indexOf(v) === i)

  // 给定「这一档要保留多少帧」，估算需要缩到多大才能进预算。
  //
  // 为什么要估：帧数少但像素大的图（比如 1600×1200 只有 3 帧），抽帧一点用没有 ——
  //   能降体积的只有缩边。以前内层固定从 1.0 开始一档档往下降，
  //   这种图要白编码三次才轮到 0.5，8 秒兜底线一到就判「压不动」，
  //   明明 0.4 能进，却被误杀成 overBudget，用户看到的是「这张图发不出去」。
  //
  // 依据：GIF 体积基本正比于「像素数 × 帧数」。
  //   所以先算出原图平均每帧每像素占多少字节，再反推目标面积。
  const area = (meta.width || 1) * ((meta.pageHeight || 0) || Math.round((meta.height || 1) / Math.max(1, pages)))
  const bytesPerFramePixel = buffer.length / Math.max(1, pages * area)
  const widthStepsFor = (keepLen) => {
    const targetArea = (IMAGE_FIT_TARGET * 0.9) / Math.max(1, keepLen * bytesPerFramePixel)
    const est = Math.sqrt(targetArea / area)
    // 估算只决定「从哪一档开始退」，不决定「能不能压」——
    // 所以从估算值往上留一点余量，能保住画质就先保住画质。
    const start = Math.min(1, Math.max(widthSteps[widthSteps.length - 1], est * 1.15))
    const out = widthSteps.filter((ws) => ws <= start + 1e-6)
    return out.length ? out : [widthSteps[widthSteps.length - 1]]
  }

  // 同一组抽帧只解码一次 —— 相邻组合常常共享 fs，解码是最贵的一步
  const sliceCache = new Map()
  const slicesFor = async (fs) => {
    if (sliceCache.has(fs)) return sliceCache.get(fs)
    const keep = pickFrames(pages, fs)
    const slices = []
    for (const page of keep) {
      slices.push(await sharp(buffer, { page, pages: 1 }).png().toBuffer())
    }
    const out = { keep, slices }
    sliceCache.set(fs, out)
    return out
  }

  // 兜底线：用户站在面板前等一张图，几秒没动静就会以为程序死了。
  // 但「几秒」不能一刀切 —— 面板上传本来就限 8 MB，超过 8 MB 的图只可能来自
  // 手动改配置或 sendFile，那些场合没人在盯着面板刷新。所以：
  //   ≤ 8 MB：8 秒，保证面板永远有及时反馈；
  //   > 8 MB：按工作量放大到最多 30 秒，否则 20~70 MB 的巨图会被
  //           「时间不够」误判成「压不动」，而它们其实缩到 0.3 就能进预算。
  // 工作量 ≈ 帧数 × 单帧像素数，与实测解码+编码耗时基本成正比。
  const workload = pages * ((meta.width || 1) * ((meta.pageHeight || 0) || Math.round((meta.height || 1) / Math.max(1, pages))))
  const budgetMs = budgetMsOverride || (buffer.length <= 8 * 1048576
    ? COMPRESS_BUDGET_MS
    : Math.min(30000, COMPRESS_BUDGET_MS + Math.round(workload / 2_000_000) * 500))
  const deadline = Date.now() + budgetMs

  for (const effort of efforts) {
    for (const fs of frameSteps) {
      if (Date.now() > deadline) return null
      let decoded
      try {
        decoded = await slicesFor(fs)
      } catch {
        continue
      }
      const { keep, slices } = decoded
      if (keep.length < 2) continue // 只剩 1 帧就不是动图了，别假装
      // 帧本来就少的图别抽帧：3 帧抽成 2 帧只省三分之一，动画却明显卡了。
      // 这种图的体积杠杆全在缩边上，抽帧那一档纯属白花编码时间
      // （实测 1600×1200 只有 3 帧时，白试一轮就撞上 8 秒兜底线，
      // 明明缩到 0.4 只剩 0.40 MB 却被判成「压不动」）。
      if (keep.length < minKeep) continue

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

      for (const ws of widthStepsFor(keep.length)) {
        if (Date.now() > deadline) return null
        const width = ws === 1 ? undefined : Math.max(48, Math.round((meta.width || 0) * ws))
        // 同一档分辨率下先试 256 色（无损观感），不行再降到 128 色。
        // 降色比缩边划算得多，所以它在缩边循环里面，不单独占一层。
        for (const colours of colourSteps) {
          if (Date.now() > deadline) return null
          try {
            // ⚠ pages: -1 不能省。只写 join:{animated:true} 时，只要后面接 resize()，
            //   sharp 就只处理第一页 —— 输出变成单帧 GIF，帧数检查不通过、白编码一轮，
            //   于是「所有需要缩边的图」全被判成压不动（实测 1600×1200 三帧缩到 640
            //   只剩 1 帧，加上 pages:-1 才是 3 帧）。这个坑几乎把整个动图压缩废掉。
            let enc = sharp(slices, { join: { animated: true }, pages: -1 })
            if (width) enc = enc.resize({ width, withoutEnlargement: true })
            const out = await enc.gif({
              delay: delaysOut,
              loop: 0,
              effort,
              dither: colours === 256 ? 1 : 0,
              colours,
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
    }
  }
  return null
}

/**
 * 读出每帧原始延时（毫秒），读不到就给 100ms。
 *
 * sharp 必须显式传进来：以前这里读的是模块级变量 sharpLib，而 sharpLib 只在
 * 「不传 requireFn」那条分支被赋值 —— 谁要是显式传了 require 函数（测试就这么干），
 * sharpLib 就一直空着，这里悄悄退回「每帧 100ms」的默认值。
 * 后果很隐蔽：造图用的 80ms/帧 被当成 100ms/帧，算出来的「压缩后总时长」凭空多出
 * 25%，看起来像压缩把动画改速了，其实是读数错了。
 */
async function readDelays(buffer, pages, sharp) {
  try {
    const meta = await sharp(buffer, { animated: true }).metadata()
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

/**
 * 用 sharp 逐级缩边 + 降质量，压到预算内。
 *
 * @param {number} [budgetMsOverride] 只给测试用：把时间预算压到极小以走到超时分支
 * @returns {Promise<{data: Buffer, mimeType: string, overBudget?: true}>}
 *   `overBudget: true` = 所有办法都试过了还是超标。上层据此**拒绝发送**，
 *   而不是硬着头皮发一张大概率被企微拒掉的图 —— 那种失败对用户是隐形的：
 *   他只看到对方没反应，不知道自己配了个永远发不出去的图。
 */
export async function fitImageToBudget(buffer, mimeType, requireFn, opts = {}) {
  if (buffer.length <= IMAGE_FIT_TARGET) return { data: buffer, mimeType }
  const sharp = getSharp(requireFn)
  // 没装 sharp 就没法压。这不算「压不动」——是我们缺工具，
  // 不该拿这个当理由拒绝发送（用户那张图本身可能企微是收得下的）。
  if (!sharp) return { data: buffer, mimeType }

  // 动图单独走一条路：GIF 是有损缩放的，直接按静态图处理会把动画压没。
  // 以前所有格式一律输出 jpeg，等于「GIF 一旦超预算就变静图」，
  // 而且因为出站压缩长期失效（__wecomRequire 从未赋值），这个 bug 一直藏着。
  if (await isAnimated(sharp, buffer)) {
    const anim = await fitAnimatedToBudget(sharp, buffer, mimeType, opts.budgetMs)
    if (anim) return anim
    // 缩边抽帧降色都试过了还是超：认了。
    // 不悄悄转静图（用户以为发了动图），也不再原样硬发（几乎必被拒）。
    return { data: buffer, mimeType, overBudget: true }
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
  return { data: buffer, mimeType, overBudget: true }
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
export async function describeImage(buffer, mimeType, requireFn, opts = {}) {
  const sharp = getSharp(requireFn)
  const base = {
    bytes: buffer.length,
    width: 0, height: 0, animated: false, pages: 1, durationMs: 0,
    finalBytes: buffer.length, finalPages: 1, finalDurationMs: 0, finalWidth: 0,
    finalMime: mimeType, dropped: false, droppedFrames: 0,
    fitsBudget: buffer.length <= IMAGE_FIT_TARGET, sendable: true, note: '',
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
  const delays = pages > 1 ? await readDelays(buffer, pages, sharp) : []
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
  const fit = await fitImageToBudget(buffer, mimeType, requireFn, opts)
  let fm = null
  try { fm = await sharp(fit.data, { animated: true }).metadata() } catch {}
  const fPages = Number(fm?.pages || 1)
  const fDelays = fPages > 1 ? await readDelays(fit.data, fPages, sharp) : []
  const fDur = fDelays.reduce((a, b) => a + (b || 0), 0)

  Object.assign(base, {
    finalBytes: fit.data.length,
    finalPages: fPages,
    finalDurationMs: fDur,
    finalWidth: fm?.width || meta.width || 0,
    finalMime: fit.mimeType,
    dropped: pages > 1 && fPages < pages,
    droppedFrames: Math.max(0, pages - fPages),
    // 发不发得出去，看压缩层自己的结论；没装 sharp 时它不会报 overBudget，
    // 那就退回「按字节数猜」——毕竟那种情况我们确实不知道。
    fitsBudget: fit.overBudget ? false : fit.data.length <= IMAGE_FIT_TARGET,
    sendable: !fit.overBudget,
  })

  if (!base.sendable) {
    // 缩边到 40%、抽帧抽到 1/8 还是超标 —— 这张图就是发不出去。
    // 明确说「不会发」，别写成「可能被拒」：说了「可能」用户就会去试，
    // 试完对面什么都没收到，他还以为是自己网不好。
    base.note = `这张图压到极限还有 ${(base.finalBytes / 1048576).toFixed(1)} MB，超过企微上限，`
      + '预回复时不会发这张图（文字照发）。换一张小点的，或者把它缩小后再传。'
  } else if (pages > 1 && fPages > 1) {
    base.note = base.dropped
      ? `动图 ${pages} 帧太大（${(buffer.length / 1048576).toFixed(1)} MB），会自动抽成 ${fPages} 帧，`
        + `总时长还是 ${(fDur / 1000).toFixed(1)} 秒，播放速度不变`
      : `动图 ${pages} 帧已经压进预算（${(fit.data.length / 1048576).toFixed(1)} MB），帧数没动`
  } else if (pages > 1 && fPages <= 1) {
    base.note = '⚠ 这张动图压不进预算，又没法安全抽帧'
  } else {
    base.note = `会压缩到 ${(fit.data.length / 1048576).toFixed(1)} MB 再发`
  }
  return base
}
