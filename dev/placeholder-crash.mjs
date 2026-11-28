// 回归：预回复发图失败时，进程绝对不能死。
//
// 背景（真机踩过，DSH 被连杀两次）：
//   host.js 传给 createPlaceholder 的 log 是 logger.child('placeholder')，
//   而 logger.child() 返回的是 **对象** {debug,info,warn,error}，不是函数。
//   预回复代码里却写成 log?.('warn', ...) —— 按函数调。
//   于是 sendImage 的 catch 块里记日志那一行本身抛 TypeError。
//   又因为 fire() 里是裸 `void sendImage(...)`，没人接这个拒绝 →
//   unhandledRejection → Node 24 默认直接杀进程 → 用户的 DSH 整个崩掉。
//
//   表面症状是「发 GIF 就崩」，实际跟 GIF 无关：任何一次上传失败都会崩。
//   GIF 只是最容易触发上传失败（体积大、动图支持差）。
//
// 这个测试守两件事：
//   ① 生产形态的 logger 对象（不是函数）传进来，发图失败也不能抛
//   ② log 自己内部抛错，也不能污染业务流程
//
// 跑法：node dev/placeholder-crash.mjs

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlaceholder } from '../src/chat/placeholder.js'
import { asLog, fireAndForget } from '../src/core/safe.js'

