// 陌生群 / 陌生人第一次说话，机器人要回他们的 ID —— 这是加白名单的唯一途径。
//
// 为什么单独一个测试：这条路径不经过模型（被拦就直接回），所以 e2e 那条链路
// （喂消息 → 跑一轮 → 回复）覆盖不到它。而它恰好是最容易被改坏的：
// 一次「统一一下文案」的重构就能把 ID 弄丢，谁也不会发现，直到真有人加不进来。
//
// 跑法：node dev/denied-reply.mjs

import { startFakeWecom } from './fake-wecom.js'
import { createFakeHost } from './fake-host.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 18098
const WS = `ws://127.0.0.1:${PORT}`
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'wecom-denied-'))
process.env.DSH_WECOM_WS_URL = WS

const problems = []
const check = (ok, name, extra = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? '：' + extra : ''}`)
  if (!ok) problems.push(name + (extra ? '：' + extra : ''))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const server = startFakeWecom({ port: PORT })
await server.listen()
const host = createFakeHost({ replyText: '这条不该出现' })
const mod = await import('../src/host.js')
const dispose = mod.apply(host.ctx)

// 白名单模式，名单全空 —— 谁来都是陌生人
await host.callRoute('/wecom-bot/api/save', {
  enabled: true,
  botId: 'bot-denied',
  secret: 'secret-denied',
  accessMode: 'whitelist',
  allow: { users: [], groups: [] },
})

for (let i = 0; i < 40; i++) {
  await sleep(150)
  if (server.subscribed) break
}
check(server.subscribed, '订阅成功')

/** 喂一条消息，等回复出现 */
async function feedAndWait(payload, want, timeoutMs = 6000) {
  // 用的是假服务的 /reset（没有 /log/clear 这个端点）
  await fetch(`http://127.0.0.1:${PORT}/reset`, { method: 'POST' }).catch(() => {})
  await fetch(`http://127.0.0.1:${PORT}/inbound`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(150)
    const log = await fetch(`http://127.0.0.1:${PORT}/log`).then((r) => r.json())
    for (const row of log.responded) {
      const text = row?.body?.markdown?.content || ''
      if (text && want(text)) return text
    }
  }
  return ''
}

// ---- 1. 陌生群：必须回群 ID ----
const GROUP_ID = 'wrfL_TESTGROUPID123abc'
const groupText = await feedAndWait(
  { text: '@海棠 你好', userid: 'wofL_STRANGER456', chattype: 'group', chatid: GROUP_ID },
  (t) => t.includes('群'),
)
check(!!groupText, '陌生群收到回复')
check(groupText.includes(GROUP_ID), '群回复里带群 ID', groupText ? `拿到「${GROUP_ID}」` : '没回复')
check(groupText.includes('wofL_STRANGER456'), '群回复里带发话人 ID')
check(!groupText.includes('这条不该出现'), '被拦时没有跑模型')

// ---- 2. 陌生人私聊：必须回 userid ----
const DM_USER = 'wofL_DMSTRANGER789'
const dmText = await feedAndWait(
  { text: '在吗', userid: DM_USER, chattype: 'single' },
  (t) => t.includes('白名单') || t.includes('ID'),
)
check(!!dmText, '陌生人私聊收到回复')
check(dmText.includes(DM_USER), "私聊回复里带自己的 ID", JSON.stringify(dmText))
check(!dmText.includes('这条不该出现'), '私聊被拦时也没有跑模型')

// ---- 3. 拒绝也要在活动日志里留下来源 ----
const rows = await fetch(`http://127.0.0.1:${PORT}/log`).then((r) => r.json())
check(rows.responded.length > 0, '假企微服务记录到了回复', `${rows.responded.length} 条`)

try { dispose?.() } catch {}
await server.close()

if (problems.length) {
  console.log('\n❌ 失败项：')
  for (const p of problems) console.log('   - ' + p)
  process.exit(1)
}
console.log('\n✅ 陌生人/陌生群的 ID 提示全部正确')
process.exit(0)
