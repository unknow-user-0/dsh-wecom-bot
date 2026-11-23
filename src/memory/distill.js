// 每日提炼：聊天流水 + 已有记忆 → 新的长期记忆 + 这个会话学到的技能。
//
// 为什么必须让模型来做，而不是靠工具调用：
//   记忆工具是「模型自觉去记」，但在对话当下它既没余裕判断什么值得记，
//   也不知道未来会用到什么。被动记忆的结果就是记忆库永远是空的。
//   提炼是离线批处理：这时候才适合做「挑什么留下来」这种需要权衡的判断。
//
// 三个必须让模型同时做的判断（照 Mem0 的做法）：
//   add      全新的事
//   update   对旧记忆的补充/更准的说法（合并成一条，不是并存两条）
//   outdated 旧记忆已经过时（换工作、搬家、分手、改了偏好）
// 只做 add 的话，记忆库会同时存在「他喜欢吃辣」和「他现在不吃辣了」，
// 召回时得分一样高，模型只能瞎猜。

import { add as addMemory, listAll, recall } from '../memory/store.js'
import { ask } from '../core/model.js'
import { listSkills, updateSkill } from '../memory/skills.js'

/** 一天里同一个会话超过这个条数就分段提炼（太长模型会漏掉前半段） */
const CHUNK = 120

/** 每轮最多给模型看多少条已有记忆做对比（太多反而会挑错） */
const COMPARE_LIMIT = 40

/** 一段流水里最少要有几条「人说的话」才值得提炼 —— 两句寒暄提炼不出东西 */
const MIN_LINES = 3

const SYSTEM = `你帮一个叫「{bot}」的聊天角色整理长期记忆。下面是一段它和别人的对话，说话人后面括号里是 ID。

挑出以后值得记住的事：别人的名字/称呼、喜好、讨厌的东西、身份、近况、重要经历、约定、你们之间的关系变化。
不要记寒暄、日常琐事、一次性的问答、以及这个角色自己的人设。

每条记忆的要求：
- 一句话，主语写清楚是谁（「小明喜欢吃辣」而不是「喜欢吃辣」）
- 尽量压短：超过 40 字就说明你在记流水账，改成概括
- 一件事实一条，不要把两件事塞进一条

同时挑出这段对话里「学会的做法」——有没有什么以后还能用的流程、格式、规则、技巧？
比如「这个群的日报要按项目分组」「报销单要先找财务签字」「问进度时直接看 TMS 不要反复催」。
只记真正可复用的做法，不要记这次的结论。没有就输出空数组。

如果下面列了「已经学会的做法」，新学到的做法要跟它们比：
- 说的是同一件事、只是措辞不同 → op 写 "update"，带上 "id"，text 写成整合后的完整做法
- 明明矛盾（「用 A 表」vs「用 B 表」）→ 也写 "update"，以这次对话里更新的说法为准
- 完全不相干 → op 写 "add"，不要带 id
不要把「报表用 A 表汇总」和「报表用 B 表汇总」当成两条并存 —— 那是同一件事的两种说法。

输出一个 JSON 对象，不要别的文字：
{"memories":[{"op":"add","text":"一句话","about":"谁的名字或 ID","importance":0.6}],
 "skills":[{"op":"add","name":"技能名（4~8字）","text":"怎么做（一句话，40字内）"}]}

skills 里的 op 只有 "add" 和 "update"，"update" 必须带上已有技能的 "id"。

op 三种：
- "add"      全新的，以前没记过
- "update"   是对下面「已经记得的事」某条的补充或更准确的说法 → 带上 "id"
             和合并后的完整说法（不是只写新增的部分）
- "outdated" 说明某条旧记忆已经不对了（换了工作、搬家、分手、口味变了）→ 带上 "id"
             和现在的新情况
拿不准是不是同一件事，就当 add。已经记得、没有新信息的，不要输出。`

function whenText(at) {
  const d = new Date(at || Date.now())
  const days = Math.floor((Date.now() - d.getTime()) / 86400000)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 30) return `${days} 天前`
  return d.toLocaleDateString('zh-CN')
}

/** 流水 → 模型能读的对话文本 */
function transcriptOf(lines) {
  return lines
    .filter((l) => String(l.text || '').trim())
    .map((l) => {
      const who = l.who === 'bot' ? '我' : (l.name || l.userId || '有人')
      const id = l.who === 'bot' ? '' : (l.userId ? `(${l.userId})` : '')
      return `${who}${id}：${String(l.text).replace(/\s+/g, ' ').trim().slice(0, 300)}`
    })
    .join('\n')
}

