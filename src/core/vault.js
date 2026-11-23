// 凭据管理：bot_id / secret / 各服务的 MCP URL 全走 DSH 凭据库，不进配置文件
//
// 为什么不用配置文件：
//   - .credentials.yaml 已被 DSH 的凭据围栏保护（ops_inspect_local_file 读会被 CREDENTIAL_DENIED）
//   - 配置面板会把 config.json 整个吐给前端，密钥放里面等于明文外泄
//
// ref 命名：WECOM_BOT_<KEY>（大写、只留 [A-Za-z0-9_]）
//   WECOM_BOT_BOTID / WECOM_BOT_SECRET
//   WECOM_BOT_MCP_<SERVICE>_<ADMINHASH>  ← 每个管理员每个服务一条

import { createHash } from 'node:crypto'

/**
 * 凭据引用名。只留真正在用的那几个 —— 这里多写一个「看起来很完整」的键
 * （比如 botId），会让人以为 bot_id 也走凭据库，实际它明文躺在 config.json 里
 * （面板要显示它，本来也不是秘密）。名字对不上现实比少一个字段更糟。
 */
export const REF = {
  secret: 'WECOM_BOT_SECRET',
}

/** 管理员的服务凭据 ref：按 userid 的短哈希区分，不会撞也不会泄露原始 id */
export function mcpRef(service, userid) {
  const h = createHash('sha256').update(String(userid)).digest('hex').slice(0, 10).toUpperCase()
  return `WECOM_BOT_MCP_${String(service).toUpperCase()}_${h}`
}

/** 内存兜底（宿主没有凭据服务时用；只活在进程内，不落盘） */
const memory = new Map()

export function createVault(ctx, log) {
  const svc = ctx.get?.('credentials') || ctx.credentials

  async function set(ref, value) {
    const v = String(value ?? '')
    if (!v) return unset(ref)
    // 先写内存镜像：面板/长连接里的同步分支（peek）立刻能读到，
    // 不用等宿主凭据库那次 await 回来
    memory.set(ref, v)
    if (svc && typeof svc.set === 'function') {
      await svc.set(ref, v)
      return true
    }
    log?.debug?.(`凭据服务不可用，${ref} 暂存内存`)
    return true
  }

  async function resolve(ref) {
    if (svc && typeof svc.resolve === 'function') {
      try {
        const r = await svc.resolve(ref)
        // 宿主返回 { value, source }，也兼容 { secret } 和裸字符串
        if (typeof r === 'string') return r || undefined
        if (r && typeof r === 'object') {
          const inner = typeof r.value === 'string' && r.value !== '' ? r.value
            : typeof r.secret === 'string' && r.secret !== '' ? r.secret : undefined
          if (inner !== undefined) return inner
        }
      } catch (error) {
        log?.debug?.(`凭据解析失败（${ref}）：${error.message}`)
      }
    }
    return memory.get(ref) || undefined
  }

  async function unset(ref) {
    memory.delete(ref)
    if (svc && typeof svc.unset === 'function') {
      try { await svc.unset(ref) } catch {}
    }
    return true
  }

  return {
    set,
    resolve,
    unset,
    /**
     * 同步读内存镜像。面板的 /state、连接前的就绪判断这类同步位置用它；
     * 进程刚起来时镜像还空，就先跑一次 warm() 把宿主里的值灌进镜像。
     */
    peek: (ref) => memory.get(ref) || undefined,
    /** 把宿主凭据库里的值预热进内存镜像（启动时 await 一次即可） */
    warm: async (refs) => {
      for (const ref of refs || []) {
        try {
          const v = await resolve(ref)
          if (v) memory.set(ref, v)
        } catch {}
      }
      return true
    },
    has: async (ref) => Boolean(await resolve(ref)),
    kind: svc && typeof svc.set === 'function' ? 'service' : 'memory',
  }
}
