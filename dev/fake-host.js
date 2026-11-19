// 假宿主：照着 DSH 的 Cordis ctx 形状造一个，用来在不装进 DSH 的情况下跑通插件
//
// 目的：能在本机直接跑 apply()，喂假的企微帧进去，看它走到哪一步、
// 工具挂上了没、回复内容对不对。真机联调前先用它把逻辑跑通。

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function createFakeHost(opts = {}) {
  const effects = []
  const routes = new Map()
  const log = []
  const sessions = new Map()      // sessionId → { events: [], appended: [], prompts: [] }
  const variables = new Map()
  const tools = new Map()
  const createCalls = []

  const ctx = {
    effect(fn, label) {
      let off
      try { off = fn() } catch (error) { throw error }
      effects.push({ off, label })
      return () => { try { if (typeof off === 'function') off() } catch {} }
    },
    on(event, fn) {
      const key = 'on:' + event
      if (!listeners.has(key)) listeners.set(key, [])
      listeners.get(key).push(fn)
      return () => {
        const arr = listeners.get(key) || []
        const i = arr.indexOf(fn)
        if (i >= 0) arr.splice(i, 1)
      }
    },
    get(name) { return services[name] || null },
    provide() {},
    // ---- webServer ----
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    // ---- systemPrompt ----
    systemPrompt: {
      variable(name, fn) { variables.set(name, fn); return () => variables.delete(name) },
      context() { return () => {} },
    },
    // ---- sessionPersistence ----
    sessionPersistence: {
      async open(id, access) {
        const rec = ensureSession(id)
        rec.openAccess = access
        return {
          id,
          access,
          async append(events) { for (const e of [].concat(events)) rec.events.push(e) },
          async flush() {},
          async close() {},
        }
      },
    },
    // ---- sessionController ----
    sessionController: {
      async create({ workspaceId, agentPreset }) {
        const sid = 'sess-' + Math.random().toString(36).slice(2, 10)
        createCalls.push({ workspaceId, agentPreset, sessionId: sid })
        ensureSession(sid, { preset: agentPreset })
        return { sessionId: sid }
      },
      async rename({ sessionId, title }) { const r = ensureSession(sessionId); r.title = title },
      async resolveAgent(sid) {
        const r = ensureSession(sid)
        return { agent: r.agent }
      },
    },
    // ---- workspaceRegistry ----
    workspaceRegistry: {
      async list() { return [{ id: 'ws-1', title: '企业微信 · AI', path: '/tmp/x' }] },
      async create({ title, dir }) { return { id: 'ws-1', title, path: dir } },
      archivedSessionIds: [],
      async archiveSession() {},
    },
    // ---- agents ----
    agents: { get: (sid) => ensureSession(sid).agent },
    // ---- sessions ----
    sessions: { async flush() {} },
    // ---- attachments ----
    attachments: {
      async admitPromptContent(content) { return content },
      async saveImage() { return { id: 'img-1' } },
    },
    // ---- tools ----
    // 跟真的一模一样地挡同名注册：真 dsh-tools 的 NamedEntries.insert 遇同名直接抛
    // 「tool "x" is already registered in this scope」。这里以前是静默覆盖，
    // 于是「并发挂同一批工具」这个 bug 测试永远抓不到。
    tools: {
      register(tool) {
        if (tools.has(tool.name)) throw new Error(`tool "${tool.name}" is already registered in this scope`)
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
      restrict() { return () => {} },
    },
  }

  const listeners = new Map()
  const services = {}
  function ensureSession(id, extra = {}) {
    if (!sessions.has(id)) {
      const promptReply = { text: opts.replyText ?? '好的' }
      const rec = {
        id, events: [], prompts: [], steers: [], title: '',
        agent: {
          id,
          session: { id },
          ctx: { tools: ctx.tools },
          async followup(message) {
            rec.prompts.push(message)
            // 模拟模型跑一轮：先回 assistant/message，再 turn/end
            const turn = rec.prompts.length
            emit('session/event', rec.agent.session, {
              type: 'assistant/message',
              data: { turn, message: { content: [{ type: 'text', text: opts.replyText ?? '好的' }] } },
            })
            emit('session/event', rec.agent.session, {
              type: 'turn/end',
              data: { turn, reason: { kind: opts.turnEnd ?? 'completed' } },
            })
          },
          async steer(message) { rec.steers.push(message) },
        },
      }
      sessions.set(id, rec)
    }
    return sessions.get(id)
  }

  function emit(event, session, payload) {
    for (const fn of listeners.get('on:' + event) || []) {
      try { fn(session, payload) } catch (error) { log.push('EMIT ERROR: ' + error.message) }
    }
  }

  return {
    ctx, routes, sessions, variables, tools, createCalls, log, listeners,
    get service() { return services },
    callRoute(path, body) {
      const r = routes.get(path)
      if (!r) return Promise.resolve({ ok: false, message: 'no route ' + path })
      const req = { url: 'http://x' + path, ...(body ? {} : {}) }
      if (body) req[Symbol.asyncIterator] = async function* () { yield Buffer.from(JSON.stringify(body)) }
      else req[Symbol.asyncIterator] = async function* () {}
      return new Promise((resolve) => {
        const res = {
          statusCode: 0, headers: {}, body: '',
          setHeader(k, v) { this.headers[k] = v },
          end(b) { resolve(JSON.parse(String(b))) },
        }
        r.handler(req, res)
      })
    },
  }
}
