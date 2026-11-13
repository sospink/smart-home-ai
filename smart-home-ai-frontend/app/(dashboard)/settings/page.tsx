'use client'

/**
 * 系统设置页 — 完全交互版
 * Tab 1: 外部服务配置 (Ollama/Dify/HA/InfluxDB) + 连接测试
 * Tab 2: 安全设置 (JWT/注册/密码策略)
 * Tab 3: 系统信息 (版本/运行时长/DB 状态)
 */

import { Suspense, useState, useEffect, useCallback, useId, useRef } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import {
  Save, Cpu, Workflow, Home, Database,
  Eye, EyeOff, CheckCircle2, XCircle, Lock, Info,
  Loader2, Wifi, Shield, Clock, Server,
  ExternalLink, RefreshCw, RotateCcw, Undo2, History, KeyRound,
} from 'lucide-react'
import { motion, AnimatePresence } from 'motion/react'
import { useAuth } from '@/lib/hooks/useAuth'
import { authApi } from '@/lib/api/auth'
import { ApiError } from '@/lib/api/client'
import {
  clearSettingsCache,
  settingsApi,
  type RuntimeSettings,
  type SettingsHistoryItem,
  type SettingsWritePayload,
  type SystemInfo,
  type TestConnectionResult,
} from '@/lib/api/system'
import { AppDrawer } from '@/components/ui/AppDrawer'
import { AppDialog } from '@/components/ui/AppDialog'
import { Pagination } from '@/components/ui/Pagination'
import { handleTabListKeyDown } from '@/lib/ui/tabs'
import { InlineToast } from '@/components/ui/InlineToast'
import { formatMilliseconds } from '@/lib/ui/format-duration'
import { businessErrorMessage } from '@/lib/ui/business-error'

type ServiceId = 'ollama' | 'dify' | 'homeassistant' | 'influxdb'
type SettingsTab = 'external' | 'security' | 'system'
type SettingsConfirmation =
  | { kind: 'navigate'; href: string; message: string }
  | { kind: 'refresh'; message: string }
  | { kind: 'reset'; message: string }

const SETTINGS_TABS: SettingsTab[] = ['external', 'security', 'system']

function settingsTabFromParam(value: string | null): SettingsTab {
  return SETTINGS_TABS.includes(value as SettingsTab) ? value as SettingsTab : 'external'
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

interface SettingsSnapshot {
  ollamaUrl: string
  difyUrl: string
  difyKey: string
  difyDatasetKey: string
  haUrl: string
  haToken: string
  influxUrl: string
  influxToken: string
  influxOrg: string
  influxBucket: string
  jwtHours: number
  allowReg: boolean
  pwdMinLen: number
}

interface TestEvidence extends TestConnectionResult {
  tested_at: string
  tested_at_ms: number
}

const SERVICE_IDS: ServiceId[] = ['ollama', 'dify', 'homeassistant', 'influxdb']
const STATUS_STALE_AFTER_MS = 2 * 60 * 1000
const STATUS_FRESHNESS_TICK_MS = 30 * 1000

const SERVICE_LABELS: Record<ServiceId, string> = {
  ollama: 'Ollama',
  dify: 'Dify',
  homeassistant: 'Home Assistant',
  influxdb: 'InfluxDB',
}

const CONFIG_KEY_LABELS: Record<string, string> = {
  ollama_base_url: 'Ollama 服务地址',
  dify_base_url: 'Dify 服务地址',
  dify_api_key: 'Dify 应用凭证',
  dify_dataset_api_key: 'Dify 知识库凭证',
  ha_base_url: 'Home Assistant 服务地址',
  ha_token: 'Home Assistant 长效凭证',
  influxdb_url: 'InfluxDB 服务地址',
  influxdb_token: 'InfluxDB 访问凭证',
  influxdb_org: 'InfluxDB 组织',
  influxdb_bucket: 'InfluxDB 存储桶',
  jwt_expire_hours: '登录有效期',
  allow_registration: '公开注册策略',
  password_min_length: '最小密码长度',
}

function serviceStatusLabel(status: string) {
  const labels: Record<string, string> = {
    running: '连接正常',
    stopped: '未连接',
    error: '连接失败',
    timeout: '连接超时',
    loading: '正在探测',
    stale: '待复核',
    unknown: '尚未测试',
  }
  return labels[String(status || 'unknown').toLowerCase()] || '状态未知'
}

function serviceLatencyLabel(latencyMs: number | null | undefined) {
  return formatMilliseconds(latencyMs)
}

function serviceProbeLatencyLabel(status: string, latencyMs: number | null | undefined) {
  if (status !== 'running' && (!latencyMs || latencyMs < 0)) return '失败用时未取得'
  return serviceLatencyLabel(latencyMs)
}

function probeAgeLabel(testedAtMs: number, nowMs: number) {
  const ageMs = Math.max(0, nowMs - testedAtMs)
  if (ageMs >= STATUS_STALE_AFTER_MS) return '证据已过期'
  if (ageMs < 60 * 1000) return '刚刚'
  return `${Math.floor(ageMs / 60_000)} 分钟前`
}

function isMaskedSecret(value: string) {
  return value.includes('•')
}

function normalizeSnapshot(input: SettingsSnapshot): SettingsSnapshot {
  return {
    ...input,
    ollamaUrl: input.ollamaUrl.trim(),
    difyUrl: input.difyUrl.trim(),
    difyKey: input.difyKey.trim(),
    difyDatasetKey: input.difyDatasetKey.trim(),
    haUrl: input.haUrl.trim(),
    haToken: input.haToken.trim(),
    influxUrl: input.influxUrl.trim(),
    influxToken: input.influxToken.trim(),
    influxOrg: input.influxOrg.trim(),
    influxBucket: input.influxBucket.trim(),
  }
}

function sameSettings(a: SettingsSnapshot | null, b: SettingsSnapshot) {
  return !!a && JSON.stringify(normalizeSnapshot(a)) === JSON.stringify(normalizeSnapshot(b))
}

function serviceHasDraftChanges(service: ServiceId, saved: SettingsSnapshot | null, current: SettingsSnapshot) {
  if (!saved) return false
  if (service === 'ollama') return saved.ollamaUrl !== current.ollamaUrl
  if (service === 'dify') {
    return saved.difyUrl !== current.difyUrl
      || saved.difyKey !== current.difyKey
      || saved.difyDatasetKey !== current.difyDatasetKey
  }
  if (service === 'homeassistant') return saved.haUrl !== current.haUrl || saved.haToken !== current.haToken
  return saved.influxUrl !== current.influxUrl
    || saved.influxToken !== current.influxToken
    || saved.influxOrg !== current.influxOrg
    || saved.influxBucket !== current.influxBucket
}

function settingsToSnapshot(settings: RuntimeSettings): SettingsSnapshot {
  return normalizeSnapshot({
    ollamaUrl: settings.services.ollama?.url || '',
    difyUrl: settings.services.dify?.url || '',
    difyKey: settings.services.dify?.token || '',
    difyDatasetKey: settings.services.dify?.extra?.dataset_token || '',
    haUrl: settings.services.homeassistant?.url || '',
    haToken: settings.services.homeassistant?.token || '',
    influxUrl: settings.services.influxdb?.url || '',
    influxToken: settings.services.influxdb?.token || '',
    influxOrg: settings.services.influxdb?.extra?.org || '',
    influxBucket: settings.services.influxdb?.extra?.bucket || '',
    jwtHours: settings.security.jwt_expire_hours,
    allowReg: settings.security.allow_registration,
    pwdMinLen: settings.security.password_min_length,
  })
}

function formatDateTime(value?: string | null) {
  if (!value) return '暂无记录'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? '时间未知'
    : date.toLocaleString('zh-CN', { hour12: false })
}

function formatUptime(seconds?: number | null) {
  if (seconds == null || seconds < 0) return '—'
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  if (days > 0) return `${days} 天 ${hours} 小时 ${minutes} 分钟`
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`
  return `${minutes} 分钟`
}

function errorMessage(error: unknown, fallback: string) {
  return businessErrorMessage(error, { fallback, service: '平台服务' })
}

function serviceDiagnosticMessage(message: string | null | undefined, service?: string) {
  const raw = String(message || '').trim()
  if (!raw) return '尚未取得连接诊断'
  const serviceLabel = SERVICE_LABELS[service as ServiceId] || '外部服务'
  return businessErrorMessage(raw, {
    fallback: `${serviceLabel}连接检查未完成，请检查服务配置和运行日志`,
    service: serviceLabel,
  })
}

function validateServiceUrl(label: string, value: string) {
  try {
    const url = new URL(value.trim())
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) {
      throw new Error()
    }
  } catch {
    return `${label}必须是有效的 http:// 或 https:// 地址，且不能包含账号、密码或 URL 片段。`
  }
  return ''
}

function validateSnapshot(snapshot: SettingsSnapshot) {
  const urls: Array<[string, string]> = [
    ['Ollama 服务地址', snapshot.ollamaUrl],
    ['Dify 服务地址', snapshot.difyUrl],
    ['Home Assistant 服务地址', snapshot.haUrl],
    ['InfluxDB 服务地址', snapshot.influxUrl],
  ]
  for (const [label, value] of urls) {
    const error = validateServiceUrl(label, value)
    if (error) return error
  }
  if (!Number.isInteger(snapshot.jwtHours) || snapshot.jwtHours < 1 || snapshot.jwtHours > 720) {
    return 'Token 有效期必须是 1 至 720 之间的整数小时。'
  }
  if (!Number.isInteger(snapshot.pwdMinLen) || snapshot.pwdMinLen < 4 || snapshot.pwdMinLen > 128) {
    return '最小密码长度必须是 4 至 128 之间的整数。'
  }
  if (!snapshot.influxOrg || !snapshot.influxBucket) return 'InfluxDB 组织名和存储桶不能为空。'
  return ''
}

function testPayload(service: ServiceId, snapshot: SettingsSnapshot): Record<string, unknown> {
  if (service === 'ollama') return { ollama_base_url: snapshot.ollamaUrl }
  if (service === 'dify') return {
    dify_base_url: snapshot.difyUrl,
    ...(isMaskedSecret(snapshot.difyKey) ? {} : { dify_api_key: snapshot.difyKey }),
    ...(isMaskedSecret(snapshot.difyDatasetKey) ? {} : { dify_dataset_api_key: snapshot.difyDatasetKey }),
  }
  if (service === 'homeassistant') return {
    ha_base_url: snapshot.haUrl,
    ...(isMaskedSecret(snapshot.haToken) ? {} : { ha_token: snapshot.haToken }),
  }
  return {
    influxdb_url: snapshot.influxUrl,
    ...(isMaskedSecret(snapshot.influxToken) ? {} : { influxdb_token: snapshot.influxToken }),
    influxdb_org: snapshot.influxOrg,
    influxdb_bucket: snapshot.influxBucket,
  }
}

function statusClasses(status: string) {
  if (status === 'running') return 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
  if (status === 'stale') return 'bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300'
  if (status === 'loading' || status === 'unknown') return 'bg-slate-100 dark:bg-white/[0.06] text-slate-500 dark:text-slate-400'
  return 'bg-red-50 dark:bg-red-500/15 text-red-500 dark:text-red-400'
}

