// 浏览器管理器：一个专用浏览器实例 + 一份登录态（cookie）仓库 + 一份常用站点清单。
//
// 为什么要 cookie 仓库：用户在内网系统（TMS / ERP / BOM / 网店后台）里都是登录状态，
// 但插件启的浏览器是独立资料目录，天然没登录态。做法是让用户在面板里「导出登录态」一次性灌进来
// （Edge cookie 大约能活一年），以后重启不用重登；过期了面板会上报一次失败。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createBrowser, findBrowser } from './cdp.js'

function readJson(path, fallback) {
  try {
    if (!existsSync(path)) return fallback
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(path, value) {
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, JSON.stringify(value, null, 2), 'utf8')
  } catch {}
}

/**
 * @param {{dataDir:string, getConfig:Function, log:object}} o
 */
export function createBrowserManager({ dataDir, getConfig, log }) {
  const dir = join(dataDir, 'browser')
  const profileDir = join(dir, 'profile')
  const cookiesFile = join(dir, 'cookies.json')
  const sitesFile = join(dir, 'sites.json')
  mkdirSync(profileDir, { recursive: true })

  let browser = null
  let lastError = ''

  const cfg = () => getConfig()

  function instance() {
    if (browser) return browser
    browser = createBrowser({
      profileDir,
      browserPath: () => cfg().browser?.path || '',
      headless: () => Boolean(cfg().browser?.headless),
      log,
    })
    return browser
  }

  /**
   * 打开（或接回）浏览器；顺带把存着的登录态灌进去。
   *
   * force：跳过「浏览器操作」开关。只有面板上的登录模块用（用户明确点了「去登录」），
   * 因为登录页必须能打开浏览器，而开关管的是「模型能不能用浏览器工具」——两件事。
   */
  async function ensure({ force = false } = {}) {
    if (!force && !cfg().features?.browser) return { ok: false, message: '浏览器能力没开（面板里打开「网页操作」）' }
    const b = instance()
    if (b.connected()) return { ok: true }
    const r = await b.open()
    if (!r.ok) {
      lastError = r.message || '浏览器没起来'
      return r
    }
    lastError = ''
    // 每次连上都补一次登录态（已存在的 cookie 会被覆盖成同样的值，幂等）
    const jar = readJson(cookiesFile, null)
    if (jar?.cookies?.length) {
      const n = await b.importCookies(jar.cookies).catch(() => 0)
      log?.debug?.(`灌入登录态 ${n} 条（${jar.savedAt || '未知时间'}导出的）`)
    }
    return { ok: true }
  }

  /** 导出当前浏览器的全部 cookie 存下来。 */
  async function saveCookies() {
    const r = await ensure()
    if (!r.ok) return r
    const cookies = await instance().exportCookies()
    writeJson(cookiesFile, { savedAt: new Date().toISOString(), cookies })
    return { ok: true, count: cookies.length, savedAt: new Date().toISOString() }
  }

  function cookieStatus() {
    const jar = readJson(cookiesFile, null)
    return {
      saved: Boolean(jar?.cookies?.length),
      count: jar?.cookies?.length || 0,
      savedAt: jar?.savedAt || '',
    }
  }

  function listSites() {
    return readJson(sitesFile, [])
  }

  function saveSite({ id, name, url, note, loginHint }) {
    const sites = listSites()
    const key = id || String(name || url || '').trim()
    if (!key) throw new Error('站点要有名字或地址')
    const i = sites.findIndex((s) => s.id === key)
    const item = { id: key, name: name || key, url: url || '', note: note || '', loginHint: loginHint || '' }
    if (i >= 0) sites[i] = { ...sites[i], ...item }
    else sites.push(item)
    writeJson(sitesFile, sites)
    return item
  }

  function removeSite(id) {
    const sites = listSites().filter((s) => s.id !== id)
    writeJson(sitesFile, sites)
    return { ok: true, count: sites.length }
  }

  function status() {
    return {
      enabled: Boolean(cfg().features?.browser),
      connected: Boolean(browser?.connected()),
      running: Boolean(browser),
      profileDir,
      browserPath: findBrowser(cfg().browser?.path || ''),
      headless: Boolean(cfg().browser?.headless),
      lastError,
      cookies: cookieStatus(),
      sites: listSites().length,
    }
  }

  function shutdown() {
    try { browser?.stopOwn() } catch {}
    try { browser?.close() } catch {}
    browser = null
  }

  return {
    ensure,
    get: () => instance(),
    saveCookies,
    cookieStatus,
    listSites,
    saveSite,
    removeSite,
    status,
    shutdown,
    profileDir,
  }
}
