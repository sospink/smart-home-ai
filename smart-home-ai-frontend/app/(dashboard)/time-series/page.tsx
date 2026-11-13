'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import {
  Activity,
  AlertTriangle,
  Clock,
  ChevronLeft,
  ChevronRight,
  Database,
  Download,
  Eye,
  FileJson,
  History,
  Loader2,
  RefreshCw,
  Search,
  Server,
  TableProperties,
  Trash2,
  X,
  Zap,
} from 'lucide-react'
import {
  exportTimeSeries,
  cleanupTimeSeriesCollectorHistory,
  fetchTimeSeriesEntities,
  fetchTimeSeriesHistory,
  fetchTimeSeriesOverview,
  fetchTimeSeriesQuery,
  syncTimeSeries,
  type TimeSeriesEntity,
  type TimeSeriesHistoryItem,
  type TimeSeriesOverview,
  type TimeSeriesPoint,
  type TimeSeriesQueryParams,
  type TimeSeriesQueryResponse,
  type TimeSeriesWindow,
} from '@/lib/api/time-series'
import { toast } from '@/components/ui/toast'
import { UnifiedSelect } from '@/components/ui/UnifiedSelect'
import { AppDialog } from '@/components/ui/AppDialog'
import { AppDrawer } from '@/components/ui/AppDrawer'
import { Pagination } from '@/components/ui/Pagination'
import { TechnicalId } from '@/components/ui/TechnicalId'
import { useAuth } from '@/lib/hooks/useAuth'
import { businessErrorMessage } from '@/lib/ui/business-error'
import { ApiError } from '@/lib/api/client'

type IconComponent = ComponentType<{ size?: number; className?: string }>

const HOUR_OPTIONS = [
  { label: '6 小时', value: 6 },
  { label: '24 小时', value: 24 },
  { label: '72 小时', value: 72 },
  { label: '7 天', value: 168 },
]

const WINDOW_OPTIONS = [
  { label: '原始', value: 'raw' },
  { label: '5 分钟', value: '5m' },
  { label: '15 分钟', value: '15m' },
  { label: '1 小时', value: '1h' },
]

function optionLabel<T extends string | number>(options: Array<{ label: string; value: T }>, value: T) {
  return options.find((item) => item.value === value)?.label || String(value)
}

const CATEGORY_LABELS: Record<string, string> = {
  light: '灯光',
  switch: '开关',
  sensor: '传感器',
  binary_sensor: '状态传感器',
  climate: '空调',
  lock: '门锁',
  cover: '窗帘',
  fan: '风扇',
  number: '数值设备',
  select: '模式设备',
}

const ROLE_LABELS: Record<string, string> = {
  power: '电源',
  temperature: '温度',
  humidity: '湿度',
  brightness: '亮度',
  status: '状态',
  value: '数值',
  mode: '模式',
  lock: '门锁',
  position: '位置',
  climate: '空调控制',
}

const SOURCE_LABELS: Record<string, string> = {
  collector: '自动采集',
  manual: '手动同步',
  influxdb: '时序数据库',
}

const STATE_LABELS: Record<string, string> = {
  on: '开启',
  off: '关闭',
  open: '打开',
  closed: '关闭',
  locked: '已锁定',
  unlocked: '未锁定',
  home: '在家',
  not_home: '离家',
  unavailable: '不可用',
  unknown: '未知',
}

