// 开源版源码静态验证：语法 + 配置层行为 + 硬编码扫描
// 用法：node <此文件> <repoRoot>
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const root = process.argv[2] ?? process.cwd()
let fail = 0
const check = (name, ok, detail = '') => {
  console.log((ok ? '[OK]  ' : '[FAIL]') + ' ' + name + (detail ? ' :: ' + detail : ''))
  if (!ok) fail += 1
}

// 1) node --check 每个 .js / .mjs
const files = []
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry.startsWith('.tmp-')) continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walk(full)
    else if (['.js', '.mjs', '.cjs'].includes(extname(entry))) files.push(full)
  }
}
walk(root)
for (const file of files) {
  const rel = file.slice(root.length + 1)
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  check('syntax ' + rel, res.status === 0, (res.stderr || '').split('\n')[0] ?? '')
}

// 2) client.js：剥离 window.__ModuleLoader__ 壳后用 new Function 解析（浏览器端代码）
const clientPath = join(root, 'lib', 'client.js')
const clientSrc = readFileSync(clientPath, 'utf8')
try {
  const wrapped = clientSrc.replace(/^window\.__ModuleLoader__\.load\(/m, 'LOAD(')
  // eslint-disable-next-line no-new-func
  new Function('LOAD', 'return ' + wrapped)
  check('client.js factory parses as browser bundle', true)
} catch (err) {
  check('client.js factory parses as browser bundle', false, err.message)
}

// 3) 配置层：默认值 + 环境变量覆盖 + 相对路径解析
//    全部用系统临时目录，绝不往仓库里写测试残留
const cfgMod = await import(pathToFileURL(join(root, 'lib', 'config.js')).href)
const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const sandbox = mkdtempSync(join(tmpdir(), 'as-verify-'))
const defaults = cfgMod.DEFAULT_CONFIG
check('default archive dir name', defaults.paths.archiveRoot === null)
check('default api prefix', defaults.server.apiPrefix === '/api/dsh-archive-sessions')
check('default preview messages', defaults.preview.maxMessages === 50)
check('default auto disabled + dryRun', defaults.auto.enabled === false && defaults.auto.dryRun === true)

const sandboxHome = join(sandbox, 'home')
process.env.DSH_HOME = sandboxHome
const loaded = cfgMod.loadConfig({ cache: false })
check('DSH_HOME respected', loaded.config.paths.home === sandboxHome)
check('archiveRoot derived from DSH_HOME', loaded.config.paths.archiveRoot === null)
check('no config file -> source null', loaded.source === null)
check('no sanitize errors on defaults', loaded.errors.length === 0, JSON.stringify(loaded.errors))

// 相对路径按 DSH home 解析
process.env.ARCHIVE_SESSIONS_CONFIG = join(sandboxHome, 'cfg.json')
const cfgPath = process.env.ARCHIVE_SESSIONS_CONFIG
mkdirSync(sandboxHome, { recursive: true })
writeFileSync(cfgPath, JSON.stringify({
  language: 'en',
  paths: { archiveRoot: 'my-archive', sessionsRoot: 'my-sessions' },
  preview: { maxMessages: 5 },
  auto: { hours: 12, enabled: true },
  server: { apiPrefix: 'api/custom-prefix/' },
  ui: { nav: 'Custom Nav' },
  bogusKey: 'x',
}), 'utf8')
const loaded2 = cfgMod.loadConfig({ cache: false })
check('relative archiveRoot resolved under home', loaded2.config.paths.archiveRoot === join(sandboxHome, 'my-archive'), loaded2.config.paths.archiveRoot)
check('relative sessionsRoot resolved under home', loaded2.config.paths.sessionsRoot === join(sandboxHome, 'my-sessions'))
check('override maxMessages', loaded2.config.preview.maxMessages === 5)
check('override auto.hours', loaded2.config.auto.hours === 12)
check('apiPrefix normalized', loaded2.config.server.apiPrefix === '/api/custom-prefix', loaded2.config.server.apiPrefix)
check('ui override merged', cfgMod.resolveUi(loaded2.config).nav === 'Custom Nav')
check('en language ui present', cfgMod.resolveUi(loaded2.config).refresh === 'Refresh')
const pub = cfgMod.publicConfig(loaded2.config)
// 公开配置必须只含界面需要的东西：不能带 home / 归档目录 / sessions 目录等绝对路径
const pubText = JSON.stringify(pub)
check('publicConfig hides absolute paths', !pubText.includes(sandboxHome) && !/[A-Ha-h]:[\\/]/.test(pubText), pubText.slice(0, 120))
check('publicConfig has no paths section', pub.paths === undefined)
check('unknown key tolerated', loaded2.errors.length === 0, JSON.stringify(loaded2.errors))

// 坏值应被清洗并记错误
writeFileSync(cfgPath, JSON.stringify({ preview: { maxMessages: 'abc' }, auto: { hours: -5 }, server: { apiPrefix: 123 } }), 'utf8')
const loaded3 = cfgMod.loadConfig({ cache: false })
check('invalid values reported', loaded3.errors.length >= 2, JSON.stringify(loaded3.errors))
check('invalid value fell back to default', loaded3.config.preview.maxMessages === defaults.preview.maxMessages)
check('negative hours clamped', loaded3.config.auto.hours >= 1)

// 4) 敏感词扫描
//    **本文件不写任何真实机器名 / 用户名 / 本机专属路径或目录名**（否则等于把要藏的东西写进要发布的仓）。
//    口径：规则表 = 「通用形态规则（永久）」+「本机标识规则（环境变量注入）」。
//      · 通用形态：任何 `…/Users/<名>` 式用户目录、任何盘符绝对路径、通用同步产品名、凭证形态。
//      · 本机标识：机器名 / 用户名 / 本机专属目录名（工作区、同步根、测试根）—— 由发布环境注入；
//        未注入时通用形态仍然生效（用户目录与绝对路径这类形态**无需注入即可检出**）。
//        注入方式（逗号或分号分隔，大小写不敏感）：
//          BUILD_MACHINE_NAMES   例：<本机主机名1>,<本机主机名2>
//          BUILD_USER_NAMES      例：<本机用户名1>,<本机用户名2>
//          BUILD_LAYOUT_ROOTS    例：<本机工作区目录名>,<本机同步根目录名>,<本机测试根目录名>
//          BUILD_SYNC_PRODUCTS   例：<本机在用同步产品目录名>
//        未注入时会在扫描段打印一行提示（提示不影响退出码）。
//    扫描范围：lib/ 与文档/配置（scripts/ 里是测试与部署工具，自身含检测规则，跳过）。
const envList = (name) => (process.env[name] ?? '')
  .split(/[,;]/)
  .map((s) => s.trim())
  .filter((s) => s.length >= 2)
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const EXTRA_MACHINES = envList('BUILD_MACHINE_NAMES')
const EXTRA_USERS = envList('BUILD_USER_NAMES')
const EXTRA_ROOTS = envList('BUILD_LAYOUT_ROOTS')
const EXTRA_SYNC = envList('BUILD_SYNC_PRODUCTS')

// 通用形态规则：与具体机器无关，永远生效
const PATTERNS = [
  [/[\\/]Users[\\/](?!<|\$\{|%|<user>)[A-Za-z0-9._-]{2,}/, 'user profile dir'],
  // 盘符前必须是「行首或非字母数字」——否则 `http://` 这类 URL scheme 会被当成盘符误报
  [/(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/](?!<|\$\{|%|<path>)[^\s'"`<>|?*]{2,}/, 'absolute windows path'],
  [/坚果云|百度网盘|Nutstore/i, 'local sync product'],
  [/\bsk-[A-Za-z0-9]{8,}/, 'api key'],
]
const GENERIC_COUNT = PATTERNS.length
// 本机标识规则：环境变量注入（未注入 = 无此规则，通用形态规则兜底）
if (EXTRA_SYNC.length) PATTERNS.unshift([new RegExp(EXTRA_SYNC.map(esc).join('|'), 'i'), 'local sync product'])
if (EXTRA_MACHINES.length) PATTERNS.unshift([new RegExp(EXTRA_MACHINES.map(esc).join('|'), 'i'), 'machine name'])
if (EXTRA_USERS.length) PATTERNS.unshift([new RegExp(EXTRA_USERS.map(esc).join('|'), 'i'), 'user name'])
if (EXTRA_ROOTS.length) PATTERNS.unshift([new RegExp(EXTRA_ROOTS.map(esc).join('|'), 'i'), 'local layout path'])
const injected = EXTRA_MACHINES.length + EXTRA_USERS.length + EXTRA_ROOTS.length + EXTRA_SYNC.length
console.log(
  '[i] sensitive rules: generic=' + GENERIC_COUNT + ' + injected=' + injected
  + '(machine=' + EXTRA_MACHINES.length + ' user=' + EXTRA_USERS.length
  + ' layout=' + EXTRA_ROOTS.length + ' sync=' + EXTRA_SYNC.length + ')'
  + (injected
    ? ''
    : '  ← 未注入 BUILD_MACHINE_NAMES / BUILD_USER_NAMES / BUILD_LAYOUT_ROOTS / BUILD_SYNC_PRODUCTS，仅通用形态规则生效')
)
const TEXT_LIKE = new Set(['.md', '.json', '.yml', '.yaml', '.txt', '.example'])
const isTextLike = (rel) => [...TEXT_LIKE].some((ext) => rel.endsWith(ext))
const isComment = (line) => /^\s{0,4}(\/\/|\/\*|\*|#|<!--)/.test(line)
let scanned = 0
for (const file of files) {
  const rel = relative(root, file).replace(/\\/g, '/')
  if (rel.startsWith('scripts/')) continue // 跳过测试/部署工具目录（自身含检测规则）
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  const patterns = isTextLike(rel) ? PATTERNS : [...PATTERNS, [/[A-H]:[\\/]/, 'absolute windows path in code']]
  for (let i = 0; i < lines.length; i++) {
    scanned += 1
    if (isComment(lines[i])) continue // 注释里允许说明性提及（含通用绝对路径示例）
    for (const [re, label] of patterns) {
      if (!re.test(lines[i])) continue
      check(`sensitive scan ${rel}:${i + 1} [${label}]`, false, lines[i].trim().slice(0, 120))
    }
  }
}
check('sensitive scan finished (' + scanned + ' lines)', true)

// 收尾：清掉沙箱，绝不在仓库里留测试残留
try {
  rmSync(sandbox, { recursive: true, force: true })
} catch { /* ignore */ }
check('sandbox cleaned up', !existsSync(sandbox))

console.log('\n' + (fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'))
process.exit(fail === 0 ? 0 : 1)
