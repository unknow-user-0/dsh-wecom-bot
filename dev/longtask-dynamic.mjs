// 长任务开关动态挂/摘：改开关不再重建会话，jobs/schedule 工具随开关藏/露。
//
// 机制：jobs/schedule 常挂在 wecom-owner preset 里（祖先 scope），
// 关掉长任务时 host.js 用 agent.ctx.tools.restrict({deny}) 在这一个 agent 的
// scope 把它们藏掉，打开时解除 restriction。preset 固定为 wecom-owner，
// 所以改开关不会换 preset、不会重建会话、不断上下文。
//
// 跑：node dev/longtask-dynamic.mjs

import { startFakeWecom } from './fake-wecom.js'
import { createFakeHost } from './fake-host.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 18131
const WS = `ws://127.0.0.1:${PORT}`
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'wecom-longtask-'))
process.env.DSH_WECOM_WS_URL = WS

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; console.log(`  ✗ ${label} ${extra}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const server = startFakeWecom({ port: PORT })
await server.listen()
const host = createFakeHost({ replyText: '收到' })
const mod = await import('../src/host.js')
const dispose = mod.apply(host.ctx)

const OWNER = 'u_boss'
const saveCfg = (longTasks) => host.callRoute('/wecom-bot/api/save', {
  enabled: true, botId: 'bot-long', secret: 'secret-long',
  accessMode: 'whitelist', longTasks,
  allow: { users: [{ userid: OWNER, name: '老大', role: 'owner' }], groups: [] },
})
const sessionsNow = async () => (await host.callRoute('/wecom-bot/api/sessions')).rows
const waitSessions = async () => {
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    const s = await sessionsNow()
    if (s.length) return s
  }
  return []
}
const denyCalls = () => host.restricts.filter((r) => Array.isArray(r.filter?.deny) && r.filter.deny.includes('job_list'))
const waitFor = async (pred, ms = 12000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred()) return true
    await sleep(200)
  }
  return false
}

await saveCfg(false)
// /save 明确忽略 admins，必须走 /admin/add 设第一个 owner
await host.callRoute('/wecom-bot/api/admin/add', { userid: OWNER, name: '老大', role: 'owner' })
for (let i = 0; i < 40; i++) { await sleep(150); if (server.subscribed) break }

const feed = (text, msgid) => fetch(`http://127.0.0.1:${PORT}/inbound`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text, userid: OWNER, chattype: 'single', msgid }),
}).then((r) => r.json())

console.log('① 长任务关闭：主人私聊首条消息')
await feed('在吗', 'lt1')
let sessions = await waitSessions()
ok(sessions.length === 1, '建了 1 个会话', `实际 ${sessions.length}`)
const sid1 = sessions[0]?.sessionId
ok(sessions[0]?.preset === 'wecom-owner', 'preset 是 wecom-owner（不再有 -long 变体）', sessions[0]?.preset)
ok(denyCalls().length >= 1, '长任务关闭时调用了 restrict({deny}) 藏工具', `实际 ${denyCalls().length} 次`)
if (denyCalls().length) {
  const set = new Set(denyCalls()[0].filter.deny)
  ok(['job_output', 'job_list', 'job_kill', 'schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit'].every((n) => set.has(n)), 'deny 覆盖全部 7 个 jobs/schedule 工具', [...set].join(','))
}

console.log('\n② 打开长任务开关并再发一条')
await saveCfg(true)
await feed('开长任务', 'lt2')
// 旧 deny 解除要等合并窗口 flush→重新 mountTools，轮询等而不是猜固定时长
await waitFor(() => denyCalls()[0]?.active === false)
sessions = await sessionsNow()
ok(sessions.length === 1, '还是同一个会话，没重建', `实际 ${sessions.length}`)
ok(sessions[0]?.sessionId === sid1, 'sessionId 不变', `${sid1} vs ${sessions[0]?.sessionId}`)
ok(denyCalls()[0]?.active === false, '旧的 deny restriction 已解除', `active=${denyCalls()[0]?.active}`)

console.log('\n③ 再关掉，验证又藏回去')
await saveCfg(false)
await feed('关长任务', 'lt3')
await waitFor(() => denyCalls().length >= 2)
sessions = await sessionsNow()
ok(sessions.length === 1 && sessions[0]?.sessionId === sid1, '依旧同一个会话', `实际 ${sessions.length}`)
ok(denyCalls().length >= 2, '又调用了一次 restrict deny', `实际 ${denyCalls().length} 次`)

try { dispose?.() } catch {}
await server.close()
console.log(`\n${fail ? '❌' : '✅'} 长任务动态挂/摘：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
