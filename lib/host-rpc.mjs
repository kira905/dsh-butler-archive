/**
 * dsh-butler-archive / lib/host-rpc.mjs
 *
 * 极简 Host RPC 客户端（**只为一元查询**用，本仓只用到 `session.list`）。
 *
 * 为什么自带一份而不是依赖别的包：本仓是「零运行时依赖」的插件，健康自检 CLI 也保持这个口径。
 * 这里只实现两件事：
 *   ① `hostCookie()` —— 用签名密钥自签 `/api` 通道的会话 cookie（`dsh-auth-<sha256(authority)>`，
 *      HMAC-SHA256 签名）。密钥**只从显式参数或环境变量来**：
 *        `opts.cookieSecret` > env `DSH_RPC_COOKIE_SECRET`（两者都是 base64 的 32 字节密钥）。
 *      🔴 本文件**不读任何凭据文件、不发现路径** —— 想用就自己把密钥传进来。
 *   ② `hostRpc()` —— 发一条一元 RPC。先试新形态（`POST /api/<ns>/<method>`，参数装在
 *      `payload.args.<wire>`），失败再回落老形态（`POST /api/<ns>.<method>`，参数在 `payload`）。
 *
 * 红线：**不硬编码 token、不关鉴权门**。没有密钥时 cookie 为 null，调用方要么走老形态、
 * 要么拿到一个可读的 401 错误（自行降级，绝不假装成功）。
 */

import crypto from 'node:crypto'

/** 已知端点表（只登记本仓用得到的；其余按「点号 → 斜杠」通用规则推导）。 */
const ENDPOINTS = {
  'session.list': { endpoint: 'session/list', wire: '_request' },
}

const COOKIE_CACHE = new Map()

const b64url = (b) => Buffer.from(b).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')

/** 解析可用的签名密钥（显式 > env）；读不到 ⇒ undefined。 */
function resolveSecretB64(opts) {
  if (opts && typeof opts.cookieSecret === 'string' && opts.cookieSecret) return opts.cookieSecret
  const env = process.env.DSH_RPC_COOKIE_SECRET
  if (env && env.trim()) return env.trim()
  return undefined
}

/**
 * 取 `/api` 通道的合法会话 cookie；无密钥时返回 null（调用方走老形态或降级）。
 * @param {string} baseUrl 形如 http://127.0.0.1:3080
 * @param {{maxAgeDays?: number, cookieSecret?: string}} [opts]
 * @returns {{name: string, value: string, header: string}|null}
 */
export function hostCookie(baseUrl, opts = {}) {
  const url = String(baseUrl).replace(/\/+$/, '')
  const secretB64 = resolveSecretB64(opts)
  const key = url + '|' + (secretB64 ? crypto.createHash('sha256').update(String(secretB64)).digest('hex').slice(0, 16) : 'none')
  if (COOKIE_CACHE.has(key)) return COOKIE_CACHE.get(key)
  let out = null
  try {
    const authority = new URL(url).host
    if (secretB64) {
      const secret = Buffer.from(
        secretB64.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (secretB64.length % 4)) % 4), 'base64')
      if (secret.length === 32) {
        const name = 'dsh-auth-' + b64url(crypto.createHash('sha256').update(authority).digest())
        const issuedAt = Date.now()
        const expiresAt = issuedAt + (opts.maxAgeDays ?? 30) * 86400_000
        const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }), 'utf8'))
        const sig = b64url(crypto.createHmac('sha256', secret).update(body).digest())
        const value = `v1.${body}.${sig}`
        out = { name, value, header: `${name}=${value}` }
      }
    }
  } catch { out = null }
  COOKIE_CACHE.set(key, out)
  return out
}

/** 清掉 cookie 缓存（密钥轮换 / 测试用）。 */
export function clearCookieCache() { COOKIE_CACHE.clear() }

function splitMethod(legacyMethod) {
  const known = ENDPOINTS[legacyMethod]
  if (known) return known
  if (legacyMethod.includes('/')) return { endpoint: legacyMethod, wire: 'request' }
  const i = legacyMethod.indexOf('.')
  return i === -1
    ? { endpoint: legacyMethod, wire: 'request' }
    : { endpoint: legacyMethod.slice(0, i) + '/' + legacyMethod.slice(i + 1), wire: 'request' }
}

