'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  History,
  Layers,
  LayoutGrid,
  List,
  Loader2,
  Network,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Search,
  ServerCog,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import {
  activateScene,
  cleanupDemoDevices,
  controlDevice,
  createDevice,
  createGateway,
  deleteDevice,
  deleteGateway,
  fetchDevice,
  fetchDeviceOperationLogs,
  fetchDevices,
  fetchGateways,
  importGatewayEntities,
  syncGateway,
  testGateway,
  updateDevice,
  updateGateway,
  type DeviceGateway,
  type DeviceGatewayPayload,
  type DeviceCapability,
  type DeviceListResponse,
  type DeviceMapping,
  type DevicePayload,
  type EntityState,
  type GatewaySyncCandidate,
  type LogicalDevice,
  type SceneItem,
} from '@/lib/api/devices'
import { fetchOperationLogList, type OperationLogItem, type OperationLogsResponse } from '@/lib/api/monitor'
import { ApiError } from '@/lib/api/client'
import { AppDialog } from '@/components/ui/AppDialog'
import { AppDrawer } from '@/components/ui/AppDrawer'
import { EmptyState } from '@/components/ui/PageState'
import { Pagination } from '@/components/ui/Pagination'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { TechnicalId } from '@/components/ui/TechnicalId'
import { UnifiedSelect } from '@/components/ui/UnifiedSelect'
import { toast } from '@/components/ui/toast'
import { useAuth } from '@/lib/hooks/useAuth'
import { businessErrorMessage } from '@/lib/ui/business-error'

type ViewMode = 'grid' | 'list'
type SortMode = 'name' | 'status' | 'category'

function deviceListViewKey(params: {
  keyword: string
  category: string
  status: string
  gateway: string
  sort: SortMode
  page: number
  size: number
}) {
  return JSON.stringify({ ...params, keyword: params.keyword.trim() })
}

function initialDeviceListParam(key: string, fallback: string) {
  if (typeof window === 'undefined') return fallback
  return new URLSearchParams(window.location.search).get(key) || fallback
}

function initialPositiveInt(key: string, fallback: number, allowed?: number[]) {
  const parsed = Number(initialDeviceListParam(key, String(fallback)))
  if (!Number.isInteger(parsed) || parsed < 1) return fallback
  return allowed && !allowed.includes(parsed) ? fallback : parsed
}
type CandidateView = 'recommended' | 'hardware' | 'all'
type ControlInFlight = {
  deviceId: string
  entityId: string
  role: string
  action: string
  startedAt: number
}
type ControlInFlightMap = Record<string, ControlInFlight>
type DeviceConfirmation =
  | { kind: 'gateway-delete'; gateway: DeviceGateway }
  | { kind: 'demo-cleanup' }
type LegacyControlDraft = {
  device: LogicalDevice
  role: string
  entity: EntityState
  service: 'set_value' | 'select_option'
  value: string
  options: string[]
  minimum: number
  maximum: number
  step: number
  unit: string
}
// 页面必须先于 API 客户端释放控制态，避免网络异常让按钮长期占用。
const CONTROL_UI_TIMEOUT_MS = 12_000

function controlKey(entityId: string, action: string) {
  return `${entityId}:${action}`
}

const CATEGORY_LABELS: Record<string, string> = {
  all: '全部类型',
  light: '灯光',
  switch: '开关',
  sensor: '传感器',
  climate: '温控',
  lock: '门锁',
  binary_sensor: '门磁/安防',
}

const STATUS_LABELS: Record<string, string> = {
  all: '全部状态',
  online: '在线',
  offline: '离线',
  unmapped: '未映射',
  disabled: '未启用',
}

const GATEWAY_LABELS: Record<string, string> = {
  homeassistant: 'Home Assistant',
  mqtt: 'MQTT',
  modbus: 'Modbus',
  http: 'HTTP',
  xiaomi: '小米/米家',
}

const CANDIDATE_PLATFORM_LABELS: Record<string, string> = {
  xiaomi_home: '小米 Home 集成',
  homeassistant: 'Home Assistant',
  mqtt: 'MQTT',
  matter: 'Matter',
  zigbee: 'Zigbee',
}

const ROLE_LABELS: Record<string, string> = {
  power: '运行状态',
  lock: '门锁状态',
  temperature: '温度',
  door: '门磁状态',
  pm25: 'PM2.5',
  brightness: '亮度',
  humidity: '湿度',
  mode: '运行模式',
  value: '数值',
}

const SUMMARY_METAS = [
  { key: 'total', label: '设备总数', icon: Layers, color: 'text-slate-900' },
  { key: 'online', label: '在线设备', icon: CheckCircle2, color: 'text-emerald-700' },
  { key: 'offline', label: '离线/待联调', icon: AlertTriangle, color: 'text-amber-700' },
  { key: 'scene_count', label: '场景预设', icon: Sparkles, color: 'text-blue-700' },
] as const

const DEVICE_FIELD_CLASS = 'w-full rounded-[8px] border border-slate-200 bg-white px-3 py-2.5 text-sm font-medium text-slate-700 outline-none transition placeholder:text-slate-400 focus:border-blue-300 focus:ring-2 focus:ring-blue-100'
const CHECKBOX_CLASS = 'h-4 w-4 shrink-0 rounded-[4px] border border-slate-300 accent-blue-600 outline-none focus-visible:ring-2 focus-visible:ring-blue-200 disabled:cursor-not-allowed disabled:opacity-50'

const emptyGateway: DeviceGatewayPayload = {
  name: '',
  gateway_type: 'homeassistant',
  base_url: '',
  port: null,
  auth_type: 'bearer',
  credential: '',
  enabled: true,
  description: '',
}

const emptyMapping: DeviceMapping = {
  role: 'power',
  endpoint: '',
  gateway_type: 'homeassistant',
  access_mode: 'rw',
  unit: '',
  value_path: '',
  control_actions: ['turn_on', 'turn_off', 'toggle'],
  metadata: {},
}

const emptyDevice: DevicePayload = {
  name: '',
  category: 'switch',
  brand: '',
  model: '',
  location: '',
  protocol: 'homeassistant',
  gateway_id: null,
  description: '',
  local_control: false,
  enabled: true,
  capability_tags: [],
  mappings: [{ ...emptyMapping }],
}

function candidateRole(candidate: GatewaySyncCandidate) {
  if (candidate.domain === 'sensor') {
    if (candidate.unit.includes('°')) return 'temperature'
    if (candidate.unit.includes('%')) return 'humidity'
    return 'value'
  }
  if (candidate.domain === 'binary_sensor') return 'door'
  if (candidate.domain === 'input_number' || candidate.domain === 'number') return 'value'
  if (candidate.domain === 'input_select' || candidate.domain === 'select') return 'mode'
  if (candidate.domain === 'lock') return 'lock'
  return 'power'
}

function candidateCategory(candidate: GatewaySyncCandidate) {
  if (candidate.domain === 'light') return 'light'
  if (candidate.domain === 'climate') return 'climate'
  if (candidate.domain === 'lock') return 'lock'
  if (candidate.domain === 'sensor') return 'sensor'
  if (candidate.domain === 'binary_sensor') return 'binary_sensor'
  return 'switch'
}

function candidateActions(candidate: GatewaySyncCandidate) {
  if (candidate.control_actions) return candidate.control_actions
  if (['sensor', 'binary_sensor'].includes(candidate.domain)) return []
  if (candidate.domain === 'lock') return ['lock', 'unlock']
  if (candidate.domain === 'input_number' || candidate.domain === 'number') return ['set_value']
  if (candidate.domain === 'input_select' || candidate.domain === 'select') return ['select_option']
  return ['turn_on', 'turn_off', 'toggle']
}

function candidateMapping(candidate: GatewaySyncCandidate): DeviceMapping {
  return {
    ...emptyMapping,
    role: candidateRole(candidate),
    endpoint: candidate.entity_id,
    gateway_type: 'homeassistant',
    access_mode: candidateActions(candidate).length ? 'rw' : 'ro',
    unit: candidate.unit || '',
    control_actions: candidateActions(candidate),
    metadata: {
      ha_device_id: candidate.ha_device_id || '',
      platform: candidate.platform || '',
      area_id: candidate.area_id || '',
      entity_category: candidate.entity_category || '',
      device_class: candidate.device_class || '',
      ...(candidate.capability_metadata || {}),
    },
  }
}

function candidateDomainLabel(candidate: GatewaySyncCandidate) {
  const labels: Record<string, string> = {
    light: '灯光控制',
    switch: '开关控制',
    sensor: '传感数据',
    binary_sensor: '状态感知',
    climate: '温控设备',
    lock: '门锁控制',
    number: '数值设置',
    input_number: '数值设置',
    select: '模式选择',
    input_select: '模式选择',
  }
  return labels[candidate.domain] || '其他能力'
}

function candidateStateLabel(candidate: GatewaySyncCandidate) {
  const labels: Record<string, string> = {
    on: '开启',
    off: '关闭',
    unavailable: '不可用',
    unknown: '未知',
  }
  const state = String(candidate.state || '').trim()
  if (labels[state]) return labels[state]
  if (/^-?\d+(?:\.\d+)?$/.test(state)) return `${state}${candidate.unit || ''}`
  return state ? '状态待确认' : '未取得'
}

function candidatePlatformLabel(platform?: string) {
  if (!platform) return '接入来源未取得'
  return CANDIDATE_PLATFORM_LABELS[platform] || '其他 Home Assistant 集成'
}

function formatTime(value?: string | null) {
  if (!value || ['unknown', 'unavailable', 'none'].includes(value.toLowerCase())) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function entityOnline(entity: EntityState) {
  return !['unknown', 'unavailable', 'pending'].includes(entity.state)
}

function primaryEntry(device: LogicalDevice): [string, EntityState] | null {
  const preferred = ['power', 'lock', 'temperature', 'door', 'pm25']
  for (const role of preferred) {
    if (device.entities[role]) return [role, device.entities[role]]
  }
  return Object.entries(device.entities)[0] || null
}

function formatEntityRole(role?: string) {
  return role ? ROLE_LABELS[role] || '设备状态' : '状态项'
}

function formatEntityState(entity?: EntityState | null) {
  if (!entity) return '—'
  const stateLabels: Record<string, string> = {
    on: '开启',
    off: '关闭',
    unavailable: '不可用',
    unknown: '未知',
    pending: '待联调',
  }
  if (stateLabels[entity.state]) return `${stateLabels[entity.state]}${entity.unit || ''}`
  if (/^-?\d+(?:\.\d+)?$/.test(String(entity.state).trim())) return `${entity.state}${entity.unit || ''}`
  return '状态待确认'
}

function categoryLabel(category?: string) {
  return category ? CATEGORY_LABELS[category] || '其他设备' : '未分类'
}

function deviceStatusLabel(status?: string) {
  return status ? STATUS_LABELS[status] || '状态待确认' : '状态待确认'
}

function gatewayTypeLabel(gatewayType?: string) {
  return gatewayType ? GATEWAY_LABELS[gatewayType] || '其他接入方式' : '未配置接入方式'
}

function useDebouncedValue<T>(value: T, delay = 300) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(timer)
  }, [delay, value])
  return debounced
}

function displayDeviceDescription(device: LogicalDevice) {
  const raw = device.description || `${device.brand || ''} ${device.model || ''}`.trim() || '未填写描述'
  return raw
    .replace(/（\s*[a-z_]+\.[^)）]+\s*）/gi, '')
    .replace(/\(\s*[a-z_]+\.[^)）]+\s*\)/gi, '')
    .replace(/，?\s*实体\s+[a-z_]+\.[^。；,，]+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim() || '未填写描述'
}

function statusBadgeClass(status: string) {
  if (status === 'online' || status === 'running') return 'bg-emerald-50 text-emerald-700 border-emerald-100'
  if (status === 'offline' || status === 'error') return 'bg-amber-50 text-amber-700 border-amber-100'
  if (status === 'disabled') return 'bg-slate-100 text-slate-500 border-slate-200'
  return 'bg-blue-50 text-blue-700 border-blue-100'
}

function actionLabel(action: string) {
  const labels: Record<string, string> = {
    turn_on: '打开',
    turn_off: '关闭',
    toggle: '切换',
    set_value: '设值',
    select_option: '选择',
    lock: '锁定',
    unlock: '解锁',
    open_cover: '打开',
    close_cover: '关闭',
    stop_cover: '停止',
    set_brightness: '设置亮度',
    set_color_temperature: '设置色温',
    set_position: '设置位置',
    set_temperature: '设置温度',
    set_hvac_mode: '选择模式',
    set_percentage: '设置风量',
    set_effect: '选择效果',
  }
  return labels[action] || '其他设备操作'
}

function isEntityControlBusy(controls: ControlInFlightMap, entityId: string) {
  return Object.values(controls).some((control) => control.entityId === entityId)
}

function currentEntityControl(controls: ControlInFlightMap, entityId: string) {
  return Object.values(controls).find((control) => control.entityId === entityId)
}

function ControlWaitStatus({ control, onCancel }: {
  control: ControlInFlight
  onCancel: () => void
}) {
  const [remainingSeconds, setRemainingSeconds] = useState(() => Math.max(0, Math.ceil((CONTROL_UI_TIMEOUT_MS - (Date.now() - control.startedAt)) / 1000)))

  useEffect(() => {
    const updateRemaining = () => {
      setRemainingSeconds(Math.max(0, Math.ceil((CONTROL_UI_TIMEOUT_MS - (Date.now() - control.startedAt)) / 1000)))
    }
    updateRemaining()
    const intervalId = window.setInterval(updateRemaining, 1_000)
    return () => window.clearInterval(intervalId)
  }, [control.startedAt])

  return (
    <div className="flex flex-col items-start gap-2 border-l-2 border-blue-500 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-800 sm:flex-row sm:items-center sm:justify-between sm:gap-3" role="status" aria-live="polite">
      <span className="flex min-w-0 items-start gap-2 leading-5">
        <Loader2 size={14} className="shrink-0 animate-spin" />
        <span className="min-w-0 break-words">
          正在{actionLabel(control.action)}，{remainingSeconds} 秒后自动恢复
          ；完成前不会重复提交其他控制
        </span>
      </span>
      <button type="button" onClick={onCancel} className="shrink-0 self-end rounded-[6px] border border-blue-200 bg-white px-2.5 py-1.5 font-bold text-blue-700 hover:bg-blue-100 sm:self-auto">取消等待</button>
    </div>
  )
}

function controlValue(value: unknown, fallback: DeviceCapability['current_value']) {
  return typeof value === 'string' || typeof value === 'number' || value === null ? value : fallback
}

function capabilityReadbackValue(capability: DeviceCapability, state: string, attributes: Record<string, unknown>): DeviceCapability['current_value'] {
  if (capability.action === 'set_brightness') {
    const brightness = Number(attributes.brightness)
    return Number.isFinite(brightness) ? Math.round(brightness * 100 / 255) : capability.current_value
  }
  if (capability.action === 'set_color_temperature') return controlValue(attributes.color_temp_kelvin, capability.current_value)
  if (capability.action === 'set_effect') return controlValue(attributes.effect, null)
  if (capability.action === 'set_position') return controlValue(attributes.current_position, capability.current_value)
  if (capability.action === 'set_temperature') return controlValue(attributes.temperature, capability.current_value)
  if (capability.action === 'set_percentage') return controlValue(attributes.percentage, capability.current_value)
  if (capability.action === 'set_hvac_mode') return controlValue(attributes.hvac_mode, state || capability.current_value)
  if (capability.action === 'select_option' || capability.action === 'set_value') return state ?? capability.current_value
  return capability.current_value
}

function isCurrentControl(
  controls: ControlInFlightMap,
  entityId: string,
  action: string,
) {
  return Boolean(controls[controlKey(entityId, action)])
}

function primaryActions(entity: EntityState, actions: string[]) {
  if (!actions.some((item) => item === 'turn_on' || item === 'turn_off')) {
    return actions
  }
  const nextPowerAction = entity.state === 'on' ? 'turn_off' : 'turn_on'
  const remaining = actions.filter((item) => !['turn_on', 'turn_off', 'toggle'].includes(item))
  return actions.includes(nextPowerAction) ? [nextPowerAction, ...remaining] : remaining
}

function visiblePrimaryActions(entity: EntityState, actions: string[]) {
  const primary = primaryActions(entity, actions)
  const hasExplicitPowerActions = primary.includes('turn_on') || primary.includes('turn_off')
  if (!hasExplicitPowerActions) return primary

  const expectedPowerAction = entity.state === 'on' ? 'turn_off' : 'turn_on'
  return primary.filter((action) => {
    if (action === 'toggle') return false
    if (action === 'turn_on' || action === 'turn_off') return action === expectedPowerAction
    return true
  })
}

function gatewayStatusLabel(status: string) {
  const labels: Record<string, string> = {
    running: '上次测试正常',
    online: '上次测试正常',
    offline: '上次测试失败',
    error: '上次测试失败',
    disabled: '已停用',
    unknown: '尚未测试',
  }
  return labels[status] || '尚未测试'
}

function displayLogTitle(log: Pick<OperationLogItem, 'title'>, parsed: ReturnType<typeof parseLogDetail>) {
  const raw = String(log.title || '').trim()
  if (!raw) return parsed.action
  return raw
    .replace(/\b(turn_on|turn_off|toggle|set_value|select_option|lock|unlock|open_cover|close_cover|stop_cover|set_brightness|set_color_temperature|set_position|set_temperature|set_hvac_mode|set_percentage|set_effect)\b/gi, (action) => actionLabel(action.toLowerCase()))
    .replace(/\s*[:：]\s*$/, '')
}

function parseLogDetail(detail?: string | null) {
  const text = String(detail || '')
  const fields: Record<string, string> = {}
  for (const match of text.matchAll(/(?:^|,\s*)([a-z_]+)=([^,]*)/g)) {
    fields[match[1]] = match[2].trim()
  }
  const action = fields.action || fields.service?.split('.').at(-1) || ''
  const resultLabels: Record<string, string> = {
    confirmed: '状态回读已确认',
    physical_pending: 'HA 已接受，待实机确认',
    success: '执行成功',
    pending: '等待状态回读',
    failed: '执行失败',
  }
  return {
    action: action ? actionLabel(action) : '设备操作',
    result: fields.result ? resultLabels[fields.result] || '结果待确认' : '',
    state: fields.new_state
      ? formatEntityState({ state: fields.new_state, unit: '', entity_id: '', attributes: {}, last_changed: null })
      : '',
    entityId: fields.entity || '',
    raw: text,
  }
}

function mappingToPayload(mapping: DeviceMapping): DeviceMapping {
  return {
    role: mapping.role,
    endpoint: mapping.endpoint,
    gateway_type: mapping.gateway_type || 'homeassistant',
    access_mode: mapping.access_mode || 'rw',
    unit: mapping.unit || '',
    value_path: mapping.value_path || '',
    control_actions: mapping.control_actions || [],
    metadata: mapping.metadata || {},
  }
}

function deviceToPayload(device: LogicalDevice): DevicePayload {
  return {
    name: device.name,
    category: device.category,
    brand: device.brand || '',
    model: device.model || '',
    location: device.location || '',
    protocol: device.protocol || device.gateway_type || 'homeassistant',
    gateway_id: device.gateway_id || null,
    description: device.description || '',
    local_control: Boolean(device.local_control),
    enabled: device.enabled !== false,
    capability_tags: device.capability_tags || [],
    mappings: (device.mappings || []).map(mappingToPayload),
  }
}

