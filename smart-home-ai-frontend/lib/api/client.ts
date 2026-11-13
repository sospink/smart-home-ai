/**
 * 统一 API 客户端 - 所有后端请求通过此 client 发送
 */
import { getToken, handleUnauthorized } from '@/lib/auth-storage'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || '/api'
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

interface RequestOptions {
  params?: Record<string, string | number | boolean>
  signal?: AbortSignal
  timeoutMs?: number
  redirectOnUnauthorized?: boolean
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(
  method: HttpMethod,
  path: string,
  data?: unknown,
  options?: RequestOptions
): Promise<T> {
  const token = getToken()
  const url = new URL(`${API_BASE}${path}`, window.location.origin)

  if (options?.params) {
    Object.entries(options.params).forEach(([k, v]) =>
      url.searchParams.set(k, String(v))
    )
  }

  const controller = new AbortController()
  let timedOut = false
  const handleExternalAbort = () => controller.abort()
  if (options?.signal?.aborted) controller.abort()
  else options?.signal?.addEventListener('abort', handleExternalAbort, { once: true })
  const timeoutId = window.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)

  let res: Response
  try {
    res = await fetch(url.toString(), {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: data ? JSON.stringify(data) : undefined,
      signal: controller.signal,
    })
    if (res.status === 401 && options?.redirectOnUnauthorized !== false) {
      handleUnauthorized()
      throw new ApiError(401, '登录已过期，请重新登录')
    }

    if (!res.ok) {
      const error = await res.json().catch(() => ({ detail: '请求失败' }))
      const detail = error?.detail
      const message = typeof detail === 'string'
        ? detail
        : Array.isArray(detail)
          ? detail.map((item) => item?.msg).filter(Boolean).join('；')
          : '请求失败'
      throw new ApiError(res.status, message || '请求失败')
    }

    if (res.status === 204) return undefined as T
    return await res.json()
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (timedOut) throw new ApiError(0, '请求超时，外部服务可能离线或网络不可达')
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ApiError(0, '无法连接后端服务，请检查网络后重试')
  } finally {
    window.clearTimeout(timeoutId)
    options?.signal?.removeEventListener('abort', handleExternalAbort)
  }
}

async function download(path: string, options?: RequestOptions): Promise<{ blob: Blob; headers: Headers }> {
  const token = getToken()
  const url = new URL(`${API_BASE}${path}`, window.location.origin)
  if (options?.params) {
    Object.entries(options.params).forEach(([key, value]) => url.searchParams.set(key, String(value)))
  }
  const controller = new AbortController()
  let timedOut = false
  const handleExternalAbort = () => controller.abort()
  if (options?.signal?.aborted) controller.abort()
  else options?.signal?.addEventListener('abort', handleExternalAbort, { once: true })
  const timeoutId = window.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options?.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(url.toString(), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    })
    if (response.status === 401) {
      handleUnauthorized()
      throw new ApiError(401, '登录已过期，请重新登录')
    }
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: '文件下载失败' }))
      throw new ApiError(response.status, error.detail || '文件下载失败')
    }
    return { blob: await response.blob(), headers: response.headers }
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (timedOut) throw new ApiError(0, '文件导出超时，请缩小筛选范围或检查后端状态')
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ApiError(0, '无法连接后端服务，请检查网络后重试')
  } finally {
    window.clearTimeout(timeoutId)
    options?.signal?.removeEventListener('abort', handleExternalAbort)
  }
}

export const apiClient = {
  get: <T>(path: string, options?: RequestOptions) =>
    request<T>('GET', path, undefined, options),
  post: <T>(path: string, data?: unknown, options?: RequestOptions) =>
    request<T>('POST', path, data, options),
  put: <T>(path: string, data?: unknown, options?: RequestOptions) =>
    request<T>('PUT', path, data, options),
  patch: <T>(path: string, data?: unknown, options?: RequestOptions) =>
    request<T>('PATCH', path, data, options),
  delete: <T>(path: string, options?: RequestOptions) =>
    request<T>('DELETE', path, undefined, options),
  download,
}
