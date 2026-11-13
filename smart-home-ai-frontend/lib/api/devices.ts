/**
 * 设备接入与控制 API
 */
import { apiClient } from './client'
import { clearOperationLogCache, type OperationLogsResponse } from './monitor'
import { clearSystemOverviewCache } from './system'
import { getAuthCacheScope } from '@/lib/auth-storage'
import { waitForSharedRead } from './shared-read'

export type GatewayType = 'homeassistant' | 'mqtt' | 'modbus' | 'http' | 'xiaomi' | string

export interface EntityState {
  entity_id: string
  state: string
  unit: string
  attributes: Record<string, unknown>
  last_changed: string | null
  mapping_id?: number
  access_mode?: string
  gateway_type?: string
  physical_confirmation?: 'physical_pending' | 'state_only' | string
  control_actions?: string[]
  capabilities?: DeviceCapability[]
}

export interface DeviceCapability {
  id: string
  label: string
  control_type: 'actions' | 'range' | 'select' | string
  actions?: string[]
  action?: string
  min?: number
  max?: number
  step?: number
  unit?: string
  options?: string[]
  current_value?: string | number | null
}

export interface DeviceGateway {
  id: number
  name: string
  gateway_type: GatewayType
  base_url: string
  port?: number | null
  auth_type: string
  enabled: boolean
  status: string
  description: string
  system_managed?: boolean
  has_credential: boolean
  credential_masked: string
  last_test_at?: string | null
  created_at?: string | null
  updated_at?: string | null
}

export interface DeviceGatewayPayload {
  name: string
  gateway_type: GatewayType
  base_url: string
  port?: number | null
  auth_type: string
  credential?: string
  enabled: boolean
  description: string
}

export interface DeviceMapping {
  id?: number | null
  role: string
  endpoint: string
  gateway_type: GatewayType
  access_mode: 'ro' | 'rw' | 'write' | string
  unit: string
  value_path?: string
  control_actions: string[]
  metadata?: Record<string, unknown>
}

export interface DevicePayload {
  name: string
  category: string
  brand: string
  model: string
  location: string
  protocol: string
  gateway_id?: number | null
  description: string
  local_control: boolean
  enabled: boolean
  capability_tags: string[]
  mappings: DeviceMapping[]
}

export interface LogicalDevice {
  id: string
  record_id?: number
  name: string
  description: string
  category: string
  brand?: string
  model?: string
  location?: string
  protocol?: string
  gateway_id?: number | null
  gateway_name?: string
  gateway_type?: string
  status: 'online' | 'offline' | 'unmapped' | 'disabled' | string
  enabled?: boolean
  local_control?: boolean
  source?: string
  capability_tags?: string[]
  entities: Record<string, EntityState>
  mappings?: DeviceMapping[]
  logs?: Array<Record<string, unknown>>
}

export interface SceneItem {
  entity_id: string
  name: string
  icon: string
  entity_count: number
  last_activated: string
}

export interface DeviceSummary {
  total: number
  online: number
  offline: number
  unmapped?: number
  disabled?: number
  seed?: number
  scene_count: number | null
  categories: Record<string, number>
}

export interface DeviceListResponse {
  devices: LogicalDevice[]
  scenes: SceneItem[]
  summary: DeviceSummary
  page: number
  size: number
  total: number
  pages: number
  ha_error?: string
  generated_at?: string
  cache?: 'hit' | 'miss' | 'shared' | string
  cache_ttl_seconds?: number
}

export interface DeviceListParams {
  page?: number
  size?: number
  keyword?: string
  category?: string
  status?: string
  gatewayId?: number
  sort?: 'name' | 'status' | 'category'
  refresh?: boolean
  signal?: AbortSignal
}

export interface ControlResult {
  success: boolean
  entity_id: string
  service: string
  action?: string
  new_state: string | null
  attributes: Record<string, unknown>
  confirmation?: 'confirmed' | 'accepted' | 'physical_pending' | string
}

