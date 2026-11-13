/**
 * 电子沙盘 API
 */
import { apiClient } from './client'
import { getAuthCacheScope } from '@/lib/auth-storage'
import { waitForSharedRead } from './shared-read'

const SANDBOX_READ_TIMEOUT_MS = 15_000
const SANDBOX_WRITE_TIMEOUT_MS = 20_000
const SANDBOX_SCENE_TIMEOUT_MS = 60_000
const SANDBOX_DEVICE_CACHE_TTL_MS = 5_000
const SANDBOX_SCENE_CACHE_TTL_MS = 5 * 60_000
const SANDBOX_LOG_CACHE_TTL_MS = 30_000

const readCache = new Map<string, { expiresAt: number; value: unknown }>()
const pendingReads = new Map<string, Promise<unknown>>()
const readGenerations = new Map<string, number>()

function scopedCacheKey(key: string) {
  return `${getAuthCacheScope()}:${key}`
}

async function cachedRead<T>(
  key: string,
  loader: () => Promise<T>,
  ttlMs: number,
  force = false,
  signal?: AbortSignal,
): Promise<T> {
  const scopedKey = scopedCacheKey(key)
  const cached = readCache.get(scopedKey)
  if (!force && cached && cached.expiresAt > Date.now()) {
    return structuredClone(cached.value) as T
  }

  const active = pendingReads.get(scopedKey)
  if (!force && active) return structuredClone(await waitForSharedRead(active as Promise<T>, signal)) as T

  const generation = (readGenerations.get(scopedKey) || 0) + 1
  readGenerations.set(scopedKey, generation)
  const request = loader()
    .then((value) => {
      if (readGenerations.get(scopedKey) === generation) {
        readCache.set(scopedKey, { value, expiresAt: Date.now() + ttlMs })
      }
      return value
    })
    .finally(() => {
      if (pendingReads.get(scopedKey) === request) pendingReads.delete(scopedKey)
    })
  pendingReads.set(scopedKey, request)
  return structuredClone(await waitForSharedRead(request, signal)) as T
}

export function clearSandboxReadCache(scope = '') {
  const authPrefix = `${getAuthCacheScope()}:`
  const keys = new Set([...readCache.keys(), ...pendingReads.keys(), ...readGenerations.keys()])
  keys.forEach((key) => {
    if (!key.startsWith(authPrefix)) return
    const resourceKey = key.slice(authPrefix.length)
    if (scope && !resourceKey.startsWith(scope)) return
    readGenerations.set(key, (readGenerations.get(key) || 0) + 1)
    readCache.delete(key)
    pendingReads.delete(key)
  })
}

/* ── Types ── */

export interface EntityState {
  state: string
  attributes: Record<string, unknown>
  last_changed?: string
  last_updated?: string
}

export interface InjectConfig {
  min: number
  max: number
  step: number
  unit: string
  label: string
}

export interface VirtualDevice {
  id: string
  name: string
  area: string
  category: string
  icon: string
  entities: Record<string, string>
  entity_states: Record<string, EntityState>
  availability: 'available' | 'partial' | 'unavailable'
  available_entity_count: number
  total_entity_count: number
  missing_roles: string[]
  injectable: boolean
  inject_config?: InjectConfig
}

export interface ScenePreset {
  id: string
  name: string
  description: string
  operation_count: number
  injection_count: number
  control_count: number
  operations: Array<{
    kind: 'inject' | 'control'
    entity_id: string
    device_name: string
    action_label: string
    target_label: string
  }>
}

export interface SandboxLog {
  id: number
  action: 'inject' | 'control' | 'scene' | 'system'
  source: 'manual' | 'preset' | 'auto'
  level: 'info' | 'success' | 'warning' | 'error'
  title: string
  device_name: string
  entity_id: string
  service: string
  requested_value: string
  actual_state: string
  confirmed: boolean | null
  total: number | null
  succeeded: number | null
  failed: number | null
  error: string
  operator: string
  created_at: string
}

export interface SandboxLogResponse {
  items: SandboxLog[]
  /** 旧版页面兼容别名，新工作台使用 items。 */
  logs: SandboxLog[]
  total: number
  page: number
  size: number
  page_count: number
  summary: {
    total: number
    successful: number
    attention: number
    last_24h: number
    latest_at: string | null
  }
}

export interface SandboxDevicesResponse {
  devices: VirtualDevice[]
  count: number
  available_count: number
  partial_count: number
  unavailable_count: number
  mode: 'simulation'
  ha_connected: boolean
  status: 'connected' | 'unavailable'
  error: string | null
  fetched_at: string
  cache_ttl_seconds: number
}

export interface SandboxWriteResult {
  success: boolean
  entity_id: string
  device_name: string
  confirmed: boolean
  mode: 'simulation'
  readback: EntityState
}

export interface SceneExecutionItem {
  kind: 'inject' | 'control'
  device_name: string
  entity_id: string
  service?: string
  action_label: string
  requested_value: string
  actual_state: string
  success: boolean
  confirmed: boolean
  error: string
}

