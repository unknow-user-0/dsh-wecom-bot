#!/usr/bin/env node
// 离线排查：单聊的 chat_id 到底该传什么
//
// 这个脚本和面板里那张「排查」卡片是同一套判定 —— 都调 src/wecom/diagnose.js。
// 它存在的唯一理由是：插件能点面板，就得先连上 DSH；连不上的时候，
// 用户还能在终端里跑一下，读的是磁盘上的配置，不依赖插件运行时。
//
// ⚠ 曾经这里自己写了一套判定，结果插件那边修好了、这里没跟上，
//   两处结论互相矛盾（旧版还推荐「改走被动回复发图」，那条路早已被真机证伪：
//   doc 服务换来的 media_id 走 aibot_respond_msg 报 40007 invalid media_id）。
//   所以现在这里是**薄壳**：只负责「在没有插件运行时的环境下把配置读出来」，
//   判定一个字都不许重写。
//
// 用法：
//   node dev/diagnose-chatid.mjs            只看结论
//   node dev/diagnose-chatid.mjs --verbose  连每一步的日志一起看
//
// 只读：只列会话、只查通讯录，一条消息都不发。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const VERBOSE = process.argv.includes('--verbose')

const HOME = process.env.DSH_HOME
  || join(process.env.USERPROFILE || homedir(), '.dsh')
// 插件和凭据库都以 DSH_HOME 为准，这里先摆好再 import ——
// src/core/config.js 是在模块加载时算 DATA_DIR 的，顺序错了就读到别的目录。
process.env.DSH_HOME = HOME

const DATA_DIR = join(HOME, 'plugins-data', 'wecom-bot')
const CONFIG_FILE = join(DATA_DIR, 'config.json')
const CRED_FILE = join(HOME, '.credentials.yaml')

function line(s = '') { process.stdout.write(s + '\n') }
function section(t) { line(''); line('='.repeat(64)); line(t); line('='.repeat(64)) }

/** 从 .credentials.yaml 里抠出某个 ref 的值（离线环境下没法用插件的凭据服务） */
function readCredRefs() {
  let text = ''
  try { text = readFileSync(CRED_FILE, 'utf8') } catch { return {} }
  const out = {}
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s{0,4}([A-Za-z_][A-Za-z0-9_]*):\s*(.+?)\s*$/.exec(raw)
    if (!m) continue
    const value = m[2].replace(/^['"]|['"]$/g, '')
    if (/^https?:\/\//.test(value)) out[m[1]] = value
  }
  return out
}

async function main() {
  const { loadConfig } = await import('../src/core/config.js')
  const { createMcpClient } = await import('../src/wecom/mcp.js')
  const { mcpRef } = await import('../src/core/vault.js')
  const { diagnoseChatId } = await import('../src/wecom/diagnose.js')

  line(`离线排查：${new Date().toISOString()}`)
  line(`DSH_HOME：${HOME}`)
  line(`node：${process.version} / ${process.platform}`)

  let cfg
  try {
    cfg = loadConfig()
  } catch (error) {
    section('读不到配置')
    line(`路径：${CONFIG_FILE}`)
    line(`原因：${error.message}`)
    line('先在 DSH 里把插件跑起来一次（面板里填好 bot_id 和 MCP），再来跑这个。')
    process.exit(1)
  }

  // 地址的真身在凭据库，配置文件里那份只是副本（2026-11 修过一次这个认知）。
  // 离线时用不到插件的 vault 服务，所以这里按同样的优先级手工取一遍：
  // 先查凭据库的 ref，取不到再退回配置文件里的明文。
  const creds = readCredRefs()
  if (VERBOSE && Object.keys(creds).length) {
    line(`凭据库：读到 ${Object.keys(creds).length} 条 https 类凭据`)
  }
  const pool = new Map()
  const mcpFor = async (service, userid) => {
    const owner = (cfg.admins || []).find((a) => a.role === 'owner') || (cfg.admins || [])[0]
    const uid = userid || owner?.userid
    const plain = owner?.mcp?.[service]
    const ref = uid ? mcpRef(service, uid) : ''
    const url = (ref && creds[ref]) || plain
    if (!url) return null
    if (VERBOSE) line(`  [mcp] ${service} → ${url.slice(0, 48)}…（${creds[ref] ? '凭据库' : '配置文件'}）`)
    if (!pool.has(url)) {
      pool.set(url, await createMcpClient(url, {
        log: VERBOSE ? (level, text) => line(`  [${level}] ${text}`) : () => {},
      }))
    }
    return pool.get(url)
  }

  const r = await diagnoseChatId({
    cfg,
    mcpFor,
    log: VERBOSE ? (level, text) => line(`[${level}] ${text}`) : undefined,
  })

  if (!r?.ok) {
    section('排查没跑起来')
    line(String(r?.message || '未知原因'))
    process.exit(1)
  }

  section('结论')
  line(r.lines.join('\n'))

  section('怎么用这份结果')
  line('· 结论是「看着没问题」：那这次发不出去就不是会话 ID 的事，')
  line('  打开面板「日志」页的「详细日志」，复现一次，把新出现的日志发出来。')
  line('· 结论说「换算不出来 / 没配 contact」：按里面写的下一步去做。')
  line('· 报告里的 ID 都已脱敏，可以直接整份发出去。')
  line('')
  line(`（整体判定：${r.level}）`)

  process.exit(r.level === 'err' ? 2 : 0)
}

main().catch((error) => {
  line('')
  line(`排查脚本自己出错了：${error?.stack || error}`)
  process.exit(1)
})
