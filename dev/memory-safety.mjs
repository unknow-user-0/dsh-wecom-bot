// 回归：本轮「唯一原料不再被静默销毁 / 越权工具不给群成员」的修复。
// 覆盖 4 条新堵的路径 + 权限双保险：
//   A. 模型输出坏 JSON（截断）→ run 失败、原料保留
//   B. 记忆写盘失败 → run 失败、原料保留（不再「记没存成、流水却删了」）
//   C. 功能关闭时 tick 不 prune（没提炼过的老流水不许按天数删）
//   D. wecom_mcp / wecom_group_history 标了 adminOnly，且 execute 内二次校验 owner
//
// 隔离：先设 DSH_HOME 再 import（config.js 的 DATA_DIR 在 import 时定死）。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const HOME = mkdtempSync(join(tmpdir(), 'wecom-safety-'))
process.env.DSH_HOME = HOME

const { createConsolidator } = await import('../src/memory/consolidate.js')
const chatlog = await import('../src/core/chatlog.js')
const { buildTools } = await import('../src/tools/wecom.js')
const DATA = join(HOME, 'plugins-data', 'wecom-bot')
const DIR = join(DATA, 'chatlog')
const MEM_FILE = join(DATA, 'memory.json')
mkdirSync(DIR, { recursive: true })

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`✅ ${name}`) }
  else { fail += 1; console.log(`❌ ${name}${extra ? ` → ${extra}` : ''}`) }
}
const dayBefore = (n) => chatlog.dayKey(new Date(Date.now() - n * 86400_000))
function seedDay(day, n = 6) {
  const rows = []
  for (let i = 0; i < n; i += 1) {
    rows.push(JSON.stringify({
      at: Date.parse(`${day}T10:0${i}:00`),
      chatId: 'u-x', kind: 'dm', chatName: '小张', userId: 'u-x',
      name: '小张', who: 'user', text: `第${i + 1}句：我说一件正经事`,
    }))
  }
  writeFileSync(join(DIR, `${day}.jsonl`), rows.join('\n') + '\n', 'utf8')
}
function llmReturning(text) {
  return {
    listProviders: () => [{ id: 'p', name: 'P' }],
    listModels: async () => [{ provider: 'p', id: 'm', name: 'M' }],
    resolveModelInfo: async () => ({ reasoning: { efforts: [], defaultEffort: undefined } }),
    stream() {
      return (async function* () {
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'finish', index: 0, reason: { kind: 'completed' } }
      })()
    },
  }
}
function makeCfg(features = { memory: true }, auto = true) {
  return () => ({ features, memory: { autoDistill: auto, distillTimes: ['04:00'] }, model: { provider: 'p', model: 'm', reasoningEffort: 'low' } })
}
const dshOf = (llm) => ({ llm, get: (n) => (n === 'llm' ? llm : null) })
const log = { debug() {}, info() {}, warn() {}, error() {} }
function makeConsolidator(llm, cfg = makeCfg()) {
  return createConsolidator({ dsh: dshOf(llm), getConfig: cfg, log })
}

async function main() {
  console.log('① 模型输出坏 JSON（截断）→ run 失败、原料保留')
  {
    const d = dayBefore(1)
    seedDay(d)
    const c = makeConsolidator(llmReturning('这是一段被 maxTokens 截断的输出，没有合法 JSON {'))
    const r = await c.run()
    ok('run 报失败（没把坏输出当「没啥可记」）', r.ok === false, JSON.stringify(r))
    ok('原料文件还在', existsSync(join(DIR, `${d}.jsonl`)), d)
    const st = JSON.parse(readFileSync(join(DATA, 'memory-distill.json'), 'utf8'))
    ok('last 记下解析错误', Boolean(st.last && st.last.error && /JSON|截断/.test(st.last.error)), JSON.stringify(st.last))
  }

  console.log('\n② 记忆写盘失败 → run 失败、原料保留（放最后，会破坏 memory.json）')
  {
    const d = dayBefore(2)
    seedDay(d)
    // 让 memory.json 写盘失败：把它变成一个目录，renameSync 必然报错
    try { rmSync(MEM_FILE, { force: true, recursive: true }) } catch {}
    mkdirSync(MEM_FILE, { recursive: true })
    const good = JSON.stringify({ memories: [{ op: 'add', text: '小张不吃辣', about: '小张', importance: 0.7 }], skills: [] })
    const c = makeConsolidator(llmReturning(good))
    let threw = false
    let r
    try { r = await c.run() } catch { threw = true }
    ok('save 抛错被 consolidate 接住（没崩进程）', !threw)
    ok('run 报失败（没误判成功）', r && r.ok === false, JSON.stringify(r))
    ok('原料文件还在', existsSync(join(DIR, `${d}.jsonl`)), d)
  }

  console.log('\n③ 功能关闭时 tick 不 prune（没提炼过的老流水不许删）')
  {
    // 上一步把 memory.json 弄成目录了，先恢复，否则 status/saveState 之外的读取可能受影响
    try { rmSync(MEM_FILE, { force: true, recursive: true }) } catch {}
    rmSync(join(DATA, 'memory-distill.json'), { force: true })
    const old = dayBefore(30)
    seedDay(old)
    const llm = llmReturning(JSON.stringify({ memories: [], skills: [] }))
    const c = makeConsolidator(llm, makeCfg({ memory: false }, false))
    await c.tick()
    ok('关着记忆时 tick 不删老流水', existsSync(join(DIR, `${old}.jsonl`)), old)
  }

  console.log('\n④ 越权工具：adminOnly 标记 + execute 内二次校验')
  {
    const cfg = { admins: [{ userid: 'owner1', role: 'owner' }], features: {} }
    const tools = buildTools({
      getConfig: () => cfg,
      getClient: () => null,
      mcpFor: async () => null,
      memory: {},
      chatOfSession: () => ({ userId: 'stranger', chatId: 'g1' }),
      recentMessages: () => [],
      log,
    })
    const mcp = tools.find((t) => t.name === 'wecom_mcp')
    const hist = tools.find((t) => t.name === 'wecom_group_history')
    ok('wecom_mcp 标了 adminOnly', Boolean(mcp && mcp.adminOnly))
    ok('wecom_group_history 标了 adminOnly', Boolean(hist && hist.adminOnly))
    // social 挂载层过滤（与 host.toolsFor 同款规则）
    const social = tools.filter((t) => !/file|disk|draw/.test(t.name) && !t.adminOnly)
    ok('social 档过滤后不含 wecom_mcp', !social.some((t) => t.name === 'wecom_mcp'))
    ok('social 档过滤后不含 wecom_group_history', !social.some((t) => t.name === 'wecom_group_history'))
    // execute 内二次校验：群成员就算拿到也被拒
    const r1 = await mcp.execute({ action: 'list', service: 'msg' }, { sessionId: 's' })
    ok('群成员调 wecom_mcp 被拒', r1.ok === false, JSON.stringify(r1))
    const r2 = await hist.execute({ minutes: 60 }, { sessionId: 's' })
    ok('群成员调 wecom_group_history 被拒', r2.ok === false, JSON.stringify(r2))
  }

  console.log(`\n${fail ? '❌' : '✅'} ${pass} 项通过${fail ? `，${fail} 项失败` : ''}\n`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
