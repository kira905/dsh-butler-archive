// 真实 DSH 实例端到端验证：对着一个正在运行的 DSH 打 HTTP，跑通 list / detail / restore / delete。
//
// 用法：
//   node scripts/verify-live.mjs --base <url> --home <DSH_HOME> [--prefix <apiPrefix>]
//   node scripts/verify-live.mjs --base http://127.0.0.1:3090 --home <隔离实例 home> --keep
//
// 它会：
//   1) 在 <DSH_HOME>/_archived-sessions/<批次>/ 造 2 个**整条 id 带 verify-fixture 标记**的假会话
//   2) 走真实 HTTP 路由列出来、预览、恢复一个、删除另一个
//   3) 校验磁盘副作用（恢复的字节一致、源已删、删除的目录没了）
//   4) 清理它造出来的一切（--keep 则保留）
//
// 安全设计：只碰自己造的会话（id 前缀 verify-fixture-），不读不写任何真实会话内容，
//          绝不调用 /auto/run 的真归档模式。
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

const argv = process.argv.slice(2)
const value = (name, fallback) => {
  const index = argv.indexOf('--' + name)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}
const BASE = value('base', 'http://127.0.0.1:3090').replace(/\/+$/, '')
const HOME = value('home', null)
const PREFIX = value('prefix', '/api/dsh-archive-sessions')
const KEEP = argv.includes('--keep')
const STAMP = value('stamp', 'verify-fixture')

if (HOME === null) {
  console.error('usage: node scripts/verify-live.mjs --base <url> --home <DSH_HOME> [--prefix <apiPrefix>] [--keep]')
  process.exit(2)
}

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) pass += 1
  else fail += 1
  console.log((ok ? '[OK]  ' : '[FAIL]') + ' ' + name + (detail ? ' :: ' + detail : ''))
}
const section = (title) => console.log('\n── ' + title + ' ' + '─'.repeat(Math.max(0, 60 - title.length)))

const BATCH = 'vfy-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const ARCHIVE_ROOT = join(HOME, '_archived-sessions')
const SESSIONS_ROOT = join(HOME, 'sessions')
const RESTORE_ID = STAMP + '-restore-0001'
const DELETE_ID = STAMP + '-delete-0002'
const CWD = join(HOME, 'verify-cwd')
const madeDirs = []

const zstdLog = (events) => Buffer.concat(events.map((ev) => zstdCompressSync(Buffer.from(JSON.stringify(ev) + '\n', 'utf8'))))
const base = Date.now()

function makeFixture(id) {
  const dir = join(ARCHIVE_ROOT, BATCH, id)
  mkdirSync(dir, { recursive: true })
  madeDirs.push(dir)
  writeFileSync(join(dir, 'session.jsonl.zstd'), zstdLog([
    { type: 'session', id, createdAt: base, cwd: CWD },
    { type: 'user/message', time: base + 1000, data: { content: [{ type: 'text', text: 'verify fixture message for ' + id }] } },
    { type: 'assistant/message', time: base + 2000, data: { message: { content: [{ type: 'text', text: 'verify fixture answer' }] } } },
  ]))
  return dir
}

const get = async (path) => {
  const res = await fetch(BASE + path, { headers: { accept: 'application/json' } })
  let body = null
  try { body = await res.json() } catch { /* ignore */ }
  return { status: res.status, body }
}
const post = async (path, payload) => {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  let body = null
  try { body = await res.json() } catch { /* ignore */ }
  return { status: res.status, body }
}

const cleanup = () => {
  for (const dir of madeDirs) {
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    } catch { /* ignore */ }
  }
  // 批次目录空则删掉
  const batchDir = join(ARCHIVE_ROOT, BATCH)
  try {
    if (existsSync(batchDir) && readdirSync(batchDir).length === 0) rmSync(batchDir, { recursive: true, force: true })
  } catch { /* ignore */ }
  // 恢复过去的会话目录也删掉（按 cwd 推出的项目 key 下）
  try {
    const restored = join(SESSIONS_ROOT, restoredKey ?? '', RESTORE_ID)
    if (existsSync(restored)) rmSync(restored, { recursive: true, force: true })
    const parent = join(SESSIONS_ROOT, restoredKey ?? '')
    if (restoredKey && existsSync(parent) && readdirSync(parent).length === 0) rmSync(parent, { recursive: true, force: true })
  } catch { /* ignore */ }
}

let restoredKey = null

console.log('base    : ' + BASE)
console.log('home    : ' + HOME)
console.log('prefix  : ' + PREFIX)
console.log('batch   : ' + BATCH)

