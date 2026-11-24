// 流水必须在合理时间内落盘 —— 它是记忆提炼的唯一原料。
//
// 立的这条防线来自一个设计缺陷：
//   chatlog.append 只在攒够 50 条或跨天时 persist()，没有定时器。
//   于是「今天聊了 30 句然后关掉 DSH」= 这 30 句全丢。
//   而企微不会重发历史，丢了就永远补不回来。
//
// 为什么不是每条都写盘：群消息密集时每条一个 writeFileSync 会堵住事件循环，
// 那比丢数据更早被用户感知到（回消息变卡）。所以是「有新增就排一次，30 秒最多一次」。
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'wecom-chatlog-'))

const { append, flush, readDay, dayKey, days, dropDay, prune } = await import('../src/core/chatlog.js')

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`✅ ${name}`) }
  else { fail += 1; console.log(`❌ ${name}${extra ? ` → ${extra}` : ''}`) }
}

const filed = () => join(process.env.DSH_HOME, 'plugins-data', 'wecom-bot', 'chatlog', `${dayKey()}.jsonl`)
const lineCount = () => (existsSync(filed()) ? readFileSync(filed(), 'utf8').trim().split('\n').filter(Boolean).length : 0)

console.log('① 内存里先攒着，不影响读')
append({ chatId: 'u1', kind: 'dm', who: 'user', name: '小张', text: '我不吃辣' })
append({ chatId: 'u1', kind: 'dm', who: 'bot', name: '我', text: '记住了' })
ok('还没落盘时文件不存在（不每条都写）', lineCount() === 0, String(lineCount()))
ok('但 readDay 能看到内存里的两条', readDay(dayKey()).length === 2, String(readDay(dayKey()).length))

console.log('\n② flush 之后必须真的在盘上')
flush()
ok('文件出现了', existsSync(filed()))
ok('两行都在', lineCount() === 2, String(lineCount()))
const first = JSON.parse(readFileSync(filed(), 'utf8').split('\n')[0])
ok('字段齐全（提炼要靠 who/chatId/text）', first.who === 'user' && first.chatId === 'u1' && first.text === '我不吃辣', JSON.stringify(first))
ok('带时间戳', typeof first.at === 'number' && first.at > 0)

console.log('\n③ 落盘后内存要清空，不然重复写')
ok('再 flush 一次不会重复追加', (() => { flush(); return lineCount() === 2 })(), String(lineCount()))
append({ chatId: 'u2', kind: 'group', who: 'user', name: '小李', text: '报表用 B 表' })
flush()
ok('追加的是第三行，不是覆盖', lineCount() === 3, String(lineCount()))
ok('群聊的 kind 存对了', JSON.parse(readFileSync(filed(), 'utf8').trim().split('\n')[2]).kind === 'group')

console.log('\n④ 超长文本要截断（一条消息不该撑爆文件）')
append({ chatId: 'u1', kind: 'dm', who: 'user', name: '小张', text: 'x'.repeat(5000) })
flush()
const last = JSON.parse(readFileSync(filed(), 'utf8').trim().split('\n').pop())
ok('截到 2000 字', last.text.length === 2000, String(last.text.length))

console.log('\n⑤ 管理能力')
ok('days() 列出今天', days().includes(dayKey()), days().join(','))
dropDay(dayKey())
ok('dropDay 之后读不到了', !days().includes(dayKey()) && lineCount() === 0)

console.log(`\n${fail === 0 ? '✅' : '❌'} 流水会按需落盘（${pass} 项通过${fail ? `，${fail} 项失败` : ''}）`)
rmSync(process.env.DSH_HOME, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
