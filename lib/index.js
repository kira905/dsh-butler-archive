/**
 * dsh-archive-sessions — host half（原生 ESM，零第三方运行时依赖）。
 *
 * 数据源 = `<DSH_HOME>/_archived-sessions` 物理目录：被物理移出 `sessions` 目录的老会话
 * （目录名保留原始形态 `session-<uuid>` 或 `<uuid>`）。
 *
 * 与主包 workspaceRegistry 的 `archivedSessionIds` 标记不同：本插件管理的是「物理移出
 * sessions」的会话。主包 workspace.json / session_projcache.json 里仍保留它们的记录，
 * 因此物理放回 +（若曾被打 archived 标记）摘除标记后，主包扫描即恢复可见。
 *
 * Routes（全部 loopback-only；前缀可配置，默认 /api/dsh-archive-sessions）:
 *   GET  {prefix}/config    — 公开配置（界面文案等，不含任何绝对路径）
 *   GET  {prefix}/list      — 列出所有归档会话（projcache 元数据，零解压）
 *   GET  {prefix}/detail    — 解码单个会话尾部 N 条消息作预览
 *   POST {prefix}/restore   — 两段式 copy→校验→删源 移回 sessions
 *   POST {prefix}/delete    — 物理删除归档会话（客户端二次确认）
 *   GET  {prefix}/auto      — 读取自动归档配置与上次运行状态
 *   POST {prefix}/auto      — 更新自动归档配置
 *   POST {prefix}/auto/run  — 立即执行一次自动归档（默认试跑）
 *
 * 所有可调参数见 lib/config.js 与 examples/archive-sessions.config.example.json。
 *
 * 设计依据：本插件是「多机交接 / 自治式运维」方法论的落地实现之一，方法论文档（脱敏公开）见
 * Gitee https://gitee.com/kira905/ops-handoff-design ｜ GitHub https://github.com/kira905/ops-handoff-design
 * 两仓互链、版本对应关系见 README §10。
 */
import { createHash } from 'node:crypto'
import {
  cpSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs'
import { promises as fsp } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { zstdDecompressSync } from 'node:zlib'
import { loadConfig, publicConfig } from './config.js'

export const name = 'dsh-archive-sessions'
/** 仅依赖 webServer（注册 HTTP 路由）；刻意不碰 workspaceRegistry/storageDomain 等敏感服务。 */
export const inject = ['webServer']

const ZSTD_MAGIC = 4247762216 // 0xFD2FB528 LE
const LOOPBACK_ADDRESSES = ['127.0.0.1', '::1', '::ffff:127.0.0.1']

// ── 配置快照 ──────────────────────────────────────────────────────────────
// 启动时载入一次并常驻内存；改配置文件后重启 DSH 生效（改完不必重启的只有 auto.* 那几项，
// 它们走 <archiveRoot>/.auto-archive.json，由 /auto 路由维护）。

let configSnapshot = loadConfig({ cache: false })

/** 重新载入配置（改过配置文件 / 测试用）。 */
export function reloadConfig() {
  configSnapshot = loadConfig({ cache: false })
  return configSnapshot
}

function currentConfig() {
  return configSnapshot
}

function get(key) {
  const config = currentConfig().config
  let value = config
  for (const part of key.split('.')) value = value?.[part]
  return value
}

function homeDir() {
  return get('paths.home')
}
function archiveRoot() {
  return get('paths.archiveRoot') ?? join(homeDir(), '_archived-sessions')
}
function sessionsRoot() {
  return get('paths.sessionsRoot') ?? join(homeDir(), 'sessions')
}
function storagesDir() {
  return get('paths.storagesDir') ?? join(homeDir(), 'storages')
}
function workspaceFile() {
  return get('paths.workspaceFile') ?? join(storagesDir(), 'workspace.json')
}
function projcacheFile() {
  return get('paths.projcacheFile') ?? join(storagesDir(), 'session_projcache.json')
}
/**
 * 会话索引的**单键**目录（主包按会话一文件写：`<storages>/session_projcache/sessions/<sid>.json`）。
 * 读一条会话的元数据只需要这一个文件，与整表无关。
 */
function projcacheSessionsDir() {
  const explicit = get('paths.projcacheSessionsDir')
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  return join(storagesDir(), 'session_projcache', 'sessions')
}
function manifestFile(batch) {
  return join(archiveRoot(), batch, String(get('archive.manifestFile') ?? 'manifest.json'))
}
function autoStateFile() {
  const explicit = get('archive.statePath')
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  return join(archiveRoot(), String(get('archive.stateFile') ?? '.auto-archive.json'))
}

// ── 通用 IO（独占锁 / 网络盘容错：短重试） ────────────────────────────────

function sleepSync(ms) {
  if (!(ms > 0)) return
  const until = Date.now() + ms
  while (Date.now() < until) { /* busy wait */ }
}

/**
 * 把事件循环让出去一次（自动归档搬运用）。
 *
 * 必须是**宏任务**（setImmediate / setTimeout）：微任务（Promise.resolve / queueMicrotask）只是把
 * 调用栈交给同一轮事件循环里排在后面的微任务，IO 回调与定时器根本轮不到 —— 那是"假异步"，
 * 长搬运照样把整个进程按住。
 */
function yieldToEventLoop() {
  return new Promise((resolve) => { setImmediate(resolve) })
}

/** 异步睡眠（异步重试的退避用）。sleepSync 会占死线程，只在同步路径里用。 */
function sleepAsync(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms > 0 ? ms : 0) })
}

/** 同步重试：网络盘 / 同步盘的独占读锁窗口短，多数情况 1 次重试即可过。 */
function withRetry(fn, tries, baseDelay) {
  const maxTries = Number.isFinite(tries) ? Math.max(1, tries) : 3
  const delay = Number.isFinite(baseDelay) ? Math.max(0, baseDelay) : 120
  let lastError
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    try {
      return fn()
    } catch (err) {
      lastError = err
      if (attempt < maxTries) sleepSync(delay * attempt)
    }
  }
  throw lastError
}

function readJsonSafe(filePath) {
  if (!existsSync(filePath)) return undefined
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return undefined
  }
}

/** 原子写 JSON（同目录 tmp + rename）。 */
function writeJsonAtomic(filePath, data) {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = filePath + '.tmp'
  withRetry(
    () => {
      writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
      renameSync(tmp, filePath)
    },
    get('archive.copyRetries'),
    get('archive.copyRetryDelayMs'),
  )
}

function isDir(p) {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * 会话索引的**单键读**：`<storages>/session_projcache/sessions/<sid>.json`，形状 `{ version, record }`。
 * 一条会话只读它自己那一个文件 —— 不再把整张 sessions 表加载进内存再按 id 筛。
 */
function readSessionRecordById(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  const raw = readJsonSafe(join(projcacheSessionsDir(), sessionId + '.json'))
  if (raw === undefined || raw === null || typeof raw !== 'object') return undefined
  const record = raw.record
  return record !== null && typeof record === 'object' ? record : raw
}

/**
 * 索引读取器：默认走单键读；只有当单键文件不存在时才退回整表（老版本数据 / 只写了整表的夹具）。
 * 整表最多读一次，且只在真的需要兜底时才读。
 */
function makeSessionRecordReader() {
  let table = null
  let tableLoaded = false
  return (sessionId) => {
    const single = readSessionRecordById(sessionId)
    if (single !== undefined) return single
    if (!tableLoaded) {
      tableLoaded = true
      table = readJsonSafe(projcacheFile())?.tables?.sessions ?? {}
    }
    return table[sessionId]
  }
}

/** 递归目录大小（字节）。 */
function dirSize(dir) {
  let total = 0
  if (!isDir(dir)) return 0
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      try {
        const st = statSync(full)
        total += st.isDirectory() ? dirSize(full) : st.size
      } catch { /* skip */ }
    }
  } catch { /* best effort */ }
  return total
}

