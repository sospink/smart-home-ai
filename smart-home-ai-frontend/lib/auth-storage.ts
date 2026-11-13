/**
 * Token 本地存储管理
 */

const TOKEN_KEY = 'access_token'
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30
export const AUTH_STORAGE_EVENT = 'smart-home-auth-storage-change'

type TokenWriteOptions = {
  notify?: boolean
  reason?: 'login' | 'logout' | 'unauthorized' | 'refresh'
}

let unauthorizedRedirectStarted = false

function notifyAuthChange(token: string | null, reason: NonNullable<TokenWriteOptions['reason']>) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(AUTH_STORAGE_EVENT, { detail: { token, reason } }))
}

function tokenCookieMaxAge(token: string): number {
  try {
    const encoded = token.split('.')[1]
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const payload = JSON.parse(atob(padded)) as { exp?: number }
    if (typeof payload.exp !== 'number') return COOKIE_MAX_AGE
    return Math.max(0, Math.min(COOKIE_MAX_AGE, payload.exp - Math.floor(Date.now() / 1000)))
  } catch {
    return COOKIE_MAX_AGE
  }
}

function readCookieToken(): string | null {
  if (typeof document === 'undefined') return null

  const cookie = document.cookie
    .split('; ')
    .find(row => row.startsWith(`${TOKEN_KEY}=`))

  return cookie ? decodeURIComponent(cookie.split('=').slice(1).join('=')) : null
}

export const getToken = (): string | null =>
  typeof window !== 'undefined'
    ? localStorage.getItem(TOKEN_KEY) || readCookieToken()
    : null

/** 只使用 JWT 的用户标识区分内存缓存，不把 Token 明文写入缓存键。 */
export const getAuthCacheScope = (): string => {
  const token = getToken()
  if (!token) return 'anonymous'
  let fingerprint = 2166136261
  for (let index = 0; index < token.length; index += 1) {
    fingerprint ^= token.charCodeAt(index)
    fingerprint = Math.imul(fingerprint, 16777619)
  }
  try {
    const encoded = token.split('.')[1]
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const payload = JSON.parse(atob(padded)) as { sub?: string | number }
    const subject = payload.sub === undefined ? 'authenticated' : `user:${String(payload.sub)}`
    return `${subject}:${(fingerprint >>> 0).toString(36)}`
  } catch {
    return `authenticated:${(fingerprint >>> 0).toString(36)}`
  }
}

export const setToken = (token: string, options: TokenWriteOptions = {}): void => {
  const previousToken = getToken()
  localStorage.setItem(TOKEN_KEY, token)
  document.cookie = `${TOKEN_KEY}=${encodeURIComponent(token)}; Path=/; Max-Age=${tokenCookieMaxAge(token)}; SameSite=Lax`
  if (options.notify !== false && previousToken !== token) {
    notifyAuthChange(token, options.reason || 'login')
  }
}

export const clearToken = (options: TokenWriteOptions = {}): void => {
  const previousToken = getToken()
  localStorage.removeItem(TOKEN_KEY)
  document.cookie = `${TOKEN_KEY}=; Path=/; Max-Age=0; SameSite=Lax`
  if (options.notify !== false && previousToken) {
    notifyAuthChange(null, options.reason || 'logout')
  }
}

function currentReturnPath() {
  if (typeof window === 'undefined') return ''
  const path = `${window.location.pathname}${window.location.search}${window.location.hash}`
  return path.startsWith('/') && !path.startsWith('//') ? path : ''
}

/** 统一处理受保护请求的会话失效，避免并发 401 重复跳转或丢失原页面。 */
export function handleUnauthorized(options: { redirect?: boolean } = {}) {
  clearToken({ reason: 'unauthorized' })
  if (options.redirect === false || typeof window === 'undefined' || unauthorizedRedirectStarted) return

  const alreadyAtLogin = window.location.pathname === '/home'
    && new URLSearchParams(window.location.search).get('login') === '1'
  if (alreadyAtLogin) return

  unauthorizedRedirectStarted = true
  const loginUrl = new URL('/home', window.location.origin)
  loginUrl.searchParams.set('login', '1')
  const next = currentReturnPath()
  if (next && window.location.pathname !== '/home') loginUrl.searchParams.set('next', next)
  window.location.replace(`${loginUrl.pathname}${loginUrl.search}`)
}
