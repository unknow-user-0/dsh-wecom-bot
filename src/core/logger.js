// 日志：面板和文件双写，带级别和通道。
// 面板要能实时看到「连上了没 / 收到什么 / 发出去什么」，排障全靠这个。
//
// ⚠ 别把不该静默的东西写成 debug。
//   DEBUG 默认是关的（见 debugEnabled），写进去等于用户永远看不见。
//   判断标准：这条信息能不能帮他/我们定位一个「他正在遭遇的」问题？
//   能 → info 起步；只是喂给我们自己断案的细节 → debug。

import { appendFileSync, existsSync, mkdirSync, statSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './config.js'

const LOG_FILE = join(DATA_DIR, 'plugin.log')
const MAX_BYTES = 4 * 1024 * 1024

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

/**
 * debug 是否输出。默认关。
 *
 * 以前 createLogger 里默认 'info'，而 DEBUG 层的 10 < 20 —— 于是全仓
 * 十几处 debug 一次都没写进文件，写的人以为自己记录了，出事时什么都没有。
 * 现在显式成一个开关：清掉环境变量就恢复，不用改代码。
 */
const DEBUG_ON = (() => {
  const v = String(process.env.WECOM_BOT_DEBUG || '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
})()

/**
 * 当前是否输出 debug。可在面板上随时开关（不用改环境变量、不用重启）。
 * 之所以做成可变的模块级状态：createLogger 只在启动时调一次，
 * 如果级别写死在实例里，面板拨开关就得重启插件 —— 而出问题时恰恰不能重启。
 */
let debugOn = DEBUG_ON

export function debugEnabled() {
  return debugOn
}

export function setDebugEnabled(on) {
  debugOn = Boolean(on)
  return debugOn
}

/** 内存里留最近 N 条给面板看 */
const RING_SIZE = 500
/**
 * ⚠ 这个 ring 必须活着跨「插件重载」，所以【不能】挪进 createLogger。
 * 和 vault 那个 memory 相反：插件热重载后，面板要还能看见重载之前的日志
 * （否则一重载就白屏，恰恰是出问题时最需要日志的时刻）。
 * 它是进程级的单一真相，多个 logger 实例共享同一个 ring，这是对的。
 */
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
      .replace(/(\bapikey=)[A-Za-z0-9_\-]{20,}/gi, '$1***')
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
  // opts.level 写死了就照它（测试/特殊场景）；否则跟着 debugOn 实时变。
  const fixed = opts.level ? (LEVELS[opts.level] || 20) : 0
  const minNow = () => fixed || (debugOn ? 10 : 20)
  const sink = []

  function write(level, tag, args) {
    if ((LEVELS[level] || 20) < minNow()) return
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
