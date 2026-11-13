/**
 * 监控大屏 API
 */
import { apiClient } from './client'
import { getAuthCacheScope } from '@/lib/auth-storage'
import { waitForSharedRead } from './shared-read'

const MONITOR_READ_TIMEOUT_MS = 15_000
const MONITOR_QUERY_TIMEOUT_MS = 20_000
const MONITOR_EXPORT_TIMEOUT_MS = 45_000

/* ── Types ── */

export interface ResourceMetrics {
  available?: boolean
  diagnostic?: string
  cpu: { percent: number; model: string; cores: number }
  memory: { percent: number; used_gb: number; total_gb: number }
  gpu: { available: boolean; percent: number | null; model: string; vram_used_gb: number | null; vram_total_gb: number | null }
  disk: { percent: number; used_gb: number; total_gb: number; available_gb?: number; mount_path?: string }
}

export interface AIStatus {
  status: 'running' | 'idle' | 'offline'
  model_name: string
  quantization: string
  family: string
  parameter_size: string
  vram_used_gb: number | null
  inference_latency_ms: number | null
  throughput_tps: number | null
}

export interface ServiceStatus {
  name: string
  status: 'running' | 'stopped' | 'error' | 'auth_error' | 'unconfigured'
  latency_ms: number | null
  http_status?: number | null
  diagnostic?: string
  extra?: string
}

export interface ActivityStats {
  conversations_today: number | null
  controls_today: number | null
  knowledge_docs: number | null
  model_count: number | null
  sources?: Record<string, {
    status: 'available' | 'unavailable'
    source: string
    error: string
  }>
  scopes?: {
    conversations_today: 'self'
    controls_today: 'all' | 'self'
    knowledge_docs: 'platform'
    model_count: 'platform'
  }
}

export interface SensorPoint {
  time: string
  value: number
}

export interface SensorHistory {
  temperature: SensorPoint[]
  humidity: SensorPoint[]
  pm25: SensorPoint[]
  _meta?: {
    data_source: string
    fallback_note: string
    hours: number
    requested_start_at?: string
    requested_end_at?: string
    target_points_per_metric?: number
    aggregation_window_minutes?: number
    available_metrics: number
    total_metrics: number
    generated: boolean
    metrics: Record<string, {
      label: string
      entity_id: string
      unit: string
      device_name?: string
      device_location?: string
      source: string
      point_count: number
      raw_point_count?: number
      coverage_truncated?: boolean
      aggregation?: string
      first_point_at?: string
      last_point_at?: string
      missing_reason: string
    }>
  }
}

export interface OperationLogItem {
  id: number
  type: string
  level: string
  title: string
  summary?: string
  detail: string
  username: string
  entity_id?: string
  time: string
  created_at: string | null
  repeat_count?: number
}

export interface ControlTrends {
  hours: string[]
  today: number[]
  yesterday: number[]
  visibility_scope?: 'all' | 'self'
}

export interface MonitorDashboard {
  resources: ResourceMetrics
  ai_status: AIStatus
  services: ServiceStatus[]
  activity: ActivityStats
  sensor_history: SensorHistory
  logs: OperationLogItem[]
  timestamp: string
}

export interface OperationLogsResponse {
  logs: OperationLogItem[]
  total?: number
  raw_total?: number
  collapsed_count?: number
  collapse_periodic?: boolean
  page?: number
  size?: number
  page_count?: number
  stats?: OperationLogStats
  type_facets?: Array<{ value: string; count: number }>
  visibility_scope?: 'all' | 'self'
}

export interface OperationLogStats {
  total: number
  success: number
  warning: number
  error: number
  info: number
  latest_at: string | null
  scope?: 'filtered' | string
}

export interface OperationLogListParams {
  page?: number
  size?: number
  type?: string
  level?: string
  keyword?: string
  start_time?: string
  end_time?: string
  collapse_periodic?: boolean
}

export interface OperationLogRetentionPreview {
  normal_days: number
  error_days: number
  normal_cutoff: string
  error_cutoff: string
  total: number
  deletable: number
  retained: number
  oldest_at: string | null
}

export interface OperationLogCleanupResult {
  success: boolean
  deleted: number
  normal_days: number
  error_days: number
  remaining: number
}

export interface AgentQueryResponse {
  status: string
  query: string
  query_type: string
  metric: string
  entity_id: string
  hours: number | null
  data_source: string
  source_endpoint: string
  fallback_note: string
  result: unknown
}

/* ── API ── */

const MONITOR_CACHE_TTL_MS = 30_000
const dashboardCache = new Map<string, { expiresAt: number; value: MonitorDashboard }>()
const dashboardPending = new Map<string, Promise<MonitorDashboard>>()
const dashboardGeneration = new Map<string, number>()
const monitorSectionCache = new Map<string, { expiresAt: number; value: unknown }>()
const monitorSectionPending = new Map<string, Promise<unknown>>()
const monitorSectionGeneration = new Map<string, number>()
const sensorHistoryCache = new Map<string, { expiresAt: number; value: SensorHistory }>()
const sensorHistoryPending = new Map<string, Promise<SensorHistory>>()
const sensorHistoryGeneration = new Map<string, number>()
const operationLogCache = new Map<string, { expiresAt: number; value: OperationLogsResponse }>()
const operationLogPending = new Map<string, Promise<OperationLogsResponse>>()
const operationLogGeneration = new Map<string, number>()