/** 带重试的目录物理删除（句柄 / 同步锁窗口容错）。 */
function safeRemoveDir(targetDir, maxRetries) {
  if (!existsSync(targetDir)) return true
  const tries = Number.isFinite(maxRetries) ? Math.max(1, maxRetries) : (get('archive.removeRetries') ?? 4)
  const delay = get('archive.removeRetryDelayMs') ?? 180
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      rmSync(targetDir, { recursive: true, force: true, maxRetries: 4, retryDelay: delay })
      return true
    } catch (err) {
      if (attempt === tries) throw err
      sleepSync(delay * attempt)
    }
  }
  return false
}

/** 递归比较两个目录：文件集合与字节数完全一致才算相同。 */
function dirsEqual(a, b) {
  const list = (root, base) => {
    const out = []
    for (const entry of readdirSync(root)) {
      const full = join(root, entry)
      const rel = base ? base + '/' + entry : entry
      const st = statSync(full)
      if (st.isDirectory()) out.push(...list(full, rel))
      else out.push([rel, st.size])
    }
    return out
  }
  try {
    const la = list(a, '').sort((x, y) => (x[0] < y[0] ? -1 : 1))
    const lb = list(b, '').sort((x, y) => (x[0] < y[0] ? -1 : 1))
    if (la.length !== lb.length) return false
    for (let i = 0; i < la.length; i++) {
      if (la[i][0] !== lb[i][0] || la[i][1] !== lb[i][1]) return false
    }
    return true
  } catch {
    return false
  }
}

// ── zstd 解码（多帧拼接逐帧解；格式参照主包会话日志） ─────────────────────

function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break
    offset += 4
    if (offset === buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) break
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) break
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) break
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) break
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) break
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

/**
 * 从内存缓冲解码：`maxFrames` 为 0/未给 = 全解，否则只解前 N 帧。
 * 抽出来是为了让「同步读」与「异步读」两条路径共用同一套帧解析（行为必然一致）。
 */
function decodeZstdBuffer(buf, maxFrames) {
  const frames = scanZstdFrames(buf)
  if (frames.length === 0) {
    try {
      return zstdDecompressSync(buf).toString('utf8')
    } catch {
      return ''
    }
  }
  const limit = Number.isFinite(maxFrames) && maxFrames > 0 ? Math.max(1, maxFrames) : 0
  const picked = limit > 0 ? frames.slice(0, limit) : frames
  const chunks = []
  for (const { start, end } of picked) {
    try {
      chunks.push(zstdDecompressSync(buf.subarray(start, end)))
    } catch {
      // 跳过损坏帧，继续往后解
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 异步读盘 → decodeZstdBuffer：候选扫描阶段用它，读文件期间事件循环照转。 */
async function decodeZstdFileAsync(filePath, maxFrames) {
  let buf
  try {
    buf = await fsp.readFile(filePath)
  } catch {
    return ''
  }
  return decodeZstdBuffer(buf, maxFrames)
}

/** 完整解码会话日志为 UTF-8 文本（多帧拼接，逐帧 zstd 解）。 */
function decodeZstdLog(filePath) {
  if (!existsSync(filePath)) return ''
  try {
    return decodeZstdBuffer(readFileSync(filePath), 0)
  } catch {
    return ''
  }
}

/** 只解第一帧（session 头通常在第一帧里，且该帧很小）——便宜路径。 */
function decodeFirstFrame(filePath) {
  return decodeHeadFrames(filePath, 1)
}

/**
 * 解文件**头部前 N 帧**并按行拼成文本。
 *
 * 为什么不是"只解第一帧"：会话日志是 append-only 的多帧拼接，但**一帧可以只装一部分事件**，
 * 首帧并不保证含第一条 user/message（实测：一条会话头独占一帧、首条用户消息落在第二帧）。
 * 只解首帧会漏掉标题兜底信息，所以这里默认往前多解几帧（帧很小，成本可忽略）。
 */
function decodeHeadFrames(filePath, maxFrames) {
  if (!existsSync(filePath)) return ''
  try {
    const limit = Number.isFinite(maxFrames) ? Math.max(1, maxFrames) : 1
    return decodeZstdBuffer(readFileSync(filePath), limit)
  } catch {
    return ''
  }
}

/** 读取会话数据文件全文（zstd 优先，jsonl 兜底）。 */
function readTranscriptText(dataDir) {
  const zstdPath = join(dataDir, 'session.jsonl.zstd')
  const jsonlPath = join(dataDir, 'session.jsonl')
  if (existsSync(zstdPath)) return decodeZstdLog(zstdPath)
  if (existsSync(jsonlPath)) {
    try {
      return readFileSync(jsonlPath, 'utf8')
    } catch { /* fallthrough */ }
  }
  return ''
}

// ── 会话识别 / 路径编码（对齐主包 dsh-session-persistence-jsonl 的规则） ──

/** 会话 id 目录段编码：安全码元原样，其余 ~XXXX。 */
function encodeSegment(raw) {
  if (raw.length === 0) return ''
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/** cwd → sessions 下的项目目录 key（例：<盘>:\work\proj → --D-work-proj--）。 */
function projectKey(cwd) {
  if (!cwd || cwd.length === 0) return get('archive.unknownCwdKey') ?? '_no-cwd'
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return '--' + (readable.replace(/^-+/, '') || 'root').slice(0, 251) + '--'
}

/** 会话目录是否有数据文件。 */
function hasSessionData(dir) {
  return existsSync(join(dir, 'session.jsonl.zstd')) || existsSync(join(dir, 'session.jsonl'))
}

/** 全局找归档会话目录：<archiveRoot>/<batch>/<sessionId>/。 */
function findSession(sessionId) {
  const root = archiveRoot()
  if (!existsSync(root) || typeof sessionId !== 'string' || sessionId.length === 0) return null
  const encoded = sessionId !== encodeSegment(sessionId) ? encodeSegment(sessionId) : null
  try {
    for (const batch of readdirSync(root)) {
      const batchDir = join(root, batch)
      if (!isDir(batchDir)) continue
      const candidates = encoded ? [sessionId, encoded] : [sessionId]
      for (const cand of candidates) {
        const dir = join(batchDir, cand)
        if (isDir(dir) && hasSessionData(dir)) return { batch, dir }
      }
    }
  } catch { /* ignore */ }
  return null
}

/** 从会话日志解析会话头事件（session 行：cwd/createdAt）。 */
function sessionHeaderFromDir(dataDir) {
  const zstdPath = join(dataDir, 'session.jsonl.zstd')
  const jsonlPath = join(dataDir, 'session.jsonl')
  let text = ''
  if (existsSync(zstdPath)) text = decodeHeadFrames(zstdPath, get('archive.headerFrames'))
  else if (existsSync(jsonlPath)) {
    try {
      text = readFileSync(jsonlPath, 'utf8')
    } catch { /* ignore */ }
  }
  if (!text) return null
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const ev = JSON.parse(line)
      if (ev && ev.type === 'session') return ev
    } catch { /* skip bad lines */ }
  }
  return null
}

// ── list ──────────────────────────────────────────────────────────────────

/** 去掉消息尾部的运行时附加块（system-reminder / runtime context）。 */
function cleanUserText(text) {
  if (typeof text !== 'string') return ''
  const reminderIdx = text.indexOf('<system-reminder>')
  if (reminderIdx !== -1) text = text.slice(0, reminderIdx)
  const runtimeIdx = text.indexOf('Current runtime context.')
  if (runtimeIdx !== -1) text = text.slice(0, runtimeIdx)
  return text.trim()
}

/** 归档会话元数据（优先 projcache 单键记录，缺则解会话头兜底）。 */
function sessionMeta(sessionId, dir, readRecord) {
  const record = typeof readRecord === 'function' ? readRecord(sessionId) : undefined
  const meta = {
    title: null,
    cwd: null,
    createdAt: null,
    turns: 0,
    fromDisk: false,
  }
  if (record) {
    meta.title = record.rows?.title?.val ?? null
    meta.cwd = record.identity?.cwd ?? null
    meta.createdAt = record.identity?.createdAt ?? null
    meta.turns = record.rows?.sessionStats?.val?.turns ?? 0
  }
  if (!meta.title || !meta.createdAt || meta.turns === 0) {
    // 从磁盘日志兜底（解第一帧，便宜）
    try {
      const header = sessionHeaderFromDir(dir)
      const firstUser = firstUserMessageFromDir(dir)
      if (header) {
        if (!meta.cwd && header.cwd) meta.cwd = header.cwd
        if (!meta.createdAt && header.createdAt) meta.createdAt = header.createdAt
      }
      if (!meta.title && firstUser) meta.title = firstUser
      if (header || firstUser) meta.fromDisk = true
    } catch { /* ignore */ }
  }
  return meta
}

function firstUserMessageFromDir(dataDir) {
  const zstdPath = join(dataDir, 'session.jsonl.zstd')
  const jsonlPath = join(dataDir, 'session.jsonl')
  if (!existsSync(zstdPath) && !existsSync(jsonlPath)) return null
  let text = ''
  if (existsSync(zstdPath)) text = decodeHeadFrames(zstdPath, get('archive.headerFrames'))
  else if (existsSync(jsonlPath)) {
    try {
      text = readFileSync(jsonlPath, 'utf8')
    } catch { /* ignore */ }
  }
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const ev = JSON.parse(line)
      if (ev.type === 'user/message') {
        const contents = Array.isArray(ev.data?.content) ? ev.data.content : []
        for (const item of contents) {
          if (item && item.type === 'text' && typeof item.text === 'string') {
            const clean = cleanUserText(item.text)
            if (clean) return clean.slice(0, 80)
          }
        }
      }
    } catch { /* skip */ }
  }
  return null
}

