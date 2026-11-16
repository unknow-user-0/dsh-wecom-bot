// 企微智能机器人长连接客户端
//
// 协议事实（企微文档 path/101463，均经真机验证）：
//   - 连 wss://openws.work.weixin.qq.com
//   - 订阅帧 aibot_subscribe { bot_id, secret }，成功回 { errcode: 0, errmsg: 'ok' }
//   - 心跳 30s（本机实测不心跳会在一段时间后断，但不报错）
//   - **单连接排他**：新订阅会把旧连接踢掉，旧连接收 disconnected_event
//     → 被踢后必须禁自动重连，否则两个实例会互踢乒乓
//   - 入站 aibot_msg_callback / aibot_event_callback
//   - 回复 aibot_respond_msg 必须透传原回调 req_id
//   - 主动推送 aibot_send_msg 要求该会话已被用户激活
//
// ⚠ 必须用 ws 库，不能用 Node 全局 WebSocket：
//    im-union lib/channels/wecom.js:3 原话「Node 全局 WebSocket(undici) 与本服务端
//    升级握手不兼容，实测订阅必失败」。真机复现是 error 事件 + close 1006。

import { randomBytes } from 'node:crypto'
import { tryRequire } from '../core/deps.js'

let WsLib
try { WsLib = tryRequire('ws') } catch { WsLib = undefined }

export const WS_URL = 'wss://openws.work.weixin.qq.com'
export const HEARTBEAT_MS = 30_000
export const REQUEST_TIMEOUT_MS = 15_000
/** 流式节流：企微官方建议，太快会被限流 */
export const STREAM_THROTTLE_MS = 1_100
/** markdown 上限 20480 字节，按中文 3 字节/字留余量 */
export const MAX_MESSAGE = 6_000

/** errcode≠0：服务端明确拒绝，可安全告知 / 不改内容重试 */
export class WecomApiError extends Error {
  constructor(message, errcode) {
    super(message)
    this.name = 'WecomApiError'
    this.errcode = errcode
  }
}

/** 结果不明（超时 / 断连）：禁止自动重发，宁可漏发不双发 */
export class WecomUncertainError extends Error {
  constructor(message) {
    super(message)
    this.name = 'WecomUncertainError'
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function createWecomClient(options) {
  const {
    botId,
    secret,
    log = () => {},
    wsUrl = WS_URL,
    heartbeatMs = HEARTBEAT_MS,
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
  } = options

  let ws
  let connected = false
  /** 被新连接踢掉 —— 置位后禁自动重连，防互踢乒乓 */
  let kicked = false
  let stopped = false
  let heartbeatTimer
  let reconnectTimer
  let reconnectDelay = 2_000
  let reqSeq = 0
  const inflight = new Map()     // reqId → { resolve, reject, timer }
  const msgListeners = []
  const eventListeners = []
  const stateListeners = []

  const newReqId = (prefix) => `${prefix}_${Date.now()}_${++reqSeq}`

  function setState(patch) {
    for (const fn of stateListeners) {
      try { fn(patch) } catch {}
    }
  }

  function startHeartbeat() {
    stopHeartbeat()
    heartbeatTimer = setInterval(() => {
      if (!connected) return
      try { ws?.send(JSON.stringify({ cmd: 'ping', headers: { req_id: newReqId('ping') } })) } catch {}
    }, heartbeatMs)
    heartbeatTimer.unref?.()
  }
  function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = undefined }
  }

  function clearInflight(reason) {
    for (const [, waiter] of inflight) {
      clearTimeout(waiter.timer)
      // 在途请求随连接拆除结果不明 —— 按 uncertain 终结，不伪装成确定性失败
      waiter.reject(new WecomUncertainError(reason))
    }
    inflight.clear()
  }

  /** 发一帧并等响应（req_id 关联） */
  function request(frame, prefix, timeoutMs = requestTimeoutMs) {
    return new Promise((resolve, reject) => {
      // 注意：不能判 connected —— 订阅帧本身就是在 connected 置 true 之前发的。
      // 这里只看 socket 是否处于 OPEN。
      const OPEN = WsLib?.OPEN ?? 1
      if (!ws || ws.readyState !== OPEN) {
        reject(new WecomUncertainError('长连接未就绪'))
        return
      }
      const reqId = frame.headers?.req_id || newReqId(prefix)
      frame.headers = { ...(frame.headers || {}), req_id: reqId }
      const timer = setTimeout(() => {
        inflight.delete(reqId)
        reject(new WecomUncertainError(`请求超时（${prefix}）`))
      }, timeoutMs)
      timer.unref?.()
      inflight.set(reqId, { resolve, reject, timer })
      try {
        ws.send(JSON.stringify(frame))
      } catch (error) {
        clearTimeout(timer)
        inflight.delete(reqId)
        reject(new WecomUncertainError(`发送失败：${error.message}`))
      }
    })
  }

