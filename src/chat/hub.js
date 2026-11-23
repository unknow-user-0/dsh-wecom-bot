// 会话中枢：一个企微会话（单聊 / 群）↔ 一个 DSH 会话
//
// 关键设计（照 araubot 的做法，但换了坑）：
//   - 每会话一个独立 DSH 会话，落在「企业微信 · XXX」工作区
//   - 会话映射存 dataDir/sessions.json
//   - 触发模型用 agent.followup(message)；只记不触发用 sessionPersistence.open(...).append()
//   - 权限档位变了（比如某人被加进管理员）→ 换新会话（preset 是会话级属性）
//
// ⚠ 影子会话（有人第一次在群里 @ 但没私聊过）：
//   企微 aibot_send_msg 要求用户先在会话里找过机器人，所以影子会话不能主动发消息。
//   做法：只在 DSH 会话里记录（append），等对方私聊时复用同一个会话 ID 再首次 followup。
//   「往会话写内容但不触发模型」靠 append 实现 —— 它只进历史、不进 inbox。

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { DATA_DIR, isOwner } from '../core/config.js'

const MAP_FILE = join(DATA_DIR, 'sessions.json')

/** 工作区标题（面板里那个分组名） */
export const WORKSPACE_TITLE = '企业微信 · AI'

/** 工作区目录：配置里有就用配置的，否则 ~/WeComBot/chats。改了配置下次自动切过去。 */
export const workspaceDirOf = (cfg) =>
  String(cfg?.workspaceDir || '').trim() ||
  join(process.env.USERPROFILE || process.env.HOME || '.', 'WeComBot', 'chats')

/** 会话 key：channel:kind:chatId —— 加通道后不会撞（智能机器人和自建应用同一个群给不同 ID） */
export function sessionKeyOf(channel, kind, chatId) {
  return `${channel}:${kind}:${chatId}`
}

function loadMap() {
  try {
    if (existsSync(MAP_FILE)) return JSON.parse(readFileSync(MAP_FILE, 'utf8'))
  } catch {}
  return { chats: {} }
}
function saveMap(m) {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    const tmp = MAP_FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify(m, null, 2), 'utf8')
    renameSync(tmp, MAP_FILE)
  } catch {}
}

/** 会话标题：企业微信 · 张三私聊 / 企业微信 · 太子群 */
export function titleFor(chat, cfg) {
  const owner = chat.kind === 'dm' && cfg.admins.some((a) => a.userid === chat.userId && a.role === 'owner')
  if (chat.kind === 'group') return `企业微信 · ${chat.groupName || chat.chatId}`
  const name = chat.displayName || chat.userId
  return owner ? `企业微信 · ${name}（管理员）` : `企业微信 · ${name}私聊`
}