function DevicesContent() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { isAdmin, loading: authLoading } = useAuth()
  const [data, setData] = useState<DeviceListResponse | null>(null)
  const [dataLoaded, setDataLoaded] = useState(false)
  const [loadedDeviceViewKey, setLoadedDeviceViewKey] = useState('')
  const [loadedDevicePage, setLoadedDevicePage] = useState(1)
  const [loadedDevicePageSize, setLoadedDevicePageSize] = useState(10)
  const [deviceListError, setDeviceListError] = useState('')
  const [gateways, setGateways] = useState<DeviceGateway[]>([])
  const [gatewaysLoaded, setGatewaysLoaded] = useState(false)
  const [gatewaysLoading, setGatewaysLoading] = useState(true)
  const [gatewaysError, setGatewaysError] = useState('')
  const [logsResponse, setLogsResponse] = useState<OperationLogsResponse | null>(null)
  const [logsLoaded, setLogsLoaded] = useState(false)
  const [loadedLogsPage, setLoadedLogsPage] = useState(1)
  const [loadedLogsPageSize, setLoadedLogsPageSize] = useState(10)
  const [logsLoading, setLogsLoading] = useState(false)
  const [logsError, setLogsError] = useState('')
  const [logsPage, setLogsPage] = useState(1)
  const [logsPageSize, setLogsPageSize] = useState(10)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState(() => initialDeviceListParam('q', ''))
  const debouncedQuery = useDebouncedValue(query.trim())
  const [category, setCategory] = useState(() => initialDeviceListParam('category', 'all'))
  const [statusFilter, setStatusFilter] = useState(() => {
    const value = initialDeviceListParam('status', 'all')
    return Object.hasOwn(STATUS_LABELS, value) ? value : 'all'
  })
  const [gatewayFilter, setGatewayFilter] = useState(() => {
    const value = initialDeviceListParam('gateway', 'all')
    return value === 'all' || /^\d+$/.test(value) ? value : 'all'
  })
  const [sortMode, setSortMode] = useState<SortMode>(() => {
    const value = initialDeviceListParam('sort', 'name')
    return ['name', 'status', 'category'].includes(value) ? value as SortMode : 'name'
  })
  const [viewMode, setViewMode] = useState<ViewMode>(() => initialDeviceListParam('view', 'list') === 'grid' ? 'grid' : 'list')
  const [page, setPage] = useState(() => initialPositiveInt('page', 1))
  const [pageSize, setPageSize] = useState(() => initialPositiveInt('size', 10, [10, 20, 50]))
  const [selected, setSelected] = useState<LogicalDevice | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [detailRecoveryEligible, setDetailRecoveryEligible] = useState(false)
  const [showLogs, setShowLogs] = useState(false)
  const [showDeviceDialog, setShowDeviceDialog] = useState(false)
  const [editingDevice, setEditingDevice] = useState<LogicalDevice | null>(null)
  const [deviceForm, setDeviceForm] = useState<DevicePayload>(emptyDevice)
  const [showGateways, setShowGateways] = useState(false)
  const [editingGateway, setEditingGateway] = useState<DeviceGateway | null>(null)
  const [gatewayForm, setGatewayForm] = useState<DeviceGatewayPayload>(emptyGateway)
  const [deleteTarget, setDeleteTarget] = useState<LogicalDevice | null>(null)
  const [confirmation, setConfirmation] = useState<DeviceConfirmation | null>(null)
  const [legacyControlDraft, setLegacyControlDraft] = useState<LegacyControlDraft | null>(null)
  const [syncCandidates, setSyncCandidates] = useState<GatewaySyncCandidate[] | null>(null)
  const [syncGatewaySource, setSyncGatewaySource] = useState<DeviceGateway | null>(null)
  const [syncTargetDevices, setSyncTargetDevices] = useState<LogicalDevice[]>([])
  const [syncTargetTruncated, setSyncTargetTruncated] = useState(false)
  const [busy, setBusy] = useState('')
  const [controlInFlight, setControlInFlight] = useState<ControlInFlightMap>({})
  const [lastResult, setLastResult] = useState('')
  const [lastResultEntity, setLastResultEntity] = useState('')
  const [lastResultTone, setLastResultTone] = useState<'success' | 'warning' | 'error'>('success')
  const dataRequestRef = useRef(0)
  const gatewaysRequestRef = useRef(0)
  const logsRequestRef = useRef(0)
  const detailRequestRef = useRef(0)
  const controlInFlightRef = useRef(new Set<string>())
  const controlResultSequenceRef = useRef(new Map<string, number>())
  const controlTimeoutsRef = useRef(new Map<string, number>())
  const controlAbortControllersRef = useRef(new Map<string, AbortController>())
  const dataAbortRef = useRef<AbortController | null>(null)
  const gatewaysAbortRef = useRef<AbortController | null>(null)
  const logsAbortRef = useRef<AbortController | null>(null)
  const detailAbortRef = useRef<AbortController | null>(null)
  const busyRef = useRef('')
  const managementRequestRef = useRef(0)
  const managementAbortRef = useRef<AbortController | null>(null)
  const managementReconcileRef = useRef(0)
  const managementReconcileTimerRef = useRef<number | null>(null)
  const confirmationCancelRef = useRef<HTMLButtonElement | null>(null)
  const legacyControlInputRef = useRef<HTMLInputElement | null>(null)
  const writtenSearchRef = useRef(searchParams.toString())

  const currentDeviceViewKey = deviceListViewKey({ keyword: debouncedQuery, category, status: statusFilter, gateway: gatewayFilter, sort: sortMode, page, size: pageSize })
  const deviceSnapshotMatchesView = Boolean(dataLoaded && query.trim() === debouncedQuery && loadedDeviceViewKey === currentDeviceViewKey)
  const deviceSnapshotUsable = deviceSnapshotMatchesView && !loading && !deviceListError
  const gatewayManagementAllowed = gatewaysLoaded && !gatewaysLoading && !gatewaysError
  const deviceManagementAllowed = deviceSnapshotUsable && gatewayManagementAllowed
  const deviceControlAllowed = deviceSnapshotUsable && !data?.ha_error

  const beginBusy = (key: string) => {
    if (busyRef.current) {
      if (busyRef.current === key) {
        managementRequestRef.current += 1
        managementAbortRef.current?.abort()
        managementAbortRef.current = null
        busyRef.current = ''
        setBusy('')
        toast.warning('已取消等待；操作可能已经完成，正在重新读取设备和网关最终状态')
        reconcileManagementState()
        return null
      }
      toast.warning('当前操作尚未完成，请等待结束后再继续')
      return null
    }
    const controller = new AbortController()
    const requestId = ++managementRequestRef.current
    managementAbortRef.current = controller
    busyRef.current = key
    setBusy(key)
    return { controller, requestId }
  }

  const endBusy = (key: string, requestId: number, controller: AbortController) => {
    if (busyRef.current !== key || managementRequestRef.current !== requestId) return
    if (managementAbortRef.current === controller) managementAbortRef.current = null
    busyRef.current = ''
    setBusy('')
  }

  const managementResultUncertain = (error: unknown) => (
    error instanceof ApiError && error.status === 0
    || error instanceof Error && /超时|网络中断|无法连接|network|timeout/i.test(error.message)
  )

  const reconcileManagementState = () => {
    const reconcileId = ++managementReconcileRef.current
    if (managementReconcileTimerRef.current !== null) window.clearTimeout(managementReconcileTimerRef.current)
    const readFinalState = () => Promise.allSettled([
      loadData(true),
      loadGateways(true),
      showLogs ? loadLogs(true) : Promise.resolve(),
    ])
    void readFinalState().finally(() => {
      if (managementReconcileRef.current !== reconcileId) return
      managementReconcileTimerRef.current = window.setTimeout(() => {
        if (managementReconcileRef.current !== reconcileId) return
        managementReconcileTimerRef.current = null
        void readFinalState()
      }, 1200)
    })
  }

  const loadGateways = useCallback(async (force = false) => {
    gatewaysAbortRef.current?.abort()
    const controller = new AbortController()
    gatewaysAbortRef.current = controller
    const requestId = ++gatewaysRequestRef.current
    setGatewaysLoading(true)
    setGatewaysError('')
    try {
      const result = await fetchGateways(force, controller.signal)
      if (gatewaysRequestRef.current === requestId) {
        setGateways(result.gateways || [])
        setGatewaysLoaded(true)
      }
    } catch (err) {
      if (!controller.signal.aborted && gatewaysRequestRef.current === requestId) {
        setGatewaysError(businessErrorMessage(err, { fallback: '网关列表加载失败', service: '设备网关' }))
      }
    } finally {
      if (gatewaysAbortRef.current === controller) gatewaysAbortRef.current = null
      if (gatewaysRequestRef.current === requestId) setGatewaysLoading(false)
    }
  }, [])

  const loadLogs = useCallback(async (force = false) => {
    logsAbortRef.current?.abort()
    const controller = new AbortController()
    logsAbortRef.current = controller
    const requestId = ++logsRequestRef.current
    setLogsLoading(true)
    setLogsError('')
    try {
      const result = await fetchOperationLogList({ page: logsPage, size: logsPageSize, type: 'device_control' }, force, controller.signal)
      if (logsRequestRef.current === requestId) {
        setLogsResponse(result)
        setLogsLoaded(true)
        setLoadedLogsPage(result.page || logsPage)
        setLoadedLogsPageSize(result.size || logsPageSize)
        if (result.page && result.page !== logsPage) setLogsPage(result.page)
      }
    } catch (err) {
      if (!controller.signal.aborted && logsRequestRef.current === requestId) {
        setLogsError(businessErrorMessage(err, { fallback: '设备操作日志加载失败', service: '设备日志' }))
      }
    } finally {
      if (logsAbortRef.current === controller) logsAbortRef.current = null
      if (logsRequestRef.current === requestId) setLogsLoading(false)
    }
  }, [logsPage, logsPageSize])

  const loadData = useCallback(async (force = false) => {
    dataAbortRef.current?.abort()
    const controller = new AbortController()
    dataAbortRef.current = controller
    const requestId = ++dataRequestRef.current
    setLoading(true)
    setError('')
    let loadedDevices: DeviceListResponse | null = null
    const devicesRequest = fetchDevices({
          page,
          size: pageSize,
          keyword: debouncedQuery,
          category: category === 'all' ? '' : category,
          status: statusFilter === 'all' ? '' : statusFilter,
          gatewayId: gatewayFilter === 'all' ? undefined : Number(gatewayFilter),
          sort: sortMode,
          refresh: force,
          signal: controller.signal,
        })
      .then((deviceRes) => {
        if (dataRequestRef.current !== requestId) return
        loadedDevices = deviceRes
        setData(deviceRes)
        setDataLoaded(true)
        setDeviceListError('')
        setLoadedDeviceViewKey(deviceListViewKey({ keyword: debouncedQuery, category, status: statusFilter, gateway: gatewayFilter, sort: sortMode, page: deviceRes.page, size: deviceRes.size }))
        setLoadedDevicePage(deviceRes.page)
        setLoadedDevicePageSize(deviceRes.size)
        if (deviceRes.page !== page) setPage(deviceRes.page)
        if (deviceRes.ha_error) setError(deviceRes.ha_error)
      })
      .catch((err) => {
        if (!controller.signal.aborted && dataRequestRef.current === requestId) {
          const message = businessErrorMessage(err, { fallback: '设备台账加载失败', service: '设备台账' })
          setDeviceListError(message)
          setError(message)
        }
      })
    await Promise.allSettled([devicesRequest])
    if (dataAbortRef.current === controller) dataAbortRef.current = null
    if (dataRequestRef.current === requestId) setLoading(false)
    return loadedDevices
  }, [category, debouncedQuery, gatewayFilter, page, pageSize, sortMode, statusFilter])

  useEffect(() => {
    void loadData()
  }, [loadData])

  useEffect(() => {
    void loadGateways()
  }, [loadGateways])

  useEffect(() => {
    if (showLogs) void loadLogs()
  }, [loadLogs, showLogs])

  useEffect(() => {
    const releaseExpiredControls = () => {
      const now = Date.now()
      const expired = Object.entries(controlInFlight)
        .filter(([, control]) => now - control.startedAt >= CONTROL_UI_TIMEOUT_MS)
      if (!expired.length) return

      const expiredKeys = new Set(expired.map(([requestKey]) => requestKey))
      expired.forEach(([requestKey, control]) => {
        controlResultSequenceRef.current.set(
          control.entityId,
          (controlResultSequenceRef.current.get(control.entityId) || 0) + 1,
        )
        controlAbortControllersRef.current.get(control.entityId)?.abort()
        controlAbortControllersRef.current.delete(control.entityId)
        const timeoutId = controlTimeoutsRef.current.get(requestKey)
        if (timeoutId !== undefined) window.clearTimeout(timeoutId)
        controlTimeoutsRef.current.delete(requestKey)
        controlInFlightRef.current.delete(requestKey)
      })
      setControlInFlight((current) => {
        const entries = Object.entries(current).filter(([requestKey]) => !expiredKeys.has(requestKey))
        return Object.fromEntries(entries)
      })
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') releaseExpiredControls()
    }
    window.addEventListener('focus', releaseExpiredControls)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('focus', releaseExpiredControls)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [controlInFlight])

  useEffect(() => () => {
    dataRequestRef.current += 1
    gatewaysRequestRef.current += 1
    logsRequestRef.current += 1
    detailRequestRef.current += 1
    managementRequestRef.current += 1
    managementReconcileRef.current += 1
    dataAbortRef.current?.abort()
    gatewaysAbortRef.current?.abort()
    logsAbortRef.current?.abort()
    detailAbortRef.current?.abort()
    managementAbortRef.current?.abort()
    managementAbortRef.current = null
    if (managementReconcileTimerRef.current !== null) window.clearTimeout(managementReconcileTimerRef.current)
    managementReconcileTimerRef.current = null
    controlTimeoutsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId))
    controlTimeoutsRef.current.clear()
    controlAbortControllersRef.current.forEach((controller) => controller.abort())
    controlAbortControllersRef.current.clear()
    controlInFlightRef.current.clear()
    busyRef.current = ''
  }, [])

  const categories = useMemo(() => {
    const keys = Object.keys(data?.summary.categories || {})
    return ['all', ...keys]
  }, [data?.summary.categories])

  const filteredDevices = data?.devices || []

  useEffect(() => {
    if (pathname !== '/devices') return
    const url = new URL(window.location.href)
    const values: Record<string, string> = {
      q: query.trim(),
      category: category === 'all' ? '' : category,
      status: statusFilter === 'all' ? '' : statusFilter,
      gateway: gatewayFilter === 'all' ? '' : gatewayFilter,
      sort: sortMode === 'name' ? '' : sortMode,
      view: viewMode === 'list' ? '' : viewMode,
      page: page === 1 ? '' : String(page),
      size: pageSize === 10 ? '' : String(pageSize),
    }
    Object.entries(values).forEach(([key, value]) => {
      if (value) url.searchParams.set(key, value)
      else url.searchParams.delete(key)
    })
    const nextSearch = url.searchParams.toString()
    writtenSearchRef.current = nextSearch
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }, [category, gatewayFilter, page, pageSize, pathname, query, sortMode, statusFilter, viewMode])

  useEffect(() => {
    if (pathname !== '/devices') return
    const nextSearch = searchParams.toString()
    if (nextSearch === writtenSearchRef.current) return
    writtenSearchRef.current = nextSearch
    const nextQuery = searchParams.get('q') || ''
    const nextCategory = searchParams.get('category') || 'all'
    const rawStatus = searchParams.get('status') || 'all'
    const nextStatus = Object.hasOwn(STATUS_LABELS, rawStatus) ? rawStatus : 'all'
    const rawGateway = searchParams.get('gateway') || 'all'
    const nextGateway = rawGateway === 'all' || /^\d+$/.test(rawGateway) ? rawGateway : 'all'
    const rawSort = searchParams.get('sort') || 'name'
    const nextSort = ['name', 'status', 'category'].includes(rawSort) ? rawSort as SortMode : 'name'
    const nextView: ViewMode = searchParams.get('view') === 'grid' ? 'grid' : 'list'
    const rawPage = Number(searchParams.get('page') || 1)
    const nextPage = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1
    const rawSize = Number(searchParams.get('size') || 10)
    const nextSize = [10, 20, 50].includes(rawSize) ? rawSize : 10
    setQuery(nextQuery)
    setCategory(nextCategory)
    setStatusFilter(nextStatus)
    setGatewayFilter(nextGateway)
    setSortMode(nextSort)
    setViewMode(nextView)
    setPage(nextPage)
    setPageSize(nextSize)
  }, [pathname, searchParams])

  const openCreateDevice = () => {
    if (!isAdmin) {
      toast.error('仅管理员可新增设备台账')
      return
    }
    if (!deviceManagementAllowed) {
      toast.warning('设备台账当前不可写，请等待列表刷新成功后再添加设备')
      return
    }
    setEditingDevice(null)
    setDeviceForm({
      ...emptyDevice,
      gateway_id: gateways[0]?.id || null,
      mappings: [{ ...emptyMapping, gateway_type: gateways[0]?.gateway_type || 'homeassistant' }],
    })
    setShowDeviceDialog(true)
  }

  const openEditDevice = (device: LogicalDevice) => {
    if (!isAdmin) {
      toast.error('仅管理员可修改设备台账')
      return
    }
    if (!deviceManagementAllowed) {
      toast.warning('设备台账当前不可写，请等待列表刷新成功后再编辑')
      return
    }
    setEditingDevice(device)
    const payload = deviceToPayload(device)
    setDeviceForm({
      ...payload,
      mappings: payload.mappings.length ? payload.mappings : [{ ...emptyMapping, gateway_type: device.gateway_type || 'homeassistant' }],
    })
    setShowDeviceDialog(true)
  }

  const openDetail = useCallback(async (device: LogicalDevice) => {
    if (!deviceSnapshotMatchesView) {
      toast.warning('当前设备快照不属于正在查看的筛选条件，请等待列表更新后再查看详情')
      return
    }
    detailAbortRef.current?.abort()
    const controller = new AbortController()
    detailAbortRef.current = controller
    const requestId = ++detailRequestRef.current
    setSelected(device)
    setDetailLoading(true)
    setDetailError('')
    setDetailRecoveryEligible(false)
    try {
      const detail = await fetchDevice(device.id, false, controller.signal)
      if (detailRequestRef.current === requestId) setSelected(detail)
    } catch (error) {
      if (!controller.signal.aborted && detailRequestRef.current === requestId) {
        setDetailError(businessErrorMessage(error, { fallback: '设备详情读取失败', service: '设备详情' }))
        setDetailRecoveryEligible(true)
      }
    } finally {
      if (detailAbortRef.current === controller) detailAbortRef.current = null
      if (detailRequestRef.current === requestId) setDetailLoading(false)
    }
  }, [deviceSnapshotMatchesView])

  const cancelDetailWait = () => {
    if (!detailLoading) return
    detailRequestRef.current += 1
    detailAbortRef.current?.abort()
    detailAbortRef.current = null
    setDetailLoading(false)
    setDetailRecoveryEligible(false)
    setDetailError('已取消详情读取；当前显示设备列表快照。')
  }

  useEffect(() => {
    const recoverDeviceList = Boolean(deviceListError)
    const recoverGateways = Boolean(gatewaysError)
    const recoverLogs = Boolean(showLogs && logsError)
    const recoverDetail = Boolean(selected && detailError && detailRecoveryEligible)
    if (!recoverDeviceList && !recoverGateways && !recoverLogs && !recoverDetail) return

    const recoverFailedReads = () => {
      if (!navigator.onLine || document.visibilityState !== 'visible') return
      if (recoverDeviceList && !dataAbortRef.current) void loadData(true)
      if (recoverGateways && !gatewaysAbortRef.current) void loadGateways(true)
      if (recoverLogs && !logsAbortRef.current) void loadLogs(true)
      if (recoverDetail && selected && !detailAbortRef.current) void openDetail(selected)
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') recoverFailedReads()
    }

    window.addEventListener('online', recoverFailedReads)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('online', recoverFailedReads)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [detailError, detailRecoveryEligible, deviceListError, gatewaysError, loadData, loadGateways, loadLogs, logsError, openDetail, selected, showLogs])

  const submitDevice = async () => {
    if (!isAdmin) {
      toast.error('仅管理员可保存设备台账')
      return
    }
    if (!deviceForm.name.trim()) {
      toast.error('设备名称不能为空')
      return
    }
    const payload = {
      ...deviceForm,
      capability_tags: deviceForm.capability_tags.filter(Boolean),
      mappings: deviceForm.mappings
        .filter((mapping) => mapping.role.trim() && mapping.endpoint.trim())
        .map(mappingToPayload),
    }
    const operationKey = 'device-save'
    const operation = beginBusy(operationKey)
    if (!operation) return
    const { controller, requestId } = operation
    try {
      if (editingDevice) {
        await updateDevice(editingDevice.id, payload, controller.signal)
        if (managementRequestRef.current !== requestId) return
        toast.success('设备信息已更新')
      } else {
        await createDevice(payload, controller.signal)
        if (managementRequestRef.current !== requestId) return
        toast.success('设备已添加')
      }
      setShowDeviceDialog(false)
      await Promise.allSettled([loadData(), loadGateways()])
    } catch (err) {
      if (controller.signal.aborted || managementRequestRef.current !== requestId) return
      if (managementResultUncertain(err)) {
        toast.warning('保存请求结果未确认，设备台账可能已经更新；正在重新读取最终状态')
        reconcileManagementState()
        return
      }
      toast.error(businessErrorMessage(err, { fallback: '设备保存失败', service: '设备台账' }))
    } finally {
      endBusy(operationKey, requestId, controller)
    }
  }

  const submitGateway = async () => {
    if (!isAdmin) {
      toast.error('仅管理员可保存网关配置')
      return
    }
    if (!gatewayForm.name.trim()) {
      toast.error('网关名称不能为空')
      return
    }
    if (!gatewayManagementAllowed) {
      toast.warning('网关目录当前不可操作，请等待读取成功后再保存')
      return
    }
    const operationKey = 'gateway-save'
    const operation = beginBusy(operationKey)
    if (!operation) return
    const { controller, requestId } = operation
    try {
      if (editingGateway) {
        await updateGateway(editingGateway.id, gatewayForm, controller.signal)
        if (managementRequestRef.current !== requestId) return
        toast.success('网关配置已更新')
      } else {
        await createGateway(gatewayForm, controller.signal)
        if (managementRequestRef.current !== requestId) return
        toast.success('网关已添加')
      }
      setEditingGateway(null)
      setGatewayForm(emptyGateway)
      await Promise.allSettled([loadData(), loadGateways()])
    } catch (err) {
      if (controller.signal.aborted || managementRequestRef.current !== requestId) return
      if (managementResultUncertain(err)) {
        toast.warning('保存请求结果未确认，网关配置可能已经更新；正在重新读取最终状态')
        reconcileManagementState()
        return
      }
      toast.error(businessErrorMessage(err, { fallback: '网关保存失败', service: '设备网关' }))
    } finally {
      endBusy(operationKey, requestId, controller)
    }
  }

  const runGatewayTest = async (gateway: DeviceGateway) => {
    if (!isAdmin) {
      toast.error('仅管理员可测试网关连接')
      return
    }
    if (!gatewayManagementAllowed) {
      toast.warning('网关目录当前不可操作，请等待读取成功后再测试')
      return
    }
    const operationKey = `gateway-test-${gateway.id}`
    const operation = beginBusy(operationKey)
    if (!operation) return
    const { controller, requestId } = operation
    try {
      const result = await testGateway(gateway.id, controller.signal)
      if (managementRequestRef.current !== requestId) return
      toast[result.status === 'running' ? 'success' : 'warning'](result.message)
      await Promise.allSettled([loadData(), loadGateways()])
    } catch (err) {
      if (controller.signal.aborted || managementRequestRef.current !== requestId) return
      toast.error(businessErrorMessage(err, { fallback: '网关测试失败', service: '设备网关' }))
    } finally {
      endBusy(operationKey, requestId, controller)
    }
  }

  const runGatewaySync = async (gateway: DeviceGateway) => {
    if (!isAdmin) {
      toast.error('仅管理员可同步网关实体')
      return
    }
    if (!gatewayManagementAllowed) {
      toast.warning('网关目录当前不可操作，请等待读取成功后再同步')
      return
    }
    const operationKey = `gateway-sync-${gateway.id}`
    const operation = beginBusy(operationKey)
    if (!operation) return
    const { controller, requestId } = operation
    try {
      const result = await syncGateway(gateway.id, controller.signal)
      if (managementRequestRef.current !== requestId) return
      const candidates = result.candidates || []
      const targetPage = await fetchDevices({ page: 1, size: 100, sort: 'name', refresh: true, signal: controller.signal })
      if (managementRequestRef.current !== requestId) return
      setSyncGatewaySource(gateway)
      setSyncCandidates(candidates)
      setSyncTargetDevices(targetPage.devices || [])
      setSyncTargetTruncated(targetPage.total > targetPage.devices.length)
      toast[result.status === 'running' ? 'success' : 'warning'](result.message)
      await Promise.allSettled([loadData(), loadGateways()])
    } catch (err) {
      if (controller.signal.aborted || managementRequestRef.current !== requestId) return
      toast.error(businessErrorMessage(err, { fallback: '网关同步失败', service: '设备网关' }))
    } finally {
      endBusy(operationKey, requestId, controller)
    }
  }

  const runGatewayImport = async (entityIds: string[]) => {
    if (!isAdmin) {
      toast.error('仅管理员可导入网关实体')
      return
    }
    if (!gatewayManagementAllowed) {
      toast.warning('网关目录当前不可操作，请等待读取成功后再导入')
      return
    }
    if (!syncGatewaySource || !entityIds.length) return
    const operationKey = `gateway-import-${syncGatewaySource.id}`
    const operation = beginBusy(operationKey)
    if (!operation) return
    const { controller, requestId } = operation
    try {
      const result = await importGatewayEntities(syncGatewaySource.id, entityIds, controller.signal)
      if (managementRequestRef.current !== requestId) return
      toast.success(result.message)
      setSyncCandidates(null)
      await Promise.allSettled([loadData(), loadGateways()])
    } catch (err) {
      if (controller.signal.aborted || managementRequestRef.current !== requestId) return
      if (managementResultUncertain(err)) {
        toast.warning('导入请求结果未确认，实体可能已经写入台账；正在重新读取最终状态')
        reconcileManagementState()
        return
      }
      toast.error(businessErrorMessage(err, { fallback: 'HA 实体导入失败', service: 'Home Assistant' }))
    } finally {
      endBusy(operationKey, requestId, controller)
    }
  }

  const executeGatewayDelete = async (gateway: DeviceGateway) => {
    if (!isAdmin) {
      toast.error('仅管理员可删除网关')
      return
    }
    if (!gatewayManagementAllowed) {
      toast.warning('网关目录当前不可操作，请等待读取成功后再删除')
      return
    }
    const operationKey = `gateway-delete-${gateway.id}`
    const operation = beginBusy(operationKey)
    if (!operation) return
    const { controller, requestId } = operation
    try {
      await deleteGateway(gateway.id, controller.signal)
      if (managementRequestRef.current !== requestId) return
      setConfirmation(null)
      toast.success('网关已删除')
      await Promise.allSettled([loadData(), loadGateways()])
    } catch (err) {
      if (controller.signal.aborted || managementRequestRef.current !== requestId) return
      if (managementResultUncertain(err)) {
        setConfirmation(null)
        toast.warning('删除请求结果未确认，网关可能已经删除；正在重新读取最终状态')
        reconcileManagementState()
        return
      }
      toast.error(businessErrorMessage(err, { fallback: '网关删除失败', service: '设备网关' }))
    } finally {
      endBusy(operationKey, requestId, controller)
    }
  }

  const runGatewayDelete = (gateway: DeviceGateway) => {
    if (!isAdmin) {
      toast.error('仅管理员可删除网关')
      return
    }
    if (!gatewayManagementAllowed) {
      toast.warning('网关目录当前不可操作，请等待读取成功后再删除')
      return
    }
    const operationKey = `gateway-delete-${gateway.id}`
    if (busyRef.current === operationKey) {
      beginBusy(operationKey)
      setConfirmation(null)
      return
    }
    if (busyRef.current) {
      toast.warning('当前操作尚未完成，请等待结束后再继续')
      return
    }
    setConfirmation({ kind: 'gateway-delete', gateway })
  }

  const executeDemoCleanup = async () => {
    if (!isAdmin) {
      toast.error('仅管理员可清理演示设备台账')
      return
    }
    const operationKey = 'demo-cleanup'
    const operation = beginBusy(operationKey)
    if (!operation) return
    const { controller, requestId } = operation
    try {
      const result = await cleanupDemoDevices(controller.signal)
      if (managementRequestRef.current !== requestId) return
      setConfirmation(null)
      toast.success(result.message)
      await loadData()
    } catch (err) {
      if (controller.signal.aborted || managementRequestRef.current !== requestId) return
      if (managementResultUncertain(err)) {
        setConfirmation(null)
        toast.warning('清理请求结果未确认，演示台账可能已经删除；正在重新读取最终状态')
        reconcileManagementState()
        return
      }
      toast.error(businessErrorMessage(err, { fallback: '演示设备清理失败', service: '设备台账' }))
    } finally {
      endBusy(operationKey, requestId, controller)
    }
  }

  const runDemoCleanup = () => {
    if (!isAdmin) {
      toast.error('仅管理员可清理演示设备台账')
      return
    }
    if (busyRef.current === 'demo-cleanup') {
      beginBusy('demo-cleanup')
      setConfirmation(null)
      return
    }
    if (busyRef.current) {
      toast.warning('当前操作尚未完成，请等待结束后再继续')
      return
    }
    setConfirmation({ kind: 'demo-cleanup' })
  }

  const runControl = async (
    device: LogicalDevice,
    role: string,
    entity: EntityState,
    service: string,
    controlData?: Record<string, unknown>,
  ) => {
    if (!deviceControlAllowed) {
      toast.warning(data?.ha_error ? 'Home Assistant 当前不可用，请恢复连接并刷新状态后再控制设备' : '设备台账当前不可操作，请等待列表刷新成功后再控制设备')
      return
    }
    const payload = controlData
    if (service === 'set_value' && !payload) {
      const attributes = entity.attributes || {}
      const parsedMinimum = Number(attributes.min ?? 0)
      const parsedMaximum = Number(attributes.max ?? 100)
      const parsedStep = Number(attributes.step ?? 1)
      const minimum = Number.isFinite(parsedMinimum) ? parsedMinimum : 0
      const maximum = Number.isFinite(parsedMaximum) && parsedMaximum >= minimum ? parsedMaximum : Math.max(100, minimum)
      setLegacyControlDraft({
        device,
        role,
        entity,
        service,
        value: ['unknown', 'unavailable'].includes(entity.state) ? '' : entity.state,
        options: [],
        minimum,
        maximum,
        step: Number.isFinite(parsedStep) && parsedStep > 0 ? parsedStep : 1,
        unit: String(attributes.unit_of_measurement || entity.unit || ''),
      })
      return
    }
    if (service === 'select_option' && !payload) {
      const options = Array.isArray(entity.attributes?.options) ? entity.attributes.options as string[] : []
      setLegacyControlDraft({
        device,
        role,
        entity,
        service,
        value: options.includes(entity.state) ? entity.state : '',
        options,
        minimum: 0,
        maximum: 0,
        step: 1,
        unit: '',
      })
      return
    }
    const entityKey = entity.entity_id
    const requestKey = controlKey(entityKey, service)
    const activeEntityRequests = Array.from(controlInFlightRef.current)
      .filter((key) => key.startsWith(`${entityKey}:`))
    if (activeEntityRequests.length) {
      // 快速切换时以最后一次操作为准。中止前端等待不会撤回已经送达 HA 的命令，
      // 但代次隔离会阻止旧响应覆盖最新状态。
      controlResultSequenceRef.current.set(entityKey, (controlResultSequenceRef.current.get(entityKey) || 0) + 1)
      controlAbortControllersRef.current.get(entityKey)?.abort()
      controlAbortControllersRef.current.delete(entityKey)
      activeEntityRequests.forEach((activeRequestKey) => {
        const timeoutId = controlTimeoutsRef.current.get(activeRequestKey)
        if (timeoutId !== undefined) window.clearTimeout(timeoutId)
        controlTimeoutsRef.current.delete(activeRequestKey)
        controlInFlightRef.current.delete(activeRequestKey)
      })
      setControlInFlight((current) => Object.fromEntries(
        Object.entries(current).filter(([, control]) => control.entityId !== entityKey),
      ))
    }
    const resultSequence = (controlResultSequenceRef.current.get(entityKey) || 0) + 1
    controlResultSequenceRef.current.set(entityKey, resultSequence)
    const controller = new AbortController()
    controlAbortControllersRef.current.set(entityKey, controller)
    controlInFlightRef.current.add(requestKey)
    setControlInFlight((current) => ({
      ...current,
      [requestKey]: { deviceId: String(device.id), entityId: entityKey, role, action: service, startedAt: Date.now() },
    }))
    const releaseControl = (force = false) => {
      if (!force && controlResultSequenceRef.current.get(entityKey) !== resultSequence) return
      const timeoutId = controlTimeoutsRef.current.get(requestKey)
      if (timeoutId !== undefined) window.clearTimeout(timeoutId)
      controlTimeoutsRef.current.delete(requestKey)
      if (controlAbortControllersRef.current.get(entityKey) === controller) {
        controlAbortControllersRef.current.delete(entityKey)
      }
      controlInFlightRef.current.delete(requestKey)
      setControlInFlight((current) => {
        if (!current[requestKey]) return current
        const next = { ...current }
        delete next[requestKey]
        return next
      })
    }
    controlTimeoutsRef.current.set(requestKey, window.setTimeout(() => {
      if (controlResultSequenceRef.current.get(entityKey) === resultSequence) {
        controlResultSequenceRef.current.set(entityKey, resultSequence + 1)
      }
      controller.abort()
      releaseControl(true)
      setLastResult(`${device.name}${actionLabel(service)}等待超时，请刷新设备状态后再试。`)
      setLastResultEntity(entity.entity_id)
      setLastResultTone('error')
      toast.error('控制等待超时，按钮已恢复；请刷新状态后再试')
    }, CONTROL_UI_TIMEOUT_MS))
    try {
      const result = await controlDevice(device.id, service, undefined, payload, role, controller.signal)
      if (controlResultSequenceRef.current.get(entityKey) !== resultSequence) return
      const stateLabel = formatEntityState({ state: result.new_state || 'pending', unit: '', entity_id: '', attributes: {}, last_changed: null })
      const pendingPhysicalCheck = result.confirmation === 'physical_pending'
      setLastResult(pendingPhysicalCheck
        ? `${device.name}控制命令已下发，Home Assistant 回读状态为“${stateLabel}”；小米设备仍需现场确认实际状态。`
        : `${device.name}已${actionLabel(service)}，Home Assistant 回读状态为“${stateLabel}”。`)
      setLastResultEntity(result.entity_id)
      setLastResultTone(pendingPhysicalCheck ? 'warning' : 'success')
      toast[pendingPhysicalCheck ? 'warning' : 'success'](pendingPhysicalCheck
        ? 'HA 已接受控制，待实机确认'
        : `控制已确认，回读状态：${result.new_state || '待刷新'}`)

      const applyControlResult = (current: LogicalDevice) => {
        const currentEntity = current.entities?.[role]
        if (!currentEntity || currentEntity.entity_id !== result.entity_id) return current
        const nextState = result.new_state || currentEntity.state
        const nextAttributes = result.attributes || currentEntity.attributes
        return {
          ...current,
          entities: {
            ...current.entities,
            [role]: {
              ...currentEntity,
              state: nextState,
              attributes: nextAttributes,
              capabilities: currentEntity.capabilities?.map((capability) => ({
                ...capability,
                current_value: capabilityReadbackValue(capability, nextState, nextAttributes),
              })),
              last_changed: new Date().toISOString(),
            },
          },
        }
      }
      setData((current) => current ? {
        ...current,
        devices: current.devices.map((item) => item.id === device.id ? applyControlResult(item) : item),
      } : current)
      setSelected((current) => current?.id === device.id ? applyControlResult(current) : current)
    } catch (err) {
      if (controlResultSequenceRef.current.get(entityKey) !== resultSequence) return
      if (controller.signal.aborted) return
      const message = businessErrorMessage(err, { fallback: '设备控制失败', service: 'Home Assistant' })
      setLastResult(`${device.name}${actionLabel(service)}失败：${message}`)
      setLastResultEntity(entity.entity_id)
      setLastResultTone('error')
      toast.error(message)
    } finally {
      releaseControl()

      // 控制响应已经携带真实回读；这里只异步刷新日志，避免旧的整页快照覆盖连续控制结果。
      if (showLogs) void loadLogs(true)
    }
  }

  const cancelControl = (entityKey: string) => {
    const activeRequests = Array.from(controlInFlightRef.current).filter((key) => key.startsWith(`${entityKey}:`))
    if (!activeRequests.length) return
    controlResultSequenceRef.current.set(entityKey, (controlResultSequenceRef.current.get(entityKey) || 0) + 1)
    controlAbortControllersRef.current.get(entityKey)?.abort()
    controlAbortControllersRef.current.delete(entityKey)
    activeRequests.forEach((requestKey) => {
      const timeoutId = controlTimeoutsRef.current.get(requestKey)
      if (timeoutId !== undefined) window.clearTimeout(timeoutId)
      controlTimeoutsRef.current.delete(requestKey)
      controlInFlightRef.current.delete(requestKey)
    })
    setControlInFlight((current) => {
      const entries = Object.entries(current).filter(([, control]) => control.entityId !== entityKey)
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries)
    })
    setLastResult('已取消当前等待，按钮已恢复。当前控制命令可能已经下发，请先刷新设备状态再继续操作。')
    setLastResultEntity(entityKey)
    setLastResultTone('warning')
    toast.warning('已取消等待；请刷新状态后再继续控制')
  }

  const closeDetail = () => {
    detailRequestRef.current += 1
    detailAbortRef.current?.abort()
    detailAbortRef.current = null
    setDetailLoading(false)
    setDetailError('')
    setDetailRecoveryEligible(false)
    Object.values(selected?.entities || {}).forEach((entity) => {
      // 请求锁会先于 React 状态更新；快速点击“应用”后立即关闭时也必须可靠释放。
      const hasActiveRequest = Array.from(controlInFlightRef.current)
        .some((key) => key.startsWith(`${entity.entity_id}:`))
      if (hasActiveRequest) cancelControl(entity.entity_id)
    })
    setSelected(null)
  }

  const editFromDetail = (device: LogicalDevice) => {
    closeDetail()
    window.setTimeout(() => openEditDevice(device), 0)
  }

  const confirmDeleteDevice = async () => {
    if (!isAdmin) {
      toast.error('仅管理员可删除设备台账')
      return
    }
    if (!deleteTarget) return
    const operationKey = `delete-${deleteTarget.id}`
    if (busyRef.current === operationKey) {
      beginBusy(operationKey)
      return
    }
    if (!deviceManagementAllowed) {
      toast.warning('设备台账当前不可写，请等待列表刷新成功后再删除')
      return
    }
    const operation = beginBusy(operationKey)
    if (!operation) return
    const { controller, requestId } = operation
    try {
      await deleteDevice(deleteTarget.id, controller.signal)
      if (managementRequestRef.current !== requestId) return
      toast.success('设备已删除')
      setDeleteTarget(null)
      await loadData(true)
    } catch (err) {
      if (controller.signal.aborted || managementRequestRef.current !== requestId) return
      if (managementResultUncertain(err)) {
        toast.warning('删除请求结果未确认，设备台账可能已经删除；正在重新读取最终状态')
        reconcileManagementState()
        return
      }
      toast.error(businessErrorMessage(err, { fallback: '设备删除失败', service: '设备台账' }))
    } finally {
      endBusy(operationKey, requestId, controller)
    }
  }

  const runDefaultHaSync = () => {
    if (!isAdmin) {
      toast.error('仅管理员可同步 Home Assistant 实体')
      return
    }
    if (!gatewayManagementAllowed) {
      toast.warning('网关目录当前不可操作，请等待读取成功后再同步')
      return
    }
    const gateway = gateways.find((item) => item.gateway_type === 'homeassistant' && item.enabled) || gateways.find((item) => item.gateway_type === 'homeassistant')
    if (!gateway) {
      toast.warning('尚未配置 Home Assistant 网关，请先在“配置网关”中新增。')
      return
    }
    runGatewaySync(gateway)
  }

  const runScene = async (scene: SceneItem) => {
    if (!deviceControlAllowed) {
      toast.warning(data?.ha_error ? 'Home Assistant 当前不可用，请恢复连接并刷新状态后再执行场景' : '设备台账当前不可操作，请等待列表刷新成功后再执行场景')
      return
    }
    const operationKey = `scene-${scene.entity_id}`
    const operation = beginBusy(operationKey)
    if (!operation) return
    const { controller, requestId } = operation
    try {
      const result = await activateScene(scene.entity_id, controller.signal)
      if (managementRequestRef.current !== requestId) return
      setLastResult(`${scene.name}已触发，当前平台已收到 Home Assistant 执行回执。`)
      setLastResultEntity(result.entity_id)
      toast.success(`${scene.name} 已触发`)
    } catch (err) {
      if (controller.signal.aborted || managementRequestRef.current !== requestId) return
      if (managementResultUncertain(err)) {
        setLastResult(`${scene.name}执行结果未确认；场景命令可能已经送达，请刷新设备状态并现场核对。`)
        setLastResultEntity(scene.entity_id)
        setLastResultTone('warning')
        toast.warning('场景执行结果未确认，正在重新读取设备状态')
        reconcileManagementState()
        return
      }
      toast.error(businessErrorMessage(err, { fallback: '场景执行失败', service: 'Home Assistant' }))
    } finally {
      endBusy(operationKey, requestId, controller)
      // 执行结果返回后先释放按钮，慢日志与台账查询在后台刷新。
      void Promise.allSettled([
        loadData(true),
        showLogs ? loadLogs(true) : Promise.resolve(),
      ])
    }
  }

  const openCreateFromCandidate = (candidate: GatewaySyncCandidate) => {
    const gateway = syncGatewaySource || gateways.find((item) => item.gateway_type === 'homeassistant') || null
    const category = candidateCategory(candidate)
    const sourceName = candidatePlatformLabel(candidate.platform)
    const sourceDescription = sourceName === '接入来源未取得' ? 'Home Assistant' : sourceName
    const deviceName = candidate.device_name || candidate.name || 'Home Assistant 设备'
    setEditingDevice(null)
    setDeviceForm({
      ...emptyDevice,
      name: candidate.name || candidate.device_name || '未命名 Home Assistant 实体',
      brand: candidate.manufacturer || '',
      model: candidate.model || '',
      location: candidate.area_name || '',
      category,
      protocol: 'homeassistant',
      gateway_id: gateway?.id || null,
      description: `从 ${sourceDescription} 发现的 ${deviceName}，通过 Home Assistant 接入平台。`,
      local_control: !['sensor', 'binary_sensor'].includes(category),
      capability_tags: Array.from(new Set([
        'Home Assistant',
        ...(sourceDescription === 'Home Assistant' ? [] : [sourceDescription]),
        categoryLabel(category),
      ])),
      mappings: [candidateMapping(candidate)],
    })
    setSyncCandidates(null)
    setShowDeviceDialog(true)
  }

  const openAttachCandidate = (candidate: GatewaySyncCandidate, deviceId: string) => {
    const device = syncTargetDevices.find((item) => item.id === deviceId)
    if (!device) {
      toast.warning('请选择要追加映射的设备')
      return
    }
    const payload = deviceToPayload(device)
    setEditingDevice(device)
    setDeviceForm({
      ...payload,
      mappings: [...payload.mappings, candidateMapping(candidate)],
    })
    setSyncCandidates(null)
    setShowDeviceDialog(true)
  }

  if ((loading && !data) || (isAdmin && gatewaysLoading && !gatewaysLoaded)) {
    return (
      <div className="flex min-h-[70vh] items-center justify-center">
        <div className="inline-flex items-center gap-3 rounded-[8px] border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-600">
          <Loader2 size={18} className="animate-spin text-blue-600" />
          正在加载设备台账和网关目录...
        </div>
      </div>
    )
  }

  return (
    <main className="mx-auto max-w-7xl space-y-6">
      <header className="flex flex-col gap-4 border-b border-slate-200 pb-6 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="inline-flex items-center gap-2 text-sm font-bold text-blue-700">
            <Power size={18} />
            设备接入、台账、映射与控制
          </div>
          <h1 className="text-3xl font-black text-slate-900">设备控制</h1>
          {!authLoading && !isAdmin ? <p className="text-xs font-semibold leading-5 text-blue-700">当前账号可查看设备状态、控制已授权设备并核对本人操作日志；设备台账、实体映射和网关配置由管理员负责。</p> : null}
        </div>
        <div className={`grid grid-cols-2 gap-2 ${isAdmin ? 'sm:grid-cols-4' : 'sm:grid-cols-2'} xl:shrink-0`}>
          {authLoading ? <div className="col-span-2 inline-flex min-h-11 items-center justify-center gap-2 rounded-[8px] border border-slate-200 bg-white px-4 text-xs font-semibold text-slate-400"><Loader2 size={14} className="animate-spin" />正在确认管理权限</div> : null}
          {isAdmin ? <button type="button" onClick={openCreateDevice} disabled={!deviceManagementAllowed} title={deviceManagementAllowed ? '添加设备' : '请等待设备台账和网关目录刷新成功'} className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[8px] bg-blue-600 px-4 py-3 text-sm font-bold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50">
            <Plus size={16} />添加设备
          </button> : null}
          {isAdmin ? <button type="button" onClick={() => setShowGateways(true)} disabled={!gatewayManagementAllowed} title={gatewayManagementAllowed ? '配置网关' : '请等待网关目录刷新成功'} className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[8px] border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 transition hover:border-blue-200 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-50">
            <ServerCog size={16} />配置网关
          </button> : null}
          {isAdmin ? <button type="button" onClick={runDefaultHaSync} disabled={!gatewayManagementAllowed || Boolean(busy && !busy.startsWith('gateway-sync-'))} className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[8px] border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 transition hover:border-blue-200 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-50">
            {busy.startsWith('gateway-sync-') ? <X size={16} /> : <Network size={16} />}{busy.startsWith('gateway-sync-') ? '取消等待' : '同步 HA 实体'}
          </button> : null}
          <button type="button" onClick={() => { setShowLogs(true); loadLogs() }} className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[8px] border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 transition hover:border-blue-200 hover:text-blue-700">
            <History size={16} />操作日志
          </button>
        </div>
      </header>

      {error && (data || !deviceListError) ? (
        <div role="alert" className="flex items-start gap-3 rounded-[8px] border border-amber-100 bg-amber-50 px-5 py-4 text-sm font-semibold leading-7 text-amber-800">
          <AlertTriangle size={18} className="mt-1 shrink-0" />
          <span>{error}{deviceListError && dataLoaded ? deviceSnapshotMatchesView ? '；继续显示当前条件下的上次成功设备快照。' : '；保留的旧设备快照不代表当前筛选条件，详情、控制和管理操作已暂停。' : ''}</span>
        </div>
      ) : null}

      {isAdmin && gatewaysError ? (
        <div className="flex items-start justify-between gap-3 rounded-[8px] border border-amber-100 bg-amber-50 px-5 py-4 text-sm font-semibold leading-7 text-amber-800">
          <div className="flex min-w-0 items-start gap-3">
            <ServerCog size={18} className="mt-1 shrink-0" />
            <span>{gatewaysError}{gatewaysLoaded ? '；继续显示上一次成功网关快照，设备管理和网关操作已暂停，设备状态与控制仍按设备台账可用性独立判断。' : '；网关配置、设备管理和同步入口已暂停，设备状态与控制仍按设备台账可用性独立判断。'}</span>
          </div>
          <button type="button" onClick={() => void loadGateways(true)} disabled={gatewaysLoading} className="shrink-0 rounded-[6px] border border-amber-200 bg-white px-3 py-1.5 text-xs font-black text-amber-800 disabled:opacity-50">{gatewaysLoading ? '读取中' : '重试'}</button>
        </div>
      ) : null}

      {isAdmin && (data?.summary.seed || 0) > 0 ? (
        <div className="flex flex-col gap-3 rounded-[8px] border border-orange-100 bg-orange-50 px-5 py-4 text-sm text-orange-900 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="font-black">检测到历史演示设备</div>
            <div className="mt-1 leading-6 text-orange-700">全量台账中有 {data?.summary.seed} 台固定种子设备，会干扰真实 HA 设备和 AI 名称搜索，可在接入真机前一次清理。</div>
          </div>
          <button type="button" onClick={runDemoCleanup} disabled={Boolean(busy && busy !== 'demo-cleanup')} className="inline-flex shrink-0 items-center justify-center gap-2 rounded-[8px] border border-orange-200 bg-white px-4 py-2.5 font-black text-orange-700 disabled:opacity-60">
            {busy === 'demo-cleanup' ? <X size={16} /> : <Trash2 size={16} />}
            {busy === 'demo-cleanup' ? '取消等待' : '清理演示设备'}
          </button>
        </div>
      ) : null}

      <section className="grid overflow-hidden rounded-[8px] border border-slate-200 bg-white lg:grid-cols-4">
        {SUMMARY_METAS.map((item) => {
          const Icon = item.icon
          const value = data ? data.summary[item.key] ?? '—' : '—'
          return (
            <div key={item.key} className="border-b border-slate-100 p-5 last:border-b-0 lg:border-b-0 lg:border-l lg:first:border-l-0">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-bold text-slate-400">{item.label}</div>
                  <div className={`mt-3 text-3xl font-black ${item.color}`}>{value}</div>
                </div>
                <Icon size={28} className="text-slate-300" />
              </div>
            </div>
          )
        })}
      </section>

      {data?.scenes?.length ? (
        <ScenePresets scenes={data.scenes} busy={busy} controlDisabled={!deviceControlAllowed} onActivate={runScene} />
      ) : null}

      <section className="border-y border-slate-200 py-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-w-0 flex-1 items-center gap-3 rounded-[8px] border border-slate-200 bg-white px-3 py-2.5">
            <Search size={18} className="shrink-0 text-slate-400" />
            <input
              aria-label="搜索设备"
              value={query}
              onChange={(event) => { setQuery(event.target.value); setPage(1) }}
              placeholder="搜索设备、型号、位置、网关或 HA 实体"
              className="min-h-8 w-full bg-transparent text-sm font-medium text-slate-700 outline-none placeholder:text-slate-400"
            />
          </div>
          <div className="grid gap-2 sm:grid-cols-4 xl:flex">
            <UnifiedSelect ariaLabel="筛选设备类型" value={category} className="min-w-36 [&>button]:rounded-[8px]" options={categories.map((item) => ({ value: item, label: categoryLabel(item) }))} onChange={(value) => { setCategory(value); setPage(1) }} />
            <UnifiedSelect ariaLabel="筛选设备连接状态" value={statusFilter} className="min-w-36 [&>button]:rounded-[8px]" options={Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }))} onChange={(value) => { setStatusFilter(value); setPage(1) }} />
            <UnifiedSelect ariaLabel="筛选设备所属网关" value={gatewayFilter} className="min-w-40 [&>button]:rounded-[8px]" options={[{ value: 'all', label: '全部网关' }, ...gateways.map((item) => ({ value: String(item.id), label: item.name }))]} onChange={(value) => { setGatewayFilter(value); setPage(1) }} />
            <UnifiedSelect ariaLabel="设备列表排序方式" value={sortMode} className="min-w-32 [&>button]:rounded-[8px]" options={[{ value: 'name', label: '按名称' }, { value: 'status', label: '按状态' }, { value: 'category', label: '按类型' }]} onChange={(next) => { setSortMode(next as SortMode); setPage(1) }} />
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => setViewMode('grid')} className={`inline-flex h-9 min-w-9 items-center justify-center rounded-[8px] border px-3 ${viewMode === 'grid' ? 'border-blue-200 bg-blue-50 text-blue-700' : 'border-slate-200 bg-white text-slate-500'}`} aria-label="网格视图"><LayoutGrid size={16} /></button>
            <button type="button" onClick={() => setViewMode('list')} className={`inline-flex h-9 min-w-9 items-center justify-center rounded-[8px] border px-3 ${viewMode === 'list' ? 'border-blue-200 bg-blue-50 text-blue-700' : 'border-slate-200 bg-white text-slate-500'}`} aria-label="列表视图"><List size={16} /></button>
            <button type="button" onClick={() => void Promise.allSettled([loadData(true), loadGateways(true)])} disabled={loading || gatewaysLoading} className="inline-flex h-9 min-w-9 items-center justify-center rounded-[8px] border border-slate-200 bg-white px-3 text-slate-500 hover:text-blue-700 disabled:cursor-wait disabled:opacity-50" aria-label="刷新"><RefreshCw size={16} className={loading || gatewaysLoading ? 'animate-spin' : ''} /></button>
          </div>
        </div>
      </section>

      {dataLoaded && (!deviceSnapshotMatchesView || loading) ? (
        <div className="border-l-2 border-blue-500 bg-blue-50 px-4 py-3 text-sm font-semibold text-blue-700" role="status" aria-live="polite">
          {loading ? '正在更新设备台账，' : '正在应用新的筛选条件，'}{deviceSnapshotMatchesView ? '当前继续显示同一条件下的上次成功结果。' : '下方旧快照不代表当前筛选条件，详情、控制和管理操作暂不可用。'}
        </div>
      ) : null}

      {lastResult ? (
        <section className={`border-l-2 px-5 py-4 text-sm ${
          lastResultTone === 'error'
            ? 'border-rose-500 bg-rose-50 text-rose-800'
            : lastResultTone === 'warning'
              ? 'border-amber-500 bg-amber-50 text-amber-800'
              : 'border-emerald-500 bg-emerald-50 text-emerald-800'
        }`}>
          <div className="font-black">最近一次执行结果</div>
          <div className="mt-2 leading-6">{lastResult}</div>
          {lastResultEntity ? (
            <details className="mt-2 text-xs text-emerald-700">
              <summary className="cursor-pointer font-semibold">技术详情</summary>
              <TechnicalId value={lastResultEntity} label="Home Assistant 实体" className="mt-2 max-w-md" />
            </details>
          ) : null}
        </section>
      ) : null}

      {viewMode === 'grid' ? (
        <DeviceGrid devices={filteredDevices} controlInFlight={controlInFlight} canManage={isAdmin} navigationDisabled={!deviceSnapshotMatchesView} managementDisabled={!deviceManagementAllowed} controlDisabled={!deviceControlAllowed} onControl={runControl} onCancelControl={cancelControl} onEdit={openEditDevice} onDelete={setDeleteTarget} onDetail={openDetail} />
      ) : (
        <DeviceTable devices={filteredDevices} controlInFlight={controlInFlight} canManage={isAdmin} navigationDisabled={!deviceSnapshotMatchesView} managementDisabled={!deviceManagementAllowed} controlDisabled={!deviceControlAllowed} onControl={runControl} onCancelControl={cancelControl} onEdit={openEditDevice} onDelete={setDeleteTarget} onDetail={openDetail} />
      )}

      {!data && error ? (
        <section role="alert" className="rounded-[8px] border border-slate-200 bg-white px-5 py-12 text-center">
          <ServerCog className="mx-auto text-slate-300" size={32} />
          <h2 className="mt-4 font-black text-slate-900">设备台账未取得</h2>
          <p className="mx-auto mt-2 max-w-xl break-words text-sm leading-6 text-slate-500">{deviceListError || error}</p>
          <p className="mt-1 text-xs leading-5 text-slate-400">读取失败不会计为 0 台设备。</p>
          <button type="button" onClick={() => void loadData(true)} disabled={loading} className="mt-4 inline-flex min-h-9 items-center gap-2 rounded-[8px] border border-slate-200 px-3 py-2 text-xs font-black text-slate-600 transition hover:border-blue-200 hover:text-blue-700 disabled:cursor-wait disabled:opacity-60">{loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}{loading ? '正在重新读取' : '重新读取台账'}</button>
        </section>
      ) : data && !filteredDevices.length ? (
        <section className="rounded-[8px] border border-slate-200 bg-white px-5 py-12 text-center">
          <ServerCog className="mx-auto text-slate-300" size={32} />
          <h2 className="mt-4 font-black text-slate-900">暂无匹配设备</h2>
          <p className="mt-2 text-sm text-slate-500">可以添加设备，或先配置 HA 网关并同步实体。</p>
        </section>
      ) : null}

      {dataLoaded ? (
        <Pagination
          page={loadedDevicePage}
          pageSize={loadedDevicePageSize}
          total={data?.total || 0}
          loading={loading}
          navigationDisabled={!deviceSnapshotMatchesView}
          onPageChange={setPage}
          onPageSizeChange={(value) => {
            setPageSize(value)
            setPage(1)
          }}
          pageSizeOptions={[10, 20, 50]}
          itemName="台设备"
        />
      ) : null}

      {selected ? <DeviceDetail key={selected.id} device={selected} detailLoading={detailLoading} detailError={detailError} onCancelDetailWait={cancelDetailWait} controlInFlight={controlInFlight} canManage={isAdmin} managementDisabled={!deviceManagementAllowed} controlDisabled={!deviceControlAllowed} onClose={closeDetail} onControl={runControl} onCancelControl={cancelControl} onEdit={editFromDetail} /> : null}
      {showLogs ? (
        <LogsPanel
          response={logsResponse}
          loaded={logsLoaded}
          loading={logsLoading}
          error={logsError}
          page={loadedLogsPage}
          pageSize={loadedLogsPageSize}
          navigationDisabled={loadedLogsPage !== logsPage || loadedLogsPageSize !== logsPageSize}
          onPageChange={(value) => {
            if (loadedLogsPage !== logsPage || loadedLogsPageSize !== logsPageSize) return
            logsAbortRef.current?.abort()
            logsRequestRef.current += 1
            setLogsLoading(true)
            setLogsPage(value)
          }}
          onPageSizeChange={(value) => {
            if (loadedLogsPage !== logsPage || loadedLogsPageSize !== logsPageSize) return
            logsAbortRef.current?.abort()
            logsRequestRef.current += 1
            setLogsLoading(true)
            setLogsPageSize(value)
            setLogsPage(1)
          }}
          onClose={() => {
            logsRequestRef.current += 1
            logsAbortRef.current?.abort()
            logsAbortRef.current = null
            setLogsLoading(false)
            setShowLogs(false)
          }}
          onRefresh={() => void loadLogs(true)}
        />
      ) : null}
      {showDeviceDialog && deviceManagementAllowed ? <DeviceFormDialog gateways={gateways} form={deviceForm} editing={Boolean(editingDevice)} busy={busy === 'device-save'} onChange={setDeviceForm} onClose={() => { if (busy === 'device-save') beginBusy('device-save'); else setShowDeviceDialog(false) }} onSubmit={submitDevice} /> : null}
      {showGateways && gatewayManagementAllowed ? (
        <GatewayDialog
          gateways={gateways}
          editing={editingGateway}
          form={gatewayForm}
          busy={busy}
          onEdit={(gateway) => {
            setEditingGateway(gateway)
            setGatewayForm({
              name: gateway.name,
              gateway_type: gateway.gateway_type,
              base_url: gateway.base_url,
              port: gateway.port,
              auth_type: gateway.auth_type,
              credential: gateway.credential_masked || '',
              enabled: gateway.enabled,
              description: gateway.description,
            })
          }}
          onNew={() => { setEditingGateway(null); setGatewayForm(emptyGateway) }}
          onChange={setGatewayForm}
          onSubmit={submitGateway}
          onTest={runGatewayTest}
          onSync={runGatewaySync}
          onDelete={runGatewayDelete}
          onClose={() => { if (busy.startsWith('gateway-')) beginBusy(busy); else setShowGateways(false) }}
        />
      ) : null}
      {deleteTarget && deviceManagementAllowed ? <DeleteDeviceDialog device={deleteTarget} busy={busy === `delete-${deleteTarget.id}`} onClose={() => { if (busy === `delete-${deleteTarget.id}`) beginBusy(busy); else setDeleteTarget(null) }} onConfirm={confirmDeleteDevice} /> : null}
      {confirmation ? (
        <AppDialog
          title={confirmation.kind === 'gateway-delete' ? '删除网关台账' : '清理历史演示设备'}
          description={confirmation.kind === 'gateway-delete'
            ? `将删除平台中的网关「${confirmation.gateway.name}」，不会删除外部系统配置。`
            : '只删除 source=seed 的历史演示设备台账，不会操作 Home Assistant 或真实硬件。'}
          onClose={busy ? () => undefined : () => setConfirmation(null)}
          maxWidth="max-w-md"
          danger
          closeOnOverlay={!busy}
          showClose={!busy}
          initialFocusRef={confirmationCancelRef}
          footer={(
            <div className="flex justify-end gap-3">
              <button
                ref={confirmationCancelRef}
                type="button"
                onClick={() => {
                  if (busy) {
                    beginBusy(busy)
                    setConfirmation(null)
                  } else setConfirmation(null)
                }}
                className="inline-flex min-h-10 items-center gap-2 rounded-[8px] border border-slate-200 px-5 text-sm font-black text-slate-700"
              >
                {busy ? <X size={15} /> : null}{busy ? '取消等待' : '取消'}
              </button>
              {!busy ? (
                <button
                  type="button"
                  onClick={() => confirmation.kind === 'gateway-delete' ? void executeGatewayDelete(confirmation.gateway) : void executeDemoCleanup()}
                  className="min-h-10 rounded-[8px] bg-rose-600 px-5 text-sm font-black text-white"
                >
                  {confirmation.kind === 'gateway-delete' ? '确认删除' : '确认清理'}
                </button>
              ) : null}
            </div>
          )}
        >
          <div className="space-y-3 text-sm leading-6 text-slate-500">
            <p>{confirmation.kind === 'gateway-delete' ? '平台设备与该网关的归属信息可能受到影响，请确认不再需要这条接入配置。' : '清理后历史演示设备将从平台列表和名称检索中移除。'}</p>
            {busy ? <p className="text-xs font-medium text-amber-700">请求已发送。取消等待只停止当前页面等待，不会撤销服务端可能已经完成的操作；页面随后会重新读取设备和网关最终状态。</p> : null}
          </div>
        </AppDialog>
      ) : null}
      {legacyControlDraft ? (
        <AppDialog
          title={legacyControlDraft.service === 'set_value' ? '设置设备目标数值' : '选择设备目标选项'}
          description={`${legacyControlDraft.device.name} · ${ROLE_LABELS[legacyControlDraft.role] || '设备参数'}`}
          onClose={() => setLegacyControlDraft(null)}
          maxWidth="max-w-sm"
          initialFocusRef={legacyControlInputRef}
          footer={(
            <div className="flex justify-end gap-3">
              <button type="button" onClick={() => setLegacyControlDraft(null)} className="min-h-10 rounded-[8px] border border-slate-200 px-5 text-sm font-black text-slate-700">取消</button>
              <button
                type="button"
                disabled={legacyControlDraft.value.trim() === '' || (legacyControlDraft.service === 'set_value' && (
                  !Number.isFinite(Number(legacyControlDraft.value))
                  || Number(legacyControlDraft.value) < legacyControlDraft.minimum
                  || Number(legacyControlDraft.value) > legacyControlDraft.maximum
                ))}
                onClick={() => {
                  const draft = legacyControlDraft
                  setLegacyControlDraft(null)
                  void runControl(draft.device, draft.role, draft.entity, draft.service, draft.service === 'set_value'
                    ? { value: Number(draft.value) }
                    : { option: draft.value })
                }}
                className="min-h-10 rounded-[8px] bg-blue-600 px-5 text-sm font-black text-white disabled:cursor-not-allowed disabled:opacity-45"
              >
                应用设置
              </button>
            </div>
          )}
        >
          {legacyControlDraft.service === 'set_value' ? (
            <label className="block space-y-2">
              <span className="text-xs font-black text-slate-600">目标数值{legacyControlDraft.unit ? `（${legacyControlDraft.unit}）` : ''}</span>
              <input ref={legacyControlInputRef} type="number" min={legacyControlDraft.minimum} max={legacyControlDraft.maximum} step={legacyControlDraft.step} value={legacyControlDraft.value} onChange={(event) => setLegacyControlDraft((current) => current ? { ...current, value: event.target.value } : current)} className={DEVICE_FIELD_CLASS} />
              <span className="block text-xs text-slate-400">允许范围 {legacyControlDraft.minimum} 至 {legacyControlDraft.maximum}，步长 {legacyControlDraft.step}</span>
            </label>
          ) : legacyControlDraft.options.length ? (
            <div className="space-y-2">
              <span className="text-xs font-black text-slate-600">目标选项</span>
              <UnifiedSelect ariaLabel="设备目标选项" value={legacyControlDraft.value} options={legacyControlDraft.options.map((option) => ({ value: option, label: capabilityOptionLabel(option) }))} onChange={(value) => setLegacyControlDraft((current) => current ? { ...current, value } : current)} />
            </div>
          ) : (
            <label className="block space-y-2">
              <span className="text-xs font-black text-slate-600">目标选项</span>
              <input ref={legacyControlInputRef} value={legacyControlDraft.value} onChange={(event) => setLegacyControlDraft((current) => current ? { ...current, value: event.target.value } : current)} className={DEVICE_FIELD_CLASS} />
              <span className="block text-xs text-amber-700">Home Assistant 未返回可选值，请按设备支持的选项准确填写。</span>
            </label>
          )}
        </AppDialog>
      ) : null}
      {syncCandidates ? (
        <SyncCandidatesDialog
          candidates={syncCandidates}
          devices={data?.devices || []}
          devicesTruncated={syncTargetTruncated}
          busy={busy === `gateway-import-${syncGatewaySource?.id}`}
          onCreate={openCreateFromCandidate}
          onAttach={openAttachCandidate}
          onImport={runGatewayImport}
          onClose={() => { if (busy === `gateway-import-${syncGatewaySource?.id}`) beginBusy(busy); else setSyncCandidates(null) }}
        />
      ) : null}
    </main>
  )
}

