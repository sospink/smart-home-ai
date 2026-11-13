'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Eye,
  Filter,
  Info,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
} from 'lucide-react'
import {
  cleanupOperationLogs,
  exportOperationLogs,
  fetchOperationLogList,
  fetchOperationLogRetention,
  type OperationLogItem,
  type OperationLogRetentionPreview,
  type OperationLogStats,
} from '@/lib/api/monitor'
import { UnifiedSelect } from '@/components/ui/UnifiedSelect'
import { TechnicalId } from '@/components/ui/TechnicalId'
import { Pagination } from '@/components/ui/Pagination'
import { AppDrawer } from '@/components/ui/AppDrawer'
import { AppDialog } from '@/components/ui/AppDialog'
import { useAuth } from '@/lib/hooks/useAuth'
import { businessErrorMessage } from '@/lib/ui/business-error'

const LOG_TYPES = [
  { value: '', label: '全部类型' },
  { value: 'model_inference', label: '模型推理' },
  { value: 'device_control', label: '设备控制' },
  { value: 'user_management', label: '用户管理' },
  { value: 'system_settings', label: '系统配置' },
  { value: 'user_login', label: '用户登录' },
  { value: 'agent_test', label: '智能体测试' },
  { value: 'agent_control', label: '智能体设备控制' },
  { value: 'agent_device_status', label: '智能体状态查询' },
  { value: 'device_sync', label: '设备同步' },
  { value: 'model_pull', label: '模型拉取' },
  { value: 'model_management', label: '模型管理' },
  { value: 'time_series', label: '时序数据' },
  { value: 'api_doc_management', label: '接口文档管理' },
  { value: 'agent_template', label: '智能体模板管理' },
  { value: 'agent_instance', label: '智能体实例管理' },
  { value: 'knowledge_management', label: '知识库管理' },
  { value: 'sandbox_simulation', label: '电子沙盘联调' },
]

const LOG_LEVELS = [
  { value: '', label: '全部等级' },
  { value: 'success', label: '成功' },
  { value: 'warning', label: '警告' },
  { value: 'error', label: '错误' },
  { value: 'info', label: '信息' },
]

function formatDateTime(value?: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('zh-CN')
}

function levelClass(level: string) {
  if (level === 'error') return 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-300'
  if (level === 'warning') return 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-300'
  if (level === 'success') return 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-300'
  if (level === 'info') return 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300'
  return 'bg-slate-100 text-slate-600 dark:bg-white/[0.08] dark:text-slate-300'
}

function levelLabel(level: string) {
  if (level === 'error') return '错误'
  if (level === 'warning') return '警告'
  if (level === 'success') return '成功'
  if (level === 'info') return '信息'
  return '其他等级'
}

function typeLabel(type: string) {
  return LOG_TYPES.find((item) => item.value === type)?.label || '其他系统操作'
}

function translateDiagnostic(value: string) {
  const translated = value
    .replace(/^\s*(?:HTTP\s*)?\d{3}\s*[:：]\s*/i, '')
    .replace(/Client error\s+['"](\d{3})[^'"]*['"]\s+for url\s+['"][^'"]+['"](?:\s+For more information check:\s*\S+)?/gi, '上游服务返回 $1 错误')
    .replaceAll('Server disconnected', '服务端连接已断开')
    .replace(/\s*without sending a response\.?/gi, '')
    .replaceAll('All connection attempts failed', '无法连接目标服务')
    .replace(/\bunavailable\b/gi, '不可用')
    .replace(/\bpending\b/gi, '等待状态回读')
    .replace(/回滚为\s+off\b/gi, '回滚为关闭')
    .replace(/回滚为\s+on\b/gi, '回滚为开启')
    .replace(/Server error\s+['"](\d{3})[^'"]*['"]\s+for url\s+['"][^'"]+['"](?:\s+For more information check:\s*\S+)?/gi, '上游服务返回 $1 错误')
    .replace(/model failed to load, this may be due to resource limitations or an internal error, check ollama server logs for details/gi, '模型加载失败，可能由系统资源不足或运行时异常导致，请查看 Ollama 服务日志')
    .replace(/\bmodel failed to load\b/gi, '模型加载失败')
    .replace(/llama runner process has terminated:\s*%!w\(<nil>\)/gi, 'Ollama 模型运行进程意外终止')
    .replace(/model_not_installed/gi, '模型尚未安装')
    .replace(/inference_failed/gi, '推理失败')
    .replace(/physical_pending/gi, '待实机确认')
    .replace(/[:：]\s*[；;]+/g, '；')
    .replace(/状态采集失败\s*[:：]\s*/g, '状态采集失败：')
    .replace(/[；;]{2,}/g, '；')
    .trim()
  if (/Metal 后端初始化失败|bfloat\/half 类型不匹配/i.test(translated)) {
    return '当前 Ollama/Metal 运行时无法加载模型，请在详情中查看完整诊断并检查 Ollama 版本与系统资源'
  }
  return translated.replace(/为\s+不可用/g, '为不可用')
}

function parseLegacyDetail(detail: string) {
  const fields: Record<string, string> = {}
  detail.split(/[;,]\s*/).forEach((part) => {
    const separator = part.indexOf('=')
    if (separator <= 0) return
    const key = part.slice(0, separator).trim().toLowerCase()
    const value = part.slice(separator + 1).trim()
    if (key && value) fields[key] = value
  })
  return fields
}

function sanitizeBusinessSummary(value: string) {
  return translateDiagnostic(value)
    .replace(/[；;,]\s*signature=[^；;,\s]+/gi, '')
    .replace(/\bpower\s*[：:]\s*on\b/gi, '电源：开启')
    .replace(/\bpower\s*[：:]\s*off\b/gi, '电源：关闭')
    .trim()
}

function detailSummary(log: OperationLogItem) {
  if (log.summary?.trim()) return sanitizeBusinessSummary(log.summary)
  const detail = String(log.detail || '').trim()
  if (!detail) return '暂无补充说明'
  if (detail.startsWith('{')) {
    try {
      const payload = JSON.parse(detail)
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        return `已记录${typeLabel(log.type)}操作；完整字段请在详情中查看。`
      }
    } catch {
      // 兼容历史非标准 JSON 详情，继续按普通文本显示。
    }
  }
  if (/InfluxDB 写入失败/i.test(detail)) {
    return '时序数据库写入暂时不可用，系统已进入退避重试；原始诊断请在详情中查看。'
  }
  const fields = parseLegacyDetail(detail)
  if (Object.keys(fields).length >= 2) {
    const resultKey = String(fields.result || fields.status || '').trim().toLowerCase()
    const hasExplicitDiagnostic = Boolean(fields.reason || fields.error)
    if (log.type === 'agent_device_status' && !hasExplicitDiagnostic && !['failed', 'error'].includes(resultKey) && fields.answer) {
      const answer = sanitizeBusinessSummary(fields.answer)
      return `状态查询结果：${answer}`
    }
    if (log.type === 'agent_test' && !hasExplicitDiagnostic && fields.answer) return `智能体测试完成：${translateDiagnostic(fields.answer)}`
    const diagnostic = translateDiagnostic(fields.reason || fields.error || '')
    const result = translateDiagnostic(fields.result || '')
    if (diagnostic) {
      if (log.type === 'device_control' || log.type === 'agent_control') return `设备控制未完成：${diagnostic}`
      if (log.type === 'model_inference') {
        return `${fields.model ? `模型 ${fields.model} ` : '模型'}推理未完成：${diagnostic}`
      }
      return `${typeLabel(log.type)}未完成：${diagnostic}`
    }
    if (result) return `${typeLabel(log.type)}结果：${result}；原始字段请在详情中查看。`
    return `已记录${typeLabel(log.type)}操作；原始字段请在详情中查看。`
  }
  if (/(^|[;,\s])(action|target_user_id|target_username|deleted|retained_failures|scope|signature|user_id|role)=/i.test(detail)) {
    return `已记录${typeLabel(log.type)}操作；原始字段请在详情中查看。`
  }
  const translated = sanitizeBusinessSummary(detail)
  if (/https?:\/\/|traceback|exception|\b[a-z]+error\b|\bhttp\s*\d{3}\b|failed to|connection refused|timed?\s*out/i.test(translated)) {
    return `${typeLabel(log.type)}未完成，请在技术信息中查看原始诊断并检查相关服务状态。`
  }
  return translated
}