function listArchives() {
  const root = archiveRoot()
  if (!existsSync(root)) return { archives: [], total: 0, totalSize: 0 }

  const readRecord = makeSessionRecordReader()
  const ws = readJsonSafe(workspaceFile())
  const archivedSet = new Set(ws?.global?.archivedSessionIds ?? [])

  const archives = []
  let totalSize = 0

  try {
    for (const batch of readdirSync(root)) {
      const batchDir = join(root, batch)
      if (!isDir(batchDir)) continue
      let entries = []
      try {
        entries = readdirSync(batchDir)
      } catch { continue }
      for (const entry of entries) {
        const dir = join(batchDir, entry)
        if (!isDir(dir)) continue // manifest.json 是文件，天然跳过
        if (!hasSessionData(dir)) continue
        const size = dirSize(dir)
        totalSize += size
        const meta = sessionMeta(entry, dir, readRecord)
        archives.push({
          sessionId: entry,
          batch,
          title: meta.title || null,
          cwd: meta.cwd || null,
          createdAt: meta.createdAt,
          turns: meta.turns || 0,
          size,
          wasArchived: archivedSet.has(entry),
          hasMeta: !meta.fromDisk,
        })
      }
    }
  } catch { /* ignore */ }

  archives.sort((a, b) => {
    const ca = a.createdAt ?? 0
    const cb = b.createdAt ?? 0
    if (ca !== cb) return cb - ca
    return a.sessionId < b.sessionId ? -1 : 1
  })

  return { archives, total: archives.length, totalSize }
}

// ── detail（预览） ─────────────────────────────────────────────────────────

function truncate(text, max) {
  if (!text) return { text: '', truncated: false }
  if (text.length <= max) return { text, truncated: false }
  return { text: text.slice(0, max) + '…', truncated: true }
}

function extractSessionDetail(dir, maxMessages) {
  const limit = Number.isFinite(maxMessages) ? Math.max(1, maxMessages) : (get('preview.maxMessages') ?? 50)
  const maxChars = get('preview.maxMessageChars') ?? 4000
  const rawText = readTranscriptText(dir)
  if (!rawText) return { messages: [], totalMessages: 0, eventTypes: {} }

  let header = null
  const messages = []
  /** 事件类型计数：空会话（日志里只有会话头）时前端用它说明日志里究竟有什么。 */
  const eventTypes = {}

  for (const line of rawText.split('\n')) {
    if (!line) continue
    try {
      const ev = JSON.parse(line)
      if (ev && typeof ev.type === 'string') eventTypes[ev.type] = (eventTypes[ev.type] ?? 0) + 1
      if (ev.type === 'session') {
        header = ev
      } else if (ev.type === 'user/message') {
        const contents = Array.isArray(ev.data?.content) ? ev.data.content : []
        for (const item of contents) {
          if (item && item.type === 'text' && typeof item.text === 'string') {
            const clean = cleanUserText(item.text)
            if (clean) {
              messages.push({ role: 'user', time: ev.time || header?.createdAt || null, content: clean })
            }
          }
        }
      } else if (ev.type === 'assistant/message') {
        const contents = Array.isArray(ev.data?.message?.content) ? ev.data.message.content : []
        const textParts = []
        for (const item of contents) {
          if (item && item.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
            textParts.push(item.text.trim())
          }
        }
        if (textParts.length > 0) {
          messages.push({ role: 'assistant', time: ev.time || null, content: textParts.join('\n\n') })
        }
      }
    } catch { /* skip bad lines */ }
  }

  const totalMessages = messages.length
  const tail = messages.slice(-limit).map((m) => {
    const cut = truncate(m.content, maxChars)
    return { role: m.role, time: m.time, content: cut.text, truncated: cut.truncated }
  })

  return {
    header: header
      ? {
          id: header.id,
          createdAt: header.createdAt ?? null,
          cwd: header.cwd ?? null,
          parentSession: header.parentSession ?? null,
          agentPreset: header.agentPreset ?? null,
          delegationDepth: header.delegationDepth ?? null,
        }
      : null,
    messages: tail,
    totalMessages,
    eventTypes,
  }
}

// ── restore ────────────────────────────────────────────────────────────────

