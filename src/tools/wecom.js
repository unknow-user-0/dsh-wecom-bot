// 企微工具集：模型在这套会话里能用的工具
//
// 设计原则：
//   1. 描述里写清「能做什么 / 不能做什么 / 坑在哪」，模型才不瞎试
//   2. 「查不到」必须和「没有」区分开 —— 超 7 天要明确报超出范围，
//      绝不能返回空数组让模型以为事情没发生过然后开始编
//   3. 发消息三条路不能混：
//        respond  = 回复别人刚说的话（走长连接，必须带原 req_id）
//        send     = 主动推给已有会话（走长连接，对方必须先聊过）
//        mcp send = 走 MCP，署名是授权真人，只给管理员且要「用我的身份」闸门

import { defineTool, str, int, bool } from './define.js'
import { sendLocalFile, sendImageBuffer, uploadToDisk, searchDisk, MAX_FILE_BYTES } from '../wecom/outbound.js'

/**
 * @param {object} d deps
 * @param {Function} d.getConfig
 * @param {Function} d.getClient  () => 企微长连接客户端（惰性——客户端是连上才有的）
 * @param {Function} d.mcpFor     (service, userid) => client|null
 * @param {object} d.memory       记忆模块
 * @param {Function} d.activity   (entry) => void
 * @param {Function} d.chatOfSession (sessionId) => chat|null
 * @param {Function} d.recentMessages (chatId, limit) => rows
 * @param {Function} d.log
 */
