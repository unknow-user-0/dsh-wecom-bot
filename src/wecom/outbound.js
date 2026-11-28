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
import { asLog } from '../core/safe.js'
import { withChatId, isInvalidChatId } from './chatid.js'

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
export async function uploadMedia({ buffer, fileName, type = 'file' }, { mcpFor, log: logRaw = () => {} }) {
  const log = asLog(logRaw)
  const picked = await uploadClient(mcpFor)
  if (!picked) {
    throw new SendFileError('没配 MCP 的 disk / mail / doc 服务，传不了文件。让管理员在设置里填一个。', 'no_mcp')
  }
  const { client, service } = picked

  // 图片先压：企微图片有自己的体积限制，手机直出的十几 MB 原图会被拒
  let data = buffer
  if (type === 'image') {
    // 「压不动」要拒绝发送，这个决定不能被下面那个 catch 吞掉 ——
    // 那个 catch 的本意是「压缩这一步出错就跳过，原图照发」，
    // 两者是完全相反的结论，所以用变量把它带出 try。
    let tooLarge = null
    try {
      const { fitImageToBudget, sniffImageMime, imageExt } = await import('./media.js')
      const mime = sniffImageMime(data)
      if (mime) {
        // 不传 require 函数：media.js 内部默认走 deps.tryRequire，
        // 自己会依次找插件 node_modules、DSH profiles、cwd。
        // 以前这里取 globalThis.__wecomRequire（从未赋值），后来又各传各的
        // nodeRequire/tryRequire —— 每个调用点一份解析逻辑，漏一处就整条链路失效。
        const fit = await fitImageToBudget(data, mime)
        if (fit.overBudget) {
          // 压到极限还是超预算：拒绝，别传上去赌企微会不会收。
          // 赌输的代价是「用户以为配好了图，对面永远收不到」，而他无从察觉。
          tooLarge = `这张图压到极限还有 ${(fit.data.length / 1048576).toFixed(1)} MB，超过企微图片上限。`
            + '换一张小点的，或者先把它缩小再传。'
        } else if (fit.data !== data) {
          data = fit.data
          const base = fileName.replace(/\.[^.]+$/, '')
          fileName = base + imageExt(fit.mimeType)
          log('info', `图片已压缩：${buffer.length} → ${data.length} 字节`)
        }
      }
    } catch (error) {
      log('debug', `图片压缩跳过：${error.message}`)
    }
    if (tooLarge) throw new SendFileError(tooLarge, 'image_too_large')
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
export async function sendLocalFile({ path, chatId, chatType, msgType }, { mcpFor, log: logRaw = () => {} }) {
  const log = asLog(logRaw)
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

  const up = await uploadMedia({ buffer, fileName, type }, { mcpFor, log: logRaw })

  const msg = await mcpFor?.('msg')
  if (!msg) throw new SendFileError('没配 MCP 的 msg 服务，发不了文件。', 'no_msg_mcp')

  const body = { chat_id: chatId, msg_type: type }
  if (type === 'image') body.image = { media_id: up.mediaId }
  else if (type === 'video') body.video = { media_id: up.mediaId, title: fileName }
  else if (type === 'voice') body.voice = { media_id: up.mediaId }
  else body.file = { media_id: up.mediaId }

  try {
    // 单聊的 chat_id 有些企业要的是加密串，不是回调里那个 from.userid。
    // 平时行为和以前一模一样：只有真撞上「非法的 chat_id」才会去通讯录换一次再重发。
    const r = await withChatId(
      (id) => msg.call('message_aibot_send', { ...body, chat_id: id }),
      { chatId, mcpFor, log: logRaw, what: `发文件（${fileName}）` },
    )
    log('info', `文件已发：${fileName}（${up.bytes} 字节，${type}）`)
    return { ok: true, mediaId: up.mediaId, bytes: up.bytes, fileName, raw: r }
  } catch (error) {
    throw new SendFileError(sendFailedMessage(error, chatId), 'send_failed')
  }
}

/**
 * 发失败的说明。把「值不对」和「会话不在」分开说 ——
 * 40073 只说明形态不对，让人去查会话在不在纯属误导。
 */
function sendFailedMessage(error, chatId) {
  if (isInvalidChatId(error)) {
    return (
      `企微不认这个会话 ID（原值 ${chatId}）：${error.message}\n` +
      '这个企业的单聊会话 ID 和 userid 不是一个值，而通讯录里也没换成唯一的一个 —— ' +
      '要么这个人还没跟机器人说过话，要么管理员的 userid 不是企微后台那个真正的 UserID，' +
      '要么没配 MCP 的 contact 服务。'
    )
  }
  return `发送失败：${error.message}`
}

/**
 * 上传到微盘（超过单次上限时的唯一出路）。
 * 微盘单文件上限 20 GB，比窗口的 1 GB 宽松得多。
 */
export async function uploadToDisk({ path, folderId }, { mcpFor, log: logRaw = () => {} }) {
  const log = asLog(logRaw)
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