function settingsActionLabel(action: string) {
  if (action === 'save') return '保存配置'
  if (action === 'reset') return '恢复默认'
  if (action === 'test') return '连接测试'
  return '配置操作'
}

/* ── Setting card ── */
function SettingCard({ icon: Icon, title, subtitle, iconBg, iconColor, status, children }: {
  icon: React.ComponentType<{ size?: number; className?: string }>
  title: string; subtitle: string; iconBg: string; iconColor: string
  status?: string; children: React.ReactNode
}) {
  const isRunning = status === 'running'
  const isStale = status === 'stale'
  const normalizedStatus = status || 'unknown'
  return (
    <div className="space-y-6 rounded-[8px] border border-slate-100 bg-white p-6 shadow-sm dark:border-white/[0.06] dark:bg-transparent dark:bg-gradient-to-b dark:from-white/[0.06] dark:to-white/[0.02] dark:shadow-none">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] ${iconBg} ${iconColor}`}>
            <Icon size={21} />
          </div>
          <div className="min-w-0">
            <h4 className="break-words text-base font-black leading-5 text-slate-900 dark:text-white">{title}</h4>
            <p className="mt-0.5 text-xs font-bold leading-4 text-blue-600 dark:text-blue-400">{subtitle}</p>
          </div>
        </div>
        {status && (
          <div className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[6px] px-2 py-1 text-xs font-bold ${statusClasses(normalizedStatus)}`}>
            <div className={`w-1.5 h-1.5 rounded-full ${isRunning ? 'bg-emerald-500' : isStale ? 'bg-amber-500' : normalizedStatus === 'loading' || normalizedStatus === 'unknown' ? 'bg-slate-300' : 'bg-red-500'}`} />
            {serviceStatusLabel(normalizedStatus)}
          </div>
        )}
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  )
}