/** 写操作完成后清理日志读取缓存，确保控制结果可以立即回读。 */
export function clearOperationLogCache() {
  const operationKeys = new Set([
    ...operationLogCache.keys(),
    ...operationLogPending.keys(),
    ...operationLogGeneration.keys(),
  ])
  operationKeys.forEach((key) => {
    operationLogGeneration.set(key, (operationLogGeneration.get(key) || 0) + 1)
  })
  operationLogCache.clear()
  operationLogPending.clear()
  for (const key of new Set([
    ...monitorSectionCache.keys(),
    ...monitorSectionPending.keys(),
    ...monitorSectionGeneration.keys(),
  ])) {
    if (!key.endsWith(':control-trends') && !key.endsWith(':activity')) continue
    monitorSectionGeneration.set(key, (monitorSectionGeneration.get(key) || 0) + 1)
    monitorSectionCache.delete(key)
    monitorSectionPending.delete(key)
  }
  for (const key of new Set([
    ...dashboardCache.keys(),
    ...dashboardPending.keys(),
    ...dashboardGeneration.keys(),
  ])) {
    dashboardGeneration.set(key, (dashboardGeneration.get(key) || 0) + 1)
    dashboardCache.delete(key)
    dashboardPending.delete(key)
  }
}

async function fetchMonitorSection<T>(key: string, path: string, force = false, signal?: AbortSignal): Promise<T> {
  const cached = monitorSectionCache.get(key)
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value as T
  const existing = !force ? monitorSectionPending.get(key) as Promise<T> | undefined : undefined
  if (existing) return waitForSharedRead(existing, signal)

  const generation = (monitorSectionGeneration.get(key) || 0) + 1
  monitorSectionGeneration.set(key, generation)
  const pending = apiClient.get<T>(path, { timeoutMs: MONITOR_READ_TIMEOUT_MS })
    .then((value) => {
      if (monitorSectionGeneration.get(key) === generation) {
        monitorSectionCache.set(key, { value, expiresAt: Date.now() + MONITOR_CACHE_TTL_MS })
      }
      return value
    })
    .finally(() => {
      if (monitorSectionPending.get(key) === pending) monitorSectionPending.delete(key)
    })
  monitorSectionPending.set(key, pending)
  return waitForSharedRead(pending, signal)
}

function operationLogQuery(params: OperationLogListParams) {
  const query: Record<string, string | number | boolean> = {}
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== '') query[key] = value as string | number | boolean
  })
  return query
}

function operationLogCacheKey(query: Record<string, string | number | boolean>) {
  return Object.entries(query)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('&')
}

/** 一次性获取全部监控数据；页面往返时复用 30 秒只读缓存。 */
export async function fetchMonitorDashboard(force = false): Promise<MonitorDashboard> {
  const key = getAuthCacheScope()
  const cached = dashboardCache.get(key)
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value
  const existing = dashboardPending.get(key)
  if (!force && existing) return existing

  const generation = (dashboardGeneration.get(key) || 0) + 1
  dashboardGeneration.set(key, generation)
  const pending = apiClient.get<MonitorDashboard>('/monitor/dashboard', { timeoutMs: MONITOR_READ_TIMEOUT_MS })
    .then((value) => {
      if (dashboardGeneration.get(key) === generation) {
        dashboardCache.set(key, { value, expiresAt: Date.now() + MONITOR_CACHE_TTL_MS })
      }
      return value
    })
    .finally(() => {
      if (dashboardPending.get(key) === pending) dashboardPending.delete(key)
    })
  dashboardPending.set(key, pending)
  return pending
}

/** 单独获取系统资源 */
export async function fetchResources(force = false, signal?: AbortSignal): Promise<ResourceMetrics> {
  return fetchMonitorSection<ResourceMetrics>(`${getAuthCacheScope()}:resources`, '/monitor/resources', force, signal)
}

/** 单独获取 AI 状态 */
export async function fetchAIStatus(force = false, signal?: AbortSignal): Promise<AIStatus> {
  return fetchMonitorSection<AIStatus>(`${getAuthCacheScope()}:ai-status`, '/monitor/ai-status', force, signal)
}

/** 单独获取外部服务健康，慢探测不会阻塞主机和设备数据。 */
export async function fetchServiceHealth(force = false, signal?: AbortSignal): Promise<ServiceStatus[]> {
  const value = await fetchMonitorSection<{ services: ServiceStatus[] }>(`${getAuthCacheScope()}:services`, '/monitor/services', force, signal)
  return value.services
}

/** 单独获取今日活动；外部来源不可达时字段为 null。 */
export async function fetchActivityStats(force = false, signal?: AbortSignal): Promise<ActivityStats> {
  return fetchMonitorSection<ActivityStats>(`${getAuthCacheScope()}:activity`, '/monitor/activity', force, signal)
}

