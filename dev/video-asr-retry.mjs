// 转写失败自动重启 ASR 的行为测试。
//
// 为什么单独立一个文件：这段逻辑的触发信号来自上游返回的**文本**
// （清单里出现 `transcript unavailable:` / `asr-failed`），不是异常。
// 所以真值表必须覆盖：认得出、认错了不会瞎重启、只重启一次、重启失败要留原因。
//
// 规矩：这里不碰真实网络也不起进程 —— 全部用假的 asr / spec。

import { retryWithAsrRestart } from '../src/tools/video.js'

let pass = 0
let fail = 0
const ok = (cond, name, extra) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`) }
}

const makeLog = () => {
  const rows = []
  const log = {
    debug: (...a) => rows.push(['debug', a.join(' ')]),
    info: (...a) => rows.push(['info', a.join(' ')]),
    warn: (...a) => rows.push(['warn', a.join(' ')]),
    error: (...a) => rows.push(['error', a.join(' ')]),
    child: () => log,
    rows,
  }
  return log
}
const FAILED = '清单\n\ntranscript unavailable: ASR 503: upstream down  [http://127.0.0.1:8080]\n  → 告诉用户：听音服务连不上'
const GOOD = '清单\n\ntranscript: asr · segments 42 · chars 1200'

console.log('\n【1】没失败时一律不动')
{
  const log = makeLog()
  let restarts = 0
  const asr = { restart: async () => { restarts += 1; return { ok: true } } }
  let calls = 0
  const spec = { execute: async () => { calls += 1; return { text: GOOD } } }
  const out = await retryWithAsrRestart({ spec, args: {}, out: { text: GOOD }, asr, log })
  ok(restarts === 0, '文本正常时不重启')
  ok(calls === 0, '也不重跑')
  ok(out.text === GOOD, '原样返回')
}

console.log('\n【2】认得出失败 → 重启 → 重跑一次')
{
  const log = makeLog()
  let restarts = 0
  let calls = 0
  const asr = { restart: async () => { restarts += 1; return { ok: true } } }
  const spec = { execute: async () => { calls += 1; return { text: GOOD } } }
  const out = await retryWithAsrRestart({ spec, args: {}, out: { text: FAILED }, asr, log })
  ok(restarts === 1, '重启一次')
  ok(calls === 1, '重跑一次')
  ok(out.text === GOOD, '返回重跑的结果')
  ok(log.rows.some(([lv, m]) => lv === 'warn' && m.includes('转写失败了')), '记了 warn 说转写失败')
  ok(log.rows.some(([lv, m]) => lv === 'info' && m.includes('已重启')), '记了 info 说已重启')
  ok(log.rows.some(([lv, m]) => lv === 'info' && m.includes('恢复正常')), '记了 info 说恢复了')
}

console.log('\n【3】重启后还是失败 → 原因必须留在日志里')
{
  const log = makeLog()
  const asr = { restart: async () => ({ ok: true }) }
  const spec = { execute: async () => ({ text: FAILED.replace('503', '502') }) }
  const out = await retryWithAsrRestart({ spec, args: {}, out: { text: FAILED }, asr, log })
  ok(out.text.includes('502'), '返回第二次的结果（不假装成功）')
  const w = log.rows.filter(([lv]) => lv === 'warn').map(([, m]) => m)
  ok(w.some((m) => m.includes('还是转写失败')), '记了 warn 说重启也没救')
  ok(w.some((m) => m.includes('502')), '把第二次的真实原因写进去了')
}

console.log('\n【4】重启本身失败 → 不再重跑，把原因写清楚')
{
  const log = makeLog()
  let calls = 0
  const asr = {
    restart: async () => ({
      ok: false,
      message: '服务没起来：退出码 1',
      killed: [{ pid: 111, port: 8081 }],
      skipped: [{ pid: 222, port: 8080, why: '命令行对不上我们的启动配置' }],
    }),
  }
  const spec = { execute: async () => { calls += 1; return { text: GOOD } } }
  const out = await retryWithAsrRestart({ spec, args: {}, out: { text: FAILED }, asr, log })
  ok(calls === 0, '重启失败就不重跑（省几十秒）')
  ok(out.text === FAILED, '返回原来的失败结果')
  const w = log.rows.filter(([lv]) => lv === 'warn').map(([, m]) => m).join('\n')
  ok(w.includes('没重启起来'), '记了 warn 说没重启起来')
  ok(w.includes('退出码 1'), '带上了重启失败的原因')
  ok(w.includes('111'), '写清停掉了哪个进程')
  ok(w.includes('222'), '写清哪个进程没敢动')
}

console.log('\n【5】重启抛异常 → 不炸，退回原结果')
{
  const log = makeLog()
  const asr = { restart: async () => { throw new Error('powershell 挂了') } }
  const spec = { execute: async () => ({ text: GOOD }) }
  const out = await retryWithAsrRestart({ spec, args: {}, out: { text: FAILED }, asr, log })
  ok(out.text === FAILED, '异常时原样返回，不冒泡')
  ok(log.rows.some(([lv, m]) => lv === 'error' && m.includes('powershell 挂了')), '把异常消息记进 error')
}

console.log('\n【6】没有 asr / 没配托管启动 → 什么都不做')
{
  const log = makeLog()
  const spec = { execute: async () => ({ text: GOOD }) }
  const a = await retryWithAsrRestart({ spec, args: {}, out: { text: FAILED }, asr: null, log })
  ok(a.text === FAILED, 'asr 为 null 时原样返回')
  const b = await retryWithAsrRestart({ spec, args: {}, out: { text: FAILED }, asr: {}, log })
  ok(b.text === FAILED, 'asr 没有 restart 方法时原样返回')
  ok(log.rows.length === 0, '什么都没记（没配就不该刷日志）')
}

console.log('\n【7】只重试一次：retried 标记挡住递归')
{
  const log = makeLog()
  let restarts = 0
  const asr = { restart: async () => { restarts += 1; return { ok: true } } }
  const spec = { execute: async () => ({ text: FAILED }) }
  await retryWithAsrRestart({ spec, args: {}, out: { text: FAILED }, asr, log, retried: true })
  ok(restarts === 0, '已标记重试过就不再重启')
}

console.log('\n【8】别把正常内容误判成失败')
{
  const log = makeLog()
  let restarts = 0
  const asr = { restart: async () => { restarts += 1; return { ok: true } } }
  const spec = { execute: async () => ({ text: GOOD }) }
  // 清单里本来就会提到各种 error / 断句，不能宽泛匹配
  const cases = [
    'transcript: asr · error count 0',
    'ocr error: none',
    'asr seconds 12.5',
    'transcript: asr-empty',
    'transcript: no-key',
  ]
  for (const text of cases) {
    await retryWithAsrRestart({ spec, args: {}, out: { text }, asr, log })
  }
  ok(restarts === 0, '这些都不该触发重启')
}

console.log('\n【9】out 形状异常也不炸')
{
  const log = makeLog()
  const asr = { restart: async () => ({ ok: true }) }
  const spec = { execute: async () => ({ text: GOOD }) }
  for (const out of [null, undefined, {}, { text: 123 }, { text: null }]) {
    const r = await retryWithAsrRestart({ spec, args: {}, out, asr, log })
    ok(r === out, `out=${JSON.stringify(out)} 原样返回`)
  }
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail ? 1 : 0)
