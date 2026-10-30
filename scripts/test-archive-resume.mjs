// 夹具 ②：半完成态可重入 —— 搬到一半崩了，下一轮只补缺的、不整份重搬。
//
// 用法：node scripts/test-archive-resume.mjs
//       变异证红用 ARCHIVE_TEST_LIB=<另一份 index.js>（把"半完成态"识别拆掉那份）
//
// 造法：手工摆一个"崩在中间"的现场 ——
//   <归档根>/<批次>/session-half-000/attachments/extra.bin   ← 已经完整搬过来了
//   <归档根>/<批次>/session-half-000/session.jsonl.zstd      ← 只搬了前 1000 字节（半截）
//   <归档根>/<批次>/.in-progress/session-half-000.json       ← 搬运中标记还在
//   状态文件里的 pendingBatch 还指着这个批次
// 判据：下一轮必须复用这个批次目录、只补那半截日志，已经完整的文件不重搬（mtime / 字节都不动）。
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  cleanup, createCounter, createWorkspace, listBatchDirs, loadLib, sha256Of, writePendingBatch, writeSession,
} from './_fixture-support.mjs'

const count = createCounter()
const ws = createWorkspace('resume')
const lib = await loadLib()
const { runAutoArchive } = lib.__testing

const BATCH = '2026-01-01T00-00-00'
const HALF = 'session-half-000'
const FULL_ONE = 'session-half-001'
const FULL_TWO = 'session-half-002'

const half = writeSession(ws.projectDir, HALF, { bytes: 512 * 1024, extraFiles: { 'attachments/extra.bin': Buffer.from('reuse-me-please') } })
const one = writeSession(ws.projectDir, FULL_ONE, { bytes: 256 * 1024 })
const two = writeSession(ws.projectDir, FULL_TWO, { bytes: 256 * 1024 })
console.log('work dir  : ' + ws.work)

// 半完成现场：搬运中标记 + 一份完整副本 + 一份半截副本
const batchDir = join(ws.archiveRoot, BATCH)
const destHalf = join(batchDir, HALF)
mkdirSync(join(destHalf, 'attachments'), { recursive: true })
mkdirSync(join(batchDir, '.in-progress'), { recursive: true })
const extraSource = readFileSync(join(half.dir, 'attachments', 'extra.bin'))
writeFileSync(join(destHalf, 'attachments', 'extra.bin'), extraSource)
writeFileSync(join(destHalf, 'session.jsonl.zstd'), readFileSync(half.logPath).subarray(0, 1000))
writeFileSync(join(batchDir, '.in-progress', HALF + '.json'), JSON.stringify({
  sessionId: HALF, batch: BATCH, startedAt: Date.now() - 60000, files: 2, bytes: half.logBytes,
}, null, 2), 'utf8')
writePendingBatch(ws.archiveRoot, BATCH)

// 崩前的"真相"：源目录的字节全部先读进内存（跑完源会被删掉）
const truth = new Map()
for (const item of [half, one, two]) {
  for (const file of item.files) {
    truth.set(item.id + '/' + file.rel, readFileSync(join(item.dir, ...file.rel.split('/'))))
  }
}
const halfDamagedBefore = statSync(join(destHalf, 'session.jsonl.zstd')).size
const extraBefore = {
  size: statSync(join(destHalf, 'attachments', 'extra.bin')).size,
  mtimeMs: statSync(join(destHalf, 'attachments', 'extra.bin')).mtimeMs,
  sha256: sha256Of(join(destHalf, 'attachments', 'extra.bin')),
}
count.check('现场：半截日志确实比源短', halfDamagedBefore === 1000 && half.logBytes > 1000,
  'dest=' + halfDamagedBefore + ' src=' + half.logBytes)

const result = await runAutoArchive({ dryRun: false, trigger: 'fixture-resume' })

count.section('A. 复用上次的批次目录（幂等键 = sessionId + 批次目录）')
count.check('没有新开批次', result.batch === BATCH, String(result.batch))
count.check('标记为批次续做', result.batchResumed === true, String(result.batchResumed))
count.check('磁盘上仍然只有这一个批次', listBatchDirs(ws.archiveRoot).join(',') === BATCH,
  listBatchDirs(ws.archiveRoot).join(','))
count.check('半完成的那份记在 resumed 里', (result.resumed ?? []).includes(HALF), JSON.stringify(result.resumed))

count.section('B. 只补缺的：补 3 个、复用 1 个')
// 半完成那份 = 2 个文件（半截日志 + 已完整的附加文件）⇒ 补 1 复用 1；
// 另外两份各 1 个文件 ⇒ 各补 1。合计：补 3、复用 1。
count.check('复制的文件数 = 3', result.copiedFiles === 3, String(result.copiedFiles))
count.check('复用的文件数 = 1（半截之外的完整文件没重搬）', result.reusedFiles === 1, String(result.reusedFiles))
count.check('另外两份照常搬完', (result.archived ?? []).length === 2, JSON.stringify(result.archived))
count.check('没有冲突 / 报错', (result.conflicts ?? []).length === 0 && (result.errors ?? []).length === 0,
  JSON.stringify({ conflicts: result.conflicts, errors: result.errors }))

count.section('C. 补完之后与源逐字节一致')
const logAfter = join(destHalf, 'session.jsonl.zstd')
count.check('半截日志被补齐到源的长度', statSync(logAfter).size === half.logBytes,
  statSync(logAfter).size + ' vs ' + half.logBytes)
count.check('补齐后的日志逐字节 = 崩前源文件',
  Buffer.compare(readFileSync(logAfter), truth.get(HALF + '/session.jsonl.zstd')) === 0, '')
count.check('已完整的附加文件字节未变',
  Buffer.compare(readFileSync(join(destHalf, 'attachments', 'extra.bin')), truth.get(HALF + '/attachments/extra.bin')) === 0, '')
count.check('已完整的附加文件 mtime 未变（说明真的没重写）',
  statSync(join(destHalf, 'attachments', 'extra.bin')).mtimeMs === extraBefore.mtimeMs,
  statSync(join(destHalf, 'attachments', 'extra.bin')).mtimeMs + ' vs ' + extraBefore.mtimeMs)
count.check('已完整的附加文件 sha 未变',
  sha256Of(join(destHalf, 'attachments', 'extra.bin')) === extraBefore.sha256, '')
count.check('整份会话目录与源同形', existsSync(join(destHalf, 'session.jsonl.zstd')) && existsSync(join(destHalf, 'attachments', 'extra.bin')), '')

count.section('D. 收尾')
count.check('搬运中标记已清掉', !existsSync(join(batchDir, '.in-progress', HALF + '.json')), '')
count.check('源目录都已删除', [half, one, two].every((item) => !existsSync(item.dir)), '')
const state = JSON.parse(readFileSync(join(ws.archiveRoot, '.auto-archive.json'), 'utf8'))
count.check('pendingBatch 已清空（批次收尾）', !state.state.pendingBatch, JSON.stringify(state.state.pendingBatch))

cleanup(ws.work)
process.exit(count.report('RESUME FIXTURE'))
