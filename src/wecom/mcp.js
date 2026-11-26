// 企微 MCP 客户端（StreamableHttp）
//
// 协议事实（真机验证）：
//   - 端点 https://qyapi.weixin.qq.com/mcp/v2/bot/<service>?apikey=<KEY>
//     8 个 service 的 apikey **各不相同**（前缀相同，后缀分叉）
//   - initialize → 响应头可能带 mcp-session-id（实测为 null，不强制携带）
//   - 响应可能是普通 JSON，也可能是 SSE（`data: {...}`），要先判断再剥前缀
//   - 返回值套娃三层：result.content[0].text 里是一段 JSON **字符串**，要再 parse
//   - 所有响应带 security_notice 和 extra_identity_context，
//     **服务端明确禁止把后者转述给终端用户**，必须剥离
//   - 时间参数是本地时区 YYYY-MM-DD HH:MM:SS，不是 UTC（用 toISOString 会偏 8 小时）
//   - 只能查最近 7 天，早于 7 天报 850016

const PROTOCOL = '2024-11-05'
const CLIENT_INFO = { name: 'dsh-wecom-bot', version: '0.1.2' }

/** 必须剥离的字段 */
const STRIP_KEYS = new Set(['security_notice', 'extra_identity_context'])

export class McpError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'McpError'
    this.code = code
  }
}

/** 递归剥掉不该给终端用户看的字段 */
export function stripMeta(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(stripMeta)
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (STRIP_KEYS.has(k)) continue
    out[k] = stripMeta(v)
  }
  return out
}

/**
 * 本地时区的 YYYY-MM-DD HH:MM:SS。
 * 服务端按本地时区解释，用 toISOString() 会整体偏 8 小时。
 */
export function localTime(ms = Date.now()) {
  const d = new Date(ms)
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 安全的时间窗：begin 至少留 6 天余量（7 天边界会踩 850016） */
export function safeWindow(spanMs = 6 * 86400e3, now = Date.now()) {
  return { begin: localTime(now - spanMs), end: localTime(now + 3600e3) }
}

/** 解析响应体：普通 JSON 或 SSE */
function parseBody(text) {
  const t = String(text || '').trim()
  if (t === '') return null
  if (t.startsWith('{') || t.startsWith('[')) {
    try { return JSON.parse(t) } catch { return null }
  }
  // SSE：多行 data: 拼接
  const dataLines = t.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
  if (dataLines.length === 0) {
    try { return JSON.parse(t) } catch { return null }
  }
  const joined = dataLines.join('')
  try { return JSON.parse(joined) } catch { return null }
}

/** 从 MCP 响应里掏出真正的数据（套娃三层） */
function unwrap(response) {
  const result = response?.result
  if (!result) return response
  if (result.isError === true) {
    const text = result.content?.[0]?.text || 'MCP 调用失败'
    throw new McpError(String(text).slice(0, 500), 'mcp_error')
  }
  const content = result.content
  if (!Array.isArray(content)) return stripMeta(result)
  // 优先 text 块
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      let payload
      try { payload = JSON.parse(block.text) } catch { return { text: block.text } }
      const stripped = stripMeta(payload)
      if (stripped && typeof stripped === 'object') {
        // 企微 MCP 有【两套】错误体系，只认 errcode 会漏掉一半：
        //   A) 顶层 { errcode: 850003, errmsg: 'authorization expired' }   ← 老的
        //   B) 套一层 { error: { code: 40058, message: '...' }, errcode: 0, errmsg: 'ok' } ← 新的
        // B 这种 errcode 是 0、成功与否全靠 error.code，只看 errcode 就会把
        // 「上传失败」当成功返回，上层拿到 undefined 再去用，错误被推迟到很远的地方。
        // 实测 disk_files_upload 空参就返回 B 这种。
        const inner = stripped.error
        if (inner && typeof inner === 'object') {
          const code = Number(inner.code ?? 0)
          if (code !== 0) {
            throw new McpError(String(inner.message || `error.code ${code}`), code)
          }
        }
        if (Number(stripped.errcode ?? 0) !== 0) {
          throw new McpError(String(stripped.errmsg || `errcode ${stripped.errcode}`), Number(stripped.errcode))
        }
      }
      return stripped
    }
  }
  return stripMeta(result)
}

