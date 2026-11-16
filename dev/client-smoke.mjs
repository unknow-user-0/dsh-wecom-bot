// 网页半边冒烟：不装进 DSH、不真的有 React，也能验出
//   - 模块能否被 __ModuleLoader__ 加载（factory 里有没有语法/引用错误）
//   - apply() 有没有把两个槽位注册上
//   - 各标签页组件是不是真的能调用（用极简假 React 渲染一遍，抓运行时错误）
//
// 跑法：node dev/client-smoke.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

// ---- 极简假 React：只要不炸就行 ----
const React = {
  createElement: (type, props, ...kids) => ({ $$el: true, type, props: props || {}, kids }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  Fragment: 'Fragment',
}

// ---- 假 window / document ----
const registered = []
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      registered.push({ id, mod: factory((name) => (name === 'react' ? React : {})) })
    },
  },
}
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ set textContent(v) {}, id: '' }),
  head: { appendChild() {} },
}
globalThis.fetch = async () => ({ json: async () => ({ ok: false, message: 'smoke' }) })
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}

// ---- 加载 ----
const code = readFileSync(join(HERE, '..', 'client', 'client.js'), 'utf8')
// 浏览器里有 window；这里直接把脚本当全局脚本跑
new Function('window', 'document', 'fetch', 'setInterval', 'clearInterval', code)(
  globalThis.window, globalThis.document, globalThis.fetch, globalThis.setInterval, globalThis.clearInterval,
)

const problems = []
if (!registered.length) problems.push('模块没被注册（__ModuleLoader__.load 没调到）')
for (const { id, mod } of registered) {
  if (id !== 'dsh-wecom-bot') problems.push('模块 id 不对：' + id)
  if (typeof mod.apply !== 'function') problems.push('没导出 apply')
  if (!Array.isArray(mod.inject)) problems.push('没导出 inject 数组')
  else if (!mod.inject.includes('slots')) problems.push('inject 里没有 slots')
  if (typeof mod.WeComPage !== 'function') problems.push('没导出 WeComPage')
  if (typeof mod.ChatIcon !== 'function') problems.push('没导出 ChatIcon')

  // 槽位注册
  const slots = new Map()
  const fakeSlots = {
    inject(name, fn) { fn() },
    register(desc, comp) { slots.set(desc.name + (desc.id || desc.key || ''), { desc, comp }); return () => slots.delete(desc.name) },
  }
  const ctx = { get: (n) => (n === 'slots' ? fakeSlots : undefined) }
  try { mod.apply(ctx) } catch (error) { problems.push('apply 抛错：' + error.message) }
  if (!slots.size) problems.push('apply 没注册任何槽位')

  // 图标组件
  try { mod.ChatIcon({ size: 16 }) } catch (error) { problems.push('ChatIcon 炸了：' + error.message) }

  // 页面组件：只验它是个函数、能在无数据时返回树（useEffect 被假实现吞掉）
  try {
    const tree = mod.WeComPage({})
    if (!tree || !tree.$$el) problems.push('WeComPage 没返回元素树')
  } catch (error) {
    problems.push('WeComPage 炸了：' + error.message)
  }
}

if (problems.length) {
  console.log('❌ 网页半边有问题：')
  for (const p of problems) console.log('   - ' + p)
  process.exit(1)
}
console.log('✅ 网页半边冒烟通过：模块加载、apply 注册、图标与页面组件都能跑')
