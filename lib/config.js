/**
 * dsh-archive-sessions — 配置层（零第三方依赖）。
 *
 * 解析优先级（后者覆盖前者）：
 *   1. DEFAULT_CONFIG                —— 代码内默认值
 *   2. <DSH_HOME>/archive-sessions.config.json  —— 用户配置文件（可选）
 *   3. 环境变量                       —— 见下表
 *
 * DSH_HOME 默认取 `$DSH_HOME`，未设置时回退 `os.homedir()`（跨平台；不依赖 USERPROFILE）。
 *
 * 环境变量：
 *   DSH_HOME                        DSH 用户数据根（默认 ~/.dsh）
 *   DSH_SESSIONS_DIR                活跃会话目录（默认 <home>/sessions）
 *   ARCHIVE_SESSIONS_CONFIG         显式指定配置文件路径
 *   ARCHIVE_SESSIONS_DIR            归档根目录（默认 <home>/_archived-sessions）
 *   ARCHIVE_SESSIONS_API_PREFIX     路由前缀（默认 /api/dsh-archive-sessions）
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** 配置文件默认文件名（放 DSH home 根下）。 */
export const CONFIG_FILE_NAME = 'archive-sessions.config.json'

/** 语言 → 默认界面文案。用户可用 config.ui 或 config.uiByLanguage 覆盖。 */
const DEFAULT_UI = {
  zh: {
    nav: '归档会话管理',
    loadFailed: '读取失败：{error}',
    loadingText: '正在读取归档目录…',
    retry: '重试',
    refresh: '刷新',
    refreshing: '加载中…',
    empty: '归档目录里没有会话。',
    unknownCwd: '未知工作目录',
    unknownTime: '时间未知',
    summary: '共 {total} 个归档会话 · 占用 {size}',
    batch: '批次',
    turns: '{n} 轮',
    goto: '前往',
    flagEmpty: '空会话',
    flagArchived: '曾归档',
    flagNoMeta: '元数据缺失',
    actionPreview: '预览',
    actionCollapse: '收起',
    actionRestore: '恢复',
    actionDelete: '删除',
    busy: '处理中…',
    decoding: '正在解码会话日志…',
    previewFailed: '预览失败：{error}',
    previewMeta: '共 {total} 条消息',
    previewTail: '（显示尾部 {n} 条）',
    cwdLabel: '工作目录 {cwd}',
    roleUser: '用户',
    roleAssistant: '助手',
    truncated: '（内容过长，已截断）',
    emptyLog: '这条会话日志里没有对话消息 —— 通常是打开会话后没发消息就关掉了，日志只留下会话头。',
    emptySafe: '这类空会话可以安全删除。',
    sessionId: '会话 id {id}',
    preset: '预设 {name}',
    delegation: '委派层级 {depth}',
    eventTypes: '日志事件：{list}',
    confirmRestore: '确认恢复这个归档会话？',
    confirmRestoreBody:
      '会把会话目录复制回 sessions 目录（复制校验通过后才删除归档源），不会覆盖任何已存在的数据。',
    restoreUnarchived: '该会话曾被打过「归档」标记，已一并摘除——重启一次 DSH 后即回到正常会话列表。',
    restored: '已恢复：{path}',
    restoreFailed: '恢复失败：{error}',
    confirmDelete: '确认永久删除这个归档会话？',
    confirmDeleteBody: '删除后不可恢复（不进回收站），请确认这不是你还需要的内容。',
    deleted: '已删除归档会话：{id}',
    deleteFailed: '删除失败：{error}',
    opFailed: '操作失败：{error}',
    setFailed: '设置失败：{error}',
    autoTitle: '自动归档',
    autoEnabledDry: '已启用 · 试跑模式',
    autoEnabledLive: '已启用 · 真归档',
    autoDisabled: '已停用',
    autoThreshold: '阈值 {hours} 小时未活跃',
    autoEvery: '每 {hours} 小时检查一次',
    autoLastRun: '上次运行 {time}',
    autoNeverRun: '尚未运行',
    autoTotal: '累计归档 {n} 个',
    autoRunNow: '立即试跑',
    autoBusy: '已经在跑了（{who} 于 {time} 开始），这一次没有排第二份。',
    autoEnable: '启用（先试跑）',
    autoGoLive: '改为真归档',
    autoGoDry: '改回试跑',
    autoDisable: '停用',
    autoScanned: '扫描 {n} 个会话',
    autoCandidates: '候选 {n} 个',
    autoDryRun: '试跑（未移动任何文件）',
    autoArchived: '已归档 {n} 个',
    autoSkipped: '跳过 {n} 个',
    autoErrors: '失败 {n} 个',
    autoBatch: '批次 {batch}',
    autoRunDone: '试跑完成：',
    autoArchiveDone: '自动归档完成：',
    autoLastDry: '上次结果：',
    autoLastReal: '上次归档：',
    autoUpdated: '自动归档设置已更新。',
    autoConfirmLive:
      '确认让自动归档真的移动会话？\n\n判据：{hours} 小时未活跃、回合已闭合、且不是空壳会话。\n移动后仍可在本列表里预览和恢复。',
    autoDaysIdle: '{days} 天未活跃',
    footer:
      '这里管理的是被物理移出 sessions 目录的老会话（归档目录 {dir}）。恢复=复制回 sessions（校验通过才删源），删除=永久删除。',
  },
  en: {
    nav: 'Archived Sessions',
    loadFailed: 'Load failed: {error}',
    loadingText: 'Reading archive directory…',
    retry: 'Retry',
    refresh: 'Refresh',
    refreshing: 'Loading…',
    empty: 'No sessions in the archive directory.',
    unknownCwd: 'Unknown working directory',
    unknownTime: 'unknown time',
    summary: '{total} archived session(s) · {size}',
    batch: 'batch',
    turns: '{n} turns',
    goto: 'Go to',
    flagEmpty: 'empty',
    flagArchived: 'was archived',
    flagNoMeta: 'no metadata',
    actionPreview: 'Preview',
    actionCollapse: 'Collapse',
    actionRestore: 'Restore',
    actionDelete: 'Delete',
    busy: 'Working…',
    decoding: 'Decoding session log…',
    previewFailed: 'Preview failed: {error}',
    previewMeta: '{total} message(s)',
    previewTail: ' (showing last {n})',
    cwdLabel: 'cwd {cwd}',
    roleUser: 'User',
    roleAssistant: 'Assistant',
    truncated: '(truncated)',
    emptyLog:
      'This session log has no conversation messages — usually the session was opened and closed without sending anything.',
    emptySafe: 'Such empty sessions are safe to delete.',
    sessionId: 'session id {id}',
    preset: 'preset {name}',
    delegation: 'delegation depth {depth}',
    eventTypes: 'Log events: {list}',
    confirmRestore: 'Restore this archived session?',
    confirmRestoreBody:
      'The session directory is copied back into the sessions directory (the archived source is removed only after the copy is verified). Existing data is never overwritten.',
    restoreUnarchived:
      'This session also carried the GUI "archived" flag; the flag was removed. Restart DSH once to see it back in the normal list.',
    restored: 'Restored: {path}',
    restoreFailed: 'Restore failed: {error}',
    confirmDelete: 'Permanently delete this archived session?',
    confirmDeleteBody: 'This cannot be undone (no recycle bin). Make sure you no longer need it.',
    deleted: 'Deleted archived session: {id}',
    deleteFailed: 'Delete failed: {error}',
    opFailed: 'Operation failed: {error}',
    setFailed: 'Update failed: {error}',
    autoTitle: 'Auto archive',
    autoEnabledDry: 'enabled · dry run',
    autoEnabledLive: 'enabled · live',
    autoDisabled: 'disabled',
    autoThreshold: 'idle for {hours}h',
    autoEvery: 'checked every {hours}h',
    autoLastRun: 'last run {time}',
    autoNeverRun: 'never ran',
    autoTotal: '{n} archived in total',
    autoRunNow: 'Dry run now',
    autoBusy: 'already running (started {time} by {who}); this trigger was not queued.',
    autoEnable: 'Enable (dry run first)',
    autoGoLive: 'Switch to live',
    autoGoDry: 'Back to dry run',
    autoDisable: 'Disable',
    autoScanned: 'scanned {n}',
    autoCandidates: 'candidates {n}',
    autoDryRun: 'dry run (nothing moved)',
    autoArchived: 'archived {n}',
    autoSkipped: 'skipped {n}',
    autoErrors: 'failed {n}',
    autoBatch: 'batch {batch}',
    autoRunDone: 'Dry run done: ',
    autoArchiveDone: 'Auto archive done: ',
    autoLastDry: 'Last result: ',
    autoLastReal: 'Last archive: ',
    autoUpdated: 'Auto archive settings updated.',
    autoConfirmLive:
      'Let auto archive really move sessions?\n\nCriteria: idle for {hours}h, closed turn, not an empty shell.\nEverything stays previewable and restorable from this list.',
    autoDaysIdle: '{days}d idle',
    footer:
      'This list manages old sessions physically moved out of the sessions directory (archive root {dir}). Restore copies them back (source removed only after verification); delete is permanent.',
  },
}

