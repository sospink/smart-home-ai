import { getAuthCacheScope, getToken, handleUnauthorized } from '@/lib/auth-storage'
import { apiClient } from '@/lib/api/client'
import { clearHelpCatalogCache } from '@/lib/api/help-docs'
import { waitForSharedRead } from '@/lib/api/shared-read'
import type {
  ApiActionResult,
  ApiDocChangePageResponse,
  ApiDocsAdminOverview,
  ApiDebuggerExecutePayload,
  ApiDebuggerExecuteResult,
  ApiEndpoint,
  ApiEndpointPageResponse,
  ApiEndpointWritePayload,
  ApiModuleListResponse,
  ApiModulePageResponse,
  ApiReferenceModule,
  OpenApiImportResult,
} from '@/types/api-docs'

function withAuthHeaders(headers: Record<string, string> = {}) {
  const token = getToken()
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...headers,
  }
}

type ModuleUpdatePayload = Partial<Pick<ApiReferenceModule,
  'title' | 'slug' | 'subtitle' | 'description' | 'markdownContent' | 'status' |
  'sourceType' | 'rendererType' | 'endpointBase' | 'sortOrder' | 'isVisible' |
  'capabilityTags' | 'highlights' | 'groups' | 'playground'
>>

type EndpointUpdatePayload = Partial<Pick<ApiEndpoint,
  'moduleId' | 'slug' | 'group' | 'method' | 'path' | 'summary' | 'description' |
  'sortOrder' | 'isVisible' | 'sourceType' | 'tags' | 'params' | 'responses' |
  'notes' | 'codeSamples' | 'requestPreview' | 'responseBody' | 'responseMeta'
>>

export type ApiDocsModuleQuery = {
  keyword?: string
  visibility?: 'all' | 'visible' | 'hidden'
  page?: number
  size?: number
}

export type ApiDocsEndpointQuery = {
  keyword?: string
  method?: string
  group?: string
  visibility?: 'all' | 'visible' | 'hidden'
  page?: number
  size?: number
}

export type ApiDocsChangeQuery = {
  keyword?: string
  targetType?: string
  sourceType?: string
  page?: number
  size?: number
}

const CACHE_TTL_MS = 30_000
const READ_TIMEOUT_MS = 15_000
const WRITE_TIMEOUT_MS = 20_000
const IMPORT_TIMEOUT_MS = 45_000
const PLATFORM_DEBUGGER_TIMEOUT_MS = 40_000
const LOCAL_MODEL_DEBUGGER_TIMEOUT_MS = 130_000
export const MAX_API_DOC_MARKDOWN_SIZE = 5 * 1024 * 1024
const cache = new Map<string, { expiresAt: number; value: unknown }>()
const pending = new Map<string, Promise<unknown>>()
const forcedPending = new Map<string, Promise<unknown>>()
const generation = new Map<string, number>()

export function validateApiDocMarkdownFile(file: File) {
  if (!/\.md$/i.test(file.name)) throw new Error('仅支持上传 .md Markdown 文件')
  if (file.size <= 0) throw new Error('Markdown 文件不能为空')
  if (file.size > MAX_API_DOC_MARKDOWN_SIZE) throw new Error('Markdown 文件不能超过 5MB')
}

function params(input: Record<string, string | number | boolean | undefined>) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== '')) as Record<string, string | number | boolean>
}

async function cached<T>(key: string, loader: () => Promise<T>, force = false, signal?: AbortSignal): Promise<T> {
  const scopedKey = `${getAuthCacheScope()}:${key}`
  const hit = cache.get(scopedKey)
  if (!force && hit && hit.expiresAt > Date.now()) return structuredClone(hit.value) as T
  const active = pending.get(scopedKey)
  if (!force && active) return structuredClone(await waitForSharedRead(active as Promise<T>, signal)) as T
  const forcedActive = forcedPending.get(scopedKey)
  if (force && forcedActive) return structuredClone(await waitForSharedRead(forcedActive as Promise<T>, signal)) as T
  const requestGeneration = (generation.get(scopedKey) || 0) + 1
  generation.set(scopedKey, requestGeneration)
  const request = loader().then((value) => {
    if (generation.get(scopedKey) === requestGeneration) {
      cache.set(scopedKey, { value, expiresAt: Date.now() + CACHE_TTL_MS })
    }
    return value
  }).finally(() => {
    if (pending.get(scopedKey) === request) pending.delete(scopedKey)
    if (forcedPending.get(scopedKey) === request) forcedPending.delete(scopedKey)
  })
  pending.set(scopedKey, request)
  if (force) forcedPending.set(scopedKey, request)
  return structuredClone(await waitForSharedRead(request, signal)) as T
}

