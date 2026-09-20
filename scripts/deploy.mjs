// dsh-archive-sessions 部署脚本（幂等）
//
// 用法：
//   node scripts/deploy.mjs                          # 装进当前 DSH_HOME（默认 ~/.dsh）
//   DSH_HOME=/path/.dsh node scripts/deploy.mjs      # 装进指定 DSH_HOME（隔离测试环境用这个）
//   node scripts/deploy.mjs --profile web --dsh-home <path> --dry-run
//
// 做的事：
//   1) 备份 profile 现有插件目录 + package.json / .package-map.json / cordis.patch.yml
//   2) 复制 lib/ + package.json 到 <profile>/node_modules/dsh-archive-sessions/
//   3) .package-map.json 加映射（已存在则跳过）
//   4) cordis.patch.yml 追加 insert（已存在则跳过）
//   5) 校验：JSON 合法 + insert id 不重复 + 源文件语法通过
//   6) 在备份目录写一份 restore.mjs + restore.cmd（一键回滚，ASCII 内容）
//
// 它**不会**：改 dsh.profile.bundles、装依赖、跑包管理器、重启 DSH。
//
// ⚠️ 部署源 = 本仓 `lib/`（本仓发行版），**不是**任何 staging / 暂存目录。
//    本仓与「生产自建的归档插件」可能是**两条演进线**（版本号、文件集都可能不同，
//    例如本仓有 `lib/config.js` 而生产线有 `lib/host-adapter.js`）。
//    若目标是**生产环境**，请用生产侧自带的那份部署脚本（与生产源码同目录、自包含 + sha256 自校验），
//    不要用本脚本覆盖生产实体——本脚本装的是本仓这一份代码。
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync, copyFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const PKG_NAME = 'dsh-archive-sessions'
const PLUGIN_ID = 'dsh-archive-sessions'

