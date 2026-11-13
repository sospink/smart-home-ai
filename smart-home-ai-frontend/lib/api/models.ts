import { apiClient } from '@/lib/api/client'
import { clearSystemOverviewCache } from '@/lib/api/system'
import { getAuthCacheScope } from '@/lib/auth-storage'
import { waitForSharedRead } from '@/lib/api/shared-read'

export type InstalledModel = {
  name: string
  model: string
  size: number
  size_display: string
  parameter_size: string
  quantization_level: string
  family: string
  families?: string[]
  format: string
  modified_at: string
  modified_display: string
  digest: string
}

export type ModelDetail = {
  name: string
  license: string
  system: string
  template: string
  parameters: string
  capabilities: string[]
  modified_at: string
  details: {
    parent_model: string
    family: string
    parameter_size: string
    quantization_level: string
    format: string
    families: string[]
  }
  architecture: {
    architecture: string
    parameter_count: number
    quantization_version: number | null
    file_type: number | null
    context_length: number | null
    embedding_length: number | null
    block_count: number | null
    head_count: number | null
    head_count_kv: number | null
    feed_forward_length: number | null
  }
  model_info: Record<string, unknown>
}

export type RunningModel = {
  name: string
  model?: string
  size_display: string
  size_vram_display: string
  expires_at?: string
}

export type SystemMetrics = {
  cpu: { percent: number; count: number; freq_mhz: number | null }
  memory: { total_gb: number; used_gb: number; percent: number }
  disk: { path: string; total_gb: number; used_gb: number; available_gb: number; percent: number }
  swap: { total_gb: number; used_gb: number; available_gb: number; percent: number }
  gpus: Array<{
    index?: number
    name: string
    utilization_percent: number
    memory_percent: number
    temperature_c: number
    memory_used_mb: number
    memory_total_mb: number
  }>
  metrics_bars: Array<{ label: string; value: number; unit?: '%' | '°C' }>
}

export type InstalledModelsResponse = {
  models: InstalledModel[]
  total: number
  page: number
  size: number
  page_count: number
  total_size: number
  summary?: {
    total: number
    total_size: number
  }
}

export type LibraryTag = {
  tag: string
  full_name: string
  size: string
  size_bytes: number
  context: string
  input: string
  updated: string
  installed?: boolean | null
}

export type LibraryModel = {
  name: string
  desc: string
  tags: LibraryTag[]
  default_tag: string
  family: string
  category: string
  installed: boolean | null
  recommended: boolean
  capabilities: string[]
  parameter_sizes: string[]
}

export type LibraryResponse = {
  models: LibraryModel[]
  total: number
  page: number
  size: number
  page_count: number
  source: 'fresh' | 'cache' | 'seed'
  last_synced_at: string | null
  error?: string
  ollama_online: boolean
  available_filters: { categories: string[]; capabilities: string[] }
}

export type PullTaskStatus = 'pending' | 'running' | 'retrying' | 'succeeded' | 'failed' | 'canceled' | 'interrupted'

export type PullTask = {
  id: number
  model_name: string
  status: PullTaskStatus
  attempt: number
  max_attempts: number
  total_bytes: number
  completed_bytes: number
  progress_percent: number
  last_status: string
  error_type: string
  error_message: string
  started_at: string | null
  finished_at: string | null
  created_at?: string | null
  updated_at: string | null
  username?: string
}

export type PullTasksResponse = {
  tasks: PullTask[]
  total: number
  page: number
  size: number
  page_count: number
  summary: {
    total: number
    active: number
    succeeded: number
    failed: number
    canceled: number
    by_status: Record<string, number>
  }
}

export type PrecheckResult = {
  ok: boolean
  model_name: string
  checks: Array<{ key: string; ok: boolean; message: string; detail?: Record<string, unknown> }>
  errors: string[]
  installed?: boolean
  catalog?: { source?: string; last_synced_at?: string | null; tag?: LibraryTag & { base_model?: LibraryModel } }
}

export type InferenceTestResult = {
  success: boolean
  model: string
  prompt: string
  response?: string
  latency_ms?: number
  tested_at: string
  error?: string
}

