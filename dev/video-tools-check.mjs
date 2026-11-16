// 看视频工具自检：不连 DSH、不连企微，只把 buildVideoTools 造出来，
// 按**宿主 dsh-tools 的 JSON Schema 子集**逐条校验 parameters 和 output.schema。
// 跑：node dev/video-tools-check.mjs    （不合规时退出码 1）
//
// 为什么要这个：2026-11 的事故是 output 里属性级 required 没翻译，六个工具
// 全部注册失败，而日志只打 WARN、面板看不见。这个脚本就是那道闸。
import { buildVideoTools } from '../src/tools/video.js'

// —— 宿主规则（从 G:/DSH/resources/app.asar 的 JsonSchemaError 校验器提取）——
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const CONSTRAINT = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
const ANNOTATION = new Set(['description', 'title', 'default', 'examples'])

const bad = []
function walk(schema, path) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    bad.push(`${path}: 不是对象`)
    return
  }
  const hasOneOf = 'oneOf' in schema
  for (const key of Object.keys(schema)) {
    if (ANNOTATION.has(key)) continue
    if (!CONSTRAINT.has(key)) {
      bad.push(`${path}.${key}: 宿主不认这个关键字`)
      continue
    }
    const value = schema[key]
    if (key === 'type') {
      if (!TYPES.has(value)) bad.push(`${path}.type 非法: ${JSON.stringify(value)}`)
    }
    if (key === 'required') {
      if (!Array.isArray(value)) {
        bad.push(`${path}.required 必须是字符串数组，实际是 ${typeof value}`)
      } else {
        for (const name of value) {
          if (typeof name !== 'string') bad.push(`${path}.required 里有非字符串项`)
          else if (!schema.properties || !(name in schema.properties)) {
            bad.push(`${path}.required 里的 "${name}" 不在 properties 里`)
          }
        }
      }
    }
    if (key === 'additionalProperties' && typeof value !== 'boolean') {
      bad.push(`${path}.additionalProperties 必须是 boolean`)
    }
    if (key === 'properties') {
      if (!value || typeof value !== 'object') bad.push(`${path}.properties 必须是对象`)
      else for (const [name, sub] of Object.entries(value)) walk(sub, `${path}.properties.${name}`)
    }
    if (key === 'items') walk(value, `${path}.items`)
    if (hasOneOf && (key === 'properties' || key === 'required' || key === 'additionalProperties' || key === 'items' || key === 'enum' || key === 'const')) {
      bad.push(`${path}: oneOf 旁边不能有 ${key}`)
    }
  }
}

const logs = []
const log = { info: (m) => logs.push('I ' + m), warn: (m) => logs.push('W ' + m), debug: () => {} }

let report = { ok: [], failed: [], reason: '', dir: '', ffmpeg: '' }
try {
  report = await buildVideoTools({ ctx: {}, log })
} catch (error) {
  console.error('buildVideoTools 抛了：', error.message)
  process.exitCode = 1
}
const tools = Array.isArray(report.ok) ? report.ok : []

for (const line of logs) console.log(line)
if (report.ffmpeg === '') console.log('W 没找到 ffmpeg（抽帧会失败）')

if (!tools.length) {
  console.error(`\n✗ 一个工具都没造出来：${report.reason || '未知原因'}（dir=${report.dir || '未找到'}）`)
  process.exitCode = 1
} else {
  for (const tool of tools) {
    walk(tool.parameters, `${tool.name}.parameters`)
    walk(tool.output?.schema, `${tool.name}.output.schema`)
    const ok = tool.parameters?.type === 'object' && typeof tool.execute === 'function'
    console.log(
      (ok ? '✓' : '✗'), tool.name.padEnd(18),
      '参数:', (Object.keys(tool.parameters?.properties ?? {}).join(',') || '（无）').padEnd(44),
      '必填:', (tool.parameters?.required ?? []).join(',') || '（无）',
      '| render:', typeof tool.output?.render,
    )
    if (!ok) bad.push(`${tool.name}: parameters.type 必须是 object 且必须有 execute`)
  }
  console.log(`\n共 ${tools.length} 个看视频工具`)
  console.log('VIOLATIONS:', bad.length ? '\n  ' + bad.join('\n  ') : 'none')
  if (bad.length) process.exitCode = 1
}
