// 抖音：yt-dlp 这条路已经废了，用插件自己的浏览器绕过去。
//
// 为什么必须绕：
//   yt-dlp 的 Douyin 提取器先打 `https://www.douyin.com/aweme/v1/web/aweme/detail/`，
//   这个接口现在上了 Argus 签名墙，缺 Uifid（浏览器 JS 算出来的设备指纹）就直接
//   `403 Blocked by ArgusSecurityPlugin Uifid Not Found`。cookie 再全、加
//   `--impersonate chrome`、换真链接，结果都一样 —— 是提取器整体失效，不是配置问题。
//   实测：2026-11 用 yt-dlp 2026.10.26 打真抖音链接，三条路径全 403。
//
// 怎么绕（2026-11 改过一次，现在的做法）：
//   早先是从页面里抠 `<video src>`。抖音改 MSE 之后这招废了 —— 播放器里挂的是
//   `blob:https://www.douyin.com/...`，永远等不到 http 地址，25 秒后报
//   「找到 N 个 video，但都拿不到 http 地址」，看着像风控，其实是过时。
//   现在的做法是：在页面里（借它的登录态和同源）调 detail 接口，直接读
//   `aweme_detail.video.play_addr.url_list` —— 那儿就是**已签名的完整 mp4 地址**。
//   实测：121 秒的视频拿到 3 条候选、13.6 MB、ffmpeg 认出
//   `Audio: aac 44100 Hz stereo` + `Video: h264 1920x1080 30fps` —— **音轨齐全**，
//   不会出现「下下来没声音、ASR 全空」那种坑。
//
// 两个关键细节：
//   1. CDN 校验 referer，必须带 `https://www.douyin.com/`，否则 403。
//   2. 直链有效期只有 1-2 小时，所以下载完立刻落盘成 mp4，别再转发这个 URL。
//
// 上游 storyboard 工具本来就支持传本地路径，所以这里只要把抖音链接换成「本地文件路径」，
// 上游一行都不用改。缓存按 aweme id 存，一次下载喂给 storyboard/zoom/locate 三个工具。
//
// 页面接口的调用（连浏览器、开独立标签页、403 重试、没登录判定）在 douyin-watch.js 里，
// 这里直接复用，不抄第二份 —— 抄一份就必然走岔，漏改一个参数就是玄学 bug。

import { existsSync, mkdirSync, statSync, createWriteStream } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createDouyinApi, findAwemeId, resolveShort, videoLink } from './douyin-watch.js'

const DOUYIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 长链接 `/video/<数字>` 和短链 `v.douyin.com/xxx` 都算 */
export function isDouyinUrl(input) {
  const raw = String(input || '').trim()
  if (!/^https?:\/\//i.test(raw)) return false
  try {
    const u = new URL(raw)
    const host = u.hostname.toLowerCase()
    if (!/(^|\.)douyin\.com$/.test(host) && !/(^|\.)iesdouyin\.com$/.test(host)) return false
    return /\/video\/\d+/.test(u.pathname) || /^v\.douyin\.com$/i.test(host) || /\/share\/video\/\d+/.test(u.pathname)
  } catch {
    return false
  }
}

/** 从 URL 里抠 aweme id，用来做缓存键；抠不到返回 '' */
export function douyinId(input) {
  const raw = String(input || '').trim()
  const m = raw.match(/\/video\/(\d{10,})/) || raw.match(/\/share\/video\/(\d{10,})/)
  return m ? m[1] : ''
}

/**
 * 从 detail 接口的返回里挑出播放地址。
 *
 * 挑法有几条硬规矩，都是实测出来的：
 *   - 只认 `http(s)`：抖音有时会在 url_list 里塞 `data:` 占位，下下来是 0 字节。
 *   - `play_addr` 优先：它是「原始码流」，音轨在里面。别用 `download_addr`
 *     （那是带水印的转码版），也别用 `bit_rate[]`（同一份视频按码率分档，
 *     挑错会下到糊的或者更大的）。
 *   - 图文（images）没有 play_addr，直接算失败 —— 那不是视频，下载路径帮不上。
 *   - 列表可能有多条（不同 CDN），调用方按顺序试，一条失败换下一条。
 *
 * 返回 `{ urls, size, durationMs, ok }`；拿不到就 `ok: false`，由调用方报人话错误。
 */
export function pickPlayUrl(json) {
  const detail = json?.aweme_detail || json?.aweme_info || null
  if (!detail) return { ok: false, urls: [], size: 0, durationMs: 0, reason: '接口没返回视频信息' }
  if (Array.isArray(detail.images) && detail.images.length) {
    return { ok: false, urls: [], size: 0, durationMs: 0, reason: '这是图文，不是视频' }
  }
  const video = detail.video || {}
  const addr = video.play_addr || video.play_addr_h264 || video.play_addr_265 || null
  const urls = (addr?.url_list || [])
    .map((u) => String(u || '').trim())
    .filter((u) => /^https?:\/\//i.test(u))
  return {
    ok: urls.length > 0,
    urls,
    size: Number(addr?.data_size) || 0,
    durationMs: Number(video.duration) || 0,
    reason: urls.length ? '' : '接口里没有可用的播放地址（可能需要登录）',
  }
}

/**
 * @param {object} o
 * @param {Function} o.getBrowser () => 浏览器管理器（manager.js 那个）
 * @param {Function} o.dataDir  插件数据目录
 * @param {object}   o.log
 */
export function createDouyinResolver({ getBrowser, dataDir, log }) {
  const dy = createDouyinApi({ getBrowser, log })
  const cacheDir = () => join(dataDir, 'video', 'douyin')

  function cachedPath(id) {
    if (!id) return ''
    const p = join(cacheDir(), `${id}.mp4`)
    try {
      if (existsSync(p) && statSync(p).size > 1024) return p
    } catch {}
    return ''
  }

  /**
   * 在页面里调一次 detail 接口，拿到播放地址。
   *
   * 为什么开独立标签页：主人可能正开着浏览器在用，别的工具也可能同时在跑。
   * 登录态在同一个资料目录里，新标签页天然是登录着的。
   */
  async function extractUrl(id) {
    log?.info?.(`抖音：读播放地址 ${id}`)
    const got = await dy.withTab(async (tab) => pickPlayUrl(await dy.detailRaw(tab, id)), { ms: 45000 })
    if (!got?.ok) throw new Error(got?.reason || '没能从接口里拿到播放地址')
    return got.urls
  }

  /** 带 referer 下载到本地，返回路径。按候选地址依次试，全失败才报错。 */
  async function download(urls, id) {
    mkdirSync(cacheDir(), { recursive: true })
    const out = join(cacheDir(), `${id || Date.now().toString(36)}.mp4`)
    const tmp = out + '.part'
    let lastError = new Error('没有可用的下载地址')
    for (const [i, srcUrl] of urls.entries()) {
      try {
        const res = await fetch(srcUrl, {
          headers: { 'user-agent': DOUYIN_UA, referer: 'https://www.douyin.com/', accept: '*/*' },
          redirect: 'follow',
          signal: AbortSignal.timeout(180000),
        })
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
        await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp))
        const st = statSync(tmp)
        // 抖音风控页也是 200，只是内容是个几百字节的 HTML/JSON
        if (st.size < 10240) throw new Error(`下回来只有 ${st.size} 字节，多半是风控页`)
        await rename(tmp, out)
        log?.info?.(`抖音：已下载 ${(st.size / 1048576).toFixed(2)}MB → ${out}`)
        return out
      } catch (error) {
        lastError = error
        await rm(tmp, { force: true }).catch(() => {})
        if (i < urls.length - 1) log?.warn?.(`抖音：第 ${i + 1} 条地址没下成（${error.message}），换下一条`)
      }
    }
    throw new Error(`下载失败：${lastError.message}`)
  }

  /**
   * 把抖音链接换成「本地 mp4 路径」。不是抖音链接就原样返回。
   * 失败时抛人话错误，由上游工具原样报给模型。
   */
  async function resolve(input) {
    const raw = String(input || '').trim()
    if (!isDouyinUrl(raw)) return input
    // 短链和长链统一走同一套识别，少一份正则就少一处走岔
    const found = findAwemeId(raw)
    let id = found?.awemeId || douyinId(raw)
    if (!id && found?.short) {
      id = await resolveShort(found.short)
      if (!id) throw new Error('抖音短链没跳到视频页，可能已删除或失效')
      log?.info?.(`抖音：短链解析到 ${videoLink(id)}`)
    }
    if (!id) throw new Error('没法从这段内容里认出视频号')
    const hit = cachedPath(id)
    if (hit) {
      log?.info?.(`抖音：命中缓存 ${hit}`)
      return hit
    }
    const urls = await extractUrl(id)
    return download(urls, id)
  }

  return { resolve, cacheDir, cachedPath, extractUrl, download }
}
