# 交接：企微插件「看视频」能力的修复

> 给接手的人/对话看的。读完这份就能直接动手，不需要翻历史对话。
> 写于 2026-11-16。仓库：`G:/蓝色大肥鱼/plugins/dsh-wecom-bot`（git 只有一个提交 `b53a581`）。

---

## 0. 一句话现状

**根因已找到、schema 翻译已修、防复发闸已建；尚未重载验证，A/B/C 三处加固还没做。** 六个看视频工具（`video_storyboard` / `video_zoom` / `video_probe` / `video_locate` / `video_subtitles` / `video_help`）在企微插件里**从来没挂上过**——不是没找到包，是注册时被宿主拒绝了。现在 schema 翻译已补、闸也建好了，还差**重载验证** + **A/B/C 三处工程化加固**（可观测性 / 启动时序 / 自检进面板）。

---

## 1. 背景：三层边界

改任何东西之前先认清谁是谁：

| 层 | 是什么 | 能不能改 |
|---|---|---|
| ① 上游 | `dsh-video-storyboard@0.7.4` 的 author spec（`src/storyboard/tool-spec.js`） | ❌ 别人的包，只能翻译 |
| ② 适配层 | 本插件 `src/tools/video.js` 的 `defineTool` 包装 | ✅ **能改，问题都在这** |
| ③ 宿主 | DSH 内核 `dsh-tools` 的 JSON Schema 子集 + `ctx.tools.register()` | ❌ 改不了，只能适配 |

---

## 2. 根因（已确认）

一个方言只翻译了一半。

- 上游的 tool spec 用的是「author 方言」：**required 写在属性里面**，例如
  `dsh-video-storyboard/src/storyboard/tool-spec.js:61`
  ```js
  text: { type: 'string', required: true, description: '...' }
  ```
- 宿主要的是**标准 JSON Schema**：`required` 必须是顶层的字符串数组。
- 本插件 `src/tools/video.js:145` 翻译了 `parameters`（走 `compileAuthorSpec`，会把属性内 `required:true` 提成顶层数组），
  但 `:149` 原来写的是
  ```js
  if (spec.output) tool.output = spec.output   // ← 原样透传，没翻译
  ```
- 宿主一看 `schema.properties.text.required` 就抛：
  ```
  unsupported JSON schema: schema.properties.text.required is not supported on type "string"
  unsupported JSON schema: schema.properties.images.items.type must be one of object/array/string/number/integer/boolean/null
  ```
  code `UNSUPPORTED_SCHEMA`。六个工具**全军覆没**。

### 宿主 schema 子集（从 app.asar 提取的事实，别猜）

- 只认这些**约束关键字**：`type` `oneOf` `properties` `required` `additionalProperties` `items` `enum` `const`
- 只认这些**注解关键字**：`description` `title` `default` `examples`
- **其余一律算违规**（包括 `required` 出现在属性对象里、`type:'json'` 之类）
- 另有硬规则：
  - `required` 必须是字符串数组，且每个名字必须在 `properties` 里
  - `additionalProperties` 必须是 boolean
  - `oneOf` 旁边不许有 `properties`/`required`/`additionalProperties`/`items`/`enum`/`const`

### 为什么一直没人发现

两句话互相掩护：

- `src/tools/video.js:165` 只要 `buildVideoTools` 返回就打印
  「看视频能力已接上（…）：video_storyboard, video_zoom, …」——**那只是"找到了模块"**。
- 真正的 `register` 在 `src/host.js:571-578`，失败只 `log.warn`，不抛、不上报、不进面板。
- 于是 `plugin.log` 里 30 条 WARN（6 工具 × 5 次重挂，行 138-150）和「已接上」并排躺着，谁也没注意。

---

## 3. 已经改了什么（工作区未提交）

`git status` 应显示 `M src/tools/video.js`。

1. `src/tools/video.js:149` 改为：
   ```js
   if (spec.output) tool.output = compileOutputSpec(spec.output)
   ```
2. `src/tools/video.js:103` 新增 `function compileOutputSpec(output)`：
   - 拆出 `schema`，走 `compileValue`
   - `properties` 交给 `compileAuthorSpec`，把属性内 `required` 提到顶层数组
   - `schema` 之外的键（`render` 等）原样保留

编译后 `video_storyboard` 的 output 长这样（合规）：
```json
{"type":"object","additionalProperties":false,
 "properties":{"text":{"type":"string"},"images":{"type":"array","items":{}}},
 "required":["text","images"]}
```
> 注：`compileValue` 会把 `type:'json'` 丢掉，所以 `items` 是空对象 `{}`。宿主接受这种注解式空 schema，不用管。

### 验证脚本（临时）

`G:/蓝色大肥鱼/tmp-check-video-tools.mjs` —— import `buildVideoTools` 后按宿主规则逐条校验，输出 `VIOLATIONS: none`。
**这个脚本该挪进 `dev/`（见下面 D 项），不要留在仓库根目录。**

