// 压图依赖解析：能不能压图只取决于「这台机器装没装 sharp」，
// 跟调用方在哪个目录、传不传 require 函数无关。
//
// 立的这条防线来自一次真实的连环失效：
//   host.js 用 createRequire(import.meta.url) 从 src/ 往外找 sharp，
//   插件自己没有 node_modules → 找不到；
//   而 getSharp() 只探一次就把结论写死 → 第一次调用把这个 undefined 钉死，
//   之后连出站那边传了正确 require 的调用也一起拿到 undefined。
//   结果：面板的抽帧预告、入站压缩、出站压缩三处同时失效，且全程静默。
//   我在面板上看到的就是 width:0 pages:1（图明明读得出来）。

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describeImage, fitImageToBudget, sniffImageMime } from '../src/wecom/media.js'
import { tryRequire } from '../src/core/deps.js'

const here = dirname(fileURLToPath(import.meta.url))
let pass = 0
let fail = 0

function check(ok, label, extra = '') {
  if (ok) { pass += 1; console.log(`✅ ${label}${extra ? '：' + extra : ''}`) }
  else { fail += 1; console.log(`❌ ${label}${extra ? '：' + extra : ''}`) }
}

const sharp = tryRequire('sharp')
if (!sharp) {
  console.log('⚠ 这台机器没装 sharp，跳过（装不装都不该崩，只是压不了图）')
  process.exit(0)
}

// 造一张能读的图
const png = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#349' } }).png().toBuffer()

// ---- ① 真实故障形态：从 src/ 起算的 createRequire 解析不到 sharp ----
{
  const fromSrc = createRequire(join(here, '..', 'src', 'noop.js'))
  let resolved
  try { resolved = typeof fromSrc('sharp') } catch (e) { resolved = 'THROW ' + (e.code || '') }
  console.log(`ℹ 复现：从 src/ 起算 require('sharp') → ${resolved}`)
}

// ---- ② 不传 requireFn，describeImage 也必须能读图 ----
{
  const pv = await describeImage(png, 'image/png')
  check(Boolean(pv), '不传 requireFn 也能拿到预览（内部自己找 sharp）')
  check(pv && pv.width === 640, '预览读到了真实宽度', String(pv?.width))
  check(pv && pv.height === 480, '预览读到了真实高度', String(pv?.height))
}

// ---- ③ 关键回归：先让「旧故障路径」跑一遍，再确认没被钉死 ----
// 以前 getSharp 只探一次，第一次拿不到就永久拿不到。
// 这里按最坏顺序来：先显式传一个解析不到 sharp 的函数，再调不传的版本。
{
  const bad = () => { throw Object.assign(new Error('Cannot find module'), { code: 'MODULE_NOT_FOUND' }) }
  const withBad = await describeImage(png, 'image/png', bad).catch(() => null)
  check(withBad === null || withBad.width === 0, '传坏的 requireFn 时优雅降级（不炸）', JSON.stringify(withBad?.width))

  const after = await describeImage(png, 'image/png')
  check(after && after.width === 640, '降级之后仍然能正常读图（结论没被钉死）', String(after?.width))
}

// ---- ④ 连调多次结果一致（缓存不能记住错的） ----
{
  const a = await describeImage(png, 'image/png')
  const b = await describeImage(png, 'image/png')
  const c = await describeImage(png, 'image/png')
  check(a && b && c && a.width === b.width && b.width === c.width, '连调三次结果稳定', `${a?.width}/${b?.width}/${c?.width}`)
}

// ---- ⑤ 小图不压缩、原样交回；这也是「没装 sharp」时该有的行为 ----
{
  const fit = await fitImageToBudget(png, sniffImageMime(png) || 'image/png')
  check(fit.data === png, '预算内的图原样返回（没有白压一遍）')
  check(fit.overBudget !== true, '预算内的图不会被判成压不动')
}

// ---- ⑥ fitImageToBudget 不传 requireFn 也能压：造一张超预算的静图 ----
{
  const { randomBytes } = await import('node:crypto')
  const w = 1600
  const h = 1200
  const raw = randomBytes(w * h * 3)
  const noisy = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer()
  if (noisy.length > 1_400_000) {
    const fit = await fitImageToBudget(noisy, 'image/png')
    check(fit.data.length < noisy.length, '不传 requireFn 也能真的压缩', `${(noisy.length / 1048576).toFixed(2)} MB → ${(fit.data.length / 1048576).toFixed(2)} MB`)
    check(fit.overBudget !== true, '这张图不该被判成压不动')
  } else {
    console.log('⚠ 没造出超预算的静图，跳过⑥')
  }
}

console.log('')
if (fail === 0) console.log(`✅ 依赖解析的行为正确（${pass} 项）`)
else { console.log(`❌ ${fail} 项没过`); process.exit(1) }
