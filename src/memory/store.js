// 记忆：四层分离（人 / 场景 / 技能 / 公共）
//
// 为什么不用 araubot 那套扁平结构：
//   它的 { text, about, chatId, importance, at } 只能表达「关于谁」，
//   表达不了「在哪儿说的」和「什么时候会过时」，会把三个月的行程安排当成今天的事实。
//
// 四层：
//   人   —— 关于某个人的属性/偏好/关系。只有和这个人对话时召回
//   场景 —— 某个群/某个私聊里发生过的事。只有在这个场景召回
//   技能 —— 怎么做一件事。所有人共享，不参与人维度打分（超过三句的放技能文件）
//   公共 —— 全公司通用的事实。所有人共享
//
// 三种遗忘：
//   ① 显式取代：新记忆覆盖旧记忆，旧的标 supersededAt 不删也不再召回
//   ② 时效过期：ephemeral 类带 expiresAt，过期自动降权到不召回
//   ③ 分级半衰期：关系永不衰减、喜好 180 天、一般事实 60 天、临时状态 7 天

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { DATA_DIR } from '../core/config.js'

const FILE = join(DATA_DIR, 'memory.json')

/** 半衰期（天）：0 = 永不衰减 */
const HALF_LIFE = {
  relation: 0,      // 关系 / 称呼 / 身份
  preference: 180,  // 核心喜好 / 禁忌
  fact: 60,         // 一般事实
  state: 7,         // 临时状态 / 心情
  ephemeral: 0,     // 靠 expiresAt 管
}

function load() {
  try {
    if (existsSync(FILE)) {
      const d = JSON.parse(readFileSync(FILE, 'utf8'))
      if (d && Array.isArray(d.items)) return d
    }
  } catch {}
  return { items: [], recallLog: [] }
}

function save(d) {
  // 写盘失败必须上抛：提炼流程靠「add 成功」判断记忆真的落了盘，
  // 然后才会去删当天的原始流水。这里原来 catch{} 吞掉，等于告诉 consolidate
  // 「记好了」，结果记忆没写进去、流水却被删 —— 两头空，永久丢数据。
  // 上抛后 consolidate 的 catch 会保留流水，下一轮重试（add 有去重，不会堆垃圾）。
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
  const tmp = FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(d, null, 2), 'utf8')
  renameSync(tmp, FILE)
}

let db = load()

/** 鲜活度：0~1，越久越低 */
function freshness(item, now = Date.now()) {
  // 字段名是 type 不是 kind —— add() 只写 type。以前这里和 alive()/stats() 三处
  // 都写成 item.kind，那是个永远 undefined 的字段，于是 ephemeral 永不过期。
  if (item.type === 'ephemeral') {
    if (!item.expiresAt) return 1
    return now < item.expiresAt ? 1 : 0
  }
  const days = HALF_LIFE[item.type] ?? 60
  if (days === 0) return 1
  const ageDays = (now - (item.at || now)) / 86400000
  return Math.pow(0.5, ageDays / days)
}

/** 是不是还能被召回 */
function alive(item, now = Date.now()) {
  if (item.supersededAt) return false
  if (item.invalidAt) return false
  if (item.type === 'ephemeral' && item.expiresAt && now > item.expiresAt) return false
  // 太小的重要度 + 太久没被想起 → 归档
  if (item.archivedAt) return false
  return true
}

/** 极简分词：中文按 2-gram，英文按词 */
function tokenize(s) {
  const text = String(s || '').toLowerCase()
  const out = new Set()
  for (const w of text.match(/[a-z0-9]{2,}/g) || []) out.add(w)
  const cjk = text.match(/[\u4e00-\u9fff]/g) || []
  for (let i = 0; i < cjk.length - 1; i += 1) out.add(cjk[i] + cjk[i + 1])
  return out
}

function similarity(a, b) {
  const A = tokenize(a)
  const B = tokenize(b)
  if (!A.size || !B.size) return 0
  let hit = 0
  for (const t of A) if (B.has(t)) hit += 1
  return hit / Math.max(A.size, B.size)
}

/**
 * 记一条。
 * @param {object} o
 * @param {string} o.text 一句话
 * @param {'person'|'scene'|'skill'|'public'} o.scope
 * @param {'relation'|'preference'|'fact'|'state'|'ephemeral'} [o.type]
 * @param {string} [o.about] 关于谁（userid）
 * @param {string} [o.aboutName] 关于谁（显示名）
 * @param {string} [o.chatId] 场景（群 chatid 或私聊 userid）
 * @param {string} [o.originKind] 来源场景类型：dm | group
 * @param {string} [o.originName] 来源场景名
 * @param {number} [o.importance] 0~1
 * @param {number} [o.expiresAt] 过期时间戳
 * @param {string} [o.supersedes] 被取代的旧条目 id
 */
