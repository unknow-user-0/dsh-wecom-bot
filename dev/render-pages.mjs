// 面板渲染快照：把每个标签页真的渲染一遍，输出 HTML 看长相
//
// 为什么不用真 React：插件网页半边跑在 DSH 的模块加载器里，本地没装 react。
// 用 dev/mini-react.mjs 的极小 hooks 引擎跑一遍，能抓到：
//   - 组件里的运行时错误（空数据下点 undefined、写错变量名）
//   - 排版有没有明显塌掉
//   - 切换标签页有没有炸
//
// 跑法：node dev/render-pages.mjs [输出目录]

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { React as MiniReact, createMiniReact, toHtml, findByText } from './mini-react.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = process.argv[2] || join(HERE, '..', '.snap')

const now = Date.now()
const STATE = {
  ok: true, version: '0.1.0', enabled: true, connected: true, kicked: false,
  connState: { connected: true, kicked: false, reason: '' },
  ready: true, setupDone: true, guideDone: true, accessMode: 'whitelist', admins: 1,
  vault: 'host', dataDir: 'C:\\Users\\Haha\\.dsh\\plugins-data\\wecom-bot',
}
const SERVICES = [
  { id: 'msg', name: '消息', desc: '收发消息、读群历史' },
  { id: 'mail', name: '邮件', desc: '收发邮件、上传附件' },
  { id: 'doc', name: '文档', desc: '微文档、表格' },
  { id: 'todo', name: '待办', desc: '待办清单' },
  { id: 'schedule', name: '日程', desc: '日程与空闲' },
  { id: 'meeting', name: '会议', desc: '会议与转写' },
  { id: 'disk', name: '微盘', desc: '上传下载文件' },
  { id: 'contact', name: '通讯录', desc: '搜索成员' },
]
const CONFIG = {
  enabled: true, longTasks: true, setupDone: true, guideDone: true,
  botName: '海棠', botId: 'aibXs8HvlkLQsTWGrYhTA_cw8RFC1m05nAi',
  accessMode: 'whitelist',
  admins: [{ userid: 'wofL_hCgAAJ5l8Bm66pquN28rQ76vQWg', name: '老大', role: 'owner', addedAt: now - 86400e3, quotaTokens: 0, mcp: { msg: true, mail: false, doc: true, todo: false, schedule: false, meeting: false, disk: true, contact: false } }],
  allow: { users: ['wofL_hCgAAJ5l8Bm66pquN28rQ76vQWg', 'zhangsan'], groups: ['wrABC123'] },
  autoRegister: false,
  workspaceDir: 'C:\\Users\\Haha\\WeComBot\\chats',
  merge: { enabled: true, waitSec: 2.5, maxSec: 8, groupWaitSec: 5, groupMaxSec: 15, placeholder: 'emmm...' },
  longTasks: false,
  features: { browser: true, video: true, files: true, desktop: false, imageGen: false, speakUp: false, mood: true, memory: true, mcpWrite: false, mcpSendAsMe: false, sendFileToUser: 'admin' },
  quota: { enabled: true, unit: 'million', globalDailyTokens: 50_000_000, perChatDailyTokens: 5_000_000, adminsUnlimited: true, burstPerMinute: 30 },
  model: { provider: '', model: '', reasoningEffort: 'low' },
  persona: { current: 'default' },
  mood: { halfLifeHours: 72 },
  speakUp: { enabled: false, idleMinutes: 120, minIntervalMinutes: 90, maxIntervalMinutes: 240, maxPerDay: 4, awakeFrom: 8, awakeTo: 23, nudge: true },
  imageGen: { enabled: false, provider: 'openai', baseUrl: '', model: '', size: '1024x1024', stylePrompt: '', apiKey: '', custom: { method: 'POST', url: '', bodyType: 'json', responsePath: '', params: [] } },
  history: { enabled: true, syncOnFirstMention: true, syncIntervalMin: 0, maxMessages: 30 },
  resync: { enabled: true, maxMinutes: 120 },
}
const ROUTES = {
  '/state': STATE,
  '/config': { ok: true, config: CONFIG, services: SERVICES },
  '/activity': { ok: true, rows: [
    { at: now - 60e3, kind: 'in', chatId: 'wofL_…', name: '老大', text: '在吗' },
    { at: now - 59e3, kind: 'out', chatId: 'wofL_…', name: '老大', text: '在' },
    { at: now - 3600e3, kind: 'in', chatId: 'wrABC123', name: '太子群', text: '@海棠 看下这个表格' },
  ], stats: { chats: 2, today: 3 } },
  '/quota': { ok: true, usage: { date: '2026-11-16', global: 1_234_567, chats: { 'dm:wofL_…': 800_000, 'group:wrABC123': 434_567 } } },
  '/memory': { ok: true, rows: [
    { id: 'm1', text: '老大不喜欢被叫「您」', scope: 'person', type: 'preference', about: '老大', at: now - 3600e3 },
    { id: 'm2', text: '这个群每周一开周会', scope: 'scene', type: 'fact', chatName: '太子群', at: now - 7200e3 },
  ], stats: { total: 2, person: 1, scene: 1, skill: 0, public: 0 } },
  '/personas': { ok: true, rows: [{ id: 'default', name: '默认', tags: ['温和', '简洁'] }], current: 'default' },
  '/persona': { ok: true, persona: { id: 'default', name: '默认', body: '你是{{name}}，说话简短。' } },
  '/logs': { ok: true, rows: [
    { at: now - 5e3, level: 'info', text: '长连接已就绪' },
    { at: now - 30e3, level: 'warn', text: '工具 browser_goto 挂不上：没开浏览器' },
    { at: now - 60e3, level: 'debug', text: '补了 12 条群历史（wrABC123）' },
  ] },
  '/mood': { ok: true, mood: { value: 78, label: '心情不错', history: [{ d: 6, reason: '被夸了', who: '老大', at: now - 3600e3 }] } },
  '/speakup/state': { ok: true, state: { day: '2026-11-16', count: 1, nextAt: now + 3600e3, last: now - 7200e3 }, enabled: false },
  '/imagegen': { ok: true, enabled: false, config: CONFIG.imageGen },
  '/sessions': { ok: true, rows: [{ key: 'dm:wofL_…', sessionId: 'session-abc', preset: 'wecom-owner', level: 'owner', title: '企业微信 · 老大（管理员）', createdAt: now - 86400e3 }] },
}
const fetchJson = async (p) => {
  const path = String(p).replace('/wecom-bot/api', '').split('?')[0]
  return { json: async () => ROUTES[path] || { ok: false, message: 'no route ' + path } }
}