// 页面控制器负责 12 秒交互兜底；客户端超时稍后触发，避免两个定时器同时中止请求。
const DEVICE_CONTROL_TIMEOUT_MS = 15_000
const DEVICE_WRITE_TIMEOUT_MS = 20_000
const DEVICE_GATEWAY_TIMEOUT_MS = 30_000

export interface DeviceHealth {
  status: 'ok' | 'error'
  module: string
  ha_connected: boolean
  latency_ms: number
  tested_at: string
}

export interface GatewayListResponse {
  gateways: DeviceGateway[]
  can_manage?: boolean
}

export interface GatewayTestResponse {
  status: string
  message: string
  gateway: DeviceGateway
}

export interface GatewaySyncCandidate {
  entity_id: string
  domain: string
  name: string
  state: string
  unit: string
  mapped: boolean
  importable?: boolean
  recommended?: boolean
  ha_device_id?: string
  device_name?: string
  area_id?: string
  area_name?: string
  manufacturer?: string
  model?: string
  platform?: string
  entity_category?: string
  device_class?: string
  classification?: 'hardware' | 'helper' | 'system' | 'unregistered'
  classification_reason?: string
  control_actions?: string[]
  capability_metadata?: Record<string, unknown>
}

export interface GatewaySyncResponse {
  status: string
  message: string
  candidates: GatewaySyncCandidate[]
  updated_mappings: number
  hardware_entities?: number
  recommended_entities?: number
}

export interface GatewayImportResponse {
  status: string
  message: string
  imported: Array<{ device_id: string; entity_id: string; name: string }>
  skipped: Array<{ entity_id: string; reason: string }>
}

export interface DemoDeviceCleanupResponse {
  success: boolean
  deleted: number
  message: string
}

export type HomeAssistantClassification = 'hardware' | 'helper' | 'system' | 'unregistered'

export interface HomeAssistantWorkspaceItem extends GatewaySyncCandidate {
  last_changed?: string | null
  last_updated?: string | null
  platform_device_id?: number | null
  platform_device_name?: string
  mapping_role?: string
  mapping_access_mode?: string
  mapping_aliases?: string[]
  physical_confirmation?: 'physical_pending' | 'state_only' | string
}

export interface HomeAssistantWorkspaceDiagnostic {
  id: string
  severity: 'info' | 'warning' | 'error' | string
  title: string
  message: string
  affected_count?: number
  entity_ids?: string[]
  entity_ids_truncated?: boolean
  action_href?: string
  action_label?: string
}

export interface HomeAssistantOrphanMapping {
  mapping_id?: number | null
  platform_device_id?: number | null
  platform_device_name: string
  mapping_role: string
  entity_id: string
  mapping_access_mode: string
}

export interface HomeAssistantWorkspaceResponse {
  status: 'running' | 'error' | string
  gateway: {
    id: number
    name: string
    base_url: string
    enabled: boolean
    status: string
    credential_configured: boolean
    config_source: string
    last_test_at?: string | null
  }
  summary: {
    total_entities: number
    hardware_entities: number
    helper_entities: number
    system_entities: number
    unregistered_entities: number
    recommended_entities: number
    mapped_entities: number
    mapped_devices: number
    unavailable_entities: number
    hardware_unavailable_entities: number
    hardware_unavailable_devices: number
    other_unavailable_entities: number
    ha_devices: number
    areas: number
    scenes: number
    orphan_mappings: number
    xiaomi_mapped_entities: number
  }
  items: HomeAssistantWorkspaceItem[]
  page: number
  size: number
  total: number
  pages: number
  domains: Record<string, number>
  diagnostics: HomeAssistantWorkspaceDiagnostic[]
  diagnostics_total?: number
  diagnostics_page?: number
  diagnostics_size?: number
  diagnostics_pages?: number
  orphan_items: HomeAssistantOrphanMapping[]
  orphan_total: number
  orphan_page: number
  orphan_pages: number
  generated_at: string
  duration_ms: number
  cache_hit: boolean
  cache_ttl_seconds: number
  data_sources: string[]
}