try {
  // ── 0. 实例与插件活着吗 ───────────────────────────────────────────────
  section('0. 实例可达性')
  const cfg = await get(PREFIX + '/config')
  check('GET /config 200', cfg.status === 200, String(cfg.status))
  check('公开配置不含绝对路径', cfg.status === 200 && !JSON.stringify(cfg.body).includes(HOME.replace(/\\/g, '\\\\')), '')
  check('界面文案下发（nav 非空）', typeof cfg.body?.ui?.nav === 'string' && cfg.body.ui.nav.length > 0, String(cfg.body?.ui?.nav))
  const list0 = await get(PREFIX + '/list')
  check('GET /list 200', list0.status === 200, String(list0.status))

  // ── 1. 造夹具 ─────────────────────────────────────────────────────────
  section('1. 造夹具（只造带 verify 标记的假会话）')
  const restoreDir = makeFixture(RESTORE_ID)
  const deleteDir = makeFixture(DELETE_ID)
  const restoreBytes = readFileSync(join(restoreDir, 'session.jsonl.zstd'))
  check('夹具目录已创建', existsSync(restoreDir) && existsSync(deleteDir), BATCH)

  // ── 2. list ───────────────────────────────────────────────────────────
  section('2. list（真实 DSH 进程）')
  const list = await get(PREFIX + '/list')
  const ids = (list.body?.archives ?? []).map((a) => a.sessionId)
  check('列表包含两个夹具', ids.includes(RESTORE_ID) && ids.includes(DELETE_ID), String(ids.length) + ' rows')
  const row = (list.body?.archives ?? []).find((a) => a.sessionId === RESTORE_ID)
  check('磁盘兜底取到 cwd', row?.cwd === CWD, String(row?.cwd))
  check('磁盘兜底取到标题', row?.title === 'verify fixture message for ' + RESTORE_ID, String(row?.title))
  check('带批次名', row?.batch === BATCH, String(row?.batch))

  // ── 3. detail ─────────────────────────────────────────────────────────
  section('3. detail')
  const detail = await get(PREFIX + '/detail?sessionId=' + encodeURIComponent(RESTORE_ID))
  check('detail 200', detail.status === 200, String(detail.status))
  check('解出 2 条消息', detail.body?.totalMessages === 2, String(detail.body?.totalMessages))
  check('会话头 cwd 正确', detail.body?.header?.cwd === CWD, String(detail.body?.header?.cwd))

  // ── 4. restore ────────────────────────────────────────────────────────
  section('4. restore（真实磁盘副作用）')
  const restore = await post(PREFIX + '/restore', { sessionId: RESTORE_ID })
  check('restore 200 + ok', restore.status === 200 && restore.body?.ok === true, JSON.stringify(restore.body))
  restoredKey = restore.body?.cwdKey ?? null
  const restoredPath = join(SESSIONS_ROOT, restoredKey ?? '', RESTORE_ID)
  check('恢复目标存在', existsSync(restoredPath), restoredPath)
  check('恢复字节一致', existsSync(restoredPath) && Buffer.compare(readFileSync(join(restoredPath, 'session.jsonl.zstd')), restoreBytes) === 0, '')
  check('归档源已删除', !existsSync(restoreDir), '')
  check('恢复目录落在 sessions 根下', restoredPath.startsWith(SESSIONS_ROOT), restoredPath)
  const listAfter = await get(PREFIX + '/list')
  const idsAfter = (listAfter.body?.archives ?? []).map((a) => a.sessionId)
  check('恢复后不再出现在归档列表', !idsAfter.includes(RESTORE_ID), '')
  const restoreAgain = await post(PREFIX + '/restore', { sessionId: RESTORE_ID })
  check('重复恢复 → 404', restoreAgain.status === 404, String(restoreAgain.status))

  // ── 5. delete ─────────────────────────────────────────────────────────
  section('5. delete')
  const del = await post(PREFIX + '/delete', { sessionId: DELETE_ID })
  check('delete 200 + ok', del.status === 200 && del.body?.ok === true, JSON.stringify(del.body))
  check('磁盘目录已删除', !existsSync(deleteDir), '')
  const delAgain = await post(PREFIX + '/delete', { sessionId: DELETE_ID })
  check('重复删除 → 404', delAgain.status === 404, String(delAgain.status))
  const guarded = await post(PREFIX + '/restore', { sessionId: '../sessions' })
  check('非法 sessionId 被拒', guarded.status === 400, JSON.stringify(guarded.body))

  // ── 6. auto（只读，不触发真归档） ─────────────────────────────────────
  section('6. auto（只读检查）')
  const auto = await get(PREFIX + '/auto')
  check('GET /auto 200', auto.status === 200, String(auto.status))
  check('自动归档默认未开启', auto.body?.config?.enabled !== true, JSON.stringify(auto.body?.config?.enabled))
} catch (err) {
  console.log('\n[ERROR] ' + (err instanceof Error ? err.stack : String(err)))
  fail += 1
} finally {
  if (KEEP) {
    console.log('\n[保留] --keep：未清理夹具')
  } else {
    cleanup()
    console.log('\n[清理] 夹具与批次目录已删除')
  }
  // 复查：确认没有残留我们造的东西
  const leftovers = madeDirs.filter((d) => existsSync(d)).length
  if (!KEEP) check('无残留夹具', leftovers === 0, String(leftovers))
}

console.log('\n' + '═'.repeat(64))
console.log(fail === 0 ? `LIVE VERIFY PASSED (${pass} checks)` : `LIVE VERIFY FAILED (${fail} failed / ${pass} passed)`)
process.exit(fail === 0 ? 0 : 1)
