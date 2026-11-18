// 入站归一：企微回调帧 → 统一的 Chat / Message 结构
//
// 企微 aibot_msg_callback 的 body 只有这些字段（协议事实，文档 path/101463）：
//   msgid / aibotid / chatid(仅群) / chattype: single|group / from.userid / msgtype / text.content
//   image|file|video: { url, aeskey, filename? }
//   voice: { content? }（语音转文字有时给）
//
// 三个必须知道的协议特点：
//   1. 群聊只有 @机器人 才回调 → mentionedBot 恒 true，没有信息量，不要把判断挂它上面
//   2. text.content 带 "@机器人名 " 前缀。我们在传输层剥掉 ——
//      名字是寻址信息，不是身份信息：它只决定「这条消息是冲着谁来的」，
//      不该进模型的认知层（否则会和角色卡里的自称打架）。
//      剥离必须先精确匹配配置里的名字，匹配不上才退到「第一个 @ 后到空白」，
//      并且要求名字至少 2 个字 —— 否则 @李老师说 会被剥成 老师说。
//   3. chattype=single 时**没有 chatid**，单聊的会话标识就是 from.userid

import { mediaDecrypt, sniffImageMime, sniffFileExt, imageExt, fitImageToBudget, looksLikeImage, looksLikeVideo } from '../wecom/media.js'

/**
 * 剥掉群消息开头的 @机器人名。
 *
 * 关键前提（协议事实，见文件头第 1 条）：群聊只有 @机器人 才会回调，
 * 所以群消息开头的 @xxx **一定**是 @ 了机器人。这让剥离变得比想象中简单 ——
 * 不用猜「@海棠花」是 @了叫海棠花的人 还是 @海棠 + 正文「花」，
 * 它就是后者。于是配置了名字就直接按名字前缀剥，不必要求名字后紧跟分隔符。
 *
 * @returns {string} 剥完的文本（可能是空串，表示对方只 @ 了一下没说话）
 */
export function stripMention(text, botName) {
  const raw = String(text ?? '')
  if (!raw.startsWith('@')) return raw

  const name = String(botName || '').trim()

  // 1) 配置了名字：按前缀剥。名字后面可能是空格、冒号，也可能直接就是正文。
  if (name && raw.startsWith('@' + name)) {
    return raw.slice(1 + name.length).replace(/^[\s\u3000:：,，]+/, '')
  }

  // 2) 没配名字（或名字过时了）：退到「@ 到第一个分隔符」。
  //    要求至少 2 个字 —— 单个字母/字在当前语境里更可能是正文而不是名字，
  //    剥错了用户的话就少一截，这种损失不可恢复，宁可不剥。
  const m = /^@([^\s\u3000:：,，]{2,20})[\s\u3000:：,，]*/.exec(raw)
  if (m) return raw.slice(m[0].length)
  return raw
}

/**
 * @returns {{ chat, text, images, files, msgid, reqId, raw }}
 *   chat = { kind:'dm'|'group', chatId, userId, displayName, groupName }
 */
export function normalizeInbound(frame, { botName = '' } = {}) {
  const body = frame.body || {}
  const chattype = body.chattype === 'group' ? 'group' : 'single'
  const kind = chattype === 'group' ? 'group' : 'dm'
  const fromUser = body.from?.userid || ''
  const chatId = kind === 'group' ? String(body.chatid || '') : fromUser

  const chat = {
    kind,
    chatId,
    userId: fromUser,
    displayName: String(body.from?.name || body.from?.alias || '').trim(),
    groupName: kind === 'group' ? String(body.chatname || body.group_name || '').trim() : '',
  }

  const msgtype = String(body.msgtype || '')
  let text = ''
  if (msgtype === 'text') text = String(body.text?.content ?? '')
  else if (msgtype === 'image') text = '[图片]'
  else if (msgtype === 'file') text = '[文件]'
  else if (msgtype === 'video') text = '[视频]'
  else if (msgtype === 'voice') text = String(body.voice?.content || '[语音]')
  else if (msgtype === 'mixed') text = String(body.mixed?.text?.content || '[混合消息]')
  else text = `[暂不支持的消息类型：${msgtype || 'unknown'}]`

  // 只有群聊的 text 会带 @ 前缀（单聊没有 @ 这回事）。剥完空掉说明对方只 @ 了一下。
  if (kind === 'group' && msgtype === 'text') {
    const stripped = stripMention(text, botName)
    text = stripped.trim() === '' && text.trim() !== '' ? '[对方只 @ 了一下，没说话]' : stripped
  }

  return {
    chat,
    text,
    images: [],
    files: [],
    msgid: String(body.msgid || ''),
    reqId: frame.headers?.req_id || '',
    msgtype,
    raw: body,
  }
}

