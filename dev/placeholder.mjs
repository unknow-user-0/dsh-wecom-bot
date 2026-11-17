// 「收到消息先回一句」的开关：开着要回这句话，关掉一个字都不能多。
//
// 为什么单独一个测试：占位是每条消息进来时立刻发的，和合并窗口、模型跑一轮
// 是三条并行的时间线。e2e 只在找回复时顺手跳过 'emmm...'，从来没断言过它
// 该不该出现 —— 所以「关掉」这个功能就算写反了也不会有人发现，
// 直到用户看到自己明明关了还在被刷屏。
//
// 跑法：node dev/placeholder.mjs

import { startFakeWecom } from './fake-wecom.js'
import { createFakeHost } from './fake-host.js'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 18097
const WS = `ws://127.0.0.1:${PORT}`
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'wecom-placeholder-'))
process.env.DSH_WECOM_WS_URL = WS

const problems = []
const check = (ok, name, extra = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? '：' + extra : ''}`)
  if (!ok) problems.push(name + (extra ? '：' + extra : ''))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const server = startFakeWecom({ port: PORT })
await server.listen()
const host = createFakeHost({ replyText: '想好了，这是答案' })
const mod = await import('../src/host.js')
const dispose = mod.apply(host.ctx)

const USER = 'u-ph'

/** 存配置（走真实的 /save，顺带验证 merge 深合并没把 merge 段冲坏） */
async function save(patch) {
  return host.callRoute('/wecom-bot/api/save', patch)
}

await save({
  enabled: true,
  botId: 'bot-ph',
  secret: 'secret-ph',
  accessMode: 'whitelist',
  allow: { users: [{ userid: USER, name: '测占位' }], groups: [] },
  // 合并窗口压到最短，别让测试等太久
  merge: { enabled: true, waitSec: 0.5, maxSec: 2 },
})

for (let i = 0; i < 40; i++) {
  await sleep(150)
  if (server.subscribed) break
}
check(server.subscribed, '订阅成功')

/**
 * 喂一条消息，把接下来一段时间里所有回复文本收集起来。
 * 等到出现「不是占位」的那条（模型回复）为止，再多等一会儿收尾。
 */
async function feed(payload, { timeoutMs = 8000 } = {}) {
  await fetch(`http://127.0.0.1:${PORT}/reset`, { method: 'POST' }).catch(() => {})
  await fetch(`http://127.0.0.1:${PORT}/inbound`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const texts = []
  let answered = false
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(120)
    const log = await fetch(`http://127.0.0.1:${PORT}/log`).then((r) => r.json())
    for (const row of log.responded) {
      const t = row?.body?.markdown?.content || ''
      if (!t) continue
      if (!texts.includes(t)) texts.push(t)
      // 出现任意非占位文案 = 模型那条已经回来了
      if (t !== 'emmm...' && t !== '秒回一句') answered = true
    }
    // 模型回复之后再多看 600ms，确保没有迟到的占位
    if (answered) {
      const grace = Date.now() + 600
      while (Date.now() < grace) {
        await sleep(120)
        const again = await fetch(`http://127.0.0.1:${PORT}/log`).then((r) => r.json())
        for (const row of again.responded) {
          const t = row?.body?.markdown?.content || ''
          if (t && !texts.includes(t)) texts.push(t)
        }
      }
      break
    }
  }
  return texts
}

// ---- 1. 默认开着，且用的是默认文案 ----
const cfg0 = await host.callRoute('/wecom-bot/api/config')
check(cfg0.config.merge.placeholderOn === true, '默认开着', `placeholderOn=${cfg0.config.merge.placeholderOn}`)
const t1 = await feed({ text: '在吗', userid: USER, chattype: 'single' })
check(t1.includes('emmm...'), '开着时先回 emmm...', JSON.stringify(t1))
check(t1.some((t) => t.includes('想好了')), '并且最终给出答案')

// ---- 2. 自定义文案 ----
await save({ merge: { placeholder: '秒回一句' } })
const t2 = await feed({ text: '在吗', userid: USER, chattype: 'single' })
check(t2.includes('秒回一句'), '自定义文案生效', JSON.stringify(t2))
check(!t2.includes('emmm...'), '自定义之后不再说 emmm...')

