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

// 数据目录隔离：必须在任何插件模块被 import 之前设置。
// ESM 的 import 会被提升，所以这里改成「先用一段纯 node 内建的同步代码设好环境变量，
// 再用 dynamic import 加载插件」—— 顺序才靠得住。
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'wecom-test-'))

const { tryRequire } = await import('../src/core/deps.js')
const { fitImageToBudget, imageExt, describeImage, sniffImageMime } = await import('../src/wecom/media.js')

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

/** 纯随机噪点的多帧 GIF：调色板压不动，用来制造「怎么压都超预算」的样本 */
async function makeNoiseGif(W, H, N) {
  const frames = []
  for (let f = 0; f < N; f++) {
    const raw = Buffer.alloc(W * H * 3)
    for (let i = 0; i < raw.length; i++) raw[i] = (Math.random() * 256) | 0
    frames.push(await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer())
  }
  return sharp(frames, { join: { animated: true } })
    .gif({ delay: Array(N).fill(40), loop: 0, effort: 1 })
    .toBuffer()
}

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

// ---- ⑥ 压到极限也放不进预算：必须明说「不发」----
// 注意：这里**不能**靠「造一张足够大的图」来触发 overBudget。
// 试过一堆巨图（20~76 MB、2~6 帧、纯噪点），最后都能压进预算
// （缩到 0.2 宽 + 128 色足够狠），硬造到压不动反而让这个用例长期空转、等于没测。
// 真正能让它压不动的只有一种情况：时间不够。所以直接把预算压到 1ms，
// 稳定地走到「超时 → null → overBudget」这条路径。
// 用户场景：随手拿了张 4K 录屏转的 GIF，几百帧，面板必须当场拦住，
// 而不是让他配好、等真来消息时才发现对面什么都没收到。
{
  const huge = await makeNoiseGif(560, 440, 24)
  if (huge.length <= BUDGET) {
    console.log('⚠ 造出来的图不够大，检查 makeNoiseGif')
  } else {
    const fit = await fitImageToBudget(huge, sniffImageMime(huge), req, { budgetMs: 1 })
    check(fit.overBudget === true, '时间不够时，压缩层明确报 overBudget',
      `${(huge.length / 1048576).toFixed(2)}MB → ${(fit.data.length / 1048576).toFixed(2)}MB`)
    check(fit.data === huge, 'overBudget 时原样交回（不悄悄换成静图）',
      fit.mimeType)

    const pv = await describeImage(huge, sniffImageMime(huge), req, { budgetMs: 1 })
    check(pv.sendable === false, '预告说这张图发不出去')
    check(pv.fitsBudget === false, '预告里 fitsBudget 也是 false')
    // 文案要点：说「不会发」，不能说「可能被拒」
    // —— 说了「可能」用户就会去试，试完对面没收到，他还以为自己网不好。
    check(/不会发/.test(pv.note), '说明里明确讲「不会发」', pv.note)
    check(!/可能被拒|可能被拒收/.test(pv.note), '说明里不能写「可能被拒」')
    check(/换一张|缩小/.test(pv.note), '说明里给出了出路（换图/缩小）')
  }
}

if (problems.length) {
  console.log(`\n❌ ${problems.length} 项没过：`)
  for (const p of problems) console.log('  - ' + p)
  process.exit(1)
}
console.log('\n✅ 动图压缩：保动画、保时长、小图不重编码、静态图不受影响')
