#!/usr/bin/env node
/**
 * session-archive-health —— 「会话归档」这件事的**只读**健康自检
 * （一条命令回答「现在的归档状态还健康吗」，不用自己去翻几份 JSON）。
 *
 * 🔴 契约（三不）：
 *   ① 只读 —— 只读文件 + 只读查询（`session.list` 是查询；`GET /api/dsh-archive-sessions/auto` 是读配置），
 *      **零写盘、零 RPC 写动作、不重启、不归档/不删/不恢复**；
 *   ② observe 档 —— 发现问题只报告、**绝不修**：退码 `0` = 六项全 ✅，`3` = 有 ⚠️/🔴；
 *   ③ 唯一会写盘的地方是 `--self-test`（在系统临时目录造假数据，跑完删掉）。
 *
 * 六项判据（改判据前先读这一段）：
 *   ① ghost —— 自动档若采用「只写 workspace.json 的 archivedSessionIds 标记、文件一个不动」，
 *      被标记归档的会话**仍留在 `sessions/`、`session.list` 也还看得见**。
 *      所以 ghost 必须三条件同时成立（物理在归档树 **且** 不在名单 **且** 仍可见）。
 *      只数「物理 − 名单」会得到大量历史批次噪音，**那不是 bug**（只作背景读数，不据此判红）。
 *   ② 自动档配置 —— 与你**自己给的期望值**逐项比对（`--expect-json`；不给就只报现值、不判红）。
 *   ③ 上一轮行为 —— 两个闸是否真在生效：`humanOnlyHandoff`（未交接不自动收走）与
 *      `skippedAlreadyArchived`（已归档不重复搬）。
 *   ④ 未分组 —— 前端「按工作区分组」时，不在任何工作区 sessionIds 里的会话会掉进「未分组」；
 *      subagent 必须靠会话日志**首帧**判（zstd 多帧：拆帧 + 只解第一帧，再读 `type==='session'`
 *      的 origin / delegationDepth）——**直接读原始字节会全判成非子代理**。
 *      同一项内另给两个投影：**孤儿卡会话**（cwd 在卡会话目录 ∧ 不在看板账本 ⇒ 插件按 human 档
 *      要求「已交接」⇒ 没有标题的会一直挂着）与**重启归组预测**（cwd 是否等于某个现存工作区 path）。
 *   ⑤ 执行者台账 —— `archive-session-ops.jsonl`（一行一条 JSON）。
 *   ⑥ 源 ↔ 部署副本 —— 改了源码没重新部署 / 部署了没同步源，两边 sha256 立刻分叉。
 *      **默认不查**：外部安装没有「源树 ↔ profile 部署副本」这一对（N/A），
 *      要查就同时传 `--plugin-src` 与 `--plugin-dep`。
 *
 * 用法：
 *   dsh-archive-health                     # 人话输出
 *   dsh-archive-health --json              # 结构化（stdout 只出 JSON）
 *   dsh-archive-health --self-test         # 夹具自测（⇐ 必须真跑一次）
 *   dsh-archive-health --strict            # ghost 按「必须 0」判（双份残留也算红）
 *   dsh-archive-health --expect-json <文件> # 带期望值做配置对齐（形状见 README）
 *
 * 联网两项（session.list / 自动档配置）拿不到只降级成 ⚠️「判不了」，**绝不猜**。
 * 需要宿主 cookie 的环境：把 base64 密钥放进 env `DSH_RPC_COOKIE_SECRET`（本件不读凭据文件）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

import { scanZstdFrames } from '../lib/zstd-frames.mjs'
import { hostRpc } from '../lib/host-rpc.mjs'

const HERE = fileURLToPath(import.meta.url)

const STATUS = { OK: 'ok', WARN: 'warn', BAD: 'bad' }
const ICON = { ok: '✅', warn: '⚠️', bad: '🔴' }
const RANK = { ok: 0, warn: 1, bad: 2 }

// ── 小工具 ───────────────────────────────────────────────────────────────────

function resolveHome(override) {
  if (override) return path.resolve(override)
  if (process.env.DSH_HOME && process.env.DSH_HOME.trim()) return path.resolve(process.env.DSH_HOME.trim())
  return path.join(os.homedir(), '.dsh')
}

/**
 * 会话 id 归一：`session-<uuid>` / 裸 `<uuid>` → `session-<uuid>`；非 uuid 形态 → `null`。
 * 与 `tools\lib\projcache-read.mjs#normalizeSessionId` 同语义（那边是主包口径的唯一源；
 * 本件不 import 它是为了不把凭据/分片读盘的依赖拉进一个只读健康检查）。
 */
function normalizeSessionId(id) {
  const s = String(id ?? '').trim().toLowerCase()
  if (!s) return null
  const bare = s.startsWith('session-') ? s.slice('session-'.length) : s
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(bare) ? `session-${bare}` : null
}

function cwdKey(p) {
  if (typeof p !== 'string' || !p.trim()) return ''
  return p.trim().replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function sha256(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

function fmtLocal(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function shortSid(sid) {
  const s = String(sid ?? '')
  return s.length > 24 ? `${s.slice(0, 20)}…${s.slice(-4)}` : s
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

// ── 会话日志首帧解码（与插件 `lib\index.js#decodeFirstFrame` 同算法、此处是 CLI 侧一次抄写）──

const FIRST_FRAME_READ_BYTES = 256 * 1024

function readHeadBytes(filePath, want) {
  let fd = -1
  try {
    fd = fs.openSync(filePath, 'r')
    const size = fs.fstatSync(fd).size
    const n = Math.min(size, want)
    if (n <= 0) return { buf: Buffer.alloc(0), size, truncated: false }
    const tmp = Buffer.allocUnsafe(n)
    const read = fs.readSync(fd, tmp, 0, n, 0)
    return { buf: tmp.subarray(0, read), size, truncated: size > read }
  } finally {
    if (fd >= 0) {
      try { fs.closeSync(fd) } catch { /* ignore */ }
    }
  }
}

/** 从 zstd 帧头读「解压后大小」（帧头未声明 ⇒ null）——判「只读到半帧」用。 */
function firstFrameContentSize(buf) {
  if (!buf || buf.length < 6) return null
  try {
    if (buf.readUInt32LE(0) !== 4247762216) return null // 0xFD2FB528 LE
    const descriptor = buf.readUInt8(4)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    if (contentSizeBytes === 0) return null
    const off = 5 + dictionaryBytes + (singleSegment ? 0 : 1)
    if (buf.length < off + contentSizeBytes) return null
    let size = 0
    for (let i = 0; i < contentSizeBytes; i++) size += buf.readUInt8(off + i) * 256 ** i
    return size
  } catch {
    return null
  }
}

/**
 * 只解**第一帧**的文本（会话头在首帧里）。
 * 截断读的完整性判据只有两条可靠：① 扫出 ≥2 帧；② 单帧时用帧头 contentSize 校验解出长度。
 * 都不成立 ⇒ 回退读全文（宁可慢这一次，绝不把「解不出来」当成「没有元数据」）。
 */
function decodeFirstFrameText(filePath) {
  if (!fs.existsSync(filePath)) return ''
  // 明文世代（`session.jsonl`）：没有 zstd 帧，直接取头部文本
  if (!/\.zstd$/i.test(filePath)) {
    try {
      return readHeadBytes(filePath, FIRST_FRAME_READ_BYTES).buf.toString('utf8')
    } catch {
      return ''
    }
  }
  let buf
  try {
    const head = readHeadBytes(filePath, FIRST_FRAME_READ_BYTES)
    buf = head.buf
    if (head.truncated) {
      const probe = scanZstdFrames(buf).frames
      if (probe.length >= 2) {
        try {
          return zstdDecompressSync(buf.subarray(probe[0].start, probe[0].end)).toString('utf8')
        } catch { /* 往下走全文 */ }
      } else if (probe.length === 1) {
        const csize = firstFrameContentSize(buf)
        if (csize !== null) {
          try {
            const t = zstdDecompressSync(buf.subarray(probe[0].start, probe[0].end)).toString('utf8')
            if (Buffer.byteLength(t) === csize) return t
          } catch { /* 往下走全文 */ }
        }
      }
      buf = fs.readFileSync(filePath)
    }
  } catch {
    try {
      buf = fs.readFileSync(filePath)
    } catch {
      return ''
    }
  }
  if (!buf || buf.length === 0) return ''
  const frames = scanZstdFrames(buf).frames
  if (frames.length === 0) {
    try {
      return zstdDecompressSync(buf).toString('utf8')
    } catch {
      return ''
    }
  }
  try {
    return zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end)).toString('utf8')
  } catch {
    return ''
  }
}

/** 会话头：{origin, delegationDepth, cwd} | null（解析不出 ⇒ null，由调用方降级并如实登记）。 */
function readSessionHeader(filePath) {
  if (!filePath) return null
  const text = decodeFirstFrameText(filePath)
  if (!text) return null
  for (const line of text.split('\n')) {
    if (!line) continue
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (ev && ev.type === 'session') {
      return {
        origin: typeof ev.origin === 'string' ? ev.origin : null,
        delegationDepth: Number.isFinite(ev.delegationDepth) ? ev.delegationDepth : null,
        cwd: typeof ev.cwd === 'string' ? ev.cwd : null,
      }
    }
  }
  return null
}

// ── 读盘：四份事实源 ─────────────────────────────────────────────────────────

/**
 * `sessions\` 索引：会话 id → { dir, file }（认两代布局：`sessions\<桶>\<会话目录>` 与老的扁平
 * `sessions\<会话目录>`）。文件按世代优先（v4 > v3 > v2 > 明文），同世代取 mtime 新的。
 */
function indexLiveSessions(sessionsRoot) {
  const out = new Map()
  const add = (sid, dir) => {
    if (out.has(sid)) return
    const file = pickSessionFile(dir)
    out.set(sid, { dir, file })
  }
  if (!fs.existsSync(sessionsRoot)) return { map: out, error: 'sessions 目录不存在' }
  let buckets = []
  try {
    buckets = fs.readdirSync(sessionsRoot, { withFileTypes: true })
  } catch (err) {
    return { map: out, error: `读 sessions 目录失败：${err?.message ?? err}` }
  }
  for (const b of buckets) {
    if (!b.isDirectory()) continue
    const bdir = path.join(sessionsRoot, b.name)
    const bsid = normalizeSessionId(b.name)
    if (bsid) { add(bsid, bdir); continue } // 老扁平布局
    let children = []
    try {
      children = fs.readdirSync(bdir, { withFileTypes: true })
    } catch { continue }
    for (const c of children) {
      if (!c.isDirectory()) continue
      const sid = normalizeSessionId(c.name)
      if (sid) add(sid, path.join(bdir, c.name))
    }
  }
  return { map: out, error: null }
}

const GEN_RANK = [['v4', 5], ['v3', 4], ['v2', 3], ['v1', 2]]

function pickSessionFile(dir) {
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return null
  }
  const cands = names.filter((n) => /^session.*\.jsonl(\.zstd)?$/i.test(n))
  if (cands.length === 0) return null
  const rankOf = (n) => {
    for (const [tag, r] of GEN_RANK) if (n.toLowerCase().includes(`.${tag}.`)) return r
    return /\.zstd$/i.test(n) ? 1 : 0
  }
  const mtimeOf = (n) => {
    try { return fs.statSync(path.join(dir, n)).mtimeMs } catch { return 0 }
  }
  cands.sort((a, b) => (rankOf(b) - rankOf(a)) || (mtimeOf(b) - mtimeOf(a)))
  return path.join(dir, cands[0])
}

/** 归档树扫描：任何目录名若恰是会话 id 就记一条（不往里递归）；其余目录最多下探 3 层。 */
function scanPhysicalArchives(archiveRoot) {
  const unique = new Map()
  const perLane = { main: 0, card: 0 }
  let nonSessionDirs = 0
  if (!fs.existsSync(archiveRoot)) return { unique, perLane, nonSessionDirs, error: '归档根不存在' }

  const laneOf = (abs) => {
    const rel = path.relative(archiveRoot, abs).split(path.sep)
    return rel[0] === 'cards' ? 'card' : 'main'
  }
  const walk = (dir, depth) => {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const abs = path.join(dir, e.name)
      const sid = normalizeSessionId(e.name)
      if (sid) {
        const lane = laneOf(abs)
        perLane[lane] += 1
        const cur = unique.get(sid)
        if (cur) {
          cur.lanes.add(lane)
          cur.dirs.push(abs)
        } else {
          unique.set(sid, { sid, lanes: new Set([lane]), dirs: [abs] })
        }
        continue // 会话目录里不再下探
      }
      nonSessionDirs += 1
      if (depth < 3) walk(abs, depth + 1)
    }
  }
  walk(archiveRoot, 0)
  return { unique, perLane, nonSessionDirs, error: null }
}

