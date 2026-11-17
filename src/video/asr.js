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
import { join, dirname, basename } from 'node:path'
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
      // 给人看的启动命令摘要：数组要按「程序名 + 程序名」拼，不能直接 String() 拍成逗号串。
      manageStart: managed ? describeStart(c.manage.start) : '',
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
      // 允许三种：字符串 / 字符串数组 / 数组的数组（多进程）。空一律删掉。
      const raw = patch.manageStart
      const list = Array.isArray(raw)
        ? raw.map((x) => (Array.isArray(x) ? x.map(String) : String(x))).filter((x) => (Array.isArray(x) ? x[0] : x))
        : String(raw || '').trim()
      const empty = Array.isArray(list) ? list.length === 0 : !list
      if (!empty) next.manage = { ...(cur.manage || {}), start: list }
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

  /**
   * 把 manage.start 说成人话，给面板显示用。
   * 数组不能 String() —— 会变成 "exe,-m,x,node,bridge.mjs" 一串逗号，用户看不出来是个什么。
   */
  function describeStart(raw) {
    const plans = parseStart(raw)
    if (!plans.length) return ''
    return plans
      .map((p) => {
        if (typeof p === 'string') return basename(p)
        return [basename(p[0]), ...p.slice(1)].join(' ')
      })
      .join(' ＋ ')
  }

  /** 把一个启动脚本写进 manage.start 并立刻起一次 */
  async function useDiscovered(script, baseUrl) {
    const r = save({ baseUrl: baseUrl || 'http://127.0.0.1:8080', manageStart: script })
    if (!r.ok) return r
    return start()
  }

  let starting = null

  /**
   * 把 manage.start 归一成「要跑的命令列表」，每条是 [exe, ...args]。
   *
   * 支持三种写法（前两种与上游 asr-lifecycle.js 一致）：
   *   "D:/asr/start.bat"              → 走 cmd /c（bat 要 CRLF，见下面 normalizeBat）
   *   ["D:/whisper.exe", "-m", "x"]   → 直接 spawn，不经过 cmd
   *   [["a.exe","-x"], ["node","b"]]  → 起多个进程（本机这套就是 whisper-server + 适配层）
   *
   * 为什么数组是首选：Windows 上批处理对行尾/编码极其敏感 ——
   * 实测 `启动-ASR.bat` 是 LF 行尾时，cmd.exe 会把 rem 注释里的中文片段当命令执行，
   * 刷一屏「'xxx' 不是内部或外部命令」，而 exit code 还是 0（看着像成功，实际什么都没起）。
   */
  function parseStart(raw) {
    if (Array.isArray(raw)) {
      // [[exe,args],[exe,args]] 还是 [exe, arg, arg]？看第一项是不是数组。
      if (raw.length && Array.isArray(raw[0])) {
        return raw.map((c) => (Array.isArray(c) ? c.map(String) : [String(c)])).filter((c) => c[0])
      }
      return raw.length ? [raw.map(String)] : []
    }
    const s = String(raw || '').trim()
    return s ? [s] : []
  }

  /**
   * LF 行尾的 bat 会被 cmd.exe 读坏，先另存一份 CRLF 的临时副本再跑。
   * 不改用户原文件 —— 那是他自己维护的东西。
   */
  function normalizeBat(file) {
    try {
      const buf = readFileSync(file)
      let text = buf.toString('utf8')
      if (!/\r\n/.test(text)) {
        text = text.replace(/\r?\n/g, '\r\n')
        const tmp = join(dirname(file), `.${Date.now().toString(36)}-crlf.bat`)
        writeFileSync(tmp, text, 'utf8')
        log?.info?.(`ASR：${file} 是 LF 行尾，已另存 CRLF 副本再跑（cmd.exe 读不了 LF）`)
        return tmp
      }
      return file
    } catch (error) {
      log?.warn?.(`ASR：检查 bat 行尾失败（${error.message}），照原样跑`)
      return file
    }
  }

  /**
   * 按 manage.start 把服务拉起来，然后等端点活。
   * 绝不 detach —— Windows 上 detached + cmd 会弹黑框（上游踩过）。
   */
  async function start({ waitMs = 90000 } = {}) {
    if (starting) return starting
    starting = (async () => {
      const c = readConfig()
      // 注意：这里绝不能 String(...) 一把梭 —— manage.start 可以是数组，
      // 字符串化会把它拍成 "exe,-m,xxx" 一个逗号串，spawn 直接 ENOENT（踩过）。
      const rawStart = c.manage?.start
      const cmd = Array.isArray(rawStart) ? rawStart : String(rawStart || '').trim()
      if (!cmd || (Array.isArray(cmd) && !cmd.length)) {
        return {
          ok: false,
          message: '没配启动命令。本机有 ASR 的话在下面「发现的本机服务」里点一键配置；没有就按提示去装一个。',
        }
      }
      // 已经活着就别重复起
      probeCache = null
      const already = await probeEndpoint(c.baseUrl)
      if (already.ok) return { ok: true, message: '服务本来就在跑', probe: already }

      // 启动并且把「到底哪一步失败了」记下来。
      // 真机上出现过：同一个 bat 在有人手动跑时 153ms 就退出、两个端口一直是 0 ——
      // 根因是 bat 是 LF 行尾，cmd.exe 把注释里的中文当命令执行完就正常退出（code=0），
      // 真正的 whisper-server 根本没起。所以这里不猜：exit code、stderr 尾、stdout 尾全收回来。
      const diag = { mode: '', pids: [], exitCodes: [], stderr: '', stdout: '' }
      const spawnOne = (exe, args) => {
        const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
        const take = (buf, key) => { diag[key] = (diag[key] + buf.toString('utf8')).slice(-4000) }
        child.stdout?.on('data', (b) => take(b, 'stdout'))
        child.stderr?.on('data', (b) => take(b, 'stderr'))
        child.on('error', (error) => { diag.stderr += `\n[spawn error] ${error.message}` })
        child.on('exit', (code) => { diag.exitCodes.push(code) })
        child.unref?.()
        return child
      }

      const plans = parseStart(cmd)
      try {
        for (const plan of plans) {
          if (typeof plan === 'string') {
            const file = plan
            const isBat = /\.(bat|cmd)$/i.test(file)
            if (isBat) {
              const fixed = normalizeBat(file)
              diag.mode = `cmd /c ${file}`
              const child = spawnOne('cmd.exe', ['/c', fixed])
              diag.pids.push(child.pid || 0)
            } else {
              diag.mode = `direct ${file}`
              const child = spawnOne(file, [])
              diag.pids.push(child.pid || 0)
            }
          } else {
            const [exe, ...args] = plan
            const isBat = /\.(bat|cmd)$/i.test(exe)
            if (isBat) {
              const fixed = normalizeBat(exe)
              diag.mode += `${diag.mode ? ' + ' : ''}cmd /c ${exe}`
              const child = spawnOne('cmd.exe', ['/c', fixed, ...args])
              diag.pids.push(child.pid || 0)
            } else {
              diag.mode += `${diag.mode ? ' + ' : ''}${exe}`
              const child = spawnOne(exe, args)
              diag.pids.push(child.pid || 0)
            }
          }
        }
      } catch (error) {
        return { ok: false, message: `起不来：${error.message}` }
      }
      if (!diag.pids.length) return { ok: false, message: '启动命令是空的，没东西可跑' }

      // 等端点活。whisper large-v3 加载模型要十几秒，别急。
      const deadline = Date.now() + Math.max(5000, waitMs)
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000))
        const p = await probeEndpoint(c.baseUrl, { timeoutMs: 1500 })
        if (p.ok) {
          log?.info?.('ASR 服务已就绪')
          return { ok: true, message: '服务起来了', probe: p, mode: diag.mode }
        }
      }

      // 走到这里说明没起来。全退出 + 没输出，多半是脚本自己就失败了。
      const tail = (s) => String(s || '').trim().split('\n').slice(-4).join(' / ')
      const detail = [
        `方式：${diag.mode}`,
        `退出码：${diag.exitCodes.length ? diag.exitCodes.join(',') : '进程还在'}`,
        tail(diag.stderr) ? `错误输出：${tail(diag.stderr)}` : '',
        tail(diag.stdout) ? `普通输出：${tail(diag.stdout)}` : '',
      ].filter(Boolean).join('；')
      log?.warn?.(`ASR 启动失败：${detail}`)
      return {
        ok: false,
        // 把真实原因原样给用户看。含糊的「端点没活」帮不上任何忙 —— 这次就是被它耽误了。
        message: `服务没起来。${detail}`, 
        detail: diag,
      }
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
