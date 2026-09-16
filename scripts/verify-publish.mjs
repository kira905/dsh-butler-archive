// 发布后复核器（只读）：两端 refs 对齐 + 内容级检查 + 匿名可读 + 敏感模式复扫
//
// 用法：
//   node scripts/verify-publish.mjs --owner <账号> --repo <仓名> [--local <本地仓目录>] [--skip-github]
//
// 判据（依 oss-publish 技能 §7「验收 5 条」）：
//   1) 双端 refs/heads/main 与本地 HEAD 一致、tag 齐全
//   2) 关键文件在两端都在（**走平台 API 直读，不抓页面 HTML**——页面会命中平台自己的 JS 名）
//   3) 仓库对匿名可见（公开仓）；内容正文用匿名身份读得到
//   4) 发布内容与发布源都无敏感模式（机器名/用户名/本机路径/个人称呼/同步产品/凭证形态）
//   5) 本地发布源跑一遍 verify-source（单一判定源）
//
// 凭据：全部从本机读取（Windows 凭据管理器 + ~/.git-credentials），本脚本不接收、不打印任何令牌。
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const OWNER = opt('owner', null)
const REPO = opt('repo', null)
const LOCAL = opt('local', ROOT)
const SKIP_GH = argv.includes('--skip-github')

if (OWNER === null || REPO === null) {
  console.error('usage: node scripts/verify-publish.mjs --owner <owner> --repo <repo> [--local <dir>] [--skip-github]')
  process.exit(2)
}

let fail = 0
let pass = 0
const check = (name, ok, detail = '') => {
  if (ok) pass += 1
  else fail += 1
  console.log((ok ? '[OK]  ' : '[FAIL]') + ' ' + name + (detail ? ' :: ' + detail : ''))
}
const section = (t) => console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 56 - t.length)))

