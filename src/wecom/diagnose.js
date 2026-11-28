// 排查：单聊会不会发不出去 / MCP 这条路通不通
//
// 为什么要做成插件内置的（2026-11-28）：
//   那台「发图报 40073 非法的 chat_id」的机器，光看日志看不出所以然 ——
//   文字全好、图全挂，而日志里只有一句企微的原文。
//   当时是让老大在那边手工跑了一个 dev/diagnose-chatid.mjs 才把根因捞出来。
//   那种事不该每次都要开终端：出问题时用户能点一下就拿到一份能发给维护者的报告。
//
// 判什么：
//   1. 有没有管理员、缺不缺服务
//   2. msg 服务连得上吗、会话列表长什么样
//   3. 最关键的一条 —— 这个企业的单聊 chat_id 到底等不等于 userid
//      · 相等：什么都不用做（大多数企业）
//      · 不相等：插件会在报 40073 时自动去通讯录换（见 chatid.js）
//        但这条兜底要求配了 contact 服务，所以这里必须真的试一次换算，
//        而不是只说「可能需要」—— 用户要的是「我现在到底能不能发」。
//
// 只读：只列会话、只查通讯录，一条消息都不发。

import { lookupChatId, resetChatIdCache } from './chatid.js'
import { asLog } from '../core/safe.js'

/** 企微加密 userid 的形态：w 开头、20 位以上 base64url */
const ENCRYPTED = /^w[A-Za-z0-9_-]{20,}$/

export function isEncryptedId(value) {
  return ENCRYPTED.test(String(value || ''))
}

/**
 * 脱敏：报告是要发给维护者的，不能把整个 userid 抄出去。
 * 短值（比如 JiYou）也不能全露 —— 它是企业后台的账号名。
 */
export function maskId(value) {
  const v = String(value || '')
  if (!v) return '（空）'
  if (v.length <= 6) return v[0] + '***' + v.slice(-1) + `（长 ${v.length}）`
  return v.slice(0, 4) + '***' + v.slice(-4) + `（长 ${v.length}）`
}

/**
 * 跑一遍检查。
 *
 * @param {object} o
 * @param {object} o.cfg           当前配置
 * @param {Function} o.mcpFor      (service, userid) => MCP 客户端 | null
 * @param {Function} [o.log]
 * @returns {Promise<{ok:true, at:string, level:string, checks:Array, lines:Array, data:object}>}
 */
