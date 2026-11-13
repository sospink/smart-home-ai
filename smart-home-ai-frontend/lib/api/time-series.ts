import { apiClient } from './client'
import { waitForSharedRead } from './shared-read'
import { getAuthCacheScope } from '@/lib/auth-storage'

const TIME_SERIES_READ_TIMEOUT_MS = 15_000
const TIME_SERIES_WRITE_TIMEOUT_MS = 20_000
const TIME_SERIES_EXPORT_TIMEOUT_MS = 45_000

export type TimeSeriesStatus = 'running' | 'stopped' | 'unconfigured' | 'error'
export type TimeSeriesField = 'value_numeric' | 'state_raw' | 'unit'
export type TimeSeriesWindow = 'raw' | '1m' | '5m' | '15m' | '30m' | '1h' | '6h' | '1d'

export interface TimeSeriesOverview {
  status: TimeSeriesStatus
  health_status: 'running' | 'stopped'
  auth_status: 'ready' | 'missing_token' | 'incomplete' | 'error'
  configured: boolean
  diagnostic: string
  url: string
  org: string
  bucket: string
  measurement: string
  entity_count: number
  latest_at: string | null
  collect_interval_seconds: number
  last_sync: {
    status: string
    written: number
    entity_count: number
    synced_at: string | null
    error: string
    consecutive_failures?: number
    next_retry_seconds?: number
  }
}

export interface TimeSeriesEntity {
  entity_id: string
  domain: string
  device_id: string
  device_name: string
  device_location: string
  role: string
  category: string
  state: string
  unit: string
  last_changed: string | null
  online: boolean
}

export interface TimeSeriesEntitiesResponse {
  entities: TimeSeriesEntity[]
  count: number
  categories: Record<string, number>
}

export interface TimeSeriesPoint {
  time: string
  entity_id: string
  domain: string
  device_id: string
  device_name: string
  role: string
  category: string
  source: string
  field: string
  value: number | string
  state_raw: string
  unit: string
}

export interface TimeSeriesQueryParams {
  entity_id?: string
  category?: string
  keyword?: string
  hours?: number
  window?: TimeSeriesWindow
  field?: TimeSeriesField
  page?: number
  size?: number
  refresh?: boolean
}

export interface TimeSeriesQueryResponse {
  source: 'influxdb'
  query: {
    entity_id: string
    category: string
    keyword: string
    hours: number
    window: TimeSeriesWindow
    field: TimeSeriesField
    snapshot_limit: number
  }
  points: TimeSeriesPoint[]
  chart_points: TimeSeriesPoint[]
  total: number
  count: number
  page: number
  size: number
  page_count: number
  entity_count: number
  latest_at: string | null
  first_at: string | null
  stats: {
    minimum: number | null
    maximum: number | null
    average: number | null
  }
  meta: {
    cache: 'hit' | 'miss' | 'shared'
    cache_ttl_seconds: number
    generated_at: string
    truncated: boolean
    chart_point_count: number
    chart_entity_count: number
    chart_entity_total: number
    chart_entities_truncated: boolean
  }
}

export interface TimeSeriesSyncResponse {
  status: string
  written: number
  entity_count: number
  synced_at: string
  error: string
}

export interface TimeSeriesHistoryItem {
  id: number
  level: string
  title: string
  detail: string
  username: string
  created_at: string
  scope: 'manual' | 'collector'
}

export interface TimeSeriesHistoryResponse {
  items: TimeSeriesHistoryItem[]
  total: number
  page: number
  size: number
  page_count: number
  visibility_scope?: 'all' | 'self'
}

const queryCache = new Map<string, { expiresAt: number; value: TimeSeriesQueryResponse }>()
const queryPending = new Map<string, Promise<TimeSeriesQueryResponse>>()
const queryGeneration = new Map<string, number>()
let queryEpoch = 0

function cleanParams(params: Record<string, string | number | boolean | undefined>) {
  const query: Record<string, string | number | boolean> = {}
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== '') query[key] = value
  })
  return query
}

function queryKey(params: TimeSeriesQueryParams) {
  return `${getAuthCacheScope()}:${JSON.stringify({
    entity_id: params.entity_id || '',
    category: params.category || '',
    keyword: params.keyword || '',
    hours: params.hours ?? 24,
    window: params.window ?? '5m',
    field: params.field ?? 'value_numeric',
    page: params.page ?? 1,
    size: params.size ?? 20,
  })}`
}

export function clearTimeSeriesQueryCache() {
  queryEpoch += 1
  queryCache.clear()
  queryPending.clear()
  queryGeneration.clear()
}

export function fetchTimeSeriesOverview(signal?: AbortSignal): Promise<TimeSeriesOverview> {
  return apiClient.get<TimeSeriesOverview>('/time-series/overview', { timeoutMs: 8_000, signal })
}

