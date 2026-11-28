// 预回复：收到消息先回一句（文字 / 图片 / 都发）
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
//   图片 → 主动推送 aibot_send_msg（预回复只在收到消息时触发，会话必然已激活；
//          也避免同一个 req_id 回两次）

import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { uploadMedia, isImagePath, MAX_FILE_BYTES } from '../wecom/outbound.js'
import { withChatId } from '../wecom/chatid.js'
import { helpUrl } from '../wecom/mcp.js'
import { asLog, fireAndForget, messageOf } from '../core/safe.js'

const DEFAULT_TEXT = 'emmm...'
/** media_id 缓存：同一张图别每条消息都重传一遍 */
const MEDIA_TTL_MS = 30 * 60 * 1000
/**
 * 瞬时故障冷却：网络抖、限流、企微一时抽风。这类会自己好，短等一次就重试。
 *
 * ⚠ 这里【没有】「图的问题」那一档，故意的。
 * 以前有个 10 分钟档，来历是「别每条消息都试一遍把日志刷满」（见 a6c24ca）。
 * 但那个痛点的前提是「每条失败都写一行 warn」，而现在去重按「同一件事」算，
 * 不再按时间丢 —— 于是那 10 分钟纯粹是副作用：
 *   · 用户换了一张完全正常的图，还要等十分钟才发得出去
 *   · 冷却期间的日志是 debug，默认不输出，用户连「为什么」都看不到
 * 换成「同一张图只失败一次」（见 failedKey）后，重复劳动一样省下了，
 * 而换图立刻恢复。精确的东西不需要拿时间兜。
 */
const COOLDOWN_REMOTE_MS = 30 * 1000       // 瞬时错误：等下一次就重试

/**
 * 判断这次失败是「我们自己/图的问题」还是「外面一时不顺」。
 *
 * 判错的方向很重要：宁可短冷却多试几次，也别让用户修好了还发不出去。
 * 反过来的代价只是多花几毫秒读一次图。
 */
export function isRemoteFailure(error) {
  // 但「授权过期」是个例外：它不是抖动，人不去点授权，重试一万次都一样。
  // 以前把它算瞬时故障，结果每 30 秒白打一次接口、日志刷一行 warn，
  // 而用户那边只会觉得「这插件坏了」。授权类单独归为 needAuth。
  if (isAuthFailure(error)) return false
  const text = messageOf(error)
  const code = Number(error?.code ?? error?.errcode ?? NaN)
  // 企微侧错误码：40001/42001 token 失效、45009 限流、
  // 60020 IP 不在白名单、-1 系统繁忙
  if ([40001, 42001, 45009, 60020, -1].includes(code)) return true
  return /限流|rate limit|too many|timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|fetch failed|network|socket|socket hang up/i.test(text)
}

/** 授权过期：必须人去点一下授权，重试无用 */
export function isAuthFailure(error) {
  const code = Number(error?.code ?? error?.errcode ?? NaN)
  if (code === 850003) return true
  return /authorization expired|not authorized|未授权|权限已过期/i.test(messageOf(error))
}

/**
 * 把失败分到五类里。分类的意义不在分类本身，在于**决定怎么对用户说**：
 * 说错了比不说更坏 —— 用户会照着错误的建议去处理，做完了还是不行。
 *
 * 以前这里是二分（外部抖 / 不是外部抖），非外部抖动的一律当成「这张图发不了，
 * 换一张就能恢复」。可「没配 MCP」「会话没了」这些都掉进那个兜底，
 * 用户换了十张图也不会好。现在把「图的锅」缩小到只有真能证明是图的问题，
 * 剩下认不出的老实说认不出。
 */
export function classifyFailure(error) {
  const code = String(error?.code ?? error?.errcode ?? '')
  const text = messageOf(error)
  if (isAuthFailure(error)) return 'auth'
  // 配置缺失：填好配置下一条消息就能发，跟图一点关系都没有
  if (code === 'no_mcp' || code === 'no_msg_mcp') return 'config'
  if (/没配 MCP/.test(text)) return 'config'
  // 图自身：太大了、压到极限还超、文件没了、不是图片
  // 正则里新旧两种叫法都认：「占位图」是这功能原来的名字，
  // 外部模块（media.js 的预览说明）和历史日志里还会有，只认新名会漏判。
  if (code === 'image_too_large' || code === 'no_file') return 'image'
  if (/(?:占位|预回复)图(?:不存在|不是图片格式)|超过 .* 上限|超过企微图片上限/.test(text)) return 'image'
  // 会话本身：chat_id 无效 / 会话不存在。换图一万次都没用
  if (/chat_?id|会话不存在|会话已失效|invalid chat/i.test(text)) return 'chat'
  if (isRemoteFailure(error)) return 'remote'
  return 'unknown'
}

