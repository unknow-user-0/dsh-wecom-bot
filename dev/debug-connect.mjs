// 单独调试长连接（不经过面板配置）：
//   node dev/debug-connect.mjs
import { startFakeWecom } from './fake-wecom.js'
import { createFakeHost } from './fake-host.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'wc-dbg-'))
process.env.DSH_WECOM_WS_URL = 'ws://127.0.0.1:18098'

const s = startFakeWecom({ port: 18098 })
await s.listen()
const host = createFakeHost({})
const mod = await import('../src/host.js')
mod.apply(host.ctx)

const r = await host.callRoute('/wecom-bot/api/connect', { botId: 'b1', secret: 's1' })
console.log('connect:', JSON.stringify(r))
for (let i = 0; i < 30; i++) {
  await new Promise((res) => setTimeout(res, 200))
  if (s.subscribed) break
}
console.log('subscribed:', Boolean(s.subscribed))
console.log('state:', JSON.stringify((await host.callRoute('/wecom-bot/api/state')).connState))
const logs = (await host.callRoute('/wecom-bot/api/logs')).rows.slice(-10)
console.log('logs:')
for (const l of logs) console.log('  ', JSON.stringify(l).slice(0, 220))
await s.close()
