// 跨会话认人 + 技能 + 提炼。
//
// 这里最要紧的两条是**互相矛盾**的需求，必须同时成立：
//   1. 换会话也认得这个人（他在私聊说过的事，群里也要想起来）
//   2. 绝不因为认得他，就把别人的事带出来
// 只做 1 就是泄露，只做 2 就是失忆。所以下面既有正例也有反例。
//
// 跑：node dev/memory-cross.mjs

import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const HOME = mkdtempSync(join(tmpdir(), 'wecom-cross-'))
process.env.DSH_HOME = HOME

const m = await import('../src/memory/store.js')
const skills = await import('../src/memory/skills.js')
const { distillLines } = await import('../src/memory/distill.js')

const DATA = join(HOME, 'plugins-data', 'wecom-bot')
const MEM = join(DATA, 'memory.json')

let pass = 0
let fail = 0
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  ✅', name) }
  else { fail += 1; console.log('  ❌', name, detail === undefined ? '' : `→ ${detail}`) }
}
const disk = () => (existsSync(MEM) ? JSON.parse(readFileSync(MEM, 'utf8')) : null)

// ---------------------------------------------------------------- ①
console.log('\n① 数据层：同一个人换了会话还认得出，别人的记忆不漏')
m.add({ text: '小张胃不好，不能吃辣', scope: 'person', about: 'u_zhang', aboutName: '小张', chatId: 'u_zhang', type: 'fact' })
m.add({ text: '小李在准备婚礼', scope: 'person', about: 'u_li', aboutName: '小李', chatId: 'u_li', type: 'fact' })
m.add({ text: '这个群在讨论装修', scope: 'scene', about: '', chatId: 'grp_a', type: 'fact' })

// 小张在群里（chatId 变了）问「我不能吃辣吗」
const inGroup = m.recall('吃辣', { about: 'u_zhang', chatId: 'grp_a', limit: 10 })
ok('小张换到群里，自己的记忆还召得到', inGroup.some((h) => h.it.about === 'u_zhang'), JSON.stringify(inGroup.map((h) => h.it.text)))
ok('不会把小李的记忆带出来', !inGroup.some((h) => h.it.about === 'u_li'), JSON.stringify(inGroup.map((h) => h.it.text)))
ok('别人的私聊场景记忆也不漏', !inGroup.some((h) => h.it.chatId === 'u_li'))

// 小李在 grp_a 里问同样的词
const liGroup = m.recall('吃辣', { about: 'u_li', chatId: 'grp_a', limit: 10 })
ok('小李也拿不到小张的记忆', !liGroup.some((h) => h.it.about === 'u_zhang'))

// 群里谁也不认（about 传空）→ 一条 person 都拿不到
const nobody = m.recall('吃辣', { chatId: 'grp_a', limit: 10 })
ok('不指定人时拿不到任何 person 记忆', !nobody.some((h) => h.it.scope === 'person'), JSON.stringify(nobody.map((h) => h.it.scope)))

// 场景记忆只在那个群
const otherGroup = m.recall('装修', { about: 'u_zhang', chatId: 'grp_b', limit: 10 })
ok('场景记忆不会跑到别的群', !otherGroup.some((h) => h.it.chatId === 'grp_a'))
const sameGroup = m.recall('装修', { about: 'u_zhang', chatId: 'grp_a', limit: 10 })
ok('场景记忆在自己群里召得到', sameGroup.some((h) => h.it.chatId === 'grp_a'))

// ---------------------------------------------------------------- ②
console.log('\n② silent 召回：不写日志、不加命中数、不改盘')
const before = disk()
const beforeLog = (before?.recallLog || []).length
// 先做一次普通召回，把那几条的 hits 抬起来，这样才能验证 silent 不再抬
m.recall('吃辣', { about: 'u_zhang', chatId: 'grp_a', limit: 20 })
const quiet = m.recall('', { about: 'u_zhang', chatId: 'grp_a', limit: 20, silent: true })
// silent 之前的命中数：从内存里读（silent 若加了 hits，这里就对不上）
const hitsNow = new Map(quiet.map((h) => [h.it.id, h.it.hits]))
const after = disk()
ok('silent 也能召回内容', quiet.length > 0, String(quiet.length))
ok('silent 不写 recallLog', (after?.recallLog || []).length === beforeLog + 1, `${beforeLog} → ${(after?.recallLog || []).length}`)
const diskHits = new Map(((after?.items) || []).map((x) => [x.id, x.hits || 0]))
const bumped = quiet.filter((h) => (diskHits.get(h.it.id) || 0) !== (hitsNow.get(h.it.id) || 0))
ok('silent 不把 hits 写进盘', bumped.length === 0, JSON.stringify(bumped.map((h) => [h.it.text, diskHits.get(h.it.id), h.it.hits])))

