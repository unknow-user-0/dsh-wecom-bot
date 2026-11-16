// WeCom Bot · 宿主半边（DSH 插件入口）
//
// 让 DSH 里的 AI 以企业微信智能机器人的身份住在企微里：
//   企微智能机器人（长连接）⇄ 本插件 ⇄ DSH 会话（自带三个 preset + 人格）
// 面板在侧栏（网页半边见 client/client.js），这里提供它要的 /wecom-bot/api/* 接口。
//
// 这个文件只管装配：配置、长连接、聊天中枢、人格变量、工具挂载、面板接口。
// 具体能力都在 src/ 下面分好了：wecom/（协议）、chat/（会话）、memory/、persona/、core/。
//
// ⚠ 安全默认：总开关关。不手动打开，一句都不会真的发到企微。

import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname, basename, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'

import { loadConfig, saveConfig, publicConfig, merge, DATA_DIR } from './core/config.js'
import { createLogger, recentLogs, redact } from './core/logger.js'
import { record as recordActivity, recentEntries, chatStats, flushLog } from './core/activity.js'
import { createVault, mcpRef } from './core/vault.js'
import { checkQuota, addUsage, tickMinute, usageSnapshot, resetUsage, estimateTokens } from './core/quota.js'
import { createWecomClient, WecomApiError, WecomUncertainError } from './wecom/client.js'
import { createMcpClient, MCP_SERVICES, validateMcpUrl } from './wecom/mcp.js'
import { createHub, WORKSPACE_TITLE } from './chat/hub.js'
import { checkAccess, autoRegister, deniedReply } from './chat/access.js'
import { createMerger } from './chat/merge.js'
import { normalizeInbound, attachInboundImage, attachInboundFile } from './chat/inbound.js'
import { listPersonas, readPersona, savePersona, deletePersona, personaText, rulesText } from './persona/personas.js'
import * as memory from './memory/store.js'
import { buildTools } from './tools/wecom.js'
import { buildBrowserTools } from './tools/browser.js'
import { buildVideoTools } from './tools/video.js'
import { createBrowserManager } from './browser/manager.js'
import { createVideoLogin } from './video/login.js'
import { createAsr } from './video/asr.js'

export const name = 'wecom-bot'
export const inject = ['agents', 'sessions', 'webServer', 'timer', 'workspaceRegistry', 'attachments', 'systemPrompt']

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = (() => { try { return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) } catch { return { version: '?' } } })()
const VERSION = PKG.version
const PREFIX = '/wecom-bot/api'
const nodeRequire = createRequire(import.meta.url)

/** existsSync 的静默版：沙箱没权限时当不存在处理，别把面板请求打挂 */
const safeExists = (p) => { try { return existsSync(p) } catch { return false } }

/** 模型这一轮不想说话时的约定 */
const SILENCE = '[沉默]'