/**
 * 下载并解密图片。失败不丢事件 —— 保留占位文本，让用户知道是图没取到而不是被忽略。
 * @param {object} raw 回调 body
 * @param {object} message normalizeInbound 的结果（就地改 images / text）
 */
export async function attachInboundImage(raw, message, { log = () => {} } = {}) {
  const image = raw.image || {}
  const url = typeof image.url === 'string' ? image.url : ''
  const aeskey = typeof image.aeskey === 'string' ? image.aeskey : ''
  const fail = (reason) => {
    log('warn', `图片未取得（${reason}）`)
    message.text = `[图片：${reason}，未能读取内容]`
  }
  if (url === '') { fail('回调缺 url'); return }
  log('info', `图片回调 field=${Object.keys(image).join(',')} aeskey=${aeskey.length}字符`)
  try {
    const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(20_000) })
    if (!response.ok) { fail(`下载失败 HTTP ${response.status}`); return }
    const cipher = Buffer.from(await response.arrayBuffer())
    const plain = mediaDecrypt(cipher, aeskey, looksLikeImage)
    if (plain === undefined) { fail(`解密失败 ${cipher.length} 字节`); return }
    const mimeType = sniffImageMime(plain) ?? 'image/png'
    const msgid = message.msgid || 'image'
    const fitted = await fitImageToBudget(plain, mimeType)
    message.images = [{ name: `${msgid}${imageExt(fitted.mimeType)}`, data: new Uint8Array(fitted.data), mimeType: fitted.mimeType }]
    message.text = '[图片]'
    log('info', `入站图片已就绪（${fitted.mimeType}，${fitted.data.length} 字节${fitted.data.length !== plain.length ? `，原图 ${plain.length} 字节已压缩` : ''}）`)
  } catch (error) {
    fail(`处理异常 ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 下载并解密文件 / 视频。与图片同一套加密口径，区别是内容不是图片，
 * 不能用魔数校验，改用严格 PKCS#7 判定解密是否成功。
 * 文件名回调不一定给 → 取 body.file.filename / 魔数嗅探 / url 末段兜底。
 */
export async function attachInboundFile(raw, message, { log = () => {} } = {}) {
  const kind = raw.msgtype === 'video' ? 'video' : 'file'
  const node = raw[kind] || {}
  const url = typeof node.url === 'string' ? node.url : ''
  const aeskey = typeof node.aeskey === 'string' ? node.aeskey : ''
  const label = kind === 'video' ? '视频' : '文件'
  const fail = (reason) => {
    log('warn', `${label}未取得（${reason}）`)
    message.text = `[${label}：${reason}，未能读取内容]`
  }
  if (url === '') { fail('回调缺 url'); return }
  const rawName = typeof node.filename === 'string' && node.filename.trim() !== ''
    ? node.filename.trim()
    : (typeof node.file_name === 'string' && node.file_name.trim() !== '' ? node.file_name.trim() : '')
  log('info', `${label}回调 field=${Object.keys(node).join(',')} aeskey=${aeskey.length}字符`)
  try {
    const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(60_000) })
    if (!response.ok) { fail(`下载失败 HTTP ${response.status}`); return }
    const cipher = Buffer.from(await response.arrayBuffer())
    // 内容不是图片，没法用魔数；明文兜底只在没 aeskey 时允许（避免把密文当文件）
    const plain = mediaDecrypt(cipher, aeskey, () => true, aeskey === '')
    if (plain === undefined || plain.length === 0) { fail(`解密失败 ${cipher.length} 字节`); return }
    const guessExt = (() => {
      const m = /\.([A-Za-z0-9]{1,8})(?:$|\?|#)/.exec(url)
      return m === null ? '' : `.${m[1]}`
    })()
    const sniffed = sniffFileExt(plain)
    const name = rawName !== '' ? rawName : `${message.msgid || 'file'}${sniffed !== '' ? sniffed : guessExt}`
    // msgtype 说 video、但魔数说不是视频时以魔数为准：否则模型会拿一个图片路径去调
    // video_storyboard，白跑一趟；反过来企微把 mp4 塞进 file 字段时也能认出来。
    const isVideo = looksLikeVideo(plain)
    ;(message.files ??= []).push({ name, data: new Uint8Array(plain), kind: isVideo ? 'video' : 'file' })
    message.text = isVideo ? `[视频] ${name}` : `[${label}] ${name}`
    log('info', `入站${label}已就绪（${name}，${plain.length} 字节${isVideo ? '，识别为视频' : ''}）`)
  } catch (error) {
    fail(`处理异常 ${error instanceof Error ? error.message : String(error)}`)
  }
}