function ScenePresets({ scenes, busy, controlDisabled, onActivate }: {
  scenes: SceneItem[]
  busy: string
  controlDisabled: boolean
  onActivate: (scene: SceneItem) => void
}) {
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(4)
  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN')
  const busySceneId = busy.startsWith('scene-') ? busy.slice('scene-'.length) : ''
  const matchingScenes = useMemo(
    () => scenes.filter((scene) => !normalizedQuery || `${scene.name} ${scene.entity_id}`.toLocaleLowerCase('zh-CN').includes(normalizedQuery)),
    [normalizedQuery, scenes],
  )
  const pageCount = Math.max(1, Math.ceil(matchingScenes.length / pageSize))
  const safePage = Math.min(page, pageCount)
  const pageScenes = matchingScenes.slice((safePage - 1) * pageSize, safePage * pageSize)
  const busyScene = busySceneId ? scenes.find((scene) => scene.entity_id === busySceneId) : undefined
  const visibleScenes = busyScene && !pageScenes.some((scene) => scene.entity_id === busyScene.entity_id)
    ? [busyScene, ...pageScenes]
    : pageScenes

  return (
    <section className="overflow-hidden rounded-[8px] border border-slate-200 bg-white">
      <div className="flex flex-col gap-3 border-b border-slate-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-black text-slate-900">场景预设</h2>
          <p className="mt-1 text-xs text-slate-500">来自当前 Home Assistant 完整场景快照，共 {scenes.length} 个。</p>
        </div>
        <label className="relative min-w-0 sm:w-64">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1) }} aria-label="搜索场景预设" placeholder="搜索场景名称" className="h-10 w-full rounded-[8px] border border-slate-200 bg-white pl-9 pr-3 text-xs outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100" />
        </label>
      </div>
      {busyScene && !matchingScenes.some((scene) => scene.entity_id === busyScene.entity_id) ? <div className="border-b border-blue-100 bg-blue-50 px-4 py-2 text-xs font-semibold text-blue-700">执行中的场景已固定显示，取消等待后将恢复当前搜索结果。</div> : null}
      {visibleScenes.length ? <div className="grid md:grid-cols-2 2xl:grid-cols-4">
      {visibleScenes.map((scene) => {
        const isBusy = busy === `scene-${scene.entity_id}`
        return (
          <article key={scene.entity_id} className="border-b border-slate-100 p-4 last:border-b-0 md:border-r md:even:border-r-0 md:[&:nth-last-child(-n+2)]:border-b-0 2xl:border-b-0 2xl:border-r 2xl:last:border-r-0">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Sparkles size={16} className="shrink-0 text-blue-600" />
                  <h2 className="truncate text-sm font-black text-slate-900" title={scene.name}>{scene.name}</h2>
                </div>
                <div className="mt-2 text-xs font-semibold text-slate-500">
                  {scene.entity_count ? `包含 ${scene.entity_count} 个设备或实体` : '场景内容由 Home Assistant 管理'}
                </div>
              </div>
              <span className="shrink-0 rounded-[6px] bg-blue-50 px-2.5 py-1 text-xs font-bold text-blue-700">HA 场景</span>
            </div>
            <div className="mt-4 flex items-center justify-between gap-3">
              <details className="group min-w-0 text-xs text-slate-500">
                <summary className="cursor-pointer font-semibold transition hover:text-blue-700">技术详情</summary>
                <TechnicalId value={scene.entity_id} label="Home Assistant 场景实体" className="mt-2 hidden max-w-52 group-open:block" />
              </details>
              <button
                type="button"
                onClick={() => onActivate(scene)}
                disabled={controlDisabled || Boolean(busy && !isBusy)}
                title={controlDisabled ? '请恢复 Home Assistant 连接并刷新设备状态' : undefined}
                className="inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[8px] bg-slate-900 px-3 py-2 text-xs font-bold text-white transition hover:bg-slate-700 disabled:opacity-60"
              >
                {isBusy ? <X size={14} /> : <Power size={14} />}
                {isBusy ? '取消等待' : '执行'}
              </button>
            </div>
          </article>
        )
      })}
      </div> : <div className="px-5 py-10 text-center text-sm text-slate-400">没有符合条件的场景预设</div>}
      <Pagination page={safePage} pageSize={pageSize} total={matchingScenes.length} itemName="个场景" pageSizeOptions={[4, 8, 16]} onPageChange={setPage} onPageSizeChange={(value) => { setPageSize(value); setPage(1) }} />
    </section>
  )
}