export function createHub({ ctx, log, getConfig }) {
  const dsh = ctx
  let controllerCached = null

  function controller() {
    if (controllerCached) return controllerCached
    const c = dsh.get?.('sessionController') || dsh.sessionController
    if (!c) throw new Error('宿主没有 sessionController（需要 DSH 桌面版 / Web 组合）')
    controllerCached = c
    return c
  }

  function persistence() {
    const p = dsh.get?.('sessionPersistence') || dsh.sessionPersistence
    if (!p) throw new Error('宿主没有 sessionPersistence 服务')
    return p
  }

  // ---------- 工作区 ----------
  // 一个插件一个工作区，所有企微会话都落在里面。
  // 按「路径」认已有工作区，不按标题 —— 路径才是工作区的身份，
  // 面板里改 workspaceDir 之后会自动指向新目录，不会两套工作区打架。
  let wsCache = null
  const normPath = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase()
  async function ensureWorkspace() {
    const cfg = getConfig()
    const dir = workspaceDirOf(cfg)
    // 改了目录就得重新找 —— 缓存绑的是上一个路径
    if (wsCache && normPath(wsCache.path) === normPath(dir)) return wsCache
    try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch {}
    const reg = dsh.get?.('workspaceRegistry') || dsh.workspaceRegistry
    if (!reg) throw new Error('宿主没有 workspaceRegistry')
    const all = typeof reg.list === 'function' ? (await reg.list()) || [] : []
    let found = all.find((w) => normPath(w?.path) === normPath(dir))
    if (!found) {
      if (typeof reg.create !== 'function') throw new Error('workspaceRegistry 没有 create')
      // 宿主签名是位置参数 create(path, title)，传对象会炸在 path 类型检查上
      found = await reg.create(dir, WORKSPACE_TITLE)
      log.info(`建好了工作区「${WORKSPACE_TITLE}」：${dir}`)
    }
    wsCache = found
    return found
  }

  // ---------- preset 选择 ----------
  function presetFor(level, cfg) {
    if (level === 'owner') return cfg.longTasks ? 'wecom-owner-long' : 'wecom-owner'
    return 'wecom-social'
  }

  /**
   * 权限档位：
   *   owner  — 主人私聊（完整工具）
   *   social — 群聊 / 普通管理员 / 白名单成员私聊（只有社交工具）
   *
   * 跟 checkAccess 必须用同一套判断：都走 config.js 的 isOwner。
   * 这里以前只判「在不在 admins 里」，普通管理员也会拿到完整工具档位。
   */
  function levelFor(cfg, chat) {
    if (chat.kind === 'dm' && isOwner(cfg, chat.userId)) return 'owner'
    return 'social'
  }

  // ---------- 建会话 ----------
  async function createSession(chat, level, cfg) {
    const ws = await ensureWorkspace()
    const preset = presetFor(level, cfg)
    const r = await controller().create({ workspaceId: ws.id, agentPreset: preset })
    const sid = String(r.sessionId)
    try {
      await controller().rename({ sessionId: sid, title: titleFor(chat, cfg) })
    } catch (error) {
      log.debug(`改会话标题失败：${error.message}`)
    }
    const m = loadMap()
    const key = sessionKeyOf('wecom', chat.kind, chat.chatId)
    m.chats[key] = {
      sessionId: sid, preset, level, createdAt: Date.now(),
      title: titleFor(chat, cfg), userId: chat.userId || '', groupId: chat.kind === 'group' ? chat.chatId : '',
    }
    saveMap(m)
    log.info(`为 ${key} 新建 DSH 会话 ${sid.slice(-8)}（${preset}）`)
    return sid
  }

  async function resolveAgent(sid) {
    const live = dsh.agents?.get?.(sid) || dsh.agents?.get?.('session-' + sid)
    if (live) return live
    const r = await controller().resolveAgent(sid)
    if (r && r.agent) return r.agent
    const e = r && r.error
    throw Object.assign(new Error(e?.message || '恢复会话失败'), { code: e?.code })
  }

  /** 拿到这个企微会话对应的活 agent（没有就建，档位变了就换新会话） */
  async function agentFor(chat) {
    const cfg = getConfig()
    const level = levelFor(cfg, chat)
    const preset = presetFor(level, cfg)
    const key = sessionKeyOf('wecom', chat.kind, chat.chatId)
    const map = loadMap()
    const entry = map.chats[key]
    let sid = entry && entry.preset === preset && entry.level === level ? entry.sessionId : ''
    let agent = null

    if (sid) {
      try {
        agent = await resolveAgent(sid)
      } catch (error) {
        log.warn(`会话 ${sid.slice(-8)} 恢复不了（${error.message}），换一个新的`)
        sid = ''
      }
      const reg = dsh.workspaceRegistry || dsh.get?.('workspaceRegistry')
      if (sid && reg && (reg.archivedSessionIds || []).includes(sid)) {
        log.info(`会话 ${sid.slice(-8)} 被归档了，换一个新的`)
        sid = ''
        agent = null
      }
    }

    if (!sid) {
      sid = await createSession(chat, level, cfg)
      agent = await resolveAgent(sid)
    }
    return { agent, sessionId: sid, level }
  }

  /** 会话已存在就拿 ID，不存在返回 null（不建） */
  function existingSessionId(chat) {
    const key = sessionKeyOf('wecom', chat.kind, chat.chatId)
    const entry = loadMap().chats[key]
    return entry ? entry.sessionId : null
  }

  /**
   * 只往会话历史里写一条，不触发模型。
   * 用途：影子会话记录群里说过的话；把人说过的话补进上下文。
   * @returns {Promise<boolean>} 成功与否
   */
  async function appendOnly(sessionId, text, source = 'wecom') {
    if (!sessionId) return false
    try {
      const handle = await persistence().open(sessionId, 'write')
      await handle.append([{
        type: 'user/message',
        data: {
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: source },
        },
        surfaceOp: 'append',
      }])
      await handle.flush?.()
      await handle.close?.()
      return true
    } catch (error) {
      log.debug(`append 失败（${sessionId.slice(-8)}）：${error.message}`)
      return false
    }
  }

  /** 触发模型（真正跑一轮） */
  async function prompt(chat, text, opts = {}) {
    const { agent, sessionId, level } = await agentFor(chat)
    const cfg = getConfig()

    // 内容要过 attachments.admitPromptContent，才能挂图片
    let content = [{ type: 'text', text }]
    if (opts.attachments && opts.attachments.length) {
      try {
        const admitted = await dsh.attachments?.admitPromptContent?.([...content, ...opts.attachments])
        if (Array.isArray(admitted) && admitted.length) content = admitted
      } catch (error) {
        log.debug(`attachments 未接纳（${error.message}），只发文本`)
      }
    }

    const message = {
      id: randomUUID(),
      role: 'user',
      content,
      source: { kind: 'wecom' },
    }
    if (opts.steer) await agent.steer(message)
    else await agent.followup(message)
    try { await dsh.sessions?.flush?.(agent.session) } catch {}

    return { agent, sessionId, level, config: cfg }
  }

  /**
   * 忘掉所有会话映射。工作区目录改了之后用：老的 DSH 会话还在老工作区里、侧栏能看到，
   * 但映射清掉之后，下一条消息会在新工作区里重新建会话 —— 不然会把新消息塞回老工作区的会话里。
   */
  function forgetSessions() {
    saveMap({ chats: {} })
    log.info('会话映射已清空（下次来消息会在当前工作区重开）')
    return true
  }

  return {
    agentFor,
    prompt,
    appendOnly,
    existingSessionId,
    levelFor,
    presetFor,
    ensureWorkspace,
    forgetSessions,
    workspaceDir: () => workspaceDirOf(getConfig()),
    sessionMap: () => loadMap().chats,
  }
}
