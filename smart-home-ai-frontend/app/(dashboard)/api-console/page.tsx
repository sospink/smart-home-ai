'use client'

import { Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import {
  Eye,
  FileUp,
  History,
  Loader2,
  Plus,
  RefreshCcw,
  Save,
  Search,
  Trash2,
  XCircle,
} from 'lucide-react'

import { toast } from '@/components/ui/toast'
import { AppDialog } from '@/components/ui/AppDialog'
import { Pagination } from '@/components/ui/Pagination'
import { UnifiedSelect } from '@/components/ui/UnifiedSelect'
import { apiDocsApi, validateApiDocMarkdownFile, type ApiDocsChangeQuery, type ApiDocsEndpointQuery, type ApiDocsModuleQuery } from '@/lib/api/api-docs'
import { ApiError } from '@/lib/api/client'
import { useAuth } from '@/lib/hooks/useAuth'
import { handleTabListKeyDown } from '@/lib/ui/tabs'
import { businessErrorMessage } from '@/lib/ui/business-error'
import type {
  ApiDocChangePageResponse,
  ApiDocChangeRecord,
  ApiDocsAdminOverview,
  ApiEndpoint,
  ApiEndpointPageResponse,
  ApiEndpointWritePayload,
  ApiModulePageResponse,
  ApiReferenceModule,
  HttpMethod,
} from '@/types/api-docs'

type ActiveTab = 'basic' | 'markdown' | 'endpoints' | 'history'
type VisibilityFilter = 'all' | 'visible' | 'hidden'
type MutationAction = 'create-module' | 'save-module' | 'delete-module' | 'import-markdown' | 'import-openapi' | 'save-endpoint' | 'delete-endpoint'

const ACTIVE_TABS: ActiveTab[] = ['basic', 'markdown', 'endpoints', 'history']
const VISIBILITY_FILTERS: VisibilityFilter[] = ['all', 'visible', 'hidden']
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const INT32_MIN = -2147483648
const INT32_MAX = 2147483647

function positivePage(value: string | null) {
  const parsed = Number(value || 1)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1
}

function pageSizeFromParam(value: string | null, fallback: number, options: number[]) {
  const parsed = Number(value || fallback)
  return options.includes(parsed) ? parsed : fallback
}

function activeTabFromParam(value: string | null): ActiveTab {
  return ACTIVE_TABS.includes(value as ActiveTab) ? value as ActiveTab : 'history'
}

function visibilityFromParam(value: string | null): VisibilityFilter {
  return VISIBILITY_FILTERS.includes(value as VisibilityFilter) ? value as VisibilityFilter : 'all'
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

type ModuleForm = {
  title: string
  slug: string
  subtitle: string
  description: string
  endpointBase: string
  sortOrder: string
  isVisible: boolean
}

type EndpointForm = {
  id: number | null
  slug: string
  sourceType: string
  summary: string
  description: string
  group: string
  path: string
  method: HttpMethod
  sortOrder: string
  isVisible: boolean
  tagsText: string
  notesText: string
  paramsText: string
  responsesText: string
  codeSamplesText: string
  requestPreview: string
  responseBody: string
  responseMeta: string
}

const EMPTY_MODULE_FORM: ModuleForm = {
  title: '', slug: '', subtitle: '', description: '', endpointBase: '', sortOrder: '0', isVisible: true,
}

const EMPTY_ENDPOINT_FORM: EndpointForm = {
  id: null,
  slug: '',
  sourceType: 'manual',
  summary: '',
  description: '',
  group: 'overview',
  path: '/api/v1/',
  method: 'GET',
  sortOrder: '0',
  isVisible: true,
  tagsText: '',
  notesText: '',
  paramsText: '[]',
  responsesText: '[]',
  codeSamplesText: '[]',
  requestPreview: '',
  responseBody: '',
  responseMeta: '',
}

const SOURCE_LABELS: Record<string, string> = {
  manual: '手工维护',
  openapi: 'OpenAPI 同步',
  markdown: 'Markdown 导入',
  contract: '项目资料',
  builtin: '内置配置',
  seed: '初始化配置',
  generated: '自动生成',
}

function displayChangeNote(note?: string | null) {
  return (note || '未填写变更说明')
    .replace(/同步合同参数对应的代表接口与模块分组/g, '同步项目接口与模块分组')
    .replace(/合同资料/g, '项目资料')
    .replace(/合同维护/g, '项目资料维护')
    .replace(/合同参数/g, '项目接口')
    .replace(/代表接口/g, '接口')
}

const TARGET_LABELS: Record<string, string> = {
  module: '模块',
  endpoint: '接口',
  import: '导入任务',
}

const STRATEGY_LABELS: Record<string, string> = {
  create: '新建',
  update: '更新',
  delete: '删除',
  append: '追加',
  replace: '覆盖',
  refresh: '同步',
}

function sourceLabel(value: string) {
  return SOURCE_LABELS[value] || '其他配置来源'
}

function targetLabel(value: string) {
  return TARGET_LABELS[value] || '其他配置对象'
}

function strategyLabel(value: string) {
  return STRATEGY_LABELS[value] || '其他配置操作'
}

function moduleFormFromDetail(detail: ApiReferenceModule): ModuleForm {
  return {
    title: detail.title,
    slug: detail.slug,
    subtitle: detail.subtitle,
    description: detail.description,
    endpointBase: detail.endpointBase || '',
    sortOrder: String(detail.sortOrder ?? 0),
    isVisible: detail.isVisible,
  }
}

function endpointFormFromEndpoint(endpoint: ApiEndpoint): EndpointForm {
  return {
    id: endpoint.id,
    slug: endpoint.slug,
    sourceType: endpoint.sourceType,
    summary: endpoint.summary,
    description: endpoint.description,
    group: endpoint.group,
    path: endpoint.path,
    method: endpoint.method,
    sortOrder: String(endpoint.sortOrder ?? 0),
    isVisible: endpoint.isVisible,
    tagsText: (endpoint.tags || []).join('\n'),
    notesText: (endpoint.notes || []).join('\n'),
    paramsText: JSON.stringify(endpoint.params || [], null, 2),
    responsesText: JSON.stringify(endpoint.responses || [], null, 2),
    codeSamplesText: JSON.stringify(endpoint.codeSamples || [], null, 2),
    requestPreview: endpoint.requestPreview,
    responseBody: endpoint.responseBody,
    responseMeta: endpoint.responseMeta,
  }
}

function parseJsonArray(text: string, label: string): unknown[] {
  try {
    const value = JSON.parse(text || '[]')
    if (!Array.isArray(value)) throw new Error('必须是 JSON 数组')
    return value
  } catch (error) {
    throw new Error(`${label}格式错误：${error instanceof Error ? error.message : '无法解析'}`)
  }
}

function jsonArrayError(text: string, label: string) {
  try {
    const value = JSON.parse(text || '[]')
    return Array.isArray(value) ? '' : `${label}必须是 JSON 数组`
  } catch (error) {
    return `${label}格式错误：${error instanceof Error ? error.message : '无法解析'}`
  }
}

function requiredTextError(value: string, label: string, maxLength: number) {
  const normalized = value.trim()
  if (!normalized) return `${label}不能为空`
  if (normalized.length > maxLength) return `${label}不能超过 ${maxLength} 个字符`
  return ''
}

function slugError(value: string, label: string) {
  const requiredError = requiredTextError(value, label, 128)
  if (requiredError) return requiredError
  return SLUG_PATTERN.test(value.trim()) ? '' : `${label}仅支持小写字母、数字和单个连字符`
}

function optionalLengthError(value: string, label: string, maxLength: number) {
  return value.trim().length > maxLength ? `${label}不能超过 ${maxLength} 个字符` : ''
}

function sortOrderError(value: string) {
  const normalized = value.trim()
  if (!normalized) return '排序不能为空'
  const parsed = Number(normalized)
  if (!Number.isInteger(parsed)) return '排序必须是整数'
  if (parsed < INT32_MIN || parsed > INT32_MAX) return `排序需在 ${INT32_MIN} 到 ${INT32_MAX} 之间`
  return ''
}

function endpointPayload(form: EndpointForm): ApiEndpointWritePayload {
  if (!form.slug.trim() || !form.summary.trim()) throw new Error('请填写接口 Slug 和接口摘要')
  if (!form.path.trim().startsWith('/')) throw new Error('接口路径必须以 / 开头')
  return {
    slug: form.slug.trim(),
    group: form.group.trim() || 'overview',
    method: form.method,
    path: form.path.trim(),
    summary: form.summary.trim(),
    description: form.description.trim(),
    sortOrder: Number(form.sortOrder || 0),
    isVisible: form.isVisible,
    tags: form.tagsText.split(/[\n,，]/).map((item) => item.trim()).filter(Boolean),
    notes: form.notesText.split('\n').map((item) => item.trim()).filter(Boolean),
    params: parseJsonArray(form.paramsText, '请求参数') as ApiEndpointWritePayload['params'],
    responses: parseJsonArray(form.responsesText, '响应字段') as ApiEndpointWritePayload['responses'],
    codeSamples: parseJsonArray(form.codeSamplesText, '代码示例') as ApiEndpointWritePayload['codeSamples'],
    requestPreview: form.requestPreview,
    responseBody: form.responseBody,
    responseMeta: form.responseMeta,
  }
}

function formatDate(value: string | null | undefined) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未取得' : date.toLocaleString('zh-CN', { hour12: false })
}

function useDebouncedValue<T>(value: T, delay = 300) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timeoutId = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(timeoutId)
  }, [delay, value])
  return debounced
}

function TextAreaField({
  label,
  value,
  onChange,
  rows = 5,
  error = '',
}: {
  label: string
  value: string
  onChange: (value: string) => void
  rows?: number
  error?: string
}) {
  const fieldId = useId()
  const errorId = `${fieldId}-error`
  return (
    <div className="block space-y-2">
      <label htmlFor={fieldId} className="text-xs font-bold text-slate-500">{label}</label>
      <textarea
        id={fieldId}
        rows={rows}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        className={`w-full rounded-[8px] border bg-white px-4 py-3 text-sm text-slate-800 outline-none transition ${error ? 'border-rose-300 focus:border-rose-400 focus:ring-2 focus:ring-rose-100' : 'border-slate-200 focus:border-blue-300 focus:ring-2 focus:ring-blue-100'}`}
      />
      {error ? <p id={errorId} className="text-xs font-semibold leading-5 text-rose-600">{error}</p> : null}
    </div>
  )
}

function TextField({
  label,
  value,
  onChange,
  type = 'text',
  error = '',
  maxLength,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  type?: string
  error?: string
  maxLength?: number
}) {
  const fieldId = useId()
  const errorId = `${fieldId}-error`
  return (
    <div className="block space-y-2">
      <label htmlFor={fieldId} className="text-xs font-bold text-slate-500">{label}</label>
      <input
        id={fieldId}
        type={type}
        maxLength={maxLength}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        className={`w-full rounded-[8px] border bg-white px-4 py-3 text-sm text-slate-800 outline-none transition ${error ? 'border-rose-300 focus:border-rose-400 focus:ring-2 focus:ring-rose-100' : 'border-slate-200 focus:border-blue-300 focus:ring-2 focus:ring-blue-100'}`}
      />
      {error ? <p id={errorId} className="text-xs font-semibold leading-5 text-rose-600">{error}</p> : null}
    </div>
  )
}

