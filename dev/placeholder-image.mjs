// 预回复图：文字和图各有开关，配了哪个发哪个，都配了就都发。
//
// 为什么单独一个测试：这条链路上有三个很容易写错的点，而且都不会在
// 「只测文字」的 placeholder.mjs 里暴露：
//   1. 只配图、关掉文字的人，必须仍然收到图预回复（wantsPlaceholder 判断）
//   2. 没配 disk/mail/doc 的人，media_upload 拿不到 media_id —— 图发不出去，
//      但文字必须照发，不能整条预回复都哑掉
//   3. 同一张图不能在每条消息来的时候重传一遍（media_id 缓存）
//
// 跑法：node dev/placeholder-image.mjs

import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlaceholder } from '../src/chat/placeholder.js'

const problems = []
const check = (ok, name, extra = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? '：' + extra : ''}`)
  if (!ok) problems.push(name + (extra ? '：' + extra : ''))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 最小的合法 PNG（1x1 透明）—— sniffImageMime 认得出，size 远小于压缩阈值
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)
const TMP = mkdtempSync(join(tmpdir(), 'wecom-phimg-'))
const IMG = join(TMP, 'ph.png')
writeFileSync(IMG, PNG)

/** 假长连接：记下 respond / send 各自收到了什么 */
function fakeClient() {
  const calls = { respond: [], send: [], sendFail: false }
  return {
    calls,
    async respond(reqId, body) { calls.respond.push({ reqId, body }) },
    async send(chatId, chatType, body) {
      if (calls.sendFail) throw new Error('主动推送被拒（会话未激活）')
      calls.send.push({ chatId, chatType, body })
    },
  }
}

/** 假 MCP：upload 计数 + 是否配了服务
 *
 * 两个服务要分开模拟，因为发图是「先上传、再发送」两段：
 *   disk/mail/doc  → media_upload 换 media_id
 *   msg            → message_aibot_send 真机验证过的出站通道
 * 只配上传服务、没配 msg 时，应该退回长连接发图（这是要测的分支）。
 */
function fakeMcp({ ready = true, msg = false } = {}) {
  const state = { uploads: 0, calls: [], sent: [] }
  const mcpFor = async (service) => {
    if (!ready) return null
    if (service === 'msg') {
      if (!msg) return null
      return {
        async call(name, args) {
          state.calls.push({ service, name, args })
          if (name === 'message_aibot_send') { state.sent.push(args); return { errcode: 0 } }
          return { success: true }
        },
      }
    }
    if (service !== 'disk') return null
    return {
      async call(name, args) {
        state.calls.push({ service, name, args })
        if (name === 'media_upload') { state.uploads += 1; return { media_id: 'mid-' + state.uploads } }
        return { success: true }
      },
    }
  }
  return { mcpFor, state }
}

const frame = (id) => ({ headers: { req_id: id } })
const chat = { kind: 'dm', chatId: 'u1', userId: 'u1' }

function build({ merge, mcp }) {
  const cfg = {
    merge: {
      placeholderOn: true, placeholder: 'emmm...',
      placeholderImage: '', placeholderImageOn: true,
      ...merge,
    },
  }
  const client = fakeClient()
  const ph = createPlaceholder({
    getConfig: () => cfg,
    getClient: () => client,
    mcpFor: mcp.mcpFor,
    log: () => {},
  })
  return { ph, client, cfg }
}

// ---- ① 只配文字 ----
{
  const mcp = fakeMcp()
  const { ph, client } = build({ merge: {}, mcp })
  ph.fire(frame('r1'), chat)
  await sleep(80)
  check(client.calls.respond.length === 1, '只配文字：发了文字', JSON.stringify(client.calls.respond[0]?.body))
  check(client.calls.send.length === 0, '只配文字：没有发图')
  check(mcp.state.uploads === 0, '只配文字：没去上传')
}

// ---- ② 只配图（文字关掉）----
// 没配 msg 服务 → 退回长连接 image 帧（文档认 media_id，但没真机验证）
{
  const mcp = fakeMcp()
  const { ph, client } = build({ merge: { placeholderOn: false, placeholderImage: IMG }, mcp })
  ph.fire(frame('r2'), chat)
  await sleep(150)
  check(client.calls.respond.length === 0, '只配图：没发文字')
  check(client.calls.send.length === 1, '只配图：发了图')
  const sent = client.calls.send[0]
  check(sent?.body?.msgtype === 'image', '只配图：msgtype=image', sent?.body?.msgtype)
  check(sent?.body?.image?.media_id === 'mid-1', '只配图：带上了 media_id', sent?.body?.image?.media_id)
  check(sent?.chatType === 1, '只配图：单聊 chat_type=1', String(sent?.chatType))
}

// ---- ②b 配了 msg 服务 → 走 MCP message_aibot_send（真机验证过的通道）----
{
  const mcp = fakeMcp({ msg: true })
  const { ph, client } = build({ merge: { placeholderOn: false, placeholderImage: IMG }, mcp })
  ph.fire(frame('r2b'), chat)
  await sleep(150)
  check(client.calls.send.length === 0, '有 msg 服务：不走长连接')
  check(mcp.state.sent.length === 1, '有 msg 服务：走了 message_aibot_send',
    JSON.stringify(mcp.state.sent[0]))
  const s = mcp.state.sent[0]
  check(s?.chat_id === 'u1' && s?.msg_type === 'image', '有 msg 服务：字段名用 MCP 那套（chat_id/msg_type）',
    `chat_id=${s?.chat_id} msg_type=${s?.msg_type}`)
  check(s?.image?.media_id === 'mid-1', '有 msg 服务：带上了 media_id', s?.image?.media_id)
}

// ---- ③ 两个都配 → 都发 ----
{
  const mcp = fakeMcp()
  const { ph, client } = build({ merge: { placeholderScreen: '', placeholder: '稍等', placeholderImage: IMG }, mcp })
  ph.fire(frame('r3'), chat)
  await sleep(150)
  check(client.calls.respond.length === 1 && client.calls.send.length === 1, '都配了：文字和图都发了',
    `respond=${client.calls.respond.length} send=${client.calls.send.length}`)
  check(client.calls.respond[0]?.body?.markdown?.content === '稍等', '都配了：文字内容对')
}

// ---- ④ 都关 → 彻底安静 ----
{
  const mcp = fakeMcp()
  const { ph, client } = build({ merge: { placeholderOn: false, placeholderImage: IMG, placeholderImageOn: false }, mcp })
  ph.fire(frame('r4'), chat)
  await sleep(120)
  check(client.calls.respond.length === 0 && client.calls.send.length === 0, '都关：一个字一张图都没有')
}

// ---- ⑤ 没配 MCP：图发不出去，文字照发 ----
{
  const mcp = fakeMcp({ ready: false })
  const { ph, client } = build({ merge: { placeholder: '在呢', placeholderImage: IMG }, mcp })
  ph.fire(frame('r5'), chat)
  await sleep(150)
  check(client.calls.respond.length === 1, '没 MCP：文字照发')
  check(client.calls.send.length === 0, '没 MCP：图没发出去（不假装发了）')
  check(/MCP/.test(ph.lastImageError), '没 MCP：记下了原因', ph.lastImageError)
}

// ---- ⑥ 同一张图不重传 ----
{
  const mcp = fakeMcp()
  const { ph, client } = build({ merge: { placeholderImage: IMG }, mcp })
  for (let i = 0; i < 3; i++) { ph.fire(frame('r6-' + i), chat); await sleep(120) }
  check(mcp.state.uploads === 1, '同一张图只上传一次', `uploads=${mcp.state.uploads}`)
  check(client.calls.send.length === 3, '每条消息都发图（用缓存 media_id）', String(client.calls.send.length))
}

// ---- ⑦ 图被换掉 → 重新上传 ----
{
  const mcp = fakeMcp()
  const { ph } = build({ merge: { placeholderImage: IMG }, mcp })
  ph.fire(frame('r7a'), chat)
  await sleep(150)
  writeFileSync(IMG, Buffer.concat([PNG, Buffer.from('x')])) // 改大小 → 缓存键失效
  ph.fire(frame('r7b'), chat)
  await sleep(150)
  check(mcp.state.uploads === 2, '图变了会重传', `uploads=${mcp.state.uploads}`)
}

// ---- ⑧ 图不存在 / 不是图片 → 不发，且有原因 ----
{
  const mcp = fakeMcp()
  const { ph, client } = build({ merge: { placeholderImage: join(TMP, 'nope.png') }, mcp })
  ph.fire(frame('r8'), chat)
  await sleep(120)
  check(client.calls.send.length === 0, '图不存在：不发')
  check(Boolean(ph.lastImageError), '图不存在：记下了原因', ph.lastImageError)
}
{
  const mcp = fakeMcp()
  const { ph, client } = build({ merge: { placeholderImage: join(TMP, 'x.txt') }, mcp })
  writeFileSync(join(TMP, 'x.txt'), 'not an image')
  ph.fire(frame('r9'), chat)
  await sleep(120)
  check(client.calls.send.length === 0, '不是图片格式：不发')
  check(/不是图片/.test(ph.lastImageError), '不是图片格式：原因说清楚了', ph.lastImageError)
}

// ---- ⑨ 缓存键里有 mtime：换图后旧 media_id 不会被继续用 ----
check(existsSync(IMG), '测试用的图片还在（没被测试自己删掉）')

if (problems.length) {
  console.log(`\n❌ ${problems.length} 项没过：`)
  for (const p of problems) console.log('  - ' + p)
  process.exit(1)
}
console.log('\n✅ 预回复图：文字/图片/都发/降级/缓存 都对')
