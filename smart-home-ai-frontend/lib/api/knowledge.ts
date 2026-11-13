import { getAuthCacheScope, getToken, handleUnauthorized } from '@/lib/auth-storage'
import { waitForSharedRead } from '@/lib/api/shared-read'
import { apiClient } from './client'
import { clearOperationLogCache } from './monitor'
import { clearSystemOverviewCache } from './system'

export interface KnowledgeDataset {
  id: string
  name: string
  description: string
  provider: string
  permission: string
  data_source_type: string
  indexing_technique: string
  app_count: number
  document_count: number
  word_count: number
  embedding_model: string | null
  embedding_model_provider: string | null
  embedding_available: boolean
  created_at: number
  updated_at: number
}

export interface KnowledgeDocument {
  id: string
  name: string
  word_count: number
  tokens: number
  indexing_status: string
  enabled: boolean
  data_source_type: string
  doc_form: string
  indexing_technique: string
  created_at: number
  position: number
}

export interface DatasetListResponse {
  datasets: KnowledgeDataset[]
  total: number
  has_more: boolean
  page: number
  page_count?: number
  summary?: {
    total: number
    document_total?: number
    word_total?: number
  }
  cache_ttl_seconds?: number
  snapshot?: {
    status: 'live' | 'fresh' | 'stale'
    stale: boolean
    snapshot_at: number
    error: string
  }
}

export interface DocumentListResponse {
  documents: KnowledgeDocument[]
  total: number
  has_more: boolean
  page: number
}

export interface HitRecord {
  content: string
  score: number
  word_count: number
  document_name: string
  document_id: string
  segment_id: string
}

export interface HitTestingResponse {
  query: string
  records: HitRecord[]
  hit_count: number
  duration_ms: number
  executed_at: string
  audit_recorded: boolean
}

export interface DatasetListParams {
  page?: number
  limit?: number
  keyword?: string
  permission?: '' | 'all_team_members'
  sort?: 'created_desc' | 'created_asc' | 'updated_desc' | 'name_asc' | 'docs_desc' | 'words_desc'
}

export interface DocumentListParams extends DatasetListParams {
  datasetId: string
}

const CACHE_TTL_MS = 45_000
const KNOWLEDGE_READ_TIMEOUT_MS = 8_000
const KNOWLEDGE_WRITE_TIMEOUT_MS = 20_000
const KNOWLEDGE_UPLOAD_TIMEOUT_MS = 90_000
const MAX_DOCUMENT_FILE_SIZE = 50 * 1024 * 1024
const ALLOWED_DOCUMENT_EXTENSIONS = new Set(['pdf', 'txt', 'docx', 'csv', 'md', 'xlsx'])
const cache = new Map<string, { expiresAt: number; value: unknown }>()
const pending = new Map<string, Promise<unknown>>()
const cacheGeneration = new Map<string, number>()

function knowledgeCacheKey(suffix: string) {
  return `knowledge:${getAuthCacheScope()}:${suffix}`
}

async function cachedRequest<T>(key: string, request: () => Promise<T>, force = false, signal?: AbortSignal): Promise<T> {
  const cached = cache.get(key)
  if (!force && cached && cached.expiresAt > Date.now()) return structuredClone(cached.value) as T
  const running = pending.get(key)
  if (!force && running) return structuredClone(await waitForSharedRead(running as Promise<T>, signal)) as T

  const generation = (cacheGeneration.get(key) || 0) + 1
  cacheGeneration.set(key, generation)
  const promise = request()
    .then((value) => {
      if (cacheGeneration.get(key) === generation) {
        cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS })
      }
      return value
    })
    .finally(() => {
      if (pending.get(key) === promise) pending.delete(key)
    })
  pending.set(key, promise)
  return structuredClone(await waitForSharedRead(promise, signal)) as T
}

function invalidateWhere(predicate: (key: string) => boolean) {
  const keys = new Set([...cache.keys(), ...pending.keys(), ...cacheGeneration.keys()])
  keys.forEach((key) => {
    if (!predicate(key)) return
    cache.delete(key)
    pending.delete(key)
    cacheGeneration.set(key, (cacheGeneration.get(key) || 0) + 1)
  })
}

export function invalidateKnowledgeCache(datasetId?: string) {
  invalidateWhere((key) => {
    if (!key.startsWith('knowledge:')) return false
    if (!datasetId) return true
    return key.includes(':list:')
      || key.includes(`:detail:${datasetId}`)
      || key.includes(`:documents:${datasetId}:`)
  })
}

function invalidateKnowledgeMutation(datasetId?: string, affectsDatasetCount = false) {
  invalidateKnowledgeCache(datasetId)
  clearOperationLogCache()
  clearSystemOverviewCache({
    scopes: affectsDatasetCount ? undefined : ['all', 'platform'],
    publicSummary: affectsDatasetCount,
  })
}

export async function fetchDatasets(params: DatasetListParams = {}, force = false, signal?: AbortSignal): Promise<DatasetListResponse> {
  const page = params.page || 1
  const limit = params.limit || 10
  const keyword = params.keyword?.trim() || ''
  const permission = params.permission || ''
  const sort = params.sort || 'created_desc'
  const key = knowledgeCacheKey(`list:${page}:${limit}:${keyword}:${permission}:${sort}`)
  return cachedRequest(key, () => apiClient.get<DatasetListResponse>('/knowledge/datasets', {
      params: {
        page,
        limit,
        sort,
        refresh: force,
        ...(keyword ? { keyword } : {}),
        ...(permission ? { permission } : {}),
      },
      timeoutMs: KNOWLEDGE_READ_TIMEOUT_MS,
    }), force, signal)
}

