// WeCom Bot · 网页半边：侧栏「企业微信机器人」入口 + 整页面板
// 只读写宿主半边的 /wecom-bot/api/* 接口，不直接碰会话和企微。
// 视觉沿用 DSH 主题变量（--dsw-alias-*），浅色/深色自动跟随；点缀用企微品牌绿。
//
// 面板分 9 个标签：
//   概览 / 连接 / 管理员 / 准入 / 人格 / 功能 / 额度 / 记忆 / 日志

window.__ModuleLoader__.load({
  id: 'dsh-wecom-bot',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const { useState, useEffect, useRef, useMemo, useCallback } = React
    const h = React.createElement
    const inject = ['slots']
    const PANEL_ID = 'wecom-bot'
    const API = '/wecom-bot/api'

    // ---------------- 小工具 ----------------
    const get = (p) =>
      fetch(API + p, { cache: 'no-store' })
        .then((r) => r.json())
        .catch((e) => ({ ok: false, message: '连不上插件：' + e.message }))
    const post = (p, body) =>
      fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
        .then((r) => r.json())
        .catch((e) => ({ ok: false, message: '连不上插件：' + e.message }))
    const clone = (o) => JSON.parse(JSON.stringify(o))
    const getPath = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o)
    const setPath = (obj, path, value) => {
      const next = clone(obj)
      let cur = next
      const ks = path.split('.')
      for (let i = 0; i < ks.length - 1; i++) cur = cur[ks[i]] = cur[ks[i]] || {}
      cur[ks[ks.length - 1]] = value
      return next
    }
    const cx = (...a) => a.filter(Boolean).join(' ')
    const timeAgo = (t) => {
      if (!t) return '—'
      const s = Math.round((Date.now() - t) / 1000)
      if (s < 60) return '刚刚'
      if (s < 3600) return Math.floor(s / 60) + ' 分钟前'
      if (s < 86400) return Math.floor(s / 3600) + ' 小时前'
      return new Date(t).toLocaleDateString()
    }
    const numText = (n) => {
      const v = Number(n) || 0
      if (v >= 1e8) return (v / 1e8).toFixed(v % 1e8 ? 1 : 0) + ' 亿'
      if (v >= 1e4) return (v / 1e4).toFixed(v % 1e4 ? 1 : 0) + ' 万'
      return String(v)
    }
    const UNIT_OPTS = [
      { id: 'million', label: '百万' },
      { id: 'tenMillion', label: '千万' },
      { id: 'hundredMillion', label: '亿' },
    ]

    // ---------------- 样式（只注入一次） ----------------
    const CSS = `
.wb-root{--wb-brand:#07c160;--wb-brand-2:#06ad56;--wb-deep:#0a7a3d;--wb-tint:rgba(7,193,96,.10);--wb-tint-2:rgba(7,193,96,.18);
  --wb-text:var(--dsw-alias-label-primary,#1f2328);--wb-sub:var(--dsw-alias-label-secondary,#57606a);--wb-dim:var(--dsw-alias-label-tertiary,#8b949e);
  --wb-bg:var(--dsw-alias-bg-base,#fff);--wb-card:var(--dsw-alias-bg-layer-1,#fff);--wb-card-2:var(--dsw-alias-bg-layer-2,#f6f8fa);
  --wb-line:var(--dsw-alias-border-l1,rgba(0,0,0,.08));--wb-line-2:var(--dsw-alias-border-l2,rgba(0,0,0,.12));
  --wb-ok:var(--dsw-alias-state-success-primary,#1a7f37);--wb-warn:var(--dsw-alias-state-warn-primary,#bf8700);--wb-err:var(--dsw-alias-state-error-primary,#cf222e);
  --wb-hover:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04));
  height:100%;overflow:auto;background:var(--wb-bg);color:var(--wb-text);font-size:13px;line-height:1.6;
  padding:var(--dsh-frame-top-clearance,24px) 0 40px;box-sizing:border-box;font-family:var(--dsh-font-family-ui,inherit)}
body[data-ds-dark-theme] .wb-root{--wb-brand:#3ddc84;--wb-brand-2:#07c160;--wb-deep:#a6f0c6;--wb-tint:rgba(61,220,132,.12);--wb-tint-2:rgba(61,220,132,.20)}
.wb-wrap{max-width:1040px;margin:0 auto;padding:0 28px}
.wb-hero{display:flex;align-items:center;gap:18px;padding:18px 20px;border-radius:16px;border:1px solid var(--wb-line);
  background:linear-gradient(120deg,var(--wb-tint-2),var(--wb-tint) 45%,transparent 80%),var(--wb-card);position:relative;overflow:hidden}
.wb-hero:after{content:"";position:absolute;right:-40px;bottom:-60px;width:220px;height:220px;border-radius:50%;background:radial-gradient(circle,var(--wb-tint-2),transparent 70%);pointer-events:none}
.wb-mark{width:56px;height:56px;border-radius:16px;flex:none;display:flex;align-items:center;justify-content:center;
  background:var(--wb-brand);color:#fff;box-shadow:0 2px 10px rgba(7,193,96,.28)}
.wb-hero h1{margin:0;font-size:19px;font-weight:650;letter-spacing:.3px}
.wb-hero .wb-sub{color:var(--wb-sub);margin-top:2px}
.wb-hero-main{flex:1;min-width:0;position:relative;z-index:1}
.wb-hero-side{display:flex;flex-direction:column;gap:8px;align-items:flex-end;position:relative;z-index:1}
.wb-pills{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.wb-pill{display:inline-flex;align-items:center;gap:6px;padding:2px 10px;border-radius:999px;font-size:12px;background:var(--wb-card-2);border:1px solid var(--wb-line);color:var(--wb-sub)}
.wb-dot{width:7px;height:7px;border-radius:50%;background:var(--wb-dim);flex:none}
.wb-dot.ok{background:var(--wb-ok)}.wb-dot.warn{background:var(--wb-warn)}.wb-dot.err{background:var(--wb-err)}
.wb-nav{position:sticky;top:0;z-index:5;margin:var(--dsh-frame-top-clearance,24px) 0 16px;border:1px solid var(--wb-line);border-radius:14px;background:var(--wb-card);
  background:color-mix(in srgb,var(--wb-card) 88%,transparent);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);box-shadow:0 1px 2px rgba(0,0,0,.03)}
.wb-nav:before{content:"";position:absolute;left:-28px;right:-28px;bottom:calc(100% + 1px);height:var(--dsh-frame-top-clearance,24px);background:var(--wb-bg);pointer-events:none}
.wb-nav-in{display:flex;align-items:center;gap:2px;padding:6px;overflow-x:auto;scrollbar-width:none}
.wb-nav-in::-webkit-scrollbar{display:none}
.wb-tab{flex:none;position:relative;display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 14px;border:0;border-radius:10px;background:transparent;
  color:var(--wb-sub);font:inherit;font-size:13px;cursor:pointer;transition:background .15s,color .15s;white-space:nowrap}
.wb-tab:hover{background:var(--wb-hover);color:var(--wb-text)}
.wb-tab.on{background:var(--wb-tint-2);color:var(--wb-deep);font-weight:600}
.wb-tab i.dirty{width:6px;height:6px;border-radius:50%;background:var(--wb-warn)}
.wb-page{display:flex;flex-direction:column;gap:14px}
.wb-card{border:1px solid var(--wb-line);border-radius:14px;background:var(--wb-card);padding:16px 18px}
.wb-card>h3{margin:0 0 4px;font-size:14px;font-weight:650;display:flex;align-items:center;gap:8px}
.wb-card>p.wb-hint{margin:0 0 12px;color:var(--wb-sub);font-size:12.5px}
.wb-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}
.wb-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.wb-field>label{font-size:12.5px;color:var(--wb-sub);display:flex;align-items:center;gap:6px}
.wb-field .tip{color:var(--wb-dim);font-size:11.5px}
.wb-input,.wb-select,.wb-area{width:100%;box-sizing:border-box;padding:7px 10px;border-radius:9px;border:1px solid var(--wb-line-2);
  background:var(--wb-bg);color:var(--wb-text);font:inherit;font-size:13px;outline:none;transition:border-color .15s,box-shadow .15s}
.wb-input:focus,.wb-select:focus,.wb-area:focus{border-color:var(--wb-brand);box-shadow:0 0 0 3px var(--wb-tint)}
.wb-area{min-height:180px;resize:vertical;font-family:var(--dsh-font-family-mono,ui-monospace,monospace);font-size:12.5px;line-height:1.65}
.wb-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.wb-between{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px dashed var(--wb-line)}
.wb-between:last-child{border-bottom:0}
.wb-btn{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 14px;border-radius:9px;border:1px solid var(--wb-line-2);
  background:var(--wb-card);color:var(--wb-text);font:inherit;font-size:13px;cursor:pointer;transition:background .15s,border-color .15s}
.wb-btn:hover{background:var(--wb-hover)}
.wb-btn:disabled{opacity:.5;cursor:not-allowed}
.wb-btn.primary{background:var(--wb-brand);border-color:var(--wb-brand);color:#fff;font-weight:600}
.wb-btn.primary:hover{background:var(--wb-brand-2)}
.wb-btn.ghost{border-color:transparent;background:transparent;color:var(--wb-sub)}
.wb-btn.ghost:hover{background:var(--wb-hover);color:var(--wb-text)}
.wb-btn.danger{color:var(--wb-err);border-color:var(--wb-line-2)}
.wb-btn.danger:hover{background:rgba(207,34,46,.08)}
.wb-btn.sm{height:26px;padding:0 9px;font-size:12px;border-radius:8px}
.wb-switch{width:40px;height:22px;border-radius:999px;border:1px solid var(--wb-line-2);background:var(--wb-card-2);position:relative;cursor:pointer;flex:none;transition:background .18s,border-color .18s;padding:0}
.wb-switch:after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform .18s}
.wb-switch.on{background:var(--wb-brand);border-color:var(--wb-brand)}
.wb-switch.on:after{transform:translateX(18px)}
.wb-switch:disabled{opacity:.5;cursor:not-allowed}
.wb-switch-row{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--wb-sub)}
.wb-switch-row span.lbl{white-space:nowrap}
.wb-tag{display:inline-flex;align-items:center;gap:5px;padding:1px 8px;border-radius:6px;font-size:11.5px;background:var(--wb-card-2);border:1px solid var(--wb-line);color:var(--wb-sub)}
.wb-tag.ok{background:rgba(26,127,55,.10);border-color:rgba(26,127,55,.24);color:var(--wb-ok)}
.wb-tag.warn{background:rgba(191,135,0,.10);border-color:rgba(191,135,0,.24);color:var(--wb-warn)}
.wb-tag.err{background:rgba(207,34,46,.10);border-color:rgba(207,34,46,.24);color:var(--wb-err)}
.wb-tag.brand{background:var(--wb-tint);border-color:var(--wb-tint-2);color:var(--wb-deep)}
.wb-muted{color:var(--wb-sub)}.wb-dim{color:var(--wb-dim)}.wb-small{font-size:12px}.wb-err{color:var(--wb-err)}
.wb-mono{font-family:var(--dsh-font-family-mono,ui-monospace,monospace);font-size:12px}
.wb-list{display:flex;flex-direction:column;gap:8px}
.wb-item{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--wb-line);border-radius:11px;background:var(--wb-card)}
.wb-item .main{flex:1;min-width:0}
.wb-item .t{font-weight:600;font-size:13px;display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.wb-item .d{color:var(--wb-sub);font-size:12px;margin-top:1px;word-break:break-all}
.wb-empty{padding:22px;text-align:center;color:var(--wb-dim);border:1px dashed var(--wb-line-2);border-radius:12px;font-size:12.5px}
.wb-logs{font-family:var(--dsh-font-family-mono,ui-monospace,monospace);font-size:12px;line-height:1.5;max-height:460px;overflow:auto;
  border:1px solid var(--wb-line);border-radius:11px;background:var(--wb-card-2);padding:8px 10px}
.wb-log{display:flex;gap:8px;padding:1.5px 0;word-break:break-all}
.wb-log .t{color:var(--wb-dim);flex:none}
.wb-log .lv{flex:none;width:44px;text-transform:uppercase;font-size:10.5px;letter-spacing:.4px;padding-top:2px}
.wb-log .lv.info{color:var(--wb-deep)}.wb-log .lv.warn{color:var(--wb-warn)}.wb-log .lv.error{color:var(--wb-err)}.wb-log .lv.debug{color:var(--wb-dim)}
.wb-savebar{position:sticky;bottom:14px;z-index:6;display:flex;align-items:center;gap:12px;margin-top:6px;padding:10px 14px;border-radius:12px;
  border:1px solid var(--wb-line-2);background:var(--wb-card);box-shadow:0 6px 24px rgba(0,0,0,.10)}
.wb-savebar .msg{flex:1;font-size:12.5px;color:var(--wb-sub)}
.wb-kbd{display:inline-block;padding:0 5px;border-radius:5px;border:1px solid var(--wb-line-2);background:var(--wb-card-2);font-size:11px;font-family:var(--dsh-font-family-mono,monospace)}
.wb-toast{position:fixed;left:50%;bottom:34px;transform:translateX(-50%);z-index:99;padding:9px 18px;border-radius:11px;
  background:rgba(24,28,33,.94);color:#fff;font-size:13px;box-shadow:0 8px 28px rgba(0,0,0,.24);max-width:70vw}
.wb-toast.err{background:rgba(207,34,46,.96)}
.wb-toast.ok{background:rgba(10,122,61,.96)}
.wb-seg{display:inline-flex;padding:2px;border-radius:10px;background:var(--wb-card-2);border:1px solid var(--wb-line);gap:2px}
.wb-seg button{height:28px;padding:0 12px;border:0;border-radius:8px;background:transparent;color:var(--wb-sub);font:inherit;font-size:12.5px;cursor:pointer}
.wb-seg button.on{background:var(--wb-card);color:var(--wb-text);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.08)}
.wb-wizard{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(10,12,14,.34);backdrop-filter:blur(3px)}
.wb-wizard-in{width:min(620px,92vw);max-height:86vh;overflow:auto;border-radius:18px;background:var(--wb-card);border:1px solid var(--wb-line-2);box-shadow:0 24px 70px rgba(0,0,0,.28);padding:22px 24px}
.wb-steps{display:flex;gap:8px;margin:0 0 18px}
.wb-step{flex:1;height:4px;border-radius:999px;background:var(--wb-card-2)}
.wb-step.on{background:var(--wb-brand)}
.wb-mono-block{padding:10px 12px;border-radius:10px;background:var(--wb-card-2);border:1px solid var(--wb-line);
  font-family:var(--dsh-font-family-mono,monospace);font-size:12px;white-space:pre-wrap;word-break:break-all;max-height:180px;overflow:auto}
`

    function useCss() {
      useEffect(() => {
        if (document.getElementById('wb-style')) return
        const el = document.createElement('style')
        el.id = 'wb-style'
        el.textContent = CSS
        document.head.appendChild(el)
      }, [])
    }

    // ---------------- 基础控件 ----------------
    function Switch({ on, onChange, disabled, title }) {
      return h('button', {
        type: 'button', className: cx('wb-switch', on && 'on'), title, role: 'switch', 'aria-checked': !!on,
        disabled, onClick: () => !disabled && onChange(!on),
      })
    }
    function Btn({ kind, onClick, children, disabled, title, sm }) {
      return h('button', { type: 'button', className: cx('wb-btn', kind, sm && 'sm'), onClick, disabled, title }, children)
    }
    function Field({ label, tip, children }) {
      return h('div', { className: 'wb-field' }, h('label', null, label), children, tip ? h('span', { className: 'tip' }, tip) : null)
    }
    function Card({ title, hint, right, children }) {
      return h('div', { className: 'wb-card' },
        title ? h('h3', null, title, right ? h('span', { style: { marginLeft: 'auto' } }, right) : null) : null,
        hint ? h('p', { className: 'wb-hint' }, hint) : null,
        children)
    }
    function Empty({ children }) { return h('div', { className: 'wb-empty' }, children) }

    function Icon({ size }) {
      const s = size || 20
      return h('svg', { width: s, height: s, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M4 11.5C4 7.9 7.6 5 12 5s8 2.9 8 6.5S16.4 18 12 18c-.9 0-1.8-.1-2.6-.3L6 19.5l.7-2.7C5.1 15.6 4 13.7 4 11.5Z' }),
        h('circle', { cx: 9, cy: 11.4, r: 0.85, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 15, cy: 11.4, r: 0.85, fill: 'currentColor', stroke: 'none' }),
      )
    }

    // ---------------- 主组件 ----------------
    function WeComPage() {
      useCss()
      const [st, setSt] = useState(null)
      const [cfg, setCfg] = useState(null)
      const [draft, setDraft] = useState(null)
      const [services, setServices] = useState([])
      const [tab, setTab] = useState('overview')
      const [toastMsg, setToastMsg] = useState(null)
      const [wizard, setWizard] = useState(false)
      const toastTimer = useRef(0)

      const toast = useCallback((text, kind) => {
        setToastMsg({ text, kind })
        clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToastMsg(null), 2600)
      }, [])

      const reload = useCallback(async () => {
        const [s, c] = await Promise.all([get('/state'), get('/config')])
        if (s?.ok) setSt(s)
        if (c?.ok) {
          setCfg(c.config)
          setServices(c.services || [])
          setDraft((d) => (d === null ? clone(c.config) : d))
        }
      }, [])

      useEffect(() => { void reload() }, [reload])
      useEffect(() => {
        const t = setInterval(() => { void get('/state').then((s) => s?.ok && setSt(s)) }, 4000)
        return () => clearInterval(t)
      }, [])

      const dirty = useMemo(() => {
        if (!draft || !cfg) return false
        return JSON.stringify(draft) !== JSON.stringify(cfg)
      }, [draft, cfg])

      const setD = useCallback((path, value) => setDraft((d) => (d ? setPath(d, path, value) : d)), [])

      const save = useCallback(async () => {
        if (!draft) return
        const r = await post('/save', { config: draft })
        if (r?.ok) { setCfg(r.config); setDraft(clone(r.config)); toast('已保存', 'ok'); void reload() }
        else toast(r?.message || '保存失败', 'err')
      }, [draft, reload, toast])

      const quickToggle = useCallback(async (path, value) => {
        if (!cfg) return
        const next = setPath(cfg, path, value)
        const r = await post('/save', { config: next })
        if (r?.ok) { setCfg(r.config); setDraft((d) => (d && !dirty ? clone(r.config) : d)); void reload() }
        else toast(r?.message || '保存失败', 'err')
      }, [cfg, dirty, reload, toast])

      useEffect(() => {
        const onKey = (e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); if (dirty) void save() }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [dirty, save])

      if (!st || !cfg || !draft) {
        return h('div', { className: 'wb-root' }, h('div', { className: 'wb-wrap' }, h(Empty, null, '读配置中…')))
      }

      const statusCls = st.connected ? 'ok' : (st.enabled && !st.ready ? 'warn' : 'err')
      const statusText = st.connected ? '已连接' : (st.kicked ? '被踢下线' : st.reason || (st.enabled ? '连接中' : '未开启'))

      const TABS = [
        { id: 'overview', label: '概览' },
        { id: 'connect', label: '连接' },
        { id: 'admins', label: '管理员' },
        { id: 'access', label: '准入' },
        { id: 'persona', label: '人格' },
        { id: 'features', label: '功能' },
        { id: 'companion', label: '陪伴' },
        { id: 'quota', label: '额度' },
        { id: 'memory', label: '记忆' },
        { id: 'logs', label: '日志' },
      ]
      const TAB_KEYS = {
        connect: ['botId', 'botName', 'longTasks'],
        access: ['accessMode', 'allow', 'autoRegister', 'merge', 'workspaceDir'],
        features: ['features', 'history', 'resync'],
        companion: ['mood', 'speakUp', 'imageGen'],
        quota: ['quota'],
        persona: ['persona'],
      }
      const tabDirty = (id) => (TAB_KEYS[id] || []).some((k) => JSON.stringify(draft[k]) !== JSON.stringify(cfg[k]))

      const P = { st, cfg, draft, setD, services, toast, reload, save, quickToggle, setWizard }
      const body = {
        overview: Overview, connect: Connect, admins: Admins, access: Access, persona: Persona,
        features: Features, companion: Companion, quota: Quota, memory: Memory, logs: Logs,
      }[tab] || Overview

      return h('div', { className: 'wb-root' },
        h('div', { className: 'wb-wrap' },
          h('div', { className: 'wb-hero' },
            h('div', { className: 'wb-mark' }, h(Icon, { size: 28 })),
            h('div', { className: 'wb-hero-main' },
              h('h1', null, cfg.botName || '企业微信机器人'),
              h('div', { className: 'wb-sub' }, cfg.botId ? 'bot_id ' + cfg.botId : '还没填 bot_id'),
              h('div', { className: 'wb-pills' },
                h('span', { className: 'wb-pill' }, h('i', { className: cx('wb-dot', statusCls) }), statusText),
                h('span', { className: 'wb-pill' }, cfg.accessMode === 'open' ? '开放模式' : '白名单模式'),
                h('span', { className: 'wb-pill' }, '管理员 ' + cfg.admins.length),
                h('span', { className: 'wb-pill' }, 'v' + st.version))),
            h('div', { className: 'wb-hero-side' },
              h('div', { className: 'wb-switch-row' }, h('span', { className: 'lbl' }, '总开关'), h(Switch, { on: cfg.enabled, onChange: (v) => quickToggle('enabled', v) })),
              h('div', { className: 'wb-switch-row' },
                h('span', { className: 'lbl' }, '试运行'),
                h(Switch, { on: cfg.dryRun, onChange: (v) => quickToggle('dryRun', v), title: '开着时只写日志，不真的发到企业微信' })))),
          h('div', { className: 'wb-nav' },
            h('div', { className: 'wb-nav-in' },
              TABS.map((t) => h('button', {
                key: t.id, type: 'button', className: cx('wb-tab', tab === t.id && 'on'), onClick: () => setTab(t.id),
              }, t.label, tabDirty(t.id) ? h('i', { className: 'dirty', title: '有没保存的改动' }) : null)))),
          h('div', { className: 'wb-page' }, h(body, P)),
          dirty ? h('div', { className: 'wb-savebar' },
            h('span', { className: 'msg' }, '有改动还没保存'),
            h('span', { className: 'wb-muted wb-small' }, h('span', { className: 'wb-kbd' }, 'Ctrl'), ' + ', h('span', { className: 'wb-kbd' }, 'S')),
            h(Btn, { kind: 'ghost', onClick: () => setDraft(clone(cfg)) }, '撤销'),
            h(Btn, { kind: 'primary', onClick: () => void save() }, '保存设置')) : null,
          wizard ? h(Wizard, { ...P, onClose: () => setWizard(false) }) : null),
        toastMsg ? h('div', { className: cx('wb-toast', toastMsg.kind), role: 'status' }, toastMsg.text) : null,
      )
    }

    // ---------------- 概览 ----------------
    function Overview({ st, cfg, setWizard }) {
      const [activity, setActivity] = useState(null)
      useEffect(() => { void get('/activity').then((r) => r?.ok && setActivity(r)) }, [])
      const rows = (activity?.rows || []).slice(-30).reverse()
      return h('div', { className: 'wb-page' },
        !st.setupDone ? h(Card, { title: '还没配置完', hint: '三步就能聊起来：填 bot_id+secret → 用手机给机器人发条私信拿自己的 userid → 把 userid 填成管理员。' },
          h(Btn, { kind: 'primary', onClick: () => setWizard(true) }, '打开引导向导'))
          : h(Card, { title: '引导向导', hint: '配好了也能再来一遍；只改你填的东西，不会重置已有设置。' },
            h(Btn, { kind: 'ghost', onClick: () => setWizard(true) }, '重新走一遍向导')),
        h(Card, { title: '跑起来了吗', hint: '这儿只显示事实，不猜。' },
          h('div', { className: 'wb-grid' },
            kv('长连接', st.connected ? '已连接' : '没连上', st.connected ? 'ok' : 'err'),
            kv('bot_id', cfg.botId || '没填', cfg.botId ? 'ok' : 'warn'),
            kv('密钥', st.ready ? '已存' : '没存', st.ready ? 'ok' : 'warn'),
            kv('凭据库', st.vault === 'service' ? 'DSH 凭据库' : '内存（重启会丢）', st.vault === 'service' ? 'ok' : 'warn'),
            kv('准入模式', cfg.accessMode === 'open' ? '开放（谁都能聊）' : '白名单', 'brand'),
            kv('数据目录', st.dataDir, 'brand'))),
        h(Card, { title: '最近动静', hint: '收发的消息都记在这儿，只看最近 30 条。', right: h(Btn, { sm: true, kind: 'ghost', onClick: () => void get('/activity').then((r) => r?.ok && setActivity(r)) }, '刷新') },
          rows.length
            ? h('div', { className: 'wb-list' }, rows.map((r, i) =>
                h('div', { key: i, className: 'wb-item' },
                  h('span', { className: cx('wb-tag', r.kind === 'in' ? 'brand' : 'ok') }, r.kind === 'in' ? '收' : '发'),
                  h('div', { className: 'main' },
                    h('div', { className: 't' }, r.name || r.chatId, h('span', { className: 'wb-dim wb-small' }, timeAgo(r.at))),
                    h('div', { className: 'd' }, String(r.text || '').slice(0, 120))))))
            : h(Empty, null, '还没有消息。让谁给机器人发一句试试。')))
    }
    function kv(k, v, cls) {
      return h('div', { key: k, className: 'wb-item' },
        h('div', { className: 'main' },
          h('div', { className: 't' }, k, h('span', { className: cx('wb-tag', cls) }, cls === 'ok' ? '正常' : cls === 'warn' ? '待办' : cls === 'err' ? '异常' : '')),
          h('div', { className: 'd wb-mono' }, String(v))))
    }

    // ---------------- 连接 ----------------
    function Connect({ cfg, st, setD, quickToggle, toast, reload }) {
      const [botId, setBotId] = useState(cfg.botId || '')
      const [secret, setSecret] = useState('')
      const [busy, setBusy] = useState(false)
      const [rows, setRows] = useState([])
      useEffect(() => { setBotId(cfg.botId || '') }, [cfg.botId])
      useEffect(() => {
        void get('/sessions').then((r) => r?.ok && setRows(r.rows || []))
      }, [st.connected])
      const doConnect = async () => {
        setBusy(true)
        const r = await post('/connect', { botId: botId.trim(), secret: secret.trim() })
        setBusy(false)
        toast(r?.ok ? '连上了' : r?.message || '没连上', r?.ok ? 'ok' : 'err')
        setSecret('')
        void reload()
      }
      return h('div', { className: 'wb-page' },
        h(Card, { title: '机器人凭据', hint: '在企业微信管理后台 → 应用管理 → 智能机器人 → API 模式里拿 bot_id 和 secret。密钥存进 DSH 凭据库，不写配置文件。' },
          h('div', { className: 'wb-grid' },
            h(Field, { label: 'bot_id', tip: '以 aib 开头的那串' },
              h('input', { className: 'wb-input wb-mono', value: botId, placeholder: 'aibXXXXXXXX', onChange: (e) => setBotId(e.target.value) })),
            h(Field, { label: 'secret', tip: '留空表示不改已有的' },
              h('input', { className: 'wb-input wb-mono', type: 'password', value: secret, placeholder: st.ready ? '已存（想改再填）' : '填一次就好', onChange: (e) => setSecret(e.target.value) }))),
          h('div', { className: 'wb-row', style: { marginTop: 12 } },
            h(Btn, { kind: 'primary', onClick: () => void doConnect(), disabled: busy || !botId.trim() }, busy ? '连接中…' : '保存并连接'),
            h(Btn, { kind: 'ghost', onClick: async () => { await post('/disconnect'); toast('已断开', 'ok'); void reload() } }, '断开'),
            h('span', { className: cx('wb-tag', st.connected ? 'ok' : 'err') }, st.connected ? '当前：已连接' : '当前：' + (st.reason || '没连上')))),
        h(Card, { title: '机器人显示名与长任务', hint: '显示名只是让模型知道自己叫什么（不用代码剥 @ 前缀）；长任务档位会多挂后台任务和定时任务工具。' },
          h('div', { className: 'wb-grid' },
            h(Field, { label: '机器人名字' },
              h('input', { className: 'wb-input', value: cfg.botName || '', placeholder: '比如 海棠', onChange: (e) => setD('botName', e.target.value) })),
            h('div', { className: 'wb-field' },
              h('label', null, '管理员私聊长任务档位'),
              h('div', { className: 'wb-switch-row' },
                h(Switch, { on: !!cfg.longTasks, onChange: (v) => setD('longTasks', v) }),
                h('span', { className: 'lbl' }, cfg.longTasks ? '开（有 jobs / schedule）' : '关（一轮一答）')))),
        h(Card, { title: '会话映射', hint: '每个私聊 / 每个群一个 DSH 会话，落在「企业微信 · AI」工作区里。' },
          rows.length
            ? h('div', { className: 'wb-list' }, rows.map((r) => h('div', { key: r.key, className: 'wb-item' },
              h('span', { className: cx('wb-tag', 'brand') }, r.level === 'owner' ? '主人档' : '社交档'),
              h('div', { className: 'main' },
                h('div', { className: 't' }, r.title || r.key),
                h('div', { className: 'd wb-mono' }, r.sessionId || '')))))
            : h(Empty, null, '还没有会话。等第一条消息进来就会建。'))))
    }

    // ---------------- 管理员 ----------------
    function Admins({ cfg, toast, reload, services }) {
      const [userid, setUserid] = useState('')
      const [name, setName] = useState('')
      const [open, setOpen] = useState('')
      const [mcpTab, setMcpTab] = useState('msg')
      const [mcpUrl, setMcpUrl] = useState('')
      const [testing, setTesting] = useState(false)

      const add = async () => {
        if (!userid.trim()) return toast('先填 userid', 'err')
        const r = await post('/admin/add', { userid: userid.trim(), name: name.trim() })
        if (r?.ok) { setUserid(''); setName(''); toast('已添加', 'ok'); void reload() }
        else toast(r?.message || '添加失败', 'err')
      }
      const remove = async (id) => {
        const r = await post('/admin/remove', { userid: id })
        if (r?.ok) { toast('已移除', 'ok'); void reload() }
        else toast(r?.message || '移除失败', 'err')
      }
      const setOne = async (id, service, url) => {
        const r = await post('/admin/mcp', { userid: id, service, url })
        if (r?.ok) { toast(url ? '已存' : '已清空', 'ok'); void reload() }
        else toast(r?.message || '没存上', 'err')
      }
      const test = async (id, service) => {
        setTesting(true)
        const r = await post('/mcp/test', { userid: id, service })
        setTesting(false)
        toast(r?.ok ? `通了，${r.count} 个工具：${(r.names || []).slice(0, 4).join('、')}…` : r?.message || '连不上', r?.ok ? 'ok' : 'err')
      }
      return h('div', { className: 'wb-page' },
        h(Card, { title: '加管理员', hint: 'userid 让本人给机器人发一条私信就能看到（机器人会回他的 ID）。第一个是主人档，会有电脑权限。' },
          h('div', { className: 'wb-grid' },
            h(Field, { label: 'userid', tip: '企业内唯一，形如 wofL_hCgAAJ5…' },
              h('input', { className: 'wb-input wb-mono', value: userid, onChange: (e) => setUserid(e.target.value) })),
            h(Field, { label: '称呼（可选）' },
              h('input', { className: 'wb-input', value: name, onChange: (e) => setName(e.target.value) }))),
          h('div', { className: 'wb-row', style: { marginTop: 12 } }, h(Btn, { kind: 'primary', onClick: () => void add() }, '添加'))),
        h(Card, { title: '管理员列表（' + cfg.admins.length + '）', hint: '主人档只有一个人。每个管理员可以单独填自己的 MCP 地址 —— 不填就用主人的，都没填就用不了。' },
          cfg.admins.length ? h('div', { className: 'wb-list' }, cfg.admins.map((a) => h('div', { key: a.userid, className: 'wb-item', style: { alignItems: 'flex-start', flexDirection: 'column' } },
            h('div', { className: 'wb-row', style: { width: '100%' } },
              h('span', { className: cx('wb-tag', a.role === 'owner' ? 'brand' : 'ok') }, a.role === 'owner' ? '主人' : '管理员'),
              h('div', { className: 'main' },
                h('div', { className: 't' }, a.name || a.userid),
                h('div', { className: 'd wb-mono' }, a.userid)),
              h(Btn, { sm: true, kind: 'ghost', onClick: () => setOpen(open === a.userid ? '' : a.userid) }, open === a.userid ? '收起 MCP' : '配 MCP'),
              a.role !== 'owner' ? h(Btn, { sm: true, kind: 'danger', onClick: () => void remove(a.userid) }, '移除') : null),
            open === a.userid ? h('div', { style: { width: '100%', marginTop: 10, paddingTop: 10, borderTop: '1px dashed var(--wb-line)' } },
              h('div', { className: 'wb-row', style: { marginBottom: 8 } },
                h('div', { className: 'wb-seg' }, (services || []).map((s) => h('button', {
                  key: s.id, type: 'button', className: cx(mcpTab === s.id && 'on'),
                  onClick: () => { setMcpTab(s.id); setMcpUrl(a.mcp?.[s.id] || '') },
                }, s.name)))),
              h(Field, {
                label: (services || []).find((s) => s.id === mcpTab)?.name || mcpTab,
                tip: (services || []).find((s) => s.id === mcpTab)?.hint || '',
              }, h('input', {
                className: 'wb-input wb-mono', value: mcpUrl, placeholder: 'https://qyapi.weixin.qq.com/mcp/v2/bot/…?apikey=…',
                onChange: (e) => setMcpUrl(e.target.value),
              })),
              h('div', { className: 'wb-row', style: { marginTop: 8 } },
                h(Btn, { sm: true, kind: 'primary', onClick: () => void setOne(a.userid, mcpTab, mcpUrl.trim()) }, '存'),
                h(Btn, { sm: true, onClick: () => void test(a.userid, mcpTab), disabled: testing }, testing ? '测…' : '测一下'),
                h(Btn, { sm: true, kind: 'ghost', onClick: () => { setMcpUrl(''); void setOne(a.userid, mcpTab, '') } }, '清空'),
                a.mcp?.[mcpTab] ? h('span', { className: 'wb-tag ok' }, '已配') : h('span', { className: 'wb-tag' }, '没配'))) : null)))
            : h(Empty, null, '还没加管理员。没有管理员，机器人不会认任何人是主人。')))
    }

    // ---------------- 准入 ----------------
    function Access({ cfg, draft, setD, toast, reload }) {
      const [uid, setUid] = useState('')
      const [gid, setGid] = useState('')
      return h('div', { className: 'wb-page' },
        h(Card, { title: '准入模式', hint: '白名单（开源默认）：只有名单里的人/群能聊。开放：谁给机器人发消息都能聊，还能自动登记名单，方便以后切回白名单。' },
          h('div', { className: 'wb-seg' },
            h('button', { type: 'button', className: cx(draft.accessMode === 'whitelist' && 'on'), onClick: () => setD('accessMode', 'whitelist') }, '白名单'),
            h('button', { type: 'button', className: cx(draft.accessMode === 'open' && 'on'), onClick: () => setD('accessMode', 'open') }, '开放模式')),
          draft.accessMode === 'open' ? h('div', { className: 'wb-between', style: { marginTop: 12 } },
            h('div', null,
              h('div', null, '自动登记来过的人 / 群'),
              h('div', { className: 'wb-dim wb-small' }, '开放模式下把每个来过的都记进名单，将来切白名单时名单现成')) ,
            h(Switch, { on: !!draft.autoRegister, onChange: (v) => setD('autoRegister', v) })) : null),
        h(Card, { title: '可聊天的人（' + (draft.allow?.users || []).length + '）', hint: '只认 userid。让对方给机器人发私信，机器人会把他的 ID 告诉他。' },
          h('div', { className: 'wb-row', style: { marginBottom: 10 } },
            h('input', { className: 'wb-input wb-mono', style: { flex: 1, minWidth: 200 }, value: uid, placeholder: 'userid', onChange: (e) => setUid(e.target.value) }),
            h(Btn, {
              kind: 'primary', onClick: () => {
                const v = uid.trim()
                if (!v) return
                if (!(draft.allow.users || []).includes(v)) setD('allow.users', [...(draft.allow.users || []), v])
                setUid('')
              },
            }, '加')),
          (draft.allow?.users || []).length
            ? h('div', { className: 'wb-list' }, draft.allow.users.map((u) => h('div', { key: u, className: 'wb-item' },
              h('div', { className: 'main' }, h('div', { className: 't wb-mono' }, u)),
              h(Btn, { sm: true, kind: 'ghost', onClick: () => setD('allow.users', draft.allow.users.filter((x) => x !== u)) }, '删'))))
            : h(Empty, null, '名单是空的 —— 白名单模式下谁也聊不了。')),
        h(Card, { title: '可聊天的群（' + (draft.allow?.groups || []).length + '）', hint: '群 chatid。没 @ 机器人也进不来消息（企微协议如此），但名单里没有的群，@ 了也不理。' },
          h('div', { className: 'wb-row', style: { marginBottom: 10 } },
            h('input', { className: 'wb-input wb-mono', style: { flex: 1, minWidth: 200 }, value: gid, placeholder: '群 chatid', onChange: (e) => setGid(e.target.value) }),
            h(Btn, {
              kind: 'primary', onClick: () => {
                const v = gid.trim()
                if (!v) return
                if (!(draft.allow.groups || []).includes(v)) setD('allow.groups', [...(draft.allow.groups || []), v])
                setGid('')
              },
            }, '加')),
          (draft.allow?.groups || []).length
            ? h('div', { className: 'wb-list' }, draft.allow.groups.map((g) => h('div', { key: g, className: 'wb-item' },
              h('div', { className: 'main' }, h('div', { className: 't wb-mono' }, g)),
              h(Btn, { sm: true, kind: 'ghost', onClick: () => setD('allow.groups', draft.allow.groups.filter((x) => x !== g)) }, '删'))))
            : h(Empty, null, '还没有群。')),
        h(Card, { title: '连发合并', hint: '对方打字慢时会连发好几条。等停下来了再一起处理，只回最后一条的消息 ID（企微规定只能回刚收到的）。' },
          h('div', { className: 'wb-between' },
            h('div', null, h('div', null, '启用合并'), h('div', { className: 'wb-dim wb-small' }, '关掉就是每条都回，容易刷屏')),
            h(Switch, { on: !!draft.merge?.enabled, onChange: (v) => setD('merge.enabled', v) })),
          h('div', { className: 'wb-grid', style: { marginTop: 12 } },
            h(Field, { label: '私聊停顿阈值（秒）', tip: '0.5 ~ 10' },
              h('input', { className: 'wb-input', type: 'number', step: '0.5', min: '0.5', max: '10', value: draft.merge?.waitSec ?? 2.5, onChange: (e) => setD('merge.waitSec', Number(e.target.value)) })),
            h(Field, { label: '私聊最长等（秒）', tip: '1 ~ 60' },
              h('input', { className: 'wb-input', type: 'number', min: '1', max: '60', value: draft.merge?.maxSec ?? 8, onChange: (e) => setD('merge.maxSec', Number(e.target.value)) })),
            h(Field, { label: '群聊停顿阈值（秒）', tip: '0.5 ~ 10' },
              h('input', { className: 'wb-input', type: 'number', step: '0.5', min: '0.5', max: '10', value: draft.merge?.groupWaitSec ?? 5, onChange: (e) => setD('merge.groupWaitSec', Number(e.target.value)) })),
            h(Field, { label: '群聊最长等（秒）', tip: '1 ~ 60' },
              h('input', { className: 'wb-input', type: 'number', min: '1', max: '60', value: draft.merge?.groupMaxSec ?? 15, onChange: (e) => setD('merge.groupMaxSec', Number(e.target.value)) })),
            h(Field, { label: '等待时的占位话', tip: '第一条消息先回这个，让对方知道收到了' },
              h('input', { className: 'wb-input', value: draft.merge?.placeholder || '', placeholder: 'emmm...', onChange: (e) => setD('merge.placeholder', e.target.value) })))),
        h(Card, { title: '会话放在哪', hint: '每个私聊/每个群一个 DSH 会话，全都落在一个工作区里，侧栏能看到。' },
          h(WorkspaceMigrate, { toast, reload })))
    }

    // ---------------- 工作目录迁移 ----------------
    // 工作区按「路径」认身份：换目录 = 换个工作区。
    // 老会话不会消失（还在老工作区里，侧栏能看到），下次有人发消息会在新目录里开新会话。
    function WorkspaceMigrate({ toast, reload }) {
      const [info, setInfo] = useState(null)
      const [dir, setDir] = useState('')
      const [probe, setProbe] = useState(null)
      const [busy, setBusy] = useState(false)
      const load = useCallback(async () => {
        const r = await get('/workspace')
        if (r?.ok) { setInfo(r); setDir((d) => d || r.dir || '') }
      }, [])
      useEffect(() => { void load() }, [load])
      const check = async () => {
        if (!dir.trim()) return toast('先填个目录', 'err')
        setBusy(true)
        const r = await post('/workspace/check', { dir: dir.trim() })
        setBusy(false)
        setProbe(r)
        toast(r?.message || (r?.ok ? '目录可用' : '目录不可用'), r?.ok ? 'ok' : 'err')
      }
      const migrate = async () => {
        if (!dir.trim()) return toast('先填个目录', 'err')
        if (!probe?.ok) return toast('先点「检查目录」确认能写', 'err')
        if (!window.confirm('切到「' + dir.trim() + '」？\n\n老会话还在老工作区里能看到，但下次有人发消息会在新目录里开新会话。')) return
        setBusy(true)
        const r = await post('/workspace/migrate', { dir: dir.trim() })
        setBusy(false)
        if (r?.ok) { toast(r.message || '已迁移', 'ok'); void load(); void reload() }
        else toast(r?.message || '迁移失败', 'err')
      }
      return h('div', null,
        h(Row, {
          title: '当前工作区目录',
          desc: info ? info.title + (info.exists ? '' : '（目录还不存在）') : '读取中…',
          right: h('span', { className: 'wb-mono wb-small' }, info?.dir || '—'),
        }),
        h(Field, { label: '新目录', tip: '绝对路径。换目录 = 换工作区；老的会话不会丢，还在老工作区里。' },
          h('input', {
            className: 'wb-input wb-mono',
            value: dir,
            placeholder: 'D:\\WeComBot\\chats',
            onChange: (e) => { setDir(e.target.value); setProbe(null) },
          })),
        h('div', { className: 'wb-row', style: { marginTop: 10 } },
          h(Btn, { onClick: () => void check(), disabled: busy }, '检查目录'),
          h(Btn, { kind: 'primary', onClick: () => void migrate(), disabled: busy || !probe?.ok }, '迁移到新目录'),
          probe ? h('span', { className: cx('wb-small', probe.ok ? 'wb-dim' : 'wb-err') }, probe.message) : h('span', { className: 'wb-dim wb-small' }, '先检查一下再迁移')),
        h('div', { className: 'wb-dim wb-small', style: { marginTop: 10 } },
          '留空用默认 %USERPROFILE%\\WeComBot\\chats。迁移只改 DSH 会话放哪，不影响企微那边任何设置。'))
    }

    // ---------------- 人格 ----------------
    function Persona({ cfg, draft, setD, toast, reload }) {
      const [rows, setRows] = useState([])
      const [cur, setCur] = useState(null)
      const [text, setText] = useState('')
      const [name, setName] = useState('')
      const load = useCallback(async () => {
        const r = await get('/personas')
        if (r?.ok) setRows(r.rows || [])
      }, [])
      useEffect(() => { void load() }, [load])
      useEffect(() => {
        void get('/persona?id=' + encodeURIComponent(draft.persona?.current || 'default')).then((r) => {
          if (r?.ok) { setCur(r.persona); setText(r.persona.body || ''); setName(r.persona.name || '') }
        })
      }, [draft.persona?.current])
      const pick = async (id) => { setD('persona.current', id) }
      const saveP = async () => {
        if (!cur) return
        const r = await post('/persona/save', { id: cur.id, name: name || cur.name, body: text, select: true })
        if (r?.ok) { toast('人格已保存', 'ok'); void load(); void reload() }
        else toast(r?.message || '保存失败', 'err')
      }
      return h('div', { className: 'wb-page' },
        h(Card, { title: '选人格', hint: '人格就是系统提示词的前半段。{{name}} 会替换成机器人名字。' },
          rows.length
            ? h('div', { className: 'wb-list' }, rows.map((p) => h('div', { key: p.id, className: 'wb-item' },
              h('span', { className: cx('wb-tag', p.id === draft.persona?.current && 'brand') }, p.id === draft.persona?.current ? '在用' : '可选'),
              h('div', { className: 'main' }, h('div', { className: 't' }, p.name), h('div', { className: 'd' }, p.id + ' · ' + (p.tags || []).join(' / '))),
              h(Btn, { sm: true, onClick: () => void pick(p.id) }, '用它'))))
            : h(Empty, null, '没有人格文件。')),
        cur ? h(Card, { title: '编辑：' + cur.id, hint: '改完点保存。保存后下一轮对话就生效（不用重启）。' },
          h('div', { className: 'wb-grid' },
            h(Field, { label: '人格名' }, h('input', { className: 'wb-input', value: name, onChange: (e) => setName(e.target.value) }))),
          h('div', { style: { marginTop: 10 } },
            h('textarea', { className: 'wb-area', value: text, onChange: (e) => setText(e.target.value), spellCheck: false })),
          h('div', { className: 'wb-row', style: { marginTop: 10 } },
            h(Btn, { kind: 'primary', onClick: () => void saveP() }, '保存人格'),
            h('span', { className: 'wb-dim wb-small' }, '内置人格别乱删；想改就复制一份新的。'))) : null)
    }

    // ---------------- 功能 ----------------
    function Features({ draft, setD }) {
      const F = [
        ['browser', '浏览器操作', '登录态要自己导 cookie。只给主人档（群和陌生人拿不到）。'],
        ['video', '看视频', '依赖 dsh-video-storyboard，还要 ffmpeg。缺了会自动降级，不报错。'],
        ['files', '文件收发', '走 MCP 的 media_upload + message_aibot_send。单次 20 MB 以内，更大的走微盘。'],
        ['memory', '记忆', '四层记忆（人 / 场景 / 技能 / 公共），跨场景召回会标来源。'],
        ['mood', '心情', '只影响语气，不影响权限。'],
        ['imageGen', '生图', '要额外的生图后端，没配就不显示这个能力。'],
        ['speakUp', '主动搭话', '安静久了主动说一句。能用 aibot_send_msg 主动推的只有聊过天的人。'],
        ['mcpWrite', 'MCP 写操作', '文档/待办/日程/微盘的增改。关了就只能读。'],
        ['mcpSendAsMe', '以管理员身份发消息', '署名是真人不是机器人。只在管理员明确说了「用我的身份」时才该开。'],
        ['desktop', '桌面控制', '本插件**没有**这个能力（只有 shell 与浏览器），开着也没用，留着是为了跟别人对齐。'],
      ]
      return h('div', { className: 'wb-page' },
        h(Card, { title: '能力开关', hint: '开源默认：浏览器 / 视频 / 文件文档 开；桌面控制 / MCP 写 / 真人身份发消息 关。' },
          F.map(([k, name, desc]) => h('div', { key: k, className: 'wb-between' },
            h('div', null, h('div', null, name), h('div', { className: 'wb-dim wb-small' }, desc)),
            h(Switch, { on: !!draft.features?.[k], onChange: (v) => setD('features.' + k, v) })))),
        h(Card, { title: '谁能让机器人发文件', hint: '默认只给管理员。开放模式下建议保持默认，不然谁都能让它往群里甩文件。' },
          h('div', { className: 'wb-seg' },
            h('button', { type: 'button', className: cx(draft.features?.sendFileToUser === 'admin' && 'on'), onClick: () => setD('features.sendFileToUser', 'admin') }, '只有管理员'),
            h('button', { type: 'button', className: cx(draft.features?.sendFileToUser === 'all' && 'on'), onClick: () => setD('features.sendFileToUser', 'all') }, '所有人'))),
        h(Card, { title: '群上下文补齐', hint: '被 @ 时用 MCP 拉这个群最近的消息，先在本地会话里垫一段，再回答。企微只让查最近 7 天。' },
          h('div', { className: 'wb-between' },
            h('div', null, h('div', null, '启用'), h('div', { className: 'wb-dim wb-small' }, '要配了 MCP 的 msg 服务才有效')),
            h(Switch, { on: !!draft.history?.enabled, onChange: (v) => setD('history.enabled', v) })),
          h('div', { className: 'wb-between' },
            h('div', null, h('div', null, '第一次被 @ 就补'), h('div', { className: 'wb-dim wb-small' }, '不然第一次 @ 时它什么上下文都没有')),
            h(Switch, { on: !!draft.history?.syncOnFirstMention, onChange: (v) => setD('history.syncOnFirstMention', v) })),
          h('div', { className: 'wb-grid', style: { marginTop: 12 } },
            h(Field, { label: '两次同步最短间隔（分钟）', tip: '0 = 不限制' },
              h('input', { className: 'wb-input', type: 'number', min: '0', value: draft.history?.syncIntervalMin ?? 0, onChange: (e) => setD('history.syncIntervalMin', Number(e.target.value)) })),
            h(Field, { label: '一次最多补几条', tip: '1 ~ 200' },
              h('input', { className: 'wb-input', type: 'number', min: '1', max: '200', value: draft.history?.maxMessages ?? 30, onChange: (e) => setD('history.maxMessages', Number(e.target.value)) })))),
        h(Card, { title: '断线补拉', hint: '掉线期间企微不会缓存消息给你。重连后只能靠 MCP 把这期间的消息读回来。' },
          h('div', { className: 'wb-between' },
            h('div', null, h('div', null, '重连后补拉'), h('div', { className: 'wb-dim wb-small' }, '只补最近几分钟，太久了补回来也没意义')),
            h(Switch, { on: !!draft.resync?.enabled, onChange: (v) => setD('resync.enabled', v) })),
          h('div', { className: 'wb-grid', style: { marginTop: 12 } },
            h(Field, { label: '最多往回补多久（分钟）', tip: '5 ~ 8640' },
              h('input', { className: 'wb-input', type: 'number', min: '5', max: '8640', value: draft.resync?.maxMinutes ?? 120, onChange: (e) => setD('resync.maxMinutes', Number(e.target.value)) })))))
    }

    // ---------------- 额度 ----------------
    function Quota({ draft, setD, toast, reload }) {
      const [usage, setUsage] = useState(null)
      useEffect(() => { void get('/quota').then((r) => r?.ok && setUsage(r.usage)) }, [])
      const unit = draft.quota?.unit || 'million'
      const mult = unit === 'hundredMillion' ? 1e8 : unit === 'tenMillion' ? 1e7 : 1e6
      const g = draft.quota?.globalDailyTokens || 0
      const p = draft.quota?.perChatDailyTokens || 0
      return h('div', { className: 'wb-page' },
        h(Card, { title: '按 token 算，不是按条数算', hint: '一条消息里塞个 PDF 就能烧掉几万 token，按条数算挡不住。0 = 不限。' },
          h('div', { className: 'wb-between' },
            h('div', null, h('div', null, '启用额度'), h('div', { className: 'wb-dim wb-small' }, '关掉 = 完全不限制')),
            h(Switch, { on: !!draft.quota?.enabled, onChange: (v) => setD('quota.enabled', v) })),
          h('div', { className: 'wb-between' },
            h('div', null, h('div', null, '管理员不限'), h('div', { className: 'wb-dim wb-small' }, '默认开。关掉就连主人也吃额度。')),
            h(Switch, { on: !!draft.quota?.adminsUnlimited, onChange: (v) => setD('quota.adminsUnlimited', v) })),
          h('div', { className: 'wb-grid', style: { marginTop: 12 } },
            h(Field, { label: '单位' },
              h('select', { className: 'wb-select', value: unit, onChange: (e) => setD('quota.unit', e.target.value) },
                UNIT_OPTS.map((u) => h('option', { key: u.id, value: u.id }, u.label)))),
            h(Field, { label: '全局每天（' + (UNIT_OPTS.find((u) => u.id === unit)?.label || '') + ' token）', tip: '当前 = ' + numText(g) + ' token' },
              h('input', { className: 'wb-input', type: 'number', min: '0', step: '1', value: +(g / mult).toFixed(2), onChange: (e) => setD('quota.globalDailyTokens', Math.round(Number(e.target.value) * mult)) })),
            h(Field, { label: '每个会话每天（' + (UNIT_OPTS.find((u) => u.id === unit)?.label || '') + ' token）', tip: '一个私聊或一个群算一个个体；当前 = ' + numText(p) + ' token' },
              h('input', { className: 'wb-input', type: 'number', min: '0', step: '1', value: +(p / mult).toFixed(2), onChange: (e) => setD('quota.perChatDailyTokens', Math.round(Number(e.target.value) * mult)) })),
            h(Field, { label: '每分钟最多几条', tip: '防刷屏，1 ~ 1000' },
              h('input', { className: 'wb-input', type: 'number', min: '1', max: '1000', value: draft.quota?.burstPerMinute ?? 30, onChange: (e) => setD('quota.burstPerMinute', Number(e.target.value)) })))),
        h(Card, { title: '今天用了多少', right: h(Btn, { sm: true, kind: 'ghost', onClick: async () => { await post('/quota/reset'); toast('已清零', 'ok'); void reload() } }, '清零') },
          usage
            ? h('div', { className: 'wb-grid' },
              h('div', { className: 'wb-item' }, h('div', { className: 'main' },
                h('div', { className: 't' }, '全局'), h('div', { className: 'd' }, numText(usage.global || 0) + ' token · ' + (usage.date || '')))),
              h('div', { className: 'wb-item' }, h('div', { className: 'main' },
                h('div', { className: 't' }, '会话数'), h('div', { className: 'd' }, String(Object.keys(usage.chats || {}).length) + ' 个'))),
              Object.entries(usage.chats || {}).slice(0, 12).map(([k, v]) => h('div', { key: k, className: 'wb-item' },
                h('div', { className: 'main' }, h('div', { className: 't wb-mono' }, k), h('div', { className: 'd' }, numText(v) + ' token')))))
            : h(Empty, null, '还没数据。')))
    }

    // ---------------- 记忆 ----------------
    function Memory({ toast }) {
      const [rows, setRows] = useState([])
      const [stats, setStats] = useState(null)
      const [q, setQ] = useState('')
      const load = useCallback(async (query) => {
        const r = await get('/memory' + (query ? '?q=' + encodeURIComponent(query) : ''))
        if (r?.ok) { setRows(r.rows || []); setStats(r.stats || null) }
      }, [])
      useEffect(() => { void load('') }, [load])
      const del = async (id) => { const r = await post('/memory/delete', { id }); if (r?.ok) { toast('删了', 'ok'); void load(q) } }
      return h('div', { className: 'wb-page' },
        h(Card, { title: '记忆库', hint: '四层：人（跨会话）/ 场景（这个群或这个私聊）/ 技能（所有人共享）/ 公共（全局事实）。过时的不会被删，只是不再被召回。' },
          stats ? h('div', { className: 'wb-row', style: { marginBottom: 12 } },
            h('span', { className: 'wb-tag brand' }, '共 ' + stats.total + ' 条'),
            h('span', { className: 'wb-tag' }, '人 ' + (stats.person || 0)),
            h('span', { className: 'wb-tag' }, '场景 ' + (stats.scene || 0)),
            h('span', { className: 'wb-tag' }, '技能 ' + (stats.skill || 0)),
            h('span', { className: 'wb-tag' }, '公共 ' + (stats.public || 0))) : null,
          h('div', { className: 'wb-row', style: { marginBottom: 12 } },
            h('input', { className: 'wb-input', style: { flex: 1, minWidth: 220 }, value: q, placeholder: '搜一条记忆试试（按召回打分）', onChange: (e) => setQ(e.target.value), onKeyDown: (e) => e.key === 'Enter' && void load(q) }),
            h(Btn, { onClick: () => void load(q) }, '搜'),
            h(Btn, { kind: 'ghost', onClick: () => { setQ(''); void load('') } }, '清空')),
          rows.length
            ? h('div', { className: 'wb-list' }, rows.slice().reverse().slice(0, 200).map((m) => h('div', { key: m.id, className: 'wb-item' },
              h('span', { className: cx('wb-tag', m.scope === 'person' ? 'brand' : m.scope === 'scene' ? 'ok' : '') }, m.scope),
              h('div', { className: 'main' },
                h('div', { className: 't', style: { fontWeight: 500 } }, m.text),
                h('div', { className: 'd' }, [m.type, m.about, m.chatName, timeAgo(m.at)].filter(Boolean).join(' · '))),
              h(Btn, { sm: true, kind: 'ghost', onClick: () => void del(m.id) }, '删'))))
            : h(Empty, null, '还没有记忆。聊几句，让它记点东西。')))
    }

    // ---------------- 陪伴（心情 / 主动搭话 / 生图） ----------------
    function Row({ title, desc, right }) {
      return h('div', { className: 'wb-between' },
        h('div', null,
          h('div', null, title),
          desc ? h('div', { className: 'wb-dim wb-small' }, desc) : null),
        right)
    }

    function Companion({ draft, setD, toast }) {
      const [mood, setMood] = useState(null)
      const [sp, setSp] = useState(null)
      const [ig, setIg] = useState(null)

      const loadMood = useCallback(async () => {
        const r = await get('/mood')
        if (r?.ok) setMood(r.mood)
      }, [])
      const loadSp = useCallback(async () => {
        const r = await get('/speakup/state')
        if (r?.ok) setSp(r)
      }, [])
      const loadIg = useCallback(async () => {
        const r = await get('/imagegen')
        if (r?.ok) setIg(r)
      }, [])
      useEffect(() => {
        loadMood().catch(() => {})
        loadSp().catch(() => {})
        loadIg().catch(() => {})
      }, [loadMood, loadSp, loadIg])

      const m = mood || { value: 60, label: '平平常常', history: [] }
      const pct = Math.max(0, Math.min(100, Math.round(Number(m.value) || 0)))
      const barColor = pct >= 70 ? 'var(--wb-brand)' : pct >= 50 ? '#e8b339' : '#d9534f'
      const igc = draft.imageGen || {}
      const custom = igc.custom || {}
      const isCustom = igc.provider === 'custom'

      const moodCard = h(Card, {
        title: '心情',
        hint: '只影响语气，不影响权限和能力。不做模型判心情（每轮多打一次模型太贵），按关键词 + 时间衰减算。',
        right: h(Btn, {
          sm: true, kind: 'ghost',
          onClick: async () => { await post('/mood/reset'); toast('归零了', 'ok'); loadMood().catch(() => {}) },
        }, '重置'),
      },
        h(Row, {
          title: m.label,
          desc: '数值 ' + pct + ' / 100 · 越高越飘',
          right: h(Switch, { on: !!draft.features?.mood, onChange: (v) => setD('features.mood', v) }),
        }),
        h('div', { style: { height: 10, background: 'var(--dsw-alias-bg-base)', borderRadius: 6, overflow: 'hidden', margin: '10px 0' } },
          h('div', { style: { width: pct + '%', height: '100%', background: barColor, transition: 'width .3s' } })),
        h('div', { className: 'wb-grid' },
          h(Field, { label: '衰减半衰期（小时）', tip: '1 ~ 720。意思是不说话多久掉一半。' },
            h('input', {
              className: 'wb-input', type: 'number', min: '1', max: '720',
              value: draft.mood?.halfLifeHours ?? 72,
              onChange: (e) => setD('mood.halfLifeHours', Number(e.target.value)),
            }))),
        (m.history || []).length
          ? h('div', { className: 'wb-list', style: { marginTop: 10 } },
            m.history.slice(-8).reverse().map((x, i) => h('div', { key: i, className: 'wb-item' },
              h('span', { className: cx('wb-tag', (x.d || 0) >= 0 ? 'ok' : '') }, (x.d >= 0 ? '+' : '') + (x.d ?? 0)),
              h('div', { className: 'main' },
                h('div', { className: 't' }, x.reason || '—'),
                h('div', { className: 'd' }, [x.who, timeAgo(x.at)].filter(Boolean).join(' · '))))))
          : null)

      const spState = (sp && sp.state) || {}
      const speakCard = h(Card, {
        title: '主动搭话',
        hint: '只对主人做，不给普通成员。企微规定：只有对方先给机器人发过消息，机器人才推得进去。',
        right: h(Btn, {
          sm: true, kind: 'ghost',
          onClick: async () => {
            const r = await post('/speakup/fire')
            toast(r?.message || '发出去了', r?.ok ? 'ok' : 'err')
            loadSp().catch(() => {})
          },
        }, '现在就叫她'),
      },
        h(Row, {
          title: '启用',
          desc: '安静太久时自己找话说',
          right: h(Switch, { on: !!draft.speakUp?.enabled, onChange: (v) => setD('speakUp.enabled', v) }),
        }),
        h(Row, {
          title: '问了没回就追一句',
          desc: '15 ~ 40 分钟后，一半概率，不占每天次数',
          right: h(Switch, { on: draft.speakUp?.nudge !== false, onChange: (v) => setD('speakUp.nudge', v) }),
        }),
        h('div', { className: 'wb-grid', style: { marginTop: 12 } },
          h(Field, { label: '安静多少分钟才开口', tip: '10 ~ 1440' },
            h('input', {
              className: 'wb-input', type: 'number', min: '10', max: '1440',
              value: draft.speakUp?.idleMinutes ?? 120,
              onChange: (e) => setD('speakUp.idleMinutes', Number(e.target.value)),
            })),
          h(Field, { label: '两次之间至少隔（分钟）', tip: '10 ~ 1440' },
            h('input', {
              className: 'wb-input', type: 'number', min: '10', max: '1440',
              value: draft.speakUp?.minIntervalMinutes ?? 90,
              onChange: (e) => setD('speakUp.minIntervalMinutes', Number(e.target.value)),
            })),
          h(Field, { label: '最多隔多久（分钟）', tip: '要 ≥ 上一个' },
            h('input', {
              className: 'wb-input', type: 'number', min: '10', max: '2880',
              value: draft.speakUp?.maxIntervalMinutes ?? 240,
              onChange: (e) => setD('speakUp.maxIntervalMinutes', Number(e.target.value)),
            })),
          h(Field, { label: '一天最多几次', tip: '0 ~ 48' },
            h('input', {
              className: 'wb-input', type: 'number', min: '0', max: '48',
              value: draft.speakUp?.maxPerDay ?? 4,
              onChange: (e) => setD('speakUp.maxPerDay', Number(e.target.value)),
            })),
          h(Field, { label: '几点到几点（开始）', tip: '0 ~ 23，可以跨夜' },
            h('input', {
              className: 'wb-input', type: 'number', min: '0', max: '23',
              value: draft.speakUp?.awakeFrom ?? 8,
              onChange: (e) => setD('speakUp.awakeFrom', Number(e.target.value)),
            })),
          h(Field, { label: '几点到几点（结束）', tip: '0 ~ 23' },
            h('input', {
              className: 'wb-input', type: 'number', min: '0', max: '23',
              value: draft.speakUp?.awakeTo ?? 23,
              onChange: (e) => setD('speakUp.awakeTo', Number(e.target.value)),
            }))),
        sp
          ? h('div', { className: 'wb-row', style: { marginTop: 10 } },
            h('span', { className: 'wb-tag' }, '今天 ' + (spState.count || 0) + ' 次'),
            h('span', { className: 'wb-tag' }, '下次最早 ' + (spState.nextAt ? new Date(spState.nextAt).toLocaleTimeString() : '—')),
            spState.last ? h('span', { className: 'wb-tag' }, '上次 ' + timeAgo(spState.last)) : null)
          : null)

      const openaiFields = h('div', { className: 'wb-grid' },
        h(Field, { label: 'Base URL', tip: '不含 /images/generations' },
          h('input', {
            className: 'wb-input wb-mono', value: igc.baseUrl || '', placeholder: 'https://api.openai.com/v1',
            onChange: (e) => setD('imageGen.baseUrl', e.target.value),
          })),
        h(Field, { label: '模型' },
          h('input', {
            className: 'wb-input wb-mono', value: igc.model || '', placeholder: 'gpt-image-1',
            onChange: (e) => setD('imageGen.model', e.target.value),
          })),
        h(Field, { label: 'API Key', tip: igc.apiKey === '已配置' ? '已存，留空表示不改' : '只存在本机凭据库里' },
          h('input', {
            className: 'wb-input wb-mono', type: 'password',
            value: igc.apiKey === '已配置' ? '' : (igc.apiKey || ''),
            placeholder: igc.apiKey === '已配置' ? '已配置（留空不改）' : 'sk-…',
            onChange: (e) => setD('imageGen.apiKey', e.target.value),
          })),
        h(Field, { label: '尺寸' },
          h('input', {
            className: 'wb-input wb-mono', value: igc.size || '1024x1024',
            onChange: (e) => setD('imageGen.size', e.target.value),
          })))

      const customFields = h('div', null,
        h('div', { className: 'wb-grid' },
          h(Field, { label: '方法' },
            h('select', {
              className: 'wb-select', value: custom.method || 'POST',
              onChange: (e) => setD('imageGen.custom.method', e.target.value),
            }, h('option', { value: 'POST' }, 'POST'), h('option', { value: 'GET' }, 'GET'))),
          h(Field, { label: 'Body 类型' },
            h('select', {
              className: 'wb-select', value: custom.bodyType || 'json',
              onChange: (e) => setD('imageGen.custom.bodyType', e.target.value),
            }, h('option', { value: 'json' }, 'JSON'), h('option', { value: 'form' }, 'Form')))),
        h('div', { style: { height: 10 } }),
        h(Field, { label: 'URL', tip: '要带 {{prompt}} 占位符，或者靠下面的参数传' },
          h('input', {
            className: 'wb-input wb-mono', value: custom.url || '', placeholder: 'https://example.com/draw?q={{prompt}}',
            onChange: (e) => setD('imageGen.custom.url', e.target.value),
          })),
        h('div', { style: { height: 10 } }),
        h(Field, { label: '返回值里图片在哪（点路径）', tip: '比如 data.0.url / images.0；留空就自己找' },
          h('input', {
            className: 'wb-input wb-mono', value: custom.responsePath || '', placeholder: 'data.0.url',
            onChange: (e) => setD('imageGen.custom.responsePath', e.target.value),
          })))

      const imageCard = h(Card, {
        title: '生图',
        hint: '要么填 OpenAI 兼容的接口，要么填一个自己的。没配就不显示这能力，不影响别的。',
        right: h(Switch, { on: !!draft.imageGen?.enabled, onChange: (v) => setD('imageGen.enabled', v) }),
      },
        h('div', { className: 'wb-row', style: { marginBottom: 10 } },
          h('div', { className: 'wb-seg' },
            h('button', {
              type: 'button', className: cx(!isCustom && 'on'),
              onClick: () => setD('imageGen.provider', 'openai'),
            }, 'OpenAI 兼容'),
            h('button', {
              type: 'button', className: cx(isCustom && 'on'),
              onClick: () => setD('imageGen.provider', 'custom'),
            }, '自建接口'))),
        isCustom ? customFields : openaiFields,
        h('div', { style: { height: 10 } }),
        h(Field, { label: '画风补充（可选）', tip: '会接在用户描述后面，比如「日系插画，柔和光线」' },
          h('input', {
            className: 'wb-input', value: igc.stylePrompt || '',
            onChange: (e) => setD('imageGen.stylePrompt', e.target.value),
          })),
        ig
          ? h('div', { className: 'wb-row', style: { marginTop: 10 } },
            h('span', { className: cx('wb-tag', ig.enabled ? 'ok' : '') }, ig.enabled ? '后端就绪' : '还没配好'))
          : null)

      return h('div', { className: 'wb-page' }, moodCard, speakCard, imageCard)
    }

    // ---------------- 日志 ----------------
    function Logs({ toast }) {
      const [rows, setRows] = useState([])
      const [auto, setAuto] = useState(true)
      const load = useCallback(async () => { const r = await get('/logs'); if (r?.ok) setRows(r.rows || []) }, [])
      useEffect(() => { void load() }, [load])
      useEffect(() => {
        if (!auto) return
        const t = setInterval(() => void load(), 2500)
        return () => clearInterval(t)
      }, [auto, load])
      return h('div', { className: 'wb-page' },
        h(Card, {
          title: '插件日志', hint: '密钥都会被抹掉再落盘。',
          right: h('div', { className: 'wb-row' },
            h('span', { className: 'wb-switch-row' }, h(Switch, { on: auto, onChange: setAuto }), h('span', { className: 'lbl' }, '自动刷新')),
            h(Btn, { sm: true, kind: 'ghost', onClick: () => void load() }, '刷新')),
        },
          rows.length
            ? h('div', { className: 'wb-logs' }, rows.slice().reverse().map((l, i) => h('div', { key: i, className: 'wb-log' },
              h('span', { className: 't' }, new Date(l.at).toLocaleTimeString()),
              h('span', { className: cx('lv', l.level) }, l.level),
              h('span', null, l.text))))
            : h(Empty, null, '还没有日志。')))
    }

    // ---------------- 向导 ----------------
    function Wizard({ st, cfg, toast, reload, onClose }) {
      const [step, setStep] = useState(0)
      const [botId, setBotId] = useState(cfg.botId || '')
      const [secret, setSecret] = useState('')
      const [userid, setUserid] = useState('')
      const [name, setName] = useState('')
      const [mode, setMode] = useState(cfg.accessMode || 'whitelist')
      const [mcpUrl, setMcpUrl] = useState('')
      const [busy, setBusy] = useState(false)

      const steps = ['填凭据', '认管理员', '选准入', '配 MCP']
      const finish = async () => {
        setBusy(true)
        await post('/save', { config: { ...cfg, setupDone: true, guideDone: true } })
        setBusy(false)
        toast('配置好了，可以聊了', 'ok')
        void reload()
        onClose()
      }
      const connectNow = async () => {
        if (!botId.trim() || !secret.trim()) return toast('两个都要填', 'err')
        setBusy(true)
        const r = await post('/connect', { botId: botId.trim(), secret: secret.trim() })
        setBusy(false)
        if (r?.ok) { toast('连上了', 'ok'); setStep(1) } else toast(r?.message || '没连上', 'err')
      }
      const saveAdmin = async () => {
        if (!userid.trim()) return toast('把你的 userid 填上', 'err')
        const r = await post('/admin/add', { userid: userid.trim(), name: name.trim() })
        if (r?.ok) { toast('管理员加好了', 'ok'); setStep(2) } else toast(r?.message || '失败', 'err')
      }
      const saveMode = async () => {
        const r = await post('/save', { config: { ...cfg, accessMode: mode } })
        if (r?.ok) setStep(3)
      }
      const saveMcp = async () => {
        if (!mcpUrl.trim()) { await finish(); return }
        const r = await post('/admin/mcp', { userid: userid.trim() || (cfg.admins[0] && cfg.admins[0].userid), service: 'msg', url: mcpUrl.trim() })
        if (r?.ok) await finish()
        else toast(r?.message || 'URL 不对', 'err')
      }

      return h('div', { className: 'wb-wizard', onClick: (e) => e.target === e.currentTarget && onClose() },
        h('div', { className: 'wb-wizard-in' },
          h('div', { className: 'wb-steps' }, steps.map((s, i) => h('div', { key: s, className: cx('wb-step', i <= step && 'on') }))),
          h('h2', { style: { margin: '0 0 4px', fontSize: 17 } }, '第 ' + (step + 1) + ' 步 · ' + steps[step]),
          step === 0 ? h('div', null,
            h('p', { className: 'wb-hint' }, '在企业管理后台 → 应用管理 → 智能机器人 → API 模式，把 bot_id 和 secret 抄过来。'),
            h(Field, { label: 'bot_id' }, h('input', { className: 'wb-input wb-mono', value: botId, placeholder: 'aib…', onChange: (e) => setBotId(e.target.value) })),
            h('div', { style: { height: 10 } }),
            h(Field, { label: 'secret' }, h('input', { className: 'wb-input wb-mono', type: 'password', value: secret, onChange: (e) => setSecret(e.target.value) })),
            h('div', { className: 'wb-row', style: { marginTop: 16 } },
              h(Btn, { kind: 'primary', onClick: () => void connectNow(), disabled: busy }, busy ? '连接中…' : '保存并连接'),
              h(Btn, { kind: 'ghost', onClick: onClose }, '先跳过'))) : null,
          step === 1 ? h('div', null,
            h('p', { className: 'wb-hint' }, '现在用你自己的企业微信，给这个机器人发一条私信。它会回你一个 ID —— 把那串抄到下面。(不用绑定码，也不用截图)'),
            h(Field, { label: '你的 userid', tip: '形如 wofL_hCgAAJ5l8Bm66pquN28rQ76vQWg' },
              h('input', { className: 'wb-input wb-mono', value: userid, onChange: (e) => setUserid(e.target.value) })),
            h('div', { style: { height: 10 } }),
            h(Field, { label: '怎么称呼你' }, h('input', { className: 'wb-input', value: name, onChange: (e) => setName(e.target.value) })),
            h('div', { className: 'wb-row', style: { marginTop: 16 } },
              h(Btn, { kind: 'primary', onClick: () => void saveAdmin() }, '这就是我'),
              h(Btn, { kind: 'ghost', onClick: () => setStep(2) }, '等会儿再填'))) : null,
          step === 2 ? h('div', null,
            h('p', { className: 'wb-hint' }, '白名单更安全（默认）；开放模式谁都能聊，但开销不受控。以后能随时改。'),
            h('div', { className: 'wb-seg' },
              h('button', { type: 'button', className: cx(mode === 'whitelist' && 'on'), onClick: () => setMode('whitelist') }, '白名单'),
              h('button', { type: 'button', className: cx(mode === 'open' && 'on'), onClick: () => setMode('open') }, '开放模式')),
            h('div', { className: 'wb-row', style: { marginTop: 16 } },
              h(Btn, { kind: 'primary', onClick: () => void saveMode() }, '就这个'))) : null,
          step === 3 ? h('div', null,
            h('p', { className: 'wb-hint' }, 'MCP 是可选增强：能读群历史、发文件、操作文档微盘邮件待办日程。填「消息」那个服务的地址就够了，其他随时能补。'),
            h(Field, { label: '消息服务 StreamableHttp URL', tip: 'https://qyapi.weixin.qq.com/mcp/v2/bot/msg?apikey=…' },
              h('input', { className: 'wb-input wb-mono', value: mcpUrl, onChange: (e) => setMcpUrl(e.target.value) })),
            h('div', { className: 'wb-row', style: { marginTop: 16 } },
              h(Btn, { kind: 'primary', onClick: () => void saveMcp() }, '存并完成'),
              h(Btn, { kind: 'ghost', onClick: () => void finish() }, '先不配，直接完成'))) : null,
          h('div', { className: 'wb-row', style: { marginTop: 18, justifyContent: 'flex-end' } },
            h('span', { className: 'wb-dim wb-small', style: { marginRight: 'auto' } }, '之后能在「概览 → 打开引导向导」重新进来'),
            step > 0 ? h(Btn, { kind: 'ghost', onClick: () => setStep(step - 1) }, '上一步') : null,
            h(Btn, { kind: 'ghost', onClick: onClose }, '关闭'))))
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, WeComPage))
      slots.inject('sidebar.panellist', () => slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 22, label: () => '企业微信' }, ChatIcon))
    }

    function ChatIcon({ size }) {
      const s = size || 16
      return h('svg', { width: s, height: s, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M4 11.5C4 7.9 7.6 5 12 5s8 2.9 8 6.5S16.4 18 12 18c-.9 0-1.8-.1-2.6-.3L6 19.5l.7-2.7C5.1 15.6 4 13.7 4 11.5Z' }),
        h('circle', { cx: 9, cy: 11.4, r: 0.7, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 15, cy: 11.4, r: 0.7, fill: 'currentColor', stroke: 'none' }),
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.WeComPage = WeComPage
    exports.ChatIcon = ChatIcon
    return module.exports
  },
})
