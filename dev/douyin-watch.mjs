// 抖音「看懂视频」移植验证：用假浏览器喂接口 JSON，验证整条读元数据链路。
// 不联网、不真开浏览器。
import assert from 'node:assert/strict'

const { findAwemeId, resolveShort, normalizeAweme, parseComments, digestOf, createDouyinWatch, videoLink } = await import('../src/video/douyin-watch.js')
const { buildDouyinTools } = await import('../src/tools/douyin.js')

let pass = 0, fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`✅ ${name}`) }
  else { fail += 1; console.log(`❌ ${name}${extra ? ' → ' + extra : ''}`) }
}

// ---- 1. findAwemeId：长链 / 短链 / 纯 id / modal_id ----
ok('长链接抠 id', findAwemeId('https://www.douyin.com/video/7712007419156516137')?.awemeId === '7712007419156516137')
ok('图文 note 抠 id', findAwemeId('https://www.douyin.com/note/7712007419156516137')?.awemeId === '7712007419156516137')
ok('modal_id 抠 id', findAwemeId('https://x.com/?modal_id=7712007419156516137')?.awemeId === '7712007419156516137')
ok('短链识别为 short', Boolean(findAwemeId('https://v.douyin.com/4_wi24th_7Y/')?.short))
ok('纯数字 id', findAwemeId('7712007419156516137')?.awemeId === '7712007419156516137')
ok('非抖音链接返回 null', findAwemeId('https://www.bilibili.com/video/BV1xx') === null)

// ---- 2. resolveShort：假 fetch 逐跳 ----
let hops = 0
const fakeFetch = async (url) => {
  hops++
  const seq = [
    { location: 'https://www.iesdouyin.com/share/video/7712007419156516137/' },
    { location: null },
  ]
  return { headers: { get: (k) => (k === 'location' ? seq[Math.min(hops - 1, seq.length - 1)].location : null) } }
}
const shortId = await resolveShort('https://v.douyin.com/xxx', fakeFetch)
ok('短链逐跳拿到 id', shortId === '7712007419156516137', `got ${shortId}`)

// ---- 3. normalizeAweme / parseComments / digestOf ----
const raw = {
  aweme_detail: {
    aweme_id: '7712007419156516137',
    item_title: '测试视频标题',
    desc: '一段文案 #话题',
    author: { nickname: '作者甲', sec_uid: 'sec1' },
    statistics: { digg_count: 123456, comment_count: 2345, share_count: 12, collect_count: 34 },
    video: { duration: 42000 },
    text_extra: [{ hashtag_name: '话题' }],
    video_tag: [{ tag_name: '美食' }],
    chapter_abstract: '这是抖音生成的内容摘要',
    chapter_list: [{ desc: '开头', detail: '介绍' }],
    music: { title: '背景乐', author: '歌手' },
    create_time: 1700000000,
  },
}
const v = normalizeAweme(raw)
ok('normalizeAweme 抠标题/作者/摘要', v && v.title === '测试视频标题' && v.author === '作者甲' && v.summary === '这是抖音生成的内容摘要')
ok('normalizeAweme 时长换算秒', v?.duration === 42, `duration=${v?.duration}`)
ok('广告视频被过滤', normalizeAweme({ aweme_detail: { aweme_id: '1', is_ads: true } }) === null)

const cs = parseComments({ comments: [
  { user: { nickname: '甲' }, text: '好看', digg_count: 100 },
  { user: { nickname: '乙' }, text: '一般', digg_count: 10 },
  { user: { nickname: '丙' }, text: '', digg_count: 999 },
] })
ok('热评按赞排序且过滤空评论', cs.length === 2 && cs[0].name === '甲' && cs[1].name === '乙')

const digest = digestOf(v, cs)
ok('摘要含标题/内容摘要/热评', /测试视频标题/.test(digest) && /内容摘要/.test(digest) && /热评/.test(digest))