// ── 参数 ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (name) => argv.includes('--' + name)
const value = (name, fallback) => {
  const index = argv.indexOf('--' + name)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

const DRY_RUN = flag('dry-run')
const PROFILE_NAME = value('profile', 'web')
const DSH_HOME = resolve(value('dsh-home', process.env.DSH_HOME ?? join(homedir(), '.dsh')))

const PROFILE = join(DSH_HOME, 'profiles', PROFILE_NAME)
const TARGET = join(PROFILE, 'node_modules', PKG_NAME)
const PKG_MAP = join(PROFILE, 'node_modules', '.package-map.json')
const PATCH = join(PROFILE, 'cordis.patch.yml')
const PROFILE_PKG = join(PROFILE, 'package.json')

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const BACKUP = join(DSH_HOME, '_archive', `dsh-archive-sessions-deploy-${stamp}`)

const log = (msg) => console.log(msg)
const ensureDir = (dir) => {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

// ── 0. 前置检查 ────────────────────────────────────────────────────────────
if (!existsSync(PROFILE)) {
  console.error(`[中止] 找不到 profile 目录：${PROFILE}`)
  console.error('       用 --dsh-home <path> / --profile <name> 指定，或先启动一次 DSH 让它生成 profile。')
  process.exit(2)
}
for (const file of ['lib/index.js', 'lib/client.js', 'lib/config.js', 'package.json']) {
  if (!existsSync(join(REPO, file))) {
    console.error(`[中止] 仓库缺文件：${file}`)
    process.exit(2)
  }
}

// 静态守卫：安装前的源文件必须能通过 node --check（避免把语法错误装进 profile）
for (const file of ['lib/index.js', 'lib/client.js', 'lib/config.js']) {
  const res = spawnSync(process.execPath, ['--check', join(REPO, file)], { encoding: 'utf8' })
  if (res.status !== 0) {
    console.error(`[中止] 语法检查失败 ${file}：${(res.stderr || '').split('\n')[0]}`)
    process.exit(2)
  }
}
log(`[目标] DSH_HOME = ${DSH_HOME}`)
log(`[目标] profile  = ${PROFILE}`)
log(`[目标] 插件目录 = ${TARGET}`)
log(`[备份] ${BACKUP}`)
if (DRY_RUN) log('[模式] dry-run：只打印将要做的改动，不写任何文件')

// ── 1. 备份 ────────────────────────────────────────────────────────────────
if (!DRY_RUN) {
  ensureDir(BACKUP)
  for (const [label, file] of [['profile-package.json', PROFILE_PKG], ['.package-map.json', PKG_MAP], ['cordis.patch.yml', PATCH]]) {
    if (existsSync(file)) {
      copyFileSync(file, join(BACKUP, label))
      log(`[备份] ${label} -> ${BACKUP}`)
    }
  }
  if (existsSync(TARGET)) {
    cpSync(TARGET, join(BACKUP, 'node_modules-' + PKG_NAME), { recursive: true })
    log(`[备份] 既有插件实体 -> ${join(BACKUP, 'node_modules-' + PKG_NAME)}`)
  }
}

// ── 2. 复制实体 ────────────────────────────────────────────────────────────
const FILES = [
  ['lib/index.js', join('lib', 'index.js')],
  ['lib/client.js', join('lib', 'client.js')],
  ['lib/config.js', join('lib', 'config.js')],
  ['package.json', 'package.json'],
  ['README.md', 'README.md'],
  ['LICENSE', 'LICENSE'],
  ['cordis.patch.yml.example', 'cordis.patch.yml.example'],
]
if (!DRY_RUN) {
  ensureDir(join(TARGET, 'lib'))
  for (const [from, to] of FILES) {
    const src = join(REPO, from)
    if (!existsSync(src)) continue
    copyFileSync(src, join(TARGET, to))
    log(`[复制] ${from} -> ${to} (${statSync(join(TARGET, to)).size} B)`)
  }
}

// ── 3. package-map ────────────────────────────────────────────────────────
function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}
let mapChanged = false
if (!DRY_RUN) {
  let map
  if (existsSync(PKG_MAP)) {
    map = readJson(PKG_MAP)
  } else {
    map = { packages: {} }
    log('[package-map] 原文件不存在，新建')
  }
  map.packages = map.packages ?? {}
  if (map.packages[PKG_NAME] === undefined) {
    map.packages[PKG_NAME] = { url: './' + PKG_NAME, dependencies: {} }
    mapChanged = true
    writeFileSync(PKG_MAP, JSON.stringify(map, null, 2) + '\n', 'utf8')
    log('[package-map] 已添加 ' + PKG_NAME)
  } else {
    log('[package-map] 已存在，跳过')
  }
} else {
  log('[package-map] (dry-run) 将确保存在映射 ' + PKG_NAME)
}

// ── 4. cordis.patch.yml insert ────────────────────────────────────────────
const INSERT_BLOCK = [
  '',
  `# ${PKG_NAME}：设置页「归档会话管理」分栏 —— 查看/预览/恢复/删除物理归档的会话。`,
  '# host 半只依赖 webServer（HTTP 路由）；client 半注册 settings.section。',
  '# 注意：它是 client 插件，**不能**放进 profile package.json 的 dsh.profile.bundles',
  '#（会崩 declares no dsh.bundle），一律走 patch insert。',
  '- insert:',
  `    - id: ${PLUGIN_ID}`,
  `      name: '${PKG_NAME}'`,
  '',
].join('\n')

let patchChanged = false
if (!DRY_RUN) {
  if (existsSync(PATCH)) {
    const text = readFileSync(PATCH, 'utf8')
    if (new RegExp(`id:\\s*${PLUGIN_ID}\\b`).test(text)) {
      log('[cordis.patch] 已存在 insert，跳过')
    } else {
      writeFileSync(PATCH, text.replace(/\s*$/, '\n') + INSERT_BLOCK, 'utf8')
      patchChanged = true
      log('[cordis.patch] 已追加 insert ' + PLUGIN_ID)
    }
  } else {
    writeFileSync(PATCH, '# Your patch layer for this dsh profile, applied after every bundle layer.\n' + INSERT_BLOCK, 'utf8')
    patchChanged = true
    log('[cordis.patch] 原文件不存在，新建并写入 insert')
  }
} else {
  log('[cordis.patch] (dry-run) 将确保存在 insert ' + PLUGIN_ID)
}

// ── 5. 校验 ───────────────────────────────────────────────────────────────
const problems = []
if (!DRY_RUN) {
  try {
    readJson(PKG_MAP)
    log('[校验] .package-map.json JSON 合法')
  } catch (err) {
    problems.push('.package-map.json 不是合法 JSON：' + err.message)
  }
  try {
    readJson(PROFILE_PKG)
    log('[校验] profile package.json JSON 合法')
  } catch (err) {
    problems.push('profile package.json 不是合法 JSON：' + err.message)
  }
  // YAML：优先用 profile 里自带的 js-yaml；没有就退回轻量检查
  let yaml = null
  try {
    const { createRequire } = await import('node:module')
    const req = createRequire(join(PROFILE, 'package.json'))
    yaml = req('js-yaml')
  } catch {
    yaml = null
  }
  const patchText = readFileSync(PATCH, 'utf8')
  if (yaml !== null) {
    try {
      const parsed = yaml.load(patchText)
      const entries = Array.isArray(parsed) ? parsed : []
      const ids = entries.flatMap((entry) => (entry && entry.insert ? entry.insert : [])).map((item) => item && item.id).filter(Boolean)
      const dup = ids.filter((id, index) => ids.indexOf(id) !== index)
      log(`[校验] cordis.patch.yml 解析 OK，insert id 共 ${ids.length} 个；重复 id：${dup.length ? dup.join(',') : '无'}`)
      if (dup.length > 0) problems.push('cordis.patch.yml 存在重复 insert id：' + dup.join(','))
      if (!ids.includes(PLUGIN_ID)) problems.push('cordis.patch.yml 未找到 ' + PLUGIN_ID + ' insert')
    } catch (err) {
      problems.push('cordis.patch.yml 解析失败：' + err.message)
    }
  } else {
    log('[校验] 未能加载 profile 的 js-yaml，退回轻量检查（缩进 + id 数）')
    const ids = [...patchText.matchAll(/^\s*-\s+id:\s*(\S+)/gm)].map((m) => m[1])
    const dup = ids.filter((id, index) => ids.indexOf(id) !== index)
    if (dup.length > 0) problems.push('cordis.patch.yml 存在重复 insert id：' + dup.join(','))
    if (!ids.includes(PLUGIN_ID)) problems.push('cordis.patch.yml 未找到 ' + PLUGIN_ID + ' insert')
    if (/\t/.test(patchText)) problems.push('cordis.patch.yml 含制表符（YAML 用空格缩进）')
  }
}

// ── 6. 回滚脚本 ───────────────────────────────────────────────────────────
if (!DRY_RUN) {
  const restorePath = join(BACKUP, 'restore.mjs')
  writeFileSync(restorePath, `// 由 deploy.mjs 生成的一键回滚脚本（幂等）
// 用法：node restore.mjs [--dry-run]
import { cpSync, existsSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

const BACKUP = ${JSON.stringify(BACKUP)}
const PROFILE = ${JSON.stringify(PROFILE)}
const TARGET = ${JSON.stringify(TARGET)}
const PKG_NAME = ${JSON.stringify(PKG_NAME)}
const PLUGIN_ID = ${JSON.stringify(PLUGIN_ID)}
const dryRun = process.argv.includes('--dry-run')
const log = (m) => console.log(m)

// 1) 插件实体：有备份就还原，没备份就删掉（说明是全新安装）
const entityBackup = join(BACKUP, 'node_modules-' + PKG_NAME)
if (existsSync(entityBackup)) {
  if (!dryRun) { rmSync(TARGET, { recursive: true, force: true }); cpSync(entityBackup, TARGET, { recursive: true }) }
  log('[还原] 插件实体 <- ' + entityBackup)
} else if (existsSync(TARGET)) {
  if (!dryRun) rmSync(TARGET, { recursive: true, force: true })
  log('[删除] 插件实体（部署前不存在）')
}

// 2) profile 文件：备份里有就拷回
for (const [label, target] of [
  ['profile-package.json', join(PROFILE, 'package.json')],
  ['.package-map.json', join(PROFILE, 'node_modules', '.package-map.json')],
  ['cordis.patch.yml', join(PROFILE, 'cordis.patch.yml')],
]) {
  const src = join(BACKUP, label)
  if (existsSync(src)) {
    if (!dryRun) copyFileSync(src, target)
    log('[还原] ' + label + ' -> ' + target)
  }
}
log(dryRun ? 'dry-run 结束（未改动任何文件）' : '回滚完成：重启 DSH 生效')
`, 'utf8')

  const cmdPath = join(BACKUP, 'restore.cmd')
  writeFileSync(cmdPath, [
    '@echo off',
    'REM One-click rollback for the dsh-archive-sessions deployment.',
    'REM Usage: double-click, or: node restore.mjs [--dry-run]',
    'setlocal',
    'node "%~dp0restore.mjs" %*',
    'pause',
    '',
  ].join('\r\n'), 'utf8')
  log('[回滚] 已生成 ' + restorePath)
  log('[回滚] 已生成 ' + cmdPath)
}

// ── 结果 ──────────────────────────────────────────────────────────────────
console.log('')
if (problems.length > 0) {
  console.error('[失败] ' + problems.join('；'))
  process.exit(1)
}
if (DRY_RUN) {
  log('[完成] dry-run（未写任何文件）。去掉 --dry-run 才会真正部署。')
} else {
  log('[完成] 已部署到 ' + TARGET)
  log('[完成] 备份目录：' + BACKUP)
  log('[完成] 部署后必须：① 重启 DSH ② 浏览器硬刷新（Ctrl+Shift+R）')
  log('[完成] 验证：curl http://localhost:<port>' + '/api/dsh-archive-sessions/list')
}
