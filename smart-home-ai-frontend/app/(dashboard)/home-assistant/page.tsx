'use client'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Home,
  Layers,
  Loader2,
  Network,
  RefreshCw,
  Search,
  ShieldAlert,
} from 'lucide-react'
import {
  fetchDeviceHealth,
  fetchDevices,
  fetchHomeAssistantWorkspace,
  type DeviceHealth,
  type DeviceListResponse,
  type HomeAssistantWorkspaceItem,
  type HomeAssistantWorkspaceResponse,
} from '@/lib/api/devices'
import { settingsApi, testServiceConnection, type RuntimeSettings, type TestConnectionResult } from '@/lib/api/system'
import { AppDialog } from '@/components/ui/AppDialog'
import { AppDrawer } from '@/components/ui/AppDrawer'
import { Pagination } from '@/components/ui/Pagination'
import { TechnicalId } from '@/components/ui/TechnicalId'
import { UnifiedSelect } from '@/components/ui/UnifiedSelect'
import { toast } from '@/components/ui/toast'
import { handleTabListKeyDown } from '@/lib/ui/tabs'
import { businessErrorMessage } from '@/lib/ui/business-error'
import { useAuth } from '@/lib/hooks/useAuth'

const DISCOVERY_VIEWS = ['entities', 'diagnostics'] as const

function discoveryViewKey(params: {
  keyword: string
  classification: string
  domain: string
  mapped: string
  status: string
  page: number
  size: number
  diagnosticPage: number
  diagnosticSize: number
}) {
  return JSON.stringify({ ...params, keyword: params.keyword.trim() })
}

function mappedViewKey(page: number, size: number) {
  return JSON.stringify({ page, size })
}

type MainResourceKey = 'settings' | 'health' | 'devices'

const MAIN_RESOURCE_KEYS: MainResourceKey[] = ['settings', 'health', 'devices']

const ROLE_LABELS: Record<string, string> = {
  power: '运行状态',
  brightness: '亮度',
  temperature: '温度',
  humidity: '湿度',
  mode: '运行模式',
  lock: '门锁状态',
  door: '门磁状态',
  value: '传感器数值',
}

const CATEGORY_LABELS: Record<string, string> = {
  light: '灯光',
  switch: '开关',
  sensor: '传感器',
  climate: '温控',
  lock: '门锁',
  binary_sensor: '门磁/安防',
}

const CLASSIFICATION_LABELS: Record<string, string> = {
  hardware: '设备关联实体',
  helper: 'HA 辅助实体',
  system: '系统实体',
  unregistered: '未登记实体',
}

const DOMAIN_LABELS: Record<string, string> = {
  binary_sensor: '二值传感器',
  button: '按钮',
  climate: '空调',
  cover: '窗帘 / 遮罩',
  event: '事件',
  fan: '风扇',
  input_boolean: '辅助开关',
  input_number: '辅助数值',
  input_select: '辅助选项',
  light: '灯光',
  lock: '门锁',
  media_player: '媒体设备',
  notify: '通知服务',
  number: '数值设置',
  conversation: '语音助理',
  person: '人员',
  scene: '场景',
  select: '选项设置',
  sensor: '传感器',
  sun: '日照',
  switch: '开关',
  todo: '待办事项',
  update: '更新实体',
  tts: '语音合成',
  weather: '天气',
  zone: '区域围栏',
}

const PLATFORM_LABELS: Record<string, string> = {
  xiaomi_home: '小米 Home 集成',
  homeassistant: 'Home Assistant 核心',
  input_boolean: 'HA 辅助开关',
  input_number: 'HA 辅助数值',
  input_select: 'HA 辅助选项',
  backup: '备份服务',
  google_translate: 'Google 翻译',
  met: '天气服务',
  sun: '日照服务',
}

function diagnosticActionLabel(id: string, label: string, isAdmin: boolean) {
  if (isAdmin) return label
  if (id === 'ha-unavailable') return '查看系统状态'
  if (id === 'registry-unavailable') return '查看 HA 配置状态'
  if (id === 'orphan-mappings') return '查看设备台账'
  return label
}

function entityStateLabel(value?: string | null) {
  const text = String(value || '').trim()
  if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
    try {
      JSON.parse(text)
      return '结构化状态（详情查看）'
    } catch {
      // 非法 JSON 继续按普通文本处理。
    }
  }
  const translated = ({
    on: '开启',
    off: '关闭',
    open: '打开',
    closed: '关闭',
    locked: '已上锁',
    unlocked: '未上锁',
    unavailable: '不可用',
    unknown: '未知',
    idle: '空闲',
    rainy: '有雨',
    cloudy: '多云',
    sunny: '晴朗',
    clear_night: '晴朗夜间',
    partlycloudy: '局部多云',
  } as Record<string, string>)[text.toLowerCase()]
  if (translated) return translated
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) return formatDateTime(text)
  if (/^-?\d+(?:\.\d+)?$/.test(text) || /[\u4e00-\u9fff]/.test(text)) return text
  return text ? '状态待确认' : '未知'
}

function entityStateTitle(value?: string | null) {
  const raw = String(value || '').trim()
  const label = entityStateLabel(raw)
  if (!raw || label !== '状态待确认') return label
  return `状态待确认（技术状态：${raw}）`
}

function entityStateClass(value?: string | null) {
  const raw = String(value || '').trim().toLowerCase()
  const label = entityStateLabel(value)
  return ['unavailable', 'unknown'].includes(raw) || label === '状态待确认'
    ? 'bg-amber-50 text-amber-700'
    : 'bg-emerald-50 text-emerald-700'
}

function classificationLabel(value?: string | null) {
  const normalized = String(value || '').trim()
  return CLASSIFICATION_LABELS[normalized] || (normalized ? '其他来源分类' : '来源待确认')
}

function classificationTitle(value?: string | null) {
  const normalized = String(value || '').trim()
  const label = classificationLabel(normalized)
  return normalized && !CLASSIFICATION_LABELS[normalized]
    ? `${label}（技术分类：${normalized}）`
    : label
}

function domainLabel(domain?: string | null) {
  const normalized = String(domain || '').trim()
  return DOMAIN_LABELS[normalized] || (normalized ? '其他实体类型' : '类型待确认')
}

function platformLabel(value?: string | null) {
  const normalized = String(value || '').trim()
  return PLATFORM_LABELS[normalized] || (normalized ? '其他 HA 集成' : '未登记集成')
}

