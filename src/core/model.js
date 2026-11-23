// 后台调一次模型（不进会话、不进历史）。
// 用途：记忆提炼、技能整理这类「插件自己的小活」——
// 它们不该占用用户正在聊的那个会话，也不该把结果写进对话历史。
//
// DSH 的 llm 服务一次调用要 provider + model 两个坐标。用户可能在设置里换了模型、
// 也可能根本没配（本地跑、只有 ollama）。所以：
//   1. 优先用插件自己的配置（cfg.model）
//   2. 没配就跟随 DSH 当前默认模型
//   3. 都拿不到就明确报错，让面板上有话可说，而不是静默不动

import { randomUUID } from 'node:crypto'

/** 一次调用的稳定形状：成功返回文本，失败抛错（调用方自己决定是记日志还是提示用户） */
async function runStream(llm, params) {
  let out = ''
  for await (const chunk of llm.stream(params)) {
    if (!chunk) continue
    if (chunk.type === 'text-delta') out += chunk.text
    if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
      const f = chunk.reason.failure || {}
      const error = new Error(f.message || f.code || '模型报错了')
      if (f.code) error.code = f.code
      throw error
    }
  }
  return out.trim()
}

/** DSH 侧的能力探测：这个模型认不认 reasoningEffort。探测不到就干脆不传。 */
const effortCache = new Map()
async function pickEffort(llm, provider, model, want) {
  const key = `${provider}::${model}`
  if (effortCache.has(key)) {
    const r = effortCache.get(key)
    if (!r) return undefined
    return r.efforts.includes(want) ? want : (r.efforts.includes(r.default) ? r.default : undefined)
  }
  let info = null
  try {
    if (typeof llm.resolveModelInfo === 'function') info = await llm.resolveModelInfo(provider, model)
  } catch {}
  // 字段名照 dsh-llm 的 LlmModelReasoningInfo：efforts + defaultEffort（不是 default）
  const r = info && info.reasoning && Array.isArray(info.reasoning.efforts)
    ? { efforts: info.reasoning.efforts.map((e) => (typeof e === 'string' ? e : e.id)), default: info.reasoning.defaultEffort }
    : null
  effortCache.set(key, r)
  if (!r) return undefined
  return r.efforts.includes(want) ? want : (r.efforts.includes(r.default) ? r.default : undefined)
}

const unsupportedEffort = (e) => /UNSUPPORTED_REASONING_EFFORT|does not support reasoning effort/i.test(String(e && (e.message || e.code) || ''))

/**
 * 拿一个能用的模型坐标。
 * @returns {{provider:string, model:string}|null}
 */
export function resolveModel(dsh, cfg) {
  const want = cfg && cfg.model
  if (want && want.provider && want.model) return { provider: want.provider, model: want.model }
  try {
    const svc = dsh.get && dsh.get('agentDefaultModel')
    const sel = svc && typeof svc.currentSelection === 'function' ? svc.currentSelection() : null
    if (sel && sel.provider && sel.model) return { provider: sel.provider, model: sel.model }
  } catch {}
  return null
}

/** 面板用：当前可用的所有模型（provider 列表 → 每个 provider 下的模型） */
export async function listModels(dsh) {
  const llm = dsh.llm || (dsh.get && dsh.get('llm'))
  if (!llm) return { ok: false, message: '宿主没有 llm 服务', providers: [], models: [] }
  const providers = []
  const models = []
  let list = []
  try {
    list = typeof llm.listProviders === 'function' ? llm.listProviders() : []
  } catch {}
  for (const p of list) {
    const id = typeof p === 'string' ? p : p.id
    const name = typeof p === 'string' ? p : (p.name || p.id)
    if (!id) continue
    providers.push({ id, name })
    let ms = []
    try {
      ms = typeof llm.listModels === 'function' ? await llm.listModels(id) : []
    } catch {}
    for (const m of ms) {
      const mid = typeof m === 'string' ? m : m.id
      if (!mid) continue
      models.push({ provider: id, model: mid, name: (typeof m === 'object' && m.name) || mid, providerName: name })
    }
  }
  return { ok: true, providers, models }
}

/**
 * 后台问一次模型。
 * @param {object} dsh 宿主 ctx
 * @param {{provider:string, model:string}} target resolveModel() 的结果
 * @param {{system?:string, text:string, maxTokens?:number, temperature?:number, effort?:string, signal?:AbortSignal}} o
 */
export async function ask(dsh, target, o) {
  const llm = dsh.llm || (dsh.get && dsh.get('llm'))
  if (!llm || typeof llm.stream !== 'function') throw new Error('宿主没有 llm 服务')
  if (!target || !target.provider || !target.model) throw new Error('还没选模型')
  const messages = [{
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(o.text || '') }],
    source: { kind: 'plugin', plugin: 'wecom-bot' },
  }]
  const base = {
    provider: target.provider,
    model: target.model,
    system: o.system || '',
    messages,
    maxTokens: Math.max(200, Math.min(8000, Number(o.maxTokens) || 2000)),
    temperature: o.temperature ?? 0.2,
    signal: o.signal,
  }
  let effort = await pickEffort(llm, target.provider, target.model, String(o.effort || 'low'))
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await runStream(llm, effort ? { ...base, reasoningEffort: effort } : base)
    } catch (error) {
      // 探测说支持、实际被拒（不同版本元数据不一致）→ 去掉再试一次
      if (attempt === 0 && effort && unsupportedEffort(error)) {
        effortCache.set(`${target.provider}::${target.model}`, null)
        effort = undefined
        continue
      }
      throw error
    }
  }
}
