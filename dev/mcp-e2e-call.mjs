// 端到端：从面板配 MCP 地址，到机器人真去调一次 —— 中间任何一环断了都要抓出来。
//
// 为什么单独立一个测试：
//   dev/mcp-config-flow.mjs 只验到 /mcp/test 认得这个服务，验不到「干活」那条路。
//   干活走的是另一条链：工具被调到 → chatOfSession 找到这个会话的 chat
//   → mcpFor(service, chat.userId) → serviceUrlOf → 凭据库 → 真的发一个 tools/call 出去。
//   这中间任何一环（会话映射丢了、userId 口径不对、协议默认发错了……）都会表现成
//   「测一下说通了，但让它干活就说没配」—— 老大报的就是这个。
//
// 做法：起一个本地假 MCP 服务（真 JSON-RPC over HTTP），把地址配进插件，
// 然后直接调 wecom_mcp 工具，看它有没有打到假服务上。
//
// 跑法：node dev/mcp-e2e-call.mjs

import { createFakeHost } from './fake-host.js'
import { startFakeWecom } from './fake-wecom.js'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MPORT = 18095  // 假 MCP 服务
const WPORT = 18096  // 假企微长连接
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'wecom-mcpcall-'))
process.env.DSH_WECOM_WS_URL = `ws://127.0.0.1:${WPORT}`

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; console.log(`  ✗ ${label}${extra ? ` → ${extra}` : ''}`) }
}

// ---------- 假 MCP 服务：真说 JSON-RPC ----------
// 记下每一次 methods 调用，测试靠它判断「工具到底有没有真去请求」。
const calls = []
const mcpServer = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    let body = {}
    try { body = JSON.parse(raw) } catch {}
    const method = body?.method || ''
    calls.push({ method, name: body?.params?.name, headers: req.headers })
    const reply = (result) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body?.id ?? 1, result }))
    }
    const replyErr = (code, message) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body?.id ?? 1, error: { code, message } }))
    }
    if (method === 'initialize') {
      return reply({
        protocolVersion: body?.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-wecom', version: '1.0.0' },
      })
    }
    if (method === 'notifications/initialized') { res.writeHead(202); return res.end() }
    if (method === 'tools/list') {
      return reply({
        tools: [
          { name: 'message_aibot_sessions_list', description: '列出机器人会话', inputSchema: { type: 'object' } },
          { name: 'message_send', description: '发消息', inputSchema: { type: 'object' } },
        ],
      })
    }
    if (method === 'tools/call') {
      const name = body?.params?.name
      if (name === 'message_aibot_sessions_list') {
        return reply({ content: [{ type: 'text', text: '{"sessions":[{"chat_id":"c1"}]}' }] })
      }
      return replyErr(-32602, `未知工具 ${name}`)
    }
    return replyErr(-32601, 'Method not found')
  })
})
await new Promise((r) => mcpServer.listen(MPORT, '127.0.0.1', r))
const MCP_URL = `http://127.0.0.1:${MPORT}/mcp/v2/bot/msg?apikey=TESTKEY`

// ---------- 假企微长连接 ----------
const wecom = startFakeWecom({ port: WPORT })
await wecom.listen()

// ---------- 装插件 ----------
const creds = new Map()
const fakeCredentials = {
  resolve(ref) {
    const v = creds.get(ref)
    return Promise.resolve(v === undefined ? undefined : { value: v, source: 'file' })
  },
  async set(ref, value) {
    if (!value || value.length === 0) throw new Error(`credentials-local: an empty value cannot be stored for "${ref}"; use unset`)
    creds.set(ref, value)
  },
  async unset(ref) { creds.delete(ref) },
}

const host = createFakeHost({ replyText: '收到' })
host.inject('credentials', fakeCredentials)
const mod = await import('../src/host.js?e2e=' + Date.now())
const dispose = mod.apply(host.ctx)

await host.callRoute('/wecom-bot/api/save', {
  enabled: true,
  botId: 'bot-mcpcall',
  secret: 'secret-mcpcall',
  accessMode: 'whitelist',
  allow: { users: [{ userid: 'u-owner', name: '主人' }], groups: [] },
})
// 把这个人提成 owner：wecom_mcp 有第二道闸，只认主人
const cfgPath = join(process.env.DSH_HOME, 'plugins-data', 'wecom-bot', 'config.json')
{
  const { readFileSync, writeFileSync } = await import('node:fs')
  const raw = JSON.parse(readFileSync(cfgPath, 'utf8'))
  raw.admins = [{ userid: 'u-owner', name: '主人', role: 'owner', addedAt: Date.now(), quotaTokens: 0, mcp: {} }]
  writeFileSync(cfgPath, JSON.stringify(raw, null, 2), 'utf8')
  // 插件内存里的 cfg 已经是旧的，重开一次让它重新读
  dispose?.()
}
const mod2 = await import('../src/host.js?e2e2=' + Date.now())
const dispose2 = mod2.apply(host.ctx)

await new Promise((r) => setTimeout(r, 400))

// 等订阅
let subscribed = false
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 150))
  if (wecom.subscribed) { subscribed = true; break }
}
ok(subscribed, '假企微订阅成功（后续会话才建得起来）')

