// 连发合并：对方停顿 waitSec 秒再一起回，最多等 maxSec 秒。
// 群里等得久一点，把一段话攒齐。
//
// ⚠ 企微特有的两个坑：
//   1. 合并后只能回复最后一条的 req_id —— 前几条的 req_id 作废（回两次会重复发）
//   2. 企微没有「正在输入」提示（caps.typing = false），用户会以为没收到
//      → 收到第一条就先回一个占位（默认 emmm...），超过阈值还没处理完再说一句

const DEFAULT_PLACEHOLDER = 'emmm...'
/** 超过这个时间还没开始处理，先发一句「别急」 */
const SLOW_NOTICE_MS = 8_000

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

    // 第一条消息：占位
    if (!entry.sentPlaceholder) {
      entry.sentPlaceholder = true
      const ph = cfg.merge.placeholder || DEFAULT_PLACEHOLDER
      try { onPlaceholder?.(frame, ph) } catch {}
      entry.slowTimer = setTimeout(() => {
        // 8 秒还没处理完 —— 再说一句（占位已经发过了，这里只记日志不重复发）
        log.debug(`合并等待已超 ${SLOW_NOTICE_MS / 1000} 秒，仍在攒消息`)
      }, SLOW_NOTICE_MS)
      entry.slowTimer.unref?.()
    }

    if (entry.timer) clearTimeout(entry.timer)
    const elapsed = Date.now() - entry.firstAt
    const remainToMax = Math.max(0, maxSec * 1000 - elapsed)
    const delay = Math.min(waitSec * 1000, remainToMax)

    if (delay <= 0) {
      void flush(key)
      return
    }
    entry.timer = setTimeout(() => { void flush(key) }, delay)
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
