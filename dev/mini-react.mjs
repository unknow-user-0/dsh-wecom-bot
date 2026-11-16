// 极简 React 实现：够跑面板就够了
//
// 为什么自己写：插件网页半边跑在 DSH 的模块加载器里，本地没装 react 也跑不了它。
// 为了能在命令行里把每个标签页真的渲染一遍（抓运行时错误 + 导出 HTML 看长相），
// 这里实现最小的 hooks 引擎 + 函数组件展开（展开后只剩宿主元素，交给 toHtml 序列化）。
//
// 支持：useState / useEffect / useRef / useMemo / useCallback / Fragment、
//       嵌套函数组件（各自独立的 hook 帧，按展开顺序编号持久化）、手动 act() 触发交互。
// 不支持：key 复用、context、memo、并发、事件合成、真实 DOM。
//
// 帧缓存的意义：子组件（比如「记忆」页）在 useEffect 里发请求再 setState，
// 帧不持久化的话每次重渲染都会退回空状态，永远看不到内容。

const FRAMES = new Map() // key -> { states, effects }
let frame = null // 当前组件的帧
let frameKey = null
let path = [] // 展开路径（用于给每个子组件实例稳定编号）
let dirty = false

function ensureFrame(key) {
  let f = FRAMES.get(key)
  if (!f) { f = { states: [], effects: [], index: 0 } ; FRAMES.set(key, f) }
  return f
}

export const React = {
  createElement(type, ...rest) {
    let p = {}
    let kids = rest
    if (rest.length && rest[0] && typeof rest[0] === 'object' && !Array.isArray(rest[0]) && !rest[0].$$el) {
      p = rest[0]
      kids = rest.slice(1)
    }
    return { $$el: true, type, props: p || {}, kids: kids.flat(Infinity) }
  },
  useState(init) {
    const f = frame
    const i = f.index++
    if (!(i in f.states)) f.states[i] = typeof init === 'function' ? init() : init
    const set = (v) => {
      const next = typeof v === 'function' ? v(f.states[i]) : v
      if (Object.is(next, f.states[i])) return
      f.states[i] = next
      dirty = true
    }
    return [f.states[i], set]
  },
  useRef(v) {
    const i = frame.index++
    if (!(i in frame.states)) frame.states[i] = { current: v }
    return frame.states[i]
  },
  useMemo(fn) {
    const i = frame.index++
    if (!(i in frame.states)) frame.states[i] = fn()
    return frame.states[i]
  },
  useCallback(fn) {
    const i = frame.index++
    if (!(i in frame.states)) frame.states[i] = fn
    return frame.states[i]
  },
  useEffect(fn) {
    const i = frame.index++
    frame.effects[i] = fn
  },
  Fragment: 'Fragment',
}

const sleep = () => new Promise((r) => setTimeout(r, 0))

/** 展开函数组件：类型变成字符串元素，子组件各自拿帧 */
function expand(node, depth = 0) {
  if (node == null || node === false || node === true) return node
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map((n, i) => { path.push(i); const r = expand(n, depth + 1); path.pop(); return r })
  if (typeof node !== 'object' || !node.$$el) return node

  const { type, props, kids } = node
  if (type === 'Fragment') return kids.map((n, i) => { path.push(i); const r = expand(n, depth + 1); path.pop(); return r })

  if (typeof type === 'function') {
    if (depth > 80) return { $$el: true, type: 'div', props: {}, kids: ['<!-- 太深了 -->'] }
    const key = (type.name || 'anon') + '@' + path.join('.')
    const prevFrame = frame
    const prevKey = frameKey
    const f = ensureFrame(key)
    f.index = 0
    const beforeEffects = f.effects.slice()
    frame = f
    frameKey = key
    // 真实 React 会把子元素塞进 props.children（单个不包数组），这里照做
    const childProps = kids.length === 0 ? undefined : kids.length === 1 ? kids[0] : kids
    const propsWithKids = childProps === undefined ? props : { ...props, children: childProps }
    let out
    try {
      out = type(propsWithKids)
    } catch (error) {
      out = { $$el: true, type: 'div', props: { className: 'wb-error' }, kids: ['组件 ' + (type.name || '?') + ' 渲染失败：' + error.message] }
    }
    // 跑本轮新出现的 effect
    for (let i = 0; i < f.effects.length; i++) {
      const fn = f.effects[i]
      if (fn && beforeEffects[i] !== fn && !fn.__ran) {
        fn.__ran = true
        try { const off = fn(); if (typeof off === 'function') fn.__off = off } catch { /* 吞掉 */ }
      }
    }
    frame = prevFrame
    frameKey = prevKey
    return expand(out, depth + 1)
  }
  return { $$el: true, type, props, kids: kids.map((n, i) => { path.push(i); const r = expand(n, depth + 1); path.pop(); return r }) }
}

export function createMiniReact({ settleRounds = 12 } = {}) {
  function createRoot(Component, props = {}) {
    let expanded = null

    async function run() {
      for (let round = 0; round < settleRounds; round++) {
        dirty = false
        path = []
        const raw = React.createElement(Component, props)
        expanded = expand(raw)
        await sleep()
        await sleep()
        if (!dirty) break
      }
      return expanded
    }

    async function act(fn) {
      try { fn() } catch { /* 吞掉 */ }
      return run()
    }

    return { run, act, getTree: () => expanded }
  }

  async function render(Component, props = {}) {
    const root = createRoot(Component, props)
    await root.run()
    return root.getTree()
  }

  return { React, createRoot, render, reset: () => FRAMES.clear() }
}

/** 已展开的树 → HTML 字符串 */
export function toHtml(node) {
  if (node == null || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return escape(String(node))
  if (Array.isArray(node)) return node.map(toHtml).join('')
  if (typeof node !== 'object' || !node.$$el) return ''
  const { type, props, kids } = node
  if (typeof type === 'function') {
    try { return toHtml(expand(node)) } catch (e) { return '<!-- 展开失败：' + escape(e.message) + ' -->' }
  }
  const attrs = []
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'children') continue
    if (v == null || v === false) continue
    if (typeof v === 'function') continue
    if (k === 'style' && typeof v === 'object') {
      attrs.push(`style="${escape(Object.entries(v).map(([a, b]) => `${camel(a)}:${b}`).join(';'))}"`)
      continue
    }
    if (k === 'className') { attrs.push(`class="${escape(String(v))}"`); continue }
    attrs.push(`${k}="${escape(String(v))}"`)
  }
  const inner = (kids || []).map(toHtml).join('')
  const voidTags = new Set(['input', 'img', 'br', 'hr', 'meta', 'link'])
  if (voidTags.has(type)) return `<${type} ${attrs.join(' ')}>`
  return `<${type} ${attrs.join(' ')}>${inner}</${type}>`
}

/** 按文字找带 onClick 的元素 */
export function findByText(tree, text) {
  const out = []
  const walk = (n) => {
    if (!n) return
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (typeof n !== 'object' || !n.$$el) return
    if (n.props?.onClick && textOf(n).includes(text)) out.push(n)
    ;(n.kids || []).forEach(walk)
  }
  walk(tree)
  return out
}

export function textOf(node) {
  if (node == null) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node !== 'object' || !node.$$el) return ''
  return (node.kids || []).map(textOf).join('')
}

function camel(s) { return s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()) }
function escape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