// ---------- 配 MCP 地址 ----------
// 不能走面板那条路：validateMcpUrl 要求 https + 域名必须是 qyapi.weixin.qq.com，
// 本地假服务过不去（那是给真机用的闸，测试不该把它掰弯）。
// 这里直接把地址写进 config 和凭据库 —— 这正是面板配完之后磁盘上的样子，
// 而本测试要验的是「配完之后干活那一段」，不是 URL 校验。
console.log('\n【1】把地址配进 config 与凭据库（面板配完后的磁盘状态）')
const { mcpRef } = await import('../src/core/vault.js')
{
  const { readFileSync, writeFileSync } = await import('node:fs')
  const raw = JSON.parse(readFileSync(cfgPath, 'utf8'))
  for (const a of raw.admins) a.mcp = { msg: MCP_URL }
  writeFileSync(cfgPath, JSON.stringify(raw, null, 2), 'utf8')
}
await fakeCredentials.set(mcpRef('msg', 'u-owner'), MCP_URL)
ok([...creds.keys()].some((k) => k.startsWith('WECOM_BOT_MCP_MSG_')), '凭据库里有了', [...creds.keys()].join(','))
dispose2?.()
const mod2b = await import('../src/host.js?e2e2b=' + Date.now())
const dispose2b = mod2b.apply(host.ctx)
await new Promise((r) => setTimeout(r, 300))

// ---------- 喂一条私聊，把会话建起来 ----------
console.log('\n【2】喂一条私聊（建会话 + 挂工具 + 建立 chat 映射）')
const feed = await fetch(`http://127.0.0.1:${WPORT}/inbound`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: '在吗', userid: 'u-owner', chattype: 'single', msgid: 'mc1' }),
}).then((r) => r.json())
ok(feed?.ok !== false, '消息喂进去了', JSON.stringify(feed).slice(0, 160))

// 等工具挂上
let tool = null
for (let i = 0; i < 50; i++) {
  await new Promise((r) => setTimeout(r, 200))
  if (host.tools.has('wecom_mcp')) { tool = host.tools.get('wecom_mcp'); break }
}
ok(Boolean(tool), 'wecom_mcp 挂上了（owner 档）', [...host.tools.keys()].join(','))

// 找这个会话的 sessionId：插件在收到消息时 sessionChat.set(sid, chat)，
// 我们从 agent.tools 的 restrict 记录里拿不到，改从 fake-host 的 sessions 里找最近建的
const sessionIds = [...host.sessions.keys()]
ok(sessionIds.length > 0, '至少建了一个会话', sessionIds.join(','))
const sid = sessionIds[sessionIds.length - 1]

// ---------- 让工具真去调一次 ----------
console.log('\n【3】让 wecom_mcp 真去调一次（这才是「干活」那条路）')
const before = calls.length
const r1 = await tool.execute({ action: 'list', service: 'msg' }, { sessionId: sid })
console.log('    action=list →', JSON.stringify(r1).slice(0, 220))
ok(r1?.ok === true, 'list 成功了', JSON.stringify(r1).slice(0, 220))
ok(calls.some((c) => c.method === 'tools/list'), '真打到了 MCP 服务的 tools/list')

const r2 = await tool.execute(
  { action: 'call', service: 'msg', tool: 'message_aibot_sessions_list', args: {} },
  { sessionId: sid },
)
console.log('    action=call →', JSON.stringify(r2).slice(0, 220))
ok(r2?.ok === true, 'call 成功了', JSON.stringify(r2).slice(0, 220))
ok(calls.some((c) => c.method === 'tools/call' && c.name === 'message_aibot_sessions_list'),
  '真打到了 MCP 服务的 tools/call', calls.map((c) => c.method + (c.name ? ':' + c.name : '')).join(','))
ok(calls.length > before, '确有新增请求（不是拿缓存糊弄）', `${before} → ${calls.length}`)

// ---------- 关键回归：凭据在、config 明文没了，还能不能干活 ----------
console.log('\n【4】把 config.json 里的明文地址抹掉（模拟换机/被 normalize 吞掉）')
{
  const { readFileSync, writeFileSync } = await import('node:fs')
  const raw = JSON.parse(readFileSync(cfgPath, 'utf8'))
  for (const a of raw.admins) a.mcp = {}
  writeFileSync(cfgPath, JSON.stringify(raw, null, 2), 'utf8')
}
dispose2b?.()
const mod3 = await import('../src/host.js?e2e3=' + Date.now())
const dispose3 = mod3.apply(host.ctx)
await new Promise((r) => setTimeout(r, 300))

// 重新喂一条，把 chat 映射重建（新实例的 sessionChat 是空的）
await fetch(`http://127.0.0.1:${WPORT}/inbound`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: '再来一次', userid: 'u-owner', chattype: 'single', msgid: 'mc2' }),
})
let tool3 = null
for (let i = 0; i < 50; i++) {
  await new Promise((r) => setTimeout(r, 200))
  if (host.tools.has('wecom_mcp')) { tool3 = host.tools.get('wecom_mcp'); break }
}
const sid3 = [...host.sessions.keys()].pop()
ok(Boolean(tool3), '重启后 wecom_mcp 还挂得上')
const r3 = await tool3.execute({ action: 'list', service: 'msg' }, { sessionId: sid3 })
console.log('    重启后 action=list →', JSON.stringify(r3).slice(0, 220))
ok(r3?.ok === true, 'config 没明文地址、只有凭据库时，干活照常', JSON.stringify(r3).slice(0, 220))

console.log(fail ? `\n❌ ${fail} 项失败（通过 ${pass}）` : `\n✅ 全部通过（${pass} 项）`)

// 收尾不能 await fake-wecom 的 close()：它内部 http.close(cb) 会一直等所有
// 连接结束，而插件的长连接还挂着 —— 那个 Promise 永远不 resolve，进程卡死。
// 先把插件停了再关服务，且给 close 加个上限，关不掉就直接 exit。
try { dispose3?.() } catch {}
try { mod3?.stop?.() } catch {}
await new Promise((r) => mcpServer.close(r))
const closed = await Promise.race([
  wecom.close().then(() => true),
  new Promise((r) => setTimeout(() => r(false), 2000)),
])
if (!closed) console.log('（假企微服务没能在 2 秒内关干净，直接退出）')
process.exit(fail ? 1 : 0)
