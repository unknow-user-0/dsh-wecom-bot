// 单聊 chat_id 换算的回归测试
//
// 背景（2026-11-28 真机踩出来的）：企微单聊回调只给 from.userid，没有 chatid，
// 插件一直拿它当 chat_id。多数企业这两个值是同一个（都是加密串），
// 但机器人由「企业创建者」创建时，回调给的是后台明文 UserID（形如 JiYou），
// 加密接口不认，报 40073「非法的 'chat_id'」。
//
// 文字不受影响是因为走 aibot_respond_msg + req_id，压根不碰 chat_id；
// 图片/文件/历史全挂，因为它们都得传 chat_id。
//
// 这个文件守住四件事：
//   1. 40073 认得出来（且不和别的错误混淆）
//   2. 只在真撞上 40073 时才查通讯录，正常路径零额外请求
//   3. 换算必须「唯一命中 + 精确匹配」，宁可失败也不发错人
//   4. 换到了就重试一次并成功；换不到就把原错误往上抛

let pass = 0, fail = 0
function ok(cond, name, extra = '') {
  if (cond) { pass += 1; console.log(`✅ ${name}`) }
  else { fail += 1; console.log(`❌ ${name}${extra ? ' → ' + extra : ''}`) }
}

const { isInvalidChatId, lookupChatId, withChatId, resetChatIdCache } = await import('../src/wecom/chatid.js')

const silent = () => {}

function err(message, code) {
  const e = new Error(message)
  if (code !== undefined) e.code = code
  return e
}

const E40073 = () => err(`非法的 'chat_id', 请重新检查'chat_id'的值是否正确 (callid: 1795869412304263247770539)`, 40073)

/** 假 contact 服务：按配置返回命中结果，并记下被查了几次 */
function makeContact({ users = [], throwIt = null } = {}) {
  const calls = []
  return {
    calls,
    client: {
      async call(name, args) {
        calls.push({ name, args })
        if (throwIt) throw throwIt
        return { users, users_count: users.length, errcode: 0, errmsg: 'ok' }
      },
    },
  }
}

function makeMcpFor({ contact = null } = {}) {
  const asked = []
  const fn = async (service) => {
    asked.push(service)
    if (service === 'contact') return contact
    return null
  }
  fn.asked = asked
  return fn
}

// ────────────────────────────────────────────────────────────
// 一、40073 的识别面
// ────────────────────────────────────────────────────────────
{
  ok(isInvalidChatId(E40073()), '认得出企微原文的「非法的 chat_id」')
  ok(isInvalidChatId(err('非法的 chat_id')), '没有引号也认得出')
  ok(isInvalidChatId(err(`非法的 "chat_id"`)), '双引号也认得出')
  ok(isInvalidChatId(err('invalid chat_id')), '英文写法认得出')
  ok(isInvalidChatId({ code: 40073 }), '只有 code 认得出')
  ok(isInvalidChatId({ errcode: 40073, message: 'x' }), 'errcode 字段也认')
  ok(!isInvalidChatId(null), 'null 不算')
  ok(!isInvalidChatId(undefined), 'undefined 不算')
  ok(!isInvalidChatId(err('对方不是你的好友')), '别的业务错误不算')
  ok(!isInvalidChatId(err('非法的 userid')), '非法的 userid 不算（是另一回事）')
  ok(!isInvalidChatId(err('网络超时')), '网络错误不算')
  ok(!isInvalidChatId(err('invalid media_id', 40007)), '40007（media_id 不对）不算 —— 那是另一类错，别拿通讯录去救')
}

// ────────────────────────────────────────────────────────────
// 二、换算本身：唯一命中 + 精确匹配才采用
// ────────────────────────────────────────────────────────────
{
  resetChatIdCache()
  const c = makeContact({
    users: [{ userid: 'wofL_hCgAAJ5l8Bm66pquN28rQ76vQWg', name: ' 季游', matched_keywords: ['JiYou'] }],
  })
  const mcpFor = makeMcpFor({ contact: c.client })
  const real = await lookupChatId('JiYou', { mcpFor, log: silent })
  ok(real === 'wofL_hCgAAJ5l8Bm66pquN28rQ76vQWg', '明文 JiYou 换成了加密 chat_id')
  ok(c.calls.length === 1, '只查了一次通讯录')
  ok(c.calls[0].name === 'contact_users_search', '查的是 contact_users_search')
  ok(Array.isArray(c.calls[0].args.keywords) && c.calls[0].args.keywords[0] === 'JiYou', 'keywords 传的是那个明文值')
}

{
  resetChatIdCache()
  const c = makeContact({ users: [{ userid: 'u1', name: '甲', matched_keywords: ['JiYou'] }] })
  const mcpFor = makeMcpFor({ contact: c.client })
  await lookupChatId('JiYou', { mcpFor, log: silent })
  await lookupChatId('JiYou', { mcpFor, log: silent })
  await lookupChatId('JiYou', { mcpFor, log: silent })
  ok(c.calls.length === 1, '同一个值查过一次就记住，不再打通讯录')
}

