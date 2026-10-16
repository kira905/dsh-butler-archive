// 推送本仓到远端（幂等；token 只从环境变量读，绝不落盘、绝不写进 git remote 配置）
//
// 用法（在仓库根目录执行）：
//   # 先把 token 放进环境变量（不要写进命令行、不要写进脚本、不要提交）
//   # PowerShell: 设置名为 OSS_PUSH_TOKEN 的环境变量（值 = 你的访问令牌）
//   node scripts/push-publish.mjs --platform gitee  --owner <账号> --repo dsh-archive-sessions
//   node scripts/push-publish.mjs --platform github --owner <账号> --repo dsh-archive-sessions
//
//   # 只看会做什么，不真推
//   node scripts/push-publish.mjs --platform gitee --owner <账号> --repo dsh-archive-sessions --dry-run
//
// 做四件事：
//   1) 前置自检：仓库干净、分支为 main、关键文件在位（README/LICENSE/lib/*）
//   2) 建远端仓（若不存在）——Gitee/GitHub 的建仓 API
//   3) 用带 token 的临时 URL push（**不执行 `git remote add`**，token 不进 .git/config）
//   4) 用不带 token 的 URL 回读 refs 验证（HEAD / main / tag 对齐）
//
// 安全约定：
//   - token 只出现在子进程参数里，不写入任何文件、不进 git 配置、不打印；
//   - 所有 git 命令的输出都会过一遍脱敏（把 token 串替换成 ***），避免误打印到日志/终端历史。
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const flag = (name) => argv.includes('--' + name)

const PLATFORM = opt('platform', 'gitee')
const OWNER = opt('owner', null)
const REPO = opt('repo', 'dsh-archive-sessions')
const TAG = opt('tag', null)
const DRY = flag('dry-run')
const TOKEN = process.env.OSS_PUSH_TOKEN ?? ''

const PLATFORMS = {
  gitee: {
    host: 'gitee.com',
    api: 'https://gitee.com/api/v5/user/repos',
    lsRemote: (owner, repo) => `https://gitee.com/${owner}/${repo}.git`,
    remoteUrl: (owner, repo, token) => `https://${owner}:${token}@gitee.com/${owner}/${repo}.git`,
    createBody: (repo) => ({ name: repo, private: false, auto_init: false, description: 'DSH web plugin: browse/preview/restore/delete physically archived sessions (zero deps)' }),
    authHeader: (token) => ({ authorization: `token ${token}` }),
  },
  github: {
    host: 'github.com',
    api: 'https://api.github.com/user/repos',
    lsRemote: (owner, repo) => `https://github.com/${owner}/${repo}.git`,
    remoteUrl: (owner, repo, token) => `https://${token}@github.com/${owner}/${repo}.git`,
    createBody: (repo) => ({ name: repo, private: false, auto_init: false, description: 'DSH web plugin: browse/preview/restore/delete physically archived sessions (zero deps)' }),
    authHeader: (token) => ({ authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'dsh-archive-sessions-push' }),
  },
}

const mask = (text) => {
  let out = String(text)
  if (TOKEN.length >= 8) out = out.split(TOKEN).join('***')
  return out.replace(/(https?:\/\/[^:@\s]+):[^@\s]+@/g, '$1:***@')
}
const git = (args, options = {}) => {
  const res = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', ...options })
  return { status: res.status, stdout: mask(res.stdout ?? ''), stderr: mask(res.stderr ?? '') }
}
const say = (msg) => console.log(mask(msg))

/**
 * 确保 Gitee 仓是公开的（可单测的纯函数，不依赖脚本其它状态）。
 *
 * ⚠️ 坑（2026-09-11 实测）：Gitee 建仓即便请求体里写了 `private: false`，建出来的仓**仍然是私有**——
 *    症状是"以为发了公开仓，其实只有自己能看"：匿名 API 一律 `404 Not Found Project`，
 *    而带 token 的 API 正常、`git ls-remote` 匿名也能过（所以光看 ls-remote 会误判成功）。
 *    必须在建仓后**再显式 PATCH 一次**；且该 PATCH **必须带 `name` 字段**，
 *    否则报 `{"messages":["name is missing"]}`。
 *
 * @returns {Promise<{ok: boolean, status: number, private?: boolean, detail?: string}>}
 */