type DeviceControlHandler = (
  device: LogicalDevice,
  role: string,
  entity: EntityState,
  action: string,
  data?: Record<string, unknown>,
) => void

type DeviceControlCancelHandler = (entityId: string) => void

function capabilityPayload(action: string, value: string | number) {
  const keys: Record<string, string> = {
    set_brightness: 'brightness_pct',
    set_color_temperature: 'color_temp_kelvin',
    set_position: 'position',
    set_temperature: 'temperature',
    set_percentage: 'percentage',
    set_value: 'value',
    select_option: 'option',
    set_hvac_mode: 'hvac_mode',
    set_effect: 'effect',
  }
  return { [keys[action] || 'value']: value }
}

function capabilityOptionLabel(value: string) {
  const normalized = value.trim().toLowerCase()
  if (!normalized) return '未设置'
  if (
    normalized.includes('空场景')
    || normalized.includes('not in any situation mode')
    || normalized === 'none'
    || normalized === 'off'
  ) return '无灯光效果'
  return value
}

function CapabilityControl({ capability, device, role, entity, controlInFlight, controlDisabled, onControl }: {
  capability: DeviceCapability
  device: LogicalDevice
  role: string
  entity: EntityState
  controlInFlight: ControlInFlightMap
  controlDisabled: boolean
  onControl: DeviceControlHandler
}) {
  const action = capability.action || ''
  // HA 未返回当前值时保持空态，不能用范围下限或第一个选项冒充真实读数。
  const initialValue = capability.current_value ?? ''
  const [value, setValue] = useState(String(initialValue))
  const initialValueText = String(initialValue)
  const previousReadbackRef = useRef(initialValueText)
  const currentActionBusy = action ? isCurrentControl(controlInFlight, entity.entity_id, action) : false
  const entityControlBusy = isEntityControlBusy(controlInFlight, entity.entity_id)
  // 参数在其他控制等待期间仍可编辑；再次提交会由上层按最后一次操作优先替换等待。
  const inputDisabled = controlDisabled || !entityOnline(entity)
  const submitDisabled = inputDisabled
  const unchanged = value === initialValueText
  const draftValueLabel = value === ''
    ? '未读取'
    : `${unchanged ? '' : '待应用：'}${value}${capability.unit || ''}`

  useEffect(() => {
    const previousReadback = previousReadbackRef.current
    previousReadbackRef.current = initialValueText
    setValue((current) => current === previousReadback ? initialValueText : current)
  }, [initialValueText])

  const updateDraft = (nextValue: string) => {
    setValue(nextValue)
  }

  if (capability.control_type === 'actions') {
    const actions = visiblePrimaryActions(entity, capability.actions || [])
    return (
      <div className="flex flex-wrap gap-2">
        {actions.map((item) => {
          const actionBusy = isCurrentControl(controlInFlight, entity.entity_id, item)
          return (
            <button key={item} type="button" onClick={() => onControl(device, role, entity, item)} disabled={controlDisabled || !entityOnline(entity)} title={controlDisabled ? '请恢复 Home Assistant 连接并刷新设备状态' : entityControlBusy && !actionBusy ? '提交后将以本次操作为准' : undefined} className="inline-flex min-w-24 items-center justify-center gap-2 rounded-[8px] bg-slate-900 px-4 py-2.5 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50">
              {actionBusy ? <Loader2 size={15} className="animate-spin" /> : <Power size={15} />}
              {actionBusy ? `${actionLabel(item)}中` : actionLabel(item)}
            </button>
          )
        })}
      </div>
    )
  }

  if (capability.control_type === 'select' && action) {
    const options = Array.from(new Set((capability.options || []).filter(Boolean)))
    const canSelect = options.length > 1
    if (!canSelect) {
      return (
        <div className="flex items-center justify-between gap-4 border-t border-slate-200 py-3 text-sm">
          <span className="font-bold text-slate-600">{capability.label}</span>
          <span className="min-w-0 truncate font-semibold text-slate-800" title={capabilityOptionLabel(String(value || options[0] || ''))}>
            {capabilityOptionLabel(String(value || options[0] || ''))}
          </span>
        </div>
      )
    }
    return (
      <div className="grid items-center gap-2 border-t border-slate-200 py-3 sm:grid-cols-[5rem_minmax(0,1fr)_5.5rem]">
        <div className="text-xs font-black text-slate-600">{capability.label}</div>
        <div className="contents">
          <UnifiedSelect ariaLabel={`${capability.label}目标选项`} value={value} options={options.map((item) => ({ value: item, label: capabilityOptionLabel(item) }))} onChange={updateDraft} disabled={inputDisabled} size="sm" className="[&>button]:rounded-[8px]" />
          <button type="button" onClick={() => onControl(device, role, entity, action, capabilityPayload(action, value))} disabled={submitDisabled || !value || unchanged} title={entityControlBusy && !currentActionBusy ? '提交后将以本次操作为准' : unchanged ? '请选择不同的选项后应用' : undefined} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-[8px] bg-blue-600 px-3 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-50">
            {currentActionBusy ? <Loader2 size={14} className="animate-spin" /> : null}
            {currentActionBusy ? '应用中' : '应用'}
          </button>
        </div>
      </div>
    )
  }

  if (capability.control_type === 'range' && action) {
    const minimum = capability.min ?? 0
    const maximum = capability.max ?? 100
    const step = capability.step || 1
    const numericValue = value === '' ? null : Number(value)
    const invalidValue = numericValue === null
      || !Number.isFinite(numericValue)
      || numericValue < minimum
      || numericValue > maximum
    return (
      <div className="grid items-center gap-2 border-t border-slate-200 py-3 sm:grid-cols-[5rem_minmax(0,1fr)_5rem_5.5rem]">
        <div>
          <div className="text-xs font-black text-slate-600">{capability.label}</div>
          <div className={`mt-1 whitespace-nowrap text-xs font-bold ${unchanged ? 'text-slate-500' : 'text-blue-700'}`}>{draftValueLabel}</div>
        </div>
        <div className="contents">
          {value === '' ? (
            <div className="flex h-10 items-center border-b border-dashed border-slate-300 text-xs font-semibold text-slate-400">输入目标值后可调节</div>
          ) : (
            <input type="range" min={minimum} max={maximum} step={step} value={value} onChange={(event) => updateDraft(event.target.value)} disabled={inputDisabled} className="w-full accent-blue-600" aria-label={capability.label} />
          )}
          <input type="number" min={minimum} max={maximum} step={step} value={value} placeholder="—" onChange={(event) => updateDraft(event.target.value)} disabled={inputDisabled} className="h-10 rounded-[8px] border border-slate-200 px-2 text-right text-sm font-bold text-slate-700 outline-none focus:border-blue-300" aria-label={`${capability.label}数值`} />
          <button type="button" onClick={() => numericValue !== null && onControl(device, role, entity, action, capabilityPayload(action, numericValue))} disabled={submitDisabled || invalidValue || unchanged} title={entityControlBusy && !currentActionBusy ? '提交后将以本次操作为准' : invalidValue && value !== '' ? `请输入 ${minimum} 至 ${maximum} 之间的数值` : unchanged ? '调整数值后应用' : undefined} className="col-span-2 inline-flex h-10 items-center justify-center gap-2 rounded-[8px] bg-blue-600 px-3 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-50 sm:col-span-1">
            {currentActionBusy ? <Loader2 size={14} className="animate-spin" /> : null}
            {currentActionBusy ? '应用中' : '应用'}
          </button>
        </div>
      </div>
    )
  }
  return null
}

