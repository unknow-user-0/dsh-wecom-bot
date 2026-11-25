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
  merge: { enabled: true, waitSec: 2.5, maxSec: 8, groupWaitSec: 5, groupMaxSec: 15, placeholderOn: true, placeholder: 'emmm...' },
  longTasks: false,
  features: { browser: 'admin', memory: true, sendFileToUser: 'admin' },
  quota: { enabled: true, unit: 'million', globalDailyTokens: 50_000_000, perChatDailyTokens: 5_000_000, adminsUnlimited: true, burstPerMinute: 30 },
  model: { provider: '', model: '', reasoningEffort: 'low' },
  persona: { current: 'default' },
  mood: { halfLifeHours: 72 },
  speakUp: { enabled: false, idleMinutes: 120, minIntervalMinutes: 90, maxIntervalMinutes: 240, maxPerDay: 4, awakeFrom: 8, awakeTo: 23, nudge: true },
  imageGen: { enabled: false, provider: 'openai', baseUrl: '', model: '', size: '1024x1024', stylePrompt: '', apiKey: '', custom: { method: 'POST', url: '', bodyType: 'json', responsePath: '', params: [] } },
  history: { enabled: true },
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
  // 占位图状态：故意给一张「动图但不用压」的，让功能页把「发出去长什么样」
  // 和「企微里要手动点开才动」这两行都渲染出来。以前没有这个桩，
  // 功能页一直走「没选图」的分支，新加的提示等于没被测试覆盖过。
  '/placeholder/state': { ok: true, image: 'C:\\\\Users\\\\Haha\\\\.dsh\\\\plugins-data\\\\wecom-bot\\\\placeholder.gif', bytes: 227_825, hasUpload: true, lastImageError: '', preview: {
    bytes: 227_825, width: 480, height: 160, animated: true, pages: 51, durationMs: 3000,
    finalBytes: 227_825, finalPages: 51, finalDurationMs: 3000, finalWidth: 480,
    finalMime: 'image/gif', dropped: false, droppedFrames: 0, fitsBudget: true, sendable: true,
    note: '动图 51 帧，3.0 秒，不用压',
  } },
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
  // 视频站登录：故意给「jar 里一条都没有」的状态 —— 这正是用户第一次点进来时的样子，
  // 也是那个死锁 bug（未登录就不渲染保存按钮）最容易复现的态。
  '/video/login': {
    ok: true,
    jarFile: 'C:\\Users\\Haha\\.dsh\\plugins-data\\wecom-bot\\video\\cookies.txt',
    jarExists: false,
    jarBytes: 0,
    jarTotal: 0,
    videoConfigFile: 'C:\\Users\\Haha\\.dsh\\video.json',
    videoConfigCookies: '',
    jarInUse: false,
    sites: [
      { id: 'douyin', name: '抖音', url: 'https://www.douyin.com/', hint: '抖音匿名基本什么都看不了，必须登录。', loggedIn: false, count: 0, keys: [], sessionOnly: 0 },
      { id: 'bili', name: 'B站', url: 'https://www.bilibili.com/', hint: 'B 站匿名能看大部分，登录后能看更高清晰度和会员内容。', loggedIn: false, count: 0, keys: [], sessionOnly: 0 },
    ],
  },
  '/video/login/probe': { ok: true, connected: false, sites: [] },
  '/asr': {
    ok: true,
    state: 'down',
    baseUrl: 'http://127.0.0.1:8080',
    model: 'whisper-1',
    language: 'zh',
    keySet: false,
    enabled: true,
    file: 'C:\\Users\\Haha\\.dsh\\asr.json',
    hostService: false,
    managed: false,
    manageStart: '',
    probe: null,
    discovery: [{ dir: 'G:\\蓝色大肥鱼\\asr', script: 'G:\\蓝色大肥鱼\\asr\\启动-ASR.bat', suggestBaseUrl: 'http://127.0.0.1:8080', label: '启动-ASR.bat' }],
    message: '配了地址但连不上，服务没启动',
  },
  '/asr/hint': { ok: true, options: [
    { id: 'whisper', name: 'whisper.cpp（全离线，推荐）', detail: '模型放本地，语音不出这台机器。模型路径不能含中文。' },
    { id: 'siliconflow', name: '云端 SiliconFlow', detail: '要 API Key，语音会发给第三方。' },
    { id: 'host', name: '宿主自带', detail: '装了语音服务的话插件直接用。' },
  ] },
}
const fetchJson = async (p) => {
  const path = String(p).replace('/wecom-bot/api', '').split('?')[0]
  return { json: async () => ROUTES[path] || { ok: false, message: 'no route ' + path } }
}

