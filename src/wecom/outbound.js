// 出站媒体：把本地文件/图片发到企微
//
// 硬事实（都已真机验证）：
//   长连接的 aibot_send_msg / aibot_respond_msg 只认 text / markdown / image / stream / template_card
//   —— image 那一格要的是 media_id，不是 url，所以图片也得先上传
//   文件完全走不了长连接，必须走 MCP：
//     media_upload（disk / mail / doc 服务都有，参数一样）
//       → { type, file_name, base64_content } → { media_id }
//     message_aibot_send（msg 服务）
//       → { chat_id, msg_type:'file'|'image'|'video'|'voice', file:{media_id} }
//   实测返回 {"success":true,"errcode":0}
//
// 分工（老板定过）：
//   机器人给用户发文件 —— 默认只给管理员，其他人要发得管理员在面板里改
//   发图 —— 按功能开关走

import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'

/** 单文件上限：草稿里定 20 MB，base64 后约 27 MB，还在 MCP 请求体承受范围内 */
export const MAX_FILE_BYTES = 20 * 1024 * 1024
/** 图片压到这个预算内（企微图片有自己的限制，超了会失败） */
const IMAGE_BUDGET = 1_400_000

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic'])

export class SendFileError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'SendFileError'
    this.code = code
  }
}

export function isImagePath(p) {
  return IMAGE_EXT.has(extname(String(p || '')).toLowerCase())
}

/**
 * 选一个能上传的服务。disk 最稳（它本来就有 media_upload），
 * mail / doc 也有同一个工具做兜底。
 */
async function uploadClient(mcpFor) {
  for (const service of ['disk', 'mail', 'doc']) {
    const c = await mcpFor?.(service)
    if (c) return { client: c, service }
  }
  return null
}

/**
 * 上传一段内容拿 media_id。
 * @param {object} o
 * @param {Buffer} o.buffer
 * @param {string} o.fileName
 * @param {'image'|'file'|'video'|'voice'} o.type
 */
export async function uploadMedia({ buffer, fileName, type = 'file' }, { mcpFor, log = () => {} }) {
  const picked = await uploadClient(mcpFor)
  if (!picked) {
    throw new SendFileError('没配 MCP 的 disk / mail / doc 服务，传不了文件。让管理员在设置里填一个。', 'no_mcp')
  }
  const { client, service } = picked

  // 图片先压：企微图片有自己的体积限制，手机直出的十几 MB 原图会被拒
  let data = buffer
  if (type === 'image') {
    try {
      const { fitImageToBudget, sniffImageMime, imageExt } = await import('./media.js')
      const mime = sniffImageMime(data)
      if (mime) {
        const fit = await fitImageToBudget(data, mime, (n) => globalThis.__wecomRequire?.(n))
        if (fit.data !== data) {
          data = fit.data
          const base = fileName.replace(/\.[^.]+$/, '')
          fileName = base + imageExt(fit.mimeType)
          log('info', `图片已压缩：${buffer.length} → ${data.length} 字节`)
        }
      }
    } catch (error) {
      log('debug', `图片压缩跳过：${error.message}`)
    }
  }

  const payload = {
    type,
    file_name: fileName || `file-${Date.now()}`,
    base64_content: data.toString('base64'),
  }

  let result
  try {
    result = await client.call('media_upload', payload)
  } catch (error) {
    throw new SendFileError(`上传到企微失败（${service} 服务）：${error.message}`, 'upload_failed')
  }
  const mediaId = result?.media_id
  if (!mediaId) {
    throw new SendFileError(`上传没拿到 media_id：${JSON.stringify(result).slice(0, 200)}`, 'no_media_id')
  }
  return { mediaId, bytes: data.length, fileName, service }
}

/**
 * 发一个本地文件/图片到会话。
 * @param {object} o
 * @param {string} o.path        本地文件路径
 * @param {string} o.chatId      单聊传 userid，群聊传群 chatid
 * @param {1|2} o.chatType
 * @param {string} [o.msgType]   不填按扩展名猜
 */
