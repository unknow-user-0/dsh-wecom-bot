// 准入判断：谁能聊、在哪个档位
//
// 两种模式（面板可切，全局生效）：
//   whitelist —— 只有 admins 和 allow.users / allow.groups 里的人能聊
//   open      —— 只要机器人被拉进群 / 被人私聊就默认能聊（但仍记录名单，方便日后切回白名单）
//
// 管理员永远能私聊，不用写进白名单；管理员永远是最高档位。

/** 判断这条消息能不能处理 */
export function checkAccess(cfg, chat) {
  const admin = chat.userId ? cfg.admins.find((a) => a.userid === chat.userId) : null

  // 管理员永远放行（单聊）
  if (chat.kind === 'dm' && admin) return { allowed: true, reason: '管理员', level: 'owner', admin }

  if (cfg.accessMode === 'open') {
    return { allowed: true, reason: '开放模式', level: 'social', admin }
  }

  // 白名单模式
  if (chat.kind === 'dm') {
    const hit = cfg.allow.users.includes(chat.userId)
    return hit
      ? { allowed: true, reason: '私聊白名单', level: 'social', admin }
      : { allowed: false, reason: '不在私聊白名单', level: 'social', admin }
  }
  if (chat.kind === 'group') {
    const hit = cfg.allow.groups.includes(chat.chatId)
    return hit
      ? { allowed: true, reason: '群白名单', level: 'social', admin }
      : { allowed: false, reason: '不在群白名单', level: 'social', admin }
  }
  return { allowed: false, reason: '未知会话类型', level: 'social', admin }
}

/** 开放模式下自动登记来过的群 / 人（切回白名单时名单现成） */
export function autoRegister(cfg, chat) {
  if (!cfg.autoRegister || cfg.accessMode !== 'open') return null
  if (chat.kind === 'dm') {
    if (cfg.allow.users.includes(chat.userId)) return null
    cfg.allow.users.push(chat.userId)
    return { kind: 'user', id: chat.userId, name: chat.displayName || '' }
  }
  if (chat.kind === 'group') {
    if (cfg.allow.groups.includes(chat.chatId)) return null
    cfg.allow.groups.push(chat.chatId)
    return { kind: 'group', id: chat.chatId, name: chat.groupName || '' }
  }
  return null
}

/**
 * 无权限时回给用户的文案。
 * 关键：把 userid / 群 id 告诉他，让他转给管理员加白名单（企微不会自动告知）。
 *
 * 群聊为什么也要给 id：管理员加群白名单时填的是 chatid，而管理员站在群里
 * 是看不到这串东西的 —— 机器人不主动说出来，他只能去翻日志或者问开发者。
 * 这里把群 id 和发话的人一起给出来：群 id 用来加群，人 id 用来加私聊白名单。
 */
export function deniedReply(chat, userid) {
  if (chat.kind === 'group') {
    const lines = [
      '我还没有在这个群里开通，让管理员把我加进白名单就好。',
      '',
      `群 ID 是：\`${chat.chatId}\``,
    ]
    if (userid) lines.push(`你的 ID 是：\`${userid}\``)
    lines.push('', '把群 ID 发给管理员，让他把我这边的群白名单加上就能聊了。')
    return lines.join('\n')
  }
  return [
    '我还没被允许跟你聊天。',
    '',
    `你的 ID 是：\`${userid}\``,
    '',
    '把这个 ID 发给管理员，让他把我这边的白名单加上就能聊了。',
  ].join('\n')
}
