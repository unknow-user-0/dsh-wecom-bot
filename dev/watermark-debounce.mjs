// 水位防抖写盘的回归测试
// 目的：证明 ①攒 500ms 合并写 ②flush 立刻写 ③频繁 touch 不会每次都落盘
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// DATA_DIR 由 config.js 在 import 时算出来，所以先改环境变量再动态 import
const dir = mkdtempSync(join(tmpdir(), 'wm-'))
process.env.DSH_HOME = dir

const { createBackfill } = await import('../src/chat/backfill.js')

let fails = 0
const ok = (cond, msg) => {
  console.log(`${cond ? '✅' : '❌'} ${msg}`)
  if (!cond) fails += 1
}

const bf = createBackfill({
  log: { debug() {}, info() {}, warn() {} },
  mcpFor: async () => null,
  appendOnly: async () => true,
  getConfig: () => ({ history: { enabled: true } }),
})

const file = bf.file
const chat = { kind: 'dm', chatId: 'u-test' }

// ① 刚 touch 完不该有文件（还在攒）
bf.touch(chat, 'm1')
ok(!existsSync(file), 'touch 之后立刻检查：还没落盘（攒着呢）')

// ② 500ms 之后自动落盘
await new Promise((r) => setTimeout(r, 700))
ok(existsSync(file), '700ms 后自动落盘了')
const j1 = JSON.parse(readFileSync(file, 'utf8'))
ok(j1.chats['dm:u-test']?.at > 0, '水位时间写进去了')
ok(j1.chats['dm:u-test']?.seen?.includes('m1'), 'msgid 记进去了')

// ③ 连发 50 条，只应该落盘一次（用 mtime 判断）
const before = statSync(file).mtimeMs
for (let i = 0; i < 50; i += 1) bf.touch(chat, 'burst-' + i)
const during = statSync(file).mtimeMs
ok(during === before, '连发 50 条期间一次都没写盘（全攒着）')
await new Promise((r) => setTimeout(r, 700))
const after = statSync(file).mtimeMs
ok(after > before, '攒完之后写了一次')
const j2 = JSON.parse(readFileSync(file, 'utf8'))
ok(j2.chats['dm:u-test'].seen.length === 51, `50 条全记下了（seen=${j2.chats['dm:u-test'].seen.length}）`)

// ④ flush 立刻落盘，不等 500ms
bf.touch(chat, 'flush-test')
const m3 = statSync(file).mtimeMs
bf.flush()
ok(statSync(file).mtimeMs > m3, 'flush() 立刻落盘，没等 500ms')
const j3 = JSON.parse(readFileSync(file, 'utf8'))
ok(j3.chats['dm:u-test'].seen.includes('flush-test'), 'flush 的内容也写进去了')

// ⑤ 没有改动时 flush 不写（省一次 IO）
const m4 = statSync(file).mtimeMs
bf.flush()
ok(statSync(file).mtimeMs === m4, '没改动时 flush 不写盘')

// ⑥ SEEN_KEEP 滚动上限：塞 4100 条，只留最后 4000
for (let i = 0; i < 4100; i += 1) bf.touch(chat, 'keep-' + i)
bf.flush()
const j4 = JSON.parse(readFileSync(file, 'utf8'))
const seen = j4.chats['dm:u-test'].seen
ok(seen.length === 4000, `seen 滚动到上限 4000（实际 ${seen.length}）`)
ok(seen[seen.length - 1] === 'keep-4099', '留下的是最新的那条')

rmSync(dir, { recursive: true, force: true })
console.log(fails ? `\n❌ ${fails} 条失败` : '\n✅ 水位防抖写盘全部通过')
process.exit(fails ? 1 : 0)
