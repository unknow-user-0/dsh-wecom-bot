// 端到端联调：假企微服务 + 假宿主 + 真插件，把「收消息 → 建会话 → 跑一轮 → 回消息」整条路跑通。
//
// 跑法：node dev/e2e.mjs
//
// 它做这些事：
//   1. 起假企微服务（ws://127.0.0.1:PORT）
//   2. 让插件的长连接指向它（DSH_WECOM_WS_URL），填假 bot_id/secret 并打开开关
//   3. 通过假服务 POST /inbound 喂一条私聊消息进来
//   4. 等插件把回复发回假服务（aibot_respond_msg）
//   5. 打印这一路发生了什么，然后断言关键点

import { startFakeWecom } from './fake-wecom.js'
import { createFakeHost } from './fake-host.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 18099
const WS = `ws://127.0.0.1:${PORT}`

// 让插件的数据落到临时目录，别污染真实配置
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'wecom-e2e-'))
process.env.DSH_WECOM_WS_URL = WS

const server = startFakeWecom({ port: PORT })
await server.listen()
console.log(`① 假企微服务起来了：${WS}`)

const host = createFakeHost({ replyText: '嗨，我是测试机器人' })
const mod = await import('../src/host.js')
const dispose = mod.apply(host.ctx)
console.log('② 插件 apply 完成')

// 填配置：假凭据 + 打开开关 + 白名单放行这个人
const saved = await host.callRoute('/wecom-bot/api/save', {
  enabled: true,
  dryRun: false,
  botId: 'bot-e2e',
  secret: 'secret-e2e',
  accessMode: 'whitelist',
  allow: { users: [{ userid: 'u-e2e', name: '测试员' }], groups: [] },
})
console.log('③ 存配置：', JSON.stringify(saved).slice(0, 200))

// 等订阅成功
let subscribed = false
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 150))
  if (server.subscribed) { subscribed = true; break }
}
console.log('④ 订阅成功：', subscribed, server.subscribed)

const state = await host.callRoute('/wecom-bot/api/state')
console.log('⑤ 连接状态：', JSON.stringify(state.connState))

// 喂一条私聊消息
const feed = await fetch(`http://127.0.0.1:${PORT}/inbound`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: '在吗', userid: 'u-e2e', chattype: 'single' }),
}).then((r) => r.json())
console.log('⑥ 喂入站消息：', JSON.stringify(feed))

// 等回复（第一条可能是合并窗口发的占位「emmm...」，要等真正的那条）
let got = null
let placeholder = null
for (let i = 0; i < 80; i++) {
  await new Promise((r) => setTimeout(r, 200))
  const log = await fetch(`http://127.0.0.1:${PORT}/log`).then((r) => r.json())
  for (const row of log.responded) {
    const text = row?.body?.markdown?.content || ''
    if (text === 'emmm...') { placeholder = row; continue }
    if (text) { got = [row]; break }
  }
  if (got) break
}
console.log('⑦ 回复：', JSON.stringify(got), placeholder ? '（有过占位）' : '')

const log = await fetch(`http://127.0.0.1:${PORT}/log`).then((r) => r.json())
console.log('⑧ 服务端记录：responded=' + log.responded.length + ' sent=' + log.sent.length + ' failed=' + log.failed.length)

// 断言
const problems = []
if (!subscribed) problems.push('没订阅上')
if (!got?.length) problems.push('没收到回复')
else {
  const text = got[0]?.body?.markdown?.content || ''
  if (!text.includes('测试机器人')) problems.push('回复内容不对：' + text)
}
if (problems.length) {
  console.log('\n❌ 失败：')
  for (const p of problems) console.log('   - ' + p)
  console.log('\n插件日志：')
  for (const l of host.log) console.log('   ' + l)
} else {
  console.log('\n✅ 整条链路通了：收消息 → 建会话 → 跑一轮 → 回复')
}

try { dispose?.() } catch {}
await server.close()
process.exit(problems.length ? 1 : 0)
