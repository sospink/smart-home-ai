'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import {
  AlertTriangle, Bug, Download, Loader2, RefreshCw, Search, Trash2, ThumbsDown, ThumbsUp, X,
} from 'lucide-react'
import {
  deleteConversation,
  exportConversationRecords,
  getConversationRecords,
  getWorkflowRunDetail,
  submitMessageFeedback,
  type ConversationRecordItem,
  type ConversationRecordStats,
  type ConversationRecordMeta,
  type ConversationRecordView,
  type ConversationRunKind,
  type WorkflowRunDetail,
} from '@/lib/api/chat'
import { AppDialog } from '@/components/ui/AppDialog'
import { ChatMarkdownRenderer } from '@/components/chat/ChatMarkdownRenderer'
import { Pagination } from '@/components/ui/Pagination'
import { UnifiedSelect } from '@/components/ui/UnifiedSelect'
import { TechnicalId } from '@/components/ui/TechnicalId'
import { handleTabListKeyDown } from '@/lib/ui/tabs'
import { ApiError } from '@/lib/api/client'
import { businessErrorMessage } from '@/lib/ui/business-error'

function formatDateTime(value?: number | string) {
  if (!value) return '—'
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function toDateInputValue(value?: number) {
  if (!value) return ''
  const date = new Date(value * 1000)
  if (Number.isNaN(date.getTime())) return ''
  const offset = date.getTimezoneOffset() * 60000
  const localDate = new Date(date.getTime() - offset)
  return Number.isNaN(localDate.getTime()) ? '' : localDate.toISOString().slice(0, 16)
}

function fromDateInputValue(value: string) {
  if (!value) return undefined
  const time = new Date(value).getTime()
  if (Number.isNaN(time)) return undefined
  return Math.floor(time / 1000)
}

type GroupedConversation = {
  id: string
  name: string
  latestAt: number
  messageCount: number
  items: ConversationRecordItem[]
}

const VIEW_OPTIONS: { id: ConversationRecordView; label: string }[] = [
  { id: 'history', label: '历史查询' },
  { id: 'runs', label: '运行记录与调试' },
  { id: 'feedback', label: '效果评估' },
]
const VIEW_IDS = VIEW_OPTIONS.map((item) => item.id)

const EMPTY_STATS: ConversationRecordStats = {
  conversation_count: 0,
  message_count: 0,
  record_count: 0,
  feedback_count: 0,
  positive_feedback_count: 0,
  negative_feedback_count: 0,
  run_count: 0,
  workflow_run_count: 0,
  platform_run_count: 0,
  device_control_count: 0,
  device_status_count: 0,
  platform_test_count: 0,
  abnormal_count: 0,
}

const RUN_KIND_OPTIONS: Array<{ value: ConversationRunKind; label: string }> = [
  { value: '', label: '全部运行类型' },
  { value: 'workflow_run', label: '工作流运行' },
  { value: 'task_run', label: '任务运行' },
  { value: 'device_control', label: '设备控制' },
  { value: 'device_status', label: '设备状态审计' },
  { value: 'platform_test', label: '平台测试' },
  { value: 'platform_run', label: '其他平台运行' },
]

function runStatusLabel(value?: string) {
  const labels: Record<string, string> = {
    success: '成功', succeeded: '成功', completed: '已完成',
    failed: '失败', error: '异常', running: '运行中', stopped: '已停止', pending: '等待执行',
  }
  if (!value) return ''
  if (/[\u4e00-\u9fff]/.test(value)) return value
  return labels[value.toLowerCase()] || '状态待确认'
}

function recordDiagnostic(value?: string) {
  const text = String(value || '').trim()
  if (!text) return ''
  const normalized = text.toLowerCase()
  if (normalized.includes('all connection attempts failed') || normalized.includes('connection refused')) {
    return '无法连接 Dify，请确认服务地址、容器状态和网络链路'
  }
  if (normalized.includes('timed out') || normalized.includes('timeout') || normalized.includes('读取超过')) {
    return text.includes('读取超过') ? text : 'Dify 请求超时，请检查服务状态和网络链路'
  }
  if (normalized.includes('connection reset') || normalized.includes('server disconnected')) {
    return 'Dify 连接已断开，请检查服务状态和网络链路'
  }
  if (normalized.includes('500 internal server error') || normalized.includes("server error '500")) {
    return 'Dify 工作流详情接口返回服务器错误；消息与平台运行证据仍已保留，可稍后重试详情读取'
  }
  return text
}

function recordIsAbnormal(record: ConversationRecordItem | null, workflowError = '') {
  if (!record) return false
  const usage = objectValue(record.usage)
  const explicitFailure = (value: unknown) => {
    const normalized = String(value || '').trim().toLowerCase()
    return ['error', 'failed', 'failure'].includes(normalized) || /异常|失败/.test(normalized)
  }
  return record.feedback?.rating === 'dislike'
    || (record.record_kind === 'conversation_message' && !record.answer.trim())
    || explicitFailure(usage.level)
    || explicitFailure(record.run_status)
    || Boolean(workflowError)
}

function recordPhysicalPending(record: ConversationRecordItem | null) {
  return Boolean(record && !recordIsAbnormal(record) && /待实机确认|待现场确认|控制已下发/.test(String(record.run_status || '')))
}

function recordListStatus(record: ConversationRecordItem) {
  if (recordIsAbnormal(record)) return { label: '待复核', className: 'text-rose-600 dark:text-rose-300' }
  if (recordPhysicalPending(record)) return { label: '待现场确认', className: 'text-amber-600 dark:text-amber-300' }
  return { label: '正常', className: 'text-emerald-600 dark:text-emerald-300' }
}

function formatElapsedSeconds(value?: number | null) {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return '—'
  if (value < 1) return `${Math.round(value * 1000)} 毫秒`
  return `${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} 秒`
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function numericValue(...values: unknown[]) {
  for (const value of values) {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function textValue(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

const RUNTIME_TYPE_LABELS: Record<string, string> = {
  agent_control: '设备控制',
  agent_device_status: '设备状态回读',
  agent_test: '智能体测试',
}

const RUNTIME_LEVEL_LABELS: Record<string, string> = {
  success: '成功', warning: '需实机确认', error: '失败', info: '已记录',
}

function UsageSummary({ value, isDifyRecord }: { value: unknown; isDifyRecord: boolean }) {
  const usage = objectValue(value)
  const promptTokens = numericValue(usage.prompt_tokens, usage.input_tokens, usage.prompt_token)
  const completionTokens = numericValue(usage.completion_tokens, usage.output_tokens, usage.answer_tokens, usage.completion_token)
  const totalTokens = numericValue(usage.total_tokens, usage.total_token, typeof value === 'number' ? value : null)
  const totalPrice = numericValue(usage.total_price, usage.price, usage.cost)
  const currency = textValue(usage.currency, usage.currency_type).toUpperCase()
  const runtimeType = textValue(usage.type)
  const runtimeLevel = textValue(usage.level)
  const hasUsage = promptTokens !== null || completionTokens !== null || totalTokens !== null || totalPrice !== null
  const hasRuntime = Boolean(runtimeType || runtimeLevel)

  return (
    <div className="mt-3 space-y-3">
      {isDifyRecord && hasUsage ? (
        <div className="grid grid-cols-2 overflow-hidden rounded-[8px] border border-slate-200 bg-white dark:border-white/[0.08] dark:bg-white/[0.02]">
          {[
            ['输入 Token', promptTokens ?? '未返回'],
            ['输出 Token', completionTokens ?? '未返回'],
            ['总 Token', totalTokens ?? '未返回'],
            ['调用费用', totalPrice === null ? '未返回' : `${totalPrice}${currency ? ` ${currency}` : ''}`],
          ].map(([label, displayValue], index) => (
            <div key={label} className={`px-3 py-3 ${index % 2 === 0 ? 'border-r border-slate-200 dark:border-white/[0.08]' : ''} ${index < 2 ? 'border-b border-slate-200 dark:border-white/[0.08]' : ''}`}>
              <p className="text-xs font-semibold text-slate-400">{label}</p>
              <p className="mt-1 break-words text-sm font-black text-slate-900 dark:text-white">{displayValue}</p>
            </div>
          ))}
        </div>
      ) : hasRuntime ? (
        <div className="grid grid-cols-2 overflow-hidden rounded-[8px] border border-slate-200 bg-white dark:border-white/[0.08] dark:bg-white/[0.02]">
          <div className="border-r border-slate-200 px-3 py-3 dark:border-white/[0.08]"><p className="text-xs font-semibold text-slate-400">运行类型</p><p className="mt-1 text-sm font-black text-slate-900 dark:text-white">{RUNTIME_TYPE_LABELS[runtimeType] || '平台运行'}</p></div>
          <div className="px-3 py-3"><p className="text-xs font-semibold text-slate-400">执行结果</p><p className="mt-1 text-sm font-black text-slate-900 dark:text-white">{RUNTIME_LEVEL_LABELS[runtimeLevel] || '待确认'}</p></div>
        </div>
      ) : <p className="text-sm leading-6 text-slate-500 dark:text-slate-400">{isDifyRecord ? '该消息未返回 Token 或费用信息。' : '该记录未返回补充运行元数据。'}</p>}
      {Object.keys(usage).length ? <RawTechnicalData value={value} /> : null}
    </div>
  )
}

function RetrievalSummary({ value }: { value: unknown[] | undefined }) {
  const resources = (value || []).map(objectValue)
  if (!resources.length) return <p className="mt-3 text-sm leading-6 text-slate-500 dark:text-slate-400">该消息没有返回知识检索引用。</p>
  return (
    <div className="mt-3 space-y-2">
      {resources.slice(0, 3).map((resource, index) => {
        const documentName = textValue(resource.document_name, resource.name, resource.title) || `引用片段 ${index + 1}`
        const datasetName = textValue(resource.dataset_name, resource.dataset)
        const content = textValue(resource.content, resource.segment_content, resource.text)
        const score = numericValue(resource.score, resource.relevance_score)
        return <div key={`${documentName}-${index}`} className="rounded-[8px] bg-white px-3 py-3 dark:bg-slate-900"><div className="flex items-start justify-between gap-3"><p className="min-w-0 truncate text-xs font-black text-slate-900 dark:text-white" title={documentName}>{documentName}</p>{score === null ? null : <span className="inline-flex h-6 shrink-0 items-center rounded-full bg-blue-50 px-2 text-xs font-bold leading-none text-blue-600 dark:bg-blue-500/10 dark:text-blue-300">相关度 {score <= 1 ? `${Math.round(score * 100)}%` : score}</span>}</div>{datasetName ? <p className="mt-1 truncate text-xs text-slate-500" title={datasetName}>知识库：{datasetName}</p> : null}{content ? <p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-600 dark:text-slate-300">{content}</p> : <p className="mt-2 text-xs text-slate-400">未返回引用片段正文</p>}</div>
      })}
      {resources.length > 3 ? <p className="text-xs text-slate-500">另有 {resources.length - 3} 条引用，可在原始技术数据中查看。</p> : null}
      <RawTechnicalData value={value} />
    </div>
  )
}

function RawTechnicalData({ value }: { value: unknown }) {
  return <details><summary className="cursor-pointer text-xs font-bold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">查看原始技术数据</summary><pre className="records-scroll mt-2 max-h-36 overflow-auto rounded-[8px] bg-white px-3 py-2 text-[11px] leading-5 text-slate-600 dark:bg-slate-900 dark:text-slate-300">{JSON.stringify(value, null, 2)}</pre></details>
}

function recordViewKey({
  view,
  keyword,
  rating,
  runKind,
  startDate,
  endDate,
  page,
  size,
}: {
  view: ConversationRecordView
  keyword: string
  rating: '' | 'like' | 'dislike'
  runKind: ConversationRunKind
  startDate: string
  endDate: string
  page: number
  size: number
}) {
  return JSON.stringify({
    view,
    keyword: keyword.trim(),
    rating: view === 'feedback' ? rating : '',
    runKind: view === 'runs' ? runKind : '',
    startDate,
    endDate,
    page,
    size,
  })
}

function ConversationRecordsContent() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const initialView = (searchParams.get('view') as ConversationRecordView) || 'history'
  const [activeView, setActiveView] = useState<ConversationRecordView>(
    ['history', 'runs', 'feedback'].includes(initialView) ? initialView : 'history'
  )
  const [keyword, setKeyword] = useState(searchParams.get('keyword') || '')
  const [debouncedKeyword, setDebouncedKeyword] = useState((searchParams.get('keyword') || '').trim())
  const [searchSettled, setSearchSettled] = useState(true)
  const [ratingFilter, setRatingFilter] = useState<'' | 'like' | 'dislike'>(
    searchParams.get('rating') === 'like' || searchParams.get('rating') === 'dislike'
      ? (searchParams.get('rating') as 'like' | 'dislike')
      : ''
  )
  const initialRunKind = searchParams.get('run_kind') as ConversationRunKind
  const [runKind, setRunKind] = useState<ConversationRunKind>(RUN_KIND_OPTIONS.some((option) => option.value === initialRunKind) ? initialRunKind : '')
  const [page, setPage] = useState(Math.max(1, Number(searchParams.get('page')) || 1))
  const [pageSize, setPageSize] = useState([10, 20, 50].includes(Number(searchParams.get('size'))) ? Number(searchParams.get('size')) : 20)
  const [total, setTotal] = useState(0)
  const [startDate, setStartDate] = useState(toDateInputValue(Number(searchParams.get('start_time')) || undefined))
  const [endDate, setEndDate] = useState(toDateInputValue(Number(searchParams.get('end_time')) || undefined))
  const [items, setItems] = useState<ConversationRecordItem[]>([])
  const [stats, setStats] = useState<ConversationRecordStats | null>(null)
  const [recordMeta, setRecordMeta] = useState<ConversationRecordMeta | null>(null)
  const [loading, setLoading] = useState(true)
  const [recordsLoaded, setRecordsLoaded] = useState(false)
  const [loadedViewKey, setLoadedViewKey] = useState('')
  const [loadedPage, setLoadedPage] = useState(1)
  const [loadedPageSize, setLoadedPageSize] = useState(20)
  const [selectedConversationId, setSelectedConversationId] = useState(searchParams.get('conversationId') || '')
  const [selectedMessageId, setSelectedMessageId] = useState(searchParams.get('messageId') || '')
  const [workflowDetail, setWorkflowDetail] = useState<WorkflowRunDetail | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [detailReload, setDetailReload] = useState(0)
  const [actionMessage, setActionMessage] = useState('')
  const [loadError, setLoadError] = useState('')
  const [deletingConversationId, setDeletingConversationId] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [markingMessageId, setMarkingMessageId] = useState('')
  const [exporting, setExporting] = useState<'' | 'json' | 'csv' | 'current'>('')
  const recordRequestRef = useRef(0)
  const detailRequestRef = useRef(0)
  const forceDetailReloadRef = useRef(false)
  const exportRequestRef = useRef(0)
  const feedbackRequestRef = useRef(0)
  const exportInFlightRef = useRef(0)
  const recordAbortRef = useRef<AbortController | null>(null)
  const detailAbortRef = useRef<AbortController | null>(null)
  const exportAbortRef = useRef<AbortController | null>(null)
  const feedbackInFlightRef = useRef('')
  const feedbackAbortRef = useRef<AbortController | null>(null)
  const deleteRequestRef = useRef(0)
  const deleteInFlightRef = useRef('')
  const deleteAbortRef = useRef<AbortController | null>(null)
  const mutationReconcileRef = useRef(0)
  const mutationReconcileTimerRef = useRef<number | null>(null)
  const deleteCancelButtonRef = useRef<HTMLButtonElement | null>(null)
  const writtenSearchRef = useRef(searchParams.toString())
  const applyingUrlStateRef = useRef(false)
  const activeViewRef = useRef(activeView)
  activeViewRef.current = activeView
  const searchParamString = searchParams.toString()

  const currentViewKey = recordViewKey({
    view: activeView,
    keyword: debouncedKeyword,
    rating: ratingFilter,
    runKind,
    startDate,
    endDate,
    page,
    size: pageSize,
  })
  const snapshotMatchesView = Boolean(
    recordsLoaded
    && searchSettled
    && keyword.trim() === debouncedKeyword
    && loadedViewKey === currentViewKey
  )
  const feedbackUnavailable = Boolean(
    recordsLoaded
    && activeView === 'feedback'
    && recordMeta?.dify_available === false
  )
  const difyViewUnavailable = Boolean(
    recordsLoaded
    && activeView !== 'runs'
    && recordMeta?.dify_available === false
  )
  const startTimestamp = fromDateInputValue(startDate)
  const endTimestamp = fromDateInputValue(endDate)
  const dateRangeInvalid = Boolean(startTimestamp && endTimestamp && startTimestamp > endTimestamp)

  const invalidateExport = () => {
    exportRequestRef.current += 1
    exportAbortRef.current?.abort()
    exportAbortRef.current = null
    exportInFlightRef.current = 0
    setExporting('')
  }

  const invalidateFeedback = () => {
    feedbackRequestRef.current += 1
    feedbackAbortRef.current?.abort()
    feedbackAbortRef.current = null
    feedbackInFlightRef.current = ''
    setMarkingMessageId('')
  }

  const invalidateRecordView = (preserveSnapshot = true) => {
    recordRequestRef.current += 1
    detailRequestRef.current += 1
    recordAbortRef.current?.abort()
    detailAbortRef.current?.abort()
    recordAbortRef.current = null
    detailAbortRef.current = null
    if (!preserveSnapshot) {
      setItems([])
      setTotal(0)
      setStats(null)
      setRecordMeta(null)
      setRecordsLoaded(false)
      setLoadedViewKey('')
      setSelectedConversationId('')
      setSelectedMessageId('')
      setWorkflowDetail(null)
      setDetailError('')
      setLoadingDetail(false)
    }
    setActionMessage('')
    setLoadError('')
    setLoading(true)
  }

  useEffect(() => {
    if (pathname !== '/conversation-records') return
    const incomingSearch = searchParamString
    if (incomingSearch === writtenSearchRef.current) return
    writtenSearchRef.current = incomingSearch
    applyingUrlStateRef.current = true
    const incomingParams = new URLSearchParams(incomingSearch)
    const incomingView = incomingParams.get('view') as ConversationRecordView
    const nextView = VIEW_IDS.includes(incomingView) ? incomingView : 'history'
    const nextKeyword = incomingParams.get('keyword') || ''
    const nextRating = incomingParams.get('rating')
    const nextRunKind = incomingParams.get('run_kind') as ConversationRunKind
    const requestedPage = Number(incomingParams.get('page') || 1)
    const requestedSize = Number(incomingParams.get('size') || 20)
    invalidateRecordView(nextView === activeViewRef.current)
    setActiveView(nextView)
    setKeyword(nextKeyword)
    setDebouncedKeyword(nextKeyword.trim())
    setSearchSettled(true)
    setRatingFilter(nextRating === 'like' || nextRating === 'dislike' ? nextRating : '')
    setRunKind(RUN_KIND_OPTIONS.some((option) => option.value === nextRunKind) ? nextRunKind : '')
    setPage(Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1)
    setPageSize([10, 20, 50].includes(requestedSize) ? requestedSize : 20)
    setStartDate(toDateInputValue(Number(incomingParams.get('start_time')) || undefined))
    setEndDate(toDateInputValue(Number(incomingParams.get('end_time')) || undefined))
    setSelectedConversationId(nextView === 'history' ? incomingParams.get('conversationId') || '' : '')
    setSelectedMessageId(nextView !== 'history' ? incomingParams.get('messageId') || '' : '')
  }, [pathname, searchParamString])

  useEffect(() => {
    if (pathname !== '/conversation-records') return
    if (applyingUrlStateRef.current) {
      applyingUrlStateRef.current = false
      return
    }
    const query = new URLSearchParams()
    if (activeView !== 'history') query.set('view', activeView)
    if (keyword.trim()) query.set('keyword', keyword.trim())
    if (activeView === 'feedback' && ratingFilter) query.set('rating', ratingFilter)
    if (startDate) query.set('start_time', String(fromDateInputValue(startDate) || ''))
    if (endDate) query.set('end_time', String(fromDateInputValue(endDate) || ''))
    if (activeView === 'runs' && runKind) query.set('run_kind', runKind)
    if (page !== 1) query.set('page', String(page))
    if (pageSize !== 20) query.set('size', String(pageSize))
    if (activeView === 'history' && selectedConversationId) query.set('conversationId', selectedConversationId)
    if (activeView !== 'history' && selectedMessageId) query.set('messageId', selectedMessageId)
    const nextQuery = query.toString()
    writtenSearchRef.current = nextQuery
    window.history.replaceState(window.history.state, '', `${pathname}${nextQuery ? `?${nextQuery}` : ''}`)
  }, [activeView, endDate, keyword, page, pageSize, pathname, ratingFilter, runKind, selectedConversationId, selectedMessageId, startDate])

  const loadRecords = useCallback(async (force = false) => {
    if (!searchSettled || keyword.trim() !== debouncedKeyword) return false
    const requestedStartTime = fromDateInputValue(startDate)
    const requestedEndTime = fromDateInputValue(endDate)
    if (requestedStartTime && requestedEndTime && requestedStartTime > requestedEndTime) {
      setLoadError('开始时间不能晚于结束时间，请调整查询范围。')
      setLoading(false)
      return false
    }
    recordAbortRef.current?.abort()
    const requestId = ++recordRequestRef.current
    const controller = new AbortController()
    recordAbortRef.current = controller
    setLoading(true)
    try {
      const res = await getConversationRecords({
        view: activeView,
        keyword: debouncedKeyword,
        rating: activeView === 'feedback' ? ratingFilter : '',
        runKind: activeView === 'runs' ? runKind : '',
        startTime: requestedStartTime,
        endTime: requestedEndTime,
        page,
        size: pageSize,
        groupConversations: activeView === 'history',
        refresh: force,
      }, controller.signal)
      if (recordRequestRef.current !== requestId) return false
      setLoadError('')
      setItems(res.items || [])
      setTotal(res.total || 0)
      setStats(res.snapshot_stats || res.stats || EMPTY_STATS)
      setRecordMeta(res.meta || null)
      setRecordsLoaded(true)
      setLoadedPage(res.page || page)
      setLoadedPageSize(res.size || pageSize)
      setLoadedViewKey(recordViewKey({
        view: activeView,
        keyword: debouncedKeyword,
        rating: ratingFilter,
        runKind,
        startDate,
        endDate,
        page: res.page || page,
        size: res.size || pageSize,
      }))
      if (res.page && res.page !== page) setPage(res.page)
      return true
    } catch (err) {
      if (controller.signal.aborted) return false
      if (recordRequestRef.current === requestId) {
        setLoadError(businessErrorMessage(err, { fallback: '会话与运行记录加载失败', service: '会话与运行记录' }))
      }
      return false
    } finally {
      if (recordAbortRef.current === controller) recordAbortRef.current = null
      if (recordRequestRef.current === requestId) setLoading(false)
    }
  }, [activeView, debouncedKeyword, endDate, keyword, page, pageSize, ratingFilter, runKind, searchSettled, startDate])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedKeyword(keyword.trim())
      setSearchSettled(true)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [keyword])

  useEffect(() => {
    void loadRecords()
  }, [loadRecords])

  useEffect(() => () => {
    recordRequestRef.current += 1
    detailRequestRef.current += 1
    exportRequestRef.current += 1
    feedbackRequestRef.current += 1
    deleteRequestRef.current += 1
    mutationReconcileRef.current += 1
    recordAbortRef.current?.abort()
    detailAbortRef.current?.abort()
    exportAbortRef.current?.abort()
    feedbackAbortRef.current?.abort()
    deleteAbortRef.current?.abort()
    if (mutationReconcileTimerRef.current !== null) window.clearTimeout(mutationReconcileTimerRef.current)
    exportInFlightRef.current = 0
    feedbackInFlightRef.current = ''
    deleteInFlightRef.current = ''
  }, [])

  useEffect(() => {
    invalidateExport()
    invalidateFeedback()
    setActionMessage('')
  }, [activeView, endDate, keyword, ratingFilter, runKind, startDate])

  const groupedConversations = useMemo<GroupedConversation[]>(() => {
    const map = new Map<string, GroupedConversation>()
    items.forEach((item) => {
      const existing = map.get(item.conversation_id)
      if (!existing) {
        map.set(item.conversation_id, {
          id: item.conversation_id,
          name: item.conversation_name || '新对话',
          latestAt: item.created_at,
          messageCount: 1,
          items: [item],
        })
        return
      }
      existing.items.push(item)
      existing.messageCount += 1
      existing.latestAt = Math.max(existing.latestAt, item.created_at)
    })
    return [...map.values()]
      .map((group) => ({
        ...group,
        items: [...group.items].sort((a, b) => a.created_at - b.created_at),
      }))
      .sort((a, b) => b.latestAt - a.latestAt)
  }, [items])

  useEffect(() => {
    if (recordsLoaded && !snapshotMatchesView) {
      setSelectedConversationId('')
      setSelectedMessageId('')
      return
    }
    if (activeView === 'history') {
      const nextConversationId = groupedConversations.some((group) => group.id === selectedConversationId)
        ? selectedConversationId
        : groupedConversations[0]?.id || ''
      setSelectedConversationId(nextConversationId)
      setSelectedMessageId('')
      return
    }

    const target = items.find((item) => item.message_id === selectedMessageId)
    setSelectedMessageId(target?.message_id || items[0]?.message_id || '')
  }, [activeView, groupedConversations, items, recordsLoaded, selectedConversationId, selectedMessageId, snapshotMatchesView])

  const selectedConversation = useMemo(
    () => groupedConversations.find((group) => group.id === selectedConversationId) || null,
    [groupedConversations, selectedConversationId]
  )

  const selectedRecord = useMemo(
    () => items.find((item) => item.message_id === selectedMessageId) || null,
    [items, selectedMessageId]
  )

  const currentConversationId = selectedConversation?.id
    || (selectedRecord && !selectedRecord.conversation_id.startsWith('operation-log-')
      ? selectedRecord.conversation_id
      : '')
  const canDeleteCurrentConversation = Boolean(currentConversationId && snapshotMatchesView)
  const exportUnavailableTitle = !snapshotMatchesView
    ? '等待当前筛选结果读取完成后再导出'
    : total === 0
      ? '当前筛选结果没有可导出的记录'
      : ''
  const currentConversationUnavailableTitle = !snapshotMatchesView
    ? '等待当前筛选结果读取完成后再操作'
    : !currentConversationId
      ? '请先选择一条会话记录'
      : ''
  const deletingConversationName = groupedConversations.find((group) => group.id === deletingConversationId)?.name
    || items.find((item) => item.conversation_id === deletingConversationId)?.conversation_name
    || '当前会话'

  useEffect(() => {
    invalidateExport()
    invalidateFeedback()
    setActionMessage('')
  }, [currentConversationId, selectedMessageId])

  const selectedRecordMarkedAbnormal = selectedRecord?.feedback?.rating === 'dislike'
  const selectedRecordFeedbackSupported = Boolean(selectedRecord?.feedback_supported)
  const selectedRecordAbnormal = recordIsAbnormal(selectedRecord, workflowDetail?.error)
  const selectedRecordMissingRunSummary = Boolean(
    selectedRecord
    && selectedRecord.record_kind !== 'conversation_message'
    && !selectedRecord.answer.trim()
    && !selectedRecordAbnormal
  )
  const selectedRecordPhysicalPending = recordPhysicalPending(selectedRecord)

  const downloadRecords = async (format: 'json' | 'csv', conversationId = '') => {
    const mode = conversationId ? 'current' : format
    if (exportInFlightRef.current) return
    if (!snapshotMatchesView) {
      setActionMessage('当前筛选结果尚未成功读取，不能按旧快照下载或导出。')
      return
    }
    const requestId = ++exportRequestRef.current
    const controller = new AbortController()
    exportInFlightRef.current = requestId
    exportAbortRef.current = controller
    setExporting(mode)
    try {
      const result = await exportConversationRecords({
        view: conversationId ? 'history' : activeView,
        keyword: conversationId ? '' : keyword.trim(),
        conversationId,
        rating: conversationId || activeView !== 'feedback' ? '' : ratingFilter,
        runKind: conversationId || activeView !== 'runs' ? '' : runKind,
        startTime: conversationId ? undefined : fromDateInputValue(startDate),
        endTime: conversationId ? undefined : fromDateInputValue(endDate),
        format,
      }, controller.signal)
      if (exportRequestRef.current !== requestId) return
      if (!result.count) {
        setActionMessage('当前筛选结果为空，暂无可导出记录')
        return
      }
      const url = URL.createObjectURL(result.blob)
      const link = document.createElement('a')
      link.href = url
      link.download = result.filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      setActionMessage(
        `已导出当前筛选快照中的 ${result.count} 条记录`
        + (result.truncated ? '；导出上限之外的记录未包含' : '')
        + (result.snapshotTruncated ? '；源快照覆盖范围有限，文件中已附带覆盖说明' : ''),
      )
    } catch (error) {
      if (controller.signal.aborted) return
      if (exportRequestRef.current === requestId) {
        setActionMessage(businessErrorMessage(error, { fallback: '记录导出失败', service: '会话记录导出' }))
      }
    } finally {
      if (exportInFlightRef.current === requestId) {
        exportInFlightRef.current = 0
        exportAbortRef.current = null
      }
      if (exportRequestRef.current === requestId) setExporting('')
    }
  }

  const exportCurrentConversation = () => {
    if (!currentConversationId) {
      setActionMessage('请先选择一个会话')
      return
    }
    void downloadRecords('json', currentConversationId)
  }

  const mutationResultUncertain = (error: unknown) => (
    error instanceof ApiError && error.status === 0
    || error instanceof Error && /超时|网络中断|无法连接|network|timeout|connection reset/i.test(error.message)
  )

  const reconcileRecordView = () => {
    const reconcileId = ++mutationReconcileRef.current
    if (mutationReconcileTimerRef.current !== null) window.clearTimeout(mutationReconcileTimerRef.current)
    void loadRecords(true).finally(() => {
      if (mutationReconcileRef.current !== reconcileId) return
      mutationReconcileTimerRef.current = window.setTimeout(() => {
        if (mutationReconcileRef.current !== reconcileId) return
        mutationReconcileTimerRef.current = null
        void loadRecords(true)
      }, 1200)
    })
  }

  const cancelFeedbackWait = () => {
    if (!feedbackInFlightRef.current) return
    feedbackRequestRef.current += 1
    feedbackAbortRef.current?.abort()
    feedbackAbortRef.current = null
    feedbackInFlightRef.current = ''
    setMarkingMessageId('')
    setActionMessage('已取消等待异常标记；Dify 可能已经保存，正在重新读取当前筛选结果')
    reconcileRecordView()
  }

  const markSelectedRecordAbnormal = async () => {
    if (!snapshotMatchesView || !selectedRecord?.message_id || !selectedRecord.feedback_supported || selectedRecord.feedback?.rating === 'dislike' || feedbackInFlightRef.current) return
    const messageId = selectedRecord.message_id
    const feedback = {
      rating: 'dislike' as const,
      content: '异常会话标记：需复核回答、运行记录或外部系统状态。',
    }
    const requestId = ++feedbackRequestRef.current
    const controller = new AbortController()
    feedbackInFlightRef.current = messageId
    feedbackAbortRef.current = controller
    setMarkingMessageId(messageId)
    try {
      await submitMessageFeedback(messageId, feedback.rating, feedback.content, controller.signal)
      if (feedbackRequestRef.current !== requestId) return
      setActionMessage('已标记为异常/待复核')
      setItems((current) => activeView === 'feedback' && ratingFilter === 'like'
        ? current.filter((item) => item.message_id !== messageId)
        : current.map((item) => item.message_id === messageId ? { ...item, feedback } : item))
      if (activeView === 'feedback' && ratingFilter === 'like') {
        setTotal((current) => Math.max(0, current - 1))
      }
    } catch (error) {
      if (controller.signal.aborted) return
      if (feedbackRequestRef.current === requestId) {
        if (mutationResultUncertain(error)) {
          setActionMessage('异常标记结果暂时无法确认，正在重新读取当前筛选结果，请勿立即重复提交')
          reconcileRecordView()
          return
        }
        setActionMessage(businessErrorMessage(error, { fallback: '异常标记失败，请检查 Dify 消息反馈接口', service: 'Dify 消息反馈' }))
      }
    } finally {
      if (feedbackInFlightRef.current === messageId) {
        feedbackInFlightRef.current = ''
        feedbackAbortRef.current = null
        setMarkingMessageId('')
      }
      if (feedbackRequestRef.current === requestId) {
        void loadRecords(true)
      }
    }
  }

  const deleteSelectedConversation = async () => {
    if (!deletingConversationId) return
    if (deleteInFlightRef.current) {
      deleteRequestRef.current += 1
      deleteAbortRef.current?.abort()
      deleteAbortRef.current = null
      deleteInFlightRef.current = ''
      setDeleting(false)
      setDeletingConversationId('')
      setActionMessage('已取消等待删除结果；会话可能已经删除，正在重新读取当前筛选结果')
      reconcileRecordView()
      return
    }
    if (!snapshotMatchesView) {
      setDeletingConversationId('')
      setActionMessage('当前筛选结果尚未成功读取，不能按旧快照删除会话。')
      return
    }
    const conversationId = deletingConversationId
    const requestId = ++deleteRequestRef.current
    const controller = new AbortController()
    deleteInFlightRef.current = conversationId
    deleteAbortRef.current = controller
    setDeleting(true)
    try {
      await deleteConversation(conversationId, controller.signal)
      if (deleteRequestRef.current !== requestId) return
      const removedCount = items.filter((item) => item.conversation_id === conversationId).length
      const nextItems = items.filter((item) => item.conversation_id !== conversationId)
      setItems(nextItems)
      setTotal((current) => Math.max(0, current - (activeView === 'history' ? 1 : removedCount)))
      setDeletingConversationId('')
      setSelectedConversationId('')
      setSelectedMessageId('')
      setActionMessage('已删除 Dify 会话记录')
      if (!nextItems.length && page > 1) setPage((current) => Math.max(1, current - 1))
    } catch (error) {
      if (!controller.signal.aborted && deleteRequestRef.current === requestId) {
        if (mutationResultUncertain(error)) {
          setDeletingConversationId('')
          setActionMessage('删除结果暂时无法确认，正在重新读取当前筛选结果，请勿立即重复提交')
          reconcileRecordView()
          return
        }
        setActionMessage(businessErrorMessage(error, { fallback: '删除失败，请检查 Dify 会话接口', service: 'Dify 会话' }))
      }
    } finally {
      if (deleteInFlightRef.current === conversationId) {
        deleteInFlightRef.current = ''
        deleteAbortRef.current = null
      }
      if (deleteRequestRef.current === requestId) setDeleting(false)
      if (deleteRequestRef.current === requestId && (page === 1 || items.some((item) => item.conversation_id !== conversationId))) {
        void loadRecords(true)
      }
    }
  }

  useEffect(() => {
    detailAbortRef.current?.abort()
    const requestId = ++detailRequestRef.current
    const controller = new AbortController()
    detailAbortRef.current = controller
    const force = forceDetailReloadRef.current
    forceDetailReloadRef.current = false
    async function loadDetail() {
      if (activeView !== 'runs' || !selectedRecord?.workflow_run_id) {
        if (detailAbortRef.current === controller) detailAbortRef.current = null
        setWorkflowDetail(null)
        setDetailError('')
        setLoadingDetail(false)
        return
      }
      try {
        setLoadingDetail(true)
        setDetailError('')
        setWorkflowDetail(null)
        const detail = await getWorkflowRunDetail(selectedRecord.workflow_run_id, controller.signal, force)
        if (detailRequestRef.current === requestId) setWorkflowDetail(detail)
      } catch (error) {
        if (controller.signal.aborted) return
        if (detailRequestRef.current === requestId) {
          setWorkflowDetail(null)
          setDetailError(businessErrorMessage(error, { fallback: '工作流详情加载失败', service: 'Dify 工作流' }))
        }
      } finally {
        if (detailAbortRef.current === controller) detailAbortRef.current = null
        if (detailRequestRef.current === requestId) setLoadingDetail(false)
      }
    }
    void loadDetail()
    return () => {
      controller.abort()
      if (detailAbortRef.current === controller) detailAbortRef.current = null
      detailRequestRef.current += 1
    }
  }, [activeView, detailReload, selectedRecord?.workflow_run_id])

  useEffect(() => {
    if (!loadError && !detailError) return
    const recoverFailedReads = () => {
      if (!navigator.onLine || document.visibilityState !== 'visible') return
      if (loadError && !recordAbortRef.current && !deleteInFlightRef.current && !feedbackInFlightRef.current) {
        void loadRecords(true)
      }
      if (detailError && !detailAbortRef.current && activeView === 'runs' && selectedRecord?.workflow_run_id) {
        forceDetailReloadRef.current = true
        setDetailReload((value) => value + 1)
      }
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
  }, [activeView, detailError, loadError, loadRecords, selectedRecord?.workflow_run_id])

  return (
    <div className="mx-auto max-w-7xl space-y-8">
      <div className="flex items-start justify-between gap-6">
        <div className="space-y-3">
          <h2 className="text-3xl font-black text-slate-900 dark:text-white">会话与运行记录</h2>
          <p className="text-sm font-medium leading-7 text-slate-500 dark:text-slate-400">
            支持历史查询、运行记录与调试、效果评估，统一管理当前登录用户的智能体会话数据。
          </p>
          <p className="text-xs font-semibold text-slate-400 dark:text-slate-500">
            {recordMeta?.generated_at ? `当前快照生成于 ${formatDateTime(recordMeta.generated_at)}` : loading ? '正在生成当前记录快照' : '记录快照尚未取得'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadRecords(true)}
          disabled={loading || !searchSettled || keyword.trim() !== debouncedKeyword}
          aria-label="刷新当前会话记录"
          title="刷新当前筛选结果"
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] border border-slate-200 bg-white text-slate-500 transition hover:border-blue-200 hover:text-blue-600 disabled:cursor-wait disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-slate-300"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="grid grid-cols-2 overflow-hidden rounded-[8px] border border-slate-100 bg-white shadow-sm xl:grid-cols-6 dark:border-white/[0.06] dark:bg-white/[0.03]">
        {[
          { label: recordMeta?.snapshot_truncated ? '已载入会话数' : '会话总数', value: recordsLoaded && recordMeta?.dify_available !== false ? stats?.conversation_count : undefined, accent: 'text-blue-600' },
          { label: recordMeta?.snapshot_truncated ? '已载入消息数' : '消息总数', value: recordsLoaded && recordMeta?.dify_available !== false ? stats?.message_count : undefined, accent: 'text-slate-900 dark:text-white' },
          { label: recordMeta?.snapshot_truncated ? '已载入评估数' : '已评估消息数', value: recordsLoaded && recordMeta?.dify_available !== false ? stats?.feedback_count : undefined, accent: 'text-emerald-600' },
          { label: recordMeta?.dify_available === false ? '平台运行记录数' : '最近运行记录数', value: recordsLoaded ? stats?.run_count : undefined, accent: 'text-purple-600' },
          { label: recordMeta?.snapshot_truncated ? '已载入待改进数' : '待改进数', value: recordsLoaded && recordMeta?.dify_available !== false ? stats?.negative_feedback_count : undefined, accent: 'text-rose-600' },
          { label: recordMeta?.dify_available === false ? '平台异常候选' : '异常候选', value: recordsLoaded ? stats?.abnormal_count : undefined, accent: 'text-amber-600' },
        ].map((card) => (
          <div key={card.label} className="flex min-h-[104px] flex-col justify-between border-b border-r border-slate-100 px-5 py-4 even:border-r-0 xl:border-b-0 xl:[&:nth-child(2n)]:border-r xl:last:border-r-0 dark:border-white/[0.06]">
            <p className="text-xs font-semibold leading-5 text-slate-500 dark:text-slate-400">{card.label}</p>
            <p className={`mt-2 text-3xl font-black ${card.accent}`}>{card.value ?? '—'}</p>
          </div>
        ))}
      </div>

      {recordsLoaded && recordMeta && (!recordMeta.dify_available || recordMeta.snapshot_truncated || recordMeta.message_load_error_count > 0) ? (
        <div className="border-l-2 border-amber-400 bg-amber-50 px-5 py-4 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
          <p className="font-black">当前记录快照不完整</p>
          <p className="mt-1 leading-6">
            {!recordMeta.dify_available
              ? `Dify 会话和评价暂不可读取${recordMeta.dify_error ? `：${recordDiagnostic(recordMeta.dify_error)}` : ''}；平台已落库的测试、设备控制和状态审计记录仍会保留。`
              : '会话与运行数据已读取，但当前快照达到读取范围上限。'}
            {recordMeta.conversation_has_more ? ` Dify 会话仅载入最近 ${recordMeta.conversation_limit} 个。` : ''}
            {recordMeta.message_truncated_conversations > 0 ? ` ${recordMeta.message_truncated_conversations} 个会话仍有更早消息未载入。` : ''}
            {recordMeta.local_run_has_more ? ` 平台运行日志仅载入最近 ${recordMeta.local_run_limit} 条。` : ''}
            {recordMeta.message_load_error_count > 0 ? ` 另有 ${recordMeta.message_load_error_count} 个会话的消息读取失败。` : ''}
          </p>
        </div>
      ) : null}

      {recordsLoaded && !snapshotMatchesView && !loading && !loadError ? (
        <div className="border-l-2 border-amber-400 bg-amber-50 px-5 py-3 text-xs font-bold text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
          当前展示的是上一次成功快照，正在等待当前筛选条件的读取结果；下载、导出、删除和异常标记暂不可用。
        </div>
      ) : null}

      <div className="rounded-2xl border border-slate-100 bg-white px-5 py-4 shadow-sm dark:border-white/[0.06] dark:bg-gradient-to-b dark:from-white/[0.06] dark:to-white/[0.02]">
        <div className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="min-w-0 space-y-2">
              <span className="text-xs font-bold text-slate-500 dark:text-slate-400">开始时间</span>
              <input
                type="datetime-local"
                aria-label="开始时间"
                aria-invalid={dateRangeInvalid}
                value={startDate}
                disabled={difyViewUnavailable}
                onChange={(e) => { invalidateRecordView(); setStartDate(e.target.value); setPage(1) }}
                className={`w-full rounded-[8px] border bg-slate-50 px-3 py-2 text-sm text-slate-700 outline-none transition focus:ring-2 disabled:cursor-not-allowed disabled:opacity-55 dark:bg-white/[0.05] dark:text-white ${dateRangeInvalid ? 'border-red-300 focus:border-red-400 focus:ring-red-100 dark:border-red-400/40' : 'border-slate-200 focus:border-blue-400 focus:ring-blue-100 dark:border-white/[0.08] dark:focus:border-blue-400 dark:focus:ring-blue-400/15'}`}
              />
            </label>
            <label className="min-w-0 space-y-2">
              <span className="text-xs font-bold text-slate-500 dark:text-slate-400">结束时间</span>
              <input
                type="datetime-local"
                aria-label="结束时间"
                aria-invalid={dateRangeInvalid}
                value={endDate}
                disabled={difyViewUnavailable}
                onChange={(e) => { invalidateRecordView(); setEndDate(e.target.value); setPage(1) }}
                className={`w-full rounded-[8px] border bg-slate-50 px-3 py-2 text-sm text-slate-700 outline-none transition focus:ring-2 disabled:cursor-not-allowed disabled:opacity-55 dark:bg-white/[0.05] dark:text-white ${dateRangeInvalid ? 'border-red-300 focus:border-red-400 focus:ring-red-100 dark:border-red-400/40' : 'border-slate-200 focus:border-blue-400 focus:ring-blue-100 dark:border-white/[0.08] dark:focus:border-blue-400 dark:focus:ring-blue-400/15'}`}
              />
            </label>
          </div>
          {dateRangeInvalid ? <p className="text-xs font-bold text-red-600 dark:text-red-300" role="alert">开始时间不能晚于结束时间，请调整查询范围。</p> : difyViewUnavailable ? <p className="text-xs font-semibold text-slate-400 dark:text-slate-500">当前视图依赖 Dify 会话数据，恢复连接后可调整时间范围。</p> : null}
          <div className="flex flex-col gap-3 border-t border-slate-100 pt-4 lg:flex-row lg:items-center lg:justify-between dark:border-white/[0.06]">
            <div className="grid gap-2 sm:grid-cols-2 lg:flex lg:flex-wrap">
              <button
              onClick={() => exporting === 'json' ? invalidateExport() : void downloadRecords('json')}
              disabled={(Boolean(exporting) && exporting !== 'json') || (!exporting && (!snapshotMatchesView || total === 0))}
              title={exporting === 'json' ? '取消当前 JSON 导出' : exporting ? '正在执行其他导出任务' : exportUnavailableTitle || '导出当前筛选范围的全部 JSON 记录'}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-[8px] bg-slate-900 px-4 text-sm font-black text-white disabled:cursor-wait disabled:opacity-50 dark:bg-white dark:text-slate-900"
            >
              {exporting === 'json' ? <><X size={16} /> 取消导出</> : <><Download size={16} /> 导出全部 JSON</>}
            </button>
            <button
              onClick={() => exporting === 'csv' ? invalidateExport() : void downloadRecords('csv')}
              disabled={(Boolean(exporting) && exporting !== 'csv') || (!exporting && (!snapshotMatchesView || total === 0))}
              title={exporting === 'csv' ? '取消当前 CSV 导出' : exporting ? '正在执行其他导出任务' : exportUnavailableTitle || '导出当前筛选范围的全部 CSV 记录'}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-[8px] bg-blue-600 px-4 text-sm font-black text-white disabled:cursor-wait disabled:opacity-50"
            >
              {exporting === 'csv' ? <><X size={16} /> 取消导出</> : <><Download size={16} /> 导出全部 CSV</>}
            </button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:flex lg:flex-wrap lg:justify-end">
              <button
              onClick={() => exporting === 'current' ? invalidateExport() : exportCurrentConversation()}
              disabled={(Boolean(exporting) && exporting !== 'current') || (!exporting && (!snapshotMatchesView || !currentConversationId))}
              title={exporting === 'current' ? '取消当前会话下载' : exporting ? '正在执行其他导出任务' : currentConversationUnavailableTitle || '下载当前会话'}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-[8px] bg-emerald-50 px-4 text-sm font-black text-emerald-700 disabled:opacity-40 dark:bg-emerald-500/10 dark:text-emerald-300"
            >
              {exporting === 'current' ? <><X size={16} /> 取消下载</> : <><Download size={16} /> 下载当前会话</>}
            </button>
            <button
              onClick={() => setDeletingConversationId(currentConversationId)}
              disabled={!canDeleteCurrentConversation}
              title={currentConversationUnavailableTitle || '删除当前会话'}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-[8px] bg-red-50 px-4 text-sm font-black text-red-600 disabled:opacity-40 dark:bg-red-500/10 dark:text-red-300"
            >
              <Trash2 size={16} /> 删除当前会话
            </button>
            </div>
          </div>
        </div>
        {actionMessage ? (
          <div className="mt-4 rounded-[8px] bg-slate-50 px-4 py-3 text-sm font-bold text-slate-600 dark:bg-white/[0.04] dark:text-slate-300">
            {actionMessage}
          </div>
        ) : null}
        {loadError && recordsLoaded ? (
          <div className="mt-4 rounded-[8px] bg-amber-50 px-4 py-3 text-sm font-bold text-amber-700 dark:bg-amber-500/10 dark:text-amber-200" role="alert">
            {loadError}
            {`，已保留上次成功读取的${items.length ? '记录' : '空结果'}${snapshotMatchesView ? '' : '；该快照不代表当前筛选或页码'}。`}
          </div>
        ) : null}
      </div>

      <div className="rounded-2xl border border-slate-100 bg-white shadow-sm dark:border-white/[0.06] dark:bg-gradient-to-b dark:from-white/[0.06] dark:to-white/[0.02]">
        <div className="border-b border-slate-100 px-8 py-6 dark:border-white/[0.06]">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex flex-wrap gap-3" role="tablist" aria-label="会话记录视图">
              {VIEW_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="tab"
                  id={`conversation-view-tab-${option.id}`}
                  data-tab-id={option.id}
                  aria-selected={activeView === option.id}
                  aria-controls="conversation-view-panel"
                  tabIndex={activeView === option.id ? 0 : -1}
                  onClick={() => { invalidateRecordView(false); setActiveView(option.id); setPage(1) }}
                  onKeyDown={(event) => handleTabListKeyDown(event, VIEW_IDS, activeView, (value) => { invalidateRecordView(false); setActiveView(value); setPage(1) })}
                  className={`rounded-[8px] px-5 py-2.5 text-sm font-bold transition-colors ${
                    activeView === option.id
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-white/[0.06] dark:text-slate-300 dark:hover:bg-white/[0.1]'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <div className="flex flex-col gap-3 sm:flex-row">
              <div className="relative min-w-[240px]">
                <Search size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  aria-label="搜索会话与运行记录"
                  value={keyword}
                  disabled={difyViewUnavailable}
                  onChange={(e) => {
                    invalidateRecordView()
                    setSearchSettled(false)
                    setKeyword(e.target.value)
                    setPage(1)
                  }}
                  placeholder="搜索会话名、提问或回复..."
                  className="w-full rounded-[8px] border border-slate-200 bg-slate-50 py-2.5 pl-11 pr-4 text-sm text-slate-900 outline-none focus:border-blue-400 disabled:cursor-not-allowed disabled:opacity-55 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-white"
                />
              </div>
              {activeView === 'runs' ? (
                <UnifiedSelect
                  ariaLabel="筛选运行记录类型"
                  value={runKind}
                  onChange={(value) => { invalidateRecordView(); setRunKind(value as ConversationRunKind); setPage(1) }}
                  options={RUN_KIND_OPTIONS}
                  size="sm"
                  className="w-full sm:w-48"
                />
              ) : null}
              {activeView === 'feedback' && (
                <div className="flex rounded-[8px] bg-slate-100 p-1 dark:bg-white/[0.06]">
                  {[
                    { value: '', label: '全部评估' },
                    { value: 'like', label: '好评' },
                    { value: 'dislike', label: '待改进' },
                  ].map((option) => (
                    <button
                      key={option.value || 'all'}
                      disabled={feedbackUnavailable}
                      onClick={() => { invalidateRecordView(); setRatingFilter(option.value as '' | 'like' | 'dislike'); setPage(1) }}
                      className={`rounded-[6px] px-4 py-2 text-xs font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                        ratingFilter === option.value
                          ? 'bg-white text-blue-600 shadow-sm dark:bg-slate-900'
                          : 'text-slate-500 dark:text-slate-400'
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <div id="conversation-view-panel" role="tabpanel" aria-labelledby={`conversation-view-tab-${activeView}`} className="grid grid-cols-1 grid-rows-[max-content_max-content] xl:min-h-[640px] xl:grid-cols-[360px_minmax(0,1fr)] xl:grid-rows-1">
          <div className="border-r border-slate-100 p-5 dark:border-white/[0.06]">
            {loading && recordsLoaded ? (
              <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-blue-600" role="status">
                <Loader2 size={13} className="animate-spin" />正在更新记录，当前暂时显示上次成功{items.length ? '快照' : '空结果'}{snapshotMatchesView ? '' : '；旧快照不代表当前条件'}
              </div>
            ) : null}
            <div className="records-scroll max-h-[640px] divide-y divide-slate-100 overflow-y-auto border-y border-slate-100 dark:divide-white/[0.06] dark:border-white/[0.06]">
              {!recordsLoaded && loading ? (
                <div className="flex items-center justify-center py-20 text-slate-400">
                  <div className="text-center">
                    <Loader2 size={24} className="mx-auto animate-spin" />
                    <p className="mt-3 text-sm font-semibold">正在读取会话与运行记录</p>
                  </div>
                </div>
              ) : !recordsLoaded && loadError ? (
                <div className="rounded-[8px] border border-dashed border-amber-200 px-6 py-12 text-center text-sm text-amber-700 dark:border-amber-500/20 dark:text-amber-300" role="alert">
                  <AlertTriangle className="mx-auto mb-3" size={24} />
                  <p className="font-black">会话与运行记录未取得</p>
                  <p className="mx-auto mt-2 max-w-sm break-words text-xs leading-5">{loadError}</p>
                  <p className="mt-1 text-xs text-amber-700/80 dark:text-amber-200/80">当前没有可展示的成功快照。</p>
                  <button
                    type="button"
                    onClick={() => void loadRecords(true)}
                    disabled={loading || dateRangeInvalid}
                    className="mt-4 inline-flex min-h-9 items-center justify-center gap-2 rounded-[6px] border border-amber-200 bg-white px-3 text-xs font-black text-amber-800 disabled:cursor-not-allowed disabled:opacity-50 dark:border-amber-400/20 dark:bg-white/[0.06] dark:text-amber-200"
                  >
                    <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
                    {loading ? '正在重新读取' : '重新读取记录'}
                  </button>
                </div>
              ) : activeView === 'history' ? (
                groupedConversations.length > 0 ? groupedConversations.map((group) => {
                  const active = group.id === selectedConversationId
                  return (
                    <button
                      key={group.id}
                      onClick={() => setSelectedConversationId(group.id)}
                      className={`w-full border-l-2 px-4 py-4 text-left transition-colors ${
                        active
                          ? 'border-l-blue-500 bg-blue-50/70 dark:bg-blue-500/10'
                          : 'border-l-transparent hover:bg-slate-50 dark:hover:bg-white/[0.04]'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-bold text-slate-900 dark:text-white" title={group.name}>{group.name}</p>
                          <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">{formatDateTime(group.latestAt)}</p>
                        </div>
                        <span className="inline-flex h-6 shrink-0 items-center rounded-full bg-white px-2.5 text-xs font-bold leading-none text-slate-500 shadow-sm dark:bg-slate-900 dark:text-slate-300">
                          {group.messageCount} 条
                        </span>
                      </div>
                    </button>
                  )
                }) : (
                  <div className="rounded-[8px] border border-dashed border-slate-200 px-6 py-12 text-center text-sm text-slate-400 dark:border-white/[0.08] dark:text-slate-500">
                    {recordMeta?.dify_available === false
                      ? 'Dify 会话历史暂不可读取，恢复连接后刷新即可查看。'
                      : snapshotMatchesView ? '暂无会话历史记录' : '上次成功快照中没有会话；该结果不代表当前筛选条件'}
                  </div>
                )
              ) : items.length > 0 ? items.map((item) => {
                const active = item.message_id === selectedMessageId
                const listStatus = activeView === 'runs' ? recordListStatus(item) : null
                return (
                  <button
                    key={item.message_id}
                    onClick={() => setSelectedMessageId(item.message_id)}
                    className={`w-full border-l-2 px-4 py-4 text-left transition-colors ${
                      active
                        ? 'border-l-blue-500 bg-blue-50/70 dark:bg-blue-500/10'
                        : 'border-l-transparent hover:bg-slate-50 dark:hover:bg-white/[0.04]'
                    }`}
                  >
                    <div>
                      <div className="flex min-w-0 items-start gap-2">
                        {activeView === 'runs' ? recordIsAbnormal(item) ? <AlertTriangle size={14} className="shrink-0 text-rose-500" /> : recordPhysicalPending(item) ? <AlertTriangle size={14} className="shrink-0 text-amber-500" /> : <Bug size={14} className="shrink-0 text-purple-500" /> : item.feedback?.rating === 'dislike' ? <ThumbsDown size={14} className="shrink-0 text-rose-500" /> : item.feedback?.rating === 'like' ? <ThumbsUp size={14} className="shrink-0 text-emerald-500" /> : <AlertTriangle size={14} className="shrink-0 text-slate-400" />}
                        <p className="line-clamp-2 min-w-0 text-sm font-bold leading-5 text-slate-900 dark:text-white" title={item.query || item.answer || item.conversation_name || '新记录'}>{item.query || item.answer || item.conversation_name || '新记录'}</p>
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-3 pl-[22px]">
                        {activeView === 'runs' ? (
                          <span className="min-w-0 truncate text-xs font-semibold text-slate-500 dark:text-slate-300" title={RUN_KIND_OPTIONS.find((option) => option.value === item.record_kind)?.label || (item.workflow_run_id ? '工作流' : '消息运行')}>{RUN_KIND_OPTIONS.find((option) => option.value === item.record_kind)?.label || (item.workflow_run_id ? '工作流' : '消息运行')}</span>
                        ) : (
                          <span className={`min-w-0 truncate text-xs font-semibold ${item.feedback?.rating === 'dislike' ? 'text-rose-600' : item.feedback?.rating === 'like' ? 'text-emerald-600' : 'text-slate-500'}`} title={item.feedback?.rating === 'dislike' ? '待改进' : item.feedback?.rating === 'like' ? '好评' : '未评价'}>
                            {item.feedback?.rating === 'dislike' ? '待改进' : item.feedback?.rating === 'like' ? '好评' : '未评价'}
                          </span>
                        )}
                        <span className="flex shrink-0 items-center gap-2">{listStatus ? <span className={`text-xs font-bold ${listStatus.className}`}>{listStatus.label}</span> : null}<span className="text-xs text-slate-400 dark:text-slate-500" title={formatDateTime(item.created_at)}>{formatDateTime(item.created_at)}</span></span>
                      </div>
                    </div>
                  </button>
                )
              }) : (
                <div className="rounded-[8px] border border-dashed border-slate-200 px-6 py-12 text-center text-sm text-slate-400 dark:border-white/[0.08] dark:text-slate-500">
                  {feedbackUnavailable
                    ? 'Dify 效果评估暂不可读取，恢复连接后刷新即可查看。'
                    : snapshotMatchesView ? '暂无匹配记录' : '上次成功快照中没有记录；该结果不代表当前筛选条件'}
                  {snapshotMatchesView && activeView === 'runs' ? '。完成一次智能体对话或智能体测试运行后，会显示消息级运行记录；Dify 返回工作流运行标识时再展示节点级调试详情。' : ''}
                </div>
              )}
            </div>
            {!recordsLoaded ? null : (activeView === 'history' || activeView === 'feedback') && recordMeta?.dify_available === false && (activeView === 'history' ? groupedConversations.length === 0 : items.length === 0) ? (
              <p className="mt-4 text-center text-xs font-bold text-slate-400 dark:text-slate-500">{activeView === 'history' ? '会话总数未取得' : '评估总数未取得'}</p>
            ) : (
              <Pagination
                page={loadedPage}
                pageSize={loadedPageSize}
                total={total}
                loading={loading && snapshotMatchesView}
                navigationDisabled={!snapshotMatchesView}
                onPageChange={(value) => { invalidateRecordView(); setPage(value) }}
                onPageSizeChange={(value) => { invalidateRecordView(); setPageSize(value); setPage(1) }}
                itemName={activeView === 'history' ? '个会话' : '条记录'}
                className="mt-4 px-0 pb-0"
              />
            )}
          </div>

          <div className="p-8">
            {activeView === 'history' ? (
              selectedConversation ? (
                <div className="space-y-6">
                  <div>
                    <p className="text-xs font-bold text-slate-500 dark:text-slate-400">历史查询</p>
                    <h3 className="mt-2 text-2xl font-black text-slate-900 dark:text-white">{selectedConversation.name}</h3>
                    <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">支持按会话维度查看历史消息流，满足会话与运行记录的历史查询能力。</p>
                  </div>
                  <div className="records-scroll max-h-[520px] space-y-4 overflow-y-auto pr-2">
                    {selectedConversation.items.map((item) => (
                      <div key={item.message_id} className="rounded-[8px] border border-slate-100 bg-white px-5 dark:border-white/[0.06] dark:bg-white/[0.03]">
                        <div className="border-b border-slate-100 py-4 dark:border-white/[0.06]">
                          <p className="text-xs font-bold text-slate-500 dark:text-slate-400">用户问题</p>
                          <p className={`mt-2 whitespace-pre-wrap break-words text-sm leading-7 ${item.query ? 'text-slate-700 dark:text-slate-300' : 'text-slate-400 dark:text-slate-500'}`}>{item.query || '该消息未记录用户问题'}</p>
                        </div>
                        <div className="border-b border-slate-100 py-4 dark:border-white/[0.06]">
                          <p className="text-xs font-bold text-slate-500 dark:text-slate-400">智能体回复</p>
                          {item.answer ? (
                            <ChatMarkdownRenderer content={item.answer} className="mt-2 text-slate-700 dark:text-slate-300" />
                          ) : (
                            <p className="mt-2 border-l-2 border-amber-300 pl-3 text-sm leading-7 text-amber-700 dark:text-amber-300">尚未收到智能体回复，可在智能体对话页重试该问题。</p>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center justify-between gap-3 py-3 text-xs text-slate-400 dark:text-slate-500">
                          <span>时间：{formatDateTime(item.created_at)}</span>
                          <details className="group/technical">
                            <summary className="cursor-pointer list-none rounded-full px-3 py-2 font-bold transition hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-white/[0.06] dark:hover:text-slate-200">
                              技术详情
                            </summary>
                            <TechnicalId value={item.message_id} label="消息技术标识" className="mt-2 min-w-[220px] max-w-sm" />
                          </details>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="flex h-full items-center justify-center text-slate-400 dark:text-slate-500">
                  选择左侧会话后可查看完整历史记录
                </div>
              )
            ) : selectedRecord ? (
              <div className="space-y-6">
                <div>
                  <p className="text-xs font-bold text-slate-500 dark:text-slate-400">{activeView === 'runs' ? '运行记录与调试' : '效果评估'}</p>
                  <h3 className="mt-2 text-2xl font-black text-slate-900 dark:text-white">{selectedRecord.conversation_name || '新对话'}</h3>
                  <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                    {activeView === 'runs'
                      ? '展示消息级运行记录、工作流详情、输入输出与错误信息。Dify 未返回工作流运行标识时仍可查看消息级记录。'
                      : '展示消息级效果评估结果、备注与原始回复内容。'}
                  </p>
                </div>

                <div className={`rounded-[8px] border px-5 py-4 ${selectedRecordAbnormal || selectedRecordPhysicalPending ? 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200' : 'border-emerald-100 bg-emerald-50 text-emerald-800 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-200'}`}>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-start gap-3">
                      <AlertTriangle size={18} className="mt-0.5 shrink-0" />
                      <div>
                        <p className="text-sm font-black">{selectedRecordAbnormal ? '异常/待复核候选' : selectedRecordPhysicalPending ? '命令已受理，等待现场确认' : '记录状态正常'}</p>
                        <p className="mt-1 text-xs leading-5 opacity-80">{selectedRecordPhysicalPending ? '平台已保存 Home Assistant 返回结果；物理设备是否动作仍需现场确认，不按成功实机记录统计。' : selectedRecordMissingRunSummary ? '该历史运行状态正常，但旧日志未保存返回摘要；缺失摘要不等同于执行失败。' : '判定口径：待改进反馈、消息空回复、明确失败状态或工作流错误；缺少工作流运行标识仅表示当前为消息级记录。'}</p>
                      </div>
                    </div>
                    {selectedRecordFeedbackSupported ? (
                      <button
                        onClick={markingMessageId === selectedRecord.message_id ? cancelFeedbackWait : markSelectedRecordAbnormal}
                        disabled={!snapshotMatchesView || (Boolean(markingMessageId) && markingMessageId !== selectedRecord.message_id) || selectedRecordMarkedAbnormal}
                        title={!snapshotMatchesView ? '当前筛选结果成功读取后才可标记' : undefined}
                        className="rounded-full bg-white/80 px-4 py-2 text-xs font-black text-amber-700 shadow-sm disabled:cursor-not-allowed disabled:opacity-60 dark:bg-slate-950/40 dark:text-amber-200"
                      >
                        {markingMessageId === selectedRecord.message_id ? <Loader2 size={14} className="mr-1 inline animate-spin" /> : null}
                        {markingMessageId === selectedRecord.message_id ? '取消等待' : selectedRecordMarkedAbnormal ? '已标记异常' : '标记异常'}
                      </button>
                    ) : (
                      <span className="inline-flex rounded-full bg-white/70 px-4 py-2 text-xs font-bold text-slate-500 shadow-sm dark:bg-slate-950/30 dark:text-slate-300" title="平台运行审计没有对应的 Dify 消息，异常状态由执行结果和运行日志判定">
                        平台审计记录
                      </span>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {[
                    { label: '创建时间', value: formatDateTime(selectedRecord.created_at) },
                    { label: activeView === 'feedback' ? '评估结果' : '运行状态', value: activeView === 'feedback' ? (selectedRecord.feedback?.rating === 'dislike' ? '待改进' : selectedRecord.feedback?.rating === 'like' ? '好评' : '未评价') : (runStatusLabel(workflowDetail?.status || selectedRecord.run_status) || (selectedRecord.workflow_run_id ? '工作流运行记录' : '消息级运行记录')) },
                  ].map((row) => (
                    <div key={row.label} className="rounded-[8px] border border-slate-100 bg-slate-50/70 px-4 py-3 dark:border-white/[0.06] dark:bg-white/[0.03]">
                      <p className="text-xs font-bold text-slate-500 dark:text-slate-400">{row.label}</p>
                      <p className="mt-2 break-all text-sm font-semibold leading-6 text-slate-900 dark:text-white">{String(row.value)}</p>
                    </div>
                  ))}
                </div>

                <details className="rounded-[8px] border border-slate-200 px-4 py-3 dark:border-white/[0.08]">
                  <summary className="cursor-pointer text-xs font-bold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">查看运行技术标识</summary>
                  <div className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
                    {[
                      { label: '会话标识', value: selectedRecord.conversation_id || '未返回' },
                      { label: '消息标识', value: selectedRecord.message_id || '未返回' },
                      { label: '工作流运行标识', value: selectedRecord.workflow_run_id || '未返回' },
                      { label: '任务标识', value: selectedRecord.task_id || '未返回' },
                    ].map((row) => <TechnicalId key={row.label} label={row.label} value={row.value === '未返回' ? '' : row.value} emptyText="未返回" />)}
                  </div>
                </details>

                <div className="rounded-[8px] border border-slate-100 bg-slate-50/70 p-5 dark:border-white/[0.06] dark:bg-white/[0.03]">
                    <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">原始回复内容</p>
                  {selectedRecord.answer ? (
                    <ChatMarkdownRenderer content={selectedRecord.answer} className="mt-3 text-slate-700 dark:text-slate-300" />
                  ) : selectedRecordMissingRunSummary ? (
                    <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-7 text-slate-700 dark:text-slate-300">该历史运行未保存返回摘要；可依据执行状态和技术标识复核，缺失摘要不代表运行失败。</p>
                  ) : (
                    <p className="mt-3 border-l-2 border-amber-300 pl-3 text-sm leading-7 text-amber-700 dark:text-amber-300">尚未收到智能体回复，该记录已作为异常候选保留。</p>
                  )}
                </div>

                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="rounded-[8px] border border-slate-100 bg-slate-50/70 p-5 dark:border-white/[0.06] dark:bg-white/[0.03]">
                    <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">{selectedRecord.record_source === 'dify_messages' || selectedRecord.record_source === 'dify_messages+operation_logs' ? '模型用量' : '运行元数据'}</p>
                    <UsageSummary value={selectedRecord.usage} isDifyRecord={selectedRecord.record_source === 'dify_messages' || selectedRecord.record_source === 'dify_messages+operation_logs'} />
                  </div>
                  <div className="rounded-[8px] border border-slate-100 bg-slate-50/70 p-5 dark:border-white/[0.06] dark:bg-white/[0.03]">
                    <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">知识检索引用</p>
                    <RetrievalSummary value={selectedRecord.retriever_resources} />
                  </div>
                </div>

                {activeView === 'feedback' ? (
                  <div className="rounded-[8px] border border-slate-100 bg-slate-50/70 p-5 dark:border-white/[0.06] dark:bg-white/[0.03]">
                    <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">效果评估备注</p>
                    <p className="mt-3 text-sm leading-7 text-slate-700 dark:text-slate-300">{selectedRecord.feedback?.content || '未填写评估备注'}</p>
                  </div>
                ) : selectedRecord.workflow_run_id ? (
                  <div className="rounded-[8px] border border-slate-100 bg-slate-50/70 p-5 dark:border-white/[0.06] dark:bg-white/[0.03]">
                    <div className="mb-4 flex items-center justify-between">
                      <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">工作流详情</p>
                      {loadingDetail && <Loader2 size={16} className="animate-spin text-blue-500" />}
                    </div>
                    {workflowDetail ? (
                      <div className="space-y-4">
                        {workflowDetail.error && (
                          <div className="rounded-[8px] bg-rose-50 px-4 py-3 text-sm text-rose-600">
                            {recordDiagnostic(workflowDetail.error)}
                          </div>
                        )}
                        <div className="grid grid-cols-1 overflow-hidden rounded-[8px] border border-slate-200 bg-white sm:grid-cols-3 dark:border-white/[0.08] dark:bg-white/[0.02]">
                          <div className="border-b border-slate-200 px-4 py-3 sm:border-b-0 sm:border-r dark:border-white/[0.08]">
                            <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">总步骤数</p>
                            <p className="mt-2 text-sm font-semibold text-slate-900 dark:text-white">{workflowDetail.total_steps ?? '—'}</p>
                          </div>
                          <div className="border-b border-slate-200 px-4 py-3 sm:border-b-0 sm:border-r dark:border-white/[0.08]">
                            <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">总 Token</p>
                            <p className="mt-2 text-sm font-semibold text-slate-900 dark:text-white">{workflowDetail.total_tokens ?? '—'}</p>
                          </div>
                          <div className="px-4 py-3">
                            <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">耗时</p>
                            <p className="mt-2 text-sm font-semibold text-slate-900 dark:text-white">{formatElapsedSeconds(workflowDetail.elapsed_time)}</p>
                          </div>
                        </div>
                        <details className="border-t border-slate-200 pt-3 dark:border-white/[0.08]">
                          <summary className="cursor-pointer text-xs font-bold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">查看原始工作流输入与输出</summary>
                          <div className="mt-3 space-y-3">
                            <div>
                              <p className="mb-2 text-xs font-semibold text-slate-500 dark:text-slate-400">输入</p>
                              <pre className="records-scroll max-h-40 overflow-auto rounded-[8px] bg-white px-4 py-3 text-xs leading-6 text-slate-700 dark:bg-slate-900 dark:text-slate-300">{JSON.stringify(workflowDetail.inputs ?? {}, null, 2)}</pre>
                            </div>
                            <div>
                              <p className="mb-2 text-xs font-semibold text-slate-500 dark:text-slate-400">输出</p>
                              <pre className="records-scroll max-h-40 overflow-auto rounded-[8px] bg-white px-4 py-3 text-xs leading-6 text-slate-700 dark:bg-slate-900 dark:text-slate-300">{JSON.stringify(workflowDetail.outputs ?? {}, null, 2)}</pre>
                            </div>
                          </div>
                        </details>
                      </div>
                    ) : detailError ? (
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <p className="text-sm leading-7 text-rose-600 dark:text-rose-300">{recordDiagnostic(detailError)}</p>
                        <button type="button" onClick={() => { forceDetailReloadRef.current = true; setDetailReload(value => value + 1) }} className="inline-flex min-h-9 shrink-0 items-center justify-center gap-2 rounded-lg border border-rose-200 bg-white px-3 text-xs font-bold text-rose-700 transition hover:bg-rose-50 dark:border-rose-400/20 dark:bg-white/[0.04] dark:text-rose-300">
                          <RefreshCw size={14} />重新读取详情
                        </button>
                      </div>
                    ) : (
                      <p className="text-sm leading-7 text-slate-500 dark:text-slate-400">
                        {loadingDetail ? '正在读取工作流详情...' : '当前尚未获取到工作流详情，请稍后重试。'}
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="rounded-[8px] border border-dashed border-slate-200 px-5 py-6 text-sm leading-7 text-slate-500 dark:border-white/[0.08] dark:text-slate-400">
                    当前消息未携带节点级运行标识，可查看会话记录与消息内容，但暂无工作流级运行详情。
                  </div>
                )}
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-slate-400 dark:text-slate-500">
                {feedbackUnavailable ? '恢复 Dify 连接后可查看评估详情' : '选择左侧记录后可查看详情'}
              </div>
            )}
          </div>
        </div>
      </div>

      {deletingConversationId ? (
        <AppDialog
          title="删除 Dify 会话记录"
          onClose={() => { if (!deleteInFlightRef.current) setDeletingConversationId('') }}
          maxWidth="max-w-md"
          danger
          closeOnOverlay={!deleting}
          showClose={!deleting}
          initialFocusRef={deleteCancelButtonRef}
          footer={(
            <div className="flex justify-end gap-3">
              <button ref={deleteCancelButtonRef} type="button" onClick={deleting ? deleteSelectedConversation : () => setDeletingConversationId('')} className="rounded-full px-5 py-2.5 text-sm font-black text-slate-500 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/[0.06]">
                {deleting ? '取消等待' : '取消'}
              </button>
              {!deleting ? (
                <button type="button" onClick={deleteSelectedConversation} className="inline-flex items-center gap-2 rounded-full bg-red-500 px-5 py-2.5 text-sm font-black text-white hover:bg-red-600">
                  确认删除
                </button>
              ) : null}
            </div>
          )}
        >
          <div className="space-y-5">
            <div className="flex items-start gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-300">
                <Trash2 size={20} />
              </div>
              <div>
                <p className="text-sm font-black text-slate-900 dark:text-white">{deletingConversationName}</p>
                <p className="text-sm leading-7 text-slate-500 dark:text-slate-400">
                  {deleting ? '删除请求正在处理。取消等待只停止当前页面等待，服务端仍可能完成删除，页面随后会自动复核。' : '该操作会调用 Dify 会话删除接口。建议先导出记录，再执行删除。'}
                </p>
              </div>
            </div>
            <div className="rounded-[8px] bg-slate-50 px-4 py-3 text-xs font-bold text-slate-500 dark:bg-white/[0.04] dark:text-slate-400">
              会话技术标识：{deletingConversationId}
            </div>
          </div>
        </AppDialog>
      ) : null}
    </div>
  )
}

export default function ConversationRecordsPage() {
  return (
    <Suspense fallback={<div className="mx-auto max-w-7xl py-20 text-center text-slate-400">加载会话与运行记录...</div>}>
      <ConversationRecordsContent />
    </Suspense>
  )
}