/** 执行者台账：行数 / 坏行数 / 末条。 */
function readOpsLedger(file) {
  if (!fs.existsSync(file)) return { ok: false, exists: false, lines: 0, bad: 0, last: null, error: '台账文件不存在' }
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    return { ok: false, exists: true, lines: 0, bad: 0, last: null, error: `读台账失败：${err?.message ?? err}` }
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
  let bad = 0
  let last = null
  for (const line of lines) {
    try {
      last = JSON.parse(line)
    } catch {
      bad += 1
    }
  }
  return { ok: bad === 0, exists: true, lines: lines.length, bad, last, error: null }
}

/**
 * 卡执行会话 id 并集：看板账本 + 外部卡执行清单（**只读**）。
 *
 * 与插件 `ledgerExecutionSessions()` 同口径（自动档定档判据就靠这个集合）：
 *   ① 本地 `<home>\task-board\ledger-v2.json` 的 `tasks[].executions[].sessionId`
 *   ② 外部清单 `config.externalExecLedgers`（同一份 config 里就有；未配置时回落
 *      `<home>\multi-instance\card-sessions.json`）里的 `sessions[].sessionId` / 纯字符串数组
 *
 * 为什么要它（2026-11-06 · 第 5 棒现跑发现）：未分组里有一类会话 **cwd 就在卡会话目录、
 * 但 sid 不在账本里**（账本里的卡被删/历史被裁掉的孤儿）。插件 `classifySession()` 只认账本
 * ⇒ 这些落 **human 档** ⇒ 被 `humanOnlyHandoff`（标题必须含【已交接】）拦下，而它们又**没有标题**
 * ⇒ 现状**永远挂着**。本检查把它们单独数出来，免得下一次又当成"重启归组就好"。
 *
 * 读不到 ⇒ `ok:false`，上层只标「判不了」，**绝不猜**（与"证据缺失一律保守"同源）。
 */
function readExecutionSessionIds(home, config) {
  const ids = new Set()
  const ext = Array.isArray(config?.externalExecLedgers)
    ? config.externalExecLedgers.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim())
    : []
  const targets = [{ role: 'ledger', file: path.join(home, 'task-board', 'ledger-v2.json') }]
  if (ext.length > 0) for (const f of ext) targets.push({ role: 'external', file: f })
  else targets.push({ role: 'external', file: path.join(home, 'multi-instance', 'card-sessions.json') })

  const files = []
  for (const t of targets) {
    const rec = { role: t.role, file: t.file, ok: false, count: 0, reason: null }
    if (!fs.existsSync(t.file)) { rec.reason = '文件不存在'; files.push(rec); continue }
    const doc = readJsonSafe(t.file)
    if (doc === null) { rec.reason = '解析失败（不是合法 JSON）'; files.push(rec); continue }
    const before = ids.size
    let shapeError = null
    try {
      const take = (v) => { const n = normalizeSessionId(v); if (n) ids.add(n) }
      if (Array.isArray(doc?.tasks)) {
        for (const task of doc.tasks) {
          for (const e of Array.isArray(task?.executions) ? task.executions : []) take(e?.sessionId)
        }
      }
      const sess = Array.isArray(doc?.sessions) ? doc.sessions : (Array.isArray(doc) ? doc : null)
      if (sess) for (const s of sess) take(typeof s === 'string' ? s : s?.sessionId)
      if (!Array.isArray(doc?.tasks) && !sess) shapeError = '结构不认识（既无 tasks[] 也无 sessions[]）'
    } catch (err) {
      shapeError = `结构异常：${err?.message ?? err}`
    }
    if (shapeError) { rec.reason = shapeError; files.push(rec); continue }
    rec.ok = true
    rec.count = ids.size - before
    files.push(rec)
  }
  return { ok: files.some((f) => f.ok), ids, files }
}

// ── 联网（只读）─────────────────────────────────────────────────────────────

/** `session.list`：查「GUI 还看得见哪些会话」。读操作。超时重试一次（host 忙时偶发 20s 超时）。 */
async function fetchSessionList(baseUrl, timeoutMs) {
  let lastErr = null
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const r = await hostRpc(baseUrl, 'session.list', {}, { timeoutMs })
      const v = r?.body?.result?.value ?? r?.body?.value
      const items = Array.isArray(v?.items) ? v.items : null
      if (!items) throw new Error(`session.list 返回形状不认识（HTTP ${r?.status}）`)
      return { ok: true, items, error: null, attempts: attempt }
    } catch (err) {
      lastErr = err
      if (attempt === 1) await new Promise((res) => setTimeout(res, 2000))
    }
  }
  return { ok: false, items: [], error: lastErr?.message ?? String(lastErr), attempts: 2 }
}

