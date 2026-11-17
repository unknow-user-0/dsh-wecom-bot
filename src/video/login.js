// 视频站登录态：把「专用浏览器里登录过的 cookie」变成 yt-dlp 能用的 cookies.txt。
//
// 为什么要这个模块：抖音几乎全部要登录，B 站部分内容要登录，而 yt-dlp 只认
// Netscape 格式的 cookies.txt。用户在面板里点一次「登录」，在弹出的专用浏览器里
// 正常登录，再点「保存登录态」，这里就把 cookie 导出来落盘，并把路径写进
// ~/.dsh/video.json 的 cookies 字段 —— 上游 dsh-video-storyboard 读的就是那里。
//
// 为什么要合并成一个文件：`video.json` 只有**一个** cookies 字段，装不下两套。
// Netscape 格式本身按 domain 区分，把两个站的 cookie 合并进同一个 jar 是标准做法，
// yt-dlp 会按目标站点的域名自己挑行，互不干扰。
//
// 安全边界（写死，不做成配置）：
//   1. 自动抓取走插件自己的专用浏览器资料目录，绝不读用户自己浏览器的 cookie；
//   2. 手动粘贴是**降级通道**，必须显式 confirmed=true 才接受（面板侧还有三重确认）；
//   3. 导出的 jar 只落插件数据目录，不碰用户已有的 cookie 文件。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** 支持登录的视频站。keys 里任意一个存在才算真的登录了。 */
export const SITES = [
  {
    id: 'douyin',
    name: '抖音',
    url: 'https://www.douyin.com/',
    domains: ['douyin.com'],
    keys: ['sessionid', 'sessionid_ss'],
    hint: '抖音匿名基本什么都看不了，必须登录。',
  },
  {
    id: 'bili',
    name: 'B站',
    url: 'https://www.bilibili.com/',
    domains: ['bilibili.com'],
    keys: ['SESSDATA'],
    hint: 'B 站匿名能看大部分，登录后能看更高清晰度和会员内容。',
  },
]

const SITE_BY_ID = new Map(SITES.map((s) => [s.id, s]))

function siteOf(id) {
  const s = SITE_BY_ID.get(String(id || '').trim())
  if (!s) throw new Error(`不认识的站点：${id}`)
  return s
}

/** cookie 的 domain 是否属于这个站点（`.douyin.com` / `www.douyin.com` 都算） */
function belongsTo(domain, suffixes) {
  const d = String(domain || '').replace(/^\./, '').toLowerCase()
  if (!d) return false
  return suffixes.some((s) => d === s || d.endsWith('.' + s))
}

/* ------------------------------------------------------------ Netscape 格式 */

/**
 * 解析 Netscape cookies.txt。认 7 列 tab 分隔，也容忍空格分隔（有人手改过）。
 * 注释行与空行直接丢。
 * @returns {Array<{domain,includeSub,path,secure,expires,name,value}>}
 */
export function netscapeParse(text) {
  const out = []
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (!line || line.startsWith('#')) continue
    // 标准是 tab；手改的常是空格。两种都试，但值里可能有空格，所以优先 tab。
    let parts = line.split('\t')
    if (parts.length < 7) parts = line.split(/\s+/)
    if (parts.length < 7) continue
    const [domain, includeSub, path, secure, expires, name, ...rest] = parts
    const value = rest.join('\t')
    if (!domain || !name) continue
    out.push({
      domain,
      includeSub: String(includeSub).toUpperCase() === 'TRUE',
      path: path || '/',
      secure: String(secure).toUpperCase() === 'TRUE',
      expires: Number(expires) || 0,
      name,
      value,
    })
  }
  return out
}

/** 一条 cookie → Netscape 行。expires <= 0 记 0（会话级，yt-dlp 也认）。 */
export function netscapeLine(c) {
  const domain = String(c.domain || '')
  const includeSub = domain.startsWith('.') ? 'TRUE' : 'FALSE'
  const expires = Number.isFinite(Number(c.expires)) && Number(c.expires) > 0 ? Math.floor(Number(c.expires)) : 0
  return [
    domain,
    includeSub,
    c.path || '/',
    c.secure ? 'TRUE' : 'FALSE',
    expires,
    c.name,
    String(c.value ?? ''),
  ].join('\t')
}

export function netscapeString(cookies) {
  const head = '# Netscape HTTP Cookie File\n# 由 dsh-wecom-bot 从专用浏览器导出，勿手改\n'
  return head + cookies.map(netscapeLine).join('\n') + '\n'
}

