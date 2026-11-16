// 工具的写法
//
// 和 @deepseek-ai/dsh-tools 的 defineTool 产物同形：parameters / output.schema 都是 JSON Schema。
// 注意 host 只认这些 schema 子集：string / number / integer / boolean / null / array(items) /
// object(properties, additionalProperties) / json / oneOf。**minimum / maximum / pattern /
// maxItems / minLength / format 一律不被支持**，写了也不会生效，不要依赖它们做校验。
//
// render 可选：默认只回一行文字；工具要把图片之类的内容块放进结果时自己传。

export function defineTool({ name, description, properties = {}, required = [], execute, render, slow }) {
  const parameters = { type: 'object', properties, required, additionalProperties: false }
  return {
    name,
    description,
    // 慢工具（生图、看视频、跑浏览器……）：超过 1.5 秒先往会话发一条「正在做」的提示，
    // 别让人干等一整轮。快工具不用标。
    ...(slow ? { slow } : {}),
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: render || ((_args, value) => [
        { type: 'text', text: value && value.ok === false ? '✗ ' + (value.message || '没成功') : (value && value.message) || '✓' },
      ]),
    },
    async execute(args, exec) {
      try {
        const r = await execute(args || {}, exec)
        return JSON.parse(JSON.stringify(r ?? { ok: true }))
      } catch (error) {
        return { ok: false, message: String(error && error.message ? error.message : error) }
      }
    },
  }
}

export const str = (description) => ({ type: 'string', description })
export const int = (description) => ({ type: 'integer', description })
export const num = (description) => ({ type: 'number', description })
export const bool = (description) => ({ type: 'boolean', description })
export const arr = (description, items = {}) => ({ type: 'array', items, description })