// ---------------------------------------------------------------- ③
console.log('\n③ 技能：明显重复自动并、可改可删、手动可加')
// 措辞接近的两条（实测覆盖率 0.71）→ 该并。这里刻意用「措辞接近」而不是
// 「意思是同一件事但说法差很远」，后者词面判断不了，走 ⑦ 让模型指名。
const s1 = skills.addSkill({ name: '周报时间', text: '每周五下班前交周报', chatId: 'grp_a', chatName: '太子群', kind: 'group' })
const s2 = skills.addSkill({ name: '周报', text: '周报周五下班前发', chatId: 'grp_b', chatName: '季游', kind: 'dm' })
ok('第一条是新增', s1.merged === false)
ok('明显重复的第二条被并进同一条', s2.merged === true, JSON.stringify(s2.item))
ok('并完还是一条', skills.listSkills().length === 1, String(skills.listSkills().length))
const merged = skills.listSkills()[0]
ok('保留了信息更全的描述', merged.text.includes('下班前'), merged.text)
ok('记下了两个来源', merged.from.length === 2, JSON.stringify(merged.from.map((f) => f.chatName)))
ok('学过次数累加', merged.times === 2, String(merged.times))

// 意思相近但措辞差很远（覆盖率 0.55）→ 词面不并，留给模型
const s3 = skills.addSkill({ name: '日报分组', text: '日报要按项目分组再发', chatId: 'grp_a', chatName: '太子群', kind: 'group' })
const s4 = skills.addSkill({ name: '日报按项目分组', text: '写日报的时候按项目分组，不要按时间排', chatId: 'grp_b', chatName: '季游', kind: 'dm' })
ok('措辞差很远的没有被词面硬并（留给模型判断）', s4.merged === false, JSON.stringify(s4))

const s5 = skills.addSkill({ name: '报销流程', text: '报销单先找财务签字再走 OA', chatId: 'grp_a', chatName: '太子群', kind: 'group' })
ok('完全不同的技能另存一条', s5.merged === false)
ok('能按关键字搜到', skills.listSkills('报销').length === 1)
ok('能改', skills.updateSkill(s5.item.id, { text: '报销单先找财务小王签字，再走 OA' }) === true)
ok('改完内容变了', skills.listSkills('报销')[0].text.includes('小王'))
ok('能删', skills.removeSkill(s5.item.id) === true)
ok('删完再删返回 false', skills.removeSkill(s5.item.id) === false)
ok('手动加一条', Boolean(skills.importSkill({ name: '手动', text: '开会前先发议程' })))
ok('空正文加不进去', skills.importSkill({ name: 'x', text: '   ' }) === null)

console.log('\n④ 技能整体整合（模型说哪几条是一回事）')
const a = skills.addSkill({ name: '周报', text: '周报周五下班前发' })
const b = skills.addSkill({ name: '周报时间', text: '每周五下班前交周报' })
const merged2 = skills.applyMergeGroups([{ ids: [a.item.id, b.item.id], name: '周报提交时间', text: '每周五下班前交周报' }])
ok('合并掉一条', merged2 === 1, String(merged2))
ok('合并后名字用了模型给的', skills.listSkills().some((x) => x.name === '周报提交时间'))
ok('不存在的 id 不会炸', skills.applyMergeGroups([{ ids: ['nope', 'nada'] }]) === 0)

// ---------------------------------------------------------------- ⑤
console.log('\n⑤ 提炼：模型返回 add/update/outdated，产出落到记忆和技能')

/** 假 llm：按调用顺序吐预设的 JSON，顺便记下收到的 prompt */
function fakeLlm(replies) {
  const seen = []
  let i = 0
  return {
    seen,
    listProviders: () => [{ id: 'p', name: '假供应商' }],
    listModels: async () => [{ provider: 'p', id: 'm1', name: '假模型' }],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low', name: '低' }], defaultEffort: 'low' } }),
    stream(params) {
      seen.push({ system: params.system, messages: params.messages })
      const text = replies[Math.min(i, replies.length - 1)]
      i += 1
      return (async function* () {
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'finish', index: 0, reason: { kind: 'completed' } }
      })()
    },
  }
}

const line = (o) => ({ at: Date.now(), chatId: 'u_zhang', kind: 'dm', chatName: '小张', userId: 'u_zhang', name: '小张', who: 'user', ...o })
const lines = [
  line({ text: '我最近胃不好，辣的都戒了' }),
  line({ text: '我们日报改成按项目分组了，别按时间排' }),
  line({ text: '对了下个月我要去济南常驻' }),
  { ...line({ who: 'bot', name: '我', text: '好，我记住了。' }) },
]

const llm = fakeLlm([JSON.stringify({
  memories: [
    { op: 'add', text: '小张胃不好，戒了辣的', about: '小张', importance: 0.8 },
    { op: 'add', text: '小张下个月去济南常驻', about: '小张', importance: 0.7 },
  ],
  skills: [{ name: '日报分组', text: '写日报按项目分组，不要按时间排' }],
})])

