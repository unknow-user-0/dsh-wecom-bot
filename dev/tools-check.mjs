// 工具集自检：不连 DSH、不连企微，只把 buildTools 造出来看清单与 schema。
// 跑：node dev/tools-check.mjs
// 数据目录隔离：必须在任何插件模块被 import 之前设置。
// ESM 的 import 会被提升，所以这里改成「先用一段纯 node 内建的同步代码设好环境变量，
// 再用 dynamic import 加载插件」—— 顺序才靠得住。
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'wecom-test-'))

const { buildTools } = await import('../src/tools/wecom.js')

const t = buildTools({
  getConfig: () => ({ features: { memory: true, mcpSendAsMe: false, sendFileToUser: 'admin' } }),
  getClient: () => null,
  mcpFor: async () => null,
  memory: {},
  chatOfSession: () => null,
  recentMessages: () => [],
  activity: () => {},
  imagegen: { enabled: () => false, generate: async () => {} },
  lastText: () => '',
  log: { info() {}, debug() {}, warn() {} },
})

let bad = 0
for (const x of t) {
  const ok = x.parameters && x.parameters.type === 'object' && x.description && typeof x.execute === 'function'
  if (!ok) bad++
  console.log(
    (ok ? '✓' : '✗'),
    x.name.padEnd(20),
    '参数:', (Object.keys(x.parameters.properties).join(',') || '（无）').padEnd(40),
    '必填:', x.parameters.required.join(',') || '（无）',
  )
}
console.log(`\n共 ${t.length} 个工具，${bad ? `${bad} 个不合格` : '全部合格'}`)