export interface HomeAssistantWorkspaceParams {
  page?: number
  size?: number
  diagnosticPage?: number
  diagnosticSize?: number
  keyword?: string
  classification?: string
  domain?: string
  mapped?: boolean | ''
  status?: string
  refresh?: boolean
  signal?: AbortSignal
}

/* ── API ── */

const DEVICE_READ_CACHE_TTL_MS = 30_000
const DEVICE_READ_TIMEOUT_MS = 15_000
const deviceListCache = new Map<string, { expiresAt: number; value: DeviceListResponse }>()
const deviceListPending = new Map<string, Promise<DeviceListResponse>>()
const deviceListGeneration = new Map<string, number>()
const deviceDetailCache = new Map<string, { expiresAt: number; value: LogicalDevice }>()
const deviceDetailPending = new Map<string, Promise<LogicalDevice>>()
const deviceDetailGeneration = new Map<string, number>()
const deviceLogCache = new Map<string, { expiresAt: number; value: OperationLogsResponse }>()
const deviceLogPending = new Map<string, Promise<OperationLogsResponse>>()
const deviceLogGeneration = new Map<string, number>()
const gatewayCache = new Map<string, { expiresAt: number; value: GatewayListResponse }>()
const gatewayPending = new Map<string, Promise<GatewayListResponse>>()
const gatewayGeneration = new Map<string, number>()

function deviceListQuery(params: DeviceListParams) {
  const query: Record<string, string | number | boolean> = {
    page: params.page || 1,
    size: params.size || 20,
    sort: params.sort || 'name',
  }
  if (params.keyword?.trim()) query.keyword = params.keyword.trim()
  if (params.category) query.category = params.category
  if (params.status) query.status = params.status
  if (params.gatewayId) query.gateway_id = params.gatewayId
  if (params.refresh) query.refresh = true
  return query
}

function stableQueryKey(query: Record<string, string | number | boolean>) {
  return Object.entries(query)
    .filter(([key]) => key !== 'refresh')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('&')
}

export function clearDeviceReadCache(options: { gateways?: boolean } = {}) {
  const listKeys = new Set([...deviceListCache.keys(), ...deviceListPending.keys(), ...deviceListGeneration.keys()])
  listKeys.forEach((key) => deviceListGeneration.set(key, (deviceListGeneration.get(key) || 0) + 1))
  deviceListCache.clear()
  deviceListPending.clear()
  const detailKeys = new Set([
    ...deviceDetailCache.keys(),
    ...deviceDetailPending.keys(),
    ...deviceDetailGeneration.keys(),
  ])
  detailKeys.forEach((key) => deviceDetailGeneration.set(key, (deviceDetailGeneration.get(key) || 0) + 1))
  deviceDetailCache.clear()
  deviceDetailPending.clear()
  const logKeys = new Set([
    ...deviceLogCache.keys(),
    ...deviceLogPending.keys(),
    ...deviceLogGeneration.keys(),
  ])
  logKeys.forEach((key) => deviceLogGeneration.set(key, (deviceLogGeneration.get(key) || 0) + 1))
  deviceLogCache.clear()
  deviceLogPending.clear()
  clearHomeAssistantWorkspaceCache()
  if (options.gateways) {
    const keys = new Set([...gatewayCache.keys(), ...gatewayPending.keys(), ...gatewayGeneration.keys()])
    keys.forEach((key) => gatewayGeneration.set(key, (gatewayGeneration.get(key) || 0) + 1))
    gatewayCache.clear()
    gatewayPending.clear()
  }
}

