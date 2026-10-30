// 新夹具（并发 / 可重入 / 重复副本）共用的小工具：
//   - 临时 DSH home + **三件套 env 隔离**（USERPROFILE + HOME + DSH_HOME，缺一个就会"写沙箱、读生产"）
//   - 造假会话（多帧 zstd 日志 + 附加文件 + 旧 mtime）
//   - 断言计数与收尾清理
//
// ⚠️ 隔离顺序：必须先 createWorkspace()（设好 env + 配置文件）再 loadLib()，
//    被测模块在 import 那一刻就把配置快照读进内存了。
import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

/** 造出来的会话一律「3 小时未活跃」，配上夹具里 hours=1 就能成为候选。 */
export const OLD_MS = Date.now() - 3 * 3600 * 1000

export function createCounter() {
  let pass = 0
  let fail = 0
  return {
    check(name, ok, detail = '') {
      if (ok) pass += 1
      else fail += 1
      console.log((ok ? '[OK]  ' : '[FAIL]') + ' ' + name + (detail === '' ? '' : ' :: ' + detail))
    },
    section(title) {
      console.log('\n── ' + title + ' ' + '─'.repeat(Math.max(0, 60 - title.length)))
    },
    report(title) {
      console.log('\n' + '═'.repeat(66))
      console.log(fail === 0
        ? title + ' PASSED (' + pass + ' checks)'
        : title + ' FAILED (' + fail + ' failed / ' + pass + ' passed)')
      return fail === 0 ? 0 : 1
    },
  }
}

/** 建临时工作区（home / sessions / archive）并把三件套 env 指向它。 */
export function createWorkspace(label) {
  const work = mkdtempSync(join(tmpdir(), 'as-' + label + '-'))
  const home = join(work, 'home')
  const sessionsRoot = join(home, 'sessions')
  const archiveRoot = join(home, '_archived-sessions')
  const projectDir = join(sessionsRoot, '--proj--')
  const configPath = join(work, 'archive-sessions.config.json')
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(configPath, JSON.stringify({
    paths: { home },
    auto: {
      enabled: false, dryRun: false, hours: 1, minSizeMb: 0, maxPerRun: 500,
      startDelayMs: 600000, tickMs: 600000,
    },
  }, null, 2), 'utf8')

  // 三件套：os.homedir() 在 win32 只认 USERPROFILE；DSH_HOME 是另一条腿 —— 少设一个就会分叉
  process.env.DSH_HOME = home
  process.env.USERPROFILE = home
  process.env.HOME = home
  process.env.ARCHIVE_SESSIONS_CONFIG = configPath
  process.env.DSH_SESSIONS_DIR = sessionsRoot

  return { work, home, sessionsRoot, archiveRoot, projectDir, configPath }
}

/** 被测 host 半：默认本仓 lib/index.js；ARCHIVE_TEST_LIB 可指到另一份（变异证红用）。 */
export async function loadLib() {
  const override = process.env.ARCHIVE_TEST_LIB
  const target = override && override.length > 0
    ? pathToFileURL(override).href
    : new URL('../lib/index.js', import.meta.url).href
  return import(target)
}

const logFrames = (id, cwd, extraText) => {
  const events = [
    { type: 'session', id, createdAt: OLD_MS, cwd },
    { type: 'user/message', time: OLD_MS + 1, data: { content: [{ type: 'text', text: 'fixture question for ' + id }] } },
  ]
  if (extraText) {
    events.push({ type: 'user/message', time: OLD_MS + 2, data: { content: [{ type: 'text', text: extraText }] } })
  }
  events.push({ type: 'assistant/message', time: OLD_MS + 3, data: { message: { content: [{ type: 'text', text: 'fixture answer' }] } } })
  return Buffer.concat(events.map((ev) => zstdCompressSync(Buffer.from(JSON.stringify(ev) + '\n', 'utf8'))))
}

/**
 * 造一个会话目录：`session.jsonl.zstd`（多帧 zstd，尾部用压不动的字节撑到 bytes）+ 可选附加文件。
 * 返回 { id, dir, logPath, logBytes, files: [{rel, size}] }
 */
export function writeSession(projectDir, id, options = {}) {
  const bytes = Number(options.bytes ?? 0)
  const extraFiles = options.extraFiles ?? {}
  const dir = join(projectDir, id)
  mkdirSync(dir, { recursive: true })
  const head = logFrames(id, options.cwd ?? join(projectDir, '..', 'proj'), options.extraText)
  const padding = bytes > head.length ? randomBytes(bytes - head.length) : Buffer.alloc(0)
  const body = Buffer.concat([head, padding])
  const logPath = join(dir, 'session.jsonl.zstd')
  writeFileSync(logPath, body)
  utimesSync(logPath, OLD_MS / 1000, OLD_MS / 1000)

  const files = [{ rel: 'session.jsonl.zstd', size: body.length }]
  for (const [rel, content] of Object.entries(extraFiles)) {
    const full = join(dir, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
    utimesSync(full, OLD_MS / 1000, OLD_MS / 1000)
    files.push({ rel, size: Buffer.byteLength(content) })
  }
  return { id, dir, logPath, logBytes: body.length, files }
}

export function sha256Of(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

/** 递归列出某个目录下所有「名字等于 name」的目录绝对路径。 */
export function findDirsNamed(root, name) {
  const out = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const full = join(dir, entry.name)
      if (entry.name === name) out.push(full)
      walk(full)
    }
  }
  walk(root)
  return out
}

/** 归档根下的批次目录（跳过 `.auto-archive.json` 之类的文件与 `.` 开头的隐藏目录）。 */
export function listBatchDirs(archiveRoot) {
  try {
    return readdirSync(archiveRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

export function autoStatePath(archiveRoot) {
  return join(archiveRoot, '.auto-archive.json')
}

export function readAutoStateFile(archiveRoot) {
  const file = autoStatePath(archiveRoot)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 把「上次跑到一半的批次」写进状态文件 —— 下一轮应当接着搬这个批次目录。 */
export function writePendingBatch(archiveRoot, batch, hours) {
  mkdirSync(archiveRoot, { recursive: true })
  writeFileSync(autoStatePath(archiveRoot), JSON.stringify({
    config: { enabled: false, dryRun: false, hours: hours ?? 1, minSizeMb: 0, maxPerRun: 500 },
    state: { lastRunAt: null, lastResult: null, totalArchived: 0, pendingBatch: { batch, createdAt: Date.now() } },
  }, null, 2), 'utf8')
}

export function cleanup(work) {
  rmSync(work, { recursive: true, force: true })
}

/** 文件是否还在、mtime 是多少（用来证明"没有重搬"）。 */
export function fileProbe(filePath) {
  if (!existsSync(filePath)) return null
  const st = statSync(filePath)
  return { size: st.size, mtimeMs: st.mtimeMs, sha256: sha256Of(filePath) }
}

export const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