---

## 4. 接下来要做的四件事

按优先级。**A/B/C 是工程化加固，D 是防复发。都只动 ② 层，不碰宿主也不改上游。**

### A. 把「找到模块」和「挂上了」分开报（最重要）

现状：`src/host.js:564-580`

```js
function mountTools(agent, chat, level, sid) {
  const list = toolsFor(level)
  ...
  for (const tool of list) {
    try {
      const off = agent.ctx.tools.register(tool)
      if (typeof off === 'function') offs.push(off)
    } catch (error) {
      log.warn(`工具 ${tool.name} 挂不上：${error.message}`)   // ← 吞掉了
    }
  }
  mounted.set(sid, { agent, key, offs })
}
```

要改成：

- `mountTools` **返回挂载结果** `{ ok: [...names], failed: [{name, message}] }`
- 有失败 → `log.error`（不是 warn）并写进模块级变量，供 `/state` 读
- 全成功 → `log.info`，且**只打一次**（`mounted` 里已有去重，注意别每次重挂都刷）
- 同时把 `src/tools/video.js:165` 的文案改掉：
  「已接上」→「**找到** dsh-video-storyboard（路径），待挂载：6 个工具」
  真正的「已接上」由 `mountTools` 说。

### B. 消除启动时序竞态

现状：`src/host.js:542-545`

```js
let videoTools = []
buildVideoTools({ ctx, log })
  .then((list) => { videoTools = list })
  .catch((error) => log.warn(`看视频能力没接上：${error.message}`))
```

`buildVideoTools` 内部是动态 `import()`（`src/tools/video.js:122` 起）。**如果第一条消息在 import 返回之前到达，`toolsFor()` 读到的是空数组 `[]`，那一轮模型手里根本没有这 6 个工具。**
视频恰恰是"第一条消息就带视频"的场景，撞上的概率不低。

要改成：存 Promise，别存数组。

```js
const videoToolsReady = buildVideoTools({ ctx, log }).catch((error) => {
  log.warn(`看视频能力没接上：${error.message}`)
  return []
})
// toolsFor 改成 async，或在 mountTools 里 await videoToolsReady
```

调用链很浅，`toolsFor` 只有**一处**调用点：`src/host.js:565`（在 `mountTools` 里）。所以把 `toolsFor` 改 async 只需要动 `mountTools`；而 `mountTools` 又只被 `src/host.js:331` 调用一次，且那里已经包了 `try { } catch`——把 `await` 加进去、catch 里落一条 error 日志即可。

### C. 启动自检，结论写进面板

现在这三项都是"用到才炸"，且炸得看不懂：

| 检查项 | 不检查的后果 | 怎么查 |
|---|---|---|
| `ctx.attachments.saveImage` 是不是函数 | 抽完帧保存时抛 `this DSH build has no \`attachments\` service` | `typeof ctx.attachments?.saveImage === 'function'` |
| ffmpeg 找不找得到 | 跑到抽帧才报错 | `findFfmpeg({ dataDir })`（`src/tools/video.js:49`，已存在） |
| 6 个工具实际挂上几个 | 面板写着"能看视频"，其实一个没有 | 复用 A 的挂载结果 |

把这三项结果挂到现有 `route('/state')`（`src/host.js:621-635`）里，例如：

```js
video: {
  enabled: cfg.features.video,
  module: found?.dir ?? null,      // 找到包的路径
  mounted: [...],                   // 真挂上的工具名
  failed: [{ name, message }],      // 挂不上的
  ffmpeg: ffmpegPath ?? null,
  saveImage: typeof ctx.attachments?.saveImage === 'function',
}
```

> 关键事实：`src/host.js:37` 的 `inject` 里有 `'attachments'`，所以本机这个服务**是存在的**。
> 但注意上游 `dsh-video-storyboard/src/tools/shared.js:52-75` 的 `attachSheetImages` 用的是
> `saveImage.call(attachments, { data, mediaType, name })` —— **必须 `.call`**，因为宿主 `saveImage` 内部读 `this.compression`。

### D. 防复发：schema 闸 —— ✅ **已完成**

`dev/video-tools-check.mjs` 已建好并跑通。

原来的 `dev/tools-check.mjs` 只自检 `buildTools` 造的企微工具（检查 `parameters.type === 'object'`、`description`、`execute`），**根本没跑 `buildVideoTools`**，所以这次事故它一点没拦住。

新的 `dev/video-tools-check.mjs`：

- 用**相对路径** import（`../src/tools/video.js`），不写死绝对路径
- 把第 2 节那套宿主规则完整实现成 `walk()`：约束/注解关键字白名单、`required` 必须是数组且名字得在 `properties` 里、`additionalProperties` 必须是 boolean、`oneOf` 旁禁词、`type` 白名单
- 同时校验 `parameters` 和 `output.schema`（当初漏的就是后者）
- 不合规时 `process.exitCode = 1`，能进 CI、能当重载前的一道闸

