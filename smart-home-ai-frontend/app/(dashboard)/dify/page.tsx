'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Database,
  ExternalLink,
  Eye,
  FileCode2,
  Loader2,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Workflow,
  XCircle,
} from 'lucide-react'
import { AppDialog } from '@/components/ui/AppDialog'
import { Pagination } from '@/components/ui/Pagination'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { TechnicalId } from '@/components/ui/TechnicalId'
import { UnifiedSelect } from '@/components/ui/UnifiedSelect'
import { agentsApi } from '@/lib/api/agents'
import { getAgentRuntimeOverview, type AgentRuntimeOverview } from '@/lib/api/chat'
import { fetchDatasets, type DatasetListResponse, type KnowledgeDataset } from '@/lib/api/knowledge'
import { settingsApi, testServiceConnection, type RuntimeSettings, type TestConnectionResult } from '@/lib/api/system'
import { toast } from '@/components/ui/toast'
import { useAuth } from '@/lib/hooks/useAuth'
import { businessErrorMessage } from '@/lib/ui/business-error'
import type {
  AgentInstanceListResponse,
  AgentRunListResponse,
  AgentRunRecord,
  AgentTemplateDoc,
} from '@/types/agents'

type ResourceKey = 'settings' | 'templates' | 'instances' | 'overview'

const RESOURCE_KEYS: ResourceKey[] = ['settings', 'templates', 'instances', 'overview']

const EMPTY_RESOURCE_LOADING: Record<ResourceKey, boolean> = {
  settings: true,
  templates: true,
  instances: true,
  overview: true,
}

const SECONDARY_BUTTON = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-white px-4 py-2 text-sm font-bold text-slate-700 shadow-sm shadow-slate-200/60 transition hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-60'

function useDebouncedValue<T>(value: T, delay = 300) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(timer)
  }, [delay, value])
  return debounced
}

function statusLabel(status?: string) {
  if (status === 'running') return '正常'
  if (status === 'degraded') return '部分可用'
  if (status === 'unconfigured') return '未配置'
  if (status === 'unavailable') return '不可用'
  if (status === 'disabled') return '已停用'
  if (status === 'mismatch') return '绑定不一致'
  if (status === 'error') return '异常'
  if (status === 'stopped') return '不可达'
  return '状态待确认'
}

function statusClass(status?: string) {
  if (status === 'running') return 'bg-emerald-50 text-emerald-700'
  if (status === 'degraded' || status === 'unconfigured' || status === 'mismatch') return 'bg-amber-50 text-amber-700'
  if (status === 'error' || status === 'unavailable') return 'bg-rose-50 text-rose-700'
  if (status === 'stopped') return 'bg-amber-50 text-amber-700'
  return 'bg-slate-50 text-slate-600'
}

function configSourceLabel(source?: string) {
  if (source === 'database_overrides') return '平台运行时配置'
  if (source === 'default_config') return '默认部署配置'
  return '尚未确认'
}

function instanceStatusLabel(status?: string) {
  if (status === 'running') return '配置已启用'
  if (status === 'ready') return '配置已就绪'
  if (status === 'draft') return '配置草稿'
  if (status === 'disabled') return '配置已停用'
  return '配置状态未确认'
}

function instanceTypeLabel(type?: string) {
  if (type === 'chatflow') return '对话流'
  if (type === 'workflow') return '工作流'
  return 'Dify 应用'
}

function formatDateTime(value?: string | number | null) {
  if (!value) return '暂无记录'
  const date = typeof value === 'number'
    ? new Date(value < 10_000_000_000 ? value * 1000 : value)
    : new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未取得' : date.toLocaleString('zh-CN', { hour12: false })
}

function formatCount(value?: number | null) {
  return value == null ? '未取得' : new Intl.NumberFormat('zh-CN').format(value)
}

function datasetScaleLabel(datasets: DatasetListResponse | null) {
  if (!datasets) return '读取失败'
  const documentTotal = datasets.summary?.document_total
  return `${datasets.total} / ${documentTotal == null ? '未取得' : documentTotal}`
}

function datasetSnapshotLabel(datasets: DatasetListResponse | null) {
  if (!datasets?.snapshot) return '快照时间未取得'
  const prefix = datasets.snapshot.stale ? '最近成功快照' : datasets.snapshot.status === 'fresh' ? '缓存快照' : '实时快照'
  return `${prefix} · ${formatDateTime(datasets.snapshot.snapshot_at)}`
}

function latencyLabel(value?: number | null) {
  return Number.isFinite(value) && Number(value) > 0 ? `${Math.round(Number(value))} 毫秒` : '耗时未取得'
}

function probeDurationLabel(status: string | undefined, value?: number | null) {
  const duration = latencyLabel(value)
  if (duration === '耗时未取得') return status === 'running' ? '响应用时未取得' : '探测用时未取得'
  return `${status === 'running' ? '响应' : '探测用时'} ${duration}`
}

function dependencyStatusLabel(status?: string) {
  if (status === 'running') return '运行中'
  if (status === 'degraded') return '部分可用'
  if (status === 'unconfigured') return '未配置'
  if (status === 'disabled') return '已停用'
  if (status === 'stopped' || status === 'offline' || status === 'unavailable' || status === 'failed' || status === 'error') return '不可达'
  return '状态待确认'
}

function serviceDetail(status?: string, error?: string | null, detail?: string | null) {
  const message = error?.trim() || detail?.trim()
  if (message) return externalErrorLabel(message)
  if (status === 'running') return '连接正常，服务已返回可用结果'
  if (status === 'degraded') return '部分能力可用，请结合链路诊断继续核对'
  if (status === 'unconfigured') return '服务尚未配置，请前往系统设置补充连接信息'
  if (status === 'disabled') return '服务当前已停用'
  if (status === 'mismatch') return '应用绑定与运行配置不一致，请检查实例配置'
  if (status === 'stopped' || status === 'unavailable') return '当前无法连接服务，请检查服务状态和网络'
  return '尚未取得可判断的服务状态'
}

function externalErrorLabel(value?: string | null) {
  const message = value?.trim() || ''
  if (!message) return '状态详情未返回'
  if (/server disconnected/i.test(message)) return '远端服务已断开连接，请检查服务状态和网络'
  if (/all connection attempts failed|connection refused|connecterror/i.test(message)) return '远端服务无法建立连接，请检查服务地址和网络'
  if (/connecttimeout|readtimeout|timed out|timeout/i.test(message)) return '远端服务连接超时，请检查服务状态和网络'
  if (/401|403|unauthorized|forbidden|authentication/i.test(message)) return 'Dify 认证失败，请检查应用 API 密钥和访问权限'
  if (/404|not found/i.test(message)) return 'Dify 应用或接口不存在，请检查应用绑定和服务地址'
  if (/500|502|503|504|internal server error|bad gateway|service unavailable/i.test(message)) return 'Dify 服务返回异常，请检查应用运行状态和服务日志'
  if (/https?:\/\/|traceback|exception|\b[a-z]+error\b/i.test(message)) return 'Dify 调用失败，请检查应用配置和运行日志'
  return /[\u4e00-\u9fff]/.test(message) ? message : 'Dify 调用失败，请检查应用配置和运行日志'
}

function runErrorLabel(value?: string | null) {
  return externalErrorLabel(value) || 'Dify 运行失败，请检查应用配置和运行日志'
}

function serviceName(key: string) {
  if (key === 'dify') return 'Dify 应用 API'
  if (key === 'knowledge') return '知识库 API'
  if (key === 'home_assistant') return 'Home Assistant'
  return '其他依赖服务'
}

function groupServiceDiagnostics(items: Array<{ name: string; message: string }>) {
  const grouped = new Map<string, string[]>()
  items.forEach(({ name, message }) => {
    const names = grouped.get(message) || []
    if (!names.includes(name)) names.push(name)
    grouped.set(message, names)
  })
  return Array.from(grouped, ([message, names]) => `${names.join('、')}：${message}`)
}

function runStatusLabel(status?: string) {
  const labels: Record<string, string> = {
    success: '执行成功',
    succeeded: '执行成功',
    completed: '已完成',
    failed: '执行失败',
    error: '执行失败',
    running: '执行中',
    pending: '等待执行',
    warning: '待复核',
    canceled: '已取消',
    cancelled: '已取消',
    stopped: '已停止',
    never: '尚未执行',
  }
  return status ? labels[status.toLowerCase()] || '状态待确认' : '状态待确认'
}

