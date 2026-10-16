// 端到端测试：在【干净路径】+【另一份配置】下跑通 list / detail / restore / delete 全流程。
//
// 用法：node scripts/test-e2e.mjs [--keep]
//   --keep   保留临时目录（默认测试结束即删）
//
// 被测对象：lib/index.js（host 半）+ lib/config.js 的配置解析。
// 测法：造一个假的 DSH home（sessions / storages / 归档目录）+ 多帧 zstd 会话日志，
//       用 scripts/test-host.mjs 起真实 HTTP（脚本内固定端口 0=随机），
//       然后完全从 HTTP 侧验证行为与磁盘副作用。
import { spawn } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, openSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const KEEP = process.argv.includes('--keep')
// 复用被测实现里的 projectKey，避免测试自己写一份可能与实现不一致的期望值
const { __testing } = await import(new URL('../lib/index.js', import.meta.url).href)

let fail = 0
let pass = 0
const check = (name, ok, detail = '') => {
  if (ok) pass += 1
  else fail += 1
  console.log((ok ? '[OK]  ' : '[FAIL]') + ' ' + name + (detail ? ' :: ' + detail : ''))
}
const section = (title) => console.log('\n── ' + title + ' ' + '─'.repeat(Math.max(0, 64 - title.length)))

// ── 夹具 ───────────────────────────────────────────────────────────────────

const WORK = mkdtempSync(join(tmpdir(), 'as-e2e-'))
const HOME = join(WORK, 'fake-home')           // 干净 home（与开发机目录无关）
const DATA = join(WORK, 'custom-archive')       // 自定义归档根（配置里指过去的）
const SESSIONS = join(WORK, 'custom-sessions')  // 自定义 sessions 根
const STORAGES = join(WORK, 'custom-storages')
const LOG = join(WORK, 'host.log')
const CONFIG = join(WORK, 'archive-sessions.config.json')