export async function diagnoseChatId({ cfg, mcpFor, log: logRaw } = {}) {
  const log = asLog(logRaw)
  const at = new Date().toISOString()
  const checks = []
  const lines = []
  const push = (s = '') => lines.push(s)
  const add = (level, title, detail, opts = {}) => {
    // superseded：这条已经被后面的检查推翻了（例如「会话里对不上」后来又换算成功了），
    // 结论级别不能再算它，但报告里要留着 —— 看报告的人需要知道中间判过什么。
    checks.push({ level, title, detail: String(detail || ''), superseded: Boolean(opts.superseded) })
    const mark = level === 'ok' ? '✅' : level === 'warn' ? '⚠️' : '❌'
    push(`${mark} ${title}`)
    if (detail) String(detail).split('\n').forEach((l) => push(`   ${l}`))
  }

  push(`排查时间：${at}`)
  push('')

  const admins = Array.isArray(cfg?.admins) ? cfg.admins : []
  const data = { admins: [], sessions: [], conversion: null, msgOk: false }

  // ---------- 1. 管理员 ----------
  if (!admins.length) {
    add('err', '没有管理员', '面板「用户」里先把你自己加成管理员，否则机器人不知道该听谁的。')
    return { ok: true, at, level: 'err', checks, lines, data }
  }
  for (const a of admins) {
    const mcp = a?.mcp || {}
    const svcs = Object.keys(mcp).filter((k) => mcp[k])
    const row = {
      userid: String(a?.userid || ''),
      masked: maskId(a?.userid),
      name: String(a?.name || ''),
      role: String(a?.role || ''),
      form: isEncryptedId(a?.userid) ? 'encrypted' : 'plain',
      services: svcs,
    }
    data.admins.push(row)
    push(`· 管理员 ${row.masked}${row.name ? `（${row.name}）` : ''} role=${row.role}`)
    push(`  userid 形态：${row.form === 'encrypted' ? '加密串' : '明文（像是企微后台的 UserID）'}`)
    push(`  配了 MCP：${svcs.length ? svcs.join(', ') : '（一个都没有）'}`)
  }
  push('')

  const owner = admins.find((a) => a?.role === 'owner') || admins[0]
  const ownerId = String(owner?.userid || '')

  // ---------- 2. msg 服务 ----------
  const hasMsg = Boolean(owner?.mcp?.msg)
  const hasContact = Boolean(owner?.mcp?.contact)
  add(hasMsg ? 'ok' : 'err', hasMsg ? 'msg 服务配了' : 'msg 服务没配',
    hasMsg ? '' : '发图、发文件、读群历史都要它。面板「用户 → 配置 MCP」里把 msg 填上。')
  if (!hasMsg) {
    return { ok: true, at, level: 'err', checks, lines, data }
  }

  let sessions = []
  try {
    const mc = await mcpFor?.('msg', ownerId)
    if (!mc) {
      add('err', 'msg 服务拿不到', '配置里写着地址，但插件取不到客户端 —— 看「日志」里有没有 850003 之类的错误。')
      return { ok: true, at, level: 'err', checks, lines, data }
    }
    const list = await mc.call('message_aibot_sessions_list', {})
    sessions = Array.isArray(list?.sessions) ? list.sessions : []
    data.msgOk = true
    data.sessions = sessions.map((s) => ({
      chatId: String(s?.chat_id || ''),
      masked: maskId(s?.chat_id),
      name: String(s?.chat_name || ''),
      type: String(s?.chat_type || ''),
      last: String(s?.last_msg_time || ''),
      form: isEncryptedId(s?.chat_id) ? 'encrypted' : 'plain',
    }))
    add('ok', 'msg 服务连得上', `拉回 ${sessions.length} 个会话。`)
  } catch (error) {
    add('err', 'msg 服务调不通', `${error?.message || error}\n如果是「authorization expired」这类，先去企业微信里重新授权。`)
    return { ok: true, at, level: 'err', checks, lines, data }
  }

  // ---------- 3. 会话列表 ----------
  const singles = data.sessions.filter((s) => s.type === 'single')
  if (!singles.length) {
    add('warn', '会话列表里没有单聊', '先让某个人给机器人发一条私信，再来跑这个检查 —— 现在没法判断单聊的会话 ID 长什么样。')
  } else {
    push('  单聊会话：')
    for (const s of singles) push(`    · ${s.masked}  name=${JSON.stringify(s.name)}  最后一条=${s.last || '（无）'}`)
    push('')
  }

  // ---------- 4. 关键：chat_id 等不等于 userid ----------
  const hitFor = (id) => singles.find((s) => s.chatId === String(id || ''))
  const direct = hitFor(ownerId)

  if (direct) {
    add('ok', '这个企业的单聊 chat_id 就等于 userid',
      '不用做任何换算，发图发文件都走原来的路。\n要是这样还发不出去，就不是会话 ID 的问题 —— 把「日志」打开详细日志再复现一次。')
    return { ok: true, at, level: 'ok', checks, lines, data }
  }

  // 没对上：可能是「这个人还没私聊过机器人」，也可能是「这个企业的 chat_id 不是 userid」
  const ownerForm = isEncryptedId(ownerId) ? 'encrypted' : 'plain'
  if (!singles.length) {
    add('warn', '暂时判断不了', '没有单聊会话可比对。')
    return { ok: true, at, level: 'warn', checks, lines, data }
  }

  add('warn', '会话列表里没有跟管理员 userid 对得上的单聊',
    `管理员 userid：${maskId(ownerId)}（${ownerForm === 'encrypted' ? '加密串' : '明文'}）\n` +
    `单聊的 chat_id：${singles.map((s) => s.masked).join(' / ')}\n` +
    '两种情况：①这个人还没跟机器人私聊过（那就让他发一句再来检查）；②这个企业的单聊会话 ID 本来就不等于 userid。',
    { superseded: true })

  // 真的试一次换算 —— 用户要的不是「可能需要」，是「我现在到底能不能发」
  if (ownerForm === 'plain') {
    resetChatIdCache()
    let real = ''
    try {
      real = await lookupChatId(ownerId, { mcpFor, log })
    } catch (error) {
      add('err', '换算时出错', String(error?.message || error))
    }
    data.conversion = { from: maskId(ownerId), to: real ? maskId(real) : '', ok: Boolean(real) }
    if (real) {
      const back = hitFor(real)
      add('ok', '能自动换算过去，发图发文件会自动走这条路',
        `通讯录里 ${maskId(ownerId)} 对应的是 ${maskId(real)}。\n` +
        (back ? '而且这个 chat_id 就在会话列表里 —— 对得上。' : '（这个 chat_id 暂时不在会话列表里，等他发过一条消息就会出现。）') +
        '\n插件平时不会多查一次：只有企微回「非法的 chat_id」时才换，换完就记住。')
    } else {
      add('err', hasContact ? '换算不出来，图和文件会发不出去' : '换算不出来：没配 contact 服务',
        hasContact
          ? '通讯录查询没有唯一命中（可能这个人不在通讯录、或者管理员 userid 填的不是企微后台那个真正的 UserID）。'
          : '这个企业的单聊会话 ID 和 userid 不是一个值，而插件要靠 contact 服务去查真实 ID。\n去面板「用户 → 配置 MCP」把 contact 填上，再回来点一次检查。')
    }
  } else {
    add('warn', '这个企业给的是加密 userid，但会话列表里没有它',
      '多半是这个人还没给机器人发过私信。让他发一句，再回来点一次检查。')
  }

  return {
    ok: true,
    at,
    // 结论级别只看没被推翻的那些 —— 「会话里对不上」这条后面只要换算成功就不该再算它，
    // 否则明明能发出去，面板还挂着黄标，用户又要白折腾一轮。
    level: checks.filter((c) => !c.superseded).some((c) => c.level === 'err')
      ? 'err'
      : checks.filter((c) => !c.superseded).some((c) => c.level === 'warn')
        ? 'warn'
        : 'ok',
    checks,
    lines,
    data,
  }
}
