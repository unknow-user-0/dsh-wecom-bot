// 抖音下载路径（文件版）：从 detail 接口的 play_addr 拿地址 → 下载到本地 mp4。
// 不联网、不真开浏览器：用假浏览器喂接口 JSON，用假 fetch 喂下载流。
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { isDouyinUrl, douyinId, pickPlayUrl, createDouyinResolver } = await import('../src/video/douyin.js')

let pass = 0, fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`✅ ${name}`) }
  else { fail += 1; console.log(`❌ ${name}${extra ? ' → ' + extra : ''}`) }
}
const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }

// ---- 1. 链接识别 ----
ok('长链接认成抖音', isDouyinUrl('https://www.douyin.com/video/7712007419156516137'))
ok('短链认成抖音', isDouyinUrl('https://v.douyin.com/kPd4zODADZ4/'))
ok('分享页认成抖音', isDouyinUrl('https://www.iesdouyin.com/share/video/7712007419156516137/'))
ok('B 站链接不算抖音', isDouyinUrl('https://www.bilibili.com/video/BV1xx') === false)
ok('不是链接的不算', isDouyinUrl('7712007419156516137') === false)
ok('从长链接抠 id', douyinId('https://www.douyin.com/video/7712007419156516137') === '7712007419156516137')
ok('从分享页抠 id', douyinId('https://www.iesdouyin.com/share/video/7712007419156516137/?x=1') === '7712007419156516137')
ok('短链抠不到 id（要跳转）', douyinId('https://v.douyin.com/kPd4zODADZ4/') === '')

// ---- 2. pickPlayUrl：从接口返回里挑地址 ----
const goodJson = {
  aweme_detail: {
    video: {
      duration: 121511,
      play_addr: {
        data_size: 13586391,
        url_list: [
          'https://v11-weba.douyinvod.com/aaa/video/tos/cn/1/?a=6383',
          'https://v26-web.douyinvod.com/bbb/video/tos/cn/1/?a=6383',
          'data:image/png;base64,iVBORw0KGgo=',
        ],
      },
    },
  },
}
const picked = pickPlayUrl(goodJson)
ok('挑出可下载地址', picked.ok === true && picked.urls.length === 2, JSON.stringify(picked).slice(0, 200))
ok('过滤掉 data: 占位', picked.urls.every((u) => /^https:\/\//.test(u)))
ok('带出体积和时长', picked.size === 13586391 && picked.durationMs === 121511)

ok('图文没有播放地址', pickPlayUrl({ aweme_detail: { images: [{ url_list: ['https://x/1.jpg'] }] } }).ok === false)
ok('图文说明是图文', /图文/.test(pickPlayUrl({ aweme_detail: { images: [{}] } }).reason))
ok('视频被删（没有 video）', pickPlayUrl({ aweme_detail: { aweme_id: '1' } }).ok === false)
ok('接口空返回', pickPlayUrl(null).ok === false)
ok('url_list 全是脏数据也不崩', pickPlayUrl({ aweme_detail: { video: { play_addr: { url_list: ['', 'data:xx'] } } } }).ok === false)
ok('play_addr 缺失时退 play_addr_h264', (() => {
  const r = pickPlayUrl({ aweme_detail: { video: { play_addr_h264: { url_list: ['https://v/1.mp4'] } } } })
  return r.ok && r.urls[0] === 'https://v/1.mp4'
})())
ok('优先 play_addr 而不是 download_addr（带水印版）', (() => {
  const r = pickPlayUrl({ aweme_detail: { video: {
    download_addr: { url_list: ['https://v/watermark.mp4'] },
    play_addr: { url_list: ['https://v/clean.mp4'] },
  } } })
  return r.ok && r.urls[0] === 'https://v/clean.mp4'
})())

// ---- 3. 假浏览器 / 假 fetch ----
const DETAIL = JSON.stringify(goodJson)
function fakeBrowser({ detailStatus = 200, detailText = DETAIL } = {}) {
  const state = { opened: 0, closed: 0, mainTouched: false }
  const b = {
    connected: () => true,
    withTab: async (url, fn) => {
      state.opened += 1
      const tab = {
        evaluate: async (expr) => (expr.includes('/aweme/v1/web/aweme/detail/')
          ? { status: detailStatus, text: detailText }
          : { status: 404, text: '' }),
        goto: async () => { state.mainTouched = true },
        close: async () => { state.closed += 1 },
      }
      try { return await fn(tab) } finally { await tab.close() }
    },
    evaluate: async () => { state.mainTouched = true; return '' },
    goto: async () => { state.mainTouched = true },
  }
  return { bm: { ensure: async () => ({ ok: true }), get: () => b }, state }
}

// 假 fetch：记录被请求的地址，前 N 个失败，其余返回一段够大的 body
function fakeFetch({ failFirst = 0, size = 20480 } = {}) {
  const seen = []
  const impl = async (url) => {
    seen.push(url)
    if (seen.length <= failFirst) throw new Error('模拟网络断开')
    return {
      ok: true,
      status: 200,
      body: ReadableStreamFrom(Buffer.alloc(size, 7)),
    }
  }
  return { impl, seen }
}
// 把 Buffer 包成 fetch 的 ReadableStream（Node 22 有 Stream.toWeb 更省事，这里手写免依赖）
function ReadableStreamFrom(buf) {
  return new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(buf)); c.close() },
  })
}