export function buildTools(d) {
  const { getConfig, getClient, mcpFor, memory, chatOfSession, recentMessages, imagegen } = d  // 长连接客户端是连上之后才有的，工具得惰性取，不能在建工具时就绑死
  const client = new Proxy({}, {
    get(_t, k) {
      const c = getClient?.() || null
      const v = c ? c[k] : undefined
      return typeof v === 'function' ? v.bind(c) : v
    },
  })
  const tools = []
  const cfg = () => getConfig()

  // ── 回当前会话 ───────────────────────────────────────────
  tools.push(defineTool({
    name: 'wecom_reply',
    description: [
      '往当前企业微信会话回一条消息。',
      '只用于「你现在正在跟这个人/这个群说话」的情况。',
      '想发给别人用 wecom_send。',
      'markdown 支持标题、列表、粗体、行内代码；单条 6000 字以内，超了会截断。',
      '不要用它回「收到」这类废话。',
    ].join('\n'),
    properties: { text: str('要发出去的内容（markdown）') },
    required: ['text'],
    execute: async ({ text }, exec) => {
      const chat = chatOfSession?.(exec?.sessionId)
      if (!chat) return { ok: false, message: '这个会话不是企微来的，发不出去。' }
      await client.sendText(chat.chatId, chat.kind === 'group' ? 2 : 1, text)
      d.activity?.({ kind: 'out', chatId: chat.chatId, text })
      return { ok: true, message: '已发出。' }
    },
  }))

  // ── 主动推到别的会话 ─────────────────────────────────────
  tools.push(defineTool({
    name: 'wecom_send',
    description: [
      '主动往指定会话或指定人发一条消息（不是回复当前这句）。',
      '协议硬限制：对方必须先跟机器人说过话，否则企微根本推不进去。',
      '所以能发的只有：正在聊的这个人、之前聊过的人、管理员。',
      '发不过去会明确报错，失败就如实说失败，不要假装发成功。',
    ].join('\n'),
    properties: {
      to: str('对方 userid（发个人）或 chatid（发群）'),
      kind: str('dm 或 group'),
      text: str('内容（markdown）'),
    },
    required: ['to', 'text'],
    execute: async ({ to, kind, text }) => {
      try {
        await client.sendText(to, kind === 'group' ? 2 : 1, text)
        d.activity?.({ kind: 'out', chatId: to, text })
        return { ok: true, message: '已发出。' }
      } catch (error) {
        const hint = /chat|会话/i.test(String(error.message))
          ? '（对方可能还没跟机器人说过话，企微不允许主动推送到这种会话）'
          : ''
        return { ok: false, message: `发失败了：${error.message}${hint}` }
      }
    },
  }))

  // ── 用管理员自己的身份发 ──────────────────────────────────
  // 走 MCP 的 message_send，企微那边显示的发件人是**授权真人**，不是机器人。
  // 所以这条要两道闸：面板里打开 mcpSendAsMe，并且管理员在话里明确说了「用我的身份」。
  tools.push(defineTool({
    name: 'wecom_send_as_me',
    description: [
      '用管理员自己的企业微信身份发一条消息（对方看到的是管理员本人发的，不是机器人）。',
      '只有管理员在对话里明确要求「用我的身份 / 以我的名义」时才能用，别自己主动用。',
      '发出去收不回来，发之前把收件人和内容再确认一遍。',
      '普通成员没有这个能力。',
    ].join('\n'),
    properties: {
      to: str('对方 userid（发个人）或 chatid（发群）'),
      kind: str('dm 或 group'),
      text: str('消息内容，纯文本'),
    },
    required: ['to', 'text'],
    execute: async ({ to, kind, text }, exec) => {
      const chat = chatOfSession?.(exec?.sessionId)
      if (!chat) return { ok: false, message: '这个会话不是企微来源。' }
      const c = cfg()
      if (!chat.isAdmin) return { ok: false, message: '只有管理员能用这个。' }
      if (!c.features.mcpSendAsMe) {
        return { ok: false, message: '这个能力默认关着，让管理员在「功能」里打开「以我的身份发消息」。' }
      }
      // 闸门：管理员这一轮必须真的说过「用我的身份 / 以我的名义」。
      // 不做二次确认（老大定的），但这句暗号必须在原话里出现过。
      const said = String(d.lastText?.(exec?.sessionId) || '')
      if (!/用我的身份|以我的名义|用我的号|以我的身份/.test(said)) {
        return { ok: false, message: '这条要用管理员本人身份发，得管理员亲口说「用我的身份发……」。先问一句。' }
      }
      const mc = await mcpFor?.('msg', chat.userId)
      if (!mc) return { ok: false, message: '没配 MCP 的 msg 服务，用不了真人身份发送。' }
      try {
        const r = await mc.call('message_send', { chat_id: to, msg_type: 'text', text: String(text) })
        d.activity?.({ kind: 'out', chatId: to, text: `[以管理员身份] ${text}` })
        return { ok: true, message: `用你的身份发出去了。${r && r.errcode ? `（errcode ${r.errcode}）` : ''}` }
      } catch (error) {
        return { ok: false, message: `发失败了：${error.message}` }
      }
    },
  }))

  // ── 本会话历史（本地，永久）───────────────────────────────
  tools.push(defineTool({
    name: 'wecom_history',
    description: [
      '读当前会话在本地留下的消息记录（你自己上下文里已经有的别再查一遍）。',
      '能读：本插件收到和发出的全部消息，永久保留。',
      '读不到：机器人不在场时群里的聊天 —— 那用 wecom_group_history，且只能查最近 7 天。',
    ].join('\n'),
    properties: { limit: int('要几条，默认 20，最多 100') },
    execute: async ({ limit }, exec) => {
      const chat = chatOfSession?.(exec?.sessionId)
      if (!chat) return { ok: false, message: '这个会话不是企微来的。' }
      const rows = recentMessages?.(chat.chatId, Math.min(100, Number(limit) || 20)) || []
      if (!rows.length) return { ok: true, message: '这个会话还没有记录。' }
      return { ok: true, message: rows.map((r) => `${r.from}（${r.at}）：${r.text}`).join('\n') }
    },
  }))

  // ── 群历史（MCP，只能 7 天）───────────────────────────────
  tools.push(defineTool({
    name: 'wecom_group_history',
    description: [
      '拉某个群/某个私聊最近的聊天记录（走企微 MCP 的 msg 服务）。',
      '',
      '⚠️ 只能查最近 7 天。超出范围会明确返回「超出可查范围」，这时必须如实告诉对方「太早的记录查不到」，',
      '绝对不能因为返回空就说「没发生过」。',
      '',
      '企微这个接口给的是全量消息，没有 @ 的也能看到 —— 被 @ 想补上下文时用它。',
    ].join('\n'),
    properties: {
      chat_id: str('群 chatid 或私聊对方 userid；留空 = 当前会话'),
      minutes: int('往回查多少分钟，默认 60，最大 10080'),
      limit: int('最多返回几条，默认 40，上限 200'),
    },
    execute: async ({ chat_id, minutes, limit }, exec) => {
      const mc = await mcpFor?.('msg')
      if (!mc) return { ok: false, message: '没配 MCP 的 msg 服务，读不了群历史。让管理员在设置里填。' }
      const chat = chatOfSession?.(exec?.sessionId)
      const target = String(chat_id || chat?.chatId || '')
      if (!target) return { ok: false, message: '不知道查哪个会话。' }

      const { safeWindow, localTime } = await import('../wecom/mcp.js')
      const now = Date.now()
      const m = Math.min(10080, Math.max(1, Number(minutes) || 60))
      if (now - m * 60000 < now - 7 * 86400e3) {
        return { ok: false, message: '超出可查范围：企微只允许查最近 7 天的消息。更早的我确实看不到。' }
      }
      const w = safeWindow(6 * 86400e3, now)
      const begin = m * 60000 > 6 * 86400e3 ? w.begin : localTime(now - m * 60000)

      try {
        const r = await mc.call('chat_messages_list', { chat_id: target, begin_time: begin, end_time: w.end })
        const list = r.message_list || r.messages || []
        if (!Array.isArray(list) || list.length === 0) {
          return { ok: true, message: `这个时间窗（${begin} ~ ${w.end}）里没有消息。注意：空不代表没聊过，也可能是这段时间真的没人说话。` }
        }
        const cap = Math.min(200, Number(limit) || 40)
        const rows = list.slice(-cap).map((it) => {
          const who = it.user_name || it.userid || '某人'
          const when = String(it.send_time || '').slice(11, 16)
          const body = it.text?.content ?? it.content ?? `[${it.msg_type || '未知类型'}]`
          return `${who}（${when}）：${body}`
        })
        const head = list.length > cap ? `（共 ${list.length} 条，这里给最近 ${cap} 条）\n` : ''
        return { ok: true, message: head + rows.join('\n') }
      } catch (error) {
        if (/850016/.test(String(error.message)) || String(error.code) === '850016') {
          return { ok: false, message: '超出可查范围：企微只允许查最近 7 天的消息。' }
        }
        return { ok: false, message: `查失败：${error.message}` }
      }
    },
  }))

  // ── 记忆 ────────────────────────────────────────────────
  tools.push(defineTool({
    name: 'wecom_memory',
    description: [
      '记住 / 回忆关于某人的事。四层：',
      '  person = 关于某个人（跨群跨私聊都认），只有和这个人对话时才召回',
      '  scene  = 只属于当前这个群 / 这个私聊的事，只在当前场景召回',
      '  skill  = 怎么做一件事（所有人共享，如「TMS 提交要带 submit=1」）',
      '  public = 全公司通用事实（所有人共享）',
      '',
      'type 决定忘得多快：relation（关系，永不衰减）/ preference（喜好，180 天）/',
      'fact（一般事实，60 天）/ state（临时状态，7 天）/ ephemeral（按 expires_hours 过期）。',
      '',
      '该记：对方的偏好、忌讳、身份、习惯、正在做要紧事。',
      '不该记：一次性闲聊、能自己查到的公开信息、别人的隐私不该扩散到群里。',
    ].join('\n'),
    properties: {
      action: str('remember / recall / forget'),
      text: str('remember：要记住的一句话（直接陈述事实，不要写「用户说」）'),
      scope: str('remember：person / scene / skill / public'),
      type: str('remember：relation / preference / fact / state / ephemeral'),
      about: str('remember：关于谁（userid）；不填 = 当前说话的人'),
      query: str('recall：想回忆什么'),
      id: str('forget：要作废的条目 id'),
      expires_hours: int('ephemeral 时：几小时后过期'),
    },
    required: ['action'],
    execute: async (args, exec) => {
      if (!cfg().features.memory) return { ok: false, message: '记忆功能关着。' }
      const chat = chatOfSession?.(exec?.sessionId)
      const action = String(args.action || 'recall')

      if (action === 'remember') {
        if (!args.text) return { ok: false, message: '要记什么内容？' }
        const item = memory.add({
          text: args.text,
          scope: args.scope || (args.about ? 'person' : (chat?.kind === 'dm' ? 'person' : 'scene')),
          type: args.type || 'fact',
          about: args.about || (chat?.kind === 'dm' ? chat.userId : ''),
          aboutName: args.about ? '' : (chat?.kind === 'dm' ? chat.displayName : ''),
          chatId: chat?.chatId || '',
          originKind: chat?.kind || '',
          originName: chat?.name || '',
          expiresAt: args.expires_hours ? Date.now() + Number(args.expires_hours) * 3600e3 : 0,
          source: 'tool',
        })
        return item ? { ok: true, message: `记住了（id ${item.id}）。` } : { ok: false, message: '这条没能记下。' }
      }

      if (action === 'forget') {
        if (!args.id) return { ok: false, message: '要作废哪条？给个 id。' }
        return { ok: memory.remove(args.id), message: memory.remove(args.id) ? '已作废。' : '没找到这条。' }
      }

      const hits = memory.recall(args.query || '', {
        about: chat?.kind === 'dm' ? chat.userId : '',
        chatId: chat?.chatId || '',
        limit: 12,
      })
      if (!hits.length) return { ok: true, message: '没有相关记忆。' }
      return { ok: true, message: hits.map((h) => memory.renderLine(h.it, chat?.chatId || '')).join('\n') }
    },
  }))

  // ── 发文件 ──────────────────────────────────────────────
  tools.push(defineTool({
    name: 'wecom_send_file',
    description: [
      '把一个本地文件发到当前企微会话。',
      `单文件上限 ${MAX_FILE_BYTES / 1048576} MB。更大的先传微盘再发链接（微盘单文件上限 20 GB）。`,
      '走的是 MCP 上传 + 机器人消息，所以需要管理员配好 disk 与 msg 两个 MCP 服务。',
      '发文件默认只允许管理员，普通成员要用得管理员在面板里放开。',
    ].join('\n'),
    slow: '我传一下，稍等。',
    properties: {
      path: str('本地文件的完整路径'),
      to_group: bool('true = 发到当前群；false = 私聊发给当前这个人'),
    },
    required: ['path'],
    execute: async ({ path, to_group }, exec) => {
      const chat = chatOfSession?.(exec?.sessionId)
      if (!chat) return { ok: false, message: '这个会话不是企微来的。' }
      const c = cfg()
      const allowed = c.features.sendFileToUser === 'all'
        || (c.features.sendFileToUser === 'admin' && chat.isAdmin)
      if (!allowed) return { ok: false, message: '当前设置只允许管理员发文件，让管理员在面板里放开。' }
      const target = to_group && chat.kind === 'group' ? chat.chatId : (chat.kind === 'dm' ? chat.userId : chat.chatId)
      try {
        const r = await sendLocalFile(
          { path, chatId: target, chatType: to_group && chat.kind === 'group' ? 2 : 1 },
          { mcpFor, log: d.log },
        )
        return { ok: true, message: `已发出 ${r.fileName}（${(r.bytes / 1024).toFixed(0)} KB）。` }
      } catch (error) {
        return { ok: false, message: error.message }
      }
    },
  }))

  // ── 微盘 ────────────────────────────────────────────────
  tools.push(defineTool({
    name: 'wecom_disk',
    description: [
      '操作企微微盘（上传大文件、搜文件）。走 MCP 的 disk 服务。',
      '注意：微盘**没有删除**接口，也没有「列出全部」，只能按关键词搜。',
      '上传后落在「共享空间」里，用 disk_files_search 才搜得到。',
    ].join('\n'),
    properties: {
      action: str('upload / search'),
      path: str('upload：本地文件路径'),
      keyword: str('search：文件名关键词'),
      folder_id: str('upload：目标文件夹 id，不填放我的空间'),
    },
    required: ['action'],
    execute: async ({ action, path, keyword, folder_id }) => {
      try {
        if (action === 'upload') {
          if (!path) return { ok: false, message: '要传哪个文件？给个路径。' }
          const r = await uploadToDisk({ path, folderId: folder_id }, { mcpFor, log: d.log })
          return { ok: true, message: `已上传微盘。${JSON.stringify(r).slice(0, 300)}` }
        }
        if (!keyword) return { ok: false, message: '搜什么关键词？' }
        const r = await searchDisk(keyword, { mcpFor })
        return { ok: true, message: JSON.stringify(r).slice(0, 1500) }
      } catch (error) {
        return { ok: false, message: error.message }
      }
    },
  }))

  // ── 画图 ────────────────────────────────────────────────
  // 生图要一两分钟，标 slow 让它先回一句「正在画」。
  tools.push(defineTool({
    name: 'wecom_draw',
    description: [
      '画一张图并直接发到当前企微会话。',
      '只在管理员在设置里配好生图服务（OpenAI 兼容接口或自建接口）之后才能用。',
      '一次画一张，需要多张就多次调用。',
    ].join('\n'),
    slow: '我画一下，大概要一两分钟。',
    properties: {
      prompt: str('画什么。写具体一点：主体、风格、构图、色调'),
    },
    required: ['prompt'],
    execute: async ({ prompt }, exec) => {
      if (!imagegen) return { ok: false, message: '生图模块没初始化。' }
      if (!imagegen.enabled()) return { ok: false, message: '生图还没配好（设置 → 陪伴 → 生图）。' }
      const chat = chatOfSession?.(exec?.sessionId)
      if (!chat) return { ok: false, message: '这个会话不是企微来的。' }
      try {
        const img = await imagegen.generate(prompt)
        const target = chat.kind === 'group' ? chat.chatId : chat.userId
        await sendImageBuffer(
          { buffer: img.buffer, chatId: target, chatType: chat.kind === 'group' ? 2 : 1, fileName: 'draw.png' },
          { mcpFor, log: d.log },
        )
        return { ok: true, message: `画好了，已经发过去（${Math.round(img.buffer.length / 1024)} KB）。` }
      } catch (error) {
        return { ok: false, message: error.message }
      }
    },
  }))

  // ── MCP 通用入口（文档/待办/日程/会议/邮件/通讯录/微盘）──────
  // 企微给机器人配的 8 组 StreamableHttp 服务，总共一百多个工具。
  // 全展开进工具列表会把系统提示撑爆（每个工具几百字描述），所以只给两个动词：
  //   list —— 先看这个服务有哪些工具、要什么参数
  //   call —— 真调一次
  // 写操作（建/改/删/发）单独一道闸：面板里「MCP 写操作」开着才放行。
  const WRITE_TOOL_RE = /(^|_)(create|add|update|modify|delete|remove|send|submit|finish|cancel|upload|rename|move|copy)(_|$)/i
  tools.push(defineTool({
    name: 'wecom_mcp',
    description: [
      '企业微信原生能力入口：文档/表格、待办、日程、会议、邮件、通讯录、微盘。',
      '用法：先 action=list 看这个 service 有哪些工具和参数，再 action=call 带上参数调用。',
      'service 只能是：msg / mail / doc / todo / schedule / meeting / disk / contact。',
      '⚠ 三条硬限制写在这里，别试没写的东西：',
      '  · 邮件、群消息历史都只能查「当前时刻前后 7 天」，超了会报错，不是没有数据。',
      '  · 微盘和文档都**没有删除**工具，只能建、改、搜、传。',
      '  · 通讯录只能按关键词搜，不能全量罗列成员。',
      '写操作（建/改/删/发）需要管理员在面板里打开「MCP 写操作」，没开会明确拒绝。',
    ].join('\n'),
    slow: '我查一下。',
    properties: {
      action: str('list = 看有哪些工具；call = 执行一个'),
      service: str('msg / mail / doc / todo / schedule / meeting / disk / contact'),
      tool: str('action=call 时的工具名，来自 list 的结果'),
      args: { type: 'object', additionalProperties: true, description: 'action=call 时的参数对象' },
    },
    required: ['action', 'service'],
    execute: async ({ action, service, tool, args }, exec) => {
      const chat = chatOfSession?.(exec?.sessionId) || {}
      const mc = await mcpFor?.(service, chat.userId)
      if (!mc) return { ok: false, message: `没配 ${service} 这个 MCP 服务，让管理员在面板里填 URL。` }
      if (action === 'list') {
        try {
          const list = await mc.listTools()
          const rows = list.map((t) => ({
            name: t.name,
            desc: String(t.description || '').split('\n')[0].slice(0, 120),
            write: WRITE_TOOL_RE.test(t.name),
          }))
          const writes = rows.filter((r) => r.write).length
          return {
            ok: true,
            message: `${service} 有 ${rows.length} 个工具（其中 ${writes} 个是写操作）：\n`
              + rows.map((r) => `· ${r.name}${r.write ? '（写）' : ''} —— ${r.desc}`).join('\n'),
          }
        } catch (error) {
          return { ok: false, message: `列不出来：${error.message}` }
        }
      }
      if (action !== 'call') return { ok: false, message: 'action 只能是 list 或 call。' }
      if (!tool) return { ok: false, message: '要调哪个工具？先 action=list 看一眼。' }
      if (WRITE_TOOL_RE.test(tool) && !cfg().features.mcpWrite) {
        return {
          ok: false,
          message: `「${tool}」是写操作，管理员还没在面板里打开「MCP 写操作」。先问一句，别自己动手。`,
        }
      }
      try {
        const r = await mc.call(tool, args && typeof args === 'object' ? args : {})
        return { ok: true, message: JSON.stringify(r).slice(0, 4000) }
      } catch (error) {
        return { ok: false, message: `调 ${tool} 失败了：${error.message}` }
      }
    },
  }))

  return tools
}
