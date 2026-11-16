// 日志：面板和文件双写，带级别和通道。
// 面板要能实时看到「连上了没 / 收到什么 / 发出去什么」，排障全靠这个。

import { appendFileSync, existsSync, mkdirSync, statSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './config.js'

const LOG_FILE = join(DATA_DIR, 'plugin.log')
const MAX_BYTES = 4 * 1024 * 1024

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

/** 内存里留最近 N 条给面板看 */
const RING_SIZE = 500
const ring = []
export function recentLogs(limit = 200) {
  return ring.slice(-limit)
}

function ensureDir() {
  try { if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true }) } catch {}
}

function rotate() {
  try {
    if (!existsSync(LOG_FILE)) return
    if (statSync(LOG_FILE).size < MAX_BYTES) return
    renameSync(LOG_FILE, LOG_FILE + '.1')
  } catch {}
}

const SECRET_KEYS = /(secret|token|apikey|password|aeskey|bot_id)/i
/** 日志里抹掉凭据（DeepSeek API key 这种也要抹） */
export function redact(value) {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    return value
      .replace(/sk-[A-Za-z0-9_-]{16,}/g, 'sk-***')
      .replace(/([?&](?:apikey|token|secret)=)[^&\s]+/gi, '$1***')
      .replace(/("(?:secret|token|apikey|password|aeskey)"\s*:\s*")[^"]*/gi, '$1***')
  }
  if (Array.isArray(value)) return value.map(redact)
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.test(k) ? '***' : redact(v)
    }
    return out
  }
  return value
}

export function createLogger(opts = {}) {
  const minLevel = LEVELS[opts.level || 'info'] || 20
  const sink = []

  function write(level, tag, args) {
    if ((LEVELS[level] || 20) < minLevel) return
    const line = args
      .map((a) => {
        if (typeof a === 'string') return a
        if (a instanceof Error) return a.message
        try { return JSON.stringify(redact(a)) } catch { return String(a) }
      })
      .join(' ')
    const entry = { at: Date.now(), level, tag, text: line }
    ring.push(entry)
    if (ring.length > RING_SIZE) ring.shift()
    for (const fn of sink) { try { fn(entry) } catch {} }
    ensureDir()
    rotate()
    try { appendFileSync(LOG_FILE, `${new Date(entry.at).toISOString()} ${level.toUpperCase().padEnd(5)} ${tag} ${line}\n`) } catch {}
  }

  const logger = {
    debug: (tag, ...a) => write('debug', tag, a),
    info: (tag, ...a) => write('info', tag, a),
    warn: (tag, ...a) => write('warn', tag, a),
    error: (tag, ...a) => write('error', tag, a),
    /** 面板订阅：返回取消函数 */
    subscribe(fn) { sink.push(fn); return () => { const i = sink.indexOf(fn); if (i >= 0) sink.splice(i, 1) } },
    child(tag) {
      return {
        debug: (...a) => write('debug', tag, a),
        info: (...a) => write('info', tag, a),
        warn: (...a) => write('warn', tag, a),
        error: (...a) => write('error', tag, a),
      }
    },
  }
  return logger
}

export { LOG_FILE }