/**
 * 按分类给一句人话。三条硬规矩：
 *   · 只有 image 类才允许说「换一张图」——它是唯一换图真能解决的类
 *   · config / chat 类必须明说「换图没用」，否则用户会在错的方向上折腾
 *   · unknown 老实说不知道，别假装知道
 */
export function describeFailure(error, kind) {
  const raw = messageOf(error)
  switch (kind) {
    case 'auth':
      return '企微说这个机器人的「消息」权限过期了，去企业微信重新授权一下（没授权之前发不了图）'
    case 'config':
      // 配置缺东西时最容易被误判成「图不行」——用户换十张图也不会好，
      // 所以这句话里必须明确把「换图」这条路堵死。
      return `${raw}（这是配置问题，换图没用）`
    case 'image':
      return `这张图本身发不出去：${raw}（换一张图就会重新试）`
    case 'chat':
      // 40073「非法的 chat_id」说的是「这个值形态不对」，不是「会话没了」。
      // 原来的文案让人去查会话在不在，是误诊 —— 真因是有些企业单聊的 chat_id 不是 userid。
      return `企微不认这个会话 ID：${raw}（换图没用。这个企业的单聊会话 ID 和 userid 不是一个值，` +
        '插件已经去通讯录换过一次还是没对上 —— 要么没配 MCP 的 contact 服务，要么这个人还没跟机器人说过话）'
    case 'remote':
      return `外部一时不通：${raw}（等会儿会自动重试）`
    default:
      return `预回复图没发出去：${raw}（没认出是哪类问题，先按这句报错查）`
  }
}