export function fetchTimeSeriesEntities(params: { category?: string; keyword?: string } = {}, signal?: AbortSignal): Promise<TimeSeriesEntitiesResponse> {
  return apiClient.get<TimeSeriesEntitiesResponse>('/time-series/entities', {
    params: cleanParams(params),
    timeoutMs: 8_000,
    signal,
  })
}

export function fetchTimeSeriesQuery(params: TimeSeriesQueryParams = {}, signal?: AbortSignal): Promise<TimeSeriesQueryResponse> {
  const key = queryKey(params)
  const cached = queryCache.get(key)
  if (!params.refresh && cached && cached.expiresAt > Date.now()) return Promise.resolve(structuredClone(cached.value))
  const existing = queryPending.get(key)
  if (!params.refresh && existing) {
    return waitForSharedRead(existing, signal).then(value => structuredClone(value))
  }

  const epoch = queryEpoch
  const generation = (queryGeneration.get(key) || 0) + 1
  queryGeneration.set(key, generation)
  const request = apiClient.get<TimeSeriesQueryResponse>('/time-series/query', {
    params: cleanParams({
      entity_id: params.entity_id,
      category: params.category,
      keyword: params.keyword,
      hours: params.hours ?? 24,
      window: params.window ?? '5m',
      field: params.field ?? 'value_numeric',
      page: params.page ?? 1,
      size: params.size ?? 20,
      refresh: params.refresh || undefined,
    }),
    timeoutMs: 8_000,
    signal: params.refresh ? signal : undefined,
  }).then(value => {
    if (queryEpoch === epoch && queryGeneration.get(key) === generation) {
      queryCache.set(key, { expiresAt: Date.now() + 30_000, value: structuredClone(value) })
    }
    return value
  }).finally(() => {
    if (queryPending.get(key) === request) queryPending.delete(key)
  })
  if (params.refresh) return request.then(value => structuredClone(value))
  queryPending.set(key, request)
  return waitForSharedRead(request, signal).then(value => structuredClone(value))
}

export async function syncTimeSeries(signal?: AbortSignal): Promise<TimeSeriesSyncResponse> {
  try {
    return await apiClient.post<TimeSeriesSyncResponse>('/time-series/sync', undefined, { timeoutMs: TIME_SERIES_WRITE_TIMEOUT_MS, signal })
  } finally {
    // 停止前端等待不能证明服务端没有完成采集，因此始终废弃读取快照。
    clearTimeSeriesQueryCache()
  }
}

export function fetchTimeSeriesHistory(params: {
  scope?: 'all' | 'manual' | 'collector'
  level?: string
  keyword?: string
  page?: number
  size?: number
} = {}, signal?: AbortSignal): Promise<TimeSeriesHistoryResponse> {
  return apiClient.get<TimeSeriesHistoryResponse>('/time-series/history', {
    params: cleanParams({
      scope: params.scope || 'all',
      level: params.level,
      keyword: params.keyword,
      page: params.page ?? 1,
      size: params.size ?? 20,
    }),
    timeoutMs: TIME_SERIES_READ_TIMEOUT_MS,
    signal,
  })
}

export async function cleanupTimeSeriesCollectorHistory(signal?: AbortSignal): Promise<{ status: string; deleted: number; retained_failures: number }> {
  try {
    return await apiClient.delete('/time-series/history/collector', { timeoutMs: TIME_SERIES_WRITE_TIMEOUT_MS, signal })
  } finally {
    // 取消等待或断网时，服务端仍可能已完成清理，后续读取必须绕过旧快照。
    clearTimeSeriesQueryCache()
  }
}

function filenameFromDisposition(value: string | null, fallback: string) {
  if (!value) return fallback
  const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf8Match) return decodeURIComponent(utf8Match[1])
  return value.match(/filename="?([^";]+)"?/i)?.[1] || fallback
}

export async function exportTimeSeries(params: TimeSeriesQueryParams & { format: 'json' | 'csv' }, signal?: AbortSignal): Promise<{ blob: Blob; filename: string; count: number; truncated: boolean }> {
  const response = await apiClient.download('/time-series/export', {
    params: cleanParams({
      entity_id: params.entity_id,
      category: params.category,
      keyword: params.keyword,
      hours: params.hours ?? 24,
      window: params.window ?? '5m',
      field: params.field ?? 'value_numeric',
      format: params.format,
    }),
    timeoutMs: TIME_SERIES_EXPORT_TIMEOUT_MS,
    signal,
  })
  return {
    blob: response.blob,
    filename: filenameFromDisposition(response.headers.get('content-disposition'), `time-series.${params.format}`),
    count: Number(response.headers.get('x-export-count') || 0),
    truncated: response.headers.get('x-export-truncated') === 'true',
  }
}