/** 自动档配置 + 上轮状态：优先问活着的 host（权威 = 内存现值），取不到才回落磁盘 config。 */
async function fetchAutoConfig(baseUrl, archiveRoot, timeoutMs) {
  let httpError = null
  try {
    const res = await fetch(`${baseUrl}/api/dsh-archive-sessions/auto`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const j = await res.json()
    return { ok: true, source: 'http', config: j?.config ?? null, state: j?.state ?? null, error: null }
  } catch (err) {
    httpError = `HTTP 取配置失败：${err?.message ?? err}`
  }
  const doc = readJsonSafe(path.join(archiveRoot, '.auto-archive.json'))
  if (doc) {
    return { ok: true, source: 'file', config: doc.config ?? null, state: doc.state ?? null, error: httpError }
  }
  return { ok: false, source: 'none', config: null, state: null, error: httpError || '配置不可得' }
}

// ── 六项检查 ────────────────────────────────────────────────────────────────
// 每项返回 { id, key, name, status, readout, details }。**只判断、不动手。**

/** ① 归档名单与 ghost。 */
function checkGhost(ctx) {
  const ids = ctx.archived
  const phys = ctx.physical
  const readoutParts = []
  readoutParts.push(`名单 ${ids.rawCount} 条`)
  const totalDirs = phys.perLane.main + phys.perLane.card
  const dupDirs = Math.max(0, totalDirs - phys.unique.size)
  readoutParts.push(
    `归档树 ${totalDirs.toLocaleString('en-US')} 个会话目录 / ${phys.unique.size.toLocaleString('en-US')} 条去重会话`
    + `（主线 ${phys.perLane.main.toLocaleString('en-US')} · 卡 ${phys.perLane.card.toLocaleString('en-US')}`
    + `${dupDirs > 0 ? ` · ${dupDirs} 个同 id 跨批次重复目录` : ''}）`,
  )

  // fs 口径（物理 − 名单）：**只作背景读数，绝不据此判红**（历史批次噪音，现网数千条）
  const fsOnly = [...phys.unique.keys()].filter((sid) => !ids.set.has(sid)).length
  readoutParts.push(`fs 口径差 ${fsOnly.toLocaleString('en-US')}（历史噪音，非红）`)

  if (phys.error) {
    return mk(1, 'ghost', '归档名单与 ghost', STATUS.WARN, `归档根读不到（${phys.error}）⇒ 无法判定`, { error: phys.error })
  }
  if (!ctx.list.ok) {
    return mk(1, 'ghost', '归档名单与 ghost', STATUS.WARN,
      `${readoutParts.join(' · ')}｜session.list 不可达（${ctx.list.error}）⇒ ghost 三条件里的「仍可见」判不了，不给结论`,
      { archivedList: ids.rawCount, physical: phys.unique.size, fsOnlyDiff: fsOnly, listError: ctx.list.error })
  }

  const listSet = new Set()
  for (const it of ctx.list.items) {
    const sid = normalizeSessionId(it?.sessionId)
    if (sid) listSet.add(sid)
  }
  const ghosts = []
  for (const [sid, rec] of phys.unique) {
    if (ids.set.has(sid)) continue
    if (!listSet.has(sid)) continue
    ghosts.push({ sid, lanes: [...rec.lanes].sort(), hasLiveCopy: ctx.live.map.has(sid), dirs: rec.dirs })
  }
  const realGhosts = ghosts.filter((g) => !g.hasLiveCopy)
  const dupCopies = ghosts.filter((g) => g.hasLiveCopy)

  readoutParts.push(`ghost ${ghosts.length} 条 = 真 ghost ${realGhosts.length} + 双份残留 ${dupCopies.length}`)
  if (dupCopies.length > 0) {
    readoutParts.push('（双份 = `sessions\\` 里还有同尺寸副本，文件没丢，只是归档树多留了一份）')
  }
  const status0 = realGhosts.length > 0 ? STATUS.BAD : (dupCopies.length > 0 ? STATUS.WARN : STATUS.OK)
  // 默认分档：真 ghost（文件搬走了还挂在列表里）红；双份残留黄（要人拍板删哪一份，删 = 不可逆）。
  // `--strict` = 严格口径「ghost 必须 0」⇒ 只要 ghosts≠0 就红（按"必须 0"逐字判的人用这个）。
  const status = (ctx.ghostPolicy === 'strict' && ghosts.length > 0) ? STATUS.BAD : status0
  return mk(1, 'ghost', '归档名单与 ghost', status, readoutParts.join(' · '), {
    archivedList: ids.rawCount,
    physical: phys.unique.size,
    perLane: phys.perLane,
    fsOnlyDiff: fsOnly,
    ghostTotal: ghosts.length,
    realGhost: realGhosts.length,
    duplicateCopies: dupCopies.length,
    ghostPolicy: ctx.ghostPolicy ?? 'split',
    ghosts,
  })
}

/**
 * ② 自动档配置对齐：与**你自己给的期望值**逐项比对。
 *
 * 期望从哪来：`--expect-json <file>`（形状见 README「期望值文件」），或调用方直接塞 `ctx.expect`。
 * 🔴 **没给期望 ⇒ 只报现值、不判红/黄** —— 本工具不知道你的策略，不替你发明一条；
 *    给了期望才逐项比对（`config[]` 比单键、`allow.require/forbid` 比目录白名单）。
 */
const DEFAULT_EXPECT_SEVERITY = 'warn'

function checkAutoConfig(ctx) {
  const auto = ctx.auto
  if (!auto.ok || !auto.config) {
    return mk(2, 'autoConfig', '自动档配置对齐', STATUS.WARN,
      `自动档配置取不到（${auto.error ?? '无内容'}）⇒ 无法比对`, { error: auto.error, source: auto.source })
  }
  const cfg = auto.config
  const expect = ctx.expect ?? null
  const allow = Array.isArray(cfg.autoArchiveCwdAllow) ? cfg.autoArchiveCwdAllow.map(cwdKey) : []
  const allowText = Array.isArray(cfg.autoArchiveCwdAllow) && cfg.autoArchiveCwdAllow.length
    ? cfg.autoArchiveCwdAllow.join(' + ')
    : '（空）'
  const srcNote = auto.source === 'file' ? '（host 未响应，读的是磁盘 config）' : ''

  if (!expect) {
    return mk(2, 'autoConfig', '自动档配置对齐', STATUS.OK,
      `未配置期望值（--expect-json）⇒ 只报现值、不判红：allow = ${allowText}${srcNote}`,
      { config: cfg, deviations: [], expected: null, source: auto.source })
  }

  const sev = (s) => (s === STATUS.BAD || s === 'bad' ? STATUS.BAD : (s === STATUS.WARN || s === 'warn' ? STATUS.WARN : (s === STATUS.OK || s === 'ok' ? STATUS.OK : DEFAULT_EXPECT_SEVERITY === 'bad' ? STATUS.BAD : STATUS.WARN)))
  const normKey = (p) => cwdKey(p)
  const deviations = []
  for (const spec of Array.isArray(expect.config) ? expect.config : []) {
    if (!spec || typeof spec.key !== 'string') continue
    const actual = cfg[spec.key]
    const ok = typeof spec.want === 'boolean' ? actual === spec.want : Number(actual) === Number(spec.want)
    if (!ok) deviations.push({ key: spec.key, expected: spec.want, actual: actual ?? null, severity: sev(spec.severity) })
  }
  const require = Array.isArray(expect.allow?.require) ? expect.allow.require.map(normKey) : []
  const forbid = Array.isArray(expect.allow?.forbid) ? expect.allow.forbid.map(normKey) : []
  const missingRequired = require.filter((p) => !allow.includes(p))
  const forbidden = allow.filter((p) => forbid.includes(p))
  const extra = allow.filter((p) => !require.includes(p) && !forbid.includes(p))
  for (const p of missingRequired) deviations.push({ key: 'autoArchiveCwdAllow', expected: `含 ${p}`, actual: '缺', severity: STATUS.WARN })
  for (const p of forbidden) deviations.push({ key: 'autoArchiveCwdAllow', expected: `不含 ${p}`, actual: p, severity: STATUS.BAD })
  for (const p of extra) deviations.push({ key: 'autoArchiveCwdAllow', expected: '不在期望清单里', actual: p, severity: STATUS.WARN })

  const worst = deviations.reduce((acc, d) => (RANK[d.severity] > RANK[acc] ? d.severity : acc), STATUS.OK)
  if (deviations.length === 0) {
    return mk(2, 'autoConfig', '自动档配置对齐', STATUS.OK,
      `期望值逐项相等（${(expect.config ?? []).length} 键 + allow ${require.length}/${forbid.length}）· allow = ${allowText}${srcNote}`,
      { config: cfg, deviations: [], expected: expect, source: auto.source })
  }
  const devText = deviations.map((d) => `${d.key} ${JSON.stringify(d.actual)}≠${JSON.stringify(d.expected)}${d.severity === STATUS.BAD ? '🔴' : '⚠️'}`).join('；')
  return mk(2, 'autoConfig', '自动档配置对齐', worst, `偏差 ${deviations.length} 项：${devText}${srcNote}`,
    { config: cfg, deviations, expected: expect, source: auto.source })
}

/** ③ 上一轮自动档行为。 */
function checkLastAutoRun(ctx) {
  const auto = ctx.auto
  const lr = auto.state?.lastResult ?? null
  if (!auto.ok || !lr) {
    return mk(3, 'lastAutoRun', '上一轮自动档行为', STATUS.WARN,
      `读不到上一轮结果（${auto.error ?? 'state.lastResult 缺失'}）⇒ 自动档是否真的在按判据跑无从判断`,
      { error: auto.error })
  }
  const byClass = lr.byClass ?? null
  if (!byClass || !byClass.human || !byClass.card || !byClass.subagent) {
    return mk(3, 'lastAutoRun', '上一轮自动档行为', STATUS.WARN,
      `上一轮结果形状不认识（byClass 缺项）⇒ 判不了`, { lastResultKeys: Object.keys(lr) })
  }
  const human = byClass.human
  const skippedHumanNotHanded = Number(lr.skippedHumanNotHanded ?? 0)
  const lines = [
    `human ${human.passed}/${human.candidates}`,
    `card ${byClass.card.passed}/${byClass.card.candidates}`,
    `subagent ${byClass.subagent.passed}/${byClass.subagent.candidates}`,
  ]
  const skipped = [
    `skippedHumanNotHanded ${skippedHumanNotHanded}`,
    `skippedAlreadyArchived ${Number(lr.skippedAlreadyArchived ?? 0)}`,
    `skippedCwdNotAllowed ${Number(lr.skippedCwdNotAllowed ?? 0)}`,
  ]
  const when = Number.isFinite(Number(lr.startedAt)) ? fmtLocal(new Date(Number(lr.startedAt))) : '未知时刻'
  const head = `上轮 ${when} · 档位 passed/candidates：${lines.join(' · ')} ｜ ${skipped.join(' · ')}`

  // 🔴 humanOnlyHandoff 疑似被关：human 档过了时间闸（passed>0）却一条都没被「未交接」挡住
  if (skippedHumanNotHanded === 0 && Number(human.passed) > 0) {
    return mk(3, 'lastAutoRun', '上一轮自动档行为', STATUS.BAD,
      `${head} ⇒ human 档 passed>0 且 skippedHumanNotHanded=0：humanOnlyHandoff 疑似被关（主线会被无交接就收走）`,
      { byClass, skippedHumanNotHanded, skippedAlreadyArchived: lr.skippedAlreadyArchived, skippedCwdNotAllowed: lr.skippedCwdNotAllowed, dryRun: lr.dryRun === true })
  }
  // ⚠️ 上一轮其实是 dryRun 预览（配置是 false）⇒ 那轮读数不能当「自动档真实轮次」的证据
  if (lr.dryRun === true) {
    return mk(3, 'lastAutoRun', '上一轮自动档行为', STATUS.WARN,
      `${head} —— 但这一轮是 **dryRun 预览**（未搬任何文件）⇒ 自动档真实轮次读数缺失，别拿它当生产读数`,
      { byClass, skippedHumanNotHanded, skippedAlreadyArchived: lr.skippedAlreadyArchived, skippedCwdNotAllowed: lr.skippedCwdNotAllowed, dryRun: true })
  }
  return mk(3, 'lastAutoRun', '上一轮自动档行为', STATUS.OK, head,
    { byClass, skippedHumanNotHanded, skippedAlreadyArchived: lr.skippedAlreadyArchived, skippedCwdNotAllowed: lr.skippedCwdNotAllowed, dryRun: false })
}

/** ④ 未分组会话（非子代理 ∧ 不在任何工作区 sessionIds ∧ 不在归档名单）。 */
function checkUngrouped(ctx) {
  if (!ctx.list.ok) {
    return mk(4, 'ungrouped', '未分组会话', STATUS.WARN,
      `session.list 不可达（${ctx.list.error}）⇒ 未分组判不了`, { error: ctx.list.error })
  }
  const wsIds = new Set()
  for (const w of ctx.workspaces.list) for (const sid of w.sessionIds) {
    const n = normalizeSessionId(sid)
    if (n) wsIds.add(n)
  }
  const arch = ctx.archived.set
  const pool = []
  for (const it of ctx.list.items) {
    const sid = normalizeSessionId(it?.sessionId)
    if (!sid) continue
    if (arch.has(sid)) continue
    if (wsIds.has(sid)) continue
    pool.push({ sid, item: it })
  }

  const ledger = ctx.ledger ?? { ok: false, ids: new Set(), files: [] }
  const cardKey = cwdKey(ctx.cardSessionsDir ?? 'card-sessions')
  const wsPaths = new Set()
  for (const w of ctx.workspaces.list) {
    const k = cwdKey(w.path)
    if (k) wsPaths.add(k)
  }

  const rows = []
  let headerMissing = 0
  for (const { sid, item } of pool) {
    const live = ctx.live.map.get(sid) ?? null
    const header = live?.file ? readSessionHeader(live.file) : null
    if (live?.file && !header) headerMissing += 1
    // 子代理判据：首帧 origin==='subagent' 或 delegationDepth>0（读不到首帧才回落 list 的 origin）
    const isSubagent = header
      ? (header.origin === 'subagent' || (header.delegationDepth !== null && header.delegationDepth > 0))
      : (item?.origin === 'subagent')
    if (isSubagent) continue
    const cwd = item?.cwd ?? header?.cwd ?? null
    const key = cwdKey(cwd)
    // 账本读不到 ⇒ inLedger = null（判不了），绝不按 false 处理（那会把它们全算成「孤儿」）
    const inLedger = ledger.ok ? ledger.ids.has(sid) : null
    rows.push({
      sid,
      cwd,
      title: item?.projections?.values?.title ?? null,
      blank: item?.blank === true,
      running: item?.running === true,
      hasHeader: header !== null,
      inLedger,
      // 孤儿卡会话：cwd 在卡会话目录 ∧ 不在看板账本（插件会当 human 档 ⇒ 被【已交接】闸拦住）
      orphanCard: inLedger === false && cardKey !== '' && (key === cardKey || key.endsWith('\\' + cardKey)),
      // 重启归组预测：cwd 恰好等于某个现存工作区的 path（bootstrap 就是按这个配对）
      willGroup: key !== '' && wsPaths.has(key),
    })
  }
  rows.sort((a, b) => String(a.cwd).localeCompare(String(b.cwd)) || a.sid.localeCompare(b.sid))

  const subagentFiltered = pool.length - rows.length
  const orphanCards = rows.filter((r) => r.orphanCard)
  const willGroup = rows.filter((r) => r.willGroup).length
  const staying = rows.length - willGroup
  const ledgerNote = ledger.ok ? '' : `· 账本读不到（${(ledger.files || []).map((f) => f.reason).filter(Boolean).join('；') || '未知'}）⇒ 孤儿卡会话判不了`
  const head = `${rows.length} 条未分组（池 ${pool.length} 条，其中 ${subagentFiltered} 条 subagent 派生已排除${headerMissing ? ` · ${headerMissing} 条首帧解不出、按 list origin 降级判` : ''}${ledgerNote ? ` ${ledgerNote}` : ''}）`
  const extra = {
    count: rows.length,
    rows,
    subagentFiltered,
    headerMissing,
    ledgerOk: ledger.ok === true,
    orphanCard: orphanCards.length,
    willGroupOnRestart: willGroup,
    stayUngroupedAfterRestart: staying,
  }
  if (rows.length === 0) {
    return mk(4, 'ungrouped', '未分组会话', STATUS.OK, head, { ...extra, rows: [] })
  }
  const orphanText = orphanCards.length > 0
    ? `｜其中 ${orphanCards.length} 条是「cwd 在卡会话目录、却不在看板账本」的孤儿卡会话 ⇒ 自动档按 human 档要求【已交接】，它们标题里通常是【完成】（不是【已交接】）⇒ **现状会一直挂着**（要收得先定档判据）`
    : ''
  const restartText = `｜重启后预计归组 ${willGroup} 条、仍留 ${staying} 条（cwd 不匹配任何工作区）`
  return mk(4, 'ungrouped', '未分组会话', STATUS.WARN,
    `${head}${orphanText}${restartText} ⇒ 归组需要重启 dsh（bootstrap 按 header.cwd 补），运行中改 workspace.json 会被 host 内存写回`,
    extra)
}

/** ⑤ 执行者台账健康。 */
function checkOpsLedger(ctx) {
  const ops = ctx.ops
  if (!ops.exists) {
    return mk(5, 'opsLedger', '执行者台账健康', STATUS.WARN, `台账不存在（${ops.error}）⇒ 归档动作无审计轨迹`, { error: ops.error })
  }
  if (ops.error) {
    return mk(5, 'opsLedger', '执行者台账健康', STATUS.WARN, ops.error, { error: ops.error })
  }
  const last = ops.last ?? null
  let lastText = '（末条不可解析）'
  if (last) {
    const ts = last.ts ? fmtLocal(new Date(last.ts)) : '无 ts'
    lastText = `末条 ${ts} · ${last.action ?? '?'} · ${shortSid(last.sid)}`
  }
  const status = ops.bad === 0 ? STATUS.OK : STATUS.WARN
  return mk(5, 'opsLedger', '执行者台账健康', status, `${ops.lines} 行 · 坏行 ${ops.bad} · ${lastText}`,
    { lines: ops.lines, bad: ops.bad, last })
}

/** ⑥ 插件源 ↔ 部署副本一致。 */
function checkPluginParity(ctx) {
  const p = ctx.plugin ?? {}
  // 外部安装没有「源树 ↔ profile 部署副本」这一对 ⇒ 默认 N/A（✅，不算黄），要查得显式传两个路径。
  if (p.enabled !== true) {
    return mk(6, 'pluginParity', '源 ↔ 部署副本一致', STATUS.OK,
      '未启用（外部安装没有源树；要查请同时传 --plugin-src 与 --plugin-dep）', { enabled: false })
  }
  if (!p.srcSha) {
    return mk(6, 'pluginParity', '源 ↔ 部署副本一致', STATUS.WARN, `读不到插件源码 ${p.src}`, { src: p.src, dep: p.dep, error: p.error })
  }
  if (!p.depSha) {
    return mk(6, 'pluginParity', '源 ↔ 部署副本一致', STATUS.BAD,
      `部署副本不存在或读不到（${p.dep}）⇒ 插件没装 / 被删，源码与线上不一致`,
      { src: p.src, dep: p.dep, srcSha: p.srcSha, depSha: null })
  }
  if (p.srcSha === p.depSha) {
    return mk(6, 'pluginParity', '源 ↔ 部署副本一致', STATUS.OK, `sha256 相同 ${p.srcSha.slice(0, 12)}（${p.bytesLabel}）`,
      { src: p.src, dep: p.dep, srcSha: p.srcSha, depSha: p.depSha })
  }
  return mk(6, 'pluginParity', '源 ↔ 部署副本一致', STATUS.BAD,
    `sha256 不同：源 ${p.srcSha.slice(0, 12)} / 部署 ${p.depSha.slice(0, 12)} ⇒ 改了源码没 deploy，或 deploy 了没同步源`,
    { src: p.src, dep: p.dep, srcSha: p.srcSha, depSha: p.depSha })
}

function mk(id, key, name, status, readout, details) {
  return { id, key, name, status, readout, details: details ?? {} }
}

const CHECKS = [
  ['ghost', checkGhost],
  ['autoConfig', checkAutoConfig],
  ['lastAutoRun', checkLastAutoRun],
  ['ungrouped', checkUngrouped],
  ['opsLedger', checkOpsLedger],
  ['pluginParity', checkPluginParity],
]

function runChecks(ctx) {
  const checks = CHECKS.map(([, fn]) => fn(ctx))
  const counts = { ok: 0, warn: 0, bad: 0 }
  for (const c of checks) counts[c.status] += 1
  const overall = counts.bad > 0 ? STATUS.BAD : (counts.warn > 0 ? STATUS.WARN : STATUS.OK)
  return { checks, counts, overall }
}

// ── 现网上下文的装载 ────────────────────────────────────────────────────────

async function gatherContext(opts) {
  const home = opts.home
  const archiveRoot = path.join(home, '_archived-sessions')
  const sessionsRoot = path.join(home, 'sessions')

  const wsDoc = readJsonSafe(path.join(home, 'storages', 'workspace.json'))
  const rawIds = Array.isArray(wsDoc?.global?.archivedSessionIds) ? wsDoc.global.archivedSessionIds : []
  const idsSet = new Set()
  for (const raw of rawIds) {
    const n = normalizeSessionId(raw)
    if (n) idsSet.add(n)
    else if (typeof raw === 'string' && raw) idsSet.add(raw.toLowerCase())
  }

  const workspaces = []
  for (const [, w] of Object.entries(wsDoc?.tables?.workspaces ?? {})) {
    workspaces.push({
      id: w?.id ?? null,
      path: w?.path ?? null,
      title: w?.title ?? null,
      sessionIds: Array.isArray(w?.sessionIds) ? w.sessionIds : [],
    })
  }

  const [list, auto] = await Promise.all([
    fetchSessionList(opts.baseUrl, opts.timeoutMs),
    fetchAutoConfig(opts.baseUrl, archiveRoot, opts.timeoutMs),
  ])

  const pluginEnabled = opts.pluginEnabled === true && Boolean(opts.pluginSrc) && Boolean(opts.pluginDep)
  const srcSha = pluginEnabled ? sha256(opts.pluginSrc) : null
  const depSha = pluginEnabled ? sha256(opts.pluginDep) : null
  let bytesLabel = '大小未知'
  if (pluginEnabled) {
    try {
      bytesLabel = `${fs.statSync(opts.pluginSrc).size.toLocaleString('en-US')} B`
    } catch { /* ignore */ }
  }

  return {
    home,
    baseUrl: opts.baseUrl,
    ghostPolicy: opts.ghostPolicy ?? 'split',
    workspace: { doc: wsDoc, error: wsDoc ? null : 'workspace.json 读不到或不是 JSON' },
    archived: { rawCount: rawIds.length, set: idsSet },
    workspaces: { list: workspaces },
    // 卡执行会话 id 并集（未分组检查判「孤儿卡会话」用；配置取活着 host 的那份，取不到用磁盘那份）
    ledger: readExecutionSessionIds(home, auto?.config ?? readJsonSafe(path.join(archiveRoot, '.auto-archive.json'))?.config ?? null),
    physical: scanPhysicalArchives(archiveRoot),
    live: indexLiveSessions(sessionsRoot),
    list,
    auto,
    ops: readOpsLedger(path.join(archiveRoot, 'archive-session-ops.jsonl')),
    plugin: { enabled: pluginEnabled, src: opts.pluginSrc, dep: opts.pluginDep, srcSha, depSha, bytesLabel, error: srcSha ? null : '源文件读不到' },
    cardSessionsDir: opts.cardSessionsDir ?? 'card-sessions',
    expect: opts.expect ?? null,
  }
}

// ── 输出 ────────────────────────────────────────────────────────────────────

function buildReport(ctx, result) {
  return {
    generatedAt: new Date().toISOString(),
    generatedAtLocal: fmtLocal(new Date()),
    tool: 'session-archive-health',
    version: 1,
    mode: 'observe',
    home: ctx.home,
    baseUrl: ctx.baseUrl,
    listSource: ctx.list.ok ? 'host-rpc(session.list)' : 'unavailable',
    autoSource: ctx.auto.source,
    ghostPolicy: ctx.ghostPolicy ?? 'split',
    overall: result.overall,
    counts: result.counts,
    exitCode: result.overall === STATUS.OK ? 0 : 3,
    checks: result.checks,
  }
}

function printHuman(report) {
  const L = []
  L.push(`会话归档健康自检（observe · 只读）  ${report.generatedAtLocal}`)
  L.push(`home ${report.home}  ·  host ${report.baseUrl}`)
  L.push('─'.repeat(72))
  for (const c of report.checks) {
    L.push(`${c.id} ${ICON[c.status]} ${c.name}`)
    L.push(`   ${c.readout}`)
    if (c.key === 'ungrouped' && Array.isArray(c.details.rows) && c.details.rows.length > 0) {
      for (const r of c.details.rows) {
        const flags = [
          r.blank ? '空壳' : null,
          r.running ? '运行中' : null,
          r.hasHeader === false ? '首帧未解出' : null,
          r.orphanCard ? '孤儿卡会话·账本无' : null,
          r.inLedger === null ? '账本读不到' : null,
          r.willGroup ? '重启后归组' : '重启后仍留',
        ].filter(Boolean).join('·')
        L.push(`   · ${r.sid}  ${r.cwd ?? '（无 cwd）'}  ${r.title ? JSON.stringify(r.title) : '（无标题）'}${flags ? `  [${flags}]` : ''}`)
      }
    }
    if (c.key === 'ghost' && Array.isArray(c.details.ghosts) && c.details.ghosts.length > 0) {
      for (const g of c.details.ghosts) {
        L.push(`   · ${g.sid}  ${g.hasLiveCopy ? '双份（sessions\\ 仍有副本）' : '真 ghost（sessions\\ 已无副本）'}  [${g.lanes.join('/')}]`)
      }
    }
    if (c.key === 'autoConfig' && Array.isArray(c.details.deviations) && c.details.deviations.length > 0) {
      for (const d of c.details.deviations) {
        L.push(`   · ${d.key}: 现值 ${JSON.stringify(d.actual)} / 期望 ${JSON.stringify(d.expected)}  ${ICON[d.severity]}`)
      }
    }
  }
  L.push('─'.repeat(72))
  L.push(`结论：${report.counts.ok} ✅ · ${report.counts.warn} ⚠️ · ${report.counts.bad} 🔴 ⇒ rc ${report.exitCode}` +
    (report.exitCode === 0 ? '（六项全绿）' : '（observe 档：只报告，不修；要修另开卡）'))
  if (report.ghostPolicy === 'strict') L.push('ghost 口径：--strict（「必须 0」，双份残留也算红）')
  console.log(L.join('\n'))
}

// ── 夹具自测（唯一会写盘的地方）──────────────────────────────────────────────

function makeTmpBase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-health-selftest-'))
  return fs.realpathSync(dir)
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8')
}

