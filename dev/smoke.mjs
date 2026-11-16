// 冒烟测试：用假宿主跑 apply()，喂一条假企微消息，看整条链路走到哪
//
// 跑法：node dev/smoke.mjs
// 它不会碰真企微（没填 bot_id/secret，长连接起不来，dryRun 默认开）。

import { createFakeHost } from './fake-host.js'

const host = createFakeHost({ replyText: '嗨，我在' })
process.env.DSH_HOME = process.env.DSH_HOME || 'C:\\Users\\Haha\\.dsh'

const mod = await import('../src/host.js')
console.log('插件导出：', Object.keys(mod))
console.log('inject：', mod.inject)

const dispose = mod.apply(host.ctx)
console.log('apply 之后：')
console.log('  路由数：', host.routes.size)
console.log('  提示词变量：', [...host.variables.keys()].join(', '))
console.log('  工具：', [...host.tools.keys()].join(', '))

const state = await host.callRoute('/wecom-bot/api/state')
console.log('state：', JSON.stringify(state))

// 造一条入站帧，直接喂给长连接的 listener（没连上时不走这里，手动触发）
const listeners = host.listeners
console.log('session/event 监听数：', (listeners.get('on:session/event') || []).length)

if (typeof dispose === 'function') dispose()
console.log('OK')