function post(baseUrl, pathname, body, cookie, timeoutMs) {
  const headers = { 'content-type': 'application/json' }
  if (cookie) headers.cookie = cookie.header
  return fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs ?? 20_000),
  })
}

async function readBody(res) {
  const fallback = (m) => ({ result: { ok: false, error: { code: 'parse', message: String(m).slice(0, 200) } } })
  try {
    const t = await res.text()
    try { return JSON.parse(t) } catch { return fallback(t) }
  } catch (e) { return fallback(e?.message ?? String(e)) }
}

/**
 * 调一个 Host RPC（兼容新/老两种形态）。
 *
 * @param {string} baseUrl     如 http://127.0.0.1:3080
 * @param {string} legacyMethod 点号方法名，如 'session.list'
 * @param {object} [payload]    业务参数
 * @param {{timeoutMs?: number, cookie?: object|null, cookieSecret?: string}} [opts]
 * @returns {Promise<{status:number, body:any, request:string, wire:string|null}>}
 */
export async function hostRpc(baseUrl, legacyMethod, payload = {}, opts = {}) {
  const base = String(baseUrl).replace(/\/+$/, '')
  const { endpoint, wire: tableWire } = splitMethod(legacyMethod)
  const timeoutMs = opts.timeoutMs
  const cookie = opts.cookie === null ? null : (opts.cookie ?? hostCookie(base, opts) ?? null)

  const tryLegacy = async () => {
    const envelope = { type: 'client-request', rpcId: crypto.randomUUID(), method: legacyMethod, payload }
    const res = await post(base, `/api/${legacyMethod}`, envelope, null, timeoutMs)
    return { status: res.status, body: await readBody(res), request: `/api/${legacyMethod}`, wire: null }
  }

  const tryNew = async (wireName) => {
    const args = wireName === null ? {} : { [wireName]: payload }
    const envelope = { type: 'client-request', rpcId: crypto.randomUUID(), method: endpoint, payload: { args } }
    const res = await post(base, `/api/${endpoint}`, envelope, cookie, timeoutMs)
    return { status: res.status, body: await readBody(res), request: `/api/${endpoint}`, wire: wireName }
  }

  const errOf = (r) => r.body?.result?.error ?? (typeof r.body === 'object' ? r.body?.error : undefined)
  const isArgsMismatch = (r) => errOf(r)?.code === 'gateway/arguments-invalid' || errOf(r)?.code === 'gateway/bad-request'
  const missingWire = (r) => String(errOf(r)?.message ?? '').match(/missing "([^"]+)"/)?.[1]

  let wireName = tableWire === undefined ? 'request' : tableWire
  try {
    let r = await tryNew(wireName)
    // 参数名不对：用错误信息里的 missing 名重试一次（自适应）
    if (r.status === 200 && isArgsMismatch(r)) {
      const miss = missingWire(r)
      if (miss && miss !== wireName) { wireName = miss; r = await tryNew(wireName) }
    }
    if (r.status === 200 && (r.body?.result?.ok === true || r.body?.result?.ok === false)) return r
    if (r.status === 404 || r.status === 401 || r.status === 405) {
      const old = await tryLegacy()
      if (old.status === 200 && old.body?.result !== undefined) return old
      return r
    }
    return r
  } catch (e) {
    // 网络异常：老形态可达则回落（老主包的 /api 无鉴权，不会 401）
    try {
      const old = await tryLegacy()
      if (old.status === 200) return old
    } catch { /* ignore */ }
    throw e
  }
}

/** 便捷封装：取 result.value，失败抛（错误信息带 HTTP 状态与 request 路径）。 */
export async function hostRpcValue(baseUrl, legacyMethod, payload = {}, opts = {}) {
  const { status, body, request } = await hostRpc(baseUrl, legacyMethod, payload, opts)
  if (body?.result?.ok === true) return body.result.value
  const err = body?.result?.error
  throw new Error(`${legacyMethod} failed: HTTP ${status} ${err ? `${err.code}: ${err.message}` : JSON.stringify(body)?.slice(0, 200)} (${request})`)
}

export default { hostRpc, hostRpcValue, hostCookie, clearCookieCache }
