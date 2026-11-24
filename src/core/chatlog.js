// 聊天流水：按天一份，记「谁说了什么」，给每日提炼当原料。
//
// 为什么不复用 activity.js：那是给人看的面板日志（最多 3000 条、满了就丢最老的），
// 提炼需要的是「某一天某个会话里完整的对话」，两者保留策略完全相反——
// 一个要短、一个要在提炼之前一条都不能少。
//
// 为什么不用 DSH 会话历史：会话历史会随着压缩/上下文裁剪变形，而且插件拿不到
// 「某个企微会话今天说了什么」这种按天的切片。流水是插件自己的、只增不改的事实记录。

import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { DATA_DIR } from './config.js'

const DIR = join(DATA_DIR, 'chatlog')

/** 一天一个文件，key 用本地时区的 YYYY-MM-DD（跟用户看到的日子对得上） */
export function dayKey(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const fileOf = (day) => join(DIR, `${day}.jsonl`)

function ensureDir() {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true })
}

// 当天的写在内存里，攒够或退出时再落盘。
// 每条消息都 open/append/close 一次不划算：企微群一分钟能来几十条。
let buf = []
let bufDay = dayKey()

export function append(entry) {
  const day = dayKey()
  // 跨天了先把昨天的落盘，否则昨天的内容会写进今天的文件
  if (day !== bufDay) {
    persist()
    bufDay = day
  }
  buf.push({
    at: Date.now(),
    chatId: String(entry.chatId || ''),       // dm 用 userid，group 用 chatid
    kind: entry.kind === 'group' ? 'group' : 'dm',
    chatName: String(entry.chatName || ''),
    userId: String(entry.userId || ''),
    name: String(entry.name || ''),           // 说话人显示名
    who: entry.who === 'bot' ? 'bot' : 'user',
    text: String(entry.text || '').slice(0, 2000),
  })
  if (buf.length >= 50) persist()
  else armFlush()
}

/**
 * 攒够 50 条再落盘是省 IO，但代价是「进程一崩，今天的对话就没了」。
 * 而 chatlog 是记忆提炼的唯一原料 —— 丢了就永远补不回来（企微不重发历史）。
 * 所以加一个节流落盘：有新增就排一次，30 秒内最多写一次。
 * 为什么不是每条都写：群消息密集时每条一个 writeFileSync 会把事件循环堵住，
 * 那比丢数据更早被用户感知到（回消息变卡）。
 */
const FLUSH_INTERVAL_MS = 30_000
let flushTimer

function armFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = undefined
    persist()
  }, FLUSH_INTERVAL_MS)
  flushTimer.unref?.()
}

/** 进程退出前落盘（host 的 effect 清理函数会调） */
export function flush() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined }
  persist()
}

function persist() {
  const rows = buf
  buf = []
  if (!rows.length) return
  try {
    ensureDir()
    const f = fileOf(bufDay)
    const head = existsSync(f) ? readFileSync(f, 'utf8') : ''
    const body = rows.map((e) => JSON.stringify(e)).join('\n')
    const tmp = f + '.tmp'
    writeFileSync(tmp, head + (head && !head.endsWith('\n') ? '\n' : '') + body + '\n', 'utf8')
    renameSync(tmp, f)
  } catch (error) {
    // 写不进去也不能影响回消息 —— 流水只是副产品
  }
}

/** 某一天的流水（含还没落盘的内存部分） */
export function readDay(day) {
  const out = []
  try {
    const f = fileOf(day)
    if (existsSync(f)) {
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try { out.push(JSON.parse(line)) } catch {}
      }
    }
  } catch {}
  if (day === bufDay) out.push(...buf)
  return out
}

/** 有流水的所有日子，从旧到新 */
export function days() {
  const set = new Set()
  try {
    if (existsSync(DIR)) {
      for (const f of readdirSync(DIR)) {
        const m = f.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/)
        if (m) set.add(m[1])
      }
    }
  } catch {}
  if (buf.length) set.add(bufDay)
  return [...set].sort()
}

/** 提炼完就把那天删了：流水是原料不是资产，留着只会让磁盘一直长 */
export function dropDay(day) {
  try {
    const f = fileOf(day)
    if (existsSync(f)) unlinkSync(f)
  } catch {}
}

/** 超过 keepDays 的自动清理（防提炼一直没跑、流水无限堆积） */
export function prune(keepDays = 14) {
  const cutoff = dayKey(new Date(Date.now() - keepDays * 86400_000))
  for (const day of days()) if (day < cutoff) dropDay(day)
}