/** 写一条假会话目录：header 走 zstd 单帧（真压真解，逼着代码走拆帧路径）。 */
function writeFakeSession(home, sid, header, opts = {}) {
  const bucket = opts.bucket ?? 'bucket-1'
  const dir = path.join(home, 'sessions', bucket, sid)
  fs.mkdirSync(dir, { recursive: true })
  const headerLine = JSON.stringify({ type: 'session', id: sid, cwd: opts.cwd ?? path.join(home, 'ws'), ...header })
  const body = `${headerLine}\n{"type":"user/message","data":{"content":[{"type":"text","text":"夹具"}]}}\n`
  if (opts.plain) {
    fs.writeFileSync(path.join(dir, 'session.jsonl'), body, 'utf8')
    return path.join(dir, 'session.jsonl')
  }
  const z = zstdCompressSync(Buffer.from(body, 'utf8'))
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  fs.writeFileSync(file, z)
  return file
}

function writeFakeArchive(home, sid, opts = {}) {
  const batch = opts.batch ?? '20261105-b1'
  const laneDir = opts.lane === 'card' ? path.join(home, '_archived-sessions', 'cards', batch) : path.join(home, '_archived-sessions', batch)
  const dir = path.join(laneDir, sid)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from('{"type":"session"}\n', 'utf8')))
  return dir
}