/* ── Input field ── */
function InputField({ label, value, onChange, type = 'text', placeholder = '', disabled = false, configured, autoComplete }: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  placeholder?: string
  disabled?: boolean
  configured?: boolean
  autoComplete?: string
}) {
  const [showPassword, setShowPassword] = useState(false)
  const isPassword = type === 'password'
  const inputId = useId()

  return (
    <div className="space-y-2">
      <label htmlFor={inputId} className="text-xs font-bold text-slate-500 dark:text-slate-400">{label}</label>
      <div className="relative">
        <input
          id={inputId}
          type={isPassword && !showPassword ? 'password' : 'text'}
          value={value}
          onChange={e => onChange(e.target.value)}
          disabled={disabled}
          autoComplete={autoComplete ?? (isPassword ? 'off' : undefined)}
          placeholder={disabled && isPassword ? (configured ? '已配置（仅管理员可更换）' : '未配置') : placeholder}
          className="w-full rounded-[8px] border border-transparent bg-slate-50 px-4 py-3 pr-12 text-sm font-medium text-slate-900 outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-500/10 disabled:cursor-not-allowed disabled:text-slate-500 disabled:opacity-80 dark:bg-white/[0.06] dark:text-white dark:placeholder:text-slate-500"
        />
        {isPassword && !disabled && (
          <button
            type="button"
            onClick={() => setShowPassword(!showPassword)}
            aria-label={showPassword ? `隐藏${label}` : `显示${label}`}
            title={showPassword ? '隐藏敏感信息' : '显示敏感信息'}
            className="absolute right-2 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-slate-300 transition-colors hover:bg-slate-100 hover:text-slate-500 dark:text-slate-600 dark:hover:bg-white/[0.06] dark:hover:text-slate-400"
          >
            {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
        )}
      </div>
    </div>
  )
}

/* ══════════════════════════════════════════════
   System Settings Page
   ══════════════════════════════════════════════ */

function SettingsContent() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { isAdmin, loading: authLoading } = useAuth()
  const [activeTab, setActiveTab] = useState<SettingsTab>(() => settingsTabFromParam(searchParams.get('tab')))
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [statusLoading, setStatusLoading] = useState(true)
  const [resetting, setResetting] = useState(false)
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)
  const [testingServices, setTestingServices] = useState<Partial<Record<ServiceId, boolean>>>({})

  // ── External service state ──
  const [ollamaUrl, setOllamaUrl] = useState('')
  const [difyUrl, setDifyUrl] = useState('')
  const [difyKey, setDifyKey] = useState('')
  const [difyDatasetKey, setDifyDatasetKey] = useState('')
  const [haUrl, setHaUrl] = useState('')
  const [haToken, setHaToken] = useState('')
  const [influxUrl, setInfluxUrl] = useState('')
  const [influxToken, setInfluxToken] = useState('')
  const [influxOrg, setInfluxOrg] = useState('')
  const [influxBucket, setInfluxBucket] = useState('')

  // ── Service statuses ──
  const [serviceStatus, setServiceStatus] = useState<Record<string, string>>({})

  // ── Security state ──
  const [jwtHours, setJwtHours] = useState(24)
  const [jwtHoursInput, setJwtHoursInput] = useState('24')
  const [allowReg, setAllowReg] = useState(true)
  const [pwdMinLen, setPwdMinLen] = useState(6)
  const [pwdMinLenInput, setPwdMinLenInput] = useState('6')

  // ── System info state ──
  const [sysInfo, setSysInfo] = useState<SystemInfo | null>(null)
  const [settings, setSettings] = useState<RuntimeSettings | null>(null)
  const [configSource, setConfigSource] = useState('default_config')
  const [configError, setConfigError] = useState('')
  const [statusError, setStatusError] = useState('')
  const [infoError, setInfoError] = useState('')
  const [savedSnapshot, setSavedSnapshot] = useState<SettingsSnapshot | null>(null)
  const [testEvidence, setTestEvidence] = useState<Record<string, TestEvidence>>({})
  const [statusTestedAtMs, setStatusTestedAtMs] = useState<number | null>(null)
  const [freshnessNowMs, setFreshnessNowMs] = useState(() => Date.now())
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyItems, setHistoryItems] = useState<SettingsHistoryItem[]>([])
  const [historyPage, setHistoryPage] = useState(1)
  const [historySize, setHistorySize] = useState(20)
  const [historyTotal, setHistoryTotal] = useState(0)
  const [historyAction, setHistoryAction] = useState('')
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [loadedHistoryAction, setLoadedHistoryAction] = useState<string | null>(null)
  const [loadedHistoryPage, setLoadedHistoryPage] = useState(1)
  const [loadedHistorySize, setLoadedHistorySize] = useState(20)
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordSaving, setPasswordSaving] = useState(false)
  const [confirmation, setConfirmation] = useState<SettingsConfirmation | null>(null)
  const confirmationCancelRef = useRef<HTMLButtonElement | null>(null)
  const configRequestRef = useRef(0)
  const statusRequestRef = useRef(0)
  const infoRequestRef = useRef(0)
  const historyRequestRef = useRef(0)
  const configAbortRef = useRef<AbortController | null>(null)
  const statusAbortRef = useRef<AbortController | null>(null)
  const infoAbortRef = useRef<AbortController | null>(null)
  const historyAbortRef = useRef<AbortController | null>(null)
  const saveInFlightRef = useRef(false)
  const resetInFlightRef = useRef(false)
  const passwordInFlightRef = useRef(false)
  const saveAbortRef = useRef<AbortController | null>(null)
  const resetAbortRef = useRef<AbortController | null>(null)
  const passwordAbortRef = useRef<AbortController | null>(null)
  const saveRequestRef = useRef(0)
  const resetRequestRef = useRef(0)
  const passwordRequestRef = useRef(0)
  const mutationReconcileTimerRef = useRef<number | null>(null)
  const mutationReconcileRequestRef = useRef(0)
  const serviceTestReconcileTimerRef = useRef<number | null>(null)
  const serviceTestReconcileRequestRef = useRef(0)
  const serviceTestPendingRef = useRef(new Set<ServiceId>())
  const serviceTestControllersRef = useRef(new Map<ServiceId, AbortController>())
  const serviceTestRequestRef = useRef<Record<ServiceId, number>>({
    ollama: 0,
    dify: 0,
    homeassistant: 0,
    influxdb: 0,
  })
  const writtenSearchRef = useRef(searchParams.toString())
  const allowDirtyNavigationRef = useRef(false)

  const tabs = [
    { id: 'external', label: '外部服务', icon: Wifi },
    { id: 'security', label: '安全设置', icon: Shield },
    { id: 'system', label: '系统信息', icon: Server },
  ]
  const tabIds = tabs.map((item) => item.id as SettingsTab)

  useEffect(() => {
    if (pathname !== '/settings') return
    const incomingSearch = searchParams.toString()
    if (incomingSearch === writtenSearchRef.current) return
    writtenSearchRef.current = incomingSearch
    setActiveTab(settingsTabFromParam(searchParams.get('tab')))
  }, [pathname, searchParams])

  useEffect(() => {
    if (pathname !== '/settings') return
    const query = new URLSearchParams()
    if (activeTab !== 'external') query.set('tab', activeTab)
    const nextSearch = query.toString()
    writtenSearchRef.current = nextSearch
    window.history.replaceState(window.history.state, '', `${pathname}${nextSearch ? `?${nextSearch}` : ''}`)
  }, [activeTab, pathname])

  const applySnapshot = useCallback((snapshot: SettingsSnapshot) => {
    setOllamaUrl(snapshot.ollamaUrl)
    setDifyUrl(snapshot.difyUrl)
    setDifyKey(snapshot.difyKey)
    setDifyDatasetKey(snapshot.difyDatasetKey)
    setHaUrl(snapshot.haUrl)
    setHaToken(snapshot.haToken)
    setInfluxUrl(snapshot.influxUrl)
    setInfluxToken(snapshot.influxToken)
    setInfluxOrg(snapshot.influxOrg)
    setInfluxBucket(snapshot.influxBucket)
    setJwtHours(snapshot.jwtHours)
    setJwtHoursInput(String(snapshot.jwtHours))
    setAllowReg(snapshot.allowReg)
    setPwdMinLen(snapshot.pwdMinLen)
    setPwdMinLenInput(String(snapshot.pwdMinLen))
  }, [])

  const invalidateServiceTest = useCallback((service: ServiceId, clearEvidence = true) => {
    serviceTestRequestRef.current[service] += 1
    serviceTestControllersRef.current.get(service)?.abort()
    serviceTestControllersRef.current.delete(service)
    serviceTestPendingRef.current.delete(service)
    setTestingServices((current) => ({ ...current, [service]: false }))
    if (clearEvidence) {
      setTestEvidence((current) => {
        const next = { ...current }
        delete next[service]
        return next
      })
    }
  }, [])

  const invalidateAllServiceTests = useCallback((clearEvidence = false) => {
    SERVICE_IDS.forEach((service) => {
      serviceTestRequestRef.current[service] += 1
    })
    serviceTestPendingRef.current.clear()
    serviceTestControllersRef.current.forEach((controller) => controller.abort())
    serviceTestControllersRef.current.clear()
    setTestingServices({})
    if (clearEvidence) {
      setServiceStatus({})
      setTestEvidence({})
    }
  }, [])

  // ── Load settings ──
  const loadSettings = useCallback(async (force = false) => {
    configAbortRef.current?.abort()
    const controller = new AbortController()
    configAbortRef.current = controller
    const requestId = ++configRequestRef.current
    try {
      setLoading(true)
      const data = await settingsApi.config(force, controller.signal)
      if (controller.signal.aborted || configRequestRef.current !== requestId) return
      const snapshot = settingsToSnapshot(data)
      setSettings(data)
      setConfigSource(data.config_source || 'default_config')
      setSavedSnapshot(snapshot)
      applySnapshot(snapshot)
      setConfigError('')
    } catch (error) {
      if (controller.signal.aborted || configRequestRef.current !== requestId) return
      const message = errorMessage(error, '加载配置失败')
      setConfigError(message)
      setToast({ message, type: 'error' })
    } finally {
      if (configAbortRef.current === controller) configAbortRef.current = null
      if (configRequestRef.current === requestId) setLoading(false)
    }
  }, [applySnapshot])

  const loadServiceStatus = useCallback(async (force = false) => {
    statusAbortRef.current?.abort()
    const controller = new AbortController()
    statusAbortRef.current = controller
    const requestId = ++statusRequestRef.current
    invalidateAllServiceTests(false)
    try {
      setStatusLoading(true)
      const data = await settingsApi.status(force, controller.signal)
      if (statusRequestRef.current !== requestId) return
      const testedAt = formatDateTime(data.tested_at)
      const testedAtMs = new Date(data.tested_at).getTime()
      const normalizedTestedAtMs = Number.isFinite(testedAtMs) ? testedAtMs : Date.now()
      const nextStatus: Record<string, string> = {}
      const nextEvidence: Record<string, TestEvidence> = {}
      SERVICE_IDS.forEach((service) => {
        const result = data.services[service]
        if (!result) return
        nextStatus[service] = result.status
        nextEvidence[service] = { ...result, tested_at: testedAt, tested_at_ms: normalizedTestedAtMs }
      })
      setServiceStatus(nextStatus)
      setTestEvidence(nextEvidence)
      setStatusTestedAtMs(normalizedTestedAtMs)
      setFreshnessNowMs(Date.now())
      setStatusError('')
    } catch (error) {
      if (!controller.signal.aborted && statusRequestRef.current === requestId) {
        setStatusError(errorMessage(error, '外部服务状态读取失败'))
      }
    } finally {
      if (statusAbortRef.current === controller) statusAbortRef.current = null
      if (statusRequestRef.current === requestId) setStatusLoading(false)
    }
  }, [invalidateAllServiceTests])

  // ── Load system info ──
  const loadSystemInfo = useCallback(async (force = false) => {
    infoAbortRef.current?.abort()
    const controller = new AbortController()
    infoAbortRef.current = controller
    const requestId = ++infoRequestRef.current
    try {
      const value = await settingsApi.info(force, controller.signal)
      if (infoRequestRef.current !== requestId) return
      setSysInfo(value)
      setInfoError('')
    } catch (error) {
      if (!controller.signal.aborted && infoRequestRef.current === requestId) {
        setInfoError(errorMessage(error, '系统信息读取失败'))
      }
    } finally {
      if (infoAbortRef.current === controller) infoAbortRef.current = null
    }
  }, [])

  const loadHistory = useCallback(async (force = false) => {
    if (!historyOpen || !isAdmin) return
    historyAbortRef.current?.abort()
    const controller = new AbortController()
    historyAbortRef.current = controller
    const requestId = ++historyRequestRef.current
    const requestedAction = historyAction
    try {
      setHistoryLoading(true)
      const result = await settingsApi.history({
        page: historyPage,
        size: historySize,
        action: historyAction,
      }, force, controller.signal)
      if (historyRequestRef.current !== requestId) return
      setHistoryItems(result.items)
      setHistoryTotal(result.total)
      setLoadedHistoryAction(requestedAction)
      setLoadedHistoryPage(result.page)
      setLoadedHistorySize(result.size)
      if (result.page !== historyPage) setHistoryPage(result.page)
      setHistoryLoaded(true)
      setHistoryError('')
    } catch (error) {
      if (!controller.signal.aborted && historyRequestRef.current === requestId) {
        setHistoryError(errorMessage(error, '配置记录读取失败'))
      }
    } finally {
      if (historyAbortRef.current === controller) historyAbortRef.current = null
      if (historyRequestRef.current === requestId) setHistoryLoading(false)
    }
  }, [historyAction, historyOpen, historyPage, historySize, isAdmin])

  const historySnapshotMatchesView = historyLoaded
    && loadedHistoryAction === historyAction
    && loadedHistoryPage === historyPage
    && loadedHistorySize === historySize

  const invalidateHistoryView = useCallback(() => {
    historyRequestRef.current += 1
    historyAbortRef.current?.abort()
    historyAbortRef.current = null
    setHistoryError('')
    setHistoryLoading(true)
  }, [])

  useEffect(() => {
    void loadSettings()
    void loadServiceStatus()
    void loadSystemInfo()
    const serviceTestRequests = serviceTestRequestRef.current
    const pendingServiceTests = serviceTestPendingRef.current
    const serviceTestControllers = serviceTestControllersRef.current
    return () => {
      configRequestRef.current += 1
      statusRequestRef.current += 1
      infoRequestRef.current += 1
      historyRequestRef.current += 1
      configAbortRef.current?.abort()
      statusAbortRef.current?.abort()
      infoAbortRef.current?.abort()
      historyAbortRef.current?.abort()
      configAbortRef.current = null
      statusAbortRef.current = null
      infoAbortRef.current = null
      historyAbortRef.current = null
      SERVICE_IDS.forEach((service) => {
        serviceTestRequests[service] += 1
      })
      pendingServiceTests.clear()
      serviceTestControllers.forEach((controller) => controller.abort())
      serviceTestControllers.clear()
      saveAbortRef.current?.abort()
      resetAbortRef.current?.abort()
      passwordAbortRef.current?.abort()
      saveRequestRef.current += 1
      resetRequestRef.current += 1
      passwordRequestRef.current += 1
      mutationReconcileRequestRef.current += 1
      serviceTestReconcileRequestRef.current += 1
      if (mutationReconcileTimerRef.current !== null) window.clearTimeout(mutationReconcileTimerRef.current)
      if (serviceTestReconcileTimerRef.current !== null) window.clearTimeout(serviceTestReconcileTimerRef.current)
      serviceTestReconcileTimerRef.current = null
      saveInFlightRef.current = false
      resetInFlightRef.current = false
      passwordInFlightRef.current = false
    }
  }, [loadSettings, loadServiceStatus, loadSystemInfo])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  useEffect(() => {
    if (activeTab !== 'external') return
    let timer: number | null = null
    const updateFreshness = () => setFreshnessNowMs(Date.now())
    const refreshStaleStatus = () => {
      const testedAt = statusTestedAtMs
      if (document.visibilityState !== 'visible' || statusLoading || !testedAt) return
      if (Date.now() - testedAt >= STATUS_STALE_AFTER_MS) void loadServiceStatus(true)
    }
    const stopFreshnessClock = () => {
      if (timer === null) return
      window.clearInterval(timer)
      timer = null
    }
    const startFreshnessClock = () => {
      stopFreshnessClock()
      if (document.visibilityState !== 'visible') return
      updateFreshness()
      refreshStaleStatus()
      timer = window.setInterval(() => {
        updateFreshness()
        refreshStaleStatus()
      }, STATUS_FRESHNESS_TICK_MS)
    }
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') startFreshnessClock()
      else stopFreshnessClock()
    }
    startFreshnessClock()
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      stopFreshnessClock()
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [activeTab, loadServiceStatus, statusLoading, statusTestedAtMs])

  const reconcileSettingsMutation = () => {
    const reconcileRequestId = ++mutationReconcileRequestRef.current
    if (mutationReconcileTimerRef.current !== null) window.clearTimeout(mutationReconcileTimerRef.current)
    const readFinalState = () => Promise.allSettled([
      loadSettings(true),
      loadServiceStatus(true),
      loadSystemInfo(true),
      ...(historyOpen ? [loadHistory(true)] : []),
    ])
    void readFinalState().then(() => {
      if (mutationReconcileRequestRef.current !== reconcileRequestId) return
      mutationReconcileTimerRef.current = window.setTimeout(() => {
        if (mutationReconcileRequestRef.current !== reconcileRequestId) return
        mutationReconcileTimerRef.current = null
        void readFinalState()
      }, 1200)
    })
  }

  const cancelSaveWait = () => {
    if (!saveInFlightRef.current) return
    saveAbortRef.current?.abort()
    saveAbortRef.current = null
    saveRequestRef.current += 1
    saveInFlightRef.current = false
    setSaving(false)
    reconcileSettingsMutation()
    setToast({ message: '已取消等待；配置可能已经保存，正在重新读取已生效配置和变更记录', type: 'error' })
  }

  const cancelResetWait = () => {
    if (!resetInFlightRef.current) return
    resetAbortRef.current?.abort()
    resetAbortRef.current = null
    resetRequestRef.current += 1
    resetInFlightRef.current = false
    setResetting(false)
    reconcileSettingsMutation()
    setToast({ message: '已取消等待；默认来源可能已经恢复，正在重新读取最终配置', type: 'error' })
  }

  const clearPasswordDraft = () => {
    setOldPassword('')
    setNewPassword('')
    setConfirmPassword('')
  }

  const cancelPasswordWait = () => {
    if (!passwordInFlightRef.current) return
    passwordAbortRef.current?.abort()
    passwordAbortRef.current = null
    passwordRequestRef.current += 1
    passwordInFlightRef.current = false
    setPasswordSaving(false)
    clearPasswordDraft()
    setToast({ message: '已取消等待；密码可能已经修改，请勿立即重复提交，下一次登录时按最终密码验证', type: 'error' })
  }

  // ── Save config ──
  const handleSave = async () => {
    if (saveInFlightRef.current) {
      cancelSaveWait()
      return
    }
    if (saveInFlightRef.current || resetInFlightRef.current) return
    if (!isAdmin || !settings?.can_manage) {
      setToast({ message: '当前账号没有修改系统配置的权限', type: 'error' })
      return
    }
    const validationError = validateSnapshot(currentSnapshot)
    if (validationError) {
      setToast({ message: validationError, type: 'error' })
      return
    }
    const controller = new AbortController()
    const requestId = ++saveRequestRef.current
    saveAbortRef.current = controller
    try {
      invalidateAllServiceTests(true)
      saveInFlightRef.current = true
      setSaving(true)
      const payload: SettingsWritePayload = {
        ollama_base_url: ollamaUrl,
        dify_base_url: difyUrl,
        dify_api_key: isMaskedSecret(difyKey) ? undefined : difyKey,
        dify_dataset_api_key: isMaskedSecret(difyDatasetKey) ? undefined : difyDatasetKey,
        ha_base_url: haUrl,
        ha_token: isMaskedSecret(haToken) ? undefined : haToken,
        influxdb_url: influxUrl,
        influxdb_token: isMaskedSecret(influxToken) ? undefined : influxToken,
        influxdb_org: influxOrg,
        influxdb_bucket: influxBucket,
        jwt_expire_hours: jwtHours,
        allow_registration: allowReg,
        password_min_length: pwdMinLen,
      }
      const result = await settingsApi.save(payload, controller.signal)
      if (saveRequestRef.current !== requestId) return
      setToast({ message: result.message, type: 'success' })
      reconcileSettingsMutation()
    } catch (error) {
      if (saveRequestRef.current !== requestId || isAbortError(error)) return
      if (error instanceof ApiError && error.status === 0) {
        reconcileSettingsMutation()
        setToast({ message: '保存请求超时或网络中断，配置可能已经生效；正在重新读取最终状态，请勿立即重复保存', type: 'error' })
        return
      }
      setToast({ message: errorMessage(error, '保存失败，请重试'), type: 'error' })
    } finally {
      if (saveRequestRef.current !== requestId) return
      saveAbortRef.current = null
      saveInFlightRef.current = false
      setSaving(false)
    }
  }

  // ── Test connection ──
  const handleTestConnection = async (service: ServiceId) => {
    serviceTestReconcileRequestRef.current += 1
    if (serviceTestReconcileTimerRef.current !== null) {
      window.clearTimeout(serviceTestReconcileTimerRef.current)
      serviceTestReconcileTimerRef.current = null
    }
    if (serviceTestPendingRef.current.has(service)) {
      const testingDraft = serviceHasDraftChanges(service, savedSnapshot, currentSnapshot)
      invalidateServiceTest(service, false)
      if (testingDraft) {
        setTestEvidence((current) => {
          const next = { ...current }
          delete next[service]
          return next
        })
        setToast({ message: `已取消等待 ${SERVICE_LABELS[service]} 草稿探测，未保存配置仍未生效`, type: 'success' })
      } else {
        setToast({ message: `已取消等待 ${SERVICE_LABELS[service]} 探测，正在重新读取已生效状态`, type: 'success' })
        const reconcileRequestId = ++serviceTestReconcileRequestRef.current
        if (serviceTestReconcileTimerRef.current !== null) window.clearTimeout(serviceTestReconcileTimerRef.current)
        void loadServiceStatus(true).then(() => {
          if (serviceTestReconcileRequestRef.current !== reconcileRequestId) return
          serviceTestReconcileTimerRef.current = window.setTimeout(() => {
            if (serviceTestReconcileRequestRef.current !== reconcileRequestId) return
            serviceTestReconcileTimerRef.current = null
            void loadServiceStatus(true)
          }, 1200)
        })
      }
      return
    }
    // 整组状态探测与单项测试会更新同一份证据，禁止并发可避免旧请求失效后 loading 无法收尾。
    if (statusLoading) return
    if (saveInFlightRef.current || resetInFlightRef.current) return
    if (isAdmin && settings?.can_manage) {
      const serviceUrl = service === 'ollama' ? ollamaUrl : service === 'dify' ? difyUrl : service === 'homeassistant' ? haUrl : influxUrl
      const validationError = validateServiceUrl(`${SERVICE_LABELS[service]} 服务地址`, serviceUrl)
      if (validationError) {
        setToast({ message: validationError, type: 'error' })
        return
      }
      if (service === 'influxdb' && (!influxOrg.trim() || !influxBucket.trim())) {
        setToast({ message: 'InfluxDB 组织名和存储桶不能为空。', type: 'error' })
        return
      }
    }
    const requestId = ++serviceTestRequestRef.current[service]
    const controller = new AbortController()
    serviceTestControllersRef.current.set(service, controller)
    serviceTestPendingRef.current.add(service)
    statusRequestRef.current += 1
    setStatusLoading(false)
    try {
      setTestingServices((current) => ({ ...current, [service]: true }))
      const payload = isAdmin && settings?.can_manage ? testPayload(service, currentSnapshot) : {}
      const result = await settingsApi.test(service, payload, controller.signal)
      if (serviceTestRequestRef.current[service] !== requestId) return
      setServiceStatus(prev => ({ ...prev, [service]: result.status }))
      setTestEvidence(prev => ({
        ...prev,
        [service]: {
          ...result,
          tested_at: new Date().toLocaleString('zh-CN', { hour12: false }),
          tested_at_ms: Date.now(),
        },
      }))
      setFreshnessNowMs(Date.now())
      setToast({
        message: result.status === 'running'
          ? `${SERVICE_LABELS[service]} 连接成功（${serviceLatencyLabel(result.latency_ms)}）`
          : result.message,
        type: result.status === 'running' ? 'success' : 'error',
      })
    } catch (error) {
      if (serviceTestRequestRef.current[service] === requestId) {
        if (controller.signal.aborted) return
        setToast({ message: errorMessage(error, `测试 ${SERVICE_LABELS[service]} 连接失败`), type: 'error' })
      }
    } finally {
      if (serviceTestRequestRef.current[service] === requestId) {
        serviceTestPendingRef.current.delete(service)
        if (serviceTestControllersRef.current.get(service) === controller) {
          serviceTestControllersRef.current.delete(service)
        }
        setTestingServices((current) => ({ ...current, [service]: false }))
      }
    }
  }

  const currentSnapshot = normalizeSnapshot({
    ollamaUrl,
    difyUrl,
    difyKey,
    difyDatasetKey,
    haUrl,
    haToken,
    influxUrl,
    influxToken,
    influxOrg,
    influxBucket,
    jwtHours: jwtHoursInput === '' ? Number.NaN : Number(jwtHoursInput),
    allowReg,
    pwdMinLen: pwdMinLenInput === '' ? Number.NaN : Number(pwdMinLenInput),
  })
  const canManage = Boolean(isAdmin && settings?.can_manage)
  const settingsPending = authLoading || loading
  const configSourceLabel = !settings
    ? configError ? '配置来源未取得' : '正在确认配置来源'
    : configSource === 'database_overrides' ? '数据库运行时配置' : '默认配置 / config.yaml 兜底'
  const hasChanges = canManage && !sameSettings(savedSnapshot, currentSnapshot)
  const serviceDraftChanges = SERVICE_IDS.reduce<Record<ServiceId, boolean>>((result, service) => {
    result[service] = canManage && serviceHasDraftChanges(service, savedSnapshot, currentSnapshot)
    return result
  }, { ollama: false, dify: false, homeassistant: false, influxdb: false })
  const serviceEvidenceStale = SERVICE_IDS.reduce<Record<ServiceId, boolean>>((result, service) => {
    const evidence = testEvidence[service]
    result[service] = Boolean(evidence && freshnessNowMs - evidence.tested_at_ms >= STATUS_STALE_AFTER_MS)
    return result
  }, { ollama: false, dify: false, homeassistant: false, influxdb: false })
  const configurationBusy = saving || resetting
  const passwordDraftDirty = Boolean(oldPassword || newPassword || confirmPassword)

  useEffect(() => {
    if (!configError && !statusError && !infoError && !historyError) return
    const recoverFailedReads = () => {
      if (!navigator.onLine || document.visibilityState !== 'visible' || configurationBusy || passwordSaving) return
      if (configError && !hasChanges && !configAbortRef.current) void loadSettings(true)
      if (statusError && !statusAbortRef.current && serviceTestPendingRef.current.size === 0) {
        void loadServiceStatus(true)
      }
      if (infoError && !infoAbortRef.current) void loadSystemInfo(true)
      if (historyError && historyOpen && !historyAbortRef.current) void loadHistory(true)
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
  }, [
    configError,
    configurationBusy,
    hasChanges,
    historyError,
    historyOpen,
    infoError,
    loadHistory,
    loadServiceStatus,
    loadSettings,
    loadSystemInfo,
    passwordSaving,
    statusError,
  ])

  useEffect(() => {
    if (!hasChanges && !passwordDraftDirty) return
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (allowDirtyNavigationRef.current) return
      event.preventDefault()
      event.returnValue = ''
    }
    const handleInternalNavigation = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const target = event.target instanceof Element ? event.target.closest('a[href]') : null
      if (!(target instanceof HTMLAnchorElement) || target.target === '_blank' || target.hasAttribute('download')) return
      const destination = new URL(target.href, window.location.href)
      if (destination.origin !== window.location.origin || destination.pathname === pathname) return
      const message = passwordDraftDirty && hasChanges
        ? '当前有未保存的系统配置和密码输入，确认放弃并离开系统设置吗？'
        : passwordDraftDirty
          ? '当前有尚未提交的密码输入，确认放弃并离开系统设置吗？'
          : '当前有未保存的系统配置，确认放弃并离开系统设置吗？'
      event.preventDefault()
      event.stopPropagation()
      setConfirmation({ kind: 'navigate', href: destination.href, message })
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    document.addEventListener('click', handleInternalNavigation, true)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      document.removeEventListener('click', handleInternalNavigation, true)
    }
  }, [hasChanges, passwordDraftDirty, pathname])

  const discardChanges = () => {
    if (!savedSnapshot || configurationBusy) return
    invalidateAllServiceTests(true)
    applySnapshot(savedSnapshot)
    setToast({ message: '已放弃未保存修改', type: 'success' })
  }

  const executeReset = async () => {
    if (!canManage || !settings?.override_keys?.length || saveInFlightRef.current || resetInFlightRef.current) return
    const controller = new AbortController()
    const requestId = ++resetRequestRef.current
    resetAbortRef.current = controller
    try {
      invalidateAllServiceTests(true)
      resetInFlightRef.current = true
      setResetting(true)
      const result = await settingsApi.reset([], controller.signal)
      if (resetRequestRef.current !== requestId) return
      setToast({ message: result.message, type: 'success' })
      reconcileSettingsMutation()
    } catch (error) {
      if (resetRequestRef.current !== requestId || isAbortError(error)) return
      if (error instanceof ApiError && error.status === 0) {
        reconcileSettingsMutation()
        setToast({ message: '恢复请求超时或网络中断，默认来源可能已经生效；正在重新读取最终配置', type: 'error' })
        return
      }
      setToast({ message: errorMessage(error, '恢复默认配置失败'), type: 'error' })
    } finally {
      if (resetRequestRef.current !== requestId) return
      resetAbortRef.current = null
      resetInFlightRef.current = false
      setResetting(false)
    }
  }

  const handleReset = () => {
    if (resetInFlightRef.current) {
      cancelResetWait()
      return
    }
    if (!canManage || !settings?.override_keys?.length || saveInFlightRef.current || resetInFlightRef.current) return
    setConfirmation({
      kind: 'reset',
      message: `确认删除 ${settings.override_keys.length} 项数据库运行时覆盖并恢复默认配置来源？配置文件和历史密钥不会被修改。`,
    })
  }

  const handleChangePassword = async () => {
    if (passwordInFlightRef.current) {
      cancelPasswordWait()
      return
    }
    if (!oldPassword || !newPassword || !confirmPassword) {
      setToast({ message: '请完整填写旧密码、新密码和确认密码', type: 'error' })
      return
    }
    if (newPassword.length < pwdMinLen) {
      setToast({ message: `新密码不能少于 ${pwdMinLen} 位`, type: 'error' })
      return
    }
    if (newPassword !== confirmPassword) {
      setToast({ message: '两次输入的新密码不一致', type: 'error' })
      return
    }
    if (oldPassword === newPassword) {
      setToast({ message: '新密码不能与旧密码相同', type: 'error' })
      return
    }
    const controller = new AbortController()
    const requestId = ++passwordRequestRef.current
    passwordAbortRef.current = controller
    try {
      passwordInFlightRef.current = true
      setPasswordSaving(true)
      const result = await authApi.changePassword(oldPassword, newPassword, controller.signal)
      if (passwordRequestRef.current !== requestId) return
      setToast({ message: result.message || '密码已修改', type: 'success' })
    } catch (error) {
      if (passwordRequestRef.current !== requestId || isAbortError(error)) return
      if (error instanceof ApiError && error.status === 0) {
        setToast({ message: '修改密码请求超时或网络中断，密码可能已经修改；请勿立即重复提交', type: 'error' })
        return
      }
      setToast({ message: errorMessage(error, '密码修改失败'), type: 'error' })
    } finally {
      clearPasswordDraft()
      if (passwordRequestRef.current !== requestId) return
      passwordAbortRef.current = null
      passwordInFlightRef.current = false
      setPasswordSaving(false)
    }
  }

  const performRefreshAll = () => {
    if (configurationBusy) return
    invalidateAllServiceTests(true)
    clearSettingsCache()
    void loadSettings(true)
    void loadServiceStatus(true)
    void loadSystemInfo(true)
  }

  const refreshAll = () => {
    if (configurationBusy) return
    if (hasChanges) {
      setConfirmation({ kind: 'refresh', message: '当前有未保存的配置修改。确认放弃这些修改并重新读取已生效配置？' })
      return
    }
    performRefreshAll()
  }

  const confirmPendingAction = () => {
    const pending = confirmation
    if (!pending) return
    setConfirmation(null)
    if (pending.kind === 'navigate') {
      allowDirtyNavigationRef.current = true
      window.location.assign(pending.href)
      return
    }
    if (pending.kind === 'refresh') {
      performRefreshAll()
      return
    }
    void executeReset()
  }

  return (
    <div className="max-w-7xl mx-auto space-y-12">
      {/* Toast */}
      <AnimatePresence>
        {toast && <InlineToast message={toast.message} tone={toast.type} onClose={() => setToast(null)} />}
      </AnimatePresence>
      {confirmation ? (
        <AppDialog
          title={confirmation.kind === 'reset' ? '恢复默认配置来源' : '放弃未保存修改'}
          onClose={() => setConfirmation(null)}
          maxWidth="max-w-md"
          danger={confirmation.kind === 'reset'}
          initialFocusRef={confirmationCancelRef}
          footer={(
            <div className="flex justify-end gap-3">
              <button ref={confirmationCancelRef} type="button" onClick={() => setConfirmation(null)} className="rounded-[8px] px-5 py-2.5 text-sm font-bold text-slate-500 transition hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200">取消</button>
              <button type="button" onClick={confirmPendingAction} className={`rounded-[8px] px-5 py-2.5 text-sm font-bold text-white transition ${confirmation.kind === 'reset' ? 'bg-red-500 hover:bg-red-600' : 'bg-blue-600 hover:bg-blue-700'}`}>
                {confirmation.kind === 'reset' ? '确认恢复' : confirmation.kind === 'navigate' ? '放弃并离开' : '放弃并刷新'}
              </button>
            </div>
          )}
        >
          <p className="text-sm leading-6 text-slate-500 dark:text-slate-400">{confirmation.message}</p>
        </AppDialog>
      ) : null}

      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-6">
        <div className="space-y-2">
          <h2 className="text-4xl font-black text-slate-900 dark:text-white">系统设置</h2>
          <p className="text-slate-500 dark:text-slate-400 font-medium">全局配置与服务集成</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {hasChanges && (
            <button
              type="button"
              onClick={discardChanges}
              disabled={configurationBusy}
              className="flex items-center gap-2 rounded-[8px] border border-slate-200 bg-white px-5 py-3 text-sm font-bold text-slate-600 transition hover:border-blue-200 hover:text-blue-600 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-slate-300"
            >
              <Undo2 size={17} />
              放弃修改
            </button>
          )}
          {canManage ? (
            <button
              type="button"
              onClick={handleSave}
              disabled={!saving && !hasChanges || resetting}
              className={`flex items-center gap-2 rounded-[8px] px-8 py-3 text-sm font-bold transition-all ${
                !saving && !hasChanges || resetting
                  ? 'bg-slate-100 dark:bg-white/[0.05] text-slate-400 cursor-not-allowed'
                  : 'bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-500/20'
              }`}
            >
              {saving ? <XCircle size={18} /> : <Save size={18} />}
              {saving ? '取消等待' : hasChanges ? '保存配置' : '暂无变更'}
            </button>
          ) : (
            <span className="flex items-center gap-2 rounded-[8px] bg-slate-100 px-5 py-3 text-sm font-bold text-slate-500 dark:bg-white/[0.06] dark:text-slate-300">
              {settingsPending ? <Loader2 size={16} className="animate-spin" /> : <Lock size={16} />}
              {settingsPending ? '正在确认权限' : '当前为只读'}
            </span>
          )}
        </div>
      </div>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="rounded-[8px] border border-blue-100 bg-blue-50/70 p-5 dark:border-blue-500/10 dark:bg-blue-500/10">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-blue-700 dark:text-blue-300">
              <Info size={18} />
              <h3 className="text-sm font-black">配置来源与保存审计</h3>
            </div>
            {canManage ? (
              <button
                type="button"
                onClick={() => setHistoryOpen(true)}
                className="inline-flex min-h-9 items-center gap-2 rounded-[8px] bg-white px-3 py-2 text-xs font-bold text-blue-700 shadow-sm transition hover:bg-blue-100 dark:bg-white/[0.06] dark:text-blue-300 dark:hover:bg-white/[0.1]"
              >
                <History size={14} />
                变更记录
              </button>
            ) : null}
          </div>
          <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
            当前来源：<span className="font-black text-slate-900 dark:text-white">{configSourceLabel}</span>。{!settings ? configError ? '当前尚未取得已生效配置，请重新读取。' : '正在读取已生效配置与账号权限。' : canManage ? '保存成功后后端会写入平台审计日志，只记录更新项名称，不记录密钥明文。' : '当前账号可查看配置和测试已保存连接，修改与恢复默认仅管理员可操作。'}
          </p>
        </div>
        <div className="rounded-[8px] border border-slate-200 bg-slate-50 p-5 dark:border-white/[0.08] dark:bg-white/[0.04]">
          <div className="flex items-center gap-2 text-slate-700 dark:text-slate-200">
            <Lock size={18} />
            <h3 className="text-sm font-black">凭证保护</h3>
          </div>
          <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
            {!settings ? settingsPending ? '正在确认当前账号权限与凭证配置状态。' : '凭证配置状态尚未取得，页面不会展示或推断密钥内容。' : canManage ? '页面仅显示脱敏后的凭证状态；只有主动输入新的 API Key 或 Token 时才会更新，变更结果记录在配置审计中。' : '当前账号只能查看凭证是否已配置，接口不会返回密钥内容、脱敏尾缀或运行地址。'}
          </p>
        </div>
      </section>

      {/* Tabs */}
      <div className="flex gap-8 border-b border-slate-100 dark:border-white/[0.06]" role="tablist" aria-label="系统设置视图">
        {tabs.map(tab => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`settings-tab-${tab.id}`}
            data-tab-id={tab.id}
            aria-selected={activeTab === tab.id}
            aria-controls="settings-tab-panel"
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => setActiveTab(tab.id as SettingsTab)}
            onKeyDown={(event) => handleTabListKeyDown(event, tabIds, activeTab, setActiveTab)}
            className={`pb-4 text-sm font-bold transition-all relative flex items-center gap-2 ${
              activeTab === tab.id
                ? 'text-blue-600 dark:text-blue-400'
                : 'text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300'
            }`}
          >
            <tab.icon size={16} />
            {tab.label}
            {activeTab === tab.id && (
              <motion.div layoutId="settingsTab" className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600 dark:bg-blue-400" />
            )}
          </button>
        ))}
      </div>

      {loading || authLoading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 size={32} className="animate-spin text-slate-300 dark:text-slate-600" />
        </div>
      ) : configError || !settings ? (
        <div className="rounded-[8px] border border-red-100 bg-red-50 px-6 py-5 text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-black">系统配置读取失败</p>
              <p className="mt-1 text-sm">{configError || '后端没有返回可用的系统配置。'}</p>
            </div>
            <button type="button" onClick={refreshAll} className="inline-flex items-center justify-center gap-2 rounded-[8px] border border-red-200 bg-white px-4 py-2 text-sm font-bold dark:border-red-400/20 dark:bg-transparent">
              <RefreshCw size={15} />重新读取
            </button>
          </div>
        </div>
      ) : (
        <div id="settings-tab-panel" role="tabpanel" aria-labelledby={`settings-tab-${activeTab}`}>
          {/* ═══ Tab 1: External Services ═══ */}
          {activeTab === 'external' && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-8"
            >
              {/* Top Grid */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* Ollama */}
                <SettingCard
                  icon={Cpu} title="Ollama" subtitle="LLM 推理引擎"
                  iconBg="bg-blue-50 dark:bg-blue-900/20" iconColor="text-blue-600 dark:text-blue-400"
                  status={statusLoading ? 'loading' : serviceEvidenceStale.ollama ? 'stale' : serviceStatus.ollama || 'unknown'}
                >
                  <InputField label="端点 URL" value={ollamaUrl} placeholder={!canManage ? '运行配置由管理员维护' : ''} onChange={(value) => { invalidateServiceTest('ollama'); setOllamaUrl(value) }} disabled={!canManage || configurationBusy} />
                  <button
                    onClick={() => handleTestConnection('ollama')}
                    disabled={(statusLoading && !testingServices.ollama) || saving || resetting}
                    title={statusLoading && !testingServices.ollama ? '请等待全部外部服务探测完成' : undefined}
                    className="flex w-full items-center justify-center gap-2 rounded-[8px] border border-slate-100 py-3 text-xs font-bold text-blue-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/[0.08] dark:text-blue-400 dark:hover:bg-white/[0.04]"
                  >
                    {testingServices.ollama ? <XCircle size={14} /> : <Wifi size={14} />}
                    {testingServices.ollama ? '取消等待' : serviceDraftChanges.ollama ? '测试草稿连接' : '测试已生效连接'}
                  </button>
                </SettingCard>

                {/* Dify */}
                <SettingCard
                  icon={Workflow} title="Dify" subtitle="知识库 & 智能体"
                  iconBg="bg-indigo-50 dark:bg-indigo-900/20" iconColor="text-indigo-600 dark:text-indigo-400"
                  status={statusLoading ? 'loading' : serviceEvidenceStale.dify ? 'stale' : serviceStatus.dify || 'unknown'}
                >
                  <InputField label="服务地址" value={difyUrl} placeholder={!canManage ? '运行配置由管理员维护' : ''} onChange={(value) => { invalidateServiceTest('dify'); setDifyUrl(value) }} disabled={!canManage || configurationBusy} />
                  <InputField label="应用 API Key" value={difyKey} onChange={(value) => { invalidateServiceTest('dify'); setDifyKey(value) }} type="password" disabled={!canManage || configurationBusy} configured={settings.services.dify?.token_configured} />
                  <InputField label="知识库 API Key" value={difyDatasetKey} onChange={(value) => { invalidateServiceTest('dify'); setDifyDatasetKey(value) }} type="password" disabled={!canManage || configurationBusy} configured={settings.services.dify?.extra?.dataset_token_configured === 'true'} />
                  <div className="rounded-[8px] bg-slate-50 px-4 py-3 text-xs font-medium text-slate-500 dark:bg-white/[0.04] dark:text-slate-400">
                    对话与会话记录使用应用 API Key，知识库列表、文档管理与语义检索使用知识库 API Key。
                  </div>
                  <button
                    onClick={() => handleTestConnection('dify')}
                    disabled={(statusLoading && !testingServices.dify) || saving || resetting}
                    title={statusLoading && !testingServices.dify ? '请等待全部外部服务探测完成' : undefined}
                    className="flex w-full items-center justify-center gap-2 rounded-[8px] border border-slate-100 py-3 text-xs font-bold text-blue-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/[0.08] dark:text-blue-400 dark:hover:bg-white/[0.04]"
                  >
                    {testingServices.dify ? <XCircle size={14} /> : <Wifi size={14} />}
                    {testingServices.dify ? '取消等待' : serviceDraftChanges.dify ? '测试草稿连接' : '测试已生效连接'}
                  </button>
                </SettingCard>

                {/* Home Assistant */}
                <SettingCard
                  icon={Home} title="Home Assistant" subtitle="物联网设备控制"
                  iconBg="bg-orange-50 dark:bg-orange-900/20" iconColor="text-orange-600 dark:text-orange-400"
                  status={statusLoading ? 'loading' : serviceEvidenceStale.homeassistant ? 'stale' : serviceStatus.homeassistant || 'unknown'}
                >
                  <InputField label="服务地址" value={haUrl} placeholder={!canManage ? '运行配置由管理员维护' : ''} onChange={(value) => { invalidateServiceTest('homeassistant'); setHaUrl(value) }} disabled={!canManage || configurationBusy} />
                  <InputField label="长效 Token" value={haToken} onChange={(value) => { invalidateServiceTest('homeassistant'); setHaToken(value) }} type="password" disabled={!canManage || configurationBusy} configured={settings.services.homeassistant?.token_configured} />
                  <button
                    onClick={() => handleTestConnection('homeassistant')}
                    disabled={(statusLoading && !testingServices.homeassistant) || saving || resetting}
                    title={statusLoading && !testingServices.homeassistant ? '请等待全部外部服务探测完成' : undefined}
                    className="flex w-full items-center justify-center gap-2 rounded-[8px] border border-slate-100 py-3 text-xs font-bold text-blue-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/[0.08] dark:text-blue-400 dark:hover:bg-white/[0.04]"
                  >
                    {testingServices.homeassistant ? <XCircle size={14} /> : <Wifi size={14} />}
                    {testingServices.homeassistant ? '取消等待' : serviceDraftChanges.homeassistant ? '测试草稿连接' : '测试已生效连接'}
                  </button>
                </SettingCard>
              </div>

              {/* InfluxDB (wide card) */}
              <div className="rounded-[8px] border border-slate-100 bg-white p-6 shadow-sm dark:border-white/[0.06] dark:bg-transparent dark:bg-gradient-to-b dark:from-white/[0.06] dark:to-white/[0.02] dark:shadow-none">
                <div className="flex flex-col items-start gap-8 xl:flex-row">
                  <div className="flex min-w-[200px] items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-[8px] bg-purple-50 text-purple-600 dark:bg-purple-900/20 dark:text-purple-400">
                      <Database size={21} />
                    </div>
                    <div>
                      <h4 className="text-base font-black text-slate-900 dark:text-white">InfluxDB</h4>
                      <p className="mt-0.5 text-xs font-bold text-purple-600 dark:text-purple-400">时序数据库</p>
                    </div>
                    <div className={`ml-auto flex items-center gap-2 rounded-[6px] px-2 py-1 text-xs font-bold ${statusClasses(statusLoading ? 'loading' : serviceEvidenceStale.influxdb ? 'stale' : serviceStatus.influxdb || 'unknown')}`}>
                      <div className={`w-1.5 h-1.5 rounded-full ${statusLoading || !serviceStatus.influxdb ? 'bg-slate-300' : serviceEvidenceStale.influxdb ? 'bg-amber-500' : serviceStatus.influxdb === 'running' ? 'bg-emerald-500' : 'bg-red-500'}`} />
                      {serviceStatusLabel(statusLoading ? 'loading' : serviceEvidenceStale.influxdb ? 'stale' : serviceStatus.influxdb || 'unknown')}
                    </div>
                  </div>
                  <div className="flex-1 w-full grid grid-cols-1 sm:grid-cols-2 gap-6">
                    <InputField label="服务地址" value={influxUrl} placeholder={!canManage ? '运行配置由管理员维护' : ''} onChange={(value) => { invalidateServiceTest('influxdb'); setInfluxUrl(value) }} disabled={!canManage || configurationBusy} />
                    <InputField label="访问令牌" value={influxToken} onChange={(value) => { invalidateServiceTest('influxdb'); setInfluxToken(value) }} type="password" disabled={!canManage || configurationBusy} configured={settings.services.influxdb?.token_configured} />
                    <InputField label="组织名" value={influxOrg} placeholder={!canManage ? '运行配置由管理员维护' : ''} onChange={(value) => { invalidateServiceTest('influxdb'); setInfluxOrg(value) }} disabled={!canManage || configurationBusy} />
                    <InputField label="存储桶" value={influxBucket} placeholder={!canManage ? '运行配置由管理员维护' : ''} onChange={(value) => { invalidateServiceTest('influxdb'); setInfluxBucket(value) }} disabled={!canManage || configurationBusy} />
                  </div>
                  <div className="w-full self-end xl:w-auto">
                    <button
                      onClick={() => handleTestConnection('influxdb')}
                      disabled={(statusLoading && !testingServices.influxdb) || saving || resetting}
                      title={statusLoading && !testingServices.influxdb ? '请等待全部外部服务探测完成' : undefined}
                      className="flex w-full items-center justify-center gap-2 rounded-[8px] border border-slate-100 px-6 py-3 text-xs font-bold text-blue-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 xl:w-auto dark:border-white/[0.08] dark:text-blue-400 dark:hover:bg-white/[0.04]"
                    >
                      {testingServices.influxdb ? <XCircle size={14} /> : <Wifi size={14} />}
                      {testingServices.influxdb ? '取消等待' : serviceDraftChanges.influxdb ? '测试草稿连接' : '测试已生效连接'}
                    </button>
                  </div>
                </div>
                <p className="mt-6 text-xs font-medium text-slate-400 dark:text-slate-500">
                  InfluxDB 属于可选时序扩展能力，当前不作为聊天、知识库、设备控制和电子沙盘等核心链路的必需依赖。
                </p>
              </div>

              <div className="rounded-[8px] border border-slate-100 bg-white p-6 shadow-sm dark:border-white/[0.06] dark:bg-gradient-to-b dark:from-white/[0.06] dark:to-white/[0.02]">
                <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h3 className="text-lg font-black text-slate-900 dark:text-white">最近探测证据</h3>
                    <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">已生效配置与未保存草稿分别记录，避免把草稿测试结果误认为已经上线。</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className={`rounded-[6px] px-3 py-1.5 text-xs font-black ${statusLoading ? 'bg-slate-100 text-slate-500 dark:bg-white/[0.06] dark:text-slate-300' : Object.values(serviceEvidenceStale).some(Boolean) ? 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300' : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'}`}>
                      {statusLoading ? '正在探测' : Object.values(serviceEvidenceStale).some(Boolean) ? '证据待复核' : '证据有效'}
                    </span>
                    <button
                      type="button"
                      onClick={() => void loadServiceStatus(true)}
                      disabled={statusLoading}
                      aria-label="重新探测全部外部服务"
                      title="重新探测全部外部服务"
                      className="inline-flex h-9 w-9 items-center justify-center rounded-[6px] border border-slate-200 text-slate-500 transition hover:border-blue-200 hover:text-blue-700 disabled:cursor-wait disabled:opacity-50 dark:border-white/[0.08] dark:text-slate-300"
                    >
                      <RefreshCw size={15} className={statusLoading ? 'animate-spin' : ''} />
                    </button>
                  </div>
                </div>
                {statusError && (
                  <div className="mb-4 flex flex-col gap-3 rounded-[8px] border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700 sm:flex-row sm:items-center sm:justify-between dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300">
                    <span>{statusError}</span>
                    <button type="button" onClick={() => void loadServiceStatus(true)} className="inline-flex items-center gap-2 font-bold">
                      <RefreshCw size={14} />重新探测
                    </button>
                  </div>
                )}
                <div className="overflow-x-auto border-y border-slate-100 dark:border-white/[0.06]" tabIndex={0} role="region" aria-label="服务运行状态列表，可横向滚动">
                  <table className="w-full min-w-[860px] table-fixed text-left">
                    <thead className="bg-slate-50/70 text-xs font-bold text-slate-500 dark:bg-white/[0.03] dark:text-slate-400">
                      <tr>
                        <th className="w-[17%] px-4 py-3">服务</th>
                        <th className="w-[16%] px-4 py-3">状态</th>
                        <th className="w-[13%] px-4 py-3">探测用时</th>
                        <th className="w-[34%] px-4 py-3">诊断</th>
                        <th className="w-[20%] px-4 py-3">探测时间</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-white/[0.06]">
                      {SERVICE_IDS.map((service) => {
                        const draftChanged = serviceDraftChanges[service]
                        const evidence = testEvidence[service]
                        const evidenceStale = serviceEvidenceStale[service]
                        const status = draftChanged && !evidence
                          ? 'unknown'
                          : statusLoading && !evidence
                            ? 'loading'
                            : evidenceStale
                              ? 'stale'
                              : evidence?.status || serviceStatus[service] || 'unknown'
                        const ok = status === 'running'
                        const isPending = status === 'loading' || status === 'unknown'
                        const needsReview = status === 'stale'
                        const message = draftChanged && !evidence
                          ? '当前草稿尚未测试；上方状态仍代表已生效配置'
                          : evidenceStale
                            ? `上次结果：${evidence?.message ? serviceDiagnosticMessage(evidence.message, service) : serviceStatusLabel(evidence?.status || 'unknown')}；证据超过 2 分钟，请重新探测`
                            : evidence?.message ? serviceDiagnosticMessage(evidence.message, service) : (statusLoading ? '正在读取已生效配置的运行状态' : '尚未取得连接诊断')
                        return (
                          <tr key={service}>
                            <td className="whitespace-nowrap px-4 py-3 text-sm font-black text-slate-800 dark:text-slate-100">
                              {SERVICE_LABELS[service] || service}
                              {draftChanged ? <span className="ml-2 text-xs font-bold text-amber-600 dark:text-amber-300">草稿</span> : null}
                            </td>
                            <td className="whitespace-nowrap px-4 py-3">
                              <span className={`inline-flex items-center gap-2 text-xs font-black ${ok ? 'text-emerald-600 dark:text-emerald-400' : needsReview ? 'text-amber-700 dark:text-amber-300' : isPending ? 'text-slate-500 dark:text-slate-400' : 'text-red-600 dark:text-red-300'}`}>
                                <span className={`h-2 w-2 rounded-full ${ok ? 'bg-emerald-500' : needsReview ? 'bg-amber-500' : isPending ? 'bg-slate-300' : 'bg-red-500'}`} />
                                {draftChanged && !evidence ? '草稿待测试' : serviceStatusLabel(status)}
                              </span>
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-500 dark:text-slate-400">
                              {evidence ? serviceProbeLatencyLabel(evidence.status, evidence.latency_ms) : statusLoading && !draftChanged ? '探测中' : '未取得'}
                            </td>
                            <td className="px-4 py-3 text-xs text-slate-500 dark:text-slate-400">
                              <span className="line-clamp-2 leading-5" title={message}>{message}</span>
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 text-xs font-medium text-slate-400 dark:text-slate-500">
                              {evidence ? <><span className="block">{evidence.tested_at}</span><span className={evidenceStale ? 'mt-0.5 block font-bold text-amber-600 dark:text-amber-300' : 'mt-0.5 block'}>{probeAgeLabel(evidence.tested_at_ms, freshnessNowMs)}</span></> : '—'}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </motion.div>
          )}

          {/* ═══ Tab 2: Security Settings ═══ */}
          {activeTab === 'security' && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-8"
            >
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* JWT  */}
                <div className="space-y-6 rounded-[8px] border border-slate-100 bg-white p-6 shadow-sm dark:border-white/[0.06] dark:bg-transparent dark:bg-gradient-to-b dark:from-white/[0.06] dark:to-white/[0.02] dark:shadow-none">
                  <div className="flex items-center gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-[8px] bg-blue-50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400">
                      <Clock size={21} />
                    </div>
                    <div>
                      <h4 className="text-lg font-black text-slate-900 dark:text-white">Token 有效期</h4>
                      <p className="mt-0.5 text-xs font-bold text-blue-600 dark:text-blue-400">JWT 配置</p>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <label htmlFor="settings-jwt-expire-hours" className="text-xs font-bold text-slate-500 dark:text-slate-400">过期时间（小时）</label>
                    <input
                      id="settings-jwt-expire-hours"
                      type="number" min={1} max={720}
                      value={jwtHoursInput}
                      onChange={e => {
                        const value = e.target.value
                        setJwtHoursInput(value)
                        const parsed = Number(value)
                        if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 720) setJwtHours(parsed)
                      }}
                      onBlur={() => { if (jwtHoursInput === '') setJwtHoursInput(String(jwtHours)) }}
                      disabled={!canManage || configurationBusy}
                      className="w-full rounded-[8px] border border-transparent bg-slate-50 px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-500/10 disabled:cursor-not-allowed disabled:text-slate-500 dark:bg-white/[0.06] dark:text-white"
                    />
                    <p className="text-xs text-slate-400 dark:text-slate-500">用户登录后 Token 的有效时长，过期需重新登录</p>
                  </div>
                </div>

                {/* Registration */}
                <div className="space-y-6 rounded-[8px] border border-slate-100 bg-white p-6 shadow-sm dark:border-white/[0.06] dark:bg-transparent dark:bg-gradient-to-b dark:from-white/[0.06] dark:to-white/[0.02] dark:shadow-none">
                  <div className="flex items-center gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-[8px] bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400">
                      <Shield size={21} />
                    </div>
                    <div>
                      <h4 className="text-lg font-black text-slate-900 dark:text-white">用户注册</h4>
                      <p className="mt-0.5 text-xs font-bold text-emerald-600 dark:text-emerald-400">访问控制</p>
                    </div>
                  </div>
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-bold text-slate-900 dark:text-white">允许自主注册</p>
                        <p className="text-xs text-slate-400 dark:text-slate-500">关闭后仅管理员可创建账号</p>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={allowReg}
                        aria-label="允许自主注册"
                        onClick={() => setAllowReg(!allowReg)}
                        disabled={!canManage || configurationBusy}
                        className={`relative w-12 h-7 rounded-full transition-colors ${
                          allowReg ? 'bg-blue-600' : 'bg-slate-200 dark:bg-white/[0.1]'
                        } disabled:cursor-not-allowed disabled:opacity-50`}
                      >
                        <motion.div
                          animate={{ x: allowReg ? 22 : 2 }}
                          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                          className="absolute top-1 w-5 h-5 bg-white rounded-full shadow"
                        />
                      </button>
                    </div>
                    <div className={`flex items-center gap-2 rounded-[8px] px-4 py-3 text-xs font-bold ${
                      allowReg
                        ? 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                        : 'bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-400'
                    }`}>
                      {allowReg ? <CheckCircle2 size={14} /> : <Lock size={14} />}
                      {allowReg ? '公开注册已启用' : '仅管理员可创建账号'}
                    </div>
                  </div>
                </div>

                {/* Password Policy */}
                <div className="space-y-6 rounded-[8px] border border-slate-100 bg-white p-6 shadow-sm dark:border-white/[0.06] dark:bg-transparent dark:bg-gradient-to-b dark:from-white/[0.06] dark:to-white/[0.02] dark:shadow-none">
                  <div className="flex items-center gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-[8px] bg-purple-50 text-purple-600 dark:bg-purple-900/20 dark:text-purple-400">
                      <Lock size={21} />
                    </div>
                    <div>
                      <h4 className="text-lg font-black text-slate-900 dark:text-white">密码策略</h4>
                      <p className="mt-0.5 text-xs font-bold text-purple-600 dark:text-purple-400">安全性</p>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <label htmlFor="settings-password-min-length" className="text-xs font-bold text-slate-500 dark:text-slate-400">最小密码长度（位）</label>
                    <input
                      id="settings-password-min-length"
                      type="number" min={4} max={128}
                      value={pwdMinLenInput}
                      onChange={e => {
                        const value = e.target.value
                        setPwdMinLenInput(value)
                        const parsed = Number(value)
                        if (Number.isInteger(parsed) && parsed >= 4 && parsed <= 128) setPwdMinLen(parsed)
                      }}
                      onBlur={() => { if (pwdMinLenInput === '') setPwdMinLenInput(String(pwdMinLen)) }}
                      disabled={!canManage || configurationBusy}
                      className="w-full rounded-[8px] border border-transparent bg-slate-50 px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-500/10 disabled:cursor-not-allowed disabled:text-slate-500 dark:bg-white/[0.06] dark:text-white"
                    />
                    <p className="text-xs text-slate-400 dark:text-slate-500">用户注册和修改密码时的最小字符数要求</p>
                  </div>
                  <div className="flex items-center gap-3 rounded-[8px] bg-slate-50 px-4 py-3 dark:bg-white/[0.04]">
                    <div className="grid grid-cols-6 gap-1 flex-1">
                      {[...Array(6)].map((_, i) => (
                        <div key={i} className={`h-1.5 rounded-full ${i < Math.min(pwdMinLen / 5, 6) ? 'bg-blue-500' : 'bg-slate-200 dark:bg-white/[0.1]'}`} />
                      ))}
                    </div>
                    <span className="text-xs font-bold text-slate-400 dark:text-slate-500">
                      {pwdMinLen <= 6 ? '基本' : pwdMinLen <= 10 ? '中等' : '强'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Security Overview Card */}
              <div className="rounded-[8px] bg-blue-600 p-8 text-white shadow-xl shadow-blue-500/20 dark:bg-blue-600 dark:shadow-blue-500/10">
                <h4 className="mb-4 text-xl font-black">安全概览</h4>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div className="flex items-center gap-3">
                    <CheckCircle2 size={16} className="text-blue-200" />
                    <span className="text-sm font-bold text-blue-50">登录有效期：{jwtHours} 小时</span>
                  </div>
                  <div className="flex items-center gap-3">
                    {allowReg ? <XCircle size={16} className="text-orange-300" /> : <CheckCircle2 size={16} className="text-blue-200" />}
                    <span className="text-sm font-bold text-blue-50">公开注册：{allowReg ? '已启用' : '已禁用'}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <CheckCircle2 size={16} className="text-blue-200" />
                    <span className="text-sm font-bold text-blue-50">密码策略：≥{pwdMinLen} 位</span>
                  </div>
                </div>
              </div>

              <div className="rounded-[8px] border border-slate-100 bg-white p-6 shadow-sm dark:border-white/[0.06] dark:bg-transparent dark:bg-gradient-to-b dark:from-white/[0.06] dark:to-white/[0.02] dark:shadow-none">
                <div className="flex items-center gap-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-[8px] bg-slate-100 text-slate-600 dark:bg-white/[0.06] dark:text-slate-300">
                    <KeyRound size={21} />
                  </div>
                  <div>
                    <h4 className="text-lg font-black text-slate-900 dark:text-white">修改当前账号密码</h4>
                    <p className="mt-0.5 text-xs font-bold text-blue-600 dark:text-blue-400">账号安全</p>
                  </div>
                </div>
                <div className="mt-6 grid gap-4 lg:grid-cols-3">
                  <InputField label="旧密码" value={oldPassword} onChange={setOldPassword} type="password" autoComplete="current-password" disabled={passwordSaving} />
                  <InputField label="新密码" value={newPassword} onChange={setNewPassword} type="password" autoComplete="new-password" disabled={passwordSaving} />
                  <InputField label="确认新密码" value={confirmPassword} onChange={setConfirmPassword} type="password" autoComplete="new-password" disabled={passwordSaving} />
                </div>
                <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs leading-5 text-slate-400 dark:text-slate-500">新密码至少 {pwdMinLen} 位。修改成功后，当前登录会话继续有效，下一次登录使用新密码。</p>
                  <button
                    type="button"
                    onClick={handleChangePassword}
                    disabled={!passwordSaving && (!oldPassword || !newPassword || !confirmPassword)}
                    className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-[8px] bg-slate-900 px-5 py-2.5 text-sm font-bold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-45 dark:bg-white dark:text-slate-900"
                  >
                    {passwordSaving ? <XCircle size={16} /> : <KeyRound size={16} />}
                    {passwordSaving ? '取消等待' : '确认修改'}
                  </button>
                </div>
              </div>
            </motion.div>
          )}

          {/* ═══ Tab 3: System Info ═══ */}
          {activeTab === 'system' && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-8"
            >
              {infoError && (
                <div className="flex flex-col gap-3 rounded-[8px] border border-red-100 bg-red-50 px-5 py-4 text-sm text-red-700 sm:flex-row sm:items-center sm:justify-between dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300">
                  <span>{infoError}</span>
                  <button type="button" onClick={() => void loadSystemInfo(true)} className="inline-flex items-center gap-2 font-bold"><RefreshCw size={14} />重新读取</button>
                </div>
              )}
              {/* System summary */}
              <div className="grid overflow-hidden rounded-[8px] border border-slate-100 bg-white shadow-sm dark:border-white/[0.06] dark:bg-transparent dark:bg-gradient-to-b dark:from-white/[0.06] dark:to-white/[0.02] dark:shadow-none md:grid-cols-2 xl:grid-cols-4">
                <div className="space-y-1 border-b border-slate-100 p-6 dark:border-white/[0.06] md:border-r xl:border-b-0">
                  <p className="text-xs font-bold text-slate-400 dark:text-slate-500">版本号</p>
                  <p className="text-2xl font-black text-slate-900 dark:text-white">{sysInfo?.version ? `v${sysInfo.version}` : '—'}</p>
                </div>
                <div className="space-y-1 border-b border-slate-100 p-6 dark:border-white/[0.06] xl:border-b-0 xl:border-r">
                  <p className="text-xs font-bold text-slate-400 dark:text-slate-500">系统运行时间</p>
                  <p className="text-2xl font-black text-slate-900 dark:text-white">{formatUptime(sysInfo?.uptime_seconds)}</p>
                </div>
                <div className="space-y-1 border-b border-slate-100 p-6 dark:border-white/[0.06] md:border-b-0 md:border-r">
                  <p className="text-xs font-bold text-slate-400 dark:text-slate-500">数据库状态</p>
                  <div className="flex items-center gap-3">
                    <p className="text-2xl font-black text-slate-900 dark:text-white">
                      {!sysInfo ? '待确认' : sysInfo.db_status === 'connected' ? '健康' : '异常'}
                    </p>
                    <div className={`h-2.5 w-2.5 rounded-full ${!sysInfo ? 'bg-slate-300' : sysInfo.db_status === 'connected' ? 'bg-emerald-500' : 'bg-red-500'}`} />
                  </div>
                </div>
                <div className="space-y-1 p-6">
                  <p className="text-xs font-bold text-slate-400 dark:text-slate-500">配置来源</p>
                  <p className="break-words text-xl font-black leading-7 text-slate-900 dark:text-white">
                    {sysInfo?.config_source ?? (configSource === 'database_overrides' ? '数据库已覆盖' : '使用默认配置')}
                  </p>
                </div>
              </div>

              {/* Detail Table */}
              <div className="overflow-x-auto rounded-[8px] border border-slate-100 bg-white shadow-sm dark:border-white/[0.06] dark:bg-transparent dark:bg-gradient-to-b dark:from-white/[0.06] dark:to-white/[0.02] dark:shadow-none" tabIndex={0} role="region" aria-label="系统配置历史列表，可横向滚动">
                <table className="w-full min-w-[620px]">
                  <tbody>
                    {[
                      { label: '系统版本', value: sysInfo?.version ? `v${sysInfo.version}` : '—' },
                      ...(sysInfo?.runtime_details_visible ? [
                        { label: '运行环境', value: sysInfo.os_info || '—' },
                        { label: 'Python 版本', value: sysInfo.python_version || '—' },
                      ] : []),
                      { label: '数据库', value: `MySQL · ${!sysInfo ? '状态待确认' : sysInfo.db_status === 'connected' ? '已连接' : '未连接'}` },
                      { label: '配置来源', value: sysInfo?.config_source ?? (configSource === 'database_overrides' ? '数据库已覆盖' : '使用默认配置') },
                      { label: '运行时长', value: formatUptime(sysInfo?.uptime_seconds) },
                      { label: '帮助文档和教程', value: sysInfo?.api_docs_url ?? '—', isLink: true },
                    ].map((row, i) => (
                      <tr key={i} className="border-b border-slate-50 dark:border-white/[0.04] last:border-0">
                        <td className="px-8 py-5 text-sm font-bold text-slate-500 dark:text-slate-400 w-[200px]">{row.label}</td>
                        <td className="px-8 py-5 text-sm font-medium text-slate-900 dark:text-white">
                          {row.isLink && row.value !== '—' ? (
                            <a
                              href={row.value}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-2"
                            >
                              {row.value}
                              <ExternalLink size={14} />
                            </a>
                          ) : row.value}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="rounded-[8px] border border-slate-100 bg-white p-6 shadow-sm dark:border-white/[0.06] dark:bg-transparent dark:bg-gradient-to-b dark:from-white/[0.06] dark:to-white/[0.02] dark:shadow-none">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h3 className="text-lg font-black text-slate-900 dark:text-white">{canManage ? '数据库运行时覆盖' : '配置管理状态'}</h3>
                    <p className="mt-1 text-sm leading-6 text-slate-500 dark:text-slate-400">{canManage ? '数据库值优先于环境变量和 config.yaml；恢复默认只删除覆盖，不修改配置文件或恢复历史密钥。' : '系统配置由管理员统一维护；当前页面仅展示已生效来源和运行状态。'}</p>
                  </div>
                  {canManage && (
                    <button
                      type="button"
                      onClick={handleReset}
                      disabled={!resetting && !settings.override_keys?.length || saving}
                      className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-[8px] border border-red-100 px-4 py-2 text-xs font-bold text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-45 dark:border-red-400/20 dark:text-red-300 dark:hover:bg-red-400/10"
                    >
                      {resetting ? <XCircle size={14} /> : <RotateCcw size={14} />}
                      {resetting ? '取消等待' : '恢复默认来源'}
                    </button>
                  )}
                </div>
                {canManage && settings.override_keys?.length ? (
                  <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {settings.override_keys.map((key) => (
                      <div key={key} className="rounded-[8px] bg-slate-50 px-4 py-3 dark:bg-white/[0.04]">
                        <p title={CONFIG_KEY_LABELS[key] ? undefined : `技术配置键：${key}`} className="text-sm font-bold text-slate-800 dark:text-slate-200">{CONFIG_KEY_LABELS[key] || '其他运行配置'}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-5 rounded-[8px] bg-slate-50 px-4 py-4 text-sm text-slate-500 dark:bg-white/[0.04] dark:text-slate-400">{canManage ? '当前没有数据库运行时覆盖，系统使用默认配置来源。' : `当前生效来源：${sysInfo?.config_source ?? (configSource === 'database_overrides' ? '数据库运行时配置' : '默认配置')}。`}</p>
                )}
                <p className="mt-4 text-xs text-slate-400 dark:text-slate-500">最近配置更新：{formatDateTime(settings.last_updated_at)}</p>
              </div>
            </motion.div>
          )}
        </div>
      )}

      <AppDrawer
        open={historyOpen}
        title="配置变更与连接测试记录"
        description="后端审计仅保留操作、配置项名称、连接结果和操作人，不返回凭证明文。"
        onClose={() => setHistoryOpen(false)}
        widthClassName="max-w-2xl"
        headerActions={(
          <button
            type="button"
            onClick={() => void loadHistory(true)}
            disabled={historyLoading}
            className="inline-flex h-9 w-9 items-center justify-center rounded-[6px] border border-slate-200 text-slate-500 transition hover:border-blue-200 hover:text-blue-700 disabled:opacity-50 dark:border-white/[0.08] dark:text-slate-300"
            aria-label="刷新配置记录"
            title="刷新配置记录"
          >
            <RefreshCw size={16} className={historyLoading ? 'animate-spin' : ''} />
          </button>
        )}
        footer={historyLoaded ? (
          <Pagination
            page={loadedHistoryPage}
            pageSize={loadedHistorySize}
            total={historyTotal}
            itemName="条配置记录"
            loading={historyLoading}
            navigationDisabled={!historySnapshotMatchesView}
            onPageChange={(page) => { invalidateHistoryView(); setHistoryPage(page) }}
            onPageSizeChange={(size) => { invalidateHistoryView(); setHistorySize(size); setHistoryPage(1) }}
            className="border-0 p-0"
          />
        ) : null}
      >
        <div className="mb-5 flex flex-wrap gap-2">
          {[
            { value: '', label: '全部记录' },
            { value: 'save', label: '保存配置' },
            { value: 'reset', label: '恢复默认' },
            { value: 'test', label: '连接测试' },
          ].map((option) => (
            <button
              key={option.value || 'all'}
              type="button"
              onClick={() => {
                if (historyAction === option.value && historyPage === 1) {
                  void loadHistory(true)
                  return
                }
                invalidateHistoryView()
                setHistoryAction(option.value)
                setHistoryPage(1)
              }}
              className={`min-h-9 rounded-[8px] px-4 py-2 text-xs font-black transition ${historyAction === option.value ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:text-blue-700 dark:bg-white/[0.06] dark:text-slate-300'}`}
            >
              {option.label}
            </button>
          ))}
        </div>
        {historyLoading && historyLoaded ? (
          <div className="mb-4 flex items-center gap-2 border-l-2 border-blue-500 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700 dark:bg-blue-500/10 dark:text-blue-300" role="status">
            <Loader2 size={14} className="animate-spin" />正在读取当前筛选，{historySnapshotMatchesView ? '下方暂时保留本次筛选上一次成功结果' : '下方暂时保留其他筛选或页码的上一次成功结果，操作已锁定'}
          </div>
        ) : null}
        {historyError && historyLoaded ? (
          <div className="rounded-[8px] bg-red-50 px-4 py-3 text-sm font-semibold text-red-700 dark:bg-red-500/10 dark:text-red-300" role="alert">{historyError}{`；下方保留${historySnapshotMatchesView ? '当前筛选' : '其他筛选或页码'}上一次成功读取的${historyItems.length ? '记录' : '空结果'}${historySnapshotMatchesView ? '' : '，分页已锁定'}。`}</div>
        ) : null}
        {!historyLoaded && historyLoading ? (
          <div className="flex items-center justify-center gap-3 py-16 text-sm font-semibold text-slate-400"><Loader2 size={18} className="animate-spin" />正在读取配置记录</div>
        ) : !historyLoaded && historyError ? (
          <div className="rounded-[8px] bg-red-50 px-5 py-12 text-center text-sm font-semibold text-red-700 dark:bg-red-500/10 dark:text-red-300" role="alert">
            <p className="font-black">配置记录未取得</p>
            <p className="mx-auto mt-2 max-w-lg break-words text-xs font-semibold leading-5">{historyError}</p>
            <button type="button" onClick={() => void loadHistory(true)} disabled={historyLoading} className="mt-4 inline-flex min-h-9 items-center justify-center gap-2 rounded-[6px] border border-red-200 bg-white px-3 text-xs font-black text-red-700 disabled:cursor-wait disabled:opacity-50 dark:border-red-400/20 dark:bg-white/[0.06] dark:text-red-200">
              <RefreshCw size={14} className={historyLoading ? 'animate-spin' : ''} />
              {historyLoading ? '正在重新读取' : '重新读取配置记录'}
            </button>
          </div>
        ) : historyItems.length ? (
          <div className="divide-y divide-slate-100 rounded-[8px] border border-slate-100 dark:divide-white/[0.06] dark:border-white/[0.06]">
            {historyItems.map((item) => (
              <article key={item.id} className="px-4 py-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded-[6px] px-2.5 py-1 text-xs font-black ${item.level === 'success' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' : item.level === 'error' ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300' : 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300'}`}>{settingsActionLabel(item.action)}</span>
                      <h3 className="break-words text-sm font-black text-slate-900 dark:text-white">{item.title}</h3>
                    </div>
                    {item.changed_keys.length ? (
                      <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">涉及：{item.changed_keys.map((key) => CONFIG_KEY_LABELS[key] || '其他运行配置').join('、')}</p>
                    ) : item.service ? (
                      <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">{SERVICE_LABELS[item.service as ServiceId] || '其他服务'} · {serviceStatusLabel(item.status)} · {serviceProbeLatencyLabel(item.status, item.latency_ms)}</p>
                    ) : null}
                    {item.message ? <p title={item.message} className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">{serviceDiagnosticMessage(item.message, item.service)}</p> : null}
                  </div>
                  <div className="shrink-0 text-left text-xs leading-5 text-slate-400 sm:text-right dark:text-slate-500">
                    <p>{formatDateTime(item.created_at)}</p>
                    <p>{item.username || '系统任务'}</p>
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="rounded-[8px] bg-slate-50 px-5 py-12 text-center text-sm font-semibold text-slate-400 dark:bg-white/[0.04]">{historySnapshotMatchesView ? '当前筛选下暂无配置记录' : '上一次成功读取的其他筛选或页码暂无配置记录，正在读取当前筛选'}</div>
        )}
      </AppDrawer>
    </div>
  )
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<div className="flex min-h-[50vh] items-center justify-center text-sm font-bold text-slate-400">正在读取系统设置...</div>}>
      <SettingsContent />
    </Suspense>
  )
}