/** 归档时写入的批次 manifest（from/to/mb/ageD）。读不到就返回 null。 */
function readManifest(batch) {
  const p = manifestFile(batch)
  if (!existsSync(p)) return null
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'))
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * 从 manifest 里移除一项（原子写回）。容错。
 * 注意：调用时机是「归档源目录已被删除之后」，因此绝不能再用 findSession 反查批次
 * （源目录已不在，反查必然返回 null，条目永远删不掉）——batch 由调用方传入。
 */
function removeManifestEntry(batch, sessionId) {
  if (!batch || !sessionId) return
  const manifest = readManifest(batch)
  if (!manifest) return
  const tail = batch.replace(/\\/g, '/') + '/' + sessionId
  const next = manifest.filter((entry) => {
    if (!entry || typeof entry.to !== 'string') return false
    const norm = entry.to.replace(/\\/g, '/')
    return !(norm.endsWith('/' + tail) || norm.endsWith('/' + sessionId))
  })
  if (next.length === manifest.length) return
  try {
    writeJsonAtomic(manifestFile(batch), next)
  } catch { /* best effort */ }
}

/**
 * 两段式恢复：copy → dirsEqual 校验 → 删源。
 * 目标 cwd 优先 projcache，其次会话头，其次 manifest.from 的项目 key，兜底 unknownCwdKey。
 */
function restoreSession(sessionId) {
  const found = findSession(sessionId)
  if (!found) return { error: 404, code: 'not-found', message: 'archived session not found' }

  // 索引单键读：只取这条会话自己的记录，不加载整张 sessions 表。
  const record = makeSessionRecordReader()(sessionId)
  let cwd = record?.identity?.cwd ?? null
  let cwdKey = null

  if (typeof cwd === 'string' && cwd.length > 0) {
    cwdKey = projectKey(cwd)
  } else {
    try {
      const header = sessionHeaderFromDir(found.dir)
      if (header && typeof header.cwd === 'string' && header.cwd.length > 0) {
        cwd = header.cwd
        cwdKey = projectKey(cwd)
      }
    } catch { /* ignore */ }
  }

  if (!cwdKey) {
    const manifest = readManifest(found.batch)
    if (manifest) {
      const tail = found.batch.replace(/\\/g, '/') + '/' + sessionId
      const entry = manifest.find((e) => {
        if (!e || typeof e.to !== 'string') return false
        const norm = e.to.replace(/\\/g, '/')
        return norm.endsWith('/' + tail) || norm.endsWith('/' + sessionId)
      })
      if (entry && typeof entry.from === 'string') {
        const match = entry.from.replace(/\\/g, '/').match(/(?:^|\/)sessions\/([^/]+)\/[^/]+$/)
        if (match) cwdKey = decodeURIComponentSafe(match[1])
      }
    }
  }
  if (!cwdKey) cwdKey = get('archive.unknownCwdKey') ?? '_no-cwd'

  const targetDir = join(sessionsRoot(), cwdKey, sessionId)
  if (existsSync(targetDir)) {
    return {
      error: 409,
      code: 'target-exists',
      message: 'a session with the same id already exists at the target path; nothing was overwritten',
      target: targetDir,
    }
  }

  try {
    mkdirSync(dirname(targetDir), { recursive: true })
    withRetry(
      () => cpSync(found.dir, targetDir, { recursive: true, errorOnExist: false }),
      get('archive.copyRetries'),
      get('archive.copyRetryDelayMs'),
    )
  } catch (err) {
    safeRemoveDir(targetDir)
    return { error: 500, code: 'copy-failed', message: 'copy failed: ' + errText(err) }
  }

  if (!dirsEqual(found.dir, targetDir)) {
    safeRemoveDir(targetDir)
    return { error: 500, code: 'verify-failed', message: 'copied data did not match; rolled back (archive source kept)' }
  }

  try {
    safeRemoveDir(found.dir)
  } catch (err) {
    return {
      error: 500,
      code: 'source-cleanup-failed',
      message: 'copy succeeded but removing the archive source failed: ' + errText(err),
      target: targetDir,
    }
  }
  removeManifestEntry(found.batch, sessionId)

  // 摘除 workspace archivedSessionIds 标记（若该会话曾被 GUI 归档）。
  // 主包运行中的内存 registry 不同步，重启一次即最终一致。
  let unarchived = false
  try {
    const ws = readJsonSafe(workspaceFile())
    if (ws?.global && Array.isArray(ws.global.archivedSessionIds) && ws.global.archivedSessionIds.includes(sessionId)) {
      ws.global.archivedSessionIds = ws.global.archivedSessionIds.filter((id) => id !== sessionId)
      writeJsonAtomic(workspaceFile(), ws)
      unarchived = true
    }
  } catch { /* best effort：归档标记残留时重启后主包自动清理幽灵 id */ }

  return { ok: true, restoredTo: targetDir, cwd, cwdKey, unarchived }
}

function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

function errText(err) {
  return err instanceof Error ? err.message : String(err)
}

// ── delete ─────────────────────────────────────────────────────────────────

function deleteSession(sessionId) {
  const found = findSession(sessionId)
  if (!found) return { error: 404, code: 'not-found', message: 'archived session not found' }
  try {
    safeRemoveDir(found.dir)
  } catch (err) {
    return { error: 500, code: 'delete-failed', message: 'delete failed: ' + errText(err) }
  }
  removeManifestEntry(found.batch, sessionId)
  return { ok: true }
}

// ── 自动归档 ──────────────────────────────────────────────────────────────
// 判据：> auto.hours 未活跃 + 尾部无未闭合 turn + 非空壳（整份日志无任何对话消息）。
// 默认 auto.enabled=false + auto.dryRun=true：显式开启才自动跑，且默认只记录不搬。

function autoDefaults() {
  return {
    enabled: get('auto.enabled') === true,
    dryRun: get('auto.dryRun') !== false,
    hours: Number(get('auto.hours')) || 48,
    intervalMs: Number(get('auto.intervalMs')) || 21600000,
    minSizeMb: Number(get('auto.minSizeMb')) || 0,
    maxPerRun: Number(get('auto.maxPerRun')) || 50,
  }
}

function readAutoState() {
  const raw = readJsonSafe(autoStateFile())
  const config = { ...autoDefaults(), ...(raw && typeof raw.config === 'object' ? raw.config : {}) }
  const state = {
    lastRunAt: null,
    lastResult: null,
    totalArchived: 0,
    ...(raw && typeof raw.state === 'object' ? raw.state : {}),
  }
  return { config, state }
}

function writeAutoState(config, state) {
  writeJsonAtomic(autoStateFile(), { config, state })
}

/** 尾部 N 帧的事件类型（判断未闭合回合用；比全解便宜）。异步读盘：扫描阶段不占事件循环。 */
async function tailEventTypes(filePath, frames = 8) {
  let buf
  try {
    buf = await fsp.readFile(filePath)
  } catch {
    return null
  }
  const all = scanZstdFrames(buf)
  if (all.length === 0) return null
  const types = []
  for (const { start, end } of all.slice(-frames)) {
    let text = ''
    try {
      text = zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        const ev = JSON.parse(line)
        if (ev && typeof ev.type === 'string') types.push(ev.type)
      } catch { /* skip bad line */ }
    }
  }
  return types
}

function hasUnclosedTurn(types) {
  if (!types || types.length === 0) return false
  const last = types[types.length - 1]
  return last === 'turn/start' || last === 'step/start'
}

/** 空壳：整份日志里没有任何对话消息。大文件必然有内容，跳过全解省成本。 */
async function isEmptyShell(filePath, sizeBytes) {
  const cap = get('auto.emptyScanMaxBytes')
  if (sizeBytes > (Number.isFinite(cap) ? cap : 65536)) return false
  const text = await decodeZstdFileAsync(filePath, 0)
  if (!text) return false
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const ev = JSON.parse(line)
      if (ev.type === 'user/message' || ev.type === 'assistant/message') return false
    } catch { /* skip bad line */ }
  }
  return true
}

/**
 * 列 sessions 下的会话目录（含数据文件路径、字节数、mtime）。
 *
 * 轻量全树扫：一次 `readdir(recursive)` 拿到整棵树的目录项（Dirent 自带类型），
 * **不再** 对每一个目录项 `stat` 一次去问「你是不是目录 / 里面有没有数据文件」；
 * 只有真正带会话数据文件的会话才做一次 stat 取大小与 mtime。
 * 老写法每个会话要约 4 次同步 stat（项目目录 / 会话目录 / 两个 existsSync），
 * 会话一多就是"一个一个问磁盘"，而且全程同步。
 */