function listItem(sid, extra = {}) {
  return {
    sessionId: sid,
    running: false,
    blank: false,
    origin: null,
    cwd: null,
    projections: { values: { title: '夹具标题' } },
    ...extra,
  }
}

/**
 * 自测：两套夹具。
 *   A 套（全绿）—— 六项都应 ✅。
 *   B 套（脏）—— 每项都必须能翻出 ⚠️ / 🔴（ghost 真条 / 配置越界 / humanOnlyHandoff 丢失 /
 *                未分组含一个 zstd 首帧判出的 subagent / 台账坏行 / 插件 sha 分叉）。
 */
/**
 * 夹具会话 id：**源码里不出现 uuid 字面量**（公开仓的脱敏扫描会把 uuid 形状判成真实会话 id），
 * 由标签派生 ⇒ 形状合法（插件按 uuid 归一化）、内容与任何真实会话无关。
 */
const SID = (tag) => {
  const h = crypto.createHash('sha1').update(String(tag)).digest('hex')
  return `session-${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

function runSelfTest() {
  const results = []
  const assert = (name, cond, detail) => {
    results.push({ name, ok: !!cond, detail: detail ?? '' })
    console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
  }

  const tmp = makeTmpBase()
  try {
    // 夹具目录一律从临时目录派生 —— 仓内的静态扫描禁源码里出现绝对路径（注释除外）。
    const WS = path.join(tmp, 'ws')
    const WS_CARD = path.join(WS, 'card-sessions')
    const WS_CHAT = path.join(WS, 'chat')
    const WS_OTHER = path.join(tmp, 'other')
    const WS_OTHER2 = path.join(tmp, 'other2')
    // 期望值：与「自动档配置对齐」那项逐键比对（形状 = --expect-json）
    const EXPECT_FIXTURE = {
      config: [
        { key: 'enabled', want: true, severity: 'bad' },
        { key: 'dryRun', want: false, severity: 'warn' },
        { key: 'hours', want: 1, severity: 'warn' },
        { key: 'humanOnlyHandoff', want: true, severity: 'bad' },
        { key: 'hoursCard', want: 2, severity: 'warn' },
        { key: 'hoursSubagent', want: 2, severity: 'warn' },
        { key: 'activeHoldHours', want: 2, severity: 'warn' },
        { key: 'moveFiles', want: false, severity: 'bad' },
        { key: 'protectOpenCards', want: true, severity: 'bad' },
      ],
      allow: { require: [WS, WS_CARD], forbid: [WS_OTHER, WS_OTHER2] },
    }
    const homeA = path.join(tmp, 'caseA')
    const pluginA = path.join(tmp, 'pluginA')
    fs.mkdirSync(homeA, { recursive: true })
    fs.mkdirSync(path.join(pluginA, 'src'), { recursive: true })
    fs.mkdirSync(path.join(pluginA, 'dep'), { recursive: true })

    // ── A 套：全绿 ──
    writeJson(path.join(homeA, 'storages', 'workspace.json'), {
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: ['w1'], archivedSessionIds: [SID('archived-main')] },
      tables: {
        workspaces: {
          w1: { id: 'w1', path: WS, title: 'dsh-workspace', sessionIds: [SID('live-in-ws')] },
        },
      },
    })
    writeFakeArchive(homeA, SID('archived-main'), { lane: 'main' })
    const liveFileA = writeFakeSession(homeA, SID('live-in-ws'), {})
    writeFakeArchive(homeA, SID('archive-not-listed'), { lane: 'card' }) // 在归档树、不在名单、也不在 list ⇒ 不算 ghost
    writeJson(path.join(homeA, '_archived-sessions', '.auto-archive.json'), {
      config: {
        enabled: true, dryRun: false, hours: 1, hoursCard: 2, hoursSubagent: 2, activeHoldHours: 2,
        humanOnlyHandoff: true, moveFiles: false, protectOpenCards: true,
        autoArchiveCwdAllow: [WS, WS_CARD],
      },
      state: {
        lastResult: {
          startedAt: Date.now() - 3600_000,
          dryRun: false,
          skippedHumanNotHanded: 3,
          skippedAlreadyArchived: 301,
          skippedCwdNotAllowed: 14,
          byClass: {
            human: { passed: 5, candidates: 2 },
            card: { passed: 1, candidates: 1 },
            subagent: { passed: 0, candidates: 0 },
          },
        },
      },
    })
    const opsLinesA = [
      { ts: '2026-11-05T09:57:19.556Z', action: 'archive-move', sid: SID('archived-main') },
      { ts: '2026-11-05T10:00:00.000Z', action: 'archive-marker', sid: SID('archive-not-listed') },
    ]
    fs.writeFileSync(path.join(homeA, '_archived-sessions', 'archive-session-ops.jsonl'),
      opsLinesA.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
    fs.writeFileSync(path.join(pluginA, 'src', 'index.js'), '// fixture plugin\n', 'utf8')
    fs.writeFileSync(path.join(pluginA, 'dep', 'index.js'), '// fixture plugin\n', 'utf8')

    const ctxA = {
      home: homeA,
      baseUrl: 'http://127.0.0.1:3080',
      expect: EXPECT_FIXTURE,
      cardSessionsDir: 'card-sessions',
      archived: { rawCount: 1, set: new Set([SID('archived-main')]) },
      workspaces: { list: [{ path: WS, sessionIds: [SID('live-in-ws')] }] },
      ledger: { ok: true, ids: new Set(), files: [] },
      physical: scanPhysicalArchives(path.join(homeA, '_archived-sessions')),
      live: indexLiveSessions(path.join(homeA, 'sessions')),
      list: { ok: true, items: [listItem(SID('live-in-ws'), { cwd: WS })], error: null },
      auto: {
        ok: true,
        source: 'http',
        config: {
          enabled: true, dryRun: false, hours: 1, hoursCard: 2, hoursSubagent: 2, activeHoldHours: 2,
          humanOnlyHandoff: true, moveFiles: false, protectOpenCards: true,
          autoArchiveCwdAllow: [WS, WS_CARD],
        },
        state: {
          lastResult: {
            startedAt: Date.now() - 3600_000, dryRun: false, skippedHumanNotHanded: 3,
            skippedAlreadyArchived: 301, skippedCwdNotAllowed: 14,
            byClass: { human: { passed: 5, candidates: 2 }, card: { passed: 1, candidates: 1 }, subagent: { passed: 0, candidates: 0 } },
          },
        },
        error: null,
      },
      ops: readOpsLedger(path.join(homeA, '_archived-sessions', 'archive-session-ops.jsonl')),
      plugin: {
        enabled: true,
        src: path.join(pluginA, 'src', 'index.js'),
        dep: path.join(pluginA, 'dep', 'index.js'),
        srcSha: sha256(path.join(pluginA, 'src', 'index.js')),
        depSha: sha256(path.join(pluginA, 'dep', 'index.js')),
        bytesLabel: '16 B',
        error: null,
      },
    }
    const rA = runChecks(ctxA)
    for (const c of rA.checks) assert(`A · ${c.id} ${c.name} ⇒ ✅`, c.status === STATUS.OK, `实际 ${c.status}`)
    assert('A · 六项齐全', rA.checks.length === 6 && rA.checks.map((c) => c.id).join(',') === '1,2,3,4,5,6')
    assert('A · 整体 ok ⇒ rc 0', rA.overall === STATUS.OK && buildReport(ctxA, rA).exitCode === 0)
    assert('A · 归档树里那条（不在名单/list）不算 ghost', rA.checks[0].details.ghostTotal === 0, `ghostTotal=${rA.checks[0].details.ghostTotal}`)
    assert('A · zstd 首帧能解出会话头', readSessionHeader(liveFileA) !== null)

    // ── B 套：每项都得能翻红/黄 ──
    const homeB = path.join(tmp, 'caseB')
    const pluginB = path.join(tmp, 'pluginB')
    fs.mkdirSync(homeB, { recursive: true })
    fs.mkdirSync(path.join(pluginB, 'src'), { recursive: true })
    fs.mkdirSync(path.join(pluginB, 'dep'), { recursive: true })

    const G1 = SID('ghost-real') // 真 ghost（归档树有、名单无、list 有、sessions 无）
    const G2 = SID('ghost-dup') // 双份（归档树 + sessions 都有）
    const UG = SID('ungrouped-human') // 未分组 human
    const SA = SID('ungrouped-subagent') // 未分组 subagent（首帧判）
    const WS1 = SID('grouped-ok') // 正常归组
    writeFakeArchive(homeB, G1, { lane: 'main' })
    writeFakeArchive(homeB, G2, { lane: 'card' })
    writeFakeSession(homeB, G2, {})
    writeFakeSession(homeB, UG, {})
    writeFakeSession(homeB, SA, { origin: 'subagent', delegationDepth: 1 })
    writeFakeSession(homeB, WS1, { plain: true })
    writeJson(path.join(homeB, 'storages', 'workspace.json'), {
      global: { archivedSessionIds: [] },
      tables: { workspaces: { w1: { path: WS, sessionIds: [WS1] } } },
    })
    const configB = {
      enabled: true, dryRun: true, hours: 3, hoursCard: 2, hoursSubagent: 6, activeHoldHours: 2,
      humanOnlyHandoff: false, moveFiles: true, protectOpenCards: false,
      autoArchiveCwdAllow: [WS, WS_OTHER],
    }
    writeJson(path.join(homeB, '_archived-sessions', '.auto-archive.json'), {
      config: configB,
      state: {
        lastResult: {
          startedAt: Date.now() - 7200_000, dryRun: false, skippedHumanNotHanded: 0,
          skippedAlreadyArchived: 0, skippedCwdNotAllowed: 0,
          byClass: { human: { passed: 7, candidates: 0 }, card: { passed: 0, candidates: 0 }, subagent: { passed: 0, candidates: 0 } },
        },
      },
    })
    const opsLinesB = [
      { ts: '2026-11-05T09:00:00.000Z', action: 'archive-move', sid: SID('ghost-real') },
    ]
    fs.writeFileSync(path.join(homeB, '_archived-sessions', 'archive-session-ops.jsonl'),
      opsLinesB.map((r) => JSON.stringify(r)).join('\n') + '\n' + '{broken json\n', 'utf8')
    fs.writeFileSync(path.join(pluginB, 'src', 'index.js'), '// fixture plugin A\n', 'utf8')
    fs.writeFileSync(path.join(pluginB, 'dep', 'index.js'), '// fixture plugin B\n', 'utf8')

    const ctxB = {
      home: homeB,
      baseUrl: 'http://127.0.0.1:3080',
      expect: EXPECT_FIXTURE,
      cardSessionsDir: 'card-sessions',
      archived: { rawCount: 0, set: new Set() },
      workspaces: { list: [{ path: WS, sessionIds: [WS1] }] },
      ledger: { ok: true, ids: new Set(), files: [] },
      physical: scanPhysicalArchives(path.join(homeB, '_archived-sessions')),
      live: indexLiveSessions(path.join(homeB, 'sessions')),
      list: {
        ok: true,
        items: [listItem(G1, { cwd: WS_CARD }), listItem(G2, { cwd: WS }), listItem(UG, { cwd: WS_CHAT, projections: { values: { title: null } } }), listItem(SA, { origin: 'subagent' }), listItem(WS1, { cwd: WS })],
        error: null,
      },
      auto: { ok: true, source: 'http', config: configB, state: readJsonSafe(path.join(homeB, '_archived-sessions', '.auto-archive.json')).state, error: null },
      ops: readOpsLedger(path.join(homeB, '_archived-sessions', 'archive-session-ops.jsonl')),
      plugin: {
        enabled: true,
        src: path.join(pluginB, 'src', 'index.js'),
        dep: path.join(pluginB, 'dep', 'index.js'),
        srcSha: sha256(path.join(pluginB, 'src', 'index.js')),
        depSha: sha256(path.join(pluginB, 'dep', 'index.js')),
        bytesLabel: '18 B',
        error: null,
      },
    }
    const rB = runChecks(ctxB)
    const byId = (n) => rB.checks.find((c) => c.id === n)

    assert('B1 · ghost 有真条 ⇒ 🔴', byId(1).status === STATUS.BAD && byId(1).details.realGhost === 1 && byId(1).details.duplicateCopies === 1,
      `真 ${byId(1).details.realGhost} / 双份 ${byId(1).details.duplicateCopies}`)
    assert('B2 · 配置越界 + 红线关掉 ⇒ 🔴', byId(2).status === STATUS.BAD && byId(2).details.deviations.length >= 4,
      `偏差 ${byId(2).details.deviations.length} 项`)
    assert('B3 · humanOnlyHandoff 失效 ⇒ 🔴', byId(3).status === STATUS.BAD)
    // 池 = G1 / G2 / UG / SA（WS1 已归组 ⇒ 不算）；SA 靠**首帧**判成 subagent ⇒ 只剩 3 条
    const rowsB = byId(4).details.rows ?? []
    assert('B4 · 未分组只数非子代理（subagent 被首帧排除）⇒ ⚠️',
      byId(4).status === STATUS.WARN && rowsB.length === 3 && rowsB.some((r) => r.sid === UG) && !rowsB.some((r) => r.sid === SA),
      `count=${rowsB.length} 含 UG=${rowsB.some((r) => r.sid === UG)} 含 SA=${rowsB.some((r) => r.sid === SA)}`)
    assert('B5 · 台账坏行 ⇒ ⚠️', byId(5).status === STATUS.WARN && byId(5).details.bad === 1)
    assert('B6 · 插件 sha 分叉 ⇒ 🔴', byId(6).status === STATUS.BAD)
    assert('B · 整体 bad ⇒ rc 3', rB.overall === STATUS.BAD && buildReport(ctxB, rB).exitCode === 3)

    // ── E：未分组的两条新投影（孤儿卡会话 / 重启归组预测）—— 2026-11-06 现网撞出来的那一类 ──
    //    G1 cwd=<ws>/card-sessions 且不在看板账本 ⇒ 孤儿卡会话（插件当 human 档 ⇒ 被【已交接】拦住）
    const eDetails = byId(4).details
    assert('E1 · cwd 在卡会话目录 ∧ 不在账本 ⇒ 判孤儿卡会话',
      eDetails.orphanCard === 1 && rowsB.find((r) => r.sid === G1)?.orphanCard === true,
      `orphanCard=${eDetails.orphanCard}`)
    //    阴性对照：同一条进了账本 ⇒ 不算孤儿（否则清完还喊）
    const dE2 = runChecks({ ...ctxB, ledger: { ok: true, ids: new Set([G1]), files: [] } }).checks.find((c) => c.id === 4)
    assert('E2 · 同一条进了看板账本 ⇒ 不再算孤儿（阴性对照）', dE2.details.orphanCard === 0, `orphanCard=${dE2.details.orphanCard}`)
    //    账本读不到 ⇒ 判不了（绝不能把全部未分组都算成孤儿）
    const dE3 = runChecks({ ...ctxB, ledger: { ok: false, ids: new Set(), files: [{ role: 'ledger', file: 'X', ok: false, count: 0, reason: '文件不存在' }] } }).checks.find((c) => c.id === 4)
    assert('E3 · 账本读不到 ⇒ 孤儿判不了（inLedger=null，不瞎判）',
      dE3.details.orphanCard === 0 && dE3.details.ledgerOk === false
      && dE3.details.rows.every((r) => r.inLedger === null),
      `orphanCard=${dE3.details.orphanCard} ledgerOk=${dE3.details.ledgerOk}`)
    //    重启归组预测：G2 cwd=<ws>（= 工作区 path）⇒ 归组；UG cwd=<ws>/chat ⇒ 仍留
    assert('E4 · 重启归组预测按「cwd 是否等于工作区 path」算',
      eDetails.willGroupOnRestart === 1 && eDetails.stayUngroupedAfterRestart === 2
      && rowsB.find((r) => r.sid === G2)?.willGroup === true && rowsB.find((r) => r.sid === UG)?.willGroup === false,
      `willGroup=${eDetails.willGroupOnRestart} stay=${eDetails.stayUngroupedAfterRestart}`)
    //    读盘口径：ledger + 外部清单取并集，两种形态都认
    const homeE = path.join(tmp, 'caseE')
    fs.mkdirSync(path.join(homeE, 'task-board'), { recursive: true })
    fs.mkdirSync(path.join(homeE, 'multi-instance'), { recursive: true })
    writeJson(path.join(homeE, 'task-board', 'ledger-v2.json'), {
      tasks: [{ executions: [{ sessionId: G1 }, { sessionId: SID('ledger-extra') }] }],
    })
    writeJson(path.join(homeE, 'multi-instance', 'card-sessions.json'), {
      sessions: [{ sessionId: G2 }, SID('external-extra')],
    })
    const ledE = readExecutionSessionIds(homeE, null)
    assert('E5 · 账本读取器：ledger + 外部清单取并集（tasks[] 与 sessions[] 两种形态）',
      ledE.ok === true && ledE.ids.size === 4 && ledE.files.length === 2,
      `ok=${ledE.ok} ids=${ledE.ids.size} files=${ledE.files.length}`)
    const ledF = readExecutionSessionIds(homeB, null)
    assert('E6 · 账本缺失 ⇒ ok:false 且不抛（判不了就明说）', ledF.ok === false && ledF.ids.size === 0,
      `ok=${ledF.ok} ids=${ledF.ids.size}`)

    // ── C：少几处降级路径 ──
    const ctxC = {
      ...ctxA,
      physical: { unique: new Map(), perLane: { main: 0, card: 0 }, nonSessionDirs: 0, error: '归档根不存在' },
      list: { ok: false, items: [], error: 'ECONNREFUSED', attempts: 2 },
      auto: { ok: true, source: 'file', config: ctxA.auto.config, state: { lastResult: { ...ctxA.auto.state.lastResult, dryRun: true } }, error: 'HTTP 取配置失败' },
      ops: readOpsLedger(path.join(homeB, '_archived-sessions', 'archive-session-ops.jsonl')),
    }
    const rC = runChecks(ctxC)
    const cById = (n) => rC.checks.find((c) => c.id === n)
    assert('C1 · 归档根读不到 ⇒ ⚠️', cById(1).status === STATUS.WARN)
    assert('C2 · 从磁盘回落取到配置 ⇒ 仍可 ✅', cById(2).status === STATUS.OK && cById(2).details.source === 'file')
    assert('C3 · 上轮是 dryRun 预览 ⇒ ⚠️', cById(3).status === STATUS.WARN && cById(3).details.dryRun === true)
    assert('C4 · list 不可达 ⇒ 未分组降级 ⚠️（不崩）', cById(4).status === STATUS.WARN)
    assert('C5 · 台账坏行在降级路径仍判 ⚠️', cById(5).status === STATUS.WARN)

    // ── D：ghost 口径开关（默认分档 vs --strict = 「必须 0」）──
    //     fixture：归档树有、名单无、list 有，但 sessions\ 里也有一份 ⇒ 默认黄、strict 红
    const homeD = path.join(tmp, 'caseD')
    const DUPD = SID('dup-only')
    writeFakeArchive(homeD, DUPD, { lane: 'card' })
    writeFakeSession(homeD, DUPD, {})
    writeJson(path.join(homeD, 'storages', 'workspace.json'), { global: { archivedSessionIds: [] }, tables: { workspaces: {} } })
    const ctxD = {
      ...ctxA,
      home: homeD,
      physical: scanPhysicalArchives(path.join(homeD, '_archived-sessions')),
      live: indexLiveSessions(path.join(homeD, 'sessions')),
      list: { ok: true, items: [listItem(DUPD)], error: null },
      archived: { rawCount: 0, set: new Set() },
      workspaces: { list: [] },
    }
    const dSplit = runChecks(ctxD).checks.find((c) => c.id === 1)
    const dStrict = runChecks({ ...ctxD, ghostPolicy: 'strict' }).checks.find((c) => c.id === 1)
    assert('D1 · 只有双份残留 ⇒ 默认 ⚠️（真 ghost 0）', dSplit.status === STATUS.WARN && dSplit.details.realGhost === 0 && dSplit.details.duplicateCopies === 1,
      `真 ${dSplit.details.realGhost} / 双份 ${dSplit.details.duplicateCopies}`)
    assert('D2 · 同一份数据按 --strict（「必须 0」）⇒ 🔴', dStrict.status === STATUS.BAD && dStrict.details.ghostPolicy === 'strict',
      `status=${dStrict.status} policy=${dStrict.details.ghostPolicy}`)

    const passed = results.filter((r) => r.ok).length
    console.log(`SELF-TEST ${passed}/${results.length}`)
    return { ok: passed === results.length, passed, total: results.length }
  } finally {
    // 只删自己刚建的 selftest 临时目录（带前缀 + 在 _tmp 下双保险）
    try {
      const base = fs.realpathSync(os.tmpdir())
      const resolved = fs.realpathSync(tmp)
      if (resolved.startsWith(base + path.sep) && path.basename(resolved).startsWith('session-archive-health-selftest-')) {
        fs.rmSync(resolved, { recursive: true, force: true })
      }
    } catch { /* 清理失败不影响结论 */ }
  }
}

// ── 参数与主流程 ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    json: false,
    selfTest: false,
    help: false,
    home: null,
    baseUrl: process.env.DSH_WEB_URL || 'http://127.0.0.1:3080',
    // 源 ↔ 部署副本对照：默认**不查**（外部安装没有源树 ⇒ N/A）；要查请成对给两个路径。
    pluginSrc: null,
    pluginDep: null,
    pluginEnabled: false,
    // 期望值文件（可选）：给了才做「配置对齐」判红/黄，不给只报现值。
    expectPath: null,
    expect: null,
    // 卡会话目录名（判「孤儿卡会话」用；相对/绝对都行，按目录名尾匹配）。
    cardSessionsDir: 'card-sessions',
    timeoutMs: 30000,
    ghostPolicy: 'split',
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--json') opts.json = true
    else if (a === '--self-test') opts.selfTest = true
    else if (a === '--help' || a === '-h') opts.help = true
    else if (a === '--strict') opts.ghostPolicy = 'strict'
    else if (a === '--home') opts.home = next()
    else if (a === '--base-url') opts.baseUrl = next()
    else if (a === '--plugin-src') opts.pluginSrc = next()
    else if (a === '--plugin-dep') opts.pluginDep = next()
    else if (a === '--expect-json') opts.expectPath = next()
    else if (a === '--card-sessions-dir') opts.cardSessionsDir = next()
    else if (a === '--timeout-ms') opts.timeoutMs = Math.max(1000, Number(next()) || 30000)
    else if (a.startsWith('--')) {
      console.error(`不认识的参数：${a}（--help 看用法）`)
      process.exitCode = 2
      return null
    }
  }
  opts.home = resolveHome(opts.home)
  if (opts.pluginSrc && !opts.pluginDep) {
    // 只给了源：按 profile 的常规部署位置补出部署副本（找不到就是读不到 ⇒ 检查⑥ 自己会报）。
    opts.pluginDep = path.join(opts.home, 'profiles', 'web', 'node_modules', 'dsh-archive-sessions', 'lib', 'index.js')
  }
  opts.pluginEnabled = Boolean(opts.pluginSrc && opts.pluginDep)
  if (opts.expectPath) {
    opts.expect = readJsonSafe(path.resolve(opts.expectPath))
    if (opts.expect === null) {
      console.error(`期望值文件读不到或不是合法 JSON：${opts.expectPath}`)
      process.exitCode = 2
      return null
    }
  }
  return opts
}

function isMainModule() {
  const arg = process.argv[1]
  if (!arg) return false
  const real = (p) => {
    try { return fs.realpathSync(p) } catch { return path.resolve(p) }
  }
  // junction 下 argv[1] 可能是逻辑路径、import.meta.url 是物理路径 ⇒ 两边都 realpath 再比
  return real(arg) === real(HERE)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (!opts) return

  if (opts.help) {
    console.log([
      'dsh-archive-health —— 会话归档的只读健康自检（observe 档）',
      '',
      '用法：',
      '  dsh-archive-health                  # 人话输出',
      '  dsh-archive-health --json           # 结构化（stdout 只出 JSON）',
      '  dsh-archive-health --self-test      # 夹具自测',
      '  dsh-archive-health --strict         # ghost 按「必须 0」判（双份残留也算红）',
      '',
      '可选：--home <目录>  --base-url <URL>  --timeout-ms <毫秒>  --card-sessions-dir <目录名>',
      '      --expect-json <文件>            # 期望值文件；给了才做配置对齐判红/黄',
      '      --plugin-src <文件> --plugin-dep <文件>   # 源 ↔ 部署副本对照；成对给才查，否则 N/A',
      '',
      'ghost 口径：缺省 = 分档（真 ghost「搬走了还挂在列表里」红 / 双份残留黄，因为删哪一份要人拍板）；',
      '            --strict = 只要 ghost ≠ 0 就红。',
      '',
      '需要宿主 cookie 的联网项：把 base64 签名密钥放进 env DSH_RPC_COOKIE_SECRET（本件不读凭据文件）；',
      '取不到就降级成 ⚠️「判不了」，绝不猜。',
      '',
      '退码：0 = 六项全 ✅；3 = 有 ⚠️/🔴；2 = 用法错；1 = 自测未全过',
    ].join('\n'))
    return
  }

  if (opts.selfTest) {
    const r = runSelfTest()
    process.exitCode = r.ok ? 0 : 1
    return
  }

  const ctx = await gatherContext(opts)
  const result = runChecks(ctx)
  const report = buildReport(ctx, result)
  if (opts.json) console.log(JSON.stringify(report, null, 2))
  else printHuman(report)
  process.exitCode = report.exitCode
}

if (isMainModule()) {
  await main()
}
