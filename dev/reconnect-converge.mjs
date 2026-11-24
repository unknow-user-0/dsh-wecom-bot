// 重连必须一直接力，直到连上为止。
//
// 立的这条防线来自一次真实的静默死亡：
//   scheduleReconnect 的 setTimeout 里 connect().catch(只打日志)，
//   失败后没有 scheduleReconnect() —— 整个重连链走完第一次就断了。
//   老大昨晚 02:49 断线，2 秒后重连遇到 ECONNREFUSED，之后十小时没再试过一次。
//   面板就安静地显示「断开」，看起来像机器人自己挂了。
//
// 这个文件名里的「converge」是这个测试的全部意义：不是「试过」，是「会一直试到连上」。

import { createWecomClient } from '../src/wecom/client.js'

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`✅ ${name}`) }
  else { fail += 1; console.log(`❌ ${name}${extra ? ` → ${extra}` : ''}`) }
}

// 假 WebSocket：可控地失败 / 成功。
// 第一次和第二次 connect 直接报错（模拟开机时网络还没起来），
// 第三次才走到 open，这样能同时验证「失败续链」和「连上后停手」。
function makeFakeWs(state) {
  return class FakeWs {
    constructor() {
      state.attempts += 1
      this.readyState = 1   // OPEN：request() 会检查这个，写 0 就永远发不出去
      const n = state.attempts
      setTimeout(() => {
        if (n <= state.failTimes) {
          this.emitError(new Error('connect ECONNREFUSED 120.233.240.159:443'))
          this.emitClose(1006)
        } else {
          this.emitOpen()
        }
      }, 0)
    }
    on(ev, fn) { (this._h ||= {})[ev] = fn; return this }
    emitOpen() { this._h?.open?.() }
    emitError(e) { this._h?.error?.(e) }
    emitClose(c) { this._h?.close?.(c) }
    removeAllListeners() { this._h = {}; return this }
    close() { setTimeout(() => this.emitClose(1000), 0) }
    send(raw) {
      // aibot_subscribe 要回一个成功帧给 connect() 里的 request()
      const frame = JSON.parse(raw)
      if (frame.cmd === 'aibot_subscribe') {
        setTimeout(() => {
          this._h?.message?.(JSON.stringify({ headers: { req_id: frame.headers?.req_id || 'sub' }, errcode: 0, errmsg: 'ok' }))
        }, 0)
      }
    }
  }
}

async function main() {
  console.log('① 重连失败之后必须继续排下一轮')

  const state = { attempts: 0, failTimes: 2 }
  const logs = []
  const client = createWecomClient({
    wsUrl: 'wss://example.invalid',
    botId: 'bot',
    secret: 'sec',
    log: (lv, msg) => logs.push(`${lv}:${msg}`),
    wsLib: makeFakeWs(state),
    requestTimeoutMs: 300,
  })

  // 起连接：这一次会失败（第 1 次）
  await client.connect().catch(() => {})
  ok('第一次连接失败是预期的', state.attempts >= 1)

  // 等重连链跑起来：第 2 次失败 → 必须自己再排第 3 次 → 第 3 次成功
  const deadline = Date.now() + 8000
  while (Date.now() < deadline && !client.connected) {
    await new Promise((r) => setTimeout(r, 50))
  }

  ok('重连链没断：尝试次数 ≥ 3', state.attempts >= 3, `实际 ${state.attempts} 次`)
  ok('最终连上了（一直试到成功）', client.connected === true)
  ok('失败过就记了 warn（不是静默）', logs.some((l) => l.startsWith('warn:') && /重连失败/.test(l)))
  ok('连上之后不再继续尝试', state.attempts === 3, `实际 ${state.attempts} 次`)

  await client.disconnect?.()

  console.log(`\n${fail === 0 ? '✅' : '❌'} 重连会一直接力（${pass} 项通过${fail ? `，${fail} 项失败` : ''}）`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('测试自身挂了：', error)
  process.exit(1)
})
