// 生图：走 OpenAI 兼容的 /v1/images/generations，或者自己填的自定义接口。
//
// 为什么自带而不是接某个具体服务：生图服务满天飞（硅基流动、通义万相兼容层、本地 SD WebUI /
// ComfyUI 的 OpenAI 代理、pollinations……），但它们大部分都能装成 OpenAI 兼容。
// 实在不兼容的，用 custom 模式自己填 URL 模板和取值路径。
//
// 和 araubot 的差别：不要 codex 订阅那条路（绑 OpenAI 账号、要登录态，对外分发太重），
// 也不要「本地接口」那套（araubot 的 local 服务），只留 openai / custom 两种。
//
// 出图后交给 wecom/outbound.js 的 sendImageBuffer 发出去（走 media_upload + message_aibot_send）。

import { sniffImageMime } from '../wecom/media.js'

function fill(tpl, vars) {
  return String(tpl ?? '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])))
}

function dimsOf(size) {
  const m = /^(\d+)\s*[x×*]\s*(\d+)$/i.exec(String(size || ''))
  return m ? { width: m[1], height: m[2] } : { width: '', height: '' }
}

function dotted(obj, path) {
  let cur = obj
  for (const k of String(path || '').split('.').map((s) => s.trim()).filter(Boolean)) {
    if (cur === null || cur === undefined) return null
    cur = cur[k]
  }
  return cur ?? null
}

/** 没配取值路径时，在返回的 JSON 里找第一个像图片的东西。 */
function findImage(obj, depth = 0) {
  if (depth > 6 || obj === null || obj === undefined) return null
  if (typeof obj === 'string') {
    if (/^data:image\//i.test(obj)) return obj
    if (/^https?:\/\//i.test(obj) && /\.(png|jpe?g|webp|gif|bmp)(\?|$)/i.test(obj)) return obj
    return null
  }
  if (Array.isArray(obj)) {
    for (const it of obj) { const r = findImage(it, depth + 1); if (r) return r }
    return null
  }
  if (typeof obj === 'object') {
    for (const k of ['url', 'image', 'imageUrl', 'image_url', 'output', 'data', 'images', 'result']) {
      if (k in obj) { const r = findImage(obj[k], depth + 1); if (r) return r }
    }
    for (const v of Object.values(obj)) { const r = findImage(v, depth + 1); if (r) return r }
  }
  return null
}

/** 自定义接口这一次要发什么（纯函数，好单测）。 */
export function customRequest(imageGen, prompt) {
  const cp = imageGen.custom || {}
  const method = String(cp.method || 'GET').toUpperCase() === 'GET' ? 'GET' : 'POST'
  const { width, height } = dimsOf(imageGen.size)
  const raw = { prompt, model: imageGen.model || '', size: imageGen.size || '', width, height }
  const enc = { ...raw, prompt: encodeURIComponent(prompt) }
  const params = (Array.isArray(cp.params) ? cp.params : [])
    .map((p) => ({ key: String(p && p.key != null ? p.key : '').trim(), value: p ? p.value : '' }))
    .filter((p) => p.key)

  let url = fill(cp.url, enc)
  if (method === 'GET' && params.length) {
    const q = params.map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(fill(p.value, raw))}`).join('&')
    url += (url.includes('?') ? '&' : '?') + q
  }

  const headers = {}
  if (imageGen.apiKey) headers.authorization = `Bearer ${imageGen.apiKey}`

  let body
  if (method === 'POST') {
    const obj = {}
    for (const p of params) obj[p.key] = fill(p.value, raw)
    if (cp.bodyType === 'form') {
      headers['content-type'] = 'application/x-www-form-urlencoded'
      body = new URLSearchParams(obj).toString()
    } else {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(obj)
    }
  }
  return { url, method, headers, body }
}

async function valueToBuffer(v, fetchImpl) {
  if (typeof v !== 'string' || !v) throw new Error('生图接口没有返回图片')
  const b64 = /^data:image\/[^;]+;base64,(.+)$/i.exec(v)
  if (b64) return Buffer.from(b64[1], 'base64')
  if (/^https?:\/\//i.test(v)) {
    const r = await fetchImpl(v, { signal: AbortSignal.timeout(120_000) })
    if (!r.ok) throw new Error(`下载生成的图失败：HTTP ${r.status}`)
    return Buffer.from(await r.arrayBuffer())
  }
  throw new Error('生图接口返回的既不是图片地址也不是图片')
}

/**
 * @param {object} opts
 * @param {() => object} opts.getConfig
 * @param {object} opts.log
 * @param {Function} [opts.fetchImpl]
 */
export function createImageGen({ getConfig, log, fetchImpl }) {
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args))

  const cfgOf = () => getConfig()?.imageGen || {}

  function enabled() {
    const c = cfgOf()
    if (!getConfig()?.features?.imageGen) return false
    if (!c.enabled) return false
    return c.provider === 'custom' ? Boolean(c.custom?.url) : Boolean(c.baseUrl && c.model)
  }

  async function generate(prompt) {
    const c = cfgOf()
    if (!getConfig()?.features?.imageGen) throw new Error('生图功能没开（设置 → 功能里打开）')
    if (!c.enabled) throw new Error('生图还没启用')
    const full = [c.stylePrompt, prompt].filter(Boolean).join('，')
    const t = Date.now()
    const buf = c.provider === 'custom' ? await viaCustom(c, full) : await viaOpenAI(c, full)
    if (!buf?.length) throw new Error('生图接口没有返回图片')
    const mime = sniffImageMime(buf)
    if (!String(mime).startsWith('image/')) throw new Error('生图接口返回的不是图片')
    log?.info?.(`画好了一张图（${Math.round(buf.length / 1024)}KB，${Math.round((Date.now() - t) / 1000)}s）：${prompt.slice(0, 40)}`)
    return { buffer: buf, mimeType: String(mime) }
  }

  async function viaOpenAI(c, prompt) {
    const base = String(c.baseUrl || '').replace(/\/+$/, '')
    if (!base || !c.model) throw new Error('还没填生图服务地址或模型')
    const headers = { 'content-type': 'application/json' }
    if (c.apiKey) headers.authorization = `Bearer ${c.apiKey}`
    const r = await doFetch(`${base}/images/generations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: c.model, prompt, size: c.size || '1024x1024', n: 1, response_format: 'b64_json', image_size: c.size || '1024x1024' }),
      signal: AbortSignal.timeout(180_000),
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j?.error?.message || j?.message || `HTTP ${r.status}`)
    const item = (j.data || j.images || [])[0] || {}
    if (item.b64_json) return Buffer.from(item.b64_json, 'base64')
    // 有的服务返回 CDN 链接，下载可能要几十秒
    if (item.url) return valueToBuffer(item.url, doFetch)
    throw new Error('生图服务没有返回图片')
  }

  async function viaCustom(c, prompt) {
    const cp = c.custom || {}
    if (!cp.url) throw new Error('还没填自定义生图接口地址')
    const req = customRequest(c, prompt)
    const r = await doFetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(180_000),
    })
    const type = String(r.headers?.get?.('content-type') || '')
    // 直接返回图片字节（pollinations 这类）
    if (type.startsWith('image/')) {
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return Buffer.from(await r.arrayBuffer())
    }
    const j = await r.json().catch(() => null)
    if (!r.ok) throw new Error((j && (j.error?.message || j.message)) || `HTTP ${r.status}`)
    if (!j) throw new Error('生图接口没有返回图片')
    const v = (cp.responsePath ? dotted(j, cp.responsePath) : null) || findImage(j)
    if (!v) throw new Error('生图接口没有返回图片地址')
    return valueToBuffer(v, doFetch)
  }

  return { generate, enabled }
}