const LINE_COLORS = ['#2563eb', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#0f172a']

function formatDateTime(value?: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未取得'
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function latestTimestamp(...values: Array<string | null | undefined>) {
  return values.reduce<string | null>((latest, value) => {
    if (!value) return latest
    const timestamp = new Date(value).getTime()
    if (!Number.isFinite(timestamp)) return latest
    if (!latest || timestamp > new Date(latest).getTime()) return value
    return latest
  }, null)
}

function labelCategory(value?: string | null) {
  return value ? CATEGORY_LABELS[value] || '其他设备类型' : '设备类型未提供'
}

function labelRole(value?: string | null) {
  if (!value) return '设备属性'
  if (ROLE_LABELS[value]) return ROLE_LABELS[value]
  const base = value.replace(/_(light|switch|sensor)(?:_\d+)?$/, '')
  return ROLE_LABELS[base] || '其他设备属性'
}

function timeSeriesDeviceName(deviceName?: string | null, category?: string | null, role?: string | null) {
  const name = String(deviceName || '').trim()
  const looksLikeEntityId = /^[a-z0-9_]+\.[a-z0-9_]+$/i.test(name)
  if (name && !looksLikeEntityId) return name
  const categoryLabel = labelCategory(category)
  const roleLabel = labelRole(role)
  const fallback = categoryLabel === '设备类型未提供' || categoryLabel === '其他设备类型'
    ? '未命名设备'
    : `未命名${categoryLabel}`
  return roleLabel === '设备属性' || roleLabel === '其他设备属性' ? fallback : `${fallback} · ${roleLabel}`
}

function technicalLabelTitle(label: string, rawValue?: string | null, known = true) {
  const value = String(rawValue || '').trim()
  return !value || known ? label : `${label}（原始值：${value}）`
}

function sourceLabel(value?: string | null) {
  const source = String(value || '').trim()
  return source ? SOURCE_LABELS[source] || '其他采集来源' : '采集来源未提供'
}

function labelState(value?: string | null) {
  const text = String(value || '').trim()
  if (!text) return '暂无'
  if (STATE_LABELS[text.toLowerCase()]) return STATE_LABELS[text.toLowerCase()]
  if (/^-?\d+(?:\.\d+)?$/.test(text) || /[\u4e00-\u9fff]/.test(text)) return text
  return '状态待确认'
}

function formatPointValue(point: TimeSeriesPoint) {
  if (point.field === 'state_raw') return labelState(String(point.value))
  if (point.field === 'unit') return String(point.value || '无单位')
  if (point.state_raw && STATE_LABELS[point.state_raw.toLowerCase()]) {
    return labelState(point.state_raw)
  }
  const value = typeof point.value === 'number'
    ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(point.value)
    : String(point.value ?? '暂无')
  return `${value}${point.unit ? ` ${point.unit}` : ''}`
}

function timeSeriesErrorMessage(value: unknown) {
  const message = value instanceof Error ? value.message : String(value || '')
  const normalized = message.toLowerCase()
  if (normalized.includes('server disconnected') || normalized.includes('connection reset')) {
    return 'InfluxDB 连接已断开，请检查服务状态和网络链路'
  }
  if (normalized.includes('timeout') || normalized.includes('timed out') || normalized.includes('请求超时')) {
    return 'InfluxDB 请求超时，请检查服务状态和网络链路'
  }
  if (
    normalized.includes('connection refused')
    || normalized.includes('all connection attempts failed')
    || normalized.includes('cannot connect to host')
    || normalized.includes('host is down')
    || normalized.includes('network is unreachable')
    || normalized.includes('no route to host')
  ) {
    return '无法连接 InfluxDB，请确认服务已启动且地址可达'
  }
  return businessErrorMessage(value, { fallback: 'InfluxDB 请求失败', service: 'InfluxDB' })
}

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

function historyLevelLabel(level: string) {
  if (level === 'success') return '成功'
  if (level === 'error') return '失败'
  if (level === 'warning') return '警告'
  if (level === 'info') return '信息'
  return '其他等级'
}

function historyDetail(item: TimeSeriesHistoryItem) {
  const detail = item.detail || ''
  const fields = Object.fromEntries(detail.split(/[,，;；]/).map((part) => {
    const [key, ...rest] = part.trim().split('=')
    return [key, rest.join('=').trim()]
  }).filter(([key]) => key))
  if (fields.error) {
    const retry = Number(fields.next_retry_seconds || 0)
    const failures = Number(fields.consecutive_failures || 0)
    return [
      timeSeriesErrorMessage(fields.error),
      failures > 0 ? `已连续失败 ${failures} 次` : '',
      retry > 0 ? `${retry} 秒后重试` : '',
    ].filter(Boolean).join('；')
  }
  if (fields.written !== undefined) return `写入 ${fields.written || 0} 条时序点，涉及 ${fields.entity_count || 0} 个实体。`
  if (fields.deleted !== undefined) return `已清理 ${fields.deleted || 0} 条自动采集日志，最近失败证据继续保留。`
  const cleaned = detail
    .replace(/(?:^|[,，;；]\s*)signature=[^,，;；]+/gi, '')
    .replace(/server disconnected/gi, '连接已断开')
    .replace(/connection reset/gi, '连接被重置')
    .replace(/^,\s*|,\s*$/g, '')
  return cleaned || '无补充说明'
}

function timeSeriesQueryViewKey(params: TimeSeriesQueryParams) {
  return JSON.stringify({
    entity_id: params.entity_id || '',
    category: params.category || '',
    keyword: (params.keyword || '').trim(),
    hours: params.hours || 24,
    window: params.window || '5m',
    page: params.page || 1,
    size: params.size || 20,
  })
}

function timeSeriesHistoryViewKey(scope: string, level: string, keyword: string, page: number, size: number) {
  return JSON.stringify({ scope, level, keyword: keyword.trim(), page, size })
}

function buildSeries(points: TimeSeriesPoint[]) {
  const grouped = new Map<string, TimeSeriesPoint[]>()
  points
    .filter((point) => typeof point.value === 'number' && Number.isFinite(new Date(point.time).getTime()))
    .forEach((point) => {
      const key = point.entity_id
      grouped.set(key, [...(grouped.get(key) || []), point])
    })
  const visibleSeries = Array.from(grouped.entries()).map(([entityId, rows], index) => {
    const sortedRows = [...rows].sort((left, right) => new Date(left.time).getTime() - new Date(right.time).getTime())
    const values = sortedRows.map((point) => Number(point.value)).filter(Number.isFinite)
    const role = sortedRows[0]?.role || ''
    const category = sortedRows[0]?.category || ''
    const binaryPower = values.length > 0
      && values.every((value) => value === 0 || value === 1)
      && role === 'power'
      && ['light', 'switch'].includes(category)
    return {
      entityId,
      name: timeSeriesDeviceName(sortedRows[0]?.device_name, category, role),
      unit: sortedRows[0]?.unit || '',
      scaleKey: binaryPower ? 'binary-power' : sortedRows[0]?.unit || 'unitless',
      displayUnit: binaryPower ? '开关状态' : sortedRows[0]?.unit || '无单位',
      rangeLabel: binaryPower ? '关闭–开启' : '',
      color: LINE_COLORS[index % LINE_COLORS.length],
      rows: sortedRows,
      minimum: Math.min(...values),
      maximum: Math.max(...values),
    }
  })
  const rangesByUnit = new Map<string, { minimum: number; maximum: number }>()
  visibleSeries.forEach((item) => {
    const unitKey = item.scaleKey
    const current = rangesByUnit.get(unitKey)
    rangesByUnit.set(unitKey, {
      minimum: current ? Math.min(current.minimum, item.minimum) : item.minimum,
      maximum: current ? Math.max(current.maximum, item.maximum) : item.maximum,
    })
  })
  return visibleSeries.map((item) => ({
    ...item,
    scaleMinimum: rangesByUnit.get(item.scaleKey)?.minimum ?? item.minimum,
    scaleMaximum: rangesByUnit.get(item.scaleKey)?.maximum ?? item.maximum,
  }))
}

function TrendChart({
  points,
  loading = false,
  entityTotal = 0,
  entitiesTruncated = false,
}: {
  points: TimeSeriesPoint[]
  loading?: boolean
  entityTotal?: number
  entitiesTruncated?: boolean
}) {
  const allSeries = useMemo(() => buildSeries(points), [points])
  const [entityPage, setEntityPage] = useState(1)
  const entityPageSize = 6
  const entityPageCount = Math.max(1, Math.ceil(allSeries.length / entityPageSize))
  const safeEntityPage = Math.min(entityPage, entityPageCount)
  const series = allSeries.slice((safeEntityPage - 1) * entityPageSize, safeEntityPage * entityPageSize)
  const visibleStart = allSeries.length ? (safeEntityPage - 1) * entityPageSize + 1 : 0
  const visibleEnd = Math.min(safeEntityPage * entityPageSize, allSeries.length)
  const numeric = points.filter((point) => typeof point.value === 'number' && Number.isFinite(new Date(point.time).getTime()))
  const width = 1000
  const height = 260
  const padding = 28

  if (!numeric.length) {
    return (
      <div className="flex h-72 items-center justify-center rounded-md bg-slate-50 text-sm font-semibold text-slate-400">
        {loading ? '正在读取趋势数据' : '暂无可绘制的数值数据'}
      </div>
    )
  }

  const times = numeric.map((point) => new Date(point.time).getTime()).filter(Number.isFinite)
  const minTime = Math.min(...times)
  const maxTime = Math.max(...times)
  const timeSpan = Math.max(maxTime - minTime, 1)
  const timeTicks = [0, 0.5, 1].map((ratio) => ({
    ratio,
    timestamp: minTime + timeSpan * ratio,
  }))
  const xForTime = (time: string) => minTime === maxTime
    ? width / 2
    : padding + ((new Date(time).getTime() - minTime) / timeSpan) * (width - padding * 2)

  const pathFor = (rows: TimeSeriesPoint[], minimum: number, maximum: number) => {
    const valueSpan = Math.max(maximum - minimum, 1)
    return rows
    .filter((point) => typeof point.value === 'number')
    .map((point, index) => {
      const x = xForTime(point.time)
      const y = maximum === minimum
        ? height / 2
        : height - padding - ((Number(point.value) - minimum) / valueSpan) * (height - padding * 2)
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`
    })
    .join(' ')
  }
  const yForValue = (value: number, minimum: number, maximum: number) => {
    if (maximum === minimum) return height / 2
    return height - padding - ((value - minimum) / Math.max(maximum - minimum, 1)) * (height - padding * 2)
  }

  const formatRangeValue = (value: number) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value)

  return (
    <div className="rounded-[8px] border border-slate-100 bg-white p-5 shadow-sm shadow-slate-200/60">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-black text-slate-900">趋势曲线</h2>
          <p className="mt-1 text-sm leading-6 text-slate-500">每页展示 6 个实体；同单位共享值域，可比较绝对高低。不同单位仅比较变化趋势，原始值以图例和表格为准。</p>
        </div>
        <div className="flex flex-wrap gap-3">
          {series.map((item) => (
            <span
              key={item.entityId}
              className="inline-flex min-w-0 items-center gap-2 rounded-[6px] bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-600"
              title={`${item.name}：${item.rangeLabel || `${formatRangeValue(item.minimum)}–${formatRangeValue(item.maximum)}${item.unit || ''}`}`}
            >
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
              <span className="break-words">{item.name} · {item.displayUnit} · {item.rangeLabel || `${formatRangeValue(item.minimum)}–${formatRangeValue(item.maximum)}`}</span>
            </span>
          ))}
        </div>
      </div>
      {allSeries.length > entityPageSize || entitiesTruncated ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-y border-slate-100 py-2.5 text-xs font-semibold text-slate-500">
          <span>
            当前展示第 {visibleStart}-{visibleEnd} 个，共 {allSeries.length} 个可绘制实体
            {entitiesTruncated ? `；查询共 ${entityTotal} 个实体，图表采样预算未覆盖全部实体` : ''}
          </span>
          {entityPageCount > 1 ? <div className="flex items-center gap-1" aria-label="趋势实体分页">
            <button type="button" onClick={() => setEntityPage(Math.max(1, safeEntityPage - 1))} disabled={safeEntityPage <= 1} title="上一组实体" aria-label="上一组实体" className="inline-flex h-8 w-8 items-center justify-center rounded-[6px] text-slate-500 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-30"><ChevronLeft size={15} /></button>
            <span className="min-w-14 text-center tabular-nums">{safeEntityPage} / {entityPageCount}</span>
            <button type="button" onClick={() => setEntityPage(Math.min(entityPageCount, safeEntityPage + 1))} disabled={safeEntityPage >= entityPageCount} title="下一组实体" aria-label="下一组实体" className="inline-flex h-8 w-8 items-center justify-center rounded-[6px] text-slate-500 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-30"><ChevronRight size={15} /></button>
          </div> : null}
        </div>
      ) : null}
      {loading ? (
        <div className="mb-3 flex items-center gap-2 border-l-2 border-blue-500 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700" role="status">
          <Loader2 size={14} className="animate-spin" />正在更新趋势，当前暂时显示上一次成功结果
        </div>
      ) : null}
      <div className="h-72 w-full overflow-hidden rounded-[8px] bg-slate-50">
        <svg viewBox={`0 0 ${width} ${height}`} className="h-full w-full" preserveAspectRatio="none">
          {[0.25, 0.5, 0.75].map((ratio) => (
            <line key={ratio} x1={padding} x2={width - padding} y1={height * ratio} y2={height * ratio} stroke="#e2e8f0" strokeWidth="1" strokeDasharray="6 8" />
          ))}
          {series.map((item) => item.rows.length === 1 ? (
            <circle
              key={item.entityId}
              cx={xForTime(item.rows[0].time)}
              cy={yForValue(Number(item.rows[0].value), item.scaleMinimum, item.scaleMaximum)}
              r="6"
              fill={item.color}
            />
          ) : (
            <path key={item.entityId} d={pathFor(item.rows, item.scaleMinimum, item.scaleMaximum)} fill="none" stroke={item.color} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          ))}
        </svg>
      </div>
      <div className="mt-2 grid grid-cols-3 text-xs font-semibold text-slate-400">
        {timeTicks.map((tick, index) => (
          <span key={tick.ratio} className={index === 1 ? 'text-center' : index === 2 ? 'text-right' : ''}>
            {formatDateTime(new Date(tick.timestamp).toISOString())}
          </span>
        ))}
      </div>
    </div>
  )
}

function StatCard({ icon: Icon, label, value, hint }: { icon: IconComponent; label: string; value: string; hint: string }) {
  return (
    <div className="relative min-w-0 rounded-[8px] border border-slate-100 bg-white p-4 shadow-sm shadow-slate-200/60 sm:p-5">
      <div className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-[8px] bg-blue-50 text-blue-600 sm:right-5 sm:top-5 sm:h-10 sm:w-10">
        <Icon size={19} />
      </div>
      <p className="pr-11 text-xs font-bold text-slate-400">{label}</p>
      <p className="mt-3 whitespace-nowrap text-xl font-black text-slate-900 sm:text-2xl" title={value}>{value}</p>
      <p className="mt-3 line-clamp-2 text-xs leading-5 text-slate-500" title={hint}>{hint}</p>
    </div>
  )
}

function TimeSeriesContent() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { isAdmin } = useAuth()
  const [overview, setOverview] = useState<TimeSeriesOverview | null>(null)
  const [entities, setEntities] = useState<TimeSeriesEntity[]>([])
  const [categoryOptions, setCategoryOptions] = useState<string[]>([])
  const [queryResult, setQueryResult] = useState<TimeSeriesQueryResponse | null>(null)
  const [queryLoaded, setQueryLoaded] = useState(false)
  const [loadedQueryViewKey, setLoadedQueryViewKey] = useState('')
  const [selected, setSelected] = useState<TimeSeriesPoint | null>(null)
  const [entityId, setEntityId] = useState(() => searchParams.get('entity') || '')
  const [category, setCategory] = useState(() => searchParams.get('category') || '')
  const [keywordInput, setKeywordInput] = useState(() => searchParams.get('q') || '')
  const [keyword, setKeyword] = useState(() => (searchParams.get('q') || '').trim())
  const [keywordSettled, setKeywordSettled] = useState(true)
  const [hours, setHours] = useState(() => {
    const value = Number(searchParams.get('hours') || 24)
    return HOUR_OPTIONS.some((option) => option.value === value) ? value : 24
  })
  const [windowSize, setWindowSize] = useState<TimeSeriesWindow>(() => {
    const value = searchParams.get('window') as TimeSeriesWindow
    return WINDOW_OPTIONS.some((option) => option.value === value) ? value : '5m'
  })
  const [page, setPage] = useState(() => {
    const value = Number(searchParams.get('page') || 1)
    return Number.isInteger(value) && value > 0 ? value : 1
  })
  const [pageSize, setPageSize] = useState(() => {
    const value = Number(searchParams.get('size') || 20)
    return [10, 20, 50, 100].includes(value) ? value : 20
  })
  const [loading, setLoading] = useState(true)
  const [querying, setQuerying] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [overviewError, setOverviewError] = useState('')
  const [entitiesError, setEntitiesError] = useState('')
  const [queryError, setQueryError] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyItems, setHistoryItems] = useState<TimeSeriesHistoryItem[]>([])
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [loadedHistoryViewKey, setLoadedHistoryViewKey] = useState('')
  const [loadedHistoryPage, setLoadedHistoryPage] = useState(1)
  const [loadedHistorySize, setLoadedHistorySize] = useState(20)
  const [historyTotal, setHistoryTotal] = useState(0)
  const [historyPage, setHistoryPage] = useState(1)
  const [historySize, setHistorySize] = useState(20)
  const [historyScope, setHistoryScope] = useState<'all' | 'manual' | 'collector'>('all')
  const [historyLevel, setHistoryLevel] = useState('')
  const [historyKeyword, setHistoryKeyword] = useState('')
  const [debouncedHistoryKeyword, setDebouncedHistoryKeyword] = useState('')
  const [historySearchSettled, setHistorySearchSettled] = useState(true)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [historyVisibility, setHistoryVisibility] = useState<'all' | 'self'>(isAdmin ? 'all' : 'self')
  const [cleanupOpen, setCleanupOpen] = useState(false)
  const [cleaning, setCleaning] = useState(false)
  const [exportingFormat, setExportingFormat] = useState<'' | 'json' | 'csv'>('')
  const [queryViewVersion, setQueryViewVersion] = useState(0)
  const [historyViewVersion, setHistoryViewVersion] = useState(0)
  const overviewRequestRef = useRef(0)
  const entitiesRequestRef = useRef(0)
  const queryRequestRef = useRef(0)
  const historyRequestRef = useRef(0)
  const exportRequestRef = useRef(0)
  const overviewAbortRef = useRef<AbortController | null>(null)
  const entitiesAbortRef = useRef<AbortController | null>(null)
  const queryAbortRef = useRef<AbortController | null>(null)
  const historyAbortRef = useRef<AbortController | null>(null)
  const exportAbortRef = useRef<AbortController | null>(null)
  const syncAbortRef = useRef<AbortController | null>(null)
  const cleanupAbortRef = useRef<AbortController | null>(null)
  const mutationReconcileRef = useRef(0)
  const mutationReconcileTimerRef = useRef<number | null>(null)
  const refreshLockRef = useRef(false)
  const recoveryInFlightRef = useRef(false)
  const syncLockRef = useRef(false)
  const cleanupLockRef = useRef(false)
  const exportLockRef = useRef(false)
  const cleanupCancelRef = useRef<HTMLButtonElement | null>(null)
  const initialBaseLoadedRef = useRef({ overview: false, entities: false })
  const writtenSearchRef = useRef(searchParams.toString())
  const applyingUrlStateRef = useRef(false)

  const queryParams = useMemo<TimeSeriesQueryParams>(() => ({
    entity_id: entityId,
    category,
    keyword,
    hours,
    window: windowSize,
    field: 'value_numeric' as const,
    page,
    size: pageSize,
  }), [entityId, category, keyword, hours, page, pageSize, windowSize])
  const exportScope = useMemo(() => JSON.stringify({
    entityId,
    category,
    keyword: keywordInput.trim(),
    hours,
    windowSize,
  }), [category, entityId, hours, keywordInput, windowSize])
  const currentQueryViewKey = timeSeriesQueryViewKey(queryParams)
  const querySnapshotMatchesView = Boolean(queryLoaded && keywordSettled && keywordInput.trim() === keyword && loadedQueryViewKey === currentQueryViewKey)
  const currentHistoryViewKey = timeSeriesHistoryViewKey(historyScope, historyLevel, debouncedHistoryKeyword, historyPage, historySize)
  const historySnapshotMatchesView = Boolean(historyLoaded && historySearchSettled && historyKeyword.trim() === debouncedHistoryKeyword && loadedHistoryViewKey === currentHistoryViewKey)
  const influxUnavailable = Boolean(overview && overview.status !== 'running')

  useEffect(() => {
    if (pathname !== '/time-series') return
    const incomingSearch = searchParams.toString()
    if (incomingSearch === writtenSearchRef.current) return
    writtenSearchRef.current = incomingSearch
    applyingUrlStateRef.current = true
    const nextKeyword = searchParams.get('q') || ''
    const requestedHours = Number(searchParams.get('hours') || 24)
    const requestedWindow = searchParams.get('window') as TimeSeriesWindow
    const requestedPage = Number(searchParams.get('page') || 1)
    const requestedSize = Number(searchParams.get('size') || 20)
    queryRequestRef.current += 1
    queryAbortRef.current?.abort()
    queryAbortRef.current = null
    setSelected(null)
    setQueryError('')
    setQuerying(true)
    setEntityId(searchParams.get('entity') || '')
    setCategory(searchParams.get('category') || '')
    setKeywordInput(nextKeyword)
    setKeyword(nextKeyword.trim())
    setKeywordSettled(true)
    setHours(HOUR_OPTIONS.some((option) => option.value === requestedHours) ? requestedHours : 24)
    setWindowSize(WINDOW_OPTIONS.some((option) => option.value === requestedWindow) ? requestedWindow : '5m')
    setPage(Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1)
    setPageSize([10, 20, 50, 100].includes(requestedSize) ? requestedSize : 20)
    setQueryViewVersion((version) => version + 1)
  }, [pathname, searchParams])

  useEffect(() => {
    if (pathname !== '/time-series') return
    if (applyingUrlStateRef.current) {
      applyingUrlStateRef.current = false
      return
    }
    const query = new URLSearchParams()
    if (entityId) query.set('entity', entityId)
    if (category) query.set('category', category)
    if (keywordInput.trim()) query.set('q', keywordInput.trim())
    if (hours !== 24) query.set('hours', String(hours))
    if (windowSize !== '5m') query.set('window', windowSize)
    if (page !== 1) query.set('page', String(page))
    if (pageSize !== 20) query.set('size', String(pageSize))
    const nextSearch = query.toString()
    writtenSearchRef.current = nextSearch
    window.history.replaceState(window.history.state, '', `${pathname}${nextSearch ? `?${nextSearch}` : ''}`)
  }, [category, entityId, hours, keywordInput, page, pageSize, pathname, windowSize])

  const markInitialBaseLoaded = useCallback((section: 'overview' | 'entities') => {
    initialBaseLoadedRef.current[section] = true
    if (initialBaseLoadedRef.current.overview && initialBaseLoadedRef.current.entities) {
      setLoading(false)
    }
  }, [])

  const loadOverview = useCallback(async () => {
    const request = ++overviewRequestRef.current
    overviewAbortRef.current?.abort()
    const controller = new AbortController()
    overviewAbortRef.current = controller
    try {
      const value = await fetchTimeSeriesOverview(controller.signal)
      if (request !== overviewRequestRef.current) return null
      setOverview(value)
      setOverviewError('')
      return value
    } catch (loadError) {
      if (request !== overviewRequestRef.current) return null
      if (controller.signal.aborted) return null
      setOverviewError(timeSeriesErrorMessage(loadError))
      return null
    } finally {
      if (overviewAbortRef.current === controller) overviewAbortRef.current = null
      if (request === overviewRequestRef.current) markInitialBaseLoaded('overview')
    }
  }, [markInitialBaseLoaded])

  const loadEntities = useCallback(async () => {
    const request = ++entitiesRequestRef.current
    entitiesAbortRef.current?.abort()
    const controller = new AbortController()
    entitiesAbortRef.current = controller
    try {
      const value = await fetchTimeSeriesEntities({ category, keyword }, controller.signal)
      if (request !== entitiesRequestRef.current) return
      setEntities(value.entities)
      setCategoryOptions(Object.keys(value.categories))
      setEntitiesError('')
    } catch (loadError) {
      if (request !== entitiesRequestRef.current) return
      if (controller.signal.aborted) return
      setEntitiesError(timeSeriesErrorMessage(loadError))
    } finally {
      if (entitiesAbortRef.current === controller) entitiesAbortRef.current = null
      if (request === entitiesRequestRef.current) markInitialBaseLoaded('entities')
    }
  }, [category, keyword, markInitialBaseLoaded])

  const loadQuery = useCallback(async (force = false, overviewOverride?: TimeSeriesOverview | null) => {
    if (!keywordSettled || keywordInput.trim() !== keyword) return
    // 概览明确判定离线时避免重复失败；仅概览请求失败时仍让查询接口独立给出结果。
    const activeOverview = overviewOverride === undefined ? overview : overviewOverride
    if (!activeOverview && !overviewError) return
    if (activeOverview && activeOverview.status !== 'running') {
      queryRequestRef.current += 1
      queryAbortRef.current?.abort()
      queryAbortRef.current = null
      setSelected(null)
      setQueryError(timeSeriesErrorMessage(activeOverview.diagnostic || 'InfluxDB 当前不可用'))
      setQuerying(false)
      return
    }
    const request = ++queryRequestRef.current
    queryAbortRef.current?.abort()
    const controller = new AbortController()
    queryAbortRef.current = controller
    setQueryError('')
    setQuerying(true)
    try {
      const queryRes = await fetchTimeSeriesQuery({ ...queryParams, refresh: force || undefined }, controller.signal)
      if (request !== queryRequestRef.current) return
      setQueryResult(queryRes)
      setQueryLoaded(true)
      setLoadedQueryViewKey(timeSeriesQueryViewKey({ ...queryParams, page: queryRes.page, size: queryRes.size }))
      setPage((current) => current === queryRes.page ? current : queryRes.page)
    } catch (loadError) {
      if (request !== queryRequestRef.current) return
      if (controller.signal.aborted) return
      setQueryError(timeSeriesErrorMessage(loadError))
    } finally {
      if (queryAbortRef.current === controller) queryAbortRef.current = null
      if (request === queryRequestRef.current) {
        setQuerying(false)
      }
    }
  }, [keyword, keywordInput, keywordSettled, overview, overviewError, queryParams])

  useEffect(() => {
    void loadOverview()
  }, [loadOverview])

  useEffect(() => {
    void loadEntities()
  }, [loadEntities])

  useEffect(() => {
    void queryViewVersion
    void loadQuery()
  }, [loadQuery, queryViewVersion])

  useEffect(() => {
    exportRequestRef.current += 1
    exportAbortRef.current?.abort()
    exportAbortRef.current = null
    exportLockRef.current = false
    setExportingFormat('')
  }, [exportScope])

  useEffect(() => () => {
    overviewRequestRef.current += 1
    entitiesRequestRef.current += 1
    queryRequestRef.current += 1
    historyRequestRef.current += 1
    exportRequestRef.current += 1
    overviewAbortRef.current?.abort()
    entitiesAbortRef.current?.abort()
    queryAbortRef.current?.abort()
    historyAbortRef.current?.abort()
    exportAbortRef.current?.abort()
    syncAbortRef.current?.abort()
    cleanupAbortRef.current?.abort()
    mutationReconcileRef.current += 1
    if (mutationReconcileTimerRef.current !== null) window.clearTimeout(mutationReconcileTimerRef.current)
    refreshLockRef.current = false
    recoveryInFlightRef.current = false
    syncLockRef.current = false
    cleanupLockRef.current = false
    exportLockRef.current = false
  }, [])

  useEffect(() => {
    if (keywordSettled && keywordInput.trim() === keyword) return
    const timer = window.setTimeout(() => {
      setKeyword(keywordInput.trim())
      setKeywordSettled(true)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [keyword, keywordInput, keywordSettled])

  const loadHistory = useCallback(async (pageOverride?: number) => {
    if (!historyOpen || !historySearchSettled || historyKeyword.trim() !== debouncedHistoryKeyword) return
    const request = ++historyRequestRef.current
    historyAbortRef.current?.abort()
    const controller = new AbortController()
    historyAbortRef.current = controller
    try {
      setHistoryLoading(true)
      const result = await fetchTimeSeriesHistory({
        scope: historyScope,
        level: historyLevel,
        keyword: debouncedHistoryKeyword,
        page: pageOverride ?? historyPage,
        size: historySize,
      }, controller.signal)
      if (request !== historyRequestRef.current) return
      setHistoryItems(result.items)
      setHistoryTotal(result.total)
      setHistoryLoaded(true)
      setLoadedHistoryPage(result.page)
      setLoadedHistorySize(result.size)
      setLoadedHistoryViewKey(timeSeriesHistoryViewKey(historyScope, historyLevel, debouncedHistoryKeyword, result.page, result.size))
      if (result.page !== historyPage) setHistoryPage(result.page)
      setHistoryVisibility(result.visibility_scope || (isAdmin ? 'all' : 'self'))
      setHistoryError('')
    } catch (historyLoadError) {
      if (request !== historyRequestRef.current) return
      if (controller.signal.aborted) return
      setHistoryError(timeSeriesErrorMessage(historyLoadError))
    } finally {
      if (historyAbortRef.current === controller) historyAbortRef.current = null
      if (request === historyRequestRef.current) setHistoryLoading(false)
    }
  }, [debouncedHistoryKeyword, historyKeyword, historyLevel, historyOpen, historyPage, historyScope, historySearchSettled, historySize, isAdmin])

  useEffect(() => {
    if (!historyOpen) return
    if (historySearchSettled && historyKeyword.trim() === debouncedHistoryKeyword) return
    const timer = window.setTimeout(() => {
      setDebouncedHistoryKeyword(historyKeyword.trim())
      setHistorySearchSettled(true)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [debouncedHistoryKeyword, historyKeyword, historyOpen, historySearchSettled])

  useEffect(() => {
    void historyViewVersion
    void loadHistory()
  }, [historyViewVersion, loadHistory])

  useEffect(() => {
    if (!overviewError && !entitiesError && !queryError && (!historyOpen || !historyError)) return

    const retryFailedReads = async () => {
      if (!navigator.onLine || document.visibilityState !== 'visible' || recoveryInFlightRef.current) return
      recoveryInFlightRef.current = true
      try {
        const refreshedOverview = overviewError ? await loadOverview() : undefined
        const reads: Promise<unknown>[] = []
        if (entitiesError) reads.push(loadEntities())
        if (queryError) reads.push(loadQuery(true, refreshedOverview))
        if (historyOpen && historyError) reads.push(loadHistory())
        await Promise.allSettled(reads)
      } finally {
        recoveryInFlightRef.current = false
      }
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') void retryFailedReads()
    }

    window.addEventListener('online', retryFailedReads)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('online', retryFailedReads)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [entitiesError, historyError, historyOpen, loadEntities, loadHistory, loadOverview, loadQuery, overviewError, queryError])

  const mutationResultUncertain = (error: unknown) => (
    error instanceof ApiError && error.status === 0
    || error instanceof Error && /超时|网络中断|无法连接|network|timeout/i.test(error.message)
  )

  const reconcileSyncState = () => {
    const reconcileId = ++mutationReconcileRef.current
    if (mutationReconcileTimerRef.current !== null) window.clearTimeout(mutationReconcileTimerRef.current)
    const readFinalState = async () => {
      const [overviewResult] = await Promise.allSettled([loadOverview(), loadEntities()])
      const refreshedOverview = overviewResult.status === 'fulfilled' ? overviewResult.value : null
      await Promise.allSettled([
        loadQuery(true, refreshedOverview),
        historyOpen ? loadHistory() : Promise.resolve(),
      ])
    }
    void readFinalState().finally(() => {
      if (mutationReconcileRef.current !== reconcileId) return
      mutationReconcileTimerRef.current = window.setTimeout(() => {
        if (mutationReconcileRef.current !== reconcileId) return
        mutationReconcileTimerRef.current = null
        void readFinalState()
      }, 1200)
    })
  }

  const reconcileCleanupState = () => {
    const reconcileId = ++mutationReconcileRef.current
    if (mutationReconcileTimerRef.current !== null) window.clearTimeout(mutationReconcileTimerRef.current)
    setHistoryPage(1)
    const readFinalState = () => loadHistory(1)
    void readFinalState().finally(() => {
      if (mutationReconcileRef.current !== reconcileId) return
      mutationReconcileTimerRef.current = window.setTimeout(() => {
        if (mutationReconcileRef.current !== reconcileId) return
        mutationReconcileTimerRef.current = null
        void readFinalState()
      }, 1200)
    })
  }

  const handleRefresh = async () => {
    if (refreshLockRef.current) return
    refreshLockRef.current = true
    setRefreshing(true)
    try {
      await Promise.allSettled([loadOverview(), loadEntities(), loadQuery(true)])
    } finally {
      refreshLockRef.current = false
      setRefreshing(false)
    }
  }

  const handleSync = async () => {
    if (!isAdmin) {
      toast.error('仅管理员可立即采集并写入共享时序库')
      return
    }
    if (syncLockRef.current) {
      syncAbortRef.current?.abort()
      return
    }
    if (!overview) {
      toast.warning('正在确认 InfluxDB 连接状态，请稍后再同步')
      return
    }
    if (overview.status !== 'running') {
      toast.error('InfluxDB 当前不可用，请先在系统设置恢复连接')
      return
    }
    syncLockRef.current = true
    const controller = new AbortController()
    syncAbortRef.current = controller
    setSyncing(true)
    try {
      const result = await syncTimeSeries(controller.signal)
      toast.success(`同步完成，写入 ${result.written} 条时序点`)
      void Promise.allSettled([loadOverview(), loadEntities(), loadQuery(true)])
      if (historyOpen) void loadHistory()
    } catch (err) {
      if (controller.signal.aborted) {
        toast.warning('已取消等待；采集任务可能已经完成，正在重新读取最终状态')
        reconcileSyncState()
        return
      }
      if (mutationResultUncertain(err)) {
        toast.error('同步结果暂时无法确认，正在重新读取时序数据和采集记录，请勿立即重复提交')
        reconcileSyncState()
        return
      }
      toast.error(businessErrorMessage(err, { fallback: '时序数据同步失败', service: '时序数据同步' }))
    } finally {
      if (syncAbortRef.current === controller) {
        syncAbortRef.current = null
        syncLockRef.current = false
        setSyncing(false)
      }
    }
  }

  const handleCleanup = async () => {
    if (!isAdmin) {
      setCleanupOpen(false)
      toast.error('仅管理员可清理自动采集日志')
      return
    }
    if (cleanupLockRef.current) {
      cleanupAbortRef.current?.abort()
      return
    }
    cleanupLockRef.current = true
    const controller = new AbortController()
    cleanupAbortRef.current = controller
    try {
      setCleaning(true)
      const result = await cleanupTimeSeriesCollectorHistory(controller.signal)
      setCleanupOpen(false)
      toast.success(`已清理 ${result.deleted} 条自动采集日志，保留最近 ${result.retained_failures} 条失败证据`)
      setHistoryPage(1)
      void loadHistory(1)
    } catch (cleanupError) {
      if (controller.signal.aborted) {
        toast.warning('已取消等待；清理可能已经完成，正在重新读取采集记录')
        reconcileCleanupState()
        return
      }
      if (mutationResultUncertain(cleanupError)) {
        toast.error('清理结果暂时无法确认，正在重新读取采集记录，请勿立即重复提交')
        reconcileCleanupState()
        return
      }
      toast.error(cleanupError instanceof Error ? cleanupError.message : '采集日志清理失败')
    } finally {
      if (cleanupAbortRef.current === controller) {
        cleanupAbortRef.current = null
        cleanupLockRef.current = false
        setCleaning(false)
      }
    }
  }

  const handleExport = async (format: 'json' | 'csv') => {
    if (exportLockRef.current) {
      if (exportingFormat === format) exportAbortRef.current?.abort()
      return
    }
    exportLockRef.current = true
    const request = ++exportRequestRef.current
    const controller = new AbortController()
    exportAbortRef.current = controller
    try {
      setExportingFormat(format)
      const result = await exportTimeSeries({ ...queryParams, format }, controller.signal)
      if (request !== exportRequestRef.current) return
      if (!result.count) {
        toast.warning('当前筛选结果为空，未生成导出文件')
        return
      }
      downloadBlob(result.filename, result.blob)
      toast.success(`已导出 ${result.count} 条时序数据${result.truncated ? '，结果达到 10,000 条上限' : ''}`)
    } catch (err) {
      if (request !== exportRequestRef.current) return
      if (controller.signal.aborted) {
        toast.warning('已取消导出')
        return
      }
      toast.error(businessErrorMessage(err, { fallback: '时序数据导出失败', service: '时序数据导出' }))
    } finally {
      if (exportAbortRef.current === controller) exportAbortRef.current = null
      if (request === exportRequestRef.current) {
        exportLockRef.current = false
        setExportingFormat('')
      }
    }
  }

  const updateQueryFilter = (update: () => void) => {
    if (influxUnavailable) return
    queryRequestRef.current += 1
    queryAbortRef.current?.abort()
    queryAbortRef.current = null
    setSelected(null)
    setQueryError('')
    setQuerying(true)
    setQueryViewVersion(version => version + 1)
    setPage(1)
    update()
  }

  const invalidateHistoryView = () => {
    historyRequestRef.current += 1
    historyAbortRef.current?.abort()
    historyAbortRef.current = null
    setHistoryError('')
    setHistoryLoading(true)
    setHistoryViewVersion(version => version + 1)
  }

  const entityById = useMemo(
    () => new Map(entities.map((entity) => [entity.entity_id, entity])),
    [entities],
  )

  const points = queryResult?.points || []
  const chartPoints = queryResult?.chart_points || points
  const canExport = querySnapshotMatchesView && !querying && !queryError && Boolean(queryResult?.total)
  const error = Array.from(new Set([overviewError, entitiesError].filter(Boolean)))
    .filter((message) => message !== queryError)
    .join('；')
  const connectionText = !overview
    ? overviewError ? '状态未取得' : '检测中'
    : overview.status === 'running'
      ? '运行中'
      : overview.status === 'unconfigured'
        ? '待配置'
        : overview.status === 'error'
          ? '鉴权异常'
          : '未连接'
  const connectionHint = !overview
    ? overviewError || '正在读取运行配置与连接状态'
    : overview.status === 'unconfigured'
      ? isAdmin ? `${overview.url || '未配置'} · 缺少查询/写入 Token` : '时序服务配置不完整，请联系管理员处理'
      : isAdmin ? `${overview.url || '未配置'} · ${overview.bucket || '—'}` : overview.status === 'running' ? '服务连接正常，运行配置由管理员维护' : '服务连接异常，请联系管理员检查运行配置'
  const queryResultValue = queryResult
      ? String(queryResult.total)
      : queryLoaded && !queryError
        ? '0'
        : '—'
  const queryResultHint = queryError && !queryResult
      ? '当前查询未完成，未取得结果总数。'
    : querying
      ? queryResult ? `正在更新，暂时显示最近 ${optionLabel(HOUR_OPTIONS, queryResult.query.hours)}的 ${queryResult.total} 条结果` : '正在读取当前筛选结果'
      : queryResult
        ? `本页 ${queryResult.count} 条，实体 ${queryResult.entity_count} 个 · ${optionLabel(HOUR_OPTIONS, queryResult.query.hours)}范围。`
        : queryLoaded
          ? `本页 0 条，实体 0 个 · ${optionLabel(HOUR_OPTIONS, hours)}范围。`
          : '等待当前筛选查询完成。'
  const queryPending = querying || (!queryLoaded && !queryError)
  const displayedLatestAt = latestTimestamp(overview?.latest_at, queryResult?.latest_at)
  const retainingQuerySnapshot = queryLoaded && (querying || !querySnapshotMatchesView)
  const collectionEntityValue = overview
    ? String(overview.entity_count)
    : entitiesError && !entities.length
      ? '—'
      : loading && !entities.length
        ? '—'
        : String(entities.length)
  const collectionEntityHint = overview
    ? `周期 ${overview.collect_interval_seconds} 秒，支持手动同步。`
    : entitiesError && !entities.length
      ? '当前未取得纳管实体与采集周期。'
      : loading && !entities.length
        ? '正在读取纳管实体与采集周期。'
        : `已读取 ${entities.length} 个纳管实体，采集周期尚未取得。`

  return (
    <main className="mx-auto max-w-7xl space-y-6">
      <header className="flex flex-col gap-4 pb-2 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="inline-flex items-center gap-2 text-sm font-bold text-blue-700">
            <Database size={18} />
            InfluxDB 时序数据
          </div>
          <h1 className="mt-2 text-3xl font-black text-slate-900">时序数据</h1>
          <p className="mt-2 max-w-3xl text-sm leading-7 text-slate-500">
            采集 Home Assistant 实体状态，写入 InfluxDB，并按实体、分类和时间范围查询趋势与明细。
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            className="inline-flex min-h-11 items-center gap-2 whitespace-nowrap rounded-lg bg-white px-4 py-2.5 text-sm font-bold text-slate-700 shadow-sm shadow-slate-200/60 transition hover:text-blue-700"
          >
            <History size={16} />
            同步记录
          </button>
          <button
            type="button"
            onClick={() => void handleRefresh()}
            disabled={refreshing}
            className="inline-flex min-h-11 items-center gap-2 whitespace-nowrap rounded-lg bg-white px-4 py-2.5 text-sm font-bold text-slate-700 shadow-sm shadow-slate-200/60 transition hover:text-blue-700 disabled:opacity-60"
          >
            <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
            {refreshing ? '刷新中' : '刷新'}
          </button>
          {isAdmin ? <button
            type="button"
            onClick={handleSync}
            disabled={!syncing && (!overview || influxUnavailable)}
            title={!overview ? '正在确认 InfluxDB 连接状态' : influxUnavailable ? '请先在系统设置恢复 InfluxDB 连接' : undefined}
            className="inline-flex min-h-11 items-center gap-2 whitespace-nowrap rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm shadow-blue-500/20 transition hover:bg-blue-500 disabled:opacity-60"
          >
            {syncing ? <X size={16} /> : <Zap size={16} />}
            {syncing ? '取消等待' : '立即同步'}
          </button> : null}
        </div>
      </header>

      {loading ? (
        <div className="flex items-center gap-3 rounded-md bg-blue-50 px-5 py-4 text-sm font-semibold text-blue-700 shadow-sm shadow-blue-100/60">
          <Loader2 size={18} className="shrink-0 animate-spin" />
          正在加载时序数据，筛选与页面结构已可查看。
        </div>
      ) : null}

      {error ? (
        <div className="rounded-md bg-rose-50 px-5 py-4 text-sm font-semibold text-rose-700 shadow-sm shadow-rose-100/60">
          {error}
        </div>
      ) : null}

      {queryError ? (
        <div className="flex items-start gap-3 rounded-md bg-amber-50 px-5 py-4 text-sm font-semibold text-amber-800 shadow-sm shadow-amber-100/60">
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          <div>
            <p>InfluxDB 查询暂不可用</p>
            <p className="mt-1 text-xs font-medium leading-5 text-amber-700">{queryError}</p>
          </div>
        </div>
      ) : null}

      <section className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <StatCard icon={Server} label="连接状态" value={connectionText} hint={connectionHint} />
        <StatCard icon={Activity} label="采集实体" value={collectionEntityValue} hint={collectionEntityHint} />
        <StatCard icon={Clock} label="最近写入" value={formatDateTime(displayedLatestAt)} hint="来自 InfluxDB 概览与当前查询快照中的较新记录。" />
        <StatCard icon={TableProperties} label="查询结果" value={queryResultValue} hint={queryResultHint} />
      </section>

      <section className="rounded-[8px] border border-slate-100 bg-white p-5 shadow-sm shadow-slate-200/60">
        <div className="mb-4 flex items-center gap-2 text-sm font-black text-slate-900">
          <Search size={18} className="text-blue-600" />
          查询条件
        </div>
        {influxUnavailable ? (
          <div className="mb-4 border-l-2 border-amber-400 bg-amber-50 px-3 py-2.5 text-xs font-semibold leading-5 text-amber-800" role="status">
            InfluxDB 当前不可用，查询条件暂不可调整；恢复服务后刷新即可继续。
          </div>
        ) : null}
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-[1.2fr_0.8fr_0.8fr_1fr]">
          <label className="space-y-1.5"><span className="text-xs font-bold text-slate-500">实体</span><UnifiedSelect
            ariaLabel="筛选时序实体"
            value={entityId}
            options={[
              { value: '', label: '全部实体' },
              ...entities.map((entity) => ({
                value: entity.entity_id,
                label: [timeSeriesDeviceName(entity.device_name, entity.category, entity.role), entity.device_location].filter(Boolean).join(' · '),
              })),
            ]}
            disabled={influxUnavailable}
            onChange={(value) => updateQueryFilter(() => setEntityId(value))}
          /></label>
          <label className="space-y-1.5"><span className="text-xs font-bold text-slate-500">设备分类</span><UnifiedSelect
            ariaLabel="筛选时序设备分类"
            value={category}
            options={[
              { value: '', label: '全部分类' },
              ...categoryOptions.map((item) => ({ value: item, label: labelCategory(item) })),
            ]}
            disabled={influxUnavailable}
            onChange={(value) => updateQueryFilter(() => {
              setCategory(value)
              setEntityId('')
            })}
          /></label>
          <label className="space-y-1.5"><span className="text-xs font-bold text-slate-500">聚合粒度</span><UnifiedSelect
            ariaLabel="时序数据聚合粒度"
            value={windowSize}
            options={WINDOW_OPTIONS}
            disabled={influxUnavailable}
            onChange={(value) => updateQueryFilter(() => setWindowSize(value as TimeSeriesWindow))}
          /></label>
          <label className="space-y-1.5"><span className="text-xs font-bold text-slate-500">关键词</span><input
            aria-label="搜索时序实体或设备"
            value={keywordInput}
            disabled={influxUnavailable}
            onChange={(event) => {
              updateQueryFilter(() => {
                setKeywordInput(event.target.value)
                setEntityId('')
              })
              setKeywordSettled(false)
            }}
            placeholder="搜索实体或设备"
            className="min-h-11 w-full rounded-[8px] border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-slate-700 outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-100 disabled:cursor-not-allowed disabled:opacity-60"
          /></label>
          <div className="space-y-1.5 md:col-span-2 xl:col-span-4"><span className="block text-xs font-bold text-slate-500">查询范围</span><div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
            {HOUR_OPTIONS.map((item) => (
              <button
                key={item.value}
                type="button"
                disabled={influxUnavailable}
                onClick={() => updateQueryFilter(() => setHours(item.value))}
                className={`min-h-10 whitespace-nowrap rounded-[8px] px-4 text-xs font-bold transition disabled:cursor-not-allowed disabled:opacity-55 ${hours === item.value ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:text-blue-700'}`}
              >
                {item.label}
              </button>
            ))}
          </div></div>
        </div>
      </section>

      <TrendChart
        points={chartPoints}
        loading={queryPending}
        entityTotal={queryResult?.meta.chart_entity_total || queryResult?.entity_count || 0}
        entitiesTruncated={Boolean(queryResult?.meta.chart_entities_truncated)}
      />

      <section className="overflow-hidden rounded-[8px] border border-slate-100 bg-white shadow-sm shadow-slate-200/60">
        <div className="flex flex-col gap-3 px-5 py-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-lg font-black text-slate-900">时序明细</h2>
            <p className="mt-1 text-sm text-slate-500">展示当前筛选下的 InfluxDB 查询结果。</p>
          </div>
          <div className="grid grid-cols-2 gap-2 md:flex md:flex-wrap">
            <button onClick={() => void handleExport('json')} disabled={Boolean(exportingFormat && exportingFormat !== 'json') || !canExport} title={exportingFormat === 'json' ? '取消当前导出' : canExport ? '导出当前筛选结果为 JSON' : '当前没有可导出的时序数据'} className="inline-flex min-h-9 items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-slate-100 px-3 py-2 text-xs font-bold text-slate-700 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-50">
              {exportingFormat === 'json' ? <X size={14} /> : <FileJson size={14} />}
              {exportingFormat === 'json' ? '取消导出' : '导出 JSON'}
            </button>
            <button onClick={() => void handleExport('csv')} disabled={Boolean(exportingFormat && exportingFormat !== 'csv') || !canExport} title={exportingFormat === 'csv' ? '取消当前导出' : canExport ? '导出当前筛选结果为 CSV' : '当前没有可导出的时序数据'} className="inline-flex min-h-9 items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-slate-100 px-3 py-2 text-xs font-bold text-slate-700 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-50">
              {exportingFormat === 'csv' ? <X size={14} /> : <Download size={14} />}
              {exportingFormat === 'csv' ? '取消导出' : '导出 CSV'}
            </button>
          </div>
        </div>
        {retainingQuerySnapshot ? (
          <div className="flex items-center gap-2 border-y border-blue-100 bg-blue-50/70 px-5 py-2.5 text-xs font-semibold text-blue-700" role="status">
            {querying ? <Loader2 size={14} className="animate-spin" /> : null}{querying ? '正在更新时序明细，' : '正在应用新的查询条件，'}{querySnapshotMatchesView ? `当前暂时显示最近 ${optionLabel(HOUR_OPTIONS, queryResult?.query.hours || hours)}的成功结果。` : '下方旧快照不代表当前查询条件，详情、导出和分页暂不可用。'}
          </div>
        ) : null}
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="时序数据明细列表，可横向滚动">
          <table className="min-w-[1080px] table-fixed text-left text-sm">
            <colgroup>
              <col className="w-[170px]" />
              <col className="w-[190px]" />
              <col className="w-[130px]" />
              <col className="w-[120px]" />
              <col className="w-[110px]" />
              <col className="w-[140px]" />
              <col className="w-[90px]" />
              <col className="w-[100px]" />
            </colgroup>
            <thead className="bg-slate-50 text-xs font-bold text-slate-500">
              <tr>
                <th className="whitespace-nowrap px-5 py-3">时间</th>
                <th className="whitespace-nowrap px-5 py-3">设备</th>
                <th className="whitespace-nowrap px-5 py-3">位置</th>
                <th className="whitespace-nowrap px-5 py-3">分类</th>
                <th className="whitespace-nowrap px-5 py-3">数据项</th>
                <th className="whitespace-nowrap px-5 py-3">记录值</th>
                <th className="whitespace-nowrap px-5 py-3">来源</th>
                <th className="whitespace-nowrap px-5 py-3">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {points.map((point, index) => (
                <tr key={`${point.time}-${point.entity_id}-${index}`} className="transition-colors hover:bg-slate-50/70">
                  <td className="whitespace-nowrap px-5 py-4 text-xs font-semibold text-slate-500">{formatDateTime(point.time)}</td>
                  <td className="px-5 py-4">
                    <div className="truncate whitespace-nowrap font-semibold text-slate-900" title={timeSeriesDeviceName(point.device_name, point.category, point.role)}>{timeSeriesDeviceName(point.device_name, point.category, point.role)}</div>
                  </td>
                  <td className="truncate whitespace-nowrap px-5 py-4 text-sm text-slate-500" title={entityById.get(point.entity_id)?.device_location || '位置未设置'}>{entityById.get(point.entity_id)?.device_location || '位置未设置'}</td>
                  <td className="px-5 py-4">
                    <span
                      className="inline-flex whitespace-nowrap rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-600"
                      title={technicalLabelTitle(labelCategory(point.category), point.category, Boolean(CATEGORY_LABELS[point.category]))}
                    >{labelCategory(point.category)}</span>
                  </td>
                  <td className="px-5 py-4">
                    <span
                      className="whitespace-nowrap text-xs font-semibold text-slate-600"
                      title={technicalLabelTitle(labelRole(point.role), point.role, Boolean(ROLE_LABELS[point.role] || ROLE_LABELS[point.role?.replace(/_(light|switch|sensor)(?:_\d+)?$/, '')]))}
                    >{labelRole(point.role)}</span>
                  </td>
                  <td className="whitespace-nowrap px-5 py-4 text-sm font-bold text-slate-800">
                    {formatPointValue(point)}
                  </td>
                  <td className="px-5 py-4">
                    <span
                      className="inline-flex whitespace-nowrap rounded-full bg-blue-50 px-2.5 py-1 text-xs font-bold text-blue-700"
                      title={technicalLabelTitle(sourceLabel(point.source), point.source, Boolean(SOURCE_LABELS[point.source]))}
                    >{sourceLabel(point.source)}</span>
                  </td>
                  <td className="px-5 py-4">
                    <button onClick={() => { if (querySnapshotMatchesView) setSelected(point) }} disabled={!querySnapshotMatchesView} title={querySnapshotMatchesView ? '查看时序记录详情' : '请等待当前查询条件读取完成'} className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-slate-100 px-3 py-2 text-xs font-bold text-slate-700 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-40">
                      <Eye size={14} />
                      详情
                    </button>
                  </td>
                </tr>
              ))}
              {!points.length ? (
                <tr>
                  <td colSpan={8} className="px-5 py-12 text-center text-sm font-semibold text-slate-400">
                    {queryPending
                      ? '正在读取当前筛选下的时序记录。'
                      : queryError || influxUnavailable
                      ? 'InfluxDB 当前不可用，恢复服务后刷新即可重新查询。'
                      : isAdmin
                        ? '当前筛选下暂无时序记录，可以执行一次同步后再查询。'
                        : '当前筛选下暂无时序记录，请等待管理员完成采集。'}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <Pagination
          page={queryResult?.page || page}
          pageSize={queryResult?.size || pageSize}
          total={queryResult?.total || 0}
          itemName="条时序记录"
          loading={queryPending && !influxUnavailable}
          totalKnown={Boolean(queryResult) || (!queryError && !influxUnavailable && !queryPending)}
          navigationDisabled={!querySnapshotMatchesView}
          onPageChange={(nextPage) => { queryRequestRef.current += 1; queryAbortRef.current?.abort(); setSelected(null); setQueryError(''); setQuerying(true); setPage(nextPage) }}
          onPageSizeChange={(size) => { queryRequestRef.current += 1; queryAbortRef.current?.abort(); setSelected(null); setQueryError(''); setQuerying(true); setPageSize(size); setPage(1) }}
          pageSizeOptions={[10, 20, 50, 100]}
        />
      </section>

      <AppDrawer
        open={Boolean(selected)}
        title={selected?.device_name || '未命名设备'}
        description={selected ? `${labelCategory(selected.category)} · ${labelRole(selected.role)}` : undefined}
        onClose={() => setSelected(null)}
        widthClassName="max-w-xl"
        zIndexClassName="z-[80]"
      >
        {selected ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                ['采集时间', formatDateTime(selected.time)],
                ['记录值', formatPointValue(selected)],
                ['数据项', labelRole(selected.role)],
                ['采集来源', sourceLabel(selected.source)],
              ].map(([label, value]) => (
                <div key={label} className="rounded-[8px] bg-slate-50 px-4 py-3">
                  <p className="text-xs font-bold text-slate-400">{label}</p>
                  <p className="mt-2 break-words text-sm font-semibold text-slate-800">{value}</p>
                </div>
              ))}
            </div>
            <div className="mt-6 border-t border-slate-100 pt-5">
              <p className="mb-4 text-xs font-bold text-slate-500">技术信息</p>
              <div className="space-y-4">
                <TechnicalId label="Home Assistant 实体" value={selected.entity_id} />
                <TechnicalId label="平台设备编号" value={selected.device_id} />
                <TechnicalId label="原始设备分类" value={selected.category} />
                <TechnicalId label="原始数据项" value={selected.role} />
                <TechnicalId label="原始采集来源" value={selected.source} />
                <TechnicalId label="实体类型" value={selected.domain} />
                <TechnicalId label="InfluxDB 字段" value={selected.field} />
                {selected.state_raw ? <TechnicalId label="原始状态" value={selected.state_raw} /> : null}
              </div>
            </div>
          </>
        ) : null}
      </AppDrawer>

      <AppDrawer
        open={historyOpen}
        title="时序同步与采集记录"
        description={historyVisibility === 'all' ? '查看全部手动同步、自动采集和失败诊断。记录由平台审计日志按页读取。' : '查看系统自动采集证据和您自己的手动同步记录。'}
        onClose={() => {
          historyRequestRef.current += 1
          historyAbortRef.current?.abort()
          historyAbortRef.current = null
          setHistoryLoading(false)
          setHistoryOpen(false)
        }}
        widthClassName="max-w-2xl"
        headerActions={isAdmin ? (
          <button
            type="button"
            onClick={() => setCleanupOpen(true)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-[6px] border border-red-100 text-red-500 transition hover:bg-red-50"
            aria-label="清理自动采集日志"
            title="清理自动采集日志"
          >
            <Trash2 size={16} />
          </button>
        ) : undefined}
        footer={(
          <Pagination
            page={loadedHistoryPage}
            pageSize={loadedHistorySize}
            total={historyTotal}
            itemName="条同步记录"
            loading={historyLoading}
            totalKnown={historyLoaded}
            navigationDisabled={!historySnapshotMatchesView}
            onPageChange={(nextPage) => { invalidateHistoryView(); setHistoryPage(nextPage) }}
            onPageSizeChange={(size) => { invalidateHistoryView(); setHistorySize(size); setHistoryPage(1) }}
            className="border-0 p-0"
          />
        )}
      >
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_minmax(180px,1.4fr)]">
          <UnifiedSelect
            ariaLabel="筛选同步记录来源"
            value={historyScope}
            options={[
              { value: 'all', label: '全部来源' },
              { value: 'manual', label: historyVisibility === 'all' ? '手动同步' : '我的手动同步' },
              { value: 'collector', label: '自动采集' },
            ]}
            onChange={(value) => { invalidateHistoryView(); setHistoryScope(value as typeof historyScope); setHistoryPage(1) }}
          />
          <UnifiedSelect
            ariaLabel="筛选同步记录结果"
            value={historyLevel}
            options={[
              { value: '', label: '全部结果' },
              { value: 'success', label: '成功' },
              { value: 'warning', label: '警告' },
              { value: 'error', label: '失败' },
              { value: 'info', label: '信息' },
            ]}
            onChange={(value) => { invalidateHistoryView(); setHistoryLevel(value); setHistoryPage(1) }}
          />
          <input
            aria-label="搜索同步记录"
            value={historyKeyword}
            onChange={(event) => { invalidateHistoryView(); setHistorySearchSettled(false); setHistoryKeyword(event.target.value); setHistoryPage(1) }}
            placeholder="搜索标题或诊断"
            className="min-h-11 rounded-[8px] border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-slate-700 outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-100 dark:border-white/[0.08] dark:bg-white/[0.06] dark:text-slate-200"
          />
        </div>
        {historyLoaded && (historyLoading || !historySnapshotMatchesView) ? (
          <div className="mt-4 flex items-center gap-2 border-l-2 border-blue-500 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700" role="status">
            {historyLoading ? <Loader2 size={14} className="animate-spin" /> : null}{historyLoading ? '正在更新同步记录，' : '正在应用新的筛选条件，'}{historySnapshotMatchesView ? '当前暂时显示同一条件下的上一次成功结果。' : '下方旧快照不代表当前条件，分页暂不可用。'}
          </div>
        ) : null}
        {historyError && historyLoaded ? (
          <div className="mt-5 rounded-md bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
            {historyError}；{historySnapshotMatchesView ? '下方保留当前条件下的上一次成功快照。' : '保留的旧快照不代表当前条件，分页已暂停。'}
          </div>
        ) : null}
        {historyLoading && !historyLoaded ? (
          <div className="flex items-center justify-center gap-3 py-16 text-sm font-semibold text-slate-400"><Loader2 size={18} className="animate-spin" />正在读取同步记录</div>
        ) : historyLoaded && historyItems.length ? (
          <div className="mt-5 divide-y divide-slate-100 rounded-[8px] border border-slate-100 dark:divide-white/[0.06] dark:border-white/[0.06]">
            {historyItems.map((item) => (
              <article key={item.id} className="px-4 py-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded-[6px] px-2.5 py-1 text-xs font-black ${item.level === 'success' ? 'bg-emerald-50 text-emerald-700' : item.level === 'error' ? 'bg-red-50 text-red-700' : item.level === 'warning' ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-600'}`}
                        title={technicalLabelTitle(historyLevelLabel(item.level), item.level, ['success', 'error', 'warning', 'info'].includes(item.level))}
                      >{historyLevelLabel(item.level)}</span>
                      <span className="rounded-[6px] bg-blue-50 px-2.5 py-1 text-xs font-black text-blue-700">{item.scope === 'manual' ? '手动同步' : '自动采集'}</span>
                      <h3 className="break-words text-sm font-black text-slate-900 dark:text-white">{item.title}</h3>
                    </div>
                    <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">{historyDetail(item)}</p>
                  </div>
                  <div className="shrink-0 text-left text-xs leading-5 text-slate-400 sm:text-right">
                    <p>{formatDateTime(item.created_at)}</p>
                    <p>{item.username === 'system' ? '系统任务' : item.username || '系统任务'}</p>
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : historyError && !historyLoaded ? (
          <div className="mt-5 rounded-md bg-red-50 px-5 py-12 text-center text-sm font-semibold text-red-700 dark:bg-red-500/10 dark:text-red-200">
            <p>同步记录未取得，不能判断当前筛选是否存在记录。</p>
            <button type="button" onClick={() => void loadHistory()} className="mt-4 min-h-9 rounded-lg border border-red-200 bg-white px-3 text-xs font-black text-red-700 hover:bg-red-50 dark:border-red-400/20 dark:bg-white/[0.06] dark:text-red-200">重新读取记录</button>
          </div>
        ) : historyLoaded ? (
          <div className="mt-5 rounded-md bg-slate-50 px-5 py-12 text-center text-sm font-semibold text-slate-400 dark:bg-white/[0.04]">当前筛选下暂无同步记录</div>
        ) : null}
      </AppDrawer>

      <AppDialog
        open={cleanupOpen}
        title="清理自动采集日志"
        description="将清理重复和过期的自动采集日志，最近失败证据仍会按后端保留策略留下。手动同步记录和 InfluxDB 时序数据不会被删除。"
        danger
        onClose={() => { if (!cleaning) setCleanupOpen(false) }}
        closeOnOverlay={!cleaning}
        showClose={!cleaning}
        initialFocusRef={cleanupCancelRef}
        footer={(
          <div className="flex justify-end gap-3">
            {!cleaning ? <button ref={cleanupCancelRef} type="button" onClick={() => setCleanupOpen(false)} className="min-h-10 rounded-lg border border-slate-200 px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50">取消</button> : null}
            <button type="button" onClick={handleCleanup} className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white hover:bg-red-700 disabled:opacity-50">
              {cleaning ? <X size={16} /> : <Trash2 size={16} />}
              {cleaning ? '取消等待' : '确认清理'}
            </button>
          </div>
        )}
      >
        <p className="text-sm leading-6 text-slate-500 dark:text-slate-400">该操作只减少平台操作日志体积，不会删除设备状态、查询结果或 InfluxDB Bucket 中的业务数据。</p>
      </AppDialog>
    </main>
  )
}

export default function TimeSeriesPage() {
  return (
    <Suspense fallback={<div className="flex min-h-[50vh] items-center justify-center text-sm font-bold text-slate-400">正在读取时序数据...</div>}>
      <TimeSeriesContent />
    </Suspense>
  )
}