export function clearApiDocsAdminCache(scope = '') {
  const matches = (key: string) => !scope || key.includes(`:${scope}`)
  const keys = new Set([...cache.keys(), ...pending.keys(), ...forcedPending.keys(), ...generation.keys()])
  keys.forEach((key) => {
    if (!matches(key)) return
    generation.set(key, (generation.get(key) || 0) + 1)
  })
  if (!scope) {
    cache.clear()
    pending.clear()
    forcedPending.clear()
    clearHelpCatalogCache()
    return
  }
  Array.from(cache.keys()).forEach((key) => {
    if (matches(key)) cache.delete(key)
  })
  Array.from(pending.keys()).forEach((key) => {
    if (matches(key)) pending.delete(key)
  })
  Array.from(forcedPending.keys()).forEach((key) => {
    if (matches(key)) forcedPending.delete(key)
  })
}

export const apiDocsApi = {
  adminOverview: (force = false, signal?: AbortSignal) => cached(
    'admin:overview',
    () => apiClient.get<ApiDocsAdminOverview>('/api-docs/admin/overview', { timeoutMs: READ_TIMEOUT_MS }),
    force,
    signal,
  ),

  adminModules: (query: ApiDocsModuleQuery = {}, force = false, signal?: AbortSignal) => {
    const key = `admin:modules:${JSON.stringify(query)}`
    return cached(key, () => apiClient.get<ApiModulePageResponse>('/api-docs/admin/modules', { params: params(query), timeoutMs: READ_TIMEOUT_MS }), force, signal)
  },

  adminModule: (moduleRef: string, force = false, signal?: AbortSignal) => cached(
    `admin:module:${moduleRef}`,
    () => apiClient.get<ApiReferenceModule>(`/api-docs/admin/modules/${moduleRef}`, { timeoutMs: READ_TIMEOUT_MS }),
    force,
    signal,
  ),

  adminEndpoints: (moduleRef: string, query: ApiDocsEndpointQuery = {}, force = false, signal?: AbortSignal) => {
    const key = `admin:endpoints:${moduleRef}:${JSON.stringify(query)}`
    return cached(key, () => apiClient.get<ApiEndpointPageResponse>(`/api-docs/admin/modules/${moduleRef}/endpoints`, { params: params(query), timeoutMs: READ_TIMEOUT_MS }), force, signal)
  },

  adminChanges: (query: ApiDocsChangeQuery = {}, force = false, signal?: AbortSignal) => {
    const key = `admin:changes:${JSON.stringify(query)}`
    return cached(key, () => apiClient.get<ApiDocChangePageResponse>('/api-docs/admin/changes', { params: params(query), timeoutMs: READ_TIMEOUT_MS }), force, signal)
  },

  listModules: (includeHidden = false, includeEndpoints = true, force = false, signal?: AbortSignal) => cached(
    `public:modules:${includeHidden}:${includeEndpoints}`,
    () => apiClient.get<ApiModuleListResponse>('/api-docs/modules', {
      params: { ...(includeHidden ? { include_hidden: true } : {}), include_endpoints: includeEndpoints },
      timeoutMs: READ_TIMEOUT_MS,
    }),
    force,
    signal,
  ),

  getModule: (moduleRef: string, includeHidden = false, force = false, signal?: AbortSignal) => cached(
    `public:module:${moduleRef}:${includeHidden}`,
    () => apiClient.get<ApiReferenceModule>(`/api-docs/modules/${moduleRef}`, {
      params: includeHidden ? { include_hidden: true } : undefined,
      timeoutMs: READ_TIMEOUT_MS,
    }),
    force,
    signal,
  ),

  createModule: async (data: {
    title: string
    slug: string
    subtitle?: string
    description?: string
    markdownContent?: string
    sortOrder?: number
    isVisible?: boolean
  }, signal?: AbortSignal) => {
    try {
      return await apiClient.post<ApiReferenceModule>('/api-docs/modules', data, { timeoutMs: WRITE_TIMEOUT_MS, signal })
    } finally {
      clearApiDocsAdminCache()
    }
  },

  updateModule: async (moduleRef: string, data: ModuleUpdatePayload, signal?: AbortSignal) => {
    try {
      return await apiClient.put<ApiReferenceModule>(`/api-docs/modules/${moduleRef}`, data, { timeoutMs: WRITE_TIMEOUT_MS, signal })
    } finally {
      clearApiDocsAdminCache()
    }
  },

  deleteModule: async (moduleRef: string, signal?: AbortSignal) => {
    try {
      return await apiClient.delete<ApiActionResult>(`/api-docs/modules/${moduleRef}`, { timeoutMs: WRITE_TIMEOUT_MS, signal })
    } finally {
      clearApiDocsAdminCache()
    }
  },

  importMarkdown: async (moduleRef: string, payload: {
    markdownText?: string
    append?: boolean
    file?: File | null
  }, signal?: AbortSignal) => {
    if (payload.file) validateApiDocMarkdownFile(payload.file)
    if (!payload.file && new TextEncoder().encode(payload.markdownText || '').byteLength > MAX_API_DOC_MARKDOWN_SIZE) {
      throw new Error('Markdown 文本不能超过 5MB')
    }
    const formData = new FormData()
    if (payload.markdownText) formData.set('markdown_text', payload.markdownText)
    if (payload.append) formData.set('append', 'true')
    if (payload.file) formData.set('file', payload.file)

    const controller = new AbortController()
    let timedOut = false
    const handleExternalAbort = () => controller.abort()
    if (signal?.aborted) controller.abort()
    else signal?.addEventListener('abort', handleExternalAbort, { once: true })
    const timeoutId = window.setTimeout(() => {
      timedOut = true
      controller.abort()
    }, IMPORT_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(`/api/v1/api-docs/modules/${moduleRef}/markdown-import`, {
        method: 'POST',
        headers: withAuthHeaders(),
        body: formData,
        signal: controller.signal,
      })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        if (!timedOut) throw error
        throw new Error('Markdown 导入超时，请检查文件大小或后端状态后重试')
      }
      throw new Error('无法连接后端服务，请检查网络后重试')
    } finally {
      window.clearTimeout(timeoutId)
      signal?.removeEventListener('abort', handleExternalAbort)
      clearApiDocsAdminCache()
    }

    if (res.status === 401) {
      handleUnauthorized()
      throw new Error('登录已过期，请重新登录')
    }

    if (!res.ok) {
      const error = await res.json().catch(() => ({ detail: 'Markdown 导入失败' }))
      throw new Error(error.detail || 'Markdown 导入失败')
    }

    return res.json() as Promise<ApiReferenceModule>
  },

  importOpenApi: async (refreshExisting = true, signal?: AbortSignal) => {
    try {
      return await apiClient.post<OpenApiImportResult>('/api-docs/import/openapi', {
        refreshExisting,
        includeHiddenModules: true,
      }, { timeoutMs: IMPORT_TIMEOUT_MS, signal })
    } finally {
      clearApiDocsAdminCache()
    }
  },

  createEndpoint: async (moduleRef: string, data: ApiEndpointWritePayload, signal?: AbortSignal) => {
    try {
      return await apiClient.post<ApiEndpoint>(`/api-docs/modules/${moduleRef}/endpoints`, data, { timeoutMs: WRITE_TIMEOUT_MS, signal })
    } finally {
      clearApiDocsAdminCache()
    }
  },

  listEndpoints: (moduleRef: string, includeHidden = false) =>
    apiClient.get<ApiEndpoint[]>(`/api-docs/modules/${moduleRef}/endpoints`, {
      params: includeHidden ? { include_hidden: true } : undefined,
      timeoutMs: READ_TIMEOUT_MS,
    }),

  updateEndpoint: async (endpointRef: string, data: EndpointUpdatePayload, signal?: AbortSignal) => {
    try {
      return await apiClient.put<ApiEndpoint>(`/api-docs/endpoints/${endpointRef}`, data, { timeoutMs: WRITE_TIMEOUT_MS, signal })
    } finally {
      clearApiDocsAdminCache()
    }
  },

  deleteEndpoint: async (endpointRef: string, signal?: AbortSignal) => {
    try {
      return await apiClient.delete<ApiActionResult>(`/api-docs/endpoints/${endpointRef}`, { timeoutMs: WRITE_TIMEOUT_MS, signal })
    } finally {
      clearApiDocsAdminCache()
    }
  },

  executeDebugger: (data: ApiDebuggerExecutePayload, signal?: AbortSignal) =>
    apiClient.post<ApiDebuggerExecuteResult>('/api-docs/debugger/execute', data, {
      timeoutMs: data.moduleSlug === 'local-model' ? LOCAL_MODEL_DEBUGGER_TIMEOUT_MS : PLATFORM_DEBUGGER_TIMEOUT_MS,
      signal,
    }),

  listInstalledModels: (signal?: AbortSignal) =>
    apiClient.get<{ models: Array<{ name?: string; model?: string }>; total: number }>('/models', { timeoutMs: READ_TIMEOUT_MS, signal }),

  getDebuggerRuntime: (force = false, signal?: AbortSignal) => cached(
    'debugger:runtime',
    () => apiClient.get<{ local_model_base_url: string }>('/api-docs/debugger/runtime', {
      timeoutMs: READ_TIMEOUT_MS,
      signal,
    }),
    force,
    signal,
  ),
}
