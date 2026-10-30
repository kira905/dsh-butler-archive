// 夹具 ①：并发触发两次，只能跑一次。
//
// 用法：node scripts/test-archive-concurrency.mjs
//       变异证红用 ARCHIVE_TEST_LIB=<另一份 index.js>（把单飞锁拆掉那份）
//
// 断言：
//   - 第二次触发立刻返回「正在跑」，并带上「谁在跑 + 从什么时候开始」
//   - 第二次没有排第二份搬运（不返回搬运结果体，磁盘上不多出批次目录）
//   - 磁盘上每个会话只出现一份
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  cleanup, createCounter, createWorkspace, findDirsNamed, listBatchDirs, loadLib, writeSession,
} from './_fixture-support.mjs'

const count = createCounter()
// ⚠️ 先建工作区（设 env + 配置）再 import：配置在 import 那一刻就被快照了
const ws = createWorkspace('concurrency')
const lib = await loadLib()
const { runAutoArchive } = lib.__testing

const SESSIONS = 24
const created = []
for (let i = 0; i < SESSIONS; i += 1) {
  created.push(writeSession(ws.projectDir, 'session-conc-' + String(i).padStart(3, '0'), { bytes: 1024 * 1024 }))
}
console.log('work dir  : ' + ws.work)
console.log('sessions  : ' + SESSIONS + ' 个（每个 ~1 MB，共 ' + SESSIONS + ' MB）')

count.section('A. 两次并发触发')
const first = runAutoArchive({ dryRun: false, trigger: 'fixture-first' })
// 让第一次真的进到搬运阶段（扫描 + 复制至少几十毫秒）
await new Promise((resolve) => setTimeout(resolve, 10))
const t0 = Date.now()
const second = await runAutoArchive({ dryRun: false, trigger: 'fixture-second' })
const secondLatencyMs = Date.now() - t0
const firstResult = await first

count.check('第二次触发返回「正在跑」', second.alreadyRunning === true, JSON.stringify(second.alreadyRunning))
count.check('带 machine-readable code', second.code === 'already-running', String(second.code))
count.check('带上"谁在跑"', second.running?.trigger === 'fixture-first', String(second.running?.trigger))
count.check('带上"从什么时候开始"',
  Number.isFinite(second.running?.startedAt) && second.running.startedAt <= firstResult.startedAt + 1,
  'startedAt=' + String(second.running?.startedAt) + ' first.startedAt=' + String(firstResult.startedAt))
count.check('第二次没有排第二份搬运（没有搬运结果体）',
  second.archived === undefined && second.scanned === undefined, JSON.stringify(Object.keys(second)))
count.check('第二次是立刻返回的（< 200ms）', secondLatencyMs < 200, secondLatencyMs + 'ms')

count.section('B. 第一次照常跑完')
count.check('第一次搬完全部候选', firstResult.archived.length === SESSIONS, String(firstResult.archived.length))
count.check('第一次没报错', (firstResult.errors ?? []).length === 0, JSON.stringify(firstResult.errors))
count.check('源会话目录都已清掉',
  created.every((item) => !existsSync(item.dir)),
  created.filter((item) => existsSync(item.dir)).map((item) => item.sessionId).join(','))

count.section('C. 磁盘上只出现一份')
const batches = listBatchDirs(ws.archiveRoot)
count.check('只有一个批次目录（第二次没有新开批次）', batches.length === 1, batches.join(','))
const placements = []
for (const item of created) placements.push(...findDirsNamed(ws.archiveRoot, item.id))
count.check('每个会话在归档树里恰好一份', placements.length === SESSIONS,
  'placements=' + placements.length + ' expected=' + SESSIONS)
const batchDir = join(ws.archiveRoot, batches[0] ?? '')
count.check('副本落在该批次目录里',
  created.every((item) => existsSync(join(batchDir, item.id, 'session.jsonl.zstd'))),
  batchDir)

cleanup(ws.work)
process.exit(count.report('CONCURRENCY FIXTURE'))
