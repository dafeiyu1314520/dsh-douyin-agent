/**
 * relay-settings.mjs —— 第三方中转站（可选）配置
 * ============================================================================
 * 2026-10-24 主人买了个 OpenAI 兼容的中转（APIGOTO），要求"给我一个输入框填密钥"。
 *
 * 规矩：
 *   ① 文件只存本机：`state/relay.json`，权限 0600；
 *   ② **绝不回显完整 Key**，设置页只给前缀 + 后四位；
 *   ③ 存在即启用（插件模型走中转），不存在就走 DSH 原生模型；
 *   ④ key 不进日志、不进 MEMORY。
 */
import fs from 'node:fs'
import path from 'node:path'
import { resolveRuntimePaths } from './runtime-paths.mjs'

const file = () => path.join(resolveRuntimePaths().stateDir, 'relay.json')

/** 读出可用配置；格式不对当没有（不抛，避免把插件拖下水）。 */
export function readRelay() {
  try {
    const v = JSON.parse(fs.readFileSync(file(), 'utf8'))
    if (!v || typeof v.baseUrl !== 'string' || typeof v.apiKey !== 'string' || typeof v.model !== 'string') return null
    if (!/^https:\/\//i.test(v.baseUrl) || v.apiKey.length < 16 || !v.model.trim() || v.model.length > 200) return null
    return { apiKey: v.apiKey, baseUrl: v.baseUrl.replace(/\/+$/, ''), model: v.model.trim() }
  } catch { return null }
}

const mask = key => (key ? `${key.slice(0, 14)}…${key.slice(-4)}` : '')

/** 给设置页看的状态（不含完整 Key）。 */
export function relayState() {
  const r = readRelay()
  return {
    configured: Boolean(r),
    baseUrl: r?.baseUrl || '',
    model: r?.model || '',
    hasKey: Boolean(r?.apiKey),
    keyHint: mask(r?.apiKey || ''),
    note: r ? '插件模型走这个中转；删掉配置即回到 DSH 原生模型。' : '未配置：插件使用 DSH 已配置的模型。',
  }
}

/** 保存；apiKey 留空表示保留原来的。 */
export function saveRelay(input = {}) {
  const baseUrl = String(input.baseUrl || '').trim()
  const model = String(input.model || '').trim()
  const apiKey = String(input.apiKey || '').trim()
  if (!/^https:\/\/[^\s]+$/i.test(baseUrl)) throw Object.assign(new Error('Base URL 必须是 https:// 开头的地址。'), { status: 400 })
  if (!model || model.length > 200) throw Object.assign(new Error('模型名不能为空，且不超过 200 字。'), { status: 400 })
  const old = readRelay()
  const key = apiKey || old?.apiKey || ''
  if (key.length < 16) throw Object.assign(new Error('API Key 太短，请确认复制完整。'), { status: 400 })
  if (apiKey && !/^sk-[A-Za-z0-9_-]{16,}$/.test(apiKey)) throw Object.assign(new Error('API Key 格式不对（应以 sk- 开头）。'), { status: 400 })
  const payload = { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey: key, model }
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  fs.writeFileSync(file(), JSON.stringify(payload, null, 1), { mode: 0o600 })
  try { fs.chmodSync(file(), 0o600) } catch { /* 设不了权限也不影响使用 */ }
  return relayState()
}

/** 清除配置，回到 DSH 原生模型。 */
export function clearRelay() {
  try { fs.rmSync(file(), { force: true }) } catch { /* 删不掉就当没配 */ }
  return relayState()
}