const TABS = ['连接', '用户', '自我', '功能', '日志']

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
    writeFileSync(join(OUT, label + '.html'), wrap(label, html), 'utf8')
    const short = html.length < 2000
    if (short) bad++
    console.log(`  ${label.padEnd(6)} ${String(html.length).padStart(7)} 字符  → ${join(OUT, label + ".html")}${short ? '  ⚠ 有点短' : ''}`)
  }

  // 合并版块最容易出的错是「漏了一个旧页」：页面照样渲染、字数也够，
  // 只是那几组设置消失了，用户找不到还以为被删了。按区块标题点名核对。
  {
    const need = {
      '连接': ['跑起来了吗', '机器人凭据', '会话映射', '按 token 算', '最近动静'],
      '用户': ['管理员列表', '主人私聊长任务档位', '准入模式'],
      '自我': ['选人格', '新建一份', '记忆库', '企微里 @ 它用的名字（门牌）'],
    }
    for (const [label, keys] of Object.entries(need)) {
      const f = readFileSync(join(OUT, label + '.html'), 'utf8')
      const miss = keys.filter((k) => !f.includes(k))
      if (miss.length) { console.log('  ❌ 「' + label + '」少了：' + miss.join('、')); bad++ }
      else console.log('  ✅ 「' + label + '」里 ' + keys.length + ' 个区块都在')
    }
    // 「最近动静」是只读回看，不是配置项，必须压在最后 ——
    // 放中间的话，想改 bot_id 得先划过 30 条聊天记录。
    {
      const f = readFileSync(join(OUT, '连接.html'), 'utf8')
      const order = [...f.matchAll(/<h3 >([^<]*)</g)].map((m) => m[1]).filter((t) => !t.startsWith('今天用了多少') && !t.startsWith('最近动静'))
      const last = [...f.matchAll(/<h3 >([^<]*)</g)].map((m) => m[1]).pop()
      if (last !== '最近动静') { console.log('  ❌ 「最近动静」不在最后，当前最后一张是：' + last); bad++ }
      else console.log('  ✅ 「最近动静」压在最后（前面 ' + order.length + ' 张配置卡）')
    }

    // 嵌套 wb-page 会让 gap 叠加，版块之间空一大块
    const c = readFileSync(join(OUT, '连接.html'), 'utf8')
    if (c.includes('wb-page\"><div class=\"wb-page\"')) { console.log('  ❌ 套了两层 wb-page'); bad++ }
  }

  // 反过来的情况也要守：静态图本来就不动，要是也弹「要点开才播」，
  // 配图的人会以为哪里出了毛病。把桩换成静态图重渲染一遍，确认提示消失。
  {
    ROUTES['/placeholder/state'].preview.animated = false
    ROUTES['/placeholder/state'].preview.pages = 1
    const root2 = mini.createRoot(Page, {})
    await root2.run()
    const btn2 = findByText(root2.getTree(), '功能').find((n) => n.type === 'button')
    if (btn2) {
      const t2 = await root2.act(() => btn2.props.onClick())
      const h2 = toHtml(t2)
      if (h2.includes('默认不会播放')) { console.log('  ❌ 静态图不该提示「默认不会播放」'); bad++ }
      else console.log('  ✅ 静态图不会误报「默认不会播放」')
    }
  }

  // 文案断言：有些提示删掉了页面照样渲染，只有断言拦得住。
  // 这条守的是「配了动图的人必须知道企微里要手动点开才动」——
  // 他精心挑了张表情包，对面看到的却是静止画，还得怪我们压坏了。
  {
    const f = readFileSync(join(OUT, '功能.html'), 'utf8')
    const must = [
      ['默认不会播放', '动图在手机企微里默认不播的提示'],
      ['动图 51 帧', '选完图「真发出去长什么样」的预告'],
    ]
    for (const [needle, what] of must) {
      if (!f.includes(needle)) { console.log(`  ❌ 功能页缺了：${what}（找不到「${needle}」）`); bad++ }
      else console.log(`  ✅ 功能页有：${what}`)
    }
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