{
  resetChatIdCache()
  const c = makeContact({
    users: [
      { userid: 'u1', name: '甲', matched_keywords: ['JiYou'] },
      { userid: 'u2', name: '乙', matched_keywords: ['JiYou'] },
    ],
  })
  const mcpFor = makeMcpFor({ contact: c.client })
  const real = await lookupChatId('JiYou', { mcpFor, log: silent })
  ok(real === '', '命中两条就放弃 —— 宁可发不出去也不能发错人')
}

{
  resetChatIdCache()
  const c = makeContact({ users: [{ userid: 'u9', name: '季游', matched_keywords: ['季游'] }] })
  const mcpFor = makeMcpFor({ contact: c.client })
  const real = await lookupChatId('JiYou', { mcpFor, log: silent })
  ok(real === '', '命中的是靠名字匹配上的（matched_keywords 对不上），不采用 —— 名字有前导空格，靠不住')
}

{
  resetChatIdCache()
  const c = makeContact({ users: [] })
  const mcpFor = makeMcpFor({ contact: c.client })
  const real = await lookupChatId('JiYou', { mcpFor, log: silent })
  ok(real === '', '一条都没命中就返回空串')
}

{
  resetChatIdCache()
  const logs = []
  const mcpFor = makeMcpFor({ contact: null })
  const real = await lookupChatId('JiYou', { mcpFor, log: (l, t) => logs.push(`${l}:${t}`) })
  ok(real === '', '没配 contact 就返回空串，不崩')
  ok(logs.some((s) => /contact/.test(s)), '并且告诉用户没配 contact —— 这是他能动手解决的')
}

{
  resetChatIdCache()
  const c = makeContact({ throwIt: err('850002 no authorization') })
  const mcpFor = makeMcpFor({ contact: c.client })
  const real = await lookupChatId('JiYou', { mcpFor, log: silent })
  ok(real === '', '通讯录接口报错就返回空串，不往上抛（换算失败不该盖住原始错误）')
}

{
  // 回调本来就是加密串的企业：查通讯录命中自己，视为「已经对了」
  resetChatIdCache()
  const c = makeContact({
    users: [{ userid: 'wofL_hCgAAJ5l8Bm66pquN28rQ76vQWg', name: '季游', matched_keywords: [] }],
  })
  const mcpFor = makeMcpFor({ contact: c.client })
  const real = await lookupChatId('wofL_hCgAAJ5l8Bm66pquN28rQ76vQWg', { mcpFor, log: silent })
  ok(real === 'wofL_hCgAAJ5l8Bm66pquN28rQ76vQWg', 'value 本身就等于 userid 时认下（matched_keywords 空也行）')
}

// ────────────────────────────────────────────────────────────
// 三、withChatId：正常路径零额外请求
// ────────────────────────────────────────────────────────────
{
  resetChatIdCache()
  const mcpFor = makeMcpFor({ contact: makeContact().client })
  const tried = []
  const out = await withChatId(
    async (id) => { tried.push(id); return { ok: true, id } },
    { chatId: 'ordinary-chat', mcpFor, log: silent },
  )
  ok(out.ok === true && out.id === 'ordinary-chat', '不发错就照原样发出去')
  ok(tried.length === 1, '只调用了一次')
  ok(!mcpFor.asked.includes('contact'), '顺风顺水时根本不去碰通讯录 —— 这是「不影响现有企业」的关键')
}

{
  resetChatIdCache()
  const c = makeContact({
    users: [{ userid: 'real-chat', name: '季游', matched_keywords: ['JiYou'] }],
  })
  const mcpFor = makeMcpFor({ contact: c.client })
  const tried = []
  const out = await withChatId(
    async (id) => {
      tried.push(id)
      if (id === 'JiYou') throw E40073()
      return { ok: true, id }
    },
    { chatId: 'JiYou', mcpFor, log: silent },
  )
  ok(out.ok === true, '撞上 40073 后换了 ID 重试成功')
  ok(tried.join(' → ') === 'JiYou → real-chat', `重试用的是换算出来的值（实际 ${tried.join(' → ')}）`)
  ok(c.calls.length === 1, '换算只查一次')
}

{
  resetChatIdCache()
  const mcpFor = makeMcpFor({ contact: makeContact({ users: [] }).client })
  const tried = []
  let caught = null
  try {
    await withChatId(
      async (id) => { tried.push(id); throw E40073() },
      { chatId: 'JiYou', mcpFor, log: silent },
    )
  } catch (e) { caught = e }
  ok(caught !== null, '换不到就把错误抛上去（不能吞掉说「发好了」）')
  ok(isInvalidChatId(caught), '抛上去的仍是原来那个 40073，调用方能识别')
  ok(tried.length === 1, '没换算出来就不拿原值再撞一次')
}