/** 默认配置（所有可调项都在这里；用户配置只需写要改的键）。 */
export const DEFAULT_CONFIG = {
  /** 界面语言：zh | en | 其他（其他语言时回退 en）。 */
  language: 'zh',
  paths: {
    /** null = 由 DSH_HOME 推导（<home>/_archived-sessions）。 */
    home: null,
    archiveRoot: null,
    sessionsRoot: null,
    storagesDir: null,
    workspaceFile: null,
    projcacheFile: null,
    /**
     * 会话索引的**单键**目录（主包按会话一文件写：`<storages>/session_projcache/sessions/<sid>.json`）。
     * null = 由 storagesDir 推导；单键文件不存在时才退回整表 projcacheFile。
     */
    projcacheSessionsDir: null,
  },
  archive: {
    /** 每个批次目录里的清单文件名。 */
    manifestFile: 'manifest.json',
    /** 自动归档运行状态文件名（写在归档根下）。 */
    stateFile: '.auto-archive.json',
    /**
     * 自动归档状态文件的完整路径覆盖（可选）。
     * 默认 null = 归档根下的 stateFile；若归档根只读，把它指到可写目录。
     */
    statePath: null,
    /** 未知工作目录时使用的 sessions 子目录名。 */
    unknownCwdKey: '_no-cwd',
    /**
     * 列表元数据兜底时向前解几帧（会话头 / 首条用户消息通常在最前几帧里）。
     * 一帧可能只装少量事件，所以不能只看第一帧。
     */
    headerFrames: 8,
    /** 恢复/移动时的复制尝试次数（配合同步盘/网络盘的独占锁窗口）。 */
    copyRetries: 3,
    /** 复制重试基础退避（毫秒）。 */
    copyRetryDelayMs: 120,
    /** 删除目录的重试次数。 */
    removeRetries: 4,
    /** 删除重试基础退避（毫秒）。 */
    removeRetryDelayMs: 180,
    /**
     * 搬运算批：累计复制这么多字节就把事件循环让出去一次（默认 1 MiB）。
     * 调小 ⇒ 让出更频繁（进程更"跟手"，吞吐略降）。
     */
    copyBatchBytes: 1048576,
    /** 搬运算批：累计复制这么多个文件就让出一次（默认 8）。 */
    copyBatchFiles: 8,
  },
  preview: {
    /** 预览返回的消息条数。 */
    maxMessages: 50,
    /** 单条消息最大字符数，超出截断。 */
    maxMessageChars: 4000,
  },
  server: {
    /** HTTP 路由前缀。 */
    apiPrefix: '/api/dsh-archive-sessions',
    /** 请求体大小上限（字节）。 */
    maxJsonBodyBytes: 262144,
    /** 允许访问的主机名（loopback 之外一律 403）。 */
    allowedHosts: ['127.0.0.1', 'localhost', '[::1]'],
    /** 是否拒绝跨站请求（sec-fetch-site: cross-site）。 */
    rejectCrossSite: true,
    /** 是否校验 Origin 与 Host 同源。 */
    sameOriginOnly: true,
  },
  auto: {
    /** 是否开启自动归档（默认关闭，需显式启用）。 */
    enabled: false,
    /** 默认试跑模式：只列出候选，不移动文件。 */
    dryRun: true,
    /** 多少小时未活跃才成为候选。 */
    hours: 48,
    /** 两次自动归档的间隔（毫秒）。 */
    intervalMs: 21600000,
    /** 候选择大小下限（MB），0 = 不限。 */
    minSizeMb: 0,
    /** 单次最多归档多少个。 */
    maxPerRun: 50,
    /** 定时器 tick 间隔（毫秒）。 */
    tickMs: 60000,
    /** 启动后多久开始第一次检查（毫秒），避免和主包启动争 IO。 */
    startDelayMs: 120000,
    /** 空壳判定：大于该字节数的日志一定不是空壳，跳过全量解码。 */
    emptyScanMaxBytes: 65536,
  },
  /** 界面文案覆盖（当前语言）。 */
  ui: {},
  /** 按语言覆盖界面文案。 */
  uiByLanguage: {},
}