/** 这段对话相关的旧记忆：在场的人 + 词相似的，给模型比对用 */
function relatedFor(chatId, transcript) {
  const ppl = new Set([...String(transcript).matchAll(/\((\w{4,})\)/g)].map((m) => m[1]))
  const isDm = chatId && !chatId.startsWith('group')
  if (isDm) ppl.add(chatId)
  const out = listAll({}).filter((m) => m.about && ppl.has(String(m.about)))
  const hits = recall(String(transcript).slice(-1200), {
    about: isDm ? chatId : '',
    limit: 12,
    minScore: 0.4,
  })
  for (const h of hits) {
    if (out.length >= COMPARE_LIMIT) break
    if (!out.some((m) => m.id === h.it.id)) out.push(h.it)
  }
  return out.slice(0, COMPARE_LIMIT)
}

function parseJson(text) {
  const s = String(text || '')
  // 有的模型会包 ```json ```，先剥掉
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = fenced ? fenced[1] : s
  const obj = raw.match(/\{[\s\S]*\}/)
  if (obj) {
    try {
      const j = JSON.parse(obj[0])
      if (j && (Array.isArray(j.memories) || Array.isArray(j.skills))) return j
    } catch {}
  }
  // 退一步：老格式，只有一个数组
  const arr = raw.match(/\[[\s\S]*\]/)
  if (arr) {
    try { return { memories: JSON.parse(arr[0]), skills: [] } } catch {}
  }
  return { memories: [], skills: [] }
}

/**
 * 这段对话里出现过的人和 id。
 * 流水里每条 user 消息都带 userId/name，群聊里不止一个人 —— 全都收进来，
 * 这样模型写「小张」也能对上 u_zhang。
 */
function rosterOf(lines, kind, chatId, chatName) {
  const out = []
  const seen = new Set()
  const push = (id, name) => {
    const i = String(id || '').trim()
    if (!i || seen.has(i)) return
    seen.add(i)
    out.push({ id: i, name: String(name || '').trim() })
  }
  for (const l of lines) {
    if (l.who === 'bot') continue
    push(l.userId, l.name)
  }
  // 私聊的会话 id 就是对方的 userid
  if (kind === 'dm') push(chatId, chatName)
  return out
}

/**
 * 把人名对回 userid。
 *
 * 模型看到的是「小张(u_zhang)：…」，但它输出 about 时常常写成「小张」而不是 id。
 * 如果就这么存，这条记忆的 about 永远对不上真正的 userid —— 跨会话认人在这里断掉。
 * 所以按「这段对话里出现过的人名 → id」反查；对不上就当没说（宁可落到当前会话）。
 */
function resolveAbout(raw, kind, kindChat, roster) {
  const s = String(raw || '').trim()
  if (!s) return null
  // 已经是 id
  const byId = roster.find((r) => r.id === s)
  if (byId) return byId
  // 是名字（含「小张」「张」「小张哥」这类近似）
  const exact = roster.find((r) => r.name === s)
  if (exact) return exact
  const loose = roster.find((r) => r.name && (r.name.includes(s) || s.includes(r.name)))
  if (loose) return loose
  return null
}

/**
 * 提炼一段对话。
 * @param {object} o
 * @param {string} o.chatId dm 用 userid，group 用 chatid
 * @param {string} o.kind 'dm' | 'group'
 * @param {string} o.chatName
 * @param {Array} o.lines 流水
 * @param {(m:object)=>void} o.addSkill 新增或整合技能
 */