/** 服务端分页读取设备、场景与完整汇总。 */
export async function fetchDevices(params: DeviceListParams = {}): Promise<DeviceListResponse> {
  const query = deviceListQuery(params)
  const key = `${getAuthCacheScope()}:${stableQueryKey(query)}`
  const cached = deviceListCache.get(key)
  if (!params.refresh && cached && cached.expiresAt > Date.now()) return cached.value
  const existing = !params.refresh ? deviceListPending.get(key) : undefined
  if (existing) return waitForSharedRead(existing, params.signal)
  const generation = (deviceListGeneration.get(key) || 0) + 1
  deviceListGeneration.set(key, generation)
  const pending = apiClient.get<DeviceListResponse>('/devices', {
    params: query,
    timeoutMs: DEVICE_READ_TIMEOUT_MS,
  })
    .then((value) => {
      if (deviceListGeneration.get(key) === generation) {
        deviceListCache.set(key, { value, expiresAt: Date.now() + DEVICE_READ_CACHE_TTL_MS })
      }
      return value
    })
    .finally(() => {
      if (deviceListPending.get(key) === pending) deviceListPending.delete(key)
    })
  deviceListPending.set(key, pending)
  return waitForSharedRead(pending, params.signal)
}

export async function fetchDevice(id: string | number, force = false, signal?: AbortSignal): Promise<LogicalDevice> {
  const key = `${getAuthCacheScope()}:${String(id)}`
  const cached = deviceDetailCache.get(key)
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value
  const active = deviceDetailPending.get(key)
  if (!force && active) return waitForSharedRead(active, signal)
  const generation = (deviceDetailGeneration.get(key) || 0) + 1
  deviceDetailGeneration.set(key, generation)
  const pending = apiClient.get<LogicalDevice>(`/devices/${id}`, { signal: force ? signal : undefined, timeoutMs: DEVICE_READ_TIMEOUT_MS })
    .then((value) => {
      if (deviceDetailGeneration.get(key) === generation) {
        deviceDetailCache.set(key, { value, expiresAt: Date.now() + DEVICE_READ_CACHE_TTL_MS })
      }
      return value
    })
    .finally(() => {
      if (deviceDetailPending.get(key) === pending) deviceDetailPending.delete(key)
    })
  if (force) return pending
  deviceDetailPending.set(key, pending)
  return waitForSharedRead(pending, signal)
}

/** 精确读取单台设备的控制日志，不用固定十条记录模拟分页。 */
export async function fetchDeviceOperationLogs(
  id: string | number,
  page = 1,
  size = 10,
  force = false,
  signal?: AbortSignal,
): Promise<OperationLogsResponse> {
  const key = `${getAuthCacheScope()}:${id}:${page}:${size}`
  const cached = deviceLogCache.get(key)
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value
  const active = deviceLogPending.get(key)
  if (!force && active) return waitForSharedRead(active, signal)
  const generation = (deviceLogGeneration.get(key) || 0) + 1
  deviceLogGeneration.set(key, generation)
  const pending = apiClient.get<OperationLogsResponse>(`/devices/${id}/logs`, {
    params: { page, size },
    signal: force ? signal : undefined,
    timeoutMs: DEVICE_READ_TIMEOUT_MS,
  }).then((value) => {
    if (deviceLogGeneration.get(key) === generation) {
      deviceLogCache.set(key, { value, expiresAt: Date.now() + DEVICE_READ_CACHE_TTL_MS })
    }
    return value
  }).finally(() => {
    if (deviceLogPending.get(key) === pending) deviceLogPending.delete(key)
  })
  if (force) return pending
  deviceLogPending.set(key, pending)
  return waitForSharedRead(pending, signal)
}

export async function createDevice(payload: DevicePayload, signal?: AbortSignal): Promise<LogicalDevice> {
  try {
    return await apiClient.post<LogicalDevice>('/devices', payload, { timeoutMs: DEVICE_WRITE_TIMEOUT_MS, signal })
  } finally {
    clearDeviceReadCache()
    clearSystemOverviewCache()
  }
}

export async function updateDevice(id: string | number, payload: DevicePayload, signal?: AbortSignal): Promise<LogicalDevice> {
  try {
    return await apiClient.put<LogicalDevice>(`/devices/${id}`, payload, { timeoutMs: DEVICE_WRITE_TIMEOUT_MS, signal })
  } finally {
    clearDeviceReadCache()
    clearSystemOverviewCache()
  }
}

export async function deleteDevice(id: string | number, signal?: AbortSignal): Promise<void> {
  try {
    await apiClient.delete<void>(`/devices/${id}`, { timeoutMs: DEVICE_WRITE_TIMEOUT_MS, signal })
  } finally {
    clearDeviceReadCache()
    clearSystemOverviewCache()
  }
}