function CapabilityControls({ device, role, entity, controlInFlight, controlDisabled, onControl }: {
  device: LogicalDevice
  role: string
  entity: EntityState
  controlInFlight: ControlInFlightMap
  controlDisabled: boolean
  onControl: DeviceControlHandler
}) {
  const capabilities = entity.capabilities?.length
    ? entity.capabilities
    : [{ id: 'actions', label: '设备操作', control_type: 'actions', actions: entity.control_actions || [] }]
  return (
    <div className="space-y-3">
      {capabilities.map((capability) => (
        <CapabilityControl key={`${entity.entity_id}-${capability.id}`} capability={capability} device={device} role={role} entity={entity} controlInFlight={controlInFlight} controlDisabled={controlDisabled} onControl={onControl} />
      ))}
    </div>
  )
}

function DeviceGrid({ devices, controlInFlight, canManage, navigationDisabled, managementDisabled, controlDisabled, onControl, onCancelControl, onEdit, onDelete, onDetail }: {
  devices: LogicalDevice[]
  controlInFlight: ControlInFlightMap
  canManage: boolean
  navigationDisabled: boolean
  managementDisabled: boolean
  controlDisabled: boolean
  onControl: DeviceControlHandler
  onCancelControl: DeviceControlCancelHandler
  onEdit: (device: LogicalDevice) => void
  onDelete: (device: LogicalDevice) => void
  onDetail: (device: LogicalDevice) => void
}) {
  return (
    <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {devices.map((device) => {
        const entry = primaryEntry(device)
        const [role, entity] = entry || []
        const actions = entity?.control_actions?.length ? primaryActions(entity, entity.control_actions) : []
        const entityBusy = entity ? isEntityControlBusy(controlInFlight, entity.entity_id) : false
        return (
          <article key={device.id} className="flex min-h-[300px] flex-col rounded-[8px] border border-slate-200 bg-white p-5 transition hover:border-blue-200">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-black text-slate-900">{device.name}</h2>
                  <span className="rounded-[6px] border border-slate-200 px-2.5 py-1 text-xs font-bold text-slate-500" title={CATEGORY_LABELS[device.category] ? undefined : `技术类型：${device.category || '未返回'}`}>{categoryLabel(device.category)}</span>
                  <span className={`inline-flex min-w-14 justify-center whitespace-nowrap rounded-[6px] border px-2.5 py-1 text-xs font-bold ${statusBadgeClass(device.status)}`} title={STATUS_LABELS[device.status] ? undefined : `技术状态：${device.status || '未返回'}`}>{deviceStatusLabel(device.status)}</span>
                </div>
                <p className="mt-2 line-clamp-2 text-sm leading-6 text-slate-500" title={displayDeviceDescription(device)}>{displayDeviceDescription(device)}</p>
              </div>
              <button type="button" onClick={() => onDetail(device)} disabled={navigationDisabled} className="shrink-0 rounded-[8px] border border-slate-200 p-2 text-slate-500 transition hover:border-blue-200 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-40" aria-label="查看详情">
                <ChevronRight size={18} />
              </button>
            </div>

            <div className="mt-5 border-y border-slate-100 py-4">
              {entity ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-slate-400">{formatEntityRole(role)}</div>
                      <button type="button" onClick={() => onDetail(device)} disabled={navigationDisabled} className="mt-1 min-h-9 rounded-lg py-2 text-xs font-semibold text-slate-400 transition hover:bg-slate-100 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-50">查看技术映射</button>
                    </div>
                    <span className={`rounded-[6px] border px-3 py-1 text-xs font-bold ${entityOnline(entity) ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50 text-amber-700'}`}>
                      {formatEntityState(entity)}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {entityBusy ? (
                      <button type="button" onClick={() => onCancelControl(entity.entity_id)} className="inline-flex items-center justify-center gap-1.5 rounded-[8px] border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800 transition hover:bg-amber-100">
                        <X size={14} />取消等待
                      </button>
                    ) : actions.slice(0, 2).map((action) => (
                      <button key={action} type="button" onClick={() => onControl(device, role || 'power', entity, action)} disabled={controlDisabled || !entityOnline(entity)} title={controlDisabled ? '请恢复 Home Assistant 连接并刷新设备状态' : undefined} className="inline-flex items-center justify-center gap-1.5 rounded-[8px] bg-slate-900 px-3 py-2 text-xs font-bold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50">
                        <Power size={14} />
                        {actionLabel(action)}
                      </button>
                    ))}
                    {!controlInFlight[entity.entity_id] && actions.length > 2 ? <span className="inline-flex items-center px-1 text-xs font-semibold text-slate-400" title="其余操作可在设备详情中执行">另 {actions.length - 2} 项</span> : null}
                    {!actions.length ? <span className="rounded-[6px] border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-500">只读设备</span> : null}
                  </div>
                </div>
              ) : (
                <div className="text-sm font-semibold text-amber-700">该设备暂无实体映射。</div>
              )}
            </div>

            <div className={`mt-4 grid gap-2 text-xs font-bold ${canManage ? 'grid-cols-3' : 'grid-cols-1'}`}>
              <button type="button" onClick={() => onDetail(device)} disabled={navigationDisabled} className="rounded-lg border border-slate-200 px-3 py-2 text-slate-600 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-40">详情</button>
              {canManage ? <button type="button" onClick={() => onEdit(device)} disabled={managementDisabled} className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-blue-700 disabled:cursor-not-allowed disabled:opacity-40">编辑</button> : null}
              {canManage ? <button type="button" onClick={() => onDelete(device)} disabled={managementDisabled} className="rounded-lg border border-rose-200 px-3 py-2 text-rose-600 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-40">删除</button> : null}
            </div>
          </article>
        )
      })}
    </section>
  )
}