const TABS = ['概览', '连接', '管理员', '准入', '人格', '功能', '额度', '记忆', '日志']

async function main() {
  mkdirSync(OUT, { recursive: true })

  let mini = null
  const registered = []
  globalThis.window = {
    __ModuleLoader__: { load({ id, factory }) { registered.push({ id, mod: factory((n) => (n === 'react' ? MiniReact : {})) }) } },
    addEventListener() {}, removeEventListener() {},
    location: { hash: '' },
  }
  globalThis.document = { getElementById: () => null, createElement: () => ({ set textContent(v) {}, id: '' }), head: { appendChild() {} } }
  globalThis.fetch = fetchJson
  globalThis.setInterval = () => 0
  globalThis.clearInterval = () => {}
  globalThis.setTimeout = globalThis.setTimeout
  globalThis.clearTimeout = globalThis.clearTimeout

  mini = createMiniReact()
  const code = readFileSync(join(HERE, '..', 'client', 'client.js'), 'utf8')
  new Function('window', 'document', 'fetch', 'setInterval', 'clearInterval', code)(
    globalThis.window, globalThis.document, globalThis.fetch, globalThis.setInterval, globalThis.clearInterval,
  )
  if (!registered.length) throw new Error('模块没注册')
  const Page = registered[0].mod.WeComPage
  if (typeof Page !== 'function') throw new Error('没导出 WeComPage')

  const root = mini.createRoot(Page, {})
  let tree = await root.run()
  if (!tree) throw new Error('首屏没渲染出来（可能是异步数据还没到）')

  let bad = 0
  for (const label of TABS) {
    const btn = findByText(root.getTree(), label).find((n) => n.type === 'button')
    if (!btn) {
      console.log(`  ${label.padEnd(6)} ❌ 找不到这个标签按钮`)
      bad++
      continue
    }
    try {
      tree = await root.act(() => btn.props.onClick())
    } catch (error) {
      console.log(`  ${label.padEnd(6)} ❌ 切过去炸了：${error.message}`)
      bad++
      continue
    }
    const html = toHtml(tree)
    const file = join(OUT, label + '.html')
    writeFileSync(file, wrap(label, html), 'utf8')
    const short = html.length < 2000
    if (short) bad++
    console.log(`  ${label.padEnd(6)} ${String(html.length).padStart(7)} 字符  → ${file}${short ? '  ⚠ 有点短' : ''}`)
  }

  console.log(bad ? `\n❌ ${bad} 个标签页有问题` : `\n✅ ${TABS.length} 个标签页都渲染出来了 → ${OUT}`)
  if (bad) process.exit(1)
}

function wrap(title, body) {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;background:#f4f6f8;font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#111}
.wb-root{padding:16px}.wb-wrap{max-width:900px;margin:0 auto;background:#fff;border-radius:12px;padding:18px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.wb-card{border:1px solid #e6e8eb;border-radius:10px;padding:14px;margin-bottom:12px}
.wb-card h3{margin:0 0 4px;font-size:14px}.wb-muted,.wb-dim{color:#888}.wb-small{font-size:12px}
.wb-mono{font-family:ui-monospace,Consolas,monospace}
.wb-input,.wb-select{width:100%;padding:6px 8px;border:1px solid #ddd;border-radius:6px;font:inherit}
.wb-btn{display:inline-block;padding:5px 12px;border-radius:6px;border:1px solid #ddd;margin-right:6px;background:#fff;cursor:pointer}
.wb-tag{display:inline-block;padding:1px 8px;border-radius:10px;background:#eef1f4;margin-right:6px;font-size:12px}
.wb-tab{display:inline-block;padding:6px 12px;margin-right:6px;border-radius:8px;background:#f2f4f6;border:0;cursor:pointer}
.wb-tab.on{background:#07c160;color:#fff}
.wb-item{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid #f0f2f4}
.wb-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}
.wb-between{display:flex;justify-content:space-between;align-items:center;padding:8px 0}
.wb-hero{display:flex;gap:12px;align-items:center;margin-bottom:14px}
.wb-nav{margin:12px 0}.wb-pill{display:inline-block;padding:2px 10px;border-radius:10px;background:#f2f4f6;margin-right:6px;font-size:12px}
.wb-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#bbb;margin-right:4px}
.wb-dot.ok{background:#07c160}.wb-dot.warn{background:#e8b339}.wb-dot.err{background:#d9534f}
</style></head><body>${body}</body></html>`
}

main().catch((e) => { console.error(e); process.exit(1) })