export type LibraryQuery = {
  keyword?: string
  category?: string
  capability?: string
  installed?: boolean
  recommended?: boolean
  page?: number
  size?: number
}

export type PullTaskQuery = {
  status?: string
  model_name?: string
  page?: number
  size?: number
}

const CACHE_TTL_MS = 30_000
const READ_TIMEOUT_MS = 15_000
const WRITE_TIMEOUT_MS = 20_000
const SYNC_TIMEOUT_MS = 45_000
const INFERENCE_TIMEOUT_MS = 60_000
const cache = new Map<string, { expiresAt: number; value: unknown }>()
const pending = new Map<string, Promise<unknown>>()
const generation = new Map<string, number>()

async function cached<T>(key: string, loader: () => Promise<T>, force = false, signal?: AbortSignal): Promise<T> {
  const scopedKey = `${getAuthCacheScope()}:${key}`
  const hit = cache.get(scopedKey)
  if (!force && hit && hit.expiresAt > Date.now()) return structuredClone(hit.value) as T
  const active = pending.get(scopedKey)
  if (!force && active) return structuredClone(await waitForSharedRead(active as Promise<T>, signal)) as T
  const requestGeneration = (generation.get(scopedKey) || 0) + 1
  generation.set(scopedKey, requestGeneration)
  const request = loader().then((value) => {
    if (generation.get(scopedKey) === requestGeneration) {
      cache.set(scopedKey, { value, expiresAt: Date.now() + CACHE_TTL_MS })
    }
    return value
  }).finally(() => {
    if (pending.get(scopedKey) === request) pending.delete(scopedKey)
  })
  pending.set(scopedKey, request)
  return structuredClone(await waitForSharedRead(request, signal)) as T
}

function params(input: Record<string, string | number | boolean | undefined>) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== '')) as Record<string, string | number | boolean>
}

function modelPath(name: string) {
  return name.split('/').map(encodeURIComponent).join('/')
}

export function clearModelCache(scope = '') {
  const keys = new Set([...cache.keys(), ...pending.keys(), ...generation.keys()])
  keys.forEach((key) => {
    if (scope && !key.includes(`:${scope}`)) return
    generation.set(key, (generation.get(key) || 0) + 1)
    cache.delete(key)
    pending.delete(key)
  })
}