function DeviceTable({ devices, controlInFlight, canManage, navigationDisabled, managementDisabled, controlDisabled, onControl, onCancelControl, onEdit, onDelete, onDetail }: {
  devices: LogicalDevice[]
  controlInFlight: ControlInFlightMap
  canManage: boolean
  navigationDisabled: boolean
  managementDisabled: boolean
  controlDisabled: boolean
  onControl: DeviceControlHandler
  onCancelControl: DeviceControlCancelHandler
  onEdit: (device: LogicalDevice) => void
  onDelete: (device: LogicalDevice) => void
  onDetail: (device: LogicalDevice) => void
}) {
  return (
    <section className="overflow-hidden rounded-[8px] border border-slate-200 bg-white">
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="设备实体映射列表，可横向滚动">
        <table className="w-full min-w-[1160px] table-fixed text-left">
          <colgroup>
            <col className="w-[200px]" />
            <col className="w-[110px]" />
            <col className="w-[130px]" />
            <col className="w-[190px]" />
            <col className="w-[130px]" />
            <col className="w-[150px]" />
            <col className="w-[250px]" />
          </colgroup>
          <thead className="bg-slate-50 text-xs font-bold text-slate-500">
            <tr>
              <th className="px-4 py-3.5">设备名称</th>
              <th className="px-4 py-3.5">类型</th>
              <th className="px-4 py-3.5">位置</th>
              <th className="px-4 py-3.5">接入来源</th>
              <th className="px-4 py-3.5">连接</th>
              <th className="px-4 py-3.5">HA 当前状态</th>
              <th className="px-3 py-3.5 text-right">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {devices.map((device) => {
              const entry = primaryEntry(device)
              const [role, entity] = entry || []
              const action = entity?.state === 'on' ? 'turn_off' : 'turn_on'
              const canQuickControl = entity?.control_actions?.includes(action)
              const entityBusy = entity ? isEntityControlBusy(controlInFlight, entity.entity_id) : false
              const accessSource = GATEWAY_LABELS[device.gateway_type || ''] || device.gateway_name || '未配置'
              return (
                    <tr key={device.id} className="h-14 bg-white transition hover:bg-slate-50/70">
                  <td className="px-4 py-3.5">
                    <button type="button" onClick={() => onDetail(device)} disabled={navigationDisabled} title={navigationDisabled ? '请等待当前筛选条件读取完成' : device.name} className="flex min-h-8 w-full items-center truncate text-left text-sm font-black text-slate-900 transition hover:text-blue-700 disabled:cursor-not-allowed disabled:text-slate-500">
                      {device.name}
                    </button>
                  </td>
                  <td className="truncate whitespace-nowrap px-4 py-3.5 text-sm font-semibold text-slate-600" title={CATEGORY_LABELS[device.category] ? categoryLabel(device.category) : `技术类型：${device.category || '未返回'}`}>
                    {categoryLabel(device.category)}
                  </td>
                  <td className="truncate whitespace-nowrap px-4 py-3.5 text-sm text-slate-600" title={device.location || '未填写位置'}>
                    {device.location || '未填写'}
                  </td>
                  <td className="truncate whitespace-nowrap px-4 py-3.5 text-sm font-semibold text-slate-700" title={device.gateway_name || accessSource}>
                    {accessSource}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3.5">
                    <StatusBadge status={device.status} label={deviceStatusLabel(device.status)} />
                  </td>
                  <td className="whitespace-nowrap px-4 py-3.5">
                    {entity ? <StatusBadge status={entityOnline(entity) ? 'running' : entity.state} label={formatEntityState(entity)} /> : <span className="text-sm text-slate-400">—</span>}
                  </td>
                  <td className="bg-white px-3 py-3.5">
                    <div className="flex justify-end gap-1.5 whitespace-nowrap">
                      {entity && entityBusy ? (
                        <button type="button" onClick={() => onCancelControl(entity.entity_id)} className="inline-flex h-9 min-w-[88px] items-center justify-center gap-1.5 rounded-[8px] border border-amber-200 bg-amber-50 px-2.5 text-xs font-bold text-amber-800 transition hover:bg-amber-100">
                          <X size={14} />取消等待
                        </button>
                      ) : entity && canQuickControl ? (
                        <button type="button" onClick={() => onControl(device, role || 'power', entity, action)} disabled={controlDisabled || !entityOnline(entity)} title={controlDisabled ? '请恢复 Home Assistant 连接并刷新设备状态' : undefined} className="inline-flex h-9 min-w-[72px] items-center justify-center gap-1.5 rounded-[8px] bg-slate-900 px-2.5 text-xs font-bold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50">
                          <Power size={14} />
                          {actionLabel(action)}
                        </button>
                      ) : null}
                      <button type="button" onClick={() => onDetail(device)} disabled={navigationDisabled} className="h-9 rounded-[8px] bg-slate-100 px-3 text-xs font-bold text-slate-700 transition hover:bg-blue-50 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-40">详情</button>
                      {canManage ? <button type="button" onClick={() => onEdit(device)} disabled={managementDisabled} title="编辑设备" aria-label={`编辑${device.name}`} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] bg-blue-50 text-blue-700 transition hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-40"><Pencil size={15} /></button> : null}
                      {canManage ? <button type="button" onClick={() => onDelete(device)} disabled={managementDisabled} title="删除设备" aria-label={`删除${device.name}`} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] border border-rose-200 text-rose-600 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-40"><Trash2 size={15} /></button> : null}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function DeviceFormDialog({ gateways, form, editing, busy, onChange, onClose, onSubmit }: {
  gateways: DeviceGateway[]
  form: DevicePayload
  editing: boolean
  busy: boolean
  onChange: (form: DevicePayload) => void
  onClose: () => void
  onSubmit: () => void
}) {
  const setMapping = (index: number, patch: Partial<DeviceMapping>) => {
    onChange({
      ...form,
      mappings: form.mappings.map((mapping, current) => current === index ? { ...mapping, ...patch } : mapping),
    })
  }
  return (
    <AppDialog
      title={editing ? '编辑设备信息' : '添加设备'}
      description="维护平台设备台账、网关归属和实体映射。真实硬件需先接入网关后再映射到平台设备。"
      onClose={onClose}
      maxWidth="max-w-4xl"
      footer={(
        <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-[8px] border border-slate-200 px-5 py-3 text-sm font-black text-slate-700 disabled:opacity-60">取消</button>
          <button type="button" onClick={onSubmit} className="inline-flex items-center justify-center gap-2 rounded-[8px] bg-blue-600 px-5 py-3 text-sm font-black text-white disabled:opacity-60">
            {busy ? <X size={16} /> : <CheckCircle2 size={16} />}
            {busy ? '取消等待' : '保存设备'}
          </button>
        </div>
      )}
    >
      <fieldset disabled={busy} className="grid gap-5 md:grid-cols-2 disabled:opacity-70">
        <Field label="设备名称"><input value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value })} className={DEVICE_FIELD_CLASS} placeholder="例如：客厅灯" /></Field>
        <Field label="设备类型"><UnifiedSelect ariaLabel="设备类型" value={form.category} options={Object.entries(CATEGORY_LABELS).filter(([value]) => value !== 'all').map(([value, label]) => ({ value, label }))} onChange={(value) => onChange({ ...form, category: value })} /></Field>
        <Field label="品牌"><input value={form.brand} onChange={(event) => onChange({ ...form, brand: event.target.value })} className={DEVICE_FIELD_CLASS} placeholder="例如：小米 / Aqara" /></Field>
        <Field label="型号"><input value={form.model} onChange={(event) => onChange({ ...form, model: event.target.value })} className={DEVICE_FIELD_CLASS} placeholder="设备型号" /></Field>
        <Field label="安装位置"><input value={form.location} onChange={(event) => onChange({ ...form, location: event.target.value })} className={DEVICE_FIELD_CLASS} placeholder="例如：客厅" /></Field>
        <Field label="接入协议"><input value={form.protocol} onChange={(event) => onChange({ ...form, protocol: event.target.value })} className={DEVICE_FIELD_CLASS} placeholder="homeassistant / matter / zigbee" /></Field>
        <Field label="所属网关"><UnifiedSelect ariaLabel="所属网关" value={String(form.gateway_id || '')} options={[{ value: '', label: '未绑定网关' }, ...gateways.map((gateway) => ({ value: String(gateway.id), label: gateway.name }))]} onChange={(value) => onChange({ ...form, gateway_id: value ? Number(value) : null })} /></Field>
        <Field label="能力标签"><input value={form.capability_tags.join('，')} onChange={(event) => onChange({ ...form, capability_tags: event.target.value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean) })} className={DEVICE_FIELD_CLASS} placeholder="灯光，HA 映射，本地可控" /></Field>
        <label className="flex items-center gap-3 rounded-[8px] bg-slate-50 px-4 py-3 text-sm font-bold text-slate-700">
          <input type="checkbox" checked={form.local_control} onChange={(event) => onChange({ ...form, local_control: event.target.checked })} className={CHECKBOX_CLASS} />
          本地可控
        </label>
        <label className="flex items-center gap-3 rounded-[8px] bg-slate-50 px-4 py-3 text-sm font-bold text-slate-700">
          <input type="checkbox" checked={form.enabled} onChange={(event) => onChange({ ...form, enabled: event.target.checked })} className={CHECKBOX_CLASS} />
          启用设备
        </label>
        <Field label="描述" className="md:col-span-2"><textarea value={form.description} onChange={(event) => onChange({ ...form, description: event.target.value })} className={`${DEVICE_FIELD_CLASS} min-h-24 resize-y`} placeholder="填写设备用途、接入边界或验收说明" /></Field>
      </fieldset>

      <fieldset disabled={busy} className="mt-6 space-y-3 disabled:opacity-70">
        <div className="flex items-center justify-between">
          <h3 className="font-black text-slate-900">实体映射</h3>
          <button type="button" onClick={() => onChange({ ...form, mappings: [...form.mappings, { ...emptyMapping }] })} className="rounded-[8px] bg-slate-900 px-4 py-2 text-xs font-black text-white">添加映射</button>
        </div>
        {form.mappings.map((mapping, index) => (
          <div key={index} className="grid gap-3 rounded-[8px] border border-slate-200 p-4 md:grid-cols-6">
            <label className="min-w-0 md:col-span-1">
              <span className="mb-1.5 block text-xs font-bold text-slate-600">映射角色</span>
              <input value={mapping.role} onChange={(event) => setMapping(index, { role: event.target.value })} className={DEVICE_FIELD_CLASS} placeholder="例如：电源" />
            </label>
            <label className="min-w-0 md:col-span-2">
              <span className="mb-1.5 block text-xs font-bold text-slate-600">连接端点</span>
              <input value={mapping.endpoint} onChange={(event) => setMapping(index, { endpoint: event.target.value })} className={DEVICE_FIELD_CLASS} placeholder="HA 实体、Topic 或设备地址" />
            </label>
            <div className="min-w-0 md:col-span-1">
              <span className="mb-1.5 block text-xs font-bold text-slate-600">网关类型</span>
              <UnifiedSelect ariaLabel={`第 ${index + 1} 条映射的网关类型`} value={mapping.gateway_type} options={Object.entries(GATEWAY_LABELS).map(([value, label]) => ({ value, label }))} onChange={(value) => setMapping(index, { gateway_type: value })} />
            </div>
            <div className="min-w-0 md:col-span-1">
              <span className="mb-1.5 block text-xs font-bold text-slate-600">访问方式</span>
              <UnifiedSelect ariaLabel={`第 ${index + 1} 条映射的访问方式`} value={mapping.access_mode} options={[{ value: 'rw', label: '读写' }, { value: 'ro', label: '只读' }, { value: 'write', label: '只写' }]} onChange={(value) => setMapping(index, { access_mode: value })} />
            </div>
            <button type="button" aria-label={`删除第 ${index + 1} 条实体映射`} onClick={() => onChange({ ...form, mappings: form.mappings.filter((_, current) => current !== index) })} className="min-h-10 self-end rounded-[8px] border border-rose-200 px-3 py-2 text-sm font-black text-rose-600">删除</button>
            <label className="min-w-0 md:col-span-1">
              <span className="mb-1.5 block text-xs font-bold text-slate-600">数据单位</span>
              <input value={mapping.unit} onChange={(event) => setMapping(index, { unit: event.target.value })} className={DEVICE_FIELD_CLASS} placeholder="例如：%" />
            </label>
            <label className="min-w-0 md:col-span-5">
              <span className="mb-1.5 block text-xs font-bold text-slate-600">允许的控制动作</span>
              <input value={mapping.control_actions.join(',')} onChange={(event) => setMapping(index, { control_actions: event.target.value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean) })} className={DEVICE_FIELD_CLASS} placeholder="例如：turn_on, turn_off, toggle" />
            </label>
          </div>
        ))}
      </fieldset>
    </AppDialog>
  )
}