const VALIDATORS = {
  'language': asString,
  'paths.home': asNullableString,
  'paths.archiveRoot': asNullableString,
  'paths.sessionsRoot': asNullableString,
  'paths.storagesDir': asNullableString,
  'paths.workspaceFile': asNullableString,
  'paths.projcacheFile': asNullableString,
  'paths.projcacheSessionsDir': asNullableString,
  'archive.manifestFile': asNonEmptyString,
  'archive.stateFile': asNonEmptyString,
  'archive.statePath': asNullableString,
  'archive.unknownCwdKey': asNonEmptyString,
  'archive.headerFrames': asInt(1, 64),
  'archive.copyRetries': asInt(1, 20),
  'archive.copyRetryDelayMs': asInt(0, 60000),
  'archive.removeRetries': asInt(1, 20),
  'archive.removeRetryDelayMs': asInt(0, 60000),
  'archive.copyBatchBytes': asInt(4096, 256 * 1024 * 1024),
  'archive.copyBatchFiles': asInt(1, 100000),
  'preview.maxMessages': asInt(1, 2000),
  'preview.maxMessageChars': asInt(100, 1000000),
  'server.apiPrefix': asApiPrefix,
  'server.maxJsonBodyBytes': asInt(1024, 64 * 1024 * 1024),
  'server.allowedHosts': asStringArray,
  'server.rejectCrossSite': asBoolean,
  'server.sameOriginOnly': asBoolean,
  'auto.enabled': asBoolean,
  'auto.dryRun': asBoolean,
  'auto.hours': asInt(1, 24 * 365),
  'auto.intervalMs': asInt(60000, 30 * 24 * 3600 * 1000),
  'auto.minSizeMb': asNumber(0, 1024 * 1024),
  'auto.maxPerRun': asInt(1, 100000),
  'auto.tickMs': asInt(1000, 3600000),
  'auto.startDelayMs': asInt(0, 3600000),
  'auto.emptyScanMaxBytes': asInt(0, 1024 * 1024 * 1024),
}