  function handleFrame(raw) {
    if (typeof raw !== 'string' || raw === '') return
    let frame
    try { frame = JSON.parse(raw) } catch { log('warn', '收到非法 JSON 帧，忽略'); return }

    const reqId = frame.headers?.req_id

    // 响应帧：无 cmd、带 errcode，按 req_id 关联
    if (frame.cmd === undefined && reqId !== undefined) {
      const waiter = inflight.get(reqId)
      if (waiter) {
        inflight.delete(reqId)
        clearTimeout(waiter.timer)
        const errcode = Number(frame.errcode ?? 0)
        if (errcode === 0) waiter.resolve(frame)
        else waiter.reject(new WecomApiError(frame.errmsg || `errcode ${errcode}`, errcode))
      } else if (reqId.startsWith('ping')) {
        // 心跳回包，忽略
      }
      return
    }

    // 入站消息
    if (frame.cmd === 'aibot_msg_callback') {
      for (const fn of msgListeners) { try { fn(frame) } catch (error) { log('error', `消息处理异常：${error.message}`) } }
      return
    }

    // 事件：enter_chat / template_card_event / feedback_event / disconnected_event
    if (frame.cmd === 'aibot_event_callback') {
      const type = frame.body?.event?.eventtype || frame.body?.eventtype || ''
      if (type === 'disconnected_event') {
        kicked = true
        connected = false
        setState({ connected: false, kicked: true, reason: '被新连接踢下线（同一机器人只能有一个长连接）' })
        log('warn', '被新连接踢下线 —— 已禁用自动重连，避免互踢')
      }
      for (const fn of eventListeners) { try { fn(frame) } catch {} }
      return
    }

    // 未知帧（心跳 ack 等）
    if (frame.cmd) log('debug', `未处理的帧 cmd=${frame.cmd}`)
  }

