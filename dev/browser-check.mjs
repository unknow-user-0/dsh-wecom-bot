// 浏览器能力自检：起 Edge（屏幕外窗口）→ 打开一个页面 → 读标题和正文 → 关掉
// 跑法：node dev/browser-check.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowser, findBrowser } from '../src/browser/cdp.js'

const profileDir = mkdtempSync(join(tmpdir(), 'wecom-browser-'))
console.log('① 浏览器：', findBrowser() || '没找到')
const b = createBrowser({
  profileDir,
  log: (lv, t) => console.log('   [' + lv + ']', t),
})
try {
  console.log('② 启动…')
  const wsUrl = await b.open()
  console.log('③ CDP：', wsUrl)
  console.log('④ 打开页面…')
  await b.goto('https://example.com/', 8000)
  const page = await b.readPage({ maxChars: 300 })
  console.log('⑤ 标题：', page.title)
  console.log('   地址：', page.url)
  console.log('   正文：', page.text.replace(/\s+/g, ' ').slice(0, 160))
  const ctl = await b.readControls({ limit: 5 })
  console.log('⑥ 可见控件：', ctl.map((c) => c.tag + ':' + (c.text || c.name || c.type || '')).slice(0, 5).join(' | '))
  console.log('\n✅ 浏览器能力可用')
} catch (e) {
  console.log('\n❌ 失败：', e.message)
} finally {
  try { await b.stopOwn() } catch {}
  process.exit(0)
}