function asString(value) {
  return typeof value === 'string' ? value : undefined
}
/** 路径字段允许显式 null（= 由 DSH_HOME 推导）。 */
function asNullableString(value) {
  if (value === null) return null
  return typeof value === 'string' ? value : undefined
}
function asNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}
function asBoolean(value) {
  return typeof value === 'boolean' ? value : undefined
}
function asNumber(min, max) {
  return (value) => {
    const n = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(n)) return undefined
    return Math.min(max, Math.max(min, n))
  }
}
function asInt(min, max) {
  const num = asNumber(min, max)
  return (value) => {
    const n = num(value)
    return n === undefined ? undefined : Math.round(n)
  }
}
function asStringArray(value) {
  if (!Array.isArray(value)) return undefined
  const list = value.filter((item) => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
  return list.length > 0 ? list : undefined
}
function asApiPrefix(value) {
  const text = asNonEmptyString(value)
  if (text === undefined) return undefined
  const withSlash = text.startsWith('/') ? text : '/' + text
  return withSlash.replace(/\/+$/, '') || undefined
}

function getPath(object, path) {
  let current = object
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = current[key]
  }
  return current
}

function setPath(object, path, value) {
  const keys = path.split('.')
  let current = object
  for (const key of keys.slice(0, -1)) {
    if (current[key] === null || typeof current[key] !== 'object' || Array.isArray(current[key])) current[key] = {}
    current = current[key]
  }
  current[keys[keys.length - 1]] = value
}

