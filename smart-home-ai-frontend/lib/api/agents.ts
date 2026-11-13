import { apiClient } from '@/lib/api/client'
import { waitForSharedRead } from '@/lib/api/shared-read'
import { getAuthCacheScope, getToken, handleUnauthorized } from '@/lib/auth-storage'
import type {
  AgentCapabilitiesResponse,
  AgentFrameworkOverview,
  AgentInstance,
  AgentInstanceListParams,
  AgentInstanceListResponse,
  AgentTemplateLibraryDetail,
  AgentTemplateLibraryItem,
  AgentTemplateLibraryListParams,
  AgentTemplateLibraryListResponse,
  AgentTemplateLibraryUploadResponse,
  AgentTestRunResult,
  AgentRunListParams,
  AgentRunListResponse,
  AgentTemplateDoc,
  AgentUploadDslResult,
  CreateAgentInstancePayload,
  UpdateAgentTemplateLibraryPayload,
  UpdateAgentInstancePayload,
} from '@/types/agents'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || '/api'
const CACHE_TTL_MS = 30_000
const AGENT_READ_TIMEOUT_MS = 15_000
const AGENT_WRITE_TIMEOUT_MS = 20_000
const AGENT_TEST_TIMEOUT_MS = 50_000
const AGENT_UPLOAD_TIMEOUT_MS = 60_000
const AGENT_DOWNLOAD_TIMEOUT_MS = 45_000
export const MAX_AGENT_DSL_FILE_SIZE = 2 * 1024 * 1024
const cache = new Map<string, { expiresAt: number; value: unknown }>()
const pending = new Map<string, Promise<unknown>>()
const forcedPending = new Map<string, Promise<unknown>>()

export function validateAgentDslFile(file: File) {
  if (!/\.(ya?ml)$/i.test(file.name)) throw new Error('仅支持上传 .yml 或 .yaml DSL 文件')
  if (file.size <= 0) throw new Error('DSL 文件不能为空')
  if (file.size > MAX_AGENT_DSL_FILE_SIZE) throw new Error('DSL 文件不能超过 2MB')
}

async function cachedRequest<T>(key: string, request: () => Promise<T>, force = false, signal?: AbortSignal): Promise<T> {
  const scopedKey = `${getAuthCacheScope()}:${key}`
  const cached = cache.get(scopedKey)
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value as T
  const active = pending.get(scopedKey)
  if (!force && active) return waitForSharedRead(active as Promise<T>, signal)
  const forcedActive = forcedPending.get(scopedKey)
  if (force && forcedActive) return waitForSharedRead(forcedActive as Promise<T>, signal)
  const promise = request()
    .then((value) => {
      if (pending.get(scopedKey) === promise) {
        cache.set(scopedKey, { value, expiresAt: Date.now() + CACHE_TTL_MS })
      }
      return value
    })
    .finally(() => {
      if (pending.get(scopedKey) === promise) pending.delete(scopedKey)
      if (forcedPending.get(scopedKey) === promise) forcedPending.delete(scopedKey)
    })
  pending.set(scopedKey, promise)
  if (force) forcedPending.set(scopedKey, promise)
  return waitForSharedRead(promise, signal)
}

export function invalidateAgentsCache() {
  cache.clear()
  pending.clear()
  forcedPending.clear()
}

function withAuthHeaders(headers: Record<string, string> = {}) {
  const token = getToken()
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...headers,
  }
}

async function rawAgentRequest(url: URL, init: RequestInit, timeoutMs: number, action: string, signal?: AbortSignal) {
  const controller = new AbortController()
  let timedOut = false
  const handleExternalAbort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', handleExternalAbort, { once: true })
  const timeoutId = window.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  let response: Response
  try {
    response = await fetch(url.toString(), { ...init, signal: controller.signal })
  } catch (error) {
    if (timedOut) throw new Error(`${action}超时，请检查 Dify 或后端服务状态`)
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new Error(`${action}请求失败，请检查后端服务和接口地址是否可用`)
  } finally {
    window.clearTimeout(timeoutId)
    signal?.removeEventListener('abort', handleExternalAbort)
  }
  if (response.status === 401) {
    handleUnauthorized()
    throw new Error('登录已过期，请重新登录')
  }
  return response
}

