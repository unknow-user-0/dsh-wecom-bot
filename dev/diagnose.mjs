#!/usr/bin/env node
// 排查功能（src/wecom/diagnose.js）的回归
//
// 这个功能的价值全在「判得对」上：判错方向会让用户往错的地方修 ——
// 比如明明是 chat_id 形态问题，却告诉他「换张图」。所以这里的断言
// 主要在钉住各种情况分别给出什么结论，而不是跑通就算。

import { diagnoseChatId, isEncryptedId, maskId } from '../src/wecom/diagnose.js'

let pass = 0
let fail = 0
function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log(`✅ ${name}`) }
  else { fail++; console.log(`❌ ${name}${extra ? ' → ' + extra : ''}`) }
}

const ENC = 'wofL_hCgAAJ5l8Bm66pquN28rQ76vQWg'   // 本机那种加密串
const ENC2 = 'wofL_hCgAAqoPHd4P22U0inqcZmO4blw'
const PLAIN = 'JiYou'                              // 珊瑚那台的明文

/** 假 mcpFor：按 service 给客户端，记录调用过哪些服务 */
function makeMcp(plan) {
  const calls = []
  const mcpFor = async (service) => {
    calls.push(service)
    const p = plan[service]
    if (!p) return null
    if (typeof p === 'function') return p(calls)
    return p
  }
  return { mcpFor, calls }
}

function session(chatId, name, type = 'single', last = '2026-11-28 18:00:00') {
  return { chat_id: chatId, chat_name: name, chat_type: type, last_msg_time: last }
}

function msgSvc(sessions) {
  return { call: async (tool) => {
    if (tool === 'message_aibot_sessions_list') return { sessions, sessions_count: sessions.length, errcode: 0 }
    throw new Error('没料到会调 ' + tool)
  } }
}

function contactSvc(users) {
  return { call: async (tool, args) => {
    if (tool !== 'contact_users_search') throw new Error('没料到会调 ' + tool)
    return { users, users_count: users.length, errcode: 0 }
  } }
}

function baseCfg(over = {}) {
  return {
    admins: [{
      userid: ENC, name: '老大', role: 'owner',
      mcp: { msg: 'https://x/msg', contact: 'https://x/contact', disk: 'https://x/disk' },
    }],
    ...over,
  }
}

// ---------------- ①小工具 ----------------
console.log('\n— ① 形态判定与脱敏 —')
ok(isEncryptedId(ENC) === true, '加密串认得出')
ok(isEncryptedId(PLAIN) === false, '明文不是加密串')
ok(isEncryptedId('') === false, '空不算加密串')
ok(isEncryptedId('wShort') === false, '太短的不当加密串（避免误判）')
ok(maskId(ENC).includes('***') && !maskId(ENC).includes(ENC), '长 ID 脱敏后不含原值')
ok(maskId(PLAIN).includes('***'), '短 ID 也脱敏（JiYou 是企业账号名，不能整条抄出去）')
ok(!maskId(PLAIN).includes('JiYou'), '短 ID 脱敏后不再含原文')
ok(maskId('').includes('空'), '空值有明确文案')

// ---------------- ②一切正常 ----------------
console.log('\n— ② 正常企业（chat_id == userid）—')
{
  const { mcpFor, calls } = makeMcp({
    msg: msgSvc([session(ENC, ' 季游'), session(ENC2, '流明'), session('wrfL_hCgAAH', '太子', 'group')]),
  })
  const r = await diagnoseChatId({ cfg: baseCfg(), mcpFor })
  ok(r.level === 'ok', '结论是 ok', r.level)
  ok(r.lines.join('\n').includes('就等于 userid'), '文案点明 chat_id 等于 userid')
  ok(!calls.includes('contact'), '正常企业不去碰通讯录（零额外请求）')
  ok(r.data.conversion === null, '没做换算')
}

