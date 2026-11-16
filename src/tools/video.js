// 看视频：直接用 dsh-video-storyboard 的公开库入口，把它那套工具原样接管过来。
//
// 为什么这么接（三种做法里选第三种）：
//   1. 依赖它的 cordis 插件 —— 不行。它 `inject=['tools']` 是硬前缀，服务没就绪 apply 就不执行，
//      插件会永远卡在「加载中」；而且它还会注册自己的设置页、跟自己那套配置打架。
//   2. 自己抄一遍管线 —— 不行。它的 schema 里有一堆调优参数（tierMap、cutFloor、budget…），
//      抄一半就漂了，上游一改就跟不上。
//   3. **import 它的 `storyboard/register.js`，拿它的 `storyboardTools(defineTool, ctx)`** —— 选这个。
//      它自己就是这么被 `src/index.js` 用的，等于我们冒充了一次它的宿主入口。
//
// ⚠ `storyboardTools` 不是 package.json 的公开 exports 子路径的一部分（只暴露了 "./storyboard"），
//   所以这里靠 `require.resolve('dsh-video-storyboard/package.json')` 找安装目录，再拼
//   `src/storyboard/register.js`。上游若改文件结构，这里会失效 → 失效时降级成「没有看视频能力」，
//   绝不让 apply 抛（apply 抛出去 = 整个插件静默不注册，更难查）。
//
// ⚠ 它的工具要 `ctx.attachments.saveImage()` 才能把分镜图提交成附件。我们的 ctx 有 attachments
//   （inject 里声明了），但它是 cordis 服务的 Proxy —— 用 try/catch 包住探测，拿不到就让它自己降级成纯文本。

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 找 dsh-video-storyboard 的安装目录：先本插件，再 DSH profile，再环境变量。 */
export function findVideoPlugin({ extraPaths = [] } = {}) {
  const tries = []
  const push = (base) => { if (base) tries.push(base) }
  push(process.env.DSH_VIDEO_STORYBOARD_DIR)
  for (const base of extraPaths) push(base)
  push(process.cwd())
  try {
    const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
    push(join(home, 'profiles', 'desktop', 'node_modules'))
    push(join(home, 'node_modules'))
  } catch {}
  for (const base of tries) {
    try {
      const req = createRequire(join(base, 'noop.js'))
      const pkgPath = req.resolve('dsh-video-storyboard/package.json')
      const dir = dirname(pkgPath)
      const reg = join(dir, 'src', 'storyboard', 'register.js')
      if (existsSync(reg)) return { dir, register: reg, spec: join(dir, 'src', 'storyboard', 'tool-spec.js') }
    } catch {}
  }
  return null
}