// ── 凭据（只读本机，不打印） ──────────────────────────────────────────────
const credManPs = (target) => `
$typeCode = @'
using System;
using System.Runtime.InteropServices;
public class C {
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "CredReadW")]
  public static extern bool CredRead(string t, int y, int f, out IntPtr p);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment; public long LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
}
'@
Add-Type -TypeDefinition $typeCode
[IntPtr]$p = [IntPtr]::Zero
[void][C]::CredRead('${target}', 1, 0, [ref]$p)
if ($p -eq [IntPtr]::Zero) { exit 0 }
$c = [System.Runtime.InteropServices.Marshal]::PtrToStructure($p, [type][C+CREDENTIAL])
Write-Output ([System.Runtime.InteropServices.Marshal]::PtrToStringUni($c.CredentialBlob, $c.CredentialBlobSize / 2))
`
const credMan = (target) => (spawnSync('pwsh', ['-NoProfile', '-Command', credManPs(target)], { encoding: 'utf8', timeout: 60000 }).stdout ?? '').trim()
const fileCred = (host) => {
  const p = join(homedir(), '.git-credentials')
  if (!existsSync(p)) return ''
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.includes(host)) continue
    try {
      return decodeURIComponent(new URL(line.trim().replace(/^https?:\/\//, 'https://')).password ?? '')
    } catch { /* ignore */ }
  }
  return ''
}
const GITEE_TOKEN = credMan('git:https://gitee.com')
const GH_TOKEN = fileCred('github.com')

// ── 1. refs 对齐 ──────────────────────────────────────────────────────────
section('1. refs 对齐')
const gitOut = (args) => spawnSync('git', args, { cwd: LOCAL, encoding: 'utf8', timeout: 120000 })
const localHead = gitOut(['rev-parse', 'HEAD']).stdout.trim()
const tagList = gitOut(['tag', '--list']).stdout.split('\n').map((s) => s.trim()).filter(Boolean)
check('本地 HEAD 可读', /^[0-9a-f]{40}$/.test(localHead), localHead.slice(0, 8))
check('本地有版本 tag', tagList.length > 0, tagList.join(', '))

const remoteRefs = async (label, url) => {
  const res = spawnSync('git', ['ls-remote', url], { encoding: 'utf8', timeout: 120000 })
  if (res.status !== 0) {
    check(label + ' ls-remote 成功', false, (res.stderr ?? '').split('\n')[0])
    return null
  }
  const refs = String(res.stdout).split('\n').filter(Boolean)
  const main = refs.find((l) => l.endsWith('refs/heads/main'))?.split('\t')[0] ?? ''
  const tags = refs.filter((l) => l.includes('refs/tags/')).map((l) => l.split('\t')[1])
  check(label + ' main 与本地 HEAD 一致', main === localHead, main.slice(0, 8) + ' vs ' + localHead.slice(0, 8))
  for (const t of tagList) check(label + ' 含 tag ' + t, tags.includes('refs/tags/' + t))
  return { main, tags }
}
const giteeUrl = `https://gitee.com/${OWNER}/${REPO}.git`
const ghUrl = `https://github.com/${OWNER}/${REPO}.git`
await remoteRefs('Gitee', giteeUrl)
if (!SKIP_GH) await remoteRefs('GitHub', ghUrl)

// ── 2/3. 内容级检查（平台 API 直读 + 匿名可见） ───────────────────────────
// 规则表**不写真实机器名 / 用户名 / 本机专属路径或目录名**（本文件随仓发布，写进去等于把要藏的东西写出来）。
// 口径与 verify-source.mjs 第 4 段一致：通用形态永久生效 + 本机标识由环境变量注入。
//   BUILD_MACHINE_NAMES / BUILD_USER_NAMES / BUILD_LAYOUT_ROOTS / BUILD_SYNC_PRODUCTS（逗号或分号分隔）
// 未注入时通用形态仍能抓出任何 `…/Users/<名>` 用户目录、任何盘符绝对路径与凭证形态。
const envList = (name) => (process.env[name] ?? '')
  .split(/[,;]/)
  .map((s) => s.trim())
  .filter((s) => s.length >= 2)
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const EXTRA_MACHINES = envList('BUILD_MACHINE_NAMES')
const EXTRA_USERS = envList('BUILD_USER_NAMES')
const EXTRA_ROOTS = envList('BUILD_LAYOUT_ROOTS')
const EXTRA_SYNC = envList('BUILD_SYNC_PRODUCTS')

const SENSITIVE = [
  [/[\\/]Users[\\/](?!<|\$\{|%)[A-Za-z0-9._-]{2,}/, '用户目录形态'],
  // 盘符前须为「行首或非字母数字」，避免 `http://` 误判为盘符
  [/(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/](?!<|\$\{|%)[^\s'"`<>|?*]{2,}/, '绝对路径形态'],
  [/坚果云|百度网盘|Nutstore/i, '本机同步产品'],
  [/主人|本鱼|铲屎的|鲸鱼娘/, '个人称呼'],
  [/\bsk-[A-Za-z0-9]{8,}|\bgho_[A-Za-z0-9]{20,}|\bghp_[A-Za-z0-9]{20,}/, '凭证形态'],
]
if (EXTRA_SYNC.length) SENSITIVE.unshift([new RegExp(EXTRA_SYNC.map(esc).join('|'), 'i'), '本机同步产品'])
if (EXTRA_MACHINES.length) SENSITIVE.unshift([new RegExp(EXTRA_MACHINES.map(esc).join('|'), 'i'), '机器名'])
if (EXTRA_USERS.length) SENSITIVE.unshift([new RegExp(EXTRA_USERS.map(esc).join('|'), 'i'), '用户名'])
if (EXTRA_ROOTS.length) SENSITIVE.unshift([new RegExp(EXTRA_ROOTS.map(esc).join('|'), 'i'), '本机路径'])
const INJECTED = EXTRA_MACHINES.length + EXTRA_USERS.length + EXTRA_ROOTS.length + EXTRA_SYNC.length
console.log('[i] 敏感规则：通用 ' + (SENSITIVE.length - INJECTED) + ' 条 + 注入 ' + INJECTED
  + '（机器名 ' + EXTRA_MACHINES.length + ' / 用户名 ' + EXTRA_USERS.length
  + ' / 目录名 ' + EXTRA_ROOTS.length + ' / 同步产品 ' + EXTRA_SYNC.length + '）'
  + (INJECTED ? '' : '  ← 未注入 BUILD_* 环境变量，仅通用形态规则生效'))
const scan = (label, text) => {
  let hit = 0
  for (const [re, name] of SENSITIVE) {
    if (re.test(text)) {
      hit += 1
      check(label + ' 命中【' + name + '】', false, (text.match(re) ?? [''])[0])
    }
  }
  if (hit === 0) check(label + ' 无敏感模式', true)
}

section('2. Gitee（匿名直读 API）')
const giteeRead = async (path) => {
  const encoded = path.split('/').map(encodeURIComponent).join('%2F')
  const res = await fetch(`https://gitee.com/api/v5/repos/${OWNER}/${REPO}/contents/${encoded}?ref=main`)
  const body = await res.json()
  return typeof body.content === 'string' ? Buffer.from(body.content, 'base64').toString('utf8') : null
}
const giteeRepo = await (await fetch(`https://gitee.com/api/v5/repos/${OWNER}/${REPO}`)).json()
check('Gitee 仓对匿名可见（公开）', giteeRepo.private === false, 'private=' + (giteeRepo.private ?? giteeRepo.message))
for (const f of ['README.md', 'README.en.md', 'LICENSE', '.gitattributes', 'package.json', 'lib/index.js', 'lib/config.js', 'lib/client.js']) {
  const text = await giteeRead(f)
  check('Gitee 匿名可读 ' + f, typeof text === 'string' && text.length > 0, text ? text.length + ' 字符' : 'null')
}
const giteeReadme = await giteeRead('README.md')
const giteeEn = await giteeRead('README.en.md')
if (typeof giteeReadme === 'string') scan('Gitee README.md', giteeReadme)
if (typeof giteeEn === 'string') scan('Gitee README.en.md', giteeEn)

if (!SKIP_GH) {
  section('3. GitHub（凭据只读 API）')
  const ghHeaders = GH_TOKEN.length > 8
    ? { authorization: 'Bearer ' + GH_TOKEN, accept: 'application/vnd.github+json', 'user-agent': 'verify-publish' }
    : { accept: 'application/vnd.github+json', 'user-agent': 'verify-publish' }
  const ghRead = async (path) => {
    const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}?ref=main`, { headers: ghHeaders })
    const body = await res.json()
    return typeof body.content === 'string' ? Buffer.from(body.content, 'base64').toString('utf8') : null
  }
  const ghRepo = await (await fetch(`https://api.github.com/repos/${OWNER}/${REPO}`, { headers: ghHeaders })).json()
  check('GitHub 仓为公开', ghRepo.private === false, 'private=' + ghRepo.private)
  for (const f of ['README.md', 'README.en.md', 'LICENSE', 'package.json', 'lib/index.js']) {
    const text = await ghRead(f)
    check('GitHub 可读 ' + f, typeof text === 'string' && text.length > 0, text ? text.length + ' 字符' : 'null')
  }
  const ghReadme = await ghRead('README.md')
  if (typeof ghReadme === 'string') scan('GitHub README.md', ghReadme)
}

// ── 5. 本地发布源扫描 ─────────────────────────────────────────────────────
section('4. 本地发布源')
const verify = spawnSync(process.execPath, [join(LOCAL, 'scripts', 'verify-source.mjs'), '.'], { cwd: LOCAL, encoding: 'utf8', timeout: 180000 })
check('verify-source 全绿', /ALL CHECKS PASSED/.test(verify.stdout ?? ''), (verify.stdout ?? '').trim().split('\n').pop())
const dirty = gitOut(['status', '--porcelain']).stdout.trim()
check('本地工作区干净', dirty.length === 0, dirty.split('\n').slice(0, 3).join(' | '))

console.log('\n' + '═'.repeat(60))
console.log(fail === 0 ? `发布复核 PASSED（${pass} 项）` : `发布复核 FAILED（${fail} 失败 / ${pass} 通过）`)
process.exit(fail === 0 ? 0 : 1)
