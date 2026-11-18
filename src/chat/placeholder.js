// 占位：收到消息先回一句（文字 / 图片 / 都发）
//
// 为什么要这个东西：企微没有「正在输入」提示（caps.typing = false），
// 合并窗口 + 模型跑一轮要好幾秒，这期间一个字都没有，对方会以为没发出去。
//
// 三种配法（面板「功能」栏同一个卡片里）：
//   只配文字 → 发文字
//   只配图片 → 发图片
//   两个都配 → 先发文字，再发图（都发）
//   都不配 / 都关 → 彻底安静
//
// ⚠ 图片的硬约束（真机验证过）：企微长连接只认 media_id，没有 URL 通道。
//   media_id 只能拿 media_upload 换，而 media_upload 在 disk / mail / doc 服务里。
//   → 没配这三个服务之一的人，图发不出去，只能发文字。
//   这不是本插件能绕的，所以失败时降级成「只发文字」，并且在日志里说清原因，
//   而不是让用户以为发了图。
//
// 通道分工：
//   文字 → 被动回复 aibot_respond_msg（带原回调 req_id，最稳）
//   图片 → 主动推送 aibot_send_msg（占位只在收到消息时触发，会话必然已激活；
//          也避免同一个 req_id 回两次）

import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { uploadMedia, isImagePath, MAX_FILE_BYTES } from '../wecom/outbound.js'
import { asLog, fireAndForget, messageOf } from '../core/safe.js'

const DEFAULT_TEXT = 'emmm...'
/** media_id 缓存：同一张图别每条消息都重传一遍 */
const MEDIA_TTL_MS = 30 * 60 * 1000
/**
 * 失败冷却：别每条消息都去读一遍大图、压一遍、再失败一次。
 *
 * 但冷却时长必须看错误性质，一刀切是错的：
 *   · 图本身有问题（太大 / 格式不对）→ 换张图才能好，冷却久点没损失
 *   · 外部一时抽风（授权过期、网络、限流）→ 用户可能自己就修好了
 *     （实测：企微授权过期 850003，用户点完授权当场就好了，
 *      而我们还在静默 10 分钟，他发消息没图，只当插件坏了）
 */
const COOLDOWN_LOCAL_MS = 10 * 60 * 1000   // 确定性错误：图的问题
const COOLDOWN_REMOTE_MS = 30 * 1000       // 瞬时错误：等下一次就重试

/**
 * 判断这次失败是「我们自己/图的问题」还是「外面一时不顺」。
 *
 * 判错的方向很重要：宁可短冷却多试几次，也别让用户修好了还发不出去。
 * 反过来的代价只是多花几毫秒读一次图。
 */
export function isRemoteFailure(error) {
  const text = messageOf(error)
  const code = Number(error?.code ?? error?.errcode ?? NaN)
  // 企微侧错误码：850003 授权过期、40001/42001 token 失效、45009 限流、
  // 60020 IP 不在白名单、-1 系统繁忙
  if ([850003, 40001, 42001, 45009, 60020, -1].includes(code)) return true
  return /authorization expired|授权|过期|限流|rate limit|too many|timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|fetch failed|network|socket|socket hang up/i.test(text)
}