/** ffmpeg 在不在。它自己的定位顺序很长，这里只做「有没有」的粗判，用来给面板提示。 */
export function findFfmpeg({ dataDir } = {}) {
  const cands = []
  const home = process.env.DSH_HOME || ''
  if (process.env.DSH_FFMPEG_PATH) cands.push(process.env.DSH_FFMPEG_PATH)
  if (process.env.FFMPEG_PATH) cands.push(process.env.FFMPEG_PATH)
  if (process.env.DSH_FFMPEG_DIR) cands.push(join(process.env.DSH_FFMPEG_DIR, 'ffmpeg.exe'))
  if (home) {
    cands.push(join(home, 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe'))
    cands.push(join(home, 'bin', 'ffmpeg.exe'))
  }
  if (dataDir) cands.push(join(dataDir, 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe'))
  const hit = cands.find((p) => p && existsSync(p))
  return hit || ''
}

/**
 * 把上游的 author spec（`parameters` 是「属性名 → 值 schema，required 写在属性里」）
 * 编译成宿主 `register()` 认的 JSON Schema（`properties` + 顶层 `required` 数组）。
 */
function compileAuthorSpec(spec) {
  const properties = {}
  const required = []
  for (const [key, value] of Object.entries(spec.parameters || {})) {
    if (!value || typeof value !== 'object') continue
    const { required: mark, ...rest } = value
    if (mark === true) required.push(key)
    properties[key] = compileValue(rest)
  }
  const parameters = { type: 'object', properties, additionalProperties: false }
  if (required.length) parameters.required = required
  return parameters
}

function compileValue(spec) {
  const out = {}
  for (const [k, v] of Object.entries(spec || {})) {
    if (k === 'required') continue
    if (k === 'properties') {
      const { properties, required } = compileAuthorSpec({ parameters: v })
      out.properties = properties
      if (required) out.required = required
      continue
    }
    if (k === 'items') { out.items = compileValue(v); continue }
    if (k === 'type' && v === 'json') continue
    out[k] = v
  }
  return out
}

/**
 * output 与 parameters 用同一套 author spec 口径，所以要同样编译一遍。
 * schema 之外的字段（render 等）原样保留。
 */
function compileOutputSpec(output) {
  const { schema, ...rest } = output || {}
  if (!schema || typeof schema !== 'object') return rest
  const { properties, required, ...others } = schema
  const compiled = compileValue(others)
  if (properties && typeof properties === 'object') {
    const c = compileAuthorSpec({ parameters: properties })
    compiled.properties = c.properties
    if (c.required.length) compiled.required = c.required
  }
  if (compiled.required === undefined && Array.isArray(required) && required.length) compiled.required = required
  return { ...rest, schema: compiled }
}

/**
 * 造一套视频工具。
 *
 * 返回值从「数组」改成「带诊断的结构」——因为原来失败时全返回 `[]`，
 * 面板和 /state 完全看不出是「没装」「加载失败」还是「schema 编译失败」，
 * 真机上就出现过「日志说已接上、实际六个工具全挂不上」还查不出来的情况。
 *
 * @param {{ctx:object, log:object}} o
 * @returns {Promise<{ok:object[], failed:object[], reason:string, dir:string, ffmpeg:string}>}
 */
export async function buildVideoTools({ ctx, log } = {}) {
  const none = (reason) => ({ ok: [], failed: [], reason, dir: '', ffmpeg: '' })
  const found = findVideoPlugin()
  if (!found) {
    log?.warn?.('没找到 dsh-video-storyboard，看视频能力不可用（装它或忽略）')
    return none('没装 dsh-video-storyboard')
  }
  const ffmpeg = findFfmpeg()
  let mod
  try {
    mod = await import(pathToFileURL(found.register).href)
  } catch (error) {
    log?.warn?.(`加载看视频能力失败：${error.message}`)
    return { ...none(`加载失败：${error.message}`), dir: found.dir, ffmpeg }
  }
  if (typeof mod.storyboardTools !== 'function') {
    log?.warn?.('dsh-video-storyboard 版本不对（没有 storyboardTools），看视频能力跳过')
    return { ...none('上游版本不对（没有 storyboardTools）'), dir: found.dir, ffmpeg }
  }

  // 冒充它的宿主 defineTool：只做「author spec → JSON Schema」，其余（render/timeout/并发）原样保留
  const defineTool = (spec) => {
    const tool = {
      name: spec.name,
      description: spec.description,
      parameters: compileAuthorSpec(spec),
    }
    // output 也要编译：上游 author spec 把 required 写在属性里（text: { required: true }），
    // 宿主只认顶层 required 数组 —— 原样透传会被判 unsupported JSON schema，六个工具全都挂不上。
    if (spec.output) tool.output = compileOutputSpec(spec.output)
    if (spec.timeoutMs) tool.timeoutMs = spec.timeoutMs
    if (typeof spec.isConcurrencySafe === 'function') tool.isConcurrencySafe = spec.isConcurrencySafe
    tool.execute = async (args, exec) => {
      try {
        return await spec.execute(args, exec)
      } catch (error) {
        // 工具异常不该把整个 turn 炸掉；上游文案通常是给人看的，原样往上抛更利于排查
        throw error
      }
    }
    return tool
  }

  let tools = []
  try {
    tools = mod.storyboardTools(defineTool, ctx)
  } catch (error) {
    log?.warn?.(`注册看视频工具失败：${error.message}`)
    return { ...none(`注册失败：${error.message}`), dir: found.dir, ffmpeg }
  }
  log?.info?.(`看视频能力已接上（${found.dir}）：${tools.map((t) => t.name).join(', ')}`)
  return { ok: tools, failed: [], reason: '', dir: found.dir, ffmpeg }
}
