// 灵活整理模式：聊完静默一会儿才整理；整理过就清水位，绝不周期性烧 token。
//
// 用假时钟推进时间（真等 5 分钟不现实）。注意 consolidate.js 里读时间都是 Date.now()，
// 全局替换它即可；dayKey() 用的是 new Date()，保持真实时间，所以种子流水落在今天。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const HOME = mkdtempSync(join(tmpdir(), 'wecom-flex-'))
process.env.DSH_HOME = HOME

let nowMs = Date.now()
const realNow = Date.now
Date.now = () => nowMs  // 假时钟：测试里手动推进

const { createConsolidator } = await import('../src/memory/consolidate.js')
const chatlog = await import('../src/core/chatlog.js')

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`✅ ${name}`) }
  else { fail += 1; console.log(`❌ ${name}${extra ? ` → ${extra}` : ''}`) }
}
const log = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }

// 造今天的流水
const DIR = join(HOME, 'plugins-data', 'wecom-bot', 'chatlog')
mkdirSync(DIR, { recursive: true })
function seedDay(day, n = 6) {
  const rows = []
  for (let i = 0; i < n; i += 1) {
    rows.push(JSON.stringify({
      at: nowMs, chatId: 'u-flex', kind: 'dm', chatName: '', userId: 'u-flex',
      name: '小张', who: 'user', text: `第${i + 1}句：一件要紧的事`,
    }))
  }
  writeFileSync(join(DIR, `${day}.jsonl`), rows.join('\n') + '\n', 'utf8')
}

// 假模型：记调用次数；它「提炼成功」返回空
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

function makeCfg(over = {}) {
  return () => ({
    features: { memory: true },
    memory: { autoDistill: true, mode: 'flexible', flexIdleSec: 300, flexMinGapSec: 600, ...over },
    model: { provider: 'p', model: 'm', reasoningEffort: 'low' },
  })
}

async function main() {
  console.log('① 还没聊过（没打活动点）→ 不跑')
  seedDay(chatlog.dayKey())
  {
    const c = createConsolidator({ dsh, getConfig: makeCfg(), log })
    calls = 0
    await c.tick()
    ok('没活动点不调模型', calls === 0, `调了 ${calls} 次`)
  }

  console.log('\n② 聊完但没静默够 → 不跑')
  {
    const c = createConsolidator({ dsh, getConfig: makeCfg(), log })
    calls = 0
    c.noteActivity()
    nowMs += 299_000  // 静默 299s < 300s
    await c.tick()
    ok('没静默够不调模型', calls === 0, `调了 ${calls} 次`)
    nowMs += 2_000    // 累计 301s
    await c.tick()
    ok('静默够了才调模型', calls === 1, `调了 ${calls} 次`)
  }

  console.log('\n③ 整理过一次就清水位：时间再过也不重复跑（欠费也不烧钱）')
  {
    const c = createConsolidator({ dsh, getConfig: makeCfg(), log })
    calls = 0
    c.noteActivity()
    nowMs += 301_000
    await c.tick()
    ok('第一次触发', calls === 1, `调了 ${calls} 次`)
    nowMs += 3_600_000  // 又过一小时，期间没有新消息
    await c.tick()
    ok('没新消息不重复调模型', calls === 1, `调了 ${calls} 次`)
  }

  console.log('\n④ 有新消息才重新计时；但离上次整理太近（小于最小间隔）→ 不跑')
  {
    const c = createConsolidator({ dsh, getConfig: makeCfg(), log })
    calls = 0
    c.noteActivity()
    nowMs += 301_000
    await c.tick()               // 触发第 1 次，记 lastFlexTriggeredAt
    c.noteActivity()             // 新消息
    nowMs += 301_000             // 静默够，但距上次只有 301s < 600s
    await c.tick()
    ok('小于最小间隔不跑', calls === 1, `调了 ${calls} 次`)
    nowMs += 300_000             // 距上次 601s > 600s
    await c.tick()
    ok('过了最小间隔才跑', calls === 2, `调了 ${calls} 次`)
  }

  console.log('\n⑤ 定时模式不受灵活模式影响（回归）')
  {
    const c = createConsolidator({
      dsh,
      getConfig: () => ({
        features: { memory: true },
        memory: { autoDistill: true, mode: 'scheduled', distillTimes: ['00:00'] },
        model: { provider: 'p', model: 'm' },
      }),
      log,
    })
    calls = 0
    c.noteActivity()
    nowMs += 3_600_000
    await c.tick()   // 走定时分支；00:00 已到（mins>=0），会跑一次
    ok('定时模式仍按到点跑，不读活动点', calls === 1, `调了 ${calls} 次`)
  }

  Date.now = realNow
  console.log(`\n${fail === 0 ? '✅' : '❌'} 灵活整理模式（${pass} 项通过${fail ? `，${fail} 项失败` : ''}）`)
  rmSync(HOME, { recursive: true, force: true })
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { Date.now = realNow; console.error('测试自身挂了：', e); process.exit(1) })