**跑通结果**（当前代码，已修）：6 个工具全过，`VIOLATIONS: none`，`EXIT=0`。

**反向验证过**（关键）：把 `video.js:149` 临时改回 `tool.output = spec.output`，脚本立刻报 13 条违规、`EXIT=1`：

```
video_storyboard.output.schema.properties.text.required 必须是字符串数组，实际是 boolean
video_storyboard.output.schema.properties.images.items.type 非法: "json"
video_zoom / video_probe / video_locate / video_subtitles / video_help …… 同样
```

> 顺带确认：`items.type: "json"` 也是宿主不认的（编译时 `compileValue` 已把它丢掉，所以修好后是空 `{}`）。
> 说明当初那个 bug 至少有两处独立违规，只补 required 也不够。

**还剩一件小事**：`dev/tools-check.mjs`（企微自己的 20+ 工具）和 `dev/video-tools-check.mjs` 目前是两个脚本。
如果想让"一条命令全查完"，在 `package.json` 加个 `"check": "node dev/tools-check.mjs && node dev/video-tools-check.mjs"` 即可。不是必须。

---

## 5. 验证步骤（改完按顺序走）

1. **不连网先跑静态检查**：`node dev/video-tools-check.mjs` → 六个 video 工具 schema 全部合规、`VIOLATIONS: none`、退出码 0（A/B/C 改完后再跑一次，别改出新违规）
2. **重载插件** → 看 `C:/Users/Haha/.dsh/plugins-data/wecom-bot/plugin.log`：
   - 不应再出现 `工具 video_* 挂不上`
   - 应出现「已挂上 6 个」之类的 INFO
3. **看面板 `/state`**：`video.mounted` 应有 6 项、`failed` 为空、`ffmpeg` 非 null、`saveImage: true`
4. **端到端**：私聊发一个真视频 → 确认落盘到 `C:/Users/Haha/.dsh/plugins-data/wecom-bot/media/` → 确认模型真的调了 `video_storyboard`（不是嘴上说"我看到了"）
5. 群聊再发一次（`social` 档位也挂了这 6 个工具，`src/host.js:561`）

---

## 6. 速查

| 项 | 值 |
|---|---|
| 插件仓库 | `G:/蓝色大肥鱼/plugins/dsh-wecom-bot` |
| 上游包 | `C:/Users/Haha/.dsh/profiles/desktop/node_modules/dsh-video-storyboard`（0.7.4） |
| 日志 | `C:/Users/Haha/.dsh/plugins-data/wecom-bot/plugin.log` |
| 视频落盘 | `C:/Users/Haha/.dsh/plugins-data/wecom-bot/media/` |
| ffmpeg | `C:/Users/Haha/.dsh/tools/ffmpeg/bin/ffmpeg.exe` |
| 配置 | `C:/Users/Haha/.dsh/plugins-data/wecom-bot/config.json`（`features.video: true`） |
| 入站视频链路 | `src/chat/inbound.js:94-127` `attachInboundFile` 下载解密 → `src/host.js:374-386` `saveInboundFile` 落盘 → prompt 追加 `[对方发来一个文件，已存到：<path>]` |
| 工具注册入口 | `src/host.js:564-580` `mountTools` |
| 工具清单入口 | `src/host.js:549-563` `toolsFor` |
| 合规写法参照 | `src/tools/define.js:10` 的 `defineTool`（output 恒为 `{type:'object', additionalProperties:true, properties:{}}`） |
| 依赖 | `package.json`：只有 `ws ^8.18.0`；optional 有 `sharp ^0.34.0`、`dsh-video-storyboard ^0.7.4` |

---

## 7. 边界提醒（别越线）

- **不要改 `dsh-video-storyboard`**（它在 node_modules 里，会被 `pnpm install` 覆盖）
- **不要试图让宿主放宽 schema 校验**（那是内核红线，改了下次升级就没了）
- 适配层是唯一的正确着力点：**上游出什么方言，插件负责翻译成宿主能吃的标准 JSON Schema**

---

## 8. 补充：宿主 attachments 服务的实际形状（已从 app.asar 核实）

排查时在 asar 里 grep 到的事实，接手时可直接用：

```
async saveImage(input)      // 单个
async saveImages(inputs)    // 批量
```

两者都在 `AttachmentStore` 上（asar 偏移 ~24923879 / ~24923529），并且是 `async` 方法。
所以 C 项的自检写 `typeof ctx.attachments?.saveImage === 'function'` 是对的；
调用时**务必**按上游 `shared.js:52-75` 的写法用 `saveImage.call(attachments, { data, mediaType, name })`——
宿主实现里会读 `this.compression`，直接解构出来调用会丢 `this`。