{
  resetChatIdCache()
  const mcpFor = makeMcpFor({ contact: makeContact({ users: [] }).client })
  let caught = null
  try {
    await withChatId(async () => { throw err('网络超时', 'network') }, { chatId: 'x', mcpFor, log: silent })
  } catch (e) { caught = e }
  ok(caught?.message === '网络超时', '不是 chat_id 的错就原样往上抛，不折腾通讯录')
  ok(!mcpFor.asked.includes('contact'), '也不会白查一次通讯录')
}

// ────────────────────────────────────────────────────────────
// 三b、trace 回执：调用方要能在成功日志里写出「实际发给了谁」
//    没有它，日志只能写回调里的原值，而原值可能根本不是真实会话 id ——
//    2026-11-28 珊瑚那台就是因为日志里看不出「换算后到底发给了谁」，
//    被别人的错报告带偏去怀疑 media_id 跨服务失效。
// ────────────────────────────────────────────────────────────
{
  resetChatIdCache()
  const mcpFor = makeMcpFor({ contact: makeContact().client })
  const trace = { chatId: '', swapped: false }
  await withChatId(async (id) => ({ ok: true, id }), {
    chatId: 'ordinary-chat', mcpFor, log: silent, trace,
  })
  ok(trace.chatId === 'ordinary-chat', '顺风时回执写明用的是原值')
  ok(trace.swapped === false, '顺风时回执标明没换算过')
}

{
  resetChatIdCache()
  const c = makeContact({ users: [{ userid: 'real-chat', name: '季游', matched_keywords: ['JiYou'] }] })
  const mcpFor = makeMcpFor({ contact: c.client })
  const trace = { chatId: '', swapped: false }
  await withChatId(
    async (id) => { if (id === 'JiYou') throw E40073(); return { ok: true, id } },
    { chatId: 'JiYou', mcpFor, log: silent, trace },
  )
  ok(trace.chatId === 'real-chat', '换算后回执给的是真实会话 id')
  ok(trace.swapped === true, '换算后回执标明动过')
}

{
  resetChatIdCache()
  // 不传 trace 不能炸 —— 另外四个调用点没传
  const mcpFor = makeMcpFor({ contact: makeContact().client })
  const out = await withChatId(async (id) => ({ ok: true, id }), {
    chatId: 'ordinary-chat', mcpFor, log: silent,
  })
  ok(out.ok === true, '不传回执也照常工作（别把可选参数做成必需）')
}

// ────────────────────────────────────────────────────────────
// 四、别的模块不再各写一份：确认它们都用的是这一处
// ────────────────────────────────────────────────────────────
{
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const root = join(import.meta.dirname, '..')
  for (const f of ['src/wecom/outbound.js', 'src/chat/placeholder.js', 'src/tools/wecom.js', 'src/chat/backfill.js']) {
    const text = readFileSync(join(root, f), 'utf8')
    ok(/from '.*chatid\.js'/.test(text), `${f} 用的是统一的 chatid.js，没有各写一份`)
  }
}

// ────────────────────────────────────────────────────────────
// 五、排查脚本不许有自己的一套判定
//
// 这里踩过一次：dev/diagnose-chatid.mjs 原来自己写了一套结论，插件那边修好后
// 它没跟上，于是同一个问题两处给出互相矛盾的答案 —— 而且它推荐的那条退路
// （改走被动回复发图）早在真机上证伪了（40007 invalid media_id）。
// 离线脚本存在的理由只是「插件没跑起来时还能读磁盘上的配置」，
// 判定必须来自 src/wecom/diagnose.js，否则迟早再漂一次。
// ────────────────────────────────────────────────────────────
{
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const root = join(import.meta.dirname, '..')
  const text = readFileSync(join(root, 'dev/diagnose-chatid.mjs'), 'utf8')

  ok(/from '\.\.\/src\/wecom\/diagnose\.js'/.test(text) || /import\('\.\.\/src\/wecom\/diagnose\.js'\)/.test(text),
    '离线排查脚本调的是 src/wecom/diagnose.js')
  ok(!/classify\s*\(/.test(text), '离线脚本里没有自己的 classify（判定不许重写）')
  // 只查「会不会被输出给用户」：注释里提这条历史是应该的，输出里再出现就是误导
  ok(!/line\([^)]*改走被动回复/.test(text), '输出文案里不再推荐「改走被动回复发图」那条已被证伪的路')
  ok(!/line\([^)]*直接传 userid 一般能过/.test(text), '输出文案里不再给出「直接传 userid 一般能过」这种没验证的结论')
  ok(/只读|不发送/.test(text), '脚本自己写明是只读的')
}

console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
