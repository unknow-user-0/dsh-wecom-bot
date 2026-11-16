// 配置：默认值 + 归一化 + 读写。
// 配置文件 ~/.dsh/plugins-data/wecom-bot/config.json（凭据另走 DSH 凭据库，不进这里）

import { join } from 'node:path'
import { homedir } from 'node:os'
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs'

const HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || homedir(), '.dsh')
export const DATA_DIR = join(process.env.DSH_HOME || join(process.env.USERPROFILE || homedir(), '.dsh'), 'plugins-data', 'wecom-bot')
const CONFIG_FILE = join(DATA_DIR, 'config.json')

/** 准入模式：whitelist = 只有名单里的人能聊；open = 谁都拉进来都能聊 */
export const ACCESS_MODES = ['whitelist', 'open']

export const DEFAULTS = {
  enabled: false,          // 总开关：关着一句都不发
  setupDone: false,        // 首次向导走完了没有（点了「跳过引导」也算）
  guideDone: false,        // 引导流程是否已完成

  // ---- 机器人 ----
  botName: '',             // 机器人在群里被 @ 时显示的名字（用于系统提示，不做字符串剥离）
  botId: '',               // aibotid，连上后自动回填（非敏感，可存配置）

  // ---- 准入 ----
  accessMode: 'whitelist', // 开源默认白名单
  admins: [
    // { userid, name, role: 'owner'|'admin', addedAt,
    //   mcp: { msg: '', mail: '', doc: '', todo: '', schedule: '', meeting: '', disk: '', contact: '' },
    //   quotaTokens: 0 }   // 0 = 跟随全局
  ],
  allow: {
    users: [],             // 白名单成员 userid
    groups: [],            // 白名单群 chatid（开放模式下自动登记）
  },
  autoRegister: true,      // 开放模式下自动登记来过的群/人（切换白名单时名单现成）

  // ---- 会话 ----
  workspaceDir: '',        // 会话放哪；留空 = 用户目录下 WeComBot\chats
  merge: {
    enabled: true,
    waitSec: 2.5,          // 私聊：对方停顿几秒算说完
    maxSec: 8,             // 私聊：最多等几秒
    groupWaitSec: 5,       // 群聊：等得久一点把一段话攒齐
    groupMaxSec: 15,
    placeholder: 'emmm...', // 等待期占位文案（企微没有「正在输入」提示）
  },
  longTasks: true,         // 管理员私聊额外挂 jobs + schedule

  // ---- 能力开关（开源默认）----
  features: {
    browser: true,         // 浏览器操作（CDP）：默认开
    video: true,           // 看视频（dsh-video-storyboard）：默认开
    files: true,           // 收发文件/文档：默认开
    desktop: false,        // 桌面命令（shell/pwsh）：默认关，最危险
    memory: true,          // 记忆（自带实现）
    mcpWrite: false,       // MCP 写操作（建文档/发邮件/建待办）：默认关
    mcpSendAsMe: false,    // MCP 以管理员真人身份发消息：默认关，且需「用我的身份」闸门
    sendFileToUser: 'admin', // 给用户发文件的权限：admin | all | off
  },

  // ---- 额度（按 token 算）----
  quota: {
    enabled: true,
    unit: 'million',       // million | tenMillion | hundredMillion
    globalDailyTokens: 50_000_000,  // 5 千万
    perChatDailyTokens: 5_000_000,  // 每会话 5 百万
    adminsUnlimited: true, // 管理员不限制
    burstPerMinute: 30,    // 防刷屏：单会话每分钟条数上限（辅助计量）
  },

  // ---- 模型 ----
  model: { provider: '', model: '', reasoningEffort: 'low' },

  // ---- 人格 ----
  persona: { current: 'default' },

  // ---- 群上下文 ----
  history: {
    enabled: true,         // 被 @ 时用 MCP 补群上下文
    syncOnFirstMention: true,
    syncIntervalMin: 0,    // 0 = 每条 @ 都后台异步更新一次
    maxMessages: 30,       // 一次最多补多少条
  },

  // ---- 补拉 ----
  resync: {
    enabled: true,         // 断线重连后用 MCP 补拉期间的 @ 消息
    maxMinutes: 120,       // 最多补拉多久之前的
  },
}

function deepClone(o) {
  return JSON.parse(JSON.stringify(o))
}

/** 把任意对象合并到默认值上（只认默认值里有的键） */
function merge(base, patch) {
  const out = deepClone(base)
  if (!patch || typeof patch !== 'object') return out
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in out)) continue
    if (Array.isArray(out[k])) { out[k] = Array.isArray(v) ? v : out[k]; continue }
    if (out[k] && typeof out[k] === 'object') { out[k] = merge(out[k], v); continue }
    if (v !== undefined) out[k] = v
  }
  return out
}

function ensureDir(dir) {
  try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch {}
}

export function loadConfig() {
  ensureDir(DATA_DIR)
  let raw = {}
  try {
    if (existsSync(CONFIG_FILE)) raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  } catch { raw = {} }
  return normalize(merge(DEFAULTS, raw))
}