function ApiConsoleContent() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { isAdmin, loading: authLoading } = useAuth()
  const [overview, setOverview] = useState<ApiDocsAdminOverview | null>(null)
  const [overviewError, setOverviewError] = useState('')
  const [modules, setModules] = useState<ApiModulePageResponse>({ items: [], total: 0, page: 1, size: 8, pageCount: 1 })
  const [moduleLoading, setModuleLoading] = useState(true)
  const [moduleError, setModuleError] = useState('')
  const [modulesLoaded, setModulesLoaded] = useState(false)
  const [moduleKeyword, setModuleKeyword] = useState(() => searchParams.get('moduleQ') || '')
  const deferredModuleKeyword = useDebouncedValue(moduleKeyword)
  const [moduleVisibility, setModuleVisibility] = useState<VisibilityFilter>(() => visibilityFromParam(searchParams.get('moduleVisibility')))
  const [modulePage, setModulePage] = useState(() => positivePage(searchParams.get('modulePage')))
  const [moduleSize, setModuleSize] = useState(() => pageSizeFromParam(searchParams.get('moduleSize'), 8, [8, 16, 32]))
  const [mutationAction, setMutationAction] = useState<MutationAction | null>(null)
  const [refreshingAll, setRefreshingAll] = useState(false)
  const [selectedModuleSlug, setSelectedModuleSlug] = useState(() => searchParams.get('module') || '')
  const [selectedModule, setSelectedModule] = useState<ApiReferenceModule | null>(null)
  const [moduleDetailLoading, setModuleDetailLoading] = useState(false)
  const [moduleDetailError, setModuleDetailError] = useState('')
  const [markdownText, setMarkdownText] = useState('')
  const [markdownFile, setMarkdownFile] = useState<File | null>(null)
  const [appendMarkdown, setAppendMarkdown] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [deleteModuleOpen, setDeleteModuleOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<ActiveTab>(() => activeTabFromParam(searchParams.get('tab')))
  const [createForm, setCreateForm] = useState({ title: '', slug: '', subtitle: '' })
  const [moduleForm, setModuleForm] = useState<ModuleForm>(EMPTY_MODULE_FORM)

  const [endpoints, setEndpoints] = useState<ApiEndpointPageResponse>({
    items: [], total: 0, page: 1, size: 8, pageCount: 1, availableFilters: { groups: [], methods: [] },
  })
  const [endpointLoading, setEndpointLoading] = useState(false)
  const [endpointError, setEndpointError] = useState('')
  const [endpointsLoaded, setEndpointsLoaded] = useState(false)
  const [endpointKeyword, setEndpointKeyword] = useState(() => searchParams.get('endpointQ') || '')
  const deferredEndpointKeyword = useDebouncedValue(endpointKeyword)
  const [endpointMethod, setEndpointMethod] = useState(() => searchParams.get('method') || '')
  const [endpointGroup, setEndpointGroup] = useState(() => searchParams.get('group') || '')
  const [endpointVisibility, setEndpointVisibility] = useState<VisibilityFilter>(() => visibilityFromParam(searchParams.get('endpointVisibility')))
  const [endpointPage, setEndpointPage] = useState(() => positivePage(searchParams.get('endpointPage')))
  const [endpointSize, setEndpointSize] = useState(() => pageSizeFromParam(searchParams.get('endpointSize'), 8, [8, 16, 32]))
  const [selectedEndpoint, setSelectedEndpoint] = useState<ApiEndpoint | null>(null)
  const [endpointForm, setEndpointForm] = useState<EndpointForm>(EMPTY_ENDPOINT_FORM)
  const [creatingEndpoint, setCreatingEndpoint] = useState(false)
  const [deleteEndpointOpen, setDeleteEndpointOpen] = useState(false)
  const [openApiImportOpen, setOpenApiImportOpen] = useState(false)
  const [discardPrompt, setDiscardPrompt] = useState<{ title: string; description: string } | null>(null)

  const [changes, setChanges] = useState<ApiDocChangePageResponse>({ items: [], total: 0, rawTotal: 0, page: 1, size: 10, pageCount: 1 })
  const [changeLoading, setChangeLoading] = useState(false)
  const [changeError, setChangeError] = useState('')
  const [changesLoaded, setChangesLoaded] = useState(false)
  const [loadedChangeKeyword, setLoadedChangeKeyword] = useState<string | null>(null)
  const [loadedChangeTarget, setLoadedChangeTarget] = useState('')
  const [loadedChangeSource, setLoadedChangeSource] = useState('')
  const [loadedChangePage, setLoadedChangePage] = useState(1)
  const [loadedChangeSize, setLoadedChangeSize] = useState(10)
  const [changeKeyword, setChangeKeyword] = useState(() => searchParams.get('historyQ') || '')
  const deferredChangeKeyword = useDebouncedValue(changeKeyword)
  const [changeTarget, setChangeTarget] = useState(() => searchParams.get('target') || '')
  const [changeSource, setChangeSource] = useState(() => searchParams.get('source') || '')
  const [changePage, setChangePage] = useState(() => positivePage(searchParams.get('historyPage')))
  const [changeSize, setChangeSize] = useState(() => pageSizeFromParam(searchParams.get('historySize'), 10, [10, 20, 50]))
  const [selectedChange, setSelectedChange] = useState<ApiDocChangeRecord | null>(null)
  const overviewRequestRef = useRef(0)
  const moduleListRequestRef = useRef(0)
  const moduleListContextRef = useRef('')
  const moduleDetailRequestRef = useRef(0)
  const endpointListRequestRef = useRef(0)
  const endpointListContextRef = useRef('')
  const changeListRequestRef = useRef(0)
  const changeListContextRef = useRef('')
  const mutationActionRef = useRef<MutationAction | null>(null)
  const mutationAbortRef = useRef<AbortController | null>(null)
  const mutationRequestRef = useRef(0)
  const mutationReconcileRef = useRef(0)
  const mutationReconcileTimerRef = useRef<number | null>(null)
  const refreshInFlightRef = useRef(false)
  const overviewAbortRef = useRef<AbortController | null>(null)
  const moduleListAbortRef = useRef<AbortController | null>(null)
  const moduleDetailAbortRef = useRef<AbortController | null>(null)
  const endpointListAbortRef = useRef<AbortController | null>(null)
  const changeListAbortRef = useRef<AbortController | null>(null)
  const pendingDiscardActionRef = useRef<(() => void) | null>(null)
  const discardCancelRef = useRef<HTMLButtonElement | null>(null)
  const moduleQueryRef = useRef(JSON.stringify([deferredModuleKeyword.trim(), moduleVisibility]))
  const endpointQueryRef = useRef(JSON.stringify([selectedModuleSlug, deferredEndpointKeyword.trim(), endpointMethod, endpointGroup, endpointVisibility]))
  const changeQueryRef = useRef(JSON.stringify([deferredChangeKeyword.trim(), changeTarget, changeSource]))
  const writtenSearchRef = useRef(searchParams.toString())
  const observedSearchRef = useRef(searchParams.toString())
  const applyingUrlSignatureRef = useRef('')
  const mutationBusy = mutationAction !== null

  const beginMutation = (action: MutationAction) => {
    if (mutationActionRef.current) return null
    const controller = new AbortController()
    const requestId = ++mutationRequestRef.current
    mutationActionRef.current = action
    mutationAbortRef.current = controller
    setMutationAction(action)
    return { controller, requestId }
  }

  const finishMutation = (action: MutationAction, requestId: number) => {
    if (mutationActionRef.current !== action || mutationRequestRef.current !== requestId) return
    mutationActionRef.current = null
    mutationAbortRef.current = null
    setMutationAction(null)
  }

  const selectedSummary = useMemo(
    () => modules.items.find((item) => item.slug === selectedModuleSlug) || null,
    [modules.items, selectedModuleSlug],
  )

  const moduleDirty = useMemo(
    () => Boolean(selectedModule && JSON.stringify(moduleForm) !== JSON.stringify(moduleFormFromDetail(selectedModule))),
    [moduleForm, selectedModule],
  )
  const endpointDirty = useMemo(() => {
    if (creatingEndpoint) return JSON.stringify(endpointForm) !== JSON.stringify(EMPTY_ENDPOINT_FORM)
    return Boolean(selectedEndpoint && JSON.stringify(endpointForm) !== JSON.stringify(endpointFormFromEndpoint(selectedEndpoint)))
  }, [creatingEndpoint, endpointForm, selectedEndpoint])
  const markdownDirty = Boolean(selectedModule && (
    markdownText !== (selectedModule.markdownContent || '') || markdownFile || appendMarkdown
  ))
  const createFormErrors = useMemo(() => ({
    title: requiredTextError(createForm.title, '模块名称', 255),
    slug: slugError(createForm.slug, '模块 Slug'),
    subtitle: optionalLengthError(createForm.subtitle, '模块副标题', 255),
  }), [createForm])
  const moduleFormErrors = useMemo(() => ({
    title: requiredTextError(moduleForm.title, '模块名称', 255),
    slug: slugError(moduleForm.slug, '模块 Slug'),
    subtitle: optionalLengthError(moduleForm.subtitle, '模块副标题', 255),
    endpointBase: optionalLengthError(moduleForm.endpointBase, '接口基础地址', 255),
    sortOrder: sortOrderError(moduleForm.sortOrder),
  }), [moduleForm])
  const endpointFormErrors = useMemo(() => ({
    summary: requiredTextError(endpointForm.summary, '接口摘要', 255),
    slug: slugError(endpointForm.slug, '接口 Slug'),
    group: optionalLengthError(endpointForm.group, '分组 ID', 64),
    path: endpointForm.path.trim().startsWith('/')
      ? optionalLengthError(endpointForm.path, '路径', 255)
      : '路径必须以 / 开头',
    sortOrder: sortOrderError(endpointForm.sortOrder),
    paramsText: jsonArrayError(endpointForm.paramsText, '请求参数'),
    responsesText: jsonArrayError(endpointForm.responsesText, '响应字段'),
    codeSamplesText: jsonArrayError(endpointForm.codeSamplesText, '代码示例'),
  }), [endpointForm])
  const createFormValid = Object.values(createFormErrors).every((error) => !error)
  const moduleFormValid = Object.values(moduleFormErrors).every((error) => !error)
  const endpointFormValid = Object.values(endpointFormErrors).every((error) => !error)
  const hasUnsavedDraft = moduleDirty || endpointDirty || markdownDirty

  const loadOverview = useCallback(async (force = false) => {
    const requestId = ++overviewRequestRef.current
    overviewAbortRef.current?.abort()
    const controller = new AbortController()
    overviewAbortRef.current = controller
    setOverviewError('')
    try {
      const result = await apiDocsApi.adminOverview(force, controller.signal)
      if (requestId !== overviewRequestRef.current) return false
      setOverview(result)
      return true
    } catch (error) {
      if (requestId !== overviewRequestRef.current || isAbortError(error)) return false
      setOverviewError(businessErrorMessage(error, { fallback: '配置概览加载失败', service: '接口配置概览' }))
      return false
    } finally {
      if (overviewAbortRef.current === controller) overviewAbortRef.current = null
    }
  }, [])

  const loadModules = useCallback(async (page = 1, size = 8, force = false) => {
    const requestId = ++moduleListRequestRef.current
    moduleListAbortRef.current?.abort()
    const controller = new AbortController()
    moduleListAbortRef.current = controller
    const query: ApiDocsModuleQuery = {
      keyword: deferredModuleKeyword.trim(), visibility: moduleVisibility, page, size,
    }
    setModuleLoading(true)
    setModuleError('')
    try {
      const result = await apiDocsApi.adminModules(query, force, controller.signal)
      if (requestId !== moduleListRequestRef.current) return false
      moduleListContextRef.current = JSON.stringify({ ...query, page: result.page, size: result.size })
      setModules(result)
      setModulesLoaded(true)
      if (result.page !== modulePage) setModulePage(result.page)
      if (result.size !== moduleSize) setModuleSize(result.size)
      setSelectedModuleSlug((current) => (
        current && result.items.some((item) => item.slug === current) ? current : result.items[0]?.slug || ''
      ))
      return true
    } catch (error) {
      if (requestId !== moduleListRequestRef.current || isAbortError(error)) return false
      setModuleError(businessErrorMessage(error, { fallback: '模块列表加载失败', service: '接口模块配置' }))
      return false
    } finally {
      if (requestId === moduleListRequestRef.current) setModuleLoading(false)
      if (moduleListAbortRef.current === controller) moduleListAbortRef.current = null
    }
  }, [deferredModuleKeyword, modulePage, moduleSize, moduleVisibility])

  const loadModuleDetail = useCallback(async (moduleRef: string, force = false) => {
    const requestId = ++moduleDetailRequestRef.current
    moduleDetailAbortRef.current?.abort()
    if (!moduleRef) {
      setSelectedModule(null)
      setModuleForm(EMPTY_MODULE_FORM)
      setModuleDetailError('')
      return true
    }
    const controller = new AbortController()
    moduleDetailAbortRef.current = controller
    setModuleDetailLoading(true)
    setModuleDetailError('')
    try {
      const detail = await apiDocsApi.adminModule(moduleRef, force, controller.signal)
      if (requestId !== moduleDetailRequestRef.current) return false
      setSelectedModule(detail)
      setModuleForm(moduleFormFromDetail(detail))
      setMarkdownText(detail.markdownContent || '')
      setMarkdownFile(null)
      setAppendMarkdown(false)
      setModuleDetailError('')
      return true
    } catch (error) {
      if (requestId !== moduleDetailRequestRef.current || isAbortError(error)) return false
      const message = businessErrorMessage(error, { fallback: '模块配置加载失败', service: '接口模块配置' })
      setModuleDetailError(message)
      toast.error(message)
      return false
    } finally {
      if (requestId === moduleDetailRequestRef.current) setModuleDetailLoading(false)
      if (moduleDetailAbortRef.current === controller) moduleDetailAbortRef.current = null
    }
  }, [])

  const loadEndpoints = useCallback(async (page = 1, size = 8, force = false) => {
    const requestId = ++endpointListRequestRef.current
    endpointListAbortRef.current?.abort()
    const moduleRef = selectedModuleSlug
    if (!moduleRef) {
      setEndpoints({ items: [], total: 0, page: 1, size, pageCount: 1, availableFilters: { groups: [], methods: [] } })
      endpointListContextRef.current = ''
      setEndpointsLoaded(true)
      setSelectedEndpoint(null)
      setEndpointForm(EMPTY_ENDPOINT_FORM)
      return true
    }
    const controller = new AbortController()
    endpointListAbortRef.current = controller
    setEndpointLoading(true)
    setEndpointError('')
    const query: ApiDocsEndpointQuery = {
      keyword: deferredEndpointKeyword.trim(), method: endpointMethod, group: endpointGroup,
      visibility: endpointVisibility, page, size,
    }
    try {
      const result = await apiDocsApi.adminEndpoints(moduleRef, query, force, controller.signal)
      if (requestId !== endpointListRequestRef.current) return false
      endpointListContextRef.current = `${moduleRef}:${JSON.stringify({ ...query, page: result.page, size: result.size })}`
      setEndpoints(result)
      setEndpointsLoaded(true)
      if (result.page !== endpointPage) setEndpointPage(result.page)
      if (result.size !== endpointSize) setEndpointSize(result.size)
      setSelectedEndpoint((current) => {
        const refreshed = current ? result.items.find((item) => item.id === current.id) : null
        return refreshed || result.items[0] || null
      })
      return true
    } catch (error) {
      if (requestId !== endpointListRequestRef.current || isAbortError(error)) return false
      setEndpointError(businessErrorMessage(error, { fallback: '接口列表加载失败', service: '接口配置' }))
      return false
    } finally {
      if (requestId === endpointListRequestRef.current) setEndpointLoading(false)
      if (endpointListAbortRef.current === controller) endpointListAbortRef.current = null
    }
  }, [deferredEndpointKeyword, endpointGroup, endpointMethod, endpointPage, endpointSize, endpointVisibility, selectedModuleSlug])

  const loadChanges = useCallback(async (page = 1, size = 10, force = false) => {
    const requestId = ++changeListRequestRef.current
    changeListAbortRef.current?.abort()
    const controller = new AbortController()
    changeListAbortRef.current = controller
    const query: ApiDocsChangeQuery = {
      keyword: deferredChangeKeyword.trim(), targetType: changeTarget, sourceType: changeSource, page, size,
    }
    const requestedKeyword = query.keyword || ''
    const requestedTarget = query.targetType || ''
    const requestedSource = query.sourceType || ''
    const contextKey = JSON.stringify(query)
    setChangeLoading(true)
    setChangeError('')
    try {
      const result = await apiDocsApi.adminChanges(query, force, controller.signal)
      if (requestId !== changeListRequestRef.current) return false
      changeListContextRef.current = contextKey
      setChanges(result)
      setChangesLoaded(true)
      setLoadedChangeKeyword(requestedKeyword)
      setLoadedChangeTarget(requestedTarget)
      setLoadedChangeSource(requestedSource)
      setLoadedChangePage(result.page)
      setLoadedChangeSize(result.size)
      if (result.page !== changePage) setChangePage(result.page)
      if (result.size !== changeSize) setChangeSize(result.size)
      return true
    } catch (error) {
      if (requestId !== changeListRequestRef.current || isAbortError(error)) return false
      setChangeError(businessErrorMessage(error, { fallback: '变更历史加载失败', service: '接口变更历史' }))
      return false
    } finally {
      if (requestId === changeListRequestRef.current) setChangeLoading(false)
      if (changeListAbortRef.current === controller) changeListAbortRef.current = null
    }
  }, [changePage, changeSize, changeSource, changeTarget, deferredChangeKeyword])

  const changeSnapshotMatchesView = changesLoaded
    && changeKeyword.trim() === deferredChangeKeyword.trim()
    && loadedChangeKeyword === deferredChangeKeyword.trim()
    && loadedChangeTarget === changeTarget
    && loadedChangeSource === changeSource
    && loadedChangePage === changePage
    && loadedChangeSize === changeSize

  const moduleSnapshotMatchesView = modulesLoaded
    && moduleKeyword.trim() === deferredModuleKeyword.trim()
    && moduleListContextRef.current === JSON.stringify({
      keyword: deferredModuleKeyword.trim(), visibility: moduleVisibility, page: modulePage, size: moduleSize,
    })

  const endpointSnapshotMatchesView = endpointsLoaded
    && Boolean(selectedModuleSlug)
    && endpointKeyword.trim() === deferredEndpointKeyword.trim()
    && endpointListContextRef.current === `${selectedModuleSlug}:${JSON.stringify({
      keyword: deferredEndpointKeyword.trim(), method: endpointMethod, group: endpointGroup,
      visibility: endpointVisibility, page: endpointPage, size: endpointSize,
    })}`
  const endpointEditorVisible = creatingEndpoint
    || Boolean(selectedEndpoint && (endpointSnapshotMatchesView || endpointDirty))

  const moduleCountLabel = overview
    ? String(overview.moduleTotal)
    : modulesLoaded
      ? String(modules.total)
      : '—'
  const endpointCountLabel = overview
    ? String(overview.endpointTotal)
    : modulesLoaded && selectedSummary
      ? String(selectedSummary.endpointCount)
      : '—'
  const historyCountLabel = changesLoaded
    ? String(changes.total)
    : overview
      ? String(overview.historyTotal)
      : '—'

  useEffect(() => { if (isAdmin) void loadOverview() }, [isAdmin, loadOverview])
  useEffect(() => { if (isAdmin) void loadModules(modulePage, moduleSize) }, [isAdmin, loadModules, modulePage, moduleSize])
  useEffect(() => { if (isAdmin) void loadModuleDetail(selectedModuleSlug) }, [isAdmin, loadModuleDetail, selectedModuleSlug])
  useEffect(() => { if (isAdmin) void loadEndpoints(endpointPage, endpointSize) }, [endpointPage, endpointSize, isAdmin, loadEndpoints])
  useEffect(() => { if (isAdmin && activeTab === 'history') void loadChanges(changePage, changeSize) }, [activeTab, changePage, changeSize, isAdmin, loadChanges])

  useEffect(() => {
    if (!isAdmin || (!overviewError && !moduleError && !moduleDetailError && !endpointError && !changeError)) return
    const recoverFailedReads = () => {
      if (!navigator.onLine || document.hidden) return
      if (overviewError && !overviewAbortRef.current) void loadOverview(true)
      if (moduleError && !moduleListAbortRef.current) void loadModules(modulePage, moduleSize, true)
      if (
        moduleDetailError
        && selectedModuleSlug
        && !hasUnsavedDraft
        && !moduleDetailAbortRef.current
      ) void loadModuleDetail(selectedModuleSlug, true)
      if (endpointError && selectedModuleSlug && !endpointDirty && !endpointListAbortRef.current) {
        void loadEndpoints(endpointPage, endpointSize, true)
      }
      if (changeError && activeTab === 'history' && !changeListAbortRef.current) {
        void loadChanges(changePage, changeSize, true)
      }
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
  }, [activeTab, changeError, changePage, changeSize, endpointDirty, endpointError, endpointPage, endpointSize, hasUnsavedDraft, isAdmin, loadChanges, loadEndpoints, loadModuleDetail, loadModules, loadOverview, moduleDetailError, moduleError, modulePage, moduleSize, overviewError, selectedModuleSlug])

  useEffect(() => {
    const queryKey = JSON.stringify([deferredModuleKeyword.trim(), moduleVisibility])
    if (queryKey === moduleQueryRef.current) return
    moduleQueryRef.current = queryKey
    if (modulePage !== 1) setModulePage(1)
  }, [deferredModuleKeyword, modulePage, moduleVisibility])

  useEffect(() => {
    const queryKey = JSON.stringify([selectedModuleSlug, deferredEndpointKeyword.trim(), endpointMethod, endpointGroup, endpointVisibility])
    if (queryKey === endpointQueryRef.current) return
    endpointQueryRef.current = queryKey
    if (endpointPage !== 1) setEndpointPage(1)
  }, [deferredEndpointKeyword, endpointGroup, endpointMethod, endpointPage, endpointVisibility, selectedModuleSlug])

  useEffect(() => {
    const queryKey = JSON.stringify([deferredChangeKeyword.trim(), changeTarget, changeSource])
    if (queryKey === changeQueryRef.current) return
    changeQueryRef.current = queryKey
    if (changePage !== 1) setChangePage(1)
  }, [changePage, changeSource, changeTarget, deferredChangeKeyword])

  useEffect(() => {
    if (moduleKeyword.trim() === deferredModuleKeyword.trim()) return
    moduleListRequestRef.current += 1
    moduleListAbortRef.current?.abort()
    setModuleLoading(true)
    setModuleError('')
  }, [deferredModuleKeyword, moduleKeyword])

  useEffect(() => {
    if (endpointKeyword.trim() === deferredEndpointKeyword.trim()) return
    endpointListRequestRef.current += 1
    endpointListAbortRef.current?.abort()
    setEndpointLoading(true)
    setEndpointError('')
  }, [deferredEndpointKeyword, endpointKeyword])

  useEffect(() => {
    if (changeKeyword.trim() === deferredChangeKeyword.trim()) return
    changeListRequestRef.current += 1
    changeListAbortRef.current?.abort()
    setChangeLoading(true)
    setChangeError('')
  }, [changeKeyword, deferredChangeKeyword])

  useEffect(() => () => {
    overviewRequestRef.current += 1
    moduleListRequestRef.current += 1
    moduleListContextRef.current = ''
    moduleDetailRequestRef.current += 1
    endpointListRequestRef.current += 1
    endpointListContextRef.current = ''
    changeListRequestRef.current += 1
    changeListContextRef.current = ''
    mutationActionRef.current = null
    mutationAbortRef.current?.abort()
    mutationAbortRef.current = null
    mutationRequestRef.current += 1
    mutationReconcileRef.current += 1
    if (mutationReconcileTimerRef.current !== null) window.clearTimeout(mutationReconcileTimerRef.current)
    refreshInFlightRef.current = false
    overviewAbortRef.current?.abort()
    moduleListAbortRef.current?.abort()
    moduleDetailAbortRef.current?.abort()
    endpointListAbortRef.current?.abort()
    changeListAbortRef.current?.abort()
  }, [])

  useEffect(() => {
    if (!selectedEndpoint || creatingEndpoint) return
    setEndpointForm(endpointFormFromEndpoint(selectedEndpoint))
  }, [creatingEndpoint, selectedEndpoint])

  useEffect(() => {
    if (!hasUnsavedDraft) return undefined
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [hasUnsavedDraft])

  const discardDrafts = useCallback(() => {
    if (selectedModule) {
      setModuleForm(moduleFormFromDetail(selectedModule))
      setMarkdownText(selectedModule.markdownContent || '')
    }
    setMarkdownFile(null)
    setAppendMarkdown(false)
    setCreatingEndpoint(false)
    setEndpointForm(selectedEndpoint ? endpointFormFromEndpoint(selectedEndpoint) : EMPTY_ENDPOINT_FORM)
  }, [selectedEndpoint, selectedModule])

  const requestDiscard = useCallback((title: string, description: string, action: () => void) => {
    if (!hasUnsavedDraft) {
      action()
      return
    }
    pendingDiscardActionRef.current = action
    setDiscardPrompt({ title, description })
  }, [hasUnsavedDraft])

  const cancelDiscard = useCallback(() => {
    pendingDiscardActionRef.current = null
    setDiscardPrompt(null)
  }, [])

  const confirmDiscard = useCallback(() => {
    const action = pendingDiscardActionRef.current
    pendingDiscardActionRef.current = null
    setDiscardPrompt(null)
    discardDrafts()
    action?.()
  }, [discardDrafts])

  const currentUrlState = useMemo(() => ({
    module: selectedModuleSlug,
    tab: activeTab,
    moduleQ: moduleKeyword.trim(),
    moduleVisibility,
    modulePage,
    moduleSize,
    endpointQ: endpointKeyword.trim(),
    method: endpointMethod,
    group: endpointGroup,
    endpointVisibility,
    endpointPage,
    endpointSize,
    historyQ: changeKeyword.trim(),
    target: changeTarget,
    source: changeSource,
    historyPage: changePage,
    historySize: changeSize,
  }), [activeTab, changeKeyword, changePage, changeSize, changeSource, changeTarget, endpointGroup, endpointKeyword, endpointMethod, endpointPage, endpointSize, endpointVisibility, moduleKeyword, modulePage, moduleSize, moduleVisibility, selectedModuleSlug])
  const currentUrlSignature = JSON.stringify(currentUrlState)

  useEffect(() => {
    if (pathname !== '/api-console') return
    const incomingSearch = searchParams.toString()
    if (incomingSearch === observedSearchRef.current) return
    observedSearchRef.current = incomingSearch
    if (incomingSearch === writtenSearchRef.current) return
    const defaultModuleSlug = modules.items[0]?.slug || ''
    const incomingState = {
      module: searchParams.get('module') || defaultModuleSlug,
      tab: activeTabFromParam(searchParams.get('tab')),
      moduleQ: searchParams.get('moduleQ') || '',
      moduleVisibility: visibilityFromParam(searchParams.get('moduleVisibility')),
      modulePage: positivePage(searchParams.get('modulePage')),
      moduleSize: pageSizeFromParam(searchParams.get('moduleSize'), 8, [8, 16, 32]),
      endpointQ: searchParams.get('endpointQ') || '',
      method: searchParams.get('method') || '',
      group: searchParams.get('group') || '',
      endpointVisibility: visibilityFromParam(searchParams.get('endpointVisibility')),
      endpointPage: positivePage(searchParams.get('endpointPage')),
      endpointSize: pageSizeFromParam(searchParams.get('endpointSize'), 8, [8, 16, 32]),
      historyQ: searchParams.get('historyQ') || '',
      target: searchParams.get('target') || '',
      source: searchParams.get('source') || '',
      historyPage: positivePage(searchParams.get('historyPage')),
      historySize: pageSizeFromParam(searchParams.get('historySize'), 10, [10, 20, 50]),
    }
    const incomingSignature = JSON.stringify(incomingState)
    if (incomingSignature === currentUrlSignature) {
      writtenSearchRef.current = incomingSearch
      return
    }
    if (hasUnsavedDraft) {
      const url = new URL(window.location.href)
      const defaults: Record<keyof typeof currentUrlState, string | number> = {
        module: defaultModuleSlug, tab: 'history', moduleQ: '', moduleVisibility: 'all', modulePage: 1, moduleSize: 8,
        endpointQ: '', method: '', group: '', endpointVisibility: 'all', endpointPage: 1, endpointSize: 8,
        historyQ: '', target: '', source: '', historyPage: 1, historySize: 10,
      }
      Object.entries(currentUrlState).forEach(([key, value]) => {
        if (String(value) === String(defaults[key as keyof typeof currentUrlState])) url.searchParams.delete(key)
        else url.searchParams.set(key, String(value))
      })
      const restoredSearch = url.searchParams.toString()
      writtenSearchRef.current = restoredSearch
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
      applyingUrlSignatureRef.current = ''
      requestDiscard(
        '放弃修改并恢复浏览上下文？',
        '继续后将放弃当前配置草稿，并切换到浏览器历史记录中的模块、页签和筛选条件。',
        () => {
          writtenSearchRef.current = incomingSearch
          applyingUrlSignatureRef.current = incomingSignature
          window.history.replaceState(window.history.state, '', `${url.pathname}${incomingSearch ? `?${incomingSearch}` : ''}${url.hash}`)
          setSelectedModuleSlug(incomingState.module)
          setActiveTab(incomingState.tab)
          setModuleKeyword(incomingState.moduleQ)
          setModuleVisibility(incomingState.moduleVisibility)
          setModulePage(incomingState.modulePage)
          setModuleSize(incomingState.moduleSize)
          setEndpointKeyword(incomingState.endpointQ)
          setEndpointMethod(incomingState.method)
          setEndpointGroup(incomingState.group)
          setEndpointVisibility(incomingState.endpointVisibility)
          setEndpointPage(incomingState.endpointPage)
          setEndpointSize(incomingState.endpointSize)
          setChangeKeyword(incomingState.historyQ)
          setChangeTarget(incomingState.target)
          setChangeSource(incomingState.source)
          setChangePage(incomingState.historyPage)
          setChangeSize(incomingState.historySize)
        },
      )
      return
    }
    discardDrafts()
    writtenSearchRef.current = incomingSearch
    applyingUrlSignatureRef.current = incomingSignature
    setSelectedModuleSlug(incomingState.module)
    setActiveTab(incomingState.tab)
    setModuleKeyword(incomingState.moduleQ)
    setModuleVisibility(incomingState.moduleVisibility)
    setModulePage(incomingState.modulePage)
    setModuleSize(incomingState.moduleSize)
    setEndpointKeyword(incomingState.endpointQ)
    setEndpointMethod(incomingState.method)
    setEndpointGroup(incomingState.group)
    setEndpointVisibility(incomingState.endpointVisibility)
    setEndpointPage(incomingState.endpointPage)
    setEndpointSize(incomingState.endpointSize)
    setChangeKeyword(incomingState.historyQ)
    setChangeTarget(incomingState.target)
    setChangeSource(incomingState.source)
    setChangePage(incomingState.historyPage)
    setChangeSize(incomingState.historySize)
  }, [currentUrlSignature, currentUrlState, discardDrafts, hasUnsavedDraft, modules.items, pathname, requestDiscard, searchParams])

  useEffect(() => {
    if (pathname !== '/api-console') return
    if (applyingUrlSignatureRef.current) {
      if (applyingUrlSignatureRef.current !== currentUrlSignature) return
      applyingUrlSignatureRef.current = ''
      return
    }
    const url = new URL(window.location.href)
    const defaultModuleSlug = modules.items[0]?.slug || ''
    const defaults: Record<keyof typeof currentUrlState, string | number> = {
      module: defaultModuleSlug, tab: 'history', moduleQ: '', moduleVisibility: 'all', modulePage: 1, moduleSize: 8,
      endpointQ: '', method: '', group: '', endpointVisibility: 'all', endpointPage: 1, endpointSize: 8,
      historyQ: '', target: '', source: '', historyPage: 1, historySize: 10,
    }
    Object.entries(currentUrlState).forEach(([key, value]) => {
      if (String(value) === String(defaults[key as keyof typeof currentUrlState])) url.searchParams.delete(key)
      else url.searchParams.set(key, String(value))
    })
    const nextSearch = url.searchParams.toString()
    writtenSearchRef.current = nextSearch
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }, [currentUrlSignature, currentUrlState, modules.items, pathname])

  const handleSelectModule = (slug: string) => {
    if (mutationBusy || !moduleSnapshotMatchesView) return
    if (slug === selectedModuleSlug) return
    requestDiscard('放弃修改并切换模块？', '当前配置尚未保存。继续后将恢复原配置，并打开所选接口模块。', () => {
      // 点击切换即废弃旧模块请求，不能等下一次 effect 启动后才隔离迟到响应。
      moduleDetailRequestRef.current += 1
      endpointListRequestRef.current += 1
      moduleDetailAbortRef.current?.abort()
      endpointListAbortRef.current?.abort()
      setSelectedModuleSlug(slug)
      setSelectedModule(null)
      setModuleDetailError('')
      setModuleForm(EMPTY_MODULE_FORM)
      setMarkdownText('')
      setMarkdownFile(null)
      setAppendMarkdown(false)
      setSelectedEndpoint(null)
      setEndpointForm(EMPTY_ENDPOINT_FORM)
      setEndpoints({ items: [], total: 0, page: 1, size: endpointSize, pageCount: 1, availableFilters: { groups: [], methods: [] } })
      setCreatingEndpoint(false)
      setEndpointKeyword('')
      setEndpointMethod('')
      setEndpointGroup('')
      setEndpointVisibility('all')
      setEndpointPage(1)
    })
  }

  const handleSelectEndpoint = (endpoint: ApiEndpoint) => {
    if (mutationBusy || !endpointSnapshotMatchesView) return
    if (endpoint.id === selectedEndpoint?.id && !creatingEndpoint) return
    requestDiscard('放弃修改并切换接口？', '当前接口尚未保存。继续后将恢复原接口配置，并打开所选接口。', () => {
      setCreatingEndpoint(false)
      setSelectedEndpoint(endpoint)
      setEndpointForm(endpointFormFromEndpoint(endpoint))
    })
  }

  const handleTabChange = (tab: ActiveTab) => {
    if (mutationBusy) return
    if (tab === activeTab) return
    const currentTabDirty = activeTab === 'basic' ? moduleDirty : activeTab === 'markdown' ? markdownDirty : activeTab === 'endpoints' ? endpointDirty : false
    if (!currentTabDirty) {
      setActiveTab(tab)
      return
    }
    requestDiscard('放弃修改并切换页签？', '当前页签尚未保存。继续后将恢复原配置，并切换到所选页签。', () => setActiveTab(tab))
  }

  const reconcileMutationState = (moduleRef = selectedModuleSlug) => {
    const reconcileId = ++mutationReconcileRef.current
    if (mutationReconcileTimerRef.current !== null) window.clearTimeout(mutationReconcileTimerRef.current)
    const readCurrent = () => Promise.all([
      loadOverview(true),
      loadModules(modulePage, moduleSize, true),
      moduleRef ? loadModuleDetail(moduleRef, true) : Promise.resolve(true),
      moduleRef ? loadEndpoints(endpointPage, endpointSize, true) : Promise.resolve(true),
      loadChanges(1, changeSize, true),
    ])
    void readCurrent().finally(() => {
      if (mutationReconcileRef.current !== reconcileId) return
      mutationReconcileTimerRef.current = window.setTimeout(() => {
        if (mutationReconcileRef.current !== reconcileId) return
        mutationReconcileTimerRef.current = null
        void readCurrent()
      }, 1200)
    })
  }

  const mutationResultUncertain = (error: unknown) => (
    error instanceof ApiError && error.status === 0
    || error instanceof Error && /超时|网络中断|无法连接|network|timeout/i.test(error.message)
  )

  const resetMutationDraft = (action: MutationAction) => {
    setDeleteModuleOpen(false)
    setDeleteEndpointOpen(false)
    setOpenApiImportOpen(false)
    if (action === 'create-module') {
      setShowCreate(false)
      setCreateForm({ title: '', slug: '', subtitle: '' })
    } else {
      discardDrafts()
    }
  }

  const cancelMutationWait = () => {
    const action = mutationActionRef.current
    if (!action) return
    mutationAbortRef.current?.abort()
    mutationAbortRef.current = null
    mutationRequestRef.current += 1
    mutationActionRef.current = null
    setMutationAction(null)
    resetMutationDraft(action)
    reconcileMutationState(action === 'delete-module' ? '' : selectedModuleSlug)
    toast.warning('已取消等待；操作可能已经完成，正在重新读取模块、接口和变更记录，请勿立即重复提交')
  }

  const handleUncertainMutation = (action: MutationAction) => {
    resetMutationDraft(action)
    reconcileMutationState(action === 'delete-module' ? '' : selectedModuleSlug)
    toast.warning('请求超时或网络中断，操作可能已经完成；正在重新读取最终状态，请勿立即重复提交')
  }

  const handleCreateModule = async () => {
    if (mutationActionRef.current) return
    if (!createFormValid) {
      toast.warning('请先修正模块表单中的错误')
      return
    }

    const mutation = beginMutation('create-module')
    if (!mutation) return
    try {
      const createdModule = await apiDocsApi.createModule(createForm, mutation.controller.signal)
      if (mutationRequestRef.current !== mutation.requestId) return
      toast.success('模块已创建')
      setShowCreate(false)
      setCreateForm({ title: '', slug: '', subtitle: '' })
      setSelectedModuleSlug(createdModule.slug)
      void Promise.all([loadOverview(true), loadModules(1, moduleSize, true)])
    } catch (error) {
      if (mutationRequestRef.current !== mutation.requestId || isAbortError(error)) return
      if (mutationResultUncertain(error)) {
        handleUncertainMutation('create-module')
        return
      }
      toast.error(businessErrorMessage(error, { fallback: '创建模块失败', service: '接口模块配置' }))
    } finally {
      finishMutation('create-module', mutation.requestId)
    }
  }

  const handleSaveModule = async () => {
    if (!selectedModule || moduleDetailError) return
    if (!moduleFormValid) {
      toast.warning('请先修正模块表单中的错误')
      return
    }
    const mutation = beginMutation('save-module')
    if (!mutation) return
    try {
      const savedModule = await apiDocsApi.updateModule(selectedModule.slug, {
        title: moduleForm.title.trim(),
        slug: moduleForm.slug.trim(),
        subtitle: moduleForm.subtitle.trim(),
        description: moduleForm.description.trim(),
        endpointBase: moduleForm.endpointBase.trim(),
        sortOrder: Number(moduleForm.sortOrder || 0),
        isVisible: moduleForm.isVisible,
      }, mutation.controller.signal)
      if (mutationRequestRef.current !== mutation.requestId) return
      setSelectedModule(savedModule)
      setModuleForm(moduleFormFromDetail(savedModule))
      setSelectedModuleSlug(savedModule.slug)
      toast.success('模块配置已保存')
      void Promise.all([loadOverview(true), loadModules(modulePage, moduleSize, true)])
    } catch (error) {
      if (mutationRequestRef.current !== mutation.requestId || isAbortError(error)) return
      if (mutationResultUncertain(error)) {
        handleUncertainMutation('save-module')
        return
      }
      toast.error(businessErrorMessage(error, { fallback: '保存模块失败', service: '接口模块配置' }))
    } finally {
      finishMutation('save-module', mutation.requestId)
    }
  }

  const handleDeleteModule = async () => {
    if (!selectedModule || mutationBusy || moduleDetailError) return
    setDeleteModuleOpen(true)
  }

  const confirmDeleteModule = async () => {
    if (!selectedModule) return
    const mutation = beginMutation('delete-module')
    if (!mutation) return
    try {
      await apiDocsApi.deleteModule(selectedModule.slug, mutation.controller.signal)
      if (mutationRequestRef.current !== mutation.requestId) return
      toast.success('模块已删除')
      setDeleteModuleOpen(false)
      setSelectedModuleSlug('')
      setSelectedModule(null)
      setSelectedEndpoint(null)
      void Promise.all([loadOverview(true), loadModules(1, moduleSize, true)])
    } catch (error) {
      if (mutationRequestRef.current !== mutation.requestId || isAbortError(error)) return
      if (mutationResultUncertain(error)) {
        handleUncertainMutation('delete-module')
        return
      }
      toast.error(businessErrorMessage(error, { fallback: '删除模块失败', service: '接口模块配置' }))
    } finally {
      finishMutation('delete-module', mutation.requestId)
    }
  }

  const handleImportMarkdown = async () => {
    if (!selectedModule || mutationActionRef.current || moduleDetailError) return
    if (!markdownText.trim() && !markdownFile) {
      toast.warning('请先上传 Markdown 文件或粘贴 Markdown 内容')
      return
    }
    const mutation = beginMutation('import-markdown')
    if (!mutation) return
    try {
      const importedModule = await apiDocsApi.importMarkdown(selectedModule.slug, {
        markdownText,
        append: appendMarkdown,
        file: markdownFile,
      }, mutation.controller.signal)
      if (mutationRequestRef.current !== mutation.requestId) return
      setSelectedModule(importedModule)
      setModuleForm(moduleFormFromDetail(importedModule))
      setMarkdownText(importedModule.markdownContent || '')
      toast.success('Markdown 已导入')
      setMarkdownFile(null)
      setAppendMarkdown(false)
      void Promise.all([loadOverview(true), loadChanges(1, changeSize, true)])
    } catch (error) {
      if (mutationRequestRef.current !== mutation.requestId || isAbortError(error)) return
      if (mutationResultUncertain(error)) {
        handleUncertainMutation('import-markdown')
        return
      }
      toast.error(businessErrorMessage(error, { fallback: 'Markdown 导入失败', service: 'Markdown 接口文档导入' }))
    } finally {
      finishMutation('import-markdown', mutation.requestId)
    }
  }

  const handleMarkdownFileChange = (file: File | null) => {
    if (!file) {
      setMarkdownFile(null)
      return
    }
    try {
      validateApiDocMarkdownFile(file)
      setMarkdownFile(file)
    } catch (error) {
      setMarkdownFile(null)
      toast.error(error instanceof Error ? error.message : 'Markdown 文件不可用')
    }
  }

  const handleImportOpenApi = async () => {
    const mutation = beginMutation('import-openapi')
    if (!mutation) return
    try {
      const result = await apiDocsApi.importOpenApi(true, mutation.controller.signal)
      if (mutationRequestRef.current !== mutation.requestId) return
      setOpenApiImportOpen(false)
      toast.success(`导入完成：新增 ${result.created}，更新 ${result.updated}，保留手工覆盖 ${result.skipped}`)
      void Promise.all([
        loadOverview(true),
        loadModules(1, moduleSize, true),
        selectedModuleSlug ? loadEndpoints(1, endpointSize, true) : Promise.resolve(),
        loadChanges(1, changeSize, true),
      ])
    } catch (error) {
      if (mutationRequestRef.current !== mutation.requestId || isAbortError(error)) return
      if (mutationResultUncertain(error)) {
        handleUncertainMutation('import-openapi')
        return
      }
      toast.error(businessErrorMessage(error, { fallback: 'OpenAPI 导入失败', service: 'OpenAPI 文档导入' }))
    } finally {
      finishMutation('import-openapi', mutation.requestId)
    }
  }

  const handleSaveEndpoint = async () => {
    if (!creatingEndpoint && !endpointSnapshotMatchesView) return
    if (!endpointFormValid) {
      toast.warning('请先修正接口表单中的错误')
      return
    }
    const mutation = beginMutation('save-endpoint')
    if (!mutation) return
    try {
      const wasCreating = creatingEndpoint
      const payload = endpointPayload(endpointForm)
      const savedEndpoint = wasCreating
        ? await apiDocsApi.createEndpoint(selectedModuleSlug, payload, mutation.controller.signal)
        : await apiDocsApi.updateEndpoint(String(selectedEndpoint?.id), payload, mutation.controller.signal)
      if (mutationRequestRef.current !== mutation.requestId) return
      setCreatingEndpoint(false)
      setSelectedEndpoint(savedEndpoint)
      setEndpointForm(endpointFormFromEndpoint(savedEndpoint))
      toast.success(wasCreating ? '接口已创建' : '接口配置已保存')
      void Promise.all([
        loadOverview(true),
        loadModules(modulePage, moduleSize, true),
        loadEndpoints(endpointPage, endpointSize, true),
        loadChanges(1, changeSize, true),
      ])
    } catch (error) {
      if (mutationRequestRef.current !== mutation.requestId || isAbortError(error)) return
      if (mutationResultUncertain(error)) {
        handleUncertainMutation('save-endpoint')
        return
      }
      toast.error(businessErrorMessage(error, { fallback: '保存接口失败', service: '接口配置' }))
    } finally {
      finishMutation('save-endpoint', mutation.requestId)
    }
  }

  const handleCreateEndpoint = () => {
    if (mutationBusy || !endpointSnapshotMatchesView) return
    requestDiscard('放弃修改并新建接口？', '当前接口尚未保存。继续后将恢复原接口配置，并打开空白的新建表单。', () => {
      setCreatingEndpoint(true)
      setSelectedEndpoint(null)
      setEndpointForm(EMPTY_ENDPOINT_FORM)
    })
  }

  const confirmDeleteEndpoint = async () => {
    if (!selectedEndpoint || selectedEndpoint.sourceType !== 'manual') return
    const mutation = beginMutation('delete-endpoint')
    if (!mutation) return
    try {
      await apiDocsApi.deleteEndpoint(String(selectedEndpoint.id), mutation.controller.signal)
      if (mutationRequestRef.current !== mutation.requestId) return
      setDeleteEndpointOpen(false)
      setSelectedEndpoint(null)
      setEndpointForm(EMPTY_ENDPOINT_FORM)
      void Promise.all([
        loadOverview(true),
        loadModules(modulePage, moduleSize, true),
        loadEndpoints(1, endpointSize, true),
        loadChanges(1, changeSize, true),
      ])
      toast.success('手工接口已删除')
    } catch (error) {
      if (mutationRequestRef.current !== mutation.requestId || isAbortError(error)) return
      if (mutationResultUncertain(error)) {
        handleUncertainMutation('delete-endpoint')
        return
      }
      toast.error(businessErrorMessage(error, { fallback: '删除接口失败', service: '接口配置' }))
    } finally {
      finishMutation('delete-endpoint', mutation.requestId)
    }
  }

  const refreshCurrent = async () => {
    if (refreshInFlightRef.current || mutationActionRef.current || hasUnsavedDraft) return
    refreshInFlightRef.current = true
    setRefreshingAll(true)
    try {
      const results = await Promise.all([
        loadOverview(true),
        loadModules(modulePage, moduleSize, true),
        selectedModuleSlug ? loadModuleDetail(selectedModuleSlug, true) : Promise.resolve(),
        selectedModuleSlug ? loadEndpoints(endpointPage, endpointSize, true) : Promise.resolve(),
        activeTab === 'history' ? loadChanges(changePage, changeSize, true) : Promise.resolve(),
      ])
      if (results.every(Boolean)) toast.success('接口配置已刷新')
      else toast.warning('部分接口配置刷新失败，请查看对应区域提示')
    } finally {
      refreshInFlightRef.current = false
      setRefreshingAll(false)
    }
  }

  if (authLoading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center text-sm text-slate-500">
        <Loader2 size={18} className="mr-2 animate-spin" />
        正在确认管理权限...
      </div>
    )
  }

  if (!isAdmin) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center px-6">
        <div className="max-w-lg rounded-[8px] border border-amber-200 bg-amber-50 p-6 text-center">
          <h1 className="text-xl font-black text-slate-900">需要管理员权限</h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">接口控制台用于修改模块、端点和导入来源。当前账号仍可在文档中心查看公开 API 参考。</p>
          <Link href="/docs?view=api" className="mt-5 inline-flex rounded-[8px] bg-blue-600 px-4 py-3 text-sm font-bold text-white">打开 API 参考</Link>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <section className="flex flex-col gap-4 rounded-[8px] border border-slate-200 bg-white px-5 py-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[24px] font-black text-slate-900">接口控制台</h1>
            <span className="inline-flex rounded-[6px] border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-bold text-slate-500">
              模块 {moduleCountLabel}
            </span>
            <span className="inline-flex rounded-[6px] border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-bold text-slate-500">
              接口 {endpointCountLabel}
            </span>
          </div>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">
            在后台统一配置接口模块、Markdown 文档和 OpenAPI 导入结果，保存后 `/docs` 的 API 参考会直接读取同一份配置。
          </p>
          {overviewError ? <p className="mt-1 text-xs font-semibold text-rose-600">配置摘要暂不可用：{overviewError}</p> : null}
        </div>

        <div className="flex shrink-0 flex-wrap gap-3">
          {mutationBusy ? (
            <button
              type="button"
              onClick={cancelMutationWait}
              className="inline-flex items-center gap-2 rounded-[8px] border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-700 transition hover:bg-amber-100"
            >
              <XCircle size={16} />
              取消等待
            </button>
          ) : null}
          <button
            onClick={refreshCurrent}
            disabled={refreshingAll || mutationBusy || hasUnsavedDraft}
            title="刷新接口配置"
            className="inline-flex h-11 w-11 items-center justify-center rounded-[8px] border border-slate-200 bg-white text-slate-600 transition hover:border-blue-200 hover:text-blue-600 disabled:opacity-50"
          >
            <RefreshCcw size={16} className={refreshingAll ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => setOpenApiImportOpen(true)}
            disabled={mutationBusy || hasUnsavedDraft}
            title={hasUnsavedDraft ? '请先保存或放弃当前修改' : '从当前后端 OpenAPI 定义同步接口'}
            className="inline-flex items-center gap-2 rounded-[8px] border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 transition hover:border-blue-200 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {mutationAction === 'import-openapi' ? <Loader2 size={16} className="animate-spin" /> : <RefreshCcw size={16} />}
            {mutationAction === 'import-openapi' ? '正在导入' : '从当前项目接口导入'}
          </button>
          <Link
            href={`/docs?view=api&module=${selectedModule?.slug ?? ''}${selectedEndpoint?.slug ? `&endpoint=${selectedEndpoint.slug}` : ''}`}
            target="_blank"
            className="inline-flex items-center gap-2 rounded-[8px] bg-blue-600 px-4 py-3 text-sm font-bold text-white transition hover:bg-blue-700"
          >
            <Eye size={16} />
            打开调试页
          </Link>
        </div>
      </section>

      <section className="grid min-w-0 items-start gap-6 xl:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="min-w-0 space-y-4 rounded-[8px] border border-slate-200 bg-white p-5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-black text-slate-900">模块列表</h2>
              <p className="mt-1 text-xs text-slate-500">按模块维护接口文档和调试页配置</p>
            </div>
            <button
              type="button"
              aria-label={showCreate ? '关闭新建模块表单' : '新建接口模块'}
              title={showCreate ? '关闭新建模块表单' : '新建接口模块'}
              onClick={() => setShowCreate((prev) => !prev)}
              disabled={mutationBusy || hasUnsavedDraft}
              className="inline-flex h-10 w-10 items-center justify-center rounded-[8px] border border-slate-200 bg-white text-slate-600 transition hover:border-blue-200 hover:text-blue-600"
            >
              <Plus size={16} />
            </button>
          </div>

          {showCreate ? (
            <fieldset disabled={mutationBusy} className="space-y-3 rounded-[8px] border border-blue-100 bg-blue-50 p-4 disabled:opacity-70">
              <TextField label="模块名称" value={createForm.title} maxLength={255} error={createFormErrors.title} onChange={(value) => setCreateForm((prev) => ({ ...prev, title: value }))} />
              <TextField label="模块 Slug" value={createForm.slug} maxLength={128} error={createFormErrors.slug} onChange={(value) => setCreateForm((prev) => ({ ...prev, slug: value.toLowerCase() }))} />
              <TextField label="模块副标题" value={createForm.subtitle} maxLength={255} error={createFormErrors.subtitle} onChange={(value) => setCreateForm((prev) => ({ ...prev, subtitle: value }))} />
              <div className="flex gap-3">
                <button
                  onClick={handleCreateModule}
                  disabled={mutationBusy || Boolean(moduleDetailError) || !createFormValid}
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-[8px] bg-blue-600 px-4 py-3 text-sm font-bold text-white transition hover:bg-blue-700"
                >
                  {mutationAction === 'create-module' ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                  {mutationAction === 'create-module' ? '正在创建' : '创建模块'}
                </button>
                <button
                  onClick={() => setShowCreate(false)}
                  disabled={mutationBusy}
                  className="rounded-[8px] border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-600 transition hover:border-slate-300"
                >
                  取消
                </button>
              </div>
            </fieldset>
          ) : null}

          <div className="space-y-2">
            <label className="relative block">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                aria-label="搜索接口模块"
                disabled={hasUnsavedDraft}
                value={moduleKeyword}
                onChange={(event) => setModuleKeyword(event.target.value)}
                placeholder={hasUnsavedDraft ? '请先保存或放弃当前修改' : '搜索模块'}
                className="h-11 w-full rounded-[8px] border border-slate-200 bg-slate-50 pl-9 pr-3 text-sm text-slate-800 outline-none focus:border-blue-300 focus:bg-white disabled:cursor-not-allowed disabled:bg-slate-100"
              />
            </label>
            <UnifiedSelect
              disabled={hasUnsavedDraft}
              value={moduleVisibility}
              onChange={(value) => setModuleVisibility(value as VisibilityFilter)}
              ariaLabel="模块显示状态"
              className="w-full [&>button]:bg-slate-50"
              options={[{ value: 'all', label: '全部状态' }, { value: 'visible', label: '公开显示' }, { value: 'hidden', label: '已隐藏' }]}
            />
          </div>

          <div className="space-y-2">
            {moduleLoading && modulesLoaded ? <div className="flex items-center gap-2 border-l-2 border-blue-500 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700" role="status"><Loader2 size={14} className="animate-spin" />正在读取当前目录，{moduleSnapshotMatchesView ? '下方保留本次条件上一次成功结果' : '下方保留其他筛选或页码的上一次成功结果，模块切换已锁定'}</div> : null}
            {moduleError && modulesLoaded ? <div className="rounded-[8px] border border-rose-100 bg-rose-50 p-4 text-xs leading-5 text-rose-700" role="alert">{moduleError}{`；下方保留${moduleSnapshotMatchesView ? '当前条件' : '其他筛选或页码'}上一次成功读取的${modules.items.length ? '目录' : '空结果'}${moduleSnapshotMatchesView ? '' : '，模块切换已锁定'}。`}</div> : null}
            {!modulesLoaded && moduleLoading ? (
              <div className="flex min-h-32 items-center justify-center text-xs text-slate-500"><Loader2 size={15} className="mr-2 animate-spin" />读取模块目录</div>
            ) : !modulesLoaded && moduleError ? (
              <div className="flex min-h-32 flex-col items-center justify-center px-4 text-center text-xs text-rose-700" role="alert">
                <p className="font-black">模块目录未取得</p>
                <p className="mt-2 max-w-full break-words leading-5">{moduleError}</p>
                <button type="button" onClick={() => void loadModules(modulePage, moduleSize, true)} disabled={moduleLoading} className="mt-3 inline-flex min-h-9 items-center justify-center gap-2 rounded-[6px] border border-rose-200 bg-white px-3 font-black disabled:cursor-wait disabled:opacity-50">
                  <RefreshCcw size={14} className={moduleLoading ? 'animate-spin' : ''} />{moduleLoading ? '正在重新读取' : '重新读取模块目录'}
                </button>
              </div>
            ) : modules.items.map((moduleItem) => (
              <button
                key={moduleItem.slug}
                disabled={!moduleSnapshotMatchesView}
                onClick={() => handleSelectModule(moduleItem.slug)}
                className={`w-full rounded-[8px] border px-3 py-3 text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${
                  selectedModuleSlug === moduleItem.slug
                    ? 'border-blue-200 bg-blue-50'
                    : 'border-slate-200 bg-slate-50 hover:border-blue-200 hover:bg-white'
                }`}
              >
                <div className="flex min-h-10 items-center justify-between gap-3">
                  <div className="flex min-w-0 flex-1 items-start gap-2">
                    <div className="line-clamp-2 min-w-0 flex-1 break-words text-sm font-black leading-5 text-slate-900" title={moduleItem.title}>{moduleItem.title}</div>
                    <span className="shrink-0 whitespace-nowrap pt-0.5 text-xs font-semibold text-slate-500">{moduleItem.endpointCount} 个接口</span>
                  </div>
                  <span
                    className={`inline-flex h-7 min-w-[48px] items-center justify-center whitespace-nowrap rounded-[6px] px-2 text-xs font-black ${
                      moduleItem.isVisible ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-500'
                    }`}
                  >
                    {moduleItem.isVisible ? '显示' : '隐藏'}
                  </span>
                </div>
              </button>
            ))}
          </div>
          {modulesLoaded && !moduleLoading && !moduleError && !modules.items.length ? (
            <div className="rounded-[8px] border border-dashed border-slate-200 p-5 text-center text-xs text-slate-500">{moduleSnapshotMatchesView ? '没有匹配的接口模块' : '上一次成功读取的其他条件暂无模块，正在读取当前目录'}</div>
          ) : null}
          {modulesLoaded ? <Pagination
            page={modules.page}
            pageSize={modules.size}
            total={modules.total}
            loading={moduleLoading || hasUnsavedDraft}
            navigationDisabled={!moduleSnapshotMatchesView}
            onPageChange={setModulePage}
            onPageSizeChange={(value) => { setModuleSize(value); setModulePage(1) }}
            pageSizeOptions={[8, 16, 32]}
            itemName="个接口模块"
            className="border-0 px-0 pb-0"
          /> : null}
        </aside>

        <section className="min-w-0 space-y-6 rounded-[8px] border border-slate-200 bg-white p-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-black text-slate-900">模块配置</h2>
              <p className="mt-1 text-sm text-slate-500">按模块维护基础信息、Markdown 文档、接口清单和调试字段。</p>
            </div>
            {selectedModule && activeTab === 'basic' ? (
              <div className="flex gap-3">
                <button
                  onClick={handleDeleteModule}
                  disabled={mutationBusy}
                  className="inline-flex items-center gap-2 rounded-[8px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-600 transition hover:bg-rose-100"
                >
                  <Trash2 size={15} />
                  删除模块
                </button>
                <button
                  onClick={handleSaveModule}
                  disabled={mutationBusy || Boolean(moduleDetailError) || !moduleDirty || !moduleFormValid}
                  className="inline-flex items-center gap-2 rounded-[8px] bg-blue-600 px-4 py-3 text-sm font-bold text-white transition hover:bg-blue-700"
                >
                  {mutationAction === 'save-module' ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                  {mutationAction === 'save-module' ? '正在保存' : moduleDirty ? '保存模块' : '暂无变更'}
                </button>
              </div>
            ) : null}
          </div>

          {moduleDetailLoading && (!selectedModule || selectedModule.slug !== selectedModuleSlug) ? (
            <div className="flex min-h-[40vh] items-center justify-center text-sm text-slate-500"><Loader2 size={18} className="mr-2 animate-spin" />正在读取模块配置...</div>
          ) : moduleDetailError && (!selectedModule || selectedModule.slug !== selectedModuleSlug) ? (
            <div className="flex min-h-[40vh] flex-col items-center justify-center rounded-[8px] border border-rose-100 bg-rose-50 px-6 text-center text-sm text-rose-700">
              <p className="font-bold">当前模块配置未取得</p>
              <p className="mt-2 max-w-xl leading-6">{moduleDetailError}</p>
              <button type="button" onClick={() => void loadModuleDetail(selectedModuleSlug, true)} className="mt-4 inline-flex min-h-9 items-center gap-2 rounded-[8px] bg-white px-4 py-2 text-xs font-black text-rose-700 shadow-sm"><RefreshCcw size={14} />重新读取</button>
            </div>
          ) : selectedModule ? (
            <div className="space-y-6">
              {moduleDetailLoading ? <div className="flex items-center gap-2 border-l-2 border-blue-500 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700" role="status"><Loader2 size={14} className="animate-spin" />正在刷新当前模块配置，暂时保留现有内容</div> : null}
              {moduleDetailError ? <div className="rounded-[8px] border border-rose-100 bg-rose-50 px-4 py-3 text-xs leading-5 text-rose-700">模块配置刷新失败：{moduleDetailError}。当前继续显示上一次成功读取的配置，保存和导入前请先重新读取。</div> : null}
              <div className="flex flex-wrap gap-1 border-b border-slate-200 pb-2" role="tablist" aria-label="模块配置视图">
                {([
                  { id: 'history', label: `变更历史 (${historyCountLabel})` },
                  { id: 'endpoints', label: `接口清单 (${selectedSummary?.endpointCount ?? endpoints.total})` },
                  { id: 'basic', label: '基础信息' },
                  { id: 'markdown', label: 'Markdown 文档' },
                ] as const).map((tab, _index, tabs) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    id={`api-console-tab-${tab.id}`}
                    data-tab-id={tab.id}
                    aria-selected={activeTab === tab.id}
                    aria-controls="api-console-tab-panel"
                    tabIndex={activeTab === tab.id ? 0 : -1}
                    onClick={() => handleTabChange(tab.id as ActiveTab)}
                    onKeyDown={(event) => handleTabListKeyDown(event, tabs.map((item) => item.id), activeTab, handleTabChange)}
                    className={`rounded-[6px] px-4 py-2.5 text-sm font-bold transition ${
                      activeTab === tab.id
                        ? 'bg-white text-blue-600 shadow-sm'
                        : 'text-slate-500 hover:bg-white/70 hover:text-slate-800'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div id="api-console-tab-panel" role="tabpanel" aria-labelledby={`api-console-tab-${activeTab}`}>
              {activeTab === 'basic' ? (
                <fieldset disabled={mutationBusy || Boolean(moduleDetailError)} className="space-y-6 disabled:opacity-70">
                  <div className="grid gap-4 md:grid-cols-2">
                    <TextField label="模块名称" value={moduleForm.title} maxLength={255} error={moduleFormErrors.title} onChange={(value) => setModuleForm((prev) => ({ ...prev, title: value }))} />
                    <TextField label="模块 Slug" value={moduleForm.slug} maxLength={128} error={moduleFormErrors.slug} onChange={(value) => setModuleForm((prev) => ({ ...prev, slug: value.toLowerCase() }))} />
                    <TextField label="模块副标题" value={moduleForm.subtitle} maxLength={255} error={moduleFormErrors.subtitle} onChange={(value) => setModuleForm((prev) => ({ ...prev, subtitle: value }))} />
                    <TextField label="接口基础地址" value={moduleForm.endpointBase} maxLength={255} error={moduleFormErrors.endpointBase} onChange={(value) => setModuleForm((prev) => ({ ...prev, endpointBase: value }))} />
                    <TextField label="排序" type="number" value={moduleForm.sortOrder} error={moduleFormErrors.sortOrder} onChange={(value) => setModuleForm((prev) => ({ ...prev, sortOrder: value }))} />
                  </div>

                  <label className="flex items-center gap-3 rounded-[8px] border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700">
                    <input
                      type="checkbox"
                      checked={moduleForm.isVisible}
                      onChange={(event) => setModuleForm((prev) => ({ ...prev, isVisible: event.target.checked }))}
                      className="h-4 w-4 shrink-0 rounded-[4px] border border-slate-300 accent-blue-600 outline-none focus-visible:ring-2 focus-visible:ring-blue-500/25 disabled:cursor-not-allowed disabled:opacity-60"
                    />
                    <span>模块在 `/docs` API 参考中显示</span>
                  </label>

                  <TextAreaField label="模块说明" value={moduleForm.description} onChange={(value) => setModuleForm((prev) => ({ ...prev, description: value }))} />
                  {moduleDirty ? <p className="text-xs font-bold text-amber-600">当前基础信息有未保存修改。</p> : null}
                </fieldset>
              ) : null}

              {activeTab === 'markdown' ? (
                <fieldset disabled={mutationBusy || Boolean(moduleDetailError)} className="rounded-[8px] border border-slate-200 bg-slate-50 p-5 disabled:opacity-70">
                  <div className="mb-4 flex items-center justify-between">
                    <div>
                      <h3 className="text-base font-black text-slate-900">Markdown 文档内容</h3>
                      <p className="mt-1 text-sm text-slate-500">支持粘贴 Markdown 或上传 `.md` 文件，保存后同步到 `/docs` 的 API 参考。</p>
                    </div>
                    <button
                      onClick={handleImportMarkdown}
                      disabled={mutationBusy || Boolean(moduleDetailError) || !markdownDirty}
                      className="inline-flex items-center gap-2 rounded-[8px] border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 transition hover:border-blue-200 hover:text-blue-600"
                    >
                      {mutationAction === 'import-markdown' ? <Loader2 size={15} className="animate-spin" /> : <FileUp size={15} />}
                      {mutationAction === 'import-markdown' ? '正在导入' : markdownDirty ? '导入 Markdown' : '暂无变更'}
                    </button>
                  </div>

                  <div className="space-y-4">
                    <TextAreaField label="Markdown 文本" value={markdownText} onChange={setMarkdownText} rows={10} />
                    <label className="block space-y-2">
                      <span className="text-xs font-bold text-slate-500">上传 Markdown 文件</span>
                      <input
                        type="file"
                        accept=".md,text/markdown"
                        aria-label="上传 Markdown 文件"
                        onChange={(event) => {
                          handleMarkdownFileChange(event.target.files?.[0] ?? null)
                          event.currentTarget.value = ''
                        }}
                        className="w-full rounded-[8px] border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
                      />
                    </label>
                    <label className="flex items-center gap-3 rounded-[8px] border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700">
                      <input
                        type="checkbox"
                        checked={appendMarkdown}
                        onChange={(event) => setAppendMarkdown(event.target.checked)}
                        className="h-4 w-4 shrink-0 rounded-[4px] border border-slate-300 accent-blue-600 outline-none focus-visible:ring-2 focus-visible:ring-blue-500/25 disabled:cursor-not-allowed disabled:opacity-60"
                      />
                      <span>追加到当前 Markdown，而不是覆盖</span>
                    </label>
                  </div>
                </fieldset>
              ) : null}

              {activeTab === 'history' ? (
                <div className="overflow-hidden rounded-[8px] border border-slate-200 bg-white">
                  <div className="flex flex-col gap-4 border-b border-slate-200 p-5 xl:flex-row xl:items-end xl:justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <History size={17} className="text-blue-600" />
                        <h3 className="text-base font-black text-slate-900">配置来源与变更历史</h3>
                      </div>
                      <p className="mt-1 text-sm text-slate-500">
                        记录手工维护、OpenAPI 同步和 Markdown 导入，不保存凭证与请求正文。
                        {changesLoaded && changes.rawTotal > changes.total ? ` 当前筛选原始 ${changes.rawTotal} 条，完全重复事件折叠为 ${changes.total} 条。` : ''}
                      </p>
                    </div>
                    <div className="grid min-w-0 gap-2 sm:grid-cols-3 xl:w-[640px]">
                      <label className="relative block min-w-0">
                        <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                      <input aria-label="搜索变更记录" value={changeKeyword} onChange={(event) => setChangeKeyword(event.target.value)} placeholder="搜索业务名称或说明" className="h-11 w-full rounded-[8px] border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none focus:border-blue-300" />
                      </label>
                      <UnifiedSelect value={changeTarget} onChange={setChangeTarget} ariaLabel="变更对象" options={[{ value: '', label: '全部对象' }, { value: 'module', label: '模块' }, { value: 'endpoint', label: '接口' }, { value: 'import', label: '导入任务' }]} />
                      <UnifiedSelect value={changeSource} onChange={setChangeSource} ariaLabel="变更来源" options={[{ value: '', label: '全部来源' }, { value: 'manual', label: '手工维护' }, { value: 'openapi', label: 'OpenAPI' }, { value: 'markdown', label: 'Markdown' }, { value: 'contract', label: '项目资料' }]} />
                    </div>
                  </div>

                  {changeLoading && changesLoaded ? <div className="m-5 flex items-center gap-2 border-l-2 border-blue-500 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700" role="status"><Loader2 size={14} className="animate-spin" />正在读取当前筛选，{changeSnapshotMatchesView ? '下方暂时保留本次筛选上一次成功结果' : '下方暂时保留其他筛选或页码的上一次成功结果，详情与分页已锁定'}</div> : null}
                  {changeError && changesLoaded ? <div className="m-5 rounded-[8px] border border-rose-100 bg-rose-50 p-4 text-sm text-rose-700" role="alert">{changeError}{`；下方保留${changeSnapshotMatchesView ? '当前筛选' : '其他筛选或页码'}上一次成功读取的${changes.items.length ? '记录' : '空结果'}${changeSnapshotMatchesView ? '' : '，详情与分页已锁定'}。`}</div> : null}
                  {!changesLoaded && changeLoading ? (
                    <div className="flex min-h-52 items-center justify-center text-sm text-slate-500"><Loader2 size={17} className="mr-2 animate-spin" />正在读取变更历史...</div>
                  ) : !changesLoaded && changeError ? (
                    <div className="flex min-h-52 flex-col items-center justify-center px-5 text-center text-sm text-rose-700" role="alert">
                      <p className="font-black">变更历史未取得</p>
                      <p className="mt-2 max-w-xl break-words text-xs leading-5">{changeError}</p>
                      <button type="button" onClick={() => void loadChanges(changePage, changeSize, true)} disabled={changeLoading} className="mt-4 inline-flex min-h-9 items-center justify-center gap-2 rounded-[6px] border border-rose-200 bg-white px-3 text-xs font-black disabled:cursor-wait disabled:opacity-50">
                        <RefreshCcw size={14} className={changeLoading ? 'animate-spin' : ''} />{changeLoading ? '正在重新读取' : '重新读取变更历史'}
                      </button>
                    </div>
                  ) : changes.items.length ? (
                    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="接口配置变更记录，可横向滚动">
                      <table className="w-full min-w-[900px] table-auto text-left [&_th]:whitespace-nowrap">
                        <thead className="bg-slate-50 text-xs font-bold text-slate-500">
                          <tr><th className="w-[150px] px-4 py-3">操作</th><th className="w-[220px] px-4 py-3">业务对象</th><th className="w-[130px] px-4 py-3">来源</th><th className="min-w-[260px] px-4 py-3">变更说明</th><th className="w-[190px] px-4 py-3">时间</th></tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {changes.items.map((item) => (
                            <tr key={item.id} className="bg-white align-middle hover:bg-slate-50/70">
                              <td className="whitespace-nowrap px-4 py-3 text-sm font-bold text-slate-900" title={STRATEGY_LABELS[item.importStrategy] ? undefined : `技术操作：${item.importStrategy}`}>
                                {STRATEGY_LABELS[item.importStrategy] || '其他配置操作'}{item.repeatCount > 1 ? ` · 合并 ${item.repeatCount} 次` : ''}
                              </td>
                              <td className="px-4 py-3 text-sm text-slate-700" title={item.targetLabel}><div className="line-clamp-2 break-words leading-5">{item.targetLabel || targetLabel(item.targetType)}</div></td>
                              <td className="whitespace-nowrap px-4 py-3"><span title={SOURCE_LABELS[item.sourceType] ? undefined : `技术来源：${item.sourceType}`} className="rounded-[6px] bg-blue-50 px-2.5 py-1 text-xs font-bold text-blue-700">{SOURCE_LABELS[item.sourceType] || '其他配置来源'}</span></td>
                              <td className="px-4 py-3 text-sm text-slate-600" title={displayChangeNote(item.note)}><div className="line-clamp-2 break-words leading-5">{displayChangeNote(item.note)}</div></td>
                              <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-500"><time>{formatDate(item.importedAt)}</time><button type="button" disabled={!changeSnapshotMatchesView} onClick={() => { if (changeSnapshotMatchesView) setSelectedChange(item) }} className="-my-2 ml-1 inline-flex min-h-8 items-center px-2 font-semibold text-blue-600 hover:text-blue-800 disabled:cursor-not-allowed disabled:text-slate-300">详情</button></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="flex min-h-52 items-center justify-center text-sm text-slate-500">{changeSnapshotMatchesView ? '暂无匹配的变更记录。' : '上一次成功读取的其他筛选或页码暂无记录，正在读取当前筛选。'}</div>
                  )}

                  {changesLoaded ? <Pagination
                    page={loadedChangePage}
                    pageSize={loadedChangeSize}
                    total={changes.total}
                    loading={changeLoading}
                    navigationDisabled={!changeSnapshotMatchesView}
                    onPageChange={setChangePage}
                    onPageSizeChange={(value) => { setChangeSize(value); setChangePage(1) }}
                    pageSizeOptions={[10, 20, 50]}
                    itemName="条变更记录"
                  /> : null}
                </div>
              ) : null}

              {activeTab === 'endpoints' ? (
              <div className="rounded-[8px] border border-slate-200 bg-slate-50 p-5">
                <div className="mb-4 flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
                  <div>
                    <h3 className="text-base font-black text-slate-900">接口清单</h3>
                    <p className="mt-1 text-sm text-slate-500">按服务端搜索和分页维护接口；真实请求调试统一前往 `/docs`。</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-[6px] bg-white px-3 py-2 text-xs font-black text-slate-500">{endpoints.total} 个接口</span>
                    <button type="button" onClick={handleCreateEndpoint} disabled={mutationBusy || !endpointSnapshotMatchesView} className="inline-flex items-center gap-2 rounded-[8px] bg-slate-900 px-4 py-3 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"><Plus size={15} />新建接口</button>
                  </div>
                </div>

                <div className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
                  <div className="space-y-2">
                    <label className="relative block">
                      <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                      <input aria-label="搜索接口名称或路径" disabled={endpointDirty} value={endpointKeyword} onChange={(event) => setEndpointKeyword(event.target.value)} placeholder={endpointDirty ? '请先保存或放弃当前修改' : '搜索接口名称或路径'} className="h-11 w-full rounded-[8px] border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none focus:border-blue-300 disabled:cursor-not-allowed disabled:bg-slate-100" />
                    </label>
                    <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-1 2xl:grid-cols-3">
                      <UnifiedSelect disabled={endpointDirty} value={endpointMethod} onChange={setEndpointMethod} ariaLabel="请求方法" options={[{ value: '', label: '全部方法' }, ...endpoints.availableFilters.methods.map((value) => ({ value, label: value }))]} />
                      <UnifiedSelect disabled={endpointDirty} value={endpointGroup} onChange={setEndpointGroup} ariaLabel="接口分组" options={[{ value: '', label: '全部分组' }, ...endpoints.availableFilters.groups.map((value) => ({ value, label: value || '默认分组' }))]} />
                      <UnifiedSelect disabled={endpointDirty} value={endpointVisibility} onChange={(value) => setEndpointVisibility(value as VisibilityFilter)} ariaLabel="接口显示状态" options={[{ value: 'all', label: '全部状态' }, { value: 'visible', label: '显示' }, { value: 'hidden', label: '隐藏' }]} />
                    </div>
                    {endpointLoading && endpointsLoaded ? <div className="flex items-center gap-2 border-l-2 border-blue-500 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700" role="status"><Loader2 size={14} className="animate-spin" />正在读取当前清单，{endpointSnapshotMatchesView ? '下方保留本次条件上一次成功结果' : '下方保留其他筛选或页码的上一次成功结果，编辑与分页已锁定'}</div> : null}
                    {endpointError && endpointsLoaded ? <div className="rounded-[8px] border border-rose-100 bg-rose-50 p-4 text-sm text-rose-700" role="alert">{endpointError}{`；下方保留${endpointSnapshotMatchesView ? '当前条件' : '其他筛选或页码'}上一次成功读取的${endpoints.items.length ? '接口' : '空结果'}${endpointSnapshotMatchesView ? '' : '，编辑与分页已锁定'}。`}</div> : null}
                    {!endpointsLoaded && endpointLoading ? (
                      <div className="flex min-h-48 items-center justify-center text-sm text-slate-500"><Loader2 size={16} className="mr-2 animate-spin" />正在读取接口...</div>
                    ) : !endpointsLoaded && endpointError ? (
                      <div className="flex min-h-48 flex-col items-center justify-center px-5 text-center text-sm text-rose-700" role="alert">
                        <p className="font-black">接口清单未取得</p>
                        <p className="mt-2 max-w-xl break-words text-xs leading-5">{endpointError}</p>
                        <button type="button" onClick={() => void loadEndpoints(endpointPage, endpointSize, true)} disabled={endpointLoading} className="mt-4 inline-flex min-h-9 items-center justify-center gap-2 rounded-[6px] border border-rose-200 bg-white px-3 text-xs font-black disabled:cursor-wait disabled:opacity-50">
                          <RefreshCcw size={14} className={endpointLoading ? 'animate-spin' : ''} />{endpointLoading ? '正在重新读取' : '重新读取接口清单'}
                        </button>
                      </div>
                    ) : endpoints.items.map((endpoint) => (
                      <button
                        key={endpoint.slug}
                        disabled={!endpointSnapshotMatchesView}
                        onClick={() => handleSelectEndpoint(endpoint)}
                        className={`w-full rounded-[8px] border px-4 py-3 text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${
                          selectedEndpoint?.slug === endpoint.slug
                            ? 'border-blue-200 bg-white shadow-sm'
                            : 'border-slate-200 bg-white/70 hover:border-blue-200'
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <span className="inline-flex h-7 min-w-12 items-center justify-center rounded-[6px] bg-blue-50 px-2 text-xs font-black text-blue-700">{endpoint.method}</span>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-black text-slate-900" title={endpoint.summary}>{endpoint.summary}</div>
                            <div className="mt-1 truncate font-mono text-xs text-slate-500" title={endpoint.path}>{endpoint.path}</div>
                          </div>
                          <span className={`ml-auto inline-flex h-7 shrink-0 items-center rounded-[6px] px-2 text-xs font-bold ${endpoint.isVisible ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{endpoint.isVisible ? '显示' : '隐藏'}</span>
                        </div>
                      </button>
                    ))}
                    {endpointsLoaded && !endpointLoading && !endpointError && !endpoints.items.length ? <div className="rounded-[8px] border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">{endpointSnapshotMatchesView ? '没有匹配的接口。' : '上一次成功读取的其他条件暂无接口，正在读取当前清单。'}</div> : null}
                    {endpointsLoaded ? <Pagination
                      page={endpoints.page}
                      pageSize={endpoints.size}
                      total={endpoints.total}
                      loading={endpointLoading || endpointDirty}
                      navigationDisabled={!endpointSnapshotMatchesView}
                      onPageChange={setEndpointPage}
                      onPageSizeChange={(value) => { setEndpointSize(value); setEndpointPage(1) }}
                      pageSizeOptions={[8, 16, 32]}
                      itemName="个接口"
                      className="border-0 px-0 pb-0"
                    /> : null}
                  </div>

                  {endpointEditorVisible ? (
                    <fieldset disabled={mutationBusy || (!creatingEndpoint && !endpointSnapshotMatchesView)} className="space-y-4 rounded-[8px] border border-slate-200 bg-white p-4 disabled:opacity-70">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <h4 className="text-sm font-black text-slate-900">{creatingEndpoint ? '新建接口' : '接口编辑'}</h4>
                          {!creatingEndpoint ? <p className="mt-1 text-xs text-slate-500" title={SOURCE_LABELS[endpointForm.sourceType] ? undefined : `技术来源：${endpointForm.sourceType}`}>来源：{sourceLabel(endpointForm.sourceType)}</p> : null}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {!creatingEndpoint && selectedEndpoint?.sourceType === 'manual' ? <button type="button" disabled={mutationBusy} onClick={() => setDeleteEndpointOpen(true)} className="inline-flex items-center gap-2 rounded-[8px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-600 disabled:cursor-not-allowed disabled:opacity-50"><Trash2 size={14} />删除</button> : null}
                          <button onClick={handleSaveEndpoint} disabled={mutationBusy || !endpointDirty || !endpointFormValid} className="inline-flex items-center gap-2 rounded-[8px] bg-blue-600 px-4 py-3 text-sm font-bold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50">
                            {mutationAction === 'save-endpoint' ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                            {mutationAction === 'save-endpoint' ? (creatingEndpoint ? '正在创建' : '正在保存') : endpointDirty ? (creatingEndpoint ? '创建接口' : '保存接口') : '暂无变更'}
                          </button>
                        </div>
                      </div>

                      <div className="grid gap-4 md:grid-cols-2">
                        <TextField label="接口摘要" value={endpointForm.summary} maxLength={255} error={endpointFormErrors.summary} onChange={(value) => setEndpointForm((prev) => ({ ...prev, summary: value }))} />
                        <TextField label="接口 Slug" value={endpointForm.slug} maxLength={128} error={endpointFormErrors.slug} onChange={(value) => setEndpointForm((prev) => ({ ...prev, slug: value.toLowerCase() }))} />
                        <TextField label="分组 ID" value={endpointForm.group} maxLength={64} error={endpointFormErrors.group} onChange={(value) => setEndpointForm((prev) => ({ ...prev, group: value }))} />
                        <label className="block space-y-2"><span className="text-xs font-bold text-slate-500">方法</span><UnifiedSelect ariaLabel="接口方法" value={endpointForm.method} onChange={(value) => setEndpointForm((prev) => ({ ...prev, method: value as HttpMethod }))} className="[&>button]:min-h-[46px]" options={(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as HttpMethod[]).map((value) => ({ value, label: value }))} /></label>
                        <TextField label="排序" type="number" value={endpointForm.sortOrder} error={endpointFormErrors.sortOrder} onChange={(value) => setEndpointForm((prev) => ({ ...prev, sortOrder: value }))} />
                      </div>

                      <TextField label="路径" value={endpointForm.path} maxLength={255} error={endpointFormErrors.path} onChange={(value) => setEndpointForm((prev) => ({ ...prev, path: value }))} />
                      <label className="flex items-center gap-3 rounded-[8px] border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700">
                        <input
                          type="checkbox"
                          checked={endpointForm.isVisible}
                          onChange={(event) => setEndpointForm((prev) => ({ ...prev, isVisible: event.target.checked }))}
                          className="h-4 w-4 shrink-0 rounded-[4px] border border-slate-300 accent-blue-600 outline-none focus-visible:ring-2 focus-visible:ring-blue-500/25 disabled:cursor-not-allowed disabled:opacity-60"
                        />
                        <span>接口在调试页中显示</span>
                      </label>

                      <TextAreaField label="接口说明" value={endpointForm.description} onChange={(value) => setEndpointForm((prev) => ({ ...prev, description: value }))} />
                      <TextAreaField label="标签（每行一个）" value={endpointForm.tagsText} onChange={(value) => setEndpointForm((prev) => ({ ...prev, tagsText: value }))} rows={3} />
                      <TextAreaField label="调试说明（每行一条）" value={endpointForm.notesText} onChange={(value) => setEndpointForm((prev) => ({ ...prev, notesText: value }))} rows={4} />
                      <details className="rounded-[8px] border border-slate-200 bg-slate-50 p-4">
                        <summary className="cursor-pointer text-sm font-black text-slate-900">请求与响应结构 JSON</summary>
                        <div className="mt-4 space-y-4"><TextAreaField label="请求参数 JSON 数组" value={endpointForm.paramsText} error={endpointFormErrors.paramsText} onChange={(value) => setEndpointForm((prev) => ({ ...prev, paramsText: value }))} rows={7} /><TextAreaField label="响应字段 JSON 数组" value={endpointForm.responsesText} error={endpointFormErrors.responsesText} onChange={(value) => setEndpointForm((prev) => ({ ...prev, responsesText: value }))} rows={7} /><TextAreaField label="代码示例 JSON 数组" value={endpointForm.codeSamplesText} error={endpointFormErrors.codeSamplesText} onChange={(value) => setEndpointForm((prev) => ({ ...prev, codeSamplesText: value }))} rows={6} /></div>
                      </details>
                      <TextAreaField label="请求示例" value={endpointForm.requestPreview} onChange={(value) => setEndpointForm((prev) => ({ ...prev, requestPreview: value }))} rows={6} />
                      <TextAreaField label="响应示例" value={endpointForm.responseBody} onChange={(value) => setEndpointForm((prev) => ({ ...prev, responseBody: value }))} rows={6} />
                      <TextAreaField label="响应元数据" value={endpointForm.responseMeta} onChange={(value) => setEndpointForm((prev) => ({ ...prev, responseMeta: value }))} rows={4} />
                    </fieldset>
                  ) : (
                    <div className="flex items-center justify-center rounded-[8px] border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-500">
                      {!endpointSnapshotMatchesView && endpointsLoaded
                        ? '正在读取当前筛选条件的接口，旧接口详情已暂时隐藏。'
                        : '选择左侧接口开始编辑，或新建一个手工接口。'}
                    </div>
                  )}
                </div>
              </div>
              ) : null}
              </div>
            </div>
          ) : (
            <div className="flex min-h-[40vh] items-center justify-center rounded-[8px] border border-dashed border-slate-300 bg-slate-50 text-sm text-slate-500">
              请选择左侧模块开始配置。
            </div>
          )}
        </section>

      </section>

      {discardPrompt ? (
        <AppDialog
          title={discardPrompt.title}
          description={discardPrompt.description}
          onClose={cancelDiscard}
          showClose={false}
          maxWidth="max-w-md"
          zIndexClass="z-[10000]"
          initialFocusRef={discardCancelRef}
          footer={(
            <div className="flex justify-end gap-3">
              <button
                ref={discardCancelRef}
                type="button"
                onClick={cancelDiscard}
                className="rounded-[8px] border border-slate-200 px-5 py-3 text-sm font-bold text-slate-600 transition hover:border-blue-200 hover:text-blue-700"
              >
                继续编辑
              </button>
              <button
                type="button"
                onClick={confirmDiscard}
                className="rounded-[8px] bg-rose-600 px-5 py-3 text-sm font-bold text-white transition hover:bg-rose-700"
              >
                放弃并继续
              </button>
            </div>
          )}
        >
          <p className="text-sm leading-7 text-slate-500">
            已保存的数据不会受到影响。需要保留本次编辑时，请返回当前页签完成保存。
          </p>
        </AppDialog>
      ) : null}

      {selectedChange ? (
        <AppDialog title="变更详情" onClose={() => setSelectedChange(null)} maxWidth="max-w-lg">
          <dl className="divide-y divide-slate-100 text-sm">
            {[
              ['操作', strategyLabel(selectedChange.importStrategy)],
              ['对象', targetLabel(selectedChange.targetType)],
              ['业务对象', selectedChange.targetLabel || targetLabel(selectedChange.targetType)],
              ['来源', sourceLabel(selectedChange.sourceType)],
              ['时间', formatDate(selectedChange.importedAt)],
              ['变更说明', displayChangeNote(selectedChange.note)],
              ...(!STRATEGY_LABELS[selectedChange.importStrategy] ? [['原始操作', selectedChange.importStrategy || '空值']] : []),
              ...(!TARGET_LABELS[selectedChange.targetType] ? [['原始对象类型', selectedChange.targetType || '空值']] : []),
              ...(!SOURCE_LABELS[selectedChange.sourceType] ? [['原始来源', selectedChange.sourceType || '空值']] : []),
              ...(selectedChange.repeatCount > 1 ? [['合并记录', `${selectedChange.repeatCount} 次完全相同事件`]] : []),
            ].map(([label, value]) => (
              <div key={label} className="grid grid-cols-[5rem_minmax(0,1fr)] gap-4 py-3">
                <dt className="font-semibold text-slate-500">{label}</dt>
                <dd className="break-words font-medium text-slate-800">{value}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-4 border-t border-slate-100 pt-4">
            <div className="text-xs font-semibold text-slate-500">技术标识</div>
            <code className="mt-2 block break-all rounded-[6px] bg-slate-50 px-3 py-2 text-xs text-slate-700">{selectedChange.targetRef || '未记录技术标识'}</code>
          </div>
        </AppDialog>
      ) : null}

      {openApiImportOpen ? (
        <AppDialog
          title="同步当前项目接口"
          description="将重新读取当前后端 OpenAPI 定义，并新增或更新自动维护的模块与接口。"
          onClose={() => { if (mutationAction !== 'import-openapi') setOpenApiImportOpen(false) }}
          maxWidth="max-w-md"
          closeOnOverlay={mutationAction !== 'import-openapi'}
          showClose={mutationAction !== 'import-openapi'}
          footer={(
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={mutationAction === 'import-openapi' ? cancelMutationWait : () => setOpenApiImportOpen(false)}
                className="min-h-10 rounded-[8px] border border-slate-200 px-5 text-sm font-bold text-slate-600 transition hover:border-blue-200 hover:text-blue-700"
              >
                {mutationAction === 'import-openapi' ? '取消等待' : '取消'}
              </button>
              {mutationAction !== 'import-openapi' ? (
                <button type="button" onClick={() => void handleImportOpenApi()} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-[8px] bg-blue-600 px-5 text-sm font-bold text-white transition hover:bg-blue-700">
                  <RefreshCcw size={15} />确认同步
                </button>
              ) : null}
            </div>
          )}
        >
          <div className="space-y-3 text-sm leading-6 text-slate-600">
            <p>手工维护的接口不会被覆盖；自动导入内容可能更新名称、路径、说明和请求响应结构。</p>
            <p className="rounded-[8px] bg-amber-50 px-4 py-3 text-xs font-semibold leading-5 text-amber-800">同步完成后会刷新模块、接口和变更历史。请求已发送时，取消等待不会撤销服务端可能已经完成的同步。</p>
          </div>
        </AppDialog>
      ) : null}

      {deleteModuleOpen && selectedModule ? (
        <AppDialog
          title="删除接口模块"
          onClose={() => { if (mutationAction !== 'delete-module') setDeleteModuleOpen(false) }}
          maxWidth="max-w-md"
          danger
          closeOnOverlay={mutationAction !== 'delete-module'}
          showClose={mutationAction !== 'delete-module'}
          footer={(
            <div className="flex justify-end gap-3">
              <button
                onClick={mutationAction === 'delete-module' ? cancelMutationWait : () => setDeleteModuleOpen(false)}
                className="rounded-[8px] border border-slate-200 px-5 py-3 text-sm font-bold text-slate-600 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {mutationAction === 'delete-module' ? '取消等待' : '取消'}
              </button>
              <button
                onClick={confirmDeleteModule}
                disabled={mutationBusy}
                className="inline-flex items-center gap-2 rounded-[8px] bg-rose-600 px-5 py-3 text-sm font-bold text-white disabled:opacity-50"
              >
                {mutationAction === 'delete-module' ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
                {mutationAction === 'delete-module' ? '正在删除' : '确认删除'}
              </button>
            </div>
          )}
        >
          <p className="text-sm leading-7 text-slate-500">
            确定删除模块「<span className="font-bold text-slate-900">{selectedModule.title}</span>」吗？删除后 `/docs` 的 API 参考将不再展示该模块配置。
          </p>
        </AppDialog>
      ) : null}

      {deleteEndpointOpen && selectedEndpoint ? (
        <AppDialog
          title="删除手工接口"
          onClose={() => { if (mutationAction !== 'delete-endpoint') setDeleteEndpointOpen(false) }}
          maxWidth="max-w-md"
          danger
          closeOnOverlay={mutationAction !== 'delete-endpoint'}
          showClose={mutationAction !== 'delete-endpoint'}
          footer={(
            <div className="flex justify-end gap-3">
              <button onClick={mutationAction === 'delete-endpoint' ? cancelMutationWait : () => setDeleteEndpointOpen(false)} className="rounded-[8px] border border-slate-200 px-5 py-3 text-sm font-bold text-slate-600 disabled:cursor-not-allowed disabled:opacity-40">{mutationAction === 'delete-endpoint' ? '取消等待' : '取消'}</button>
              <button onClick={confirmDeleteEndpoint} disabled={mutationBusy} className="inline-flex items-center gap-2 rounded-[8px] bg-rose-600 px-5 py-3 text-sm font-bold text-white disabled:opacity-50">
                {mutationAction === 'delete-endpoint' ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}{mutationAction === 'delete-endpoint' ? '正在删除' : '确认删除'}
              </button>
            </div>
          )}
        >
          <p className="text-sm leading-7 text-slate-500">确定删除接口「<span className="font-bold text-slate-900">{selectedEndpoint.summary}</span>」吗？自动导入或项目资料维护的接口只能隐藏，不能直接删除。</p>
        </AppDialog>
      ) : null}
    </div>
  )
}

export default function ApiConsolePage() {
  return (
    <Suspense fallback={<div className="flex min-h-[50vh] items-center justify-center text-sm font-bold text-slate-400">正在读取接口配置...</div>}>
      <ApiConsoleContent />
    </Suspense>
  )
}
