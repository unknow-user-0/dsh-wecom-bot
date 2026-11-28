// ASR 启动配置回归。
//
// 这一组测试是为了那个真实事故：asr.json 里写「数组套数组」（多进程）时，
// 上游 dsh-video-storyboard 的 lifecycleConfig() 会把内层数组 String() 成逗号串，
// 然后 spawn("exe,-m,x", ["node,b"]) → ENOENT → 那处 spawn 没挂 error 监听 →
// uncaught exception → **整个 DSH host 进程 exit 1**，客户端崩。
// 所以：多进程配置必须落成 bat（上游唯一认的写法），而且读配置时要能自愈。

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let pass = 0
let fail = 0
const ok = (cond, name, extra) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? ` → ${extra}` : ''}`) }
}

const home = mkdtempSync(join(tmpdir(), 'wecom-asr-'))
process.env.DSH_HOME = home

const asr = await import('../src/video/asr.js')
const logs = []
const log = {
  debug: (m) => logs.push(['debug', m]),
  info: (m) => logs.push(['info', m]),
  warn: (m) => logs.push(['warn', m]),
  error: (m) => logs.push(['error', m]),
}

const MULTI = [
  ['G:\\蓝色大肥鱼\\tmp\\whisper\\bin\\Release\\whisper-server.exe', '-m', 'G:/feiyu-asr/ggml-large-v3-turbo.bin', '-l', 'zh', '--port', '8081'],
  ['node', 'G:\\蓝色大肥鱼\\asr\\bridge-asr.mjs'],
]

console.log('\n【1】isMultiStart 辨识')
ok(asr.isMultiStart(MULTI) === true, '数组套数组 = 多进程')
ok(asr.isMultiStart([['a', 'b']]) === true, '一层嵌套也算')
ok(asr.isMultiStart(['a', 'b']) === false, '字符串数组不是多进程')
ok(asr.isMultiStart('D:/asr/start.bat') === false, '字符串不是多进程')
ok(asr.isMultiStart([]) === false, '空数组不是多进程')
ok(asr.isMultiStart([['a'], 'b']) === false, '半嵌套不算（不猜）')
ok(asr.isMultiStart(null) === false, 'null 不崩')

console.log('\n【2】writeStartBat 生成的文件')
const { file, lines } = asr.writeStartBat({ dir: join(home, 'wecom-asr'), plans: MULTI, log })
ok(existsSync(file), `bat 落盘了：${file}`)
const text = readFileSync(file, 'utf8')
ok(text.includes('\r\n'), '是 CRLF 行尾（LF 会让 cmd 把注释当命令执行）')
ok(!/[^\r]\n/.test(text), '没有裸 LF')
ok(text.includes('start "" /b'), '用 start "" /b（不弹黑框，且父进程退出后子进程还活着）')
ok(text.includes('whisper-server.exe'), '第一条命令在里面')
ok(text.includes('bridge-asr.mjs'), '第二条命令在里面')
ok(text.indexOf('whisper-server.exe') < text.indexOf('bridge-asr.mjs'), '顺序保持：先 whisper 后适配层')
ok(text.includes('-m') && text.includes('ggml-large-v3-turbo.bin'), '参数没丢')
ok(text.includes('start-0.log') && text.includes('start-1.log'), '每条命令各写一份日志（合成一份看不出谁先死）')
ok(!text.includes(',-m,'), '没有逗号串（就是崩的那个形态）')
ok(lines.length >= 4, '有注释头')
// 下面三条是 2026-11-28 崩溃的回归闸：chcp 65001 下 bat 里出现中文 rem，
// cmd 会把 start 行的 /b 拆出来当命令 b 执行，4 次实测 4 次全挂。
// 注意只该拦注释行 —— exe 路径里有中文是本机常态，拦了就是误伤。
const remLines = lines.filter((l) => /^\s*rem\b/i.test(l))
ok(remLines.length > 0 && remLines.every((l) => /^[\x00-\x7F]*$/.test(l)), 'rem 注释全是 ASCII（中文 rem 会被 cmd 读成命令 b）')
ok(text.includes('chcp 65001'), '保留 chcp 65001（去掉它 exe 路径里的中文会被 GBK 码页戳坏）')
let threw = ''
try {
  asr.writeStartBat({ dir: join(home, 'wecom-asr-bad'), plans: [[join(home, '中文.exe'), '-x']], log })
} catch (error) {
  threw = error.message
}
ok(threw === '', `路径里有中文不该触发自检（实际：${threw || '没抛'}）`)
ok(text.includes('whisper-server.exe'), '中文路径的 exe 仍然正确写进 start 行')

console.log('\n【3】describePlans / readStartPlans 面板显示')
const plans = asr.readStartPlans(file)
ok(Array.isArray(plans) && plans.length === 2, '旁车记录了原始命令清单')
ok(asr.describePlans(MULTI).includes('whisper-server.exe'), 'describePlans 显示程序名')
ok(asr.describePlans(MULTI).includes('＋'), '多条用 ＋ 连起来')
ok(!asr.describePlans(MULTI).includes(',-m,'), 'describePlans 也不是逗号串')

console.log('\n【4】save() 写多进程 → 落盘是 bat，不是嵌套数组')
const asrApi = asr.createAsr({ log, getHostService: () => undefined, getExtraDirs: () => [] })
const s1 = asrApi.save({ baseUrl: 'http://127.0.0.1:8080', manageStart: MULTI })
ok(s1.ok === true, '保存成功')
const onDisk = JSON.parse(readFileSync(join(home, 'asr.json'), 'utf8'))
ok(typeof onDisk.manage.start === 'string', '落盘的 start 是字符串（不是嵌套数组）')
ok(/\.bat$/i.test(onDisk.manage.start), `落盘指向 bat：${onDisk.manage.start}`)
ok(existsSync(onDisk.manage.start), '那个 bat 真的在磁盘上')
ok(!Array.isArray(onDisk.manage.start), '不是数组 —— 上游 map(String) 也就毁不掉')

console.log('\n【5】服务启动前的关键一步：上游读出来的 start 不能是逗号串')
// 复刻上游 lifecycleConfig 的解析：Array.isArray ? map(String) : String
const upstreamRaw = onDisk.manage.start
const upstreamStart = Array.isArray(upstreamRaw) ? upstreamRaw.map(String) : String(upstreamRaw)
ok(typeof upstreamStart === 'string', '上游拿到的是字符串')
ok(!upstreamStart.includes(',-m,'), '上游拿到的不是逗号串（这就是崩溃点）')
ok(/\.bat$/i.test(upstreamStart), '上游会走 spawn(bat, [], {shell:true}) 这条路')

console.log('\n【6】自愈：磁盘上已经是嵌套数组时，读配置就自动修好')
const asr2 = asr.createAsr({ log, getHostService: () => undefined, getExtraDirs: () => [] })
// 手动把 asr.json 写回事故现场的形态
writeFileSync(join(home, 'asr.json'), JSON.stringify({ baseUrl: 'http://127.0.0.1:8080', manage: { start: MULTI } }, null, 2), 'utf8')
const st = await asr2.status()
ok(st.managed === true, '依然认「托管拉起」')
ok(st.manageStart.includes('whisper-server.exe'), `面板显示还原成了命令：${st.manageStart}`)
const healed = JSON.parse(readFileSync(join(home, 'asr.json'), 'utf8'))
ok(typeof healed.manage.start === 'string' && /\.bat$/i.test(healed.manage.start), '读一次就自动改写成 bat 了')
ok(logs.some(([lv, m]) => lv === 'warn' && m.includes('数组套数组')), '写了 warn 说明为什么改')

console.log('\n【7】单进程配置不被改动')
const asr3 = asr.createAsr({ log, getHostService: () => undefined, getExtraDirs: () => [] })
const single = ['node', 'G:\\蓝色大肥鱼\\asr\\bridge-asr.mjs']
asr3.save({ baseUrl: 'http://127.0.0.1:8080', manageStart: single })
const s2 = JSON.parse(readFileSync(join(home, 'asr.json'), 'utf8'))
ok(Array.isArray(s2.manage.start) && s2.manage.start.length === 2, '单进程还是数组，没被转成 bat')
ok(s2.manage.start[0] === 'node', '内容原样')

console.log('\n【8】清空')
asr3.save({ manageStart: '' })
const s3 = JSON.parse(readFileSync(join(home, 'asr.json'), 'utf8'))
ok(!s3.manage || !s3.manage.start, '清空后没有 start')

console.log('\n【9】scanStartLogs：从 bat 的日志里认出「这条命令压根没跑起来」')
const logDir = join(home, 'logs-scan')
mkdirSync(logDir, { recursive: true })
writeFileSync(join(logDir, 'start-0.log'), "'b' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n", 'utf8')
writeFileSync(join(logDir, 'start-1.log'), '[asr] 适配层已启动 http://127.0.0.1:8080/\r\n', 'utf8')
const bad0 = asr.scanStartLogs(logDir, 2)
ok(bad0.length === 1 && bad0[0].includes('start-0.log'), '认出坏的那条，正常的不算')
ok(bad0[0].includes('not recognized'), '把原始错误行带出来，不是一句「启动失败」')
writeFileSync(join(logDir, 'start-1.log'), '无法启动程序，系统找不到指定的文件 ENOENT\r\n', 'utf8')
ok(asr.scanStartLogs(logDir, 2).length === 2, 'ENOENT 也算')
writeFileSync(join(logDir, 'start-0.log'), 'whisper_init_from_file_with_params: loading model\r\n', 'utf8')
writeFileSync(join(logDir, 'start-1.log'), 'warn: slow decode\r\n', 'utf8')
ok(asr.scanStartLogs(logDir, 2).length === 0, '程序正常打日志不算失败（别把告警当崩）')
writeFileSync(join(logDir, 'start-0.log'), '', 'utf8')
ok(asr.scanStartLogs(logDir, 2).length === 0, '空日志不算失败')
ok(asr.scanStartLogs(logDir, 5).length === 0, '压根没有日志文件也不崩')

console.log('\n【10】bat 被删掉 → 照 asr.json 里存的清单自动重建')
const asr4 = asr.createAsr({ log, getHostService: () => undefined, getExtraDirs: () => [] })
asr4.save({ baseUrl: 'http://127.0.0.1:8080', manageStart: MULTI })
const cfg4 = JSON.parse(readFileSync(join(home, 'asr.json'), 'utf8'))
ok(Array.isArray(cfg4.manage.startPlans) && cfg4.manage.startPlans.length === 2, 'save 时把原始命令清单也存进 asr.json 了')
ok(/\.bat$/i.test(cfg4.manage.start), 'start 指向 bat')
const bat4 = cfg4.manage.start
rmSync(bat4, { force: true })
ok(!existsSync(bat4), '先手动删掉 bat（模拟被清理工具扫掉）')
const st4 = await asr4.status()
ok(existsSync(bat4), '读一次配置就把 bat 重建出来了')
ok(st4.managed === true && st4.manageStart.includes('whisper-server.exe'), '面板显示的还是原来的命令，不是一条死路径')
ok(logs.some(([lv, m]) => lv === 'warn' && m.includes('不见了')), '写了 warn 说明为什么重建')

console.log('\n【11】单进程/清空时不留 startPlans')
asr4.save({ manageStart: single })
const cfg5 = JSON.parse(readFileSync(join(home, 'asr.json'), 'utf8'))
ok(!cfg5.manage.startPlans, '换成单进程后清单被清掉了（免得残留误导重建）')

console.log('\n【12】重启：只杀自己的进程（重启失败会误伤别人的程序，这条必须守住）')
const PLAN_MULTI = [
  ['G:\\蓝色大肥鱼\\tmp\\whisper\\bin\\Release\\whisper-server.exe', '-m', 'G:/feiyu-asr/x.bin', '--port', '8081'],
  ['node', 'G:\\蓝色大肥鱼\\asr\\bridge-asr.mjs'],
]
ok(asr.ownedByPlan('"node"  "G:\\蓝色大肥鱼\\asr\\bridge-asr.mjs"', PLAN_MULTI), '适配层（node + 完整脚本路径）认成自己的')
ok(asr.ownedByPlan('"G:\\蓝色大肥鱼\\tmp\\whisper\\bin\\Release\\whisper-server.exe" "-m" "x"', PLAN_MULTI), 'whisper（完整 exe 路径）认成自己的')
// 下面三条是防误杀的核心：裸解释器名绝不能当身份
ok(!asr.ownedByPlan('"C:\\Program Files\\nodejs\\node.exe" "C:\\other\\x.js"', PLAN_MULTI), '别人的 node 进程不会被认成自己的')
ok(!asr.ownedByPlan('"D:\\other\\whisper-server.exe" "-m" "y"', PLAN_MULTI), '别处同名 exe 不会被认成自己的（路径不同）')
ok(!asr.ownedByPlan('', PLAN_MULTI), '拿不到命令行时不认（宁可重启失败，也不误杀）')
ok(!asr.ownedByPlan('something', [['node', 'x']]), '配置里只有裸解释器名时，谁都不认')
ok(asr.ownedByPlan('"C:\\x\\run.bat"', [['C:\\x\\run.bat']]), 'bat 全路径也能认出来')
ok(asr.ownedByPlan('node "c:\\y\\bridge-asr.mjs"', [[ 'node', 'C:/y/bridge-asr.mjs' ]]), '正斜杠和反斜杠混写也能对上')

console.log('\n【13】没有监听者时 portOwners 不炸')
ok(Array.isArray(asr.portOwners(0)), '端口 0 返回数组不抛')
ok(asr.portOwners(0).length === 0, '端口 0 没人监听')
ok(Array.isArray(asr.portOwners(65533)), '没人用的端口返回空数组，不是抛错')

console.log('\n【14】没配地址时 restart 直接说清楚，不瞎折腾')
const asr5 = asr.createAsr({ log, getHostService: () => undefined, getExtraDirs: () => [] })
writeFileSync(join(home, 'asr.json'), JSON.stringify({ baseUrl: '' }), 'utf8')
const r14 = await asr5.restart()
ok(r14.ok === false, '没配地址时不报成功')
ok(/没配/.test(r14.message), '说清是没配地址')

rmSync(home, { recursive: true, force: true })
console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail ? 1 : 0)
