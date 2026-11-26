// MCP 探活：「测一下」到底测了什么。
//
// 为什么单独一个测试：面板上那个「测一下」按钮曾经是假通过的 ——
// 只调 tools/list 就算通。而企微的授权过期（850003）下 initialize 和
// tools/list 永远 200，只有 tools/call 才暴露。于是面板显示「通了，6 个工具」，
// 用户以为配好了，实际每条消息都发不出去。
//
// 这个测试钉死三件事：
//   1. 只列工具不算通，必须真调一次业务工具
//   2. 授权过期要能把 help_message 里的授权入口带出来（否则用户不知道去哪点）
//   3. 业务参数错误【算通】—— 能走到业务层就说明授权那关过了，别吓唬人
//
// 跑法：node dev/mcp-probe.mjs

import { McpError, helpUrl, probeService, MCP_PROBES, MCP_SERVICES } from '../src/wecom/mcp.js'

const problems = []
const check = (ok, name, extra = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? '：' + extra : ''}`)
  if (!ok) problems.push(name + (extra ? '：' + extra : ''))
}

const AUTH_URL = 'https://work.weixin.qq.com/ai/aiHelper/authorizationList?from=chat&aibotid=X'
const HELP = `当前机器人「消息」使用权限已过期\n若你是智能机器人创建者，可以[点击这里](${AUTH_URL})授权当前机器人消息使用权限；`

/** 造个假客户端：list 与 call 各自可控 */
function fakeMc({ listError, callError, tools = ['a', 'b'] } = {}) {
  const calls = []
  return {
    calls,
    async listTools() {
      if (listError) throw listError
      return tools.map((name) => ({ name }))
    },
    async call(name, args) {
      calls.push({ name, args })
      if (callError) throw callError
      return { errcode: 0 }
    },
  }
}

function authError() {
  return new McpError('authorization expired, hint: [1795680]', 850003, { help: HELP })
}

// ---------------------------------------------------------------
// ① 探针表必须覆盖所有服务，且不能拿 media_upload 当探针
// ---------------------------------------------------------------
{
  const missing = MCP_SERVICES.map((s) => s.id).filter((id) => !MCP_PROBES[id])
  check(missing.length === 0, '每个服务都有探活工具', missing.join(','))

  const uploads = Object.entries(MCP_PROBES).filter(([, p]) => /media_upload/.test(p.tool))
  // media_upload 不校验服务权限：授权全过期了它照样 errcode=0。
  check(uploads.length === 0, '不用 media_upload 当探针（它不校验权限）', uploads.map(([k]) => k).join(','))

  const writes = Object.entries(MCP_PROBES).filter(([, p]) => /_create|_send|_update|_delete|_append|_upload|_cancel|_finish/.test(p.tool))
  check(writes.length === 0, '探针只用只读工具（不能因为点一下「测一下」就往别人微盘里写东西）', writes.map(([k, p]) => `${k}:${p.tool}`).join(','))
}

// ---------------------------------------------------------------
// ② 真探活：正常 / 授权过期 / 参数错误 / 网络不通
// ---------------------------------------------------------------
{
  const ok = await probeService(fakeMc(), 'msg')
  check(ok.ok === true, '正常：判通')
  check(ok.count === 2, '正常：工具数量带回来')
  check(ok.tool === MCP_PROBES.msg.tool, '正常：说明用的是哪个探针')

  const mc = fakeMc({ callError: authError() })
  const auth = await probeService(mc, 'msg')
  check(mc.calls.length === 1, '授权过期前确实真调了一次业务工具（不是只列工具）')
  check(auth.ok === false, '授权过期：判失败（这正是以前假通过的地方）')
  check(auth.needAuth === true, '授权过期：打上 needAuth 标记给面板用')
  check(auth.url === AUTH_URL, '授权过期：把授权入口抠出来了', auth.url)
  check(/权限已过期|authorization expired/.test(auth.help), '授权过期：help_message 原样带回来')

  // 关键的一条：业务报错不等于配错。能走到业务层 —> 授权过了，别吓唬人。
  const biz = await probeService(fakeMc({ callError: new McpError('参数 keywords 必填', 40058) }), 'doc')
  check(biz.ok === true, '业务/参数错误：仍然判通（授权这关是过的）', biz.note)
  check(/参数 keywords 必填/.test(biz.note || ''), '业务错误：把原话带出来给人看')

  const net = await probeService(fakeMc({ listError: new McpError('连不上 MCP 服务：ECONNREFUSED', 'network') }), 'mail')
  check(net.ok === false, '网络不通：判失败')
  check(!net.needAuth, '网络不通：不能说成授权问题')

  const http = await probeService(fakeMc({ listError: new McpError('MCP HTTP 500：boom', 'http_500') }), 'mail')
  check(http.ok === false, 'HTTP 5xx：判失败')
}

// ---------------------------------------------------------------
// ③ 没在探针表里的服务：降到「只验连通」，并且得说清楚
// ---------------------------------------------------------------
{
  const r = await probeService(fakeMc(), 'unknown_svc')
  check(r.ok === true, '未知服务：只验连通也判通')
  check(/只验了连通性/.test(r.note || ''), '未知服务：说明没做业务探活，别让人误以为全能', r.note)
}

// ---------------------------------------------------------------
// ④ McpError.needAuth 与 helpUrl 的判定面
// ---------------------------------------------------------------
{
  check(new McpError('x', 850003).needAuth === true, 'needAuth：认错误码 850003')
  check(new McpError('authorization expired').needAuth === true, 'needAuth：认文案 authorization expired')
  check(new McpError('未授权').needAuth === true, 'needAuth：认中文「未授权」')
  check(new McpError('权限已过期').needAuth === true, 'needAuth：认中文「权限已过期」')
  check(new McpError('参数错误', 40058).needAuth === false, 'needAuth：业务错误不算')
  check(new McpError('timeout', 'network').needAuth === false, 'needAuth：网络错误不算')

  check(helpUrl({ help: `看看[这里](${AUTH_URL})然后点` }) === AUTH_URL, 'helpUrl：从 markdown 链接里抠')
  check(helpUrl({ help: `直接去 ${AUTH_URL} 授权` }) === AUTH_URL, 'helpUrl：裸 URL 也认')
  check(helpUrl({ help: '没有链接' }) === '', 'helpUrl：没链接返回空串')
  check(helpUrl({}) === '', 'helpUrl：没有 help 也不炸')
  check(helpUrl(null) === '', 'helpUrl：null 也不炸')
}

if (problems.length) {
  console.log(`\n❌ ${problems.length} 项没过：`)
  for (const p of problems) console.log('  - ' + p)
  process.exit(1)
}
console.log('\n✅ MCP 探活：真调业务工具 / 授权过期带出入口 / 业务错误不误判')