export function add(o) {
  const text = String(o.text || '').trim().slice(0, 500)
  if (!text) return null
  const scope = ['person', 'scene', 'skill', 'public'].includes(o.scope) ? o.scope : 'person'
  const type = Object.keys(HALF_LIFE).includes(o.type) ? o.type : 'fact'

  // 去重：同 scope + 同 about + 高相似度 → 覆盖已有（视为「取代」）
  const dup = db.items.find((m) =>
    !m.invalidAt && !m.supersededAt &&
    m.scope === scope &&
    String(m.about || '') === String(o.about || '') &&
    similarity(m.text, text) >= 0.6)
  if (dup) {
    dup.supersededAt = Date.now()
    dup.supersededBy = 'auto'
  }

  // 显式取代
  if (o.supersedes) {
    const old = db.items.find((m) => m.id === o.supersedes)
    if (old && !old.supersededAt) {
      old.supersededAt = Date.now()
      old.supersededBy = 'explicit'
    }
  }

  const item = {
    id: randomUUID().slice(0, 8),
    text,
    scope,
    type,
    about: String(o.about || ''),
    aboutName: String(o.aboutName || ''),
    chatId: String(o.chatId || ''),
    originKind: String(o.originKind || ''),
    originName: String(o.originName || ''),
    importance: Math.max(0, Math.min(1, Number(o.importance) || 0.5)),
    expiresAt: Number(o.expiresAt) || 0,
    at: Date.now(),
    hits: 0,
    source: String(o.source || 'tool'),
  }
  db.items.push(item)
  // 上限保护：超过 5000 条把最老最不重要的归档
  if (db.items.length > 5000) archiveStale()
  save(db)
  return item
}

/** 归档：长期没被召回 + 重要度低 + 老 */
function archiveStale() {
  const now = Date.now()
  const alive_ = db.items.filter((m) => !m.archivedAt && !m.invalidAt)
  alive_.sort((a, b) => {
    const sa = (a.importance || 0.5) * freshness(a, now) * (1 + Math.min(a.hits || 0, 10) * 0.1)
    const sb = (b.importance || 0.5) * freshness(b, now) * (1 + Math.min(b.hits || 0, 10) * 0.1)
    return sa - sb
  })
  const surplus = Math.max(0, db.items.length - 4500)
  for (let i = 0; i < surplus && i < alive_.length; i += 1) alive_[i].archivedAt = now
}

/**
 * 召回。
 * @param {string} query
 * @param {object} o { about, chatId, aboutList, limit, minScore, silent }
 */
