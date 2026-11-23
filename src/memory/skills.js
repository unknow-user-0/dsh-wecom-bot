// 所学技能：从不同会话里提炼出来的「可复用的做法」。
//
// 和记忆的区别：
//   记忆是「关于谁的事实」——小明喜欢吃辣、这个群是做 TMS 的
//   技能是「以后怎么做」——日报按项目分组、报销先找财务签字
// 记忆按人/场景隔离（隐私边界），技能**所有人共享**：谁学会的都该让大家都用上。
//
// 跨会话整合靠相似度：同一个做法在不同群被分别学到时，不该在列表里躺着两条。
// 合并时保留更长的那句描述（通常信息更全），来源记成多条 —— 面板上能看到「从哪儿学的」。

import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { DATA_DIR } from '../core/config.js'

const DIR = join(DATA_DIR, 'skills')
const FILE = join(DIR, 'skills.json')

/**
 * 相似度到多少算「同一个技能」。
 *
 * 用**覆盖率**（交集 / 较短那条）而不是 Jaccard：技能描述长短差很多，
 * 「日报要按项目分组」和「写日报的时候按项目分组，不要按时间排」说的是同一件事，
 * 但 Jaccard 只有 0.33，覆盖率有 0.55。
 *
 * 0.6 这个数是量出来的，不是拍的。实测几组：
 *   同一件事、措辞接近  0.88 / 0.71  → 应该并
 *   同一件事、措辞差得远 0.55        → 并不了，留给模型
 *   不同的事            0.00        → 不能并
 * 卡在 0.6 就是「明显的重复自动并，说不准的不动」。
 *
 * 说不准的那部分**故意**不靠加大阈值硬凑：词面判错是把两条不同的做法
 * 合成一条，不可逆；而漏掉的同义改写还能靠「再整合一次」（模型判定）补回来。
 * 一个错误能修，另一个不能，那就往能修的那边偏。
 */
const MERGE_AT = 0.6

/** 短于这么多个 token 的技能不参与判重（两三个字的「报销」会跟任何长句撞上） */
const MIN_TOKENS = 6

/** 重叠至少要这么多 token，避免短技能靠两三个字判成同一条 */
const MIN_HIT = 4

/** 最多留多少条：技能是精挑的东西，几百条就说明提炼提示词该收紧了 */
const MAX = 400

function load() {
  try {
    if (existsSync(FILE)) {
      const j = JSON.parse(readFileSync(FILE, 'utf8'))
      if (j && Array.isArray(j.items)) return j
    }
  } catch {}
  return { items: [], rev: 0 }
}

function save(db) {
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true })
    const tmp = FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8')
    renameSync(tmp, FILE)
  } catch {}
}

/** 和记忆同一套极简分词：中文 2-gram + 英文词 */
function tokenize(s) {
  const text = String(s || '').toLowerCase()
  const out = new Set()
  for (const w of text.match(/[a-z0-9]{2,}/g) || []) out.add(w)
  const cjk = text.match(/[\u4e00-\u9fff]/g) || []
  for (let i = 0; i < cjk.length - 1; i += 1) out.add(cjk[i] + cjk[i + 1])
  return out
}

/** 词面相似度：交集 / 较短那条（覆盖率，不是 Jaccard） */
export function sim(a, b) {
  const A = tokenize(a)
  const B = tokenize(b)
  if (!A.size || !B.size) return 0
  let hit = 0
  for (const t of A) if (B.has(t)) hit += 1
  // 覆盖率有个天然缺陷：短句被长句完整包住时永远是 1.0。
  // 「报销」这种两个字的短技能会跟任何提到报销的长句判成同一条。
  // 所以要求两边都有一定体量、且重叠本身够多，短句不参与判重。
  if (Math.min(A.size, B.size) < MIN_TOKENS || hit < MIN_HIT) return 0
  return hit / Math.min(A.size, B.size)
}

/**
 * 加一条技能。和已有的像就合并，不像就新增。
 * @returns {{item:object, merged:boolean}}
 */