async function listSessionDirs() {
  const root = sessionsRoot()
  let entries
  try {
    entries = await fsp.readdir(root, { recursive: true, withFileTypes: true })
  } catch {
    return []
  }
  /** 目录 → { zstd, jsonl }：一次遍历就把"哪个目录里有会话数据文件"收齐。 */
  const holders = new Map()
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const fileName = entry.name
    if (fileName !== 'session.jsonl.zstd' && fileName !== 'session.jsonl') continue
    const parent = typeof entry.parentPath === 'string' ? entry.parentPath
      : (typeof entry.path === 'string' ? entry.path : '')
    if (parent.length === 0) continue
    const slot = holders.get(parent) ?? { zstd: false, jsonl: false }
    if (fileName === 'session.jsonl.zstd') slot.zstd = true
    else slot.jsonl = true
    holders.set(parent, slot)
  }

  const out = []
  let sinceYield = 0
  for (const [dir, slot] of holders) {
    const file = slot.zstd ? join(dir, 'session.jsonl.zstd') : join(dir, 'session.jsonl')
    const st = await statOrNull(file)
    if (st === null || !st.isFile()) continue
    out.push({ id: basename(dir), dir, file, size: st.size, mtimeMs: st.mtimeMs })
    sinceYield += 1
    if (sinceYield >= 64) {
      sinceYield = 0
      await yieldToEventLoop()
    }
  }
  return out
}

// ── 异步搬运原语 ──────────────────────────────────────────────────────────
// 铁律：自动归档路径上的读写一律异步（fsp / 流）。同步调用会把单线程事件循环按住，
// 搬运期间别的 HTTP 请求、别的会话解码、定时器全部停摆 —— 那正是本仓要治的病。

/** 异步重试（与 withRetry 同语义；退避用 sleepAsync，不忙等）。 */
async function withRetryAsync(fn, tries, baseDelay) {
  const maxTries = Number.isFinite(tries) ? Math.max(1, tries) : 3
  const delay = Number.isFinite(baseDelay) ? Math.max(0, baseDelay) : 120
  let lastError
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (attempt < maxTries) await sleepAsync(delay * attempt)
    }
  }
  throw lastError
}

async function statOrNull(p) {
  try {
    return await fsp.stat(p)
  } catch {
    return null
  }
}

async function pathExists(p) {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

async function removeFileQuiet(p) {
  try {
    await fsp.rm(p, { force: true })
  } catch { /* best effort */ }
}

/** 异步递归删除（带重试）。异步路径不要用 safeRemoveDir —— 它是 sleepSync 忙等。 */
async function removeDirAsync(targetDir, maxRetries) {
  if (!(await pathExists(targetDir))) return true
  const tries = Number.isFinite(maxRetries) ? Math.max(1, maxRetries) : (get('archive.removeRetries') ?? 4)
  const delay = get('archive.removeRetryDelayMs') ?? 180
  let lastError
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      await fsp.rm(targetDir, { recursive: true, force: true, maxRetries: 4, retryDelay: delay })
      return true
    } catch (err) {
      lastError = err
      if (attempt < tries) await sleepAsync(delay * attempt)
    }
  }
  throw lastError
}

async function hashFileAsync(filePath) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath, { highWaterMark: 1 << 20 })) hash.update(chunk)
  return hash.digest('hex')
}

/** 两个文件是否逐字节相同（比 sha256，不比 mtime —— mtime 会被同步盘来回改）。 */
async function filesIdenticalAsync(a, b) {
  const [hashA, hashB] = await Promise.all([hashFileAsync(a), hashFileAsync(b)])
  return hashA === hashB
}

/**
 * 目录树里的文件清单（相对路径用 `/`，按路径排序）。
 * 异步遍历：目录多的时候不会一次性占住线程。
 */
async function listTreeAsync(root) {
  const files = []
  const walk = async (dir, base) => {
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = base ? base + '/' + entry.name : entry.name
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, rel)
        continue
      }
      if (!entry.isFile()) continue
      const st = await statOrNull(full)
      if (st === null) continue
      files.push({ rel, size: st.size })
    }
  }
  await walk(root, '')
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return files
}

/**
 * 流式复制单个文件，边写边算源字节的 sha256（校验不用再读一遍盘）。
 * 用流而不是 copyFileSync：每读一块都会回到事件循环，几十 MB 的日志也不会按住线程。
 */
async function copyFileWithHash(src, dst) {
  await fsp.mkdir(dirname(dst), { recursive: true })
  const hash = createHash('sha256')
  let bytes = 0
  await pipeline(
    createReadStream(src, { highWaterMark: 1 << 20 }),
    new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk)
        bytes += chunk.length
        callback(null, chunk)
      },
    }),
    createWriteStream(dst),
  )
  return { sha256: hash.digest('hex'), bytes }
}

/**
 * 复制一棵目录树（逐文件异步 + 分批让出事件循环）。
 *
 * `allowOverwrite=false`（正常路径）：目标里出现同名文件即视为冲突，绝不覆盖。
 * `allowOverwrite=true`（半完成态、有 in-progress 标记）：同名的半截文件可以重写；
 *   内容已经一致的文件仍然跳过，只补缺的。
 */
async function copyTreeAsync(srcRoot, dstRoot, srcFiles, options = {}) {
  const allowOverwrite = options.allowOverwrite === true
  const batchBytes = Math.max(1, Number(get('archive.copyBatchBytes')) || 1048576)
  const batchFiles = Math.max(1, Number(get('archive.copyBatchFiles')) || 8)
  let copiedFiles = 0
  let reusedFiles = 0
  let bytesCopied = 0
  let sinceYieldBytes = 0
  let sinceYieldFiles = 0

  await fsp.mkdir(dstRoot, { recursive: true })
  for (const file of srcFiles) {
    const srcPath = join(srcRoot, ...file.rel.split('/'))
    const dstPath = join(dstRoot, ...file.rel.split('/'))
    const dstStat = await statOrNull(dstPath)
    if (dstStat !== null && dstStat.isFile() && dstStat.size === file.size
      && await filesIdenticalAsync(srcPath, dstPath)) {
      reusedFiles += 1
    } else if (dstStat !== null && dstStat.isFile() && allowOverwrite) {
      const written = await withRetryAsync(
        () => copyFileWithHash(srcPath, dstPath),
        get('archive.copyRetries'),
        get('archive.copyRetryDelayMs'),
      )
      copiedFiles += 1
      bytesCopied += written.bytes
      sinceYieldBytes += written.bytes
      sinceYieldFiles += 1
    } else if (dstStat !== null) {
      throw new ArchiveConflictError(
        'destination already holds a different file at "' + file.rel + '" (refusing to overwrite)',
      )
    } else {
      const written = await withRetryAsync(
        () => copyFileWithHash(srcPath, dstPath),
        get('archive.copyRetries'),
        get('archive.copyRetryDelayMs'),
      )
      copiedFiles += 1
      bytesCopied += written.bytes
      sinceYieldBytes += written.bytes
      sinceYieldFiles += 1
    }
    if (sinceYieldBytes >= batchBytes || sinceYieldFiles >= batchFiles) {
      sinceYieldBytes = 0
      sinceYieldFiles = 0
      await yieldToEventLoop()
    }
  }
  return { copiedFiles, reusedFiles, bytesCopied }
}

/** 目录树形状（相对路径 + 字节数）是否一致。便宜，用它做复制后的校验。 */
async function treesSameShapeAsync(root, srcFiles) {
  const dstFiles = await listTreeAsync(root)
  if (dstFiles.length !== srcFiles.length) return false
  for (let i = 0; i < srcFiles.length; i++) {
    if (dstFiles[i].rel !== srcFiles[i].rel || dstFiles[i].size !== srcFiles[i].size) return false
  }
  return true
}

/**
 * 目录树是否**逐字节**一致（先比相对路径与字节数快速排除，再逐文件比 sha256）。
 * 「已搬过 ⇒ 跳过」「目标不一致 ⇒ 冲突」都用它做判据：只比大小会漏掉"同大小不同内容"。
 */