  function scheduleReconnect() {
    if (stopped || kicked) return
    if (reconnectTimer) return
    const delay = reconnectDelay
    reconnectDelay = Math.min(reconnectDelay * 2, 60_000)
    log('info', `${Math.round(delay / 1000)} 秒后重连`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      connect().catch((error) => log('warn', `重连失败：${error.message}`))
    }, delay)
    reconnectTimer.unref?.()
  }

  async function connect() {
    if (stopped) throw new Error('已停止')
    if (kicked) throw new Error('已被踢下线，请先手动重连')
    if (connected) return

    if (!WsLib) {
      throw new Error('缺少 ws 库（企微长连接必须用 ws，Node 全局 WebSocket 与本服务端握手不兼容）')
    }
    if (!botId || !secret) throw new Error('bot_id / secret 未配置')

    if (ws) { try { ws.removeAllListeners(); ws.close() } catch {} ws = undefined }

    ws = new WsLib(wsUrl)

    await new Promise((resolve, reject) => {
      let settled = false
      const fail = (error) => {
        if (settled) return
        settled = true
        reject(error)
      }
      const succeed = () => {
        if (settled) return
        settled = true
        resolve()
      }

      ws.on('open', () => {
        void (async () => {
          try {
            await request({ cmd: 'aibot_subscribe', headers: {}, body: { bot_id: botId, secret } }, 'sub')
            connected = true
            kicked = false
            reconnectDelay = 2_000
            startHeartbeat()
            setState({ connected: true, kicked: false, reason: '' })
            log('info', '长连接已建立（订阅成功）')
            succeed()
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)))
          }
        })()
      })

      ws.on('error', (error) => {
        if (!settled) fail(new WecomUncertainError(`长连接失败：${error?.message || '未知网络错误'}`))
      })

      ws.on('close', (code) => {
        const wasConnected = connected
        connected = false
        stopHeartbeat()
        clearInflight('长连接已断开')
        setState({ connected: false, kicked, reason: `连接关闭（code ${code}）` })
        if (!settled) fail(new WecomUncertainError(`长连接在订阅完成前关闭（code ${code}）`))
        else if (wasConnected && !stopped && !kicked) {
          log('warn', `长连接断开（code ${code}），准备重连`)
          scheduleReconnect()
        }
      })

      ws.on('message', (data) => handleFrame(data?.toString?.() ?? String(data)))

      setTimeout(() => fail(new WecomUncertainError('连接超时')), requestTimeoutMs).unref?.()
    })
  }

  async function disconnect() {
    stopped = true
    stopHeartbeat()
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = undefined }
    connected = false
    clearInflight('主动断开')
    try { ws?.removeAllListeners(); ws?.close() } catch {}
    ws = undefined
    setState({ connected: false, kicked: false, reason: '已主动断开' })
  }

  /** 重新开始（用户点「重连」） */
  async function restart() {
    await disconnect()
    stopped = false
    kicked = false
    reconnectDelay = 2_000
    return connect()
  }

  /**
   * 被动回复：必须带原回调的 req_id。
   * @param {string} reqId 原入站帧的 headers.req_id
   * @param {object} body { msgtype, markdown|text|... }
   */
  async function respond(reqId, body) {
    return request({ cmd: 'aibot_respond_msg', headers: { req_id: reqId }, body }, 'resp')
  }

  /**
   * 流式回复。
   * 企微要求：首次发送起 10 分钟内必须 finish，否则那条消息会卡在「正在输入」。
   * @param {string} reqId 原回调 req_id
   * @param {object} opts { onWarn }
   */
  function createStream(reqId, opts = {}) {
    const id = randomBytes(8).toString('hex')
    const startedAt = Date.now()
    let lastSentAt = 0
    let lastText = ''
    let finished = false
    let aborted = false
    const HARD_LIMIT = 10 * 60 * 1000
    const SOFT_LIMIT = 8 * 60 * 1000

    const send = async (markdown, finish) => {
      const body = {
        msgtype: 'stream',
        stream: { id, ...(finish ? { finish: true } : {}), content: markdown },
      }
      return request({ cmd: 'aibot_respond_msg', headers: { req_id: reqId }, body }, 'stream')
    }

    return {
      get elapsed() { return Date.now() - startedAt },
      get finished() { return finished },
      async update(markdown) {
        if (finished || aborted) return
        const now = Date.now()
        if (now - lastSentAt < STREAM_THROTTLE_MS) return
        // 到软上限先 finish 一段，避免撞 10 分钟硬墙
        if (now - startedAt > SOFT_LIMIT) {
          await this.finish(markdown + '\n\n（还在弄，弄完再跟你说）')
          return
        }
        lastSentAt = now
        lastText = markdown
        try {
          await send(markdown, false)
        } catch (error) {
          log('debug', `流式更新失败：${error.message}`)
        }
      },
      async finish(markdown) {
        if (finished) return { uncertain: false }
        finished = true
        const text = markdown || lastText || '（没有内容）'
        try {
          await send(text, true)
          return { uncertain: false }
        } catch (error) {
          if (error instanceof WecomApiError) throw error
          return { uncertain: true, error }
        }
      },
      abort() { aborted = true },
    }
  }

  /**
   * 主动推送。前提：该会话已被用户激活（用户先给机器人发过消息）。
   * 限速每会话 30 条/分钟、1000 条/小时。
   * @param {string} chatId 单聊传 userid，群聊传群 chatid
   * @param {1|2} chatType 1 = 单聊，2 = 群聊
   */
  async function send(chatId, chatType, body) {
    return request({
      cmd: 'aibot_send_msg',
      headers: { req_id: newReqId('send') },
      body: { chatid: chatId, chat_type: chatType, ...body },
    }, 'send')
  }

  async function sendText(chatId, chatType, text) {
    return send(chatId, chatType, { msgtype: 'markdown', markdown: { content: text } })
  }

  return {
    connect,
    disconnect,
    restart,
    respond,
    createStream,
    send,
    sendText,
    onMessage(fn) { msgListeners.push(fn); return () => { const i = msgListeners.indexOf(fn); if (i >= 0) msgListeners.splice(i, 1) } },
    onEvent(fn) { eventListeners.push(fn); return () => { const i = eventListeners.indexOf(fn); if (i >= 0) eventListeners.splice(i, 1) } },
    onState(fn) { stateListeners.push(fn); return () => { const i = stateListeners.indexOf(fn); if (i >= 0) stateListeners.splice(i, 1) } },
    get connected() { return connected },
    get kicked() { return kicked },
  }
}
