// 抖音「看懂视频」：在浏览器页面里调抖音网页自己的接口读元数据，交给模型总结。
//
// 为什么走这条路（而不是下载 mp4）：
//   yt-dlp 的 Douyin 提取器整体失效（web detail 接口上了 Argus 签名墙，403）；
//   从 <video src> 抠 CDN 直链下载 mp4 又强依赖登录态 + 非无头，很脆弱。
//   抖音网页自己调接口时，签名由页面脚本自动加、登录态随 cookie 带上 —— 我们只要在
//   页面里 fetch 同样的地址，就能拿到标题、内容摘要、文案、热评，模型读这些就能总结视频。
//   这条路不下载任何视频文件。
//
// 接口只拼固定参数（没有动态签名），浏览器打开过 www.douyin.com 拿到游客 cookie 即可；
// 若用户点了面板的「视频站登录」并保存，专用浏览器的登录态会一并带上，成功率更高。
//
// 这段代码移植自本机 dsh-aurabot-qq/src/douyin/site.js（已在真机稳定运行）。
// 差别：wecombot 的 b.evaluate 用 returnByValue，直接返回对象，不用再 JSON.parse 字符串。

import { setTimeout as sleep } from 'node:timers/promises'

const HOME = 'https://www.douyin.com/'
export const videoLink = (id) => `https://www.douyin.com/video/${id}`

// 网页端接口的公共参数（和网页自己发的一样）
const BASE = {
  device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web',
  pc_client_type: '1', version_code: '290100', version_name: '29.1.0',
  cookie_enabled: 'true', platform: 'PC', downlink: '10',
}
// 这些业务码说明没登录
const NOT_LOGIN = new Set([8, 2190008])

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const clean = (t, max = 300) => [...String(t ?? '').replace(/\s+/g, ' ').trim()].slice(0, max).join('')
const wan = (n) => (n >= 10000 ? (n / 10000).toFixed(n >= 100000 ? 0 : 1) + '万' : String(n))

/** 从一段文字里认视频：完整链接 / modal_id / 图文 note / v.douyin.com 短链 / 纯数字 id */
export function findAwemeId(text) {
  const s = String(text || '')
  const m = s.match(/douyin\.com\/(?:video|note)\/(\d{15,})/)
    || s.match(/[?&]modal_id=(\d{15,})/)
    || s.match(/iesdouyin\.com\/share\/(?:video|note)\/(\d{15,})/)
  if (m) return { awemeId: m[1] }
  const short = s.match(/https?:\/\/v\.douyin\.com\/[A-Za-z0-9_-]+\/?/)
  if (short) return { short: short[0] }
  if (/^\d{15,}$/.test(s.trim())) return { awemeId: s.trim() }
  return null
}

/** 短链跳一下，拿到真实视频 id。 */
export async function resolveShort(url, fetchImpl = fetch) {
  let cur = url
  for (let i = 0; i < 4; i++) {
    const r = await fetchImpl(cur, {
      redirect: 'manual',
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' },
      signal: AbortSignal.timeout(10000),
    })
    const loc = r.headers.get('location')
    if (!loc) break
    cur = new URL(loc, cur).toString()
    const id = findAwemeId(cur)
    if (id?.awemeId) return id.awemeId
  }
  return ''
}