export function addSkill({ name, text, chatId = '', chatName = '', kind = '' }) {
  const t = String(text || '').trim().slice(0, 300)
  if (!t) return { item: null, merged: false }
  const n = String(name || '').trim().slice(0, 30) || '做法'
  const db = load()
  const origin = { chatId: String(chatId || ''), chatName: String(chatName || ''), kind: String(kind || ''), at: Date.now() }

  // 比「名字 + 正文」两处，任一相似就算同一个技能
  const hit = db.items.find((s) => sim(`${s.name} ${s.text}`, `${n} ${t}`) >= MERGE_AT)
  if (hit) {
    // 保留信息更全的那句：长的那条通常是后来补充清楚的
    if (t.length > hit.text.length) {
      hit.text = t
      if (n.length >= 2 && n !== hit.name) hit.name = n
    }
    if (!hit.from.some((f) => f.chatId === origin.chatId)) hit.from.push(origin)
    hit.from = hit.from.slice(-8)
    hit.at = Date.now()
    hit.times = (hit.times || 1) + 1
    db.rev += 1
    save(db)
    return { item: hit, merged: true }
  }

  const item = { id: randomUUID().slice(0, 8), name: n, text: t, from: [origin], at: Date.now(), times: 1, source: 'auto' }
  db.items.push(item)
  if (db.items.length > MAX) {
    // 满了先丢「只学到一次 + 最久没再出现」的
    db.items.sort((a, b) => ((b.times || 1) - (a.times || 1)) || (b.at - a.at))
    db.items = db.items.slice(0, MAX)
  }
  db.rev += 1
  save(db)
  return { item, merged: false }
}

/** 把现有技能整体再整合一遍：模型判断哪些其实是同一件事（相似度兜不住同义改写） */
export function applyMergeGroups(groups, log) {
  const db = load()
  let merged = 0
  for (const g of groups || []) {
    const ids = Array.isArray(g && g.ids) ? g.ids.map(String) : []
    if (ids.length < 2) continue
    const items = ids.map((id) => db.items.find((s) => s.id === id)).filter(Boolean)
    if (items.length < 2) continue
    const keep = items.reduce((a, b) => ((b.text || '').length > (a.text || '').length ? b : a))
    keep.name = String(g.name || '').trim().slice(0, 30) || keep.name
    keep.text = String(g.text || '').trim().slice(0, 300) || keep.text
    keep.times = items.reduce((n, s) => n + (s.times || 1), 0)
    keep.from = items.flatMap((s) => s.from || []).slice(-8)
    keep.at = Date.now()
    for (const s of items) if (s !== keep) db.items = db.items.filter((x) => x !== s)
    merged += items.length - 1
  }
  if (merged) { db.rev += 1; save(db) }
  log?.info?.(`技能整合：合并掉 ${merged} 条重复`)
  return merged
}

export function listSkills(q = '') {
  const db = load()
  const items = db.items.slice().sort((a, b) => (b.at || 0) - (a.at || 0))
  if (!q) return items
  const t = String(q).toLowerCase()
  return items.filter((s) => `${s.name} ${s.text}`.toLowerCase().includes(t) || sim(`${s.name} ${s.text}`, q) >= 0.4)
}

export function updateSkill(id, patch) {
  const db = load()
  const s = db.items.find((x) => x.id === id)
  if (!s) return false
  for (const k of ['name', 'text']) if (patch[k] !== undefined) s[k] = String(patch[k]).slice(0, k === 'name' ? 30 : 300)
  s.source = 'panel'
  s.at = Date.now()
  db.rev += 1
  save(db)
  return true
}

export function removeSkill(id) {
  const db = load()
  const before = db.items.length
  db.items = db.items.filter((x) => x.id !== id)
  if (db.items.length === before) return false
  db.rev += 1
  save(db)
  return true
}

/** 手动加一条（面板上「新增技能」或从文件导入） */
export function importSkill({ name, text }) {
  const t = String(text || '').trim()
  if (!t) return null
  return addSkill({ name, text: t, chatId: '', chatName: '手动添加', kind: 'manual' }).item
}

export function stats() {
  const db = load()
  return { count: db.items.length, merged: db.items.filter((s) => (s.times || 1) > 1).length }
}
