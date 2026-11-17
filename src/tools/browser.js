// 网页操作工具：给模型一套「看得见、点得动」的手。
//
// 为什么不让模型自己写脚本：企微会话给的是 social preset（没有 shell），
// 而 TMS / ERP / 网店后台这些系统必须真点真填。所以操作全在这里做成工具，
// 模型按「读页面 → 列控件 → 点击/输入 → 再读页面确认」的顺序用。
//
// 安全边界（写死，不做成配置）：这些工具只在**管理员私聊档位**挂载（见 host.js mountTools）。
// 群里和陌生人永远拿不到这些东西。

import { defineTool, str, int } from './define.js'

/**
 * @param {object} d deps
 * @param {Function} d.getBrowser  () => browser manager
 * @param {Function} d.getConfig
 * @param {object}   d.log
 */
export function buildBrowserTools(d) {
  const { getBrowser, getConfig } = d
  const tools = []
  const cfg = () => getConfig()
  const bm = () => getBrowser()

  async function ready() {
    if (!cfg().features?.browser || cfg().features.browser === 'off') throw new Error('网页操作能力没开（管理员在面板里打开「浏览器操作」）')
    const m = bm()
    if (!m) throw new Error('浏览器没初始化')
    const r = await m.ensure()
    if (!r.ok) throw new Error(r.message || '浏览器没起来')
    return m.get()
  }

  tools.push(defineTool({
    name: 'browser_open',
    description: '打开（或接回）网页操作专用的浏览器。第一次用其它 browser_* 工具时会自动打开，这个工具用来手动确认浏览器起来了、看登录态。',
    properties: {},
    execute: async () => {
      const b = await ready()
      const st = bm().status()
      return {
        ok: true,
        browserPath: st.browserPath,
        headless: st.headless,
        cookies: st.cookies,
        sites: st.sites,
      }
    },
  }))

  tools.push(defineTool({
    name: 'browser_goto',
    description: '在专用浏览器里打开一个网址，等页面加载完。返回标题、地址、正文摘要。',
    properties: {
      url: str('完整网址，要以 http:// 或 https:// 开头'),
      wait_ms: int('最多等多久加载（毫秒），默认 15000'),
    },
    required: ['url'],
    execute: async (args) => {
      const b = await ready()
      const url = String(args.url || '').trim()
      if (!/^https?:\/\//i.test(url)) throw new Error('网址要以 http:// 或 https:// 开头')
      await b.goto(url, Math.min(Math.max(Number(args.wait_ms) || 15000, 1000), 60000))
      return { ok: true, ...(await b.readPage({ maxChars: 3000 })) }
    },
  }))

  tools.push(defineTool({
    name: 'browser_read',
    description: '读当前页面的正文（纯文本）。默认返回 6000 字，超了会标 truncated=true，可以调大 max_chars 再读一次，或用 selector 只读某一块。',
    properties: {
      selector: str('可选，CSS 选择器，只读这一块（比如 #main、.content）'),
      max_chars: int('最多返回多少字，默认 6000，最大 30000'),
    },
    execute: async (args) => {
      const b = await ready()
      return { ok: true, ...(await b.readPage({ selector: args.selector, maxChars: args.max_chars })) }
    },
  }))

  tools.push(defineTool({
    name: 'browser_controls',
    description: '列出当前页面上能点、能填的元素（按钮/链接/输入框/下拉框），带文字和 name/id/href。不知道点哪儿时先调这个。',
    properties: { limit: int('最多列多少个，默认 60，最大 300') },
    execute: async (args) => {
      const b = await ready()
      const list = await b.readControls({ limit: args.limit })
      return { ok: true, count: list.length, controls: list }
    },
  }))

  tools.push(defineTool({
    name: 'browser_click',
    description: '点页面上的元素。三种方式任选其一：按文字点（text，最常用）、按 CSS 选择器点（selector）。点完默认等 800ms 让页面反应。',
    properties: {
      text: str('按钮/链接上的文字，支持「包含」匹配'),
      selector: str('CSS 选择器，比如 #submit、button.login'),
      wait_ms: int('点完等多久（毫秒），默认 800'),
    },
    execute: async (args) => {
      const b = await ready()
      const wait = Math.min(Math.max(Number(args.wait_ms) || 800, 0), 30000)
      let how = ''
      if (args.text) {
        const hit = await b.pressText(String(args.text))
        if (!hit) return { ok: false, message: `页面上没找到文字是「${args.text}」的可点元素` }
        how = `text:${hit}`
      } else if (args.selector) {
        const ok = await b.press(String(args.selector))
        if (!ok) return { ok: false, message: `页面上没找到 ${args.selector}` }
        how = `selector:${args.selector}`
      } else {
        throw new Error('要给 text 或 selector')
      }
      if (wait) await new Promise((r) => setTimeout(r, wait))
      return { ok: true, by: how, ...(await b.readPage({ maxChars: 1500 })) }
    },
  }))

  tools.push(defineTool({
    name: 'browser_type',
    description: '往页面里填字。先按 selector 点中那个输入框，再清空、再打字（富文本编辑器也认）。不传 selector 就往当前焦点里打。',
    properties: {
      text: str('要填的内容'),
      selector: str('可选，要填的输入框的 CSS 选择器；不传就往当前焦点打'),
      enter: bool('填完是否回车，默认否'),
    },
    required: ['text'],
    execute: async (args) => {
      const b = await ready()
      let ok = true
      if (args.selector) ok = await b.typeInto(String(args.selector), String(args.text))
      else await b.type(String(args.text))
      if (!ok) return { ok: false, message: `页面上没找到 ${args.selector}` }
      if (args.enter) await b.pressEnter()
      return { ok: true }
    },
  }))

  tools.push(defineTool({
    name: 'browser_screenshot',
    description: '截当前页面一张图（PNG）。用来确认页面对不对、有没有弹出验证码/确认框。返回的图会附在会话里。',
    properties: {},
    slow: '我截个图看看。',
    execute: async () => {
      const b = await ready()
      const data = await b.screenshot()
      if (!data) throw new Error('截图失败')
      return { ok: true, dataUrl: data }
    },
  }))

  tools.push(defineTool({
    name: 'browser_wait_response',
    description: '等某个接口返回，用来确认「提交到底成功没有」。用法：先说要做的事，再点，再等。返回状态码和 JSON。',
    properties: {
      url_pattern: str('接口地址的正则片段，比如 /api/save、ShipApply/add'),
      timeout_ms: int('最多等多久（毫秒），默认 15000'),
      action_text: str('可选：等待期间要点的按钮文字（省一次工具调用）'),
    },
    required: ['url_pattern'],
    execute: async (args) => {
      const b = await ready()
      let re
      try { re = new RegExp(String(args.url_pattern)) } catch { throw new Error('url_pattern 不是合法正则') }
      const pending = b.waitResponse(re, Math.min(Math.max(Number(args.timeout_ms) || 15000, 1000), 120000))
      if (args.action_text) {
        await new Promise((r) => setTimeout(r, 150))
        await b.pressText(String(args.action_text))
      }
      const r = await pending
      if (!r) return { ok: false, message: '等超时了，没等到这个接口' }
      return { ok: true, status: r.status, url: r.url, json: r.json }
    },
  }))

  tools.push(defineTool({
    name: 'browser_site',
    description: '常用网站清单：action=list 列出管理员配好的站点；action=open 按名字打开（自动带上登录态）。',
    properties: {
      action: str('list（默认）或 open'),
      name: str('要打开的站点名字（action=open 时必填）'),
    },
    execute: async (args) => {
      const m = bm()
      const action = String(args.action || 'list')
      if (action === 'list') return { ok: true, sites: m.listSites() }
      if (action === 'open') {
        const site = m.listSites().find((s) => s.name === args.name || s.id === args.name)
        if (!site) return { ok: false, message: `没有叫「${args.name}」的站点，先 action=list 看看有哪些` }
        const b = await ready()
        await b.goto(site.url)
        return { ok: true, site: site.name, ...(await b.readPage({ maxChars: 2500 })) }
      }
      throw new Error('action 只能是 list 或 open')
    },
  }))

  return tools
}

function bool(description) {
  return { type: 'boolean', description }
}