export function createPlaceholder({ getConfig, getClient, mcpFor, log: logRaw, cooldowns }) {
  // 外面传 logger 对象（host.js 传的就是 logger.child()）还是 (level, text) 函数都能吃。
  // 以前这里直接按函数调 log?.(...)，而 host 传的是对象 → TypeError。
  const log = asLog(logRaw)
  // 只给测试用：真实冷却动辄几分钟，测试要能在毫秒级里观察「到点有没有恢复」
  const coolLocal = cooldowns?.local ?? COOLDOWN_LOCAL_MS
  const coolRemote = cooldowns?.remote ?? COOLDOWN_REMOTE_MS
  let cached = null // { key, mediaId, at }
  let failUntil = 0
  let failReason = ''

  function cfgOf() {
    const c = getConfig() || {}
    return c.merge || {}
  }

  function textOf(m) {
    if (m.placeholderOn === false) return ''
    return String(m.placeholder || DEFAULT_TEXT)
  }

  function imageOf(m) {
    if (m.placeholderImageOn === false) return ''
    return String(m.placeholderImage || '').trim()
  }

  /** 图 + 路径进缓存键：换了图、或者同一个路径被覆盖了，都要重传 */
  async function mediaIdFor(path) {
    const st = await stat(path).catch(() => null)
    if (!st || !st.isFile()) throw new Error(`占位图不存在：${path}`)
    if (st.size > MAX_FILE_BYTES) {
      throw new Error(`占位图 ${(st.size / 1048576).toFixed(1)} MB，超过 ${MAX_FILE_BYTES / 1048576} MB 上限`)
    }
    const key = `${path}|${st.size}|${st.mtimeMs}`
    if (cached && cached.key === key && Date.now() - cached.at < MEDIA_TTL_MS) return cached.mediaId

    const buffer = await readFile(path)
    const up = await uploadMedia({ buffer, fileName: basename(path), type: 'image' }, { mcpFor, log })
    cached = { key, mediaId: up.mediaId, at: Date.now() }
    return up.mediaId
  }

  async function sendImage(client, chat, path) {
    // 冷却中直接返回。注意：这里【必须】写日志 —— 以前静默 return，
    // 用户发了消息没图，日志里也一行都没有，谁都查不出为什么。
    if (Date.now() < failUntil) {
      log('debug', `占位图冷却中，还剩 ${Math.ceil((failUntil - Date.now()) / 1000)} 秒（上次失败：${failReason}）`)
      return
    }
    if (!isImagePath(path)) {
      failReason = `占位图不是图片格式：${extname(path)}`
      failUntil = Date.now() + coolLocal
      log('warn', failReason)
      return
    }
    try {
      const mediaId = await mediaIdFor(path)
      // 两条通道，优先走真机验证过的那条：
      //   ① MCP message_aibot_send（真机报告里唯一验证过能发图的出站通道）
      //   ② 长连接 aibot_send_msg 的 image 帧（文档里认 media_id，但没真机验证）
      // 注意两边字段名不是一套：MCP 是 chat_id/msg_type，长连接是 chatid/chat_type/msgtype。
      const msg = await mcpFor?.('msg')
      if (msg) {
        await msg.call('message_aibot_send', {
          chat_id: chat.chatId,
          msg_type: 'image',
          image: { media_id: mediaId },
        })
      } else {
        await client.send(chat.chatId, chat.kind === 'group' ? 2 : 1, {
          msgtype: 'image',
          image: { media_id: mediaId },
        })
      }
      failReason = ''
    } catch (error) {
      failReason = messageOf(error)
      const remote = isRemoteFailure(error)
      const cooldown = remote ? coolRemote : coolLocal
      failUntil = Date.now() + cooldown
      // 瞬时故障多发一次 warn 带秒数，用户看日志就知道「等下会重试」；
      // 图本身的问题才是真需要人去处理，所以也说清换图就能好。
      log('warn', `占位图没发出去：${failReason}`
        + `（${remote ? '外部一时不通' : '这张图本身发不了'}，${Math.round(cooldown / 1000)} 秒内不再重试）`
        + (remote ? '' : ' 换一张图就能恢复。'))
    }
  }

  /**
   * 收到第一条消息时立刻调用。
   * 文字同步发（快），图片异步发（要上传，慢），互不阻塞。
   */
  function fire(frame, chat) {
    const m = cfgOf()
    const text = textOf(m)
    const image = imageOf(m)
    if (!text && !image) return

    const client = getClient?.()
    if (!client) return
    const reqId = frame?.headers?.req_id

    // ⚠ 两条都必须挂 catch：这里是 setTimeout / 收消息回调里发起的，
    //   没人接的拒绝 = unhandledRejection = 整个 DSH 进程被 Node 杀掉。
    if (text && reqId) {
      fireAndForget(
        client.respond(reqId, { msgtype: 'markdown', markdown: { content: text } }),
        '占位文字发送',
        log,
        'debug',
      )
    }
    if (image) fireAndForget(sendImage(client, chat, image), '占位图发送', log)
  }

  return {
    fire,
    /** 面板自检用：现在能不能发图（不能就说明原因） */
    get lastImageError() { return failReason },
  }
}