function deepMerge(base, override) {
  if (override === undefined) return base
  if (Array.isArray(override)) return override.slice()
  if (override === null || typeof override !== 'object') return override
  if (base === null || typeof base !== 'object' || Array.isArray(base)) {
    const out = {}
    for (const [key, value] of Object.entries(override)) out[key] = deepMerge(undefined, value)
    return out
  }
  const out = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue
    out[key] = deepMerge(base[key], value)
  }
  return out
}

function readJsonFile(filePath) {
  try {
    if (!existsSync(filePath)) return { value: undefined, error: undefined }
    return { value: JSON.parse(readFileSync(filePath, 'utf8')), error: undefined }
  } catch (err) {
    // 隐去绝对路径，避免把本机目录结构写进日志。
    return { value: undefined, error: err instanceof Error ? err.message : String(err) }
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 校验并清洗未知 / 非法字段；返回清洗后的配置与错误列表。 */
function sanitize(config) {
  const errors = []
  const clean = JSON.parse(JSON.stringify(config))
  for (const path of Object.keys(VALIDATORS)) {
    const value = getPath(clean, path)
    if (value === undefined) continue
    const checked = VALIDATORS[path](value)
    if (checked === undefined) {
      errors.push(`${path}: invalid value ${JSON.stringify(value)}`)
      setPath(clean, path, getPath(DEFAULT_CONFIG, path))
    } else {
      setPath(clean, path, checked)
    }
  }
  for (const key of ['ui', 'uiByLanguage', 'paths', 'archive', 'preview', 'server', 'auto']) {
    if (!isPlainObject(clean[key])) {
      if (clean[key] !== undefined) errors.push(`${key}: expected an object`)
      clean[key] = isPlainObject(DEFAULT_CONFIG[key]) ? { ...DEFAULT_CONFIG[key] } : {}
    }
  }
  return { config: clean, errors }
}

let cached = null

/** 显式配置文件路径（环境变量优先，其次按主机名探测，最后通用名）。 */
export function configFilePath() {
  const fromEnv = process.env.ARCHIVE_SESSIONS_CONFIG
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return resolve(fromEnv.trim())
  return discoverConfigFile()
}

/** DSH 用户数据根：DSH_HOME 优先，否则 ~/.dsh（跨平台，不读 USERPROFILE）。 */
export function homeDir() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return resolve(fromEnv.trim())
  return join(homedir(), '.dsh')
}

/**
 * 配置文件名：优先 `<hostname>.archive-sessions.config.json`（一台机器一份，便于多机共存），
 * 找不到再退回通用名 `archive-sessions.config.json`。
 */
function discoverConfigFile() {
  const home = homeDir()
  let host = ''
  try {
    host = hostname()
  } catch {
    host = ''
  }
  if (host.length > 0) {
    const perHost = join(home, host + '.' + CONFIG_FILE_NAME)
    if (existsSync(perHost)) return perHost
  }
  return join(home, CONFIG_FILE_NAME)
}

function applyEnv(config) {
  const envHome = process.env.DSH_HOME
  if (typeof envHome === 'string' && envHome.trim().length > 0) config.paths.home = resolve(envHome.trim())
  const envSessions = process.env.DSH_SESSIONS_DIR
  if (typeof envSessions === 'string' && envSessions.trim().length > 0) config.paths.sessionsRoot = resolve(envSessions.trim())
  const envArchive = process.env.ARCHIVE_SESSIONS_DIR
  if (typeof envArchive === 'string' && envArchive.trim().length > 0) config.paths.archiveRoot = resolve(envArchive.trim())
  const envPrefix = process.env.ARCHIVE_SESSIONS_API_PREFIX
  if (typeof envPrefix === 'string' && envPrefix.trim().length > 0) {
    const checked = asApiPrefix(envPrefix)
    if (checked !== undefined) config.server.apiPrefix = checked
  }
  return config
}

function resolveRelativePaths(config) {
  const home = config.paths.home
  if (typeof home === 'string' && home.length > 0) config.paths.home = resolve(home)
  for (const key of ['archiveRoot', 'sessionsRoot', 'storagesDir', 'workspaceFile', 'projcacheFile', 'projcacheSessionsDir']) {
    const value = config.paths[key]
    if (typeof value === 'string' && value.length > 0) {
      config.paths[key] = modelAbsolute(value, config.paths.home)
    } else {
      config.paths[key] = null
    }
  }
  return config
}

/**
 * 配置里的相对路径按 DSH home 解析（写 `"archiveRoot": "archive"` 就得到 `<home>/archive`）。
 * 这样配置文件可以跨机器搬运，不必把用户名写进去。
 */
function modelAbsolute(value, home) {
  const trimmed = value.trim()
  if (isAbsolute(trimmed)) return resolve(trimmed)
  return join(home, trimmed)
}

/** 载入配置（每次调用重新读文件；文件不存在时返回默认值）。 */
export function loadConfig(options = {}) {
  const filePath = options.configPath ?? configFilePath()
  const { value: raw, error } = readJsonFile(filePath)
  const errors = []
  if (error !== undefined) errors.push(`config file could not be parsed: ${error}`)
  if (raw !== undefined && !isPlainObject(raw)) errors.push('config file must contain a JSON object')
  const merged = deepMerge(DEFAULT_CONFIG, isPlainObject(raw) ? raw : undefined)
  const { config, errors: sanitizeErrors } = sanitize(merged)
  errors.push(...sanitizeErrors)
  const withEnv = applyEnv(config)
  resolveRelativePaths(withEnv)
  const result = {
    config: withEnv,
    errors,
    source: existsSync(filePath) ? filePath : null,
  }
  if (options.cache === true) cached = result
  return result
}

/** 进程内缓存（同插件实例内多处共用；文件改动需重启或调用 loadConfig 刷新）。 */
export function getConfig() {
  if (cached === null) return loadConfig({ cache: true })
  return cached
}

/** 配置是否来自用户文件（用于前端提示）。 */
export function describeSource(options = {}) {
  const filePath = options.configPath ?? configFilePath()
  if (!existsSync(filePath)) return { path: filePath, exists: false, mtimeMs: null }
  let mtimeMs = null
  try {
    mtimeMs = statSync(filePath).mtimeMs
  } catch { /* ignore */ }
  return { path: filePath, exists: true, mtimeMs }
}

/** 当前语言的默认界面文案（en 兜底）。 */
export function defaultUi(language) {
  return DEFAULT_UI[language] ?? DEFAULT_UI.en
}

/** 有效界面文案 = 默认(en→lang) ⊕ uiByLanguage[lang] ⊕ ui。 */
export function resolveUi(config) {
  const lang = typeof config.language === 'string' ? config.language : 'zh'
  const base = { ...DEFAULT_UI.en, ...defaultUi(lang) }
  const byLang = isPlainObject(config.uiByLanguage) && isPlainObject(config.uiByLanguage[lang]) ? config.uiByLanguage[lang] : {}
  const flat = isPlainObject(config.ui) ? config.ui : {}
  const out = { ...base }
  for (const [key, value] of Object.entries(byLang)) {
    if (typeof value === 'string') out[key] = value
  }
  for (const [key, value] of Object.entries(flat)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

/** 供前端使用的公开配置（只暴露 UI 需要的项，绝不返回本机绝对路径）。 */
export function publicConfig(config) {
  return {
    language: config.language,
    apiPrefix: config.server.apiPrefix,
    preview: { maxMessages: config.preview.maxMessages, maxMessageChars: config.preview.maxMessageChars },
    auto: {
      hours: config.auto.hours,
      intervalMs: config.auto.intervalMs,
      maxPerRun: config.auto.maxPerRun,
      dryRun: config.auto.dryRun,
      enabled: config.auto.enabled,
    },
    ui: resolveUi(config),
  }
}
