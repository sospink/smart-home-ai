'use client'

import { Suspense, useCallback, useEffect, useId, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { createPortal } from 'react-dom'
import {
  AlertTriangle, ArrowRight, Bot, CheckCircle2, CloudUpload, ExternalLink, History, LayoutGrid, List, Loader2, PlayCircle, Plus, RefreshCw, Search, Trash2, X,
} from 'lucide-react'
import { toast } from '@/components/ui/toast'
import { UnifiedSelect } from '@/components/ui/UnifiedSelect'
import { AppDialog } from '@/components/ui/AppDialog'
import { AppDrawer } from '@/components/ui/AppDrawer'
import { Pagination } from '@/components/ui/Pagination'
import { TechnicalId } from '@/components/ui/TechnicalId'
import { agentsApi, validateAgentDslFile } from '@/lib/api/agents'
import { ApiError } from '@/lib/api/client'
import { useAuth } from '@/lib/hooks/useAuth'
import { useDialogFocusTrap, useDialogLock } from '@/lib/hooks/useDialogLock'
import { businessErrorMessage } from '@/lib/ui/business-error'
import type {
  AgentInstance,
  AgentRunRecord,
  AgentRunListResponse,
  AgentTestRunResult,
  AgentTemplateDoc,
  CreateAgentInstancePayload,
} from '@/types/agents'

type CreateMode = 'external_dify' | 'built_in_template' | 'uploaded_dsl'
type InstanceViewMode = 'card' | 'list'
type InstanceScope = 'primary' | 'all'

function instanceViewKey(scope: InstanceScope, keyword: string, page: number, pageSize: number) {
  return JSON.stringify({ scope, keyword: keyword.trim(), page, pageSize })
}

function runViewKey(keyword: string, status: string, instanceId: string, page: number, pageSize: number) {
  return JSON.stringify({ keyword: keyword.trim(), status, instanceId, page, pageSize })
}

const INSTANCE_STATUS_STYLES: Record<string, string> = {
  draft: 'bg-amber-50 text-amber-700',
  ready: 'bg-sky-50 text-sky-700',
  running: 'bg-emerald-50 text-emerald-700',
  disabled: 'bg-slate-100 text-slate-500',
}

const INSTANCE_STATUS_LABELS: Record<string, string> = {
  draft: '配置草稿',
  ready: '配置已就绪',
  running: '配置已启用',
  disabled: '已停用',
}

const INSTANCE_TYPE_LABELS: Record<string, string> = {
  chatflow: '对话应用',
  workflow: '工作流',
}

const RUNTIME_STATUS_LABELS: Record<string, string> = {
  unchecked: '正在检测 Dify',
  running: '调用链路可用',
  mismatch: '应用名称待核对',
  unavailable: 'Dify 服务不可用',
  unconfigured: '尚不可调用',
  disabled: '实例已停用',
}

const RUNTIME_STATUS_STYLES: Record<string, string> = {
  unchecked: 'bg-sky-50 text-sky-700',
  running: 'bg-emerald-50 text-emerald-700',
  mismatch: 'bg-amber-50 text-amber-700',
  unavailable: 'bg-rose-50 text-rose-700',
  unconfigured: 'bg-amber-50 text-amber-700',
  disabled: 'bg-slate-100 text-slate-500',
}

function instanceTypeLabel(instanceType?: string) {
  return instanceType ? INSTANCE_TYPE_LABELS[instanceType] || '应用类型待确认' : '应用类型待确认'
}

function instanceStatusLabel(status?: string) {
  return status ? INSTANCE_STATUS_LABELS[status] || '实例状态待确认' : '实例状态待确认'
}

function runtimeEvidenceStatus(instance: AgentInstance) {
  if (instance.runtime?.status === 'unchecked' && !instance.hasDifyApiKey && !instance.isDefault) {
    return 'unconfigured'
  }
  return instance.runtime?.status
}

function loadErrorMessage(error: unknown, fallback: string) {
  return businessErrorMessage(error, { fallback, service: '智能体管理' })
}

function runErrorLabel(value?: string | null) {
  const message = String(value || '').trim()
  if (!message) return '智能体运行失败，请检查 Dify 应用配置和运行日志'
  if (/all connection attempts failed|connection refused|connecterror|network is unreachable/i.test(message)) return '无法连接 Dify，请检查服务地址、容器状态和网络链路'
  if (/connecttimeout|readtimeout|timed out|timeout/i.test(message)) return 'Dify 请求超时，请检查服务状态和网络链路'
  if (/401|403|unauthorized|forbidden|authentication/i.test(message)) return 'Dify 认证失败，请检查应用 API 密钥和访问权限'
  if (/404|not found/i.test(message)) return 'Dify 应用或接口不存在，请检查应用绑定和服务地址'
  if (/500|502|503|504|internal server error|bad gateway|service unavailable/i.test(message)) return 'Dify 服务返回异常，请检查应用运行状态和服务日志'
  if (/https?:\/\/|traceback|exception|\b[a-z]+error\b/i.test(message)) return '智能体运行失败，请检查 Dify 应用配置和运行日志'
  return /[\u4e00-\u9fff]/.test(message) ? message : '智能体运行失败，请检查 Dify 应用配置和运行日志'
}

function runtimeStatusLabel(instance: AgentInstance) {
  if (!instance.enabled || instance.status === 'disabled') return '已停用'
  return RUNTIME_STATUS_LABELS[runtimeEvidenceStatus(instance)] || '运行状态待确认'
}

function runtimeStatusTone(instance: AgentInstance) {
  if (!instance.enabled || instance.status === 'disabled') return 'text-slate-500'
  const status = runtimeEvidenceStatus(instance)
  if (status === 'running') return 'text-emerald-700'
  if (status === 'unavailable') return 'text-rose-700'
  return 'text-amber-700'
}

function runtimeStatusStyle(instance: AgentInstance) {
  if (!instance.enabled || instance.status === 'disabled') return INSTANCE_STATUS_STYLES.disabled
  return RUNTIME_STATUS_STYLES[runtimeEvidenceStatus(instance)] || 'bg-slate-100 text-slate-500'
}

function canTestInstance(instance: AgentInstance) {
  const runtimeStatus = runtimeEvidenceStatus(instance)
  return instance.enabled
    && (instance.hasDifyApiKey || instance.isDefault)
    && (runtimeStatus === 'running' || runtimeStatus === 'mismatch')
}

function instanceTestDisabledReason(instance: AgentInstance) {
  if (!instance.enabled || instance.status === 'disabled') return '实例已停用'
  if (!instance.hasDifyApiKey && !instance.isDefault) return '完成 Dify API 密钥配置后可测试'
  const runtimeStatus = runtimeEvidenceStatus(instance)
  if (runtimeStatus === 'unchecked') return '正在确认 Dify 调用链路'
  if (runtimeStatus === 'unavailable') return 'Dify 服务不可用，请恢复连接并刷新后再测试'
  if (runtimeStatus === 'unconfigured') return 'Dify 调用配置尚未完成'
  return '当前实例暂不可测试'
}

function lastRunLabel(instance: AgentInstance) {
  if (instance.lastRun?.status === 'success') return '最近测试成功'
  if (instance.lastRun?.status === 'failed') return '最近测试失败'
  return '尚无测试记录'
}

function bindingLabel(instance: AgentInstance) {
  if (instance.difyAppId && instance.hasDifyApiKey) return '调用配置完整'
  if (instance.difyAppId) return '缺少应用 API 密钥'
  if (instance.hasDifyApiKey) return '缺少应用标识'
  return '调用配置未完成'
}

function bindingTone(instance: AgentInstance) {
  return instance.difyAppId && instance.hasDifyApiKey
    ? 'text-emerald-700'
    : 'text-amber-700'
}

function entryRouteLabel(route?: string) {
  const labels: Record<string, string> = {
    '/chat': '智能体对话',
    '/conversation-records': '会话与运行记录',
    '/devices': '设备控制',
    '/monitor': '设备状态与系统监控',
    '/knowledge': '知识库管理',
    '/sandbox': '电子沙盘',
  }
  return labels[route || '/chat'] || '平台功能页面'
}

function formatDateTime(value?: string) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function formatFullDateTime(value?: string) {
  if (!value) return '时间未记录'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未记录'
  return date.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

function compactList(values: string[], fallback: string) {
  if (!values.length) return fallback
  if (values.length === 1) return values[0]
  return `${values[0]} 等 ${values.length} 项`
}

function instanceBusinessName(instance: AgentInstance) {
  return instance.businessName || instance.name || '未命名智能体'
}

function instanceBusinessDescription(instance: AgentInstance) {
  return instance.businessDescription || instance.description || '尚未填写智能体用途说明。'
}

function sourceTemplateLabel(instance: AgentInstance) {
  if (instance.sourceTemplate === 'template-00') return '统一主编排模板'
  if (instance.sourceType === 'template_library') return '模板库实例快照'
  return instance.sourceTemplate ? '历史模板资产' : '自定义 DSL'
}

function testQueryHasSideEffects(query: string) {
  const normalized = query.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!normalized) return false
  return [
    'turn_on', 'turn_off', 'toggle', 'set_brightness', 'set_temperature',
    '打开', '开启', '关闭', '关掉', '切换', '调亮', '调暗', '调节',
    '设置亮度', '设置色温', '执行场景', '启动场景', '激活场景',
  ].some((action) => normalized.includes(action))
}

function buildDifyInstanceUrl(instance: AgentInstance) {
  const configured = instance.difyConsoleUrl?.trim()
  if (!configured) return ''
  try {
    const url = new URL(configured)
    if (url.port === '5001') url.port = ''
    if (url.pathname.includes('/app/')) return url.toString()
    if (!instance.difyAppId?.trim()) return ''
    url.pathname = `/app/${encodeURIComponent(instance.difyAppId.trim())}/workflow`
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return ''
  }
}

function AgentsContent() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { isAdmin, loading: authLoading } = useAuth()
  const [mounted, setMounted] = useState(false)
  const [instances, setInstances] = useState<AgentInstance[]>([])
  const [templates, setTemplates] = useState<AgentTemplateDoc[]>([])
  const [instancesLoaded, setInstancesLoaded] = useState(false)
  const [templatesLoaded, setTemplatesLoaded] = useState(false)
  const [templatesLoading, setTemplatesLoading] = useState(false)
  const [loadedInstanceViewKey, setLoadedInstanceViewKey] = useState('')
  const [loadedInstancePage, setLoadedInstancePage] = useState(1)
  const [loadedInstancePageSize, setLoadedInstancePageSize] = useState(10)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [runtimeLoading, setRuntimeLoading] = useState(false)
  const [instancesError, setInstancesError] = useState('')
  const [templatesError, setTemplatesError] = useState('')
  const [runtimeError, setRuntimeError] = useState('')
  const [lastSuccessfulReadAt, setLastSuccessfulReadAt] = useState<Date | null>(null)
  const [saving, setSaving] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [selectedInstance, setSelectedInstance] = useState<AgentInstance | null>(null)
  const [confirmDiscardBinding, setConfirmDiscardBinding] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<AgentInstance | null>(null)
  const [deletingInstanceId, setDeletingInstanceId] = useState<number | null>(null)
  const [testTarget, setTestTarget] = useState<AgentInstance | null>(null)
  const [testQuery, setTestQuery] = useState('')
  const [testRunning, setTestRunning] = useState(false)
  const [testResult, setTestResult] = useState<AgentTestRunResult | null>(null)
  const [allowTestSideEffects, setAllowTestSideEffects] = useState(false)
  const [bindingSaving, setBindingSaving] = useState(false)
  const [viewMode, setViewMode] = useState<InstanceViewMode>(() => searchParams.get('view') === 'card' ? 'card' : 'list')
  const [instanceScope, setInstanceScope] = useState<InstanceScope>(() => searchParams.get('scope') === 'all' ? 'all' : 'primary')
  const [instanceKeywordInput, setInstanceKeywordInput] = useState(() => searchParams.get('q') || '')
  const [instanceKeyword, setInstanceKeyword] = useState(() => (searchParams.get('q') || '').trim())
  const [instanceSearchSettled, setInstanceSearchSettled] = useState(true)
  const [instancePage, setInstancePage] = useState(() => {
    const value = Number(searchParams.get('page') || 1)
    return Number.isInteger(value) && value > 0 ? value : 1
  })
  const [instancePageSize, setInstancePageSize] = useState(() => {
    const value = Number(searchParams.get('size') || 10)
    return [5, 10, 20].includes(value) ? value : 10
  })
  const [instanceTotal, setInstanceTotal] = useState(0)
  const [runHistoryOpen, setRunHistoryOpen] = useState(false)
  const [runHistory, setRunHistory] = useState<AgentRunListResponse | null>(null)
  const [loadedRunViewKey, setLoadedRunViewKey] = useState('')
  const [runFilterInstances, setRunFilterInstances] = useState<AgentInstance[]>([])
  const [runHistoryLoading, setRunHistoryLoading] = useState(false)
  const [runHistoryError, setRunHistoryError] = useState('')
  const [runKeywordInput, setRunKeywordInput] = useState('')
  const [runKeyword, setRunKeyword] = useState('')
  const [runSearchSettled, setRunSearchSettled] = useState(true)
  const [runEvidenceTarget, setRunEvidenceTarget] = useState<AgentRunRecord | null>(null)
  const [runStatus, setRunStatus] = useState('')
  const [runInstanceId, setRunInstanceId] = useState('')
  const [runPage, setRunPage] = useState(1)
  const [runPageSize, setRunPageSize] = useState(10)
  const [createMode, setCreateMode] = useState<CreateMode>('external_dify')
  const [createName, setCreateName] = useState('')
  const [createDescription, setCreateDescription] = useState('')
  const [createTemplateId, setCreateTemplateId] = useState('template-00')
  const [createEnabled, setCreateEnabled] = useState(true)
  const [createIsDefault, setCreateIsDefault] = useState(true)
  const [createDifyUrl, setCreateDifyUrl] = useState('')
  const [createDifyAppId, setCreateDifyAppId] = useState('')
  const [createDifyApiKey, setCreateDifyApiKey] = useState('')
  const [bindingApiKey, setBindingApiKey] = useState('')
  const [dslFile, setDslFile] = useState<File | null>(null)
  const instancesLoadedRef = useRef(false)
  const requestSequenceRef = useRef(0)
  const templatesRequestRef = useRef(0)
  const runHistoryRequestRef = useRef(0)
  const runFilterRequestRef = useRef(0)
  const testRequestRef = useRef(0)
  const bindingRequestRef = useRef(0)
  const refreshInFlightRef = useRef(false)
  const createInFlightRef = useRef(false)
  const deleteInFlightRef = useRef(false)
  const bindingInFlightRef = useRef(false)
  const testInFlightRef = useRef(false)
  const testAbortControllerRef = useRef<AbortController | null>(null)
  const testReconcileRef = useRef(0)
  const testReconcileTimerRef = useRef<number | null>(null)
  const createAbortRef = useRef<AbortController | null>(null)
  const bindingAbortRef = useRef<AbortController | null>(null)
  const deleteAbortRef = useRef<AbortController | null>(null)
  const dataAbortRef = useRef<AbortController | null>(null)
  const templatesAbortRef = useRef<AbortController | null>(null)
  const runHistoryAbortRef = useRef<AbortController | null>(null)
  const runFilterAbortRef = useRef<AbortController | null>(null)
  const instanceDialogRef = useRef<HTMLDivElement | null>(null)
  const testDialogRef = useRef<HTMLDivElement | null>(null)
  const createDialogRef = useRef<HTMLDivElement | null>(null)
  const testQueryRef = useRef<HTMLTextAreaElement | null>(null)
  const createDifyUrlRef = useRef<HTMLInputElement | null>(null)
  const discardBindingCancelRef = useRef<HTMLButtonElement | null>(null)
  const instanceDialogTitleId = useId()
  const testDialogTitleId = useId()
  const createDialogTitleId = useId()
  const writtenSearchRef = useRef(searchParams.toString())

  const currentInstanceViewKey = instanceViewKey(instanceScope, instanceKeyword, instancePage, instancePageSize)
  const instanceSnapshotMatchesView = Boolean(
    instancesLoaded
    && instanceSearchSettled
    && instanceKeywordInput.trim() === instanceKeyword
    && loadedInstanceViewKey === currentInstanceViewKey
  )
  const instanceNavigationAllowed = instanceSnapshotMatchesView
  const instanceActionsAllowed = instanceNavigationAllowed && !refreshing && !instancesError
  const instanceTestAllowed = instanceActionsAllowed && !runtimeLoading && !runtimeError
  const runSnapshotActionsAllowed = Boolean(
    runHistory
    && !runHistoryLoading
    && runSearchSettled
    && runKeywordInput.trim() === runKeyword
    && loadedRunViewKey === runViewKey(runKeyword, runStatus, runInstanceId, runPage, runPageSize)
  )
  const primaryInstance = instanceSnapshotMatchesView
    ? instances.find((instance) => instance.isDefault) || (instanceScope === 'primary' ? instances[0] : undefined)
    : undefined

  useDialogLock(Boolean(selectedInstance))
  useDialogLock(Boolean(testTarget))
  useDialogLock(createOpen)
  useDialogFocusTrap(Boolean(selectedInstance) && !confirmDiscardBinding, instanceDialogRef, closeInstanceDialog)
  useDialogFocusTrap(Boolean(testTarget), testDialogRef, () => {
    if (!testRunning) setTestTarget(null)
  }, testQueryRef)
  useDialogFocusTrap(createOpen, createDialogRef, () => {
    if (!saving) closeCreateDialog()
  }, createDifyUrlRef)

  useEffect(() => {
    setMounted(true)
    return () => {
      requestSequenceRef.current += 1
      templatesRequestRef.current += 1
      runHistoryRequestRef.current += 1
      runFilterRequestRef.current += 1
      testRequestRef.current += 1
      testReconcileRef.current += 1
      bindingRequestRef.current += 1
      refreshInFlightRef.current = false
      createInFlightRef.current = false
      deleteInFlightRef.current = false
      bindingInFlightRef.current = false
      testInFlightRef.current = false
      testAbortControllerRef.current?.abort()
      testAbortControllerRef.current = null
      if (testReconcileTimerRef.current !== null) window.clearTimeout(testReconcileTimerRef.current)
      testReconcileTimerRef.current = null
      createAbortRef.current?.abort()
      createAbortRef.current = null
      bindingAbortRef.current?.abort()
      bindingAbortRef.current = null
      deleteAbortRef.current?.abort()
      deleteAbortRef.current = null
      dataAbortRef.current?.abort()
      dataAbortRef.current = null
      templatesAbortRef.current?.abort()
      templatesAbortRef.current = null
      runHistoryAbortRef.current?.abort()
      runHistoryAbortRef.current = null
      runFilterAbortRef.current?.abort()
      runFilterAbortRef.current = null
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const nextKeyword = instanceKeywordInput.trim()
      if (nextKeyword !== instanceKeyword) {
        setInstanceKeyword(nextKeyword)
        setInstancePage(1)
      }
      setInstanceSearchSettled(true)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [instanceKeyword, instanceKeywordInput])

  useEffect(() => {
    if (pathname !== '/agents') return
    const url = new URL(window.location.href)
    const values: Record<string, string> = {
      scope: instanceScope === 'primary' ? '' : instanceScope,
      q: instanceKeywordInput.trim(),
      view: viewMode === 'list' ? '' : viewMode,
      page: instancePage === 1 ? '' : String(instancePage),
      size: instancePageSize === 10 ? '' : String(instancePageSize),
    }
    Object.entries(values).forEach(([key, value]) => {
      if (value) url.searchParams.set(key, value)
      else url.searchParams.delete(key)
    })
    const nextSearch = url.searchParams.toString()
    writtenSearchRef.current = nextSearch
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }, [instanceKeywordInput, instancePage, instancePageSize, instanceScope, pathname, viewMode])

  useEffect(() => {
    if (pathname !== '/agents') return
    const nextSearch = searchParams.toString()
    if (nextSearch === writtenSearchRef.current) return
    writtenSearchRef.current = nextSearch
    const nextKeyword = searchParams.get('q') || ''
    const nextScope: InstanceScope = searchParams.get('scope') === 'all' ? 'all' : 'primary'
    const nextView: InstanceViewMode = searchParams.get('view') === 'card' ? 'card' : 'list'
    const rawPage = Number(searchParams.get('page') || 1)
    const nextPage = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1
    const rawSize = Number(searchParams.get('size') || 10)
    const nextSize = [5, 10, 20].includes(rawSize) ? rawSize : 10
    setInstanceKeywordInput(nextKeyword)
    setInstanceKeyword(nextKeyword.trim())
    setInstanceSearchSettled(true)
    setInstanceScope(nextScope)
    setViewMode(nextView)
    setInstancePage(nextPage)
    setInstancePageSize(nextSize)
  }, [pathname, searchParams])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setRunKeyword(runKeywordInput.trim())
      setRunPage(1)
      setRunSearchSettled(true)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [runKeywordInput])

  const openCreateDialog = () => {
    window.setTimeout(() => setCreateOpen(true), 0)
  }

  function closeCreateDialog() {
    if (saving) return
    setCreateOpen(false)
    setCreateMode('external_dify')
    setCreateName('')
    setCreateDescription('')
    setCreateTemplateId('template-00')
    setCreateEnabled(true)
    setCreateIsDefault(true)
    setCreateDifyUrl('')
    setCreateDifyAppId('')
    setCreateDifyApiKey('')
    setDslFile(null)
  }

  const openInstanceDialog = (instance: AgentInstance) => {
    if (bindingSaving || !instanceNavigationAllowed) return
    setConfirmDiscardBinding(false)
    setBindingApiKey('')
    window.setTimeout(() => setSelectedInstance(instance), 0)
  }

  const bindingDirty = Boolean(selectedInstance && (() => {
    const persisted = instances.find((item) => item.id === selectedInstance.id)
    if (!persisted) return Boolean(bindingApiKey.trim())
    return Boolean(
      bindingApiKey.trim()
      || selectedInstance.difyAppId.trim() !== persisted.difyAppId.trim()
      || selectedInstance.difyConsoleUrl.trim() !== persisted.difyConsoleUrl.trim()
      || selectedInstance.isDefault !== persisted.isDefault
    )
  })())

  function closeInstanceDialog() {
    if (bindingSaving) return
    if (bindingDirty) {
      setConfirmDiscardBinding(true)
      return
    }
    discardBindingDraft()
  }

  function discardBindingDraft() {
    setConfirmDiscardBinding(false)
    setBindingApiKey('')
    setSelectedInstance(null)
  }

  useEffect(() => {
    if (!bindingDirty) return undefined
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [bindingDirty])

  const loadTemplates = useCallback(async (force = false) => {
    templatesAbortRef.current?.abort()
    const controller = new AbortController()
    templatesAbortRef.current = controller
    const requestId = ++templatesRequestRef.current
    setTemplatesLoading(true)
    try {
      const result = await agentsApi.getTemplates(force, controller.signal)
      if (requestId !== templatesRequestRef.current) return
      setTemplates(result)
      setTemplatesLoaded(true)
      setTemplatesError('')
      setCreateTemplateId((current) => result.some((template) => template.id === current) ? current : result[0]?.id || '')
    } catch (error) {
      if (!controller.signal.aborted && requestId === templatesRequestRef.current) {
        setTemplatesError(loadErrorMessage(error, '历史模板说明读取失败'))
      }
    } finally {
      if (templatesAbortRef.current === controller) templatesAbortRef.current = null
      if (requestId === templatesRequestRef.current) setTemplatesLoading(false)
    }
  }, [])

  const loadData = useCallback(async (force = false) => {
    dataAbortRef.current?.abort()
    const controller = new AbortController()
    dataAbortRef.current = controller
    const sequence = ++requestSequenceRef.current
    setRuntimeLoading(false)
    if (!instancesLoadedRef.current) setLoading(true)
    else setRefreshing(true)

    const instanceParams = {
      page: instancePage,
      pageSize: instancePageSize,
      keyword: instanceKeyword,
      primaryOnly: instanceScope === 'primary',
      includeRuntime: false,
    }
    const instancesResult = await agentsApi.listInstances(instanceParams, force, controller.signal)
      .then((value) => ({ status: 'fulfilled' as const, value }))
      .catch((reason: unknown) => ({ status: 'rejected' as const, reason }))
    if (sequence !== requestSequenceRef.current) return

    let anySuccess = false
    if (instancesResult.status === 'fulfilled') {
      setInstances(instancesResult.value.instances)
      setInstanceTotal(instancesResult.value.total)
      instancesLoadedRef.current = true
      setInstancesLoaded(true)
      setLoadedInstanceViewKey(instanceViewKey(instanceScope, instanceKeyword, instancePage, instancePageSize))
      setLoadedInstancePage(instancesResult.value.page)
      setLoadedInstancePageSize(instancesResult.value.pageSize)
      if (instancesResult.value.page !== instancePage) setInstancePage(instancesResult.value.page)
      setInstancesError('')
      anySuccess = true
    } else {
      setInstancesError(loadErrorMessage(instancesResult.reason, '智能体实例读取失败'))
    }
    if (anySuccess) setLastSuccessfulReadAt(new Date())
    setLoading(false)
    setRefreshing(false)

    if (instancesResult.status === 'fulfilled') {
      setRuntimeLoading(true)
      try {
        const runtimeResult = await agentsApi.listInstances({
          ...instanceParams,
          includeRuntime: true,
          refreshRuntime: force,
        }, force, controller.signal)
        if (sequence !== requestSequenceRef.current) return
        setInstances(runtimeResult.instances)
        setInstanceTotal(runtimeResult.total)
        setLoadedInstancePage(runtimeResult.page)
        setLoadedInstancePageSize(runtimeResult.pageSize)
        if (runtimeResult.page !== instancePage) setInstancePage(runtimeResult.page)
        setRuntimeError('')
        setLastSuccessfulReadAt(new Date())
      } catch (error) {
        if (sequence === requestSequenceRef.current) {
          setRuntimeError(loadErrorMessage(error, 'Dify 运行状态探测失败'))
        }
      } finally {
        if (dataAbortRef.current === controller) dataAbortRef.current = null
        if (sequence === requestSequenceRef.current) setRuntimeLoading(false)
      }
    } else if (sequence === requestSequenceRef.current) {
      if (dataAbortRef.current === controller) dataAbortRef.current = null
      setRuntimeLoading(false)
    }
  }, [instanceKeyword, instancePage, instancePageSize, instanceScope])

  const loadRunHistory = useCallback(async (force = false) => {
    runHistoryAbortRef.current?.abort()
    const controller = new AbortController()
    runHistoryAbortRef.current = controller
    const requestId = ++runHistoryRequestRef.current
    setRunHistoryLoading(true)
    setRunHistoryError('')
    try {
      const response = await agentsApi.listRuns({
        page: runPage,
        pageSize: runPageSize,
        keyword: runKeyword,
        status: runStatus,
        instanceId: runInstanceId ? Number(runInstanceId) : undefined,
      }, force, controller.signal)
      if (runHistoryRequestRef.current === requestId) {
        setRunHistory(response)
        setLoadedRunViewKey(runViewKey(runKeyword, runStatus, runInstanceId, response.page, response.pageSize))
        if (response.page !== runPage) setRunPage(response.page)
      }
    } catch (error) {
      if (!controller.signal.aborted && runHistoryRequestRef.current === requestId) {
        setRunHistoryError(loadErrorMessage(error, '智能体运行记录读取失败'))
      }
    } finally {
      if (runHistoryAbortRef.current === controller) runHistoryAbortRef.current = null
      if (runHistoryRequestRef.current === requestId) setRunHistoryLoading(false)
    }
  }, [runInstanceId, runKeyword, runPage, runPageSize, runStatus])

  useEffect(() => {
    if (!instanceSearchSettled || instanceKeywordInput.trim() !== instanceKeyword) return
    void loadData()
  }, [instanceKeyword, instanceKeywordInput, instanceSearchSettled, loadData])

  useEffect(() => {
    void loadTemplates()
  }, [loadTemplates])

  useEffect(() => {
    if (!runHistoryOpen || !runSearchSettled || runKeywordInput.trim() !== runKeyword) return
    void loadRunHistory()
  }, [loadRunHistory, runHistoryOpen, runKeyword, runKeywordInput, runSearchSettled])

  useEffect(() => {
    if (!instancesError && !templatesError && !runtimeError && (!runHistoryOpen || !runHistoryError)) return

    const retryFailedReads = () => {
      if (!navigator.onLine || document.visibilityState !== 'visible') return
      if (instancesError || runtimeError) void loadData(true)
      if (templatesError) void loadTemplates(true)
      if (runHistoryOpen && runHistoryError) void loadRunHistory(true)
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
  }, [instancesError, loadData, loadRunHistory, loadTemplates, runHistoryError, runHistoryOpen, runtimeError, templatesError])

  useEffect(() => {
    if (!runHistoryOpen) return
    runFilterAbortRef.current?.abort()
    const controller = new AbortController()
    runFilterAbortRef.current = controller
    const filterRequestId = ++runFilterRequestRef.current
    void agentsApi.listInstances({
      page: 1,
      pageSize: 50,
      primaryOnly: false,
      includeRuntime: false,
    }, false, controller.signal).then((response) => {
      if (runFilterRequestRef.current === filterRequestId) setRunFilterInstances(response.instances)
    }).catch(() => undefined).finally(() => {
      if (runFilterAbortRef.current === controller) runFilterAbortRef.current = null
    })
  }, [runHistoryOpen])

  const closeRunHistory = () => {
    runHistoryRequestRef.current += 1
    runFilterRequestRef.current += 1
    runHistoryAbortRef.current?.abort()
    runHistoryAbortRef.current = null
    runFilterAbortRef.current?.abort()
    runFilterAbortRef.current = null
    setRunHistoryLoading(false)
    setRunEvidenceTarget(null)
    setRunHistoryOpen(false)
  }

  const invalidateInstanceList = () => {
    requestSequenceRef.current += 1
    dataAbortRef.current?.abort()
    dataAbortRef.current = null
    setInstancesError('')
    setRuntimeError('')
    setLoading(false)
    setRuntimeLoading(false)
    setRefreshing(true)
  }

  const invalidateRunHistory = () => {
    runHistoryRequestRef.current += 1
    runHistoryAbortRef.current?.abort()
    runHistoryAbortRef.current = null
    setRunHistoryError('')
    setRunHistoryLoading(true)
    setRunEvidenceTarget(null)
  }

  const handleRefresh = async () => {
    if (refreshInFlightRef.current) return
    refreshInFlightRef.current = true
    try {
      await Promise.all([loadData(true), loadTemplates(true)])
    } finally {
      refreshInFlightRef.current = false
    }
  }

  const handleCreate = async () => {
    if (!isAdmin) {
      toast.error('仅管理员可新建智能体应用')
      return
    }
    if (createMode === 'built_in_template' && (!templatesLoaded || templatesLoading || !templates.some((template) => template.id === createTemplateId))) {
      toast.warning(templatesError ? '历史模板读取失败，请重试后再创建' : '请等待历史模板读取完成后再创建')
      return
    }
    if (createInFlightRef.current) {
      createAbortRef.current?.abort()
      return
    }
    createInFlightRef.current = true
    const controller = new AbortController()
    createAbortRef.current = controller
    setSaving(true)
    try {
      const payload: CreateAgentInstancePayload = {
        name: createName.trim() || (createMode === 'external_dify'
          ? '智慧空间智能体'
          : createMode === 'built_in_template'
          ? templates.find((template) => template.id === createTemplateId)?.title || '新建智能体实例'
          : (dslFile?.name.replace(/\.(yml|yaml)$/i, '') || 'DSL 导入实例')),
        description: createDescription.trim(),
        sourceType: createMode,
        sourceTemplate: createMode === 'built_in_template' ? createTemplateId : '',
        instanceType: createMode === 'external_dify' ? 'chatflow' : undefined,
        difyAppId: createMode === 'external_dify' ? createDifyAppId.trim() : '',
        difyConsoleUrl: createMode === 'external_dify' ? createDifyUrl.trim() : '',
        difyApiKey: createMode === 'external_dify' ? createDifyApiKey.trim() : '',
        isDefault: createMode === 'external_dify' ? createIsDefault : false,
        enabled: createEnabled,
      }
      let nextInstance: AgentInstance
      if (createMode === 'uploaded_dsl' && dslFile) {
        const created = await agentsApi.createInstance(payload, controller.signal)
        try {
          const upload = await agentsApi.uploadDsl(created.id, dslFile, controller.signal)
          nextInstance = upload.instance
        } catch (uploadError) {
          if (controller.signal.aborted) throw uploadError
          await agentsApi.deleteInstance(created.id).catch(() => undefined)
          const message = businessErrorMessage(uploadError, { fallback: 'DSL 上传失败', service: '智能体模板上传' })
          throw new Error(`${message}，平台实例已回滚，当前并未导入 Dify。`)
        }
      } else {
        nextInstance = await agentsApi.createInstance(payload, controller.signal)
      }
      setInstances((prev) => [nextInstance, ...prev.filter((item) => item.id !== nextInstance.id)])
      setCreateOpen(false)
      setCreateMode('external_dify')
      setDslFile(null)
      setCreateName('')
      setCreateDescription('')
      setCreateTemplateId('template-00')
      setCreateEnabled(true)
      setCreateDifyUrl('')
      setCreateDifyAppId('')
      setCreateDifyApiKey('')
      setCreateIsDefault(true)
      toast.success('智能体应用已创建')
      setSaving(false)
      void loadData(true)
    } catch (error) {
      if (controller.signal.aborted) {
        toast.warning('已取消前端等待；创建或 DSL 解析可能已经完成，正在复核实例列表')
        void loadData(true)
        return
      }
      const message = businessErrorMessage(error, { fallback: '创建智能体应用失败', service: '智能体应用' })
      toast.error(message)
    } finally {
      if (createAbortRef.current === controller) {
        createAbortRef.current = null
        createInFlightRef.current = false
        setSaving(false)
      }
    }
  }

  const handleDslFileChange = (file: File | null) => {
    if (!file) {
      setDslFile(null)
      return
    }
    try {
      validateAgentDslFile(file)
      setDslFile(file)
    } catch (error) {
      setDslFile(null)
      toast.error(error instanceof Error ? error.message : 'DSL 文件不可用')
    }
  }

  const handleDeleteInstance = async () => {
    if (!isAdmin) {
      setDeleteTarget(null)
      toast.error('仅管理员可删除智能体应用')
      return
    }
    if (!deleteTarget) return
    if (deleteInFlightRef.current) {
      deleteAbortRef.current?.abort()
      return
    }
    if (!instanceActionsAllowed) {
      toast.warning('当前实例快照已过期，请等待列表更新后再删除')
      return
    }
    deleteInFlightRef.current = true
    const controller = new AbortController()
    deleteAbortRef.current = controller
    const target = deleteTarget
    setDeletingInstanceId(target.id)
    try {
      await agentsApi.deleteInstance(target.id, controller.signal)
      toast.success('智能体应用已删除')
      setInstances((current) => current.filter((instance) => instance.id !== target.id))
      setInstanceTotal((current) => Math.max(0, current - 1))
      if (selectedInstance?.id === target.id) {
        setSelectedInstance(null)
      }
      setDeleteTarget(null)
      if (instances.length === 1 && instancePage > 1) setInstancePage((value) => value - 1)
      else void loadData(true)
    } catch (error) {
      if (controller.signal.aborted) {
        toast.warning('已取消前端等待；删除可能已经完成，正在复核实例列表')
        setDeleteTarget(null)
        void loadData(true)
        return
      }
      toast.error(businessErrorMessage(error, { fallback: '删除智能体应用失败', service: '智能体应用' }))
    } finally {
      if (deleteAbortRef.current === controller) {
        deleteAbortRef.current = null
        deleteInFlightRef.current = false
        setDeletingInstanceId(null)
      }
    }
  }

  const handleSaveBinding = async () => {
    if (!isAdmin) {
      toast.error('仅管理员可保存智能体调用配置')
      return
    }
    if (!selectedInstance) return
    if (bindingInFlightRef.current) {
      bindingAbortRef.current?.abort()
      return
    }
    if (!instanceActionsAllowed) {
      toast.warning('当前实例快照已过期，请等待列表更新后再保存')
      return
    }
    bindingInFlightRef.current = true
    const controller = new AbortController()
    bindingAbortRef.current = controller
    const targetId = selectedInstance.id
    const requestId = ++bindingRequestRef.current
    setBindingSaving(true)
    try {
      const updated = await agentsApi.updateInstance(targetId, {
        difyAppId: selectedInstance.difyAppId.trim(),
        difyConsoleUrl: selectedInstance.difyConsoleUrl.trim(),
        difyApiKey: bindingApiKey.trim() || undefined,
        isDefault: selectedInstance.isDefault,
      }, controller.signal)
      if (bindingRequestRef.current !== requestId) return
      setBindingApiKey('')
      setSelectedInstance((current) => current?.id === targetId ? updated : current)
      setInstances((prev) => prev.map((item) => (item.id === updated.id ? updated : item)))
      toast.success(updated.difyAppId ? 'Dify App 绑定已保存' : 'Dify App 绑定状态已更新')
    } catch (error) {
      if (controller.signal.aborted) {
        toast.warning('已取消前端等待；配置可能已经保存，正在复核实例状态')
        setBindingApiKey('')
        setSelectedInstance(null)
        void loadData(true)
        return
      }
      if (bindingRequestRef.current === requestId) {
        toast.error(businessErrorMessage(error, { fallback: '保存 Dify 绑定失败', service: 'Dify 应用绑定' }))
      }
    } finally {
      if (bindingAbortRef.current === controller) {
        bindingAbortRef.current = null
        bindingInFlightRef.current = false
      }
      if (bindingRequestRef.current === requestId) {
        setBindingSaving(false)
      }
    }
  }

  const openTestRun = (instance: AgentInstance) => {
    if (testRunning || !instanceTestAllowed) return
    setTestTarget(instance)
    setTestResult(null)
    setAllowTestSideEffects(false)
    if (instance.isDefault || instance.sourceTemplate === 'template-00') {
      setTestQuery('查询当前系统服务状态')
    } else if (instance.sourceTemplate === 'template-02') {
      setTestQuery('查询当前可用照明设备及状态，不要执行控制')
    } else if (instance.sourceTemplate === 'template-03') {
      setTestQuery('根据知识库回答：系统支持哪些核心能力？')
    } else if (instance.sourceTemplate === 'template-04') {
      setTestQuery('查询当前室内温度和最近 24 小时趋势')
    } else {
      setTestQuery('请执行一次智能家居平台联调自检，并返回完整的运行结果')
    }
  }

  const testResultUncertain = (error: unknown) => (
    error instanceof ApiError && error.status === 0
    || error instanceof Error && /网络中断|无法连接|network|connection reset/i.test(error.message)
  )

  const reconcileTestRun = (targetId: number) => {
    const reconcileId = ++testReconcileRef.current
    if (testReconcileTimerRef.current !== null) window.clearTimeout(testReconcileTimerRef.current)
    const readFinalState = async () => {
      const [instancesResult, targetRunsResult] = await Promise.allSettled([
        agentsApi.listInstances({
          page: instancePage,
          pageSize: instancePageSize,
          keyword: instanceKeyword,
          primaryOnly: instanceScope === 'primary',
          includeRuntime: false,
        }, true),
        agentsApi.listRuns({ page: 1, pageSize: 10, instanceId: targetId }, true),
        runHistoryOpen ? loadRunHistory(true) : Promise.resolve(),
      ])
      if (testReconcileRef.current !== reconcileId || instancesResult.status !== 'fulfilled') return
      setInstances(current => instancesResult.value.instances.map(instance => {
        const previous = current.find(item => item.id === instance.id)
        return previous?.runtime ? { ...instance, runtime: previous.runtime } : instance
      }))
      setInstanceTotal(instancesResult.value.total)
      instancesLoadedRef.current = true
      setInstancesLoaded(true)
      setLoadedInstanceViewKey(instanceViewKey(instanceScope, instanceKeyword, instancePage, instancePageSize))
      setLoadedInstancePage(instancesResult.value.page)
      setLoadedInstancePageSize(instancesResult.value.pageSize)
      setLastSuccessfulReadAt(new Date())
      if (
        targetRunsResult.status === 'fulfilled'
        && runHistoryOpen
        && runPage === 1
        && runStatus === ''
        && runKeyword === ''
        && runInstanceId !== ''
        && Number(runInstanceId) === targetId
      ) {
        setRunHistory(targetRunsResult.value)
        setRunHistoryError('')
      }
    }
    void readFinalState().finally(() => {
      if (testReconcileRef.current !== reconcileId) return
      testReconcileTimerRef.current = window.setTimeout(() => {
        if (testReconcileRef.current !== reconcileId) return
        testReconcileTimerRef.current = null
        void readFinalState()
      }, 1200)
    })
  }

  const handleTestRun = async () => {
    if (!testTarget) return
    if (testInFlightRef.current) {
      const targetId = testTarget.id
      testRequestRef.current += 1
      testInFlightRef.current = false
      testAbortControllerRef.current?.abort()
      testAbortControllerRef.current = null
      setTestRunning(false)
      toast.warning('已取消等待测试结果；Dify 任务可能仍在运行，正在重新读取实例和运行记录')
      reconcileTestRun(targetId)
      return
    }
    if (!instanceTestAllowed) {
      toast.warning(runtimeError ? 'Dify 运行状态当前不可用，请恢复连接并刷新后再测试' : '当前实例状态尚未读取完成，请关闭测试窗口并等待刷新')
      return
    }
    if (!canTestInstance(testTarget)) {
      toast.warning(instanceTestDisabledReason(testTarget))
      return
    }
    const targetId = testTarget.id
    const hasSideEffects = testQueryHasSideEffects(testQuery)
    if (hasSideEffects && !allowTestSideEffects) {
      toast.warning('该测试可能控制真实设备或执行场景，请先勾选允许真实副作用')
      return
    }
    testInFlightRef.current = true
    const requestId = ++testRequestRef.current
    const controller = new AbortController()
    testAbortControllerRef.current = controller
    setTestRunning(true)
    setTestResult(null)
    try {
      const result = await agentsApi.testRun(targetId, testQuery, allowTestSideEffects, controller.signal)
      if (testRequestRef.current !== requestId) return
      setTestResult(result)
      toast.success(result.workflowRunId ? '智能体测试运行完成，已返回运行标识' : '智能体测试运行完成')
    } catch (error) {
      if (controller.signal.aborted) return
      if (testRequestRef.current === requestId) {
        if (testResultUncertain(error)) {
          toast.warning('测试结果暂时无法确认，正在重新读取实例和运行记录，请勿立即重复提交')
          reconcileTestRun(targetId)
          return
        }
        toast.error(businessErrorMessage(error, { fallback: '智能体测试运行失败', service: 'Dify 智能体' }))
      }
    } finally {
      if (testRequestRef.current === requestId) {
        testInFlightRef.current = false
        if (testAbortControllerRef.current === controller) testAbortControllerRef.current = null
        setTestRunning(false)
        void loadData(true)
        if (runHistoryOpen) void loadRunHistory(true)
      }
    }
  }

  const renderActions = (instance: AgentInstance) => (
    <div className="flex items-center justify-end gap-1.5 whitespace-nowrap">
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          if (instanceNavigationAllowed) router.push(instance.entryRoute || '/chat')
        }}
        disabled={!instanceNavigationAllowed}
        title={instanceNavigationAllowed ? `${instance.isDefault ? '进入当前智能体的' : '打开相关'}${entryRouteLabel(instance.entryRoute)}` : '请等待当前筛选条件读取完成'}
        className={`inline-flex h-9 items-center justify-center gap-1.5 rounded-[8px] px-3 text-xs font-bold transition disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500 ${instance.isDefault ? 'bg-slate-900 text-white hover:bg-slate-700' : 'border border-slate-200 bg-white text-slate-600 hover:border-blue-200 hover:text-blue-700'}`}
      >
        {instance.isDefault ? '业务入口' : '相关页面'} <ArrowRight size={14} />
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          openTestRun(instance)
        }}
        disabled={!instanceTestAllowed || !canTestInstance(instance)}
        title={!instanceNavigationAllowed ? '请等待当前筛选条件读取完成' : runtimeError ? '请恢复 Dify 连接并刷新运行状态' : runtimeLoading ? '正在确认 Dify 运行状态' : canTestInstance(instance) ? '运行只读测试' : instanceTestDisabledReason(instance)}
        className="inline-flex h-9 items-center justify-center gap-1.5 rounded-[8px] border border-emerald-200 px-3 text-xs font-bold text-emerald-700 transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400 disabled:hover:bg-transparent"
      >
        <PlayCircle size={14} /> 测试
      </button>
      {isAdmin ? (
        <>
          {instanceNavigationAllowed && buildDifyInstanceUrl(instance) ? (
            <a
              href={buildDifyInstanceUrl(instance)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => event.stopPropagation()}
              title="打开 Dify 应用"
              aria-label={`打开 ${instanceBusinessName(instance)} 的 Dify 应用`}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] border border-blue-100 bg-blue-50 text-blue-700 transition hover:bg-blue-100"
            >
              <ExternalLink size={15} />
            </a>
          ) : (
            <button
              type="button"
              disabled
              title="尚未绑定具体 Dify 应用"
              aria-label={`${instanceBusinessName(instance)}尚未绑定具体 Dify 应用`}
              className="inline-flex h-9 w-9 items-center justify-center rounded-[8px] border border-slate-200 bg-slate-50 text-slate-400"
            >
              <ExternalLink size={15} />
            </button>
          )}
        </>
      ) : null}
    </div>
  )

  if (loading && !instancesLoaded) {
    return (
      <div className="flex min-h-[70vh] items-center justify-center">
        <div className="flex items-center gap-3 rounded-[8px] border border-slate-100 bg-white px-5 py-3 text-sm font-semibold text-slate-500">
          <Loader2 size={18} className="animate-spin text-blue-600" />
          正在加载智能体框架与应用...
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-7xl space-y-8">
      {(instancesError && instancesLoaded) || templatesError || runtimeError ? (
        <div className="flex flex-col gap-3 rounded-[8px] border border-amber-100 bg-amber-50 px-5 py-4 text-sm font-medium text-amber-800 sm:flex-row sm:items-center sm:justify-between" role="alert">
          <div className="space-y-1 leading-6">
            {instancesError && instancesLoaded ? <p>智能体实例：{instancesError}{instanceSnapshotMatchesView ? '，继续显示当前条件下的上次成功快照。' : '，保留的旧快照不代表当前筛选条件，实例操作已暂停。'}</p> : null}
            {templatesError ? <p>历史模板：{templatesError}{templatesLoaded ? '，继续显示上次成功数据。' : '，尚未取得模板数据。'}</p> : null}
            {runtimeError ? <p>Dify 运行状态：{runtimeError}，实例元数据与最近测试记录仍可使用。</p> : null}
          </div>
          <button type="button" onClick={() => void handleRefresh()} disabled={refreshing} className="inline-flex min-h-9 shrink-0 items-center justify-center gap-2 rounded-[8px] bg-white px-4 py-2 text-xs font-black text-amber-800 disabled:cursor-wait disabled:opacity-50">
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />重新读取
          </button>
        </div>
      ) : null}
      <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-3xl space-y-3">
          <h1 className="text-4xl font-black text-slate-900">智能体框架与应用</h1>
          <p className="text-lg font-medium leading-8 text-slate-500">
            用于登记 Dify 智能体、绑定应用标识和 API 密钥、设为当前运行入口，并保留历史模板作为架构参考。
          </p>
          <p className="text-xs font-semibold text-slate-400">
            30 秒读取缓存 · {lastSuccessfulReadAt ? `最近成功读取 ${lastSuccessfulReadAt.toLocaleTimeString('zh-CN')}` : loading ? '正在读取真实实例状态' : '尚未取得实例数据'}
          </p>
          {!authLoading && !isAdmin ? <p className="text-xs font-semibold leading-5 text-blue-700">当前账号可查看智能体状态、进入对应平台页面并执行允许的只读测试；绑定、密钥、默认实例与 Dify 深度配置由管理员负责。</p> : null}
        </div>
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => setRunHistoryOpen(true)}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[8px] border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-600 transition hover:border-blue-200 hover:text-blue-600"
          >
            <History size={17} />
            运行记录
          </button>
          <button type="button" aria-label="刷新智能体实例" title="刷新实例状态" onClick={() => void handleRefresh()} disabled={loading || refreshing || runtimeLoading} className="inline-flex h-11 w-11 items-center justify-center rounded-[8px] border border-slate-200 bg-white text-slate-500 transition hover:border-blue-200 hover:text-blue-600 disabled:cursor-wait disabled:opacity-50">
            <RefreshCw size={17} className={refreshing || runtimeLoading ? 'animate-spin' : ''} />
          </button>
          {authLoading ? (
            <div className="inline-flex min-h-11 items-center gap-2 rounded-[8px] border border-slate-100 bg-white px-5 text-sm font-semibold text-slate-400"><Loader2 size={16} className="animate-spin" />正在确认权限</div>
          ) : isAdmin ? (
            <button
              type="button"
              onClick={openCreateDialog}
              disabled={!instanceActionsAllowed}
              title={instanceActionsAllowed ? '绑定 Dify 智能体' : '请等待实例列表读取成功'}
              className="inline-flex items-center gap-2 rounded-[8px] bg-blue-600 px-5 py-3 text-sm font-bold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus size={18} />
              绑定 Dify 智能体
            </button>
          ) : null}
        </div>
      </header>

      <section className="border-y border-blue-100 bg-blue-50/70 px-6 py-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-3xl">
            <h2 className="text-xl font-black text-slate-900">Prompt 编辑与管理功能</h2>
            <p className="mt-2 text-sm leading-7 text-slate-600">
              进入 Dify 应用编辑页，维护系统提示词、变量、节点提示词、开场白和工具调用说明。
            </p>
          </div>
          {isAdmin && primaryInstance && buildDifyInstanceUrl(primaryInstance) ? <a
            href={buildDifyInstanceUrl(primaryInstance)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-[8px] bg-blue-600 px-5 py-3 text-sm font-bold text-white transition hover:bg-blue-500"
          >
            <ExternalLink size={16} />
            进入 Prompt 编辑与管理
          </a> : isAdmin ? <button
            type="button"
            disabled
            title={!instanceSnapshotMatchesView ? '请等待当前实例列表读取完成' : '当前主智能体未配置 Dify 控制台地址'}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-[8px] bg-slate-200 px-5 py-3 text-sm font-bold text-slate-500"
          >
            <ExternalLink size={16} />
            进入 Prompt 编辑与管理
          </button> : <div className="max-w-sm text-sm font-semibold leading-6 text-blue-800">
            Prompt、节点和发布配置由管理员在 Dify 中维护；当前账号可在下方查看运行状态并执行自己的只读测试。
          </div>}
        </div>
      </section>

      <section className="rounded-[8px] border border-slate-200 bg-white p-5 md:p-8">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-2">
            <h2 className="text-2xl font-black text-slate-900">智能体实例管理</h2>
            <p className="text-sm leading-7 text-slate-500">
              {instanceScope === 'primary'
                ? '默认只显示平台统一主智能体；切换到全部实例可查看历史拆分与备用应用。'
                : '正在显示全部已登记实例；“当前使用”标识代表平台统一主调用入口。'}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-3 lg:justify-end">
            <div className="inline-flex rounded-[8px] border border-slate-200 bg-slate-50 p-1">
              <button
                type="button"
                onClick={() => {
                  if (instanceScope === 'primary') return
                  invalidateInstanceList()
                  setInstanceScope('primary')
                  setInstancePage(1)
                }}
                className={`rounded-[6px] px-4 py-2 text-xs font-black transition ${instanceScope === 'primary' ? 'bg-blue-600 text-white' : 'text-slate-600'}`}
              >
                主入口
              </button>
              <button
                type="button"
                onClick={() => {
                  if (instanceScope === 'all') return
                  invalidateInstanceList()
                  setInstanceScope('all')
                  setInstancePage(1)
                }}
                className={`rounded-[6px] px-4 py-2 text-xs font-black transition ${instanceScope === 'all' ? 'bg-blue-600 text-white' : 'text-slate-600'}`}
              >
                全部实例
              </button>
            </div>
            <div className="inline-flex rounded-[8px] border border-slate-200 bg-slate-50 p-1">
              <button
                type="button"
                onClick={() => setViewMode('card')}
                title="卡片视图"
                aria-label="切换到卡片视图"
                className={`inline-flex h-8 w-9 items-center justify-center rounded-[6px] transition ${viewMode === 'card' ? 'bg-blue-600 text-white' : 'text-slate-600'}`}
              >
                <LayoutGrid size={15} />
              </button>
              <button
                type="button"
                onClick={() => setViewMode('list')}
                title="列表视图"
                aria-label="切换到列表视图"
                className={`inline-flex h-8 w-9 items-center justify-center rounded-[6px] transition ${viewMode === 'list' ? 'bg-blue-600 text-white' : 'text-slate-600'}`}
              >
                <List size={15} />
              </button>
            </div>
          </div>
        </div>

        <div className="relative mt-5 max-w-md">
          <Search size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            value={instanceKeywordInput}
            onChange={(event) => {
              invalidateInstanceList()
              setInstanceSearchSettled(false)
              setInstanceKeywordInput(event.target.value)
            }}
            placeholder={instanceScope === 'primary' ? '搜索主智能体名称或用途' : '搜索全部实例名称、用途或模板'}
            aria-label="搜索智能体实例"
            className="h-11 w-full rounded-[8px] border border-slate-200 bg-slate-50 pl-11 pr-4 text-sm font-medium text-slate-700 outline-none transition placeholder:text-slate-400 focus:border-blue-300 focus:bg-white focus:ring-2 focus:ring-blue-100"
          />
        </div>

        {refreshing && instancesLoaded ? (
          <div className="mt-5 flex items-center gap-2 border-l-2 border-blue-500 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700" role="status">
            <Loader2 size={14} className="animate-spin" />
            正在更新智能体实例，{instanceSnapshotMatchesView ? '当前暂时显示同一筛选条件下的上次成功结果' : '下方旧快照不代表当前筛选条件，相关操作暂不可用'}
          </div>
        ) : null}

        {!instancesLoaded && instancesError ? (
          <div className="mt-6 border-y border-amber-200 bg-amber-50 px-6 py-14 text-center" role="alert">
            <AlertTriangle className="mx-auto mb-3 text-amber-600" size={28} />
            <p className="text-sm font-black text-amber-900">智能体实例尚未取得</p>
            <p className="mx-auto mt-2 max-w-xl break-words text-xs leading-6 text-amber-700">{instancesError}</p>
            <p className="mt-1 text-xs leading-6 text-amber-700/80">当前不能确认实例数量和状态，请重新读取后再进行配置或测试。</p>
            <button type="button" onClick={() => void handleRefresh()} disabled={refreshing} className="mt-4 inline-flex min-h-9 items-center justify-center gap-2 rounded-[8px] bg-white px-4 py-2 text-xs font-black text-amber-800 disabled:cursor-wait disabled:opacity-50">
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />重新读取实例
            </button>
          </div>
        ) : null}

        {instancesLoaded && viewMode === 'card' ? (
          <div className="mt-6 grid gap-5 lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {instances.map((instance) => (
              <article
                key={instance.id}
                onClick={(event) => {
                  if ((event.target as HTMLElement).closest('button, a, input, select, textarea, [role="button"]')) return
                  openInstanceDialog(instance)
                }}
                title={instanceNavigationAllowed ? '查看智能体详情' : '请等待当前筛选条件读取完成'}
                className={`rounded-[8px] border border-slate-200 bg-white p-6 transition ${instanceNavigationAllowed ? 'cursor-pointer hover:border-blue-200' : 'cursor-not-allowed opacity-75'}`}
              >
                <div className="flex flex-col gap-4">
                  <div>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        openInstanceDialog(instance)
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return
                        event.preventDefault()
                        event.stopPropagation()
                        openInstanceDialog(instance)
                      }}
                      disabled={!instanceNavigationAllowed}
                      aria-label={`查看“${instanceBusinessName(instance)}”智能体详情`}
                      title={instanceBusinessName(instance)}
                      className="line-clamp-2 min-h-[56px] w-full break-words rounded-[6px] text-left text-xl font-black text-slate-900 outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed"
                    >
                      {instanceBusinessName(instance)}
                    </button>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span className={`inline-flex whitespace-nowrap rounded-[6px] px-2.5 py-1 text-xs font-bold ${instance.isDefault ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-500'}`}>
                        {instance.isDefault ? '当前使用' : instanceTypeLabel(instance.instanceType)}
                      </span>
                      <span className={`inline-flex whitespace-nowrap rounded-[6px] px-2.5 py-1 text-xs font-bold ${runtimeStatusStyle(instance)}`}>
                        {runtimeStatusLabel(instance)}
                      </span>
                    </div>
                  </div>
                  <p className="min-h-[56px] text-sm leading-7 text-slate-500">
                    {instanceBusinessDescription(instance)}
                  </p>
                </div>

                <div className="mt-5 space-y-2 border-y border-slate-100 py-4">
                  <div className="flex items-center justify-between gap-4 text-sm">
                    <span className="font-semibold text-slate-400">来源</span>
                    <span className="line-clamp-2 text-right font-semibold leading-5 text-slate-700" title={sourceTemplateLabel(instance)}>{sourceTemplateLabel(instance)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-4 text-sm">
                    <span className="font-semibold text-slate-400">最近更新</span>
                    <span className="whitespace-nowrap font-semibold text-slate-700">{formatDateTime(instance.updatedAt)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-4 text-sm">
                    <span className="font-semibold text-slate-400">调用配置</span>
                    <span className={`line-clamp-2 text-right font-semibold leading-5 ${bindingTone(instance)}`} title={bindingLabel(instance)}>{bindingLabel(instance)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-4 text-sm">
                    <span className="font-semibold text-slate-400">最近测试</span>
                    <span className={`line-clamp-2 text-right font-semibold leading-5 ${instance.lastRun?.status === 'failed' ? 'text-rose-600' : instance.lastRun?.status === 'success' ? 'text-emerald-700' : 'text-slate-500'}`} title={lastRunLabel(instance)}>{lastRunLabel(instance)}</span>
                  </div>
                </div>

                <div className="mt-5">
                  {renderActions(instance)}
                </div>
              </article>
            ))}
          </div>
        ) : instancesLoaded ? (
          <>
          <div className="mt-6 overflow-hidden rounded-[8px] border border-slate-200 bg-white md:hidden">
            <div className="divide-y divide-slate-100">
              {instances.map((instance) => (
                <article key={instance.id} className="px-4 py-4">
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => openInstanceDialog(instance)}
                      disabled={!instanceNavigationAllowed}
                      title={instanceNavigationAllowed ? '查看智能体配置' : '请等待当前筛选条件读取完成'}
                      className="min-w-0 flex-1 rounded-[6px] text-left outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed"
                    >
                      <span className="block break-words text-sm font-black leading-5 text-slate-900 [overflow-wrap:anywhere]">{instanceBusinessName(instance)}</span>
                      <span className="mt-1 block text-xs font-semibold text-slate-500">{instanceTypeLabel(instance.instanceType)} · {instance.isDefault ? '当前使用' : '备用实例'}</span>
                    </button>
                    <span className={`inline-flex shrink-0 rounded-[6px] px-2 py-1 text-[11px] font-black leading-4 ${runtimeStatusStyle(instance)}`}>
                      {runtimeStatusLabel(instance)}
                    </span>
                  </div>
                  <dl className="mt-3 grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 border-t border-slate-100 pt-3 text-xs leading-5">
                    <dt className="font-semibold text-slate-400">调用配置</dt>
                    <dd className={`min-w-0 break-words font-bold [overflow-wrap:anywhere] ${bindingTone(instance)}`}>{bindingLabel(instance)}</dd>
                    <dt className="font-semibold text-slate-400">最近测试</dt>
                    <dd className={`min-w-0 break-words font-bold [overflow-wrap:anywhere] ${instance.lastRun?.status === 'failed' ? 'text-rose-600' : instance.lastRun?.status === 'success' ? 'text-emerald-700' : 'text-slate-500'}`}>{lastRunLabel(instance)}</dd>
                    <dt className="font-semibold text-slate-400">更新时间</dt>
                    <dd className="font-semibold text-slate-600">{formatDateTime(instance.updatedAt)}</dd>
                  </dl>
                  <div className="mt-3 border-t border-slate-100 pt-3">{renderActions(instance)}</div>
                </article>
              ))}
              {instances.length === 0 ? (
                <div className="px-6 py-14 text-center">
                  <Bot className="mx-auto mb-3 text-slate-300" size={28} />
                  <p className="text-sm font-black text-slate-700">{instanceKeyword ? '没有匹配的智能体实例' : instanceScope === 'primary' ? '暂无统一主智能体' : '暂无智能体实例'}</p>
                  <p className="mt-1 text-xs leading-5 text-slate-400">{instanceKeyword ? '请调整搜索关键词后重试。' : '绑定或导入智能体应用后会出现在这里。'}</p>
                </div>
              ) : null}
            </div>
          </div>
          <div className="mt-6 hidden overflow-x-auto rounded-[8px] border border-slate-200 bg-white md:block">
            <div className="min-w-[1180px]">
              <div className="grid grid-cols-[minmax(180px,1fr)_105px_100px_125px_145px_130px_125px_200px] gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs font-bold text-slate-500">
                <div className="sticky left-0 z-10 -ml-4 bg-slate-50 py-3 pl-4 shadow-[8px_0_12px_-12px_rgba(15,23,42,0.45)]">智能体名称</div>
                <div>应用类型</div>
                <div>运行入口</div>
                <div>运行状态</div>
                <div>调用配置</div>
                <div>最近测试</div>
                <div>更新时间</div>
                <div className="sticky right-0 z-10 -mr-4 bg-slate-50 py-3 pr-4 text-right shadow-[-8px_0_12px_-12px_rgba(15,23,42,0.45)]">操作</div>
              </div>
              <div className="divide-y divide-slate-100">
              {instances.map((instance) => (
                <article
                  key={instance.id}
                  className="grid min-h-16 grid-cols-[minmax(180px,1fr)_105px_100px_125px_145px_130px_125px_200px] items-center gap-3 px-4 py-3 transition hover:bg-slate-50/70"
                >
                  <div className="sticky left-0 z-10 -ml-4 min-w-0 self-stretch bg-white py-3 pl-4 shadow-[8px_0_12px_-12px_rgba(15,23,42,0.45)]">
                    <button
                      type="button"
                      onClick={() => openInstanceDialog(instance)}
                      disabled={!instanceNavigationAllowed}
                      title={instanceNavigationAllowed ? '查看智能体配置' : '请等待当前筛选条件读取完成'}
                      className="block min-w-0 text-left disabled:cursor-not-allowed"
                    >
                      <span className="block truncate text-sm font-black text-slate-900" title={instanceBusinessName(instance)}>{instanceBusinessName(instance)}</span>
                    </button>
                  </div>
                  <div className="truncate text-sm font-semibold text-slate-600" title={INSTANCE_TYPE_LABELS[instance.instanceType] ? instanceTypeLabel(instance.instanceType) : `技术类型：${instance.instanceType || '未返回'}`}>
                    {instanceTypeLabel(instance.instanceType)}
                  </div>
                  <div className={`truncate text-sm font-bold ${instance.isDefault ? 'text-blue-700' : 'text-slate-500'}`} title={instance.isDefault ? '当前使用' : '备用'}>
                    {instance.isDefault ? '当前使用' : '备用'}
                  </div>
                  <div className="min-w-0">
                    <div className={`truncate text-sm font-bold ${runtimeStatusTone(instance)}`} title={runtimeStatusLabel(instance)}>
                      {runtimeStatusLabel(instance)}
                    </div>
                  </div>
                  <div className="min-w-0">
                    <div className={`truncate text-sm font-bold ${bindingTone(instance)}`} title={bindingLabel(instance)}>{bindingLabel(instance)}</div>
                  </div>
                  <div className="min-w-0">
                    <div className={`truncate text-sm font-bold ${instance.lastRun?.status === 'failed' ? 'text-rose-600' : instance.lastRun?.status === 'success' ? 'text-emerald-700' : 'text-slate-500'}`} title={lastRunLabel(instance)}>
                      {lastRunLabel(instance)}
                    </div>
                  </div>
                  <div className="whitespace-nowrap text-xs font-semibold text-slate-500">
                    {formatDateTime(instance.updatedAt)}
                  </div>
                  <div className="sticky right-0 z-10 -mr-4 flex min-w-0 self-stretch items-center justify-end bg-white pr-4 shadow-[-8px_0_12px_-12px_rgba(15,23,42,0.45)]">
                    {renderActions(instance)}
                  </div>
                </article>
              ))}
              </div>

            {instances.length === 0 ? (
              <div className="border-t border-slate-100 px-6 py-16 text-center">
                <Bot className="mx-auto mb-3 text-slate-300" size={28} />
                <p className="text-sm font-black text-slate-700">{instanceKeyword ? '没有匹配的智能体实例' : instanceScope === 'primary' ? '暂无统一主智能体' : '暂无智能体实例'}</p>
                <p className="mt-1 text-xs text-slate-400">{instanceKeyword ? '请调整搜索关键词后重试。' : '绑定或导入智能体应用后会出现在这里。'}</p>
              </div>
            ) : null}
            </div>
          </div>
          </>
        ) : null}
        {instancesLoaded ? <Pagination
          page={loadedInstancePage}
          pageSize={loadedInstancePageSize}
          total={instanceTotal}
          loading={loading || refreshing}
          navigationDisabled={!instanceSnapshotMatchesView}
          onPageChange={(value) => { invalidateInstanceList(); setInstancePage(value) }}
          onPageSizeChange={(value) => { invalidateInstanceList(); setInstancePageSize(value); setInstancePage(1) }}
          pageSizeOptions={[5, 10, 20]}
          itemName="个实例"
          className="mt-5 px-0"
        /> : null}
      </section>

      <AppDrawer
        open={runHistoryOpen}
        title="智能体运行记录"
        description="保留平台测试请求、执行结果和 Dify 运行标识；普通用户仅能查看自己的记录。"
        onClose={closeRunHistory}
        widthClassName="max-w-5xl"
        headerActions={(
          <button
            type="button"
            onClick={() => void loadRunHistory(true)}
            disabled={runHistoryLoading}
            className="inline-flex h-9 w-9 items-center justify-center rounded-[6px] border border-slate-200 text-slate-500 transition hover:border-blue-200 hover:text-blue-700 disabled:opacity-50"
            aria-label="刷新运行记录"
            title="刷新运行记录"
          >
            <RefreshCw size={16} className={runHistoryLoading ? 'animate-spin' : ''} />
          </button>
        )}
        footer={(
          runHistory ? (
            <Pagination
              page={runHistory.page}
              pageSize={runHistory.pageSize}
              total={runHistory.total}
              itemName="条运行记录"
              loading={runHistoryLoading}
              navigationDisabled={!runSnapshotActionsAllowed}
              onPageChange={(value) => { invalidateRunHistory(); setRunPage(value) }}
              onPageSizeChange={(value) => { invalidateRunHistory(); setRunPageSize(value); setRunPage(1) }}
              className="border-0 p-0"
            />
          ) : null
        )}
      >
        {runHistory ? (
          <div className="mb-5 grid grid-cols-2 overflow-hidden rounded-[8px] border border-slate-200 sm:grid-cols-4">
            {[
              [runHistory.visibilityScope === 'all' ? '全部记录' : '我的记录', runHistory.summary.totalRuns],
              ['执行成功', runHistory.summary.successfulRuns],
              ['执行失败', runHistory.summary.failedRuns],
              ['近 24 小时', runHistory.summary.runs24h],
            ].map(([label, value]) => (
              <div key={label} className="border-b border-r border-slate-100 bg-slate-50 px-4 py-3 last:border-r-0 sm:border-b-0">
                <div className="text-xs font-semibold text-slate-400">{label}</div>
                <div className="mt-1 text-xl font-black text-slate-900">{value}</div>
              </div>
            ))}
          </div>
        ) : null}

        <div className="mb-5 grid gap-3 sm:grid-cols-[minmax(0,1fr)_150px_180px]">
          <label className="relative min-w-0">
            <Search size={15} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              value={runKeywordInput}
              onChange={(event) => {
                invalidateRunHistory()
                setRunSearchSettled(false)
                setRunKeywordInput(event.target.value)
              }}
              placeholder={runHistory?.visibilityScope === 'all' ? '搜索请求、智能体或操作人' : '搜索我的请求或智能体'}
              aria-label="搜索运行记录"
              className="min-h-10 w-full rounded-[8px] border border-slate-200 bg-white pl-10 pr-4 text-xs font-semibold text-slate-700 outline-none transition placeholder:text-slate-400 focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
            />
          </label>
          <UnifiedSelect
            ariaLabel="筛选运行记录执行结果"
            size="sm"
            className="[&>button]:rounded-[8px]"
            value={runStatus}
            onChange={(value) => { invalidateRunHistory(); setRunStatus(value); setRunPage(1) }}
            options={[
              { value: '', label: '全部结果' },
              { value: 'success', label: '执行成功' },
              { value: 'failed', label: '执行失败' },
            ]}
          />
          <UnifiedSelect
            ariaLabel="筛选运行记录智能体"
            size="sm"
            className="[&>button]:rounded-[8px]"
            value={runInstanceId}
            onChange={(value) => { invalidateRunHistory(); setRunInstanceId(value); setRunPage(1) }}
            options={[
              { value: '', label: '全部智能体' },
              ...(runFilterInstances.length ? runFilterInstances : instances).map((instance) => ({ value: String(instance.id), label: instanceBusinessName(instance) })),
            ]}
          />
        </div>

        {runHistoryError && runHistory ? (
          <div className="mb-4 border-l-2 border-rose-400 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700" role="alert">
            {runHistoryError}，继续显示上次成功读取的运行记录快照。
          </div>
        ) : null}

        {runHistoryLoading && runHistory ? (
          <div className="mb-4 border-l-2 border-blue-400 bg-blue-50 px-4 py-3 text-xs font-semibold leading-5 text-blue-700">
            正在读取新的筛选结果，当前继续显示上次成功快照；详情与分页暂不可操作。
          </div>
        ) : null}

        {runHistoryLoading && !runHistory ? (
          <div className="flex items-center justify-center gap-3 py-16 text-sm font-semibold text-slate-400"><Loader2 size={18} className="animate-spin" />正在读取运行记录</div>
        ) : runHistoryError && !runHistory ? (
          <div className="py-16 text-center" role="alert">
            <History className="mx-auto text-slate-300" size={28} />
            <p className="mt-3 text-sm font-black text-slate-700">运行记录未取得</p>
            <p className="mx-auto mt-2 max-w-xl break-words text-xs leading-5 text-rose-600">{runHistoryError}</p>
            <p className="mt-1 text-xs text-slate-400">恢复平台连接后重新读取，不会将读取失败计为 0 条记录。</p>
            <button type="button" onClick={() => void loadRunHistory(true)} disabled={runHistoryLoading} className="mt-4 inline-flex min-h-9 items-center justify-center gap-2 rounded-[6px] border border-slate-200 px-3 py-2 text-xs font-black text-slate-600 transition hover:border-blue-200 hover:text-blue-700 disabled:cursor-wait disabled:opacity-50"><RefreshCw size={14} className={runHistoryLoading ? 'animate-spin' : ''} />{runHistoryLoading ? '正在重新读取' : '重新读取运行记录'}</button>
          </div>
        ) : runHistory?.items.length ? (
          <>
          <div className="overflow-hidden rounded-[8px] border border-slate-200 md:hidden">
            <div className="divide-y divide-slate-100">
              {runHistory.items.map((run) => (
                <article key={run.id} className="px-4 py-4">
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className={`text-sm font-black ${run.status === 'success' ? 'text-emerald-700' : 'text-rose-700'}`}>{run.status === 'success' ? '执行成功' : '执行失败'}</div>
                      <p className="mt-1 line-clamp-2 break-words text-sm font-semibold leading-6 text-slate-700 [overflow-wrap:anywhere]" title={run.query || '未记录测试请求'}>{run.query || '未记录测试请求'}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => { if (runSnapshotActionsAllowed) setRunEvidenceTarget(run) }}
                      disabled={!runSnapshotActionsAllowed}
                      title={runSnapshotActionsAllowed ? '查看运行证据' : '请等待当前筛选结果读取完成'}
                      className="inline-flex min-h-9 shrink-0 items-center rounded-[6px] border border-slate-200 px-3 text-xs font-bold text-slate-600 transition hover:border-blue-200 hover:text-blue-700 disabled:cursor-not-allowed disabled:text-slate-300"
                    >
                      查看证据
                    </button>
                  </div>
                  <dl className="mt-3 grid grid-cols-[4rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-t border-slate-100 pt-3 text-xs leading-5">
                    <dt className="font-semibold text-slate-400">智能体</dt><dd className="min-w-0 break-words font-bold text-slate-700 [overflow-wrap:anywhere]">{run.businessName || run.instanceName || '历史智能体'}</dd>
                    <dt className="font-semibold text-slate-400">操作人</dt><dd className="min-w-0 break-words font-semibold text-slate-600 [overflow-wrap:anywhere]">{run.username || '系统用户'}</dd>
                    <dt className="font-semibold text-slate-400">执行时间</dt><dd className="font-semibold text-slate-600">{formatDateTime(run.createdAt || undefined)}</dd>
                  </dl>
                </article>
              ))}
            </div>
          </div>
          <div className="hidden overflow-x-auto rounded-[8px] border border-slate-200 md:block">
            <div className="min-w-[900px]">
              <div className="grid grid-cols-[105px_minmax(220px,1fr)_160px_110px_130px_90px] gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs font-bold text-slate-500">
                <div>执行结果</div>
                <div>测试请求</div>
                <div>智能体</div>
                <div>操作人</div>
                <div>执行时间</div>
                <div className="text-right">运行证据</div>
              </div>
              <div className="divide-y divide-slate-100">
                {runHistory.items.map((run) => (
                  <div key={run.id} className="grid min-h-16 grid-cols-[105px_minmax(220px,1fr)_160px_110px_130px_90px] items-center gap-3 px-4 py-3 transition hover:bg-slate-50/70">
                    <div className={`truncate text-sm font-bold ${run.status === 'success' ? 'text-emerald-700' : 'text-rose-700'}`} title={run.status === 'success' ? '执行成功' : '执行失败'}>
                      {run.status === 'success' ? '执行成功' : '执行失败'}
                    </div>
                    <div className="truncate text-sm font-semibold text-slate-700" title={run.query || '未记录测试请求'}>
                      {run.query || '未记录测试请求'}
                    </div>
                    <div className="truncate text-sm font-semibold text-slate-700" title={run.businessName || run.instanceName || '历史智能体'}>
                      {run.businessName || run.instanceName || '历史智能体'}
                    </div>
                    <div className="truncate text-sm text-slate-600" title={run.username || '系统用户'}>{run.username || '系统用户'}</div>
                    <div className="whitespace-nowrap text-xs font-semibold text-slate-500">{formatDateTime(run.createdAt || undefined)}</div>
                    <button
                      type="button"
                      onClick={() => { if (runSnapshotActionsAllowed) setRunEvidenceTarget(run) }}
                      disabled={!runSnapshotActionsAllowed}
                      title={runSnapshotActionsAllowed ? '查看运行证据' : '请等待当前筛选结果读取完成'}
                      className="justify-self-end rounded-[6px] border border-slate-200 px-2.5 py-1.5 text-xs font-bold text-slate-600 transition hover:border-blue-200 hover:text-blue-700 disabled:cursor-not-allowed disabled:text-slate-300 disabled:hover:border-slate-200"
                    >
                      查看
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
          </>
        ) : (
          <div className="py-16 text-center">
            <History className="mx-auto text-slate-300" size={28} />
            <p className="mt-3 text-sm font-black text-slate-700">暂无匹配的运行记录</p>
            <p className="mt-1 text-xs text-slate-400">执行一次智能体测试后，运行证据会保留在这里。</p>
          </div>
        )}
      </AppDrawer>

      {runEvidenceTarget && mounted ? createPortal(
        <AppDialog
          title="运行证据"
          description={`${runEvidenceTarget.businessName || runEvidenceTarget.instanceName || '历史智能体'} · ${formatDateTime(runEvidenceTarget.createdAt || undefined)}`}
          onClose={() => setRunEvidenceTarget(null)}
          maxWidth="max-w-lg"
          zIndexClass="z-[10000]"
          panelClassName="!rounded-[8px]"
        >
          <div className="space-y-4">
            <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-4 gap-y-3 border-y border-slate-100 py-4 text-sm">
              <div className="font-semibold text-slate-400">执行结果</div>
              <div className={`font-bold ${runEvidenceTarget.status === 'success' ? 'text-emerald-700' : 'text-rose-700'}`}>{runEvidenceTarget.status === 'success' ? '执行成功' : '执行失败'}</div>
              <div className="font-semibold text-slate-400">测试请求</div>
              <div className="break-words font-semibold text-slate-700">{runEvidenceTarget.query || '未记录测试请求'}</div>
              <div className="font-semibold text-slate-400">操作人</div>
              <div className="break-words font-semibold text-slate-700">{runEvidenceTarget.username || '系统用户'}</div>
              <div className="font-semibold text-slate-400">执行时间</div>
              <div className="break-words font-semibold text-slate-700">{formatFullDateTime(runEvidenceTarget.createdAt || undefined)}</div>
              {runEvidenceTarget.status === 'success' ? <><div className="font-semibold text-slate-400">返回摘要</div><div className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-semibold leading-6 text-slate-700">{runEvidenceTarget.answer || '该历史记录未保存返回摘要。'}</div></> : null}
              {runEvidenceTarget.error ? <><div className="font-semibold text-slate-400">失败原因</div><div className="break-words font-semibold text-rose-700">{runErrorLabel(runEvidenceTarget.error)}</div></> : null}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <TechnicalId label="Dify 工作流标识" value={runEvidenceTarget.workflowRunId} />
              <TechnicalId label="Dify 消息标识" value={runEvidenceTarget.messageId} />
              {runEvidenceTarget.error ? <TechnicalId label="原始错误" value={runEvidenceTarget.error} /> : null}
            </div>
          </div>
        </AppDialog>,
        document.body,
      ) : null}

      {confirmDiscardBinding ? (
        <AppDialog
          title="放弃未保存的调用配置？"
          description="关闭后，本次对 Dify App 标识、工作流地址、默认实例和临时 API 密钥的修改不会保留。"
          onClose={() => setConfirmDiscardBinding(false)}
          closeOnOverlay
          showClose={false}
          maxWidth="max-w-md"
          zIndexClass="z-[10002]"
          initialFocusRef={discardBindingCancelRef}
          footer={(
            <div className="flex justify-end gap-3">
              <button
                ref={discardBindingCancelRef}
                type="button"
                onClick={() => setConfirmDiscardBinding(false)}
                className="rounded-[8px] border border-slate-200 px-5 py-3 text-sm font-bold text-slate-600 transition hover:border-blue-200 hover:text-blue-700"
              >
                继续编辑
              </button>
              <button
                type="button"
                onClick={discardBindingDraft}
                className="rounded-[8px] bg-rose-600 px-5 py-3 text-sm font-bold text-white transition hover:bg-rose-700"
              >
                放弃修改
              </button>
            </div>
          )}
        >
          <p className="text-sm leading-7 text-slate-500">
            已保存的智能体配置不会受到影响；如需保留本次修改，请先返回并执行“保存调用配置”。
          </p>
        </AppDialog>
      ) : null}

      {selectedInstance && mounted ? createPortal(
        <div className="dialog-overlay p-3 sm:p-6 [@media(max-height:520px)]:p-3" style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0, 0, 0, 0.4)', backdropFilter: 'blur(4px)' }}>
          <div aria-hidden="true" className="absolute inset-0" onClick={closeInstanceDialog} />
          <div
            ref={instanceDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={instanceDialogTitleId}
            tabIndex={-1}
            className="dialog-panel relative flex max-h-[calc(100dvh-1.5rem)] w-full max-w-3xl flex-col rounded-[8px] p-4 sm:max-h-[calc(100dvh-3rem)] sm:p-8 [@media(max-height:520px)]:max-h-[calc(100dvh-1.5rem)] [@media(max-height:520px)]:p-4"
            style={{ position: 'relative', zIndex: 1, width: '100%', maxWidth: '48rem', border: '1px solid rgba(255, 255, 255, 0.7)', background: 'rgba(255, 255, 255, 0.98)', boxShadow: '0 25px 70px rgba(15, 23, 42, 0.2)', backdropFilter: 'blur(18px)' }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-6">
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-3">
                  <h2 id={instanceDialogTitleId} className="text-2xl font-black text-slate-900">{instanceBusinessName(selectedInstance)}</h2>
                  <span className="inline-flex whitespace-nowrap rounded-[6px] bg-slate-100 px-3 py-1 text-xs font-black text-slate-600" title={INSTANCE_TYPE_LABELS[selectedInstance.instanceType] ? undefined : `技术类型：${selectedInstance.instanceType || '未返回'}`}>
                    {instanceTypeLabel(selectedInstance.instanceType)}
                  </span>
                  <span className={`inline-flex whitespace-nowrap rounded-[6px] px-3 py-1 text-xs font-black ${INSTANCE_STATUS_STYLES[selectedInstance.status] || 'bg-slate-100 text-slate-500'}`} title={INSTANCE_STATUS_LABELS[selectedInstance.status] ? undefined : `技术状态：${selectedInstance.status || '未返回'}`}>
                    {instanceStatusLabel(selectedInstance.status)}
                  </span>
                  <span className={`inline-flex whitespace-nowrap rounded-[6px] px-3 py-1 text-xs font-black ${selectedInstance.isDefault ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-500'}`}>
                    {selectedInstance.isDefault ? '当前使用' : '历史/备用'}
                  </span>
                </div>
                <p className="text-sm leading-7 text-slate-500">
                  {instanceBusinessDescription(selectedInstance)}
                </p>
              </div>
              <button
                type="button"
                onClick={closeInstanceDialog}
                disabled={bindingSaving}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] border border-slate-200 bg-white text-slate-500 transition hover:border-blue-200 hover:bg-slate-50 hover:text-blue-600 disabled:cursor-wait disabled:opacity-50"
                aria-label="关闭"
              >
                <X size={14} />
              </button>
            </div>

        <div className="dialog-scrollbar -mr-2 mt-4 min-h-0 flex-1 overscroll-contain overflow-y-auto pr-2 sm:-mr-3 sm:mt-6 sm:pr-3 [@media(max-height:520px)]:-mr-2 [@media(max-height:520px)]:mt-3 [@media(max-height:520px)]:pr-2">
          <div className="grid overflow-hidden rounded-[8px] border border-slate-200 md:grid-cols-2">
                <div className="border-b border-slate-100 bg-slate-50 px-5 py-4 md:border-r">
                  <div className="text-xs font-bold text-slate-500">来源模板</div>
                  <div className="mt-2 text-sm font-semibold text-slate-700">{sourceTemplateLabel(selectedInstance)}</div>
                </div>
                <div className="border-b border-slate-100 bg-slate-50 px-5 py-4">
                  <div className="text-xs font-bold text-slate-500">使用模型</div>
                  <div className="mt-2 text-sm font-semibold text-slate-700">{selectedInstance.defaultModel || '未配置'}</div>
                </div>
                <div className="border-b border-slate-100 bg-slate-50 px-5 py-4 md:border-r">
                  <div className="text-xs font-bold text-slate-500">绑定知识库</div>
                  <div className="mt-2 text-sm font-semibold text-slate-700">{compactList(selectedInstance.knowledgeBindings, '未绑定')}</div>
                </div>
                <div className="border-b border-slate-100 bg-slate-50 px-5 py-4">
                  <div className="text-xs font-bold text-slate-500">绑定外部能力</div>
                  <div className="mt-2 text-sm font-semibold text-slate-700">{compactList(selectedInstance.capabilityTags, '未配置')}</div>
                </div>
                <div className="border-b border-slate-100 bg-slate-50 px-5 py-4 md:border-r">
                  <div className="text-xs font-bold text-slate-500">入口页面</div>
                  <div className="mt-2 text-sm font-semibold text-slate-700">{entryRouteLabel(selectedInstance.entryRoute)}</div>
                </div>
                <div className="border-b border-slate-100 bg-slate-50 px-5 py-4">
                  <div className="text-xs font-bold text-slate-500">最后更新时间</div>
                  <div className="mt-2 text-sm font-semibold text-slate-700">{formatDateTime(selectedInstance.updatedAt)}</div>
                </div>
                <div className="border-b border-slate-100 bg-slate-50 px-5 py-4 md:col-span-2">
                  <div className="text-xs font-bold text-slate-500">DSL 文件</div>
                  <div className="mt-2 text-sm font-semibold text-slate-700">{selectedInstance.dslFileName || '尚未归档 DSL 文件'}</div>
                </div>
                <div className="bg-slate-50 px-5 py-4 md:border-r">
                  <div className="text-xs font-bold text-slate-500">Dify 运行状态</div>
                  <div className="mt-2 text-sm font-semibold text-slate-700">{runtimeStatusLabel(selectedInstance)}</div>
                  <div className="mt-1 text-xs leading-5 text-slate-500">{selectedInstance.runtime?.checkedAt ? `${formatDateTime(selectedInstance.runtime.checkedAt)} 检测${selectedInstance.runtime.latencyMs !== null ? ` · ${selectedInstance.runtime.latencyMs} 毫秒` : ''}` : '尚未完成运行探测'}</div>
                </div>
                <div className="bg-slate-50 px-5 py-4">
                  <div className="text-xs font-bold text-slate-500">最近测试</div>
                  <div className={`mt-2 text-sm font-semibold ${selectedInstance.lastRun?.status === 'failed' ? 'text-rose-600' : selectedInstance.lastRun?.status === 'success' ? 'text-emerald-700' : 'text-slate-700'}`}>{lastRunLabel(selectedInstance)}</div>
                  <div className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500" title={selectedInstance.lastRun?.query || (selectedInstance.lastRun?.error ? runErrorLabel(selectedInstance.lastRun.error) : '完成一次测试运行后会记录真实结果。')}>{selectedInstance.lastRun?.query || (selectedInstance.lastRun?.error ? runErrorLabel(selectedInstance.lastRun.error) : '完成一次测试运行后会记录真实结果。')}</div>
                </div>
              </div>
              {isAdmin ? <div className="mt-5 border-t border-blue-100 bg-blue-50/70 px-5 py-5">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <div className="text-sm font-black text-blue-950">Dify 智能体调用绑定</div>
                    <p className="mt-1 text-sm leading-6 text-blue-800">
                      {selectedInstance.hasDifyApiKey
                        ? '当前实例已配置 Dify 应用 API 密钥，设为当前使用后智能体对话会优先调用该应用。'
                        : selectedInstance.isDefault
                          ? '当前实例未配置独立 API 密钥，测试和对话会使用系统运行时密钥。'
                          : '当前备用实例未配置独立 API 密钥，保存密钥或设为当前使用后才能测试。'}
                    </p>
                  </div>
                  <span className={`inline-flex w-fit rounded-[6px] px-3 py-1 text-xs font-black ${selectedInstance.hasDifyApiKey ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                    {selectedInstance.hasDifyApiKey ? 'API 密钥已配置' : 'API 密钥未配置'}
                  </span>
                </div>
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <label className="space-y-2">
                    <span className="text-xs font-bold text-blue-600">Dify 应用标识</span>
                    <input
                      value={selectedInstance.difyAppId}
                      disabled={!instanceActionsAllowed}
                      onChange={(event) => setSelectedInstance((prev) => (prev ? { ...prev, difyAppId: event.target.value } : prev))}
                      className="w-full rounded-[8px] border border-blue-100 bg-white px-4 py-3 text-sm outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-100 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500"
                      placeholder="例如 app-xxxxxxxx"
                    />
                  </label>
                  <label className="space-y-2">
                    <span className="text-xs font-bold text-blue-600">Dify 聊天或控制台地址</span>
                    <input
                      value={selectedInstance.difyConsoleUrl}
                      disabled={!instanceActionsAllowed}
                      onChange={(event) => setSelectedInstance((prev) => (prev ? { ...prev, difyConsoleUrl: event.target.value } : prev))}
                      className="w-full rounded-[8px] border border-blue-100 bg-white px-4 py-3 text-sm outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-100 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500"
                      placeholder="例如 http://192.168.1.20/app/.../workflow"
                    />
                  </label>
                  <label className="space-y-2">
                    <span className="text-xs font-bold text-blue-600">Dify 应用 API 密钥</span>
                    <input
                      value={bindingApiKey}
                      disabled={!instanceActionsAllowed}
                      onChange={(event) => setBindingApiKey(event.target.value)}
                      className="w-full rounded-[8px] border border-blue-100 bg-white px-4 py-3 text-sm outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-100 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500"
                      placeholder={selectedInstance.difyApiKeyMasked || '填写 app- 开头的应用 API 密钥'}
                      type="password"
                      autoComplete="new-password"
                    />
                  </label>
                  <label className="inline-flex items-center gap-3 rounded-[8px] border border-blue-100 bg-white px-4 py-3 text-sm font-semibold text-blue-800">
                    <input
                      type="checkbox"
                      checked={selectedInstance.isDefault}
                      disabled={!instanceActionsAllowed}
                      onChange={(event) => setSelectedInstance((prev) => (prev ? { ...prev, isDefault: event.target.checked } : prev))}
                      className="h-4 w-4 shrink-0 rounded-[4px] border border-blue-200 accent-blue-600 outline-none focus-visible:ring-2 focus-visible:ring-blue-500/25 disabled:cursor-not-allowed disabled:opacity-60"
                    />
                    设为当前运行智能体
                  </label>
                </div>
                <div className="mt-4 flex justify-end">
                  <button
                    type="button"
                    onClick={handleSaveBinding}
                    disabled={!instanceActionsAllowed}
                    title={instanceActionsAllowed ? '保存调用配置' : '请等待当前实例列表读取完成'}
                    className="inline-flex items-center gap-2 rounded-[8px] bg-blue-600 px-5 py-3 text-sm font-bold text-white disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
                  >
                    {bindingSaving ? <X size={16} /> : <CheckCircle2 size={16} />}
                    {bindingSaving ? '取消等待' : '保存调用配置'}
                  </button>
                </div>
              </div> : null}
              <div className="mt-5 border-l-2 border-amber-400 bg-amber-50 px-5 py-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-700" />
                  <div>
                    <div className="text-sm font-black text-amber-900">运行测试口径</div>
                    <p className="mt-2 text-sm leading-6 text-amber-800">
                      测试运行优先使用本实例的 Dify 应用 API 密钥；未填写时才回退系统设置里的 Dify 应用 API 密钥。真实提示词、节点和发布仍在 Dify 控制台维护。
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-8 flex flex-wrap justify-between gap-3 border-t border-slate-100 pt-6 [@media(max-height:520px)]:mt-3 [@media(max-height:520px)]:pt-3">
              {isAdmin ? <button
                type="button"
                onClick={() => setDeleteTarget(selectedInstance)}
                disabled={!instanceActionsAllowed}
                title={instanceActionsAllowed ? '删除智能体应用' : '请等待当前实例列表读取完成'}
                className="inline-flex items-center gap-2 rounded-[8px] border border-rose-200 px-4 py-2.5 text-sm font-bold text-rose-600 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400 disabled:hover:bg-transparent"
              >
                <Trash2 size={16} />
                删除智能体应用
              </button> : <span className="text-xs font-semibold text-slate-400">当前账号为只读实例视图，可进入页面并执行自己的测试。</span>}
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => { if (instanceNavigationAllowed) router.push(selectedInstance.entryRoute || '/chat') }}
                  disabled={!instanceNavigationAllowed}
                  title={instanceNavigationAllowed ? `${selectedInstance.isDefault ? '进入当前智能体的' : '打开相关'}${entryRouteLabel(selectedInstance.entryRoute)}` : '请等待当前实例列表读取完成'}
                  className={`rounded-[8px] border px-4 py-2.5 text-sm font-bold disabled:cursor-not-allowed disabled:text-slate-400 ${selectedInstance.isDefault ? 'border-slate-300 bg-slate-900 text-white' : 'border-slate-200 text-slate-600'}`}
                >
                  {selectedInstance.isDefault ? '业务入口' : '相关页面'}
                </button>
                {isAdmin && instanceNavigationAllowed && buildDifyInstanceUrl(selectedInstance) ? <a
                  href={buildDifyInstanceUrl(selectedInstance)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 rounded-[8px] border border-blue-200 px-4 py-2.5 text-sm font-bold text-blue-700 transition hover:bg-blue-50"
                >
                  <ExternalLink size={16} />
                  打开 Dify 应用
                </a> : null}
                {isAdmin && instanceNavigationAllowed && !buildDifyInstanceUrl(selectedInstance) ? (
                  <span className="inline-flex items-center rounded-[8px] border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm font-bold text-slate-400">
                    尚未绑定具体 Dify 应用
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={() => openTestRun(selectedInstance)}
                  disabled={!instanceTestAllowed || !canTestInstance(selectedInstance)}
                  title={!instanceNavigationAllowed ? '请等待当前实例列表读取完成' : runtimeError ? '请恢复 Dify 连接并刷新运行状态' : runtimeLoading ? '正在确认 Dify 运行状态' : canTestInstance(selectedInstance) ? '测试运行当前智能体' : instanceTestDisabledReason(selectedInstance)}
                  className="inline-flex items-center gap-2 rounded-[8px] bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <PlayCircle size={16} />
                  测试运行
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}

      {deleteTarget && mounted ? createPortal(
        <AppDialog
          title="删除智能体应用"
          onClose={() => { if (deletingInstanceId === null) setDeleteTarget(null) }}
          closeOnOverlay={deletingInstanceId === null}
          showClose={deletingInstanceId === null}
          maxWidth="max-w-md"
          zIndexClass="z-[10000]"
          danger
          footer={(
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                disabled={deletingInstanceId !== null}
                className="rounded-[8px] border border-slate-200 px-5 py-3 text-sm font-bold text-slate-600 disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleDeleteInstance}
                disabled={deletingInstanceId === null && !instanceActionsAllowed}
                title={deletingInstanceId !== null ? '取消等待删除结果' : instanceActionsAllowed ? '确认删除智能体应用' : '请等待当前实例列表读取完成'}
                className="inline-flex items-center gap-2 rounded-[8px] bg-rose-600 px-5 py-3 text-sm font-bold text-white disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
              >
                {deletingInstanceId !== null ? <X size={16} /> : <Trash2 size={16} />}
                {deletingInstanceId !== null ? '取消等待' : '确认删除'}
              </button>
            </div>
          )}
        >
            <div className="space-y-3">
              <p className="text-sm leading-7 text-slate-500">
                确认删除 <span className="font-semibold text-slate-700">{instanceBusinessName(deleteTarget)}</span> 吗？删除后该平台实例将从列表中移除。
              </p>
            </div>
        </AppDialog>,
        document.body,
      ) : null}

      {testTarget && mounted ? createPortal(
        <div className="dialog-overlay p-3 sm:p-6 [@media(max-height:520px)]:p-3" style={{ position: 'fixed', inset: 0, zIndex: 10001, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0, 0, 0, 0.4)', backdropFilter: 'blur(4px)' }}>
          <div aria-hidden="true" className="absolute inset-0" onClick={() => { if (!testRunning) setTestTarget(null) }} />
          <div
            ref={testDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={testDialogTitleId}
            tabIndex={-1}
            className="dialog-panel relative flex max-h-[calc(100dvh-1.5rem)] w-full max-w-3xl flex-col rounded-[8px] p-4 sm:max-h-[calc(100dvh-3rem)] sm:p-8 [@media(max-height:520px)]:max-h-[calc(100dvh-1.5rem)] [@media(max-height:520px)]:p-4"
            style={{ position: 'relative', zIndex: 1, border: '1px solid rgba(255, 255, 255, 0.7)', background: 'rgba(255, 255, 255, 0.98)', boxShadow: '0 25px 70px rgba(15, 23, 42, 0.2)', backdropFilter: 'blur(18px)' }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-6">
              <div className="space-y-2">
                <h3 id={testDialogTitleId} className="text-2xl font-black text-slate-900">测试运行智能体实例</h3>
                <p className="text-sm leading-7 text-slate-500">
                  {instanceBusinessName(testTarget)} · 优先使用实例级 Dify 应用 API 密钥发起一次同步测试，并返回运行结果。
                </p>
              </div>
              <button
                type="button"
                onClick={() => setTestTarget(null)}
                disabled={testRunning}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] border border-slate-200 bg-white text-slate-500 transition hover:border-blue-200 hover:bg-slate-50 hover:text-blue-600 disabled:cursor-wait disabled:opacity-50"
                aria-label="关闭"
              >
                <X size={14} />
              </button>
            </div>

            <div className="dialog-scrollbar -mr-2 mt-4 min-h-0 flex-1 overscroll-contain overflow-y-auto pr-2 sm:-mr-3 sm:mt-6 sm:pr-3 [@media(max-height:520px)]:-mr-2 [@media(max-height:520px)]:mt-3 [@media(max-height:520px)]:pr-2">
              <label className="space-y-2">
                <span className="text-xs font-bold text-slate-500">测试问题</span>
                <textarea
                  ref={testQueryRef}
                  value={testQuery}
                  onChange={(event) => setTestQuery(event.target.value)}
                  disabled={testRunning}
                  className="h-24 w-full rounded-[8px] border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-100 disabled:cursor-not-allowed disabled:opacity-60"
                />
              </label>

              <div className="mt-5 border-l-2 border-amber-400 bg-amber-50 px-5 py-4 text-sm leading-6 text-amber-800">
                <div className="font-black text-amber-900">绑定说明</div>
                <div className="mt-2">
                  {testTarget.difyAppId ? '当前实例已填写 Dify 应用标识。' : '当前实例未填写 Dify 应用标识，本次测试使用系统运行时密钥，不视为实例独立绑定完成。'} 非主对话流和知识检索应用可在 Dify 控制台继续查看运行记录。
                  {' '}API 密钥：{testTarget.hasDifyApiKey ? '已配置实例级密钥' : '未配置，将回退系统设置密钥'}。
                </div>
                <TechnicalId label="Dify 应用标识" value={testTarget.difyAppId} emptyText="未填写" className="mt-3" />
              </div>

              {testQueryHasSideEffects(testQuery) ? (
                <label className="mt-4 flex items-start gap-3 border-l-2 border-rose-500 bg-rose-50 px-5 py-4 text-sm leading-6 text-rose-800">
                  <input
                    type="checkbox"
                    checked={allowTestSideEffects}
                    onChange={(event) => setAllowTestSideEffects(event.target.checked)}
                    disabled={testRunning}
                    className="mt-1 h-4 w-4 shrink-0 rounded-[4px] border border-rose-300 accent-rose-600 outline-none focus-visible:ring-2 focus-visible:ring-rose-500/25 disabled:cursor-not-allowed disabled:opacity-60"
                  />
                  <span>
                    <strong className="block text-rose-900">允许真实副作用</strong>
                    当前测试语句可能控制真实设备、调节属性或执行场景。勾选后才允许下发，执行结果仍需通过 Home Assistant 和实机状态确认。
                  </span>
                </label>
              ) : (
                <div className="mt-4 border-l-2 border-emerald-500 bg-emerald-50 px-5 py-3 text-sm font-semibold text-emerald-800">
                  当前为只读测试语句，不会主动授权设备或场景控制。
                </div>
              )}

              {testResult ? (
                <div className="mt-5 space-y-4">
                  <div className="border-l-2 border-emerald-500 bg-emerald-50 px-5 py-4">
                    <div className="flex items-center gap-2 text-sm font-black text-emerald-800">
                      <CheckCircle2 size={18} />
                      测试运行完成
                    </div>
                    <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-emerald-900">{testResult.answer || 'Dify 未返回 answer 字段。'}</p>
                  </div>
                  <div className="grid overflow-hidden rounded-[8px] border border-slate-200 md:grid-cols-2">
                    <div className="border-b border-slate-100 bg-slate-50 px-4 py-3 md:border-b-0 md:border-r">
                      <div className="text-xs font-black text-slate-400">调用凭证</div>
                      <div className="mt-2 text-sm font-semibold text-slate-700">{testResult.runtimeBinding?.hasInstanceApiKey ? '使用实例独立凭证' : '使用系统运行时凭证'}</div>
                    </div>
                    <div className="bg-slate-50 px-4 py-3">
                      <div className="text-xs font-black text-slate-400">运行证据</div>
                      <div className="mt-2 text-sm font-semibold text-slate-700">{testResult.workflowRunId || testResult.messageId || testResult.taskId ? '已返回可追踪标识' : '未返回技术标识'}</div>
                    </div>
                  </div>
                  <details className="rounded-[8px] border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500">
                    <summary className="cursor-pointer font-semibold transition hover:text-blue-700">技术详情</summary>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <TechnicalId label="Dify 工作流标识" value={testResult.workflowRunId} />
                      <TechnicalId label="Dify 消息标识" value={testResult.messageId} />
                      <TechnicalId label="Dify 会话标识" value={testResult.conversationId} />
                      <TechnicalId label="Dify 任务标识" value={testResult.taskId} />
                    </div>
                  </details>
                  {testResult.warnings.length ? (
                    <div className="border-l-2 border-amber-400 bg-amber-50 px-5 py-4 text-sm leading-6 text-amber-800">
                      <div className="font-black text-amber-900">配置提醒</div>
                      <ul className="mt-2 list-disc space-y-1 pl-5">
                        {testResult.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="mt-8 flex flex-wrap justify-end gap-3 border-t border-slate-100 pt-6 [@media(max-height:520px)]:mt-3 [@media(max-height:520px)]:pt-3">
              <button
                type="button"
                onClick={() => setTestTarget(null)}
                disabled={testRunning}
                className="rounded-[8px] border border-slate-200 px-5 py-3 text-sm font-bold text-slate-600 disabled:cursor-wait disabled:opacity-50"
              >
                关闭
              </button>
              <button
                type="button"
                onClick={handleTestRun}
                disabled={!testRunning && (!instanceTestAllowed || !testQuery.trim() || (testQueryHasSideEffects(testQuery) && !allowTestSideEffects))}
                className={`inline-flex items-center gap-2 rounded-[8px] px-5 py-3 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-60 ${testRunning ? 'bg-amber-600' : 'bg-emerald-600'}`}
              >
                {testRunning ? <X size={18} /> : <PlayCircle size={18} />}
                {testRunning ? '取消等待' : '开始测试'}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}

      {createOpen && mounted ? createPortal(
        <div
          className="dialog-overlay p-3 sm:p-6 [@media(max-height:520px)]:p-3"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0, 0, 0, 0.4)',
            backdropFilter: 'blur(4px)',
          }}
        >
          <div
            aria-hidden="true"
            className="absolute inset-0"
            onClick={closeCreateDialog}
          />
          <div
            ref={createDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={createDialogTitleId}
            tabIndex={-1}
            className="dialog-panel relative flex max-h-[calc(100dvh-1.5rem)] w-full max-w-3xl flex-col rounded-[8px] p-4 sm:max-h-[calc(100dvh-3rem)] sm:p-8 [@media(max-height:520px)]:max-h-[calc(100dvh-1.5rem)] [@media(max-height:520px)]:p-4"
            style={{
              position: 'relative',
              zIndex: 1,
              width: '100%',
              maxWidth: '48rem',
              border: '1px solid rgba(255, 255, 255, 0.7)',
              background: 'rgba(255, 255, 255, 0.98)',
              boxShadow: '0 25px 70px rgba(15, 23, 42, 0.2)',
              backdropFilter: 'blur(18px)',
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-6">
              <div className="space-y-2">
                <h2 id={createDialogTitleId} className="text-2xl font-black text-slate-900">绑定已有 Dify 智能体</h2>
                <p className="text-sm leading-7 text-slate-500">
                  平台只登记和调用 Dify 应用；Prompt、节点、发布和深度编辑继续在 Dify 控制台完成。
                </p>
              </div>
              <button
                type="button"
                onClick={closeCreateDialog}
                disabled={saving}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] border border-slate-200 bg-white text-slate-500 transition hover:border-blue-200 hover:bg-slate-50 hover:text-blue-600"
                aria-label="关闭"
              >
                <X size={14} />
              </button>
            </div>

            <fieldset disabled={saving} className="contents">
            <div className="dialog-scrollbar -mr-2 mt-4 min-h-0 flex-1 overscroll-contain overflow-y-auto pr-2 sm:-mr-3 sm:mt-6 sm:pr-3 [@media(max-height:520px)]:-mr-2 [@media(max-height:520px)]:mt-3 [@media(max-height:520px)]:pr-2">
              <div className="inline-flex rounded-[8px] border border-slate-200 bg-slate-50 p-1">
                <button
                  type="button"
                  onClick={() => setCreateMode('external_dify')}
                  className={`rounded-[6px] px-4 py-2 text-sm font-bold transition ${createMode === 'external_dify' ? 'bg-blue-600 text-white' : 'text-slate-600'}`}
                >
                  绑定 Dify 应用
                </button>
                <button
                  type="button"
                  onClick={() => setCreateMode('uploaded_dsl')}
                  className={`rounded-[6px] px-4 py-2 text-sm font-bold transition ${createMode === 'uploaded_dsl' ? 'bg-blue-600 text-white' : 'text-slate-600'}`}
                >
                  上传 DSL 文件
                </button>
                <button
                  type="button"
                  onClick={() => setCreateMode('built_in_template')}
                  className={`rounded-[6px] px-4 py-2 text-sm font-bold transition ${createMode === 'built_in_template' ? 'bg-blue-600 text-white' : 'text-slate-600'}`}
                >
                  历史模板
                </button>
              </div>

              <div className="mt-6 grid gap-5">
                {createMode === 'external_dify' ? (
                  <div className="grid gap-4 md:grid-cols-2">
                    <label className="space-y-2">
                      <span className="text-xs font-bold text-slate-500">Dify 聊天或控制台地址</span>
                      <input
                        ref={createDifyUrlRef}
                        value={createDifyUrl}
                        onChange={(event) => setCreateDifyUrl(event.target.value)}
                        className="w-full rounded-[8px] border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
                        placeholder="例如 http://192.168.1.20/app/.../workflow"
                      />
                    </label>
                    <label className="space-y-2">
                      <span className="text-xs font-bold text-slate-500">Dify 应用标识</span>
                      <input
                        value={createDifyAppId}
                        onChange={(event) => setCreateDifyAppId(event.target.value)}
                        className="w-full rounded-[8px] border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
                        placeholder="填写当前 Dify 应用标识"
                      />
                    </label>
                    <label className="space-y-2 md:col-span-2">
                      <span className="text-xs font-bold text-slate-500">Dify 应用 API 密钥</span>
                      <input
                        value={createDifyApiKey}
                        onChange={(event) => setCreateDifyApiKey(event.target.value)}
                        className="w-full rounded-[8px] border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
                        placeholder="填写 app- 开头的应用 API 密钥，平台不会在响应中回传明文"
                        type="password"
                        autoComplete="new-password"
                      />
                    </label>
                  </div>
                ) : createMode === 'built_in_template' ? (
                  <div className="space-y-2">
                    <span className="text-xs font-bold text-slate-500">历史模板库</span>
                    <UnifiedSelect
                      ariaLabel="历史模板库"
                      value={createTemplateId}
                      options={templates.map((template) => ({ value: template.id, label: template.title }))}
                      disabled={templatesLoading || !templatesLoaded || templates.length === 0}
                      placeholder={templatesLoading ? '正在读取模板' : templatesError ? '模板读取失败' : '暂无可用模板'}
                      onChange={setCreateTemplateId}
                    />
                    {templatesLoading ? <p className="flex items-center gap-2 text-xs font-semibold text-slate-500"><Loader2 size={13} className="animate-spin" />正在读取历史模板</p> : templatesError ? <button type="button" onClick={() => void loadTemplates(true)} className="text-xs font-bold text-amber-700 hover:underline">模板读取失败，点击重试</button> : templatesLoaded && templates.length === 0 ? <p className="text-xs font-semibold text-slate-500">当前没有可用于创建实例的历史模板。</p> : null}
                  </div>
                ) : (
                  <label className="space-y-2">
                    <span className="text-xs font-bold text-slate-500">DSL 文件</span>
                    <label className="flex cursor-pointer items-center justify-between rounded-[8px] border border-dashed border-slate-200 bg-slate-50 px-5 py-4 transition hover:border-blue-200 hover:bg-blue-50/40">
                      <div className="flex items-center gap-3">
                        <div className="flex h-12 w-12 items-center justify-center rounded-[8px] bg-white text-blue-600">
                          <CloudUpload size={20} />
                        </div>
                        <div>
                          <div className="text-sm font-black text-slate-900">{dslFile ? dslFile.name : '点击上传 .yml / .yaml DSL 文件'}</div>
                    <div className="mt-1 text-xs text-slate-500">平台会自动解析应用名称、模式与说明；正式运行仍建议绑定已发布的 Dify 应用 API 密钥。</div>
                        </div>
                      </div>
                      <input
                        type="file"
                        aria-label="选择智能体 DSL 文件"
                        accept=".yml,.yaml"
                        className="hidden"
                        onChange={(event) => {
                          handleDslFileChange(event.target.files?.[0] || null)
                          event.currentTarget.value = ''
                        }}
                      />
                    </label>
                  </label>
                )}

                {createMode === 'built_in_template' ? (
                  <div className="grid overflow-hidden rounded-[8px] border border-slate-200 md:grid-cols-3">
                    {(() => {
                      const selectedTemplate = templates.find((template) => template.id === createTemplateId)
                      return (
                        <>
                          <div className="border-b border-slate-100 bg-slate-50 px-4 py-3 md:border-b-0 md:border-r">
                            <div className="text-xs font-bold text-slate-500">模板文件</div>
                            <div className="mt-2 text-sm font-semibold text-slate-700">{selectedTemplate?.fileName || '—'}</div>
                          </div>
                          <div className="border-b border-slate-100 bg-slate-50 px-4 py-3 md:border-b-0 md:border-r">
                            <div className="text-xs font-bold text-slate-500">应用类型</div>
                            <div className="mt-2 text-sm font-semibold text-slate-700">{selectedTemplate?.templateType || '—'}</div>
                          </div>
                          <div className="bg-slate-50 px-4 py-3">
                            <div className="text-xs font-bold text-slate-500">配置说明</div>
                            <div className="mt-2 text-sm font-semibold text-slate-700">{selectedTemplate?.description || '—'}</div>
                          </div>
                        </>
                      )
                    })()}
                  </div>
                ) : null}

                <label className="space-y-2">
                  <span className="text-xs font-bold text-slate-500">应用名称</span>
                  <input
                    value={createName}
                    onChange={(event) => setCreateName(event.target.value)}
                    className="w-full rounded-[8px] border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
                    placeholder="不填写则默认使用模板名称或 DSL 名称"
                  />
                </label>
                <label className="space-y-2">
                  <span className="text-xs font-bold text-slate-500">应用描述</span>
                  <textarea
                    value={createDescription}
                    onChange={(event) => setCreateDescription(event.target.value)}
                    className="h-24 w-full rounded-[8px] border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
                  />
                </label>
                <label className="inline-flex items-center gap-3 rounded-[8px] border border-slate-100 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-600">
                  <input
                    type="checkbox"
                    checked={createEnabled}
                    onChange={(event) => setCreateEnabled(event.target.checked)}
                    className="h-4 w-4 shrink-0 rounded-[4px] border border-slate-300 accent-blue-600 outline-none focus-visible:ring-2 focus-visible:ring-blue-500/25 disabled:cursor-not-allowed disabled:opacity-60"
                  />
                  创建后立即启用当前应用实例
                </label>
                {createMode === 'external_dify' ? (
                  <label className="inline-flex items-center gap-3 rounded-[8px] border border-blue-100 bg-blue-50 px-4 py-3 text-sm font-semibold text-blue-800">
                    <input
                      type="checkbox"
                      checked={createIsDefault}
                      onChange={(event) => setCreateIsDefault(event.target.checked)}
                      className="h-4 w-4 shrink-0 rounded-[4px] border border-blue-200 accent-blue-600 outline-none focus-visible:ring-2 focus-visible:ring-blue-500/25 disabled:cursor-not-allowed disabled:opacity-60"
                    />
                    设为当前运行智能体
                  </label>
                ) : null}
              </div>
            </div>
            </fieldset>

            <div className="mt-8 flex flex-wrap justify-end gap-3 border-t border-slate-100 pt-6 [@media(max-height:520px)]:mt-3 [@media(max-height:520px)]:pt-3">
              <button
                type="button"
                onClick={closeCreateDialog}
                disabled={saving}
                className="rounded-[8px] border border-slate-200 px-5 py-3 text-sm font-bold text-slate-600 disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleCreate}
                disabled={!saving && ((createMode === 'uploaded_dsl' && !dslFile) || (createMode === 'built_in_template' && (!templatesLoaded || templatesLoading || !templates.some((template) => template.id === createTemplateId))) || (createMode === 'external_dify' && (!createDifyUrl.trim() || !createDifyApiKey.trim())))}
                className="inline-flex items-center gap-2 rounded-[8px] bg-blue-600 px-5 py-3 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saving ? <X size={18} /> : <Plus size={18} />}
                {saving ? '取消等待' : createMode === 'external_dify' ? '保存 Dify 绑定' : '创建智能体应用'}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  )
}

export default function AgentsPage() {
  return (
    <Suspense fallback={<div className="mx-auto max-w-[1600px] py-20 text-center text-sm text-slate-400">正在读取智能体实例...</div>}>
      <AgentsContent />
    </Suspense>
  )
}
