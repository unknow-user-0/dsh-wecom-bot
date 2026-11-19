// 记忆层的测试。
//
// 隔离靠 DSH_HOME —— src/core/config.js:9 的 DATA_DIR 从这里派生，
// 所以必须在 import 任何插件模块之前设好。以前没有这个隔离，
// 测试直接读写生产的 ~/.dsh/plugins-data/wecom-bot/memory.json。
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const HOME = mkdtempSync(join(tmpdir(), 'wecom-mem-'))
process.env.DSH_HOME = HOME

const m = await import('../src/memory/store.js')
const DATA = join(HOME, 'plugins-data', 'wecom-bot')
const FILE = join(DATA, 'memory.json')

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('  ✅', name) }
  else { fail += 1; console.log('  ❌', name, detail === undefined ? '' : `→ ${detail}`) }
}
function disk() {
  return existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : null
}

console.log('\n① 基本存取')
const a = m.add({ text: '小张不吃辣', scope: 'person', type: 'preference', about: 'u_zhang', aboutName: '小张' })
check('记忆能写进去', Boolean(a && a.id), JSON.stringify(a))
check('落盘了', disk()?.items?.length === 1, String(disk()?.items?.length))
check('scope 正确', a.scope === 'person', a.scope)
check('type 正确', a.type === 'preference', a.type)
// add() 只写 type，从来不写 kind —— 这正是下面 ② 那个 bug 的根。
check('没有 kind 字段（只有 type）', !Object.hasOwn(a, 'kind'), Object.keys(a).join(','))

console.log('\n② ephemeral 真的会过期')
// 以前 alive()/freshness()/stats() 三处都判 item.kind === 'ephemeral'，
// 而 add() 只写 type —— kind 恒 undefined，于是 ephemeral 永不过期。
const dead = m.add({ text: '临时：一小时前说的话', type: 'ephemeral', expiresAt: Date.now() - 1000 })
const aliveOne = m.add({ text: '临时：还有一小时', type: 'ephemeral', expiresAt: Date.now() + 3600e3 })
check('过期的 ephemeral 不再被召回', !m.recall('临时 一小时', { limit: 20 }).some((h) => h.it.id === dead.id))
check('没过期的 ephemeral 还能被召回', m.recall('还有一小时', { limit: 20 }).some((h) => h.it.id === aliveOne.id))
check('stats().expired 数得对（=1）', m.stats().expired === 1, String(m.stats().expired))
check('过期的不出现在 listAll 里（默认滤掉死的）', !m.listAll({}).some((x) => x.id === dead.id))
check('stats().alive 把过期的排除在外', m.stats().alive === m.stats().total - m.stats().expired, `${m.stats().alive} / ${m.stats().total}`)

console.log('\n③ 召回日志要落盘')
const before = (disk()?.recallLog || []).length
m.recall('小张 吃辣', { about: 'u_zhang', limit: 5 })
const after = (disk()?.recallLog || []).length
// 以前是先 save(db) 再 unshift，日志只活在内存里，重启就没了。
check('召回后磁盘上的 recallLog 变多了', after > before, `${before} → ${after}`)
const last = (disk()?.recallLog || [])[0]
check('日志里有 query', last?.query === '小张 吃辣', JSON.stringify(last?.query))
check('命中时记了 hits', Array.isArray(last?.hits) && last.hits.length > 0, JSON.stringify(last?.hits))
const before2 = (disk()?.recallLog || []).length
m.recall('完全不相关的词xyz', { limit: 5 })
check('没命中也要留一条日志', (disk()?.recallLog || []).length === before2 + 1, String((disk()?.recallLog || []).length))

console.log('\n④ 四层隔离')
const me = m.add({ text: '这个人怕冷', scope: 'person', about: 'u_li', aboutName: '小李' })
const scene = m.add({ text: '这个群在聊装修', scope: 'scene', chatId: 'g1' })
const skill = m.add({ text: 'TMS 提交要带 submit=1', scope: 'skill' })
check('关于某人的，带 about 时才召回', m.recall('怕冷', { about: 'u_li' }).some((h) => h.it.id === me.id))
check('换个 about 就召不到他', !m.recall('怕冷', { about: 'u_wang' }).some((h) => h.it.id === me.id))
check('场景记忆在别的会话里召不到', !m.recall('装修', { chatId: 'g2' }).some((h) => h.it.id === scene.id))
check('场景记忆在本会话里召得到', m.recall('装修', { chatId: 'g1' }).some((h) => h.it.id === scene.id))
check('技能类不依赖词命中也算分', m.recall('随便什么', {}).some((h) => h.it.id === skill.id))

console.log('\n⑤ 遗忘')
check('remove 返回 true', m.remove(skill.id) === true)
check('作废后召不到', !m.recall('TMS submit', {}).some((h) => h.it.id === skill.id))
check('remove 不存在的 id 返回 false', m.remove('nope') === false)
check('作废的还在文件里（不删，只是不召回）', disk().items.some((x) => x.id === skill.id && x.invalidAt))

console.log('\n⑥ 上限保护')
for (let i = 0; i < 120; i += 1) m.add({ text: `压测第 ${i} 条`, scope: 'scene', chatId: 'g9' })
check('5000 条以内不触发归档', m.stats().total < 5000, String(m.stats().total))

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 项通过，${fail} 项失败`)
process.exit(fail === 0 ? 0 : 1)
