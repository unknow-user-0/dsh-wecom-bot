// 主动搭话：主人一段时间没理她时，她在**私聊里**主动找主人说几句。
//
// 三条企微特有的硬约束，代码里必须守住：
//   1. 只能推给「已激活」的会话 —— 企微规定用户先给机器人发过消息，才有会话实体。
//      没跟机器人说过话的人，推不进去（errcode 会报错）。所以这里只对管理员私聊推，
//      而且要确认那个私聊会话确实存在过（sessions.json 里有记录）。
//   2. 频率上限每会话 30 条/分钟、1000 条/小时 —— 主动搭话是低频的，但要在代码里留一条
//      自己的节流（最少间隔 + 每天上限），别把协议配额吃掉。
//   3. 只对主人（owner）做，不对普通成员做 —— 主动打扰陌生人是最招人烦的功能。
//
// 和 araubot 的差别：那边有「追问」（她问了一句主人 15~40 分钟没回，轻轻追一句）。
// 企微这边保留，但只在主人私聊里。

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

// 每次换个由头，免得句句都是「在干嘛」
const ANGLES = [
  '分享一件你今天（编也行，符合你的人设）遇到的小事或想到的东西',
  '接着你们上次聊的话题，问问后来怎么样了',
  '想起记忆里关于对方的一件事，顺口提一句或关心一下',
  '问问对方现在在干嘛、吃了没、累不累',
  '撒个娇或者吐槽一句，说你有点无聊',
  '一句没头没尾的感慨',
  '看看现在几点，按时间说点应景的（早上、饭点、深夜）',
]

/**
 * @param {object} opts
 * @param {() => object} opts.getConfig
 * @param {string} opts.dataDir
 * @param {(text: string, reason: string) => Promise<boolean>} opts.deliver
 *        把这段话交给主人私聊（只 append 不 followup 的那条路走不通 —— 主动搭话要模型先说话）。
 *        实现方负责：建/复用主人私聊会话、发一条系统提醒、等模型回复、推给企微。
 * @param {() => number} opts.idleMinutesOf  主人多久没跟自己说话了（分钟）
 * @param {object} opts.log
 */
export function createSpeakUp({ getConfig, dataDir, deliver, idleMinutesOf, log }) {
  const file = () => join(dataDir, 'speakup.json')
  const load = () => {
    try {
      if (existsSync(file())) {
        const s = JSON.parse(readFileSync(file(), 'utf8'))
        return { day: String(s.day || ''), count: Number(s.count) || 0, nextAt: Number(s.nextAt) || 0, last: Number(s.last) || 0, nudgedAt: Number(s.nudgedAt) || 0 }
      }
    } catch {}
    return { day: '', count: 0, nextAt: 0, last: 0, nudgedAt: 0 }
  }
  const save = (s) => {
    try {
      mkdirSync(dataDir, { recursive: true })
      const tmp = file() + '.tmp'
      writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8')
      renameSync(tmp, file())
    } catch {}
  }

  const cfgOf = () => getConfig()?.speakUp || {}
  const enabled = () => Boolean(getConfig()?.enabled && getConfig()?.features?.speakUp && cfgOf().enabled)

  function schedule(s, c) {
    const min = Number(c.minIntervalMinutes) || 90
    const max = Math.max(min, Number(c.maxIntervalMinutes) || 240)
    s.nextAt = Date.now() + (min + Math.random() * (max - min)) * 60_000
  }

  /** 主动说一句。返回是否真的说了。 */
  async function fire(reason = '定时', { nudge = false } = {}) {
    if (!enabled()) return false
    const c = cfgOf()
    const owner = getConfig()?.ownerName || '主人'
    const idle = idleMinutesOf()
    const angle = ANGLES[Math.floor(Math.random() * ANGLES.length)]
    const prompt = nudge
      ? `【系统提醒，不是${owner}说的话】你刚才跟${owner}说了一句，${owner}已经 ${idle} 分钟没回了。可以轻轻追一句（比如「人呢」「睡着啦？」，或者换个话题），别催、别抱怨；觉得${owner}在忙就只回 ${'[沉默]'}。`
      : `【系统提醒，不是${owner}说的话】你已经 ${idle > 600 ? '很久' : idle + ' 分钟'}没和${owner}说上话了，想主动找${owner}说点什么。这次的由头可以是：${angle}。用你自己的口气，一两句就好，别用模板、别解释为什么来找；实在不想说就只回 ${'[沉默]'}。`
    try {
      const ok = await deliver(prompt, nudge ? '追问' : reason)
      if (ok) log?.info?.(`主动搭话（${nudge ? '追问' : reason}）`)
      return Boolean(ok)
    } catch (error) {
      log?.warn?.(`主动搭话失败：${error.message}`)
      return false
    }
  }

  /** 定时器每分钟调一次。 */
  async function tick() {
    if (!enabled()) return
    const c = cfgOf()
    const s = load()
    const today = new Date().toDateString()
    if (s.day !== today) Object.assign(s, { day: today, count: 0 })
    if (!s.nextAt) schedule(s, c)

    const h = new Date().getHours()
    const awakeFrom = Number(c.awakeFrom ?? 8)
    const awakeTo = Number(c.awakeTo ?? 23)
    const awake = awakeFrom <= awakeTo ? h >= awakeFrom && h < awakeTo : h >= awakeFrom || h < awakeTo
    if (!awake) { save(s); return }

    const idle = idleMinutesOf()

    // 追问：她最后一句是在问主人，主人 15~40 分钟没回，有一半的机会轻轻追一句（不占每天次数）
    if (c.nudge && s.nudgedAt && Date.now() - s.nudgedAt > 15 * 60_000 && Date.now() - s.nudgedAt < 40 * 60_000 && idle > 15) {
      s.nudgedAt = 0
      save(s)
      if (Math.random() < 0.5) await fire('追问', { nudge: true })
      return
    }

    const idleOk = idle > (Number(c.idleMinutes) || 120)
    const quotaOk = s.count < (Number(c.maxPerDay) || 4)
    if (idleOk && quotaOk && Date.now() >= s.nextAt) {
      s.count += 1
      s.last = Date.now()
      schedule(s, c)
      save(s)
      await fire()
      return
    }
    save(s)
  }

  return { tick, fire, state: load, enabled, markAsked: () => { const s = load(); s.nudgedAt = Date.now(); save(s) } }
}