export async function fetchDataset(datasetId: string, force = false, signal?: AbortSignal): Promise<KnowledgeDataset> {
  return cachedRequest(
    knowledgeCacheKey(`detail:${datasetId}`),
    () => apiClient.get<KnowledgeDataset>(`/knowledge/datasets/${datasetId}`, { timeoutMs: KNOWLEDGE_READ_TIMEOUT_MS }),
    force,
    signal,
  )
}

export async function fetchDocuments(params: DocumentListParams, force = false, signal?: AbortSignal): Promise<DocumentListResponse> {
  const page = params.page || 1
  const limit = params.limit || 10
  const keyword = params.keyword?.trim() || ''
  const key = knowledgeCacheKey(`documents:${params.datasetId}:${page}:${limit}:${keyword}`)
  return cachedRequest(key, () => apiClient.get<DocumentListResponse>(
    `/knowledge/datasets/${params.datasetId}/documents`,
    { params: { page, limit, ...(keyword ? { keyword } : {}) }, timeoutMs: KNOWLEDGE_READ_TIMEOUT_MS },
  ), force, signal)
}

export async function createDataset(payload: { name: string; description: string }, signal?: AbortSignal) {
  try {
    return await apiClient.post<KnowledgeDataset>('/knowledge/datasets', payload, { timeoutMs: KNOWLEDGE_WRITE_TIMEOUT_MS, signal })
  } finally {
    // 中止浏览器等待不等于撤回已送达 Dify 的写入，因此无论结果如何都失效读取快照。
    invalidateKnowledgeMutation(undefined, true)
  }
}

export async function deleteDataset(datasetId: string, signal?: AbortSignal) {
  try {
    return await apiClient.delete<{ success: boolean; message: string }>(`/knowledge/datasets/${datasetId}`, { timeoutMs: KNOWLEDGE_WRITE_TIMEOUT_MS, signal })
  } finally {
    invalidateKnowledgeMutation(datasetId, true)
  }
}

export async function createTextDocument(datasetId: string, payload: { name: string; text: string }, signal?: AbortSignal) {
  try {
    return await apiClient.post(`/knowledge/datasets/${datasetId}/documents/text`, payload, { timeoutMs: KNOWLEDGE_WRITE_TIMEOUT_MS, signal })
  } finally {
    invalidateKnowledgeMutation(datasetId)
  }
}

export async function updateTextDocument(datasetId: string, documentId: string, payload: { name: string; text: string }, signal?: AbortSignal) {
  try {
    return await apiClient.put(`/knowledge/datasets/${datasetId}/documents/${documentId}/text`, payload, { timeoutMs: KNOWLEDGE_WRITE_TIMEOUT_MS, signal })
  } finally {
    invalidateKnowledgeMutation(datasetId)
  }
}

export async function deleteDocument(datasetId: string, documentId: string, signal?: AbortSignal) {
  try {
    return await apiClient.delete<{ success: boolean; message: string }>(
      `/knowledge/datasets/${datasetId}/documents/${documentId}`,
      { timeoutMs: KNOWLEDGE_WRITE_TIMEOUT_MS, signal },
    )
  } finally {
    invalidateKnowledgeMutation(datasetId)
  }
}

export async function hitTestDataset(datasetId: string, query: string, signal?: AbortSignal): Promise<HitTestingResponse> {
  try {
    return await apiClient.post<HitTestingResponse>(`/knowledge/datasets/${datasetId}/hit-testing`, { query }, { timeoutMs: KNOWLEDGE_WRITE_TIMEOUT_MS, signal })
  } finally {
    clearOperationLogCache()
  }
}

async function uploadForm(path: string, file: File, signal?: AbortSignal) {
  const extension = file.name.split('.').pop()?.toLowerCase() || ''
  if (!ALLOWED_DOCUMENT_EXTENSIONS.has(extension)) {
    throw new Error('仅支持 PDF、TXT、DOCX、CSV、MD、XLSX 文件')
  }
  if (file.size <= 0) throw new Error('不能上传空文件')
  if (file.size > MAX_DOCUMENT_FILE_SIZE) throw new Error('文件不能超过 50MB')
  const formData = new FormData()
  formData.append('file', file)
  const token = getToken()
  const controller = new AbortController()
  let timedOut = false
  const handleExternalAbort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', handleExternalAbort, { once: true })
  const timeoutId = window.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, KNOWLEDGE_UPLOAD_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(`/api/v1${path}`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
      signal: controller.signal,
    })
  } catch (error) {
    if (timedOut) throw new Error('文件上传超时，请检查 Dify 服务状态或缩小文件后重试')
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new Error('无法连接后端服务，文件上传未完成')
  } finally {
    window.clearTimeout(timeoutId)
    signal?.removeEventListener('abort', handleExternalAbort)
  }
  if (response.status === 401) {
    handleUnauthorized()
    throw new Error('登录已过期，请重新登录后上传')
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    throw new Error(payload.detail || `文件请求失败（HTTP ${response.status}）`)
  }
  return response.json()
}

export async function uploadDocument(datasetId: string, file: File, signal?: AbortSignal) {
  try {
    return await uploadForm(`/knowledge/datasets/${datasetId}/documents/file`, file, signal)
  } finally {
    // 主动取消仅停止前端等待，服务端仍可能已经完成上传，因此结束后始终失效读取缓存。
    invalidateKnowledgeMutation(datasetId)
  }
}

export async function replaceDocumentFile(datasetId: string, documentId: string, file: File, signal?: AbortSignal) {
  try {
    return await uploadForm(`/knowledge/datasets/${datasetId}/documents/${documentId}/file`, file, signal)
  } finally {
    invalidateKnowledgeMutation(datasetId)
  }
}