function GatewayDialog({ gateways, editing, form, busy, onEdit, onNew, onChange, onSubmit, onTest, onSync, onDelete, onClose }: {
  gateways: DeviceGateway[]
  editing: DeviceGateway | null
  form: DeviceGatewayPayload
  busy: string
  onEdit: (gateway: DeviceGateway) => void
  onNew: () => void
  onChange: (form: DeviceGatewayPayload) => void
  onSubmit: () => void
  onTest: (gateway: DeviceGateway) => void
  onSync: (gateway: DeviceGateway) => void
  onDelete: (gateway: DeviceGateway) => void
  onClose: () => void
}) {
  return (
    <AppDialog title="网关接入配置" description="HA 网关可真实同步和控制；其他类型用于保存现场接入资料，等待适配器联调。" onClose={onClose} maxWidth="max-w-5xl">
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-3">
          {gateways.map((gateway) => (
            <article key={gateway.id} className="rounded-[8px] border border-slate-200 p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-black text-slate-900">{gateway.name}</h3>
                    <span className={`rounded-lg border px-2.5 py-1 text-xs font-bold ${statusBadgeClass(gateway.status)}`}>{gatewayStatusLabel(gateway.status)}</span>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-slate-500" title={GATEWAY_LABELS[gateway.gateway_type] ? undefined : `技术类型：${gateway.gateway_type || '未返回'}`}>{gatewayTypeLabel(gateway.gateway_type)} · {gateway.base_url || '未填写地址'} · {gateway.system_managed ? '地址与凭证由系统设置托管' : gateway.has_credential ? '凭证已配置' : '未配置凭证'}</p>
                  <p className="mt-1 text-xs text-slate-400">{gateway.last_test_at ? `最近测试：${formatTime(gateway.last_test_at)}` : '尚无连接测试记录'}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {gateway.system_managed ? (
                    <button type="button" onClick={() => { window.location.href = '/settings' }} disabled={Boolean(busy)} className="rounded-lg bg-blue-50 px-3 py-2 text-xs font-black text-blue-700 disabled:cursor-not-allowed disabled:opacity-50">系统设置</button>
                  ) : (
                    <button type="button" onClick={() => onEdit(gateway)} disabled={Boolean(busy)} className="rounded-lg bg-blue-50 px-3 py-2 text-xs font-black text-blue-700 disabled:cursor-not-allowed disabled:opacity-50">编辑</button>
                  )}
                  <button type="button" onClick={() => onTest(gateway)} disabled={Boolean(busy && busy !== `gateway-test-${gateway.id}`)} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-black text-slate-600 disabled:cursor-not-allowed disabled:opacity-50">
                    {busy === `gateway-test-${gateway.id}` ? <X size={13} /> : null}
                    {busy === `gateway-test-${gateway.id}` ? '取消等待' : '测试'}
                  </button>
                  <button type="button" onClick={() => onSync(gateway)} disabled={Boolean(busy && busy !== `gateway-sync-${gateway.id}`)} className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 px-3 py-2 text-xs font-black text-emerald-700 disabled:cursor-not-allowed disabled:opacity-50">
                    {busy === `gateway-sync-${gateway.id}` ? <X size={13} /> : null}
                    {busy === `gateway-sync-${gateway.id}` ? '取消等待' : '同步'}
                  </button>
                  {!gateway.system_managed ? (
                    <button type="button" onClick={() => onDelete(gateway)} disabled={Boolean(busy && busy !== `gateway-delete-${gateway.id}`)} className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 px-3 py-2 text-xs font-black text-rose-600 disabled:cursor-not-allowed disabled:opacity-50">
                      {busy === `gateway-delete-${gateway.id}` ? <X size={13} /> : null}
                      {busy === `gateway-delete-${gateway.id}` ? '取消等待' : '删除'}
                    </button>
                  ) : null}
                </div>
              </div>
            </article>
          ))}
        </div>
        <div className="rounded-[8px] bg-slate-50 p-4">
          <div className="flex items-center justify-between">
            <h3 className="font-black text-slate-900">{editing ? '编辑网关' : '新增网关'}</h3>
            <button type="button" onClick={onNew} className="inline-flex min-h-8 items-center rounded-[6px] px-2 text-xs font-black text-blue-700 hover:bg-blue-50">新建</button>
          </div>
          <fieldset disabled={Boolean(busy)} className="mt-4 space-y-3 disabled:opacity-70">
            <Field label="网关名称"><input value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value })} className={DEVICE_FIELD_CLASS} placeholder="例如：实验室 Matter 网关" /></Field>
            <div><span className="mb-2 block text-sm font-black text-slate-700">网关类型</span><UnifiedSelect ariaLabel="网关类型" value={form.gateway_type} options={Object.entries(GATEWAY_LABELS).map(([value, label]) => ({ value, label }))} onChange={(value) => onChange({ ...form, gateway_type: value })} /></div>
            <Field label="服务地址"><input value={form.base_url} onChange={(event) => onChange({ ...form, base_url: event.target.value })} className={DEVICE_FIELD_CLASS} placeholder="例如：http://host:8123" /></Field>
            <Field label="服务端口（可选）"><input type="number" min="1" max="65535" value={form.port || ''} onChange={(event) => onChange({ ...form, port: event.target.value ? Number(event.target.value) : null })} className={DEVICE_FIELD_CLASS} placeholder="例如：8123" /></Field>
            <div><span className="mb-2 block text-sm font-black text-slate-700">鉴权方式</span><UnifiedSelect ariaLabel="鉴权方式" value={form.auth_type} options={[{ value: 'none', label: '无鉴权' }, { value: 'bearer', label: 'Bearer Token' }, { value: 'basic', label: '账号密码' }, { value: 'apikey', label: 'API Key' }]} onChange={(value) => onChange({ ...form, auth_type: value })} /></div>
            <Field label="访问凭证"><input type="password" autoComplete="new-password" value={form.credential || ''} onChange={(event) => onChange({ ...form, credential: event.target.value })} className={DEVICE_FIELD_CLASS} placeholder="留空或保留掩码则不替换" /></Field>
            <Field label="接入说明"><textarea value={form.description} onChange={(event) => onChange({ ...form, description: event.target.value })} className={`${DEVICE_FIELD_CLASS} min-h-24 resize-y`} placeholder="填写硬件位置、用途或协议备注" /></Field>
            <label className="flex items-center gap-3 text-sm font-bold text-slate-700"><input type="checkbox" checked={form.enabled} onChange={(event) => onChange({ ...form, enabled: event.target.checked })} className={CHECKBOX_CLASS} />启用网关</label>
          </fieldset>
          <button type="button" onClick={onSubmit} disabled={Boolean(busy && busy !== 'gateway-save')} className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-[8px] bg-blue-600 px-4 py-3 text-sm font-black text-white disabled:opacity-60">
            {busy === 'gateway-save' ? <X size={16} /> : <ServerCog size={16} />}
            {busy === 'gateway-save' ? '取消等待' : '保存网关'}
          </button>
        </div>
      </div>
    </AppDialog>
  )
}

