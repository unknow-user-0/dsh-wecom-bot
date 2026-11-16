// 额度：按 token 算，全局 + 每会话两档
//
// 为什么按 token 不按条数：一次带图的问题可能顶 100 条纯文字，按条算完全不准。
// 条数只作为「防刷屏」的辅助计量（单会话每分钟超过 N 条就拦）。
//
// token 从哪来：DSH 的 turn/end 事件带 usage（inputTokens / outputTokens /
// cacheReadTokens / cacheWriteTokens）。拿不到时退化成「字符数 / 3」估算。

import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { DATA_DIR } from '../core/config.js'

const FILE = join(DATA_DIR, 'usage.json')

function today() {
  return new Date().toLocaleDateString('en-CA')   // YYYY-MM-DD（本地时区）
}

function load() {
  try {
    if (existsSync(FILE)) {
      const d = JSON.parse(readFileSync(FILE, 'utf8'))
      if (d && d.day === today()) return d
    }
  } catch {}
  return { day: today(), global: 0, chats: {}, minutes: {} }
}

function save(d) {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    const tmp = FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify(d), 'utf8')
    renameSync(tmp, FILE)
  } catch {}
}

const state = load()

/** 粗估 token：中文按 1 字 ≈ 1 token，英文按 4 字符 ≈ 1 token，取中位 */
export function estimateTokens(text) {
  const s = String(text || '')
  if (!s) return 0
  // 中日韩字符算 1 token/字，其它按 3.5 字符/token
  const cjk = (s.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length
  const rest = s.length - cjk
  return Math.ceil(cjk + rest / 3.5)
}

/**
 * 记一次用量。
 * @param {string} chatKey 会话 key（channel:kind:chatId）
 * @param {number} tokens 实际或估算的 token 数
 */
export function addUsage(chatKey, tokens) {
  const n = Math.max(0, Math.round(Number(tokens) || 0))
  if (!n) return
  state.global = (state.global || 0) + n
  state.chats[chatKey] = (state.chats[chatKey] || 0) + n
  save(state)
}

/** 每分钟条数（防刷屏） */
export function tickMinute(chatKey) {
  const m = new Date().toISOString().slice(0, 16)
  if (!state.minutes[m]) state.minutes[m] = {}
  state.minutes[m][chatKey] = (state.minutes[m][chatKey] || 0) + 1
  // 清掉两分钟前的
  for (const k of Object.keys(state.minutes)) if (k < m.slice(0, 14) + '00' || k !== m) {
    const diff = (new Date(m + ':00').getTime() - new Date(k + ':00').getTime()) / 60000
    if (diff > 2) delete state.minutes[k]
  }
  save(state)
  return state.minutes[m][chatKey]
}

/**
 * 检查还能不能用。
 * @returns {{ok:boolean, scope?:'global'|'chat'|'burst', used?:number, limit?:number, text?:string}}
 */
export function checkQuota(cfg, chatKey, isAdmin) {
  if (!cfg.quota.enabled) return { ok: true }
  if (isAdmin && cfg.quota.adminsUnlimited) return { ok: true }

  // 防刷屏（辅助计量）
  const m = new Date().toISOString().slice(0, 16)
  const perMin = state.minutes[m]?.[chatKey] || 0
  if (perMin >= cfg.quota.burstPerMinute) {
    return { ok: false, scope: 'burst', used: perMin, limit: cfg.quota.burstPerMinute, text: '你说话太快啦，让我缓一下下' }
  }

  const usedChat = state.chats[chatKey] || 0
  const usedGlobal = state.global || 0

  if (cfg.quota.globalDailyTokens > 0 && usedGlobal >= cfg.quota.globalDailyTokens) {
    return { ok: false, scope: 'global', used: usedGlobal, limit: cfg.quota.globalDailyTokens, text: '我今天有点累啦，明天再来找我吧' }
  }
  if (cfg.quota.perChatDailyTokens > 0 && usedChat >= cfg.quota.perChatDailyTokens) {
    return { ok: false, scope: 'chat', used: usedChat, limit: cfg.quota.perChatDailyTokens, text: '我今天跟你说太多啦，明天再聊好不好' }
  }
  return { ok: true, used: usedChat, limit: cfg.quota.perChatDailyTokens }
}

export function usageSnapshot() {
  return {
    day: state.day,
    global: state.global || 0,
    chats: { ...state.chats },
    top: Object.entries(state.chats || {}).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([key, tokens]) => ({ key, tokens })),
  }
}

export function resetUsage() {
  state.day = today()
  state.global = 0
  state.chats = {}
  state.minutes = {}
  save(state)
}
