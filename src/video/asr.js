// 语音转文字（ASR）连接：让「看视频」能听见声音。
//
// 为什么要有这一层：上游 dsh-video-storyboard 的台词层靠一个 OpenAI 兼容的
// /audio/transcriptions 端点。没配就是「只看得见图、听不见声音」，而失败时上游
// 静默降级（设计如此，不让整个分镜挂掉），所以用户在群里只会觉得「它没听见」，
// 完全不知道是没配。这个模块把那条隐形依赖变成面板上看得见、点得动的东西。
//
// 配置写在 ~/.dsh/asr.json —— 这是上游唯一认的通道（DSH 桌面版读不到 setx 设的
// 环境变量，踩过坑）。字段与上游一致：baseUrl / key / model / language / enabled / manage。
//
// manage.start 是「托管拉起」：写了它，模型自己用视频工具时上游也会按需把服务拉起来；
// 没写就绝不碰用户的进程。面板上的「启动」按钮同样只走这一条路。

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'

/** 本机服务不需要 key（与上游 isLoopback 同一套判据） */
export function isLoopback(baseUrl) {
  try {
    const h = new URL(String(baseUrl)).hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '0.0.0.0'
  } catch {
    return false
  }
}

/** 探活：先试 /health，再退 /v1/models。2 秒超时，别把面板卡住。 */
export async function probeEndpoint(baseUrl, { timeoutMs = 2000 } = {}) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!base) return { ok: false, message: '没配地址' }
  for (const path of ['/health', '/v1/models', '/models']) {
    try {
      const r = await fetch(base + path, { signal: AbortSignal.timeout(timeoutMs) })
      if (r.ok) return { ok: true, path, status: r.status }
    } catch {}
  }
  return { ok: false, message: '连不上（服务没启动，或地址/端口不对）' }
}

/** 本地常见安装位置里找 ASR 启动脚本，找到就给出「一键配置」候选 */
export function discoverLocal(extraDirs = []) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  // 用户常把 ASR 放在工作区旁边（asr/ 目录），而插件的 cwd 可能是工作区、也可能是
  // 插件自己的目录。所以从每个起点往上扫几层，找「同级的 asr 目录」，别只认一个位置。
  const roots = [process.cwd(), ...extraDirs].filter(Boolean)
  const dirs = [join(home, 'tools', 'asr')]
  for (const root of roots) {
    let dir = root
    for (let i = 0; i < 4 && dir; i += 1) {
      dirs.push(join(dir, 'asr'), dir)
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  dirs.push(join(homedir(), 'asr'))
  const scriptNames = ['启动-ASR.bat', 'start-asr.bat', 'asr.bat', 'start-asr.cmd']
  const found = []
  const seen = new Set()
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    try {
      if (!existsSync(dir) || !statSync(dir).isDirectory()) continue
    } catch { continue }
    for (const name of scriptNames) {
      const p = join(dir, name)
      if (!existsSync(p)) continue
      found.push({
        dir,
        script: p,
        // 本机常见部署：whisper-server 起 8081，适配层起 8080
        suggestBaseUrl: 'http://127.0.0.1:8080',
        label: name,
      })
      break
    }
  }
  return found
}

/**
 * @param {object} o
 * @param {object} o.log
 * @param {Function} [o.getHostService] () => 宿主自带的 speechToText 服务（没有就 undefined）
 * @param {Function} [o.getExtraDirs] () => 额外要扫的目录（插件把工作区路径递进来）
 */
