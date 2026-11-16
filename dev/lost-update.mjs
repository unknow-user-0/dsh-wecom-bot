// 回归测试：/save 是增量语义，旧快照不得冲掉别处刚改的值
//
// 这个 bug 出现过两次（workspaceDir 被迁移结果冲掉、accessMode 被向导完成冲掉），
// 根因都是「前端发整份快照 + 后端整体替换」。这里把协议本身钉住：
//   patch 里有什么就改什么，没传的字段一律保持服务端当前值。
//
// 跑法：node dev/lost-update.mjs

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// config.js 的 DATA_DIR 读 DSH_HOME，先指到临时目录，别碰真实配置
const HOME = mkdtempSync(join(tmpdir(), 'wecom-lost-'))
process.env.DSH_HOME = HOME

const { createFakeHost } = await import('./fake-host.js')
const host = createFakeHost({ replyText: 'x' })
const mod = await import('../src/host.js')
const dispose = mod.apply(host.ctx)

const save = (config) => host.callRoute('/wecom-bot/api/save', { config })
const config = async () => (await host.callRoute('/wecom-bot/api/config')).config

let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed++
}

// ── 用例 1：面板只发改动字段，别处设的 accessMode 不被冲掉 ──────────────
// 场景：用户在向导里选了开放模式；随后回到面板改了 botName 并保存。
// 旧实现里面板 draft 是打开面板那一刻的快照（accessMode 还是 whitelist），
// 整份发回去就把 open 冲回 whitelist —— 这就是用户报的那个 bug。
await save({ accessMode: 'open' })
await save({ botName: '海棠' })          // 面板只发了改动的那个字段
{
  const c = await config()
  check('用例1 旧快照不冲掉 accessMode', c.accessMode === 'open', `accessMode=${c.accessMode}`)
  check('用例1 改动本身生效', c.botName === '海棠', `botName=${c.botName}`)
}

// ── 用例 2：嵌套半截对象不冲掉同级字段（浅合并的老 bug）──────────────
// 面板只改「等几秒算说完」一个阈值，发 merge:{waitSec:3}。
// 浅合并会把整个 merge 对象替换成 {waitSec:3}，enabled/maxSec 全被默认值补齐。
await save({ merge: { enabled: false, maxSec: 20 } })
await save({ merge: { waitSec: 3 } })
{
  const c = await config()
  check('用例2 同级字段保留', c.merge.enabled === false && c.merge.maxSec === 20,
    `enabled=${c.merge.enabled} maxSec=${c.merge.maxSec}`)
  check('用例2 改动本身生效', c.merge.waitSec === 3, `waitSec=${c.merge.waitSec}`)
}

// ── 用例 3：向导「完成」只提交两个标记，不动别的 ─────────────────────
// 这正是实测复现过的路径：第 3 步存 open → 第 4 步点完成 → 被冲回 whitelist。
await save({ accessMode: 'open' })
await save({ setupDone: true, guideDone: true })   // 修好后的 finish()
{
  const c = await config()
  check('用例3 向导完成不撤销准入', c.accessMode === 'open', `accessMode=${c.accessMode}`)
  check('用例3 完成标记生效', c.setupDone === true && c.guideDone === true)
}

// ── 用例 4：空 patch 不改任何东西 ───────────────────────────────────
{
  const before = await config()
  await save({})
  const after = await config()
  check('用例4 空 patch 不动配置', JSON.stringify(before) === JSON.stringify(after))
}

// ── 用例 5：admins / workspaceDir 永远不走 /save（兜底仍在）──────────
{
  const before = await config()
  await save({ admins: [{ userid: 'hacker', role: 'owner' }], workspaceDir: 'C:\\nope' })
  const after = await config()
  check('用例5 admins 不被 /save 改写',
    JSON.stringify(after.admins) === JSON.stringify(before.admins),
    `admins=${after.admins.length}`)
  check('用例5 workspaceDir 不被 /save 改写',
    after.workspaceDir === before.workspaceDir, `dir=${after.workspaceDir}`)
}

// ── 用例 6：扁平传参也走增量（脚本/curl 方便）────────────────────────
await save({ botName: '旧名字' })
await host.callRoute('/wecom-bot/api/save', { botName: '新名字' })  // 不带 config 包装
{
  const c = await config()
  check('用例6 扁平传参生效', c.botName === '新名字', `botName=${c.botName}`)
}

try { dispose() } catch {}

// ── 用例 7：面板只发「用户动过的字段」（防线在前端）─────────────────
// 后端改成增量语义后，前端如果还发整份快照，bug 照样回来。而且光靠
// 「draft 和 cfg 做 diff」也不行：面板开着的时候别处把 accessMode 改成 open，
// draft 里还是旧值 whitelist，diff 会误判成「用户改过」又把旧值发回去。
// 正确判据是「用户碰过哪些字段」——这里直接钉住 buildPatch / applyEdits。
{
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const HERE = dirname(fileURLToPath(import.meta.url))

  const React = {
    createElement: (t, p, ...k) => ({ $$el: true, t, p, k }),
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {}, useRef: (v) => ({ current: v }),
    useMemo: (f) => f(), useCallback: (f) => f, Fragment: 'Fragment',
  }
  const reg = []
  globalThis.window = { __ModuleLoader__: { load: ({ id, factory }) => reg.push({ id, mod: factory(() => React) }) } }
  globalThis.document = { getElementById: () => null, createElement: () => ({ set textContent(v) {}, id: '' }), head: { appendChild() {} } }
  globalThis.fetch = async () => ({ json: async () => ({ ok: false }) })
  globalThis.setInterval = () => 0
  globalThis.clearInterval = () => {}
  new Function('window', 'document', 'fetch', 'setInterval', 'clearInterval',
    readFileSync(join(HERE, '..', 'client', 'client.js'), 'utf8'))(
    globalThis.window, globalThis.document, globalThis.fetch, globalThis.setInterval, globalThis.clearInterval)

  const { buildPatch, applyEdits } = reg[0].mod

  check('用例7 只发用户动过的字段',
    JSON.stringify(buildPatch({ botName: '新' })) === '{"botName":"新"}',
    JSON.stringify(buildPatch({ botName: '新' })))
  check('用例7 什么都没动就返回空对象', Object.keys(buildPatch({})).length === 0)
  check('用例7 嵌套字段拼出正确层级',
    JSON.stringify(buildPatch({ 'merge.waitSec': 9 })) === '{"merge":{"waitSec":9}}',
    JSON.stringify(buildPatch({ 'merge.waitSec': 9 })))

  const server = { botName: '旧', accessMode: 'open', merge: { enabled: false, waitSec: 2.5 } }
  const shown = applyEdits(JSON.parse(JSON.stringify(server)), { botName: '新' })
  check('用例7 reload 后服务端新值能看到', shown.accessMode === 'open', 'accessMode=' + shown.accessMode)
  check('用例7 reload 后用户改动还在', shown.botName === '新', 'botName=' + shown.botName)
  check('用例7 嵌套改动也能盖上去',
    applyEdits(JSON.parse(JSON.stringify(server)), { 'merge.waitSec': 9 }).merge.waitSec === 9)
}

rmSync(HOME, { recursive: true, force: true })

console.log(failed ? `\n❌ ${failed} 条没过` : '\n✅ /save 增量语义全部通过')
process.exit(failed ? 1 : 0)
