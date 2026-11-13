import { apiClient } from './client'
import { getAuthCacheScope } from '@/lib/auth-storage'
import { waitForSharedRead } from './shared-read'

const SYSTEM_READ_TIMEOUT_MS = 15_000
const SYSTEM_PROBE_TIMEOUT_MS = 12_000
const SYSTEM_WRITE_TIMEOUT_MS = 20_000

export type ServiceStatus = 'running' | 'stopped' | 'error' | 'unknown'

export interface RuntimeServiceConfig {
  url: string
  configured?: boolean
  token?: string
  token_configured?: boolean
  status: ServiceStatus
  extra?: Record<string, string>
}

export interface RuntimeSettings {
  services: Record<string, RuntimeServiceConfig>
  security: {
    jwt_expire_hours: number
    allow_registration: boolean
    password_min_length: number
  }
  config_source: string
  override_keys?: string[]
  last_updated_at?: string | null
  can_manage?: boolean
}

export interface TestConnectionResult {
  service: string
  status: ServiceStatus
  message: string
  latency_ms: number
}

export interface RuntimeSettingsStatus {
  services: Record<string, TestConnectionResult>
  tested_at: string
  cached: boolean
}

export interface SettingsHistoryItem {
  id: number
  action: 'save' | 'reset' | 'test' | string
  level: string
  title: string
  changed_keys: string[]
  service: string
  status: string
  latency_ms: number
  message: string
  username: string
  created_at: string | null
}

export interface SettingsHistoryPage {
  items: SettingsHistoryItem[]
  total: number
  page: number
  size: number
}

export interface SystemInfo {
  version: string
  python_version: string
  os_info: string
  db_status: string
  uptime_seconds: number
  uptime_display: string
  api_docs_url: string
  config_source: string
  runtime_details_visible: boolean
}

export interface SettingsWritePayload {
  ollama_base_url?: string
  dify_base_url?: string
  dify_api_key?: string
  dify_dataset_api_key?: string
  ha_base_url?: string
  ha_token?: string
  influxdb_url?: string
  influxdb_token?: string
  influxdb_org?: string
  influxdb_bucket?: string
  jwt_expire_hours?: number
  allow_registration?: boolean
  password_min_length?: number
  reset_keys?: string[]
}

export interface SettingsActionResult {
  success: boolean
  message: string
  updated_keys: string[]
  reset_keys: string[]
}

export interface SystemDashboardService {
  key: string
  name: string
  endpoint: string
  status: ServiceStatus | 'unconfigured'
  latency_ms: number
  detail: string
  source: string
}

export interface SystemDashboardActivity {
  id: number
  type: string
  type_label?: string
  level: string
  title: string
  username: string
  entity_id: string
  created_at: string | null
}

export interface SystemDashboard {
  stats: {
    total_users: number
    active_users: number
    new_users_7d: number
    registered_devices: number
    online_devices: number | null
    model_count: number | null
    knowledge_count: number | null
  }
  services: SystemDashboardService[]
  recent_activity: SystemDashboardActivity[]
  activity_coverage?: {
    scanned_count: number
    scan_limit: number
    scan_truncated: boolean
    distinct_count: number
    display_limit: number
  }
  warnings: string[]
  generated_at: string
  backend_uptime_seconds: number
  scope?: 'all' | 'platform'
  visibility_scope?: 'all' | 'self' | 'public'
}

export interface SystemDashboardRuntime {
  stats: Pick<SystemDashboard['stats'], 'registered_devices' | 'online_devices' | 'model_count' | 'knowledge_count'>
  services: SystemDashboardService[]
  warnings: string[]
  generated_at: string
  scope: 'runtime'
}

export interface PublicSystemSummaryService {
  key: string
  name: string
  status: ServiceStatus | 'unconfigured'
  latency_ms: number
}

export interface PublicSystemSummary {
  overall_status: 'healthy' | 'degraded' | 'unavailable'
  stats: {
    registered_devices: number
    online_devices: number | null
    model_count: number | null
    knowledge_count: number | null
    running_services: number
    total_services: number
  }
  services: PublicSystemSummaryService[]
  generated_at: string
  cached: boolean
}