export function createPlaceholder({ getConfig, getClient, mcpFor, log: logRaw, cooldowns }) {
  // 外面传 logger 对象（host.js 传的就是 logger.child()）还是 (level, text) 函数都能吃。
  // 以前这里直接按函数调 log?.(...)，而 host 传的是对象 → TypeError。
  const log = asLog(logRaw)
  // 只给测试用：真实冷却动辄几分钟，测试要能在毫秒级里观察「到点有没有恢复」
  const coolRemote = cooldowns?.remote ?? COOLDOWN_REMOTE_MS
  let cached = null // { key, mediaId, at }
  let failUntil = 0
  let failReason = ''
  /**
   * 上一张「已经确认发不出去」的图（键是 path+size+mtime）。
   * 同一个键不再重试 —— 这是旧 10 分钟冷却真正想干的事，但做成精确的：
   * 换图（键变了）立刻恢复，不用等；同一张图则永远不再白撞。
   */
  let failedKey = ''
  /** 已经为哪一类原因警告过。同一类只警告一次，避免刷屏又不丢信息 */
  let warnedKind = ''
  /** 最近一次失败属于哪一类（图自身 / 授权 / 网络 / 配置 / 会话 / 认不出） */
  let failKind = ''
  /** 授权过期时企微给的授权入口（面板要渲染成可点按钮，光一行红字没人知道去哪点） */
  let authHint = ''

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
    if (!st || !st.isFile()) throw new Error(`预回复图不存在：${path}`)
    if (st.size > MAX_FILE_BYTES) {
      throw new Error(`预回复图 ${(st.size / 1048576).toFixed(1)} MB，超过 ${MAX_FILE_BYTES / 1048576} MB 上限`)
    }
    const key = `${path}|${st.size}|${st.mtimeMs}`
    if (cached && cached.key === key && Date.now() - cached.at < MEDIA_TTL_MS) return cached.mediaId

    const buffer = await readFile(path)
    const up = await uploadMedia({ buffer, fileName: basename(path), type: 'image' }, { mcpFor, log })
    cached = { key, mediaId: up.mediaId, at: Date.now() }
    return up.mediaId
  }

  /**
   * 失败时的现场快照。给两拨人看：
   *   · 用户 —— 面板上那行「上次发图失败」要能说清是什么问题
   *   · 我们 —— 事后查日志，得知道当时图多大、走没走 MCP、有没有缓存
   * 之所以要一次抓全：用户往往是过很久才想起「昨天没发出去」，那时环境早变了。
   */
  async function describeContext(path, st, error, kind) {
    const parts = [`这张图：${path}`]
    if (st && st.isFile()) parts.push(`大小 ${(st.size / 1048576).toFixed(2)} MB`)
    else parts.push('文件读不到（不存在或没权限）')
    parts.push(`按 ${kind} 类处理`)
    if (cached && cached.mediaId) parts.push(`media_id 有缓存（${cached.mediaId.slice(0, 12)}…）`)
    let upload = '未知'
    try {
      const ready = await Promise.resolve(mcpFor?.('disk') || mcpFor?.('mail') || mcpFor?.('doc'))
      upload = ready ? '有 disc/mail/doc 之一' : '没配 disc/mail/doc 任一服务'
    } catch (e) {
      upload = `查上传通道时出错：${e?.message || e}`
    }
    parts.push(`上传通道：${upload}`)
    return parts.join('，')
  }

  async function sendImage(client, chat, path) {
    // 同一张图已经确认发不出去：不再重试，也不再刷日志。
    // 换图（size/mtime 变了）键就变，立刻恢复 —— 见 failedKey 的注释。
    const st = await stat(path).catch(() => null)
    const key = st && st.isFile() ? `${path}|${st.size}|${st.mtimeMs}` : `${path}|missing`
    if (key === failedKey) {
      log('debug', `预回复图这张已经试过发不出去，跳过（换一张就会重试）：${path}`)
      return
    }
    // 瞬时故障的短冷却（网络/限流），过点就重试
    if (Date.now() < failUntil) {
      log('debug', `预回复图冷却中，还剩 ${Math.ceil((failUntil - Date.now()) / 1000)} 秒（上次失败：${failReason}）`)
      return
    }
    if (!isImagePath(path)) {
      failedKey = key
      failKind = 'image'
      warnedKind = 'image'
      failReason = `预回复图不是图片格式：${extname(path)}`
      log('warn', failReason + '（换一张能发的图就会重新试）')
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
        // 单聊 chat_id 有些企业要的是加密串，不是回调里那个 from.userid。
        // 撞上「非法的 chat_id」才去通讯录换一次再重发，平时零额外请求。
        await withChatId(
          (id) => msg.call('message_aibot_send', {
            chat_id: id,
            msg_type: 'image',
            image: { media_id: mediaId },
          }),
          { chatId: chat.chatId, mcpFor, log, what: '预回复图' },
        )
      } else {
        await withChatId(
          (id) => client.send(id, chat.kind === 'group' ? 2 : 1, {
            msgtype: 'image',
            image: { media_id: mediaId },
          }),
          { chatId: chat.chatId, mcpFor, log, what: '预回复图（长连接）' },
        )
      }
      failReason = ''
      authHint = ''
      failedKey = ''
      warnedKind = ''
      failKind = ''
    } catch (error) {
      const kind = classifyFailure(error)
      failReason = describeFailure(error, kind)
      failKind = kind
      if (kind === 'image') {
        // 图自身的问题：记住这张图，换图才重试。不设时间冷却。
        failedKey = key
        failUntil = 0
      } else if (kind === 'remote') {
        // 只有「等一等可能就好」的情况才值得冷却：网络抖动、限流。
        // 冷却期内不重试，避免抖动期里每条消息都去撞一次接口。
        failedKey = ''
        failUntil = Date.now() + coolRemote
      } else {
        // 授权 / 配置 / 会话 / 认不出：等多久都不会自己好，是等人去动手的。
        // 这类一冷却就变成「修好了还发不出去」，正是用户抱怨的那个坑。
        // 日志刷屏由 warnedKind 管，不该拿时间窗去替代。
        failedKey = ''
        failUntil = 0
      }
      authHint = kind === 'auth' ? helpUrl(error) : ''
      // 现场快照：图多大、通道通不通、有没有缓存。一次抓全，
      // 因为用户往往过很久才回头看，那时环境早变了，事后复现不出来。
      const detail = await describeContext(path, st, error, kind)
      if (warnedKind !== kind) {
        warnedKind = kind
        log('warn', `${failReason}\n${detail}` + (authHint ? `\n授权入口：${authHint}` : ''))
      } else {
        // 同类再次失败不重复警告（刷屏），但现场照记 —— 用 info 而不是 debug，
        // 因为 debug 默认不输出，而「自动留下证据」正是要用户什么都不做也能查到。
        log('info', `预回复图还是同一类问题（${kind}）：${failReason}\n${detail}`)
      }
      // 给真要断案的人：完整堆栈。这条走 debug（默认不写），
      // 开了「详细日志」才有；上面两条默认就有，够定位大部分问题了。
      log('debug', `预回复图失败堆栈（${kind}）：${error?.stack || error?.message || String(error)}`)
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
        '预回复文字发送',
        log,
        'debug',
      )
    }
    if (image) fireAndForget(sendImage(client, chat, image), '预回复图发送', log)
  }

  return {
    fire,
    /** 面板自检用：现在能不能发图（不能就说明原因） */
    get lastImageError() { return failReason },
    /** 上次失败的类别（面板据此决定提示哪一句） */
    get lastImageKind() { return failKind },
    /** 上次发图失败的授权入口（没有就是空串） */
    get lastImageAuthUrl() { return authHint },
  }
}