export async function ensureGiteePublic({ owner, repo, token, fetchImpl = fetch }) {
  try {
    const res = await fetchImpl(`https://gitee.com/api/v5/repos/${owner}/${repo}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ access_token: token, name: repo, private: 'false' }),
    })
    const body = await res.json().catch(() => ({}))
    const isPublic = body !== null && typeof body === 'object' && body.private === false
    return { ok: res.status === 200 && isPublic, status: res.status, private: body?.private, detail: isPublic ? undefined : JSON.stringify(body).slice(0, 200) }
  } catch (err) {
    return { ok: false, status: 0, detail: err instanceof Error ? err.message : String(err) }
  }
}

// ── 主流程（仅在直接执行本文件时运行；被 import 时只导出上面的纯函数） ───────
//   注意：判断主入口必须 realpath 双方再比 —— 经 junction/symlink 调用时
//   import.meta.url 是物理路径、process.argv[1] 是逻辑路径，直接比字符串会永远不相等，
//   表现为「脚本静默退出、什么都不做」。
function isMainEntry() {
  if (typeof process.argv[1] !== 'string') return false
  const selfPath = fileURLToPath(import.meta.url)
  const canon = (p) => {
    try {
      return realpathSync.native(p).toLowerCase()
    } catch {
      return p.toLowerCase()
    }
  }
  return canon(selfPath) === canon(process.argv[1])
}

if (!isMainEntry()) {
  // 被当作库导入：不执行任何副作用
} else {

// ── 1. 前置自检 ────────────────────────────────────────────────────────────
say('=== 推送前置自检 ===')
if (!existsSync(join(ROOT, '.git'))) {
  console.error('不是 git 仓库：' + ROOT)
  process.exit(2)
}
if (PLATFORMS[PLATFORM] === undefined) {
  console.error('未知平台：' + PLATFORM + '（支持 gitee / github）')
  process.exit(2)
}
if (OWNER === null) {
  console.error('缺少 --owner（远端账号名）')
  process.exit(2)
}
for (const file of ['README.md', 'LICENSE', 'lib/index.js', 'lib/client.js', 'lib/config.js', 'package.json']) {
  if (!existsSync(join(ROOT, file))) {
    console.error('缺少文件：' + file)
    process.exit(2)
  }
}
const status = git(['status', '--porcelain'])
if (status.stdout.trim().length > 0) {
  console.error('工作区不干净，先提交：\n' + status.stdout)
  process.exit(2)
}
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim()
say('  分支      : ' + branch)
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const versionTag = TAG ?? 'v' + pkg.version
say('  包版本    : ' + pkg.version + ' → tag ' + versionTag)
say('  平台/账号 : ' + PLATFORM + ' / ' + OWNER + '/' + REPO)

// tag 是否存在（本地）；没有就建（轻量 tag）
const hasTag = git(['tag', '--list', versionTag]).stdout.trim() === versionTag
if (!hasTag && !DRY) {
  const created = git(['tag', versionTag])
  if (created.status !== 0) {
    console.error('建 tag 失败：' + created.stderr)
    process.exit(1)
  }
  say('  已建 tag  : ' + versionTag)
}

if (DRY) {
  say('\n[dry-run] 将执行：')
  say('  1) 确保远端仓 ' + OWNER + '/' + REPO + ' 存在（不存在则调 ' + PLATFORMS[PLATFORM].api + ' 创建）')
  say('  2) git push <临时带 token URL> ' + branch + ' --tags')
  say('  3) git ls-remote ' + PLATFORMS[PLATFORM].lsRemote(OWNER, REPO) + ' 验证 refs')
  process.exit(0)
}

if (TOKEN.length < 8) {
  console.error('\n缺少环境变量 OSS_PUSH_TOKEN（或长度异常）。')
  console.error('用法：$env:OSS_PUSH_TOKEN=\'<token>\'; node scripts/push-publish.mjs --platform ' + PLATFORM + ' --owner ' + OWNER)
  process.exit(2)
}
say('  token     : 已从环境变量读取（' + TOKEN.length + ' 字符，不落盘、不打印）')

// ── 2. 确保远端仓存在 ──────────────────────────────────────────────────────
const conf = PLATFORMS[PLATFORM]
const remoteCheck = spawnSync('git', ['ls-remote', conf.lsRemote(OWNER, REPO), 'HEAD'], { encoding: 'utf8' })
const exists = remoteCheck.status === 0
say('\n=== 远端仓检查 ===')
if (exists) {
  say('  远端仓已存在（ls-remote 可读）')
} else {
  say('  远端仓不可读 → 尝试通过 API 创建（已存在会返回 4xx，属正常）')
  try {
    const res = await fetch(conf.api, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...conf.authHeader(TOKEN) },
      body: JSON.stringify(conf.createBody(REPO)),
    })
    const text = await res.text()
    say('  create -> HTTP ' + res.status + (res.status >= 400 ? '（若非「已存在」请检查 token 权限）' : ''))
    if (res.status >= 400) say('  响应片段：' + text.slice(0, 200))
  } catch (err) {
    say('  create 请求失败：' + err.message + '（若仓库已存在可忽略）')
  }
}

// 可见性：Gitee 建仓默认私有（见 ensureGiteePublic 注释），**无论仓是否已存在都确保一次**——
// 这样已存在的私有仓也会被纠正，脚本可重入。
if (PLATFORM === 'gitee') {
  const visibility = await ensureGiteePublic({ owner: OWNER, repo: REPO, token: TOKEN })
  say('  设为公开 -> ' + (visibility.ok
    ? 'OK（HTTP ' + visibility.status + '，private=false 已确认）'
    : 'HTTP ' + visibility.status + '：' + (visibility.detail ?? '未确认') + ' → 请到 Gitee 仓库设置里手工把可见性改为「公开」'))
}

// ── 3. 推送（临时 URL，不写 remote） ──────────────────────────────────────
say('\n=== 推送 ===')
const pushUrl = conf.remoteUrl(OWNER, REPO, TOKEN)
const push = git(['push', pushUrl, branch + ':refs/heads/main', '--tags'], { timeout: 300000 })
if (push.status !== 0) {
  say('  首次推送失败，重试一次（网络抖动/首次建仓握手常见）')
  const retry = git(['push', pushUrl, branch + ':refs/heads/main', '--tags'], { timeout: 300000 })
  if (retry.status !== 0) {
    console.error('推送失败：\n' + retry.stderr)
    console.error('\n排查：① token 是否有 repo 写权限 ② 账号名对不对 ③ 网络（GitHub 需要代理时先起 Clash）')
    process.exit(1)
  }
  say(retry.stderr.trim() || '  push ok')
} else {
  say(push.stderr.trim() || '  push ok')
}

// ── 4. 回读验证 ────────────────────────────────────────────────────────────
say('\n=== 回读验证（不带 token） ===')
const verify = spawnSync('git', ['ls-remote', conf.lsRemote(OWNER, REPO)], { encoding: 'utf8', timeout: 60000 })
if (verify.status !== 0) {
  console.error('回读失败：' + mask(verify.stderr ?? ''))
  process.exit(1)
}
const refs = String(verify.stdout).split('\n').filter(Boolean)
const hasMain = refs.some((line) => line.endsWith('refs/heads/main'))
const hasVersionTag = refs.some((line) => line.endsWith('refs/tags/' + versionTag))
say('  refs 总数 : ' + refs.length)
say('  main      : ' + (hasMain ? 'OK' : '缺失'))
say('  ' + versionTag + ' : ' + (hasVersionTag ? 'OK' : '缺失'))
for (const line of refs.slice(0, 6)) say('    ' + line)

const localHead = git(['rev-parse', 'HEAD']).stdout.trim()
const remoteHead = refs.find((line) => line.endsWith('refs/heads/main'))?.split('\t')[0] ?? ''
say('  本地 HEAD : ' + localHead)
say('  远端 main : ' + remoteHead)
const same = localHead === remoteHead
say('  一致性    : ' + (same ? 'OK（本地与远端 main 相同）' : '不一致，请检查'))
say('\n[完成] 远端地址：' + conf.lsRemote(OWNER, REPO).replace(/\.git$/, ''))
say('[提醒] 本仓 git remote 没有被改写（token 未落盘）；需要配置无 token 的 origin 可用：')
say('       git remote add origin ' + conf.lsRemote(OWNER, REPO))
process.exit(same && hasMain && hasVersionTag ? 0 : 1)

} // end of isMainEntry() guard