async function treesIdenticalAsync(srcRoot, dstRoot, srcFiles) {
  if (!(await treesSameShapeAsync(dstRoot, srcFiles))) return false
  for (const file of srcFiles) {
    const srcPath = join(srcRoot, ...file.rel.split('/'))
    const dstPath = join(dstRoot, ...file.rel.split('/'))
    if (!(await filesIdenticalAsync(srcPath, dstPath))) return false
  }
  return true
}

/** 目标目录已经存在、但内容与源对不上（且不是我们自己留下的半完成态）。 */
class ArchiveConflictError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ArchiveConflictError'
  }
}

/** 批次目录里的"搬运中"标记目录（**必须在会话目录之外**，否则会污染逐字节比对）。 */
function inProgressDir(batchDir) {
  return join(batchDir, '.in-progress')
}

function markerPathOf(batchDir, sessionId) {
  return join(inProgressDir(batchDir), sessionId + '.json')
}

/**
 * 搬一个会话目录。**幂等键 = sessionId + 目标批次目录**（绝不用源路径：会话搬走后路径就变了）。
 *
 * 四态判定：
 *   ① 目标不存在                     ⇒ 全新搬运：先写 in-progress 标记，再逐文件流式复制、校验、删源
 *   ② 目标存在 + 与源逐字节一致      ⇒ 已经搬过（可能只是崩在"删源"之前）⇒ 只补删源
 *   ③ 目标存在 + 有 in-progress 标记 ⇒ 半完成态 ⇒ 只补缺的文件（已一致的文件跳过），不整份重搬
 *   ④ 目标存在 + 无标记 + 内容不一致 ⇒ 冲突：报错、原样保留，**绝不覆盖**
 */
async function archiveOneSession(candidate, batchDir, job) {
  const dest = join(batchDir, candidate.sessionId)
  const markerPath = markerPathOf(batchDir, candidate.sessionId)
  const destStat = await statOrNull(dest)
  const srcFiles = await listTreeAsync(candidate.dir)

  if (destStat !== null && !destStat.isDirectory()) {
    throw new ArchiveConflictError('destination path exists and is not a directory')
  }

  if (destStat !== null && await treesIdenticalAsync(candidate.dir, dest, srcFiles)) {
    // ② 内容已经在位：只剩删源这一步（崩在删源前的半完成态也是这种形状）
    await removeDirAsync(candidate.dir)
    await removeFileQuiet(markerPath)
    return { status: 'already-archived', copiedFiles: 0, reusedFiles: srcFiles.length, bytesCopied: 0 }
  }

  const resumable = destStat !== null && await pathExists(markerPath)
  if (destStat !== null && !resumable) {
    // ④ 别人放的 / 上一次不同批次留下的：不覆盖
    throw new ArchiveConflictError(
      'destination session id already exists with different bytes (refusing to overwrite)',
    )
  }

  if (destStat === null) {
    // ① 先落标记再动手：崩溃后下一轮才知道这个目录是我们写到一半的
    const totalBytes = srcFiles.reduce((sum, file) => sum + file.size, 0)
    await writeJsonAtomic(markerPath, {
      sessionId: candidate.sessionId,
      batch: basename(batchDir),
      runId: job.runId,
      startedAt: Date.now(),
      bytes: totalBytes,
      files: srcFiles.length,
    })
  }

  job.phase = 'copy'
  const copied = await copyTreeAsync(candidate.dir, dest, srcFiles, { allowOverwrite: resumable })
  if (!(await treesSameShapeAsync(dest, srcFiles))) {
    throw new Error('copied data did not match; destination kept so the next run can resume it')
  }
  await removeDirAsync(candidate.dir)
  await removeFileQuiet(markerPath)
  return {
    status: destStat === null ? 'archived' : 'resumed',
    copiedFiles: copied.copiedFiles,
    reusedFiles: copied.reusedFiles,
    bytesCopied: copied.bytesCopied,
  }
}

// ── 自动归档入口：单飞锁 + 异步分批 ───────────────────────────────────────

/**
 * 正在跑的自动归档任务（**进程级单飞**：timer 与手动触发共用同一把锁）。
 * 同一时刻第二次触发立刻返回「正在跑」并带上"谁在跑、从什么时候开始"，绝不排队。
 */
let activeRun = null
let runSeq = 0

function describeActiveRun() {
  if (activeRun === null) return null
  return {
    runId: activeRun.runId,
    trigger: activeRun.trigger,
    dryRun: activeRun.dryRun,
    startedAt: activeRun.startedAt,
    elapsedMs: Date.now() - activeRun.startedAt,
    phase: activeRun.phase,
    processed: activeRun.processed,
    batch: activeRun.batch,
  }
}

/**
 * 执行一次自动归档（dryRun=true 只列不搬）。
 *
 * 单飞：进入函数的第一件事（在任何 await 之前）抢锁；抢不到就立刻返回 alreadyRunning。
 * 搬运本身异步分批：每搬一个文件/一份会话都会把事件循环让出去。
 */
async function runAutoArchive(options = {}) {
  const trigger = typeof options.trigger === 'string' && options.trigger.length > 0 ? options.trigger : 'manual'
  if (activeRun !== null) {
    return {
      ok: false,
      alreadyRunning: true,
      code: 'already-running',
      message: 'an auto-archive run is already in progress; this trigger did not start a second one',
      running: describeActiveRun(),
    }
  }
  const { config } = readAutoState()
  const dryRun = options.dryRun === undefined ? config.dryRun !== false : options.dryRun === true
  const job = {
    runId: 'run-' + (++runSeq) + '-' + Date.now().toString(36),
    trigger,
    dryRun,
    startedAt: Date.now(),
    phase: 'scan',
    processed: 0,
    batch: null,
  }
  activeRun = job
  try {
    return await runAutoArchiveInner(job)
  } finally {
    activeRun = null
  }
}

