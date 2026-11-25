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
  botName: '',             // 机器人在群里被 @ 时显示的名字（企微后台改完要来这里同步）
  observedBotName: '',     // 从群消息 @ 前缀自动学到的名字（只在 default 人格里当 {{name}} 用，不回填 botName）
  botNameAliases: [],      // 以前叫过的名字。改名时自动记下，最多 5 条，用于告诉模型「那也是在叫我」
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
    // 收到消息先回一句「我收到了」—— 企微没有「正在输入」提示，不给这句对方会以为没发出去。
    // 关掉就彻底安静（模型想好了再直接给答案），适合不想看到多余气泡的人。
    placeholderOn: true,
    placeholder: 'emmm...', // 占位文案，可自定义
    // 占位图：本地图片路径（面板上从本地选一张，存进插件数据目录）。
    // 文字和图片都配了就都发；只配一个就发那个；配了图但没 MCP 时图发不出去（见 chat/placeholder.js）。
    placeholderImage: '',
    // 发图必须走 MCP 的 media_upload 换 media_id（长连接只认 media_id，没有 URL 通道）。
    // 这个开关只用来「我知道要发图但暂时不想发」时临时闭掉，默认跟着有没有图走。
    placeholderImageOn: true,
  },
  longTasks: true,         // 管理员私聊额外挂 jobs + schedule

  // ---- 能力档位 ----
  // 这里只留「确实需要选」的东西。其余能力（看视频、收文件、MCP 写、真人身份发消息）
  // 都不设开关：它们的边界由「是不是管理员」「是私聊还是群」决定，不靠用户记得去打开。
  features: {
    // 浏览器操作：admin = 只有管理员私聊能用；all = 管理员 + 所有私聊；off = 谁都不能用
    browser: 'admin',
    memory: true,          // 记忆（自带实现），开关在面板「记忆」栏
    sendFileToUser: 'admin', // 机器人能往谁那儿发文件：admin | all | off
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
  // 后台小任务（记忆提炼）用哪个模型。留空 = 跟随 DSH 当前默认模型。
  // 空着也能跑：resolveModel() 会去问 agentDefaultModel，所以开源用户不填也能用。
  model: { provider: '', model: '', reasoningEffort: 'low' },

  // ---- 记忆 ----
  // 只控制「自动整理」的节奏。开关本身在 features.memory（面板上叫「启用记忆」）。
  memory: {
    autoDistill: true,          // 自动整理总开关
    // 两种节奏二选一：scheduled=每天固定时间点；flexible=聊完静默一会儿就整理
    mode: 'scheduled',
    distillTimes: ['17:00'],    // 定时模式的整理时间点（本地时间，可多个）；默认下午5点
    flexIdleSec: 180,           // 灵活模式：最后一条消息后静默多久才整理（秒，默认3分钟）
    flexMinGapSec: 900,         // 灵活模式：两次整理最小间隔（秒，默认15分钟，防连着刷）
  },

  // ---- 人格 ----
  persona: { current: 'default' },


  // ---- 上下文补齐 ----
  // 群上下文补齐和断线补拉是同一件事：拿「上次见到消息的时间」当水位，把中间的全部补回来。
  // 不再有「最短间隔」「最多补几条」这类参数 —— 那是让用户替程序做决定。
  history: {
    enabled: true,
  },
}

function deepClone(o) {
  return JSON.parse(JSON.stringify(o))
}

/**
 * 把 patch 深合并进 base（只认 base 里有的键，`v !== undefined` 才覆盖）。
 * 也是 /save 的增量更新语义：只传改动的字段，没传的不动。
 */
export function merge(base, patch) {
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
  // 浏览器操作从布尔升成三档：老配置里的 true/false 就地迁移，别让用户重设一遍
  if (c.features.browser === true) c.features.browser = 'admin'
  else if (c.features.browser === false) c.features.browser = 'off'
  else if (!['admin', 'all', 'off'].includes(c.features.browser)) c.features.browser = 'admin'

  const num = (v, min, max, dflt) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return dflt
    return Math.max(min, Math.min(max, n))
  }
  c.merge.waitSec = num(c.merge.waitSec, 0.5, 10, 2.5)
  c.merge.maxSec = num(c.merge.maxSec, 1, 60, 8)
  c.merge.groupWaitSec = num(c.merge.groupWaitSec, 0.5, 10, 5)
  c.merge.groupMaxSec = num(c.merge.groupMaxSec, 1, 60, 15)
  // 占位开关：老的配置里没有这个键，缺省给 true（保持以前的行为）
  if (typeof c.merge.placeholderOn !== 'boolean') c.merge.placeholderOn = true
  if (!c.merge.placeholder) c.merge.placeholder = 'emmm...'
  if (typeof c.merge.placeholderImage !== 'string') c.merge.placeholderImage = ''
  if (typeof c.merge.placeholderImageOn !== 'boolean') c.merge.placeholderImageOn = true
  c.quota.globalDailyTokens = num(c.quota.globalDailyTokens, 0, 1e12, 50_000_000)
  c.quota.perChatDailyTokens = num(c.quota.perChatDailyTokens, 0, 1e12, 5_000_000)
  c.quota.burstPerMinute = num(c.quota.burstPerMinute, 1, 1000, 30)

  // 记忆整理：时间点必须是 HH:MM，写错的时间点会让「到点就跑」永远不触发
  if (typeof c.memory.autoDistill !== 'boolean') c.memory.autoDistill = true
  // 两种节奏：老的没有 mode 就按定时（保持原行为），取值非法也回退定时
  if (!['scheduled', 'flexible'].includes(c.memory.mode)) c.memory.mode = 'scheduled'
  const times = Array.isArray(c.memory.distillTimes) ? c.memory.distillTimes : []
  const clean = times.map((t) => String(t || '').trim()).filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t))
  c.memory.distillTimes = clean.length ? [...new Set(clean)].slice(0, 4) : ['17:00']
  // 灵活模式的两个时间：静默多久（30s~6h）与两次最小间隔（30s~24h）。
  // 老配置没有这两个键 → 用默认值（3分钟 / 15分钟），用户不改就不用管。
  c.memory.flexIdleSec = num(c.memory.flexIdleSec, 30, 6 * 3600, 180)
  c.memory.flexMinGapSec = num(c.memory.flexMinGapSec, 30, 24 * 3600, 900)
  // 提炼模型的坐标：provider/model 都空着 = 跟随默认。只填一个就等于没填（会退回跟随默认），
  // 免得半截配置让 resolveModel 拿到一个不存在的路由。
  const pm = c.model || {}
  c.model = {
    provider: String(pm.provider || '').trim(),
    model: String(pm.model || '').trim(),
    reasoningEffort: ['low', 'medium', 'high'].includes(pm.reasoningEffort) ? pm.reasoningEffort : 'low',
  }
  if (!c.model.provider || !c.model.model) { c.model.provider = ''; c.model.model = '' }

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
