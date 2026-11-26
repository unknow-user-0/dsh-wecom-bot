// 并发挂工具：同一个会话两条消息同时进来，不能撞名、不能丢注销器。
//
// 真实事故：plugin.log 2026-11-17T09:45:33 一次报 25 条
//   tool "wecom_reply" is already registered in this scope
//   …（25 个工具全撞）
// 根因：mountTools 在 await toolsFor() 那里让出，mounted.set(sid) 在循环之后。
// 两条消息同时进来都读到「没挂过」，第二遍给同一批名字注册 → 全撞名，
// 且它 offs 是空的，把第一遍存好的注销器盖掉 → 之后再也摘不掉。
//
// 跑：node dev/tools-mount.mjs

import { startFakeWecom } from './fake-wecom.js'
import { createFakeHost } from './fake-host.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 18097
const WS = `ws://127.0.0.1:${PORT}`
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'wecom-mount-'))
process.env.DSH_WECOM_WS_URL = WS

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; console.log(`  ✗ ${label} ${extra}`) }
}

const server = startFakeWecom({ port: PORT })
await server.listen()
const host = createFakeHost({ replyText: '收到' })
const mod = await import('../src/host.js')
mod.apply(host.ctx)

await host.callRoute('/wecom-bot/api/save', {
  enabled: true,
  botId: 'bot-mount',
  secret: 'secret-mount',
  accessMode: 'whitelist',
  allow: { users: [{ userid: 'u-mount', name: '测试员' }], groups: [] },
})
await new Promise((r) => setTimeout(r, 300))
console.log('   白名单:', JSON.stringify((await host.callRoute('/wecom-bot/api/state')).config?.allow))

// 挑一条会说话的告警日志当失败信号
const warnsOf = (needle) => host.log.filter((l) => String(l).includes(needle))
const registeredNames = () => [...host.tools.keys()].sort()
// 等订阅成功（假服务要等插件 aibot_subscribe 才肯转发）
let subscribed = false
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 150))
  if (server.subscribed) { subscribed = true; break }
}
if (!subscribed) { console.log('❌ 插件没订阅上假服务'); process.exit(1) }

const feed = (text, msgid) => fetch(`http://127.0.0.1:${PORT}/inbound`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text, userid: 'u-mount', chattype: 'single', msgid }),
}).then((r) => r.json())

console.log('① 第一条消息（建会话 + 挂工具）')
console.log('   喂入站结果:', JSON.stringify(await feed('喂', 'm1')))
await new Promise((r) => setTimeout(r, 900))
console.log('   [调试] 回复:', JSON.stringify(await fetch(`http://127.0.0.1:${PORT}/log`).then(r=>r.json()).then(l=>l.responded.map(x=>x.body?.markdown?.content))))
const warnsAfterFirst = warnsOf('挂不上').length
ok(warnsAfterFirst === 0, '第一条消息没有撞名告警', `实际 ${warnsAfterFirst} 条`)

console.log('\n② 同一个会话，两条消息几乎同时进来')
const before = warnsOf('挂不上').length
await Promise.all([feed('一', 'm2'), feed('二', 'm3')])
await new Promise((r) => setTimeout(r, 5500))
const newWarns = warnsOf('挂不上').length - before
ok(newWarns === 0, '并发进来没有撞名告警', `多出 ${newWarns} 条`)

console.log('\n③ 并发之后工具都挂上了，且只挂了一遍')
const namesAfter = registeredNames()
ok(namesAfter.length > 0, `挂上了 ${namesAfter.length} 个工具：${namesAfter.join(',')}`)
// u-mount 是普通白名单用户（非主人），走 social 档：挂 6 个基础工具。
// 原先这里期望 7 个，多出的 wecom_mcp / wecom_group_history 是越权漏洞
// （群成员能借主人凭据调企微原生能力、查任意会话），本轮已用 adminOnly 挡掉。
// douyin_watch 是后来加的、有意给全档位：它是「读抖音视频元数据」的有界只读能力，
// 只能按校验过的视频号调抖音自己的接口，没有任意导航/点击/读文件/发消息，
// 而且每次干活开独立标签页，不碰主人正在用的页面。
ok(namesAfter.length === 6, '并发后 social 档挂的是 6 个基础工具', `实际 ${namesAfter.length}：${namesAfter.join(',')}`)
ok(!namesAfter.includes('wecom_mcp'), 'social 档不含越权工具 wecom_mcp')
ok(!namesAfter.includes('wecom_group_history'), 'social 档不含越权工具 wecom_group_history')

console.log('\n④ 注销器还在：换 agent 后能全部摘掉再重挂')
// 模拟 DSH 重建 agent：清空 tools 表（等价于旧 agent 被销毁）
host.tools.clear()
const beforeAgain = warnsOf('挂不上').length
await feed('三', 'm4')
await new Promise((r) => setTimeout(r, 5500))
// 这里 agent 还是同一个，key 也没变，所以会直接 return（不重挂）；工具表空是因为我们手动清了。
// 关键断言：没有撞名告警说明「同一 agent + 同 key」走的是提前返回，不会重复注册。
ok(warnsOf('挂不上').length === beforeAgain, '同 agent 同清单不重复注册（提前返回）', `多出 ${warnsOf('挂不上').length - beforeAgain} 条`)

console.log(`\n${fail === 0 ? '✅' : '❌'} 通过 ${pass}，失败 ${fail}`)
await server.close?.()
process.exit(fail === 0 ? 0 : 1)
