// 整理器：把「流水 → 提炼 → 记忆/技能」串起来，并管住「什么时候该跑」。
//
// 四条硬约束（都是踩过的坑）：
//   1. 同一天不重复提炼同一段：记 processed[day] = 已处理条数，
//      下午那次只处理之后新增的（照 aurabot 做法）。
//   2. 提炼完才删流水。反过来的话，模型一旦失败，原料就没了。
//   3. 提炼失败不重试到底：失败就打标记，等下一次手动触发，
//      不要自己陷入「失败-重试-再失败」的循环烧 token。
//   4. 失败必须上抛到 catch，绝不能在 distill 里吞掉后继续删原料 ——
//      流水是唯一原料、企微不重发，静默吞错 = 永久丢数据。

import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { DATA_DIR } from '../core/config.js'
import * as chatlog from '../core/chatlog.js'
import { resolveModel } from '../core/model.js'
import { distillLines } from './distill.js'
import * as skills from './skills.js'

const STATE_FILE = join(DATA_DIR, 'memory-distill.json')

function loadState() {
  try {
    if (existsSync(STATE_FILE)) {
      const j = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
      if (j && typeof j === 'object') return j
    }
  } catch {}
  return { processed: {}, runs: {}, last: null }
}

function saveState(s) {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    const tmp = STATE_FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8')
    renameSync(tmp, STATE_FILE)
  } catch {}
}