/**
 * 建一个服务客户端。
 * @param {string} url 完整的 StreamableHttp URL（含 apikey）
 */
export function createMcpClient(url, { log = () => {}, timeoutMs = 30_000 } = {}) {
  let sessionId = null
  let seq = 0
  let initialized = false

  async function rpc(method, params, { signal } = {}) {
    const body = { jsonrpc: '2.0', id: ++seq, method, ...(params ? { params } : {}) }
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    }
    if (sessionId) headers['mcp-session-id'] = sessionId

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs)
    timer.unref?.()
    const onAbort = () => ctrl.abort(signal?.reason)
    if (signal) signal.addEventListener('abort', onAbort, { once: true })

    let res
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal })
    } catch (error) {
      clearTimeout(timer)
      throw new McpError(`连不上 MCP 服务：${error.message}`, 'network')
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }

    const sid = res.headers.get('mcp-session-id')
    if (sid) sessionId = sid

    const text = await res.text()
    if (!res.ok) {
      throw new McpError(`MCP HTTP ${res.status}：${text.slice(0, 300)}`, `http_${res.status}`)
    }
    const parsed = parseBody(text)
    if (!parsed) throw new McpError('MCP 返回体解析失败', 'parse')
    if (parsed.error) {
      throw new McpError(String(parsed.error.message || 'JSON-RPC 错误'), parsed.error.code)
    }
    return parsed
  }

  async function ensureInit() {
    if (initialized) return
    await rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT_INFO })
    initialized = true
  }

  return {
    get sessionId() { return sessionId },
    async ping() {
      await ensureInit()
      return true
    },
    async listTools() {
      await ensureInit()
      const r = await rpc('tools/list', {})
      return r.result?.tools || []
    },
    async call(name, args = {}) {
      await ensureInit()
      const r = await rpc('tools/call', { name, arguments: args })
      return unwrap(r)
    },
  }
}

/**
 * 校验面板填的 URL 是不是企微 MCP 的合法形态
 */
export function validateMcpUrl(url, expectService) {
  const s = String(url || '').trim()
  if (s === '') return { ok: false, message: '没填' }
  let u
  try { u = new URL(s) } catch { return { ok: false, message: '不是合法 URL' } }
  if (u.protocol !== 'https:') return { ok: false, message: '必须是 https' }
  if (!u.hostname.endsWith('qyapi.weixin.qq.com')) return { ok: false, message: '域名应该是 qyapi.weixin.qq.com' }
  const m = /\/mcp\/v\d+\/bot\/([a-z]+)/.exec(u.pathname)
  if (!m) return { ok: false, message: '路径里找不到 /mcp/vX/bot/<service>' }
  if (expectService && m[1] !== expectService) {
    return { ok: false, message: `这是 ${m[1]} 的地址，当前要填的是 ${expectService}` }
  }
  if (!u.searchParams.get('apikey')) return { ok: false, message: 'URL 里没有 apikey 参数' }
  return { ok: true, service: m[1] }
}

export const MCP_SERVICES = [
  { id: 'msg', name: '消息', desc: '读群/私聊历史消息（最近 7 天）、发消息、发文件' },
  { id: 'mail', name: '邮件', desc: '搜索、读取、发送邮件（只能查前后 7 天）' },
  { id: 'doc', name: '文档', desc: '文档/表格/智能表格/智能文档的读写' },
  { id: 'todo', name: '待办', desc: '待办的创建、查询、完成' },
  { id: 'schedule', name: '日程', desc: '日程与会议室的查询、创建' },
  { id: 'meeting', name: '会议', desc: '会议的创建与查询' },
  { id: 'disk', name: '微盘', desc: '微盘文件的上传、下载、搜索、重命名' },
  { id: 'contact', name: '通讯录', desc: '按关键词搜成员（不支持全量罗列）' },
]