// ---- 4. watch() 全链路：假浏览器 + 假 evaluate 返回接口 JSON ----
const detailJson = JSON.stringify(raw)
const commentsJson = JSON.stringify({ status_code: 0, comments: [{ user: { nickname: '甲' }, text: '好看', digg_count: 100 }] })
// 独立标签页：watch 必须开一个自己的 tab，而不是在主页面里 goto（会冲掉主人正在看的页面）
let tabOpened = 0, tabClosed = 0, mainTouched = false, tabUrl = ''
function makeTab() {
  tabOpened += 1
  return {
    evaluate: async (expr) => {
      if (expr.includes('/aweme/v1/web/aweme/detail/')) return { status: 200, text: detailJson }
      if (expr.includes('/aweme/v1/web/comment/list/')) return { status: 200, text: commentsJson }
      if (expr === 'document.readyState') return 'complete'
      return { status: 404, text: '' }
    },
    goto: async () => { mainTouched = true },
    close: async () => { tabClosed += 1 },
  }
}
const fakeB = {
  connected: () => true,
  withTab: async (url, fn) => {
    tabUrl = url
    const tab = makeTab()
    try { return await fn(tab) } finally { await tab.close() }
  },
  evaluate: async () => { mainTouched = true; return '' },
  goto: async () => { mainTouched = true },
}
const fakeBm = { ensure: async () => ({ ok: true }), get: () => fakeB }
const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
const watcher = createDouyinWatch({ getBrowser: () => fakeBm, log })
const result = await watcher.watch('https://www.douyin.com/video/7712007419156516137')
ok('watch 返回 ok + 摘要', result.ok === true && /测试视频标题/.test(result.message), JSON.stringify(result).slice(0, 200))
ok('watch 返回 id / 标题 / 链接', result.awemeId === '7712007419156516137' && result.title === '测试视频标题' && result.url === videoLink('7712007419156516137'))
ok('开自己的标签页，且指向抖音首页', tabOpened === 1 && /douyin\.com/.test(tabUrl), `opened=${tabOpened} url=${tabUrl}`)
ok('用完把标签页关了', tabClosed === 1, `closed=${tabClosed}`)
ok('全程没碰主页面', mainTouched === false)
ok('接口报错时标签页也会关掉', await (async () => {
  let closed = 0
  const bad = {
    connected: () => true,
    withTab: async (u, fn) => {
      const tab = { evaluate: async () => ({ status: 500, text: '' }), goto: async () => {}, close: async () => { closed++ } }
      try { return await fn(tab) } finally { await tab.close() }
    },
    evaluate: async () => '', goto: async () => {},
  }
  const w = createDouyinWatch({ getBrowser: () => ({ ensure: async () => ({ ok: true }), get: () => bad }), log })
  try { await w.watch('https://www.douyin.com/video/7712007419156516137') } catch {}
  return closed === 1
})())

// ---- 5. 未登录业务码 → 抛人话错误 ----
const notLoginB = {
  connected: () => true,
  withTab: async (url, fn) => {
    const tab = {
      evaluate: async () => ({ status: 200, text: JSON.stringify({ status_code: 2190008, status_msg: 'login required' }) }),
      goto: async () => {},
      close: async () => {},
    }
    try { return await fn(tab) } finally { await tab.close() }
  },
  evaluate: async () => '',
  goto: async () => {},
}
const notLoginWatcher = createDouyinWatch({ getBrowser: () => ({ ensure: async () => ({ ok: true }), get: () => notLoginB }), log })
let loginErr = ''
try { await notLoginWatcher.watch('https://www.douyin.com/video/7712007419156516137') } catch (e) { loginErr = e.message }
ok('未登录抛「没登录」人话', /没登录/.test(loginErr), loginErr)

// ---- 6. buildDouyinTools 产出 douyin_watch 工具 ----
const tools = buildDouyinTools({ douyin: watcher })
ok('工具名 douyin_watch', tools.length === 1 && tools[0].name === 'douyin_watch')
const toolResult = await tools[0].execute({ link: 'https://www.douyin.com/video/7712007419156516137' })
ok('工具 execute 走 watch 链路', toolResult.ok === true && /测试视频标题/.test(toolResult.message))
ok('工具无 douyin 依赖时返回空', buildDouyinTools({}).length === 0)

console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
