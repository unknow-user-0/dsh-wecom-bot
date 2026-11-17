// 抖音：yt-dlp 这条路已经废了，用插件自己的浏览器绕过去。
//
// 为什么必须绕：
//   yt-dlp 的 Douyin 提取器先打 `https://www.douyin.com/aweme/v1/web/aweme/detail/`，
//   这个接口现在上了 Argus 签名墙，缺 Uifid（浏览器 JS 算出来的设备指纹）就直接
//   `403 Blocked by ArgusSecurityPlugin Uifid Not Found`。cookie 再全、加
//   `--impersonate chrome`、换真链接，结果都一样 —— 是提取器整体失效，不是配置问题。
//   实测：2026-11 用 yt-dlp 2026.10.26 打真抖音链接，三条路径全 403。
//
// 怎么绕：
//   抖音自己的网页里，播放器会把已经签好名的 CDN 直链塞进 `<video src>`。我们只要让
//   **浏览器**打开那个页面，等它渲染出来，再把 src 抠出来下载就行 —— 签名由抖音自己算，
//   一个字都不用我们实现。
//   实测：`https://www.douyin.com/video/6961737553342991651` 打开后拿到
//   `https://v11-weba.douyinvod.com/...mime_type=video_mp4...`，带 referer 下载 3.67MB，
//   ffprobe 认出 `mov,mp4,m4a` 19.78s，是真视频（不是封面图）。
//
// 两个关键细节：
//   1. CDN 校验 referer，必须带 `https://www.douyin.com/`，否则 403。
//   2. 直链有效期只有 1-2 小时，所以下载完立刻落盘成 mp4，别再转发这个 URL。
//
// 上游 storyboard 工具本来就支持传本地路径，所以这里只要把抖音链接换成「本地文件路径」，
// 上游一行都不用改。缓存按 aweme id 存，一次下载喂给 storyboard/zoom/locate 三个工具。

