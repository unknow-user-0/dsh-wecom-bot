// 「要用 llm 就得先 inject」——接口层的守卫。
//
// 立的这条防线来自一次真实的半成品：
//   host.js 的 inject 里漏了 'llm'（照抄 aurabot 时抄漏一个），
//   于是 /memory/models 直接 500：cannot get property "llm" without inject。
//   而 /memory/status 照样能返回模型名 —— 因为它走的是 agentDefaultModel，
//   不需要 llm。一半能跑一半不能跑，最容易被当成「偶发」。
//
// 这个测试不看实现，只看两件事：
//   1. inject 清单里有没有 llm
//   2. 每个需要 llm 的后端接口，在宿主没给 llm 时返回的是「友好降级」而不是抛异常

// 数据目录隔离：必须在插件模块被 import 之前设置。
// 这个测试只查 inject 清单和 llm 降级、不写盘，但 host.js 一 import 就会
// 加载 config.js 算出 DATA_DIR（还会建目录）。不给临时目录，就等于让测试
// 站在生产数据门口——上次就是在这种情形下把老大的角色卡删掉的。
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'wecom-llm-'))

const { inject } = await import('../src/host.js')
const { listModels, resolveModel, ask } = await import('../src/core/model.js')

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`✅ ${name}`) }
  else { fail += 1; console.log(`❌ ${name}${extra ? ` → ${extra}` : ''}`) }
}

await (async () => {
  console.log('① 插件声明了 llm 依赖')
  ok('inject 里有 llm（少了它面板的模型下拉必然 500）', inject.includes('llm'), inject.join(', '))

  console.log('\n② 宿主没给 llm 时要友好降级，不能抛')
  const noLlm = { get: () => null }

  const listed = await listModels(noLlm)
  ok('listModels 返回 ok:false 而不是 throw', listed && listed.ok === false, JSON.stringify(listed))
  ok('listModels 带一句人话', typeof listed?.message === 'string' && listed.message.length > 0, listed?.message)
  ok('listModels 的 models 是空数组（面板能安全 .map）', Array.isArray(listed?.models) && listed.models.length === 0)

  // resolveModel 要能退回默认模型；两个来源都没有才算没有
  ok('宿主什么都没有时 resolveModel 返回 null', resolveModel(noLlm, {}) === null)

  // ask 在没 llm 时抛的是明确的「宿主没有 llm 服务」，不是 TypeError
  let askError = ''
  try { await ask(noLlm, { provider: 'p', model: 'm' }, { text: 'hi' }) } catch (e) { askError = e.message }
  ok('ask 抛的是可读错误', /llm/.test(askError), askError)

  console.log('\n③ 宿主给了 llm 时，三个能力都要真的用上')
  const calls = []
  const fakeLlm = {
    listProviders: () => [{ id: 'buddy', name: 'Buddy' }],
    listModels: async (p) => [{ provider: p, id: 'flash', name: 'Flash' }],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' } }),
    stream(params) {
      calls.push(params)
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: '{"memories":[],"skills":[]}' }
        yield { type: 'finish', index: 0, reason: { kind: 'completed' } }
      })()
    },
  }
  const withLlm = { llm: fakeLlm, get: (n) => (n === 'llm' ? fakeLlm : null) }

  const list2 = await listModels(withLlm)
  ok('列得出模型', list2.ok === true && list2.models.length === 1, JSON.stringify(list2.models))
  ok('模型项自带 provider 名（下拉要显示「provider / model」）', list2.models[0].providerName === 'Buddy', JSON.stringify(list2.models[0]))

  const out = await ask(withLlm, { provider: 'buddy', model: 'flash' }, { text: 'hi', maxTokens: 5000 })
  ok('ask 拿到了模型输出', out.includes('memories'), out.slice(0, 40))
  ok('maxTokens 被夹进 200~8000', calls[0].maxTokens >= 200 && calls[0].maxTokens <= 8000, String(calls[0].maxTokens))
  ok('消息形态带 source.plugin（DSH 靠它归类）', calls[0].messages?.[0]?.source?.plugin === 'wecom-bot', JSON.stringify(calls[0].messages?.[0]?.source))

  console.log(`\n${fail === 0 ? '✅' : '❌'} llm 依赖与降级都正确（${pass} 项通过${fail ? `，${fail} 项失败` : ''}）`)
  process.exit(fail === 0 ? 0 : 1)
})()