/** CDP 导出的 cookie 对象 → Netscape 行需要的形状（字段名基本一致，只补默认值） */
function fromCdp(c) {
  return {
    domain: c.domain,
    path: c.path || '/',
    secure: Boolean(c.secure),
    expires: Number(c.expires) > 0 ? Number(c.expires) : 0,
    name: c.name,
    value: String(c.value ?? ''),
  }
}

/* ---------------------------------------------------------------- 主逻辑 */

/**
 * @param {object} o
 * @param {string}   o.dataDir    插件数据目录
 * @param {Function} o.getBrowser () => browser manager（src/browser/manager.js）
 * @param {object}   o.log
 */
export function createVideoLogin({ dataDir, getBrowser, log }) {
  const dir = join(dataDir, 'video')
  const jarFile = join(dir, 'cookies.txt')
  mkdirSync(dir, { recursive: true })

  const homeDir = () => process.env.DSH_HOME || join(homedir(), '.dsh')
  const videoConfigFile = () => join(homeDir(), 'video.json')

  function readVideoConfig() {
    try {
      const raw = JSON.parse(readFileSync(videoConfigFile(), 'utf8'))
      return raw && typeof raw === 'object' ? raw : {}
    } catch {
      return {}
    }
  }

  /** 只改我们关心的键，别的字段原样保留（用户可能自己配了 ytdlp 路径等） */
  function writeVideoConfig(patch) {
    const next = { ...readVideoConfig(), ...patch }
    try {
      mkdirSync(join(videoConfigFile(), '..'), { recursive: true })
      writeFileSync(videoConfigFile(), JSON.stringify(next, null, 2), 'utf8')
      return { ok: true, file: videoConfigFile() }
    } catch (error) {
      return { ok: false, message: `写不了 ${videoConfigFile()}：${error.message}` }
    }
  }

  function readJar() {
    try {
      if (!existsSync(jarFile)) return []
      return netscapeParse(readFileSync(jarFile, 'utf8'))
    } catch {
      return []
    }
  }

  /**
   * 把某个站点的 cookie 并进 jar：先删掉这个站点旧的所有行，再写新的。
   * 这样重复保存不会越堆越多，也不会把另一个站的登录态冲掉。
   */
  function mergeJar(site, cookies) {
    const fresh = cookies.filter((c) => belongsTo(c.domain, site.domains))
    if (!fresh.length) return { ok: false, message: `没抓到 ${site.name} 的 cookie，可能还没登录成功` }
    const kept = readJar().filter((c) => !belongsTo(c.domain, site.domains))
    const all = [...kept, ...fresh]
    try {
      writeFileSync(jarFile, netscapeString(all), 'utf8')
    } catch (error) {
      return { ok: false, message: `写不了登录态文件：${error.message}` }
    }
    // 让上游认得这个 jar
    const cfgPatch = writeVideoConfig({ cookies: jarFile })
    if (!cfgPatch.ok) return cfgPatch
    const names = new Set(fresh.map((c) => c.name))
    const hit = site.keys.filter((k) => names.has(k))
    return {
      ok: true,
      count: fresh.length,
      total: all.length,
      file: jarFile,
      videoConfig: videoConfigFile(),
      keys: hit,
      message: hit.length
        ? `${site.name} 登录态已保存（${fresh.length} 条 cookie）`
        : `${site.name} 的 cookie 存下了，但没看到 ${site.keys.join(' / ')} —— 可能还没登录完，或者登录的是别的账号域`,
    }
  }

  /** 当前状态：每个站点登录了没、jar 在哪、video.json 指向哪 */
  function status() {
    const jar = readJar()
    const vc = readVideoConfig()
    const sites = SITES.map((s) => {
      const mine = jar.filter((c) => belongsTo(c.domain, s.domains))
      const names = new Set(mine.map((c) => c.name))
      const keys = s.keys.filter((k) => names.has(k))
      return {
        id: s.id,
        name: s.name,
        url: s.url,
        hint: s.hint,
        loggedIn: keys.length > 0,
        count: mine.length,
        keys,
        // 会话级 cookie（expires=0）重启浏览器就没了，但 jar 里存着还能用，只是不会续期
        sessionOnly: mine.filter((c) => !c.expires).length,
      }
    })
    let jarTime = ''
    try { jarTime = existsSync(jarFile) ? String(Number(readFileSync(jarFile).length)) : '' } catch {}
    return {
      jarFile,
      jarExists: existsSync(jarFile),
      jarBytes: jarTime ? Number(jarTime) : 0,
      jarTotal: jar.length,
      videoConfigFile: videoConfigFile(),
      // 上游读的是 video.json 的 cookies 字段；跟我们的 jar 不一致时面板要提醒
      videoConfigCookies: String(vc.cookies || ''),
      jarInUse: String(vc.cookies || '') === jarFile,
      // 正在自动盯着的站点：面板据此显示「登录完会自动存」
      watching: watch ? { site: watch.siteId, until: watch.until } : null,
      sites,
    }
  }

  /**
   * 打开专用浏览器并跳到站点首页，把窗口挪到屏幕里让用户自己登录。
   * force 跳过 features.browser 开关：登录态是给视频用的，跟网页操作开关不是一回事。
   */
  async function openLogin(siteId) {
    const site = siteOf(siteId)
    const bm = getBrowser()
    if (!bm) return { ok: false, message: '浏览器模块没初始化' }
    const r = await bm.ensure({ force: true })
    if (!r.ok) return r
    const b = bm.get()
    await b.goto(site.url, 20000)
    await b.show(true)
    // 打开就顺手盯上：人登完常常直接走，不会回来点保存
    startWatch(site.id)
    return {
      ok: true,
      site: site.id,
      name: site.name,
      autoSave: true,
      message: `已打开${site.name}，在那个窗口里登录就行，登完会自动存下来（最多等 ${Math.round(AUTO_SAVE_MAX_MS / 60000)} 分钟）。`,
    }
  }

  /* ------------------------------------------------- 自动保存（登录完自己存） */
  //
  // 以前是纯手动：点「去登录」→ 在浏览器里登 → 回来点「保存登录态」。
  // 实际用起来第三步经常被忘掉，面板就一直显示未登录、用户以为坏了。
  // 现在改成打开登录页之后就后台盯着浏览器里的 cookie，一看到该站点的登录标识
  // 出现就自动存一次；手动保存仍然保留，当作「我确认好了」的显式入口。
  //
  // 三条边界：
  //   1. 只盯一个站点，最长 AUTO_SAVE_MAX_MS，到点自己停 —— 不做常驻轮询；
  //   2. 自动存时窗口不收起（hide:false），人可能还要接着登另一个站；
  //   3. 手动保存/清除会先把它停掉，避免自动的把手动粘进来的覆盖回去。
  const AUTO_SAVE_EVERY_MS = 3000
  const AUTO_SAVE_MAX_MS = 5 * 60 * 1000
  let watch = null

  /** 停掉正在盯的那个站点。reason 只用于写日志。 */
  function stopWatch(reason) {
    if (!watch) return
    clearTimeout(watch.timer)
    const siteId = watch.siteId
    watch = null
    if (reason) log?.info?.(`自动保存停了（${siteId}）：${reason}`)
  }

  /** 盯住某个站点的登录态，看到登录标识就自动存一次，存成即停。 */
  function startWatch(siteId) {
    const site = siteOf(siteId)
    stopWatch('换了个站点')
    const w = { siteId: site.id, timer: null, until: Date.now() + AUTO_SAVE_MAX_MS }
    watch = w
    const tick = async () => {
      if (watch !== w) return
      if (Date.now() > w.until) { stopWatch('等太久了，没等到登录'); return }
      const b = getBrowser()?.get?.()
      if (b?.connected?.()) {
        let cookies = []
        try { cookies = await b.exportCookies() } catch {}
        const names = new Set(cookies.filter((c) => belongsTo(c.domain, site.domains)).map((c) => c.name))
        if (site.keys.some((k) => names.has(k))) {
          const r = await saveLogin(site.id, { auto: true, hide: false })
          if (r?.ok) { stopWatch(`${site.name} 登录态已自动存下`); return }
          // 存失败就继续盯，下一轮再试（比如正好在写盘）
        }
      }
      if (watch !== w) return
      w.timer = setTimeout(tick, AUTO_SAVE_EVERY_MS)
      w.timer.unref?.()
    }
    w.timer = setTimeout(tick, AUTO_SAVE_EVERY_MS)
    w.timer.unref?.()
    log?.info?.(`${site.name}：开始自动盯登录态（最多 ${Math.round(AUTO_SAVE_MAX_MS / 60000)} 分钟）`)
  }

  /**
   * 从专用浏览器导 cookie，过滤出这个站点的，存进 jar。
   *
   * 浏览器没连着时先自己接一次（ensure force）：用户登录完把窗口关了、或者 DSH 重启过，
   * 这里还应该努力接回去，而不是甩一句「浏览器没开着」让人重新登一遍。
   * 接不回来才报错，而且要说清楚是哪种情况。
   *
   * `hide` 默认 true（手动保存时把窗口收起来，表示"完事了"）。
   * 自动保存时必须传 false —— 用户可能还要接着登另一个站，把窗口藏了等于把人赶走。
   */
  async function saveLogin(siteId, { hide = true, auto = false } = {}) {
    const site = siteOf(siteId)
    if (!auto) stopWatch('改成手动保存了')
    const bm = getBrowser()
    if (!bm) return { ok: false, message: '浏览器模块没初始化' }
    if (!bm.get()?.connected?.()) {
      const r = await bm.ensure({ force: true }).catch((error) => ({ ok: false, message: error.message }))
      if (!r?.ok) {
        return { ok: false, message: `浏览器没开着，也接不回来（${r?.message || '未知原因'}）。重新点一次「去登录」` }
      }
    }
    let cookies = []
    try {
      cookies = await bm.get().exportCookies()
    } catch (error) {
      return { ok: false, message: `导不出 cookie：${error.message}` }
    }
    const out = mergeJar(site, cookies.map(fromCdp))
    if (hide) {
      try { await bm.get().show(false) } catch {}
    }
    log?.info?.(`${site.name} 登录态：${out.message}`)
    return { ...out, status: status() }
  }

  /**
   * 实时看浏览器里现在到底登没登 —— 不落盘，只读。
   *
   * 为什么要单独一个：用户点完「去登录」在浏览器里操作，面板上得能立刻看到变化，
   * 否则他不知道该不该点保存。而 status() 只读 jar，反映不了浏览器里的当下状态。
   * 浏览器没连着时返回 connected:false，面板据此提示「先点去登录」。
   */
  async function probe() {
    const bm = getBrowser()
    if (!bm) return { ok: false, connected: false, message: '浏览器模块没初始化' }
    const b = bm.get()
    if (!b?.connected?.()) return { ok: true, connected: false, sites: [] }
    let cookies = []
    try {
      cookies = await b.exportCookies()
    } catch (error) {
      return { ok: true, connected: true, sites: [], message: `读不到浏览器 cookie：${error.message}` }
    }
    const sites = SITES.map((s) => {
      const mine = cookies.filter((c) => belongsTo(c.domain, s.domains))
      const names = new Set(mine.map((c) => c.name))
      const keys = s.keys.filter((k) => names.has(k))
      return { id: s.id, loggedIn: keys.length > 0, count: mine.length, keys }
    })
    return { ok: true, connected: true, sites }
  }

  /**
   * 手动粘贴 cookies.txt 的降级通道。
   * 必须 confirmed === true —— 这一条由面板的三重确认换来，后端再兜一次，
   * 防止有人直接 curl 这个接口塞别人的 cookie。
   */
  function saveManual(siteId, text, confirmed) {
    const site = siteOf(siteId)
    if (confirmed !== true) {
      return { ok: false, message: '手动粘贴需要先勾选确认（cookie 等同于账号凭据）' }
    }
    const parsed = netscapeParse(text)
    if (!parsed.length) {
      return { ok: false, message: '没解析出 cookie。需要 Netscape 格式（每行 7 列，tab 分隔），不是 JSON' }
    }
    const mine = parsed.filter((c) => belongsTo(c.domain, site.domains))
    if (!mine.length) {
      return { ok: false, message: `这份文件里没有 ${site.name} 的 cookie（域名要含 ${site.domains.join(' / ')}）` }
    }
    const out = mergeJar(site, mine)
    log?.info?.(`${site.name} 手动导入登录态：${out.message}`)
    return { ...out, status: status() }
  }

  /** 清掉某个站点（或全部）的登录态 */
  function clear(siteId) {
    stopWatch('清登录态了')
    const site = siteId ? siteOf(siteId) : null
    const kept = site ? readJar().filter((c) => !belongsTo(c.domain, site.domains)) : []
    try {
      if (kept.length) writeFileSync(jarFile, netscapeString(kept), 'utf8')
      else if (existsSync(jarFile)) writeFileSync(jarFile, netscapeString([]), 'utf8')
    } catch (error) {
      return { ok: false, message: error.message }
    }
    return { ok: true, message: site ? `${site.name} 的登录态已清掉` : '全部登录态已清掉', status: status() }
  }

  return { status, probe, openLogin, saveLogin, saveManual, clear, stopWatch, jarFile, videoConfigFile }
}
