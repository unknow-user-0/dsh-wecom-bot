// 名字这件事的三条链路：
//   1) 入站剥 @ 前缀（传输层，不进认知层）
//   2) 系统提示里声明旧名字（历史消息里的残留 @ 不变成陌生人）
//   3) 角色卡增删（以前删不掉、删完不切回、新建会静默覆盖同名卡）
//
// 这三条以前都没测过。名字冲突是最容易「看着能用、群里就翻车」的地方，
// 所以这里把边界钉死。

import { stripMention, normalizeInbound } from '../src/chat/inbound.js'
import { rulesText, personaText, listPersonas, createPersona, deletePersona, setPersonasDir } from '../src/persona/personas.js'
import { merge, DEFAULTS } from '../src/core/config.js'
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 角色卡测试必须在临时目录里跑 —— 以前直接打真实数据目录，
// 一条断言写错就把用户手写的角色卡永久删掉了（unlinkSync 绕过回收站）。
setPersonasDir(mkdtempSync(join(tmpdir(), 'wecom-personas-')))

let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`) }
}

function eq(name, actual, want) {
  check(name, actual === want, `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(want)}`)
}

console.log('\n① 剥离：正常情况')
eq('精确名字 + 空格', stripMention('@海棠 你好', '海棠'), '你好')
eq('精确名字 + 无空格', stripMention('@海棠你好', '海棠'), '你好')
eq('精确名字 + 全角空格', stripMention('@海棠　你好', '海棠'), '你好')
eq('精确名字 + 冒号', stripMention('@海棠: 你好', '海棠'), '你好')
eq('只有 @ 加名字', stripMention('@海棠', '海棠'), '')
eq('私聊文本不以 @ 开头', stripMention('你好啊', '海棠'), '你好啊')
eq('空文本', stripMention('', '海棠'), '')

console.log('\n② 剥离：边界（群聊必然 @ 机器人，所以配了名字就是安全剥）')
eq('配置过时/没配名字时，@后面超过 2 字才兜底剥', stripMention('@海棠花 开了', '海棠花'), '开了')
eq('配了 1 个字的短名，按前缀剥（群聊必然在 @ 机器人，这是安全的）', stripMention('@李老师说这事', '李'), '老师说这事')
eq('没配名字时，@后面只有 1 个字就不剥（宁可不剥也不吃用户的话）', stripMention('@李 说这事', ''), '@李 说这事')
eq('没配名字、@后面 1 个字，不动', stripMention('@A 你好', ''), '@A 你好')
eq('未配置名字时兜底剥 2 字以上的 @', stripMention('@某某机器人 你好', ''), '你好')
eq('保留正文里后面的 @', stripMention('@海棠 你去问问@季游', '海棠'), '你去问问@季游')
eq('配置了名字就按前缀剥，不要求后面有分隔符', stripMention('@海棠花 开了', '海棠'), '花 开了')

console.log('\n③ 剥离：配置过时（名字对不上）也不能卡死')
eq('名字过时，兜底剥掉开头 @', stripMention('@旧名字 你好', '新名字'), '你好')

console.log('\n④ normalizeInbound 只在群聊 text 上剥')
const groupFrame = { body: { chattype: 'group', chatid: 'g1', from: { userid: 'u1' }, msgtype: 'text', text: { content: '@海棠 在吗' } }, headers: { req_id: 'r1' } }
const dmFrame = { body: { chattype: 'single', from: { userid: 'u1' }, msgtype: 'text', text: { content: '@海棠 在吗' } }, headers: { req_id: 'r2' } }
eq('群聊剥掉', normalizeInbound(groupFrame, { botName: '海棠' }).text, '在吗')
eq('单聊不动（单聊本来就没 @ 这回事，出现 @ 是在说别人）', normalizeInbound(dmFrame, { botName: '海棠' }).text, '@海棠 在吗')
const onlyAt = { body: { chattype: 'group', chatid: 'g1', from: { userid: 'u1' }, msgtype: 'text', text: { content: '@海棠 ' } }, headers: {} }
eq('只 @ 不说话', normalizeInbound(onlyAt, { botName: '海棠' }).text, '[对方只 @ 了一下，没说话]')
const imgFrame = { body: { chattype: 'group', chatid: 'g1', from: { userid: 'u1' }, msgtype: 'image' }, headers: {} }
eq('图片消息不做剥离', normalizeInbound(imgFrame, { botName: '海棠' }).text, '[图片]')

console.log('\n⑤ 系统提示：不再说「你叫 X」')
const base = merge(DEFAULTS, { admins: [{ userid: 'u1', name: '季游' }], botName: '海棠', botNameAliases: [] })
const rules = rulesText('owner', base)
check('没有「你叫「海棠」」这种句子', !/你叫「?海棠/.test(rules), rules.slice(0, 200))
check('说明 @ 前缀已替它去过', rules.includes('我们已经替你去掉了'))
check('说明残留 @ 是在说别人', rules.includes('那是在说别人'))

console.log('\n⑥ 系统提示：旧名字被声明为别名')
const renamed = merge(DEFAULTS, { admins: [{ userid: 'u1', name: '季游' }], botName: 'BT', botNameAliases: ['海棠'] })
const r2 = rulesText('owner', renamed)
check('声明了旧名字', r2.includes('以前在企业微信里叫过「海棠」'), r2.slice(0, 300))
check('说明 @旧名 也是叫它自己', r2.includes('@海棠'))
check('要求别主动提旧名字', r2.includes('内部信息'))

console.log('\n⑦ 系统提示：没有别名时不出现那段')
check('无别名不提改名', !rules.includes('以前在企业微信里叫过'))

console.log('\n⑧ personaText：只有角色卡显式写了 {{name}} 才注入名字')
// 内置角色卡第 6 行有「你是{{name}}」，所以配了名字就会被替换进去 —— 这是它的设计。
const withName = personaText({ persona: { current: 'default' }, botName: '海棠' })
check('内置卡写了 {{name}}，会注入', withName.includes('你是海棠'), withName.slice(0, 120))
const noName = personaText({ persona: { current: 'default' }, botName: '' })
check('没配名字时 {{name}} 不会变成空字符串留个洞', !noName.includes('你是，'), noName.slice(0, 120))
check('没配名字时兜底成「我」', noName.includes('你是我'), noName.slice(0, 120))

console.log('\n⑨ 角色卡增删')
const made = createPersona('test-card-1', { name: '测试卡', body: '我是测试卡的正文。' })
check('能新建', made.ok === true, JSON.stringify(made))
const dup = createPersona('test-card-1', { name: '又一个', body: 'x' })
check('同名再新建会被挡（不静默覆盖）', dup.ok === false, JSON.stringify(dup))
const gone = deletePersona('test-card-1')
check('能删除', gone.ok === true, JSON.stringify(gone))
check('删除前留了备份，且备份里是原文', (() => {
  try { return readFileSync(gone.backup, 'utf8').includes('我是测试卡的正文。') } catch { return false }
})(), JSON.stringify(gone.backup))
const goneAgain = deletePersona('test-card-1')
check('删不存在的卡返回 ok:false 而不是 undefined', goneAgain.ok === false && typeof goneAgain.reason === 'string', JSON.stringify(goneAgain))
const delBuiltin = deletePersona('default')
check('内置卡删不掉，且给出理由', delBuiltin.ok === false && /内置/.test(delBuiltin.reason || ''), JSON.stringify(delBuiltin))
check('内置卡确实还在', listPersonas().some((p) => p.id === 'default'))
const weird = deletePersona('../../etc/passwd')
check('id 里的路径符号被清掉，不会越界删', weird.ok === false, JSON.stringify(weird))

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 项通过，${fail} 项失败\n`)
process.exit(fail === 0 ? 0 : 1)