export const agentsApi = {
  getOverview: () => apiClient.get<AgentFrameworkOverview>('/agents/overview', { timeoutMs: AGENT_READ_TIMEOUT_MS }),
  getCapabilities: () => apiClient.get<AgentCapabilitiesResponse>('/agents/capabilities', { timeoutMs: AGENT_READ_TIMEOUT_MS }),
  getTemplates: (force = false, signal?: AbortSignal) => cachedRequest(
    'agents:templates',
    () => apiClient.get<AgentTemplateDoc[]>('/agents/templates', { timeoutMs: AGENT_READ_TIMEOUT_MS }),
    force,
    signal,
  ),
  listTemplateLibrary: (params: AgentTemplateLibraryListParams = {}, force = false, signal?: AbortSignal) => {
    const query: Record<string, string | number> = {
      page: params.page || 1,
      page_size: params.pageSize || 10,
    }
    if (params.keyword?.trim()) query.keyword = params.keyword.trim()
    if (params.source) query.source = params.source
    const key = `agents:template-library:${JSON.stringify(query)}`
    return cachedRequest(
      key,
      () => apiClient.get<AgentTemplateLibraryListResponse>('/agents/template-library', { params: query, timeoutMs: AGENT_READ_TIMEOUT_MS }),
      force,
      signal,
    )
  },
  getTemplateLibraryItem: (id: string, signal?: AbortSignal) => apiClient.get<AgentTemplateLibraryDetail>(`/agents/template-library/${id}`, { signal, timeoutMs: AGENT_READ_TIMEOUT_MS }),
  updateTemplateLibraryItem: async (id: string, payload: UpdateAgentTemplateLibraryPayload, signal?: AbortSignal) => {
    try {
      return await apiClient.put<AgentTemplateLibraryItem>(`/agents/template-library/${id}`, payload, { timeoutMs: AGENT_WRITE_TIMEOUT_MS, signal })
    } finally {
      invalidateAgentsCache()
    }
  },
  deleteTemplateLibraryItem: async (id: string, signal?: AbortSignal) => {
    try {
      return await apiClient.delete<void>(`/agents/template-library/${id}`, { timeoutMs: AGENT_WRITE_TIMEOUT_MS, signal })
    } finally {
      invalidateAgentsCache()
    }
  },
  uploadTemplateLibraryFile: async (file: File, signal?: AbortSignal) => {
    validateAgentDslFile(file)
    const formData = new FormData()
    formData.set('file', file)
    const url = new URL(`${API_BASE}/agents/template-library/upload`, window.location.origin)
    try {
      const res = await rawAgentRequest(url, {
        method: 'POST',
        headers: withAuthHeaders(),
        body: formData,
      }, AGENT_UPLOAD_TIMEOUT_MS, '模板上传', signal)
      if (!res.ok) {
        const error = await res.json().catch(() => ({ detail: '模板上传失败' }))
        throw new Error(error.detail || '模板上传失败')
      }
      return await res.json() as AgentTemplateLibraryUploadResponse
    } catch (error) {
      throw error instanceof Error ? error : new Error('模板上传失败')
    } finally {
      // 取消前端等待不能证明后端未保存模板，后续目录读取必须绕过旧缓存。
      invalidateAgentsCache()
    }
  },
  downloadTemplateLibraryFile: async (id: string, signal?: AbortSignal) => {
    const url = new URL(`${API_BASE}/agents/template-library/${id}/download`, window.location.origin)
    let res: Response
    try {
      res = await rawAgentRequest(url, {
        method: 'GET',
        headers: withAuthHeaders(),
      }, AGENT_DOWNLOAD_TIMEOUT_MS, '模板下载', signal)
    } catch (error) {
      throw error instanceof Error ? error : new Error('模板下载失败')
    }
    if (!res.ok) {
      const error = await res.json().catch(() => ({ detail: '模板下载失败' }))
      throw new Error(error.detail || '模板下载失败')
    }
    return {
      blob: await res.blob(),
      fileName: parseDownloadFileName(res.headers.get('Content-Disposition')),
    }
  },
  listInstances: (params: AgentInstanceListParams = {}, force = false, signal?: AbortSignal) => {
    const query: Record<string, string | number | boolean> = {
      page: params.page || 1,
      page_size: params.pageSize || 10,
    }
    if (params.keyword?.trim()) query.keyword = params.keyword.trim()
    if (params.status) query.status = params.status
    if (params.instanceType) query.instance_type = params.instanceType
    if (params.sourceType) query.source_type = params.sourceType
    if (params.bound !== undefined) query.bound = params.bound
    if (params.refreshRuntime) query.refresh_runtime = true
    if (params.primaryOnly) query.primary_only = true
    if (params.includeRuntime !== undefined) query.include_runtime = params.includeRuntime
    const key = `agents:instances:${JSON.stringify(query)}`
    return cachedRequest(key, () => apiClient.get<AgentInstanceListResponse>('/agents/instances', { params: query, timeoutMs: AGENT_READ_TIMEOUT_MS }), force, signal)
  },
  listRuns: (params: AgentRunListParams = {}, force = false, signal?: AbortSignal) => {
    const query: Record<string, string | number | boolean> = {
      page: params.page || 1,
      page_size: params.pageSize || 10,
    }
    if (params.keyword?.trim()) query.keyword = params.keyword.trim()
    if (params.status) query.status = params.status
    if (params.instanceId !== undefined) query.instance_id = params.instanceId
    const key = `agents:runs:${JSON.stringify(query)}`
    return cachedRequest(key, () => apiClient.get<AgentRunListResponse>('/agents/runs', { params: query, timeoutMs: AGENT_READ_TIMEOUT_MS }), force, signal)
  },
  getInstance: (id: number) => apiClient.get<AgentInstance>(`/agents/instances/${id}`, { timeoutMs: AGENT_READ_TIMEOUT_MS }),
  createInstance: async (payload: CreateAgentInstancePayload, signal?: AbortSignal) => {
    try {
      return await apiClient.post<AgentInstance>('/agents/instances', payload, { timeoutMs: AGENT_WRITE_TIMEOUT_MS, signal })
    } finally {
      invalidateAgentsCache()
    }
  },
  updateInstance: async (id: number, payload: UpdateAgentInstancePayload, signal?: AbortSignal) => {
    try {
      return await apiClient.put<AgentInstance>(`/agents/instances/${id}`, payload, { timeoutMs: AGENT_WRITE_TIMEOUT_MS, signal })
    } finally {
      invalidateAgentsCache()
    }
  },
  deleteInstance: async (id: number, signal?: AbortSignal) => {
    try {
      return await apiClient.delete<void>(`/agents/instances/${id}`, { timeoutMs: AGENT_WRITE_TIMEOUT_MS, signal })
    } finally {
      invalidateAgentsCache()
    }
  },
  testRun: async (id: number, query?: string, allowSideEffects = false, signal?: AbortSignal) => {
    try {
      return await apiClient.post<AgentTestRunResult>(`/agents/instances/${id}/test-run`, {
        query,
        allowSideEffects,
      }, { timeoutMs: AGENT_TEST_TIMEOUT_MS, signal })
    } finally {
      // 停止前端等待不能证明 Dify 或后端没有完成运行，下一次读取必须绕过旧缓存。
      invalidateAgentsCache()
    }
  },
  uploadDsl: async (id: number, file: File, signal?: AbortSignal) => {
    validateAgentDslFile(file)
    const formData = new FormData()
    formData.set('file', file)
    const url = new URL(`${API_BASE}/agents/instances/${id}/upload-dsl`, window.location.origin)
    let res: Response
    try {
      res = await rawAgentRequest(url, {
        method: 'POST',
        headers: withAuthHeaders(),
        body: formData,
      }, AGENT_UPLOAD_TIMEOUT_MS, 'DSL 上传', signal)
    } catch (error) {
      throw error instanceof Error ? error : new Error('DSL 上传失败')
    }
    if (!res.ok) {
      const error = await res.json().catch(() => ({ detail: 'DSL 上传失败' }))
      throw new Error(error.detail || 'DSL 上传失败')
    }
    const result = await res.json() as AgentUploadDslResult
    invalidateAgentsCache()
    return result
  },
}

function parseDownloadFileName(contentDisposition: string | null) {
  if (!contentDisposition) return 'template.yml'
  const utf8Match = contentDisposition.match(/filename\\*=UTF-8''([^;]+)/i)
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1])
    } catch {
      return utf8Match[1]
    }
  }
  const fallbackMatch = contentDisposition.match(/filename="?([^";]+)"?/i)
  return fallbackMatch?.[1] || 'template.yml'
}