const dataDir = mkdtempSync(join(tmpdir(), 'dy-dl-'))
const realFetch = globalThis.fetch

// ---- 4. resolve：下载成功、落到缓存、二次命中缓存 ----
{
  const { bm, state } = fakeBrowser()
  const f = fakeFetch()
  globalThis.fetch = f.impl
  const dy = createDouyinResolver({ getBrowser: () => bm, dataDir, log })
  const p = await dy.resolve('https://www.douyin.com/video/7712007419156516137')
  ok('下载到本地 mp4', existsSync(p) && p.endsWith('7712007419156516137.mp4'), p)
  ok('下载的文件够大（不是风控页）', statSync(p).size === 20480, String(statSync(p).size))
  ok('带 referer 去要 CDN', f.seen.length === 1 && f.seen[0].includes('douyinvod.com'))
  ok('开了一个独立标签页并关掉', state.opened === 1 && state.closed === 1)
  ok('没碰主页面', state.mainTouched === false)

  const before = f.seen.length
  const p2 = await dy.resolve('https://www.douyin.com/video/7712007419156516137')
  ok('第二次命中缓存，不再下载', p2 === p && f.seen.length === before)
  ok('命中缓存也不再开标签页', state.opened === 1)
  globalThis.fetch = realFetch
}

// ---- 5. 第一条地址坏了，自动换下一条 ----
{
  const { bm } = fakeBrowser()
  const f = fakeFetch({ failFirst: 1 })
  globalThis.fetch = f.impl
  const dy = createDouyinResolver({ getBrowser: () => bm, dataDir: mkdtempSync(join(tmpdir(), 'dy-dl-')), log })
  const p = await dy.resolve('https://www.douyin.com/video/7712007419156516137')
  ok('第一条失败后换下一条成功', existsSync(p) && f.seen.length === 2, `seen=${f.seen.length}`)
  globalThis.fetch = realFetch
}

// ---- 6. 全部地址都失败 → 抛人话错误，不留 .part ----
{
  const { bm } = fakeBrowser()
  const dir = mkdtempSync(join(tmpdir(), 'dy-dl-'))
  globalThis.fetch = async () => { throw new Error('模拟断网') }
  const dy = createDouyinResolver({ getBrowser: () => bm, dataDir: dir, log })
  let err = ''
  try { await dy.resolve('https://www.douyin.com/video/7712007419156516137') } catch (e) { err = e.message }
  ok('全失败时抛「下载失败」', /下载失败/.test(err), err)
  ok('失败后不留 .part 垃圾', !existsSync(join(dir, 'video', 'douyin', '7712007419156516137.mp4.part')))
  globalThis.fetch = realFetch
}

// ---- 7. 下回来太小（风控页）→ 报错，不落成 mp4 ----
{
  const { bm } = fakeBrowser()
  const dir = mkdtempSync(join(tmpdir(), 'dy-dl-'))
  globalThis.fetch = async () => ({ ok: true, status: 200, body: ReadableStreamFrom(Buffer.alloc(500, 1)) })
  const dy = createDouyinResolver({ getBrowser: () => bm, dataDir: dir, log })
  let err = ''
  try { await dy.resolve('https://www.douyin.com/video/7712007419156516137') } catch (e) { err = e.message }
  ok('小文件被认作风控页', /风控|太小|字节/.test(err), err)
  ok('风控页不会污染缓存', !existsSync(join(dir, 'video', 'douyin', '7712007419156516137.mp4')))
  globalThis.fetch = realFetch
}

// ---- 8. 接口报错 / 图文 / 非抖音链接 ----
{
  const { bm } = fakeBrowser({ detailStatus: 500, detailText: '' })
  const dy = createDouyinResolver({ getBrowser: () => bm, dataDir: mkdtempSync(join(tmpdir(), 'dy-dl-')), log })
  let err = ''
  try { await dy.resolve('https://www.douyin.com/video/7712007419156516137') } catch (e) { err = e.message }
  ok('接口 500 时报人话', /抖音接口返回 500/.test(err), err)

  const { bm: bm2 } = fakeBrowser({ detailText: JSON.stringify({ aweme_detail: { images: [{}] } }) })
  const dy2 = createDouyinResolver({ getBrowser: () => bm2, dataDir: mkdtempSync(join(tmpdir(), 'dy-dl-')), log })
  let err2 = ''
  try { await dy2.resolve('https://www.douyin.com/video/7712007419156516137') } catch (e) { err2 = e.message }
  ok('图文说清楚是图文', /图文/.test(err2), err2)

  const dy3 = createDouyinResolver({ getBrowser: () => bm2, dataDir: dataDir, log })
  const passThrough = 'https://www.bilibili.com/video/BV1xx'
  ok('非抖音链接原样返回', (await dy3.resolve(passThrough)) === passThrough)
}

console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
