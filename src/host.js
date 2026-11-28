// WeCom Bot · 宿主半边（DSH 插件入口）
//
// 让 DSH 里的 AI 以企业微信智能机器人的身份住在企微里：
//   企微智能机器人（长连接）⇄ 本插件 ⇄ DSH 会话（自带两个 preset + 人格）
// 面板在侧栏（网页半边见 client/client.js），这里提供它要的 /wecom-bot/api/* 接口。
//
// 这个文件只管装配：配置、长连接、聊天中枢、人格变量、工具挂载、面板接口。
// 具体能力都在 src/ 下面分好了：wecom/（协议）、chat/（会话）、memory/、persona/、core/。
//
// ⚠ 安全默认：总开关关。不手动打开，一句都不会真的发到企微。

import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { join, dirname, basename, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'

import { loadConfig, saveConfig, publicConfig, merge, DATA_DIR } from './core/config.js'
import { createLogger, recentLogs, redact, debugEnabled, setDebugEnabled } from './core/logger.js'
import { fireAndForget } from './core/safe.js'
import { record as recordActivity, recentEntries, chatStats, flushLog } from './core/activity.js'
import * as chatlog from './core/chatlog.js'
import { resolveModel, listModels, ask as askModel } from './core/model.js'
import { createConsolidator } from './memory/consolidate.js'
import * as skills from './memory/skills.js'
import { createVault, mcpRef, REF } from './core/vault.js'
import { checkQuota, addUsage, tickMinute, usageSnapshot, resetUsage, estimateTokens } from './core/quota.js'
import { createWecomClient, WecomApiError, WecomUncertainError } from './wecom/client.js'
import { createMcpClient, MCP_SERVICES, validateMcpUrl, probeService } from './wecom/mcp.js'
import { diagnoseChatId } from './wecom/diagnose.js'
import { createHub, WORKSPACE_TITLE } from './chat/hub.js'
import { checkAccess, autoRegister, deniedReply } from './chat/access.js'
import { createMerger } from './chat/merge.js'
import { createPlaceholder } from './chat/placeholder.js'
import { createBackfill } from './chat/backfill.js'
import { normalizeInbound, attachInboundImage, attachInboundFile } from './chat/inbound.js'
import { listPersonas, readPersona, savePersona, deletePersona, createPersona, personaText, rulesText } from './persona/personas.js'
import * as memory from './memory/store.js'
import { buildTools } from './tools/wecom.js'
import { buildBrowserTools } from './tools/browser.js'
import { buildVideoTools } from './tools/video.js'
import { createBrowserManager } from './browser/manager.js'
import { createVideoLogin } from './video/login.js'
import { exposeYtdlp } from './video/binaries.js'
import { createDouyinResolver } from './video/douyin.js'
import { createDouyinWatch } from './video/douyin-watch.js'
import { buildDouyinTools } from './tools/douyin.js'
import { createAsr } from './video/asr.js'

export const name = 'wecom-bot'
export const inject = ['agents', 'sessions', 'webServer', 'timer', 'workspaceRegistry', 'attachments', 'systemPrompt', 'llm']

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = (() => { try { return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) } catch { return { version: '?' } } })()
const VERSION = PKG.version
const PREFIX = '/wecom-bot/api'

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

  // ---------- 人格与规则：注入到两个 preset 的提示词变量 ----------
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
  // 同一个会话的一轮必须串行到「回复发出」为止：否则长任务 A 还在跑时，
  // 第二条消息 B 会覆盖 turnState 里 A 的槽位 → A 的 req_id 丢失 → 协议层发不出，
  // 表现为「会话里有回复、用户却收不到」。仿 mountChain 按 sid 排队，跨会话不互相阻塞。
  const turnChain = new Map()
  function runTurn(sid, fn) {
    const prev = turnChain.get(sid) || Promise.resolve()
    const next = prev.then(fn).catch((error) => {
      log.warn(`处理会话 ${String(sid).slice(-8)} 这一轮出错：${error.message}`)
    })
    turnChain.set(sid, next)
    next.then(() => { if (turnChain.get(sid) === next) turnChain.delete(sid) })
    return next
  }

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
  /**
   * 找某个服务的 MCP 地址。两段：
   *   1) config.json 里的明文（快路径，最常见）
   *   2) 凭据库里的 WECOM_BOT_MCP_<SERVICE>_<HASH>（慢路径）
   *
   * 为什么必须有第 2 段：地址的**真身一直在凭据库**，config 里那份只是副本。
   * 老实现只认副本，副本一丢（换机迁移、手改 config、旧版本写坏）就报「还没配这个服务」，
   * 哪怕凭据库里的 URL 好好的 —— 这正是「测一下说通了、干活说没配」的根。
   */
  async function serviceUrlOf(service, userid) {
    // 用 hasOwnProperty：a.mcp['constructor'] 会顺着原型链拿到函数，
    // 而 service 名来自工具参数（任意字符串），不是白名单成员。
    const pick = (a) => (a && a.mcp && Object.prototype.hasOwnProperty.call(a.mcp, service) && a.mcp[service]) || ''
    if (userid) {
      const a = adminList().find((x) => x.userid === userid)
      if (a && pick(a)) return { url: pick(a), userid, fromVault: false }
    }
    // 没指定人：先用 owner 的，再退第一个配了的
    const owner = adminList().find((a) => a.role === 'owner')
    if (owner && pick(owner)) return { url: pick(owner), userid: owner.userid, fromVault: false }
    for (const a of adminList()) if (pick(a)) return { url: pick(a), userid: a.userid, fromVault: false }
    // 慢路径：谁先问谁优先，其次 owner，最后挨个试
    const order = []
    if (userid) order.push(userid)
    if (owner && !order.includes(owner.userid)) order.push(owner.userid)
    for (const a of adminList()) if (!order.includes(a.userid)) order.push(a.userid)
    for (const uid of order) {
      try {
        const url = await secrets.resolve(mcpRef(service, uid))
        if (url) {
          log?.info?.(`${service} 的地址在凭据库里（${uid}），配置里没有，按凭据库走`)
          return { url, userid: uid, fromVault: true }
        }
      } catch {}
    }
    return null
  }

  /** 拿某个服务的 MCP 客户端；没配就返回 null（工具据此降级） */
  async function mcpFor(service, userid) {
    // userid 口径归一：面板存的时候可能是 number，工具调用传的是 string。
    // mcpRef 内部虽然 String() 了，但 serviceUrlOf 的严格 find 会漏，
    // 统一成字符串再查，ref 才算得一致。
    const uid = userid == null ? undefined : String(userid)
    const found = await serviceUrlOf(service, uid)
    if (!found) return null
    const ref = mcpRef(service, found.userid)
    const cached = mcpPool.get(ref)
    if (cached) return cached
    // fromVault 时 found.url 就是从凭据库读出来的，不必再查一遍
    let url = found.fromVault ? found.url : await secrets.resolve(ref)
    if (!url) {
      // 凭据库没读到（新机冷启动 / 凭据只写进了 config 明文 / 服务晚就绪）：
      // config 里的 URL 同样经过面板校验，拿来兜底，总比直接「没配」强。
      url = found.url
      if (url) log?.warn?.(`${service} 凭据没读到，临时用配置里的 URL（建议重新填写一次凭据）`)
    }
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
      secretCache = (await secrets.resolve(REF.secret)) || ''
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
      // 从断开 → 已连接：断线期间的消息企微不会重发，拿水位自己去补。
      // 首次连接不补（那时还没有水位，也没什么可补的）。
      if (s.connected && !wasConnected && everConnected) {
        fireAndForget(backfill.fillAll(s.reason || '重连', knownTargets()), '断线补拉', log, 'debug')
      }
      if (s.connected) everConnected = true
    })
    // ⚠ 必须吞掉拒绝：这是 websocket 的消息回调，外面的 try 管不到异步链。
    //   这里漏一个 await 的失败，就是 unhandledRejection，Node 直接把 DSH 进程杀掉。
    c.onMessage((frame) => { fireAndForget(onInbound(frame), '处理入站消息', log) })
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
    // 退出前把内存里还没落盘的流水写掉。
    // 不接这一步，关掉 DSH 就等于把「今天还没攒够 50 条」的对话整段丢了，
    // 而 chatlog 是记忆提炼的唯一原料，企微不会重发历史，丢了就补不回来。
    return () => {
      try { chatlog.flush() } catch {}
      void stopConnection()
    }
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
      // 条件删除：只删自己这一轮的槽位，绝不误删后一轮的（成本极低，双保险）
      if (turnState.get(sid) === st) turnState.delete(sid)
      // 回复真正发出后才放行同一会话排队的下一条消息
      const done = () => { try { st.finishTurn?.() } catch {} }
      if (!completed) {
        const detail = String(d.reason?.error?.message || d.reason?.failure?.message || '').replace(/\s+/g, ' ').slice(0, 180)
        log.warn(`${st.chat.chatId} 这一轮没正常结束（${d.reason?.kind || '?'}${detail ? '：' + redact(detail) : ''}）`)
        fireAndForget(replyTo(frame, '这次没跑完，出错了。再试一次？').finally(done), '回复出错提示', log)
        return
      }
      if (isSilence(text)) {
        log.info(`${st.chat.chatId} 这一轮不说话`)
        fireAndForget(replyTo(frame, '', true).finally(done), '回复静默', log)
        return
      }
      fireAndForget(replyTo(frame, clip(text)).finally(done), '回复消息', log)
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
      // 机器人自己说的话也要进流水：提炼时要能看出「对方问-它怎么答-对方满意了没」，
      // 只有对方的话会把一段对话切成孤立的问句，学不到做法。
      chatlog.append({
        chatId: frame.__chatId || '',
        kind: frame.__chatKind || 'dm',
        chatName: frame.__chatName || '',
        userId: '',
        name: '我',
        who: 'bot',
        text,
      })
      // 灵活整理模式按「最后一条消息」计时，机器人自己的回复也算一条
      consolidator.noteActivity()
    } catch (error) {
      log.error(`回复失败：${error.message}`)
    }
  }

  // ---------- 记忆上下文（每轮拼一小段）----------
  // 这段必须挂进系统提示词才有用 —— cordis.patch.yml 两个 preset 的 prefix
  // 里都要有 {{wecom_context}}，否则模型根本不知道自己有记性，tool 白挂。
  //
  // 空库也要注入：以前 `if (!s.total) return ''`，结果是「先有记忆才提示，
  // 但没提示就永远不会有记忆」的死循环。
  function contextText() {
    try {
      if (!cfg.features.memory) return ''
      const s = memory.stats()
      const lines = [
        '【你有记性】',
        `你有一个跨会话的记忆库（用 wecom_memory 主动记录和回忆）。现在里面有 ${s.alive} 条还没过期的。`,
        '什么时候主动回忆：对方提到「上次」「之前说过」，或你在接一件没做完的事时，先 wecom_memory(recall) 查一下，别凭印象编。',
        '什么时候主动记：对方的偏好、忌讳、身份、正在办的要紧事。不记一次性的闲聊、不记能自己查到的公开信息。',
        '召回时如果某条标注是从别的群/别的地方听来的，那件事不要当成当前这个群的公开信息到处讲。',
      ]
      // 技能：跨会话共享的「怎么做」。只列名字，正文按需查 ——
      // 全量正文塞进系统提示会让每轮的 token 都变贵，而且大部分本轮用不上。
      const sk = skills.listSkills().slice(0, 12)
      if (sk.length) {
        lines.push('')
        lines.push('【你学会的做法】用到哪条就 wecom_memory(action="skill", query="关键字") 看细节。')
        for (const x of sk) lines.push(`· ${x.name}`)
      }
      return lines.join('\n')
    } catch { return '' }
  }

  /** 每轮拼的一小段上下文（记忆提示，很短） */
  function contextLineOf() {
    return contextText()
  }

  /**
   * 「现在是谁在说话 + 你记得关于他的什么」。
   *
   * 这条是全篇最要紧的一处：以前每轮只告诉模型「你有记性，自己去查」，
   * 但模型在群里根本不知道对方是谁、也就想不到该查谁 —— 于是他在私聊里
   * 说过的一切，换个会话就像没发生过。跨会话认人不是「存得下 ID」的问题，
   * 是「轮到这一轮时有没有把 ID 和记得的事摆到眼前」的问题。
   *
   * 挂在当轮用户消息里而不是系统提示：系统提示每轮都会补一份运行时上下文快照，
   * 内容变了就多一份，历史会越滚越大。放这里只占当轮。
   */
  function whoLine(chat) {
    const name = chat.displayName || chat.name || ''
    const where = chat.kind === 'group' ? `群「${chat.groupName || chat.name || ''}」里` : '私聊里'
    const head = `【现在跟你说话的人】${name || '（没名字）'}${chat.userId ? `（ID ${chat.userId}）` : ''}，在${where}。`
    let mine = []
    try {
      mine = memory.recall('', {
        about: chat.userId || '',
        chatId: chat.chatId || '',
        limit: 6,
        // 不写召回日志、不落盘：这条是每轮自动塞的，不是模型主动回忆。
        // 每条消息都改一次 memory.json，群消息一多就把磁盘打满。
        silent: true,
      })
    } catch {}
    if (!mine.length) return `${head}你目前对他没有印象（记忆库里没有关于他的事）。`
    // 只要「关于这个人」的：public/skill 是所有会话共享的，混进这段会挤掉
    // 真正属于他的那几条，而它们本来就在系统提示的「学会的做法」里。
    const only = mine.filter((h) => h.it.about && String(h.it.about) === String(chat.userId))
    if (!only.length) return `${head}你目前对他没有印象（记忆库里没有关于他的事）。`
    const lines = only.map((h) => `· ${h.it.text}`)
    return [
      head,
      '你记得关于他的事（从以前的对话里记下来的，直接当自己知道就行，别问「你怎么知道」）：',
      ...lines,
    ].join('\n')
  }

  // ---------- 预回复（文字 / 图片 / 都发）----------
  const placeholder = createPlaceholder({
    getConfig,
    getClient: () => client,
    mcpFor,
    log: logger.child('placeholder'),
  })

  // 发图要 media_id，media_id 只能从 disk / mail / doc 的 media_upload 换。
  // 面板上要把这个说清楚：选了图但没配这三个服务之一，图是发不出去的。
  const mcpUploadReady = async () => {
    for (const s of ['disk', 'mail', 'doc']) {
      if (await serviceUrlOf(s)) return true
    }
    return false
  }

  // ---------- 记忆整理（流水 → 提炼 → 记忆/技能）----------
  const consolidator = createConsolidator({
    dsh: ctx,
    getConfig,
    log: logger.child('memory'),
  })
  // 每分钟看一眼到没到点。到点才真跑，平时只是比两个数字。
  ctx.effect(() => {
    const t = setInterval(() => { fireAndForget(consolidator.tick(), '自动整理记忆', log, 'debug') }, 60_000)
    t.unref?.()
    return () => clearInterval(t)
  }, 'wecom-bot: 记忆整理定时器')

  // ---------- 收消息 ----------
  const merger = createMerger({
    log: logger.child('merge'),
    onPlaceholder: (frame, chat) => { placeholder.fire(frame, chat) },
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
    frame.__chatKind = chat.kind
    recordActivity({ kind: 'in', chatId: chat.chatId, name: chat.name, userId: chat.userId, text: merged })
    // 流水是每日提炼的原料。activity 那份只留 3000 条给面板看，不够提炼用。
    chatlog.append({
      chatId: chat.chatId,
      kind: chat.kind,
      chatName: chat.name || '',
      userId: chat.userId,
      name: chat.displayName || chat.name || '',
      who: 'user',
      text: merged,
    })
    // 灵活整理模式按「最后一条消息」计时
    consolidator.noteActivity()

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

    // 群上下文：被 @ 时补一段。水位 = 上次被 @ 的时刻（群里未 @ 的消息企微根本不推，
    // 所以只能这样），补完把水位推到现在。
    if (chat.kind === 'group' && cfg.history.enabled) {
      fireAndForget(backfill.fill(chat, sid, { reason: '这个群在你上次被叫之后又聊了这些' }), '补群历史', log, 'debug')
    }
    // 这一轮要串行到「回复真正发出」为止：长任务 A 还在跑时来一条消息 B，
    // B 会排在队列里，不会覆盖 turnState 里 A 的槽位（覆盖会让 A 的 req_id 丢失）。
    await runTurn(sid, async () => {
      let resolveTurn
      const turnDone = new Promise((resolve) => { resolveTurn = resolve })
      let settled = false
      const finishTurn = () => { if (!settled) { settled = true; resolveTurn() } }
      turnState.set(sid, { chat, frame, text: '', lastTurn: -1, startedAt: Date.now(), said: merged, finishTurn })

      // 附件
      const attachments = []
      for (const img of first.images || []) {
        // admitImage 返回的已经是登记好的完整块 { type:'image', attachment:<ref> }。
        // 绝不能再套一层 { type:'image', attachment:<那块> } —— 套壳会被写进会话历史，
        // 之后每轮回放内核读 ref.attachmentId 拿到 undefined → "Attachment reference is invalid."，
        // 连后面发的纯文字也一起卡死。登记失败时返回 null，下面 filter 会滤掉。
        const block = await admitImage(img)
        if (block) attachments.push(block)
      }
      let promptText = merged
      for (const f of first.files || []) {
        const p = saveInboundFile(first, f)
        if (p) promptText += `\n\n[对方发来一个文件，已存到：${p}]`
      }
      // 说话人 → 「你记得关于他的事」。
      // 这一小段必须挂在当轮用户消息里，不能进系统提示：系统提示每轮都会追加一份
      // 运行时上下文快照，内容一变就多一份快照，历史会越滚越大（413 就是这么来的）。
      if (cfg.features.memory) promptText = `${whoLine(chat)}\n\n${promptText}`

      // 兜底：万一 turn/end 没来（中断/异常），10 分钟后也放行，别让队列永久卡死
      const guard = setTimeout(finishTurn, 10 * 60_000)
      try {
        await hub.prompt(chat, promptText, { attachments: attachments.filter((a) => a && a.attachment) })
        addUsage(chatKey, estimateTokens(promptText) + 300)
        tickMinute(chatKey)
        // 等 turn/end 把这一轮的回复真正发出去，才放同一会话的下一条（保证 req_id 不串）
        await turnDone
      } catch (error) {
        log.error(`投递失败：${error.message}`)
        if (turnState.get(sid)?.finishTurn === finishTurn) turnState.delete(sid)
        await replyTo(frame, '我这边把消息送进会话失败了，稍后再试一次。')
      } finally {
        clearTimeout(guard)
        finishTurn()
      }
    })
  }

  async function admitImage(img) {
    try {
      // 内核 @deepseek-ai/dsh-attachment 只读顶层 data/source 之外的扁平字段：
      // isEncodedImage 认 type:'image'，saveInput 直接读 image.data → Buffer.from(base64)。
      // 之前塞在 source.data 里会被读成 undefined → Buffer.from(undefined) 抛错被吞 → 图变 [图片]。
      const content = [{ type: 'image', data: Buffer.from(img.data).toString('base64'), mediaType: img.mimeType }]
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

  // ---------- 上下文补齐（一套水位，两个触发点）----------
  // 群上下文补齐和断线补拉本来是两坨代码、两套配置，做的是同一件事。
  // 现在只有一份实现（src/chat/backfill.js），触发点两个：群里被 @、重连成功。
  const backfill = createBackfill({
    log: logger.child('backfill'),
    mcpFor,
    appendOnly: (sid, text, source) => hub.appendOnly(sid, text, source),
    getConfig,
  })
  // 插件卸载时把攒着的水位写下去，不然最后 500ms 的进度白丢
  ctx.effect(() => () => { try { backfill.flush() } catch {} }, 'wecom-bot: 落盘水位')

  /** 已知会话 → [{ chat, sessionId }]，补拉时按这个清单走 */
  function knownTargets() {
    const map = hub.sessionMap() || {}
    const out = []
    for (const [key, v] of Object.entries(map)) {
      if (!v?.sessionId) continue
      // key 形如 wecom:group:xxx / wecom:dm:xxx；映射里还存了 title / userId / groupId
      const parts = String(key).split(':')
      const kind = parts[1] === 'group' ? 'group' : 'dm'
      const chatId = v.groupId || (kind === 'dm' ? v.userId : '') || parts.slice(2).join(':')
      if (!chatId) continue
      out.push({
        chat: {
          kind,
          chatId,
          userId: kind === 'dm' ? (v.userId || chatId) : '',
          groupName: kind === 'group' ? (v.title || '') : '',
        },
        sessionId: v.sessionId,
      })
    }
    return out
  }


  // ---------- 入站主流程 ----------
  async function onInbound(frame) {
    let message
    try { message = normalizeInbound(frame, { botName: cfg.botName }) } catch (error) {
      log.warn(`入站解析失败：${error.message}`)
      return
    }
    const { chat } = message

    // 先鉴权再下附件。
    // 为什么要换顺序：以前是先下载解密再查白名单，开放模式下任何陌生人都能甩个
    // 20MB 文件触发下载和落盘。改成先判权限，没权限的连内容都不碰。
    const access = checkAccess(cfg, chat)
    if (!access.allowed) {
      log.info(`拦下一条（${access.reason}）：${chat.kind} ${chat.chatId} / ${chat.userId}`)
      // 先把会话标识写进 frame，再回话 —— replyTo 里记录活动用的是 frame.__chatId，
      // 不给的话日志栏里这条拒绝是「没有来源」的，管理员根本看不出是哪个群被拦了。
      frame.__chatId = chat.chatId
      frame.__chatName = (chat.kind === 'group' ? chat.groupName : chat.displayName) || ''
      await replyTo(frame, deniedReply(chat, chat.userId))
      // 管理员还没绑定任何人的话，把首个私聊者的 ID 直接告诉他，方便填进面板
      return
    }

    // 自动学名字：群里只有被 @ 才会回调，@ 前缀就是机器人当前的名字。
    // 只在没手动配 botName 时学，且只写到 observedBotName（不回填门牌 botName，
    // 否则剥 @ 前缀和规则里的门牌都跟着变，身份分层就塌了）。
    // 学到的名字只在 default 人格里替换 {{name}}；写盘去重，名字没变就不动。
    const learned = String(message.mentionName || '').trim()
    if (learned && !String(cfg.botName || '').trim() && learned !== String(cfg.observedBotName || '').trim()) {
      cfg = saveConfig({ ...cfg, observedBotName: learned })
      log.info(`从群消息 @ 前缀学到机器人名字：${learned}`)
    }

    // 附件：图片所有会话都收；视频所有会话都收；普通文件只收私聊。
    // 群里的文件不接（老大定的）—— 群文件多是共享资料，收下来既占地方又容易跑偏。
    const groupFile = chat.kind === 'group' && message.msgtype === 'file'
    if (message.msgtype === 'image') {
      await attachInboundImage(message.raw, message, { log: (lv, t) => log[lv]?.(t) })
    } else if (message.msgtype === 'video') {
      await attachInboundFile(message.raw, message, { log: (lv, t) => log[lv]?.(t) })
    } else if (message.msgtype === 'file') {
      if (groupFile) {
        message.text = '[文件] 群里发的文件我不收，需要我看的话私聊发我'
      } else {
        await attachInboundFile(message.raw, message, { log: (lv, t) => log[lv]?.(t) })
      }
    }

    const added = autoRegister(cfg, chat)
    if (added) {
      saveConfig(cfg)
      log.info(`开放模式自动登记：${added.kind} ${added.name || added.id}`)
    }

    // 水位：私聊收到任何消息都推进（机器人看得见）；群只有被 @ 时才推进
    // —— 群里没 @ 的消息企微不推，写进去也只是把水位往前挪，反而漏补。
    if (chat.kind === 'dm') backfill.touch(chat, message.msgid)

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
  // yt-dlp 必须在 buildVideoTools 之前塞进 process.env：上游的 discoverYtdlp() 只认
  // DSH_YTDLP_PATH / PATH / pip 脚本目录三条路，而 DSH 桌面版读不到用户 setx 设的环境变量，
  // 用户把 exe 放 ~/.dsh/tools/ 下时三条路全落空（真机上 tried=[]，抖音链接一律报找不到）。
  const ytdlpInfo = exposeYtdlp({ log })
  // 抖音得绕开 yt-dlp：Argus 签名墙把它的 web detail 接口打成了 403（真机实测见
  // src/video/douyin.js 顶部）。这里把浏览器抠直链那条路递给视频工具，
  // 让 video_* 在执行前把抖音链接换成「已下好的本地 mp4」。
  const douyin = createDouyinResolver({ getBrowser: () => browser, dataDir: DATA_DIR, log: logger.child('douyin') })
  // 抖音「看懂视频」：页面内 API 读标题/摘要/热评，跟上面那条下载 mp4 的路互不影响。
  // 它每次干活都开一个独立标签页（browser.withTab），不碰主人当前页面，
  // 两个人同时发抖音链接也不会互相冲掉；能力边界是「只读元数据」，故全档位给。
  const douyinWatch = createDouyinWatch({ getBrowser: () => browser, log: logger.child('douyin-watch') })
  const douyinTools = buildDouyinTools({ douyin: douyinWatch })
  // 语音转写失败时自动重启一次：转写请求是上游自己发的，我们拦不到那个 fetch，
  // 只能从它返回的清单里认出 asr-failed 再兜一层。为什么上游不自己重启：
  // 它探的是 8080 的 /health，那是适配层自答的，whisper 挂了它也认为服务正常。
  const videoReady = buildVideoTools({ ctx, log, douyin, asr })
    .catch((error) => {
      log.warn(`看视频能力没接上：${error.message}`)
      return { ok: [], failed: [], reason: `异常：${error.message}`, dir: '', ffmpeg: '' }
    })
  let videoReport = null // 给面板/自检用：挂上了什么、为什么没挂上
  fireAndForget(videoReady.then((r) => { videoReport = r }), '视频能力自检', log, 'debug')

  // 长任务工具（jobs/schedule）常挂在 wecom-owner preset 里，不再随开关换 preset。
  // 关掉长任务时用 tools.restrict({deny}) 在「这个 agent 的 scope」把它们藏掉；
  // 打开时解除 restriction。restrict 必须走 agent.ctx.tools —— 它内部用 scopeOf(this.ctx)
  // 定位作用域，插件 ctx 上调用会误伤全局。这些工具是 preset 继承来的，属 restrictable，
  // 能被藏；而本插件自己 register 的 wecom/browser/video 工具是 agent scope 的 own，豁免。
  const LONG_TASK_TOOLS = ['job_output', 'job_list', 'job_kill', 'schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit']

  /** 给某个 agent 挂工具（工具清单变了才重挂，避免前缀缓存失效） */
  const mounted = new Map()
  // 同一个会话的挂载必须串行：mountTools 在工具清单算完之前有 await，
  // 两条消息同时进来会都读到「没挂过」，第二遍给同一批名字注册就全撞名，
  // 而且它的 offs 是空的，会盖掉第一遍存下的注销器 —— 之后再也摘不掉。
  const mountChain = new Map()
  async function toolsFor(level, chat) {
    const video = await videoReady
    // 浏览器操作是三档：admin（只有管理员私聊）/ all（管理员 + 所有私聊）/ off。
    // 群聊永远不给 —— 一个群成员不该能操纵主人电脑上的浏览器，这不是配置项。
    const browserMode = cfg.features.browser
    const canBrowser = browserMode !== 'off'
      && (level === 'owner' || (browserMode === 'all' && chat?.kind === 'dm'))
    // 文件/微盘/画图 只给管理员私聊：这几样能碰本机磁盘。
    // 收文件另说（私聊收、群不收，在 onInbound 里按会话类型挡）。
    const fileish = (t) => /file|disk|draw/.test(t.name)
    if (level === 'owner') {
      const list = [...wecomTools]
      if (canBrowser) list.push(...browserTools)
      list.push(...video.ok)
      list.push(...douyinTools)
      return list
    }
    // social（群聊 / 非管理员私聊）：只能发消息、读本会话历史、记点东西、看视频。
    // 没有文件、没有微盘、没有画图，也没有 adminOnly 工具（以主人身份调企微原生
    // 能力 / 查任意会话历史）——那些一旦给群成员就是越权。
    const list = wecomTools.filter((t) => !fileish(t) && !t.adminOnly)
    if (canBrowser) list.push(...browserTools)
    list.push(...video.ok)
    // douyin_watch 是「读抖音视频元数据」的有界只读能力：只能按校验过的视频号
    // 调抖音 detail/评论接口，没有任意导航/点击/读文件/发消息，跟会操纵主人
    // 电脑的 browserTools 不是一回事。群里有人发链接要机器人看懂就靠它，故全档位给。
    list.push(...douyinTools)
    return list
  }
  async function mountToolsNow(agent, chat, level, sid) {
    const list = await toolsFor(level, chat)
    // 长任务关掉时要在主人私聊里藏掉 jobs/schedule —— 这个状态进 key，
    // 开关一变下次来消息就重算（restrict 是加/解，必须成对）
    const longOff = level === 'owner' && !cfg.longTasks
    const key = list.map((t) => t.name).sort().join(',') + '|' + level + '|long:' + (longOff ? 'off' : 'on')
    const prev = mounted.get(sid)
    if (prev && prev.agent === agent && prev.key === key) return
    if (prev) {
      for (const off of prev.offs) { try { off() } catch {} }
      if (prev.restrictOff) { try { prev.restrictOff() } catch {} }
    }
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
    // 长任务关闭：在主人 agent 自己的 scope 把 jobs/schedule 工具藏掉。
    // 这些工具是 preset 挂在祖先 scope 的，属 restrictable，能被 deny；
    // 本插件 register 的 wecom/browser/video 是 agent scope 自己的，不受影响。
    // 工具没挂上的组合（如某种精简 mode）restrict 会抛 unknown，catch 掉即可（本来就没有）。
    let restrictOff = null
    if (longOff) {
      try {
        restrictOff = agent.ctx.tools.restrict({ deny: LONG_TASK_TOOLS })
      } catch (error) {
        log.debug(`长任务工具屏蔽跳过：${error.message}`)
      }
    }
    if (failed.length) {
      // 挂不上的工具留在自检里，面板上能看到「说接上了、实际没挂上」
      videoReport = { ...(videoReport || {}), mountFailed: failed }
    }
    mounted.set(sid, { agent, key, offs, restrictOff })
  }
  // 同一个会话排队挂，谁先算完谁先挂，后进来的看到的一定是已挂好的状态。
  function mountTools(agent, chat, level, sid) {
    const prev = mountChain.get(sid) || Promise.resolve()
    const next = prev.then(() => mountToolsNow(agent, chat, level, sid)).catch((error) => {
      log.warn(`挂工具失败：${error.message}`)
    })
    mountChain.set(sid, next)
    // 队列跑空了就把这条链摘掉，不然会话越来越多会一直攒着
    next.then(() => { if (mountChain.get(sid) === next) mountChain.delete(sid) })
    return next
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
    // 改名时把旧名字记进别名。理由：历史消息里残留的「@旧名」不会因为改名而消失，
    // 系统提示里声明一遍「那也是在叫我」，模型就不会把它当成一个陌生人。
    // 只记 2 个字以上的，避免把空值/半截名字塞进去；最多留 5 条。
    const oldName = String(before?.botName || '').trim()
    const newName = String(next?.botName || '').trim()
    if (oldName && oldName !== newName && oldName.length >= 2) {
      const kept = (Array.isArray(next.botNameAliases) ? next.botNameAliases : [])
        .filter((n) => n && n !== oldName && n !== newName)
      next = { ...next, botNameAliases: [oldName, ...kept].slice(0, 5) }
    }
    cfg = saveConfig(next)
    if (before.enabled !== cfg.enabled || before.botId !== cfg.botId) {
      fireAndForget((async () => {
        await stopConnection()
        if (cfg.enabled) await startConnection()
      })(), '按配置重连', log)
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
    vault: secrets.kind(),
    dataDir: DATA_DIR,
    // 自检：这三项以前只能靠翻 plugin.log 猜，面板上必须能直接看到
    video: videoSelfCheck(),
    asr: await asrSelfCheck(),
    browser: browserSelfCheck(),
  }))

  /** 看视频链路自检：模块找没找到 / 工具实际挂上几个 / ffmpeg 在不在 / yt-dlp 接没接上 / 附件服务可用否 */
  function videoSelfCheck() {
    const r = videoReport
    if (!r) return { state: 'loading', message: '还在接', tools: [], ffmpeg: '', dir: '', ytdlp: ytdlpInfo }
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
      // yt-dlp 决定「链接能不能看」（抖音/B站），ffmpeg 决定「能不能合流成片」，两件事
      ytdlp: ytdlpInfo,
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
  // 实时探测：用户点完「去登录」在浏览器里操作，面板要能立刻看到登没登
  route('/video/login/probe', () => videoLogin.probe())
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
      await secrets.set(REF.secret, body.secret.trim())
      secretCache = body.secret.trim()
    }
    return { ok: true, config: publicConfig(setConfig(next)) }
  })
  route('/connect', async (req) => {
    const body = await readBody(req)
    if (body.botId) cfg = saveConfig({ ...cfg, botId: String(body.botId).trim() })
    if (typeof body.secret === 'string' && body.secret.trim()) {
      await secrets.set(REF.secret, body.secret.trim())
      secretCache = body.secret.trim()
    }
    if (!cfg.enabled) cfg = saveConfig({ ...cfg, enabled: true })
    await stopConnection()
    const r = await startConnection()
    return { ...r, ok: r.ok }
  })
  route('/disconnect', async () => { await stopConnection(); return { ok: true } })
  route('/logs', (req) => ({ ok: true, rows: recentLogs(300), debug: debugEnabled() }))
  /**
   * 面板上拨 debug 开关。
   * 为什么要这个：debug 日志写了半天没人能看，等于没写。
   * 让用户自己拨，出事时不用改环境变量、不用重启 —— 重启会丢掉现场。
   */
  route('/logs/debug', (req) => {
    if (req.method === 'GET') return { ok: true, debug: debugEnabled() }
    return readBody(req).then((body) => {
      const on = setDebugEnabled(Boolean(body?.on))
      logger.info('logger', on ? '面板打开了 debug 日志（会多写很多细节）' : '面板关掉了 debug 日志')
      return { ok: true, debug: on }
    })
  })
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

  // ---- 记忆整理 ----
  route('/memory/status', () => consolidator.status())
  route('/memory/models', async () => {
    const r = await listModels(ctx)
    // 顺手告诉面板「不选的时候会跟随哪个」——用户才知道空着是不是真的能用
    const st = consolidator.status()
    return { ...r, following: st.model, modelFromConfig: st.modelFromConfig }
  })
  route('/memory/distill', async (req) => {
    const body = await readBody(req).catch(() => ({}))
    return consolidator.run({ includeToday: body?.includeToday !== false, days: body?.days })
  })
  // 技能列表：跨会话共享，所以不按 chatId 过滤
  route('/skills', (req) => {
    const url = new URL(req.url, 'http://x')
    const q = url.searchParams.get('q') || ''
    return { ok: true, rows: skills.listSkills(q), stats: skills.stats() }
  })
  route('/skills/save', async (req) => {
    const body = await readBody(req)
    if (body.id) {
      const ok = skills.updateSkill(body.id, { name: body.name, text: body.text })
      return ok ? { ok: true } : { ok: false, message: '没这条技能' }
    }
    const item = skills.importSkill({ name: body.name, text: body.text })
    return item ? { ok: true, item } : { ok: false, message: '正文不能是空的' }
  })
  route('/skills/delete', async (req) => {
    const body = await readBody(req)
    return { ok: skills.removeSkill(body.id) }
  })
  route('/skills/merge', async () => {
    // 手动触发一次整合：让模型看全量技能，判断哪些是同一件事
    const cfg2 = getConfig()
    const target = resolveModel(ctx, cfg2)
    if (!target) return { ok: false, message: '还没选提炼用的模型' }
    const all = skills.listSkills()
    if (all.length < 2) return { ok: false, message: '技能少于两条，没什么可整合的' }
    const text = all.map((s) => `#${s.id} ${s.name}：${s.text}`).join('\n')
    let out = ''
    try {
      out = await askModel(ctx, target, {
        system: '下面是一个聊天角色学会的做法列表。找出「其实是同一件事」的条目，把它们合成一条：名字用更准确的，描述保留信息最全的那句（不要简单拼接）。只输出 JSON：{"groups":[{"ids":["id1","id2"],"name":"名字","text":"描述"}]}。没有可合并的就输出 {"groups":[]}。不要输出别的文字。',
        text,
        maxTokens: 2000,
        temperature: 0.1,
      })
    } catch (error) {
      return { ok: false, message: `模型调用失败：${error.message}` }
    }
    const m = String(out).match(/\{[\s\S]*\}/)
    let groups = []
    try { groups = (JSON.parse(m ? m[0] : out).groups) || [] } catch {}
    const merged = skills.applyMergeGroups(groups, logger.child('skills'))
    return { ok: true, merged, message: merged ? `合并掉 ${merged} 条重复` : '没有需要合并的' }
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
    const r = deletePersona(body.id)
    if (!r.ok) return { ok: false, message: r.reason }
    // 删掉的正好是当前在用的那张 —— 必须自动切回 default，
    // 否则 cfg.persona.current 指向一个不存在的文件，readPersona 会静默退到第一张，
    // 面板上还显示旧名字，用户以为没删掉。
    if (String(body.id) === String(cfg.persona.current)) {
      setConfig({ ...cfg, persona: { ...cfg.persona, current: 'default' } })
    }
    return { ok: true }
  })
  route('/persona/create', async (req) => {
    const body = await readBody(req)
    const r = createPersona(body.id, { name: body.name, tags: body.tags, body: body.body })
    return r.ok ? { ok: true, id: r.id } : { ok: false, message: r.reason }
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
    // userid 口径归一：配置里存的是字符串，前端/工具偶尔传数字。
    // 严格相等会误判「没这个管理员」→ 重新填写直接失败，正是这次要修的症状。
    const uid = String(userid ?? '')
    if (!adminList().some((a) => a.userid === uid)) return { ok: false, message: '没这个管理员' }
    if (!MCP_SERVICES.some((s) => s.id === service)) return { ok: false, message: '没这个服务' }
    const ref = mcpRef(service, uid)
    const warn = []
    // 凭据库和配置文件是两条独立的存储，谁坏都不该拖垮另一条。
    // 老实现把 secrets.set 的异常抛到最外层，结果凭据服务一挂，
    // setAdminMcp 就不执行 —— 连 config.json 都存不上，用户永远配不好。
    // 现在：凭据库失败只降级成 warning，配置照样落盘（serviceUrlOf 会读 config）。
    if (!url) {
      try {
        await secrets.unset(ref)
      } catch (error) {
        warn.push(`凭据库里的旧地址没删掉（${error.message}），它可能还会被继续使用`)
      }
      mcpPool.delete(ref)
      return {
        ok: true,
        config: publicConfig(setConfig(setAdminMcp(uid, service, ''))),
        ...(warn.length ? { warning: warn.join('；') } : {}),
      }
    }
    const v = validateMcpUrl(url, service)
    if (!v.ok) return { ok: false, message: v.message }
    try {
      await secrets.set(ref, url)
    } catch (error) {
      warn.push(`凭据库里没存上（${error.message}），先按配置文件里的地址用，重启 DSH 后可能要重填`)
    }
    mcpPool.delete(ref)
    // 写后回读：确认这次填写真的能被读回来（口径/类型错误在这里就暴露）。
    let saved = ''
    try { saved = await secrets.resolve(ref) } catch {}
    if (saved !== url && !warn.length) warn.push('凭据已写但回读不一致，请检查凭据服务')
    if (secrets.kind() === 'memory') warn.push('凭据只存内存，重启 DSH 后会丢——请等凭据服务就绪后重填')
    return {
      ok: true,
      config: publicConfig(setConfig(setAdminMcp(uid, service, url))),
      ...(warn.length ? { warning: warn.join('；') } : {}),
    }
  })
  route('/mcp/test', async (req) => {
    const body = await readBody(req)
    const mc = await mcpFor(body.service, body.userid)
    if (!mc) return { ok: false, message: '还没配这个服务' }
    // 只列 tools/list 会假通过：授权过期（850003）时 initialize 和 tools/list
    // 永远 200，只有真调一次业务工具才暴露。面板曾因此显示「通了，6 个工具」。
    return probeService(mc, body.service)
  })
  route('/sessions', () => ({ ok: true, rows: Object.entries(hub.sessionMap()).map(([k, v]) => ({ key: k, ...v })) }))
  /**
   * 「排查」：出问题时点一下，拿到一份能直接发给维护者的结论。
   *
   * 为什么不是日志就够：图发不出去这件事，日志里只有企微的一句原文
   * 「非法的 chat_id」，看不出「这个企业的会话 ID 和 userid 不是一个值」。
   * 2026-11-28 那次是靠手工跑脚本才捞出来的，不该每次都那样。
   * 只读：只列会话、只查通讯录，不发明消息。
   */
  route('/diagnose/chatid', async () => {
    try {
      return await diagnoseChatId({ cfg, mcpFor, log: logger.child('diagnose') })
    } catch (error) {
      return { ok: false, message: String(error?.message || error) }
    }
  })

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
  route('/placeholder/image', async (req) => {
    const body = await readBody(req)
    // 面板选本地文件 → 读成 base64 传上来 → 存进插件数据目录。
    // 为什么不让面板直接填路径：浏览器里拿不到真实本地路径（input file 只给假路径），
    // 而且数据存在插件目录里，换机器/重装插件后配置里的路径不会指向一个不存在的文件。
    const name = String(body.name || 'placeholder.png')
    const b64 = String(body.base64 || '')
    if (!b64) return { ok: false, message: '没收到图片内容' }
    let buffer
    try { buffer = Buffer.from(b64, 'base64') } catch { return { ok: false, message: '图片内容解不开' } }
    if (!buffer.length) return { ok: false, message: '图片是空的' }
    if (buffer.length > 8 * 1024 * 1024) return { ok: false, message: '图片超过 8 MB，换一张小点的' }
    const ext = (name.match(/\.[A-Za-z0-9]+$/) || ['.png'])[0].toLowerCase()
    if (!['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)) {
      return { ok: false, message: `不支持的图片格式：${ext}` }
    }
    const file = join(DATA_DIR, 'placeholder' + ext)

    // 先预演，再落盘。顺序很重要：一张压到极限还超标的图，
    // 存下来只会让用户以为配好了、其实永远发不出去 —— 不如当场拒收，
    // 并说清原因和出路。所以「能不能发」必须在写文件之前就判定完。
    let preview = null
    try {
      const { describeImage, sniffImageMime } = await import('./wecom/media.js')
      const mime = sniffImageMime(buffer) || ''
      if (!mime) return { ok: false, message: '这不是一张能识别的图片（坏了或者扩展名不对）' }
      preview = await describeImage(buffer, mime)
    } catch (error) {
      // 预演本身出错不该挡住上传（可能只是 sharp 没装好）。
      // 这种情况预览为空，面板就不显示那句说明，图照常存。
      log.debug(`预回复图预演失败：${error.message}`)
    }
    if (preview && preview.sendable === false) {
      return { ok: false, message: preview.note, preview }
    }

    try {
      mkdirSync(DATA_DIR, { recursive: true })
      // 换格式时把旧的删掉，不然目录里会躺着一堆没人引用的图
      for (const old of ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']) {
        if (old !== ext) { try { rmSync(join(DATA_DIR, 'placeholder' + old), { force: true }) } catch {} }
      }
      writeFileSync(file, buffer)
    } catch (error) {
      return { ok: false, message: '存不下这张图：' + error.message }
    }
    cfg = saveConfig({ ...cfg, merge: { ...cfg.merge, placeholderImage: file, placeholderImageOn: true } })
    return { ok: true, path: file, bytes: buffer.length, preview, config: publicConfig(cfg) }
  })
  route('/placeholder/state', async () => {
    const path = cfg.merge.placeholderImage
    let bytes = 0
    try { if (path && existsSync(path)) bytes = statSync(path).size } catch {}
    // 面板每次加载也要能看到「现在这张图真发出去长什么样」，
    // 不然换了机器、或者图被别的地方改过，用户就不知道当前状态了。
    let preview = null
    if (path && bytes) {
      try {
        const { describeImage, sniffImageMime } = await import('./wecom/media.js')
        const buf = readFileSync(path)
        const mime = sniffImageMime(buf) || ''
        if (mime) preview = await describeImage(buf, mime)
      } catch (error) {
        log.debug(`预回复图状态预演失败：${error.message}`)
      }
    }
    return {
      ok: true,
      image: path,
      bytes,
      preview,
      lastImageError: placeholder.lastImageError,
      lastImageKind: placeholder.lastImageKind,
      lastImageAuthUrl: placeholder.lastImageAuthUrl,
      hasUpload: Boolean(await mcpUploadReady()),
    }
  })
  route('/placeholder/clear', async () => {
    // 只删插件自己存的那张（DATA_DIR 下的 placeholder.*），
    // 配置里的路径万一被人手改成别处的文件，绝不能顺手删掉。
    const old = cfg.merge.placeholderImage
    if (old && dirname(old) === DATA_DIR && /^placeholder\./.test(basename(old))) {
      try { rmSync(old, { force: true }) } catch {}
    }
    cfg = saveConfig({ ...cfg, merge: { ...cfg.merge, placeholderImage: '' } })
    return { ok: true, config: publicConfig(cfg) }
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