// ---- 3. 关掉：一个字都不能多说 ----
await save({ merge: { placeholderOn: false } })
const cfg3 = await host.callRoute('/wecom-bot/api/config')
check(cfg3.config.merge.placeholderOn === false, '关掉了', `placeholderOn=${cfg3.config.merge.placeholderOn}`)
check(cfg3.config.merge.placeholder === '秒回一句', '关掉不抹掉文案（下次打开还是它）')
const t3 = await feed({ text: '在吗', userid: USER, chattype: 'single' })
check(!t3.includes('秒回一句') && !t3.includes('emmm...'), '关掉后没有任何占位', JSON.stringify(t3))
check(t3.some((t) => t.includes('想好了')), '关掉后答案照常给', JSON.stringify(t3))

// ---- 4. 再打开，回到自定义文案 ----
await save({ merge: { placeholderOn: true } })
const t4 = await feed({ text: '在吗', userid: USER, chattype: 'single' })
check(t4.includes('秒回一句'), '重新打开还是那句自定义文案', JSON.stringify(t4))

// ---- 4.5 占位图：面板从本地选图 → 存进插件目录 → 配置指向它 ----
// 只测接口和落盘，发图本身在 dev/placeholder-image.mjs 里（要 mock MCP，更细）。
const PNG1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const up1 = await host.callRoute('/wecom-bot/api/placeholder/image', { name: 'a.png', base64: PNG1x1 })
check(up1.ok === true, '上传占位图成功', up1.message || '')
check(up1.bytes > 0, '存下来的字节数是对的', String(up1.bytes))
const st1 = await host.callRoute('/wecom-bot/api/placeholder/state', {})
check(st1.image && existsSync(st1.image), '配置里的路径指向真实文件', st1.image)
check(st1.bytes > 0, 'state 报告了文件大小', String(st1.bytes))
const cfgImg = await host.callRoute('/wecom-bot/api/config')
check(cfgImg.config.merge.placeholderImage === up1.path, '配置记住了这张图')
check(cfgImg.config.merge.placeholderImageOn === true, '存图时顺手把图开关打开')

// 换格式：旧的 png 必须被删掉，否则目录里会攒一堆没人引用的图
const up2 = await host.callRoute('/wecom-bot/api/placeholder/image', { name: 'b.jpg', base64: PNG1x1 })
check(up2.ok === true, '换一张 jpg 成功', up2.message || '')
check(!existsSync(up1.path), '换格式后旧文件已删', up1.path)

// 拒绝：空内容、超过上限、不是图片
const badEmpty = await host.callRoute('/wecom-bot/api/placeholder/image', { name: 'c.png', base64: '' })
check(badEmpty.ok === false, '空内容被拒绝', badEmpty.message || '')
const badExt = await host.callRoute('/wecom-bot/api/placeholder/image', { name: 'c.exe', base64: PNG1x1 })
check(badExt.ok === false && /不支持/.test(badExt.message || ''), '非图片格式被拒绝', badExt.message || '')

// 清掉：配置清空 + 插件目录里那张删掉
const cleared = await host.callRoute('/wecom-bot/api/placeholder/clear', {})
check(cleared.ok === true, '清占位图成功', cleared.message || '')
check(!existsSync(up2.path), '清掉后文件没了', up2.path)
const st2 = await host.callRoute('/wecom-bot/api/placeholder/state', {})
check(st2.image === '', '清掉后配置里没有路径了', JSON.stringify(st2.image))

// ---- 5. 老配置没有这个键时，按「开」处理 ----
// 直接用 normalize 跑一遍，别走 /save（它只会写 DEFAULTS 里有的键）
const { loadConfig } = await import('../src/core/config.js')
const old = loadConfig()
delete old.merge.placeholderOn
const { saveConfig } = await import('../src/core/config.js')
saveConfig(old)
const cfg5 = await host.callRoute('/wecom-bot/api/config')
check(cfg5.config.merge.placeholderOn === true, '老配置缺键时补成开')

try { dispose?.() } catch {}
await server.close()
if (problems.length) {
  console.log(`\n❌ ${problems.length} 处不对：`)
  for (const p of problems) console.log('   - ' + p)
  process.exit(1)
}
console.log('\n✅ 「收到消息先回一句」的开关行为正确')
