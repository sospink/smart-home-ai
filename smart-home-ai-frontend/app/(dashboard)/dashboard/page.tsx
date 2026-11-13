'use client'

/**
 * 仪表盘页
 * 概览统计 · 快速访问 · 近期活动 · 服务状态
 * Layout: elevated-admin-dashboard style (Tailwind utility classes)
 * Data:   保留已有 apiClient 接口
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import Link from 'next/link'
import {
  BookOpen, Cpu, Bot, Users, Settings, Smartphone,
  ChevronRight, Globe, Database, Home, BrainCircuit,
  MessageSquare, Lightbulb, Box, Activity,
  RefreshCw, AlertTriangle, CheckCircle,
  Loader2,
  type LucideProps,
} from 'lucide-react'
import { motion } from 'motion/react'
import {
  fetchSystemDashboardPlatform,
  fetchSystemDashboardRuntime,
  type SystemDashboard,
  type SystemDashboardActivity,
  type SystemDashboardRuntime,
  type SystemDashboardService,
} from '@/lib/api/system'
import { useAuth } from '@/lib/hooks/useAuth'
import { businessErrorMessage } from '@/lib/ui/business-error'

function dashboardLogLevel(level: string) {
  if (level === 'success') return '成功'
  if (level === 'warning') return '警告'
  if (level === 'error') return '错误'
  if (level === 'info') return '信息'
  return '其他等级'
}

function formatActivityTime(value: string | null, now: number) {
  if (!value) return '时间未知'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未知'
  const seconds = Math.max(0, Math.floor((now - date.getTime()) / 1000))
  if (seconds < 60) return '刚刚'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} 天前`
  return date.toLocaleDateString('zh-CN')
}

function displayOperator(value: string) {
  return !value || value.toLowerCase() === 'system' ? '系统任务' : value
}

function activityTypeLabel(log: SystemDashboardActivity) {
  if (log.type_label?.trim()) return log.type_label.trim()
  return /[\u4e00-\u9fff]/.test(log.type || '') ? log.type : '其他系统操作'
}

function formatGeneratedAt(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN')
}

function serviceSourceLabel(service: SystemDashboardService) {
  const labels: Record<string, string> = {
    '当前后端进程': '平台进程状态',
    'Dify 应用信息接口': '智能体应用运行探测',
    'Dify 知识库接口': '知识库运行探测',
    'Home Assistant 状态接口 + 平台设备台账': '设备状态与平台台账',
    'Ollama 模型列表接口': '本地模型运行探测',
    'InfluxDB 健康接口': '时序服务运行探测',
  }
  return labels[service.source] || '平台运行探测'
}

function groupRuntimeWarnings(warnings: string[]) {
  const grouped = new Map<string, string[]>()
  const standalone: string[] = []
  Array.from(new Set(warnings.map((warning) => warning.trim()).filter(Boolean))).forEach((warning) => {
    const separator = warning.indexOf('：')
    if (separator <= 0 || separator >= warning.length - 1) {
      standalone.push(warning)
      return
    }
    const name = warning.slice(0, separator).trim()
    const message = warning.slice(separator + 1).trim()
    const names = grouped.get(message) || []
    if (!names.includes(name)) names.push(name)
    grouped.set(message, names)
  })
  return [
    ...Array.from(grouped, ([message, names]) => `${names.join('、')}：${message}`),
    ...standalone,
  ]
}

/* ── Stat card (inlined from elevated-admin-dashboard) ── */
function StatCard({ icon: Icon, value, label, trend, active, activeLabel, iconColor, iconBg, compactValue = false }: {
  icon: ComponentType<LucideProps>; value: string; label: string; trend?: string; active?: boolean; activeLabel?: string
  iconColor?: string; iconBg?: string
  compactValue?: boolean
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="group min-h-[150px] min-w-0 rounded-2xl border border-transparent bg-white p-4 shadow-sm transition-shadow hover:shadow-md sm:p-6 dark:border-white/[0.06] dark:bg-transparent dark:bg-gradient-to-b dark:from-white/[0.06] dark:to-white/[0.02] dark:shadow-none"
    >
      <div className="mb-3 flex items-start justify-between gap-2 sm:mb-4">
        <div className={`shrink-0 rounded-full p-2.5 sm:p-3 ${iconBg || 'bg-blue-50 dark:bg-white/[0.08]'} ${iconColor || 'text-blue-600 dark:text-blue-400'} group-hover:bg-blue-600 group-hover:text-white transition-colors`}>
          <Icon size={20} />
        </div>
        {trend && (
          <span className={`text-xs font-bold ${trend.includes('+') ? 'text-emerald-600 bg-emerald-50 dark:bg-emerald-500/10 dark:text-emerald-400' : 'text-slate-400 bg-slate-50 dark:bg-white/[0.06] dark:text-slate-500'} px-2 py-1 rounded-full`}>
            {trend}
          </span>
        )}
        {active && (
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            <span className="truncate text-xs font-bold text-emerald-600 dark:text-emerald-400">{activeLabel}</span>
          </div>
        )}
      </div>
      <p className={`${compactValue ? 'text-xl leading-8 sm:text-2xl sm:leading-10' : 'text-3xl sm:text-4xl'} break-words font-black text-slate-900 dark:text-white`}>{value}</p>
      <p className="mt-1 break-words text-xs font-medium leading-5 text-slate-500 sm:text-sm dark:text-slate-400">{label}</p>
    </motion.div>
  )
}

