// 依赖解析：ws 这类包在 DSH 的 profile 里有，但插件自己的 node_modules 未必装。
//
// 顺序：① 插件自己的 node_modules（用户 npm i 过就有）② DSH_HOME/profiles/*/node_modules
//      ③ cwd 往上 ④ DSH_TOOLS_PATH 那套。找到就用，找不到返回 undefined（调用方自己降级）。
//
// 为什么必须用 ws：企微 openws 服务端的升级握手跟 Node 全局 WebSocket(undici) 不兼容，
// 实测订阅必失败（im-union lib/channels/wecom.js:3 原话）。

import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

function bases() {
  const out = [join(here, '..', '..')] // 插件根
  // 两个 home 都要看：DSH_HOME（可能是用户指定的数据目录）和真正的 ~/.dsh。
  // 之所以两个都看：有人把 DSH_HOME 指到别处（测试、便携版），依赖包仍可能装在 ~/.dsh 下。
  const homes = []
  if (process.env.DSH_HOME) homes.push(process.env.DSH_HOME)
  const realHome = join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
  if (realHome && !homes.includes(realHome)) homes.push(realHome)
  for (const home of homes) {
    try {
      const profiles = join(home, 'profiles')
      if (existsSync(profiles)) {
        for (const name of readdirSync(profiles)) out.push(join(profiles, name, 'node_modules'))
      }
      out.push(join(home, 'node_modules'))
    } catch {}
  }
  out.push(process.cwd())
  return out
}

const cache = new Map()

/** 解析一个包，返回模块本身；找不到返回 undefined。 */
export function tryRequire(name) {
  if (cache.has(name)) return cache.get(name)
  let found
  for (const base of bases()) {
    try {
      const req = createRequire(join(base, 'noop.js'))
      found = req(name)
      break
    } catch {}
  }
  cache.set(name, found)
  return found
}