export async function fetchGateways(force = false, signal?: AbortSignal): Promise<GatewayListResponse> {
  const key = getAuthCacheScope()
  const cached = gatewayCache.get(key)
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value
  const active = gatewayPending.get(key)
  if (!force && active) return waitForSharedRead(active, signal)
  const generation = (gatewayGeneration.get(key) || 0) + 1
  gatewayGeneration.set(key, generation)
  const pending = apiClient.get<GatewayListResponse>('/devices/gateways', { signal: force ? signal : undefined, timeoutMs: DEVICE_READ_TIMEOUT_MS })
    .then((value) => {
      if (gatewayGeneration.get(key) === generation) {
        gatewayCache.set(key, { value, expiresAt: Date.now() + DEVICE_READ_CACHE_TTL_MS })
      }
      return value
    })
    .finally(() => {
      if (gatewayPending.get(key) === pending) gatewayPending.delete(key)
    })
  if (force) return pending
  gatewayPending.set(key, pending)
  return waitForSharedRead(pending, signal)
}

export async function createGateway(payload: DeviceGatewayPayload, signal?: AbortSignal): Promise<DeviceGateway> {
  try {
    return await apiClient.post<DeviceGateway>('/devices/gateways', payload, { timeoutMs: DEVICE_WRITE_TIMEOUT_MS, signal })
  } finally {
    clearDeviceReadCache({ gateways: true })
  }
}

export async function updateGateway(id: number, payload: DeviceGatewayPayload, signal?: AbortSignal): Promise<DeviceGateway> {
  try {
    return await apiClient.put<DeviceGateway>(`/devices/gateways/${id}`, payload, { timeoutMs: DEVICE_WRITE_TIMEOUT_MS, signal })
  } finally {
    clearDeviceReadCache({ gateways: true })
  }
}

export async function deleteGateway(id: number, signal?: AbortSignal): Promise<void> {
  try {
    await apiClient.delete<void>(`/devices/gateways/${id}`, { timeoutMs: DEVICE_WRITE_TIMEOUT_MS, signal })
  } finally {
    clearDeviceReadCache({ gateways: true })
  }
}

export async function testGateway(id: number, signal?: AbortSignal): Promise<GatewayTestResponse> {
  try {
    return await apiClient.post<GatewayTestResponse>(`/devices/gateways/${id}/test`, undefined, { timeoutMs: DEVICE_GATEWAY_TIMEOUT_MS, signal })
  } finally {
    clearDeviceReadCache({ gateways: true })
  }
}

export async function syncGateway(id: number, signal?: AbortSignal): Promise<GatewaySyncResponse> {
  try {
    return await apiClient.post<GatewaySyncResponse>(`/devices/gateways/${id}/sync`, undefined, { timeoutMs: DEVICE_GATEWAY_TIMEOUT_MS, signal })
  } finally {
    clearDeviceReadCache({ gateways: true })
  }
}

export async function importGatewayEntities(id: number, entityIds: string[], signal?: AbortSignal): Promise<GatewayImportResponse> {
  try {
    return await apiClient.post<GatewayImportResponse>(`/devices/gateways/${id}/import`, {
      entity_ids: entityIds,
    }, { timeoutMs: DEVICE_GATEWAY_TIMEOUT_MS, signal })
  } finally {
    clearDeviceReadCache()
    clearSystemOverviewCache()
  }
}

export async function cleanupDemoDevices(signal?: AbortSignal): Promise<DemoDeviceCleanupResponse> {
  try {
    return await apiClient.delete<DemoDeviceCleanupResponse>('/devices/demo-devices', { timeoutMs: DEVICE_WRITE_TIMEOUT_MS, signal })
  } finally {
    clearDeviceReadCache()
    clearSystemOverviewCache()
  }
}