export const modelApi = {
  listInstalled(query: { keyword?: string; page?: number; size?: number; complete?: boolean } = {}, force = false, signal?: AbortSignal) {
    const key = `installed:${JSON.stringify(query)}`
    return cached(key, () => apiClient.get<InstalledModelsResponse>('/models', { params: params(query), timeoutMs: READ_TIMEOUT_MS }), force, signal)
  },
  listAllInstalled(force = false, signal?: AbortSignal) {
    return this.listInstalled({ complete: true }, force, signal)
  },
  running(force = false, signal?: AbortSignal) {
    return cached('runtime:running', () => apiClient.get<{ running: RunningModel[]; count: number }>('/models/status', { timeoutMs: READ_TIMEOUT_MS }), force, signal)
  },
  version(force = false, signal?: AbortSignal) {
    return cached('runtime:version', () => apiClient.get<{ version: string; online: boolean; error?: string }>('/models/version', { timeoutMs: READ_TIMEOUT_MS }), force, signal)
  },
  current(force = false, signal?: AbortSignal) {
    return cached('runtime:current', () => apiClient.get<{ current_model: string }>('/models/current', { timeoutMs: READ_TIMEOUT_MS }), force, signal)
  },
  metrics(force = false, signal?: AbortSignal) {
    return cached('runtime:metrics', () => apiClient.get<SystemMetrics>('/models/system-metrics', { timeoutMs: READ_TIMEOUT_MS }), force, signal)
  },
  detail(name: string, signal?: AbortSignal) {
    return cached(
      `detail:${name}`,
      () => apiClient.post<ModelDetail>(`/models/${modelPath(name)}/detail`, undefined, { timeoutMs: READ_TIMEOUT_MS }),
      false,
      signal,
    )
  },
  async setCurrent(name: string, signal?: AbortSignal) {
    try {
      return await apiClient.put<{ message: string; current_model: string }>('/models/current', { name }, { timeoutMs: WRITE_TIMEOUT_MS, signal })
    } finally {
      // 中止等待不能证明后端未完成写入，下次读取必须绕开旧状态。
      clearModelCache('runtime:')
      clearSystemOverviewCache({ scopes: ['all', 'platform'], publicSummary: false })
    }
  },
  async remove(name: string, signal?: AbortSignal) {
    try {
      return await apiClient.delete<{ message: string }>(`/models/${modelPath(name)}`, { timeoutMs: WRITE_TIMEOUT_MS, signal })
    } finally {
      clearModelCache()
      clearSystemOverviewCache()
    }
  },
  async copy(source: string, destination: string, signal?: AbortSignal) {
    try {
      return await apiClient.post<{ message: string }>('/models/copy', {
        source,
        destination,
      }, { timeoutMs: WRITE_TIMEOUT_MS, signal })
    } finally {
      // 请求中止或超时后，Ollama 仍可能已创建别名，必须丢弃旧清单。
      clearModelCache()
      clearSystemOverviewCache()
    }
  },
  library(query: LibraryQuery = {}, force = false, signal?: AbortSignal) {
    const key = `library:${JSON.stringify(query)}`
    return cached(key, () => apiClient.get<LibraryResponse>('/models/library', { params: params(query), timeoutMs: READ_TIMEOUT_MS }), force, signal)
  },
  async syncLibrary(signal?: AbortSignal) {
    const response = await apiClient.post<{ source: string; last_synced_at: string | null; error?: string }>('/models/library/sync', undefined, { timeoutMs: SYNC_TIMEOUT_MS, signal })
    clearModelCache('library:')
    clearSystemOverviewCache({ scopes: ['all', 'platform'], publicSummary: false })
    return response
  },
  pullTasks(query: PullTaskQuery = {}, force = false, signal?: AbortSignal) {
    const key = `tasks:${JSON.stringify(query)}`
    return cached(key, () => apiClient.get<PullTasksResponse>('/models/pull-tasks', { params: params(query), timeoutMs: READ_TIMEOUT_MS }), force, signal)
  },
  precheck(modelName: string, allowCustom = false, force = false, signal?: AbortSignal) {
    return apiClient.post<PrecheckResult>('/models/pull-tasks/precheck', {
      model_name: modelName,
      allow_custom: allowCustom,
      force,
    }, { timeoutMs: WRITE_TIMEOUT_MS, signal })
  },
  async createPull(modelName: string, allowCustom = false, force = false, signal?: AbortSignal) {
    try {
      return await apiClient.post<{ task: PullTask; created: boolean }>('/models/pull-tasks', {
        model_name: modelName,
        allow_custom: allowCustom,
        force,
      }, { timeoutMs: WRITE_TIMEOUT_MS, signal })
    } finally {
      clearModelCache('tasks:')
      clearSystemOverviewCache({ scopes: ['all', 'platform'], publicSummary: false })
    }
  },
  async retry(taskId: number, signal?: AbortSignal) {
    try {
      return await apiClient.post<PullTask>(`/models/pull-tasks/${taskId}/retry`, undefined, { timeoutMs: WRITE_TIMEOUT_MS, signal })
    } finally {
      clearModelCache('tasks:')
      clearSystemOverviewCache({ scopes: ['all', 'platform'], publicSummary: false })
    }
  },
  async cancel(taskId: number, signal?: AbortSignal) {
    try {
      return await apiClient.post<PullTask>(`/models/pull-tasks/${taskId}/cancel`, undefined, { timeoutMs: WRITE_TIMEOUT_MS, signal })
    } finally {
      clearModelCache('tasks:')
      clearSystemOverviewCache({ scopes: ['all', 'platform'], publicSummary: false })
    }
  },
  inference(model: string, prompt: string, signal?: AbortSignal) {
    return apiClient.post<InferenceTestResult>('/models/inference-test', { model, prompt }, { timeoutMs: INFERENCE_TIMEOUT_MS, signal })
  },
}
