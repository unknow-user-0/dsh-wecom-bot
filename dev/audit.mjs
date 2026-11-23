// 静态体检：找出「装进插件但从没被用上」和「用了但不可能成功」的东西。
//
// 为什么需要这个脚本：前面几轮的真 bug 全是这一类——
//   · __wecomRequire 从来没被赋值 → 出站图永不压缩
//   · cordis.patch.yml 没引用 {{wecom_context}} → 模型永远不知道自己有记性
//   · item.kind 从来没被写过 → ephemeral 永不过期
// 它们的共同点：代码能跑、测试能绿、日志不报错，功能就是不在工作。
// 人工看日志只能靠运气撞上，所以把「引用关系」本身变成可检查的东西。
//
// 跑：node dev/audit.mjs

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, extname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')

let pass = 0
let fail = 0
const warns = []
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  ✅', name) }
  else { fail += 1; console.log('  ❌', name, detail === undefined ? '' : `→ ${detail}`) }
}
const warn = (msg) => { warns.push(msg); console.log('  ⚠️ ', msg) }

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (extname(p) === '.js' || extname(p) === '.mjs') out.push(p)
  }
  return out
}

/**
 * 去掉注释再检查。
 *
 * 这条很要紧：__wecomRequire 这个 bug 修完之后，代码里只剩下注释提到它。
 * 不剥注释的话 audit 会一直报它 —— 报警器自己报假警，用两次就没人看了。
 *
 * 但**不能用正则剥**：src/host.js 第 5 行的行注释里写着 `/wecom-bot/api/* 接口`，
 * 那个 `/*` 会让 /\/\*[\s\S]*?\*\// 从这行一路吃到下一个 `*\/`，
 * 一口气吞掉一万四千字正文，于是后面所有 import 都「不存在」，
 * 检查结果全是假的。所以按字符扫：认字符串、模板串、行注释、块注释。
 */
function stripComments(src) {
  const out = []
  let i = 0
  const n = src.length
  let quote = ''      // 当前所在字符串的引号：', ", `
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (quote) {
      out.push(c)
      if (c === '\\') { out.push(src[i + 1] ?? ''); i += 2; continue }
      if (c === quote) quote = ''
      i += 1
      continue
    }
    if (c === '/' && d === '/') {                    // 行注释：跳到行尾
      while (i < n && src[i] !== '\n') i += 1
      continue
    }
    if (c === '/' && d === '*') {                    // 块注释：跳到结束（保留换行，行号不错位）
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out.push('\n')
        i += 1
      }
      i += 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') quote = c
    out.push(c)
    i += 1
  }
  return out.join('')
}

const files = walk(SRC)
const raw = new Map(files.map((f) => [relative(ROOT, f).replace(/\\/g, '/'), readFileSync(f, 'utf8')]))
const code = new Map([...raw].map(([f, s]) => [f, stripComments(s)]))
const client = stripComments(readFileSync(join(ROOT, 'client/client.js'), 'utf8'))
const patchYml = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
const hostSrc = raw.get('src/host.js') || ''

// ---------------------------------------------------------------- ①
console.log('\n① 全局钩子：写了读、没人写 → 功能永远不生效')
// 抓「全局可变状态」这一类：globalThis.xxx / global.xxx 被读但没被赋值
const globalsRead = new Set()
const globalsWritten = new Set()
for (const [f, s] of code) {
  for (const m of s.matchAll(/globalThis\.(__?\w+)/g)) {
    // 赋值形式：globalThis.x = / globalThis.x ||= 之类
    const isWrite = new RegExp(`globalThis\\.${m[1]}\\s*(=[^=]|\\|\\|=|&&=|\\?\\?)`).test(s)
    if (isWrite) globalsWritten.add(m[1])
    else globalsRead.add(m[1])
  }
}
const dangling = [...globalsRead].filter((g) => !globalsWritten.has(g))
ok('没有「只读不写」的全局钩子', dangling.length === 0, dangling.join(', '))