function runStatusBadgeStatus(status?: string) {
  const normalized = String(status || '').toLowerCase()
  if (['success', 'succeeded', 'completed'].includes(normalized)) return 'success'
  if (['failed', 'error'].includes(normalized)) return 'error'
  if (['running'].includes(normalized)) return 'running'
  if (['pending', 'warning', 'canceled', 'cancelled', 'stopped'].includes(normalized)) return 'warning'
  return 'unknown'
}

function runViewKey(keyword: string, status: string, page: number, pageSize: number) {
  return JSON.stringify({ keyword: keyword.trim(), status, page, pageSize })
}

function datasetViewKey(keyword: string, page: number, pageSize: number) {
  return JSON.stringify({ keyword: keyword.trim(), page, pageSize })
}

function indexLabel(value?: string) {
  if (value === 'high_quality') return '高质量索引'
  if (value === 'economy') return '经济型索引'
  return value ? '其他索引方式' : '索引方式未知'
}

function embeddingModelLabel(value?: string | null) {
  if (!value) return '模型信息未取得'
  if (value === 'multimodal-embedding-v1') return '多模态向量模型'
  return '其他向量模型'
}

function permissionLabel(value?: string) {
  if (value === 'all_team_members') return '团队成员可用'
  if (value === 'only_me') return '仅创建者可用'
  if (value === 'partial_members') return '指定成员可用'
  return '权限未识别'
}

function knownIndexingTechnique(value?: string) {
  return !value || value === 'high_quality' || value === 'economy'
}

function knownDatasetPermission(value?: string) {
  return !value || value === 'all_team_members' || value === 'only_me' || value === 'partial_members'
}

function datasetDescription(dataset: KnowledgeDataset) {
  if (dataset.description && !/^useful for when you want to answer queries about/i.test(dataset.description)) {
    return dataset.description
  }
  return `未填写业务说明 · ${permissionLabel(dataset.permission)}`
}

function runEvidence(item: AgentRunRecord) {
  if (item.error) return runErrorLabel(item.error)
  if (item.workflowRunId) return '已取得 Dify 工作流运行标识'
  if (item.messageId) return '已取得 Dify 消息标识'
  return '仅保留平台测试审计'
}

function overviewCoverageLabel(overview: AgentRuntimeOverview) {
  if (!overview.coverage) return '统计范围未返回'
  if (overview.coverage.complete) return '完整快照'
  const reasons = []
  if (overview.coverage.dify_records_available === false) reasons.push('Dify 会话记录未取得')
  if (overview.coverage.knowledge_available === false) reasons.push('知识库状态未取得')
  if (overview.coverage.home_assistant_available === false) reasons.push('Home Assistant 状态未取得')
  if (overview.coverage.conversation_has_more) reasons.push('仍有会话未载入')
  if (overview.coverage.message_truncated_conversations) reasons.push(`${overview.coverage.message_truncated_conversations} 个会话仍有更早消息`)
  if (overview.coverage.message_load_error_count) reasons.push(`${overview.coverage.message_load_error_count} 个会话读取失败`)
  return reasons.length ? `部分快照：${reasons.join('，')}` : '部分快照'
}

function buildConsoleUrl(baseUrl?: string) {
  if (!baseUrl) return ''
  try {
    const url = new URL(baseUrl)
    if (url.port === '5001') url.port = ''
    url.pathname = '/apps'
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    const trimmed = baseUrl.replace(/\/+$/, '').replace(':5001', '')
    return trimmed.endsWith('/apps') ? trimmed : `${trimmed}/apps`
  }
}

