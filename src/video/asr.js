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
import { spawn, execFileSync } from 'node:child_process'
/** 本机服务不需要 key（与上游 isLoopback 同一套判据） */
export function isLoopback(baseUrl) {
  try {
    const h = new URL(String(baseUrl)).hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '0.0.0.0'
  } catch {
    return false
  }
}

/**
 * 正在监听某端口的进程（pid → 命令行）。
 *
 * 为什么需要这个：ASR 挂掉时**端口可能还被上一个进程占着**，直接重启会撞端口。
 * 但杀进程绝不能按名字一把梭 —— 用户机器上可能同时跑着别的 whisper / node。
 * 所以只取「监听这个端口的那个 pid」，再由调用方比对命令行是否出自我们自己的配置。
 *
 * 仅 Windows 实现（本插件的托管拉起本来就是 Windows 优先：上游那条 bat 分支也是 win32 才有）。
 * 拿不到就返回空数组 —— 宁可重启失败，也不要误杀。
 */
export function portOwners(port) {
  const n = Number(port)
  if (!Number.isInteger(n) || n <= 0) return []
  const pids = new Set()
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', timeout: 5000 })
      const re = new RegExp(`:${n}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'i')
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(re)
        if (m) pids.add(Number(m[1]))
      }
    } catch {}
  } else {
    try {
      const out = execFileSync('lsof', ['-nP', `-iTCP:${n}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', timeout: 5000 })
      for (const s of out.split(/\s+/)) if (/^\d+$/.test(s)) pids.add(Number(s))
    } catch {}
  }
  if (!pids.size) return []
  return [...pids].map((pid) => ({ pid, cmd: processCmdline(pid) }))
}

/** 取进程命令行；拿不到就返回空串（判断时按「不认识」处理，不杀）。 */
function processCmdline(pid) {
  try {
    if (process.platform === 'win32') {
      // 必须先强制 PowerShell 用 UTF-8 输出，否则中文路径会被按 GBK 写出来、
      // 我们再按 UTF-8 读 → 变成一片问号，全路径比对必然失配（踩过）。
      const out = execFileSync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        '[Console]::OutputEncoding=[Text.Encoding]::UTF8;'
        + `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}').CommandLine`,
      ], { encoding: 'utf8', timeout: 8000, windowsHide: true })
      return String(out || '').trim()
    }
    return String(execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 5000 }) || '').trim()
  } catch {
    return ''
  }
}

/** 结束一个进程（连带子进程）。返回是否成功。 */
function killPid(pid) {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000, windowsHide: true })
    } else {
      process.kill(Number(pid), 'SIGKILL')
    }
    return true
  } catch {
    return false
  }
}

/**
 * 这个进程是不是「我们自己配起来的」。
 *
 * 判据：命令行里出现了配置里某个启动计划里的**有辨识度的**那一段。
 *
 * 「有辨识度」很关键：`['node', 'bridge-asr.mjs']` 里的 `node` 是通用解释器名，
 * 拿它去匹配的话，用户机器上**任何一个 node 进程**都会被认成我们的，
 * 重启时就会把别人的程序全杀掉。所以裸可执行名（node / python / cmd）一律不当身份，
 * 只认带路径分隔符的路径片段，或带扩展名的文件名（.exe/.mjs/.bat…）。
 */