/* ── Quick access card ── */
function QuickAccessCard({ icon: Icon, title, gradient, href, dark = false }: {
  icon: ComponentType<LucideProps>; title: string; gradient: string; href: string; dark?: boolean
}) {
  return (
    <Link href={href} className="block h-full">
      <motion.div
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
        className={`group relative flex h-full min-h-[148px] flex-col justify-between overflow-hidden rounded-2xl p-4 text-white shadow-lg transition-all sm:min-h-[166px] sm:p-6 ${gradient} ${dark ? 'shadow-slate-200 dark:shadow-none' : 'shadow-blue-500/10'}`}
      >
        <div className="flex items-start justify-between gap-3">
          <Icon size={32} className="opacity-80 shrink-0" />
        </div>
        <div className="flex items-end justify-between gap-4">
          <span className="min-h-[3.5rem] break-words text-base font-bold leading-6 sm:text-lg sm:leading-tight">{title}</span>
          <span className="shrink-0 transition-transform group-hover:translate-x-1">→</span>
        </div>
      </motion.div>
    </Link>
  )
}

/* ── Service status row ── */
function ServiceRow({ icon: Icon, service, color, canViewEndpoint }: {
  icon: ComponentType<LucideProps>; service: SystemDashboardService; color: string; canViewEndpoint: boolean
}) {
  const statusMeta = service.status === 'running'
    ? { label: '运行中', dot: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400' }
    : service.status === 'unconfigured'
      ? { label: '未配置', dot: 'bg-slate-400', text: 'text-slate-500 dark:text-slate-400' }
      : service.status === 'error'
        ? { label: '服务异常', dot: 'bg-rose-500', text: 'text-rose-600 dark:text-rose-400' }
        : { label: '当前不可用', dot: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400' }
  const endpointLabel = service.key === 'backend'
    ? '平台内部接口'
    : canViewEndpoint
      ? service.endpoint || '平台内部服务'
      : '管理员可查看配置'
  const latencyLabel = service.latency_ms > 0
    ? `${service.latency_ms} 毫秒`
    : service.key === 'backend'
      ? '本机进程'
      : service.status === 'unconfigured'
        ? '未探测'
        : '未取得'
  return (
    <tr className="group hover:bg-slate-50 dark:hover:bg-white/[0.03] transition-colors border-b border-slate-100 dark:border-white/[0.06] last:border-0">
      <td className="px-6 py-4">
        <div className="flex items-center gap-3">
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${color}`}>
            <Icon size={18} />
          </div>
          <span className="min-w-0 truncate font-bold text-slate-900 dark:text-slate-100" title={`${service.name} · ${serviceSourceLabel(service)}`}>{service.name}</span>
        </div>
      </td>
      <td className="px-6 py-4 text-sm text-slate-500 dark:text-slate-400">
        <span className="line-clamp-2 block leading-5" title={service.detail || '暂无补充诊断'}>{service.detail || '暂无补充诊断'}</span>
      </td>
      <td className="px-6 py-4 text-sm font-mono text-slate-500 dark:text-slate-400">
        <span className="block truncate font-sans" title={endpointLabel}>{endpointLabel}</span>
      </td>
      <td className="whitespace-nowrap px-6 py-4 text-sm text-slate-500 dark:text-slate-400">{latencyLabel}</td>
      <td className="px-6 py-4">
        <div className={`flex items-center gap-2 ${statusMeta.text}`}>
          <span className={`h-2.5 w-2.5 rounded-full ${statusMeta.dot}`} />
          <span className="text-xs font-black">{statusMeta.label}</span>
        </div>
      </td>
    </tr>
  )
}

/* ══════════════════════════════════════════════
   Dashboard Page
   ══════════════════════════════════════════════ */

export default function DashboardPage() {
  const [platformData, setPlatformData] = useState<SystemDashboard | null>(null)
  const [runtimeData, setRuntimeData] = useState<SystemDashboardRuntime | null>(null)
  const [platformLoading, setPlatformLoading] = useState(true)
  const [runtimeLoading, setRuntimeLoading] = useState(true)
  const [platformError, setPlatformError] = useState('')
  const [runtimeError, setRuntimeError] = useState('')
  const [activityClock, setActivityClock] = useState(() => Date.now())
  const platformRequestIdRef = useRef(0)
  const runtimeRequestIdRef = useRef(0)
  const platformAbortRef = useRef<AbortController | null>(null)
  const runtimeAbortRef = useRef<AbortController | null>(null)
  const platformRefreshInFlightRef = useRef(false)
  const runtimeRefreshInFlightRef = useRef(false)
  const platformLastAttemptAtRef = useRef(0)
  const runtimeLastAttemptAtRef = useRef(0)
  const { isAdmin } = useAuth()

  const loadPlatform = useCallback((force = false) => {
    if (force && platformRefreshInFlightRef.current) return Promise.resolve()
    if (!force && platformAbortRef.current) return Promise.resolve()
    platformAbortRef.current?.abort()
    const controller = new AbortController()
    platformAbortRef.current = controller
    platformLastAttemptAtRef.current = Date.now()
    if (force) platformRefreshInFlightRef.current = true
    const requestId = ++platformRequestIdRef.current
    setPlatformLoading(true)
    setPlatformError('')
    return fetchSystemDashboardPlatform(force, controller.signal)
      .then((value) => {
        if (requestId !== platformRequestIdRef.current) return
        setPlatformData(value)
        setPlatformError('')
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return
        if (requestId === platformRequestIdRef.current) {
          setPlatformError(businessErrorMessage(reason, { fallback: '平台数据加载失败', service: '平台概览' }))
        }
      })
      .finally(() => {
        if (platformAbortRef.current === controller) platformAbortRef.current = null
        if (requestId === platformRequestIdRef.current) setPlatformLoading(false)
        if (force) platformRefreshInFlightRef.current = false
      })
  }, [])

  const loadRuntime = useCallback((force = false) => {
    if (force && runtimeRefreshInFlightRef.current) return Promise.resolve()
    if (!force && runtimeAbortRef.current) return Promise.resolve()
    runtimeAbortRef.current?.abort()
    const controller = new AbortController()
    runtimeAbortRef.current = controller
    runtimeLastAttemptAtRef.current = Date.now()
    if (force) runtimeRefreshInFlightRef.current = true
    const requestId = ++runtimeRequestIdRef.current
    setRuntimeLoading(true)
    setRuntimeError('')
    return fetchSystemDashboardRuntime(force, controller.signal)
      .then((value) => {
        if (requestId !== runtimeRequestIdRef.current) return
        setRuntimeData(value)
        setRuntimeError('')
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return
        if (requestId === runtimeRequestIdRef.current) {
          setRuntimeError(businessErrorMessage(reason, { fallback: '外部服务状态读取失败', service: '外部服务状态' }))
        }
      })
      .finally(() => {
        if (runtimeAbortRef.current === controller) runtimeAbortRef.current = null
        if (requestId === runtimeRequestIdRef.current) setRuntimeLoading(false)
        if (force) runtimeRefreshInFlightRef.current = false
      })
  }, [])

  useEffect(() => {
    const initialLoad = window.setTimeout(() => {
      void loadPlatform(false)
      void loadRuntime(false)
    }, 0)
    return () => {
      window.clearTimeout(initialLoad)
      platformRequestIdRef.current += 1
      runtimeRequestIdRef.current += 1
      platformAbortRef.current?.abort()
      runtimeAbortRef.current?.abort()
      platformRefreshInFlightRef.current = false
      runtimeRefreshInFlightRef.current = false
    }
  }, [loadPlatform, loadRuntime])

  useEffect(() => {
    let timer: number | null = null

    const refreshStaleData = () => {
      if (document.hidden) return
      const now = Date.now()
      if (now - platformLastAttemptAtRef.current >= 60_000) void loadPlatform(false)
      if (now - runtimeLastAttemptAtRef.current >= 300_000) void loadRuntime(false)
    }

    const stopClock = () => {
      if (timer === null) return
      window.clearInterval(timer)
      timer = null
    }
    const startClock = () => {
      stopClock()
      if (document.hidden) return
      setActivityClock(Date.now())
      refreshStaleData()
      timer = window.setInterval(() => {
        setActivityClock(Date.now())
        refreshStaleData()
      }, 60_000)
    }
    const handleVisibilityChange = () => {
      if (document.hidden) stopClock()
      else startClock()
    }

    startClock()
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      stopClock()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [loadPlatform, loadRuntime])

  useEffect(() => {
    if (!platformError && !runtimeError) return

    const retryFailedReads = () => {
      if (!navigator.onLine || document.visibilityState !== 'visible') return
      if (platformError && !platformAbortRef.current) void loadPlatform(true)
      if (runtimeError && !runtimeAbortRef.current) void loadRuntime(true)
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
  }, [loadPlatform, loadRuntime, platformError, runtimeError])

  const loading = platformLoading || runtimeLoading
  const stats = useMemo(() => ({
    total_users: platformData?.stats.total_users ?? null,
    new_users_7d: platformData?.stats.new_users_7d ?? null,
    registered_devices: runtimeData?.stats.registered_devices ?? platformData?.stats.registered_devices ?? null,
    online_devices: runtimeData?.stats.online_devices ?? null,
    model_count: runtimeData?.stats.model_count ?? null,
    knowledge_count: runtimeData?.stats.knowledge_count ?? null,
  }), [platformData, runtimeData])
  const homeAssistantService = runtimeData?.services.find(service => service.key === 'homeassistant')
  const homeAssistantReadable = homeAssistantService?.status === 'running' && stats.online_devices !== null
  const deviceStatusValue = stats.online_devices === null
    ? String(stats.registered_devices ?? '—')
    : stats.registered_devices === null
      ? String(stats.online_devices)
      : `${stats.online_devices} / ${stats.registered_devices}`
  const deviceStatusLabel = runtimeLoading && stats.online_devices === null
    ? '正在读取 HA 设备状态'
    : !homeAssistantReadable && stats.registered_devices !== null
      ? '设备台账 · HA 在线状态未取得'
      : stats.registered_devices === null
      ? 'HA 状态可读 · 设备台账未取得'
      : 'HA 状态可读 / 设备台账'
  const services = useMemo(
    () => Array.from(new Map(
      [...(platformData?.services ?? []), ...(runtimeData?.services ?? [])]
        .map((service) => [service.key, service]),
    ).values()),
    [platformData, runtimeData],
  )
  const runtimeWarnings = useMemo(
    () => groupRuntimeWarnings(runtimeData?.warnings ?? []),
    [runtimeData],
  )
  const logs: SystemDashboardActivity[] = platformData?.recent_activity ?? []
  const visibleLogs = logs.slice(0, 3)
  const activityCoverage = platformData?.activity_coverage
  const platformUpdated = formatGeneratedAt(platformData?.generated_at)
  const runtimeUpdated = formatGeneratedAt(runtimeData?.generated_at)
  const canViewAll = platformData?.visibility_scope === 'all'

  return (
    <div className="max-w-7xl mx-auto space-y-12">
      {/* Header */}
      <section>
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <h2 className="mb-2 text-3xl font-black text-slate-900 dark:text-white">设备与系统状态查看</h2>
            <p className="text-slate-500 dark:text-slate-400 font-medium">统一 Web 管理界面的系统状态与核心能力总览</p>
            <p className="mt-2 text-xs font-semibold text-slate-400 dark:text-slate-500">
              {platformUpdated ? `平台更新：${platformUpdated}` : '平台数据尚未取得'}
              {' · '}
              {runtimeLoading ? '外部服务正在探测' : runtimeUpdated ? `服务探测：${runtimeUpdated}` : '服务状态尚未取得'}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => void loadPlatform(true)}
              disabled={platformLoading}
              className="inline-flex items-center justify-center gap-2 rounded-[8px] bg-white px-4 py-3 text-sm font-bold text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-60 dark:bg-white/[0.06] dark:text-slate-200 dark:hover:bg-white/[0.1]"
            >
              <RefreshCw size={16} className={platformLoading ? 'animate-spin' : ''} />
              {platformLoading ? '正在刷新平台' : '刷新平台数据'}
            </button>
            <button
              onClick={() => void loadRuntime(true)}
              disabled={runtimeLoading}
              className="inline-flex items-center justify-center gap-2 rounded-[8px] bg-slate-900 px-4 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-slate-800 disabled:opacity-60 dark:bg-blue-600 dark:hover:bg-blue-500"
            >
              <Activity size={16} className={runtimeLoading ? 'animate-pulse' : ''} />
              {runtimeLoading ? '正在探测服务' : '探测外部服务'}
            </button>
          </div>
        </div>
        {platformError && platformData && (
          <div className="mt-5 flex items-start gap-3 rounded-[8px] bg-amber-50 px-5 py-4 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
            <AlertTriangle size={18} className="mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold">设备与系统状态加载失败</p>
              <p className="mt-1 text-sm leading-6">{platformError}{platformData ? '，页面继续保留上次成功数据。' : ''}</p>
            </div>
            <button type="button" onClick={() => void loadPlatform(true)} disabled={platformLoading} className="inline-flex shrink-0 items-center gap-2 rounded-[8px] bg-white px-3 py-2 text-xs font-black text-amber-800 shadow-sm disabled:cursor-wait disabled:opacity-50 dark:bg-white/10 dark:text-amber-200">{platformLoading ? <Loader2 size={13} className="animate-spin" /> : null}{platformLoading ? '正在重新读取' : '重新读取'}</button>
          </div>
        )}
        {runtimeError && runtimeData && (
          <div className="mt-5 flex items-start gap-3 rounded-[8px] bg-amber-50 px-5 py-4 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
            <AlertTriangle size={18} className="mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold">外部服务状态读取失败</p>
              <p className="mt-1 text-sm leading-6">{runtimeError}{runtimeData ? '，外部状态继续显示上次成功快照。' : '，平台用户与设备台账仍可正常使用。'}</p>
            </div>
            <button type="button" onClick={() => void loadRuntime(true)} disabled={runtimeLoading} className="inline-flex shrink-0 items-center gap-2 rounded-[8px] bg-white px-3 py-2 text-xs font-black text-amber-800 shadow-sm disabled:cursor-wait disabled:opacity-50 dark:bg-white/10 dark:text-amber-200">{runtimeLoading ? <Loader2 size={13} className="animate-spin" /> : null}{runtimeLoading ? '正在重新探测' : '重新探测'}</button>
          </div>
        )}
      </section>

      {/* Stat cards */}
      <section className="grid grid-cols-2 gap-3 md:gap-6 lg:grid-cols-4">
        <StatCard icon={Users} value={canViewAll ? String(stats.total_users ?? '—') : platformData ? '已启用' : '—'} label={canViewAll ? '用户总数' : '当前账号状态'} trend={canViewAll && stats.new_users_7d ? `近 7 天 +${stats.new_users_7d}` : undefined} active={!canViewAll && Boolean(platformData)} activeLabel={!canViewAll && platformData ? '可使用' : undefined} compactValue={!canViewAll} />
        <StatCard icon={Smartphone} value={deviceStatusValue} label={deviceStatusLabel} active={homeAssistantReadable} activeLabel="状态可读" compactValue={deviceStatusValue.length > 5} />
        <StatCard icon={Cpu} value={String(stats.model_count ?? '—')} label={runtimeLoading && stats.model_count === null ? '正在读取已安装模型' : '已安装模型'} />
        <StatCard icon={BookOpen} value={String(stats.knowledge_count ?? '—')} label={runtimeLoading && stats.knowledge_count === null ? '正在读取知识库数量' : '知识库数量'} />
      </section>

      {/* Quick access + Recent activities */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-6">
          <h3 className="text-xl font-bold text-slate-900 dark:text-white px-2">快速访问</h3>
          <div className="grid auto-rows-fr grid-cols-2 gap-3 sm:gap-4 2xl:grid-cols-3">
            <QuickAccessCard icon={MessageSquare} title="智能体对话" gradient="bg-gradient-to-br from-cyan-600 to-sky-700" href="/chat" />
            <QuickAccessCard icon={Lightbulb} title="设备控制" gradient="bg-gradient-to-br from-amber-500 to-orange-600" href="/devices" />
            <QuickAccessCard icon={Box} title="电子沙盘" gradient="bg-gradient-to-br from-violet-600 to-purple-700" href="/sandbox" />
            <QuickAccessCard icon={Activity} title="设备状态与系统监控" gradient="bg-gradient-to-br from-rose-600 to-pink-700" href="/monitor" />
            <QuickAccessCard icon={BookOpen} title="知识库管理" gradient="bg-gradient-to-br from-blue-600 to-indigo-700" href="/knowledge" />
            <QuickAccessCard icon={Cpu} title="开源大语言模型" gradient="bg-gradient-to-br from-slate-800 to-slate-950" href="/models" />
            <QuickAccessCard icon={Bot} title="智能体框架与应用" gradient="bg-gradient-to-br from-purple-600 to-fuchsia-700" href="/agents" />
            <QuickAccessCard icon={Settings} title="系统设置" gradient="bg-slate-200 dark:bg-white/[0.08] !text-slate-800 dark:!text-slate-200" dark href="/settings" />
            {isAdmin && (
              <QuickAccessCard icon={Users} title="用户管理" gradient="bg-gradient-to-br from-emerald-600 to-teal-700" href="/users" />
            )}
          </div>
        </div>

        <div className="space-y-6">
          <div className="flex items-center justify-between gap-4 px-2">
            <h3 className="text-xl font-bold text-slate-900 dark:text-white">{canViewAll ? '近期活动' : '我的近期活动'}</h3>
            <Link href="/activity-logs" className="inline-flex min-h-9 items-center gap-1 rounded-[8px] bg-blue-50 px-3 py-2 text-xs font-bold text-blue-600 transition hover:bg-blue-100 dark:bg-blue-500/10 dark:text-blue-300">
              查看全部
              <ChevronRight size={14} />
            </Link>
          </div>
          <div className="rounded-2xl border border-slate-100 bg-white p-5 shadow-sm dark:border-white/[0.06] dark:bg-gradient-to-b dark:from-white/[0.06] dark:to-white/[0.02]">
            {platformLoading && !platformData ? (
              <div className="flex min-h-[180px] flex-col items-center justify-center text-center">
                <Loader2 className="mb-3 h-8 w-8 animate-spin text-blue-400" />
                <p className="text-sm font-bold text-slate-700 dark:text-slate-200">正在读取近期活动</p>
                <p className="mt-1 text-xs leading-5 text-slate-400">活动数据来自平台操作日志，不使用静态占位记录。</p>
              </div>
            ) : !platformData && platformError ? (
              <div className="flex min-h-[180px] flex-col items-center justify-center px-3 text-center" role="alert">
                <AlertTriangle className="mb-3 h-8 w-8 text-amber-400" />
                <p className="text-sm font-bold text-slate-700 dark:text-slate-200">近期活动未取得</p>
                <p className="mt-2 max-w-sm break-words text-xs leading-5 text-amber-700 dark:text-amber-300">{platformError}</p>
                <p className="mt-1 text-xs leading-5 text-slate-400">当前没有可展示的成功快照，不按零条日志统计。</p>
                <button type="button" onClick={() => void loadPlatform(true)} disabled={platformLoading} className="mt-4 inline-flex min-h-9 items-center gap-2 rounded-[8px] border border-amber-200 bg-white px-3 text-xs font-black text-amber-800 transition hover:bg-amber-50 disabled:cursor-wait disabled:opacity-50 dark:border-amber-500/30 dark:bg-white/[0.05] dark:text-amber-200">
                  {platformLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}{platformLoading ? '正在重新读取' : '重新读取平台数据'}
                </button>
              </div>
            ) : logs.length ? (
              <div className="divide-y divide-slate-100 dark:divide-white/[0.06]">
                {visibleLogs.map((log, index) => (
                  <Link
                    key={log.id || index}
                    href="/activity-logs"
                    className="flex items-center gap-3 px-1 py-4 transition hover:bg-blue-50/60 dark:hover:bg-blue-500/10"
                  >
                    <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                      log.level === 'error' ? 'bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300'
                        : log.level === 'warning' ? 'bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300'
                          : log.level === 'success' ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300'
                            : log.level === 'info' ? 'bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300'
                              : 'bg-slate-100 text-slate-500 dark:bg-white/[0.08] dark:text-slate-300'
                    }`}>
                      {log.level === 'error' || log.level === 'warning' ? <AlertTriangle size={16} /> : <Activity size={16} />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-black text-slate-900 dark:text-slate-100" title={log.title}>{log.title}</p>
                        <span
                          className={`inline-flex h-6 shrink-0 items-center rounded-[6px] px-2 text-xs font-bold ${
                            log.level === 'error' ? 'bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300'
                              : log.level === 'warning' ? 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300'
                                : log.level === 'success' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
                                  : 'bg-slate-100 text-slate-600 dark:bg-white/[0.08] dark:text-slate-300'
                          }`}
                          title={['success', 'warning', 'error', 'info'].includes(log.level) ? dashboardLogLevel(log.level) : `未识别等级：${log.level || '空值'}`}
                        >{dashboardLogLevel(log.level)}</span>
                      </div>
                      <p className="mt-1 truncate text-xs text-slate-400 dark:text-slate-500" title={`${formatActivityTime(log.created_at, activityClock)}${log.username ? ` · ${displayOperator(log.username)}` : ''} · ${activityTypeLabel(log)}`}>
                        {formatActivityTime(log.created_at, activityClock)}{log.username ? ` · ${displayOperator(log.username)}` : ''} · {activityTypeLabel(log)}
                      </p>
                    </div>
                  </Link>
                ))}
                <p className="px-1 pt-3 text-xs font-semibold leading-5 text-slate-400 dark:text-slate-500">
                  当前展示 {visibleLogs.length} 项{activityCoverage ? `，候选 ${activityCoverage.distinct_count} 项来自最近 ${activityCoverage.scanned_count} 条日志` : ''}。
                  {activityCoverage?.scan_truncated ? ' 更早记录未纳入本区摘要，请进入“查看全部”。' : ' 完整记录可进入“查看全部”。'}
                </p>
              </div>
            ) : (
              <div className="flex min-h-[180px] flex-col items-center justify-center text-center">
                <CheckCircle className="mb-3 h-8 w-8 text-slate-300" />
                <p className="text-sm font-bold text-slate-700 dark:text-slate-200">暂无操作日志</p>
                <p className="mt-1 text-xs leading-5 text-slate-400">完成设备控制、智能体测试或系统操作后会在这里形成运行记录。</p>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Service status table */}
      <section className="space-y-6">
        <div className="flex justify-between items-end px-2">
          <div>
            <h3 className="text-xl font-bold text-slate-900 dark:text-white">服务状态</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400 font-medium">核心服务最近一次探测状态</p>
          </div>
          <Link href="/activity-logs" className="flex min-h-9 items-center gap-1 rounded-[8px] px-3 py-2 text-sm font-bold text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-500/10">
            查看操作日志
            <ChevronRight size={16} />
          </Link>
        </div>

        {runtimeWarnings.length ? (
          <div className="flex flex-col gap-3 border-l-2 border-amber-400 bg-amber-50 px-4 py-3 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-black">
                <AlertTriangle size={16} className="shrink-0" />
                {runtimeError ? '上次成功探测仍有运行提醒' : runtimeLoading ? '正在复核外部服务，暂显示上次运行提醒' : `${runtimeWarnings.length} 类外部服务运行提醒`}
              </div>
              <ul className="mt-2 space-y-1 text-xs font-semibold leading-5">
                {runtimeWarnings.map((warning) => <li key={warning}>• {warning}</li>)}
              </ul>
            </div>
            <Link href="/settings" className="inline-flex min-h-9 shrink-0 items-center justify-center gap-1 rounded-[7px] border border-amber-300 bg-white px-3 py-2 text-xs font-black text-amber-800 transition hover:bg-amber-100 dark:border-amber-400/30 dark:bg-white/10 dark:text-amber-100 dark:hover:bg-white/15">
              检查系统设置
              <ChevronRight size={14} />
            </Link>
          </div>
        ) : runtimeData && !runtimeLoading && !runtimeError ? (
          <div className="flex items-center gap-2 border-l-2 border-emerald-500 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200">
            <CheckCircle size={16} className="shrink-0" />
            最近一次外部服务探测未发现运行异常，具体业务操作仍以目标页面反馈为准。
          </div>
        ) : null}

        {runtimeError && !runtimeData && services.length > 0 ? (
          <div className="flex flex-col gap-3 rounded-[8px] border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200 sm:flex-row sm:items-center sm:justify-between" role="alert">
            <div className="min-w-0">
              <p className="font-black">外部服务状态未取得</p>
              <p className="mt-1 break-words text-xs leading-5">{runtimeError}；下方仅保留已取得的平台后端状态，不代表外部服务可用。</p>
            </div>
            <button type="button" onClick={() => void loadRuntime(true)} disabled={runtimeLoading} className="inline-flex min-h-9 shrink-0 items-center justify-center gap-2 rounded-[8px] border border-amber-300 bg-white px-3 text-xs font-black text-amber-800 disabled:cursor-wait disabled:opacity-50 dark:border-amber-400/30 dark:bg-white/10 dark:text-amber-100">
              {runtimeLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}{runtimeLoading ? '正在重新探测' : '重新探测外部服务'}
            </button>
          </div>
        ) : null}

        <div className="bg-white dark:bg-transparent dark:bg-gradient-to-b dark:from-white/[0.04] dark:to-transparent rounded-2xl overflow-hidden shadow-sm dark:shadow-none border border-slate-100 dark:border-white/[0.06]">
          {platformLoading && !platformData ? (
            <div className="flex items-center gap-3 border-b border-slate-100 bg-blue-50/60 px-6 py-4 text-sm font-bold text-blue-700 dark:border-white/[0.06] dark:bg-blue-500/10 dark:text-blue-200">
              <Loader2 size={16} className="animate-spin" />
              正在读取平台后端状态与设备台账...
            </div>
          ) : runtimeLoading && !runtimeData && (
            <div className="flex items-center gap-3 border-b border-slate-100 bg-blue-50/60 px-6 py-4 text-sm font-bold text-blue-700 dark:border-white/[0.06] dark:bg-blue-500/10 dark:text-blue-200">
              <Loader2 size={16} className="animate-spin" />
              平台后端已就绪，正在独立探测 Dify、Home Assistant、Ollama 与 InfluxDB...
            </div>
          )}
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="核心服务状态列表，可横向滚动">
          <table className="min-w-[900px] w-full table-fixed text-left">
            <thead>
              <tr className="bg-slate-50/50 dark:bg-white/[0.04]">
                <th className="w-[20%] px-6 py-4 text-xs font-bold text-slate-500 dark:text-slate-400">服务名称</th>
                <th className="w-[32%] px-6 py-4 text-xs font-bold text-slate-500 dark:text-slate-400">运行诊断</th>
                <th className="w-[24%] px-6 py-4 text-xs font-bold text-slate-500 dark:text-slate-400">{isAdmin ? '访问地址' : '配置范围'}</th>
                <th className="w-[12%] px-6 py-4 text-xs font-bold text-slate-500 dark:text-slate-400">响应耗时</th>
                <th className="w-[12%] px-6 py-4 text-xs font-bold text-slate-500 dark:text-slate-400">状态</th>
              </tr>
            </thead>
            <tbody>
              {services.map(svc => {
                const iconMap: Record<string, ComponentType<LucideProps>> = {
                  backend: Globe,
                  dify_app: Bot,
                  dify_knowledge: BookOpen,
                  ollama: BrainCircuit,
                  homeassistant: Home,
                  influxdb: Database,
                }
                const colorMap: Record<string, string> = {
                  backend: 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400',
                  dify_app: 'bg-purple-50 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400',
                  dify_knowledge: 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400',
                  ollama: 'bg-slate-100 dark:bg-white/[0.08] text-slate-700 dark:text-slate-300',
                  homeassistant: 'bg-orange-50 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400',
                  influxdb: 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400',
                }
                return (
                  <ServiceRow
                    key={svc.key}
                    icon={iconMap[svc.key] || Globe}
                    service={svc}
                    color={colorMap[svc.key] || 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400'}
                    canViewEndpoint={isAdmin}
                  />
                )
              })}
              {!services.length && !loading && (
                <tr>
                  <td colSpan={5} role={platformError || runtimeError ? 'alert' : undefined} className={`break-words px-8 py-12 text-center text-sm font-semibold ${platformError || runtimeError ? 'text-amber-700 dark:text-amber-300' : 'text-slate-400'}`}>
                    <p>{platformError || runtimeError || '当前没有需要展示的服务状态。'}</p>
                    {platformError || runtimeError ? <p className="mt-1 text-xs font-medium opacity-80">当前没有成功服务快照，不能判断服务是否可用。</p> : null}
                    <button type="button" onClick={() => {
                      if (platformError) void loadPlatform(true)
                      if (runtimeError) void loadRuntime(true)
                    }} disabled={platformLoading || runtimeLoading} className="mt-3 inline-flex min-h-9 items-center gap-2 rounded-[8px] bg-slate-100 px-4 text-xs font-black text-slate-700 hover:bg-blue-50 hover:text-blue-700 disabled:cursor-wait disabled:opacity-50 dark:bg-white/[0.08] dark:text-slate-200">
                      {platformLoading || runtimeLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}{platformLoading || runtimeLoading ? '正在重新读取' : '重新读取状态'}
                    </button>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </div>
        </div>
      </section>
    </div>
  )
}
