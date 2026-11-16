// 心情：0~100，基线 60。聊天里的话按关键词推一推，随时间按半衰期回到基线。
//
// 设计取舍（和 araubot 的差别）：
//   - araubot 的心情会影响「发表情包/发语音的概率、回复快慢、群里插话积极程度」。
//     企微这边没有表情包、没有语音合成、也不做延迟拟真，所以心情**只剩一件事：影响语气**。
//     这正好也是老大定的口径 ——「心情降级为只影响语气」。
//   - 因此这里只保留 moodLabel / MOOD_STYLE / scoreText / decayed / 储存与 contextLine。
//
// 为什么不做模型判心情：那要每轮多打一次模型，成本翻倍，收益只是语气更细腻。
// 关键词够用，且完全本地、不花钱。

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export const BASE = 60

const UP = ['喜欢你', '爱你', '想你', '可爱', '好看', '漂亮', '聪明', '真棒', '厉害', '牛', '谢谢', '辛苦', '晚安', '早安', '抱抱', '摸摸', '贴贴', '乖', '宝贝', '爱了', '哈哈哈', '好吃', '请你吃', '棒']
const DOWN = ['讨厌', '滚', '烦死', '闭嘴', '笨', '蠢', '傻', '丑', '垃圾', '废物', '恶心', '无聊', '走开', '别理我', '不理你', '别说话', '生气', '难过', '烦人', '废物']

export function moodLabel(v) {
  if (v >= 85) return '超开心'
  if (v >= 70) return '心情不错'
  if (v >= 50) return '平平常常'
  if (v >= 35) return '有点低落'
  return '不太开心'
}

/** 每种心情下具体怎么说话。平平常常返回空串 —— 别把性格念「定」住。 */
export function moodStyle(v) {
  const label = moodLabel(v)
  if (label === '超开心') return '话多一点、语气活泼，爱用语气词和感叹，会主动接话、开玩笑'
  if (label === '心情不错') return '语气轻快，爱开点小玩笑，回得积极一些'
  if (label === '有点低落') return '话少一点、句子短，回得有点懒；有人关心你会慢慢好起来'
  if (label === '不太开心') return '有点小脾气、带点委屈，回得简短，可能会怼一句（但别伤人）；被哄、被夸会消气'
  return ''
}

/** 一句话让心情变化多少（-20~20）。 */
export function scoreText(text) {
  const t = String(text || '')
  let d = 0
  for (const w of UP) if (t.includes(w)) d += 6
  for (const w of DOWN) if (t.includes(w)) d -= 8
  return Math.max(-20, Math.min(20, d))
}

/** 按半衰期回落到基线。 */
export function decayed(value, at, halfLifeHours, now = Date.now()) {
  const h = Math.max(0, (now - at) / 3600_000)
  return BASE + (value - BASE) * Math.pow(0.5, h / halfLifeHours)
}

/**
 * @param {object} opts
 * @param {() => object} opts.getConfig  取插件配置（要 mood.enabled / mood.halfLifeHours）
 * @param {string} opts.dataDir          落盘目录
 */
export function createMood({ getConfig, dataDir }) {
  const file = () => join(dataDir, 'mood.json')
  const load = () => {
    try {
      if (existsSync(file())) {
        const s = JSON.parse(readFileSync(file(), 'utf8'))
        return { value: Number(s.value) || 65, at: Number(s.at) || Date.now(), reason: String(s.reason || ''), history: Array.isArray(s.history) ? s.history : [] }
      }
    } catch {}
    return { value: 65, at: Date.now(), reason: '', history: [] }
  }
  const save = (s) => {
    try {
      mkdirSync(dataDir, { recursive: true })
      const tmp = file() + '.tmp'
      writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8')
      renameSync(tmp, file())
    } catch {}
  }

  const halfLife = () => Number(getConfig()?.mood?.halfLifeHours) || 72

  function current() {
    const s = load()
    return Math.round(decayed(s.value, s.at, halfLife()))
  }

  function nudge(d, reason) {
    if (!getConfig()?.features?.mood || !d) return
    const s = load()
    const before = current()
    s.value = Math.max(5, Math.min(100, before + d))
    s.at = Date.now()
    s.reason = reason
    s.history = [{ at: Date.now(), from: before, to: Math.round(s.value), reason }, ...s.history].slice(0, 20)
    save(s)
  }

  return {
    current,
    label: () => moodLabel(current()),
    state: () => ({ ...load(), value: current(), label: moodLabel(current()), baseline: BASE }),
    /**
     * 聊天里的一句话。direct = 是对她说的（私聊 / 群里 @ 她）。
     * 群聊里顺带听见的话只算三成。
     */
    observe(text, who, { direct = true, owner = false } = {}) {
      if (!getConfig()?.features?.mood) return
      const d0 = scoreText(text)
      if (!d0) return
      const d = Math.round(d0 * (direct ? 1 : 0.3) * (owner ? 1.5 : 1))
      nudge(d, `${who || '有人'}说「${String(text).slice(0, 20)}」`)
    },
    /** 每轮拼进上下文的语气提示。平平常常返回空串。 */
    contextLine() {
      if (!getConfig()?.features?.mood) return ''
      const s = load()
      const v = current()
      const style = moodStyle(v)
      if (!style) return ''
      return `（你现在${moodLabel(v)}${s.reason ? '，因为' + s.reason : ''}。这会自然地影响你说话：${style}。不用说出来自己心情如何。）`
    },
    reset() { save({ value: BASE, at: Date.now(), reason: '', history: [] }) },
  }
}