export function ownedByPlan(cmd, plans) {
  const text = String(cmd || '').toLowerCase().replace(/\//g, '\\')
  if (!text) return false
  const looksLikeIdentity = (s) => {
    if (s.length < 4 || s.startsWith('-')) return false
    if (/[\\]/.test(s)) return true                        // 带路径 → 够独特
    return /\.[a-z0-9]{2,5}$/i.test(s)                     // 带扩展名 → 够独特
  }
  for (const plan of plans || []) {
    const parts = Array.isArray(plan) ? plan : [plan]
    for (const part of parts) {
      const s = String(part || '').trim().toLowerCase().replace(/\//g, '\\')
      if (!looksLikeIdentity(s)) continue
      if (text.includes(s)) return true
    }
  }
  return false
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

/**
 * 端点自己报出来的「上游」地址（没有就返回空串）。
 *
 * 本机这套是「适配层监听 8080 + whisper-server 监听 8081」：适配层自己会给
 * /health 回 `{ok:true, upstream:'http://127.0.0.1:8081'}`。也就是说，
 * **8080 通不代表 whisper 活着** —— 真机上就是这么误报「服务起来了」的，
 * 等用户真发语音才 ECONNREFUSED。这里把上游地址抠出来，一并探一遍。
 */
export async function probeUpstream(baseUrl, { timeoutMs = 1500 } = {}) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!base) return ''
  let body = null
  try {
    const r = await fetch(base + '/health', { signal: AbortSignal.timeout(timeoutMs) })
    if (r.ok) body = await r.json()
  } catch {
    return ''
  }
  if (!body || typeof body !== 'object') return ''
  for (const value of Object.values(body)) {
    if (typeof value !== 'string' || !/^https?:\/\/\S+$/i.test(value.trim())) continue
    // 适配层报的往往是「推理路径」而不是根地址（本机就是
    // http://127.0.0.1:8081/audio/transcriptions）。探活要探 origin，
    // 拼上 /health、/v1/models 才能问到点上；把整条路径留下会探成
    // /audio/transcriptions/health，那永远 404。
    try {
      const u = new URL(value.trim())
      return u.origin
    } catch {
      return ''
    }
  }
  return ''
}

/**
 * 扫描 bat 每条命令各自的 start-N.log，找「这条命令压根没跑起来」的硬证据。
 *
 * 为什么要这一步：走 bat 时是 `cmd /c bat`，里面的 `start "" /b` 会把真正的进程
 * 甩到后台、cmd 自己立刻退出（退出码 0）。所以 **bat 模式下进程退出码毫无意义**，
 * 不能用它判成功失败。而日志是重定向到文件的，命令没跑起来时错误就落在那里，
 * 例如 chcp 65001 + 中文 rem 那个坑，日志第一行就是
 * `'b' is not recognized as an internal or external command`。
 *
 * 只认「这条命令压根没执行」的硬标记，避免把程序正常的告警当成失败。
 * @returns {string[]} 每条形如「start-0.log：'b' is not recognized…」
 */
export function scanStartLogs(dir, count) {
  const MARKERS = [
    /is not recognized as an internal or external command/i,
    /不是内部或外部命令/,
    /\bENOENT\b/,
    /No such file or directory/i,
  ]
  const bad = []
  for (let i = 0; i < count; i += 1) {
    const file = join(dir, `start-${i}.log`)
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue // 没这个日志：可能还没写，也可能是直接 spawn（没有重定向）。不算证据。
    }
    const hit = text.split(/\r?\n/).find((line) => MARKERS.some((re) => re.test(line)))
    if (hit) bad.push(`start-${i}.log：${hit.trim().slice(0, 160)}`)
  }
  return bad
}

/**
 * 是不是「数组套数组」（多进程启动配置）。
 * 光看外层是不是数组不够 —— ["node","x.mjs"] 是单进程，[[…],[…]] 才是多进程。
 */
export function isMultiStart(raw) {
  return Array.isArray(raw) && raw.length > 0 && raw.every((x) => Array.isArray(x))
}

/** 把要跑的命令列表说成人话（面板显示、日志都用它） */
export function describePlans(plans) {
  return (plans || [])
    .map((p) => (Array.isArray(p) ? [basename(p[0]), ...p.slice(1)].join(' ') : basename(String(p))))
    .join(' ＋ ')
}

/**
 * 把「多进程启动配置」写成 bat 文件。
 *
 * 为什么不直接往 asr.json 塞数组套数组：
 *   上游 dsh-video-storyboard 的 lifecycleConfig() 只处理一层数组 ——
 *   `Array.isArray(m.start) ? m.start.map(String) : String(m.start)`。
 *   于是 [["a.exe","-x"],["node","b"]] 会被 String() 拍成
 *   "a.exe,-x" 和 "node,b" 两条**逗号串**，再 spawn(第一条, [第二条]) → ENOENT。
 *   2026-11-28 实测就是这个让 DSH 的 host 进程直接 exit 1（那处 spawn 没挂 error 监听，
 *   一个「ASR 起不来」被放大成整个客户端崩溃）。
 *
 *   上游唯一认的多进程写法是「start 是一个字符串，指向 .bat/.cmd」——
 *   这时它走 spawn(start, [], { shell: true })，由 cmd 自己解释里面的 start 命令。
 *   所以嵌套数组只能存在于我们自己的接口里，落盘前必须转成 bat。
 *
 * @returns {{file: string, lines: string[]}}
 */
