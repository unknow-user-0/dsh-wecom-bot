// 连发合并：对方停顿 waitSec 秒再一起回，最多等 maxSec 秒。
// 群里等得久一点，把一段话攒齐。
//
// ⚠ 企微特有的两个坑：
//   1. 合并后只能回复最后一条的 req_id —— 前几条的 req_id 作废（回两次会重复发）
//   2. 企微没有「正在输入」提示（caps.typing = false），用户会以为没收到
//      → 收到第一条就先回一句预回复（默认 emmm...），超过阈值还没处理完再说一句

import { fireAndForget } from '../core/safe.js'

/** 超过这个时间还没开始处理，先发一句「别急」 */
const SLOW_NOTICE_MS = 8_000

/**
 * 要不要发预回复。
 * 文字和图片各有开关：只配了图的人用 placeholderOn=false 关掉文字，
 * 但他仍然想收到预回复图 —— 所以两个都关才是「彻底安静」。
 */
function wantsPlaceholder(cfg) {
  const m = cfg?.merge || {}
  const textOn = m.placeholderOn !== false
  const imageOn = m.placeholderImageOn !== false && Boolean(String(m.placeholderImage || '').trim())
  return textOn || imageOn
}

export function createMerger({ log, onFlush, onPlaceholder }) {
  /** chatId → { items: [], timer, firstAt, lastAt, sentPlaceholder, slowTimer, lastFrame } */
  const pending = new Map()

  function keyOf(frame) {
    const body = frame.body || {}
    return body.chatid || body.from?.userid || 'unknown'
  }

  function clearTimers(entry) {
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = undefined }
    if (entry.slowTimer) { clearTimeout(entry.slowTimer); entry.slowTimer = undefined }
  }

  /** 把一条入站帧塞进合并队列 */
  function push(frame, normalized, opts) {
    const cfg = opts.config
    const kind = normalized.chat.kind
    const waitSec = kind === 'group' ? cfg.merge.groupWaitSec : cfg.merge.waitSec
    const maxSec = kind === 'group' ? cfg.merge.groupMaxSec : cfg.merge.maxSec
    const key = keyOf(frame)

    let entry = pending.get(key)
    if (!entry) {
      entry = { items: [], timer: undefined, slowTimer: undefined, firstAt: Date.now(), lastAt: 0, sentPlaceholder: false, lastFrame: frame }
      pending.set(key, entry)
    }

    entry.items.push(normalized)
    entry.lastAt = Date.now()
    entry.lastFrame = frame          // 只回最后一条的 req_id

    // 第一条消息：预回复（文字 / 图片 / 都发）
    // 开关在面板「功能」栏。关掉就彻底不出声 —— 有人嫌「emmm...」多余，
    // 也有人（群里）觉得没有它就像消息石沉大海。默认开。
    //
    // 这里只判断「要不要通知一声」，具体发什么由 src/chat/placeholder.js 决定：
    // 文字和图片各有自己的开关，只配了图的用户不该因为 placeholderOn 没开就不出声。
    if (!entry.sentPlaceholder && wantsPlaceholder(cfg)) {
      entry.sentPlaceholder = true
      try { onPlaceholder?.(frame, normalized.chat) } catch {}
      entry.slowTimer = setTimeout(() => {
        // 8 秒还没处理完 —— 再说一句（预回复已经发过了，这里只记日志不重复发）
        log.debug(`合并等待已超 ${SLOW_NOTICE_MS / 1000} 秒，仍在攒消息`)
      }, SLOW_NOTICE_MS)
      entry.slowTimer.unref?.()
    }

    if (entry.timer) clearTimeout(entry.timer)
    const elapsed = Date.now() - entry.firstAt
    const remainToMax = Math.max(0, maxSec * 1000 - elapsed)
    const delay = Math.min(waitSec * 1000, remainToMax)

    if (delay <= 0) {
      fireAndForget(flush(key), '合并处理', log)
      return
    }
    entry.timer = setTimeout(() => { fireAndForget(flush(key), '合并处理', log) }, delay)
    entry.timer.unref?.()
  }

  async function flush(key) {
    const entry = pending.get(key)
    if (!entry || entry.items.length === 0) return
    pending.delete(key)
    clearTimers(entry)
    const frame = entry.lastFrame
    const items = entry.items
    log.debug(`合并 ${items.length} 条消息（${key}）`)
    try {
      await onFlush(frame, items)
    } catch (error) {
      log.error(`合并处理失败：${error.message}`)
    }
  }

  /** 进程退出 / 断开时把攒着的都放出去 */
  async function flushAll() {
    const keys = [...pending.keys()]
    for (const k of keys) await flush(k)
  }

  function cancel(key) {
    const entry = pending.get(key)
    if (!entry) return
    clearTimers(entry)
    pending.delete(key)
  }

  return { push, flush, flushAll, cancel, pendingCount: () => pending.size }
}