const r1 = await distillLines({
  dsh: { llm, get: (n) => (n === 'llm' ? llm : null) },
  target: { provider: 'p', model: 'm1' },
  lines,
  botName: '海棠',
  log: { debug() {}, info() {}, warn() {} },
  addSkill: (s) => skills.addSkill(s),
})
ok('提炼返回值有统计', r1.added === 2 && r1.skills === 1, JSON.stringify(r1))
const zhang = m.listAll({ about: 'u_zhang' })
ok('记忆挂到了说话的这个人身上（不是「小张」这个字符串）', zhang.some((x) => x.text.includes('济南')), JSON.stringify(zhang.map((x) => x.about)))
ok('私聊里模型写「小张」也会归到对方 id', zhang.every((x) => x.about === 'u_zhang'))
ok('技能进了共享列表', skills.listSkills().some((x) => x.name === '日报分组'))
ok('提炼时把对话文本发给了模型', String(llm.seen[0].messages[0].content[0].text).includes('辣的都戒了'))

console.log('\n⑥ 提炼：模型说要合并/过时，旧条要被取代而不是并存')
const old = m.add({ text: '小张在准备婚礼', scope: 'person', about: 'u_zhang', aboutName: '小张', chatId: 'u_zhang', type: 'fact' })
const llm2 = fakeLlm([JSON.stringify({
  memories: [{ op: 'update', id: old.id, text: '小张婚礼办完了，现在在度蜜月', about: '小张' }],
  skills: [],
})])
await distillLines({
  dsh: { llm: llm2, get: (n) => (n === 'llm' ? llm2 : null) },
  target: { provider: 'p', model: 'm1' },
  lines,
  botName: '海棠',
  log: { debug() {}, info() {}, warn() {} },
  addSkill: () => {},
})
const alive = m.listAll({ about: 'u_zhang' })
ok('新说法在库里', alive.some((x) => x.text.includes('度蜜月')), JSON.stringify(alive.map((x) => x.text)))
ok('旧说法被取代（不再算活着）', !alive.some((x) => x.text === '小张在准备婚礼'), JSON.stringify(alive.map((x) => x.text)))
const raw = disk()
const oldRow = raw.items.find((x) => x.id === old.id)
ok('旧条没被物理删除（留痕）', Boolean(oldRow))
ok('旧条标了 supersededAt', Boolean(oldRow.supersededAt), JSON.stringify(oldRow.supersededAt))

console.log('\n⑦ 词面判不出来的那种：字面几乎一样但意思相反，必须靠模型指名')
// 这是覆盖率最致命的场景：「报表用 A 表汇总」vs「报表用 B 表汇总」相似度 1.00。
// 词面判断只会二选一：要么并成一条（把正确的那条吃掉），要么并存（两条矛盾）。
const sk1 = skills.addSkill({ name: '报表口径', text: '报表用 A 表汇总', chatId: 'grp_a', chatName: '太子群', kind: 'group' })
ok('先存一条旧口径', Boolean(sk1.item))
const llm3 = fakeLlm([JSON.stringify({
  memories: [],
  skills: [{ op: 'update', id: sk1.item.id, name: '报表口径', text: '报表改用 B 表汇总（A 表作废）' }],
})])
const r4 = await distillLines({
  dsh: { llm: llm3, get: (n) => (n === 'llm' ? llm3 : null) },
  target: { provider: 'p', model: 'm1' },
  lines,
  botName: '海棠',
  log: { debug() {}, info() {}, warn() {} },
  addSkill: (s) => skills.addSkill(s),
})
ok('模型说这是同一条的改版', r4.skills >= 1, JSON.stringify(r4))
ok('旧口径被就地改掉，而不是多出一条矛盾的', skills.listSkills('报表').length === 1, JSON.stringify(skills.listSkills('报表').map((x) => x.text)))
ok('内容确实换成了新口径', skills.listSkills('报表')[0].text.includes('B 表'), JSON.stringify(skills.listSkills('报表')[0]))
ok('提炼时把已有技能清单给了模型', String(llm3.seen[0].messages[0].content[0].text).includes('报表用 A 表汇总'))

console.log('\n⑧ 提炼出错不炸、不落半截数据')
const boom = {
  listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => null,
  stream() { return (async function* () { yield { type: 'finish', index: 0, reason: { kind: 'error', failure: { code: 'X', message: '模型挂了' } } } })() },
}
const r3 = await distillLines({
  dsh: { llm: boom, get: (n) => (n === 'llm' ? boom : null) },
  target: { provider: 'p', model: 'm1' },
  lines,
  botName: '海棠',
  log: { debug() {}, info() {}, warn() {} },
  addSkill: () => {},
})
ok('模型报错时返回零而不是抛出去', r3.added === 0 && r3.skills === 0, JSON.stringify(r3))

console.log(`\n${fail ? '❌' : '✅'} ${pass} 项通过${fail ? `，${fail} 项失败` : ''}\n`)
process.exit(fail ? 1 : 0)
