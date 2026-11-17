// 上下文补齐：一套水位，两个触发点
//
// 为什么合并：以前「群上下文补齐」和「断线补拉」是两坨代码、两套配置，做的是同一件事 ——
// 拿上次见到消息的时间当水位，把中间的全部拉回来。分开维护只会让两边的边界条件越来越不像。
//
// 硬约束（真机实测，别再试）：
//   · 群里未 @ 机器人的消息企微**根本不推**（长连接和 StreamableHttp 都一样），
//     所以群的水位只能停在上次被 @ 的时刻；私聊才是「收到就更新」。
//   · MCP 的 chat_messages_list 只能查最近 7 天，超了报 850016。
//   · 返回值里 content[0].text 是 JSON 字符串，要二次 parse，还要剥掉服务端禁止转述的字段。
//
// 三个必须做的保护：
//   1. 去重 —— 实时消息和补拉会撞同一句，按 msgid 挡（滚动集合，持久化）。
//   2. 分批 —— 一次 append 几万条会把上下文炸掉，按字符预算切，**先补最近的**。
//   3. 首次启动无水位就不补 —— 否则第一次启动就把 7 天全拉回来。

import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { DATA_DIR } from '../core/config.js'

const WATER_FILE = join(DATA_DIR, 'watermarks.json')

/** 一批最多塞多少字符（约 2 万字符 ≈ 一万汉字，够模型理解上下文又不至于炸） */
const BATCH_CHARS = 20000
/** 已见 msgid 只留最近这么多条，再老的丢掉（否则文件无限长） */
const SEEN_KEEP = 4000
/** MCP 的硬上限，留一天余量 */
const MAX_SPAN_MS = 6 * 86400e3

function load() {
  try {
    if (existsSync(WATER_FILE)) {
      const m = JSON.parse(readFileSync(WATER_FILE, 'utf8'))
      if (m && typeof m === 'object' && m.chats) return m
    }
  } catch {}
  return { chats: {} }
}

function saveNow(m) {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    const tmp = WATER_FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify(m, null, 2), 'utf8')
    renameSync(tmp, WATER_FILE)
  } catch {}
}

/**
 * 防抖写盘：touch() 每条消息都会调，而水位文件会随会话数线性变大
 * （单会话 seen 上限 4000 条 ≈ 140 KB，十个会话就 1.4 MB）。
 * 每条消息同步全量重写会卡在事件循环上，所以攒 500ms 合并写一次。
 *
 * 代价：进程崩溃时可能丢最后 500ms 的水位。那个后果是「下次多补几条」，
 * 而补拉有 msgid 去重兜底，不会重复 —— 丢水位是安全方向，丢消息才不是。
 */
const SAVE_DEBOUNCE_MS = 500

/**
 * @param {object} o
 * @param {object} o.log
 * @param {Function} o.mcpFor (service, userid) => MCP 客户端
 * @param {Function} o.appendOnly (sessionId, text, source) => Promise<boolean>
 * @param {Function} o.getConfig
 */
