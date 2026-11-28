#!/usr/bin/env node
// 诊断：单聊的 chat_id 到底该传什么
//
// 背景：有个企业（userid 是后台明文 `JiYou` 那种）发图时报
//   「非法的 'chat_id', 请重新检查'chat_id'的值是否正确」
// 而文字一直正常 —— 因为文字走被动回复（req_id），完全不碰 chat_id。
// 另一个企业（userid 是 `wofL_hCgAA...` 加密串）就没这个问题。
//
// 所以怀疑：单聊的 chat_id 是不是等于 userid，**取决于企业配置**。
//
// 这个脚本只读不写：不发明消息内容、不改配置，只列会话 + 打一次最小请求。
// 在插件目录下跑：
//   node dev/diagnose-chatid.mjs
// 把全部输出发给维护者。
//
// 想看更细（包括请求/响应原文）：
//   node dev/diagnose-chatid.mjs --verbose

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const VERBOSE = process.argv.includes('--verbose')

const DATA_DIR = process.env.DSH_HOME
  ? join(process.env.DSH_HOME, 'plugins-data', 'wecom-bot')
  : join(process.env.USERPROFILE || homedir(), '.dsh', 'plugins-data', 'wecom-bot')
const CONFIG_FILE = join(DATA_DIR, 'config.json')

function line(s = '') { process.stdout.write(s + '\n') }
function section(t) { line(''); line('='.repeat(60)); line(t); line('='.repeat(60)) }

function mask(s) {
  const v = String(s || '')
  if (v.length <= 8) return v ? v[0] + '***' : '（空）'
  return v.slice(0, 4) + '***' + v.slice(-4) + `（长 ${v.length}）`
}

/** 极简 MCP 客户端：只够跑 initialize + tools/call */
async function makeClient(url, verbose) {
  let nextId = 1
  const rpc = async (method, params) => {
    const id = nextId++
    const req = { jsonrpc: '2.0', id, method, params }
    if (verbose) line(`→ ${JSON.stringify(req).slice(0, 800)}`)
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(20000),
    })
    const text = await res.text()
    if (verbose) line(`← HTTP ${res.status} ${text.slice(0, 1200)}`)
    // 可能是 SSE（data: {...}），也可能是裸 JSON
    const dataLine = text.split('\n').find((l) => l.trim().startsWith('data:'))
    const payload = JSON.parse((dataLine || text).replace(/^data:\s*/, ''))
    if (payload.error) throw new Error(`${method} 失败：${JSON.stringify(payload.error).slice(0, 300)}`)
    return payload.result
  }
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'dsh-wecom-bot-diagnose', version: '1' },
  })
  const call = async (name, args = {}) => {
    const r = await rpc('tools/call', { name, arguments: args })
    // 企微把业务错误也包在 result.content[0].text 里（isError 常是 false），必须解包
    const raw = r?.content?.[0]?.text ?? ''
    let parsed = null
    try { parsed = JSON.parse(raw) } catch { /* 不是 JSON 就算了 */ }
    return { ok: parsed ? Number(parsed.errcode ?? 0) === 0 : false, parsed, raw }
  }
  return { rpc, call }
}

/** 从会话列表里判断这个企业的单聊 chat_id 长什么样 */
function classify(sessions) {
  const singles = sessions.filter((s) => String(s?.chat_type || '') === 'single')
  if (!singles.length) {
    return { kind: 'no-single', note: '会话列表里没有单聊会话 —— 先跟机器人私聊一句话再来跑这个脚本' }
  }
  // 加密形态：企微加密 userid 通常是 4+24 位 base64url 风格（wofL_hCgAA...）
  const looksEncrypted = (id) => /^w[A-Za-z0-9_-]{20,}$/.test(String(id || ''))
  const enc = singles.filter((s) => looksEncrypted(s.chat_id)).length
  if (enc === singles.length) {
    return {
      kind: 'encrypted',
      note: '单聊 chat_id 都是加密串（w 开头、20 位以上）。这种企业里 chat_id 通常就等于加密后的 userid，直接传 userid 一般能过。',
    }
  }
  if (enc === 0) {
    return {
      kind: 'plain',
      note: '单聊 chat_id 是普通字符串（不是加密串）。这种企业里 chat_id **很可能不等于** 明文 UserID，直接把 userid 当 chat_id 传就会被拒。',
    }
  }
  return { kind: 'mixed', note: '单聊 chat_id 有的加密有的不加密，情况比较特殊。' }
}

