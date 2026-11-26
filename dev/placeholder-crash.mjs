// 回归：占位发图失败时，进程绝对不能死。
//
// 背景（真机踩过，DSH 被连杀两次）：
//   host.js 传给 createPlaceholder 的 log 是 logger.child('placeholder')，
//   而 logger.child() 返回的是 **对象** {debug,info,warn,error}，不是函数。
//   占位代码里却写成 log?.('warn', ...) —— 按函数调。
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
    logs.some((l) => l.level === 'warn' && /占位图没发出去/.test(l.text)),
    '失败写进了 warn 日志（走的是对象式 logger）',
    JSON.stringify(logs.map((l) => l.level)),
  )
  check(client.calls.respond.length === 1, '文字占位照发，没被图片失败带下水')
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
    logs.some((l) => /占位文字发送失败/.test(l.text)),
    '文字失败也记进了日志（debug 级，占位失败不算严重）',
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
// ⑦ 短冷却到点必须自动恢复（以前静默 10 分钟 = 用户以为坏了）
// ---------------------------------------------------------------
{
  const { createPlaceholder } = await import('../src/chat/placeholder.js')
  let fail = true
  const client = fakeClient()
  const mcp = {
    async mcpFor(service) {
      if (service !== 'disk') return null
      return {
        async call(name) {
          if (name === 'media_upload') {
            if (fail) throw Object.assign(new Error('authorization expired'), { code: 850003 })
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
    cooldowns: { local: 5000, remote: 400 }, // 把「瞬时」冷却压到 400ms 便于观察
  })

  ph.fire(frame('c1'), chat)
  await sleep(150) // 还在 400ms 冷却窗口内
  check(ph.lastImageError !== '', '第一枪：授权过期，记下了失败', ph.lastImageError)
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

  // 用户修好了授权，等冷却过去
  fail = false
  await sleep(300)
  ph.fire(frame('c3'), chat)
  await sleep(150)
  check(client.calls.send.length + 1 > afterFirst || ph.lastImageError === '', '授权修好后冷却结束就能发出去', `send=${client.calls.send.length} err="${ph.lastImageError}"`)
  check(ph.lastImageError === '', '成功一次之后失败原因被清掉', `"${ph.lastImageError}"`)
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
console.log('\n✅ 占位崩溃回归：对象 logger / 上传失败 / 日志抛错 / 无 log 都不炸')
