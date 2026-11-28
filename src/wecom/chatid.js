// 单聊 chat_id 的换算
//
// 为什么需要这个文件（2026-11-28 真机踩出来的）：
//   企微单聊的回调里没有 chatid，只有 from.userid，所以插件一直拿 from.userid 当单聊的 chat_id。
//   这在很多企业里是对的 —— 但那是因为那些企业回调给的 from.userid 本身就是加密串。
//   机器人由「企业创建者」创建时，回调给的是后台明文 UserID（形如 JiYou），
//   而 message_aibot_send / chat_messages_list 要的是加密串，照原样传就 40073「非法的 chat_id」。
//   症状很迷惑：文字全好（走 aibot_respond_msg + req_id，压根不碰 chat_id），图片和文件全挂。
//
// 怎么换算（本机和另一台机器都验证过）：
//   contact_users_search({ keywords: [明文] }) 命中的那个 user.userid，就是该会话的 chat_id。
//   反过来查不了（拿加密串查通讯录命中 0 条），所以这条链是单向的。
//
// 三条纪律：
//   1. 只在真撞上 40073 之后才查 —— 正常企业零额外请求，行为和以前一模一样。
//   2. 必须「只命中一个」且 matched_keywords 精确包含查询值才采用。
//      绝不按名字模糊匹配：发错人比发不出去严重得多。
//   3. 查不到就如实报错，不猜、不改用别的会话发。

import { asLog } from '../core/safe.js'

/** 同一个明文 ID 换算出来的结果，进程内记住就够了 —— 一次失败重试的代价远小于落盘复杂度 */
const cache = new Map()

/** 测试用：清掉缓存 */
export function resetChatIdCache() {
  cache.clear()
}

/**
 * 这个错误是不是「chat_id 这个值本身不被接受」。
 * 企微原文：非法的 'chat_id', 请重新检查'chat_id'的值是否正确 (callid: ...)
 * 注意 40073 只说明「形态不对」，不能据此推断「会话不存在」。
 */
export function isInvalidChatId(error) {
  if (!error) return false
  if (Number(error.code ?? error.errcode) === 40073) return true
  const text = String(error.message || error)
  return /非法的\s*[''"]?chat_?id/i.test(text) || /invalid\s+chat_?id/i.test(text)
}

/**
 * 把明文 userid 换成真正的单聊 chat_id。
 * @param {string} plain 回调里拿到的 from.userid
 * @param {object} o
 * @param {Function} o.mcpFor  取 MCP 客户端
 * @param {Function} [o.log]
 * @returns {Promise<string>} 换算结果；查不到返回空串（调用方据此决定怎么报错）
 */
export async function lookupChatId(plain, { mcpFor, log: logRaw } = {}) {
  const log = asLog(logRaw)
  const key = String(plain || '').trim()
  if (!key) return ''
  const hit = cache.get(key)
  if (hit) return hit

  const contact = await mcpFor?.('contact')
  if (!contact) {
    log('warn', '会话 ID 不对，但没配 MCP 的 contact 服务，没法把 userid 换成会话 ID。去面板「用户 → 配置 MCP」把 contact 填上。')
    return ''
  }

  let r
  try {
    r = await contact.call('contact_users_search', { keywords: [key] })
  } catch (error) {
    log('warn', `查通讯录换会话 ID 失败：${error?.message || error}`)
    return ''
  }

  const users = Array.isArray(r?.users) ? r.users : []
  if (users.length !== 1) {
    log('warn', `查通讯录换会话 ID：命中 ${users.length} 条，不敢用（只接受唯一命中）。`)
    return ''
  }
  const one = users[0]
  const matched = Array.isArray(one?.matched_keywords) ? one.matched_keywords.map(String) : []
  const exact = matched.includes(key) || String(one?.userid || '') === key
  if (!exact) {
    log('warn', `查通讯录换会话 ID：命中的是「${one?.name || '?'}」（matched_keywords=${matched.join('、') || '空'}），和要查的 ${key} 对不上，不敢用。`)
    return ''
  }

  const real = String(one?.userid || '').trim()
  if (!real) {
    log('warn', '查通讯录换会话 ID：命中了但没有 userid 字段。')
    return ''
  }
  cache.set(key, real)
  log('info', `会话 ID 换算好了：${key} → ${real}（这个企业的单聊 chat_id 不是 userid）`)
  return real
}

/**
 * 用 chat_id 调一个企微接口，撞上「非法的 chat_id」就换算一次再重试。
 *
 * @param {(chatId: string) => Promise<any>} run 真正发请求的函数，参数是要用的 chat_id
 * @param {object} o
 * @param {string} o.chatId  原本要用的 chat_id
 * @param {Function} o.mcpFor
 * @param {Function} [o.log]
 * @param {string} [o.what]  日志里怎么称呼这件事
 * @returns {Promise<any>}
 */
export async function withChatId(run, { chatId, mcpFor, log: logRaw, what = '发送', trace } = {}) {
  const log = asLog(logRaw)
  // trace 是可选的「回执」：把这次到底用了哪个 id 写回调用方。
  // 为什么要这个 —— 成功日志里必须写出真实会话 id，
  // 否则「换算之后到底发给了谁」在日志里查不出来（2026-11-28 珊瑚那台就是这么卡住的）。
  // 用回执对象而不是改返回值：五个调用点都指望 run() 的原始返回，动它等于全改。
  const note = trace && typeof trace === 'object' ? trace : null
  try {
    const r = await run(chatId)
    if (note) {
      note.chatId = chatId
      note.swapped = false
    }
    return r
  } catch (error) {
    if (!isInvalidChatId(error)) throw error
    const real = await lookupChatId(chatId, { mcpFor, log: logRaw })
    if (!real || real === chatId) throw error
    log('info', `${what}：这个企业的单聊会话 ID 和 userid 不是一个值，已换成 ${real} 重试。`)
    const r = await run(real)
    if (note) {
      note.chatId = real
      note.swapped = true
    }
    return r
  }
}