/** 获取控制操作趋势 */
export async function fetchControlTrends(force = false, signal?: AbortSignal): Promise<ControlTrends> {
  return fetchMonitorSection<ControlTrends>(`${getAuthCacheScope()}:control-trends`, '/monitor/control-trends', force, signal)
}

/** 获取最近操作日志 */
export async function fetchOperationLogs(limit = 20, type = ''): Promise<OperationLogsResponse> {
  return fetchOperationLogList({ page: 1, size: limit, type })
}

/** 获取完整操作日志列表 */
export async function fetchOperationLogList(
  params: OperationLogListParams = {},
  force = false,
  signal?: AbortSignal,
): Promise<OperationLogsResponse> {
  const query = operationLogQuery(params)
  const key = `${getAuthCacheScope()}:${operationLogCacheKey(query)}`
  const cached = operationLogCache.get(key)
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value
  const existing = !force ? operationLogPending.get(key) : undefined
  if (existing) return waitForSharedRead(existing, signal)

  const generation = (operationLogGeneration.get(key) || 0) + 1
  operationLogGeneration.set(key, generation)
  const pending = apiClient.get<OperationLogsResponse>('/monitor/logs', { params: query, timeoutMs: MONITOR_READ_TIMEOUT_MS })
    .then((value) => {
      if (operationLogGeneration.get(key) === generation) {
        operationLogCache.set(key, { value, expiresAt: Date.now() + MONITOR_CACHE_TTL_MS })
      }
      return value
    })
    .finally(() => {
      if (operationLogPending.get(key) === pending) operationLogPending.delete(key)
    })
  operationLogPending.set(key, pending)
  return waitForSharedRead(pending, signal)
}

export async function exportOperationLogs(
  params: Omit<OperationLogListParams, 'page' | 'size'> = {},
  signal?: AbortSignal,
): Promise<{ blob: Blob; filename: string; count: number; truncated: boolean }> {
  const result = await apiClient.download('/monitor/logs/export', { params: operationLogQuery(params), timeoutMs: MONITOR_EXPORT_TIMEOUT_MS, signal })
  const disposition = result.headers.get('content-disposition')
  const filename = disposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
    || disposition?.match(/filename="?([^";]+)"?/i)?.[1]
    || 'operation-logs.csv'
  return {
    blob: result.blob,
    filename: decodeURIComponent(filename),
    count: Number(result.headers.get('X-Export-Count') || 0),
    truncated: result.headers.get('X-Export-Truncated') === 'true',
  }
}

export async function fetchOperationLogRetention(
  normalDays = 90,
  errorDays = 365,
  signal?: AbortSignal,
): Promise<OperationLogRetentionPreview> {
  return apiClient.get<OperationLogRetentionPreview>('/monitor/logs/retention', {
    params: { normal_days: normalDays, error_days: errorDays },
    timeoutMs: MONITOR_READ_TIMEOUT_MS,
    signal,
  })
}

export async function cleanupOperationLogs(
  payload: { normal_days: number; error_days: number; confirmation: string },
  signal?: AbortSignal,
): Promise<OperationLogCleanupResult> {
  try {
    return await apiClient.post<OperationLogCleanupResult>('/monitor/logs/retention/cleanup', payload, {
      timeoutMs: 30_000,
      signal,
    })
  } finally {
    clearOperationLogCache()
  }
}

/** 获取指定时间范围内的传感器历史趋势 */
export async function fetchSensorHistory(hours = 24, force = false, signal?: AbortSignal): Promise<SensorHistory> {
  const key = `${getAuthCacheScope()}:${hours}`
  const cached = sensorHistoryCache.get(key)
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value
  const existing = !force ? sensorHistoryPending.get(key) : undefined
  if (existing) return waitForSharedRead(existing, signal)

  const generation = (sensorHistoryGeneration.get(key) || 0) + 1
  sensorHistoryGeneration.set(key, generation)
  const pending = apiClient.get<SensorHistory>('/monitor/sensor-history', { params: { hours }, timeoutMs: MONITOR_READ_TIMEOUT_MS })
    .then((value) => {
      if (sensorHistoryGeneration.get(key) === generation) {
        sensorHistoryCache.set(key, { value, expiresAt: Date.now() + MONITOR_CACHE_TTL_MS })
      }
      return value
    })
    .finally(() => {
      if (sensorHistoryPending.get(key) === pending) sensorHistoryPending.delete(key)
    })
  sensorHistoryPending.set(key, pending)
  return waitForSharedRead(pending, signal)
}

/** Dify 数据查询代理验证 */
export async function fetchAgentQuery(params: {
  query: string
  metric?: string
  queryType?: string
  entityId?: string
  hours?: number
}, signal?: AbortSignal): Promise<AgentQueryResponse> {
  return apiClient.get<AgentQueryResponse>('/monitor/agent-query', {
    params: {
      query: params.query,
      metric: params.metric || '',
      query_type: params.queryType || 'auto',
      entity_id: params.entityId || '',
      hours: params.hours || 24,
    },
    timeoutMs: MONITOR_QUERY_TIMEOUT_MS,
    signal,
  })
}
