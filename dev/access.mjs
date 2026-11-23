// 准入与档位：谁能聊、拿到哪一档。
//
// 这块以前完全没有测试，而它决定的是「谁能读写你本机的文件」。
// 实际存在的漏洞：admins 数组里 owner 和 admin 两个角色都有，
// 但 levelFor / checkAccess 只判「在不在 admins 里」——
// 于是随便一个管理员私聊就能拿到 owner 档位的完整工具。
// 下面把这个边界钉死。
//
// 跑：node dev/access.mjs

// 数据目录隔离：必须在插件模块被 import 之前设置。
// 这个测试只判权限、不写盘，但 chat/hub.js 的 import 链会走到 config.js，
// 那里加载时就算出 DATA_DIR；不给个临时目录，就等于让测试站在生产数据家门口。
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'wecom-access-'))

const { checkAccess } = await import('../src/chat/access.js')
const { createHub } = await import('../src/chat/hub.js')

let pass = 0
let fail = 0
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  ✅', name) }
  else { fail += 1; console.log('  ❌', name, detail === undefined ? '' : `→ ${detail}`) }
}

// 注意 allow.users / allow.groups 在正常化之后存的是**纯 id 字符串**
// （config.js 的 normalize 用 asId 映射过），不是对象数组。
const cfg = {
  accessMode: 'whitelist',
  admins: [
    { userid: 'u_owner', name: '老大', role: 'owner' },
    { userid: 'u_admin', name: '同事', role: 'admin' },
  ],
  allow: { users: ['u_guest'], groups: ['grp_ok'] },
}
const dm = (id) => ({ kind: 'dm', chatId: id, userId: id })
const grp = (id) => ({ kind: 'group', chatId: id, userId: 'u_guest', groupName: '太子群' })

console.log('\n① 谁能聊')
ok('主人私聊放行', checkAccess(cfg, dm('u_owner')).allowed)
ok('普通管理员私聊放行', checkAccess(cfg, dm('u_admin')).allowed)
ok('白名单私聊放行', checkAccess(cfg, dm('u_guest')).allowed)
ok('陌生人私聊拦下', !checkAccess(cfg, dm('u_stranger')).allowed)
ok('白名单群放行', checkAccess(cfg, grp('grp_ok')).allowed)
ok('不在白名单的群拦下', !checkAccess(cfg, grp('grp_other')).allowed)

console.log('\n② 拿到哪一档（这一档决定能不能碰本机文件）')
ok('主人 → owner', checkAccess(cfg, dm('u_owner')).level === 'owner', checkAccess(cfg, dm('u_owner')).level)
ok('普通管理员 → 只有 social', checkAccess(cfg, dm('u_admin')).level === 'social', checkAccess(cfg, dm('u_admin')).level)
ok('白名单成员 → social', checkAccess(cfg, dm('u_guest')).level === 'social')
ok('群里 → social，哪怕说话的是主人', checkAccess(cfg, { kind: 'group', chatId: 'grp_ok', userId: 'u_owner' }).level === 'social')

console.log('\n③ 开放模式不降标准')
const open = { ...cfg, accessMode: 'open' }
ok('开放模式下陌生人也能聊', checkAccess(open, dm('u_stranger')).allowed)
ok('开放模式下陌生人只有 social', checkAccess(open, dm('u_stranger')).level === 'social')
ok('开放模式下管理员仍然只有 social', checkAccess(open, dm('u_admin')).level === 'social')
ok('开放模式下主人仍是 owner', checkAccess(open, dm('u_owner')).level === 'owner')

console.log('\n④ 建会话时用的档位必须跟准入判断一致')
// 两处各自实现了一遍判断，曾经就是这里分叉的。直接对着同一份 cfg 比。
const hub = createHub({
  dsh: {},
  getConfig: () => cfg,
  log: { debug() {}, info() {}, warn() {}, error() {} },
})
const lf = hub.levelFor
ok('hub 里有 levelFor', typeof lf === 'function', typeof lf)
for (const [label, chat] of [['主人私聊', dm('u_owner')], ['管理员私聊', dm('u_admin')], ['群聊', grp('grp_ok')]]) {
  const a = checkAccess(cfg, chat)
  const b = lf(cfg, chat)
  // 群聊的 checkAccess 可能是拦下的，只比放行的
  if (a.allowed) ok(`${label}：checkAccess 给 ${a.level}，hub 给 ${b}`, a.level === b, `两处判断分叉`)
}

console.log('\n⑤ 没有管理员时不会崩')
const empty = { accessMode: 'whitelist', admins: [], allow: { users: [], groups: [] } }
ok('admins 为空不抛错', (() => { try { checkAccess(empty, dm('u_x')); return true } catch { return false } })())
ok('没人被误判成 owner', !checkAccess(empty, dm('u_x')).allowed)

console.log(`\n${fail ? '❌' : '✅'} ${pass} 项通过${fail ? `，${fail} 项失败` : ''}\n`)
process.exit(fail ? 1 : 0)