import { existsSync, mkdirSync, statSync, createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

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
 * 浏览器里那段抠 `video.src` 的表达式。
 *
 * 四个坑（都是实测踩出来的）：
 *   - `v.src` 常常是**空字符串**，真正的地址在 `currentSrc`；只读 src 会拿到 undefined 就直接跳过。
 *   - 页面上有两个 `<video>`：一个是预加载的**短片段**（实测 2.6 秒 / 0.19MB），
 *     另一个才是正片（19.7 秒）。谁先出现在 DOM 里不一定，必须按 `duration` 挑最长的，
 *     否则会「成功」下载到一个两秒的开头就以为完事了。
 *   - 地址可能是 `blob:`（MSE 流），blob 下不下来，要等真地址。
 *   - 页面是 SPA，`loadEventFired` 之后视频元素还要几百毫秒才挂上去。
 */
const PICK_SRC = `(async () => {
  const deadline = Date.now() + 25000
  const collect = () => {
    const out = []
    for (const v of document.querySelectorAll('video')) {
      const cand = [v.currentSrc, v.src, v.getAttribute('src')]
        .find((s) => s && /^https?:\\/\\//i.test(s) && /douyinvod|douyin|byteimg|tos-cn|snssdk/i.test(s))
      if (!cand) continue
      out.push({ url: cand, dur: Number(v.duration) || 0, ready: Number(v.readyState) || 0 })
    }
    return out
  }
  for (;;) {
    const list = collect()
    // 先挑「已知时长里最长的」；都还不知道时长就挑 readyState 最大的那个。
    if (list.length) {
      const known = list.filter((x) => x.dur > 0).sort((a, b) => b.dur - a.dur)
      if (known.length) {
        const best = known[0]
        // 太短的（预加载片段 / 封面动画）宁可再等等，除非已经等到最后了
        if (best.dur >= 3 || Date.now() > deadline) return best.url
      } else if (Date.now() > deadline) {
        return list.sort((a, b) => b.ready - a.ready)[0].url
      }
    }
    if (Date.now() > deadline) {
      const vs = document.querySelectorAll('video').length
      return vs
        ? 'ERR:找到 ' + vs + ' 个 video，但都拿不到 http 地址（可能被风控或需要登录）'
        : 'ERR:页面上没有 video 元素（可能不是视频页、或页面没渲染出来）'
    }
    await new Promise((r) => setTimeout(r, 400))
  }
})()`

/**
 * @param {object} o
 * @param {Function} o.getBrowser () => 浏览器管理器（manager.js 那个）
 * @param {Function} o.dataDir  插件数据目录
 * @param {object}   o.log
 */
export function createDouyinResolver({ getBrowser, dataDir, log }) {
  const cacheDir = () => join(dataDir, 'video', 'douyin')

  function cachedPath(id) {
    if (!id) return ''
    const p = join(cacheDir(), `${id}.mp4`)
    try {
      if (existsSync(p) && statSync(p).size > 1024) return p
    } catch {}
    return ''
  }

  /** 让浏览器打开页面、等渲染完、抠出直链 */
  async function extractUrl(url) {
    const bm = getBrowser?.()
    if (!bm) throw new Error('浏览器模块没初始化')
    // force：登录页/看视频不该被「浏览器操作」开关挡住，那个开关管的是模型能不能用 browser_* 工具
    const ready = await bm.ensure({ force: true })
    if (!ready?.ok) throw new Error(`打不开浏览器：${ready?.message || '未知原因'}`)
    const b = bm.get()
    if (!b?.connected?.()) throw new Error('浏览器没连上')

    log?.info?.(`抖音：用浏览器打开 ${url}`)
    await b.goto(url, 30000)
    const src = await b.evaluate(PICK_SRC, 40000)
    const text = String(src || '')
    if (!text || text.startsWith('ERR:')) {
      throw new Error(text.replace(/^ERR:/, '') || '没能从页面上拿到视频地址')
    }
    return text
  }

  /** 带 referer 下载到本地，返回路径 */
  async function download(srcUrl, id) {
    mkdirSync(cacheDir(), { recursive: true })
    const out = join(cacheDir(), `${id || Date.now().toString(36)}.mp4`)
    const tmp = out + '.part'
    const res = await fetch(srcUrl, {
      headers: { 'user-agent': DOUYIN_UA, referer: 'https://www.douyin.com/', accept: '*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(180000),
    })
    if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status}`)
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp))
    try {
      const st = statSync(tmp)
      if (st.size < 10240) throw new Error(`下载下来的文件太小（${st.size} 字节），多半是风控页`)
    } catch (error) {
      try { if (existsSync(tmp)) (await import('node:fs')).rmSync(tmp, { force: true }) } catch {}
      throw error
    }
    await (await import('node:fs/promises')).rename(tmp, out)
    const size = statSync(out).size
    log?.info?.(`抖音：已下载 ${(size / 1048576).toFixed(2)}MB → ${out}`)
    return out
  }

  /**
   * 把抖音链接换成「本地 mp4 路径」。不是抖音链接就原样返回。
   * 失败时抛出人话错误，由上游工具原样报给模型。
   */
  async function resolve(input) {
    const raw = String(input || '').trim()
    if (!isDouyinUrl(raw)) return input
    let id = douyinId(raw)
    // 短链：先跟着跳到长链接，才有 id（也顺带确认视频还在）
    if (!id) {
      try {
        const head = await fetch(raw, {
          method: 'GET',
          redirect: 'follow',
          headers: { 'user-agent': DOUYIN_UA },
          signal: AbortSignal.timeout(20000),
        })
        id = douyinId(head.url || '')
        if (!id) throw new Error('短链没跳到视频页，可能已删除或失效')
        log?.info?.(`抖音：短链解析到 ${head.url}`)
      } catch (error) {
        throw new Error(`抖音短链解析失败：${error.message}`)
      }
    }
    const hit = cachedPath(id)
    if (hit) {
      log?.info?.(`抖音：命中缓存 ${hit}`)
      return hit
    }
    const src = await extractUrl(`https://www.douyin.com/video/${id}`)
    return download(src, id)
  }

  return { resolve, cacheDir, cachedPath, extractUrl, download }
}