export interface SceneExecutionResult {
  success: boolean
  partial: boolean
  scene_id: string
  scene: string
  operation_count: number
  succeeded_count: number
  failed_count: number
  results: SceneExecutionItem[]
  mode: 'simulation'
}

export interface SandboxEntities {
  light_living: string
  light_bedroom: string
  light_study: string
  switch_coffee: string
  switch_water_heater: string
  switch_front_lock: string
  sensor_temp: string
  sensor_humidity: string
  sensor_pm25: string
  sensor_power: string
  binary_door: string
  scene_home: string
  scene_away: string
  scene_sleep: string
  scene_cinema: string
}

export interface SandboxClientConfig {
  ha_url: string
  auth_mode: 'backend_proxy'
  entities: SandboxEntities
  mode: 'simulation'
}

/* ── API ── */

/** 获取电子沙盘前端连接配置 */
export async function fetchSandboxClientConfig(): Promise<SandboxClientConfig> {
  return apiClient.get('/sandbox/client-config', { timeoutMs: SANDBOX_READ_TIMEOUT_MS })
}

/** 获取虚拟设备列表与状态，后端使用短时批量状态快照。 */
export async function fetchSandboxDevices(refresh = false, signal?: AbortSignal): Promise<SandboxDevicesResponse> {
  return cachedRead(
    'devices',
    () => apiClient.get('/sandbox/devices', { params: { refresh }, timeoutMs: SANDBOX_READ_TIMEOUT_MS }),
    SANDBOX_DEVICE_CACHE_TTL_MS,
    refresh,
    signal,
  )
}

/** 数据注入 */
export async function injectData(payload: {
  entity_id: string
  value: string
  source?: string
}, signal?: AbortSignal): Promise<SandboxWriteResult & { value: string }> {
  try {
    return await apiClient.post<SandboxWriteResult & { value: string }>('/sandbox/inject', payload, { timeoutMs: SANDBOX_WRITE_TIMEOUT_MS, signal })
  } finally {
    clearSandboxReadCache('devices')
    clearSandboxReadCache('logs:')
  }
}

/** 控制虚拟设备 */
export async function controlSandboxDevice(payload: {
  entity_id: string
  service: string
  data?: Record<string, unknown>
}, signal?: AbortSignal): Promise<SandboxWriteResult & { service: string; previous_state: EntityState }> {
  try {
    return await apiClient.post<SandboxWriteResult & { service: string; previous_state: EntityState }>('/sandbox/control', payload, { timeoutMs: SANDBOX_WRITE_TIMEOUT_MS, signal })
  } finally {
    clearSandboxReadCache('devices')
    clearSandboxReadCache('logs:')
  }
}

/** 获取场景预设 */
export async function fetchScenePresets(signal?: AbortSignal, refresh = false): Promise<{ scenes: ScenePreset[]; count: number; mode: 'simulation' }> {
  return cachedRead(
    'scenes',
    () => apiClient.get('/sandbox/scenes', { timeoutMs: SANDBOX_READ_TIMEOUT_MS }),
    SANDBOX_SCENE_CACHE_TTL_MS,
    refresh,
    signal,
  )
}

/** 执行场景预设 */
export async function executeScene(sceneId: string, signal?: AbortSignal): Promise<SceneExecutionResult> {
  try {
    return await apiClient.post<SceneExecutionResult>(`/sandbox/scenes/${sceneId}/execute`, undefined, { timeoutMs: SANDBOX_SCENE_TIMEOUT_MS, signal })
  } finally {
    clearSandboxReadCache('devices')
    clearSandboxReadCache('logs:')
  }
}

/** 获取仿真日志 */
export async function fetchSandboxLogs(params?: {
  page?: number
  size?: number
  level?: string
  action?: string
  keyword?: string
}, signal?: AbortSignal, refresh = false): Promise<SandboxLogResponse> {
  const query = {
    page: params?.page || 1,
    size: params?.size || 20,
    level: params?.level || '',
    action: params?.action || '',
    keyword: params?.keyword?.trim() || '',
  }
  return cachedRead(
    `logs:${JSON.stringify(query)}`,
    () => apiClient.get('/sandbox/logs', {
      params: Object.fromEntries(Object.entries(query).filter(([, value]) => value !== '')) as Record<string, string | number | boolean>,
      timeoutMs: SANDBOX_READ_TIMEOUT_MS,
    }),
    SANDBOX_LOG_CACHE_TTL_MS,
    refresh,
    signal,
  )
}

/** 清空日志 */
export async function clearSandboxLogs(signal?: AbortSignal): Promise<{ success: boolean; deleted: number; operator: string }> {
  try {
    return await apiClient.delete<{ success: boolean; deleted: number; operator: string }>('/sandbox/logs', { timeoutMs: SANDBOX_WRITE_TIMEOUT_MS, signal })
  } finally {
    clearSandboxReadCache('logs:')
  }
}