function DifyContent() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { isAdmin } = useAuth()
  const [settings, setSettings] = useState<RuntimeSettings | null>(null)
  const [templates, setTemplates] = useState<AgentTemplateDoc[]>([])
  const [instances, setInstances] = useState<AgentInstanceListResponse | null>(null)
  const [overview, setOverview] = useState<AgentRuntimeOverview | null>(null)
  const [datasets, setDatasets] = useState<DatasetListResponse | null>(null)
  const [runs, setRuns] = useState<AgentRunListResponse | null>(null)
  const [runsLoaded, setRunsLoaded] = useState(false)
  const [loadedRunViewKey, setLoadedRunViewKey] = useState('')
  const [loadedRunPage, setLoadedRunPage] = useState(1)
  const [loadedRunSize, setLoadedRunSize] = useState(10)
  const [connection, setConnection] = useState<TestConnectionResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [resourceLoading, setResourceLoading] = useState<Record<ResourceKey, boolean>>(EMPTY_RESOURCE_LOADING)
  const [testing, setTesting] = useState(false)
  const [resourceErrors, setResourceErrors] = useState<Partial<Record<ResourceKey, string>>>({})
  const [runsLoading, setRunsLoading] = useState(true)
  const [runsError, setRunsError] = useState('')
  const initialDatasetPage = Number(searchParams.get('datasetPage') || 1)
  const initialDatasetSize = Number(searchParams.get('datasetSize') || 6)
  const [datasetPage, setDatasetPage] = useState(Number.isInteger(initialDatasetPage) && initialDatasetPage > 0 ? initialDatasetPage : 1)
  const [datasetSize, setDatasetSize] = useState([6, 12, 24].includes(initialDatasetSize) ? initialDatasetSize : 6)
  const [datasetKeyword, setDatasetKeyword] = useState(searchParams.get('datasetQ') || '')
  const [datasetsLoaded, setDatasetsLoaded] = useState(false)
  const [datasetsLoading, setDatasetsLoading] = useState(true)
  const [datasetsError, setDatasetsError] = useState('')
  const [loadedDatasetViewKey, setLoadedDatasetViewKey] = useState('')
  const [loadedDatasetPage, setLoadedDatasetPage] = useState(1)
  const [loadedDatasetSize, setLoadedDatasetSize] = useState(6)
  const initialRunPage = Number(searchParams.get('runPage') || 1)
  const initialRunSize = Number(searchParams.get('runSize') || 10)
  const initialRunStatus = searchParams.get('runStatus') || ''
  const [runPage, setRunPage] = useState(Number.isInteger(initialRunPage) && initialRunPage > 0 ? initialRunPage : 1)
  const [runSize, setRunSize] = useState([10, 20, 50].includes(initialRunSize) ? initialRunSize : 10)
  const [runKeyword, setRunKeyword] = useState(searchParams.get('runQ') || '')
  const [runStatus, setRunStatus] = useState(['success', 'failed'].includes(initialRunStatus) ? initialRunStatus : '')
  const [selectedRun, setSelectedRun] = useState<AgentRunRecord | null>(null)
  const [selectedDataset, setSelectedDataset] = useState<KnowledgeDataset | null>(null)
  const dataRequestRef = useRef(0)
  const datasetsRequestRef = useRef(0)
  const runsRequestRef = useRef(0)
  const testRequestRef = useRef(0)
  const testInFlightRef = useRef(false)
  const testAbortControllerRef = useRef<AbortController | null>(null)
  const testReconcileSequenceRef = useRef(0)
  const testReconcileTimerRef = useRef<number | null>(null)
  const dataAbortRef = useRef<AbortController | null>(null)
  const datasetsAbortRef = useRef<AbortController | null>(null)
  const runsAbortRef = useRef<AbortController | null>(null)
  const writtenSearchRef = useRef(searchParams.toString())
  const debouncedRunKeyword = useDebouncedValue(runKeyword.trim())
  const debouncedDatasetKeyword = useDebouncedValue(datasetKeyword.trim())
  const currentRunViewKey = runViewKey(debouncedRunKeyword, runStatus, runPage, runSize)
  const runSnapshotMatchesView = Boolean(
    runsLoaded
    && runKeyword.trim() === debouncedRunKeyword
    && loadedRunViewKey === currentRunViewKey
  )
  const currentDatasetViewKey = datasetViewKey(debouncedDatasetKeyword, datasetPage, datasetSize)
  const datasetSnapshotMatchesView = Boolean(
    datasetsLoaded
    && datasetKeyword.trim() === debouncedDatasetKeyword
    && loadedDatasetViewKey === currentDatasetViewKey
  )

  const difyService = settings?.services?.dify

  const loadData = useCallback(async (force = false, requestedKeys: ResourceKey[] = RESOURCE_KEYS) => {
    const keys = requestedKeys.length ? Array.from(new Set(requestedKeys)) : RESOURCE_KEYS
    dataAbortRef.current?.abort()
    const controller = new AbortController()
    dataAbortRef.current = controller
    const requestId = ++dataRequestRef.current
    if (!force) setLoading(true)
    if (!force) setResourceErrors({})
    setResourceLoading((current) => keys.reduce(
      (next, key) => ({ ...next, [key]: true }),
      { ...current },
    ))
    let revealed = false
    const reveal = () => {
      if (revealed || dataRequestRef.current !== requestId) return
      revealed = true
      setLoading(false)
    }
    const loadResource = async <T,>(
      key: ResourceKey,
      label: string,
      loader: () => Promise<T>,
      setter: (value: T) => void,
    ) => {
      try {
        const value = await loader()
        if (dataRequestRef.current !== requestId) return null
        setter(value)
        reveal()
        return null
      } catch (reason) {
        if (dataRequestRef.current !== requestId) return null
        return [key, `${label}：${businessErrorMessage(reason, { fallback: '读取失败', service: label })}`] as const
      } finally {
        if (dataRequestRef.current === requestId) {
          setResourceLoading((current) => ({ ...current, [key]: false }))
        }
      }
    }
    try {
      const loaders: Record<ResourceKey, () => Promise<readonly [ResourceKey, string] | null>> = {
        settings: () => loadResource('settings', '运行配置', () => settingsApi.config(force, controller.signal), setSettings),
        templates: () => loadResource('templates', '模板说明', () => agentsApi.getTemplates(force, controller.signal), setTemplates),
        instances: () => loadResource(
          'instances',
          '应用实例',
          () => agentsApi.listInstances({
            page: 1,
            pageSize: 1,
            primaryOnly: true,
            refreshRuntime: force,
          }, force, controller.signal),
          setInstances,
        ),
        overview: () => loadResource('overview', '运行概览', () => getAgentRuntimeOverview(force, controller.signal), setOverview),
      }
      const failures = (await Promise.all(keys.map((key) => loaders[key]()))).filter((item): item is readonly [ResourceKey, string] => Boolean(item))
      if (dataRequestRef.current === requestId) {
        setResourceErrors((current) => {
          const next = { ...current }
          keys.forEach((key) => delete next[key])
          failures.forEach(([key, message]) => { next[key] = message })
          return next
        })
      }
    } finally {
      if (dataAbortRef.current === controller) dataAbortRef.current = null
      if (dataRequestRef.current === requestId) setLoading(false)
    }
  }, [])

  const loadDatasets = useCallback(async (force = false) => {
    if (datasetKeyword.trim() !== debouncedDatasetKeyword) {
      setDatasetsLoading(true)
      return
    }
    datasetsAbortRef.current?.abort()
    const controller = new AbortController()
    datasetsAbortRef.current = controller
    const requestId = ++datasetsRequestRef.current
    setDatasetsLoading(true)
    setDatasetsError('')
    try {
      const value = await fetchDatasets({
        page: datasetPage,
        limit: datasetSize,
        keyword: debouncedDatasetKeyword,
      }, force, controller.signal)
      if (controller.signal.aborted || datasetsRequestRef.current !== requestId) return
      const effectivePage = Math.min(Math.max(value.page || 1, 1), Math.max(value.page_count || 1, 1))
      setDatasets(value)
      setDatasetsLoaded(true)
      setLoadedDatasetPage(effectivePage)
      setLoadedDatasetSize(datasetSize)
      setLoadedDatasetViewKey(datasetViewKey(debouncedDatasetKeyword, effectivePage, datasetSize))
      if (effectivePage !== datasetPage) setDatasetPage(effectivePage)
    } catch (reason) {
      if (!controller.signal.aborted && datasetsRequestRef.current === requestId) {
        setDatasetsError(businessErrorMessage(reason, { fallback: '知识库读取失败', service: 'Dify 知识库' }))
      }
    } finally {
      if (datasetsAbortRef.current === controller) datasetsAbortRef.current = null
      if (datasetsRequestRef.current === requestId) setDatasetsLoading(false)
    }
  }, [datasetKeyword, datasetPage, datasetSize, debouncedDatasetKeyword])

  const loadRuns = useCallback(async (force = false) => {
    if (runKeyword.trim() !== debouncedRunKeyword) {
      setRunsLoading(true)
      return
    }
    runsAbortRef.current?.abort()
    const controller = new AbortController()
    runsAbortRef.current = controller
    const requestId = ++runsRequestRef.current
    setRunsLoading(true)
    setRunsError('')
    try {
      const value = await agentsApi.listRuns({
        page: runPage,
        pageSize: runSize,
        keyword: debouncedRunKeyword,
        status: runStatus,
      }, force, controller.signal)
      if (runsRequestRef.current === requestId) {
        setRuns(value)
        setRunsLoaded(true)
        setLoadedRunPage(value.page)
        setLoadedRunSize(value.pageSize)
        const effectivePage = Math.min(Math.max(value.page || 1, 1), Math.max(value.pageCount || 1, 1))
        setLoadedRunViewKey(runViewKey(debouncedRunKeyword, runStatus, effectivePage, value.pageSize))
        if (effectivePage !== runPage) setRunPage(effectivePage)
      }
    } catch (reason) {
      if (!controller.signal.aborted && runsRequestRef.current === requestId) {
        setRunsError(businessErrorMessage(reason, { fallback: '运行记录读取失败', service: 'Dify 运行记录' }))
      }
    } finally {
      if (runsAbortRef.current === controller) runsAbortRef.current = null
      if (runsRequestRef.current === requestId) setRunsLoading(false)
    }
  }, [debouncedRunKeyword, runKeyword, runPage, runSize, runStatus])

  useEffect(() => {
    void loadData()
  }, [loadData])

  useEffect(() => {
    void loadDatasets()
  }, [loadDatasets])

  useEffect(() => {
    void loadRuns()
  }, [loadRuns])

  useEffect(() => {
    const failedKeys = (Object.keys(resourceErrors) as ResourceKey[])
      .filter((key) => !resourceLoading[key])
    if (!failedKeys.length && !datasetsError && !runsError) return

    const retryFailedReads = () => {
      if (!navigator.onLine || document.visibilityState !== 'visible') return
      if (failedKeys.length && !dataAbortRef.current) void loadData(true, failedKeys)
      if (datasetsError && !datasetsAbortRef.current) void loadDatasets(true)
      if (runsError && !runsAbortRef.current) void loadRuns(true)
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
  }, [datasetsError, loadData, loadDatasets, loadRuns, resourceErrors, resourceLoading, runsError])

  useEffect(() => {
    if (pathname !== '/dify') return
    const url = new URL(window.location.href)
    const values: Record<string, string> = {
      datasetQ: datasetKeyword.trim(),
      datasetPage: datasetPage === 1 ? '' : String(datasetPage),
      datasetSize: datasetSize === 6 ? '' : String(datasetSize),
      runQ: runKeyword.trim(),
      runStatus,
      runPage: runPage === 1 ? '' : String(runPage),
      runSize: runSize === 10 ? '' : String(runSize),
    }
    Object.entries(values).forEach(([key, value]) => {
      if (value) url.searchParams.set(key, value)
      else url.searchParams.delete(key)
    })
    writtenSearchRef.current = url.searchParams.toString()
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }, [datasetKeyword, datasetPage, datasetSize, pathname, runKeyword, runPage, runSize, runStatus])

  useEffect(() => {
    if (pathname !== '/dify') return
    const incomingSearch = searchParams.toString()
    if (incomingSearch === writtenSearchRef.current) return
    writtenSearchRef.current = incomingSearch
    const nextPage = Number(searchParams.get('runPage') || 1)
    const nextSize = Number(searchParams.get('runSize') || 10)
    const nextStatus = searchParams.get('runStatus') || ''
    const nextDatasetPage = Number(searchParams.get('datasetPage') || 1)
    const nextDatasetSize = Number(searchParams.get('datasetSize') || 6)
    datasetsRequestRef.current += 1
    datasetsAbortRef.current?.abort()
    datasetsAbortRef.current = null
    setDatasetsError('')
    setDatasetsLoading(true)
    setDatasetKeyword(searchParams.get('datasetQ') || '')
    setDatasetPage(Number.isInteger(nextDatasetPage) && nextDatasetPage > 0 ? nextDatasetPage : 1)
    setDatasetSize([6, 12, 24].includes(nextDatasetSize) ? nextDatasetSize : 6)
    setSelectedDataset(null)
    invalidateRunView()
    setRunKeyword(searchParams.get('runQ') || '')
    setRunStatus(['success', 'failed'].includes(nextStatus) ? nextStatus : '')
    setRunPage(Number.isInteger(nextPage) && nextPage > 0 ? nextPage : 1)
    setRunSize([10, 20, 50].includes(nextSize) ? nextSize : 10)
    setSelectedRun(null)
  }, [pathname, searchParams])

  useEffect(() => () => {
    dataRequestRef.current += 1
    datasetsRequestRef.current += 1
    runsRequestRef.current += 1
    testRequestRef.current += 1
    testInFlightRef.current = false
    testAbortControllerRef.current?.abort()
    testAbortControllerRef.current = null
    testReconcileSequenceRef.current += 1
    if (testReconcileTimerRef.current !== null) window.clearTimeout(testReconcileTimerRef.current)
    dataAbortRef.current?.abort()
    dataAbortRef.current = null
    datasetsAbortRef.current?.abort()
    datasetsAbortRef.current = null
    runsAbortRef.current?.abort()
  }, [])

  const reconcileConnectionTest = useCallback(async () => {
    const sequence = ++testReconcileSequenceRef.current
    if (testReconcileTimerRef.current !== null) window.clearTimeout(testReconcileTimerRef.current)
    await Promise.allSettled([loadData(true), loadDatasets(true), loadRuns(true)])
    if (testReconcileSequenceRef.current !== sequence) return
    setConnection(null)
    testReconcileTimerRef.current = window.setTimeout(() => {
      if (testReconcileSequenceRef.current !== sequence) return
      void Promise.allSettled([loadData(true), loadDatasets(true), loadRuns(true)]).then(() => {
        if (testReconcileSequenceRef.current === sequence) setConnection(null)
      })
    }, 1200)
  }, [loadData, loadDatasets, loadRuns])

  const handleTest = async () => {
    if (testInFlightRef.current) {
      testRequestRef.current += 1
      testInFlightRef.current = false
      testAbortControllerRef.current?.abort()
      testAbortControllerRef.current = null
      setTesting(false)
      setConnection(null)
      toast.warning('已取消前端等待，正在重新读取 Dify 真实状态')
      void reconcileConnectionTest()
      return
    }
    testInFlightRef.current = true
    const requestId = ++testRequestRef.current
    const controller = new AbortController()
    testAbortControllerRef.current = controller
    setTesting(true)
    try {
      const result = await testServiceConnection('dify', controller.signal)
      if (testRequestRef.current !== requestId) return
      setConnection(result)
      setTesting(false)
      if (result.status === 'running') {
        toast.success(`Dify 连接正常，延迟 ${result.latency_ms} 毫秒`)
      } else {
        toast.warning(result.message)
      }
      // 单次测试只做即时反馈，卡片最终以并行运行快照为准。
      void reconcileConnectionTest()
    } catch (err) {
      if (testRequestRef.current !== requestId) return
      if (controller.signal.aborted) return
      toast.error(businessErrorMessage(err, { fallback: 'Dify 连接测试失败', service: 'Dify' }))
      setConnection(null)
      void reconcileConnectionTest()
    } finally {
      if (testRequestRef.current === requestId) {
        testInFlightRef.current = false
        if (testAbortControllerRef.current === controller) testAbortControllerRef.current = null
        setTesting(false)
      }
    }
  }

  const invalidateRunView = () => {
    runsRequestRef.current += 1
    runsAbortRef.current?.abort()
    runsAbortRef.current = null
    setRunsError('')
    setRunsLoading(true)
  }

  const invalidateDatasetView = () => {
    datasetsRequestRef.current += 1
    datasetsAbortRef.current?.abort()
    datasetsAbortRef.current = null
    setDatasetsError('')
    setDatasetsLoading(true)
    setSelectedDataset(null)
  }

  const mainInstance = instances?.instances.find((item) => item.isDefault)
    || instances?.instances.find((item) => item.sourceTemplate === 'template-00')
    || null
  const consoleUrl = mainInstance?.difyConsoleUrl || buildConsoleUrl(difyService?.url)
  const opensCurrentApp = Boolean(mainInstance?.difyConsoleUrl)
  const appService = overview?.services.find((item) => item.key === 'dify')
  const connectionSummary = connection
    ? `${connection.message || '连接状态已返回'} · ${probeDurationLabel(connection.status, connection.latency_ms)}`
    : appService
      ? `${serviceDetail(appService.status, appService.error, appService.detail)} · ${probeDurationLabel(appService.status, appService.latency_ms)}`
      : resourceLoading.overview
        ? '正在读取应用 API 真实状态'
        : '应用 API 状态暂时无法确认'
  const knowledgeService = overview?.services.find((item) => item.key === 'knowledge')
  const haService = overview?.services.find((item) => item.key === 'home_assistant')
  // 配置启用、实例探测和应用 API 探测是三类证据，连接状态只采用应用 API 的真实探测结果。
  const effectiveDifyStatus = connection?.status || appService?.status
  const deviceRate = overview?.metrics.device_control_success_rate
  const difyMetricsAvailable = overview?.coverage?.dify_records_available !== false
  const difyMetricsComplete = overview?.coverage?.dify_metrics_complete ?? Boolean(
    overview?.coverage?.dify_records_available
    && !overview.coverage.conversation_has_more
    && !overview.coverage.message_truncated_conversations
    && !overview.coverage.message_load_error_count
  )
  const runVisibilityScope = runs?.visibilityScope || (isAdmin ? 'all' : 'self')
  const resourcesRefreshing = Object.values(resourceLoading).some(Boolean)
  const dependencySnapshotLoading = resourceLoading.overview || resourceLoading.instances
  const dependencySnapshotAvailable = Boolean(overview && mainInstance)
  const dependencyChainHealthy = Boolean(
    dependencySnapshotAvailable
    && mainInstance?.runtime.status === 'running'
    && appService?.status === 'running'
    && knowledgeService?.status === 'running'
    && haService?.status === 'running'
  )
  const difyAddressConfigured = difyService?.configured ?? Boolean(difyService?.url)
  const serviceDiagnostics = groupServiceDiagnostics([
    appService && appService.status !== 'running'
      ? { name: serviceName(appService.key), message: serviceDetail(appService.status, appService.error, appService.detail) }
      : null,
    knowledgeService && knowledgeService.status !== 'running'
      ? { name: serviceName(knowledgeService.key), message: serviceDetail(knowledgeService.status, knowledgeService.error, knowledgeService.detail) }
      : null,
    haService && haService.status !== 'running'
      ? { name: serviceName(haService.key), message: serviceDetail(haService.status, haService.error, haService.detail) }
      : null,
  ].filter((item): item is { name: string; message: string } => Boolean(item)))
  const mainInstanceDiagnostic = mainInstance && mainInstance.runtime.status !== 'running'
    && !appService
    ? `默认应用：${externalErrorLabel(mainInstance.runtime.error || '默认应用实时探测未通过')}`
    : ''
  const diagnostics = [
    settings && !difyAddressConfigured ? 'Dify 服务地址尚未配置' : '',
    settings && !difyService?.token_configured ? '应用 API 密钥尚未配置' : '',
    settings && difyService?.extra?.dataset_token_configured !== 'true' ? '知识库 API 密钥尚未配置' : '',
    !resourceLoading.instances && !resourceErrors.instances && !mainInstance ? '当前没有默认 Dify 智能体' : '',
    mainInstanceDiagnostic,
    ...serviceDiagnostics,
    overview?.metrics.device_control_count && deviceRate != null && deviceRate < 80
      ? `近 24 小时 ${overview.metrics.device_control_count} 次设备控制的确认率为 ${deviceRate}%，仍需结合现场硬件核验`
      : '',
  ].filter(Boolean)

  return (
    <main className="mx-auto max-w-7xl space-y-6">
      {loading ? (
        <div className="flex items-center gap-3 rounded-md bg-blue-50 px-5 py-4 text-sm font-semibold text-blue-700 shadow-sm shadow-blue-100/60">
          <Loader2 size={18} className="shrink-0 animate-spin" />
          正在读取 Dify 运行状态，页面其余功能可先查看。
        </div>
      ) : null}
      {Object.keys(resourceErrors).length ? (
        <div className="flex flex-col gap-3 rounded-md bg-amber-50 px-5 py-4 text-sm font-semibold leading-6 text-amber-800 shadow-sm shadow-amber-100/60 sm:flex-row sm:items-center sm:justify-between" role="status">
          <div className="min-w-0">
            <p className="font-black">部分链路读取失败，页面已保留其他真实数据</p>
            <ul className="mt-2 space-y-1 text-xs font-semibold leading-5">
              {Object.entries(resourceErrors).map(([key, message]) => <li key={key} className="flex gap-2"><span aria-hidden="true">-</span><span className="min-w-0 break-words">{message}</span></li>)}
            </ul>
          </div>
          <button
            type="button"
            onClick={() => void loadData(true, Object.keys(resourceErrors) as ResourceKey[])}
            disabled={resourcesRefreshing}
            className="inline-flex min-h-9 shrink-0 items-center justify-center gap-2 rounded-lg border border-amber-200 bg-white px-3 text-xs font-black text-amber-800 transition hover:bg-amber-100 disabled:cursor-wait disabled:opacity-60"
          >
            <RefreshCw size={14} className={resourcesRefreshing ? 'animate-spin' : ''} />
            {resourcesRefreshing ? '正在重新读取' : '重新读取资源'}
          </button>
        </div>
      ) : null}

      <header className="flex flex-col gap-4 pb-6 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-2">
          <div className="inline-flex items-center gap-2 text-sm font-bold text-blue-700">
            <Workflow size={18} />
            Dify 智能体编排
          </div>
          <h1 className="text-3xl font-black text-slate-900">Dify 平台链路状态</h1>
          <p className="max-w-3xl text-sm leading-7 text-slate-500">
            展示当前默认 Dify 智能体、实例级 API 密钥绑定状态、知识库连接状态和控制台入口，运行入口以当前默认智能体为准。
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={handleTest}
            className="inline-flex min-h-11 items-center gap-2 whitespace-nowrap rounded-lg bg-white px-4 py-2.5 text-sm font-bold text-slate-700 shadow-sm shadow-slate-200/60 transition hover:text-blue-700 disabled:opacity-60"
          >
            {testing ? <XCircle size={16} /> : <RefreshCw size={16} />}
            {testing ? '取消等待' : '测试连接'}
          </button>
          {isAdmin && consoleUrl ? <a
            href={consoleUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center gap-2 whitespace-nowrap rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm shadow-blue-500/20 transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ExternalLink size={16} />
            {opensCurrentApp ? '打开当前 Dify 应用' : '打开 Dify 控制台'}
          </a> : isAdmin ? <button
            type="button"
            disabled
            title="Dify 控制台地址未配置"
            className="inline-flex min-h-11 items-center gap-2 whitespace-nowrap rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-bold text-white opacity-50"
          >
            <ExternalLink size={16} />
            打开 Dify 控制台
          </button> : null}
        </div>
      </header>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-md bg-white p-5 shadow-sm shadow-slate-200/60">
          <div className="text-xs font-bold text-slate-400">运行配置</div>
          <div className="mt-3 truncate text-sm font-semibold text-slate-800" title={isAdmin ? difyService?.url || '未配置' : undefined}>{resourceLoading.settings && !settings ? '读取中' : isAdmin ? difyService?.url || '未配置' : difyAddressConfigured ? '由管理员维护' : '未配置'}</div>
          <div className="mt-3 text-xs leading-5 text-slate-500">来源：{configSourceLabel(settings?.config_source)}</div>
        </div>
        <div className={`rounded-md p-5 shadow-sm shadow-slate-200/60 ${statusClass(effectiveDifyStatus)}`}>
          <div className="text-xs font-bold">应用 API 状态</div>
          <div className="mt-3 text-2xl font-black">{statusLabel(effectiveDifyStatus)}</div>
          <div className="mt-2 line-clamp-2 text-xs leading-5" title={connectionSummary}>{connectionSummary}</div>
        </div>
        <div className="rounded-md bg-white p-5 shadow-sm shadow-slate-200/60">
          <div className="text-xs font-bold text-slate-400">知识库 / 文档</div>
          <div className="mt-3 text-2xl font-black text-slate-900">{datasetsLoading && !datasets ? '—' : datasetScaleLabel(datasets)}</div>
          <div className={`mt-2 text-xs leading-5 ${datasets?.snapshot?.stale ? 'font-semibold text-amber-700' : 'text-slate-500'}`} title={datasets?.snapshot ? formatDateTime(datasets.snapshot.snapshot_at) : undefined}>{datasets ? datasetSnapshotLabel(datasets) : '知识库 API 快照未取得'}</div>
        </div>
        <div className="rounded-md bg-white p-5 shadow-sm shadow-slate-200/60">
          <div className="text-xs font-bold text-slate-400">调用已配置</div>
          <div className="mt-3 text-2xl font-black text-slate-900">{resourceLoading.instances && !instances ? '—' : instances ? instances.summary.callableInstances ?? instances.summary.boundInstances : '读取失败'}</div>
          <div className="mt-2 text-xs leading-5 text-slate-500">{mainInstance ? `${mainInstance.businessName || mainInstance.name} · ${mainInstance.hasDifyApiKey ? 'API 密钥已配置' : 'API 密钥待配置'}` : resourceLoading.instances ? '正在读取应用实例' : resourceErrors.instances ? '应用实例清单未取得' : `推荐模板 ${templates.find((item) => item.id === 'template-00')?.title || '统一对话流'}待绑定`}</div>
        </div>
      </section>

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="min-w-0 rounded-md bg-white shadow-sm shadow-slate-200/60">
          <div className="px-5 py-4">
            <h2 className="font-black text-slate-900">当前默认 Dify 智能体</h2>
          </div>
          {mainInstance ? (
            <div className="divide-y divide-slate-100">
              <div className="grid gap-3 px-5 py-4 transition-colors hover:bg-slate-50/70 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                <div className="min-w-0">
                  <div className="truncate whitespace-nowrap font-bold text-slate-900" title={mainInstance.businessName || mainInstance.name}>{mainInstance.businessName || mainInstance.name}</div>
                  <div className="mt-1 text-sm text-slate-500">{instanceTypeLabel(mainInstance.instanceType)}</div>
                </div>
                <div className="flex flex-wrap gap-2 md:justify-end">
                  <span className="inline-flex whitespace-nowrap rounded-[6px] bg-blue-50 px-3 py-1 text-xs font-bold text-blue-700">
                    当前使用
                  </span>
                  <span className={`inline-flex whitespace-nowrap rounded-[6px] px-3 py-1 text-xs font-bold ${mainInstance.difyAppId && mainInstance.hasDifyApiKey ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
                    {mainInstance.difyAppId && mainInstance.hasDifyApiKey ? '调用已配置' : '调用配置待补充'}
                  </span>
                </div>
              </div>
              <div className="grid gap-3 px-5 py-4 sm:grid-cols-2 lg:grid-cols-4">
                <InfoCell label="实例状态">{instanceStatusLabel(mainInstance.status)}</InfoCell>
                <InfoCell label="Dify 最近探测"><StatusBadge status={mainInstance.runtime.status} label={statusLabel(mainInstance.runtime.status)} /></InfoCell>
                <InfoCell label="默认模型">{mainInstance.defaultModel || overview?.agent.model || '由 Dify 应用配置'}</InfoCell>
                <InfoCell label="最近测试">{mainInstance.lastRun.status === 'never' ? '尚未执行' : `${runStatusLabel(mainInstance.lastRun.status)} · ${formatDateTime(mainInstance.lastRun.createdAt)}`}</InfoCell>
              </div>
              <details className="mx-5 mb-4 rounded-md border border-slate-200 px-4 py-3">
                <summary className="cursor-pointer text-xs font-bold text-slate-600">技术信息</summary>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <TechnicalId value={mainInstance.dslFileName || ''} label="DSL 文件" />
                  <TechnicalId value={mainInstance.difyConsoleUrl || ''} label="Dify 应用地址" />
                  <TechnicalId value={mainInstance.difyAppId || ''} label="Dify 应用 ID" />
                </div>
              </details>
              {mainInstance.runtime.error ? <div className="mx-5 mb-4 rounded-md bg-rose-50 px-4 py-3 text-xs leading-5 text-rose-700">{externalErrorLabel(mainInstance.runtime.error)}</div> : null}
            </div>
          ) : resourceLoading.instances ? (
            <div className="px-5 py-10 text-center text-sm text-slate-400"><Loader2 size={20} className="mx-auto mb-3 animate-spin" />正在读取默认 Dify 智能体</div>
          ) : !instances ? (
            <div className="px-5 py-10 text-center"><AlertTriangle className="mx-auto mb-3 text-amber-500" size={28} /><p className="text-sm font-black text-amber-800">应用实例读取失败</p><p className="mt-1 text-xs leading-5 text-amber-700">其他 Dify 配置与运行数据仍可继续查看，请稍后刷新。</p></div>
          ) : (
            <div className="px-5 py-10 text-center">
              <Bot className="mx-auto mb-3 text-slate-300" size={28} />
              <p className="text-sm font-black text-slate-700">当前未绑定默认 Dify 智能体</p>
              <p className="mt-1 text-xs leading-5 text-slate-400">请在智能体管理页面绑定已发布的 Dify Chatflow，并设为当前使用。</p>
            </div>
          )}
        </div>

        <aside className="rounded-md bg-amber-50 p-5 shadow-sm shadow-amber-100/60">
          <div className="flex items-center gap-2 text-sm font-black text-amber-800">
            <AlertTriangle size={18} />
            链路诊断
          </div>
          <ul className="mt-4 space-y-3 text-sm leading-6 text-amber-800">
            {dependencySnapshotLoading ? <li className="flex gap-2"><Loader2 size={16} className="mt-1 shrink-0 animate-spin" /><span>正在核对默认应用及三条依赖链路，完成前不判定为正常。</span></li> : diagnostics.length ? <>{diagnostics.slice(0, 5).map((item, index) => <li key={`${index}-${item}`} className="flex gap-2"><XCircle size={16} className="mt-1 shrink-0" /><span>{item}</span></li>)}{diagnostics.length > 5 ? <li className="pl-6 text-xs font-semibold text-amber-700">另有 {diagnostics.length - 5} 项诊断，请在系统设置、智能体管理和外部服务状态中继续核对。</li> : null}</> : dependencyChainHealthy ? <li className="flex gap-2 text-emerald-800"><ShieldCheck size={16} className="mt-1 shrink-0" />默认应用探测、应用 API、知识库 API 和 Home Assistant 均已取得可用结果。</li> : <li className="flex gap-2"><AlertTriangle size={16} className="mt-1 shrink-0" /><span>依赖链路快照未完整取得，当前不能判定全部正常。</span></li>}
          </ul>
          <div className="mt-5 flex flex-wrap gap-2">
            <Link href="/agents" className={SECONDARY_BUTTON}><Bot size={15} />管理应用</Link>
            <Link href="/settings" className={SECONDARY_BUTTON}><Settings2 size={15} />检查配置</Link>
          </div>
        </aside>
      </section>

      <section className="rounded-md bg-white shadow-sm shadow-slate-200/60">
        <div className="flex flex-col gap-3 border-b border-slate-100 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="font-black text-slate-900">运行链路与真实指标</h2>
            <p className="mt-1 text-xs leading-5 text-slate-500">Dify 应用、知识库 API 与 Home Assistant 并行探测，任一链路失败不会清空其他结果。</p>
          </div>
          <span className="text-xs text-slate-400">{overview ? `${overview.cache === 'hit' ? '缓存快照' : '最新探测'} · ${overviewCoverageLabel(overview)} · ${formatDateTime(overview.generated_at)}` : resourceLoading.overview ? '正在读取运行快照' : '运行快照读取失败'}</span>
        </div>
        <div className="grid gap-3 p-5 md:grid-cols-3">
          {(overview?.services || []).map((service) => (
            <div key={service.key} className="rounded-md bg-slate-50 px-4 py-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0"><div className="text-sm font-black text-slate-900">{serviceName(service.key)}</div><div className="mt-1 text-xs text-slate-400">{probeDurationLabel(service.status, service.latency_ms)}</div></div>
                <StatusBadge status={service.status} label={dependencyStatusLabel(service.status)} />
              </div>
              <p className={`mt-3 text-xs leading-5 ${service.error ? 'text-rose-700' : 'text-slate-500'}`}>{serviceDetail(service.status, service.error, service.detail)}</p>
            </div>
          ))}
          {!resourceLoading.overview && !overview ? <div className="md:col-span-3 rounded-md bg-amber-50 px-4 py-8 text-center text-sm text-amber-700">运行链路暂时无法读取，其他配置与实例数据仍保留。</div> : null}
        </div>
        <div className="grid gap-3 border-t border-slate-100 px-5 py-4 sm:grid-cols-2 xl:grid-cols-4">
          <InfoCell label={difyMetricsComplete ? '近 24 小时会话' : '近 24 小时已载入会话'}>{overview ? difyMetricsAvailable ? `${overview.metrics.conversation_count} 个` : '未取得' : '—'}</InfoCell>
          <InfoCell label={difyMetricsComplete ? '知识检索命中' : '已载入知识检索命中'}>{overview ? difyMetricsAvailable ? `${overview.metrics.retrieval_message_count} 条消息 / ${overview.metrics.retrieval_segment_count} 个片段` : '未取得' : '—'}</InfoCell>
          <InfoCell label="设备控制确认率">{!overview ? '—' : overview.metrics.device_control_count === 0 ? '暂无控制记录' : overview.metrics.device_control_success_rate == null ? '确认结果未取得' : `${overview.metrics.device_control_success_rate}%`}</InfoCell>
          <InfoCell label="近 24 小时平台操作成功率">{!overview ? '—' : overview.metrics.local_run_count === 0 ? '暂无平台操作' : overview.metrics.local_run_success_rate == null ? '执行结果未取得' : `${overview.metrics.local_run_success_rate}% · ${overview.metrics.local_run_count} 次`}</InfoCell>
        </div>
      </section>

      <section className="rounded-md bg-white shadow-sm shadow-slate-200/60">
        <div className="flex flex-col gap-4 border-b border-slate-100 px-5 py-4 xl:flex-row xl:items-center xl:justify-between">
          <div><h2 className="font-black text-slate-900">知识增强通道</h2><p className="mt-1 text-xs text-slate-500">来自知识库 API 的真实数据，不使用模板声明或示例数据代替。</p></div>
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
            <label className="relative min-w-0 sm:w-64"><Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" /><input value={datasetKeyword} onChange={(event) => { invalidateDatasetView(); setDatasetPage(1); setDatasetKeyword(event.target.value) }} aria-label="搜索 Dify 知识库" placeholder="搜索知识库名称或说明" className="h-10 w-full rounded-[8px] border border-slate-200 bg-white pl-9 pr-3 text-xs outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100" /></label>
            <button type="button" onClick={() => void loadDatasets(true)} disabled={datasetsLoading || datasetKeyword.trim() !== debouncedDatasetKeyword} title="刷新当前知识库列表" aria-label="刷新当前知识库列表" className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 transition hover:border-blue-200 hover:text-blue-700 disabled:cursor-wait disabled:opacity-50"><RefreshCw size={14} className={datasetsLoading ? 'animate-spin' : ''} /></button>
            <Link href="/knowledge" className="inline-flex min-h-10 shrink-0 items-center px-2 text-xs font-bold text-blue-700 hover:underline">管理知识库</Link>
          </div>
        </div>
        <div className="flex flex-col gap-1 border-b border-slate-100 px-5 py-3 text-xs sm:flex-row sm:items-center sm:justify-between">
          <span className="font-semibold text-slate-500">{datasets ? `共 ${datasets.total} 个知识库` : '知识库总数未取得'}</span>
          {datasets ? <span className={`font-semibold leading-5 ${datasets.snapshot?.stale ? 'text-amber-700' : 'text-slate-400'}`}>{datasetSnapshotLabel(datasets)}</span> : null}
        </div>
        {datasets?.snapshot?.stale ? (
          <div className="mx-5 mt-4 border-l-2 border-amber-400 bg-amber-50 px-3 py-2 text-xs font-semibold leading-5 text-amber-800">
            知识库实时刷新失败，当前保留 {formatDateTime(datasets.snapshot.snapshot_at)} 的最近成功快照：{externalErrorLabel(datasets.snapshot.error)}
          </div>
        ) : null}
        {datasetsError && datasets ? <div role="alert" className="mx-5 mt-4 rounded-md bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800">知识库读取失败：{datasetsError}{datasetSnapshotMatchesView ? '；继续显示当前条件下的上次成功快照。' : '；下方保留的旧快照不代表当前条件，详情与分页已暂停。'}</div> : null}
        {datasetsLoaded && (!datasetSnapshotMatchesView || datasetsLoading) ? <div className="mx-5 mt-4 flex items-center gap-2 border-l-2 border-blue-500 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700" role="status">{datasetsLoading ? <Loader2 size={14} className="animate-spin" /> : null}{datasetsLoading ? '正在更新知识库列表，' : '正在应用新的知识库筛选，'}{datasetSnapshotMatchesView ? '当前暂时显示同一条件下的上次成功结果。' : '下方旧快照不代表当前条件，详情与分页暂不可用。'}</div> : null}
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Dify 知识库列表，可横向滚动">
          <div className="min-w-[760px]">
            <div className="grid grid-cols-[minmax(320px,1fr)_170px_140px_44px] bg-slate-50 px-5 py-3 text-xs font-bold text-slate-500">
              <div>知识库与业务说明</div><div>内容规模</div><div>索引方式</div><div />
            </div>
            <div className="divide-y divide-slate-100">
              {(datasets?.datasets || []).map((dataset) => (
                <button key={dataset.id} type="button" onClick={() => { if (datasetSnapshotMatchesView) setSelectedDataset(dataset) }} disabled={!datasetSnapshotMatchesView} title={datasetSnapshotMatchesView ? `查看${dataset.name}` : '请等待当前知识库筛选读取完成'} className="grid w-full grid-cols-[minmax(320px,1fr)_170px_140px_44px] items-center px-5 py-4 text-left transition hover:bg-slate-50/70 disabled:cursor-not-allowed disabled:opacity-60">
                  <div className="min-w-0 pr-6">
                    <div className="truncate text-sm font-bold text-slate-900" title={dataset.name}>{dataset.name}</div>
                    <div className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500" title={datasetDescription(dataset)}>{datasetDescription(dataset)}</div>
                  </div>
                  <div className="whitespace-nowrap text-xs text-slate-500"><span className="font-bold text-slate-800">{dataset.document_count}</span> 份 · {formatCount(dataset.word_count)} 词</div>
                  <div className="whitespace-nowrap text-xs text-slate-500" title={knownIndexingTechnique(dataset.indexing_technique) ? indexLabel(dataset.indexing_technique) : `技术索引方式：${dataset.indexing_technique}`}>{indexLabel(dataset.indexing_technique)}</div>
                  <Eye size={15} className="justify-self-end text-slate-400" />
                </button>
              ))}
            </div>
          </div>
        </div>
        <div>
          {datasetsLoading && !datasets ? <div className="px-5 py-10 text-center text-sm text-slate-400"><Loader2 size={18} className="mx-auto mb-2 animate-spin" />正在读取知识库</div> : null}
          {!datasetsLoading && datasetsError && !datasets ? <div role="alert" className="px-5 py-10 text-center"><AlertTriangle className="mx-auto mb-3 text-amber-500" size={26} /><p className="text-sm font-black text-amber-800">知识库列表未取得</p><p className="mx-auto mt-1 max-w-xl break-words text-xs leading-5 text-amber-700">{datasetsError}</p><button type="button" onClick={() => void loadDatasets(true)} disabled={datasetsLoading} className="mt-4 inline-flex min-h-9 items-center gap-2 rounded-[8px] border border-amber-200 bg-white px-3 text-xs font-black text-amber-800 transition hover:bg-amber-50 disabled:cursor-wait disabled:opacity-60">{datasetsLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}{datasetsLoading ? '正在重新读取' : '重新读取知识库'}</button></div> : null}
          {datasets && !datasets.total ? <div className="px-5 py-10 text-center text-sm text-slate-400">{debouncedDatasetKeyword ? '没有符合搜索条件的知识库' : '当前未读取到知识库'}</div> : null}
        </div>
        {datasets || datasetsLoading ? <Pagination page={loadedDatasetPage} pageSize={loadedDatasetSize} total={datasets?.total || 0} itemName="个知识库" loading={datasetsLoading} totalKnown={datasetsLoaded} navigationDisabled={!datasetSnapshotMatchesView} pageSizeOptions={[6, 12, 24]} onPageChange={(page) => { invalidateDatasetView(); setDatasetPage(page) }} onPageSizeChange={(size) => { invalidateDatasetView(); setDatasetSize(size); setDatasetPage(1) }} /> : null}
      </section>

      <section className="rounded-md bg-white shadow-sm shadow-slate-200/60">
        <div className="flex flex-col gap-3 border-b border-slate-100 px-5 py-4 xl:flex-row xl:items-center xl:justify-between">
          <div><h2 className="font-black text-slate-900">{runVisibilityScope === 'all' ? '平台应用测试运行记录' : '我的应用测试运行记录'}</h2><p className="mt-1 text-xs text-slate-500">真实记录来自智能体实例测试接口，{runVisibilityScope === 'all' ? '管理员可查看全平台记录' : '当前仅展示本人记录'}，支持服务端搜索、结果筛选和分页。</p></div>
          <div className="grid gap-2 sm:grid-cols-[minmax(220px,1fr)_150px_40px] xl:w-[520px]">
            <label className="relative min-w-0"><Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" /><input value={runKeyword} onChange={(event) => { invalidateRunView(); setRunPage(1); setRunKeyword(event.target.value) }} placeholder={runVisibilityScope === 'all' ? '搜索请求、应用或操作人' : '搜索我的请求或应用'} aria-label="搜索应用测试运行记录" className="h-10 w-full rounded-[8px] border border-slate-200 bg-white pl-9 pr-3 text-xs outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100" /></label>
            <UnifiedSelect ariaLabel="筛选应用测试执行结果" value={runStatus} onChange={(value) => { invalidateRunView(); setRunPage(1); setRunStatus(value) }} size="sm" options={[{ value: '', label: '全部执行结果' }, { value: 'success', label: '执行成功' }, { value: 'failed', label: '执行失败' }]} />
            <button type="button" onClick={() => void loadRuns(true)} disabled={runsLoading || runKeyword.trim() !== debouncedRunKeyword} aria-label="刷新应用测试运行记录" title="刷新当前筛选结果" className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 transition hover:border-blue-200 hover:text-blue-700 disabled:cursor-wait disabled:opacity-50">
              <RefreshCw size={14} className={runsLoading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>
        {runsError && runs ? <div role="alert" className="mx-5 mt-4 rounded-md bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-700">运行记录读取失败：{runsError}{runSnapshotMatchesView ? '；继续显示当前条件下的上次成功快照。' : '；保留的旧快照不代表当前筛选条件，分页与详情已暂停。'}</div> : null}
        {runsLoaded && (!runSnapshotMatchesView || runsLoading) ? <div className="mx-5 mt-4 flex items-center gap-2 border-l-2 border-blue-500 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700" role="status">{runsLoading ? <Loader2 size={14} className="animate-spin" /> : null}{runsLoading ? '正在更新运行记录，' : '正在应用新的筛选条件，'}{runSnapshotMatchesView ? '当前暂时显示同一条件下的上次成功结果。' : '下方旧快照不代表当前条件，分页与详情暂不可用。'}</div> : null}
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="应用测试运行记录列表，可横向滚动">
          <table className="w-full min-w-[980px] table-fixed text-left [&_td]:align-middle [&_th]:whitespace-nowrap">
            <colgroup><col className="w-[120px]" /><col className="w-[260px]" /><col className="w-[180px]" /><col /><col className="w-[172px]" /><col className="w-[60px]" /></colgroup>
            <thead className="bg-slate-50 text-xs font-bold text-slate-500"><tr><th className="px-4 py-3">结果</th><th className="px-4 py-3">测试请求</th><th className="px-4 py-3">应用</th><th className="px-4 py-3">运行证据</th><th className="px-4 py-3">执行时间</th><th className="px-4 py-3" /></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {(runs?.items || []).map((item) => <tr key={item.id} className="transition hover:bg-slate-50/70"><td className="px-4 py-4"><StatusBadge status={runStatusBadgeStatus(item.status)} label={runStatusLabel(item.status)} className="min-w-[5.5rem] justify-center" /></td><td className="px-4 py-4"><div className="line-clamp-2 text-sm font-bold leading-6 text-slate-900" title={item.query}>{item.query || '请求内容未记录'}</div></td><td className="px-4 py-4 text-xs font-semibold leading-5 text-slate-600" title={item.businessName || item.instanceName || '智能体应用'}><div className="line-clamp-2">{item.businessName || item.instanceName || '智能体应用'}</div></td><td className={`px-4 py-4 text-xs leading-5 ${item.error ? 'text-rose-700' : 'text-slate-500'}`} title={runEvidence(item)}><div className="line-clamp-2">{runEvidence(item)}</div></td><td className="whitespace-nowrap px-4 py-4 text-xs text-slate-500">{formatDateTime(item.createdAt)}</td><td className="px-4 py-4"><button type="button" onClick={() => { if (runSnapshotMatchesView) setSelectedRun(item) }} disabled={!runSnapshotMatchesView} title={runSnapshotMatchesView ? '查看运行详情' : '请等待当前筛选条件读取完成'} aria-label={`查看 ${item.query || item.title} 运行详情`} className="inline-flex h-9 w-9 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-40"><Eye size={15} /></button></td></tr>)}
            </tbody>
          </table>
        </div>
        {runsLoading && !runs ? <div className="px-5 py-10 text-center text-sm text-slate-400"><Loader2 size={18} className="mx-auto mb-2 animate-spin" />正在读取运行记录</div> : null}
        {!runsLoading && runsError && !runs ? (
          <div role="alert" className="px-5 py-10 text-center">
            <AlertTriangle className="mx-auto mb-3 text-amber-500" size={26} />
            <p className="text-sm font-black text-amber-800">运行记录未取得</p>
            <p className="mx-auto mt-1 max-w-xl break-words text-xs leading-5 text-amber-700">{runsError}</p>
            <button type="button" onClick={() => void loadRuns(true)} disabled={runsLoading} className="mt-4 inline-flex min-h-9 items-center gap-2 rounded-[8px] border border-amber-200 bg-white px-3 text-xs font-black text-amber-800 transition hover:bg-amber-50 disabled:cursor-wait disabled:opacity-60">
              {runsLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}{runsLoading ? '正在重新读取' : '重新读取记录'}
            </button>
          </div>
        ) : null}
        {!runsLoading && runs && !runs.items.length ? <div className="px-5 py-10 text-center text-sm text-slate-400">没有符合条件的运行记录</div> : null}
        {runs || runsLoading ? <Pagination page={loadedRunPage} pageSize={loadedRunSize} total={runs?.total || 0} itemName="条测试记录" loading={runsLoading} totalKnown={runsLoaded} navigationDisabled={!runSnapshotMatchesView} onPageChange={(page) => { invalidateRunView(); setRunPage(page) }} onPageSizeChange={(size) => { invalidateRunView(); setRunSize(size); setRunPage(1) }} /> : null}
      </section>

      <section className="rounded-md bg-white p-5 shadow-sm shadow-slate-200/60">
        <div className="flex items-center gap-2 text-sm font-black text-slate-900">
          <FileCode2 size={18} />
          运行检查
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {[
            ['默认调用', '对话和测试优先使用智能体管理中的当前默认智能体。'],
            ['密钥安全', '实例级 Dify API 密钥只写入后端，不在页面回传明文。'],
            ['Prompt 与节点', '系统提示词、变量、开场白和工具调用说明统一在 Dify 控制台维护。'],
            ['运行详情', '可由智能体管理测试运行或智能体对话查看运行标识与回传结果。'],
          ].map(([title, desc]) => (
            <div key={title} className="rounded-md bg-slate-50 px-4 py-3">
              <div className="flex items-center gap-2 text-sm font-black text-slate-900">
                <CheckCircle2 size={16} className="text-emerald-600" />
                {title}
              </div>
              <p className="mt-2 text-sm leading-6 text-slate-500">{desc}</p>
            </div>
          ))}
        </div>
      </section>

      <AppDialog
        open={Boolean(selectedRun)}
        onClose={() => setSelectedRun(null)}
        title="应用测试运行详情"
        description={selectedRun ? `${selectedRun.businessName || selectedRun.instanceName || '智能体应用'} · ${formatDateTime(selectedRun.createdAt)}` : undefined}
        maxWidth="max-w-2xl"
        footer={<button type="button" onClick={() => setSelectedRun(null)} className={SECONDARY_BUTTON}>关闭</button>}
      >
        {selectedRun ? <div className="space-y-5"><div className="grid gap-3 sm:grid-cols-2"><InfoCell label="执行结果"><StatusBadge status={runStatusBadgeStatus(selectedRun.status)} label={runStatusLabel(selectedRun.status)} /></InfoCell><InfoCell label="操作用户">{selectedRun.username || '用户未记录'}</InfoCell></div><div className="rounded-md bg-slate-50 p-4"><p className="text-xs text-slate-500">测试请求</p><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-800">{selectedRun.query || '请求内容未记录'}</p></div>{selectedRun.error ? <div className="rounded-md bg-rose-50 p-4 text-sm leading-6 text-rose-700">{runErrorLabel(selectedRun.error)}</div> : <div className="rounded-md bg-emerald-50 p-4 text-sm leading-6 text-emerald-800">平台已保存运行审计；节点级输入输出请通过运行标识在 Dify 控制台继续核对。</div>}<details className="rounded-md border border-slate-200 p-4"><summary className="cursor-pointer text-sm font-bold text-slate-700">技术证据</summary><div className="mt-4 space-y-3"><TechnicalId value={String(selectedRun.instanceId || '')} label="平台实例 ID" /><TechnicalId value={selectedRun.messageId} label="Dify 消息 ID" /><TechnicalId value={selectedRun.workflowRunId} label="Dify 工作流运行 ID" />{selectedRun.error ? <TechnicalId value={selectedRun.error} label="原始错误" /> : null}</div></details></div> : null}
      </AppDialog>

      <AppDialog
        open={Boolean(selectedDataset)}
        onClose={() => setSelectedDataset(null)}
        title={selectedDataset?.name || '知识库详情'}
        description="业务信息优先展示，技术标识仅用于问题定位。"
        maxWidth="max-w-2xl"
        footer={<button type="button" onClick={() => setSelectedDataset(null)} className={SECONDARY_BUTTON}>关闭</button>}
      >
        {selectedDataset ? <div className="space-y-5"><div className="grid gap-3 sm:grid-cols-2"><InfoCell label="文档规模">{selectedDataset.document_count} 份文档 · {formatCount(selectedDataset.word_count)} 词</InfoCell><InfoCell label="应用引用">{selectedDataset.app_count} 个 Dify 应用</InfoCell><InfoCell label="索引方式">{indexLabel(selectedDataset.indexing_technique)}</InfoCell><InfoCell label="访问权限">{permissionLabel(selectedDataset.permission)}</InfoCell><InfoCell label="嵌入模型">{embeddingModelLabel(selectedDataset.embedding_model)}</InfoCell><InfoCell label="最近更新">{formatDateTime(selectedDataset.updated_at)}</InfoCell></div>{selectedDataset.description && datasetDescription(selectedDataset) === selectedDataset.description ? <div className="rounded-md bg-slate-50 p-4"><p className="text-xs text-slate-500">知识库说明</p><p className="mt-2 break-words text-sm leading-6 text-slate-700">{selectedDataset.description}</p></div> : null}<details className="rounded-md border border-slate-200 p-4"><summary className="cursor-pointer text-sm font-bold text-slate-700">技术信息</summary><div className="mt-4 space-y-3"><TechnicalId value={selectedDataset.id} label="Dify Dataset ID" /><TechnicalId value={selectedDataset.embedding_model || ''} label="原始嵌入模型" />{!knownIndexingTechnique(selectedDataset.indexing_technique) ? <TechnicalId value={selectedDataset.indexing_technique} label="原始索引方式" /> : null}{!knownDatasetPermission(selectedDataset.permission) ? <TechnicalId value={selectedDataset.permission} label="原始权限类型" /> : null}</div></details><div className="flex justify-end"><Link href={`/knowledge/${selectedDataset.id}`} className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-bold text-white"><Database size={15} />查看知识库</Link></div></div> : null}
      </AppDialog>
    </main>
  )
}

function InfoCell({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="min-w-0 rounded-md bg-slate-50 px-4 py-3"><div className="text-xs font-bold text-slate-400">{label}</div><div className="mt-2 break-words text-sm font-bold text-slate-800">{children}</div></div>
}

export default function DifyPage() {
  return <Suspense fallback={null}><DifyContent /></Suspense>
}
