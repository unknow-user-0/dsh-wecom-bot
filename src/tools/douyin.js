// 抖音「看懂视频」工具：让别人发来的抖音链接变成模型能读的标题 / 摘要 / 热评。
// 走的是 aurabot 那套页面内 API 读元数据，不下载视频文件、不强依赖登录态。
//
// 档位：跟 video_* 一样全档位给（群成员也能用）。它只能按校验过的视频号调抖音
// 自己的只读接口，没有任意导航 / 点击 / 读文件 / 发消息；而且读的时候开的是
// 独立标签页（见 src/browser/cdp.js 的 withTab），不碰主人正在用的页面。

import { defineTool, str } from './define.js'

export function buildDouyinTools({ douyin }) {
  const tools = []
  if (!douyin?.watch) return tools

  tools.push(defineTool({
    name: 'douyin_watch',
    description: '打开一个抖音视频看看：读标题、分类、内容摘要、文案和热评，看完再聊。别人发来抖音链接（v.douyin.com 短链也行，或直接一串视频号）时用这个，然后就能总结、讨论这个视频。不下载视频文件。',
    properties: {
      link: str('抖音链接：完整链接、v.douyin.com 短链，或纯视频 id 都行'),
    },
    required: ['link'],
    slow: true,
    execute: async (args) => douyin.watch(args.link),
  }))

  return tools
}
