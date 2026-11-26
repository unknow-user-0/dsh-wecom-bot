// 模拟「新机器」上从零配置 MCP 的完整链路，定位到底哪一步断
//
// 用假宿主 + 忠实模拟 DSH credentials-local 的服务（返回值形状、
// 空值语义都和真的一致），走一遍：
//   /admin/add → /admin/mcp → /mcp/test → 模拟重启 → 再取
//
// 全程不调 /connect（那会真连企微长连接）：botId/secret 直接注入凭据服务。
// 跑法：node dev/mcp-config-flow.mjs

import { createFakeHost } from './fake-host.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'wecom-mcpflow-'))
process.env.DSH_HOME = HOME
process.env.DSH_WECOM_WS_URL = 'ws://127.0.0.1:1/never' // 万一走到连接也只打本地死端口

/** 忠实模拟 dsh-credentials-local 的 LocalCredentialProvider */
function makeCredentials(disk = new Map()) {
  const values = new Map(disk) // 启动时从「磁盘」读进内存
  return {
    disk,
    resolve(ref) {
      const stored = values.get(ref)
      if (stored !== undefined) return Promise.resolve({ value: stored, source: 'file' })
      return Promise.resolve(undefined)
    },
    describe(ref) {
      return Promise.resolve(values.get(ref) !== undefined
        ? { configured: true, source: 'file', writable: true }
        : { configured: false, writable: true })
    },
    async set(ref, value) {
      if (!value || value.length === 0) {
        throw new Error(`credentials-local: an empty value cannot be stored for "${ref}"; use unset`)
      }
      values.set(ref, value)
      disk.set(ref, value) // 只有走到这里才算真落盘
    },
    async unset(ref) { values.delete(ref); disk.delete(ref) },
  }
}

const URL_MSG = 'https://qyapi.weixin.qq.com/mcp/v2/bot/msg?apikey=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz'

const fails = []
const ok = (cond, name, extra = '') => {
  if (cond) console.log('  ✓', name)
  else { fails.push(name); console.log('  ✗', name, extra ? `→ ${extra}` : '') }
}
const skip = (name, extra = '') => console.log('  ⚠', name, extra ? `→ ${extra}` : '')

let n = 0
const boot = async (creds) => {
  const host = createFakeHost({ replyText: 'ok' })
  if (creds) host.inject('credentials', creds)
  // 每次 import 新实例，模拟重启
  const mod = await import('../src/host.js?boot=' + (++n))
  const dispose = mod.apply(host.ctx)
  return { host, dispose }
}

/** 直接改 config.json 设 botId（绕开 /connect，不真连企微） */
async function setBotId() {
  const { readFileSync, writeFileSync, existsSync } = await import('node:fs')
  const p = join(HOME, 'plugins-data', 'wecom-bot', 'config.json')
  const raw = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}
  raw.botId = 'aibTESTBOT'
  writeFileSync(p, JSON.stringify(raw, null, 2), 'utf8')
}

console.log('\n【1】全新机器：凭据服务还没就绪（ctx.get("credentials") 返回 null）')
{
  const { host, dispose } = await boot(null)
  const a = await host.callRoute('/wecom-bot/api/admin/add', { userid: 'zhangsan', name: '张三' })
  ok(a?.ok === true, '加管理员', JSON.stringify(a))
  const m = await host.callRoute('/wecom-bot/api/admin/mcp', { userid: 'zhangsan', service: 'msg', url: URL_MSG })
  ok(m?.ok === true, '写 MCP 地址不报错', JSON.stringify(m))
  ok(Boolean(m?.warning), '必须警告「只存内存，重启会丢」', JSON.stringify(m))
  ok(String(m?.warning || '').includes('重启'), '警告里讲清楚重启会丢', JSON.stringify(m?.warning))
  dispose()
}

console.log('\n【2】有凭据服务：正常配一次，检查落盘')
const disk = new Map()
{
  disk.set('WECOM_BOT_SECRET', 'secTEST')
  await setBotId()
  const { host, dispose } = await boot(makeCredentials(disk))
  await host.callRoute('/wecom-bot/api/admin/add', { userid: 'zhangsan', name: '张三' })
  const m = await host.callRoute('/wecom-bot/api/admin/mcp', { userid: 'zhangsan', service: 'msg', url: URL_MSG })
  ok(m?.ok === true, '写 MCP 地址', JSON.stringify(m))
  ok(!m?.warning, '有凭据服务时不该有 warning', JSON.stringify(m))
  ok(m?.config?.admins?.[0]?.mcp?.msg === true, 'config 里 mcp.msg 是 true（面板只看到布尔）')
  ok([...disk.keys()].some((k) => k.startsWith('WECOM_BOT_MCP_MSG_')), '凭据落盘了', [...disk.keys()].join(','))
  dispose()
}

console.log('\n【3】重启（同一个凭据磁盘，新进程，config.json 里仍有明文 URL）')
{
  const { host, dispose } = await boot(makeCredentials(new Map(disk)))
  const cfg = await host.callRoute('/wecom-bot/api/config')
  ok(cfg?.config?.admins?.[0]?.mcp?.msg === true, '重启后面板仍显示配过')
  const t = await host.callRoute('/wecom-bot/api/mcp/test', { userid: 'zhangsan', service: 'msg' })
  console.log('    /mcp/test =', JSON.stringify(t).slice(0, 160))
  ok(t?.message !== '还没配这个服务', '重启后仍认得这个服务', JSON.stringify(t).slice(0, 160))
  dispose()
}

console.log('\n【4】只有凭据、config.json 里没有明文 URL（换机/被 normalize 吞掉/手改过）')
{
  const { readFileSync, writeFileSync } = await import('node:fs')
  const cfgPath = join(HOME, 'plugins-data', 'wecom-bot', 'config.json')
  const raw = JSON.parse(readFileSync(cfgPath, 'utf8'))
  for (const a of raw.admins) a.mcp = {}
  writeFileSync(cfgPath, JSON.stringify(raw, null, 2), 'utf8')

  const { host, dispose } = await boot(makeCredentials(new Map(disk)))
  const cfg = await host.callRoute('/wecom-bot/api/config')
  ok(cfg?.config?.admins?.[0]?.mcp?.msg === false, '面板如实显示「没配过」', JSON.stringify(cfg?.config?.admins?.[0]?.mcp))
  const t = await host.callRoute('/wecom-bot/api/mcp/test', { userid: 'zhangsan', service: 'msg' })
  console.log('    /mcp/test =', JSON.stringify(t).slice(0, 200))
  ok(t?.message !== '还没配这个服务', 'config 没 URL 时应回落到凭据库', JSON.stringify(t).slice(0, 200))
  dispose()
}

console.log('\n【5】新机器真·从零：凭据库里什么都没有')
{
  const { host, dispose } = await boot(makeCredentials(new Map()))
  await host.callRoute('/wecom-bot/api/admin/add', { userid: 'lisi', name: '李四' })
  const t = await host.callRoute('/wecom-bot/api/mcp/test', { userid: 'lisi', service: 'msg' })
  console.log('    /mcp/test =', JSON.stringify(t))
  ok(t?.ok === false && t?.message === '还没配这个服务', '没配就该说没配', JSON.stringify(t))
  dispose()
}

console.log(fails.length ? `\n❌ ${fails.length} 项失败：${fails.join(' / ')}` : '\n✅ 全部通过')
process.exit(fails.length ? 1 : 0)