async function main() {
  line(`诊断时间：${new Date().toISOString()}`)
  line(`数据目录：${DATA_DIR}`)
  line(`node：${process.version} / ${process.platform}`)

  section('1. 配置')
  let cfg
  try {
    cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  } catch (error) {
    line(`读不到配置：${error.message}`)
    line('先确认插件跑起来过一次（配置里要有管理员和 MCP 地址）。')
    process.exit(1)
  }
  const admins = Array.isArray(cfg.admins) ? cfg.admins : []
  line(`管理员 ${admins.length} 个：`)
  for (const a of admins) {
    line(`  · userid=${a.userid} name=${a.name} role=${a.role}`)
    line(`    userid 形态：${/^w[A-Za-z0-9_-]{20,}$/.test(String(a.userid)) ? '加密串' : '明文（像是企微后台的 UserID）'}`)
    const mcp = a.mcp || {}
    const svcs = Object.keys(mcp).filter((k) => mcp[k])
    line(`    配了 MCP：${svcs.length ? svcs.join(', ') : '（无）'}`)
  }

  const owner = admins.find((a) => a.role === 'owner') || admins[0]
  if (!owner) {
    line('没有管理员，退出。')
    process.exit(1)
  }
  const msgUrl = owner.mcp?.msg
  if (!msgUrl) {
    line('')
    line(`管理员 ${owner.userid} 没配 msg 服务的 MCP 地址，后面的都没法测。`)
    line('去面板「用户 → 配置 MCP」把 msg 那一格填上再来。')
    process.exit(1)
  }

  section('2. 连 msg 服务')
  line(`地址：${mask(msgUrl)}`)
  const mc = await makeClient(msgUrl, VERBOSE)
  line('initialize 成功。')

  section('3. 会话列表（这是判断 chat_id 形态的唯一依据）')
  const list = await mc.call('message_aibot_sessions_list', {})
  if (!list.ok) {
    line(`拉会话列表失败：${list.raw.slice(0, 400)}`)
    process.exit(1)
  }
  const sessions = Array.isArray(list.parsed?.sessions) ? list.parsed.sessions : []
  line(`共 ${sessions.length} 个会话：`)
  for (const s of sessions) {
    line(`  · chat_type=${s.chat_type} chat_id=${s.chat_id}`)
    line(`    chat_name=${JSON.stringify(s.chat_name)}  last_msg_time=${s.last_msg_time || '（无）'}`)
    line(`    chat_id 形态：${/^w[A-Za-z0-9_-]{20,}$/.test(String(s.chat_id || '')) ? '加密串' : '明文/普通字符串'}`)
  }

  section('4. 结论')
  const verdict = classify(sessions)
  line(`判断：${verdict.kind}`)
  line(verdict.note)

  const singles = sessions.filter((s) => String(s?.chat_type || '') === 'single')
  const adminIds = new Set(admins.map((a) => String(a.userid)))
  const matched = singles.filter((s) => adminIds.has(String(s.chat_id)))
  line('')
  if (matched.length) {
    line(`✅ 会话列表里有 chat_id 与管理员 userid **完全相同** 的单聊会话：`)
    for (const s of matched) line(`   ${s.chat_id}（${s.chat_name}）`)
    line('   说明这个企业 chat_id == userid，直接传 userid 是对的。')
    line('   那这次发图失败就不是 chat_id 的问题，得看别的（把上面的 --verbose 输出也发来）。')
  } else {
    line(`❌ 会话列表里**没有**哪个单聊 chat_id 等于管理员 userid。`)
    line(`   管理员 userid：${[...adminIds].join(' / ')}`)
    line(`   会话里的 chat_id：${singles.map((s) => s.chat_id).join(' / ') || '（没有单聊）'}`)
    line('')
    line('   → 这就是根因：这个企业的单聊会话 ID 和 userid 不是一个值，')
    line('     插件把 userid 当 chat_id 传，企微就回「非法的 chat_id」。')
    line('     文字之所以没事，是因为文字走被动回复（req_id），压根不用 chat_id。')
  }

  section('5. 关键问题：能不能靠会话列表反查')
  line('sessions_list 的返回里只有 chat_id / chat_name / chat_type / last_msg_time，')
  line('**没有 userid**。所以如果 chat_id ≠ userid，插件无法靠它把「谁」和「哪个 chat_id」对上。')
  line('')
  if (!matched.length) {
    line('这就意味着「按 userid 反查 chat_id」这条路走不通 —— 需要换思路（改走被动回复发图）。')
  }

  line('')
  line('诊断结束。把上面全部输出（加 --verbose 更好）发给维护者。')
}

main().catch((error) => {
  line('')
  line(`诊断脚本自己出错了：${error?.stack || error}`)
  process.exit(1)
})