async function runAutoArchiveInner(job) {
  const { config, state } = readAutoState()
  const dryRun = job.dryRun
  const now = job.startedAt
  const minAgeMs = Math.max(0, Number(config.hours) || 48) * 3600 * 1000
  const minBytes = Math.max(0, Number(config.minSizeMb) || 0) * 1048576
  const maxPerRun = Math.max(1, Number(config.maxPerRun) || 50)

  const result = {
    runId: job.runId,
    trigger: job.trigger,
    startedAt: now,
    durationMs: 0,
    dryRun,
    scanned: 0,
    candidates: [],
    archived: [],
    resumed: [],
    alreadyArchived: [],
    conflicts: [],
    skipped: [],
    errors: [],
    batch: null,
    batchResumed: false,
    movedMb: 0,
    copiedFiles: 0,
    reusedFiles: 0,
  }

  job.phase = 'scan'
  const scanned = await listSessionDirs()
  result.scanned = scanned.length

  const picked = []
  let sinceYield = 0
  for (const item of scanned) {
    const ageMs = now - item.mtimeMs
    if (ageMs < minAgeMs) continue
    if (item.size < minBytes) continue
    if (hasUnclosedTurn(await tailEventTypes(item.file))) {
      result.skipped.push({ sessionId: item.id, reason: 'open-turn' })
      continue
    }
    if (await isEmptyShell(item.file, item.size)) {
      result.skipped.push({ sessionId: item.id, reason: 'empty-shell' })
      continue
    }
    picked.push({ sessionId: item.id, dir: item.dir, mb: item.size / 1048576, ageD: ageMs / 86400000, mtime: item.mtimeMs })
    sinceYield += 1
    if (sinceYield >= 8) {
      sinceYield = 0
      await yieldToEventLoop()
    }
  }

  picked.sort((a, b) => a.mtime - b.mtime) // 最老的先
  const take = picked.slice(0, maxPerRun)
  result.candidates = take.map((c) => ({ sessionId: c.sessionId, mb: Number(c.mb.toFixed(2)), ageD: Number(c.ageD.toFixed(1)) }))

  const notes = []
  if (picked.length > take.length) notes.push('candidates=' + picked.length + ', processed=' + take.length + ' (maxPerRun)')

  const pending = state.pendingBatch
  const pendingBatch = pending && typeof pending.batch === 'string' && pending.batch.length > 0 ? pending.batch : null

  if (dryRun) {
    notes.push('dryRun: no file was moved')
    if (pendingBatch !== null && isDir(join(archiveRoot(), pendingBatch))) {
      notes.push('pending batch ' + pendingBatch + ' (a live run will resume it)')
    }
  } else if (take.length > 0) {
    // 批次目录复用：上一次跑到一半（pendingBatch 还在）就接着搬，而不是开一个新批次重搬一遍。
    // 幂等键 = sessionId + 批次目录，所以「同一批次目录 + 同一 sessionId」必须认作同一件事。
    let batch = null
    let batchResumed = false
    if (pendingBatch !== null && isDir(join(archiveRoot(), pendingBatch))) {
      batch = pendingBatch
      batchResumed = true
    } else {
      batch = new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19)
      await fsp.mkdir(join(archiveRoot(), batch), { recursive: true })
      state.pendingBatch = { batch, createdAt: now }
      try {
        writeAutoState(config, state)
      } catch { /* best effort */ }
    }
    job.batch = batch
    result.batch = batch
    result.batchResumed = batchResumed
    if (batchResumed) notes.push('resumed batch ' + batch + ' (pending from a previous run)')

    const batchDir = join(archiveRoot(), batch)
    const manifestPath = join(batchDir, String(get('archive.manifestFile') ?? 'manifest.json'))
    const manifest = readManifest(batch) ?? []
    job.phase = 'copy'
    for (const c of take) {
      job.processed += 1
      try {
        const outcome = await archiveOneSession(c, batchDir, job)
        if (outcome.status === 'archived') result.archived.push(c.sessionId)
        else if (outcome.status === 'resumed') result.resumed.push(c.sessionId)
        else result.alreadyArchived.push(c.sessionId)
        if (outcome.status !== 'already-archived') {
          result.movedMb += c.mb
          result.copiedFiles += outcome.copiedFiles
        }
        result.reusedFiles += outcome.reusedFiles
        manifest.push({ from: c.dir, to: join(batchDir, c.sessionId), mb: c.mb, ageD: c.ageD })
        // 每搬完一份就落一次清单：进程崩在半路，下一轮看清单就知道哪些已经在位
        try {
          writeJsonAtomic(manifestPath, manifest)
        } catch { /* best effort */ }
      } catch (err) {
        if (err instanceof ArchiveConflictError) {
          result.conflicts.push({ sessionId: c.sessionId, reason: errText(err) })
        } else {
          result.errors.push({ sessionId: c.sessionId, error: errText(err) })
        }
      }
      await yieldToEventLoop()
    }
    result.movedMb = Number(result.movedMb.toFixed(2))

    if (result.conflicts.length > 0) notes.push('conflicts=' + result.conflicts.length + ' (kept as-is, nothing overwritten)')
    if (result.resumed.length > 0 || result.alreadyArchived.length > 0) {
      notes.push('resumed=' + result.resumed.length + ', alreadyArchived=' + result.alreadyArchived.length)
    }

    // 批次收尾：待办批次标记清掉（下一次是真新批次）；标记目录空了就顺手删掉
    if (result.conflicts.length === 0) {
      state.pendingBatch = null
      try {
        await fsp.rmdir(inProgressDir(batchDir))
      } catch { /* 还有残留标记就留着 */ }
    }
  }
  if (notes.length > 0) result.note = notes.join('; ')
  job.phase = 'done'
  result.durationMs = Date.now() - now

  state.lastRunAt = now
  state.lastResult = result
  state.totalArchived = (Number(state.totalArchived) || 0)
    + result.archived.length + result.resumed.length + result.alreadyArchived.length
  try {
    writeAutoState(config, state)
  } catch { /* best effort */ }

  return result
}

// ── HTTP 层（loopback-only + same-origin 防护） ───────────────────────────

function isLoopbackRequest(request) {
  const address = request.socket?.remoteAddress
  if (!LOOPBACK_ADDRESSES.includes(address)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  const allowedHosts = get('server.allowedHosts') ?? ['127.0.0.1', 'localhost', '[::1]']
  if (!allowedHosts.includes(hostUrl.hostname) && !allowedHosts.includes('[' + hostUrl.hostname + ']')) return false
  if (get('server.rejectCrossSite') !== false && request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  if (get('server.sameOriginOnly') === false) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** 读 JSON 请求体；返回 { body } 或 { error: {status, code, message} }。 */
async function readJsonBody(req) {
  const limit = get('server.maxJsonBodyBytes') ?? 262144
  const chunks = []
  let size = 0
  try {
    for await (const chunk of req) {
      size += chunk.length
      if (size > limit) return { error: { status: 413, code: 'body-too-large', message: 'request body too large' } }
      chunks.push(chunk)
    }
  } catch {
    return { error: { status: 400, code: 'body-read-failed', message: 'could not read request body' } }
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim().length === 0) return { body: {} }
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: { status: 400, code: 'invalid-body', message: 'request body must be a JSON object' } }
    }
    return { body: parsed }
  } catch {
    return { error: { status: 400, code: 'invalid-json', message: 'request body is not valid JSON' } }
  }
}

function bodySessionId(body) {
  if (!body) return null
  const id = typeof body.sessionId === 'string' ? body.sessionId : null
  if (!id || id.length === 0 || id.includes('\\') || id.includes('/') || id === '.' || id === '..') return null
  return id
}

/** 宽松布尔解析：兼容 JSON true/1/"true"/"1"。 */
function toBoolean(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    if (text === 'true' || text === '1') return true
    if (text === 'false' || text === '0') return false
  }
  return undefined
}

function positiveNumber(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return undefined
  return Math.min(max, Math.max(min, n))
}

/**
 * 注册一条路由：优先 ctx.webServer.register，退回 ctx.server.register。
 * 不同主包版本暴露的服务名不同，这里做运行时探测（见 README「兼容性」）。
 */
function registerRoute(ctx, route) {
  const server = ctx.webServer ?? ctx.server
  if (!server || typeof server.register !== 'function') {
    throw new Error('dsh-archive-sessions: no web server service found (expected ctx.webServer.register or ctx.server.register)')
  }
  return server.register(route)
}