export function saveConfig(next) {
  ensureDir(DATA_DIR)
  const cfg = normalize(merge(DEFAULTS, next))
  const tmp = CONFIG_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8')
  renameSync(tmp, CONFIG_FILE)
  return cfg
}

function normalize(c) {
  if (!ACCESS_MODES.includes(c.accessMode)) c.accessMode = 'whitelist'
  if (!['million', 'tenMillion', 'hundredMillion'].includes(c.quota.unit)) c.quota.unit = 'million'
  if (!['admin', 'all', 'off'].includes(c.features.sendFileToUser)) c.features.sendFileToUser = 'admin'

  const num = (v, min, max, dflt) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return dflt
    return Math.max(min, Math.min(max, n))
  }
  c.merge.waitSec = num(c.merge.waitSec, 0.5, 10, 2.5)
  c.merge.maxSec = num(c.merge.maxSec, 1, 60, 8)
  c.merge.groupWaitSec = num(c.merge.groupWaitSec, 0.5, 10, 5)
  c.merge.groupMaxSec = num(c.merge.groupMaxSec, 1, 60, 15)
  if (!c.merge.placeholder) c.merge.placeholder = 'emmm...'
  c.quota.globalDailyTokens = num(c.quota.globalDailyTokens, 0, 1e12, 50_000_000)
  c.quota.perChatDailyTokens = num(c.quota.perChatDailyTokens, 0, 1e12, 5_000_000)
  c.quota.burstPerMinute = num(c.quota.burstPerMinute, 1, 1000, 30)
  c.history.maxMessages = num(c.history.maxMessages, 1, 200, 30)
  c.resync.maxMinutes = num(c.resync.maxMinutes, 5, 6 * 24 * 60, 120)

  // 管理员：保证 userid 非空、role 合法、只有一个 owner
  const seen = new Set()
  const admins = []
  let ownerTaken = false
  for (const a of Array.isArray(c.admins) ? c.admins : []) {
    const userid = String(a?.userid || '').trim()
    if (!userid || seen.has(userid)) continue
    seen.add(userid)
    let role = a?.role === 'owner' ? 'owner' : 'admin'
    if (role === 'owner') {
      if (ownerTaken) role = 'admin'
      else ownerTaken = true
    }
    const mcp = {}
    for (const k of ['msg', 'mail', 'doc', 'todo', 'schedule', 'meeting', 'disk', 'contact']) {
      const v = String(a?.mcp?.[k] || '').trim()
      // 只认 http(s) 开头的地址。面板下发的 mcp 是布尔（true=配过），
      // 万一它被原样存回来，这里必须当没配，绝不能把 "true" 当成 URL。
      if (/^https?:\/\//i.test(v)) mcp[k] = v
    }
    admins.push({ userid, name: String(a?.name || '').trim(), role, addedAt: Number(a?.addedAt) || Date.now(), mcp, quotaTokens: Number(a?.quotaTokens) || 0 })
  }
  // 没有 owner 但有人：第一个提成 owner
  if (!ownerTaken && admins.length) admins[0].role = 'owner'
  c.admins = admins
  if (!Array.isArray(c.allow.users)) c.allow.users = []
  if (!Array.isArray(c.allow.groups)) c.allow.groups = []
  // 也容忍 [{userid}] / [{id}] 这种对象写法（面板或脚本手滑时不会变成 "[object Object]"）
  const asId = (v) => {
    if (v && typeof v === 'object') return String(v.userid ?? v.id ?? v.chatId ?? v.value ?? '').trim()
    return String(v ?? '').trim()
  }
  c.allow.users = [...new Set(c.allow.users.map(asId).filter(Boolean))]
  c.allow.groups = [...new Set(c.allow.groups.map(asId).filter(Boolean))]
  c.accessMode = ACCESS_MODES.includes(c.accessMode) ? c.accessMode : 'whitelist'
  return c
}

/** 面板拿到的配置：抹掉凭据细节，只留「配上没配上」 */
export function publicConfig(c) {
  const out = deepClone(c)
  out.admins = c.admins.map((a) => ({
    userid: a.userid,
    name: a.name,
    role: a.role,
    addedAt: a.addedAt,
    quotaTokens: a.quotaTokens,
    mcp: Object.fromEntries(
      ['msg', 'mail', 'doc', 'todo', 'schedule', 'meeting', 'disk', 'contact'].map((k) => [k, Boolean(a.mcp?.[k])]),
    ),
  }))
  // 生图的 key 别往回吐 —— 前端只需要知道「配了没有」
  return out
}

/** 管理员池里找人 */
export function adminOf(cfg, userid) {
  return cfg.admins.find((a) => a.userid === String(userid)) || null
}

export function isOwner(cfg, userid) {
  const a = adminOf(cfg, userid)
  return Boolean(a && a.role === 'owner')
}

export { CONFIG_FILE }
