// 动图压缩：超预算的 GIF 必须「还是动图」，不能被压成一张静图。
//
// 背景：出站压缩长期失效（outbound.js 取的是从未赋值的 globalThis.__wecomRequire），
// 所以「所有格式一律输出 jpeg」这个 bug 一直藏着。压缩一修好就暴露：
// 2 MB 的 30 帧动图会被压成 0.19 MB 的静态 jpeg —— 用户以为发了动图，
// 对方收到的是一张静止画面。
//
// 这个测试守三件事：
//   ① 压缩后仍是 image/gif，且帧数 > 1
//   ② 抽帧之后总播放时长不变（否则动图会播放快好几倍）
//   ③ 小图原样返回，不做任何处理
//
// 依赖 sharp。装了才跑，没装就跳过（CI 上可以不装）。
// 跑法：node dev/media-animated.mjs

import { tryRequire } from '../src/core/deps.js'
import { fitImageToBudget, imageExt, describeImage, sniffImageMime } from '../src/wecom/media.js'

const problems = []
const check = (ok, name, extra = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? '：' + extra : ''}`)
  if (!ok) problems.push(name + (extra ? '：' + extra : ''))
}

const sharp = tryRequire('sharp')
if (!sharp) {
  console.log('⚠ 没装 sharp，跳过动图压缩测试')
  process.exit(0)
}

const BUDGET = 1_400_000

/** 造一个真多帧 GIF（sharp 数组输入 + join.animated） */
async function makeAnimGif(W, H, N, delayMs) {
  const frames = []
  for (let f = 0; f < N; f++) {
    const raw = Buffer.alloc(W * H * 3)
    // 噪点：GIF 压不动，能稳定造出超预算的文件
    for (let i = 0; i < raw.length; i += 3) {
      raw[i] = (i * 37 + f * 91) % 256
      raw[i + 1] = (i * 13 + f * 57) % 256
      raw[i + 2] = (i * 71 + f * 29) % 256
    }
    frames.push(await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer())
  }
  return sharp(frames, { join: { animated: true } })
    .gif({ delay: Array(N).fill(delayMs), loop: 0, effort: 3 })
    .toBuffer()
}

const req = (n) => tryRequire(n)

// ---- ① 超预算大动图：保住动画，压进预算 ----
{
  const gif = await makeAnimGif(700, 550, 30, 80)
  const before = await sharp(gif, { animated: true }).metadata()
  check(gif.length > BUDGET, '造出来的原图确实超预算', `${(gif.length / 1048576).toFixed(2)} MB`)
  check(before.pages > 1, '原图确实是多帧动图', `${before.pages} 帧`)

  const fit = await fitImageToBudget(gif, 'image/gif', req)
  const after = await sharp(fit.data, { animated: true }).metadata()

  check(fit.mimeType === 'image/gif', '压缩后仍是 GIF（没被偷偷转静图）', fit.mimeType)
  check(imageExt(fit.mimeType) === '.gif', '文件名扩展名不会被改成 .jpg', imageExt(fit.mimeType))
  check(Number(after.pages || 1) > 1, '压缩后还是动图', `${after.pages} 帧`)
  check(fit.data.length <= BUDGET, '压进了预算', `${(fit.data.length / 1048576).toFixed(2)} MB`)

  // ---- ② 抽帧必须补偿延时，总播放时长不变 ----
  const totalBefore = before.pages * 80
  const delays = Array.isArray(after.delay) ? after.delay : []
  const totalAfter = delays.length ? delays.reduce((a, b) => a + b, 0) : 0
  const ratio = totalBefore ? totalAfter / totalBefore : 1
  check(
    ratio > 0.85 && ratio < 1.25,
    '抽帧后总播放时长基本不变（不会播放变快）',
    `${totalBefore}ms → ${totalAfter}ms (${ratio.toFixed(2)}x)`,
  )
}

// ---- ③ 小动图：不超预算就原样返回，别白费 CPU 重编码 ----
{
  const gif = await makeAnimGif(200, 150, 6, 100)
  const fit = await fitImageToBudget(gif, 'image/gif', req)
  check(fit.data === gif, '小动图原样返回（没被重编码）')
  check(fit.mimeType === 'image/gif', '小动图 mime 不变', fit.mimeType)
}

// ---- ④ 静态大图：仍走 jpeg 那条老路，别被动图分支误伤 ----
{
  const W = 1600, H = 1200
  const raw = Buffer.alloc(W * H * 3)
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 37 + 11) % 256
  const png = await sharp(raw, { raw: { width: W, height: H, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toBuffer()
  if (png.length > BUDGET) {
    const fit = await fitImageToBudget(png, 'image/png', req)
    check(fit.data.length <= BUDGET, '静态大图照样能压进预算', `${(fit.data.length / 1048576).toFixed(2)} MB`)
    check(fit.mimeType === 'image/jpeg', '静态图走 jpeg（不受动图分支影响）', fit.mimeType)
  } else {
    console.log('⚠ 静态图没造到超预算，跳过该项')
  }
}

// ---- ⑤ describeImage：面板「选图预告」的数据源 ----
// 这是用户在选完图那一刻唯一能看到的东西。它报错了，用户就会以为
// 「我选的 30 帧表情包会原样发出去」，实际对面只看到 15 帧。
{
  const big = await makeAnimGif(700, 550, 30, 80)
  if (big.length > BUDGET) {
    const pv = await describeImage(big, sniffImageMime(big), req)
    check(Boolean(pv), 'describeImage 有返回')
    check(pv.pages === 30, '预告报出原始帧数', String(pv.pages))
    check(pv.dropped === true, '预告知道会被抽帧')
    check(pv.finalPages >= 2 && pv.finalPages < pv.pages, '预告报出抽完还剩几帧', `${pv.pages} → ${pv.finalPages}`)
    check(pv.droppedFrames === pv.pages - pv.finalPages, '少掉的帧数算得对', String(pv.droppedFrames))
    // 时长必须对得上，不然用户以为动图会变快
    check(Math.abs(pv.finalDurationMs - pv.durationMs) < 120,
      '预告里的总时长和原图一致（不会变快）', `${pv.durationMs}ms → ${pv.finalDurationMs}ms`)
    check(pv.finalMime === 'image/gif', '预告里最终形态还是 GIF', pv.finalMime)
    check(pv.fitsBudget === true, '预告说压进预算了')
    check(typeof pv.note === 'string' && pv.note.length > 0, '有给人看的一句话说明', pv.note)
  } else {
    console.log('⚠ 大动图没造到超预算，跳过 describeImage 抽帧项')
  }

  // 小动图：不压缩，最终形态必须等于原图 ——
  // 曾经这里漏赋值，导致面板把 8 帧显示成「→ 1 帧」，
  // 用户以为动画被压没了，其实根本没动过。
  const small = await makeAnimGif(200, 150, 8, 100)
  const pv2 = await describeImage(small, sniffImageMime(small), req)
  check(pv2.finalPages === pv2.pages, '小动图：最终帧数 == 原始帧数', `${pv2.pages} → ${pv2.finalPages}`)
  check(pv2.finalDurationMs === pv2.durationMs, '小动图：最终时长 == 原始时长',
    `${pv2.durationMs}ms → ${pv2.finalDurationMs}ms`)
  check(pv2.dropped === false, '小动图：不会误报被抽帧')
  check(pv2.finalBytes === pv2.bytes, '小动图：字节数不变（确实没重编码）')

  // 静态图：不该被当成动图
  const W = 800, H = 600
  const raw = Buffer.alloc(W * H * 3)
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 37 + 11) % 256
  const still = await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer()
  const pv3 = await describeImage(still, 'image/png', req)
  check(pv3.animated === false && pv3.pages === 1, '静态图：预告按静图处理')
  check(pv3.dropped === false, '静态图：不会误报抽帧')

  // 不是图片：必须返回 null，让上层不显示预告而不是崩
  const pv4 = await describeImage(Buffer.from('这不是图片'), 'image/png', req)
  check(pv4 === null, '解不开的内容返回 null（不炸）')
}

if (problems.length) {
  console.log(`\n❌ ${problems.length} 项没过：`)
  for (const p of problems) console.log('  - ' + p)
  process.exit(1)
}
console.log('\n✅ 动图压缩：保动画、保时长、小图不重编码、静态图不受影响')