const SYSTEM_DASHBOARD_TTL_MS = 30_000
const PUBLIC_SUMMARY_STORAGE_KEY = 'smart-home:public-summary:v1'
const PUBLIC_SUMMARY_REVISION_KEY = 'smart-home:public-summary:revision'
const PUBLIC_SUMMARY_LOCK_NAME = 'smart-home:public-summary'
const dashboardCache = new Map<string, { expiresAt: number; value: unknown }>()
const dashboardPending = new Map<string, Promise<unknown>>()
const dashboardGeneration = new Map<string, number>()
let publicSummaryCache: { expiresAt: number; revision: number; value: PublicSystemSummary } | null = null
let publicSummaryPending: Promise<PublicSystemSummary> | null = null
let publicSummaryGeneration = 0
const SETTINGS_CACHE_TTL_MS = 30_000
const settingsCache = new Map<string, { expiresAt: number; value: unknown }>()
const settingsPending = new Map<string, Promise<unknown>>()
const settingsGeneration = new Map<string, number>()

function isFiniteNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

function isPublicSystemSummary(value: unknown): value is PublicSystemSummary {
  if (!value || typeof value !== 'object') return false
  const summary = value as Partial<PublicSystemSummary>
  const stats = summary.stats as Partial<PublicSystemSummary['stats']> | undefined
  const validOverall = ['healthy', 'degraded', 'unavailable'].includes(String(summary.overall_status || ''))
  const validStats = Boolean(
    stats
    && typeof stats.registered_devices === 'number'
    && isFiniteNumberOrNull(stats.online_devices)
    && isFiniteNumberOrNull(stats.model_count)
    && isFiniteNumberOrNull(stats.knowledge_count)
    && typeof stats.running_services === 'number'
    && typeof stats.total_services === 'number',
  )
  const validServices = Array.isArray(summary.services) && summary.services.every((service) => Boolean(
    service
    && typeof service.key === 'string'
    && typeof service.name === 'string'
    && ['running', 'stopped', 'error', 'unknown', 'unconfigured'].includes(service.status)
    && typeof service.latency_ms === 'number'
    && Number.isFinite(service.latency_ms),
  ))
  return validOverall
    && validStats
    && validServices
    && typeof summary.generated_at === 'string'
    && typeof summary.cached === 'boolean'
}

function readPublicSummaryRevision() {
  if (typeof window === 'undefined') return 0
  try {
    const revision = Number(window.localStorage.getItem(PUBLIC_SUMMARY_REVISION_KEY) || 0)
    return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0
  } catch {
    return 0
  }
}

function readSharedPublicSummary(revision: number): { expiresAt: number; revision: number; value: PublicSystemSummary } | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(PUBLIC_SUMMARY_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { expiresAt?: unknown; revision?: unknown; value?: unknown }
    if (parsed.revision !== revision || typeof parsed.expiresAt !== 'number' || parsed.expiresAt <= Date.now() || !isPublicSystemSummary(parsed.value)) {
      window.localStorage.removeItem(PUBLIC_SUMMARY_STORAGE_KEY)
      return null
    }
    return { expiresAt: parsed.expiresAt, revision, value: parsed.value }
  } catch {
    try { window.localStorage.removeItem(PUBLIC_SUMMARY_STORAGE_KEY) } catch { /* 浏览器禁用存储时退回内存缓存。 */ }
    return null
  }
}

function writeSharedPublicSummary(value: PublicSystemSummary, expiresAt: number, revision: number) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(PUBLIC_SUMMARY_STORAGE_KEY, JSON.stringify({ expiresAt, revision, value }))
  } catch {
    // 隐私模式或存储配额不足时，当前标签页的内存缓存仍然可用。
  }
}

function clearSharedPublicSummary() {
  if (typeof window === 'undefined') return
  try {
    const revision = readPublicSummaryRevision()
    window.localStorage.setItem(PUBLIC_SUMMARY_REVISION_KEY, String(revision + 1))
    window.localStorage.removeItem(PUBLIC_SUMMARY_STORAGE_KEY)
  } catch { /* 保持失效流程可继续。 */ }
}

function cachePublicSummary(value: PublicSystemSummary, generation: number, revision: number) {
  if (publicSummaryGeneration !== generation || readPublicSummaryRevision() !== revision) return
  const expiresAt = Date.now() + SYSTEM_DASHBOARD_TTL_MS
  publicSummaryCache = { value, expiresAt, revision }
  writeSharedPublicSummary(value, expiresAt, revision)
}

function waitForPublicSummary(pending: Promise<PublicSystemSummary>, signal: AbortSignal) {
  return new Promise<PublicSystemSummary>((resolve, reject) => {
    const handleAbort = () => {
      cleanup()
      reject(new DOMException('请求已取消', 'AbortError'))
    }
    const cleanup = () => signal.removeEventListener('abort', handleAbort)
    signal.addEventListener('abort', handleAbort, { once: true })
    pending.then(
      (value) => { cleanup(); resolve(value) },
      (error) => { cleanup(); reject(error) },
    )
  })
}

