// 假企微长连接服务：照企微智能机器人协议的帧格式造一个，本机联调用。
//
// 用法：
//   node dev/fake-wecom.js                  # 起在 127.0.0.1:18080
//   node dev/fake-wecom.js --port 18080
//
// 然后在另一个终端把插件指向它：
//   DSH_WECOM_WS_URL=ws://127.0.0.1:18080 node dev/e2e.mjs
//
// 支持的帧：
//   收 aibot_subscribe { bot_id, secret }        → 回 { errcode: 0, errmsg: 'ok' }
//   收 aibot_respond_msg { msgtype, markdown }  → 回 { errcode: 0 }，并把内容记下来
//   收 aibot_send_msg { chatid, chat_type, ... } → 回 { errcode: 0 }，记下来
//   发 aibot_msg_callback                        → 模拟用户发消息（由 HTTP POST /inbound 触发）
//   发 aibot_event_callback                      → 模拟 enter_chat 等事件
//   发 ping 心跳                                  → 回 pong
//
// 只监听 127.0.0.1，不对外。

import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { tryRequire } from '../src/core/deps.js'

const wsLib = tryRequire('ws')
if (!wsLib) {
  console.error('缺 ws 依赖，跑不起来。在插件目录执行：pnpm add ws')
  process.exit(1)
}
const { WebSocketServer } = wsLib

const args = process.argv.slice(2)
const portArg = args.indexOf('--port')
const PORT = portArg >= 0 ? Number(args[portArg + 1]) : 18080

/** 这个会话收到的所有东西（给 e2e 断言用） */
const log = { sent: [], responded: [], failed: [] }
let socket = null
let subscribed = null

export function startFakeWecom({ port = PORT } = {}) {
  const http = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`)
    let body = ''
    for await (const chunk of req) body += chunk
    let json = {}
    try { json = body ? JSON.parse(body) : {} } catch {}

    const reply = (code, obj) => {
      res.statusCode = code
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(obj))
    }

    if (url.pathname === '/inbound') {
      if (!socket || !subscribed) return reply(503, { ok: false, message: '插件还没订阅' })
      const frame = {
        cmd: 'aibot_msg_callback',
        headers: { req_id: json.req_id || 'req-' + Date.now().toString(36) },
        body: {
          msgid: json.msgid || 'msg-' + Math.random().toString(36).slice(2, 10),
          aibotid: subscribed.bot_id,
          chattype: json.chattype || 'single',
          from: { userid: json.userid || 'user-test' },
          msgtype: json.msgtype || 'text',
          text: { content: json.text ?? '你好' },
          ...(json.chatid ? { chatid: json.chatid } : {}),
          ...(json.image ? { image: json.image } : {}),
          ...(json.file ? { file: json.file } : {}),
        },
      }
      socket.send(JSON.stringify(frame))
      return reply(200, { ok: true, sent: frame.headers.req_id })
    }
    if (url.pathname === '/event') {
      if (!socket || !subscribed) return reply(503, { ok: false, message: '插件还没订阅' })
      const frame = {
        cmd: 'aibot_event_callback',
        headers: { req_id: 'ev-' + Date.now().toString(36) },
        body: { eventtype: json.eventtype || 'enter_chat', from: { userid: json.userid || 'user-test' } },
      }
      socket.send(JSON.stringify(frame))
      return reply(200, { ok: true })
    }
    if (url.pathname === '/log') return reply(200, log)
    if (url.pathname === '/reset') {
      log.sent.length = 0; log.responded.length = 0; log.failed.length = 0
      return reply(200, { ok: true })
    }
    if (url.pathname === '/kick') {
      if (socket) {
        socket.send(JSON.stringify({ cmd: 'aibot_event_callback', headers: { req_id: 'k1' }, body: { eventtype: 'disconnected_event' } }))
      }
      return reply(200, { ok: true })
    }
    if (url.pathname === '/close') {
      if (socket) socket.close()
      return reply(200, { ok: true })
    }
    return reply(404, { ok: false, message: 'no route ' + url.pathname })
  })

  const wss = new WebSocketServer({ server: http })
  wss.on('connection', (ws) => {
    socket = ws
    ws.on('message', (raw) => {
      let frame
      try { frame = JSON.parse(String(raw)) } catch { return }
      const reqId = frame.headers?.req_id || ''
      const reply = (obj) => {
        try { ws.send(JSON.stringify({ headers: { req_id: reqId }, ...obj })) } catch {}
      }
      if (frame.cmd === 'aibot_subscribe') {
        const { bot_id, secret } = frame.body || {}
        if (!bot_id || !secret) return reply({ errcode: 40001, errmsg: '缺 bot_id/secret' })
        subscribed = { bot_id, secret }
        return reply({ errcode: 0, errmsg: 'ok' })
      }
      if (frame.cmd === 'ping') return reply({ errcode: 0, errmsg: 'pong' })
      if (frame.cmd === 'aibot_respond_msg') {
        log.responded.push({ reqId, body: frame.body })
        return reply({ errcode: 0, errmsg: 'ok' })
      }
      if (frame.cmd === 'aibot_send_msg') {
        log.sent.push({ reqId, body: frame.body })
        return reply({ errcode: 0, errmsg: 'ok' })
      }
      log.failed.push({ reqId, cmd: frame.cmd })
      return reply({ errcode: 40004, errmsg: '未知命令 ' + frame.cmd })
    })
    ws.on('close', () => { if (socket === ws) { socket = null; subscribed = null } })
  })

  return {
    http,
    listen() {
      return new Promise((resolve) => http.listen(port, '127.0.0.1', () => resolve({ port, url: `http://127.0.0.1:${port}` })))
    },
    close() {
      return new Promise((resolve) => {
        try { socket?.close() } catch {}
        try { wss.close() } catch {}
        http.close(() => resolve())
      })
    },
    log,
    get subscribed() { return subscribed },
  }
}

// 直接跑当独立服务用（被 import 时不起）
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (isMain) {
  const s = startFakeWecom()
  const info = await s.listen()
  console.log(`假企微服务已起：${info.url}`)
  console.log(`  ws 地址：ws://127.0.0.1:${info.port}`)
  console.log('  模拟收消息：curl -X POST localhost:' + info.port + '/inbound -d \'{"text":"你好","userid":"u1"}\'')
  console.log('  看发出去的：curl localhost:' + info.port + '/log')
}