export function createConsolidator({ dsh, getConfig, log }) {
  let busy = false
  let lastError = ''

  /** 现在有没有条件跑：开着、有模型、有流水 */
  function ready() {
    const cfg = getConfig()
    if (!cfg.features.memory) return { ok: false, reason: '记忆功能关着' }
    const target = resolveModel(dsh, cfg)
    if (!target) return { ok: false, reason: '还没选提炼用的模型' }
    return { ok: true, target }
  }

  function status() {
    const st = loadState()
    const cfg = getConfig()
    const model = resolveModel(dsh, cfg)
    return {
      ok: true,
      busy,
      enabled: !!cfg.features.memory,
      auto: cfg.memory?.autoDistill !== false,
      times: cfg.memory?.distillTimes || ['04:00'],
      model: model ? `${model.provider} / ${model.model}` : '',
      modelFromConfig: !!(cfg.model && cfg.model.provider),
      lastError,
      last: st.last || null,
      pendingDays: chatlog.days(),
      skills: skills.stats(),
    }
  }

  /**
   * 提炼一批日子。
   * @param {{days?:string[], includeToday?:boolean, signal?:AbortSignal}} o
   */
  async function run(o = {}) {
    if (busy) return { ok: false, message: '正在整理，等这轮跑完' }
    const r = ready()
    if (!r.ok) return { ok: false, message: r.reason }
    busy = true
    lastError = ''
    const startedAt = Date.now()
    const state = loadState()
    const today = chatlog.dayKey()
    const cfg = getConfig()
    let total = { added: 0, updated: 0, outdated: 0, skills: 0, chats: 0 }
    let days = 0
    let attempted = false
    try {
      const list = (o.days && o.days.length ? o.days : chatlog.days())
        .filter((d) => d <= today)
        .filter((d) => o.includeToday || d !== today)
      for (const day of list) {
        if (o.signal && o.signal.aborted) break
        const all = chatlog.readDay(day)
        const done = day === today ? 0 : (state.processed[day] || 0)
        // 同一段流水不重复提炼：上次处理到第几行，这次只喂后面的
        const fresh = day === today ? all : all.slice(done)
        if (!fresh.length) {
          if (day !== today) chatlog.dropDay(day)
          delete state.processed[day]
          saveState(state)
          continue
        }
        attempted = true
        const result = await distillLines({
          dsh,
          target: r.target,
          lines: fresh,
          botName: cfg.botName,
          log,
          addSkill: (s) => skills.addSkill(s),
          signal: o.signal,
        })
        total.added += result.added
        total.updated += result.updated
        total.outdated += result.outdated
        total.skills += result.skills
        total.chats += result.chats
        days += 1
        // 提炼成功才删原料；今天的留着（还在往里写）
        if (day < today) {
          chatlog.dropDay(day)
          delete state.processed[day]
        } else {
          state.processed[day] = all.length
        }
        saveState(state)
      }
      const summary = {
        at: startedAt,
        days,
        ...total,
        ms: Date.now() - startedAt,
        model: `${r.target.provider} / ${r.target.model}`,
      }
      state.last = summary
      saveState(state)
      log.info(`整理记忆：${days} 天、${total.chats} 个会话 → ${total.added} 新 / ${total.updated} 合并 / ${total.outdated} 过时 / ${total.skills} 技能`)
      return { ok: true, attempted, ...summary, message: days ? describe(summary) : '没有新的聊天可整理' }
    } catch (error) {
      lastError = error.message
      const state2 = loadState()
      state2.last = { at: startedAt, error: error.message, days, ...total }
      saveState(state2)
      log.warn(`整理记忆失败：${error.message}`)
      // 原料和 processed 水位都没动（异常发生在 dropDay 之前），下一轮会重试
      return { ok: false, attempted, message: error.message }
    } finally {
      busy = false
      // 只有「这一轮真的成功提炼过」才清理老流水。
      // 原来 finally 无条件 prune：欠费/模型没配/功能关着时 run 直接 early return，
      // 但 prune 照跑，把没提炼过的老流水按天数删掉 —— 又一次「没记成却删原料」。
      // 判断依据是本轮成功写下的 state.last.at === 本次 startedAt。
      let ok = false
      try {
        const s = loadState()
        ok = !!(s.last && s.last.at === startedAt && !s.last.error)
      } catch {}
      if (ok) chatlog.prune(14)
    }
  }

  /** 每分钟调一次，到点就跑。同一天同一个时间点只跑一次。 */
  async function tick() {
    const cfg = getConfig()
    if (!cfg.features.memory || cfg.memory?.autoDistill === false) {
      // 功能关着/自动整理关着时绝不 prune：这些流水还没提炼过，删了就永久没了。
      return
    }
    const st = loadState()
    const today = chatlog.dayKey()
    const now = new Date()
    const mins = now.getHours() * 60 + now.getMinutes()
    const runs = st.runs || {}
    const due = (cfg.memory?.distillTimes || ['04:00']).filter((t) => {
      const [hh, mm] = String(t).split(':').map(Number)
      return mins >= hh * 60 + mm && runs[t] !== today
    })
    if (!due.length) return
    const r = await run({ includeToday: true })
    // 只要真调过模型就算「今天这个点跑过了」，成功失败都标记。
    // 失败也标记是为了防死循环：due 靠「runs[t] !== today」判断，
    // 失败不标记 → 每分钟重试 → 每分钟烧 token，正好违反硬约束 3。
    // 原料没删、水位没动，用户手动整理或明天还能重试。
    // attempted=false 是「没配模型」这种 early return，没烧 token，留着下轮再试。
    if (r.ok || r.attempted) {
      const st2 = loadState()
      st2.runs = { ...(st2.runs || {}) }
      for (const t of due) st2.runs[t] = today
      // 只留最近三天的运行记录，别让 state 文件一直长
      saveState(st2)
    }
  }

  return { run, tick, status, ready }
}

function describe(s) {
  const bits = []
  if (s.added) bits.push(`新记 ${s.added} 条`)
  if (s.updated) bits.push(`合并 ${s.updated} 条`)
  if (s.outdated) bits.push(`标记过时 ${s.outdated} 条`)
  if (s.skills) bits.push(`学到 ${s.skills} 个做法`)
  return bits.length ? `整理完了：${bits.join('，')}` : '整理完了，没发现值得记的新东西'
}