// ---------------- ③明文 userid，能换算 ----------------
console.log('\n— ③ 明文 userid，通讯录能换算 —')
{
  const cfg = baseCfg({
    admins: [{
      userid: PLAIN, name: '老铁', role: 'owner',
      mcp: { msg: 'https://x/msg', contact: 'https://x/contact' },
    }],
  })
  const { mcpFor, calls } = makeMcp({
    msg: msgSvc([session(ENC, '季游'), session('wrfL_hCgAAH', '太子', 'group')]),
    contact: contactSvc([{ userid: ENC, name: '季游', matched_keywords: [PLAIN] }]),
  })
  const r = await diagnoseChatId({ cfg, mcpFor })
  const text = r.lines.join('\n')
  ok(calls.includes('contact'), '真的去查了通讯录（不是只说「可能需要」）')
  ok(r.data.conversion?.ok === true, '换算成功')
  ok(text.includes('能自动换算过去'), '文案说明能自动换算')
  ok(text.includes('对得上'), '换出来的 ID 在会话列表里能找到')
  ok(r.level === 'ok', '这种情况算 ok（能发出去）', r.level)
}

// ---------------- ④明文 userid，换算不出来但有 contact ----------------
console.log('\n— ④ 明文 userid，通讯录没唯一命中 —')
{
  const cfg = baseCfg({
    admins: [{ userid: PLAIN, name: '老铁', role: 'owner', mcp: { msg: 'https://x/msg', contact: 'https://x/contact' } }],
  })
  const { mcpFor } = makeMcp({
    msg: msgSvc([session(ENC, '季游')]),
    contact: contactSvc([{ userid: ENC, name: '季游' }, { userid: ENC2, name: '季游2' }]),
  })
  const r = await diagnoseChatId({ cfg, mcpFor })
  ok(r.level === 'err', '命中两条 → 结论是 err（发不出去）', r.level)
  ok(r.lines.join('\n').includes('换算不出来'), '文案说换算不出来')
  ok(r.data.conversion?.ok === false, 'data 里如实标记失败')
}

// ---------------- ⑤没配 contact ----------------
console.log('\n— ⑤ 明文 userid 但没配 contact —')
{
  const cfg = baseCfg({
    admins: [{ userid: PLAIN, name: '老铁', role: 'owner', mcp: { msg: 'https://x/msg' } }],
  })
  const { mcpFor, calls } = makeMcp({ msg: msgSvc([session(ENC, '季游')]) })
  const r = await diagnoseChatId({ cfg, mcpFor })
  const text = r.lines.join('\n')
  // 会问一次 mcpFor('contact')（问了才知道没配），但不该真的发出通讯录请求 ——
  // 假客户端里没给它挂任何 call，用得着就会抛错，能跑到这里说明没调。
  ok(calls.includes('contact'), '会问一次 contact 有没有配')
  ok(r.data.conversion?.ok === false, '没配 contact 就换算不出来')
  ok(r.level === 'err', '结论是 err', r.level)
  ok(text.includes('没配 contact'), '文案直接点出没配 contact')
  ok(text.includes('配置 MCP'), '告诉用户去哪儿配')
}

// ---------------- ⑥没有管理员 ----------------
console.log('\n— ⑥ 没管理员 —')
{
  const { mcpFor, calls } = makeMcp({})
  const r = await diagnoseChatId({ cfg: { admins: [] }, mcpFor })
  ok(r.level === 'err', '结论是 err')
  ok(r.lines.join('\n').includes('没有管理员'), '文案说没有管理员')
  ok(calls.length === 0, '没管理员就不该去调任何服务')
}

// ---------------- ⑦没配 msg ----------------
console.log('\n— ⑦ 没配 msg —')
{
  const cfg = baseCfg({ admins: [{ userid: ENC, name: '老大', role: 'owner', mcp: { disk: 'https://x/disk' } }] })
  const { mcpFor } = makeMcp({})
  const r = await diagnoseChatId({ cfg, mcpFor })
  ok(r.level === 'err', '结论是 err')
  ok(r.lines.join('\n').includes('msg 服务没配'), '文案说没配 msg')
}

