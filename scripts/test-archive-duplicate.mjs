// 夹具 ③：重复副本不重复搬 —— 同一 sessionId 已在批次目录里且字节一致 ⇒ 跳过；不一致 ⇒ 冲突且绝不覆盖。
//
// 用法：node scripts/test-archive-duplicate.mjs
//       变异证红用 ARCHIVE_TEST_LIB=<另一份 index.js>（把"逐字节"判据改成"只比大小"那份）
//
// 判据（幂等键 = sessionId + 目标批次目录，与源路径无关）：
//   ① 目标里已有同名会话、且与源**逐字节一致** ⇒ 记「已搬」跳过，不再复制一遍
//   ② 目标里已有同名会话、字节不一致      ⇒ 报冲突，目标原样保留，源也不动（不覆盖）
import { existsSync, readFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  cleanup, createCounter, createWorkspace, listBatchDirs, loadLib, sha256Of, writePendingBatch, writeSession,
} from './_fixture-support.mjs'

const count = createCounter()
const ws = createWorkspace('duplicate')
const lib = await loadLib()
const { runAutoArchive } = lib.__testing

const BATCH = '2026-02-02T00-00-00'
const DUP = 'session-dup-000'
const CLASH = 'session-clash-000'

const dup = writeSession(ws.projectDir, DUP, { bytes: 128 * 1024 })
const clash = writeSession(ws.projectDir, CLASH, { bytes: 128 * 1024 })
console.log('work dir  : ' + ws.work)

const batchDir = join(ws.archiveRoot, BATCH)
mkdirSync(batchDir, { recursive: true })

// ① 重复副本：目标里放一份与源完全一样的字节（模拟"上次搬好了、只是没删源"）
const dupDest = join(batchDir, DUP)
mkdirSync(dupDest, { recursive: true })
writeFileSync(join(dupDest, 'session.jsonl.zstd'), readFileSync(dup.logPath))
const dupDestBefore = { size: statSync(join(dupDest, 'session.jsonl.zstd')).size, sha256: sha256Of(join(dupDest, 'session.jsonl.zstd')) }

// ② 冲突：目标里放一份**同样大小、内容不同**的日志（只有"比字节"才抓得住）
const clashDest = join(batchDir, CLASH)
mkdirSync(clashDest, { recursive: true })
const clashBytes = Buffer.alloc(clash.logBytes, 0x41) // 同长度、全是 'A'
writeFileSync(join(clashDest, 'session.jsonl.zstd'), clashBytes)
const clashDestBefore = { size: statSync(join(clashDest, 'session.jsonl.zstd')).size, sha256: sha256Of(join(clashDest, 'session.jsonl.zstd')) }
const clashSrcBefore = { size: statSync(clash.logPath).size, sha256: sha256Of(clash.logPath) }

count.check('现场：冲突副本与源同大小', clashDestBefore.size === clashSrcBefore.size,
  clashDestBefore.size + ' vs ' + clashSrcBefore.size)
count.check('现场：冲突副本与源不同字节', clashDestBefore.sha256 !== clashSrcBefore.sha256, '')

writePendingBatch(ws.archiveRoot, BATCH)
const result = await runAutoArchive({ dryRun: false, trigger: 'fixture-duplicate' })

count.section('A. 字节一致 ⇒ 记「已搬」跳过')
count.check('该会话记在 alreadyArchived 里', (result.alreadyArchived ?? []).includes(DUP), JSON.stringify(result.alreadyArchived))
count.check('没有重新复制它', !(result.archived ?? []).includes(DUP), JSON.stringify(result.archived))
count.check('目标字节未变（sha 前后一致）',
  sha256Of(join(dupDest, 'session.jsonl.zstd')) === dupDestBefore.sha256,
  dupDestBefore.sha256.slice(0, 12) + ' → ' + sha256Of(join(dupDest, 'session.jsonl.zstd')).slice(0, 12))
count.check('目标大小未变', statSync(join(dupDest, 'session.jsonl.zstd')).size === dupDestBefore.size, '')
count.check('归档树里仍然只有一份', listBatchDirs(ws.archiveRoot).join(',') === BATCH, listBatchDirs(ws.archiveRoot).join(','))
count.check('源目录已收尾删除（只补了删源这一步）', !existsSync(dup.dir), '')

count.section('B. 字节不一致 ⇒ 报冲突、不覆盖')
count.check('该会话记在 conflicts 里', (result.conflicts ?? []).some((item) => item.sessionId === CLASH),
  JSON.stringify(result.conflicts))
count.check('冲突原因说得清', ((result.conflicts ?? [])[0]?.reason ?? '').length > 0, String(result.conflicts?.[0]?.reason))
count.check('没有算进 archived', !(result.archived ?? []).includes(CLASH), JSON.stringify(result.archived))
count.check('目标文件被原样保留（sha 未变）',
  sha256Of(join(clashDest, 'session.jsonl.zstd')) === clashDestBefore.sha256,
  clashDestBefore.sha256.slice(0, 12) + ' → ' + sha256Of(join(clashDest, 'session.jsonl.zstd')).slice(0, 12))
count.check('目标大小未变', statSync(join(clashDest, 'session.jsonl.zstd')).size === clashDestBefore.size, '')
const clashSrcAfter = existsSync(clash.logPath) ? sha256Of(clash.logPath) : null
count.check('源文件也没被动（sha 未变）', clashSrcAfter === clashSrcBefore.sha256, String(clashSrcAfter))
count.check('源目录还在（等人工裁决，不擅自删）', existsSync(clash.dir), '')

count.section('C. 状态收尾')
const state = JSON.parse(readFileSync(join(ws.archiveRoot, '.auto-archive.json'), 'utf8'))
count.check('有冲突时 pendingBatch 不清空（下一轮还看得见这批）',
  state.state.pendingBatch?.batch === BATCH, JSON.stringify(state.state.pendingBatch))

cleanup(ws.work)
process.exit(count.report('DUPLICATE FIXTURE'))