async function distillChunk({ dsh, target, botName, chatId, kind, chatName, lines, log, addSkill }) {
  const talk = lines.filter((l) => String(l.text || '').trim() && !String(l.text).startsWith('【系统'))
  if (talk.filter((l) => l.who !== 'bot').length < MIN_LINES) return { added: 0, updated: 0, outdated: 0, skills: 0 }
  const transcript = transcriptOf(talk)
  const related = relatedFor(chatId, transcript)
  const known = new Map(related.map((m) => [m.id, m]))
  const knownSkills = new Map(listSkills().slice(0, COMPARE_LIMIT).map((s) => [s.id, s]))
  // 这段对话里出现过的人：名字 → id。模型写的 about 多是名字，必须对回 id。
  const roster = rosterOf(talk, kind, chatId, chatName)

  const out = await ask(dsh, target, {
    system: SYSTEM.replace('{bot}', botName || '这个角色'),
    text: (related.length
      ? `已经记得的事：\n${related.map((m) => `#${m.id} [${whenText(m.at)}] ${m.aboutName ? '[' + m.aboutName + '] ' : ''}${m.text}`).join('\n')}\n\n`
      : '') + (knownSkills.size
      ? `已经学会的做法：\n${[...knownSkills.values()].map((s) => `#${s.id} ${s.name}：${s.text}`).join('\n')}\n\n`
      : '') + `对话：\n${transcript}`,
    maxTokens: 2500,
    temperature: 0.2,
  })
  const { memories, skills } = parseJson(out)
  // 已有技能清单：让模型能指名道姓说「这是第几条的改版」。
  // 只给 id + 名字 + 一句话，太多了会把它挤散。

  let added = 0
  let updated = 0
  let outdated = 0
  for (const x of (memories || []).slice(0, 16)) {
    if (!x || !String(x.text || '').trim()) continue
    const aboutRaw = String(x.about || '').trim()
    // 她自己的事不该进记忆库（人设里写着呢）。模型有时会写成「我」，这种情况：
    //   私聊里就落到对方头上；群里就直接丢掉 —— 群里「我」指谁是不确定的，猜错比不记更糟。
    const isSelf = /^(我|大肥鱼|本人|自己)$/.test(aboutRaw)
    if (isSelf && kind !== 'dm') continue
    // 先按这段对话里出现过的人把人名对回 id；对不上才算「不知道是谁」。
    const hit = isSelf || !aboutRaw ? null : resolveAbout(aboutRaw, kind, chatId, roster)
    const about = (isSelf || !aboutRaw) ? (kind === 'dm' ? chatId : '') : (hit ? hit.id : '')
    const aboutName = (isSelf || !aboutRaw) ? (kind === 'dm' ? chatName : '') : (hit ? hit.name : aboutRaw)
    const base = {
      text: String(x.text).trim().slice(0, 200),
      about,
      aboutName,
      // 知道是谁 → 人（跨会话）；不知道 → 场景（只在这个群有效）
      scope: about ? 'person' : 'scene',
      chatId,
      originKind: kind,
      originName: chatName,
      importance: Number(x.importance) || 0.5,
      source: 'auto',
    }
    const id = String(x.id || '').replace(/^#/, '')
    const target_ = known.get(id)
    const op = String(x.op || 'add')

    if (op === 'update' && target_) {
      // 合并而不是并存：旧的说法留着已经没意义，而且两条一起召回会让模型看到矛盾信息
      const merged = { ...target_ }
      merged.text = base.text.length >= target_.text.length ? base.text : `${target_.text}（后来补充：${base.text}）`
      merged.text = merged.text.slice(0, 200)
      addMemory({ ...merged, supersedes: target_.id, source: 'auto' })
      updated += 1
      continue
    }
    if (op === 'outdated' && target_) {
      addMemory({ ...base, supersedes: target_.id })
      outdated += 1
      continue
    }
    addMemory(base)
    added += 1
  }

  let skillCount = 0
  for (const s of (skills || []).slice(0, 6)) {
    if (!s || !String(s.text || '').trim()) continue
    const name = String(s.name || '').trim().slice(0, 20) || '做法'
    const text = String(s.text).trim().slice(0, 200)
    // 模型说「这就是已有第 N 条」→ 直接覆盖那一条。
    // 为什么不靠词面相似度自己判：「报表用 A 表汇总」和「报表用 B 表汇总」
    // 覆盖率是 1.00 —— 字面几乎一样，意思正好相反。词面判断在这种地方必错，
    // 而把两条矛盾的做法并成一条、或者该并的没并，都是 irreversible 的。
    // 所以让模型在看到已有清单的情况下指名道姓，词面相似度只当兜底。
    const sid = String(s.id || '').replace(/^#/, '')
    const prev = sid ? knownSkills.get(sid) : null
    if (String(s.op || '') === 'update' && prev) {
      updateSkill(prev.id, { name, text })
      skillCount += 1
      continue
    }
    addSkill({ name, text, chatId, chatName, kind })
    skillCount += 1
  }

  log?.debug?.(`提炼 ${chatId}：${added} 新/${updated} 合并/${outdated} 过时/${skillCount} 技能`)
  return { added, updated, outdated, skills: skillCount }
}

/**
 * 提炼一整天。
 * @param {object} o
 * @param {object} o.dsh 宿主
 * @param {{provider:string,model:string}} o.target
 * @param {Array} o.lines 当天的流水（全都会话混在一起）
 * @param {string} o.botName
 * @param {(s:object)=>void} o.addSkill
 */
export async function distillLines({ dsh, target, lines, botName = '', log, addSkill, signal }) {
  const byChat = new Map()
  for (const l of lines) {
    if (!l.chatId) continue
    if (!byChat.has(l.chatId)) byChat.set(l.chatId, [])
    byChat.get(l.chatId).push(l)
  }
  let total = { added: 0, updated: 0, outdated: 0, skills: 0, chats: 0 }
  for (const [chatId, list] of byChat) {
    const meta = list.find((l) => l.chatName) || {}
    const kind = list[0].kind || 'dm'
    const chatName = meta.chatName || (kind === 'group' ? '这个群' : '对方')
    for (let i = 0; i < list.length; i += CHUNK) {
      if (signal && signal.aborted) throw Object.assign(new Error('已取消'), { code: 'ABORTED' })
      const part = list.slice(i, i + CHUNK)
      try {
        const r = await distillChunk({ dsh, target, botName, chatId, kind, chatName, lines: part, log, addSkill })
        total.added += r.added
        total.updated += r.updated
        total.outdated += r.outdated
        total.skills += r.skills
      } catch (error) {
        // 一个会话失败不该让整天的提炼白跑
        log?.warn?.(`提炼 ${chatId} 失败：${error.message}`)
      }
    }
    total.chats += 1
  }
  return total
}