async function cachedSettings<T>(key: string, loader: () => Promise<T>, force = false, signal?: AbortSignal): Promise<T> {
  const scopedKey = `${getAuthCacheScope()}:${key}`
  const hit = settingsCache.get(scopedKey)
  if (!force && hit && hit.expiresAt > Date.now()) return structuredClone(hit.value) as T
  const active = settingsPending.get(scopedKey)
  if (!force && active) return structuredClone(await waitForSharedRead(active as Promise<T>, signal)) as T
  const generation = (settingsGeneration.get(scopedKey) || 0) + 1
  settingsGeneration.set(scopedKey, generation)
  const request = loader().then((value) => {
    if (settingsGeneration.get(scopedKey) === generation) {
      settingsCache.set(scopedKey, { value, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS })
    }
    return value
  }).finally(() => {
    if (settingsPending.get(scopedKey) === request) settingsPending.delete(scopedKey)
  })
  settingsPending.set(scopedKey, request)
  return structuredClone(await waitForSharedRead(request, signal)) as T
}

export function clearSettingsCache() {
  const keys = new Set([...settingsCache.keys(), ...settingsPending.keys(), ...settingsGeneration.keys()])
  keys.forEach((key) => settingsGeneration.set(key, (settingsGeneration.get(key) || 0) + 1))
  settingsCache.clear()
  settingsPending.clear()
}

type DashboardScope = 'all' | 'platform' | 'runtime'

export function clearSystemOverviewCache(options: {
  scopes?: DashboardScope[]
  publicSummary?: boolean
} = {}) {
  const scopes = new Set(options.scopes || ['all', 'platform', 'runtime'])
  const keys = new Set([
    ...dashboardCache.keys(),
    ...dashboardPending.keys(),
    ...dashboardGeneration.keys(),
  ])
  keys.forEach((key) => {
    if (![...scopes].some((scope) => key.endsWith(`:${scope}`))) return
    dashboardGeneration.set(key, (dashboardGeneration.get(key) || 0) + 1)
    dashboardCache.delete(key)
    dashboardPending.delete(key)
  })

  if (options.publicSummary !== false) {
    publicSummaryGeneration += 1
    publicSummaryCache = null
    publicSummaryPending = null
    clearSharedPublicSummary()
  }
}

async function fetchDashboardScope<T>(scope: 'all' | 'platform' | 'runtime', force = false, signal?: AbortSignal): Promise<T> {
  const cacheKey = `${getAuthCacheScope()}:${scope}`
  const hit = dashboardCache.get(cacheKey)
  if (!force && hit && hit.expiresAt > Date.now()) return structuredClone(hit.value) as T
  if (force) {
    const generation = (dashboardGeneration.get(cacheKey) || 0) + 1
    dashboardGeneration.set(cacheKey, generation)
    const value = await apiClient.get<T>('/system/dashboard', { params: { scope }, timeoutMs: SYSTEM_READ_TIMEOUT_MS, signal })
    if (dashboardGeneration.get(cacheKey) === generation) {
      dashboardCache.set(cacheKey, { value, expiresAt: Date.now() + SYSTEM_DASHBOARD_TTL_MS })
    }
    return structuredClone(value) as T
  }
  const active = dashboardPending.get(cacheKey)
  if (active) return structuredClone(await waitForSharedRead(active as Promise<T>, signal)) as T

  const generation = (dashboardGeneration.get(cacheKey) || 0) + 1
  dashboardGeneration.set(cacheKey, generation)
  const pending = apiClient.get<T>('/system/dashboard', { params: { scope }, timeoutMs: SYSTEM_READ_TIMEOUT_MS })
    .then((value) => {
      if (dashboardGeneration.get(cacheKey) === generation) {
        dashboardCache.set(cacheKey, { value, expiresAt: Date.now() + SYSTEM_DASHBOARD_TTL_MS })
      }
      return value
    })
    .finally(() => {
      if (dashboardPending.get(cacheKey) === pending) dashboardPending.delete(cacheKey)
    })
  dashboardPending.set(cacheKey, pending)
  return structuredClone(await waitForSharedRead(pending, signal)) as T
}

export async function fetchSystemDashboard(force = false): Promise<SystemDashboard> {
  return fetchDashboardScope<SystemDashboard>('all', force)
}

export async function fetchSystemDashboardPlatform(force = false, signal?: AbortSignal): Promise<SystemDashboard> {
  return fetchDashboardScope<SystemDashboard>('platform', force, signal)
}

export async function fetchSystemDashboardRuntime(force = false, signal?: AbortSignal): Promise<SystemDashboardRuntime> {
  return fetchDashboardScope<SystemDashboardRuntime>('runtime', force, signal)
}