export function apply(ctx) {
  // 启动时按当前磁盘状态载入一次配置
  loadConfig({ cache: true })
  const { errors } = currentConfig()
  if (errors.length > 0) {
    ctx.logger?.warn?.('[dsh-archive-sessions] config issues: ' + errors.join('; '))
  }

  const guard = (handler) => async (req, res) => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: 'forbidden', code: 'loopback-only', message: 'this endpoint only accepts loopback requests' })
      return
    }
    await handler(req, res)
  }

  const apiPrefix = () => get('server.apiPrefix') ?? '/api/dsh-archive-sessions'

  const routes = [
    {
      kind: 'exact',
      path: '/__archive-sessions/config',
      handler: guard(async (req, res) => {
        if (req.method !== 'GET') return writeJson(res, 405, { error: 'method not allowed' })
        try {
          const { config, errors } = currentConfig()
          writeJson(res, 200, { ...publicConfig(config), configErrors: errors })
        } catch (err) {
          writeJson(res, 500, { error: errText(err), code: 'internal' })
        }
      }),
    },
    {
      kind: 'exact',
      path: '/__archive-sessions/list',
      handler: guard(async (req, res) => {
        if (req.method !== 'GET') return writeJson(res, 405, { error: 'method not allowed' })
        try {
          writeJson(res, 200, listArchives())
        } catch (err) {
          writeJson(res, 500, { error: errText(err), code: 'internal' })
        }
      }),
    },
    {
      kind: 'exact',
      path: '/__archive-sessions/detail',
      handler: guard(async (req, res) => {
        if (req.method !== 'GET') return writeJson(res, 405, { error: 'method not allowed' })
        try {
          const url = new URL(req.url, 'http://localhost')
          const sessionId = url.searchParams.get('sessionId') || ''
          if (!sessionId) return writeJson(res, 400, { error: 'sessionId required', code: 'session-id-required' })
          const found = findSession(sessionId)
          if (!found) return writeJson(res, 404, { error: 'archived session not found', code: 'not-found' })
          const record = makeSessionRecordReader()(sessionId)
          const detail = extractSessionDetail(found.dir)
          writeJson(res, 200, {
            sessionId,
            batch: found.batch,
            title: record?.rows?.title?.val ?? null,
            cwd: record?.identity?.cwd ?? detail.header?.cwd ?? null,
            createdAt: record?.identity?.createdAt ?? detail.header?.createdAt ?? null,
            turns: record?.rows?.sessionStats?.val?.turns ?? 0,
            ...detail,
          })
        } catch (err) {
          writeJson(res, 500, { error: errText(err), code: 'internal' })
        }
      }),
    },
    {
      kind: 'exact',
      path: '/__archive-sessions/restore',
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
        const { body, error } = await readJsonBody(req)
        if (error) return writeJson(res, error.status, { error: error.message, code: error.code })
        const sessionId = bodySessionId(body)
        if (!sessionId) return writeJson(res, 400, { error: 'sessionId required', code: 'session-id-required' })
        try {
          const result = restoreSession(sessionId)
          writeJson(res, result.error ?? 200, result)
        } catch (err) {
          writeJson(res, 500, { error: errText(err), code: 'internal' })
        }
      }),
    },
    {
      kind: 'exact',
      path: '/__archive-sessions/delete',
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
        const { body, error } = await readJsonBody(req)
        if (error) return writeJson(res, error.status, { error: error.message, code: error.code })
        const sessionId = bodySessionId(body)
        if (!sessionId) return writeJson(res, 400, { error: 'sessionId required', code: 'session-id-required' })
        try {
          const result = deleteSession(sessionId)
          writeJson(res, result.error ?? 200, result)
        } catch (err) {
          writeJson(res, 500, { error: errText(err), code: 'internal' })
        }
      }),
    },
    {
      kind: 'exact',
      path: '/__archive-sessions/auto',
      handler: guard(async (req, res) => {
        try {
          if (req.method === 'GET') {
            const { config, state } = readAutoState()
            return writeJson(res, 200, { config, state })
          }
          if (req.method === 'POST') {
            const { body, error } = await readJsonBody(req)
            if (error) return writeJson(res, error.status, { error: error.message, code: error.code })
            const { config, state } = readAutoState()
            const next = { ...config }
            const enabled = toBoolean(body.enabled)
            if (enabled !== undefined) next.enabled = enabled
            const dryRun = toBoolean(body.dryRun)
            if (dryRun !== undefined) next.dryRun = dryRun
            const hours = positiveNumber(body.hours, 1, 24 * 365)
            if (hours !== undefined) next.hours = hours
            const intervalMs = positiveNumber(body.intervalMs, 60000, 30 * 24 * 3600 * 1000)
            if (intervalMs !== undefined) next.intervalMs = intervalMs
            const minSizeMb = positiveNumber(body.minSizeMb, 0, 1024 * 1024)
            if (minSizeMb !== undefined) next.minSizeMb = minSizeMb
            const maxPerRun = positiveNumber(body.maxPerRun, 1, 100000)
            if (maxPerRun !== undefined) next.maxPerRun = maxPerRun
            writeAutoState(next, state)
            return writeJson(res, 200, { ok: true, config: next })
          }
          return writeJson(res, 405, { error: 'method not allowed' })
        } catch (err) {
          writeJson(res, 500, { error: errText(err), code: 'internal' })
        }
      }),
    },
    {
      kind: 'exact',
      path: '/__archive-sessions/auto/run',
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
        const { body } = await readJsonBody(req)
        const parsed = toBoolean(body?.dryRun)
        const dryRun = parsed === undefined ? true : parsed
        try {
          const result = await runAutoArchive({ dryRun, trigger: 'manual' })
          writeJson(res, 200, result)
        } catch (err) {
          writeJson(res, 500, { error: errText(err), code: 'internal' })
        }
      }),
    },
  ].map((route) => ({ ...route, path: apiPrefix() + route.path.replace('/__archive-sessions', '') }))

  const disposers = routes.map((route) => registerRoute(ctx, route))

  // 自动归档定时器：按 auto.tickMs tick，到点（intervalMs）且 enabled 才真跑；全程 try/catch。
  // tick 是异步的（搬运分批让出事件循环），setInterval 不会等上一轮 —— 重入由单飞锁挡掉。
  let autoTimer = null
  const tickMs = Number(get('auto.tickMs')) || 60000
  const startDelayMs = Number(get('auto.startDelayMs')) || 120000
  const autoTick = async () => {
    try {
      const { config, state } = readAutoState()
      if (config.enabled !== true) return
      const last = Number(state.lastRunAt) || 0
      const interval = Math.max(60000, Number(config.intervalMs) || 21600000)
      if (Date.now() - last < interval) return
      const result = await runAutoArchive({ dryRun: config.dryRun !== false, trigger: 'timer' })
      if (result.alreadyRunning === true) {
        ctx.logger?.info?.('[dsh-archive-sessions] auto-archive skipped: another run is in progress')
        return
      }
      ctx.logger?.info?.(
        '[dsh-archive-sessions] auto-archive scanned=' + result.scanned +
        ' archived=' + result.archived.length + ' dryRun=' + result.dryRun,
      )
    } catch (err) {
      ctx.logger?.warn?.('[dsh-archive-sessions] auto-archive failed: ' + errText(err))
    }
  }
  const autoStartup = setTimeout(() => {
    void autoTick()
    autoTimer = setInterval(() => { void autoTick() }, tickMs)
    if (typeof autoTimer.unref === 'function') autoTimer.unref()
  }, startDelayMs)
  if (typeof autoStartup.unref === 'function') autoStartup.unref()

  return () => {
    try { clearTimeout(autoStartup) } catch { /* ignore */ }
    try { if (autoTimer !== null) clearInterval(autoTimer) } catch { /* ignore */ }
    for (const dispose of disposers) {
      try {
        dispose()
      } catch { /* ignore */ }
    }
  }
}

/** 供测试 / 其他模块复用的纯函数导出。 */
export const __testing = {
  projectKey,
  encodeSegment,
  scanZstdFrames,
  decodeZstdLog,
  decodeFirstFrame,
  firstUserMessageFromDir,
  sessionHeaderFromDir,
  extractSessionDetail,
  listArchives,
  restoreSession,
  deleteSession,
  runAutoArchive,
  isLoopbackRequest,
  toBoolean,
  archiveRoot,
  sessionsRoot,
  getConfig: () => currentConfig().config,
  // 异步搬运件（夹具直接用）
  listSessionDirs,
  listTreeAsync,
  treesIdenticalAsync,
  archiveOneSession,
  inProgressDir,
  describeActiveRun,
  isArchiveRunning: () => activeRun !== null,
  writeAutoState,
  readAutoState,
  yieldToEventLoop,
}
