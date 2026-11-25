// 回归：模型提炼失败时，原始聊天流水绝不能被删，且不能陷入每分钟重试烧 token。
//
// 这是旧会话最后发现的恶性 bug：402/网络错误被 distill 的 catch 吞掉 →
// consolidate 误判成功 → dropDay 删掉唯一原料（企微不重发，永久丢）。
// 修完又冒出二阶坑：tick 只在 r.ok 时标记 runs，失败就每分钟重试烧 token。
// 两条一起验。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const HOME = mkdtempSync(join(tmpdir(), 'wecom-fail-'))
process.env.DSH_HOME = HOME

const { createConsolidator } = await import('../src/memory/consolidate.js')
const chatlog = await import('../src/core/chatlog.js')

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`✅ ${name}`) }
  else { fail += 1; console.log(`❌ ${name}${extra ? ` → ${extra}` : ''}`) }
}

const DIR = join(HOME, 'plugins-data', 'wecom-bot', 'chatlog')
const STATE_FILE = join(HOME, 'plugins-data', 'wecom-bot', 'memory-distill.json')
mkdirSync(DIR, { recursive: true })

function seedDay(day, n = 6) {
  const rows = []
  for (let i = 0; i < n; i += 1) {
    rows.push(JSON.stringify({
      at: Date.parse(`${day}T10:0${i}:00`),
      chatId: 'u-lose', kind: 'dm', chatName: '小张', userId: 'u-lose',
      name: '小张', who: 'user', text: `第${i + 1}句：我在说一件要紧的事`,
    }))
  }
  writeFileSync(join(DIR, `${day}.jsonl`), rows.join('\n') + '\n', 'utf8')
}

function failingLlm() {
  return {
    listProviders: () => [{ id: 'p', name: 'P' }],
    listModels: async () => [{ provider: 'p', id: 'm', name: 'M' }],
    resolveModelInfo: async () => ({ reasoning: { efforts: [], defaultEffort: undefined } }),
    stream() {
      return (async function* () {
        yield { type: 'finish', index: 0, reason: { kind: 'error', failure: { code: '402', message: '余额不足' } } }
      })()
    },
  }
}
function makeCfg(times) {
  return () => ({
    features: { memory: true },
    memory: { autoDistill: true, distillTimes: times },
    model: { provider: 'p', model: 'm', reasoningEffort: 'low' },
  })
}
const log = { debug() {}, info() {}, warn() {}, error() {} }

async function main() {
  const yesterday = chatlog.dayKey(new Date(Date.now() - 86400_000))

  console.log('① 模型报错 → run 必须报失败，且昨天的原料还在')
  seedDay(yesterday)
  {
    const llm = failingLlm()
    const c = createConsolidator({ dsh: { llm, get: (n) => (n === 'llm' ? llm : null) }, getConfig: makeCfg(['04:00']), log })
    const r = await c.run()
    ok('run 返回失败', r.ok === false, JSON.stringify(r))
    ok('返回里带 attempted（真调过模型）', r.attempted === true, JSON.stringify(r))
    ok('原料文件还在（没被静默删掉）', existsSync(join(DIR, `${yesterday}.jsonl`)))
    const st = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    ok('processed 水位没推进（下轮能重试）', !st.processed || !st.processed[yesterday], JSON.stringify(st.processed))
    ok('last 记下了错误（面板能看见）', Boolean(st.last && st.last.error && /余额不足/.test(st.last.error)), JSON.stringify(st.last))
  }

  console.log('\n② 定时失败 → 标记 runs，不能每分钟重试烧 token')
  {
    rmSync(STATE_FILE, { force: true })
    seedDay(chatlog.dayKey())
    const llm = failingLlm()
    let calls = 0
    const origStream = llm.stream
    llm.stream = function () { calls += 1; return origStream.call(this) }
    const c = createConsolidator({ dsh: { llm, get: (n) => (n === 'llm' ? llm : null) }, getConfig: makeCfg(['00:00']), log })
    await c.tick()
    ok('第一次 tick 调了模型', calls === 1, `调了 ${calls} 次`)
    await c.tick()
    ok('第二次 tick 没再调（今天这个点已标记）', calls === 1, `调了 ${calls} 次`)
    const st = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    ok('runs 记下了今天', st.runs && st.runs['00:00'] === chatlog.dayKey(), JSON.stringify(st.runs))
  }

  console.log(`\n${fail ? '❌' : '✅'} ${pass} 项通过${fail ? `，${fail} 项失败` : ''}\n`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