export function createAsr({ log, getHostService, getExtraDirs }) {
  const homeDir = () => process.env.DSH_HOME || join(homedir(), '.dsh')
  const configFile = () => join(homeDir(), 'asr.json')

  /** 额外扫描目录由调用方给（插件的 cwd 不是用户工作区，不能只靠 process.cwd()） */
  function safeExtraDirs() {
    try {
      const list = getExtraDirs?.()
      return Array.isArray(list) ? list.filter((d) => typeof d === 'string' && d) : []
    } catch {
      return []
    }
  }

  function readConfig() {
    try {
      const raw = JSON.parse(readFileSync(configFile(), 'utf8'))
      return raw && typeof raw === 'object' ? raw : {}
    } catch {
      return {}
    }
  }

  function writeConfig(next) {
    const file = configFile()
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(next, null, 2), 'utf8')
      return { ok: true, file }
    } catch (error) {
      return { ok: false, message: `写不了 ${file}：${error.message}` }
    }
  }

  /** 宿主自带服务能不能用（能用的话根本不需要本机 whisper） */
  function hostService() {
    try {
      const s = getHostService?.()
      return typeof s?.transcribe === 'function'
    } catch {
      return false
    }
  }

  /**
   * 探活结果缓存。
   * 为什么需要：面板每次刷新都打 /state，/state 会 await 这个探活。服务没起时
   * 三个候选路径各 2 秒超时 = 面板卡 6 秒，而"没起"这个结论十秒内不会变。
   * 缓存 10 秒；点「启动」和保存配置时会主动清掉，保证用户点完立刻看到真状态。
   */
  let probeCache = null
  async function probeCached(baseUrl) {
    const now = Date.now()
    if (probeCache && probeCache.baseUrl === baseUrl && now - probeCache.at < 10000) {
      return probeCache.value
    }
    const value = await probeEndpoint(baseUrl)
    probeCache = { baseUrl, at: now, value }
    return value
  }

  async function status() {
    const c = readConfig()
    const baseUrl = String(c.baseUrl || '').trim()
    const hasHost = hostService()
    const managed = Boolean(c.manage && c.manage.start)
    let probe = { ok: false, message: '没配地址' }
    if (baseUrl) probe = await probeCached(baseUrl)
    const state = hasHost || probe.ok ? 'ok' : (baseUrl ? 'down' : 'missing')
    return {
      state,
      baseUrl,
      model: String(c.model || ''),
      language: String(c.language || ''),
      // key 绝不回传，只说有没有
      keySet: Boolean(c.key),
      enabled: c.enabled !== false,
      file: configFile(),
      hostService: hasHost,
      managed,
      manageStart: managed ? String(c.manage.start) : '',
      probe,
      discovery: discoverLocal(safeExtraDirs()),
      message: hasHost
        ? '宿主自带语音服务可用'
        : (state === 'ok'
          ? '本机语音服务在线'
          : (state === 'down' ? '配了地址但连不上，服务没启动' : '还没配语音转文字，视频里的声音听不见')),
    }
  }

  /**
   * 保存配置。只改传进来的键，没传的保持原样（跟 /save 的增量语义一致）。
   * key 传空字符串 = 清掉；不传 = 不动。
   */
  function save(patch = {}) {
    const cur = readConfig()
    const next = { ...cur }
    if (typeof patch.baseUrl === 'string') next.baseUrl = patch.baseUrl.trim()
    if (typeof patch.model === 'string') next.model = patch.model.trim()
    if (typeof patch.language === 'string') next.language = patch.language.trim()
    if (patch.key !== undefined) {
      const k = String(patch.key || '').trim()
      if (k) next.key = k
      else delete next.key
    }
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
    if (patch.manageStart !== undefined) {
      const s = String(patch.manageStart || '').trim()
      if (s) next.manage = { ...(cur.manage || {}), start: s }
      else if (next.manage) {
        delete next.manage.start
        if (!Object.keys(next.manage).length) delete next.manage
      }
    }
    // 本机地址不需要 key，顺手清掉免得看着像泄露
    if (next.baseUrl && isLoopback(next.baseUrl) && !next.key) delete next.key
    const out = writeConfig(next)
    probeCache = null // 配置变了，缓存立刻作废
    if (!out.ok) return out
    log?.info?.(`ASR 配置已更新：${next.baseUrl || '(空)'}`)
    return { ok: true, file: out.file }
  }

  /** 把一个启动脚本写进 manage.start 并立刻起一次 */
  async function useDiscovered(script, baseUrl) {
    const r = save({ baseUrl: baseUrl || 'http://127.0.0.1:8080', manageStart: script })
    if (!r.ok) return r
    return start()
  }

  let starting = null

  /**
   * 按 manage.start 把服务拉起来，然后等端点活。
   * 绝不 detach —— Windows 上 detached + cmd 会弹黑框（上游踩过）。
   */
  async function start({ waitMs = 90000 } = {}) {
    if (starting) return starting
    starting = (async () => {
      const c = readConfig()
      const cmd = String(c.manage?.start || '').trim()
      if (!cmd) {
        return {
          ok: false,
          message: '没配启动命令。本机有 ASR 的话在下面「发现的本机服务」里点一键配置；没有就按提示去装一个。',
        }
      }
      // 已经活着就别重复起
      probeCache = null
      const already = await probeEndpoint(c.baseUrl)
      if (already.ok) return { ok: true, message: '服务本来就在跑', probe: already }

      const isBat = /\.(bat|cmd)$/i.test(cmd)
      try {
        const child = isBat
          ? spawn('cmd.exe', ['/c', cmd], { stdio: 'ignore', windowsHide: true })
          : spawn(cmd, [], { stdio: 'ignore', windowsHide: true, shell: false })
        child.on('error', (error) => log?.warn?.(`ASR 启动失败：${error.message}`))
        child.unref?.()
      } catch (error) {
        return { ok: false, message: `起不来：${error.message}` }
      }
      // 等端点活。whisper large-v3 加载模型要十几秒，别急。
      const deadline = Date.now() + Math.max(5000, waitMs)
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000))
        const p = await probeEndpoint(c.baseUrl, { timeoutMs: 1500 })
        if (p.ok) {
          log?.info?.('ASR 服务已就绪')
          return { ok: true, message: '服务起来了', probe: p }
        }
      }
      return { ok: false, message: '启动命令跑了，但端点一直没活。看服务自己的日志（常见：模型路径含中文、端口被占）' }
    })().finally(() => { starting = null })
    return starting
  }

  /** 装不上时的提示：给的是「怎么办」，不是一句「不支持」 */
  function installHint() {
    return {
      title: '需要装一个本机语音服务（三选一）',
      options: [
        {
          id: 'whisper',
          name: 'whisper.cpp（推荐，全离线）',
          detail: '下载 whisper.cpp 的 Windows 版，把 ggml 模型（large-v3-turbo 效果最好）放同一目录，'
            + '用它的 whisper-server 起一个 OpenAI 兼容端点（默认 8081）。注意模型路径不能含中文，'
            + '否则进程会静默起不来。',
        },
        {
          id: 'siliconflow',
          name: '云端（SiliconFlow 等，要 key）',
          detail: '填 baseUrl（形如 https://api.siliconflow.cn/v1）+ 模型名 + key。不用装东西，但要联网，'
            + '而且语音内容会发到第三方。',
        },
        {
          id: 'host',
          name: '宿主自带语音服务',
          detail: '如果这个 DSH 装了语音转文字插件，面板会直接显示「宿主自带可用」，这里什么都不用配。',
        },
      ],
    }
  }

  return { status, save, start, useDiscovered, installHint, configFile }
}