/** 检查设备模块与 Home Assistant 连接 */
export async function fetchDeviceHealth(signal?: AbortSignal): Promise<DeviceHealth> {
  return apiClient.get<DeviceHealth>('/devices/health', { signal, timeoutMs: DEVICE_READ_TIMEOUT_MS })
}

const HA_WORKSPACE_CLIENT_TTL_MS = 30_000
const haWorkspaceCache = new Map<string, { expiresAt: number; payload: HomeAssistantWorkspaceResponse }>()
const haWorkspacePending = new Map<string, Promise<HomeAssistantWorkspaceResponse>>()
const haWorkspaceGeneration = new Map<string, number>()

function clearHomeAssistantWorkspaceCache() {
  const keys = new Set([
    ...haWorkspaceCache.keys(),
    ...haWorkspacePending.keys(),
    ...haWorkspaceGeneration.keys(),
  ])
  keys.forEach((key) => {
    haWorkspaceCache.delete(key)
    haWorkspacePending.delete(key)
    haWorkspaceGeneration.set(key, (haWorkspaceGeneration.get(key) || 0) + 1)
  })
}

/** 读取只读 HA 发现、映射与诊断工作台；不执行同步、导入或控制。 */
export async function fetchHomeAssistantWorkspace(
  params: HomeAssistantWorkspaceParams = {},
): Promise<HomeAssistantWorkspaceResponse> {
  const normalized = {
    page: params.page || 1,
    size: params.size || 20,
    diagnostic_page: params.diagnosticPage || 1,
    diagnostic_size: params.diagnosticSize || 10,
    keyword: params.keyword || '',
    classification: params.classification || '',
    domain: params.domain || '',
    status: params.status || '',
    refresh: Boolean(params.refresh),
    ...(params.mapped === '' || params.mapped === undefined ? {} : { mapped: params.mapped }),
  }
  const cacheKey = `${getAuthCacheScope()}:${JSON.stringify({ ...normalized, refresh: false })}`
  const cached = haWorkspaceCache.get(cacheKey)
  if (!normalized.refresh && cached && cached.expiresAt > Date.now()) return cached.payload

  const pending = haWorkspacePending.get(cacheKey)
  if (!normalized.refresh && pending) return waitForSharedRead(pending, params.signal)
  const generation = (haWorkspaceGeneration.get(cacheKey) || 0) + 1
  haWorkspaceGeneration.set(cacheKey, generation)
  const request = apiClient.get<HomeAssistantWorkspaceResponse>('/devices/home-assistant/workspace', {
    params: normalized,
    signal: normalized.refresh ? params.signal : undefined,
    timeoutMs: DEVICE_READ_TIMEOUT_MS,
  }).then((payload) => {
    if (haWorkspaceGeneration.get(cacheKey) === generation) {
      haWorkspaceCache.set(cacheKey, { expiresAt: Date.now() + HA_WORKSPACE_CLIENT_TTL_MS, payload })
    }
    return payload
  }).finally(() => {
    if (haWorkspacePending.get(cacheKey) === request) haWorkspacePending.delete(cacheKey)
  })
  if (normalized.refresh) return request
  haWorkspacePending.set(cacheKey, request)
  return waitForSharedRead(request, params.signal)
}

/** 控制设备（操作单个实体） */
export async function controlDevice(
  entityId: string | number,
  service: string,
  domain?: string,
  data?: Record<string, unknown>,
  role?: string,
  signal?: AbortSignal,
): Promise<ControlResult> {
  try {
    return await apiClient.post<ControlResult>(`/devices/${entityId}/control`, {
      service,
      domain: domain || undefined,
      data: data || undefined,
      role: role || undefined,
    }, { timeoutMs: DEVICE_CONTROL_TIMEOUT_MS, signal })
  } finally {
    clearDeviceReadCache()
    clearOperationLogCache()
    clearSystemOverviewCache({ scopes: ['all', 'platform'], publicSummary: false })
  }
}

/** 触发场景 */
export async function activateScene(entityId: string, signal?: AbortSignal): Promise<ControlResult> {
  return controlDevice(entityId, 'turn_on', 'scene', undefined, undefined, signal)
}