const zstdLog = (events) => Buffer.concat(events.map((ev) => zstdCompressSync(Buffer.from(JSON.stringify(ev) + '\n', 'utf8'))))
const w = (p, content) => {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

// 会话 A：projcache 里有元数据（走快路径）
const A = 'session-fixture-a'
// 会话 B：projcache 里没有（走磁盘兜底）
const B = 'session-fixture-b'
// 会话 C：只用来测删除
const C = 'session-fixture-c'

const baseTime = Date.parse('2026-01-02T03:04:05.000Z')
const headerOf = (id, cwd) => ({ type: 'session', id, createdAt: baseTime, cwd })
const userEvent = (text, t) => ({ type: 'user/message', time: t, data: { content: [{ type: 'text', text }] } })
const assistantEvent = (text, t) => ({ type: 'assistant/message', time: t, data: { message: { content: [{ type: 'text', text }] } } })

w(join(DATA, 'batch-001', A, 'session.jsonl.zstd'), zstdLog([
  headerOf(A, join(WORK, 'proj-alpha')),
  userEvent('first question from fixture\n<system-reminder>ignore me</system-reminder>', baseTime + 1000),
  assistantEvent('first answer', baseTime + 2000),
]))
w(join(DATA, 'batch-001', B, 'session.jsonl.zstd'), zstdLog([
  headerOf(B, join(WORK, 'proj-beta')),
  userEvent('second fixture question', baseTime + 5000),
]))
w(join(DATA, 'batch-002', C, 'session.jsonl.zstd'), zstdLog([
  headerOf(C, join(WORK, 'proj-alpha')),
  userEvent('to be deleted', baseTime + 9000),
]))
w(join(DATA, 'batch-001', 'manifest.json'), JSON.stringify([
  { from: join(SESSIONS, 'placeholder', A), to: join(DATA, 'batch-001', A), mb: 0.01, ageD: 3 },
], null, 2))
w(join(SESSIONS, 'existing-proj', 'session-keepme', 'session.jsonl.zstd'), zstdLog([headerOf('session-keepme', join(WORK, 'proj-alpha'))]))
w(join(STORAGES, 'workspace.json'), JSON.stringify({ global: { archivedSessionIds: [A, C] } }, null, 2))
w(join(STORAGES, 'session_projcache.json'), JSON.stringify({
  tables: {
    sessions: {
      [A]: {
        identity: { cwd: join(WORK, 'proj-alpha'), createdAt: baseTime },
        rows: { title: { val: 'Fixture A title' }, sessionStats: { val: { turns: 4 } } },
      },
      [C]: {
        identity: { cwd: join(WORK, 'proj-alpha'), createdAt: baseTime },
        rows: { title: { val: 'Fixture C title' }, sessionStats: { val: { turns: 1 } } },
      },
    },
  },
}, null, 2))

// 另一份配置：路径全部自定义（含相对路径写法）+ 改了几处默认值
w(CONFIG, JSON.stringify({
  language: 'en',
  paths: {
    storagesDir: STORAGES,
    archiveRoot: DATA,
    sessionsRoot: SESSIONS,
  },
  archive: { unknownCwdKey: '_fallback-cwd' },
  preview: { maxMessages: 3, maxMessageChars: 200 },
  server: { apiPrefix: '/api/custom-archive' },
  auto: { enabled: false, dryRun: true, hours: 1, minSizeMb: 0, maxPerRun: 5, startDelayMs: 60000, tickMs: 60000 },
}, null, 2))

console.log('work dir : ' + WORK)
console.log('config   : ' + CONFIG)
console.log('archive  : ' + DATA)

// ── 起 host ────────────────────────────────────────────────────────────────

const out = await (async () => {
  const fd = openSync(LOG, 'a')
  const child = spawn(process.execPath, [join(ROOT, 'scripts', 'test-host.mjs'), '0'], {
    env: {
      ...process.env,
      ARCHIVE_SESSIONS_CONFIG: CONFIG,
      DSH_HOME: HOME,
      DSH_SESSIONS_DIR: SESSIONS,
    },
    cwd: ROOT,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  })
  const waitLog = async (pattern, timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const text = existsSync(LOG) ? readFileSync(LOG, 'utf8') : ''
      const match = text.match(pattern)
      if (match) return match
      if (child.exitCode !== null) throw new Error('host exited early: ' + text)
      await new Promise((r) => setTimeout(r, 120))
    }
    throw new Error('timeout waiting for ' + pattern + ' in ' + LOG)
  }
  const match = await waitLog(/\[ready\] http:\/\/127\.0\.0\.1:(\d+)/, 20000)
  const port = Number(match[1])
  const base = 'http://127.0.0.1:' + port
  console.log('host     : ' + base)

  const get = async (path) => {
    const res = await fetch(base + path, { headers: { accept: 'application/json' } })
    let body = null
    try { body = await res.json() } catch { /* ignore */ }
    return { status: res.status, body }
  }
  const post = async (path, payload) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    let body = null
    try { body = await res.json() } catch { /* ignore */ }
    return { status: res.status, body }
  }

  const stop = async () => {
    child.kill()
    await new Promise((r) => setTimeout(r, 300))
  }

  try {
    // ── 1. 配置外置 ─────────────────────────────────────────────────────────
    section('1. 配置外置（另一份配置生效）')
    const cfg = await get('/api/custom-archive/config')
    check('自定义 apiPrefix 生效', cfg.status === 200 && cfg.body?.apiPrefix === '/api/custom-archive', JSON.stringify(cfg.body?.apiPrefix))
    check('公开配置不含任何绝对路径', !JSON.stringify(cfg.body).includes(WORK), '')
    check('预览条数来自配置', cfg.body?.preview?.maxMessages === 3, String(cfg.body?.preview?.maxMessages))
    check('英文界面文案生效', cfg.body?.ui?.nav === 'Archived Sessions', String(cfg.body?.ui?.nav))
    const oldPrefix = await get('/api/dsh-archive-sessions/list')
    check('默认前缀已让位（路由真的换了）', oldPrefix.status === 404, String(oldPrefix.status))

    // ── 2. list ────────────────────────────────────────────────────────────
    section('2. list')
    const list = await get('/api/custom-archive/list')
    check('list 200', list.status === 200, String(list.status))
    check('列出 3 个归档会话', list.body?.total === 3, JSON.stringify((list.body?.archives ?? []).map((a) => a.sessionId)))
    check('占用字节 > 0', (list.body?.totalSize ?? 0) > 0, String(list.body?.totalSize))
    const rowA = (list.body?.archives ?? []).find((a) => a.sessionId === A)
    check('projcache 元数据优先（title）', rowA?.title === 'Fixture A title', String(rowA?.title))
    check('projcache 元数据优先（turns）', rowA?.turns === 4, String(rowA?.turns))
    check('曾归档标记来自 workspace.json', rowA?.wasArchived === true, String(rowA?.wasArchived))
    const rowB = (list.body?.archives ?? []).find((a) => a.sessionId === B)
    check('无 projcache 时磁盘兜底取到 cwd', rowB?.cwd === join(WORK, 'proj-beta'), String(rowB?.cwd))
    check('无 projcache 时磁盘兜底取到标题', rowB?.title === 'second fixture question', String(rowB?.title))
    check('磁盘兜底记录 hasMeta=false', rowB?.hasMeta === false, String(rowB?.hasMeta))

    // ── 3. detail ──────────────────────────────────────────────────────────
    section('3. detail')
    const detail = await get('/api/custom-archive/detail?sessionId=' + encodeURIComponent(A))
    check('detail 200', detail.status === 200, String(detail.status))
    check('会话头 cwd 正确', detail.body?.header?.cwd === join(WORK, 'proj-alpha'), String(detail.body?.header?.cwd))
    check('解出 2 条消息', detail.body?.totalMessages === 2, String(detail.body?.totalMessages))
    const firstUser = (detail.body?.messages ?? []).find((m) => m.role === 'user')
    check('system-reminder 已剥离', firstUser !== undefined && !firstUser.content.includes('ignore me'), String(firstUser?.content))
    check('事件类型计数存在（含工具事件）', typeof detail.body?.eventTypes?.session === 'number', JSON.stringify(detail.body?.eventTypes))
    const detailB = await get('/api/custom-archive/detail?sessionId=' + encodeURIComponent(B))
    check('无 projcache 会话也能预览', detailB.status === 200 && (detailB.body?.messages ?? []).length === 1, String(detailB?.body?.totalMessages))
    const detailMissing = await get('/api/custom-archive/detail?sessionId=session-nope')
    check('不存在的会话 → 404 + code', detailMissing.status === 404 && detailMissing.body?.code === 'not-found', JSON.stringify(detailMissing.body))
    const detailNoId = await get('/api/custom-archive/detail')
    check('缺 sessionId → 400', detailNoId.status === 400, String(detailNoId.status))

    // ── 4. restore ─────────────────────────────────────────────────────────
    section('4. restore')
    const beforeRestore = await get('/api/custom-archive/list')
    // 归档源在 restore 成功后会被删除，先在内存里留一份原始字节用于比对
    const archiveBytesA = readFileSync(join(DATA, 'batch-001', A, 'session.jsonl.zstd'))
    const restore = await post('/api/custom-archive/restore', { sessionId: A })
    check('restore 200', restore.status === 200 && restore.body?.ok === true, JSON.stringify(restore.body))
    const expectedKey = __testing.projectKey(join(WORK, 'proj-alpha'))
    check('恢复到按 cwd 推出的项目目录', restore.body?.cwdKey === expectedKey, String(restore.body?.cwdKey) + ' vs ' + expectedKey)
    const restoredDir = join(SESSIONS, restore.body?.cwdKey ?? '', A)
    check('磁盘上目标目录存在', existsSync(restoredDir), restoredDir)
    check('恢复后的日志逐字节一致（与归档源同一份字节）',
      existsSync(join(restoredDir, 'session.jsonl.zstd')) &&
      Buffer.compare(readFileSync(join(restoredDir, 'session.jsonl.zstd')), archiveBytesA) === 0, '')
    check('归档源已删除', !existsSync(join(DATA, 'batch-001', A)), '')
    check('workspace 归档标记已摘除',
      !(JSON.parse(readFileSync(join(STORAGES, 'workspace.json'), 'utf8')).global.archivedSessionIds ?? []).includes(A), '')
    check('manifest 条目已剔除',
      !JSON.stringify(JSON.parse(readFileSync(join(DATA, 'batch-001', 'manifest.json'), 'utf8'))).includes(A), '')
    const afterRestore = await get('/api/custom-archive/list')
    check('list 数量 -1', afterRestore.body?.total === beforeRestore.body.total - 1, String(afterRestore.body?.total))
    const restoreAgain = await post('/api/custom-archive/restore', { sessionId: A })
    check('重复恢复 → 404', restoreAgain.status === 404, String(restoreAgain.status))
    const restoreTraversal = await post('/api/custom-archive/restore', { sessionId: 'session-x..%2F..%2Fetc' })
    check('路径穿越形态的 id → 404（不会越界读写）', restoreTraversal.status === 404, JSON.stringify(restoreTraversal.body))
    const restoreSlash = await post('/api/custom-archive/restore', { sessionId: 'a/b' })
    check('含分隔符的 id 被拒 → 400', restoreSlash.status === 400, JSON.stringify(restoreSlash.body))

    // ── 5. delete ──────────────────────────────────────────────────────────
    section('5. delete')
    const del = await post('/api/custom-archive/delete', { sessionId: C })
    check('delete 200', del.status === 200 && del.body?.ok === true, JSON.stringify(del.body))
    check('磁盘目录已删除', !existsSync(join(DATA, 'batch-002', C)), '')
    const delAgain = await post('/api/custom-archive/delete', { sessionId: C })
    check('重复删除 → 404', delAgain.status === 404, String(delAgain.status))
    const delBadBody = await fetch(base + '/api/custom-archive/delete', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
    })
    check('坏 JSON → 400 + code', delBadBody.status === 400, String(delBadBody.status))
    const delBadBodyJson = await delBadBody.json()
    check('坏 JSON 带 code', delBadBodyJson?.code === 'invalid-json', JSON.stringify(delBadBodyJson))

    // ── 6. auto ────────────────────────────────────────────────────────────
    section('6. auto archive（默认关闭 / 试跑）')
    const auto = await get('/api/custom-archive/auto')
    check('auto 200 且默认停用', auto.status === 200 && auto.body?.config?.enabled === false, JSON.stringify(auto.body?.config))
    check('auto 阈值来自配置', auto.body?.config?.hours === 1, String(auto.body?.config?.hours))
    const run = await post('/api/custom-archive/auto/run', {})
    check('默认试跑（dryRun=true）', run.status === 200 && run.body?.dryRun === true, JSON.stringify({ status: run.status, dryRun: run.body?.dryRun }))
    check('试跑未移动任何文件', existsSync(join(SESSIONS, 'existing-proj', 'session-keepme')), '')
    const setAuto = await post('/api/custom-archive/auto', { hours: 72 })
    check('auto 配置可更新', setAuto.status === 200 && setAuto.body?.config?.hours === 72, JSON.stringify(setAuto.body?.config?.hours))
    const autoState = JSON.parse(readFileSync(join(DATA, '.auto-archive.json'), 'utf8'))
    check('auto 状态写在归档根（可配置文件名）', autoState.config.hours === 72, JSON.stringify(autoState.config))

    // ── 7. 安全边界 ────────────────────────────────────────────────────────
    section('7. 安全边界')
    const noOrigin = await fetch(base + '/api/custom-archive/list', { headers: { 'sec-fetch-site': 'cross-site' } })
    check('cross-site 请求被拒 → 403', noOrigin.status === 403, String(noOrigin.status))
    const badOrigin = await fetch(base + '/api/custom-archive/list', { headers: { origin: 'http://evil.example' } })
    check('跨源 Origin 被拒 → 403', badOrigin.status === 403, String(badOrigin.status))
    const sameOrigin = await fetch(base + '/api/custom-archive/list', { headers: { origin: 'http://127.0.0.1:' + port } })
    check('同源 Origin 放行', sameOrigin.status === 200, String(sameOrigin.status))
    const wrongMethod = await fetch(base + '/api/custom-archive/list', { method: 'POST', body: '{}' })
    check('方法不符 → 405', wrongMethod.status === 405, String(wrongMethod.status))

    await stop()
  } catch (err) {
    console.log('\n[ERROR] ' + (err instanceof Error ? err.stack : String(err)))
    fail += 1
    await stop()
  }
  return { port }
})()

// ── 收尾 ───────────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(66))
console.log(fail === 0 ? `E2E PASSED (${pass} checks)` : `E2E FAILED (${fail} failed / ${pass} passed)`)
console.log('host log : ' + LOG)
if (KEEP) {
  console.log('已保留临时目录：' + WORK)
} else {
  rmSync(WORK, { recursive: true, force: true })
}
process.exit(fail === 0 ? 0 : 1)