export function createBackfill({ log, mcpFor, appendOnly, getConfig }) {
  const state = load()
  let running = false
  let saveTimer = null
  let dirty = false

  /** 立刻落盘（关停、补拉结束这类「必须写下去」的时刻用） */
  function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    if (!dirty) return
    dirty = false
    saveNow(state)
  }

  /** 攒着写：500ms 内的多次改动合并成一次落盘 */
  function save() {
    dirty = true
    if (saveTimer) return
    saveTimer = setTimeout(() => { saveTimer = null; flush() }, SAVE_DEBOUNCE_MS)
    // 别让这个定时器拖住进程退出（DSH 关停时不该等它）
    if (typeof saveTimer.unref === 'function') saveTimer.unref()
  }

  const entry = (key) => {
    if (!state.chats[key]) state.chats[key] = { at: 0, seen: [] }
    const e = state.chats[key]
    if (!Array.isArray(e.seen)) e.seen = []
    return e
  }

  /** 收到一条实时消息时推进水位（群里的调用方只在被 @ 时才调） */
  function touch(chat, msgid) {
    if (!chat?.chatId) return
    const key = `${chat.kind}:${chat.chatId}`
    const e = entry(key)
    e.at = Date.now()
    if (msgid) markSeen(key, msgid)
    save()
  }

  function markSeen(key, msgid) {
    const e = entry(key)
    if (!msgid || e.seen.includes(msgid)) return
    e.seen.push(msgid)
    if (e.seen.length > SEEN_KEEP) e.seen = e.seen.slice(-SEEN_KEEP)
  }

  const hasSeen = (key, msgid) => {
    const e = state.chats[key]
    return Boolean(msgid && e && Array.isArray(e.seen) && e.seen.includes(msgid))
  }

  function watermarkOf(chat) {
    const e = state.chats[`${chat.kind}:${chat.chatId}`]
    return e && Number(e.at) > 0 ? Number(e.at) : 0
  }

  /** 把一条消息格式化成一行；服务端禁止转述的字段在这里剥掉 */
  function lineOf(it) {
    const who = it.user_name || it.userid || '某人'
    const when = String(it.send_time || '').slice(11, 16)
    const body = it.text?.content ?? `[${it.msg_type || '消息'}]`
    return `${who}（${when}）：${String(body).replace(/\s+/g, ' ').trim()}`
  }

  /** 按字符预算切批，先补最近的 */
  function batches(lines) {
    const out = []
    let cur = []
    let size = 0
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]
      if (size + line.length > BATCH_CHARS && cur.length) {
        out.unshift(cur) // 反着收集，所以用 unshift 把「较早的一批」放前面
        cur = []
        size = 0
      }
      cur.unshift(line)
      size += line.length + 1
    }
    if (cur.length) out.unshift(cur)
    return out
  }

  /**
   * 补一个会话从「上次见到」到「现在」之间漏掉的消息。
   * @param {object} chat
   * @param {string} sessionId
   * @param {{ reason?: string, force?: boolean }} [opts]
   */
  async function fill(chat, sessionId, opts = {}) {
    const cfg = getConfig()
    if (!cfg.history?.enabled) return { ok: false, message: '上下文补齐关着' }
    if (!sessionId) return { ok: false, message: '没有会话' }
    const at = watermarkOf(chat)
    if (!at && !opts.force) {
      // 第一次见这个会话：不补。补了就是把 7 天历史一次性倒进来。
      return { ok: true, skipped: true, message: '首次见这个会话，不补历史' }
    }
    const mc = await mcpFor('msg', chat.userId)
    if (!mc) return { ok: false, message: '没配 MCP 的 msg 服务' }

    const { localTime, safeWindow } = await import('../wecom/mcp.js')
    const now = Date.now()
    const from = Math.max(at || now - 3600e3, now - MAX_SPAN_MS)
    const w = safeWindow(MAX_SPAN_MS, now)
    const begin = localTime(from)
    const truncated = at > 0 && now - at > MAX_SPAN_MS

    const r = await mc.call('chat_messages_list', {
      chat_id: chat.chatId,
      begin_time: begin < w.begin ? w.begin : begin,
      end_time: w.end,
    })
    const list = Array.isArray(r.message_list) ? r.message_list : (Array.isArray(r.messages) ? r.messages : [])
    if (!list.length) {
      touch(chat, '')
      return { ok: true, added: 0, message: '这期间没有新消息' }
    }

    const key = `${chat.kind}:${chat.chatId}`
    // 去重：实时消息已经进过上下文的，这里不再重复
    const fresh = list.filter((it) => !hasSeen(key, it.msgid || it.msg_id || it.id))
    if (!fresh.length) {
      touch(chat, '')
      return { ok: true, added: 0, message: '都看过了，没有新的' }
    }

    const lines = fresh.map(lineOf)
    const chunks = batches(lines)
    const head = opts.reason ? `【${opts.reason}】` : '【这里在你上次看到之后又聊了这些】'
    let added = 0
    for (let i = 0; i < chunks.length; i += 1) {
      const more = i < chunks.length - 1 ? `\n（更早的还有 ${chunks.length - 1 - i} 批，后台继续补）` : ''
      await appendOnly(sessionId, `${head}\n${chunks[i].join('\n')}${more}`, 'wecom-history')
      added += chunks[i].length
    }
    for (const it of fresh) markSeen(key, it.msgid || it.msg_id || it.id)
    touch(chat, '')
    flush() // 补拉是一次性的，别攒着 —— 补完就该让水位落定
    log.debug(`补了 ${added} 条（${chat.kind} ${chat.chatId}${truncated ? '，水位超 7 天已截断' : ''}）`)
    return {
      ok: true,
      added,
      batches: chunks.length,
      truncated,
      message: `补了 ${added} 条${truncated ? '（更早的超过 7 天，企微查不到）' : ''}`,
    }
  }

  /**
   * 重连后把所有已知会话补一遍。
   * @param {string} reason
   * @param {Array<{ chat:object, sessionId:string }>} targets
   */
  async function fillAll(reason, targets) {
    if (running) return { ok: false, message: '已经在补了' }
    const cfg = getConfig()
    if (!cfg.history?.enabled) return { ok: false, message: '上下文补齐关着' }
    if (!targets?.length) return { ok: true, added: 0, message: '没有已知会话' }
    running = true
    let total = 0
    try {
      for (const t of targets) {
        try {
          const r = await fill(t.chat, t.sessionId, { reason })
          total += r.added || 0
        } catch (error) {
          log.debug(`补拉失败（${t.chat?.chatId}）：${error.message}`)
        }
      }
      if (total) log.info(`断线补拉完成：${total} 条，覆盖 ${targets.length} 个会话`)
      return { ok: true, added: total, message: `补了 ${total} 条` }
    } finally {
      running = false
      flush()
    }
  }

  return { touch, fill, fillAll, watermarkOf, hasSeen, flush, file: WATER_FILE }
}
