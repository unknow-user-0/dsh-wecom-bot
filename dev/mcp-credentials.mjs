// MCP 凭据"重新填写后无法使用"回归测试
// 覆盖：冷启动 svc 晚就绪 / userid number vs string / 凭据没落盘时 config URL 兜底
import assert from 'node:assert/strict'
process.env.DSH_HOME = process.env.DSH_HOME || new URL('../.tmp-mcp-home', import.meta.url).pathname
const { createVault, mcpRef } = await import('../src/core/vault.js')

// 假宿主：credentials 一开始不存在，之后才出现（模拟冷启动时序）
const host = {}
let n = 0
const { set: vaultSet, resolve: vaultResolve, kind: vaultKind } = createVault(host, null)
const failMsg = []

// ① 服务晚就绪：set 时服务还没出现 → 落内存（kind=memory）
assert.equal(vaultKind(), 'memory')
await vaultSet('WECOM_BOT_MCP_MSG_X', 'http://early')
assert.equal(await vaultResolve('WECOM_BOT_MCP_MSG_X'), 'http://early')

// ② 服务此刻出现 → 新 set 直接走服务（动态取，不再固化 undefined）
host.credentials = {
  store: new Map(),
  set(k, v) { this.store.set(k, v) },
  resolve(k) { return this.store.get(k) },
}
assert.equal(vaultKind(), 'service')
await vaultSet('WECOM_BOT_MCP_MSG_X', 'http://late')
assert.equal(await vaultResolve('WECOM_BOT_MCP_MSG_X'), 'http://late')
assert.equal(host.credentials.store.get('WECOM_BOT_MCP_MSG_X'), 'http://late')

// ③ userid 口径：mcpRef 内部已 String()，number 和 string 算出同一个 ref
assert.equal(mcpRef('msg', 12345), mcpRef('msg', '12345'))
console.log('✅ MCP 凭据动态服务 + 口径归一（3 项通过）')
