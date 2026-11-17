// 外部二进制的定位与「告诉上游」。
//
// 为什么要有这个文件：上游 dsh-video-storyboard 的 `discoverYtdlp()` 只认三条路 ——
// `env.DSH_YTDLP_PATH`、PATH、pip 脚本目录。而 DSH 桌面版**读不到用户用 setx 设的环境变量**
// （这是上游自己在 asr.json 的注释里写过的坑），用户把 yt-dlp 放在 `~/.dsh/tools/` 下时
// 三条路全落空，`tried = []`，抖音/B站链接一律报「yt-dlp not found」。
//
// 解法不是改上游（node_modules 会被覆盖），而是**在插件启动时把它塞进 process.env**：
// 这是上游明确设计的第一优先级通道，属于正当用法。
//
// 边界：只在原本没有该变量时才写，绝不覆盖用户自己设的；找不到就什么都不做，让上游照常报错。

import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 找 yt-dlp 的候选路径。顺序与上游的偏好一致：显式配置优先，其次 DSH 自带的工具目录。 */
export function ytdlpCandidates({ env = process.env, extraDirs = [] } = {}) {
  const home = env.DSH_HOME || join(env.USERPROFILE || env.HOME || '', '.dsh')
  const exe = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
  const cands = []
  if (env.DSH_YTDLP_PATH) cands.push(env.DSH_YTDLP_PATH)
  // ~/.dsh/tools 是 DSH 自己的工具目录（ffmpeg 也在这），用户手动下载的 exe 通常丢这
  cands.push(join(home, 'tools', exe))
  cands.push(join(home, 'bin', exe))
  for (const dir of extraDirs) {
    if (dir) cands.push(join(dir, exe))
  }
  return cands
}

export function findYtdlp({ env = process.env, exists = existsSync, extraDirs = [] } = {}) {
  for (const p of ytdlpCandidates({ env, extraDirs })) {
    try {
      if (p && exists(p)) return p
    } catch { /* 忽略不可读的候选 */ }
  }
  return ''
}

/**
 * 把找到的 yt-dlp 路径写进 process.env，让上游的 discoverYtdlp 能捡到。
 *
 * 幂等：已经设了就原样返回，不覆盖（用户显式配置永远优先）。
 * @returns {{ok:boolean, path:string, set:boolean, reason:string}}
 */
export function exposeYtdlp({ env = process.env, exists = existsSync, extraDirs = [], log } = {}) {
  if (env.DSH_YTDLP_PATH) {
    return { ok: true, path: env.DSH_YTDLP_PATH, set: false, reason: '已由环境变量指定' }
  }
  const hit = findYtdlp({ env, exists, extraDirs })
  if (!hit) {
    log?.warn?.(
      '没找到 yt-dlp：抖音/B站这类链接看不了。'
      + '下载 yt-dlp.exe 放到 ' + join(env.DSH_HOME || '~/.dsh', 'tools') + ' 下，或设 DSH_YTDLP_PATH',
    )
    return { ok: false, path: '', set: false, reason: '没找到 yt-dlp' }
  }
  env.DSH_YTDLP_PATH = hit
  log?.info?.(`yt-dlp 已接入：${hit}`)
  return { ok: true, path: hit, set: true, reason: '' }
}