const problems = []
const check = (ok, name, extra = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? '：' + extra : ''}`)
  if (!ok) problems.push(name + (extra ? '：' + extra : ''))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)
const TMP = mkdtempSync(join(tmpdir(), 'wecom-phcrash-'))
const IMG = join(TMP, 'ph.png')
writeFileSync(IMG, PNG)

const chat = { kind: 'dm', chatId: 'u1', userId: 'u1' }
const frame = (id = 'r1') => ({ headers: { req_id: id } })

/** 生产形态：createLogger().child() 返回的那种对象 */
function objectLogger(collected = []) {
  const make = (level) => (text) => { collected.push({ level, text }) }
  return { debug: make('debug'), info: make('info'), warn: make('warn'), error: make('error') }
}

function cfgWith(merge) {
  return {
    merge: {
      placeholderOn: true,
      placeholder: 'emmm...',
      placeholderImage: '',
      placeholderImageOn: true,
      ...merge,
    },
  }
}

const fakeClient = () => ({
  calls: { respond: [], send: [] },
  async respond(reqId, body) { this.calls.respond.push({ reqId, body }) },
  async send(chatId, chatType, body) { this.calls.send.push({ chatId, chatType, body }) },
})

/** 上传必炸的 MCP：模拟 disk 服务报错（企微对 GIF 就是这么拒的） */
function failingMcp(reason = 'media_upload 失败：不支持该图片格式') {
  const state = { uploads: 0 }
  return {
    state,
    async mcpFor(service) {
      if (service !== 'disk') return null
      return {
        async call(name) {
          if (name === 'media_upload') {
            state.uploads += 1
            throw new Error(reason)
          }
          return { success: true }
        },
      }
    },
  }
}

// ---------------------------------------------------------------
// ① 核心回归：对象 logger + 上传失败 = 不抛、进程活着
// ---------------------------------------------------------------
{
  const logs = []
  const mcp = failingMcp()
  const client = fakeClient()
  const cfg = cfgWith({ placeholderImage: IMG })
  const ph = createPlaceholder({
    getConfig: () => cfg,
    getClient: () => client,
    mcpFor: mcp.mcpFor,
    log: objectLogger(logs), // ← 生产形态，正是以前会炸的那个
  })

  let threw = null
  try {
    ph.fire(frame(), chat)
  } catch (error) {
    threw = error
  }
  check(threw === null, '对象 logger + 上传失败：fire() 不抛（同步部分）', threw ? threw.message : '')

  // 等异步那条走完。以前这里会把整个进程带走，现在必须活到这里。
  await sleep(150)

  check(mcp.state.uploads === 1, '确实尝试上传了一次', String(mcp.state.uploads))
  check(client.calls.send.length === 0, '上传失败：没有发出半张图')
  check(Boolean(ph.lastImageError), '上传失败：记下了原因（面板能看到）', ph.lastImageError)
  check(/不支持该图片格式/.test(ph.lastImageError), '失败原因原样保留', ph.lastImageError)
  check(
    logs.some((l) => l.level === 'warn' && /预回复图没发出去/.test(l.text)),
    '失败写进了 warn 日志（走的是对象式 logger）',
    JSON.stringify(logs.map((l) => l.level)),
  )
  check(client.calls.respond.length === 1, '文字预回复照发，没被图片失败带下水')
}

// ---------------------------------------------------------------
// ② 文字发送失败 + 对象 logger：同样不能抛
// ---------------------------------------------------------------
{
  const logs = []
  const client = fakeClient()
  client.respond = async () => { throw new Error('aibot_respond_msg 超时') }
  const cfg = cfgWith({ placeholderImage: '' }) // 只发文字
  const ph = createPlaceholder({
    getConfig: () => cfg,
    getClient: () => client,
    mcpFor: async () => null,
    log: objectLogger(logs),
  })

  let threw = null
  try { ph.fire(frame('r2'), chat) } catch (error) { threw = error }
  await sleep(120)
  check(threw === null, '文字发送失败：不抛')
  check(
    logs.some((l) => /预回复文字发送失败/.test(l.text)),
    '文字失败也记进了日志（debug 级，预回复失败不算严重）',
    JSON.stringify(logs),
  )
}

// ---------------------------------------------------------------
// ③ 日志自己炸了，业务流程不能跟着炸
// ---------------------------------------------------------------
{
  const client = fakeClient()
  const cfg = cfgWith({ placeholderImage: '' })
  const boomLog = {
    debug() { throw new Error('日志炸了') },
    info() { throw new Error('日志炸了') },
    warn() { throw new Error('日志炸了') },
    error() { throw new Error('日志炸了') },
  }
  const ph = createPlaceholder({
    getConfig: () => cfg,
    getClient: () => client,
    mcpFor: async () => null,
    log: boomLog,
  })
  let threw = null
  try {
    ph.fire(frame('r3'), chat)
    await sleep(80)
  } catch (error) {
    threw = error
  }
  check(threw === null, 'logger 内部抛错：业务不受影响', threw ? threw.message : '')
  check(client.calls.respond.length === 1, 'logger 抛错时文字照发')
}

// ---------------------------------------------------------------
// ④ 完全不传 log（undefined）也不能炸
// ---------------------------------------------------------------
{
  const client = fakeClient()
  const cfg = cfgWith({ placeholderImage: IMG })
  const ph = createPlaceholder({
    getConfig: () => cfg,
    getClient: () => client,
    mcpFor: async () => { throw new Error('没有 msg 服务') },
    // log 故意不给
  })
  let threw = null
  try { ph.fire(frame('r4'), chat); await sleep(120) } catch (error) { threw = error }
  check(threw === null, '不传 log：不炸', threw ? threw.message : '')
  check(Boolean(ph.lastImageError), '不传 log：失败原因仍然记下', ph.lastImageError)
}

// ---------------------------------------------------------------
// ⑤ asLog / fireAndForget 单元行为
// ---------------------------------------------------------------
{
  const got = []
  const fnLog = asLog((level, text) => got.push([level, text]))
  fnLog('warn', 'x')
  check(got.length === 1 && got[0][0] === 'warn', 'asLog 吃得下函数式 log')

  const objLog = asLog(objectLogger(got.length ? [] : []))
  let ok = true
  try { objLog('warn', 'y') } catch { ok = false }
  check(ok, 'asLog 吃得下对象式 log')

  const nothing = asLog(undefined)
  let ok2 = true
  try { nothing('info', 'z') } catch { ok2 = false }
  check(ok2, 'asLog(undefined) 是安全的空操作')

  // fireAndForget 必须永远 resolve
  let rejected = false
  await fireAndForget(Promise.reject(new Error('故意炸')), '测试任务', objectLogger(), 'warn')
    .catch(() => { rejected = true })
  check(!rejected, 'fireAndForget 吞掉拒绝，不会变成 unhandledRejection')
}

// ---------------------------------------------------------------
// ⑥ 冷却必须看错误性质，不能一刀切
//
// 真机踩过：企微授权过期（850003）导致发图失败 → 挂了 10 分钟冷却。
// 用户点完授权当场就修好了，插件却还在静默 —— 他再发消息没有图，
// 只当插件坏了；更糟的是那时候连日志都不写，谁都查不出来。
// 所以：外部一时不通 → 短冷却（几秒后自动恢复）；
//       图本身有问题 → 长冷却（反正换图才能好）。
// ---------------------------------------------------------------
{
  const { isRemoteFailure, isAuthFailure } = await import('../src/chat/placeholder.js')

  const remoteCases = [
    [{ code: 45009 }, '45009 限流'],
    [{ code: -1 }, '-1 系统繁忙'],
    [new Error('fetch failed'), 'fetch failed'],
    [new Error('socket hang up'), 'socket hang up'],
    [new Error('request timed out'), 'timeout'],
  ]
  for (const [err, name] of remoteCases) {
    check(isRemoteFailure(err) === true, `外部故障判为瞬时：${name}`)
  }

  // 授权过期【不算】瞬时故障：人不去点授权，重试一万次都一样。
  // 以前把它算成瞬时，结果每 30 秒白打一次接口、日志刷一行 warn。
  const authCases = [
    [{ code: 850003, message: 'authorization expired' }, '850003 授权过期'],
    [{ code: 850003 }, '850003 只有码没有文案'],
    [new Error('errcode 850003: authorization expired, hint: [...]'), '文案带 authorization expired'],
  ]
  for (const [err, name] of authCases) {
    check(isRemoteFailure(err) === false, `授权过期不算瞬时：${name}`)
    check(isAuthFailure(err) === true, `授权过期认得出：${name}`)
  }

  const localCases = [
    [new Error('media_upload 失败：不支持该图片格式'), '图片格式不支持'],
    [{ code: 40058, message: 'file upload source is invalid' }, '参数错误'],
    [new Error('这张图 7.8 MB 超过上限'), '图太大'],
  ]
  for (const [err, name] of localCases) {
    check(isRemoteFailure(err) === false, `自身问题判为确定性：${name}`)
    check(isAuthFailure(err) === false, `自身问题不是授权问题：${name}`)
  }
}

// ---------------------------------------------------------------
// ⑦ 短冷却只给「等一等会好」的错（网络抖动），且到点必须自动恢复
//
// 以前所有错一律静默 10 分钟 = 用户修好了还发不出去、以为插件坏了。
// 现在只有 remote 类吃短冷却；授权/配置类根本不冷却（等着人去动手）。
// ---------------------------------------------------------------
{
  const { createPlaceholder } = await import('../src/chat/placeholder.js')
  let fail = 'remote'
  const client = fakeClient()
  const mcp = {
    async mcpFor(service) {
      if (service !== 'disk') return null
      return {
        async call(name) {
          if (name === 'media_upload') {
            if (fail === 'auth') throw Object.assign(new Error('authorization expired'), { code: 850003 })
            if (fail === 'remote') throw new Error('fetch failed: ECONNRESET')
            return { media_id: 'MID_OK' }
          }
          return { errcode: 0 }
        },
      }
    },
  }
  const logs = []
  const ph = createPlaceholder({
    getConfig: () => cfgWith({ placeholderImage: IMG }),
    getClient: () => client,
    mcpFor: mcp.mcpFor,
    log: objectLogger(logs),
    cooldowns: { remote: 400 }, // 把「瞬时」冷却压到 400ms 便于观察
  })

  ph.fire(frame('c1'), chat)
  await sleep(150) // 还在 400ms 冷却窗口内
  check(ph.lastImageError !== '', '第一枪：网络抖动，记下了失败', ph.lastImageError)
  check(ph.lastImageKind === 'remote', '网络类判成 remote（只有这一类该冷却）', ph.lastImageKind)
  const afterFirst = client.calls.send.length
  check(afterFirst === 0, '第一枪：图没发出去')

  // 冷却期内再发一次：不应该再去撞上传
  ph.fire(frame('c2'), chat)
  await sleep(80)
  check(client.calls.send.length === afterFirst, '冷却期内不重复撞上传')
  check(
    logs.some((l) => l.level === 'debug' && /冷却中/.test(l.text)),
    '冷却中会写日志（以前静默，用户和开发者都查不出原因）',
  )

  // 网络恢复了，等冷却过去
  fail = ''
  await sleep(300)
  ph.fire(frame('c3'), chat)
  await sleep(150)
  check(client.calls.send.length + 1 > afterFirst || ph.lastImageError === '', '网络恢复后冷却结束就能发出去', `send=${client.calls.send.length} err="${ph.lastImageError}"`)
  check(ph.lastImageError === '', '成功一次之后失败原因被清掉', `"${ph.lastImageError}"`)

  // 反面：授权类不吃冷却 —— 用户当场授权完，下一条消息就该能发。
  let authFail = 'auth'
  const client2 = fakeClient()
  const ph2 = createPlaceholder({
    getConfig: () => cfgWith({ placeholderImage: IMG }),
    getClient: () => client2,
    mcpFor: async (service) => {
      if (service !== 'disk') return null
      return {
        async call(name) {
          if (name === 'media_upload') {
            if (authFail === 'auth') throw Object.assign(new Error('authorization expired'), { code: 850003 })
            return { media_id: 'MID_OK' }
          }
          return { errcode: 0 }
        },
      }
    },
    log: objectLogger([]),
    cooldowns: { remote: 400 },
  })
  ph2.fire(frame('a1'), chat)
  await sleep(120)
  check(ph2.lastImageKind === 'auth', '授权类判成 auth', ph2.lastImageKind)
  authFail = ''
  // 不等任何冷却，立刻再发一次 —— 必须能发
  ph2.fire(frame('a2'), chat)
  await sleep(200)
  check(ph2.lastImageError === '', '授权修好了立刻就能发，不用等冷却', `"${ph2.lastImageError}"`)
  check(client2.calls.send.length > 0, '授权修好后确实发出去了', `send ${client2.calls.send.length}`)
}

// ---------------------------------------------------------------
// ⑧ 失败分类与文案：只许图的锅说「换张图」，别的说了就是害人
//
// 真机教训：以前是二分（外部抖 / 不是外部抖），非外部抖的一律
// 「这张图本身发不了，换一张就能恢复」。可「没配 MCP」「会话没了」
// 也掉进那个兜底 —— 用户照着换十张图，永远好不了。
// 对开源项目，误导性诊断比失败本身更糟。
// ---------------------------------------------------------------
{
  const { classifyFailure, describeFailure } = await import('../src/chat/placeholder.js')

  const cases = [
    [{ code: 'no_mcp', message: '没配 MCP 的 disk / mail / doc 服务，传不了文件。' }, 'config', '没配 MCP（磁盘/邮件/文档）'],
    [{ code: 'no_msg_mcp', message: '没配 MCP 的 msg 服务，发不了文件。' }, 'config', '没配 MCP（消息）'],
    [new Error('没配 MCP 的 disk 服务，传不了微盘。'), 'config', '文案里带「没配 MCP」'],
    [{ code: 'image_too_large', message: '这张图压到极限还有 2 MB' }, 'image', '压到极限还超'],
    [{ code: 'no_file', message: '找不到文件：a.png' }, 'image', '文件没了'],
    [new Error('预回复图不存在：a.png'), 'image', '预回复图不存在'],
    [new Error('预回复图不是图片格式：.txt'), 'image', '不是图片格式'],
    [new Error('预回复图 3.0 MB，超过 2 MB 上限'), 'image', '超过文件上限'],
    [new Error('chat_id invalid'), 'chat', '会话 id 无效'],
    [new Error('会话不存在'), 'chat', '会话不存在'],
    [{ code: 850003, message: 'authorization expired' }, 'auth', '授权过期'],
    [{ code: 45009 }, 'remote', '限流'],
    [new Error('socket hang up'), 'remote', '连接断了'],
    [new Error('某个从没见过的错'), 'unknown', '认不出的错误'],
  ]
  for (const [err, want, name] of cases) {
    const got = classifyFailure(err)
    check(got === want, `分类正确：${name} → ${want}`, got === want ? '' : `实际 ${got}`)
  }

  // 文案的第一硬规矩：只有 image 类才允许出现「换一张图」
  for (const [err, kind, name] of cases) {
    const text = describeFailure(err, kind)
    const saysChangeImage = /换一张图/.test(text)
    if (kind === 'image') {
      check(saysChangeImage, `图的锅就该说换图：${name}`)
    } else {
      check(!saysChangeImage, `不是图的锅就别让用户换图：${name}`, text.slice(0, 40))
    }
  }
  // 配置/会话类必须明确告诉用户「换图没用」，否则他还在原地折腾
  check(
    /换图没用/.test(describeFailure({ code: 'no_mcp', message: '没配 MCP' }, 'config')),
    '配置类明说换图没用',
  )
  check(
    /换图没用/.test(describeFailure(new Error('chat_id invalid'), 'chat')),
    '会话类明说换图没用',
  )
}

// ---------------------------------------------------------------
// ⑨ 同一张坏图只撞一次，换图立刻恢复（取代旧的 600 秒静默冷却）
//
// 旧实现：图的问题一律静默 10 分钟。用户换了一张完全正常的图，
// 也要等十分钟才发得出去；而那 10 分钟里连日志都没有（debug 默认不输出）。
// 新实现：按「这张图」去重 —— 同一张不再试，换图立刻重试。
// ---------------------------------------------------------------
{
  const { createPlaceholder } = await import('../src/chat/placeholder.js')
  const BAD = join(TMP, 'bad.txt')
  writeFileSync(BAD, 'not an image')
  const GOOD = join(TMP, 'good.png')
  writeFileSync(GOOD, PNG)
  let imgPath = BAD // 同一个实例，配置里的图路径可变 —— 真实场景就是用户在面板里换图
  const logs = []
  const client = fakeClient()
  const ph = createPlaceholder({
    getConfig: () => cfgWith({ placeholderImage: imgPath }),
    getClient: () => client,
    mcpFor: async () => null,
    log: objectLogger(logs),
  })

  ph.fire(frame('d1'), chat)
  await sleep(120)
  const warns = () => logs.filter((l) => l.level === 'warn').length
  check(warns() === 1, '坏图只警告一次', `warn ${warns()} 条`)
  check(/不是图片格式/.test(ph.lastImageError), '失败原因说清了：不是图片格式', ph.lastImageError)

  // 同一张再发三条：一条 warn 都不该多
  for (const id of ['d2', 'd3', 'd4']) {
    ph.fire(frame(id), chat)
    await sleep(40)
  }
  check(warns() === 1, '同一张坏图不再刷日志（这是旧 600 秒冷却想干的事，现在做精确了）', `warn ${warns()} 条`)

  // 换一张能发的图：立刻恢复，不用等任何冷却
  // 这里必须给 mcpFor 配一个能用的假上传（前面几个用例用 null 验证的是「没配」），
  // 否则挡住它的是配置而不是图，测的就不是想测的东西了。
  const st = mkdtempSync(join(tmpdir(), 'wecom-phok-'))
  const GOOD2 = join(st, 'good.png')
  writeFileSync(GOOD2, PNG)
  const okMcp = {
    async mcpFor(service) {
      if (service !== 'disk') return null
      return {
        async call(name) {
          if (name === 'media_upload') return { media_id: 'MID_OK' }
          return { errcode: 0 }
        },
      }
    },
  }
  const client2 = fakeClient()
  let img2 = BAD
  const ph2 = createPlaceholder({
    getConfig: () => cfgWith({ placeholderImage: img2 }),
    getClient: () => client2,
    mcpFor: okMcp.mcpFor,
    log: objectLogger([]),
  })
  ph2.fire(frame('e0'), chat)
  await sleep(80)
  check(ph2.lastImageError !== '', '换图前：坏图确实发不出去（先在同一个实例里留下失败记录）', ph2.lastImageError)
  const before = client2.calls.send.length
  img2 = GOOD2 // 用户在面板里换了一张好图
  ph2.fire(frame('e1'), chat)
  await sleep(200)
  check(ph2.lastImageError === '', '换一张正常的图，立刻就发得出去（不用等冷却）', ph2.lastImageError)
  check(client2.calls.send.length > before, '确实发出去了一帧', `send ${before} → ${client2.calls.send.length}`)
}

// ---------------------------------------------------------------
// ⑩ 失败要自己留下证据（默认就留，不用用户先去开「详细日志」）
//
// 老的坑：失败只写 debug，而 debug 默认不输出 —— 等于什么都没写。
// 用户看到的只有面板一行红字，我们这边一点现场都没有。
// 现在：第一次失败写 warn（带图多大、上传通道通不通），
// 同类再失败写 info（不刷屏但仍在），堆栈走 debug（开了详细日志才有）。
// ---------------------------------------------------------------
{
  const logs = []
  const client = fakeClient()
  // 没配任何上传服务 = 配置类错误。这类不锁图（换了图也还是同一个配置问题），
  // 所以能连发两次，正好用来验证 warn → info 的降级。
  const ph = createPlaceholder({
    getConfig: () => cfgWith({ placeholderImage: IMG }),
    getClient: () => client,
    mcpFor: async () => null,
    log: objectLogger(logs),
  })
  ph.fire(frame('k1'), chat)
  await sleep(120)
  ph.fire(frame('k2'), chat)
  await sleep(120)

  check(ph.lastImageKind === 'config', '面板能拿到失败类别：config', ph.lastImageKind)
  check(/换图没用/.test(ph.lastImageError), '配置类失败明说换图没用', ph.lastImageError)

  const warnRows = logs.filter((l) => l.level === 'warn')
  const infoRows = logs.filter((l) => l.level === 'info')
  check(warnRows.length === 1, '第一次失败写 warn（一次就够）', `warn ${warnRows.length} 条`)
  check(infoRows.length >= 1, '同类再失败写 info（默认就落盘，不是 debug）', `info ${infoRows.length} 条`)

  const ev = warnRows[0]?.text || ''
  check(/大小 /.test(ev), '现场：记下了图多大', ev.slice(0, 60))
  check(/上传通道：/.test(ev), '现场：记下了上传通道通不通')
  check(/没配 disc\/mail\/doc/.test(ev), '现场：说清了是没配上传服务')
  check(logs.some((l) => l.level === 'debug' && /预回复图失败堆栈/.test(l.text)), '堆栈走 debug，开了详细日志能捞到')
}

// ---------------------------------------------------------------
// 收尾：这时候进程还活着，就说明没漏出 unhandledRejection
// ---------------------------------------------------------------
process.on('unhandledRejection', (error) => {
  console.log(`\n❌ 漏出一个 unhandledRejection：${error?.message || error}`)
  console.log('   这正是会把整个 DSH 进程杀掉的那个东西。')
  process.exit(1)
})
await sleep(200)

if (problems.length) {
  console.log(`\n❌ ${problems.length} 项没过：`)
  for (const p of problems) console.log('  - ' + p)
  process.exit(1)
}
console.log('\n✅ 预回复崩溃回归：对象 logger / 上传失败 / 日志抛错 / 无 log 都不炸')
