/**
 * toast.mjs —— Windows 通知（借用 dsh-douyin-scroll 的 lib/toast.mjs，2026-10-24）
 * ============================================================================
 * 为什么要有：我们这边一轮刷完只写日记/状态，人得自己去翻才知道结果。
 * Windows 通知中心是零配置的：不装 BurntToast、不联网、不要 token。
 *
 * 实现：powershell.exe（5.1，WinRT 在它这里才稳）调 Windows.UI.Notifications，
 *      标题/正文走临时 JSON 文件（命令行塞中文和引号会被转义坑死）。
 *
 * 三条纪律（照抄原实现）：
 *   ① 永不抛异常：通知发不出去只是"这一轮没提醒到"，不能把那一轮拖下水；
 *   ② 不联网、不装东西；
 *   ③ 正文截断：Toast 只看头几行，完整内容留在日记/状态里。
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 桌面程序弹 Toast 必须有"身份"；借 PowerShell 自己的 AUMID 是不注册快捷方式时唯一可靠的做法
const AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

const PS_SCRIPT = String.raw`
param([string]$Json, [string]$Aumid)
$ErrorActionPreference = 'Stop'
try {
  $msg = (Get-Content -LiteralPath $Json -Raw -Encoding UTF8) | ConvertFrom-Json
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null

  $title = [System.Security.SecurityElement]::Escape([string]$msg.title)
  $body  = [System.Security.SecurityElement]::Escape([string]$msg.body)
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>' + $title + '</text><text>' + $body + '</text></binding></visual><audio src="ms-winsoundevent:Notification.Default"/></toast>')

  $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
  # 同名 Tag 会覆盖上一条，避免刷屏（Tag 只允许 1-16 位字母数字）
  try { $toast.Tag = 'dafeiyu'; $toast.Group = 'dafeiyu' } catch {}
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($Aumid).Show($toast)
  Write-Output 'OK'
} catch {
  Write-Output ('ERR:' + $_.Exception.Message)
}
`

function ensureScript(dir) {
  mkdirSync(dir, { recursive: true })
  const ps1 = join(dir, 'toast.ps1')
  writeFileSync(ps1, PS_SCRIPT, 'utf8')
  return ps1
}

/**
 * 发一条 Windows 通知。永不抛异常。
 * @param {{ title?: string, body?: string, timeoutMs?: number, dir?: string }} o
 * @returns {{ ok: boolean, sent: boolean, error?: string }}
 */
export function sendToast({ title = '大肥鱼', body = '', timeoutMs = 20_000, dir } = {}) {
  if (process.platform !== 'win32') return { ok: false, sent: false, error: 'not_windows' }
  const workDir = dir || join(tmpdir(), 'dsh-douyin-toast')
  const jsonFile = join(workDir, `msg-${process.pid}-${Date.now()}.json`)
  try {
    const ps1 = ensureScript(workDir)
    const payload = { title: String(title || '大肥鱼').slice(0, 64), body: String(body || '').slice(0, 220) }
    writeFileSync(jsonFile, JSON.stringify(payload), 'utf8')
    const r = spawnSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Json', jsonFile, '-Aumid', AUMID],
      { windowsHide: true, timeout: timeoutMs, encoding: 'utf8' })
    const out = String(r.stdout || '') + String(r.stderr || '')
    if (r.error) return { ok: false, sent: false, error: String(r.error.message || r.error) }
    if (r.status !== 0 || !/OK/.test(out)) return { ok: false, sent: false, error: (out.trim() || `powershell exit=${r.status}`).slice(0, 300) }
    return { ok: true, sent: true }
  } catch (e) {
    return { ok: false, sent: false, error: String(e?.message ?? e) }
  } finally {
    try { rmSync(jsonFile, { force: true }) } catch { /* 删不掉就算了 */ }
  }
}