export async function fetchPublicSystemSummary(force = false, signal?: AbortSignal): Promise<PublicSystemSummary> {
  if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError')
  const revision = readPublicSummaryRevision()
  if (!force && publicSummaryCache && publicSummaryCache.revision === revision && publicSummaryCache.expiresAt > Date.now()) return publicSummaryCache.value
  if (!force) {
    const shared = readSharedPublicSummary(revision)
    if (shared) {
      publicSummaryCache = shared
      return structuredClone(shared.value)
    }
  }
  if (!force && publicSummaryPending) return publicSummaryPending

  const generation = ++publicSummaryGeneration
  const load = async () => {
    if (!force) {
      const shared = readSharedPublicSummary(revision)
      if (shared) {
        publicSummaryCache = shared
        return structuredClone(shared.value)
      }
    }
    const value = await apiClient.get<PublicSystemSummary>('/system/public-summary', { timeoutMs: SYSTEM_READ_TIMEOUT_MS })
    cachePublicSummary(value, generation, revision)
    return value
  }
  const pending: Promise<PublicSystemSummary> = (typeof navigator !== 'undefined' && navigator.locks)
    ? navigator.locks.request<Promise<PublicSystemSummary>>(PUBLIC_SUMMARY_LOCK_NAME, () => load()).then(value => value)
    : load()
  publicSummaryPending = pending
  const sharedResult = pending.finally(() => {
    if (publicSummaryPending === pending) publicSummaryPending = null
  })
  if (!signal) return sharedResult
  return waitForPublicSummary(sharedResult, signal)
}

export async function fetchRuntimeSettings(): Promise<RuntimeSettings> {
  const [config, status] = await Promise.all([
    settingsApi.config(),
    settingsApi.status().catch(() => null),
  ])
  if (status) {
    Object.entries(status.services).forEach(([key, result]) => {
      if (config.services[key]) config.services[key].status = result.status
    })
  }
  return config
}

export async function testServiceConnection(service: 'dify' | 'homeassistant', signal?: AbortSignal): Promise<TestConnectionResult> {
  return apiClient.post<TestConnectionResult>('/system/test-connection', { service }, { timeoutMs: SYSTEM_PROBE_TIMEOUT_MS, signal })
}

export const settingsApi = {
  config: (force = false, signal?: AbortSignal) => cachedSettings(
    'config',
    () => apiClient.get<RuntimeSettings>('/system/settings', { timeoutMs: SYSTEM_READ_TIMEOUT_MS }),
    force,
    signal,
  ),
  status: (force = false, signal?: AbortSignal) => cachedSettings(
    'status',
    () => apiClient.get<RuntimeSettingsStatus>('/system/settings/status', {
      params: force ? { refresh: true } : undefined,
      timeoutMs: SYSTEM_PROBE_TIMEOUT_MS,
    }),
    force,
    signal,
  ),
  info: (force = false, signal?: AbortSignal) => cachedSettings(
    'info',
    () => apiClient.get<SystemInfo>('/system/info', { timeoutMs: SYSTEM_READ_TIMEOUT_MS }),
    force,
    signal,
  ),
  history: (query: { page?: number; size?: number; action?: string } = {}, force = false, signal?: AbortSignal) => {
    const key = `history:${JSON.stringify(query)}`
    return cachedSettings(key, () => apiClient.get<SettingsHistoryPage>('/system/settings/history', { params: query, timeoutMs: SYSTEM_READ_TIMEOUT_MS }), force, signal)
  },
  save: async (payload: SettingsWritePayload, signal?: AbortSignal) => {
    try {
      return await apiClient.put<SettingsActionResult>('/system/settings', payload, { timeoutMs: SYSTEM_WRITE_TIMEOUT_MS, signal })
    } finally {
      clearSettingsCache()
      clearSystemOverviewCache()
    }
  },
  reset: async (keys: string[] = [], signal?: AbortSignal) => {
    try {
      return await apiClient.post<SettingsActionResult>('/system/settings/reset', { keys }, { timeoutMs: SYSTEM_WRITE_TIMEOUT_MS, signal })
    } finally {
      clearSettingsCache()
      clearSystemOverviewCache()
    }
  },
  test: async (service: string, payload: Record<string, unknown> = {}, signal?: AbortSignal) => {
    const result = await apiClient.post<TestConnectionResult>('/system/test-connection', { service, ...payload }, { timeoutMs: SYSTEM_PROBE_TIMEOUT_MS, signal })
    clearSettingsCache()
    clearSystemOverviewCache({ scopes: ['all', 'platform'], publicSummary: false })
    return result
  },
}
