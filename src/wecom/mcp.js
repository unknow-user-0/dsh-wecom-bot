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
const CLIENT_INFO = { name: 'dsh-wecom-bot', version: '0.1.4' }

/** 必须剥离的字段 */
const STRIP_KEYS = new Set(['security_notice', 'extra_identity_context'])

export class McpError extends Error {
  /**
   * @param {string} message 给人看的错误说明
   * @param {number|string} [code] 企微 errcode / error.code
   * @param {object} [extra]
   * @param {string} [extra.help] 企微返回的 help_message（原样，里面带授权链接）
   * @param {string} [extra.helpInstruction] 企微要求怎么使用 help_message
   */
  constructor(message, code, extra = {}) {
    super(message)
    this.name = 'McpError'
    this.code = code
    // 企微明确要求把 help_message 逐字原样展示给用户（里面是授权入口）。
    // 以前这里只留 errmsg，用户看到「授权过期」却不知道去哪点授权。
    this.help = String(extra.help || '')
    this.helpInstruction = String(extra.helpInstruction || '')
  }

  /** 这个错是「去点一下授权就好了」，不是网络抖动，重试一万次也没用 */
  get needAuth() {
    return this.code === 850003 || /authorization expired|not authorized|未授权|权限已过期/i.test(this.message)
  }
}

/**
 * 企微在 help_message 里给的入口是 markdown 链接 [文字](url) 或裸 URL。
 * 从里面抠出第一个 http(s) 地址，给面板渲染成可点按钮用。
 */
export function helpUrl(error) {
  const text = String(error?.help || '')
  const md = /\((https?:\/\/[^)\s]+)\)/.exec(text)
  if (md) return md[1]
  const bare = /(https?:\/\/[^\s)」]+)/.exec(text)
  return bare ? bare[1] : ''
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

/**
 * 各服务的「探活工具」：只读、幂等、不产生任何副作用。
 *
 * 为什么不能只调 tools/list 就算测通：实测 850003（授权过期）下
 * initialize 和 tools/list 永远成功，只有 tools/call 才暴露 —— 面板
 * 那句「通了，6 个工具」就是这么骗过人的。
 * 也不能用 media_upload 当探针：它不校验服务权限，授权全过期了它照样返回
 * errcode=0，只能证明 apikey 是对的，证明不了授权还有效。
 */
export const MCP_PROBES = {
  msg: { tool: 'message_aibot_sessions_list', args: {} },
  mail: { tool: 'mail_search', args: { limit: 1 } },
  doc: { tool: 'doc_search', args: { keywords: '会议', limit: 1 } },
  todo: { tool: 'todo_list', args: { limit: 1 } },
  schedule: { tool: 'calendar_schedules_list', args: {} },
  meeting: { tool: 'meeting_list', args: { limit: 1 } },
  disk: { tool: 'disk_files_list', args: { limit: 1 } },
  contact: { tool: 'contact_users_search', args: { keywords: 'a' } },
}

/**
 * 真探活：列工具 + 调一次业务工具。
 * 判据只有一条 —— 「授权还有效吗」，所以：
 *   · needAuth / 网络不通  → 失败（这是面板该红的地方）
 *   · 其它业务/参数错误     → 算通（能走到业务层就说明授权过了，报错是参数的事）
 */
export async function probeService(mc, service) {
  const probe = MCP_PROBES[service]
  let names = []
  try {
    names = (await mc.listTools()).map((t) => t.name)
  } catch (error) {
    return failOf(error, names, probe)
  }
  if (!probe) return { ok: true, count: names.length, names, note: '没有探活工具，只验了连通性' }
  try {
    await mc.call(probe.tool, probe.args)
    return { ok: true, count: names.length, names, tool: probe.tool }
  } catch (error) {
    return failOf(error, names, probe)
  }
}

function failOf(error, names, probe) {
  const base = { count: names.length, names, tool: probe?.tool }
  if (error?.needAuth) {
    return {
      ...base,
      ok: false,
      needAuth: true,
      message: error.message,
      help: error.help || '',
      url: helpUrl(error),
    }
  }
  if (error?.code === 'network' || String(error?.code || '').startsWith('http_')) {
    return { ...base, ok: false, message: error.message }
  }
  // 能拿到业务层的报错，说明授权这关是过的。
  return { ...base, ok: true, note: `接口回了「${error?.message || '未知错误'}」，这是参数/业务问题，不是授权问题` }
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
        // help_message / help_instruction 是企微专门写给终端用户的（多半是
        // 「去这里授权」的链接），而且明确要求逐字原样展示。它跟
        // security_notice 恰好相反：那个必须剥，这个必须留。
        const help = {
          help: stripped.help_message,
          helpInstruction: stripped.help_instruction,
        }
        const inner = stripped.error
        if (inner && typeof inner === 'object') {
          const code = Number(inner.code ?? 0)
          if (code !== 0) {
            throw new McpError(String(inner.message || `error.code ${code}`), code, help)
          }
        }
        if (Number(stripped.errcode ?? 0) !== 0) {
          throw new McpError(String(stripped.errmsg || `errcode ${stripped.errcode}`), Number(stripped.errcode), help)
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
