// 真机探针：用真企微机器人凭据跑真正的长连接，验证「收消息 → 跑一轮 → 回复」。
// 不装进 DSH，不依赖面板 —— 用假宿主把插件当普通模块跑起来（模型那一轮是假的，
// 会固定回 fake-host 里那句 replyText，所以看到它回复就说明协议全链路通了）。
//
// 跑法（凭据走环境变量，不落盘）：
//   DSH_TEST_BOTID=... DSH_TEST_SECRET=... node dev/real-probe.mjs
//
// 跑起来后：在企微里给机器人发条私信，或在群里 @ 它。
// 按 Ctrl+C 退出。

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeHost } from './fake-host.js'

const BOT_ID = process.env.DSH_TEST_BOTID || ''
const SECRET = process.env.DSH_TEST_SECRET || ''
if (!BOT_ID || !SECRET) {
  console.error('缺凭据：请设 DSH_TEST_BOTID 与 DSH_TEST_SECRET')
  process.exit(1)
}

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'wecom-real-'))
delete process.env.DSH_WECOM_WS_URL // 用真的 wss://

const host = createFakeHost({ replyText: '链路通了，我是测试回显。' })
const plugin = await import('../src/host.js')
await plugin.apply(host.ctx)

const saved = await host.callRoute('/wecom-bot/api/connect', { botId: BOT_ID, secret: SECRET })
console.log('connect:', JSON.stringify(saved))

let tries = 0
while (tries++ < 60) {
  await new Promise((r) => setTimeout(r, 500))
  const st = await host.callRoute('/wecom-bot/api/state')
  if (st?.connected) {
    console.log('✅ 真机长连接已就绪：', JSON.stringify(st.connState))
    break
  }
  if (tries === 60) {
    console.log('❌ 30 秒没连上，日志：')
    const logs = await host.callRoute('/wecom-bot/api/logs', { limit: 40 })
    for (const l of logs?.rows || []) console.log('  ', l.level, l.tag || '', l.text)
    process.exit(1)
  }
}

console.log('\n🎧 等消息中……现在去企微里给机器人发条私信，或在一个群里 @ 它。\n')

// 盯着假宿主里记下的东西：收到几条 → 回复了几条
let seen = 0
setInterval(async () => {
  const sess = [...host.sessions.values()].filter((s) => s.prompts.length)
  const total = sess.reduce((n, s) => n + s.prompts.length, 0)
  if (total <= seen) return
  seen = total
  const st = await host.callRoute('/wecom-bot/api/state')
  const act = await host.callRoute('/wecom-bot/api/activity')
  console.log(`── 第 ${total} 条 ──────────────────────────`)
  const last = sess[sess.length - 1]
  const msg = last.prompts[last.prompts.length - 1]
  const txt = (msg?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
  console.log('  进模型的文本：' + JSON.stringify(txt).slice(0, 400))
  console.log('  附件块：' + ((msg?.content || []).length - 1))
  console.log('  会话标题：' + (last.title || '(未命名)') + '  会话ID：' + last.id)
  console.log('  已回给企微：' + (act?.rows || []).filter((r) => r.kind === 'out').length + ' 条')
  console.log('  连接：' + (st.connected ? '正常' : '断了') + '\n')
}, 700)

process.on('SIGINT', async () => {
  console.log('\n收工。最后 20 条日志：')
  const logs = await host.callRoute('/wecom-bot/api/logs', { limit: 20 })
  for (const l of logs?.rows || []) console.log('  ', l.level, l.tag || '', l.text)
  process.exit(0)
})