export async function sendLocalFile({ path, chatId, chatType, msgType }, { mcpFor, log = () => {} }) {
  const st = await stat(path).catch(() => null)
  if (!st || !st.isFile()) throw new SendFileError(`找不到文件：${path}`, 'no_file')
  if (st.size > MAX_FILE_BYTES) {
    throw new SendFileError(
      `文件 ${(st.size / 1048576).toFixed(1)} MB，超过单次上限 ${MAX_FILE_BYTES / 1048576} MB。` +
      `大文件先传微盘再把链接发过去（微盘单文件上限 20 GB）。`,
      'too_large',
    )
  }

  const buffer = await readFile(path)
  const type = msgType || (isImagePath(path) ? 'image' : 'file')
  const fileName = basename(path)

  const up = await uploadMedia({ buffer, fileName, type }, { mcpFor, log })

  const msg = await mcpFor?.('msg')
  if (!msg) throw new SendFileError('没配 MCP 的 msg 服务，发不了文件。', 'no_msg_mcp')

  const body = { chat_id: chatId, msg_type: type }
  if (type === 'image') body.image = { media_id: up.mediaId }
  else if (type === 'video') body.video = { media_id: up.mediaId, title: fileName }
  else if (type === 'voice') body.voice = { media_id: up.mediaId }
  else body.file = { media_id: up.mediaId }

  try {
    const r = await msg.call('message_aibot_send', body)
    log('info', `文件已发：${fileName}（${up.bytes} 字节，${type}）`)
    return { ok: true, mediaId: up.mediaId, bytes: up.bytes, fileName, raw: r }
  } catch (error) {
    throw new SendFileError(`发送失败：${error.message}`, 'send_failed')
  }
}

/**
 * 发图片（Buffer 形式，比如生图结果）。
 * 走 MCP 的 message_aibot_send，因为长连接的 image 帧也要 media_id。
 */
export async function sendImageBuffer({ buffer, chatId, chatType, fileName = 'image.png' }, { mcpFor, log = () => {} }) {
  const up = await uploadMedia({ buffer, fileName, type: 'image' }, { mcpFor, log })
  const msg = await mcpFor?.('msg')
  if (!msg) throw new SendFileError('没配 MCP 的 msg 服务，发不了图片。', 'no_msg_mcp')
  try {
    const r = await msg.call('message_aibot_send', { chat_id: chatId, msg_type: 'image', image: { media_id: up.mediaId } })
    log('info', `图片已发（${up.bytes} 字节）`)
    return { ok: true, mediaId: up.mediaId, bytes: up.bytes, raw: r }
  } catch (error) {
    throw new SendFileError(`发图失败：${error.message}`, 'send_failed')
  }
}

/**
 * 上传到微盘（超过单次上限时的唯一出路）。
 * 微盘单文件上限 20 GB，比窗口的 1 GB 宽松得多。
 */
export async function uploadToDisk({ path, folderId }, { mcpFor, log = () => {} }) {
  const disk = await mcpFor?.('disk')
  if (!disk) throw new SendFileError('没配 MCP 的 disk 服务，传不了微盘。', 'no_mcp')
  const st = await stat(path).catch(() => null)
  if (!st || !st.isFile()) throw new SendFileError(`找不到文件：${path}`, 'no_file')

  const args = { file_path: path, file_name: basename(path) }
  if (folderId) args.folder_id = folderId
  try {
    const r = await disk.call('disk_files_upload', args)
    log('info', `已上传微盘：${basename(path)}`)
    return r
  } catch (error) {
    throw new SendFileError(`上传微盘失败：${error.message}`, 'disk_failed')
  }
}

/** 微盘里搜文件（没有「列出全部」的能力，只能搜） */
export async function searchDisk(keyword, { mcpFor }) {
  const disk = await mcpFor?.('disk')
  if (!disk) throw new SendFileError('没配 MCP 的 disk 服务。', 'no_mcp')
  return disk.call('disk_files_search', { keyword })
}

/** 从消息里下载媒体（入站文件/图片的备用通道） */
export async function fetchMessageMedia(mediaId, { mcpFor }) {
  const msg = await mcpFor?.('msg')
  if (!msg) throw new SendFileError('没配 MCP 的 msg 服务。', 'no_mcp')
  return msg.call('message_files_get', { media_id: mediaId })
}
