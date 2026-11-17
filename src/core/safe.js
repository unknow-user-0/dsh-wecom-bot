// 边界防呆：把「插件内部的失败」关在插件里，别让它掀掉整个宿主进程。
//
// 为什么需要这个文件（真机踩过的坑）：
//   Node 24 默认 --unhandled-rejections=throw，一个没人接的 Promise 拒绝
//   会直接把进程干掉。DSH 宿主跑在同一个进程里，插件里一次上传失败
//   就能让用户整个 DSH 崩掉 —— 这不是「某个功能有 bug」，
//   是「插件有权杀死宿主」，性质完全不同。
//
// 两条规则，全插件通用：
//   1. 异步调用不许裸奔：要么 await（在 try 里），要么 fireAndForget()。
//   2. 日志调用只走 asLog()：外面传 logger 对象还是 (level, text) 函数都能吃，
//      而且日志自己再出错也不会反过来炸业务。

/**
 * 日志兼容层：外面可能传 logger 对象（.info/.warn），也可能传 log(level, text) 函数。
 * 返回的函数永远是安全的 —— 调日志本身绝不会抛错。
 *
 * @param {Function|object} [log]
 * @returns {(level: string, text: unknown) => void}
 */
export function asLog(log) {
  if (typeof log === 'function') {
    return (level, text) => {
      try { log(level, text) } catch {}
    }
  }
  if (log && typeof log.info === 'function') {
    return (level, text) => {
      const fn = typeof log[level] === 'function' ? log[level] : log.info
      try { fn.call(log, String(text ?? level)) } catch {}
    }
  }
  if (log && typeof log.debug === 'function') {
    // 只实现了 debug 的最小 logger
    return (level, text) => {
      const fn = typeof log[level] === 'function' ? log[level] : log.debug
      try { fn.call(log, String(text ?? level)) } catch {}
    }
  }
  return () => {}
}

/**
 * 起一个不需要等的异步任务，并保证它的失败不会变成 unhandledRejection。
 * 用法：fireAndForget(sendImage(...), '发送占位图', log)
 *
 * @param {Promise<unknown>} promise
 * @param {string} [what] 失败时日志里写什么
 * @param {Function|object} [log]
 * @param {string} [level] 失败记到哪一级，默认 'warn'
 * @returns {Promise<unknown>} 永远 resolve 的包装后的 promise（方便测试等它）
 */
export function fireAndForget(promise, what = '', log = undefined, level = 'warn') {
  const write = asLog(log)
  return Promise.resolve(promise).catch((error) => {
    write(level, `${what || '后台任务'}失败：${error?.message || error}`)
    return undefined
  })
}

/** 只取错误信息，永不为 null */
export function messageOf(error) {
  if (!error) return '未知错误'
  if (typeof error === 'string') return error
  return error.message || String(error)
}