export function writeStartBat({ dir, plans, log }) {
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`
  // ⚠ 这几行 rem 必须是纯 ASCII，一个中文都不能有（本文件其它地方随便写中文）。
  //   实测（2026-11-28，各跑 4 次）：
  //     中文 rem + chcp 65001 → start 命令 4 次全挂，日志里是 'b' is not recognized...
  //     ASCII rem + chcp 65001 → 4 次全过
  //     ASCII rem 且去掉 chcp   → 4 次全挂（exe 路径里的中文被 GBK 码页戳坏）
  //   两个条件缺一不可。机制：chcp 切换码页后 cmd 重新按字节偏移读这个 UTF-8 文件，
  //   注释里的多字节字符让行边界错位，`/b` 被拆出来当成命令 `b` 执行。
  //   注意中文**路径和参数**在 start 行里是没问题的（B 组实测含中文 exe 路径照样过），
  //   只有 rem 行会触发，所以不要去动 exe/args 的编码。
  const lines = [
    '@echo off',
    'chcp 65001 >nul',
    'rem Generated by dsh-wecom-bot. Edit it from the panel, not by hand:',
    'rem this file is rewritten every time the start config is saved.',
    'rem',
    'rem Multiprocess start has to be a .bat file: upstream only understands one',
    'rem array level, and an array of arrays gets String()-flattened into one',
    'rem comma-joined argument string, which spawn turns into ENOENT',
    'rem (this crashed DSH on 2026-11-28).',
    'rem',
    'rem KEEP EVERY rem LINE ASCII-ONLY. Do not translate these comments.',
    'rem chcp 65001 + a non-ASCII rem line makes cmd split the /b off the start',
    'rem line and fail with: \'b\' is not recognized as an internal command.',
  ]
  plans.forEach((plan, i) => {
    const list = Array.isArray(plan) ? plan : [plan]
    const [exe, ...args] = list.map(String)
    if (!exe) return
    // 每条命令各写一份日志：合成一份会互相覆盖，出问题看不出是哪个先死的。
    const logFile = join(dir, `start-${i}.log`)
    // start "" /b：/b 表示不建新窗口。/b 起的进程在启动器退出后仍然活着（实测过），
    // 而 detached:true 在 Windows 上会弹黑框，上游注释里也明确踩过。
    lines.push(`start "" /b ${q(exe)} ${args.map(q).join(' ')} >> ${q(logFile)} 2>&1`)
  })
  const file = join(dir, 'asr-start.bat')
  mkdirSync(dir, { recursive: true })
  // 自检：**注释行**出现任何非 ASCII 就拒绝生成。理由见上面那段注释 —— 中文 rem
  // 会让 cmd 把 /b 读岔，而失败方式极其隐蔽（bat 自己把错误重定向进日志，exit code 还是 0）。
  // 只查 rem 行、不查整个文件：实测含中文的 exe 路径和参数在 start 行里是完全正常的
  // （本机就是 G:\蓝色大肥鱼\tmp\whisper\...\whisper-server.exe），拦了反而误伤。
  const body = lines.join('\r\n')
  const badLine = lines.find((line) => /^\s*rem\b/i.test(line) && /[^\x00-\x7F]/.test(line))
  if (badLine) {
    throw new Error(`bat 注释里有非 ASCII 字符，会把 start 命令读坏：${badLine.slice(0, 60)}`)
  }
  // 必须是 CRLF：LF 行尾的 bat 会被 cmd.exe 读坏（把注释里的中文当命令执行），
  // 而且 exit code 还是 0，看起来像成功。这个坑上游和本插件都踩过。
  writeFileSync(file, body + '\r\n', 'utf8')
  // 旁车：把原始命令列表留在旁边，面板显示时才能把 bat 还原成「程序名 参数」，
  // 否则用户只能看到一行 "asr-start.bat"，不知道里面起的是什么。
  try {
    writeFileSync(join(dir, 'asr-start.plans.json'), JSON.stringify(plans, null, 2), 'utf8')
  } catch {}
  log?.info?.(`ASR：多进程启动配置已生成为 ${file}（上游只认 bat）`)
  return { file, lines }
}

/** 读 bat 旁边的命令清单（没有就返回 null）。给面板显示用。 */
export function readStartPlans(batFile) {
  try {
    const raw = JSON.parse(readFileSync(join(dirname(batFile), 'asr-start.plans.json'), 'utf8'))
    return Array.isArray(raw) ? raw : null
  } catch {
    return null
  }
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

  /**
   * 把已经落盘的「数组套数组」自愈成 bat。
   *
   * 为什么要自愈：asr.json 在我们把它改成 bat 之前就可能已经被写成嵌套数组了
   * （旧版本写的、用户手改的、或者从别的机器带过来的）。上游读到嵌套数组就会
   * spawn 一个逗号串、ENOENT、**整个 DSH host 崩掉**（下游那处 spawn 没有 error 监听）。
   * 所以每次读配置都得检查一遍，发现就立刻修，不等用户去点保存。
   */
  function healNestedStart(cfg) {
    const raw = cfg?.manage?.start
    if (!isMultiStart(raw)) return { cfg, healed: false }
    const plans = raw.map((c) => (Array.isArray(c) ? c.map(String) : [String(c)])).filter((c) => c[0])
    try {
      const { file } = writeStartBat({ dir: join(homeDir(), 'wecom-asr'), plans, log })
      // 原始命令清单也存进 asr.json。上游 lifecycleConfig 只认 start，多余的键它不看，
      // 所以这份清单是安全的；而它的价值在于 —— bat 被误删/被清理工具扫掉时，
      // 我们还能照着清单把 bat 重新生成出来，不至于让托管启动变成一条死路。
      const next = { ...cfg, manage: { ...(cfg.manage || {}), start: file, startPlans: plans } }
      const out = writeConfig(next)
      if (!out.ok) return { cfg, healed: false }
      log?.warn?.(
        `ASR：asr.json 里的启动配置是「数组套数组」，上游不支持这种写法`
        + `（会被拍成逗号串、spawn ENOENT，能把 DSH 整个搞崩）。已自动改写成 ${file}。`
        + ` 想改启动参数请回面板改，别手改 asr.json。`,
      )
      return { cfg: next, healed: true }
    } catch (error) {
      log?.warn?.(`ASR：asr.json 里是嵌套数组但自动改写成 bat 失败了（${error.message}），先不碰它`)
      return { cfg, healed: false }
    }
  }

  /**
   * bat 文件不见了就照着 asr.json 里存的 startPlans 重新生成。
   *
   * 真机踩过：手动删掉 wecom-asr/asr-start.bat 之后，asr.json 还指着那个路径，
   * 于是每次启动都是 cmd /c <不存在的 bat> → 退出码 1、等满 90 秒才报错，
   * 而用户完全不知道问题在哪。这种「配置引用的文件被别人删了」必须能自愈。
   */
  function healMissingBat(cfg) {
    const raw = cfg?.manage?.start
    if (typeof raw !== 'string' || !/\.(bat|cmd)$/i.test(raw)) return { cfg, healed: false }
    if (existsSync(raw)) return { cfg, healed: false }
    const plans = Array.isArray(cfg?.manage?.startPlans) ? cfg.manage.startPlans : null
    if (!isMultiStart(plans)) return { cfg, healed: false }
    try {
      const { file } = writeStartBat({ dir: join(homeDir(), 'wecom-asr'), plans, log })
      const next = { ...cfg, manage: { ...(cfg.manage || {}), start: file, startPlans: plans } }
      const out = writeConfig(next)
      if (!out.ok) return { cfg, healed: false }
      log?.warn?.(`ASR：启动脚本 ${raw} 不见了（可能被清理工具删了），已照 asr.json 里存的命令重建为 ${file}`)
      return { cfg: next, healed: true }
    } catch (error) {
      log?.warn?.(`ASR：启动脚本 ${raw} 不见了，重建也失败了（${error.message}）`)
      return { cfg, healed: false }
    }
  }

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

  /** 读配置并顺手自愈（所有对外入口都走这个，别再直接调 readConfig） */
  function readConfigSafe() {
    const { cfg } = healMissingBat(healNestedStart(readConfig()).cfg)
    return cfg
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
    const c = readConfigSafe()
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
    const cur = readConfigSafe()
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
      // 三种写法：字符串 / 字符串数组（单进程）/ 数组的数组（多进程）。
      // 前两种原样落盘；多进程必须先转成 bat（见 writeStartBat 的注释），
      // 因为上游 lifecycleConfig() 会把嵌套数组 String() 成逗号串，spawn 直接 ENOENT。
      const raw = patch.manageStart
      const list = Array.isArray(raw)
        ? raw.map((x) => (Array.isArray(x) ? x.map(String) : String(x))).filter((x) => (Array.isArray(x) ? x[0] : x))
        : String(raw || '').trim()
      const empty = Array.isArray(list) ? list.length === 0 : !list
      if (!empty) {
        let startValue = list
        let plans = null
        if (isMultiStart(list)) {
          try {
            startValue = writeStartBat({ dir: join(homeDir(), 'wecom-asr'), plans: list, log }).file
          } catch (error) {
            return { ok: false, message: `多进程启动配置转 bat 失败：${error.message}` }
          }
          plans = list
        }
        next.manage = { ...(cur.manage || {}), start: startValue }
        // 多进程才存清单（bat 被删时靠它重建）；单进程/字符串没有这个必要。
        if (plans) next.manage.startPlans = plans
        else delete next.manage.startPlans
      } else if (next.manage) {
        delete next.manage.start
        delete next.manage.startPlans
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
   * 落盘成 bat 的多进程配置，从旁车 asr-start.plans.json 还原成「程序名 参数」。
   */
  function describeStart(raw) {
    if (typeof raw === 'string' && /\.(bat|cmd)$/i.test(raw)) {
      const plans = readStartPlans(raw)
      if (plans) return describePlans(plans)
    }
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
      const c = readConfigSafe()
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
          // 端点通了不等于真能用。分三种情况：
          //   · 走 bat：cmd 立刻退出（退出码 0），退出码毫无意义，只能看 start-*.log
          //   · 直接 spawn：进程还在 = 真的在加载模型；全退了就是失败
          // 两种都先给 2 秒宽限，有的批处理会先退出再 fork 出真正干活的进程。
          const isBatMode = /^cmd \/c /.test(diag.mode || '')
          const batDir = isBatMode ? dirname(String(diag.mode).slice('cmd /c '.length).split(' + ')[0]) : ''
          const evaluate = () => {
            if (isBatMode) {
              const bad = scanStartLogs(batDir, diag.pids.length)
              return bad.length ? `启动日志里报错了（${bad.join('；')}）` : ''
            }
            const codes = diag.exitCodes.filter((x) => x !== null && x !== undefined)
            if (codes.length >= diag.pids.length && diag.pids.length > 0) {
              return codes.every((x) => x === 0)
                ? '拉起来的进程都正常退出了（退出码 0），真正要跑的程序没跑起来'
                : `拉起来的进程退出了（退出码 ${codes.join(',')}）`
            }
            return ''
          }
          const gap = evaluate()
          if (gap) {
            await new Promise((r) => setTimeout(r, 2000))
            const again = evaluate()
            if (again) {
              log?.warn?.(`ASR 端点通了但${again}`)
              return {
                ok: false,
                // 这里必须报错，不能假装成功 —— 用户接下来发语音才会发现更晚、更难查。
                message: `端口通了，但${again}。${diag.mode ? `方式：${diag.mode}。` : ''}`
                  + '常见原因：模型路径含中文、模型文件不在那个位置、或端口被别的程序占了。',
                detail: diag,
                probe: p,
              }
            }
          }
          // 最后一关：端点可能只是个「转发层」，真正的上游还没活。本机就是 8080 → 8081。
          const upstream = await probeUpstream(c.baseUrl)
          if (upstream && upstream.replace(/\/+$/, '') !== c.baseUrl.replace(/\/+$/, '')) {
            let up = await probeEndpoint(upstream, { timeoutMs: 1500 })
            if (!up.ok) {
              // 上游加载大模型要十几秒，给足时间再判死，别误杀。
              const upDeadline = Date.now() + Math.min(Math.max(5000, waitMs), 60000)
              while (!up.ok && Date.now() < upDeadline) {
                await new Promise((r) => setTimeout(r, 1000))
                up = await probeEndpoint(upstream, { timeoutMs: 1500 })
              }
            }
            if (!up.ok) {
              log?.warn?.(`ASR：${c.baseUrl} 通了，但它后面真正的服务 ${upstream} 没起来`)
              return {
                ok: false,
                message: `${c.baseUrl} 这个地址是自己应答的（转发层），它后面真正的服务 ${upstream} 没起来。`
                  + '看 wecom-asr 目录下 start-*.log 里第一个程序报了什么。',
                detail: diag,
                probe: p,
              }
            }
          }
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

  /**
   * 重启：先杀掉占着端口的「我们自己的」进程，再重新起。
   *
   * 为什么必须杀：ASR 这套是「适配层 8080 + whisper 8081」两个进程。
   * whisper 挂掉时适配层往往还活着，端口 8080 照样回 /health 200 —— 上游
   * ensureAsr 探到这里就认定服务正常，于是它自己**永远不会重启**。
   * 直接再 spawn 一份也会撞端口。所以只能先清掉残留。
   *
   * 杀谁：只杀命令行里能匹配到我们自己 startPlans 的进程（见 ownedByPlan）。
   * 用户机器上可能还跑着别的 whisper / node，按名字一把梭会误伤。
   */
  async function restart({ waitMs = 90000 } = {}) {
    const c = readConfigSafe()
    const baseUrl = String(c.baseUrl || '').trim()
    if (!baseUrl) return { ok: false, message: '没配 ASR 地址，无从重启' }
    // 判断「这进程是不是我们的」必须拿**真实命令**，不能拿 manage.start ——
    // 多进程配置落盘后 start 只是个 bat 路径，拿它去比对进程命令行永远对不上，
    // 结果就是「一个也没杀」然后撞端口（真机踩过）。真实命令在 startPlans 里。
    const plans = isMultiStart(c.manage?.startPlans)
      ? c.manage.startPlans
      : parseStart(c.manage?.start)
    // 端口：从 baseUrl 与它背后真正的上游各取一个。适配层和 whisper 都要清。
    const ports = new Set()
    const addPort = (u) => {
      try {
        const p = Number(new URL(String(u)).port)
        if (p) ports.add(p)
      } catch {}
    }
    addPort(baseUrl)
    const upstream = await probeUpstream(baseUrl).catch(() => '')
    if (upstream) addPort(upstream)

    const killed = []
    const skipped = []
    for (const port of ports) {
      for (const item of portOwners(port)) {
        if (ownedByPlan(item.cmd, plans)) {
          if (killPid(item.pid)) killed.push({ pid: item.pid, port })
          else skipped.push({ pid: item.pid, port, why: '杀不掉' })
        } else {
          skipped.push({ pid: item.pid, port, why: '命令行对不上我们的启动配置' })
        }
      }
    }
    if (killed.length) {
      log?.info?.(`ASR 重启：先停掉残留进程 ${killed.map((k) => `${k.pid}(端口 ${k.port})`).join('、')}`)
      // 等端口真的松开，否则紧接着的 spawn 会撞上 TIME_WAIT / 还被占
      await new Promise((r) => setTimeout(r, 800))
    }
    if (skipped.length) {
      log?.warn?.(
        'ASR 重启：有进程占着端口但没动它（'
        + skipped.map((s) => `${s.pid} 端口 ${s.port}：${s.why}`).join('；')
        + '）。如果不是你启动的，可能得手动处理。',
      )
    }
    const out = await start({ waitMs })
    return { ...out, killed, skipped }
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

  return { status, save, start, restart, useDiscovered, installHint, configFile }
}