export function recall(query, o = {}) {
  const now = Date.now()
  const q = String(query || '')
  const qTok = tokenize(q)
  const limit = Math.max(1, Math.min(30, Number(o.limit) || 8))
  const minScore = Number(o.minScore) || 0

  const aboutSet = new Set()
  if (o.about) aboutSet.add(String(o.about))
  for (const a of o.aboutList || []) aboutSet.add(String(a))
  const chatId = String(o.chatId || '')

  const scored = []
  for (const it of db.items) {
    if (!alive(it, now)) continue

    // 硬门禁（不是加分，是「根本不该看见」）。
    //
    // 四层里 person 和 scene 是私密层，它们的隔离必须是硬约束：
    // 以前只把它们做成加分项，于是词命中就能跨过隔离 —— 小李在私聊说过
    // 「我胃不好」，别人在群里问「谁胃不好」照样能召回出来。分数再高，
    // 泄露出去也是错的。这是隐私边界，不是排序偏好。
    if (it.scope === 'person' && it.about && !aboutSet.has(String(it.about))) continue
    if (it.scope === 'scene' && it.chatId && String(it.chatId) !== chatId) continue

    // 权重：场景匹配 > 关于这个人 > 词命中
    let score = 0
    const why = []

    const itTok = tokenize(`${it.text} ${it.aboutName || ''}`)
    let hit = 0
    for (const t of qTok) if (itTok.has(t)) hit += 1
    if (hit > 0) {
      score += hit / Math.max(1, Math.min(qTok.size, 8))
      why.push('词命中')
    }

    if (chatId && it.chatId && String(it.chatId) === chatId) {
      score += 1.2
      why.push('就在这个会话里说的')
    }
    if (it.about && aboutSet.has(String(it.about))) {
      score += 0.8
      why.push('关于这个人')
    }
    // 公共 / 技能：不太依赖词命中，但权重压低
    if (it.scope === 'public' || it.scope === 'skill') score += 0.15

    if (score <= 0) continue
    score *= (0.55 + 0.45 * freshness(it, now)) * (0.6 + 0.8 * (it.importance || 0.5))
    // 最近 24 小时内的加分
    if (now - (it.at || 0) < 86400000) score += 0.25

    if (score < minScore) continue
    scored.push({ it, score, why })
  }

  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, limit)

  // 召回日志也要落盘，所以 save 必须放在这行之后。
  // 以前是先 save(db)、再 unshift —— 日志只活在内存里，重启就没了，
  // 表现就是「recallLog 永远是空的，到底有没有召回根本查不了」。
  //
  // silent：每轮自动塞进用户消息的那次「你记得关于他的事」用它。
  // 那条不是模型主动回忆，不该占召回日志，更重要的是不该每条消息都重写一遍
  // memory.json（5000 条时一次几 MB，群里一分钟几十条就直接卡住了）。
  if (!o.silent) {
    db.recallLog.unshift({ at: now, query: q.slice(0, 120), hits: top.map((h) => ({ id: h.it.id, text: h.it.text, score: Number(h.score.toFixed(2)) })) })
    if (db.recallLog.length > 200) db.recallLog.length = 200
    for (const h of top) h.it.hits = (h.it.hits || 0) + 1
    save(db)
  }

  return top
}

/** 一条记忆渲染成一行（来源不是当前场景时标明，让模型有语境感） */
export function renderLine(item, currentChatId = '') {
  const parts = []
  const when = new Date(item.at || Date.now())
  const days = Math.floor((Date.now() - when.getTime()) / 86400000)
  const whenText = days === 0 ? '今天' : days === 1 ? '昨天' : days < 30 ? `${days} 天前` : when.toLocaleDateString('zh-CN')
  parts.push(`[${whenText}]`)
  if (item.aboutName) parts.push(`[${item.aboutName}]`)
  // 来源场景不是当前场景 → 明确标出来
  if (item.chatId && currentChatId && item.chatId !== currentChatId) {
    const where = item.originKind === 'group' ? `在「${item.originName || '另一个群'}」说的` : '私聊说的'
    parts.push(`（${where}）`)
  }
  parts.push(item.text)
  return parts.join(' ')
}

export function listAll(filter = {}) {
  const now = Date.now()
  return db.items
    .filter((m) => {
      if (filter.scope && m.scope !== filter.scope) return false
      if (filter.about && String(m.about) !== String(filter.about)) return false
      if (!filter.includeDead && !alive(m, now)) return false
      if (filter.q) {
        const t = String(filter.q).toLowerCase()
        if (!m.text.toLowerCase().includes(t) && !String(m.aboutName || '').toLowerCase().includes(t)) return false
      }
      return true
    })
    .sort((a, b) => (b.at || 0) - (a.at || 0))
}

export function stats() {
  const now = Date.now()
  const alive_ = db.items.filter((m) => alive(m, now))
  return {
    total: db.items.length,
    alive: alive_.length,
    archived: db.items.filter((m) => m.archivedAt).length,
    superseded: db.items.filter((m) => m.supersededAt).length,
    expired: db.items.filter((m) => m.type === 'ephemeral' && m.expiresAt && now > m.expiresAt).length,
    byScope: {
      person: alive_.filter((m) => m.scope === 'person').length,
      scene: alive_.filter((m) => m.scope === 'scene').length,
      skill: alive_.filter((m) => m.scope === 'skill').length,
      public: alive_.filter((m) => m.scope === 'public').length,
    },
  }
}

export function update(id, patch) {
  const m = db.items.find((x) => x.id === id)
  if (!m) return null
  for (const k of ['text', 'importance', 'type', 'expiresAt', 'aboutName', 'chatId']) {
    if (patch[k] !== undefined) m[k] = patch[k]
  }
  save(db)
  return m
}

export function remove(id) {
  const i = db.items.findIndex((x) => x.id === id)
  if (i < 0) return false
  db.items[i].invalidAt = Date.now()
  save(db)
  return true
}

export function recallLog(limit = 50) {
  return db.recallLog.slice(0, limit)
}

export function reload() { db = load() }