function displayOperator(value?: string | null) {
  const normalized = String(value || '').trim().toLowerCase()
  return !normalized || normalized === 'system' || normalized === 'system_task' ? '系统任务' : String(value)
}

function displayLogTitle(log: OperationLogItem) {
  return String(log.title || '未命名操作')
    .replace(/\bturn_on\b/gi, '打开')
    .replace(/\bturn_off\b/gi, '关闭')
    .replace(/\btoggle\b/gi, '切换')
    .replace(/\bset_brightness\b/gi, '设置亮度')
    .replace(/\bset_color_temperature\b/gi, '设置色温')
    .replace(/\bset_effect\b/gi, '设置灯效')
    .replace(/\bset_temperature\b/gi, '设置温度')
    .replace(/\bset_hvac_mode\b/gi, '设置运行模式')
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function fullDetail(value?: string | null) {
  const detail = String(value || '').trim()
  if (!detail) return '—'
  try {
    const payload = JSON.parse(detail)
    return JSON.stringify(payload, null, 2)
  } catch {
    return detail
  }
}

function logViewKey({
  keyword,
  type,
  level,
  startTime,
  endTime,
  collapsePeriodic,
  page,
  size,
}: {
  keyword: string
  type: string
  level: string
  startTime: string
  endTime: string
  collapsePeriodic: boolean
  page: number
  size: number
}) {
  return JSON.stringify({ keyword: keyword.trim(), type, level, startTime, endTime, collapsePeriodic, page, size })
}

function StatCard({ label, value, tone, detail = '', className = '' }: { label: string; value: string | number; tone: string; detail?: string; className?: string }) {
  const valueText = String(value)
  return (
    <div className={`flex min-h-[116px] min-w-0 flex-col rounded-[8px] border border-slate-200 bg-white px-4 py-4 dark:border-white/[0.08] dark:bg-white/[0.04] sm:px-5 sm:py-4 ${className}`}>
      <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">{label}</p>
      <p className={`mt-3 break-words text-2xl font-black leading-tight ${tone}`} title={valueText}>{value}</p>
      {detail ? <p className="mt-auto line-clamp-2 pt-2 text-xs font-medium leading-5 text-slate-400 dark:text-slate-500" title={detail}>{detail}</p> : null}
    </div>
  )
}

function ActivityLogsContent() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [logs, setLogs] = useState<OperationLogItem[]>([])
  const [stats, setStats] = useState<OperationLogStats | null>(null)
  const [total, setTotal] = useState(0)
  const [collapsedCount, setCollapsedCount] = useState(0)
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(20)
  const [keyword, setKeyword] = useState('')
  const [debouncedKeyword, setDebouncedKeyword] = useState('')
  const [searchSettled, setSearchSettled] = useState(true)
  const [type, setType] = useState('')
  const [level, setLevel] = useState('')
  const [startTime, setStartTime] = useState('')
  const [endTime, setEndTime] = useState('')
  const [collapsePeriodic, setCollapsePeriodic] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [listReadFailed, setListReadFailed] = useState(false)
  const [selected, setSelected] = useState<OperationLogItem | null>(null)
  const [filtersReady, setFiltersReady] = useState(false)
  const [hasLoaded, setHasLoaded] = useState(false)
  const [loadedViewKey, setLoadedViewKey] = useState('')
  const [loadedPage, setLoadedPage] = useState(1)
  const [loadedSize, setLoadedSize] = useState(20)
  const [refreshing, setRefreshing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning' | 'error'; message: string } | null>(null)
  const [maintenanceOpen, setMaintenanceOpen] = useState(false)
  const [retentionPreview, setRetentionPreview] = useState<OperationLogRetentionPreview | null>(null)
  const [retentionLoading, setRetentionLoading] = useState(false)
  const [retentionError, setRetentionError] = useState('')
  const [retentionReadFailed, setRetentionReadFailed] = useState(false)
  const [cleanupConfirmation, setCleanupConfirmation] = useState('')
  const [cleaning, setCleaning] = useState(false)
  const requestSequence = useRef(0)
  const listAbortRef = useRef<AbortController | null>(null)
  const refreshInFlight = useRef(0)
  const exportInFlight = useRef(false)
  const exportRequestSequence = useRef(0)
  const exportAbortRef = useRef<AbortController | null>(null)
  const retentionAbortRef = useRef<AbortController | null>(null)
  const cleanupAbortRef = useRef<AbortController | null>(null)
  const cleanupSequence = useRef(0)
  const cleanupReconcileTimer = useRef<number | null>(null)
  const cleanupConfirmationRef = useRef<HTMLInputElement | null>(null)
  const maintenanceFocusPending = useRef(false)
  const writtenSearchRef = useRef(searchParams.toString())
  const { isAdmin, loading: authLoading } = useAuth()

  const activeFilterCount = [keyword.trim(), type, level, startTime, endTime].filter(Boolean).length
  const currentViewKey = logViewKey({
    keyword: debouncedKeyword,
    type,
    level,
    startTime,
    endTime,
    collapsePeriodic,
    page,
    size,
  })
  const snapshotMatchesView = hasLoaded
    && searchSettled
    && keyword.trim() === debouncedKeyword
    && loadedViewKey === currentViewKey
  const snapshotIsStale = hasLoaded && !snapshotMatchesView
  const dateRangeInvalid = Boolean(startTime && endTime && startTime > endTime)
  const exportDisabled = !exporting && (!snapshotMatchesView || dateRangeInvalid || total === 0)
  const exportTitle = dateRangeInvalid
    ? '开始时间不能晚于结束时间，请调整查询范围'
    : !snapshotMatchesView
      ? '等待当前筛选结果读取完成后再导出'
      : total === 0
        ? '当前筛选结果没有可导出的日志'
        : '导出当前筛选范围内的完整日志 CSV'

  const invalidateLogView = () => {
    listAbortRef.current?.abort()
    listAbortRef.current = null
    requestSequence.current += 1
    refreshInFlight.current = 0
    setRefreshing(false)
    setLoading(true)
    setError('')
    setListReadFailed(false)
    setSelected(null)
  }

  const loadLogs = useCallback(async (force = false) => {
    if (!filtersReady || !searchSettled || keyword.trim() !== debouncedKeyword) return
    if (force && refreshInFlight.current) return
    if (startTime && endTime && startTime > endTime) {
      setError('开始时间不能晚于结束时间')
      setListReadFailed(false)
      setLoading(false)
      setRefreshing(false)
      return
    }
    listAbortRef.current?.abort()
    const controller = new AbortController()
    listAbortRef.current = controller
    const sequence = ++requestSequence.current
    if (force) {
      refreshInFlight.current = sequence
      setRefreshing(true)
    }
    setLoading(true)
    setListReadFailed(false)
    try {
      const result = await fetchOperationLogList({
        page,
        size,
        keyword: debouncedKeyword,
        type,
        level,
        start_time: startTime,
        end_time: endTime,
        collapse_periodic: collapsePeriodic,
      }, force, controller.signal)
      if (sequence !== requestSequence.current) return
      setLogs(result.logs || [])
      setStats(result.stats || null)
      setTotal(result.total || 0)
      setCollapsedCount(result.collapsed_count || 0)
      const resolvedPage = result.page || page
      const resolvedSize = result.size || size
      setLoadedPage(resolvedPage)
      setLoadedSize(resolvedSize)
      setLoadedViewKey(logViewKey({
        keyword: debouncedKeyword,
        type,
        level,
        startTime,
        endTime,
        collapsePeriodic,
        page: resolvedPage,
        size: resolvedSize,
      }))
      if (resolvedPage !== page) setPage(resolvedPage)
      setHasLoaded(true)
      setError('')
      setListReadFailed(false)
    } catch (err) {
      if (sequence !== requestSequence.current || controller.signal.aborted) return
      setError(businessErrorMessage(err, { fallback: '操作日志加载失败', service: '操作日志' }))
      setListReadFailed(true)
    } finally {
      if (listAbortRef.current === controller) listAbortRef.current = null
      if (sequence === requestSequence.current) setLoading(false)
      if (refreshInFlight.current === sequence) {
        refreshInFlight.current = 0
        setRefreshing(false)
      }
    }
  }, [collapsePeriodic, debouncedKeyword, endTime, filtersReady, keyword, level, page, searchSettled, size, startTime, type])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const initialKeyword = params.get('keyword') || ''
    setKeyword(initialKeyword)
    setDebouncedKeyword(initialKeyword.trim())
    setType(LOG_TYPES.some(item => item.value === params.get('type')) ? params.get('type') || '' : '')
    setLevel(LOG_LEVELS.some(item => item.value === params.get('level')) ? params.get('level') || '' : '')
    setStartTime(params.get('start_time') || '')
    setEndTime(params.get('end_time') || '')
    setCollapsePeriodic(params.get('periodic') !== 'full')
    const requestedSize = Number(params.get('size'))
    if ([10, 20, 50, 100].includes(requestedSize)) setSize(requestedSize)
    const requestedPage = Number(params.get('page'))
    if (Number.isInteger(requestedPage) && requestedPage > 0) setPage(requestedPage)
    setFiltersReady(true)
  }, [])

  useEffect(() => {
    if (!filtersReady) return
    const params = new URLSearchParams()
    if (keyword.trim()) params.set('keyword', keyword.trim())
    if (type) params.set('type', type)
    if (level) params.set('level', level)
    if (startTime) params.set('start_time', startTime)
    if (endTime) params.set('end_time', endTime)
    if (!collapsePeriodic) params.set('periodic', 'full')
    if (size !== 20) params.set('size', String(size))
    if (page !== 1) params.set('page', String(page))
    const query = params.toString()
    writtenSearchRef.current = query
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${query ? `?${query}` : ''}`)
  }, [collapsePeriodic, endTime, filtersReady, keyword, level, page, size, startTime, type])

  useEffect(() => {
    if (!filtersReady || pathname !== '/activity-logs') return
    const incomingSearch = searchParams.toString()
    if (incomingSearch === writtenSearchRef.current) return
    writtenSearchRef.current = incomingSearch
    const nextKeyword = searchParams.get('keyword') || ''
    const requestedSize = Number(searchParams.get('size'))
    const requestedPage = Number(searchParams.get('page'))
    invalidateLogView()
    setKeyword(nextKeyword)
    setDebouncedKeyword(nextKeyword.trim())
    setSearchSettled(true)
    setType(LOG_TYPES.some((item) => item.value === searchParams.get('type')) ? searchParams.get('type') || '' : '')
    setLevel(LOG_LEVELS.some((item) => item.value === searchParams.get('level')) ? searchParams.get('level') || '' : '')
    setStartTime(searchParams.get('start_time') || '')
    setEndTime(searchParams.get('end_time') || '')
    setCollapsePeriodic(searchParams.get('periodic') !== 'full')
    setSize([10, 20, 50, 100].includes(requestedSize) ? requestedSize : 20)
    setPage(Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1)
  }, [filtersReady, pathname, searchParams])

  useEffect(() => {
    if (!filtersReady) return
    const timer = window.setTimeout(() => {
      setDebouncedKeyword(keyword.trim())
      setSearchSettled(true)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [filtersReady, keyword])

  useEffect(() => {
    void loadLogs()
  }, [loadLogs])

  useEffect(() => () => {
    requestSequence.current += 1
    listAbortRef.current?.abort()
    listAbortRef.current = null
    exportRequestSequence.current += 1
    refreshInFlight.current = 0
    exportAbortRef.current?.abort()
    exportAbortRef.current = null
    exportInFlight.current = false
    retentionAbortRef.current?.abort()
    cleanupAbortRef.current?.abort()
    cleanupSequence.current += 1
    if (cleanupReconcileTimer.current !== null) window.clearTimeout(cleanupReconcileTimer.current)
  }, [])

  useEffect(() => {
    exportRequestSequence.current += 1
    exportAbortRef.current?.abort()
    exportAbortRef.current = null
    exportInFlight.current = false
    setExporting(false)
    setNotice(null)
  }, [endTime, keyword, level, startTime, type])

  useEffect(() => {
    if (!maintenanceOpen || !maintenanceFocusPending.current || !retentionPreview?.deletable) return
    maintenanceFocusPending.current = false
    cleanupConfirmationRef.current?.focus()
  }, [maintenanceOpen, retentionPreview])

  const clearFilters = () => {
    invalidateLogView()
    setSearchSettled(false)
    setKeyword('')
    setType('')
    setLevel('')
    setStartTime('')
    setEndTime('')
    setPage(1)
  }

  const openLogDetail = (log: OperationLogItem) => {
    if (!snapshotMatchesView) {
      setNotice({ tone: 'warning', message: '当前日志属于上一次成功快照，请等待当前筛选结果返回后再查看详情。' })
      return
    }
    setSelected(log)
  }

  const handleExport = async () => {
    if (exportInFlight.current) return
    if (dateRangeInvalid) {
      setNotice({ tone: 'error', message: '开始时间不能晚于结束时间，未执行导出。' })
      return
    }
    if (!snapshotMatchesView || total === 0) return
    const sequence = ++exportRequestSequence.current
    const controller = new AbortController()
    exportInFlight.current = true
    exportAbortRef.current = controller
    try {
      setExporting(true)
      setNotice(null)
      const result = await exportOperationLogs({
        keyword: keyword.trim(),
        type,
        level,
        start_time: startTime,
        end_time: endTime,
      }, controller.signal)
      if (exportRequestSequence.current !== sequence) return
      if (!result.count) {
        setNotice({ tone: 'warning', message: '当前筛选结果为空，未生成导出文件。' })
        return
      }
      downloadBlob(result.blob, result.filename)
      setNotice({ tone: 'success', message: `已导出 ${result.count} 条日志${result.truncated ? '，结果达到 10,000 条上限' : ''}` })
    } catch (err) {
      if (controller.signal.aborted) return
      if (exportRequestSequence.current === sequence) {
        setNotice({ tone: 'error', message: businessErrorMessage(err, { fallback: '操作日志导出失败', service: '操作日志导出' }) })
      }
    } finally {
      if (exportRequestSequence.current === sequence) {
        exportInFlight.current = false
        exportAbortRef.current = null
        setExporting(false)
      }
    }
  }

  const cancelExport = () => {
    if (!exportInFlight.current) return
    exportRequestSequence.current += 1
    exportAbortRef.current?.abort()
    exportAbortRef.current = null
    exportInFlight.current = false
    setExporting(false)
    setNotice({ tone: 'warning', message: '已取消本次导出，未生成文件。' })
  }

  const latestTime = useMemo(() => formatDateTime(stats?.latest_at), [stats?.latest_at])

  const loadRetentionPreview = useCallback(async () => {
    if (!isAdmin) {
      setRetentionPreview(null)
      setRetentionError('日志保留策略仅管理员可查看')
      setRetentionReadFailed(false)
      return
    }
    retentionAbortRef.current?.abort()
    const controller = new AbortController()
    retentionAbortRef.current = controller
    setRetentionLoading(true)
    setRetentionError('')
    setRetentionReadFailed(false)
    try {
      const result = await fetchOperationLogRetention(90, 365, controller.signal)
      if (retentionAbortRef.current !== controller) return
      setRetentionPreview(result)
      setRetentionReadFailed(false)
    } catch (reason) {
      if (!controller.signal.aborted) {
        setRetentionError(businessErrorMessage(reason, { fallback: '日志保留策略读取失败', service: '日志维护' }))
        setRetentionReadFailed(true)
      }
    } finally {
      if (retentionAbortRef.current === controller) {
        retentionAbortRef.current = null
        setRetentionLoading(false)
      }
    }
  }, [isAdmin])

  useEffect(() => {
    if (!listReadFailed && !(maintenanceOpen && retentionReadFailed)) return
    const recoverFailedReads = () => {
      if (!navigator.onLine || document.hidden) return
      if (listReadFailed && !listAbortRef.current) void loadLogs(true)
      if (
        maintenanceOpen
        && retentionReadFailed
        && !cleaning
        && !retentionAbortRef.current
      ) void loadRetentionPreview()
    }
    const handleVisibilityChange = () => {
      if (!document.hidden) recoverFailedReads()
    }
    window.addEventListener('online', recoverFailedReads)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('online', recoverFailedReads)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [cleaning, listReadFailed, loadLogs, loadRetentionPreview, maintenanceOpen, retentionReadFailed])

  const reconcileCleanup = useCallback(async (sequence: number) => {
    await loadLogs(true)
    if (cleanupSequence.current !== sequence) return
    await loadRetentionPreview()
    if (cleanupReconcileTimer.current !== null) window.clearTimeout(cleanupReconcileTimer.current)
    cleanupReconcileTimer.current = window.setTimeout(() => {
      if (cleanupSequence.current !== sequence) return
      void (async () => {
        await loadLogs(true)
        if (cleanupSequence.current === sequence) await loadRetentionPreview()
      })()
    }, 1200)
  }, [loadLogs, loadRetentionPreview])

  const openMaintenance = () => {
    if (!isAdmin) {
      setNotice({ tone: 'error', message: '日志维护仅管理员可执行。' })
      return
    }
    maintenanceFocusPending.current = true
    setRetentionPreview(null)
    setRetentionError('')
    setRetentionReadFailed(false)
    setMaintenanceOpen(true)
    setCleanupConfirmation('')
    void loadRetentionPreview()
  }

  const cancelCleanupWaiting = () => {
    if (!cleaning) return
    const sequence = ++cleanupSequence.current
    cleanupAbortRef.current?.abort()
    cleanupAbortRef.current = null
    setCleaning(false)
    setNotice({ tone: 'warning', message: '已取消前端等待，服务端清理结果待确认；页面正在自动复核。' })
    void reconcileCleanup(sequence)
  }

  const closeMaintenance = () => {
    maintenanceFocusPending.current = false
    retentionAbortRef.current?.abort()
    retentionAbortRef.current = null
    setRetentionLoading(false)
    setRetentionPreview(null)
    setRetentionError('')
    setRetentionReadFailed(false)
    if (cleaning) cancelCleanupWaiting()
    setMaintenanceOpen(false)
    setCleanupConfirmation('')
  }

  const handleCleanup = async () => {
    if (cleaning || cleanupConfirmation.trim() !== '清理过期日志') return
    if (!isAdmin) {
      setMaintenanceOpen(false)
      setNotice({ tone: 'error', message: '日志维护仅管理员可执行。' })
      return
    }
    const sequence = ++cleanupSequence.current
    const controller = new AbortController()
    cleanupAbortRef.current = controller
    setCleaning(true)
    setRetentionError('')
    try {
      const result = await cleanupOperationLogs({ normal_days: 90, error_days: 365, confirmation: cleanupConfirmation.trim() }, controller.signal)
      if (cleanupSequence.current !== sequence) return
      setCleanupConfirmation('')
      setNotice({ tone: 'success', message: `已清理 ${result.deleted} 条过期日志，当前保留 ${result.remaining} 条审计记录。` })
      await reconcileCleanup(sequence)
    } catch (reason) {
      if (cleanupSequence.current !== sequence || controller.signal.aborted) return
      setNotice({ tone: 'warning', message: '日志清理结果待确认，页面正在自动复核，请勿立即重复提交。' })
      await reconcileCleanup(sequence)
      if (reason instanceof Error) setRetentionError(reason.message)
    } finally {
      if (cleanupSequence.current === sequence) {
        cleanupAbortRef.current = null
        setCleaning(false)
      }
    }
  }

  return (
    <div className="mx-auto w-full max-w-7xl min-w-0 space-y-8 overflow-hidden">
      <section className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <h2 className="text-3xl font-black text-slate-900 dark:text-white">{authLoading || isAdmin ? '操作日志' : '我的操作日志'}</h2>
          <p className="mt-2 max-w-4xl text-sm leading-7 text-slate-500 dark:text-slate-400">
            {authLoading
              ? '正在确认当前账号可查看的日志范围。'
              : isAdmin
              ? '查看平台系统操作、模型推理、设备控制、用户管理和配置保存记录；原始字段收纳在详情中。'
              : '查看当前账号产生的模型推理、设备控制和智能体运行记录；其他用户和系统任务日志不会返回。'}
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
          {isAdmin ? (
            <button
              type="button"
              onClick={openMaintenance}
              className="inline-flex h-11 w-full shrink-0 items-center justify-center gap-2 rounded-[8px] border border-slate-200 bg-white px-5 text-sm font-black text-slate-600 transition hover:bg-slate-50 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-slate-200 sm:w-auto"
            >
              <Trash2 size={16} />
              日志维护
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => exporting ? cancelExport() : void handleExport()}
            disabled={exportDisabled}
            title={exporting ? '取消当前导出' : exportTitle}
            className="inline-flex h-11 w-full shrink-0 items-center justify-center gap-2 rounded-[8px] border border-slate-200 bg-white px-5 text-sm font-black text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-slate-200 sm:w-auto"
          >
            {exporting ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
            {exporting ? '取消导出' : '导出 CSV'}
          </button>
          <button
            type="button"
            onClick={() => void loadLogs(true)}
            disabled={refreshing || (loading && !hasLoaded) || !filtersReady || !searchSettled || keyword.trim() !== debouncedKeyword}
            className="inline-flex h-11 w-full shrink-0 items-center justify-center gap-2 rounded-[8px] bg-blue-600 px-5 text-sm font-black text-white transition hover:bg-blue-700 disabled:opacity-60 sm:w-auto"
          >
            <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
            {refreshing ? '正在刷新' : '刷新日志'}
          </button>
        </div>
      </section>

      {notice ? (
        <div className={`-mt-5 flex items-center justify-end gap-2 text-xs font-semibold ${notice.tone === 'success' ? 'text-emerald-700 dark:text-emerald-300' : notice.tone === 'warning' ? 'text-amber-700 dark:text-amber-300' : 'text-rose-700 dark:text-rose-300'}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
          {notice.tone === 'success' ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
          {notice.message}
        </div>
      ) : null}

      <section className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
        <StatCard
          label="日志总数"
          value={hasLoaded ? stats?.total ?? total : '—'}
          detail={hasLoaded ? `${snapshotIsStale ? '上次快照 · ' : ''}其中信息 ${stats?.info ?? 0} 条` : ''}
          tone="text-slate-900 dark:text-white"
        />
        <StatCard label="成功" value={hasLoaded ? stats?.success ?? 0 : '—'} detail={snapshotIsStale ? '上次快照' : ''} tone="text-emerald-600" />
        <StatCard label="警告" value={hasLoaded ? stats?.warning ?? 0 : '—'} detail={snapshotIsStale ? '上次快照' : ''} tone="text-amber-600" />
        <StatCard label="错误" value={hasLoaded ? stats?.error ?? 0 : '—'} detail={snapshotIsStale ? '上次快照' : ''} tone="text-red-600" />
        <StatCard label="最近记录" value={latestTime} detail={snapshotIsStale ? '上次快照' : ''} tone="text-blue-600 text-sm leading-6 tabular-nums sm:text-base" className="col-span-2 lg:col-span-1" />
      </section>

      <section className="rounded-[8px] border border-slate-200 bg-white p-5 dark:border-white/[0.08] dark:bg-white/[0.04]">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 text-sm font-black text-slate-900 dark:text-white">
            <Filter size={16} className="text-blue-500" />
            筛选条件{activeFilterCount ? ` · 已启用 ${activeFilterCount} 项` : ''}
          </div>
          <div className="flex min-w-0 items-center justify-between gap-3 sm:justify-end">
            <div className="inline-flex min-w-0 rounded-[8px] border border-slate-200 bg-slate-50 p-0.5 dark:border-white/[0.08] dark:bg-white/[0.04]" aria-label="周期日志显示方式">
              <button type="button" onClick={() => { if (!collapsePeriodic) { invalidateLogView(); setCollapsePeriodic(true); setPage(1) } }} aria-pressed={collapsePeriodic} className={`min-h-8 whitespace-nowrap rounded-[6px] px-3 py-1.5 text-xs font-black transition ${collapsePeriodic ? 'bg-white text-blue-700 shadow-sm dark:bg-white/[0.08] dark:text-blue-300' : 'text-slate-500 dark:text-slate-400'}`}>精简视图</button>
              <button type="button" onClick={() => { if (collapsePeriodic) { invalidateLogView(); setCollapsePeriodic(false); setPage(1) } }} aria-pressed={!collapsePeriodic} className={`min-h-8 whitespace-nowrap rounded-[6px] px-3 py-1.5 text-xs font-black transition ${!collapsePeriodic ? 'bg-white text-blue-700 shadow-sm dark:bg-white/[0.08] dark:text-blue-300' : 'text-slate-500 dark:text-slate-400'}`}>完整记录</button>
            </div>
            {activeFilterCount ? (
              <button type="button" onClick={clearFilters} className="inline-flex items-center gap-1.5 text-xs font-black text-slate-500 transition hover:text-blue-600 dark:text-slate-400">
                <RotateCcw size={14} />
                清空
              </button>
            ) : null}
          </div>
        </div>
        {collapsePeriodic && snapshotMatchesView && collapsedCount > 0 ? (
          <p className="mb-4 text-xs font-semibold text-slate-500 dark:text-slate-400">
            同类周期性自动采集告警已按故障原因分别合并为最新记录，共收起 {collapsedCount} 条重复记录；顶部统计和 CSV 仍按完整日志计算。
          </p>
        ) : null}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
          <div className="relative min-[980px]:col-span-2">
            <Search size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              aria-label="搜索操作日志"
              value={keyword}
              onChange={(event) => {
                invalidateLogView()
                setSearchSettled(false)
                setKeyword(event.target.value)
                setPage(1)
              }}
              placeholder="搜索标题、详情、用户、实体..."
              className="w-full rounded-[8px] border border-slate-200 bg-slate-50 py-2.5 pl-11 pr-4 text-sm text-slate-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-white dark:focus:border-blue-400 dark:focus:ring-blue-400/15"
            />
          </div>
          <UnifiedSelect
            ariaLabel="筛选日志操作类型"
            value={type}
            options={LOG_TYPES}
            onChange={(nextValue) => { invalidateLogView(); setType(nextValue); setPage(1) }}
          />
          <UnifiedSelect
            ariaLabel="筛选日志级别"
            value={level}
            options={LOG_LEVELS}
            onChange={(nextValue) => { invalidateLogView(); setLevel(nextValue); setPage(1) }}
          />
          <label className={`grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center rounded-[8px] border bg-slate-50 pl-3 transition focus-within:ring-2 dark:bg-white/[0.05] ${dateRangeInvalid ? 'border-red-300 focus-within:border-red-400 focus-within:ring-red-100 dark:border-red-400/40' : 'border-slate-200 focus-within:border-blue-400 focus-within:ring-blue-100 dark:border-white/[0.08] dark:focus-within:border-blue-400 dark:focus-within:ring-blue-400/15'}`}>
            <span className="pr-3 text-xs font-bold text-slate-500 dark:text-slate-400">开始</span>
            <input aria-label="开始时间" aria-invalid={dateRangeInvalid} title="开始时间" type="datetime-local" value={startTime} onChange={(event) => { invalidateLogView(); setStartTime(event.target.value); setPage(1) }} className="min-w-0 rounded-r-[7px] border-0 border-l border-slate-200 bg-transparent px-3 py-2.5 text-sm text-slate-700 outline-none dark:border-white/[0.08] dark:text-white" />
          </label>
          <label className={`grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center rounded-[8px] border bg-slate-50 pl-3 transition focus-within:ring-2 dark:bg-white/[0.05] ${dateRangeInvalid ? 'border-red-300 focus-within:border-red-400 focus-within:ring-red-100 dark:border-red-400/40' : 'border-slate-200 focus-within:border-blue-400 focus-within:ring-blue-100 dark:border-white/[0.08] dark:focus-within:border-blue-400 dark:focus-within:ring-blue-400/15'}`}>
            <span className="pr-3 text-xs font-bold text-slate-500 dark:text-slate-400">结束</span>
            <input aria-label="结束时间" aria-invalid={dateRangeInvalid} title="结束时间" type="datetime-local" value={endTime} onChange={(event) => { invalidateLogView(); setEndTime(event.target.value); setPage(1) }} className="min-w-0 rounded-r-[7px] border-0 border-l border-slate-200 bg-transparent px-3 py-2.5 text-sm text-slate-700 outline-none dark:border-white/[0.08] dark:text-white" />
          </label>
        </div>
        {dateRangeInvalid ? <p className="mt-3 text-xs font-bold text-red-600 dark:text-red-300" role="alert">开始时间不能晚于结束时间，请调整查询范围。</p> : null}
      </section>

      {error && hasLoaded ? (
        <section className="flex items-start gap-3 rounded-[8px] bg-amber-50 px-5 py-4 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300" role="alert">
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-black">日志加载失败</p>
            <p className="mt-1 text-sm leading-6">{error}</p>
            {hasLoaded ? (
              <p className="mt-1 text-xs font-semibold leading-5 text-amber-800/80 dark:text-amber-200/80">
                下方继续展示上一次成功读取的{logs.length ? '日志记录' : '空结果'}{snapshotMatchesView ? '' : '，其筛选条件或页码与当前视图不同'}。
              </p>
            ) : null}
          </div>
          <button type="button" onClick={() => void loadLogs(true)} disabled={refreshing || (Boolean(startTime && endTime && startTime > endTime))} className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-[6px] border border-amber-200 bg-white px-3 text-xs font-black text-amber-800 disabled:opacity-50 dark:border-amber-400/20 dark:bg-white/[0.06] dark:text-amber-200">
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            重试
          </button>
        </section>
      ) : null}

      {loading && hasLoaded ? (
        <div className="flex items-center gap-2 border-l-2 border-blue-500 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700 dark:bg-blue-500/10 dark:text-blue-300" role="status">
          <Loader2 size={14} className="animate-spin" />
          正在更新操作日志，当前暂时显示上一次成功{logs.length ? '记录' : '空结果'}{snapshotMatchesView ? '' : '；旧快照不代表当前筛选条件'}
        </div>
      ) : null}

      {hasLoaded && !snapshotMatchesView && !loading && !error ? (
        <div className="border-l-2 border-amber-500 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
          当前展示的是上一次成功快照，正在等待当前筛选条件的读取结果。
        </div>
      ) : null}

      <section className="min-w-0 overflow-hidden rounded-[8px] border border-slate-200 bg-white dark:border-white/[0.08] dark:bg-white/[0.03]">
        <div className="divide-y divide-slate-100 md:hidden dark:divide-white/[0.06]">
          {!hasLoaded && loading ? (
            <div className="px-6 py-14 text-center text-slate-400">
              <Loader2 className="mx-auto animate-spin" size={24} />
              <p className="mt-3 text-sm font-semibold">正在读取操作日志</p>
            </div>
          ) : !hasLoaded && error ? (
            <div className="px-6 py-14 text-center text-amber-700 dark:text-amber-300" role="alert">
              <AlertTriangle className="mx-auto mb-3" size={28} />
              <p className="text-sm font-black">操作日志未取得</p>
              <p className="mt-1 break-words text-xs leading-5">{error}</p>
              <p className="mt-1 text-xs text-amber-700/80 dark:text-amber-200/80">当前没有可展示的成功快照。</p>
              <button type="button" onClick={() => void loadLogs(true)} disabled={refreshing || dateRangeInvalid} className="mt-4 inline-flex h-9 items-center justify-center gap-1.5 rounded-[6px] border border-amber-200 bg-white px-3 text-xs font-black text-amber-800 disabled:cursor-not-allowed disabled:opacity-50 dark:border-amber-400/20 dark:bg-white/[0.06] dark:text-amber-200">
                <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
                {refreshing ? '正在重新读取' : '重新读取日志'}
              </button>
            </div>
          ) : logs.length ? logs.map((log) => (
            <article
              key={log.id}
              tabIndex={snapshotMatchesView ? 0 : undefined}
              aria-label={snapshotMatchesView ? `查看日志详情：${displayLogTitle(log)}` : undefined}
              onClick={snapshotMatchesView ? (event) => {
                if ((event.target as HTMLElement).closest('button, a, input, summary, [role="button"]')) return
                openLogDetail(log)
              } : undefined}
              onKeyDown={snapshotMatchesView ? (event) => {
                if (event.currentTarget !== event.target || (event.key !== 'Enter' && event.key !== ' ')) return
                event.preventDefault()
                openLogDetail(log)
              } : undefined}
              className={`px-4 py-4 transition ${snapshotMatchesView ? 'cursor-pointer hover:bg-slate-50 focus-visible:bg-blue-50/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-500 dark:hover:bg-white/[0.03]' : 'opacity-75'}`}
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className={`no-vertical-text inline-flex min-w-[44px] justify-center rounded-[6px] px-2 py-1 text-xs font-bold ${levelClass(log.level)}`} title={LOG_LEVELS.some((item) => item.value === log.level) ? levelLabel(log.level) : `未识别等级：${log.level || '空值'}`}>{levelLabel(log.level)}</span>
                <span className="text-xs font-bold text-slate-600 dark:text-slate-300">{typeLabel(log.type)}</span>
                <time className="ml-auto text-xs font-semibold tabular-nums text-slate-500 dark:text-slate-400">{formatDateTime(log.created_at)}</time>
              </div>
              <div className="mt-3 flex min-w-0 items-start gap-2">
                <h3 className="min-w-0 flex-1 break-words text-sm font-black leading-6 text-slate-900 [overflow-wrap:anywhere] dark:text-white">{displayLogTitle(log)}</h3>
                {(log.repeat_count || 1) > 1 ? <span className="shrink-0 rounded-[6px] bg-amber-50 px-2 py-1 text-[11px] font-black text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">累计 {log.repeat_count} 次</span> : null}
              </div>
              <p className="mt-1 line-clamp-2 break-words text-sm leading-6 text-slate-500 [overflow-wrap:anywhere] dark:text-slate-400" title={detailSummary(log)}>{detailSummary(log)}</p>
              <div className="mt-3 flex items-center justify-between gap-3 border-t border-slate-100 pt-3 dark:border-white/[0.06]">
                <span className="min-w-0 truncate text-xs font-semibold text-slate-500 dark:text-slate-400" title={displayOperator(log.username)}>操作人：{displayOperator(log.username)}</span>
                <button type="button" onClick={(event) => { event.stopPropagation(); openLogDetail(log) }} disabled={!snapshotMatchesView} title={snapshotMatchesView ? '查看日志详情' : '当前行属于上一次成功快照，请等待当前筛选完成'} className="inline-flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-[6px] bg-blue-50 px-3 text-xs font-black text-blue-600 disabled:cursor-not-allowed disabled:opacity-45 dark:bg-blue-500/10 dark:text-blue-300">
                  <Eye size={14} />详情
                </button>
              </div>
            </article>
          )) : (
            <div className="px-6 py-14 text-center">
              <Info className="mx-auto mb-3 text-slate-300" size={28} />
              <p className="text-sm font-black text-slate-700 dark:text-slate-200">{snapshotMatchesView ? '暂无匹配日志' : '上次成功快照中没有日志'}</p>
              <p className="mt-1 text-xs leading-5 text-slate-400">{snapshotMatchesView ? '调整筛选条件或完成一次业务操作后再查看。' : '该空结果不代表当前筛选条件，请重新读取。'}</p>
            </div>
          )}
        </div>
        <div className="hidden max-w-full overflow-x-auto md:block" tabIndex={0} role="region" aria-label="操作日志列表，可横向滚动">
          <table className="w-full min-w-[900px] table-auto text-left [&_td]:align-middle [&_th]:whitespace-nowrap">
            <thead>
              <tr className="bg-slate-50/80 dark:bg-white/[0.04]">
                <th className="w-[150px] px-4 py-4 text-xs font-bold text-slate-500 dark:text-slate-400">时间</th>
                <th className="w-[82px] px-4 py-4 text-xs font-bold text-slate-500 dark:text-slate-400">等级</th>
                <th className="w-[116px] px-4 py-4 text-xs font-bold text-slate-500 dark:text-slate-400">类型</th>
                <th className="w-[230px] px-4 py-4 text-xs font-bold text-slate-500 dark:text-slate-400">标题</th>
                <th className="px-4 py-4 text-xs font-bold text-slate-500 dark:text-slate-400">摘要</th>
                <th className="w-[110px] px-4 py-4 text-xs font-bold text-slate-500 dark:text-slate-400">操作人</th>
                <th className="w-[92px] px-4 py-4 text-right text-xs font-bold text-slate-500 dark:text-slate-400">操作</th>
              </tr>
            </thead>
            <tbody>
              {!hasLoaded && loading ? (
                <tr>
                  <td colSpan={7} className="px-6 py-16 text-center text-slate-400">
                    <Loader2 className="mx-auto animate-spin" size={24} />
                    <p className="mt-3 text-sm font-semibold">正在读取操作日志</p>
                  </td>
                </tr>
              ) : !hasLoaded && error ? (
                <tr>
                  <td colSpan={7} className="px-6 py-16 text-center text-amber-700 dark:text-amber-300">
                    <div className="mx-auto flex max-w-xl flex-col items-center" role="alert">
                      <AlertTriangle className="mb-3" size={28} />
                      <p className="text-sm font-black">操作日志未取得</p>
                      <p className="mt-1 max-w-full break-words text-xs leading-5">{error}</p>
                      <p className="mt-1 text-xs text-amber-700/80 dark:text-amber-200/80">当前没有可展示的成功快照。</p>
                      <button
                        type="button"
                        onClick={() => void loadLogs(true)}
                        disabled={refreshing || dateRangeInvalid}
                        className="mt-4 inline-flex h-9 items-center justify-center gap-1.5 rounded-[6px] border border-amber-200 bg-white px-3 text-xs font-black text-amber-800 disabled:cursor-not-allowed disabled:opacity-50 dark:border-amber-400/20 dark:bg-white/[0.06] dark:text-amber-200"
                      >
                        <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
                        {refreshing ? '正在重新读取' : '重新读取日志'}
                      </button>
                    </div>
                  </td>
                </tr>
              ) : logs.length ? logs.map((log) => (
                <tr
                  key={log.id}
                  tabIndex={snapshotMatchesView ? 0 : undefined}
                  aria-label={snapshotMatchesView ? `查看日志详情：${displayLogTitle(log)}` : undefined}
                  onClick={snapshotMatchesView ? (event) => {
                    const target = event.target as HTMLElement
                    if (target.closest('a, button, input, select, textarea, summary, [role="button"], [role="link"]')) return
                    openLogDetail(log)
                  } : undefined}
                  onKeyDown={snapshotMatchesView ? (event) => {
                    if (event.currentTarget !== event.target || (event.key !== 'Enter' && event.key !== ' ')) return
                    event.preventDefault()
                    openLogDetail(log)
                  } : undefined}
                  className={`border-t border-slate-100 transition dark:border-white/[0.06] ${snapshotMatchesView ? 'cursor-pointer hover:bg-slate-50 focus-visible:bg-blue-50/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-500 dark:hover:bg-white/[0.03] dark:focus-visible:bg-blue-500/10' : ''}`}
                >
                  <td className="whitespace-nowrap px-4 py-4 text-sm font-semibold text-slate-600 dark:text-slate-300">{formatDateTime(log.created_at)}</td>
                  <td className="px-4 py-4">
                    <span
                      className={`no-vertical-text inline-flex min-w-[44px] justify-center rounded-[6px] px-2.5 py-1 text-xs font-bold ${levelClass(log.level)}`}
                      title={LOG_LEVELS.some((item) => item.value === log.level) ? levelLabel(log.level) : `未识别等级：${log.level || '空值'}`}
                    >
                      {levelLabel(log.level)}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-4 text-sm font-bold text-slate-600 dark:text-slate-300">{typeLabel(log.type)}</td>
                  <td className="px-4 py-4 text-sm font-black text-slate-900 dark:text-white">
                    <div className="flex min-w-0 items-center gap-2">
                      <p className="line-clamp-2 min-w-0 break-words leading-6" title={displayLogTitle(log)}>{displayLogTitle(log)}</p>
                      {(log.repeat_count || 1) > 1 ? <span className="shrink-0 rounded-[6px] bg-amber-50 px-2 py-1 text-xs font-black text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">累计 {log.repeat_count} 次</span> : null}
                    </div>
                  </td>
                  <td className="px-4 py-4 text-sm leading-6 text-slate-500 dark:text-slate-400">
                    <p className="line-clamp-2 break-words" title={detailSummary(log)}>{detailSummary(log)}</p>
                  </td>
                  <td className="truncate whitespace-nowrap px-4 py-4 text-sm text-slate-500 dark:text-slate-400" title={displayOperator(log.username)}>{displayOperator(log.username)}</td>
                  <td className="px-4 py-4 text-right">
                    <button
                      onClick={() => openLogDetail(log)}
                      disabled={!snapshotMatchesView}
                      title={snapshotMatchesView ? '查看日志详情' : '当前行属于上一次成功快照，请等待当前筛选完成'}
                      className="no-vertical-text inline-flex min-h-9 min-w-[68px] items-center justify-center gap-2 rounded-[8px] bg-blue-50 px-3 py-2 text-xs font-black text-blue-600 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-45 dark:bg-blue-500/10 dark:text-blue-300"
                    >
                      <Eye size={14} className="shrink-0" />
                      <span>详情</span>
                    </button>
                  </td>
                </tr>
              )) : (
                <tr>
                  <td colSpan={7} className="px-6 py-16 text-center">
                    <Info className="mx-auto mb-3 text-slate-300" size={28} />
                    <p className="text-sm font-black text-slate-700 dark:text-slate-200">{snapshotMatchesView ? '暂无匹配日志' : '上次成功快照中没有日志'}</p>
                    <p className="mt-1 text-xs text-slate-400">{snapshotMatchesView ? '调整筛选条件或完成一次业务操作后再查看。' : '该空结果不代表当前筛选条件，请重新读取。'}</p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {hasLoaded ? (
          <Pagination
            page={loadedPage}
            pageSize={loadedSize}
            total={total}
            loading={loading && snapshotMatchesView}
            navigationDisabled={!snapshotMatchesView}
            pageSizeOptions={[10, 20, 50, 100]}
            onPageChange={(nextPage) => { invalidateLogView(); setPage(nextPage) }}
            onPageSizeChange={(nextSize) => { invalidateLogView(); setSize(nextSize); setPage(1) }}
            itemName={collapsePeriodic ? '条可见记录' : '条日志'}
          />
        ) : null}
      </section>

      <AppDrawer open={Boolean(selected)} title={selected ? displayLogTitle(selected) : '日志详情'} description="业务信息优先展示，原始字段收纳在技术信息中。" onClose={() => setSelected(null)}>
        {selected ? (
          <div>
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                ['等级', levelLabel(selected.level)],
                ['类型', typeLabel(selected.type)],
                ['用户', displayOperator(selected.username)],
                ['创建时间', formatDateTime(selected.created_at)],
                ...((selected.repeat_count || 1) > 1 ? [['合并次数', `累计 ${selected.repeat_count} 次`]] : []),
              ].map(([label, value]) => (
                <div key={label} className="border-l-2 border-slate-200 px-4 py-2 dark:border-white/[0.12]">
                  <p className="text-xs font-bold text-slate-500 dark:text-slate-400">{label}</p>
                  <p className="mt-2 break-words text-sm font-bold text-slate-900 dark:text-white">{value}</p>
                </div>
              ))}
            </div>
            <div className="mt-5 rounded-[8px] bg-slate-50 p-5 dark:bg-white/[0.04]">
              <p className="text-xs font-bold text-slate-500 dark:text-slate-400">{selected.level === 'error' || selected.level === 'warning' ? '诊断说明' : '业务摘要'}</p>
              <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-7 text-slate-700 dark:text-slate-300">{detailSummary(selected)}</p>
            </div>
            <details className="mt-5 rounded-[8px] border border-slate-200 bg-white px-4 py-3 dark:border-white/[0.08] dark:bg-white/[0.02]">
              <summary className="cursor-pointer text-sm font-bold text-slate-600 dark:text-slate-300">查看技术信息</summary>
              <div className="mt-4 space-y-3">
                <TechnicalId label="日志 ID" value={String(selected.id)} />
                <TechnicalId label="关联对象" value={selected.entity_id} />
                <TechnicalId label="原始等级" value={selected.level} />
                <TechnicalId label="原始类型" value={selected.type} />
                <div className="rounded-[8px] bg-slate-50 p-4 dark:bg-white/[0.04]">
                  <p className="text-xs font-bold text-slate-500 dark:text-slate-400">原始详情</p>
                  <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-all font-mono text-xs leading-6 text-slate-600 dark:text-slate-300">{fullDetail(selected.detail)}</pre>
                </div>
              </div>
            </details>
          </div>
        ) : null}
      </AppDrawer>

      <AppDialog
        open={maintenanceOpen}
        title="操作日志维护"
        description="防止长期运行时日志无限增长；清理只影响超过保留期的历史审计记录。"
        onClose={closeMaintenance}
        maxWidth="max-w-xl"
        danger
        closeOnOverlay={!cleaning}
        initialFocusRef={cleanupConfirmationRef}
        footer={(
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" onClick={closeMaintenance} className="h-10 rounded-[8px] border border-slate-200 px-4 text-sm font-black text-slate-600 dark:border-white/[0.08] dark:text-slate-300">关闭</button>
            <button
              type="button"
              onClick={() => cleaning ? cancelCleanupWaiting() : void handleCleanup()}
              disabled={!cleaning && (!retentionPreview?.deletable || cleanupConfirmation.trim() !== '清理过期日志')}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-[8px] bg-rose-600 px-4 text-sm font-black text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {cleaning ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
              {cleaning ? '取消等待' : '清理过期日志'}
            </button>
          </div>
        )}
      >
        <div className="space-y-5">
          <div className="border-l-2 border-amber-400 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
            普通日志保留 90 天，错误日志保留 365 天。后端每日自动执行同一策略，近期操作和关键故障证据不会被删除。
          </div>

          {retentionLoading && !retentionPreview ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm font-semibold text-slate-400"><Loader2 size={17} className="animate-spin" />正在计算可清理范围</div>
          ) : retentionPreview ? (
            <dl className="overflow-hidden rounded-[8px] border border-slate-200 divide-y divide-slate-100 text-sm dark:divide-white/[0.08] dark:border-white/[0.08]">
              {[
                ['当前日志', `${retentionPreview.total} 条`],
                ['预计删除', `${retentionPreview.deletable} 条`],
                ['清理后保留', `${retentionPreview.retained} 条`],
                ['最早保留记录', formatDateTime(retentionPreview.oldest_at)],
                ['普通日志截止', formatDateTime(retentionPreview.normal_cutoff)],
                ['错误日志截止', formatDateTime(retentionPreview.error_cutoff)],
              ].map(([label, value]) => (
                <div key={label} className="flex items-center justify-between gap-4 px-4 py-3">
                  <dt className="font-semibold text-slate-500 dark:text-slate-400">{label}</dt>
                  <dd className="text-right font-black text-slate-900 dark:text-white">{value}</dd>
                </div>
              ))}
            </dl>
          ) : null}

          {retentionError ? (
            <div className="flex flex-col gap-3 rounded-[8px] bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700 dark:bg-rose-500/10 dark:text-rose-300 sm:flex-row sm:items-center sm:justify-between">
              <span>{retentionError}</span>
              <button
                type="button"
                onClick={() => void loadRetentionPreview()}
                disabled={retentionLoading}
                className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-[8px] border border-rose-200 bg-white px-3 text-xs font-black text-rose-700 transition hover:bg-rose-100 disabled:cursor-wait disabled:opacity-60 dark:border-rose-400/20 dark:bg-white/[0.04] dark:text-rose-200 dark:hover:bg-white/[0.08]"
              >
                <RefreshCw size={14} className={retentionLoading ? 'animate-spin' : ''} />
                {retentionLoading ? '正在计算' : '重新计算'}
              </button>
            </div>
          ) : null}

          {retentionPreview && retentionPreview.deletable === 0 ? (
            <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">当前没有超过各自保留期的日志，无需手动清理。错误记录保留时间更长，因此最早保留记录可能早于普通日志截止时间。</p>
          ) : retentionPreview?.deletable ? (
            <div>
              <label htmlFor="operation-log-cleanup-confirmation" className="block text-xs font-black text-slate-500 dark:text-slate-400">
                输入“清理过期日志”确认
              </label>
              <input
                ref={cleanupConfirmationRef}
                id="operation-log-cleanup-confirmation"
                value={cleanupConfirmation}
                onChange={(event) => setCleanupConfirmation(event.target.value)}
                disabled={cleaning}
                autoComplete="off"
                className="mt-2 h-11 w-full rounded-[8px] border border-slate-200 px-4 text-sm font-semibold text-slate-900 outline-none focus:border-rose-300 focus:ring-2 focus:ring-rose-100 disabled:opacity-60 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-white"
              />
            </div>
          ) : null}
        </div>
      </AppDialog>
    </div>
  )
}

export default function ActivityLogsPage() {
  return (
    <Suspense fallback={<div className="flex min-h-[50vh] items-center justify-center text-sm font-bold text-slate-400">正在读取操作日志...</div>}>
      <ActivityLogsContent />
    </Suspense>
  )
}