// ---------------- ⑧msg 服务抛错（授权过期之类） ----------------
console.log('\n— ⑧ msg 服务调不通 —')
{
  const boom = { call: async () => { throw new Error('authorization expired (850003)') } }
  const { mcpFor } = makeMcp({ msg: boom })
  const r = await diagnoseChatId({ cfg: baseCfg(), mcpFor })
  ok(r.level === 'err', '结论是 err')
  const text = r.lines.join('\n')
  ok(text.includes('调不通'), '文案说调不通')
  ok(text.includes('authorization expired'), '把原始错误带上（排障要靠它）')
  ok(text.includes('重新授权'), '给出下一步')
}

// ---------------- ⑨没有单聊会话 ----------------
console.log('\n— ⑨ 会话列表里没有单聊 —')
{
  const { mcpFor } = makeMcp({ msg: msgSvc([session('wrfL_hCgAAH', '太子', 'group')]) })
  const r = await diagnoseChatId({ cfg: baseCfg(), mcpFor })
  const text = r.lines.join('\n')
  ok(r.level === 'warn' || r.level === 'err', '不是 ok（判不了）', r.level)
  ok(text.includes('没有单聊'), '文案说没有单聊')
  ok(text.includes('私信'), '告诉用户怎么办')
}

// ---------------- ⑩加密 userid 但会话列表没有 ----------------
console.log('\n— ⑩ 加密 userid，会话里没有它 —')
{
  const { mcpFor, calls } = makeMcp({ msg: msgSvc([session(ENC2, '流明')]) })
  const r = await diagnoseChatId({ cfg: baseCfg(), mcpFor })
  const text = r.lines.join('\n')
  ok(r.level === 'warn', '结论是 warn（大概率还没私聊过）', r.level)
  ok(text.includes('发过私信') || text.includes('私聊'), '文案提示先私聊一次')
  ok(!calls.includes('contact'), '加密 userid 不做通讯录换算（换不来）')
}

// ---------------- ⑪报告本身要能直接发出去 ----------------
console.log('\n— ⑪ 报告内容 —')
{
  const cfg = baseCfg({ admins: [{ userid: PLAIN, name: '老铁', role: 'owner', mcp: { msg: 'https://x/msg' } }] })
  const { mcpFor } = makeMcp({ msg: msgSvc([session(ENC, '季游')]) })
  const r = await diagnoseChatId({ cfg, mcpFor })
  const text = r.lines.join('\n')
  ok(!text.includes(PLAIN), '报告里不含明文 userid 原文', text.match(/JiYou/g)?.length + ' 处')
  ok(!text.includes(ENC), '报告里不含完整加密 chat_id')
  ok(text.includes('排查时间'), '带时间戳（维护者要按时间对日志）')
  ok(Array.isArray(r.checks) && r.checks.length > 0, '结构化 checks 有内容（面板要用）')
  ok(r.checks.every((c) => c.level && c.title), 'checks 每项都有 level 和标题')
}

// ---------------- ⑫数据形状（给面板/测试用） ----------------
console.log('\n— ⑫ 返回结构 —')
{
  const { mcpFor } = makeMcp({ msg: msgSvc([session(ENC, ' 季游'), session(ENC2, '流明')]) })
  const r = await diagnoseChatId({ cfg: baseCfg(), mcpFor })
  ok(r.ok === true, 'ok 是 true')
  ok(typeof r.at === 'string' && r.at.includes('T'), 'at 是 ISO 时间')
  ok(Array.isArray(r.lines) && r.lines.length > 0, 'lines 是字符串数组')
  ok(r.lines.every((l) => typeof l === 'string'), 'lines 每行都是字符串（前端直接渲染）')
  ok(Array.isArray(r.data.sessions) && r.data.sessions.length === 2, 'data.sessions 如实带上')
  ok(r.data.sessions.every((s) => s.masked && s.chatId), '每个会话有 masked 和原始 chatId（内部用）')
  ok(r.data.admins.length === 1 && r.data.admins[0].form === 'encrypted', 'data.admins 带形态判定')
}

console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