/** 接口里的一条视频整理成给模型看的样子；广告 / 直播 / 没 id 的返回 null。 */
export function normalizeAweme(raw) {
  const a = raw?.aweme_info || raw?.aweme_detail || raw
  if (!a || typeof a !== 'object') return null
  const id = String(a.aweme_id || '')
  if (!id || a.is_ads || a.cell_room || a.is_live || a.live_reason) return null
  const st = a.statistics || {}
  const au = a.author || {}
  const desc = clean(a.desc, 300)
  return {
    awemeId: id,
    title: clean(a.item_title, 80) || desc.replace(/#\S+/g, '').trim().slice(0, 80),
    desc,
    author: clean(au.nickname, 40),
    authorSecUid: String(au.sec_uid || ''),
    likes: num(st.digg_count),
    comments: num(st.comment_count),
    shares: num(st.share_count),
    collects: num(st.collect_count),
    duration: Math.round(num(a.video?.duration || a.duration) / 1000),
    tags: (a.text_extra || []).map((t) => t?.hashtag_name).filter(Boolean).slice(0, 8),
    category: (a.video_tag || []).map((t) => t?.tag_name).filter(Boolean),
    summary: clean(a.chapter_abstract, 600), // 抖音自己生成的内容摘要，长一点的视频常有
    chapters: (a.chapter_list || []).map((c) => clean([c.desc, c.detail].filter(Boolean).join('：'), 120)).filter(Boolean).slice(0, 8),
    music: a.music?.title ? clean(`${a.music.title}${a.music.author ? ' - ' + a.music.author : ''}`, 60) : '',
    isImages: Array.isArray(a.images) && a.images.length > 0,
    createdAt: num(a.create_time) * 1000,
  }
}

/** 评论接口 → 按赞数排的热评 [{name, text, likes}]。 */
export function parseComments(json, max = 8) {
  return (json?.comments || [])
    .map((c) => ({ name: clean(c.user?.nickname, 20), text: clean(c.text, 120), likes: num(c.digg_count) }))
    .filter((c) => c.text)
    .sort((a, b) => b.likes - a.likes)
    .slice(0, max)
}

/** 一个视频交给模型看的样子：标题、作者、数据、分类、摘要 / 章节、文案、音乐、热评。 */
export function digestOf(v, comments = []) {
  return [
    `《${v.title || '（无标题）'}》 作者：${v.author || '?'}  赞 ${wan(v.likes)}  评论 ${wan(v.comments)}${v.duration ? '  ' + v.duration + ' 秒' : ''}${v.isImages ? '  图文' : ''}`,
    v.category.length ? `分类：${v.category.join(' / ')}` : '',
    v.summary ? `内容摘要：${v.summary}` : '',
    v.chapters.length ? '分段：\n' + v.chapters.map((c) => '  - ' + c).join('\n') : '',
    v.desc && v.desc !== v.title ? `文案：${v.desc}` : '',
    v.music ? `配乐：${v.music}` : '',
    comments.length ? '热评：\n' + comments.map((c) => `  ${c.name}：${c.text}（${wan(c.likes)} 赞）`).join('\n') : '',
  ].filter(Boolean).join('\n')
}

/**
 * @param {object} o
 * @param {Function} o.getBrowser () => 浏览器管理器（manager.js 那个）
 * @param {object}   o.log
 */
/**
 * 抖音网页接口的调用器：负责「连上专用浏览器 → 开独立标签页 → 在页面里 fetch」。
 *
 * 抽成独立工厂是因为下载路径（src/video/douyin.js）要拿同一个接口里的播放地址，
 * 两处各抄一份必然走岔（签名参数、403 重试、没登录判定，抄漏一个就出玄学 bug）。
 *
 * @param {object} o
 * @param {Function} o.getBrowser () => 浏览器管理器（manager.js 那个）
 * @param {object}   o.log
 */
export function createDouyinApi({ getBrowser, log }) {
  /** 连上专用浏览器（不碰它当前的页面）。返回 browser 实例。 */
  async function ensure() {
    const bm = getBrowser?.()
    if (!bm) throw new Error('浏览器模块没初始化')
    // force：看视频不该被「浏览器操作」开关挡住。开关管的是「模型能不能在页面上
    // 随意导航/点击」，而这里只是借浏览器的同源 + 登录态读一个公开接口。
    const ready = await bm.ensure({ force: true })
    if (!ready?.ok) throw new Error(`打不开浏览器：${ready?.message || '未知原因'}`)
    const b = bm.get()
    if (!b?.connected?.()) throw new Error('浏览器没连上')
    if (typeof b.withTab !== 'function') throw new Error('浏览器控件太旧，升级一下插件')
    return b
  }

  /**
   * 在页面里调网页端 GET 接口。没登录 / 业务出错会抛带 code 的错。
   *
   * 抖音的 403 多半是「风控 cookie 还没种好」——刚打开的标签页要跑一会儿 JS 才会
   * 拿到 s_v_web_id 之类的东西，这时候请求会被打回来。这种是等几百毫秒就好的临时
   * 状态，重试比在调用处瞎睡一觉更准（不用睡的地方就不睡，该等的时候一定等够）。
   */
  async function api(tab, path, params = {}) {
    const u = new URL(path, HOME)
    for (const [k, v] of Object.entries({ ...BASE, ...params })) u.searchParams.set(k, String(v))
    const expression = `fetch(${JSON.stringify(u.toString())}, { credentials: 'include' }).then(async (r) => ({ status: r.status, text: await r.text() }))`
    let r
    for (let i = 0; i < 4; i += 1) {
      r = await tab.evaluate(expression, 30000)
      if (r && r.status !== 403) break
      if (i < 3) await sleep(500)
    }
    if (!r || r.status !== 200) throw Object.assign(new Error(`抖音接口返回 ${r?.status || '空'}`), { code: r?.status })
    if (!r.text) throw Object.assign(new Error('抖音接口返回空内容（可能被风控或没登录）'), { code: 'empty' })
    let json
    try { json = JSON.parse(r.text) } catch { throw Object.assign(new Error('抖音接口返回的不是 JSON'), { code: 'bad' }) }
    const code = Number(json.status_code || 0)
    if (NOT_LOGIN.has(code)) throw Object.assign(new Error('抖音还没登录（面板里点「视频站登录」登录一次）'), { code: 'login' })
    if (code) throw Object.assign(new Error(json.status_msg || `抖音接口出错（${code}）`), { code })
    return json
  }

  async function detail(tab, id) {
    const v = normalizeAweme((await api(tab, '/aweme/v1/web/aweme/detail/', { aweme_id: id })).aweme_detail)
    if (!v) throw new Error('这个视频打不开（删了、私密或者是直播）')
    return v
  }

  async function comments(tab, id) {
    return parseComments(await api(tab, '/aweme/v1/web/comment/list/', { aweme_id: id, cursor: 0, count: 20, item_type: 0 }))
  }

  /** 详情接口的原始返回（下载路径要拿 play_addr，不走 normalizeAweme）。 */
  async function detailRaw(tab, id) {
    return api(tab, '/aweme/v1/web/aweme/detail/', { aweme_id: id })
  }

  /**
   * 开一个独立标签页干活，干完关掉。
   *
   * 独立是硬要求：主人可能正用着这个浏览器，别的工具也可能同时在跑。
   * 登录态在同一个资料目录里，所以新标签页天然是登录着的。
   */
  async function withTab(fn, opts = { ms: 30000 }) {
    const b = await ensure()
    return b.withTab(HOME, fn, opts)
  }

  return { ensure, api, detail, comments, detailRaw, withTab }
}

/**
 * @param {object} o
 * @param {Function} o.getBrowser () => 浏览器管理器（manager.js 那个）
 * @param {object}   o.log
 */
export function createDouyinWatch({ getBrowser, log }) {
  const dy = createDouyinApi({ getBrowser, log })

  /**
   * 打开一个抖音链接看看：读标题、分类、内容摘要和热评，返回给模型去总结。
   * 完整链接 / v.douyin.com 短链 / 纯视频 id 都认。
   */
  async function watch(link) {
    const raw = String(link || '').trim()
    const found = findAwemeId(raw)
    if (!found) throw new Error('这看起来不是抖音链接（完整链接、v.douyin.com 短链、或直接一串视频号都行）')
    let id = found.awemeId
    if (!id && found.short) {
      id = await resolveShort(found.short)
      if (!id) throw new Error('短链没跳到视频页，可能已删除或失效')
    }
    log?.info?.(`抖音：读视频信息 ${id}`)
    return dy.withTab(async (tab) => {
      const [v, cs] = await Promise.all([
        dy.detail(tab, id),
        dy.comments(tab, id).catch(() => []), // 热评是锦上添花，读不到不算失败
      ])
      return {
        ok: true,
        message: digestOf(v, cs),
        awemeId: id,
        title: v.title,
        url: videoLink(id),
      }
    })
  }

  return { watch }
}
