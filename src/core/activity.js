// 一个会话（人 / 群）的进出流水 —— 面板看「谁来过、聊了什么」
//
// 与 araubot 的 bridge 记录同类，但更薄：只记 chat 维度的最近 N 条，
// 用于①面板展示 ②切白名单时看到谁是陌生的 ③排障

import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { DATA_DIR } from '../core/config.js'

const FILE = join(DATA_DIR, 'log.jsonl')
const MAX_KEEP = 3000

let buf = []

export function record(entry) {
  buf.push({ at: Date.now(), ...entry })
  if (buf.length > 400) persist()
  return entry
}

function persist() {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    const existing = existsSync(FILE) ? readFileSync(FILE, 'utf8').split('\n').filter(Boolean) : []
    const merged = [...existing, ...buf.map((e) => JSON.stringify(e))]
    const keep = merged.slice(-MAX_KEEP)
    const tmp = FILE + '.tmp'
    writeFileSync(tmp, keep.join('\n') + '\n', 'utf8')
    renameSync(tmp, FILE)
    buf = []
  } catch {}
}

export function flushLog() { persist() }

/** 面板：最近的流水 */
export function recentEntries(limit = 100, filter = {}) {
  try {
    const disk = existsSync(FILE) ? readFileSync(FILE, 'utf8').split('\n').filter(Boolean) : []
    const all = [...disk.map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean), ...buf]
    let rows = all
    if (filter.chatId) rows = rows.filter((r) => r.chatId === filter.chatId)
    if (filter.kind) rows = rows.filter((r) => r.kind === filter.kind)
    return rows.slice(-limit).reverse()
  } catch {
    return []
  }
}

/** 统计：谁来过、最后一次什么时候、来了几次 */
export function chatStats() {
  try {
    const disk = existsSync(FILE) ? readFileSync(FILE, 'utf8').split('\n').filter(Boolean) : []
    const all = [...disk.map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean), ...buf]
    const m = new Map()
    for (const r of all) {
      if (!r.chatId) continue
      let e = m.get(r.chatId)
      if (!e) {
        e = { chatId: r.chatId, kind: r.kind, name: r.name || '', userId: r.userId || '', count: 0, firstAt: r.at, lastAt: r.at }
        m.set(r.chatId, e)
      }
      e.count += 1
      e.lastAt = Math.max(e.lastAt, r.at)
      e.firstAt = Math.min(e.firstAt, r.at)
      if (r.name) e.name = r.name
    }
    return [...m.values()].sort((a, b) => b.lastAt - a.lastAt)
  } catch {
    return []
  }
}
