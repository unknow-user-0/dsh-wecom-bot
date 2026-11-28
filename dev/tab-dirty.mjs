// 脏标记的分组断言：合并版块以后，两个版块分着管同一块配置（features / merge），
// 传整个对象就会在另一格亮假圆点，那个圆点一旦不可信就等于没有。
// 这个测试把「改哪一处，该亮哪一格」钉死。
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
const m = src.match(/const TAB_KEYS = (\{[\s\S]*?\n      \})/)
if (!m) throw new Error('找不到 TAB_KEYS')
const TAB_KEYS = eval('(' + m[1] + ')')

const at = (o, p) => p.split('.').reduce((v, k) => (v == null ? v : v[k]), o)
const dirty = (id, d, c) => (TAB_KEYS[id] || []).some((k) => JSON.stringify(at(d, k)) !== JSON.stringify(at(c, k)))

const base = {
  botId: 'a', botName: 'b', longTasks: false, quota: { enabled: true },
  admins: [], accessMode: 'whitelist', allow: {}, autoRegister: false,
  merge: {
    enabled: true, waitSec: 3, maxSec: 8, groupWaitSec: 5, groupMaxSec: 15,
    placeholderOn: false, placeholder: 'emmm', placeholderImage: '', placeholderImageOn: true,
  },
  persona: { current: 'default' },
  features: { browser: 'admin', memory: true, sendFileToUser: 'admin' },
  history: { enabled: true },
}
const clone = () => JSON.parse(JSON.stringify(base))

let bad = 0
const check = (what, mutate, expect) => {
  const d = clone()
  mutate(d)
  const on = Object.keys(TAB_KEYS).filter((id) => dirty(id, d, base))
  const ok = JSON.stringify(on) === JSON.stringify(expect)
  console.log(`  ${ok ? '✓' : '✗'} ${what} → 亮：${on.join(',') || '无'}`)
  if (!ok) bad++
}

console.log('脏标记该亮在哪一格：')
check('功能页改浏览器', (d) => { d.features.browser = 'all' }, ['features'])
check('自我页改记忆', (d) => { d.features.memory = false }, ['self'])
check('功能页改预回复文字', (d) => { d.merge.placeholder = 'hi' }, ['features'])
check('功能页关预回复', (d) => { d.merge.placeholderOn = true }, ['features'])
check('用户页改准入阈值', (d) => { d.merge.waitSec = 9 }, ['users'])
check('用户页改准入模式', (d) => { d.accessMode = 'open' }, ['users'])
check('连接页改额度', (d) => { d.quota.enabled = false }, ['connect'])
check('自我页改名字', (d) => { d.botName = 'x' }, ['self'])
check('用户页改长任务', (d) => { d.longTasks = true }, ['users'])
check('自我页换人格', (d) => { d.persona.current = 'other' }, ['self'])

// 反过来：没人动的键不许乱亮 —— 空改动必须一格都不亮
const none = Object.keys(TAB_KEYS).filter((id) => dirty(id, clone(), base))
if (none.length) { console.log(`  ✗ 什么都没改却亮了：${none.join(',')}`); bad++ }
else console.log('  ✓ 没改动时一格都不亮')

console.log(bad ? `\n❌ ${bad} 项不符合` : '\n✅ 脏标记分组正确')
process.exit(bad ? 1 : 0)
