// 定时提炼：错过时间点之后启动，必须补跑。
//
// 老大问的问题很关键：「定时如果当时没在运行是不是就无法触发」。
// 判断逻辑是 mins >= hh*60+mm（现在几点 ≥ 设定几点），不是「那个时刻有没有被消费」，
// 所以理论上会补 —— 但这只是读代码得出的结论，必须真跑一遍才算数。
//
// 真正要防的是这两种：
//   ① 04:00 时关机，09:00 开机 → 必须立刻补跑
//   ② 连续几天不开机 → 积压的日子必须一起补完，不能只处理今天
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const HOME = mkdtempSync(join(tmpdir(), 'wecom-tick-'))
process.env.DSH_HOME = HOME

const { createConsolidator } = await import('../src/memory/consolidate.js')
const chatlog = await import('../src/core/chatlog.js')

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`✅ ${name}`) }
  else { fail += 1; console.log(`❌ ${name}${extra ? ` → ${extra}` : ''}`) }
}

// 直接往磁盘上造几天的流水（绕过 append，才能指定日期）
const DIR = join(HOME, 'plugins-data', 'wecom-bot', 'chatlog')
mkdirSync(DIR, { recursive: true })
function seedDay(day, n = 6) {
  const rows = []
  for (let i = 0; i < n; i += 1) {
    rows.push(JSON.stringify({
      at: Date.parse(`${day}T10:0${i}:00`),
      chatId: 'u-tick', kind: 'dm', chatName: '', userId: 'u-tick',
      name: '小张', who: 'user', text: `第${i + 1}句：我在说一件要紧的事`,
    }))
  }
  writeFileSync(join(DIR, `${day}.jsonl`), rows.join('\n') + '\n', 'utf8')
}

// 假的模型：永远回「没提炼出东西」，但**记录被调了几次** —— 这才是要验的行为
let calls = 0
const fakeLlm = {
  listProviders: () => [{ id: 'p', name: 'P' }],
  listModels: async () => [{ provider: 'p', id: 'm', name: 'M' }],
  resolveModelInfo: async () => ({ reasoning: { efforts: [], defaultEffort: undefined } }),
  stream() {
    calls += 1
    return (async function* () {
      yield { type: 'text-delta', index: 0, text: '{"memories":[],"skills":[]}' }
      yield { type: 'finish', index: 0, reason: { kind: 'completed' } }
    })()
  },
}
const dsh = { llm: fakeLlm, get: (n) => (n === 'llm' ? fakeLlm : null) }

function makeCfg(times) {
  // model 必须点名 provider/model，否则 ready() 直接判「还没选提炼用的模型」，
  // run() 会 early return，看起来像「到点没补跑」，其实是没配模型。
  return () => ({
    features: { memory: true },
    memory: { autoDistill: true, distillTimes: times },
    model: { provider: 'p', model: 'm', reasoningEffort: 'low' },
  })
}

const stateFile = join(HOME, 'plugins-data', 'wecom-bot', 'memory-distill.json')

/** 把「今天」的时间点设成已经跑过（模拟 04:00 正点跑过） */
function markRan(times) {
  const today = chatlog.dayKey()
  const runs = {}
  for (const t of times) runs[t] = today
  writeFileSync(stateFile, JSON.stringify({ processed: {}, runs, last: null }), 'utf8')
}

async function main() {
  console.log('① 时间点还没到 → 不能抢跑')
  seedDay(chatlog.dayKey(), 6)
  // 设一个 23:59 的时间点，今天几乎不可能刚到；用它验证「没到点不跑」
  {
    const c = createConsolidator({ dsh, getConfig: makeCfg(['23:59']), log: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } })
    calls = 0
    await c.tick()
    ok('没到点时不调模型', calls === 0, `调了 ${calls} 次`)
  }

  console.log('\n② 到点之后才启动 → 必须补跑（这就是老大问的场景）')
  seedDay(chatlog.dayKey(), 6)
  {
    // 00:00 一定能满足「mins >= 0」；标记成今天没跑过
    writeFileSync(stateFile, JSON.stringify({ processed: {}, runs: {}, last: null }), 'utf8')
    const c = createConsolidator({ dsh, getConfig: makeCfg(['00:00']), log: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } })
    calls = 0
    await c.tick()
    ok('补跑了：模型被调用', calls > 0, `调了 ${calls} 次`)
    const st = JSON.parse((await import('node:fs')).readFileSync(stateFile, 'utf8'))
    ok('记下今天已跑（不会每分钟重复烧 token）', st.runs['00:00'] === chatlog.dayKey(), JSON.stringify(st.runs))
  }

  console.log('\n③ 同一天第二次 tick → 不能重复跑')
  {
    const c = createConsolidator({ dsh, getConfig: makeCfg(['00:00']), log: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } })
    calls = 0
    await c.tick()
    ok('第二次 tick 不调模型', calls === 0, `调了 ${calls} 次`)
  }

  console.log('\n④ 连续几天不开机 → 积压的日子要一起补完')
  // 造三天前、两天前的流水，且 treated 为空（表示都没处理过）
  const back = (n) => {
    const d = new Date(Date.now() - n * 86400_000)
    return chatlog.dayKey(d)
  }
  seedDay(back(3), 4)
  seedDay(back(2), 4)
  writeFileSync(stateFile, JSON.stringify({ processed: {}, runs: {}, last: null }), 'utf8')
  {
    const c = createConsolidator({ dsh, getConfig: makeCfg(['00:00']), log: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } })
    calls = 0
    const r = await c.run({ includeToday: true })
    ok('一次 run 处理了多天', r.days >= 2, `days=${r.days}`)
    ok('三天前的流水被消费掉（提炼成功才删）', !chatlog.days().includes(back(3)), chatlog.days().join(','))
    ok('两天前的也被消费掉', !chatlog.days().includes(back(2)), chatlog.days().join(','))
  }

  console.log('\n⑤ 自动提炼关掉 → 一次都不该调模型')
  {
    const c = createConsolidator({
      dsh,
      getConfig: () => ({ features: { memory: true }, memory: { autoDistill: false, distillTimes: ['00:00'] }, model: { provider: 'p', model: 'm' } }),
      log: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
    })
    writeFileSync(stateFile, JSON.stringify({ processed: {}, runs: {}, last: null }), 'utf8')
    calls = 0
    await c.tick()
    ok('关掉后不调模型', calls === 0, `调了 ${calls} 次`)
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} 错过时间点会补跑（${pass} 项通过${fail ? `，${fail} 项失败` : ''}）`)
  rmSync(HOME, { recursive: true, force: true })
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error('测试自身挂了：', e); process.exit(1) })