export function apply(ctx) {
  const logger = createLogger({ dsh: ctx })
  const log = logger.child('core')
  let cfg = loadConfig()
  const getConfig = () => cfg
  const secrets = createVault(ctx, log)

  // ---------- 人格与规则：注入到三个 preset 的提示词变量 ----------
  const variable = (n, fn) => ctx.effect(() => ctx.systemPrompt.variable(n, fn), `wecom-bot: 变量 ${n}`)
  variable('wecom_persona', () => personaText(cfg))
  variable('wecom_rules_owner', () => rulesText('owner', cfg))
  variable('wecom_rules_social', () => rulesText('social', cfg))
  // 记忆与场景提示：每轮都拼，但内容短（只放高相关的几条）
  variable('wecom_context', () => contextLineOf())

  // ---------- 会话中枢 ----------
  const hub = createHub({ ctx, log: logger.child('hub'), getConfig })
  /** sessionId → chat（工具里靠它找会话） */
  const sessionChat = new Map()
  /** sessionId → 这一轮的回复状态 */
  const turnState = new Map()

  // ---------- 网页操作（专用浏览器 + 登录态） ----------
  // 只在用到时才启动浏览器，光开面板不会弹窗。
  const browser = createBrowserManager({
    dataDir: DATA_DIR,
    getConfig,
    log: logger.child('browser'),
  })
  ctx.effect(() => () => { try { browser.shutdown() } catch {} }, 'wecom-bot: 关浏览器')

  // ---------- 视频站登录（抖音 / B站） ----------
  // 上游 yt-dlp 只认 Netscape 格式的 cookies.txt。这里把「用专用浏览器登录一次，
  // 然后把 cookie 导出来喂给 yt-dlp」做成面板上的按钮，省得用户去翻 F12。
  const videoLogin = createVideoLogin({
    dataDir: DATA_DIR,
    getBrowser: () => browser,
    log: logger.child('video-login'),
  })

  // ---------- 语音转文字 ----------
  // 上游的台词层靠一个 OpenAI 兼容端点，没配就「看得见图、听不见声音」，且静默降级。
  // 这里把那条隐形依赖做成面板上看得见、点得动的东西。
  const asr = createAsr({
    log: logger.child('asr'),
    // 宿主自带语音服务时根本不用装 whisper；ctx.get 是 cordis 的安全取法
    getHostService: () => { try { return ctx.get?.('speechToText') } catch { return undefined } },
    // 插件的 cwd 不是用户工作区，把真正的工作区路径递进去，才能找到旁边的 asr/ 目录
    getExtraDirs: () => {
      const dir = String(cfg.workspaceDir || '').trim()
      return dir ? [dir] : []
    },
  })

  // ---------- 心情与主动搭话 ----------

  // ---------- MCP 客户端池 ----------
  const mcpPool = new Map() // ref → client

  function adminList() { return cfg.admins || [] }
  function serviceUrlOf(service, userid) {
    const pick = (a) => (a && a.mcp && a.mcp[service]) || ''
    if (userid) {
      const a = adminList().find((x) => x.userid === userid)
      if (a && pick(a)) return { url: pick(a), userid }
    }
    // 没指定人：先用 owner 的，再退第一个配了的
    const owner = adminList().find((a) => a.role === 'owner')
    if (owner && pick(owner)) return { url: pick(owner), userid: owner.userid }
    for (const a of adminList()) if (pick(a)) return { url: pick(a), userid: a.userid }
    return null
  }

  /** 拿某个服务的 MCP 客户端；没配就返回 null（工具据此降级） */
  async function mcpFor(service, userid) {
    const found = serviceUrlOf(service, userid)
    if (!found) return null
    const ref = mcpRef(service, found.userid)
    const cached = mcpPool.get(ref)
    if (cached) return cached
    const url = await secrets.resolve(ref)
    if (!url) return null
    const client = createMcpClient(url, { log: logger.child('mcp:' + service) })
    mcpPool.set(ref, client)
    return client
  }

  // ---------- 长连接 ----------
  let client = null
  let connState = { connected: false, kicked: false, reason: '未启动' }
  let everConnected = false // 首次连上不补拉；断开后再连上才补
  // secret 是异步从凭据库拿的；这里留一份同步镜像，供 /state 与就绪判断用
  let secretCache = ''

  async function refreshSecret() {
    try {
      secretCache = (await secrets.resolve('WECOM_BOT_SECRET')) || ''
    } catch {
      secretCache = ''
    }
    return secretCache
  }

  function connectionReady() {
    return Boolean(cfg.botId && secretCache)
  }

  function makeClient() {
    const c = createWecomClient({
      botId: cfg.botId || '',
      secret: secretCache,
      // 开发期可以指向本地假服务，照企微帧格式造假数据；正式用一律走官方地址
      wsUrl: process.env.DSH_WECOM_WS_URL || undefined,
      // client 内部按 (level, text) 调；转成我们 logger 的 (level, text)
      log: (level, text) => {
        const fn = typeof log[level] === 'function' ? log[level] : log.info
        fn.call(log, String(text ?? level))
      },
    })
    c.onState((s) => {
      const wasConnected = connState.connected
      connState = { ...connState, ...s }
      log.info(`连接状态：${s.connected ? '已连接' : '断开'}${s.reason ? '（' + s.reason + '）' : ''}`)
      // 从断开 → 已连接：断线期间的消息企微不会重发，自己去补。
      // 首次连接不补（那时还没有会话记录，也没什么可补的）。
      if (s.connected && !wasConnected && everConnected) {
        void resyncAll(s.reason || '重连').catch(() => {})
      }
      if (s.connected) everConnected = true
    })
    c.onMessage((frame) => { void onInbound(frame) })
    c.onEvent((frame) => { onEventCallback(frame) })
    return c
  }

  async function startConnection() {    if (!cfg.enabled) return { ok: false, message: '总开关没开' }
    if (!secretCache) await refreshSecret()
    if (!connectionReady()) return { ok: false, message: '还没填 bot_id 和 secret' }
    if (client) return { ok: Boolean(client.connected), message: client.connected ? '已连接' : '连接中' }
    client = makeClient()
    try {
      await client.connect()
      return { ok: true, message: '已连接' }
    } catch (error) {
      log.warn(`连接失败：${error.message}`)
      return { ok: false, message: error.message }
    }
  }

  async function stopConnection() {
    if (!client) return
    try { await client.disconnect() } catch {}
    client = null
    connState = { connected: false, kicked: false, reason: '已停止' }
  }

  ctx.effect(() => {
    // 先把凭据库里已有的 secret 预热进内存，/state 与就绪判断都是同步读的
    void refreshSecret().then(() => {
      if (cfg.enabled) return startConnection()
      return undefined
    }).catch(() => {})
    return () => { void stopConnection() }
  }, 'wecom-bot: 长连接')

  // ---------- 一轮回复：盯会话事件 ----------
  function textOf(message) {
    if (!message || !Array.isArray(message.content)) return ''
    return message.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim()
  }

  function isSilence(text) {
    const t = String(text || '').trim()
    return t === '' || t === SILENCE || t === '［沉默］' || t === '(沉默)' || t === '（沉默）'
  }

  /** markdown 收尾：企微 markdown 只支持很小子集，别的原样留着也不报错 */
  function clip(text, max = 6000) {
    const t = String(text || '')
    return t.length <= max ? t : t.slice(0, max - 20) + '\n\n（后面太长了，截断）'
  }

  function onSessionEvent(session, event) {
    const sid = session?.id
    if (!sid) return
    const st = turnState.get(sid)
    if (!st) return

    if (event.type === 'assistant/message') {
      const d = event.data || {}
      if (d.interrupted) return
      const t = textOf(d.message)
      if (t) { st.lastTurn = d.turn; st.text = t }
      return
    }

    if (event.type === 'turn/end') {
      const d = event.data || {}
      const completed = d.reason && d.reason.kind === 'completed'
      const text = st.lastTurn === d.turn ? st.text : ''
      const frame = st.frame
      turnState.delete(sid)
      if (!completed) {
        const detail = String(d.reason?.error?.message || d.reason?.failure?.message || '').replace(/\s+/g, ' ').slice(0, 180)
        log.warn(`${st.chat.chatId} 这一轮没正常结束（${d.reason?.kind || '?'}${detail ? '：' + redact(detail) : ''}）`)
        void replyTo(frame, '这次没跑完，出错了。再试一次？')
        return
      }
      if (isSilence(text)) {
        log.info(`${st.chat.chatId} 这一轮不说话`)
        void replyTo(frame, '', true)
        return
      }
      void replyTo(frame, clip(text))
    }
  }

  ctx.effect(() => {
    const off = ctx.on('session/event', (session, event) => {
      try { onSessionEvent(session, event) } catch (error) { log.warn(`会话事件处理出错：${error.message}`) }
    })
    return () => { try { if (typeof off === 'function') off() } catch {} }
  }, 'wecom-bot: 盯会话')

  /** 把模型这一轮的话发出去（走被动回复，必须带原回调 req_id） */
  async function replyTo(frame, text, silent = false) {
    const reqId = frame?.headers?.req_id
    if (!reqId) { log.warn('没有 req_id，发不出去'); return }
    if (silent) return
    try {
      await client?.respond(reqId, { msgtype: 'markdown', markdown: { content: text } })
      recordActivity({ kind: 'out', chatId: frame.__chatId || '', text, name: frame.__chatName || '' })
    } catch (error) {
      log.error(`回复失败：${error.message}`)
    }
  }

  // ---------- 记忆上下文（每轮拼一小段）----------
  function contextText() {
    try {
      if (!cfg.features.memory) return ''
      const s = memory.stats()
      if (!s.total) return ''
      return [
        '【你有记性】',
                '你记得住谁说过什么（用 wecom_memory 主动回忆/记录）。',
        '召回时如果某条标注是从别的群/别的地方听来的，那件事不要当成当前这个群的公开信息到处讲。',
      ].join('\n')
    } catch { return '' }
  }

  /** 每轮拼的一小段上下文（记忆提示，很短） */
  function contextLineOf() {
    return contextText()
  }

  // ---------- 收消息 ----------
  const merger = createMerger({
    log: logger.child('merge'),
    onPlaceholder: (frame, text) => {
      const reqId = frame?.headers?.req_id
      if (!reqId) return
      void client?.respond(reqId, { msgtype: 'markdown', markdown: { content: text } }).catch(() => {})
    },
    onFlush: (frame, items) => handleBatch(frame, items),
  })

  async function handleBatch(frame, items) {
    const first = items[0]
    const chat = first.chat
    const merged = items.map((i) => i.text).filter(Boolean).join('\n')
    if (!merged.trim()) {
      await replyTo(frame, '看到你发的附件了，但内容没能读出来。再发一次试试？')
      return
    }

    // 额度
    const chatKey = `${chat.kind}:${chat.chatId}`
    const isAdmin = cfg.admins.some((a) => a.userid === chat.userId)
    const q = checkQuota(cfg, chatKey, isAdmin)
    if (!q.ok) {
      await replyTo(frame, q.text)
      return
    }

    // 会话准备
    chat.isAdmin = isAdmin
    chat.name = chat.kind === 'group' ? chat.groupName : chat.displayName
    frame.__chatId = chat.chatId
    frame.__chatName = chat.name || ''
    recordActivity({ kind: 'in', chatId: chat.chatId, name: chat.name, userId: chat.userId, text: merged })

    let info
    try {
      info = await hub.agentFor(chat)
    } catch (error) {
      log.error(`建会话失败：${error.message}`)
      await replyTo(frame, '我这边起会话失败了，让管理员看一眼插件日志。')
      return
    }
    const sid = info.sessionId
    sessionChat.set(sid, chat)
    // 工具按档位挂：social 档位没有文件/微盘这类能碰本机的东西
    // 必须 await —— 挂工具现在是 async（要等视频工具那批 Promise），
    // 不等的话 prompt 先跑起来，模型看到的是没有 video_* 的工具清单。
    try { await mountTools(info.agent, chat, info.level, sid) } catch (error) { log.debug(`挂工具失败：${error.message}`) }

    // 群上下文：被 @ 时先用 MCP 补一段最近消息（只在打开的群、且距上次同步够久时）
    if (chat.kind === 'group' && cfg.history.enabled && cfg.history.syncOnFirstMention) {
      void syncGroupHistory(chat, sid).catch((error) => log.debug(`补群历史失败：${error.message}`))
    }

    // 记下这一轮的状态：等 turn/end 再发
    turnState.set(sid, { chat, frame, text: '', lastTurn: -1, startedAt: Date.now(), said: merged })

    // 附件
    const attachments = []
    for (const img of first.images || []) {
      attachments.push({ type: 'image', attachment: await admitImage(img) })
    }
    let promptText = merged
    for (const f of first.files || []) {
      const p = saveInboundFile(first, f)
      if (p) promptText += `\n\n[对方发来一个文件，已存到：${p}]`
    }

    try {
      await hub.prompt(chat, promptText, { attachments: attachments.filter((a) => a && a.attachment) })
      addUsage(chatKey, estimateTokens(promptText) + 300)
      tickMinute(chatKey)
    } catch (error) {
      log.error(`投递失败：${error.message}`)
      turnState.delete(sid)
      await replyTo(frame, '我这边把消息送进会话失败了，稍后再试一次。')
    }
  }

  async function admitImage(img) {
    try {
      const content = [{ type: 'image', source: { type: 'base64', mediaType: img.mimeType, data: Buffer.from(img.data).toString('base64') } }]
      const admitted = await ctx.attachments?.admitPromptContent?.(content)
      return Array.isArray(admitted) ? admitted[0] : null
    } catch (error) {
      log.debug(`图片接不进来：${error.message}`)
      return null
    }
  }

  function saveInboundFile(message, file) {
    try {
      const dir = join(DATA_DIR, 'media')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const safe = String(file.name || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(-80)
      const p = join(dir, `${Date.now().toString(36)}-${safe}`)
      writeFileSync(p, Buffer.from(file.data))
      return p
    } catch (error) {
      log.warn(`落盘失败：${error.message}`)
      return ''
    }
  }

  // ---------- 群上下文补齐 ----------
  const lastSync = new Map() // chatId → 毫秒
  async function syncGroupHistory(chat, sid) {
    if (!cfg.history.enabled) return
    const mc = await mcpFor('msg')
    if (!mc) return
    const now = Date.now()
    const prev = lastSync.get(chat.chatId) || 0
    const minGap = Math.max(0, Number(cfg.history.syncIntervalMin) || 0) * 60_000
    const from = prev && now - prev < 6 * 86400e3 ? prev : now - Math.min(3600_000, 30 * 60_000)
    if (prev && minGap && now - prev < minGap) return
    lastSync.set(chat.chatId, now)

    const { localTime, safeWindow } = await import('./wecom/mcp.js')
    const w = safeWindow(6 * 86400e3, now)
    const begin = Math.max(from, now - 6 * 86400e3) < now - 6 * 86400e3 ? w.begin : localTime(from)
    const r = await mc.call('chat_messages_list', { chat_id: chat.chatId, begin_time: begin, end_time: w.end })
    const list = Array.isArray(r.message_list) ? r.message_list : (Array.isArray(r.messages) ? r.messages : [])
    if (!list.length) return
    const cap = Math.min(200, Number(cfg.history.maxMessages) || 30)
    const lines = list.slice(-cap).map((it) => {
      const who = it.user_name || it.userid || '某人'
      const when = String(it.send_time || '').slice(11, 16)
      const body = it.text?.content ?? `[${it.msg_type || '消息'}]`
      return `${who}（${when}）：${body}`
    })
    await hub.appendOnly(sid, `【这个群在你上次看之后又聊了这些】\n${lines.join('\n')}`, 'wecom-history')
    log.debug(`补了 ${lines.length} 条群历史（${chat.chatId}）`)
  }

  // ---------- 断线补拉 ----------
  // 断线期间的 @ 消息企微不会重发，只能重连后自己去 MCP 拉回来。
  // 只补「已经有会话的群/私聊」，且只 append 不 followup —— 不惊动模型，下一轮它自己就看到了。
  let resyncing = false
  async function resyncAll(reason) {
    if (!cfg.resync?.enabled || resyncing) return
    const mins = Math.max(5, Math.min(6 * 24 * 60, Number(cfg.resync.maxMinutes) || 120))
    const map = hub.sessionMap() || {}
    const targets = Object.entries(map).map(([key, v]) => ({ key, ...v })).filter((v) => v.sessionId)
    if (!targets.length) return
    const mc = await mcpFor('msg')
    if (!mc) {
      log.debug('断线补拉跳过：还没配 MCP 的 msg 服务')
      return
    }
    resyncing = true
    const now = Date.now()
    let total = 0
    try {
      const { localTime, safeWindow } = await import('./wecom/mcp.js')
      const w = safeWindow(6 * 86400e3, now)
      const begin = localTime(now - mins * 60_000)
      for (const t of targets) {
        const isGroup = String(t.key).includes(':group:') || Boolean(t.groupId)
        const chatId = isGroup ? (t.groupId || String(t.key).split(':').pop()) : (t.userId || String(t.key).split(':').pop())
        if (!chatId) continue
        try {
          const r = await mc.call('chat_messages_list', {
            chat_id: chatId,
            begin_time: begin < w.begin ? w.begin : begin,
            end_time: w.end,
          })
          const list = Array.isArray(r.message_list) ? r.message_list : (Array.isArray(r.messages) ? r.messages : [])
          if (!list.length) continue
          const lines = list.slice(-100).map((it) => {
            const who = it.user_name || it.userid || '某人'
            const when = String(it.send_time || '').slice(11, 16)
            const body = it.text?.content ?? `[${it.msg_type || '消息'}]`
            return `${who}（${when}）：${body}`
          })
          await hub.appendOnly(t.sessionId, `【断线期间这里还聊了这些（${reason || '重连补拉'}）】\n${lines.join('\n')}`, 'wecom-history')
          total += lines.length
        } catch (error) {
          log.debug(`补拉失败（${chatId}）：${error.message}`)
        }
      }
      if (total) log.info(`断线补拉完成：${total} 条，覆盖 ${targets.length} 个会话`)
    } finally {
      resyncing = false
    }
  }

  // ---------- 入站主流程 ----------
  async function onInbound(frame) {
    let message
    try { message = normalizeInbound(frame) } catch (error) {
      log.warn(`入站解析失败：${error.message}`)
      return
    }
    const { chat } = message

    // 附件先取（图片走 magic 校验解密，文件走严格 PKCS#7）
    if (message.msgtype === 'image') {
      await attachInboundImage(message.raw, message, { log: (lv, t) => log[lv]?.(t), requireFn: nodeRequire })
    } else if (message.msgtype === 'file' || message.msgtype === 'video') {
      await attachInboundFile(message.raw, message, { log: (lv, t) => log[lv]?.(t) })
    }

    const access = checkAccess(cfg, chat)
    if (!access.allowed) {
      log.info(`拦下一条（${access.reason}）：${chat.kind} ${chat.chatId} / ${chat.userId}`)
      await replyTo(frame, deniedReply(chat, chat.userId))
      // 管理员还没绑定任何人的话，把首个私聊者的 ID 直接告诉他，方便填进面板
      return
    }

    const added = autoRegister(cfg, chat)
    if (added) {
      saveConfig(cfg)
      log.info(`开放模式自动登记：${added.kind} ${added.name || added.id}`)
    }

    merger.push(frame, message, { config: cfg })
  }

  function onEventCallback(frame) {
    const type = frame.body?.event?.eventtype || frame.body?.eventtype || ''
    if (type === 'enter_chat') {
      const userid = frame.body?.from?.userid || ''
      log.info(`有人进入单聊会话：${userid}`)
    }
  }

  // ---------- 工具挂载 ----------
  const toolDisposers = new Map()
  function chatOfSession(sid) {
    const direct = sessionChat.get(sid)
    if (direct) return direct
    for (const [k, chat] of sessionChat) {
      if (k.endsWith(String(sid).slice(-12))) return chat
    }
    return null
  }

  // 企微自己的工具集：所有档位都能用（发消息/读历史/记忆）
  const wecomTools = buildTools({
    getConfig,
    getClient: () => client,
    mcpFor,
    memory,
    chatOfSession,
    recentMessages: (chatId, limit) => recentEntries(limit, { chatId }).reverse(),
    activity: recordActivity,
    // 「以我的身份发」的闸门要读管理员这一轮的原话
    lastText: (sid) => turnState.get(sid)?.said || '',
    log,
  })

  // 网页操作：**只有主人私聊档位给**。群聊和陌生人永远拿不到。
  // 这条不是配置项，是写死的边界 —— 一个群成员不该能操纵主人电脑上的浏览器。
  const browserTools = buildBrowserTools({ getBrowser: () => browser, getConfig, log })

  // 看视频：所有档位都能看（只是读文件/抽帧，不碰本机别的东西）。
  //
  // 存的是 **Promise 不是数组** —— 原来是 `let videoTools = []` + then 里赋值，
  // 启动后头几秒进来的消息拿到的工具清单里没有视频工具；等数组被填上，
  // 已经在跑的会话也不会重挂（mountTools 的 key 只在下次消息时才算）。
  // 改成 Promise 后 toolsFor 是 async，等它一次就永远拿到完整清单。
  const videoReady = buildVideoTools({ ctx, log })
    .catch((error) => {
      log.warn(`看视频能力没接上：${error.message}`)
      return { ok: [], failed: [], reason: `异常：${error.message}`, dir: '', ffmpeg: '' }
    })
  let videoReport = null // 给面板/自检用：挂上了什么、为什么没挂上
  void videoReady.then((r) => { videoReport = r })

  /** 给某个 agent 挂工具（工具清单变了才重挂，避免前缀缓存失效） */
  const mounted = new Map()
  async function toolsFor(level) {
    const video = await videoReady
    // 文件/微盘/画图 归「收发文件」这一个总闸管（默认开，老大定的）
    const fileish = (t) => /file|disk|draw/.test(t.name)
    if (level === 'owner') {
      const list = [...wecomTools].filter((t) => cfg.features.files || !fileish(t))
      if (cfg.features.browser) list.push(...browserTools)
      if (cfg.features.video) list.push(...video.ok)
      return list
    }
    // social（群聊 / 非管理员私聊）：只能发消息、读本会话历史、记点东西、看视频、查企微原生能力。
    // 没有文件、没有微盘、没有浏览器、没有画图。
    const list = wecomTools.filter((t) => !/file|disk|draw/.test(t.name))
    if (cfg.features.video) list.push(...video.ok)
    return list
  }
  async function mountTools(agent, chat, level, sid) {
    const list = await toolsFor(level)
    const key = list.map((t) => t.name).sort().join(',') + '|' + level
    const prev = mounted.get(sid)
    if (prev && prev.agent === agent && prev.key === key) return
    if (prev) for (const off of prev.offs) { try { off() } catch {} }
    const offs = []
    const failed = []
    for (const tool of list) {
      try {
        const off = agent.ctx.tools.register(tool)
        if (typeof off === 'function') offs.push(off)
      } catch (error) {
        failed.push({ name: tool.name, message: error.message })
        log.warn(`工具 ${tool.name} 挂不上：${error.message}`)
      }
    }
    if (failed.length) {
      // 挂不上的工具留在自检里，面板上能看到「说接上了、实际没挂上」
      videoReport = { ...(videoReport || {}), mountFailed: failed }
    }
    mounted.set(sid, { agent, key, offs })
  }

  // ---------- 面板接口 ----------
  const send = (res, code, body, type = 'application/json; charset=utf-8') => {
    try {
      res.statusCode = code
      res.setHeader?.('content-type', type)
      res.setHeader?.('cache-control', 'no-store')
      res.end?.(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
    } catch {}
  }
  const readBody = async (req) => {
    let s = ''
    try { for await (const c of req) s += c } catch {}
    try { return JSON.parse(s || '{}') } catch { return {} }
  }
  const answer = async (res, fn) => {
    try {
      const r = await fn()
      if (r !== undefined) send(res, 200, r)
    } catch (error) {
      send(res, 200, { ok: false, message: redact(String(error?.message || error)) })
    }
  }
  const route = (path, handler) => ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: PREFIX + path, handler: (req, res) => answer(res, () => handler(req, res)) }),
    `wecom-bot: 路由 ${path}`,
  )

  const setConfig = (next) => {
    const before = cfg
    cfg = saveConfig(next)
    if (before.enabled !== cfg.enabled || before.botId !== cfg.botId) {
      void (async () => {
        await stopConnection()
        if (cfg.enabled) await startConnection()
      })()
    }
    return cfg
  }

  route('/state', async () => ({
    ok: true,
    version: VERSION,
    enabled: cfg.enabled,
    connected: Boolean(client && client.connected),
    kicked: Boolean(client && client.kicked),
    connState,
    ready: connectionReady(),
    setupDone: cfg.setupDone,
    guideDone: cfg.guideDone,
    accessMode: cfg.accessMode,
    admins: cfg.admins.length,
    vault: secrets.kind,
    dataDir: DATA_DIR,
    // 自检：这三项以前只能靠翻 plugin.log 猜，面板上必须能直接看到
    video: videoSelfCheck(),
    asr: await asrSelfCheck(),
    browser: browserSelfCheck(),
  }))

  /** 看视频链路自检：模块找没找到 / 工具实际挂上几个 / ffmpeg 在不在 / 附件服务可用否 */
  function videoSelfCheck() {
    const r = videoReport
    if (!r) return { state: 'loading', message: '还在接', tools: [], ffmpeg: '', dir: '' }
    const ok = Array.isArray(r.ok) ? r.ok : []
    const failed = Array.isArray(r.failed) ? r.failed : []
    const mountFailed = Array.isArray(r.mountFailed) ? r.mountFailed : []
    return {
      state: ok.length > 0 ? 'ok' : 'broken',
      message: r.reason || '',
      tools: ok.map((t) => t.name),
      failed,
      mountFailed,
      ffmpeg: r.ffmpeg || '',
      dir: r.dir || '',
      // 上游工具要 ctx.attachments.saveImage 才能把分镜图提交成附件，缺了只能出纯文本
      canSaveImage: typeof ctx.attachments?.saveImage === 'function',
    }
  }

  /** ASR 自检：交给 asr 模块（它读 $DSH_HOME/asr.json 并探活），这里只保留 /state 的字段形状 */
  async function asrSelfCheck() {
    try {
      return await asr.status()
    } catch (error) {
      return { state: 'missing', baseUrl: '', hostService: false, message: error.message }
    }
  }

  /** 浏览器自检：能不能找到 Edge/Chrome、开没开、cookie 存了几条 */
  function browserSelfCheck() {
    try {
      const s = browser.status?.() || {}
      return {
        state: s.browserPath ? (s.connected ? 'ok' : 'idle') : 'broken',
        browserPath: s.browserPath || '',
        enabled: s.enabled,
        connected: Boolean(s.connected),
        running: Boolean(s.running),
        lastError: s.lastError || '',
        cookies: s.cookies || { saved: false, count: 0 },
        message: s.browserPath ? '' : '本机没找到 Edge / Chrome',
      }
    } catch (error) {
      return { state: 'broken', message: error.message }
    }
  }

  route('/config', () => ({ ok: true, config: publicConfig(cfg), services: MCP_SERVICES }))

  // ---------- 视频站登录（抖音 / B站） ----------
  // 浏览器工具和登录模块共用同一个专用浏览器实例，所以这里绝不另起一个。
  route('/video/login', () => videoLogin.status())
  route('/video/login/open', async (req) => {
    const body = await readBody(req)
    return videoLogin.openLogin(body.site)
  })
  route('/video/login/save', async (req) => {
    const body = await readBody(req)
    return videoLogin.saveLogin(body.site)
  })
  // 手动粘贴 cookies.txt 是兜底路线，后端同样要求显式确认（面板的三重确认不能只在前端）
  route('/video/login/manual', async (req) => {
    const body = await readBody(req)
    return videoLogin.saveManual(body.site, body.text, body.confirmed === true)
  })
  route('/video/login/clear', async (req) => {
    const body = await readBody(req)
    return videoLogin.clear(body.site)
  })

  // ---------- 语音转文字 ----------
  route('/asr', () => asr.status())
  route('/asr/save', async (req) => {
    const body = await readBody(req)
    return asr.save(body)
  })
  route('/asr/start', async (req) => {
    const body = await readBody(req)
    return asr.start({ waitMs: Number(body.waitMs) || 90000 })
  })
  route('/asr/discover', async (req) => {
    const body = await readBody(req)
    return asr.useDiscovered(body.script, body.baseUrl)
  })
  route('/asr/hint', () => asr.installHint())
  route('/save', async (req) => {
    const body = await readBody(req)
    // 面板传 { config: {...} }；也接受直接摊平传（脚本/curl 方便）
    const patch = body.config && typeof body.config === 'object' ? body.config : body
    // 增量语义：patch 里有什么就改什么，没传的字段一律保持服务端当前值。
    // 前端只发改动过的字段（见 client/client.js 的 diffConfig），所以「面板快照
    // 过期」不会再覆盖掉别处刚做的修改 —— 这是 lost update 的根治办法。
    // 深合并由 merge() 保证：嵌套对象逐层合并，不会被半截对象替换掉。
    const next = merge(cfg, patch)
    delete next.secret
    // 兜底：这两样永远不走 /save。管理员池的 mcp 在 publicConfig 里是布尔，
    // 原样存回来会变成 "true"，只能走 /admin/*；工作区目录走 /workspace/migrate。
    next.admins = cfg.admins
    next.workspaceDir = cfg.workspaceDir
    // 密钥单独收，不进 config
    if (typeof body.secret === 'string' && body.secret.trim()) {
      await secrets.set('WECOM_BOT_SECRET', body.secret.trim())
      secretCache = body.secret.trim()
    }
    return { ok: true, config: publicConfig(setConfig(next)) }
  })
  route('/connect', async (req) => {
    const body = await readBody(req)
    if (body.botId) cfg = saveConfig({ ...cfg, botId: String(body.botId).trim() })
    if (typeof body.secret === 'string' && body.secret.trim()) {
      await secrets.set('WECOM_BOT_SECRET', body.secret.trim())
      secretCache = body.secret.trim()
    }
    if (!cfg.enabled) cfg = saveConfig({ ...cfg, enabled: true })
    await stopConnection()
    const r = await startConnection()
    return { ...r, ok: r.ok }
  })
  route('/disconnect', async () => { await stopConnection(); return { ok: true } })
  route('/logs', (req) => ({ ok: true, rows: recentLogs(300) }))
  route('/activity', (req) => ({ ok: true, rows: recentEntries(200), stats: chatStats() }))
  route('/quota', () => ({ ok: true, usage: usageSnapshot(), config: cfg.quota }))
  route('/quota/reset', () => { resetUsage(); return { ok: true } })
  route('/memory', (req) => {
    const url = new URL(req.url, 'http://x')
    const q = url.searchParams.get('q') || ''
    const scope = url.searchParams.get('scope') || ''
    const rows = q ? memory.recall(q, { limit: 100 }) : memory.listAll(scope ? { scope } : {})
    return { ok: true, stats: memory.stats(), rows: rows.slice(-200) }
  })
  route('/memory/delete', async (req) => {
    const body = await readBody(req)
    return { ok: memory.remove(body.id) }
  })
  route('/personas', () => ({
    ok: true,
    rows: listPersonas().map((p) => ({ id: p.id, name: p.name, tags: p.tags, current: p.id === cfg.persona.current })),
  }))
  route('/persona', (req) => {
    const url = new URL(req.url, 'http://x')
    const id = url.searchParams.get('id') || cfg.persona.current
    const p = readPersona(id)
    return p ? { ok: true, persona: p } : { ok: false, message: '没这个人格' }
  })
  route('/persona/save', async (req) => {
    const body = await readBody(req)
    const p = savePersona(body.id, { name: body.name, tags: body.tags, body: body.body })
    if (body.select) setConfig({ ...cfg, persona: { ...cfg.persona, current: p.id } })
    return { ok: true, persona: p }
  })
  route('/persona/select', async (req) => {
    const body = await readBody(req)
    setConfig({ ...cfg, persona: { ...cfg.persona, current: String(body.id || 'default') } })
    return { ok: true }
  })
  route('/persona/delete', async (req) => {
    const body = await readBody(req)
    return { ok: deletePersona(body.id) }
  })
  route('/admin/add', async (req) => {
    const body = await readBody(req)
    return { ok: true, config: publicConfig(setConfig(addAdmin(body))) }
  })
  route('/admin/remove', async (req) => {
    const body = await readBody(req)
    return { ok: true, config: publicConfig(setConfig(removeAdmin(body.userid))) }
  })
  route('/admin/mcp', async (req) => {
    const body = await readBody(req)
    const { userid, service, url } = body
    if (!adminList().some((a) => a.userid === userid)) return { ok: false, message: '没这个管理员' }
    if (!MCP_SERVICES.some((s) => s.id === service)) return { ok: false, message: '没这个服务' }
    if (!url) {
      secrets.unset(mcpRef(service, userid))
      mcpPool.delete(mcpRef(service, userid))
      return { ok: true, config: publicConfig(setConfig(setAdminMcp(userid, service, ''))) }
    }
    const v = validateMcpUrl(url, service)
    if (!v.ok) return { ok: false, message: v.message }
    secrets.set(mcpRef(service, userid), url)
    mcpPool.delete(mcpRef(service, userid))
    return { ok: true, config: publicConfig(setConfig(setAdminMcp(userid, service, url))) }
  })
  route('/mcp/test', async (req) => {
    const body = await readBody(req)
    const mc = await mcpFor(body.service, body.userid)
    if (!mc) return { ok: false, message: '还没配这个服务' }
    try {
      const list = await mc.listTools()
      return { ok: true, count: list.length, names: list.map((t) => t.name).slice(0, 40) }
    } catch (error) {
      return { ok: false, message: error.message }
    }
  })
  route('/sessions', () => ({ ok: true, rows: Object.entries(hub.sessionMap()).map(([k, v]) => ({ key: k, ...v })) }))

  // ---------- 工作区目录迁移 ----------
  // 企微会话都落在同一个工作区里，工作区按「路径」认身份。
  // 换目录 = 换个工作区，老会话不会消失（还挂在老工作区里、侧栏能看到），
  // 新消息起在新目录。想彻底重来就去「重置会话」。
  route('/workspace', () => ({
    ok: true,
    dir: hub.workspaceDir(),
    title: WORKSPACE_TITLE,
    exists: safeExists(hub.workspaceDir()),
  }))

  route('/workspace/check', async (req) => {
    const body = await readBody(req)
    const dir = String(body.dir || '').trim()
    if (!dir) return { ok: false, message: '要填一个目录' }
    if (!isAbsolute(dir)) return { ok: false, message: '请填绝对路径（比如 D:\\WeComBot\\chats）' }
    const exists = safeExists(dir)
    let writable = false
    let message = ''
    try {
      mkdirSync(dir, { recursive: true })
      const probe = join(dir, '.write-test')
      writeFileSync(probe, 'ok')
      rmSync(probe, { force: true })
      writable = true
    } catch (error) {
      message = error.message
    }
    if (!writable) return { ok: false, dir, exists, message: `这个目录写不进去：${message}` }
    return { ok: true, dir, exists, message: exists ? '目录已存在，可以写' : '目录不存在，迁移时会创建' }
  })

  route('/workspace/migrate', async (req) => {
    const body = await readBody(req)
    // 去掉结尾的斜杠再比 —— 否则 "D:\chats\" 和 "D:\chats" 会被当成两个工作区
    const dir = String(body.dir || '').trim().replace(/[\\/]+$/, '')
    if (!dir) return { ok: false, message: '要填一个目录' }
    if (!isAbsolute(dir)) return { ok: false, message: '请填绝对路径' }
    const before = String(hub.workspaceDir() || '').replace(/[\\/]+$/, '')
    if (before.toLowerCase() === dir.toLowerCase()) return { ok: true, message: '目录没变', dir, moved: 0 }

    try { mkdirSync(dir, { recursive: true }) } catch (error) {
      return { ok: false, message: `目录建不出来：${error.message}` }
    }

    // 1) 写配置（必须走 setConfig —— 直接 saveConfig 只落盘不更新内存里的 cfg）
    // 工作区缓存按新路径重新找（或新建）
    setConfig({ ...cfg, workspaceDir: dir })

    // 2) 清掉内存里的会话映射，让下一条消息在新工作区里开新会话
    let moved = 0
    for (const [k] of sessionChat) { sessionChat.delete(k); mounted.delete(k); moved++ }
    for (const sid of [...turnState.keys()]) turnState.delete(sid)
    hub.forgetSessions()

    log.info(`工作区目录已迁移：${before} → ${dir}（清掉 ${moved} 个会话映射）`)
    return {
      ok: true,
      dir,
      before,
      moved,
      message: `已切到「${dir}」。老的会话还在「${WORKSPACE_TITLE}」工作区里能看到，下次有人发消息会在新目录里开新会话。`,
    }
  })

  route('/test-send', async (req) => {
    const body = await readBody(req)
    if (!client || !client.connected) return { ok: false, message: '长连接没连上' }
    if (!body.chatId) return { ok: false, message: '要发给谁？' }
    try {
      await client.sendText(String(body.chatId), body.kind === 'group' ? 2 : 1, String(body.text || '测试消息'))
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error.message }
    }
  })
  route('/reset', async () => {
    const n = Object.keys(hub.sessionMap()).length
    for (const [k, chat] of sessionChat) { sessionChat.delete(k); mounted.delete(k) }
    return { ok: true, message: `已经重置 ${n} 个会话映射（下次来消息会重开）` }
  })

  /** 支持 /config 里包含的 mcp 结构化更新 */
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: (req, res) => answer(res, () => {
      let path = ''
      try { path = new URL(req.url, 'http://x').pathname } catch {}
      return { ok: false, message: `没有这个接口：${path}` }
    }),
  }), 'wecom-bot: 兜底路由')

  function addAdmin(body) {
    const userid = String(body.userid || '').trim()
    if (!userid) throw new Error('要填 userid')
    if (cfg.admins.some((a) => a.userid === userid)) throw new Error('这个 userid 已经在管理员里了')
    const role = body.role === 'owner' && !cfg.admins.some((a) => a.role === 'owner') ? 'owner' : 'admin'
    cfg.admins.push({ userid, name: String(body.name || '').trim(), role, addedAt: Date.now(), mcp: {}, quotaTokens: 0 })
    if (role === 'owner') { /* 第一个 owner */ }
    return cfg
  }
  function removeAdmin(userid) {
    cfg.admins = cfg.admins.filter((a) => a.userid !== userid)
    return cfg
  }
  function setAdminMcp(userid, service, url) {
    const a = cfg.admins.find((x) => x.userid === userid)
    if (a) { a.mcp = a.mcp || {}; if (url) a.mcp[service] = url; else delete a.mcp[service] }
    return cfg
  }

  flushLog()
  log.info(`WeCom Bot ${VERSION} 已加载（${cfg.enabled ? '开关开' : '开关关'}）`)
  return () => {
    for (const [, v] of mounted) for (const off of v.offs) { try { off() } catch {} }
    flushLog()
  }
}