function DeviceDetail({ device, detailLoading, detailError, onCancelDetailWait, controlInFlight, canManage, managementDisabled, controlDisabled, onClose, onControl, onCancelControl, onEdit }: {
  device: LogicalDevice
  detailLoading: boolean
  detailError: string
  onCancelDetailWait: () => void
  controlInFlight: ControlInFlightMap
  canManage: boolean
  managementDisabled: boolean
  controlDisabled: boolean
  onClose: () => void
  onControl: DeviceControlHandler
  onCancelControl: DeviceControlCancelHandler
  onEdit: (device: LogicalDevice) => void
}) {
  const [logPage, setLogPage] = useState(1)
  const [logPageSize, setLogPageSize] = useState(5)
  const [logsResponse, setLogsResponse] = useState<OperationLogsResponse | null>(null)
  const [logsLoaded, setLogsLoaded] = useState(false)
  const [loadedLogPage, setLoadedLogPage] = useState(1)
  const [loadedLogPageSize, setLoadedLogPageSize] = useState(5)
  const [logsLoading, setLogsLoading] = useState(true)
  const [logsError, setLogsError] = useState('')
  const logsRequestRef = useRef(0)
  const logsAbortRef = useRef<AbortController | null>(null)

  const loadDeviceLogs = useCallback(async (force = false) => {
    logsAbortRef.current?.abort()
    const controller = new AbortController()
    logsAbortRef.current = controller
    const requestId = ++logsRequestRef.current
    setLogsLoading(true)
    setLogsError('')
    try {
      const response = await fetchDeviceOperationLogs(device.id, logPage, logPageSize, force, controller.signal)
      if (!controller.signal.aborted && logsRequestRef.current === requestId) {
        setLogsResponse(response)
        const responsePage = response.page || logPage
        const responsePageSize = [5, 10, 20].includes(response.size || 0) ? response.size! : logPageSize
        setLoadedLogPage(responsePage)
        setLoadedLogPageSize(responsePageSize)
        setLogsLoaded(true)
        if (responsePage !== logPage) setLogPage(responsePage)
        if (responsePageSize !== logPageSize) setLogPageSize(responsePageSize)
      }
    } catch (error) {
      if (logsRequestRef.current === requestId) {
        setLogsError(businessErrorMessage(error, { fallback: '设备控制日志加载失败', service: '设备日志' }))
      }
    } finally {
      if (logsAbortRef.current === controller) logsAbortRef.current = null
      if (logsRequestRef.current === requestId) setLogsLoading(false)
    }
  }, [device.id, logPage, logPageSize])

  useEffect(() => {
    void loadDeviceLogs()
  }, [loadDeviceLogs])

  useEffect(() => {
    if (!logsError) return

    const recoverFailedLogs = () => {
      if (!navigator.onLine || document.visibilityState !== 'visible' || logsAbortRef.current) return
      void loadDeviceLogs(true)
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') recoverFailedLogs()
    }

    window.addEventListener('online', recoverFailedLogs)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('online', recoverFailedLogs)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [loadDeviceLogs, logsError])

  useEffect(() => () => {
    logsRequestRef.current += 1
    logsAbortRef.current?.abort()
    logsAbortRef.current = null
  }, [])

  const deviceLogs = logsResponse?.logs || []
  const deviceLogTotal = logsResponse?.total || 0
  const deviceLogScope = logsResponse?.visibility_scope || (canManage ? 'all' : 'self')
  const logSnapshotMatchesView = logsLoaded
    && loadedLogPage === logPage
    && loadedLogPageSize === logPageSize

  return (
    <AppDrawer
      title={device.name}
      description={<><span>{displayDeviceDescription(device)}</span><span className="mt-1 block text-xs font-bold text-slate-400">{device.gateway_name || '未绑定网关'} · {device.location || '未填写位置'}</span></>}
      onClose={onClose}
      widthClassName="max-w-2xl"
      headerActions={canManage ? <button type="button" onClick={() => onEdit(device)} disabled={managementDisabled} title={managementDisabled ? '请等待设备台账刷新成功' : '编辑设备'} className="inline-flex h-9 w-9 items-center justify-center rounded-[6px] border border-blue-100 bg-blue-50 text-blue-700 disabled:cursor-not-allowed disabled:opacity-45" aria-label="编辑设备"><Pencil size={18} /></button> : null}
    >
        <div>
          {detailLoading ? (
            <div className="mb-4 flex flex-col items-start gap-2 border-l-2 border-blue-500 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-800 sm:flex-row sm:items-center sm:justify-between sm:gap-3" role="status">
              <span className="flex min-w-0 items-center gap-2"><Loader2 size={14} className="shrink-0 animate-spin" />正在补充设备实时详情，当前先显示列表快照。</span>
              <button type="button" onClick={onCancelDetailWait} className="shrink-0 self-end rounded-[6px] border border-blue-200 bg-white px-2.5 py-1.5 font-bold text-blue-700 hover:bg-blue-100 sm:self-auto">取消等待</button>
            </div>
          ) : detailError ? (
            <div className="mb-4 border-l-2 border-amber-400 bg-amber-50 px-3 py-2 text-xs font-semibold leading-5 text-amber-800">{detailError} 当前显示的设备信息来自列表最近成功快照。</div>
          ) : null}
          {Object.entries(device.entities || {}).map(([role, entity]) => {
            const actions = entity.control_actions || []
            const entityControlBusy = isEntityControlBusy(controlInFlight, entity.entity_id)
            const activeControl = currentEntityControl(controlInFlight, entity.entity_id)
            return (
              <section key={role} className="border-b border-slate-200 py-5 first:pt-0">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0">
                    <div className="text-sm font-bold text-slate-800">{formatEntityRole(role)}</div>
                    <div className="mt-2 text-xs text-slate-500">最近变化：{formatTime(entity.last_changed)}</div>
                    <details className="mt-2 text-xs text-slate-500">
                      <summary className="cursor-pointer font-semibold transition hover:text-blue-700">技术信息</summary>
                      <TechnicalId value={entity.entity_id} label="Home Assistant 实体" className="mt-2 max-w-md" />
                    </details>
                  </div>
                  <div className="shrink-0 text-right">
                    <span className={`inline-flex rounded-[6px] border px-3 py-1 text-xs font-bold ${entityOnline(entity) ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50 text-amber-700'}`}>{formatEntityState(entity)}</span>
                    {entity.physical_confirmation === 'physical_pending' ? <p className="mt-1 max-w-52 text-xs font-semibold leading-5 text-amber-700">HA 状态回报，物理设备待现场确认</p> : null}
                  </div>
                </div>
                <div className="mt-4 space-y-3">
                  {entityControlBusy && activeControl ? <ControlWaitStatus control={activeControl} onCancel={() => onCancelControl(entity.entity_id)} /> : null}
                  <CapabilityControls device={device} role={role} entity={entity} controlInFlight={controlInFlight} controlDisabled={controlDisabled || Boolean(detailError)} onControl={onControl} />
                  {!actions.length ? <span className="inline-flex border-l-2 border-slate-300 px-3 py-1 text-sm font-semibold text-slate-500">只读实体</span> : null}
                </div>
              </section>
            )
          })}
          {!Object.keys(device.entities || {}).length ? <div className="border-l-2 border-amber-400 bg-amber-50 p-5 text-sm font-semibold text-amber-800">该设备暂无实体映射。</div> : null}
          <section className="py-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="font-black text-slate-900">控制日志</div>
                <div className="mt-1 text-xs text-slate-500">
                  {deviceLogScope === 'all' ? '统计当前设备全部映射实体的真实控制记录。' : '仅展示您对当前设备执行的真实控制记录。'}
                </div>
              </div>
              <button type="button" onClick={() => void loadDeviceLogs(true)} disabled={logsLoading} className="rounded-[8px] border border-slate-200 p-2 text-slate-500 hover:text-blue-700 disabled:opacity-50" aria-label="刷新设备日志">
                <RefreshCw size={16} className={logsLoading ? 'animate-spin' : ''} />
              </button>
            </div>
            <div className="mt-3 divide-y divide-slate-100 border-y border-slate-100">
              {deviceLogs.map((log) => {
                const parsed = parseLogDetail(String(log.detail || ''))
                return (
                  <article key={String(log.id)} className="px-1 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="line-clamp-2 text-sm font-bold leading-5 text-slate-800" title={displayLogTitle(log as OperationLogItem, parsed)}>{displayLogTitle(log as OperationLogItem, parsed)}</div>
                        <div className="mt-1 text-xs text-slate-500">{[parsed.action, parsed.result, parsed.state].filter(Boolean).join(' · ') || '已记录设备操作'}</div>
                      </div>
                      <div className="shrink-0 text-xs font-semibold text-slate-400">{formatTime(String(log.created_at || ''))}</div>
                    </div>
                    {parsed.raw ? <details className="mt-2 text-xs text-slate-500"><summary className="cursor-pointer font-semibold">技术详情</summary><TechnicalId value={parsed.raw} label="原始日志" className="mt-2" /></details> : null}
                  </article>
                )
              })}
              {logsLoading && !logsResponse ? <div className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-slate-500"><Loader2 size={16} className="animate-spin" />正在加载控制日志</div> : null}
              {logsError ? <div className="border-l-2 border-rose-400 bg-rose-50 px-3 py-4 text-sm text-rose-700">{logsError}</div> : null}
              {!logsLoading && !logsError && !deviceLogs.length ? <div className="px-3 py-6 text-center text-sm text-slate-500">{deviceLogScope === 'all' ? '暂无该设备控制日志。' : '您尚未对该设备执行控制。'}</div> : null}
            </div>
            {logsLoaded ? <Pagination
              page={loadedLogPage}
              pageSize={loadedLogPageSize}
              total={deviceLogTotal}
              loading={logsLoading}
              navigationDisabled={!logSnapshotMatchesView}
              onPageChange={(value) => {
                if (!logSnapshotMatchesView) return
                logsAbortRef.current?.abort()
                logsRequestRef.current += 1
                setLogsLoading(true)
                setLogPage(value)
              }}
              onPageSizeChange={(value) => {
                if (!logSnapshotMatchesView || value === logPageSize) return
                logsAbortRef.current?.abort()
                logsRequestRef.current += 1
                setLogsLoading(true)
                setLogPageSize(value)
                setLogPage(1)
              }}
              pageSizeOptions={[5, 10, 20]}
              className="mt-3 px-0 pb-0"
              itemName="条日志"
            /> : null}
          </section>
        </div>
    </AppDrawer>
  )
}

function LogsPanel({ response, loaded, loading, error, page, pageSize, navigationDisabled, onPageChange, onPageSizeChange, onClose, onRefresh }: {
  response: OperationLogsResponse | null
  loaded: boolean
  loading: boolean
  error: string
  page: number
  pageSize: number
  navigationDisabled: boolean
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: number) => void
  onClose: () => void
  onRefresh: () => void
}) {
  const logs = response?.logs || []
  const total = response?.total || 0

  return (
    <AppDrawer
      title="最近操作日志"
      description="来自平台操作审计，用于核对设备控制链路。"
      onClose={onClose}
      widthClassName="max-w-xl"
      zIndexClassName="z-[130]"
      headerActions={<button type="button" onClick={onRefresh} disabled={loading} className="inline-flex h-9 w-9 items-center justify-center rounded-[6px] border border-slate-200 text-slate-500 hover:text-blue-700 disabled:opacity-50" aria-label="刷新日志"><RefreshCw size={18} className={loading ? 'animate-spin' : ''} /></button>}
    >
        <div className="overflow-hidden rounded-[8px] border border-slate-200 divide-y divide-slate-100">
          {logs.map((log) => {
            const parsed = parseLogDetail(log.detail)
            return (
              <article key={log.id} className="px-4 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="line-clamp-2 font-bold leading-5 text-slate-900" title={displayLogTitle(log, parsed)}>{displayLogTitle(log, parsed)}</div>
                    <div className="mt-1 text-sm leading-6 text-slate-600">{[parsed.action, parsed.result, parsed.state].filter(Boolean).join(' · ') || '已记录设备操作'}</div>
                  </div>
                  <StatusBadge status={log.level} />
                </div>
                <div className="mt-2 flex items-center justify-between gap-3 text-xs text-slate-400">
                  <span>{formatTime(log.created_at || log.time)}</span>
                  {parsed.raw ? <details className="min-w-0"><summary className="cursor-pointer font-semibold text-slate-500">技术详情</summary><TechnicalId value={parsed.raw} label="原始日志" className="mt-2 min-w-0 max-w-full" /></details> : null}
                </div>
              </article>
            )
          })}
          {loading && !loaded ? <div className="flex min-h-40 items-center justify-center gap-2 px-4 text-sm text-slate-500"><Loader2 size={17} className="animate-spin" />正在加载设备操作日志</div> : null}
          {loading && loaded ? <div className="border-l-2 border-blue-500 bg-blue-50 px-4 py-3 text-sm font-semibold text-blue-700"><Loader2 size={14} className="mr-2 inline animate-spin" />正在更新日志，当前继续显示上一次成功快照。</div> : null}
          {error ? <div className="border-l-2 border-rose-400 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}{loaded ? logs.length ? '；继续显示上一次成功日志快照。' : '；继续保留上一次成功读取的空日志快照。' : '；设备操作日志尚未取得。'}</div> : null}
          {!loading && loaded && !logs.length ? <EmptyState title="暂无设备操作日志" description="执行设备控制后，确认式回读记录会显示在这里。" /> : null}
        </div>
        {loaded ? <Pagination page={page} pageSize={pageSize} total={total} loading={loading} navigationDisabled={navigationDisabled} onPageChange={onPageChange} onPageSizeChange={onPageSizeChange} pageSizeOptions={[10, 20, 50]} className="mt-3 px-0" itemName="条日志" /> : null}
    </AppDrawer>
  )
}

function DeleteDeviceDialog({ device, busy, onClose, onConfirm }: { device: LogicalDevice; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  return (
    <AppDialog title="删除设备台账" description={`将删除「${device.name}」的平台台账和映射，不会删除 HA 或真实硬件中的实体。`} onClose={onClose} maxWidth="max-w-md" danger footer={(
      <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
        <button type="button" onClick={onClose} disabled={busy} className="rounded-[8px] border border-slate-200 px-5 py-3 text-sm font-black text-slate-700 disabled:opacity-60">取消</button>
        <button type="button" onClick={onConfirm} className="inline-flex items-center justify-center gap-2 rounded-[8px] bg-rose-600 px-5 py-3 text-sm font-black text-white disabled:opacity-60">
          {busy ? <X size={16} /> : <Trash2 size={16} />}
          {busy ? '取消等待' : '确认删除'}
        </button>
      </div>
    )}>
      <div className="rounded-[8px] bg-rose-50 p-4 text-sm font-semibold leading-7 text-rose-700">删除后可重新添加设备并配置映射。</div>
    </AppDialog>
  )
}

function SyncCandidatesDialog({
  candidates,
  devices,
  devicesTruncated,
  busy,
  onCreate,
  onAttach,
  onImport,
  onClose,
}: {
  candidates: GatewaySyncCandidate[]
  devices: LogicalDevice[]
  devicesTruncated: boolean
  busy: boolean
  onCreate: (candidate: GatewaySyncCandidate) => void
  onAttach: (candidate: GatewaySyncCandidate, deviceId: string) => void
  onImport: (entityIds: string[]) => void
  onClose: () => void
}) {
  const [targetDeviceId, setTargetDeviceId] = useState(devices[0]?.id || '')
  const [targetDeviceKeyword, setTargetDeviceKeyword] = useState('')
  const debouncedTargetDeviceKeyword = useDebouncedValue(targetDeviceKeyword.trim())
  const [remoteTargetDeviceOptions, setRemoteTargetDeviceOptions] = useState<LogicalDevice[]>([])
  const [targetDeviceLoading, setTargetDeviceLoading] = useState(false)
  const [targetDeviceError, setTargetDeviceError] = useState('')
  const [targetDeviceTotal, setTargetDeviceTotal] = useState(devices.length)
  const targetDeviceRequestRef = useRef(0)
  const targetDeviceAbortRef = useRef<AbortController | null>(null)
  const [candidateView, setCandidateView] = useState<CandidateView>('recommended')
  const [candidateKeyword, setCandidateKeyword] = useState('')
  const [candidatePage, setCandidatePage] = useState(1)
  const [candidatePageSize, setCandidatePageSize] = useState(10)
  const normalizedCandidateKeyword = candidateKeyword.trim().toLowerCase()
  const filteredCandidates = candidates.filter((item) => {
    if (candidateView === 'recommended') return Boolean(item.recommended || item.mapped)
    if (candidateView === 'hardware') return item.classification === 'hardware'
    return true
  }).filter((item) => {
    if (!normalizedCandidateKeyword) return true
    return [
      item.name,
      item.device_name,
      item.manufacturer,
      item.model,
      item.area_name,
      candidatePlatformLabel(item.platform),
      candidateDomainLabel(item),
      item.entity_id,
    ].some((value) => String(value || '').toLowerCase().includes(normalizedCandidateKeyword))
  })
  const candidatePageCount = Math.max(1, Math.ceil(filteredCandidates.length / candidatePageSize))
  const safeCandidatePage = Math.min(candidatePage, candidatePageCount)
  const visibleCandidates = filteredCandidates.slice((safeCandidatePage - 1) * candidatePageSize, safeCandidatePage * candidatePageSize)
  const importableCandidates = visibleCandidates.filter((item) => !item.mapped && item.importable !== false && item.recommended !== false)
  const [selectedEntityIds, setSelectedEntityIds] = useState<string[]>([])
  const allSelected = importableCandidates.length > 0 && importableCandidates.every((item) => selectedEntityIds.includes(item.entity_id))
  const hardwareCount = candidates.filter((item) => item.classification === 'hardware').length
  const helperCount = candidates.filter((item) => item.classification === 'helper').length
  const recommendedCount = candidates.filter((item) => item.recommended && !item.mapped).length

  useEffect(() => {
    if (!debouncedTargetDeviceKeyword || !devicesTruncated) {
      targetDeviceRequestRef.current += 1
      targetDeviceAbortRef.current?.abort()
      targetDeviceAbortRef.current = null
      return
    }

    targetDeviceAbortRef.current?.abort()
    const controller = new AbortController()
    targetDeviceAbortRef.current = controller
    const requestId = ++targetDeviceRequestRef.current
    const timer = window.setTimeout(() => {
      setTargetDeviceLoading(true)
      setTargetDeviceError('')
      void fetchDevices({
        page: 1,
        size: 20,
        keyword: debouncedTargetDeviceKeyword,
        sort: 'name',
        signal: controller.signal,
      }).then((response) => {
        if (controller.signal.aborted || targetDeviceRequestRef.current !== requestId) return
        setRemoteTargetDeviceOptions(response.devices || [])
        setTargetDeviceTotal(response.total)
      }).catch((searchError) => {
        if (controller.signal.aborted || targetDeviceRequestRef.current !== requestId) return
        setTargetDeviceError(businessErrorMessage(searchError, { fallback: '目标设备搜索失败', service: '设备台账' }))
      }).finally(() => {
        if (targetDeviceAbortRef.current === controller) targetDeviceAbortRef.current = null
        if (targetDeviceRequestRef.current === requestId) setTargetDeviceLoading(false)
      })
    }, 0)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [debouncedTargetDeviceKeyword, devicesTruncated])

  useEffect(() => () => {
    targetDeviceRequestRef.current += 1
    targetDeviceAbortRef.current?.abort()
    targetDeviceAbortRef.current = null
  }, [])

  const normalizedTargetDeviceKeyword = debouncedTargetDeviceKeyword.toLowerCase()
  const localTargetDeviceOptions = normalizedTargetDeviceKeyword
    ? devices.filter((device) => [device.name, device.location, device.brand, device.model]
      .some((value) => String(value || '').toLowerCase().includes(normalizedTargetDeviceKeyword)))
    : devices
  const targetDeviceOptions = normalizedTargetDeviceKeyword && devicesTruncated
    ? remoteTargetDeviceOptions
    : localTargetDeviceOptions
  const visibleTargetDeviceTotal = normalizedTargetDeviceKeyword
    ? devicesTruncated ? targetDeviceTotal : localTargetDeviceOptions.length
    : devices.length
  const visibleTargetDeviceLoading = Boolean(normalizedTargetDeviceKeyword && devicesTruncated && targetDeviceLoading)
  const visibleTargetDeviceError = normalizedTargetDeviceKeyword && devicesTruncated ? targetDeviceError : ''
  const selectedTargetDevice = [...devices, ...targetDeviceOptions].find((device) => String(device.id) === String(targetDeviceId))
  const selectableTargetDevices = selectedTargetDevice && !targetDeviceOptions.some((device) => device.id === selectedTargetDevice.id)
    ? [selectedTargetDevice, ...targetDeviceOptions]
    : targetDeviceOptions

  const toggleAll = () => {
    const pageEntityIds = new Set(importableCandidates.map((item) => item.entity_id))
    setSelectedEntityIds((current) => allSelected
      ? current.filter((item) => !pageEntityIds.has(item))
      : Array.from(new Set([...current, ...pageEntityIds])))
  }

  const toggleCandidate = (entityId: string) => {
    setSelectedEntityIds((current) => current.includes(entityId)
      ? current.filter((item) => item !== entityId)
      : [...current, entityId])
  }

  return (
    <AppDialog title="HA 设备发现与导入" description={`本次读取 ${candidates.length} 个实体，识别 ${hardwareCount} 个真实硬件实体、${helperCount} 个辅助实体。`} onClose={onClose} maxWidth="max-w-6xl">
      <div className="mb-4 rounded-[8px] bg-blue-50 px-4 py-3 text-sm leading-6 text-blue-800">
        默认只显示推荐的真实硬件实体。批量导入会按 HA device_id 聚合，同一物理设备的多个实体归入同一台平台设备；HA Helper、系统实体和诊断实体不会被批量导入。
      </div>
      {devicesTruncated ? <div className="mb-4 rounded-[8px] border border-blue-200 bg-blue-50 px-4 py-3 text-sm leading-6 text-blue-800">平台设备超过 100 台。默认展示前 100 台，输入目标设备名称、位置、品牌或型号后会从完整台账搜索。</div> : null}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {([
          { value: 'recommended', label: `推荐导入 ${recommendedCount}` },
          { value: 'hardware', label: `全部硬件 ${hardwareCount}` },
          { value: 'all', label: `全部实体 ${candidates.length}` },
        ] as const).map((item) => (
          <button key={item.value} type="button" onClick={() => { setCandidateView(item.value); setCandidatePage(1) }} className={`rounded-lg px-3 py-2 text-xs font-black ${candidateView === item.value ? 'bg-blue-600 text-white' : 'border border-slate-200 bg-white text-slate-600'}`}>{item.label}</button>
        ))}
      </div>
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center">
          <label className="relative min-w-0 sm:w-64">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={candidateKeyword}
              onChange={(event) => { setCandidateKeyword(event.target.value); setCandidatePage(1) }}
              className={`${DEVICE_FIELD_CLASS} pl-9`}
              placeholder="搜索名称、型号、位置或实体"
              aria-label="搜索发现的 Home Assistant 实体"
            />
          </label>
          <div className="min-w-0 flex-1 sm:min-w-[320px]">
            <div className="mb-2 flex items-center justify-between gap-3 text-sm font-black text-slate-700">
              <span>追加映射目标设备</span>
              <span className="text-xs font-semibold text-slate-400">{visibleTargetDeviceLoading ? '正在搜索' : `匹配 ${visibleTargetDeviceTotal} 台`}</span>
            </div>
            <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(150px,0.8fr)_minmax(220px,1.2fr)]">
              <label className="relative min-w-0">
                <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  value={targetDeviceKeyword}
                  onChange={(event) => setTargetDeviceKeyword(event.target.value)}
                  className={`${DEVICE_FIELD_CLASS} pl-9`}
                  placeholder="搜索目标设备"
                  aria-label="搜索追加映射目标设备"
                />
              </label>
              <UnifiedSelect
                ariaLabel="追加映射目标设备"
                value={targetDeviceId}
                options={selectableTargetDevices.map((device) => ({
                  value: String(device.id),
                  label: `${device.name}${device.location ? ` · ${device.location}` : ''}`,
                }))}
                onChange={setTargetDeviceId}
                disabled={visibleTargetDeviceLoading || Boolean(visibleTargetDeviceError)}
                placeholder={visibleTargetDeviceLoading ? '正在搜索设备' : visibleTargetDeviceError ? '搜索失败' : '没有匹配设备'}
              />
            </div>
            {visibleTargetDeviceError ? <p className="mt-2 text-xs font-semibold leading-5 text-rose-600">{visibleTargetDeviceError}</p> : null}
          </div>
        </div>
        <button type="button" onClick={() => onImport(selectedEntityIds)} disabled={!busy && !selectedEntityIds.length} className="inline-flex items-center justify-center gap-2 rounded-[8px] bg-blue-600 px-4 py-2.5 text-sm font-black text-white disabled:cursor-not-allowed disabled:opacity-50">
          {busy ? <X size={16} /> : <Plus size={16} />}
          {busy ? '取消等待' : `批量导入${selectedEntityIds.length ? ` (${selectedEntityIds.length})` : ''}`}
        </button>
      </div>
      {selectedEntityIds.length ? <div className="mb-3 text-xs font-semibold text-blue-700">已跨页选择 {selectedEntityIds.length} 个可导入实体。</div> : null}
      <div className="max-h-[60vh] overflow-auto rounded-[8px] border border-slate-200" tabIndex={0} role="region" aria-label="Home Assistant 候选实体列表，可横向滚动">
        <table className="min-w-[1100px] w-full table-fixed text-left text-sm">
          <colgroup><col className="w-[52px]" /><col className="w-[230px]" /><col className="w-[190px]" /><col className="w-[180px]" /><col className="w-[120px]" /><col className="w-[110px]" /><col className="w-[210px]" /><col className="w-[190px]" /></colgroup>
          <thead className="bg-slate-50 text-xs font-black text-slate-400">
            <tr>
              <th className="px-4 py-3"><input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="选择当前页全部可导入实体" className={CHECKBOX_CLASS} /></th>
              <th className="px-4 py-3">实体名称</th><th className="px-4 py-3">设备与型号</th><th className="px-4 py-3">位置与接入</th><th className="px-4 py-3">能力</th><th className="px-4 py-3">当前值</th><th className="px-4 py-3">导入判断</th><th className="px-4 py-3 text-right">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {visibleCandidates.map((item) => (
              <tr key={item.entity_id}>
                <td className="px-4 py-3"><input type="checkbox" checked={selectedEntityIds.includes(item.entity_id)} onChange={() => toggleCandidate(item.entity_id)} disabled={item.mapped || item.importable === false || item.recommended === false} aria-label={`选择 ${item.name}`} className={CHECKBOX_CLASS} /></td>
                <td className="px-4 py-3">
                  <div className="truncate font-semibold text-slate-900" title={item.name || item.entity_id}>{item.name || '未命名实体'}</div>
                  <details className="mt-1 text-xs text-slate-400">
                    <summary className="cursor-pointer font-semibold hover:text-slate-600">技术信息</summary>
                    <div className="mt-2"><TechnicalId value={item.entity_id} label="HA 实体" compact /></div>
                  </details>
                </td>
                <td className="px-4 py-3"><div className="truncate font-semibold text-slate-800" title={item.device_name || item.name}>{item.device_name || item.name || '未识别物理设备'}</div><div className="mt-1 truncate text-xs text-slate-400" title={[item.manufacturer, item.model].filter(Boolean).join(' · ')}>{[item.manufacturer, item.model].filter(Boolean).join(' · ') || '厂商型号未取得'}</div></td>
                <td className="px-4 py-3"><div className="truncate text-slate-700" title={item.area_name || '未分配区域'}>{item.area_name || '未分配区域'}</div><div className="mt-1 truncate text-xs text-slate-400" title={candidatePlatformLabel(item.platform)}>{candidatePlatformLabel(item.platform)}</div></td>
                <td className="truncate px-4 py-3 text-slate-600" title={candidateDomainLabel(item)}>{candidateDomainLabel(item)}</td>
                <td className="truncate px-4 py-3 font-semibold text-slate-700" title={candidateStateLabel(item)}>{candidateStateLabel(item)}</td>
                <td className="px-4 py-3"><span className={`inline-flex rounded-[6px] px-2.5 py-1 text-xs font-black ${item.mapped ? 'bg-emerald-50 text-emerald-700' : item.recommended ? 'bg-blue-50 text-blue-700' : item.classification === 'helper' ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>{item.mapped ? '已映射' : item.recommended ? '推荐硬件' : item.classification === 'hardware' ? '硬件附属实体' : item.classification === 'helper' ? '辅助实体' : '系统/未注册'}</span><div className="mt-2 line-clamp-2 text-xs leading-5 text-slate-400" title={item.classification_reason || '未返回判断说明'}>{item.classification_reason || '未返回判断说明'}</div></td>
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-2">
                    <button type="button" onClick={() => onCreate(item)} disabled={item.mapped || item.importable === false} className="rounded-lg bg-blue-50 px-3 py-2 text-xs font-black text-blue-700 disabled:cursor-not-allowed disabled:opacity-50">创建设备</button>
                    <button type="button" onClick={() => onAttach(item, targetDeviceId)} disabled={item.mapped || item.importable === false || !targetDeviceId} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-black text-slate-700 disabled:cursor-not-allowed disabled:opacity-50">加入映射</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!visibleCandidates.length ? <div className="px-5 py-10 text-center text-sm text-slate-500">{candidateKeyword.trim() ? '当前筛选下没有匹配实体。' : '当前分类下没有候选实体。'}</div> : null}
      </div>
      <Pagination
        page={safeCandidatePage}
        pageSize={candidatePageSize}
        total={filteredCandidates.length}
        onPageChange={setCandidatePage}
        onPageSizeChange={(size) => { setCandidatePageSize(size); setCandidatePage(1) }}
        pageSizeOptions={[10, 20, 50]}
        itemName="个候选实体"
        className="px-0 pb-0"
      />
    </AppDialog>
  )
}

export default function DevicesPage() {
  return (
    <Suspense fallback={<div className="mx-auto max-w-[1600px] py-20 text-center text-sm text-slate-400">正在读取设备台账...</div>}>
      <DevicesContent />
    </Suspense>
  )
}

function Field({ label, children, className = '' }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-2 block text-sm font-black text-slate-700">{label}</span>
      {children}
    </label>
  )
}