// ---------------------------------------------------------------- ②
console.log('\n② 提示词变量：模板里引用的，host 必须注册过')
const registered = new Set([...hostSrc.matchAll(/variable\(\s*['"]([\w_]+)['"]/g)].map((m) => m[1]))
const referenced = new Set([...patchYml.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))
const missing = [...referenced].filter((v) => !registered.has(v))
ok('模板里的变量都注册了', missing.length === 0, missing.join(', '))
// 反过来：注册了但模板没引用 → 白算了
const unusedVars = [...registered].filter((v) => !referenced.has(v))
ok('注册的变量都被模板用上了', unusedVars.length === 0, unusedVars.join(', '))
ok('记忆提示确实接进了系统提示', patchYml.includes('{{wecom_context}}'))

// ---------------------------------------------------------------- ③
console.log('\n③ 字段名一致性：写入用的字段名，判定时也得用同一个')
// 记忆条目的类型字段：add() 写的是哪个，三处判定就必须是哪个
const storeSrc = code.get('src/memory/store.js') || ''
const writesKind = /(\w+):\s*(o\.)?type\b/.test(storeSrc)
const judgesKind = /item\.kind\b|it\.kind\b/.test(storeSrc)
const judgesType = /item\.type\b|it\.type\b/.test(storeSrc)
ok('类型字段没有 type/kind 混用', !(writesKind && judgesKind && !judgesType), 'store.js 里同时存在 type 写入和 kind 判定')

// ---------------------------------------------------------------- ④
console.log('\n④ 后端路由 vs 面板调用')
const routes = new Set([...hostSrc.matchAll(/route\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]))
const called = new Set()
// 去掉查询串再比：面板可能调 '/persona?id=xx'，后端注册的是 '/persona'
for (const m of client.matchAll(/\b(?:get|post)\(\s*['"]([^'"]+)['"]/g)) {
  called.add(m[1].split('?')[0])
}
// 还可能有拼出来的路径（`/x/${id}`）—— 取前缀再比一次
const calledNoRoute = [...called].filter((p) => {
  if (p.startsWith('http')) return false
  if (routes.has(p)) return false
  // 'slots' 之类是 DSH 服务名，不是本插件的接口
  if (!p.startsWith('/')) return false
  // 拼出来的路径：后端注册的前缀能对上就算有
  return ![...routes].some((r) => p.startsWith(r + '/'))
})
ok('面板调的接口后端都有', calledNoRoute.length === 0, calledNoRoute.join(', '))
// 只提醒不判死：有些路由是给 MCP/外部用的
const routesNeverCalled = [...routes].filter((p) => !called.has(p))
if (routesNeverCalled.length) warn(`后端有面板不调的接口（可能是给外部用的，人工确认）：${routesNeverCalled.join(', ')}`)

// ---------------------------------------------------------------- ⑤
console.log('\n⑤ 导出了但全项目没人引用的（疑似半成品）')
// 判定标准故意放得很松：**只要在任何地方（包括自己文件、包括测试）出现过一次
// 除定义行以外的引用，就算在用**。因为这条检查的价值全在「准」——
// 之前那个 __wecomRequire 是真正的孤儿，而这种孤儿少但有杀伤力；
// 把「只在同文件用」「只在测试用」也算成问题时，一次会报五十条，
// 报警器变成噪音源，真正那条就淹在里面了。那些情况下面单独用提醒列出。
const devFiles = readdirSync(join(ROOT, 'dev')).filter((n) => n.endsWith('.mjs'))
const dynSrc = [...code.values()].join(String.fromCharCode(10)) + String.fromCharCode(10)
const devSrc = devFiles.map((n) => stripComments(readFileSync(join(ROOT, 'dev', n), 'utf8'))).join('\n')

const dead = []
const testOnly = []
for (const [f, s] of code) {
  const names = []
  for (const m of s.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) names.push(m[1])
  for (const m of s.matchAll(/export\s+const\s+(\w+)\s*=/g)) names.push(m[1])
  for (const name of names) {
    const word = new RegExp(`\\b${name}\\b`)
    // 定义行本身不算引用
    const withoutDef = s.replace(new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${name}\\b`), '')
    let usedInProduct = word.test(withoutDef)
    // import { x as y } —— 只出现一次、后面全程用别名，必须单独认
    const aliased = new RegExp(`\\{[^}]*\\b${name}\\s+as\\s+\\w+[^}]*\\}`)
    if (!usedInProduct) {
      for (const [g, t] of code) {
        if (g === f) continue
        if (word.test(t) || aliased.test(t)) { usedInProduct = true; break }
      }
    }
    if (!usedInProduct && (word.test(client) || aliased.test(client))) usedInProduct = true
    if (usedInProduct) continue
    if (word.test(devSrc)) testOnly.push(`${f} → ${name}`)
    else dead.push(`${f} → ${name}`)
  }
}
ok('没有全项目零引用的导出', dead.length === 0, dead.join(' | '))
// 只在测试里出现：可能是动态 import 或字符串拼出来的名字（会误报），所以只提醒
if (testOnly.length) warn(`只在测试里出现（可能是动态 import，人工确认）：${testOnly.join(' | ')}`)

// ---------------------------------------------------------------- ⑥
console.log('\n⑥ 配置项：定义了就要有人读')
const cfgSrc = code.get('src/core/config.js') || ''
// 只查 DEFAULTS 里的一级键
const defaultsBlock = cfgSrc.slice(cfgSrc.indexOf('const DEFAULTS'), cfgSrc.indexOf('export function load'))
const defKeys = new Set([...defaultsBlock.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]))
const consumers = [hostSrc, client, ...code.values()].join('\n')
const unreadKeys = [...defKeys].filter((k) => {
  // 读写形式：cfg.x / .x = / draft.x / ['x']
  return !new RegExp(`\\.${k}\\b|['"]${k}['"]`).test(consumers)
})
ok('配置项都有人读', unreadKeys.length === 0, unreadKeys.join(', '))

// ---------------------------------------------------------------- ⑦
console.log('\n⑦ 测试替身不能比真身宽松')
const fakeHost = readFileSync(join(ROOT, 'dev/fake-host.js'), 'utf8')
ok('fake-host 挡重名注册（跟真 dsh-tools 一致）', /already registered in this scope/.test(fakeHost))
// 生产传对象 logger、测试传函数 logger —— 这个不一致曾让「上传失败杀进程」漏测
const crashTest = readFileSync(join(ROOT, 'dev/placeholder-crash.mjs'), 'utf8')
ok('崩溃测试用的是对象形态 logger（生产形态）', /log:\s*\{[^}]*warn/.test(crashTest) || /asLog/.test(crashTest))

// ---------------------------------------------------------------- ⑧
console.log('\n⑧ 数据目录没有被测试直接写（避免又一次删掉用户数据）')
// 不能一刀切「import 了 src 就必须隔离」：只校验工具 schema 的测试压根不碰盘。
// 所以沿 import 链往下走，只有链上出现「碰数据目录的模块」才算必须隔离。
// 这条规则的来历：上次 dev/names.mjs 直接调真实 deletePersona，
// 把老大手写的 BT-7274 角色卡 unlink 掉了（绕过回收站）。
const DATA_TOUCHING = [
  'src/core/config.js',     // 加载时就算出 DATA_DIR
  'src/memory/store.js',
  'src/memory/skills.js',
  'src/core/chatlog.js',
  'src/persona/personas.js',
]
function importChain(file, seen = new Set()) {
  const s = readFileSync(file, 'utf8')
  const dir = dirname(file)
  for (const m of s.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
    let p = join(dir, m[1])
    if (!p.endsWith('.js')) p += '.js'
    if (seen.has(p) || !existsSync(p)) continue
    seen.add(p)
    importChain(p, seen)
  }
  return seen
}
const testFiles = readdirSync(join(ROOT, 'dev')).filter((n) => n.endsWith('.mjs'))
const dirty = []
for (const n of testFiles) {
  const file = join(ROOT, 'dev', n)
  const s = readFileSync(file, 'utf8')
  const touchesData = [...importChain(file)].some((p) => {
    const rel = relative(ROOT, p).replace(/\\/g, '/')
    return DATA_TOUCHING.includes(rel)
  })
  if (!touchesData) continue
  if (/DSH_HOME|setPersonasDir|mkdtemp/.test(s)) continue
  dirty.push(n)
}
ok('会碰数据层的测试都做了隔离', dirty.length === 0, dirty.join(', '))

// ---------------------------------------------------------------- ⑨
console.log('\n⑨ 打包面：文件该有的有，不该有的没有')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
// repository 不判死：仓库地址只有作者知道，不该由脚本猜。
// 但它是开源的硬伤（npm 页面上没有任何源站链接），所以要单独提醒到显眼处。
if (!pkg.repository) warn('package.json 还没有 repository 字段 —— 发布前要填上真实仓库地址，否则开源页面上找不到源码')
else ok('有 repository 字段（开源的硬要求）', true)
ok('main 指向的文件存在', existsSync(join(ROOT, pkg.main || 'index.js')), pkg.main)
ok('files 里含 src 与 client', (pkg.files || []).includes('src') && (pkg.files || []).includes('client'))
ok('LICENSE 进了打包清单', (pkg.files || []).includes('LICENSE'))
ok('MIT 与 LICENSE 文件对得上', String(pkg.license || '').toUpperCase() === 'MIT' && existsSync(join(ROOT, 'LICENSE')), pkg.license)
// dev/ 不该进包：那是测试与临时脚本，用户用不上还要多下几百 KB
ok('dev/ 没被打进包', !(pkg.files || []).includes('dev'))
// 依赖声明得跟实际 import 对得上：少声明会在别人机器上装不上
const imports = [...code.values()].join('\n')
const bareImports = new Set()
for (const m of imports.matchAll(/(?:^|\n)\s*import[^\n]*?from\s+['"]([^'".][^'"]*)['"]/g)) {
  const spec = m[1]
  if (spec.startsWith('node:') || spec.startsWith('.')) continue
  bareImports.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])
}
const declared = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.optionalDependencies || {}), ...Object.keys(pkg.peerDependencies || {})])
const missingDeps = [...bareImports].filter((d) => !declared.has(d))
ok('import 的第三方包都声明了', missingDeps.length === 0, missingDeps.join(', '))

console.log(`\n${fail ? '❌' : '✅'} ${pass} 项通过${fail ? `，${fail} 项失败` : ''}${warns.length ? `，${warns.length} 条提醒` : ''}`)
console.log(warns.length ? `\n提醒：\n${warns.map((w) => ' · ' + w).join('\n')}\n` : '')
process.exit(fail ? 1 : 0)