function displayEntityName(value?: string | null) {
  const normalized = String(value || '')
    .replace(/\s*string_fmt\s*:\s*.+$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (!normalized) return '未命名实体'
  const parts = normalized.split(' ')
  const compact = parts.filter((part, index) => {
    const previous = parts[index - 1]
    if (!previous) return true
    if (part === previous) return false
    return !(part.length <= 2 && previous.endsWith(part))
  })
  return (compact.join(' ') || '未命名实体')
    .replace(/^Backup\b/i, '备份')
}

function displayEntityUnit(value?: string | null) {
  const unit = String(value || '').trim()
  return ({ min: '分钟', mins: '分钟', minute: '分钟', minutes: '分钟', h: '小时', hr: '小时', hrs: '小时' } as Record<string, string>)[unit.toLowerCase()] || unit
}

function statusClass(status?: string) {
  if (status === 'running' || status === 'ok') return 'bg-emerald-50 text-emerald-700'
  if (status === 'error') return 'bg-rose-50 text-rose-700'
  if (status === 'stopped') return 'bg-amber-50 text-amber-700'
  return 'bg-slate-50 text-slate-600'
}

function statusLabel(status?: string) {
  if (status === 'running' || status === 'ok') return '正常'
  if (status === 'error') return '异常'
  if (status === 'stopped') return '不可达'
  return '未知'
}

function formatDateTime(value?: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未取得'
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function latencyLabel(value?: number | null) {
  return Number.isFinite(value) && Number(value) > 0 ? `${Math.round(Number(value))} 毫秒` : '耗时未取得'
}

function probeSummary(status: string | undefined, latencyMs: number | null | undefined, testedAt: string) {
  const prefix = status === 'running' ? '实时响应' : '失败用时'
  const duration = latencyLabel(latencyMs)
  const durationSummary = duration === '耗时未取得' ? `${prefix}未取得` : `${prefix} ${duration}`
  return `${durationSummary} · ${formatDateTime(testedAt)}`
}

function manualProbeSummary(status: string | undefined, latencyMs: number | null | undefined, testedAt: string) {
  const duration = latencyLabel(latencyMs)
  const durationSummary = duration === '耗时未取得'
    ? status === 'running' ? '响应用时未取得' : '失败用时未取得'
    : `${status === 'running' ? '响应' : '失败用时'} ${duration}`
  return `${statusLabel(status)} · ${durationSummary} · ${formatDateTime(testedAt)}`
}

function discoveryStateLabel(item: HomeAssistantWorkspaceItem) {
  const label = entityStateLabel(item.state)
  return item.unit && !['unavailable', 'unknown'].includes(String(item.state).toLowerCase()) ? `${label} ${displayEntityUnit(item.unit)}` : label
}

function mappingStatusLabel(item: HomeAssistantWorkspaceItem) {
  if (item.mapped) return `已纳入：${item.platform_device_name || '平台设备'}`
  if (item.recommended) return '建议纳入台账'
  if (item.importable) return '可纳入台账'
  if (item.classification === 'hardware') return '附属实体，无需单独纳入'
  return '无需纳入台账'
}

function HomeAssistantContent() {
  const { isAdmin } = useAuth()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const initialMappedPage = Number(searchParams.get('mappedPage') || 1)
  const initialMappedSize = Number(searchParams.get('mappedSize') || 10)
  const initialDiscoveryPage = Number(searchParams.get('discoveryPage') || 1)
  const initialDiscoverySize = Number(searchParams.get('discoverySize') || 20)
  const initialDiagnosticPage = Number(searchParams.get('diagnosticPage') || 1)
  const initialDiagnosticSize = Number(searchParams.get('diagnosticSize') || 10)
  const initialDiscoveryView = searchParams.get('discoveryView')
  const [settings, setSettings] = useState<RuntimeSettings | null>(null)
  const [deviceData, setDeviceData] = useState<DeviceListResponse | null>(null)
  const [health, setHealth] = useState<DeviceHealth | null>(null)
  const [connection, setConnection] = useState<TestConnectionResult | null>(null)
  const [connectionTestedAt, setConnectionTestedAt] = useState('')
  const [loading, setLoading] = useState(true)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState('')
  const [healthError, setHealthError] = useState('')
  const [devicesError, setDevicesError] = useState('')
  const [discoveryOpen, setDiscoveryOpen] = useState(searchParams.get('discovery') === 'open')
  const [discoveryView, setDiscoveryView] = useState<'entities' | 'diagnostics'>(initialDiscoveryView === 'diagnostics' ? 'diagnostics' : 'entities')
  const [discovery, setDiscovery] = useState<HomeAssistantWorkspaceResponse | null>(null)
  const [discoveryLoaded, setDiscoveryLoaded] = useState(false)
  const [loadedDiscoveryViewKey, setLoadedDiscoveryViewKey] = useState('')
  const [loadedDiscoveryPage, setLoadedDiscoveryPage] = useState(1)
  const [loadedDiscoverySize, setLoadedDiscoverySize] = useState(20)
  const [discoveryDomains, setDiscoveryDomains] = useState<Record<string, number>>({})
  const [discoveryLoading, setDiscoveryLoading] = useState(false)
  const [discoveryRefreshing, setDiscoveryRefreshing] = useState(false)
  const [discoveryError, setDiscoveryError] = useState('')
  const [discoveryKeywordInput, setDiscoveryKeywordInput] = useState(searchParams.get('discoveryQ') || '')
  const [discoveryKeyword, setDiscoveryKeyword] = useState((searchParams.get('discoveryQ') || '').trim())
  const [discoverySearchSettled, setDiscoverySearchSettled] = useState(true)
  const [discoveryClassification, setDiscoveryClassification] = useState(searchParams.get('classification') || '')
  const [discoveryDomain, setDiscoveryDomain] = useState(searchParams.get('domain') || '')
  const [discoveryMapped, setDiscoveryMapped] = useState(searchParams.get('mapped') || '')
  const [discoveryStatus, setDiscoveryStatus] = useState(searchParams.get('status') || '')
  const [discoveryPage, setDiscoveryPage] = useState(Number.isInteger(initialDiscoveryPage) && initialDiscoveryPage > 0 ? initialDiscoveryPage : 1)
  const [discoverySize, setDiscoverySize] = useState([10, 20, 50].includes(initialDiscoverySize) ? initialDiscoverySize : 20)
  const [diagnosticPage, setDiagnosticPage] = useState(Number.isInteger(initialDiagnosticPage) && initialDiagnosticPage > 0 ? initialDiagnosticPage : 1)
  const [diagnosticSize, setDiagnosticSize] = useState([5, 10, 20].includes(initialDiagnosticSize) ? initialDiagnosticSize : 10)
  const [loadedDiagnosticPage, setLoadedDiagnosticPage] = useState(1)
  const [loadedDiagnosticSize, setLoadedDiagnosticSize] = useState(10)
  const [selectedEntity, setSelectedEntity] = useState<HomeAssistantWorkspaceItem | null>(null)
  const [mappedWorkspace, setMappedWorkspace] = useState<HomeAssistantWorkspaceResponse | null>(null)
  const [mappedLoaded, setMappedLoaded] = useState(false)
  const [loadedMappedViewKey, setLoadedMappedViewKey] = useState('')
  const [loadedMappedPage, setLoadedMappedPage] = useState(1)
  const [loadedMappedSize, setLoadedMappedSize] = useState(10)
  const [mappedLoading, setMappedLoading] = useState(true)
  const [mappedRefreshing, setMappedRefreshing] = useState(false)
  const [mappedError, setMappedError] = useState('')
  const [mappedPage, setMappedPage] = useState(Number.isInteger(initialMappedPage) && initialMappedPage > 0 ? initialMappedPage : 1)
  const [mappedSize, setMappedSize] = useState([10, 20, 50].includes(initialMappedSize) ? initialMappedSize : 10)
  const dataRequestRef = useRef(0)
  const discoveryRequestRef = useRef(0)
  const mappedRequestRef = useRef(0)
  const testRequestRef = useRef(0)
  const testingRef = useRef(false)
  const testAbortRef = useRef<AbortController | null>(null)
  const testReconcileSequenceRef = useRef(0)
  const testReconcileTimerRef = useRef<number | null>(null)
  const discoveryRefreshRef = useRef(0)
  const discoveryRefreshSequenceRef = useRef(0)
  const mappedRefreshRef = useRef(0)
  const mappedRefreshSequenceRef = useRef(0)
  const dataAbortRef = useRef<AbortController | null>(null)
  const mappedAbortRef = useRef<AbortController | null>(null)
  const discoveryAbortRef = useRef<AbortController | null>(null)
  const writtenSearchRef = useRef(searchParams.toString())

  const haService = settings?.services?.homeassistant
  const haAddressLabel = !settings
    ? '正在确认配置'
    : haService?.configured === false
      ? '未配置'
      : isAdmin && haService?.url
        ? haService.url
        : '由管理员维护'
  const mappedEntities = mappedWorkspace?.items || []
  const effectiveConnectionStatus = health ? (health.ha_connected ? 'running' : 'error') : healthError ? 'error' : haService?.status
  const mappedWorkspaceOnline = mappedWorkspace?.status === 'running'
  const healthProbeSummary = health
    ? probeSummary(health.ha_connected ? 'running' : 'error', health.latency_ms, health.tested_at)
    : healthError
      ? '实时连接状态读取失败'
      : '正在读取实时连接状态'
  const latestManualProbeSummary = connection
    ? manualProbeSummary(connection.status, connection.latency_ms, connectionTestedAt)
    : ''
  const mappedSnapshotMatchesPage = Boolean(mappedLoaded && loadedMappedViewKey === mappedViewKey(mappedPage, mappedSize))
  const discoveryOnline = discovery?.status === 'running'
  const currentDiscoveryViewKey = discoveryViewKey({
    keyword: discoveryKeyword,
    classification: discoveryClassification,
    domain: discoveryDomain,
    mapped: discoveryMapped,
    status: discoveryStatus,
    page: discoveryPage,
    size: discoverySize,
    diagnosticPage,
    diagnosticSize,
  })
  const discoverySnapshotMatchesView = Boolean(
    discoveryLoaded
    && discoverySearchSettled
    && discoveryKeywordInput.trim() === discoveryKeyword
    && loadedDiscoveryViewKey === currentDiscoveryViewKey
  )

  const loadData = useCallback(async (force = false, requestedKeys: MainResourceKey[] = MAIN_RESOURCE_KEYS) => {
    const keys = requestedKeys.length ? Array.from(new Set(requestedKeys)) : MAIN_RESOURCE_KEYS
    dataAbortRef.current?.abort()
    const controller = new AbortController()
    dataAbortRef.current = controller
    const requestId = ++dataRequestRef.current
    setLoading(true)
    if (keys.includes('settings')) setError('')
    let revealed = false
    const applyIfCurrent = (apply: () => void) => {
      if (dataRequestRef.current === requestId) apply()
    }
    const revealAvailableData = () => {
      if (revealed || dataRequestRef.current !== requestId) return
      revealed = true
      setLoading(false)
    }
    const loaders: Record<MainResourceKey, () => Promise<void>> = {
      settings: () => settingsApi.config(force, controller.signal)
        .then((value) => applyIfCurrent(() => {
          setSettings(value)
          setError('')
          revealAvailableData()
        }))
        .catch((reason) => applyIfCurrent(() => setError(businessErrorMessage(reason, { fallback: 'Home Assistant 配置读取失败', service: 'Home Assistant' })))),
      health: () => fetchDeviceHealth(controller.signal)
        .then((value) => applyIfCurrent(() => {
          setHealth(value)
          setHealthError('')
          revealAvailableData()
        }))
        .catch((reason) => applyIfCurrent(() => setHealthError(businessErrorMessage(reason, { fallback: '设备模块状态读取失败', service: '设备模块' })))),
      devices: () => fetchDevices({ refresh: force, signal: controller.signal })
        .then((value) => applyIfCurrent(() => {
          setDeviceData(value)
          setDevicesError('')
          revealAvailableData()
        }))
        .catch((reason) => applyIfCurrent(() => setDevicesError(businessErrorMessage(reason, { fallback: '设备实体读取失败', service: 'Home Assistant' })))),
    }
    await Promise.allSettled(keys.map((key) => loaders[key]()))
    if (dataAbortRef.current === controller) dataAbortRef.current = null
    applyIfCurrent(() => setLoading(false))
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  const loadMappedEntities = useCallback(async (force = false) => {
    mappedAbortRef.current?.abort()
    const controller = new AbortController()
    mappedAbortRef.current = controller
    const requestId = ++mappedRequestRef.current
    setMappedLoading(true)
    setMappedError('')
    try {
      const payload = await fetchHomeAssistantWorkspace({ page: mappedPage, size: mappedSize, mapped: true, refresh: force, signal: controller.signal })
      if (mappedRequestRef.current !== requestId) return
      const resolvedPage = payload.status === 'running' ? payload.page : payload.orphan_page
      setMappedWorkspace(payload)
      setMappedLoaded(true)
      setLoadedMappedPage(resolvedPage)
      setLoadedMappedSize(payload.size)
      setLoadedMappedViewKey(mappedViewKey(resolvedPage, payload.size))
      if (mappedPage !== resolvedPage) setMappedPage(resolvedPage)
    } catch (loadError) {
      if (!controller.signal.aborted && mappedRequestRef.current === requestId) {
        setMappedError(businessErrorMessage(loadError, { fallback: '实体映射读取失败', service: '设备映射' }))
      }
    } finally {
      if (mappedAbortRef.current === controller) mappedAbortRef.current = null
      if (mappedRequestRef.current === requestId) setMappedLoading(false)
    }
  }, [mappedPage, mappedSize])

  useEffect(() => {
    void loadMappedEntities()
  }, [loadMappedEntities])

  useEffect(() => () => {
    dataRequestRef.current += 1
    discoveryRequestRef.current += 1
    mappedRequestRef.current += 1
    testRequestRef.current += 1
    testingRef.current = false
    testAbortRef.current?.abort()
    testAbortRef.current = null
    testReconcileSequenceRef.current += 1
    if (testReconcileTimerRef.current !== null) window.clearTimeout(testReconcileTimerRef.current)
    discoveryRefreshRef.current = 0
    mappedRefreshRef.current = 0
    dataAbortRef.current?.abort()
    dataAbortRef.current = null
    mappedAbortRef.current?.abort()
    mappedAbortRef.current = null
    discoveryAbortRef.current?.abort()
    discoveryAbortRef.current = null
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDiscoveryKeyword(discoveryKeywordInput.trim())
      setDiscoverySearchSettled(true)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [discoveryKeywordInput])

  useEffect(() => {
    if (pathname !== '/home-assistant') return
    const url = new URL(window.location.href)
    const values: Record<string, string> = {
      mappedPage: mappedPage === 1 ? '' : String(mappedPage),
      mappedSize: mappedSize === 10 ? '' : String(mappedSize),
      discovery: discoveryOpen ? 'open' : '',
      discoveryView: discoveryOpen && discoveryView === 'diagnostics' ? 'diagnostics' : '',
      discoveryQ: discoveryOpen ? discoveryKeywordInput.trim() : '',
      classification: discoveryOpen ? discoveryClassification : '',
      domain: discoveryOpen ? discoveryDomain : '',
      mapped: discoveryOpen ? discoveryMapped : '',
      status: discoveryOpen ? discoveryStatus : '',
      discoveryPage: discoveryOpen && discoveryPage !== 1 ? String(discoveryPage) : '',
      discoverySize: discoveryOpen && discoverySize !== 20 ? String(discoverySize) : '',
      diagnosticPage: discoveryOpen && discoveryView === 'diagnostics' && diagnosticPage !== 1 ? String(diagnosticPage) : '',
      diagnosticSize: discoveryOpen && discoveryView === 'diagnostics' && diagnosticSize !== 10 ? String(diagnosticSize) : '',
    }
    Object.entries(values).forEach(([key, value]) => {
      if (value) url.searchParams.set(key, value)
      else url.searchParams.delete(key)
    })
    writtenSearchRef.current = url.searchParams.toString()
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }, [diagnosticPage, diagnosticSize, discoveryClassification, discoveryDomain, discoveryKeywordInput, discoveryMapped, discoveryOpen, discoveryPage, discoverySize, discoveryStatus, discoveryView, mappedPage, mappedSize, pathname])

  useEffect(() => {
    if (pathname !== '/home-assistant') return
    const incomingSearch = searchParams.toString()
    if (incomingSearch === writtenSearchRef.current) return
    writtenSearchRef.current = incomingSearch
    const nextMappedPage = Number(searchParams.get('mappedPage') || 1)
    const nextMappedSize = Number(searchParams.get('mappedSize') || 10)
    const nextDiscoveryPage = Number(searchParams.get('discoveryPage') || 1)
    const nextDiscoverySize = Number(searchParams.get('discoverySize') || 20)
    const nextDiagnosticPage = Number(searchParams.get('diagnosticPage') || 1)
    const nextDiagnosticSize = Number(searchParams.get('diagnosticSize') || 10)
    const nextKeyword = searchParams.get('discoveryQ') || ''
    invalidateMappedEntities()
    invalidateDiscovery()
    setMappedPage(Number.isInteger(nextMappedPage) && nextMappedPage > 0 ? nextMappedPage : 1)
    setMappedSize([10, 20, 50].includes(nextMappedSize) ? nextMappedSize : 10)
    setDiscoveryOpen(searchParams.get('discovery') === 'open')
    setDiscoveryView(searchParams.get('discoveryView') === 'diagnostics' ? 'diagnostics' : 'entities')
    setDiscoveryKeywordInput(nextKeyword)
    setDiscoveryKeyword(nextKeyword.trim())
    setDiscoverySearchSettled(true)
    setDiscoveryClassification(searchParams.get('classification') || '')
    setDiscoveryDomain(searchParams.get('domain') || '')
    setDiscoveryMapped(['true', 'false'].includes(searchParams.get('mapped') || '') ? searchParams.get('mapped') || '' : '')
    setDiscoveryStatus(searchParams.get('status') || '')
    setDiscoveryPage(Number.isInteger(nextDiscoveryPage) && nextDiscoveryPage > 0 ? nextDiscoveryPage : 1)
    setDiscoverySize([10, 20, 50].includes(nextDiscoverySize) ? nextDiscoverySize : 20)
    setDiagnosticPage(Number.isInteger(nextDiagnosticPage) && nextDiagnosticPage > 0 ? nextDiagnosticPage : 1)
    setDiagnosticSize([5, 10, 20].includes(nextDiagnosticSize) ? nextDiagnosticSize : 10)
  }, [pathname, searchParams])

  const loadDiscovery = useCallback(async (force = false) => {
    discoveryAbortRef.current?.abort()
    const controller = new AbortController()
    discoveryAbortRef.current = controller
    const requestId = ++discoveryRequestRef.current
    setDiscoveryLoading(true)
    setDiscoveryError('')
    try {
      const payload = await fetchHomeAssistantWorkspace({
        page: discoveryPage,
        size: discoverySize,
        diagnosticPage,
        diagnosticSize,
        keyword: discoveryKeyword,
        classification: discoveryClassification,
        domain: discoveryDomain,
        mapped: discoveryMapped === '' ? '' : discoveryMapped === 'true',
        status: discoveryStatus,
        refresh: force,
        signal: controller.signal,
      })
      if (!controller.signal.aborted && discoveryRequestRef.current === requestId) {
        const payloadDiagnosticPage = payload.diagnostics_page || 1
        const payloadDiagnosticSize = payload.diagnostics_size || Math.max(payload.diagnostics.length, 1)
        setDiscovery(payload)
        setDiscoveryLoaded(true)
        setLoadedDiscoveryViewKey(discoveryViewKey({
          keyword: discoveryKeyword,
          classification: discoveryClassification,
          domain: discoveryDomain,
          mapped: discoveryMapped,
          status: discoveryStatus,
          page: payload.page,
          size: payload.size,
          diagnosticPage: payloadDiagnosticPage,
          diagnosticSize: payloadDiagnosticSize,
        }))
        setLoadedDiscoveryPage(payload.page)
        setLoadedDiscoverySize(payload.size)
        setLoadedDiagnosticPage(payloadDiagnosticPage)
        setLoadedDiagnosticSize(payloadDiagnosticSize)
        setDiscoveryDomains(payload.domains || {})
        if (discoveryPage !== payload.page) setDiscoveryPage(payload.page)
        if (diagnosticPage !== payloadDiagnosticPage) setDiagnosticPage(payloadDiagnosticPage)
      }
    } catch (loadError) {
      if (!controller.signal.aborted && discoveryRequestRef.current === requestId) {
        setDiscoveryError(businessErrorMessage(loadError, { fallback: 'Home Assistant 实体发现读取失败', service: 'Home Assistant' }))
      }
    } finally {
      if (discoveryAbortRef.current === controller) discoveryAbortRef.current = null
      if (discoveryRequestRef.current === requestId) setDiscoveryLoading(false)
    }
  }, [diagnosticPage, diagnosticSize, discoveryClassification, discoveryDomain, discoveryKeyword, discoveryMapped, discoveryPage, discoverySize, discoveryStatus])

  useEffect(() => {
    if (!discoveryOpen || !discoverySearchSettled || discoveryKeywordInput.trim() !== discoveryKeyword) return
    void loadDiscovery()
  }, [discoveryKeyword, discoveryKeywordInput, discoveryOpen, discoverySearchSettled, loadDiscovery])

  useEffect(() => {
    const failedMainKeys: MainResourceKey[] = [
      ...(error ? ['settings' as const] : []),
      ...(healthError ? ['health' as const] : []),
      ...(devicesError ? ['devices' as const] : []),
    ]
    const mainReadFailed = failedMainKeys.length > 0
    if (!mainReadFailed && !mappedError && (!discoveryOpen || !discoveryError)) return

    const retryFailedReads = () => {
      if (!navigator.onLine || document.visibilityState !== 'visible') return
      if (mainReadFailed && !dataAbortRef.current) void loadData(true, failedMainKeys)
      if (mappedError && !mappedAbortRef.current) void loadMappedEntities(true)
      if (discoveryOpen && discoveryError && !discoveryAbortRef.current) void loadDiscovery(true)
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') retryFailedReads()
    }

    window.addEventListener('online', retryFailedReads)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('online', retryFailedReads)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [devicesError, discoveryError, discoveryOpen, error, healthError, loadData, loadDiscovery, loadMappedEntities, mappedError])

  const invalidateMappedEntities = () => {
    mappedRequestRef.current += 1
    mappedAbortRef.current?.abort()
    mappedAbortRef.current = null
    mappedRefreshRef.current = 0
    setMappedRefreshing(false)
    setMappedError('')
    setMappedLoading(true)
    setSelectedEntity(null)
  }

  const invalidateDiscovery = () => {
    discoveryRequestRef.current += 1
    discoveryAbortRef.current?.abort()
    discoveryAbortRef.current = null
    discoveryRefreshRef.current = 0
    setDiscoveryRefreshing(false)
    setDiscoveryError('')
    setDiscoveryLoading(true)
    setSelectedEntity(null)
  }

  const closeDiscovery = () => {
    discoveryRequestRef.current += 1
    discoveryAbortRef.current?.abort()
    discoveryAbortRef.current = null
    discoveryRefreshRef.current = 0
    setDiscoveryRefreshing(false)
    setDiscoveryLoading(false)
    setDiscoveryOpen(false)
    setSelectedEntity(null)
  }

  const reconcileConnectionTest = useCallback(async () => {
    const sequence = ++testReconcileSequenceRef.current
    if (testReconcileTimerRef.current !== null) window.clearTimeout(testReconcileTimerRef.current)
    const refreshCurrentState = () => Promise.allSettled([
      loadData(true, ['settings', 'health']),
      loadMappedEntities(true),
      ...(discoveryOpen ? [loadDiscovery(true)] : []),
    ])
    await refreshCurrentState()
    if (testReconcileSequenceRef.current !== sequence) return
    testReconcileTimerRef.current = window.setTimeout(() => {
      if (testReconcileSequenceRef.current !== sequence) return
      void refreshCurrentState().finally(() => {
        if (testReconcileSequenceRef.current === sequence) testReconcileTimerRef.current = null
      })
    }, 1200)
  }, [discoveryOpen, loadData, loadDiscovery, loadMappedEntities])

  const handleTest = async () => {
    if (testingRef.current) {
      testRequestRef.current += 1
      testingRef.current = false
      testAbortRef.current?.abort()
      testAbortRef.current = null
      setTesting(false)
      setConnection(null)
      toast.warning('已取消前端等待，正在重新读取 Home Assistant 真实状态')
      void reconcileConnectionTest()
      return
    }
    testReconcileSequenceRef.current += 1
    if (testReconcileTimerRef.current !== null) {
      window.clearTimeout(testReconcileTimerRef.current)
      testReconcileTimerRef.current = null
    }
    const requestId = ++testRequestRef.current
    const controller = new AbortController()
    testingRef.current = true
    testAbortRef.current = controller
    setTesting(true)
    try {
      const result = await testServiceConnection('homeassistant', controller.signal)
      if (testRequestRef.current !== requestId) return
      setConnection(result)
      setConnectionTestedAt(new Date().toISOString())
      if (result.status === 'running') {
        toast.success(`Home Assistant 连接正常，延迟 ${result.latency_ms} 毫秒`)
      } else {
        toast.warning(result.message)
      }
      void reconcileConnectionTest()
    } catch (err) {
      if (testRequestRef.current !== requestId) return
      if (controller.signal.aborted) return
      toast.error(businessErrorMessage(err, { fallback: 'HA 连接测试失败', service: 'Home Assistant' }))
      setConnection(null)
      void reconcileConnectionTest()
    } finally {
      if (testRequestRef.current === requestId) {
        testingRef.current = false
        testAbortRef.current = null
        setTesting(false)
      }
    }
  }

  const refreshMappedEntities = async () => {
    if (mappedRefreshRef.current) return
    const refreshId = ++mappedRefreshSequenceRef.current
    mappedRefreshRef.current = refreshId
    setMappedRefreshing(true)
    try {
      await loadMappedEntities(true)
    } finally {
      if (mappedRefreshRef.current === refreshId) {
        mappedRefreshRef.current = 0
        setMappedRefreshing(false)
      }
    }
  }

  const refreshDiscovery = async () => {
    if (discoveryRefreshRef.current) return
    const refreshId = ++discoveryRefreshSequenceRef.current
    discoveryRefreshRef.current = refreshId
    setDiscoveryRefreshing(true)
    try {
      await loadDiscovery(true)
    } finally {
      if (discoveryRefreshRef.current === refreshId) {
        discoveryRefreshRef.current = 0
        setDiscoveryRefreshing(false)
      }
    }
  }

  return (
    <main className="mx-auto max-w-7xl space-y-6">
      {loading ? (
        <div className="flex items-center gap-3 rounded-md bg-blue-50 px-5 py-4 text-sm font-semibold text-blue-700 shadow-sm shadow-blue-100/60">
          <Loader2 size={18} className="shrink-0 animate-spin" />
          正在读取 Home Assistant 状态，页面其余功能可先查看。
        </div>
      ) : null}
      {error ? (
        <div className="rounded-md bg-rose-50 px-5 py-4 text-sm font-semibold text-rose-700 shadow-sm shadow-rose-100/60">
          {error}
        </div>
      ) : null}
      {healthError || devicesError ? (
        <div className="flex items-start gap-3 rounded-md bg-amber-50 px-5 py-4 text-sm text-amber-700 shadow-sm shadow-amber-100/60">
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-bold">部分 Home Assistant 数据读取失败</p>
            {healthError ? <p className="mt-1 leading-6">设备模块：{healthError}{health ? '，继续展示上次成功状态。' : '。'}</p> : null}
            {devicesError ? <p className="mt-1 leading-6">平台设备台账：{devicesError}{deviceData ? '，继续展示上次成功清单。' : '。'}</p> : null}
          </div>
        </div>
      ) : null}

      <header className="flex flex-col gap-4 pb-6 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-2">
          <div className="inline-flex items-center gap-2 text-sm font-bold text-blue-700">
            <Home size={18} />
            Home Assistant 统一设备抽象
          </div>
          <h1 className="text-3xl font-black text-slate-900">HA 接入与实体映射</h1>
          <p className="max-w-3xl text-sm leading-7 text-slate-500">
            平台通过后端代理 Home Assistant 读取实体、执行控制和回读状态。小米设备需先进入 Home Assistant 实体清单，再映射到平台逻辑设备。
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => setDiscoveryOpen(true)}
            className="inline-flex min-h-11 items-center gap-2 whitespace-nowrap rounded-lg bg-white px-4 py-2.5 text-sm font-bold text-slate-700 shadow-sm shadow-slate-200/60 transition hover:text-blue-700"
          >
            <Search size={16} />
            实体发现
          </button>
          <button
            type="button"
            onClick={handleTest}
            className={`inline-flex min-h-11 items-center gap-2 whitespace-nowrap rounded-lg bg-white px-4 py-2.5 text-sm font-bold shadow-sm shadow-slate-200/60 transition ${testing ? 'text-amber-700 hover:text-amber-800' : 'text-slate-700 hover:text-blue-700'}`}
          >
            {testing ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            {testing ? '取消等待' : '测试连接'}
          </button>
          {isAdmin && haService?.url ? <a
            href={haService.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center gap-2 whitespace-nowrap rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm shadow-blue-500/20 transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ExternalLink size={16} />
            打开 HA 控制台
          </a> : isAdmin ? <button
            type="button"
            disabled
            title={!settings ? '正在确认 Home Assistant 配置' : 'Home Assistant 地址未配置'}
            className="inline-flex min-h-11 items-center gap-2 whitespace-nowrap rounded-lg bg-slate-100 px-4 py-2.5 text-sm font-bold text-slate-400"
          >
            <ExternalLink size={16} />
            打开 HA 控制台
          </button> : null}
        </div>
      </header>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-md bg-white p-5 shadow-sm shadow-slate-200/60">
          <div className="text-xs font-bold text-slate-400">HA 地址</div>
          <div className="mt-3 truncate text-sm font-semibold text-slate-800" title={haAddressLabel}>{haAddressLabel}</div>
          <div className="mt-3 text-xs leading-5 text-slate-500">{isAdmin ? 'Token 由后端保管，页面只显示配置状态。' : '地址和 Token 由管理员维护，当前账号不接收连接凭证。'}</div>
        </div>
        <div className={`rounded-md p-5 shadow-sm shadow-slate-200/60 ${statusClass(effectiveConnectionStatus)}`}>
          <div className="text-xs font-bold">连接状态</div>
          <div className="mt-3 text-2xl font-black">{statusLabel(effectiveConnectionStatus)}</div>
          <div className="mt-2 line-clamp-2 text-xs leading-5" title={healthProbeSummary}>{healthProbeSummary}</div>
          {connection ? <div className="mt-1 truncate text-xs opacity-75" title={`${latestManualProbeSummary}；${connection.message}`}>最近手动测试：{latestManualProbeSummary}</div> : null}
        </div>
        <div className={`rounded-md p-5 shadow-sm shadow-slate-200/60 ${statusClass(health?.status)}`}>
          <div className="text-xs font-bold">设备模块</div>
          <div className="mt-3 text-2xl font-black">{healthError && !health ? '读取失败' : !health ? '待确认' : health.ha_connected ? '已代理' : '代理异常'}</div>
          <div className="mt-2 text-xs leading-5">{healthError && !health ? '当前无法读取设备模块状态。' : !health ? '正在确认平台代理状态。' : health.ha_connected ? '平台后端统一代理 Home Assistant 接口。' : 'Home Assistant 当前不可达，状态读取和控制暂不可用。'}</div>
        </div>
        <div className="rounded-md bg-white p-5 shadow-sm shadow-slate-200/60">
          <div className="text-xs font-bold text-slate-400">映射 / 场景</div>
          <div className="mt-3 text-2xl font-black text-slate-900">{mappedWorkspaceOnline ? mappedWorkspace.summary.mapped_entities : '—'}</div>
          <div className="mt-2 text-xs leading-5 text-slate-500">{mappedWorkspace && !mappedWorkspaceOnline ? `HA 实时清单未取得；平台登记 ${mappedWorkspace.summary.mapped_devices} 个逻辑设备，失联映射 ${mappedWorkspace.summary.orphan_mappings} 条。` : mappedError && !mappedWorkspace ? '当前无法读取 HA 映射统计。' : mappedWorkspace ? `HA 场景 ${mappedWorkspace.summary.scenes} 个，逻辑设备 ${mappedWorkspace.summary.mapped_devices} 个。` : '正在读取 HA 场景与平台映射统计。'}</div>
          {mappedWorkspace ? <div className="mt-1 truncate text-xs text-slate-400" title={`实体快照 · ${formatDateTime(mappedWorkspace.generated_at)}${mappedWorkspace.cache_hit ? ' · 服务端缓存' : ''}`}>实体快照 · {formatDateTime(mappedWorkspace.generated_at)}{mappedWorkspace.cache_hit ? ' · 服务端缓存' : ''}</div> : null}
        </div>
      </section>

      <section className="grid gap-5 2xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 rounded-md bg-white shadow-sm shadow-slate-200/60">
          <div className="flex flex-col gap-2 px-5 py-4 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="font-black text-slate-900">Home Assistant 实体映射</h2>
              <p className="mt-1 text-sm leading-6 text-slate-500">业务名称和状态优先显示，实体标识收纳在技术详情中。</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-flex shrink-0 items-center whitespace-nowrap rounded-[6px] bg-slate-100 px-3 py-1 text-xs font-bold text-slate-600">
                {mappedLoading && !mappedWorkspace ? '正在读取' : mappedWorkspaceOnline ? `共 ${mappedWorkspace.total} 项` : mappedWorkspace?.orphan_total ? `平台台账 ${mappedWorkspace.orphan_total} 条` : '共 — 项'}
              </span>
              <button type="button" onClick={() => void refreshMappedEntities()} disabled={mappedRefreshing} aria-label="刷新实体映射" title="刷新实体映射" className="inline-flex h-9 w-9 items-center justify-center rounded-[6px] border border-slate-200 text-slate-500 transition hover:border-blue-200 hover:text-blue-700 disabled:cursor-wait disabled:opacity-50">
                <RefreshCw size={14} className={mappedRefreshing ? 'animate-spin' : ''} />
              </button>
            </div>
          </div>
          {mappedLoading && mappedWorkspace ? <div className="border-t border-blue-100 bg-blue-50 px-5 py-2.5 text-xs font-semibold text-blue-700">正在更新实体映射，当前继续显示上次成功结果。</div> : null}
          {!mappedWorkspaceOnline && mappedWorkspace?.orphan_items.length ? (
            <div className="border-t border-amber-100 bg-amber-50 px-5 py-3 text-xs leading-5 text-amber-800">
              Home Assistant 实时清单未取得；下方显示平台设备台账中已知的失联映射，仅用于定位修复对象，不能代表当前 HA 实体状态。
            </div>
          ) : null}
          {mappedWorkspaceOnline && mappedEntities.length ? (
            <div className="divide-y divide-slate-100 md:hidden">
              {mappedEntities.map((entity) => (
                <article key={entity.entity_id} className="min-w-0 px-4 py-4">
                  <div className="flex min-w-0 items-start justify-between gap-3"><div className="min-w-0"><button type="button" onClick={() => { if (mappedSnapshotMatchesPage) setSelectedEntity(entity) }} disabled={!mappedSnapshotMatchesPage} className="break-words text-left text-sm font-black text-slate-900 [overflow-wrap:anywhere] disabled:text-slate-500">{entity.platform_device_name || '未命名平台设备'}</button><p className="mt-1 text-xs text-slate-500">{ROLE_LABELS[entity.mapping_role || ''] || '设备能力'} · {platformLabel(entity.platform)}</p></div><span title={entityStateTitle(entity.state)} className={`shrink-0 rounded-[6px] px-2 py-1 text-xs font-bold ${entityStateClass(entity.state)}`}>{entityStateLabel(entity.state)}</span></div>
                  <div className="mt-3 flex items-center justify-between gap-3 border-t border-slate-100 pt-3"><span className="text-xs text-slate-500">更新于 {formatDateTime(entity.last_changed)}</span><button type="button" onClick={() => { if (mappedSnapshotMatchesPage) setSelectedEntity(entity) }} disabled={!mappedSnapshotMatchesPage} className="text-xs font-black text-blue-700 disabled:text-slate-400">查看详情</button></div>
                </article>
              ))}
            </div>
          ) : !mappedWorkspaceOnline && mappedWorkspace?.orphan_items.length ? (
            <div className="divide-y divide-slate-100 md:hidden">
              {mappedWorkspace.orphan_items.map((item) => (
                <article key={item.mapping_id ?? item.entity_id} className="min-w-0 px-4 py-4">
                  <div className="flex min-w-0 items-start justify-between gap-3"><div className="min-w-0"><p className="break-words text-sm font-black text-slate-900 [overflow-wrap:anywhere]">{item.platform_device_name}</p><p className="mt-1 text-xs text-slate-500">{ROLE_LABELS[item.mapping_role] || '设备能力'}</p></div><span className="shrink-0 rounded-[6px] bg-amber-100 px-2 py-1 text-xs font-bold text-amber-800">映射失联</span></div>
                  <div className="mt-3 flex items-center justify-between gap-3 border-t border-slate-100 pt-3"><span className="text-xs text-slate-500">当前无法从 HA 回读</span><a href="/devices" className="text-xs font-black text-blue-700">查看设备台账</a></div>
                </article>
              ))}
            </div>
          ) : null}
          <div className="hidden overflow-x-auto md:block" tabIndex={0} role="region" aria-label="Home Assistant 实体映射列表，可横向滚动">
            <table className="min-w-[760px] table-fixed text-left text-sm">
              <colgroup>
                <col className="w-[180px]" />
                <col className="w-[140px]" />
                <col />
                <col className="w-[110px]" />
                <col className="w-[170px]" />
              </colgroup>
              <thead className="bg-slate-50 text-xs font-bold text-slate-500">
                <tr>
                  <th className="px-5 py-3 whitespace-nowrap">逻辑设备</th>
                  <th className="px-5 py-3 whitespace-nowrap">角色</th>
                  <th className="px-5 py-3 whitespace-nowrap">接入集成</th>
                  <th className="px-5 py-3 whitespace-nowrap">状态</th>
                  <th className="px-5 py-3 whitespace-nowrap">{mappedWorkspaceOnline ? '更新时间' : '处理'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {!mappedWorkspaceOnline ? mappedWorkspace?.orphan_items.map((item) => (
                  <tr key={item.mapping_id ?? item.entity_id} className="transition-colors hover:bg-amber-50/40">
                    <td className="px-5 py-4 font-semibold text-slate-900">{item.platform_device_name}</td>
                    <td className="px-5 py-4 text-slate-500"><span className="inline-flex rounded-[6px] bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">{ROLE_LABELS[item.mapping_role] || '设备能力'}</span></td>
                    <td className="px-5 py-4 text-xs font-semibold text-slate-500">平台设备台账</td>
                    <td className="px-5 py-3"><span className="inline-flex rounded-[6px] bg-amber-100 px-2.5 py-1 text-xs font-bold text-amber-800">映射失联</span></td>
                    <td className="px-5 py-4 text-xs leading-5 text-slate-500"><a href="/devices" className="font-black text-blue-700">查看设备台账</a></td>
                  </tr>
                )) : null}
                {mappedEntities.map((entity) => (
                  <tr key={entity.entity_id} className="transition-colors hover:bg-slate-50/70">
                    <td className="px-5 py-4 font-semibold text-slate-900">
                      <button type="button" onClick={() => { if (mappedSnapshotMatchesPage) setSelectedEntity(entity) }} disabled={!mappedSnapshotMatchesPage} className="-my-2 flex min-h-8 w-full items-center truncate whitespace-nowrap text-left transition hover:text-blue-700 disabled:cursor-not-allowed disabled:text-slate-500" title={mappedSnapshotMatchesPage ? entity.platform_device_name || '未命名平台设备' : '请等待当前页读取完成'}>{entity.platform_device_name || '未命名平台设备'}</button>
                    </td>
                    <td className="px-5 py-4 text-slate-500">
                      <span className="inline-flex max-w-full items-center truncate whitespace-nowrap rounded-[6px] bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600" title={ROLE_LABELS[entity.mapping_role || ''] || '设备能力'}>
                        {ROLE_LABELS[entity.mapping_role || ''] || '设备能力'}
                      </span>
                    </td>
                    <td className="truncate px-5 py-4 text-xs font-semibold text-slate-700" title={PLATFORM_LABELS[entity.platform || ''] ? platformLabel(entity.platform) : entity.platform ? `其他 HA 集成（技术集成：${entity.platform}）` : '未登记集成'}>
                      {platformLabel(entity.platform)}
                    </td>
                    <td className="px-5 py-3">
                      <span title={entityStateTitle(entity.state)} className={`inline-flex items-center whitespace-nowrap rounded-[6px] px-2.5 py-1 text-xs font-bold ${entityStateClass(entity.state)}`}>
                        {entityStateLabel(entity.state)}
                      </span>
                    </td>
                    <td className="px-5 py-4 text-xs leading-5 text-slate-500">{formatDateTime(entity.last_changed)}</td>
                  </tr>
                ))}
                {!mappedLoading && !mappedEntities.length && !(mappedWorkspace?.orphan_items.length) ? <tr><td colSpan={5} className="px-5 py-12 text-center text-sm text-slate-500">{mappedWorkspace && !mappedWorkspaceOnline ? 'Home Assistant 实时实体清单未取得，平台台账中也没有可定位的失联映射。' : mappedError || '暂无已映射的 Home Assistant 实体'}</td></tr> : null}
                {mappedLoading && !mappedWorkspace ? <tr><td colSpan={5} className="px-5 py-12 text-center text-sm text-slate-500"><Loader2 size={16} className="mr-2 inline animate-spin" />正在读取实体映射</td></tr> : null}
              </tbody>
            </table>
          </div>
          {mappedError && mappedWorkspace ? <div className="border-t border-amber-100 bg-amber-50 px-5 py-3 text-xs font-semibold text-amber-700">{mappedError}，继续显示上次成功结果。</div> : null}
          {mappedWorkspaceOnline ? (
            <Pagination
              page={loadedMappedPage}
              pageSize={loadedMappedSize}
              total={mappedWorkspace.total}
              loading={mappedLoading}
              navigationDisabled={!mappedSnapshotMatchesPage}
              onPageChange={(value) => { invalidateMappedEntities(); setMappedPage(value) }}
              onPageSizeChange={(value) => { invalidateMappedEntities(); setMappedSize(value); setMappedPage(1) }}
              pageSizeOptions={[10, 20, 50]}
              itemName="个映射实体"
            />
          ) : mappedWorkspace && mappedWorkspace.orphan_total > mappedWorkspace.size ? (
            <Pagination page={mappedWorkspace.orphan_page} pageSize={mappedWorkspace.size} total={mappedWorkspace.orphan_total} loading={mappedLoading} navigationDisabled={!mappedSnapshotMatchesPage} onPageChange={(value) => { invalidateMappedEntities(); setMappedPage(value) }} onPageSizeChange={(value) => { invalidateMappedEntities(); setMappedSize(value); setMappedPage(1) }} pageSizeOptions={[10, 20, 50]} itemName="条失联映射" />
          ) : null}
        </div>

        <aside className="space-y-4">
          <div className="rounded-md bg-amber-50 p-5 shadow-sm shadow-amber-100/60">
            <div className="flex items-center gap-2 text-sm font-black text-amber-800">
              <ShieldAlert size={18} />
              小米接入状态
            </div>
            <p className="mt-3 text-sm leading-6 text-amber-800">
              {!mappedWorkspaceOnline
                ? '当前无法判断 Xiaomi Home 实体映射情况；请先恢复 Home Assistant 连接，再结合实体发现和现场实测确认。'
                : mappedWorkspace.summary.xiaomi_mapped_entities
                ? `当前识别 ${mappedWorkspace.summary.xiaomi_mapped_entities} 个已映射 Xiaomi Home 实体。HA 状态回读不能单独证明现场硬件已经动作，物理控制和断网能力仍需实机确认。`
                : '当前映射中未识别到 Xiaomi Home 实体；厂商设备型号、物理控制和断网能力以实体发现及现场实测为准。'}
            </p>
          </div>
          <div className="rounded-md bg-white p-5 shadow-sm shadow-slate-200/60">
            <div className="flex items-center gap-2 text-sm font-black text-slate-900">
              <Network size={18} />
              接入信息
            </div>
            <dl className="mt-4 divide-y divide-slate-100 rounded-lg border border-slate-200 px-4 text-sm">
              {[
                {
                  label: 'HA 当前资产',
                  value: `${mappedWorkspaceOnline ? mappedWorkspace.summary.total_entities : '—'} 个实体 · ${mappedWorkspaceOnline ? mappedWorkspace.summary.ha_devices : '—'} 台设备`,
                  warning: false,
                },
                {
                  label: '平台映射',
                  value: `${mappedWorkspaceOnline ? mappedWorkspace.summary.mapped_entities : '—'} 个实体 · ${mappedWorkspace?.summary.mapped_devices ?? '—'} 个逻辑设备`,
                  warning: false,
                },
                {
                  label: '受影响 HA 设备',
                  value: `涉及 ${mappedWorkspaceOnline ? mappedWorkspace.summary.hardware_unavailable_devices : '—'} 台 · ${mappedWorkspaceOnline ? mappedWorkspace.summary.hardware_unavailable_entities : '—'} 个关联实体`,
                  warning: Boolean(mappedWorkspaceOnline && (mappedWorkspace.summary.hardware_unavailable_devices || mappedWorkspace.summary.hardware_unavailable_entities)),
                },
                {
                  label: '其他不可用 / 失效映射',
                  value: `${mappedWorkspaceOnline ? mappedWorkspace.summary.other_unavailable_entities : '—'} 个其他实体 · ${mappedWorkspace?.summary.orphan_mappings ?? '—'} 条失效映射`,
                  warning: Boolean(mappedWorkspaceOnline && (mappedWorkspace.summary.other_unavailable_entities || mappedWorkspace.summary.orphan_mappings)),
                },
              ].map((item) => (
                <div key={item.label} className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-3 py-3">
                  <dt className="flex items-center gap-2 font-semibold text-slate-500">
                    {item.warning ? <AlertTriangle size={14} className="shrink-0 text-amber-600" /> : <CheckCircle2 size={14} className="shrink-0 text-emerald-600" />}
                    {item.label}
                  </dt>
                  <dd className={`break-words text-right font-bold ${item.warning ? 'text-amber-800' : 'text-slate-700'}`}>{item.value}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="rounded-md bg-white p-5 shadow-sm shadow-slate-200/60">
            <div className="flex items-center gap-2 text-sm font-black text-slate-900">
              <Layers size={18} />
              平台设备分类
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {Object.entries(deviceData?.summary.categories || {}).map(([category, count]) => (
                <span key={category} className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-600">
                  {CATEGORY_LABELS[category] || '其他设备'} · {count}
                </span>
              ))}
              {!Object.keys(deviceData?.summary.categories || {}).length ? (
                <span className="text-sm text-slate-500">
                  {devicesError && !deviceData ? '平台设备分类未取得' : !deviceData ? '正在读取平台设备分类' : '暂无已登记设备分类'}
                </span>
              ) : null}
            </div>
          </div>
        </aside>
      </section>

      <AppDrawer
        open={discoveryOpen}
        title="Home Assistant 实体发现"
        description="只读查看 HA 全量实体、平台映射与接入诊断；浏览和刷新不会同步台账或控制设备。"
        onClose={closeDiscovery}
        widthClassName="max-w-4xl"
        headerActions={(
          <button
            type="button"
            onClick={() => void refreshDiscovery()}
            disabled={discoveryRefreshing}
            className="inline-flex h-9 w-9 items-center justify-center rounded-[6px] border border-slate-200 text-slate-500 transition hover:border-blue-200 hover:text-blue-700 disabled:opacity-50"
            aria-label="刷新实体发现"
            title="刷新实体发现"
          >
            <RefreshCw size={16} className={discoveryRefreshing ? 'animate-spin' : ''} />
          </button>
        )}
        footer={discoveryView === 'entities' && discoveryOnline ? (
          <Pagination
            page={loadedDiscoveryPage}
            pageSize={loadedDiscoverySize}
            total={discovery?.total || 0}
            itemName="个实体"
            loading={discoveryLoading}
            navigationDisabled={!discoverySnapshotMatchesView}
            onPageChange={(value) => { invalidateDiscovery(); setDiscoveryPage(value) }}
            onPageSizeChange={(value) => { invalidateDiscovery(); setDiscoverySize(value); setDiscoveryPage(1) }}
            pageSizeOptions={[10, 20, 50]}
            className="border-0 p-0"
          />
        ) : discoveryView === 'diagnostics' && discoveryLoaded && (discovery?.diagnostics_total ?? discovery?.diagnostics.length ?? 0) > 0 ? (
          <Pagination
            page={loadedDiagnosticPage}
            pageSize={loadedDiagnosticSize}
            total={discovery?.diagnostics_total ?? discovery?.diagnostics.length ?? 0}
            itemName="项诊断"
            loading={discoveryLoading}
            navigationDisabled={!discoverySnapshotMatchesView}
            onPageChange={(value) => { invalidateDiscovery(); setDiagnosticPage(value) }}
            onPageSizeChange={(value) => { invalidateDiscovery(); setDiagnosticSize(value); setDiagnosticPage(1) }}
            pageSizeOptions={[5, 10, 20]}
            className="border-0 p-0"
          />
        ) : undefined}
      >
        {discovery ? (
          <div className="mb-5">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ['HA 全量实体', discovery.summary.total_entities],
                ['设备关联实体', discovery.summary.hardware_entities],
                ['平台已映射', discovery.summary.mapped_entities],
                ['受影响 HA 设备', discovery.summary.hardware_unavailable_devices],
              ].map(([label, value]) => (
                <div key={label} className="rounded-md bg-slate-50 px-4 py-3">
                  <div className="text-xs font-semibold text-slate-400">{label}</div>
                  <div className="mt-1 text-xl font-black text-slate-900">{discoveryOnline ? value : '—'}</div>
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs leading-5 text-slate-400">
              快照生成于 {formatDateTime(discovery.generated_at)} · {discovery.cache_hit ? '服务端缓存' : '直接读取'} · {discovery.cache_ttl_seconds} 秒缓存，可手动刷新
            </p>
          </div>
        ) : null}

        <div className="mb-5 inline-flex rounded-lg bg-slate-100 p-1" role="tablist" aria-label="实体发现视图">
          <button type="button" role="tab" id="ha-discovery-tab-entities" data-tab-id="entities" aria-selected={discoveryView === 'entities'} aria-controls="ha-discovery-panel" tabIndex={discoveryView === 'entities' ? 0 : -1} onClick={() => setDiscoveryView('entities')} onKeyDown={(event) => handleTabListKeyDown(event, DISCOVERY_VIEWS, discoveryView, setDiscoveryView)} className={`rounded-md px-4 py-2 text-xs font-black transition ${discoveryView === 'entities' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500'}`}>实体清单</button>
          <button type="button" role="tab" id="ha-discovery-tab-diagnostics" data-tab-id="diagnostics" aria-selected={discoveryView === 'diagnostics'} aria-controls="ha-discovery-panel" tabIndex={discoveryView === 'diagnostics' ? 0 : -1} onClick={() => setDiscoveryView('diagnostics')} onKeyDown={(event) => handleTabListKeyDown(event, DISCOVERY_VIEWS, discoveryView, setDiscoveryView)} className={`rounded-md px-4 py-2 text-xs font-black transition ${discoveryView === 'diagnostics' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500'}`}>接入诊断{(discovery?.diagnostics_total ?? discovery?.diagnostics.length ?? 0) > 0 ? `（${discovery?.diagnostics_total ?? discovery?.diagnostics.length ?? 0}）` : ''}</button>
        </div>

        {discoveryError && discoveryLoaded ? (
          <div className="mb-4 rounded-md bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700" role="alert">
            {discoveryError}{discoverySnapshotMatchesView ? '，继续显示当前条件下的上次成功快照。' : '，保留的旧快照不代表当前筛选条件，分页与实体详情已暂停。'}
          </div>
        ) : null}

        {discoveryLoading && discovery ? (
          <div className="mb-4 border-l-2 border-blue-500 bg-blue-50 px-4 py-3 text-sm font-semibold text-blue-700" role="status" aria-live="polite">
            正在应用筛选条件并更新实体清单，{discoverySnapshotMatchesView ? '当前继续显示同一条件下的上次成功结果。' : '下方旧快照不代表当前条件，分页与实体详情暂不可用。'}
          </div>
        ) : null}

        <div id="ha-discovery-panel" role="tabpanel" aria-labelledby={`ha-discovery-tab-${discoveryView}`}>
        {discoveryView === 'entities' ? (
          <>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(220px,1fr)_155px_155px_145px_145px]">
              <label className="relative min-w-0">
                <Search size={15} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="search"
                  value={discoveryKeywordInput}
                  disabled={discoveryRefreshing}
                  onChange={(event) => {
                    invalidateDiscovery()
                    setDiscoverySearchSettled(false)
                    setDiscoveryPage(1)
                    setDiscoveryKeywordInput(event.target.value)
                  }}
                  placeholder="搜索名称、区域、型号或实体"
                  aria-label="搜索 HA 实体"
                  className="min-h-10 w-full rounded-lg border border-slate-200 bg-white pl-10 pr-4 text-xs font-semibold text-slate-700 outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
                />
              </label>
              <UnifiedSelect size="sm" ariaLabel="筛选 HA 实体来源" disabled={discoveryRefreshing} value={discoveryClassification} onChange={(value) => { invalidateDiscovery(); setDiscoveryClassification(value); setDiscoveryPage(1) }} options={[{ value: '', label: '全部来源' }, { value: 'hardware', label: '设备关联实体' }, { value: 'helper', label: 'HA 辅助实体' }, { value: 'system', label: '系统实体' }, { value: 'unregistered', label: '未登记实体' }]} />
              <UnifiedSelect size="sm" ariaLabel="筛选 HA 实体类型" disabled={discoveryRefreshing} value={discoveryDomain} onChange={(value) => { invalidateDiscovery(); setDiscoveryDomain(value); setDiscoveryPage(1) }} options={[{ value: '', label: '全部类型' }, ...Object.entries(discoveryDomains).sort((left, right) => right[1] - left[1]).map(([value, count]) => ({ value, label: `${domainLabel(value)}（${count}）` }))]} />
              <UnifiedSelect size="sm" ariaLabel="筛选 HA 映射状态" disabled={discoveryRefreshing} value={discoveryMapped} onChange={(value) => { invalidateDiscovery(); setDiscoveryMapped(value); setDiscoveryPage(1) }} options={[{ value: '', label: '全部映射' }, { value: 'true', label: '已映射' }, { value: 'false', label: '未映射' }]} />
              <UnifiedSelect size="sm" ariaLabel="筛选 HA 当前状态" disabled={discoveryRefreshing} value={discoveryStatus} onChange={(value) => { invalidateDiscovery(); setDiscoveryStatus(value); setDiscoveryPage(1) }} options={[{ value: '', label: '全部状态' }, { value: 'available', label: '当前可用' }, { value: 'unavailable', label: '不可用 / 未知' }, { value: 'on', label: '开启' }, { value: 'off', label: '关闭' }]} />
            </div>
            <p className="mb-5 mt-3 text-xs leading-5 text-slate-500">
              {isAdmin
                ? '这里仅评估实体是否适合纳入平台；创建逻辑设备或调整映射请前往设备控制页面。'
                : '这里仅供查看实体与台账状态；创建逻辑设备和调整映射由管理员处理。'}
            </p>

            {discoveryLoading && !discoveryLoaded ? (
              <div className="flex items-center justify-center gap-3 py-16 text-sm font-semibold text-slate-400"><Loader2 size={18} className="animate-spin" />正在发现 Home Assistant 实体</div>
            ) : !discoveryLoaded ? (
              <div className="py-16 text-center" role="alert">
                <AlertTriangle className="mx-auto text-amber-500" size={28} />
                <p className="mt-3 text-sm font-black text-slate-700">Home Assistant 实体发现数据未取得</p>
                <p className="mx-auto mt-2 max-w-xl break-words text-xs leading-5 text-rose-600">{discoveryError || '当前尚未取得实体发现结果。'}</p>
                <p className="mt-1 text-xs text-slate-400">请检查连接后重新读取，当前不能确认实体总数或筛选结果。</p>
                <button type="button" onClick={() => void refreshDiscovery()} disabled={discoveryRefreshing} className="mt-4 inline-flex min-h-9 items-center justify-center gap-2 rounded-[8px] border border-amber-200 bg-white px-4 py-2 text-xs font-black text-amber-800 disabled:cursor-wait disabled:opacity-50"><RefreshCw size={14} className={discoveryRefreshing ? 'animate-spin' : ''} />重新读取实体</button>
              </div>
            ) : discovery?.items.length ? (
              <div className="overflow-x-auto rounded-md border border-slate-100" tabIndex={0} role="region" aria-label="Home Assistant 发现实体列表，可横向滚动">
                <table className="w-full min-w-[820px] table-fixed text-left text-sm">
                  <colgroup><col className="w-[280px]" /><col className="w-[145px]" /><col className="w-[145px]" /><col className="w-[160px]" /><col className="w-[170px]" /></colgroup>
                  <thead className="bg-slate-50 text-xs font-bold text-slate-500"><tr><th className="px-4 py-3">实体名称</th><th className="px-4 py-3">来源</th><th className="px-4 py-3">类型</th><th className="px-4 py-3">台账状态</th><th className="px-4 py-3 text-right">当前值</th></tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {discovery.items.map((item) => (
                      <tr key={item.entity_id} className="transition hover:bg-slate-50/70">
                        <td className="px-4 py-4"><button type="button" onClick={() => { if (discoverySnapshotMatchesView) setSelectedEntity(item) }} disabled={!discoverySnapshotMatchesView} className="-my-2 flex min-h-8 w-full items-center truncate text-left font-bold text-slate-900 transition hover:text-blue-700 disabled:cursor-not-allowed disabled:text-slate-500" title={discoverySnapshotMatchesView ? displayEntityName(item.name) : '请等待当前筛选条件读取完成'} aria-label={`查看 ${displayEntityName(item.name)} 实体详情`}>{displayEntityName(item.name)}</button></td>
                        <td className="truncate px-4 py-4 text-xs font-semibold text-slate-700" title={classificationTitle(item.classification)}>{classificationLabel(item.classification)}</td>
                        <td className="truncate px-4 py-4 text-xs font-semibold text-slate-700" title={DOMAIN_LABELS[item.domain] ? domainLabel(item.domain) : `技术类型：${item.domain || '未返回'}`}>{domainLabel(item.domain)}</td>
                        <td className="truncate px-4 py-4 text-xs font-bold text-slate-600" title={mappingStatusLabel(item)}>{mappingStatusLabel(item)}</td>
                        <td className="truncate px-4 py-4 text-right text-xs font-bold text-slate-700" title={discoveryStateLabel(item)}>{discoveryStateLabel(item)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="py-16 text-center">
                {discovery && !discoveryOnline ? <AlertTriangle className="mx-auto text-amber-500" size={28} /> : <Search className="mx-auto text-slate-300" size={28} />}
                <p className="mt-3 text-sm font-black text-slate-700">{discovery && !discoveryOnline ? 'Home Assistant 实时实体清单未取得' : '没有匹配的 HA 实体'}</p>
                <p className="mt-1 text-xs text-slate-400">{discovery && !discoveryOnline ? '恢复 Home Assistant 连接后刷新即可继续发现和核对实体。' : '请调整搜索或筛选条件后重试。'}</p>
              </div>
            )}
          </>
        ) : discoveryLoading && !discoveryLoaded ? (
          <div className="flex items-center justify-center gap-3 py-16 text-sm font-semibold text-slate-400"><Loader2 size={18} className="animate-spin" />正在生成接入诊断</div>
        ) : !discoveryLoaded ? (
          <div className="py-16 text-center" role="alert"><AlertTriangle className="mx-auto text-amber-500" size={28} /><p className="mt-3 text-sm font-black text-slate-700">接入诊断未取得</p><p className="mx-auto mt-2 max-w-xl break-words text-xs leading-5 text-rose-600">{discoveryError || '当前尚未取得接入诊断结果。'}</p><p className="mt-1 text-xs text-slate-400">请重新读取 Home Assistant 实体发现数据。</p></div>
        ) : discovery?.diagnostics.length ? (
          <div className="grid gap-3 md:grid-cols-2">
            {discovery.diagnostics.map((diagnostic) => (
              <article key={diagnostic.id} className={`rounded-md border px-4 py-4 ${diagnostic.severity === 'error' ? 'border-rose-100 bg-rose-50' : diagnostic.severity === 'warning' ? 'border-amber-100 bg-amber-50' : 'border-blue-100 bg-blue-50'}`}>
                <div className="flex items-start gap-3"><AlertTriangle size={18} className={`mt-0.5 shrink-0 ${diagnostic.severity === 'error' ? 'text-rose-600' : diagnostic.severity === 'warning' ? 'text-amber-600' : 'text-blue-600'}`} /><div className="min-w-0"><h3 className="text-sm font-black text-slate-900">{diagnostic.title}</h3><p className="mt-2 text-sm leading-6 text-slate-600">{diagnostic.message}</p>{diagnostic.entity_ids?.length ? <details className="mt-3"><summary className="cursor-pointer text-xs font-bold text-slate-600">查看关联实体（{diagnostic.entity_ids.length}{diagnostic.affected_count && diagnostic.affected_count > diagnostic.entity_ids.length ? ` / ${diagnostic.affected_count}` : ''} 个）</summary><div className="mt-2 space-y-2">{diagnostic.entity_ids.slice(0, 5).map((entityId) => <TechnicalId key={entityId} value={entityId} label="HA 实体" compact />)}{diagnostic.entity_ids.length > 5 ? <p className="text-xs font-semibold text-slate-500">当前样本中另有 {diagnostic.entity_ids.length - 5} 个关联实体未展开。</p> : null}{diagnostic.entity_ids_truncated && diagnostic.affected_count && diagnostic.affected_count > diagnostic.entity_ids.length ? <p className="text-xs font-semibold leading-5 text-amber-700">诊断共影响 {diagnostic.affected_count} 个实体，当前仅返回前 {diagnostic.entity_ids.length} 个标识；请进入设备台账查看并处理完整范围。</p> : null}</div></details> : null}{diagnostic.action_href && diagnostic.action_label ? <Link href={diagnostic.action_href} className="mt-3 inline-flex rounded-[6px] border border-current/20 px-3 py-2 text-xs font-black transition hover:bg-white/50">{diagnosticActionLabel(diagnostic.id, diagnostic.action_label, isAdmin)}</Link> : null}</div></div>
              </article>
            ))}
          </div>
        ) : (
          <div className="py-16 text-center"><CheckCircle2 className="mx-auto text-emerald-500" size={30} /><p className="mt-3 text-sm font-black text-slate-700">当前未发现接入异常</p><p className="mt-1 text-xs text-slate-400">这只代表平台与 HA 数据链路正常，不替代真实硬件现场验收。</p></div>
        )}
        </div>
      </AppDrawer>

      <AppDialog
        open={Boolean(selectedEntity)}
        onClose={() => setSelectedEntity(null)}
        title={displayEntityName(selectedEntity?.name) || 'HA 实体详情'}
        description="业务信息优先展示，技术标识仅用于调试、映射和问题定位。"
        maxWidth="max-w-3xl"
        zIndexClass="z-[170]"
      >
        {selectedEntity ? (
          <div className="space-y-5">
            {selectedEntity.physical_confirmation === 'physical_pending' ? <div className="rounded-md border border-amber-100 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800"><strong>待实机确认：</strong>Home Assistant 状态不能单独证明现场硬件已经动作。</div> : null}
            <dl className="divide-y divide-slate-100 rounded-lg border border-slate-200 px-4">
              {[
                ['HA 当前状态', discoveryStateLabel(selectedEntity)],
                ['来源分类', classificationLabel(selectedEntity.classification)],
                ['实体类型', domainLabel(selectedEntity.domain)],
                ['HA 设备', selectedEntity.device_name || '未关联设备'],
                ['所属区域', selectedEntity.area_name || '未分配区域'],
                ['接入集成', platformLabel(selectedEntity.platform)],
                ['台账状态', mappingStatusLabel(selectedEntity)],
                ['映射别名', selectedEntity.mapping_aliases?.join('、') || '未配置别名'],
                ['最后变化', formatDateTime(selectedEntity.last_changed)],
              ].map(([label, value]) => <div key={label} className="grid gap-1 py-3 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-4"><dt className="text-xs font-semibold text-slate-400">{label}</dt><dd className="break-words text-sm font-bold text-slate-800">{value}</dd></div>)}
            </dl>
            <div className="border-l-2 border-blue-200 bg-blue-50/70 px-4 py-3"><div className="text-xs font-semibold text-blue-700">来源判断</div><p className="mt-1 text-sm leading-6 text-slate-700">{selectedEntity.classification_reason || '当前没有可用的来源判断依据。'}</p></div>
            <details className="border-t border-slate-100 pt-4">
              <summary className="cursor-pointer text-sm font-black text-slate-700">查看技术标识与原始状态</summary>
              <div className="mt-4 grid gap-3 sm:grid-cols-2"><TechnicalId value={selectedEntity.entity_id} label="HA 实体 ID" /><TechnicalId value={selectedEntity.ha_device_id || ''} label="HA Device Registry ID" /><TechnicalId value={selectedEntity.platform_device_id ? String(selectedEntity.platform_device_id) : ''} label="平台设备 ID" /><TechnicalId value={selectedEntity.mapping_role || ''} label="平台映射角色" /><TechnicalId value={selectedEntity.classification || ''} label="原始来源分类" /><TechnicalId value={selectedEntity.domain || ''} label="原始实体域" /><TechnicalId value={selectedEntity.platform || ''} label="原始集成标识" /></div>
              <div className="mt-3 rounded-md bg-slate-950 px-4 py-3 text-xs text-slate-200">
                <div className="font-semibold text-slate-400">HA 原始状态</div>
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono leading-5">{String(selectedEntity.state || '未返回')}</pre>
              </div>
            </details>
          </div>
        ) : null}
      </AppDialog>
    </main>
  )
}

export default function HomeAssistantPage() {
  return <Suspense fallback={null}><HomeAssistantContent /></Suspense>
}
