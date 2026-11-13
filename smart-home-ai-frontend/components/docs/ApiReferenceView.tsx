'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { handleTabListKeyDown } from '@/lib/ui/tabs'

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false })
import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  Clipboard,
  Clock3,
  Copy,
  Database,
  FileCode2,
  FileSearch,
  Heart,
  History,
  House,
  Lightbulb,
  Loader2,
  Play,
  RefreshCcw,
  Search,
  Settings2,
  Square,
  TriangleAlert,
  Workflow,
  type LucideIcon,
} from 'lucide-react'

import { toast } from '@/components/ui/toast'
import { AppDialog } from '@/components/ui/AppDialog'
import { MetricStrip } from '@/components/ui/MetricStrip'
import { StatusBadge, type StatusTone } from '@/components/ui/StatusBadge'
import { TechnicalId } from '@/components/ui/TechnicalId'
import { AUTH_STORAGE_EVENT, getAuthCacheScope, getToken } from '@/lib/auth-storage'
import { apiDocsApi } from '@/lib/api/api-docs'
import type { ApiCodeSample, ApiEndpoint, ApiReferenceModule } from '@/types/api-docs'
import { formatMilliseconds } from '@/lib/ui/format-duration'
import { copyTextToClipboard } from '@/lib/clipboard'

type ResponseTab = 'body' | 'headers' | 'request' | 'curl' | 'error'
type RequestConfigTab = 'overview' | 'path' | 'query' | 'headers' | 'body' | 'example' | 'preview'
type BodyMode = 'form' | 'json'
type ExampleReplacementAction = 'fill' | 'reset'

type RequestState = {
  path: Record<string, string>
  query: Record<string, string>
  header: Record<string, string>
  body: Record<string, string>
  bodyJson: string
}

type DebugResult = {
  status: number | null
  ok: boolean
  durationMs: number | null
  timestamp: string
  headers: Array<[string, string]>
  body: string
  request: string
  curl: string
  error: string
}

const DEBUGGER_FAVORITES_KEY = 'docs-api-debugger-favorites'
const DEBUGGER_RECENT_KEY = 'docs-api-debugger-recent'
const DEBUGGER_HISTORY_KEY = 'docs-api-debugger-history'

function debuggerStorageKey(key: string, scope = getAuthCacheScope()) {
  return `${key}:${scope}`
}

const INTERNAL_NOTE_PATTERNS = [
  /合同参数验收/,
  /招标演示要求/,
  /OpenAPI 自动导入生成/,
  /后续可在后台进一步补充/,
]

type DebuggerHistoryItem = {
  moduleSlug?: string
  endpointSlug: string
  summary: string
  status: number | null
  createdAt: string
  success?: boolean
}

const moduleIconMap: Record<string, LucideIcon> = {
  'local-model': FileCode2,
  'agent-external': Bot,
  'smart-home': House,
  sandbox: Workflow,
  'device-data': Database,
  'device-control': Lightbulb,
  knowledge: FileSearch,
  system: Settings2,
}

const methodStyles = {
  GET: 'bg-blue-100 text-blue-700',
  POST: 'bg-emerald-100 text-emerald-700',
  PUT: 'bg-amber-100 text-amber-700',
  PATCH: 'bg-violet-100 text-violet-700',
  DELETE: 'bg-rose-100 text-rose-700',
} as const

const EMPTY_MODULE: ApiReferenceModule = {
  id: 0,
  slug: 'empty-module',
  title: '接口模块待配置',
  subtitle: '当前暂无可展示的接口模块。',
  status: 'planned',
  sourceType: 'manual',
  rendererType: 'api-reference',
  endpointBase: '',
  description: '当前暂无可展示的 API 参考模块，请先在接口控制台中完成配置。',
  markdownContent: '',
  sortOrder: 0,
  isVisible: true,
  capabilityTags: [],
  highlights: [],
  groups: [],
  endpoints: [],
  playground: {
    title: '接口调试台',
    targetLabel: '接口请求调试',
    statusLabel: '接口调试',
    note: '当前暂无模块配置。',
    fields: [],
    presets: [],
  },
}

type Props = {
  modules: ApiReferenceModule[]
  activeModuleId: string
  onModuleChange: (moduleId: string) => void
  onBackToDocs?: () => void
  activeEndpointSlug?: string
  onEndpointChange?: (endpointSlug: string) => void
  embedded?: boolean
  showSidebar?: boolean
  showModuleTabs?: boolean
}

// Monaco 语言映射
const MONACO_LANG_MAP: Record<string, string> = {
  bash: 'shell',
  shell: 'shell',
  json: 'json',
  javascript: 'javascript',
  typescript: 'typescript',
  python: 'python',
  yaml: 'yaml',
  html: 'html',
  css: 'css',
  markdown: 'markdown',
}

function toMonacoLang(language: string) {
  return MONACO_LANG_MAP[language] ?? 'plaintext'
}

function MonacoBlock({
  code,
  language,
  emptyPlaceholder,
  minHeight = 160,
  maxHeight = 420,
}: {
  code: string
  language: string
  emptyPlaceholder: string
  minHeight?: number
  maxHeight?: number
}) {
  const displayCode = code?.trim() ? code : emptyPlaceholder
  const monacoLang = toMonacoLang(language)

  const height = useMemo(() => {
    const lines = displayCode.split('\n').length
    return Math.min(Math.max(lines * 21 + 40, minHeight), maxHeight)
  }, [displayCode, minHeight, maxHeight])

  return (
    <MonacoEditor
      height={height}
      language={monacoLang}
      value={displayCode}
      theme="light"
      options={{
        readOnly: true,
        domReadOnly: true,
        minimap: { enabled: false },
        lineNumbers: 'on',
        wordWrap: 'on',
        scrollBeyondLastLine: false,
        automaticLayout: true,
        fontSize: 13,
        fontFamily: 'SFMono-Regular, SF Mono, Monaco, Consolas, "Liberation Mono", monospace',
        padding: { top: 12, bottom: 12 },
        renderLineHighlight: 'none',
        overviewRulerBorder: false,
        scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
        folding: false,
        contextmenu: false,
        lineDecorationsWidth: 0,
        glyphMargin: false,
      }}
    />
  )
}

async function copyText(text: string, successMessage = '已复制') {
  const success = await copyTextToClipboard(text)
  if (success) toast.success(successMessage)
  else toast.error('复制失败，请手动选择内容')
}

function stringifyDefaultValue(value: unknown) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function looksLikeComplexType(type: string) {
  return /object|\[\]|array|\|/i.test(type)
}

function inferBodyMode(endpoint: ApiEndpoint): BodyMode {
  const bodyParams = endpoint.params.filter((param) => param.location === 'body')
  if (!bodyParams.length) return 'form'
  if (bodyParams.length > 4) return 'json'
  if (bodyParams.some((param) => looksLikeComplexType(param.type))) return 'json'
  return 'form'
}

function parseJsonSafely<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function safeParseStringArray(value: string | null) {
  const parsed = parseJsonSafely<unknown>(value || '[]', [])
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
}

function safeParseHistory(value: string | null) {
  const parsed = parseJsonSafely<unknown>(value || '[]', [])
  if (!Array.isArray(parsed)) return []
  return parsed.filter((item): item is DebuggerHistoryItem => {
    return Boolean(item && typeof item === 'object' && 'endpointSlug' in item && 'summary' in item && 'createdAt' in item)
  })
}

function endpointStorageKey(moduleSlug: string, endpointSlug: string) {
  return `${moduleSlug}::${endpointSlug}`
}

function resolveStoredEndpoint(value: string, modules: ApiReferenceModule[]) {
  const separatorIndex = value.indexOf('::')
  if (separatorIndex >= 0) {
    const moduleSlug = value.slice(0, separatorIndex)
    const endpointSlug = value.slice(separatorIndex + 2)
    const ownerModule = modules.find((item) => item.slug === moduleSlug)
    const endpoint = ownerModule?.endpoints.find((item) => item.slug === endpointSlug)
    return ownerModule && endpoint ? { ownerModule, endpoint } : null
  }
  const owners = modules.flatMap((ownerModule) => ownerModule.endpoints
    .filter((endpoint) => endpoint.slug === value)
    .map((endpoint) => ({ ownerModule, endpoint })))
  return owners.length === 1 ? owners[0] : null
}

function isResolvedStoredEndpoint(
  value: ReturnType<typeof resolveStoredEndpoint>,
): value is NonNullable<ReturnType<typeof resolveStoredEndpoint>> {
  return value !== null
}

function formatUnknownBody(value: unknown) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function formatJsonString(value: string) {
  if (!value.trim()) return '{\n  \n}'
  return JSON.stringify(JSON.parse(value), null, 2)
}

function extractJsonBodyFromCodeSample(sample: ApiCodeSample) {
  const match = sample.code.match(/(?:--data(?:-raw|-binary)?|-d)\s+(['"])([\s\S]*?)\1/)
  const rawBody = match?.[2]?.trim()
  if (!rawBody) return ''
  try {
    return JSON.stringify(JSON.parse(rawBody), null, 2)
  } catch {
    return ''
  }
}

function looksLikeResponsePreview(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  const responseKeys = ['created_at', 'response', 'done', 'done_reason', 'total_duration', 'load_duration', 'eval_count', 'embeddings', 'models']
  const requestKeys = ['prompt', 'messages', 'input', 'name', 'from', 'stream', 'options', 'suffix', 'system', 'format', 'raw', 'keep_alive', 'think']
  return keys.some((key) => responseKeys.includes(key)) && !keys.some((key) => requestKeys.includes(key))
}

function getEndpointRequestExample(endpoint: ApiEndpoint) {
  const preview = endpoint.requestPreview?.trim() || '{}'
  const extractedFromCode = endpoint.codeSamples.map(extractJsonBodyFromCodeSample).find(Boolean) || ''

  try {
    const parsedPreview = JSON.parse(preview)
    const requiredBodyParams = endpoint.params
      .filter((param) => param.location === 'body' && param.required)
      .map((param) => param.name)
    const previewKeys = parsedPreview && typeof parsedPreview === 'object' && !Array.isArray(parsedPreview)
      ? Object.keys(parsedPreview)
      : []
    const missesRequiredBodyParam = requiredBodyParams.some((name) => !previewKeys.includes(name))

    if (!looksLikeResponsePreview(parsedPreview) && !missesRequiredBodyParam) {
      return JSON.stringify(parsedPreview, null, 2)
    }
  } catch {
    return extractedFromCode || preview
  }

  return extractedFromCode || preview
}

function buildInitialRequestState(endpoint: ApiEndpoint): RequestState {
  const requestExample = getEndpointRequestExample(endpoint)
  const requestPreview = parseJsonSafely<Record<string, unknown>>(requestExample || '{}', {})
  const hasBodyParams = endpoint.params.some((param) => param.location === 'body')
  const state: RequestState = {
    path: {},
    query: {},
    header: {},
    body: {},
    bodyJson: hasBodyParams && requestExample && requestExample !== '{}' ? requestExample : '{}',
  }

  for (const param of endpoint.params) {
    const previewValue = requestPreview[param.name]
    const fallbackValue = stringifyDefaultValue(previewValue ?? param.defaultValue)
    if (param.location === 'path') state.path[param.name] = fallbackValue
    if (param.location === 'query') state.query[param.name] = fallbackValue
    if (param.location === 'header') state.header[param.name] = fallbackValue
    if (param.location === 'body') state.body[param.name] = fallbackValue
  }

  return state
}

function applyInstalledModel(state: RequestState, modelName: string): RequestState {
  const parsedBody = parseJsonSafely<Record<string, unknown>>(state.bodyJson, {})
  const hasJsonModel = Object.prototype.hasOwnProperty.call(parsedBody, 'model')
  const hasFormModel = Object.prototype.hasOwnProperty.call(state.body, 'model')
  if (!hasJsonModel && !hasFormModel) return state

  return {
    ...state,
    body: hasFormModel ? { ...state.body, model: modelName } : state.body,
    bodyJson: hasJsonModel
      ? JSON.stringify({ ...parsedBody, model: modelName }, null, 2)
      : state.bodyJson,
  }
}

function applyLocalModelDebugDefaults(state: RequestState, path: string): RequestState {
  if (!['/api/generate', '/api/chat'].includes(path)) return state

  const parsedBody = parseJsonSafely<Record<string, unknown>>(state.bodyJson, {})
  const parsedOptions = parsedBody.options
  const nextBody: Record<string, unknown> = {
    ...parsedBody,
    stream: false,
    think: false,
    options: {
      ...(parsedOptions && typeof parsedOptions === 'object' && !Array.isArray(parsedOptions) ? parsedOptions : {}),
      num_predict: 32,
    },
  }
  const nextFormBody = { ...state.body }
  for (const key of Object.keys(nextFormBody)) {
    if (Object.prototype.hasOwnProperty.call(nextBody, key)) {
      nextFormBody[key] = stringifyDefaultValue(nextBody[key])
    }
  }

  return {
    ...state,
    body: nextFormBody,
    bodyJson: JSON.stringify(nextBody, null, 2),
  }
}

function castValueByType(type: string, rawValue: string): unknown {
  const value = rawValue.trim()
  if (!value) return ''

  if (/boolean/i.test(type) && /^(true|false)$/i.test(value)) {
    return value.toLowerCase() === 'true'
  }

  if (/(integer|number|float|double)/i.test(type) && !Number.isNaN(Number(value))) {
    return Number(value)
  }

  if (looksLikeComplexType(type)) {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }

  return value
}

function replacePathParams(path: string, pathValues: Record<string, string>) {
  let finalPath = path
  for (const [key, value] of Object.entries(pathValues)) {
    if (!value.trim()) continue
    finalPath = finalPath.replaceAll(`{${key}}`, encodeURIComponent(value))
    finalPath = finalPath.replaceAll(`:${key}`, encodeURIComponent(value))
  }
  return finalPath
}

function joinUrl(baseUrl: string, path: string) {
  const trimmedBase = baseUrl.replace(/\/+$/, '')
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${trimmedBase}${normalizedPath}`
}

function isFileLikeEndpoint(endpoint: ApiEndpoint) {
  return endpoint.params.some((param) => /file|upload|binary/i.test(param.type))
}

function isRealDebuggable(module: ApiReferenceModule, endpoint: ApiEndpoint) {
  if (endpoint.path.startsWith('/api/reference/')) return false
  if (module.slug === 'local-model') {
    return endpoint.path.startsWith('/api/') && !isFileLikeEndpoint(endpoint)
  }
  if (!endpoint.path.startsWith('/api/v1/')) return false
  if (isFileLikeEndpoint(endpoint)) return false
  return true
}

function getDebugStatus(
  result: DebugResult,
  isSending: boolean,
  canRealDebug: boolean,
): { label: string; detail: string; status: string; tone: StatusTone } {
  if (!canRealDebug) {
    return { label: '仅文档示例', detail: '当前端点不支持执行', status: 'draft', tone: 'neutral' }
  }
  if (isSending) {
    return { label: '正在执行', detail: '等待后端代理返回', status: 'processing', tone: 'info' }
  }
  if (!result.timestamp) {
    return { label: '尚未执行', detail: '填写参数后发起请求', status: 'unknown', tone: 'neutral' }
  }
  if (result.ok) {
    return {
      label: result.status ? `${result.status} 请求成功` : '请求成功',
      detail: result.durationMs !== null ? formatMilliseconds(result.durationMs) : '已收到响应',
      status: 'success',
      tone: 'success',
    }
  }
  return {
    label: result.status ? `${result.status} 请求失败` : '请求失败',
    detail: result.durationMs !== null ? formatMilliseconds(result.durationMs) : '查看错误诊断',
    status: 'failed',
    tone: 'danger',
  }
}

function buildCurlSnippet(args: {
  method: string
  url: string
  headers: Record<string, string>
  body?: string
}) {
  const headerLines = Object.entries(args.headers).map(([key, value]) => `  -H "${key}: ${value}"`)
  const bodyLine = args.body ? [`  -d '${args.body.replaceAll("'", "\\'")}'`] : []
  return [`curl -X ${args.method} "${args.url}"`, ...headerLines, ...bodyLine].join(' \\\n')
}

function parseRequestBodyForSnapshot(value: string) {
  if (!value.trim()) return null
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function inferCodeLanguage(value: string, fallback: string = 'json') {
  const trimmed = value.trim()
  if (!trimmed) return fallback
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    return 'json'
  }
  if (trimmed.startsWith('curl ') || trimmed.includes(' -H ') || trimmed.includes(' -X ')) {
    return 'bash'
  }
  if (trimmed.includes('fetch(') || trimmed.includes('const ') || trimmed.includes('await ')) {
    return 'javascript'
  }
  if (trimmed.includes('import requests') || trimmed.includes('requests.') || trimmed.includes('def ')) {
    return 'python'
  }
  return fallback
}

export default function ApiReferenceView({
  modules,
  activeModuleId,
  onModuleChange,
  onBackToDocs,
  activeEndpointSlug,
  onEndpointChange,
  embedded = false,
  showSidebar = true,
  showModuleTabs = true,
}: Props) {
  const moduleMap = useMemo(() => Object.fromEntries(modules.map((module) => [module.slug, module])), [modules])
  const activeModule = moduleMap[activeModuleId] ?? modules[0] ?? EMPTY_MODULE
  const [activeEndpointId, setActiveEndpointId] = useState(activeEndpointSlug ?? activeModule.endpoints[0]?.slug ?? '')
  const [responseTab, setResponseTab] = useState<ResponseTab>('body')
  const [requestConfigTab, setRequestConfigTab] = useState<RequestConfigTab>('overview')
  const [filterText, setFilterText] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [isRestoring, setIsRestoring] = useState(false)
  const [confirmExecutionOpen, setConfirmExecutionOpen] = useState(false)
  const [exampleReplacementAction, setExampleReplacementAction] = useState<ExampleReplacementAction | null>(null)
  const [showAllResponseFields, setShowAllResponseFields] = useState(false)
  const [localModelBaseUrl, setLocalModelBaseUrl] = useState(
    activeModule.endpointBase || 'http://localhost:11434',
  )
  const [debuggerStorageScope, setDebuggerStorageScope] = useState(() => getAuthCacheScope())
  const [favorites, setFavorites] = useState<string[]>(() => typeof window === 'undefined' ? [] : safeParseStringArray(window.localStorage.getItem(debuggerStorageKey(DEBUGGER_FAVORITES_KEY))))
  const [recentEntries, setRecentEntries] = useState<string[]>(() => typeof window === 'undefined' ? [] : safeParseStringArray(window.localStorage.getItem(debuggerStorageKey(DEBUGGER_RECENT_KEY))))
  const [history, setHistory] = useState<DebuggerHistoryItem[]>(() => typeof window === 'undefined' ? [] : safeParseHistory(window.localStorage.getItem(debuggerStorageKey(DEBUGGER_HISTORY_KEY))))
  const [bodyMode, setBodyMode] = useState<BodyMode>('form')
  const [requestState, setRequestState] = useState<RequestState>(buildInitialRequestState(activeModule.endpoints[0] ?? {
    id: 0,
    moduleId: 0,
    slug: 'empty',
    group: 'overview',
    method: 'GET',
    path: '/planned',
    summary: '',
    description: '',
    sourceType: 'manual',
    sourceIdentifier: '',
    sortOrder: 0,
    isVisible: true,
    tags: [],
    params: [],
    responses: [],
    codeSamples: [{ id: 'curl', label: 'cURL', language: 'bash', code: '# 暂无示例' }],
    requestPreview: '{}',
    responseBody: '{}',
    responseMeta: '{}',
  }))

  const [debugResult, setDebugResult] = useState<DebugResult>({
    status: null,
    ok: false,
    durationMs: null,
    timestamp: '',
    headers: [],
    body: '',
    request: '',
    curl: '',
    error: '',
  })
  const responseSectionRef = useRef<HTMLDivElement | null>(null)
  const executionRequestRef = useRef(0)
  const executionControllerRef = useRef<AbortController | null>(null)
  const restoreRequestRef = useRef(0)
  const restoreInFlightRef = useRef(false)
  const restoreControllerRef = useRef<AbortController | null>(null)
  const requestBaselineRef = useRef('')

  useEffect(() => {
    const loadScopedDebuggerStorage = (event?: Event) => {
      if (event instanceof StorageEvent && event.key !== 'access_token') return
      const nextScope = getAuthCacheScope()
      executionRequestRef.current += 1
      executionControllerRef.current?.abort()
      executionControllerRef.current = null
      restoreRequestRef.current += 1
      restoreControllerRef.current?.abort()
      restoreControllerRef.current = null
      restoreInFlightRef.current = false
      setIsSending(false)
      setIsRestoring(false)
      setConfirmExecutionOpen(false)
      setExampleReplacementAction(null)
      setDebugResult({ status: null, ok: false, durationMs: null, timestamp: '', headers: [], body: '', request: '', curl: '', error: '' })
      setDebuggerStorageScope(nextScope)
      setFavorites(safeParseStringArray(window.localStorage.getItem(debuggerStorageKey(DEBUGGER_FAVORITES_KEY, nextScope))))
      setRecentEntries(safeParseStringArray(window.localStorage.getItem(debuggerStorageKey(DEBUGGER_RECENT_KEY, nextScope))))
      setHistory(safeParseHistory(window.localStorage.getItem(debuggerStorageKey(DEBUGGER_HISTORY_KEY, nextScope))))
    }
    // 旧键无法证明所属账号，不迁移到当前账号空间。
    window.localStorage.removeItem(DEBUGGER_FAVORITES_KEY)
    window.localStorage.removeItem(DEBUGGER_RECENT_KEY)
    window.localStorage.removeItem(DEBUGGER_HISTORY_KEY)
    loadScopedDebuggerStorage()
    window.addEventListener(AUTH_STORAGE_EVENT, loadScopedDebuggerStorage)
    window.addEventListener('storage', loadScopedDebuggerStorage)
    return () => {
      window.removeEventListener(AUTH_STORAGE_EVENT, loadScopedDebuggerStorage)
      window.removeEventListener('storage', loadScopedDebuggerStorage)
    }
  }, [])

  const activeEndpoint = useMemo<ApiEndpoint>(() => {
    return activeModule.endpoints.find((endpoint) => endpoint.slug === activeEndpointId) ?? activeModule.endpoints[0] ?? {
      id: 0,
      moduleId: activeModule.id,
      slug: 'empty-endpoint',
      group: 'overview',
      method: 'GET',
      path: '/planned',
      summary: '接口规划中',
      description: '当前模块暂未配置具体接口，请先在接口控制台执行 OpenAPI 导入或手工补充。',
      sourceType: 'manual',
      sourceIdentifier: 'manual:planned',
      sortOrder: 0,
      isVisible: true,
      tags: ['Planned'],
      params: [],
      responses: [],
      notes: ['请先在接口控制台中补充该模块的接口骨架与文档内容。'],
      codeSamples: [{ id: 'curl', label: 'cURL', language: 'bash', code: '# 当前模块暂无接口代码示例，请先完成接口配置。' }],
      requestPreview: '{}',
      responseBody: '{"message":"当前模块暂无接口，请先完成配置。"}',
      responseMeta: '{"status":200,"mode":"static"}',
    }
  }, [activeEndpointId, activeModule])

  const requestExampleText = useMemo(
    () => getEndpointRequestExample(activeEndpoint),
    [activeEndpoint],
  )
  const requestStateSignature = useMemo(() => JSON.stringify(requestState), [requestState])
  const requestHasChanges = Boolean(requestBaselineRef.current && requestStateSignature !== requestBaselineRef.current)

  const requestBodyFieldCount = activeEndpoint.params.filter((param) => param.location === 'body').length

  const visibleEndpointNotes = useMemo(
    () => (activeEndpoint.notes || []).filter(
      (note) => !INTERNAL_NOTE_PATTERNS.some((pattern) => pattern.test(note)),
    ),
    [activeEndpoint.notes],
  )

  const groupedParams = useMemo(
    () => ({
      path: activeEndpoint.params.filter((param) => param.location === 'path'),
      query: activeEndpoint.params.filter((param) => param.location === 'query'),
      header: activeEndpoint.params.filter((param) => param.location === 'header'),
      body: activeEndpoint.params.filter((param) => param.location === 'body'),
    }),
    [activeEndpoint],
  )

  const canRealDebug = useMemo(
    () => isRealDebuggable(activeModule, activeEndpoint),
    [activeModule, activeEndpoint],
  )
  const requiresExecutionConfirmation = useMemo(
    () => canRealDebug && activeEndpoint.method !== 'GET' && !(
      activeModule.slug === 'local-model' && ['/api/generate', '/api/chat', '/api/embed'].includes(activeEndpoint.path)
    ),
    [activeEndpoint.method, activeEndpoint.path, activeModule.slug, canRealDebug],
  )

  const responseBodyLanguage = useMemo(
    () => inferCodeLanguage(debugResult.body, 'json'),
    [debugResult.body],
  )
  const requestCodeLanguage = useMemo(
    () => inferCodeLanguage(debugResult.request, 'json'),
    [debugResult.request],
  )
  const errorCodeLanguage = useMemo(
    () => inferCodeLanguage(debugResult.error, 'bash'),
    [debugResult.error],
  )
  const debugStatus = useMemo(
    () => getDebugStatus(debugResult, isSending, canRealDebug),
    [canRealDebug, debugResult, isSending],
  )

  const filteredGroups = useMemo(() => {
    const matchesFilter = (endpoint: ApiEndpoint) => {
      if (!filterText) return true
      const searchable = `${endpoint.path} ${endpoint.summary} ${endpoint.description}`.toLowerCase()
      return searchable.includes(filterText.toLowerCase())
    }
    const configuredGroupIds = new Set(activeModule.groups.map((group) => group.id))
    const grouped = activeModule.groups
      .map((group) => {
        const endpoints = activeModule.endpoints.filter((endpoint) => {
          if (endpoint.group !== group.id) return false
          return matchesFilter(endpoint)
        })
        return { ...group, endpoints }
      })
    const ungroupedEndpoints = activeModule.endpoints.filter((endpoint) => {
      if (configuredGroupIds.has(endpoint.group)) return false
      return matchesFilter(endpoint)
    })
    return [
      ...grouped,
      { id: 'ungrouped', label: '其他接口', endpoints: ungroupedEndpoints },
    ].filter((group) => group.endpoints.length > 0)
  }, [activeModule, filterText])

  const requestDetailsText = useMemo(() => debugResult.request, [debugResult.request])

  useEffect(() => {
    if (!activeEndpointSlug) return
    setActiveEndpointId(activeEndpointSlug)
  }, [activeEndpointSlug])

  useEffect(() => {
    const nextEndpointId = activeEndpointSlug ?? activeModule.endpoints[0]?.slug ?? ''
    executionRequestRef.current += 1
    executionControllerRef.current?.abort()
    executionControllerRef.current = null
    restoreRequestRef.current += 1
    restoreControllerRef.current?.abort()
    restoreControllerRef.current = null
    setIsSending(false)
    setIsRestoring(false)
    restoreInFlightRef.current = false
    setActiveEndpointId(nextEndpointId)
    setResponseTab('body')
    setRequestConfigTab('overview')
    setFilterText('')
  }, [activeModule, activeEndpointSlug])

  useEffect(() => {
    executionRequestRef.current += 1
    executionControllerRef.current?.abort()
    executionControllerRef.current = null
    restoreRequestRef.current += 1
    restoreControllerRef.current?.abort()
    restoreControllerRef.current = null
    setIsSending(false)
    setIsRestoring(false)
    restoreInFlightRef.current = false
    setRequestState(buildInitialRequestState(activeEndpoint))
    requestBaselineRef.current = JSON.stringify(buildInitialRequestState(activeEndpoint))
    setBodyMode(inferBodyMode(activeEndpoint))
    setDebugResult({
      status: null,
      ok: false,
      durationMs: null,
      timestamp: '',
      headers: [],
      body: '',
      request: '',
      curl: '',
      error: '',
    })
    setRequestConfigTab('overview')
    setConfirmExecutionOpen(false)
    setExampleReplacementAction(null)
    setShowAllResponseFields(false)
  }, [activeEndpoint, canRealDebug])

  useEffect(() => () => {
    executionRequestRef.current += 1
    executionControllerRef.current?.abort()
    executionControllerRef.current = null
    restoreRequestRef.current += 1
    restoreControllerRef.current?.abort()
    restoreControllerRef.current = null
    restoreInFlightRef.current = false
  }, [])

  useEffect(() => {
    const documentedBaseUrl = activeModule.endpointBase || 'http://localhost:11434'
    setLocalModelBaseUrl(documentedBaseUrl)
    if (activeModule.slug !== 'local-model' || !getToken()) return

    let cancelled = false
    apiDocsApi.getDebuggerRuntime().then((runtime) => {
      if (!cancelled && runtime.local_model_base_url) {
        setLocalModelBaseUrl(runtime.local_model_base_url)
      }
    }).catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [activeModule.endpointBase, activeModule.slug])

  const updateRequestField = (location: keyof Omit<RequestState, 'bodyJson'>, name: string, value: string) => {
    setRequestState((prev) => ({
      ...prev,
      [location]: {
        ...prev[location],
        [name]: value,
      },
    }))
  }

  const changeBodyMode = (nextMode: BodyMode) => {
    if (nextMode === bodyMode) return

    if (nextMode === 'form') {
      let parsedBody: unknown
      try {
        parsedBody = JSON.parse(requestState.bodyJson || '{}')
      } catch {
        toast.error('当前 JSON 格式不正确，请修正后再切换到表单模式')
        return
      }
      if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
        toast.error('请求体需要是 JSON 对象，暂不能切换到表单模式')
        return
      }
      const bodyObject = parsedBody as Record<string, unknown>
      setRequestState((prev) => ({
        ...prev,
        body: Object.fromEntries(groupedParams.body.map((param) => [
          param.name,
          Object.prototype.hasOwnProperty.call(bodyObject, param.name)
            ? stringifyDefaultValue(bodyObject[param.name])
            : '',
        ])),
      }))
      setBodyMode('form')
      return
    }

    const existingBody = parseJsonSafely<unknown>(requestState.bodyJson, {})
    const nextBody: Record<string, unknown> = existingBody && typeof existingBody === 'object' && !Array.isArray(existingBody)
      ? { ...existingBody as Record<string, unknown> }
      : {}
    for (const param of groupedParams.body) {
      const rawValue = requestState.body[param.name] ?? ''
      if (rawValue.trim()) nextBody[param.name] = castValueByType(param.type, rawValue)
      else delete nextBody[param.name]
    }
    setRequestState((prev) => ({
      ...prev,
      bodyJson: JSON.stringify(nextBody, null, 2),
    }))
    setBodyMode('json')
  }

  const loadInstalledLocalModels = async (signal?: AbortSignal) => {
    if (activeModule.slug !== 'local-model' || !getToken()) return []
    try {
      const result = await apiDocsApi.listInstalledModels(signal)
      return result.models
        .map((item) => item.name || item.model || '')
        .filter((name, index, values): name is string => Boolean(name) && values.indexOf(name) === index)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      return []
    }
  }

  const buildRestoredRequestState = async (signal?: AbortSignal) => {
    const nextState = buildInitialRequestState(activeEndpoint)
    if (activeModule.slug !== 'local-model') return nextState
    const parsedBody = parseJsonSafely<Record<string, unknown>>(nextState.bodyJson, {})
    if (!Object.prototype.hasOwnProperty.call(parsedBody, 'model') && !Object.prototype.hasOwnProperty.call(nextState.body, 'model')) {
      return nextState
    }
    const models = await loadInstalledLocalModels(signal)
    if (!models.length) {
      toast.warning('未读取到可用模型，请确认 Ollama 已启动并已安装模型')
      return nextState
    }
    return applyLocalModelDebugDefaults(
      applyInstalledModel(nextState, models[0]),
      activeEndpoint.path,
    )
  }

  const fillExample = async () => {
    if (restoreInFlightRef.current || executionControllerRef.current) {
      toast.warning(executionControllerRef.current ? '请求执行期间不能替换参数，请先取消等待' : '正在读取示例参数，请稍候')
      return
    }
    const requestId = ++restoreRequestRef.current
    const controller = new AbortController()
    restoreControllerRef.current = controller
    restoreInFlightRef.current = true
    setIsRestoring(true)
    try {
      const nextState = await buildRestoredRequestState(controller.signal)
      if (restoreRequestRef.current !== requestId) return
      setRequestState(nextState)
      requestBaselineRef.current = JSON.stringify(nextState)
      toast.success('已填充示例参数')
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        toast.error('示例参数读取失败，请检查平台后端和 Ollama 状态')
      }
    } finally {
      if (restoreControllerRef.current === controller) restoreControllerRef.current = null
      if (restoreRequestRef.current === requestId) {
        restoreInFlightRef.current = false
        setIsRestoring(false)
      }
    }
  }

  const resetRequest = async () => {
    if (restoreInFlightRef.current || executionControllerRef.current) {
      toast.warning(executionControllerRef.current ? '请求执行期间不能恢复参数，请先取消等待' : '正在读取示例参数，请稍候')
      return
    }
    const requestId = ++restoreRequestRef.current
    const controller = new AbortController()
    restoreControllerRef.current = controller
    restoreInFlightRef.current = true
    setIsRestoring(true)
    try {
      const nextState = await buildRestoredRequestState(controller.signal)
      if (restoreRequestRef.current !== requestId) return
      setRequestState(nextState)
      requestBaselineRef.current = JSON.stringify(nextState)
      setBodyMode(inferBodyMode(activeEndpoint))
      setResponseTab('body')
      setDebugResult({
        status: null,
        ok: false,
        durationMs: null,
        timestamp: '',
        headers: [],
        body: '',
        request: '',
        curl: '',
        error: '',
      })
      toast.info('已恢复默认配置')
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        toast.error('默认配置读取失败，请检查平台后端和 Ollama 状态')
      }
    } finally {
      if (restoreControllerRef.current === controller) restoreControllerRef.current = null
      if (restoreRequestRef.current === requestId) {
        restoreInFlightRef.current = false
        setIsRestoring(false)
      }
    }
  }

  const formatBodyJson = () => {
    try {
      const formattedBody = formatJsonString(requestState.bodyJson)
      setRequestState((prev) => ({
        ...prev,
        bodyJson: formattedBody,
      }))
      toast.success('JSON 已格式化')
    } catch {
      toast.error('当前 JSON 格式不正确，无法格式化')
    }
  }

  // 简化版 buildRequestPayload：不再需要手动配置 baseUrl 或鉴权
  // 后端执行器会自动透传用户 JWT，对 /api/v1/* 接口使用自身 baseUrl
  const buildRequestPayload = () => {
    if (!canRealDebug) {
      return {
        url: activeEndpoint.path,
        method: activeEndpoint.method,
        headers: {} as Record<string, string>,
        requestBodyText: requestState.bodyJson,
        bodyValue: requestState.bodyJson,
      }
    }

    const resolvedPath = replacePathParams(activeEndpoint.path, requestState.path)
    const browserOrigin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin
    const requestBaseUrl = activeModule.slug === 'local-model'
      ? localModelBaseUrl
      : browserOrigin
    const url = new URL(joinUrl(requestBaseUrl, resolvedPath))

    for (const param of groupedParams.query) {
      const value = requestState.query[param.name]
      if (value?.trim()) url.searchParams.set(param.name, value)
    }

    const headers: Record<string, string> = {}
    for (const param of groupedParams.header) {
      const value = requestState.header[param.name]
      if (value?.trim()) headers[param.name] = value
    }

    let bodyValue: unknown = undefined
    let requestBodyText = ''

    if (!['GET'].includes(activeEndpoint.method)) {
      if (groupedParams.body.length) {
        if (bodyMode === 'json') {
          if (requestState.bodyJson.trim()) {
            try {
              bodyValue = JSON.parse(requestState.bodyJson)
            } catch {
              throw new Error('JSON 请求体格式不正确')
            }
          }
        } else {
          const bodyPayload: Record<string, unknown> = {}
          for (const param of groupedParams.body) {
            const rawValue = requestState.body[param.name]
            if (rawValue?.trim()) {
              bodyPayload[param.name] = castValueByType(param.type, rawValue)
            }
          }
          bodyValue = bodyPayload
        }
      } else if (requestState.bodyJson.trim() && requestState.bodyJson.trim() !== '{}') {
        try {
          bodyValue = JSON.parse(requestState.bodyJson)
        } catch {
          throw new Error('JSON 请求体格式不正确')
        }
      }
    }

    if (bodyValue !== undefined) {
      headers['Content-Type'] = 'application/json'
      requestBodyText = typeof bodyValue === 'string' ? bodyValue : JSON.stringify(bodyValue, null, 2)
    }

    let previewUrl = url.toString()
    for (const param of groupedParams.path) {
      if (requestState.path[param.name]?.trim()) continue
      previewUrl = previewUrl.replaceAll(
        encodeURIComponent(`{${param.name}}`),
        `{${param.name}}`,
      )
    }

    return {
      url: previewUrl,
      method: activeEndpoint.method,
      headers,
      bodyValue,
      requestBodyText,
    }
  }

  const copyCurrentCurl = () => {
    try {
      const payload = buildRequestPayload()
      copyText(
        buildCurlSnippet({
          method: payload.method,
          url: payload.url,
          headers: payload.headers,
          body: payload.requestBodyText || undefined,
        }),
        '已复制 cURL',
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '复制 cURL 失败')
    }
  }

  const copyCurrentRequest = () => {
    try {
      const payload = buildRequestPayload()
      copyText(
        JSON.stringify(
          {
            method: payload.method,
            url: payload.url,
            headers: payload.headers,
            body: parseRequestBodyForSnapshot(payload.requestBodyText),
          },
          null,
          2,
        ),
        '已复制请求详情',
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '复制请求详情失败')
    }
  }

  const currentRequestPreviewText = useMemo(() => {
    try {
      const payload = buildRequestPayload()
      return JSON.stringify(
        {
          method: payload.method,
          url: payload.url,
          headers: payload.headers,
          body: parseRequestBodyForSnapshot(payload.requestBodyText),
        },
        null,
        2,
      )
    } catch (error) {
      return JSON.stringify(
        {
          error: error instanceof Error ? error.message : '请求配置不完整',
          method: activeEndpoint.method,
          path: activeEndpoint.path,
        },
        null,
        2,
      )
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEndpoint, bodyMode, canRealDebug, groupedParams, localModelBaseUrl, requestState])

  const currentCurlText = useMemo(() => {
    try {
      const payload = buildRequestPayload()
      return buildCurlSnippet({
        method: payload.method,
        url: payload.url,
        headers: payload.headers,
        body: payload.requestBodyText || undefined,
      })
    } catch (error) {
      return `# ${error instanceof Error ? error.message : '当前请求配置不完整'}`
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEndpoint, bodyMode, canRealDebug, groupedParams, localModelBaseUrl, requestState])

  const sendRequest = async (confirmed = false) => {
    if (executionControllerRef.current) {
      toast.warning('当前请求仍在执行，可先取消等待后再重试')
      return
    }
    if (!canRealDebug) {
      toast.warning('当前端点仅提供文档示例，不支持执行调试')
      setRequestConfigTab('example')
      return
    }
    if (restoreInFlightRef.current) {
      toast.warning('示例参数仍在加载，请稍候再执行')
      return
    }

    // 前置校验：路径参数是否全部填写
    if (canRealDebug && groupedParams.path.length > 0) {
      const emptyRequired = groupedParams.path.filter(
        (param) => param.required && !requestState.path[param.name]?.trim(),
      )
      if (emptyRequired.length > 0) {
        toast.error(`请先填写路径参数：${emptyRequired.map((param) => param.name).join('、')}`)
        setRequestConfigTab('path')
        return
      }
    }

    const missingQueryParams = groupedParams.query.filter(
      (param) => param.required && !requestState.query[param.name]?.trim(),
    )
    if (missingQueryParams.length) {
      toast.error(`请先填写查询参数：${missingQueryParams.map((param) => param.name).join('、')}`)
      setRequestConfigTab('query')
      return
    }
    const missingHeaderParams = groupedParams.header.filter(
      (param) => param.required && !requestState.header[param.name]?.trim(),
    )
    if (missingHeaderParams.length) {
      toast.error(`请先填写请求头：${missingHeaderParams.map((param) => param.name).join('、')}`)
      setRequestConfigTab('headers')
      return
    }
    const requiredBodyParams = groupedParams.body.filter((param) => param.required)
    if (requiredBodyParams.length) {
      if (bodyMode === 'json') {
        let parsedBody: Record<string, unknown>
        try {
          parsedBody = JSON.parse(requestState.bodyJson) as Record<string, unknown>
        } catch {
          toast.error('JSON 请求体格式不正确')
          setRequestConfigTab('body')
          return
        }
        const missingBodyParams = requiredBodyParams.filter((param) => {
          const value = parsedBody?.[param.name]
          return value === undefined || value === null || (typeof value === 'string' && !value.trim())
        })
        if (missingBodyParams.length) {
          toast.error(`请先填写请求体字段：${missingBodyParams.map((param) => param.name).join('、')}`)
          setRequestConfigTab('body')
          return
        }
      } else {
        const missingBodyParams = requiredBodyParams.filter((param) => !requestState.body[param.name]?.trim())
        if (missingBodyParams.length) {
          toast.error(`请先填写请求体字段：${missingBodyParams.map((param) => param.name).join('、')}`)
          setRequestConfigTab('body')
          return
        }
      }
    }

    if (requiresExecutionConfirmation && !confirmed) {
      setConfirmExecutionOpen(true)
      return
    }

    setConfirmExecutionOpen(false)
    const requestId = ++executionRequestRef.current
    const controller = new AbortController()
    executionControllerRef.current = controller
    setIsSending(true)
    const startedAt = performance.now()

    try {
      const payload = buildRequestPayload()
      const requestSnapshot = JSON.stringify(
        {
          method: payload.method,
          url: payload.url,
          headers: payload.headers,
          body: parseRequestBodyForSnapshot(payload.requestBodyText),
        },
        null,
        2,
      )

      // 后端代理执行：auth_type=none 时后端自动透传当前用户 JWT
      const result = await apiDocsApi.executeDebugger({
        moduleSlug: activeModule.slug,
        endpointSlug: activeEndpoint.slug,
        baseUrl: activeModule.slug === 'local-model' ? localModelBaseUrl : '',
        method: payload.method,
        path: activeEndpoint.path,
        pathParams: requestState.path,
        queryParams: requestState.query,
        headers: requestState.header,
        bodyText: payload.requestBodyText,
        authType: 'none',
        authValue: '',
        customHeaderName: '',
        confirmRiskyExecution: confirmed,
      }, controller.signal)

      if (executionRequestRef.current !== requestId) return

      setDebugResult({
        status: result.statusCode,
        ok: result.success,
        durationMs: result.durationMs,
        timestamp: new Date().toLocaleString('zh-CN'),
        headers: Object.entries(result.responseHeaders || {}),
        body: formatUnknownBody(result.responseBody) || '{}',
        request: JSON.stringify(result.requestSnapshot || JSON.parse(requestSnapshot), null, 2),
        curl: result.curlCommand || currentCurlText,
        error: result.error || '',
      })
      setResponseTab(result.success ? 'body' : 'error')

      setRecentEntries((current) => {
        const storageKey = endpointStorageKey(activeModule.slug, activeEndpoint.slug)
        const next = [storageKey, ...current.filter((item) => item !== storageKey && item !== activeEndpoint.slug)].slice(0, 8)
        window.localStorage.setItem(debuggerStorageKey(DEBUGGER_RECENT_KEY, debuggerStorageScope), JSON.stringify(next))
        return next
      })
      setHistory((current) => {
        const next = [{
          moduleSlug: activeModule.slug,
          endpointSlug: activeEndpoint.slug,
          summary: activeEndpoint.summary,
          status: result.statusCode,
          createdAt: new Date().toLocaleString('zh-CN'),
          success: result.success,
        }, ...current].slice(0, 10)
        window.localStorage.setItem(debuggerStorageKey(DEBUGGER_HISTORY_KEY, debuggerStorageScope), JSON.stringify(next))
        return next
      })
      window.requestAnimationFrame(() => responseSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    } catch (error) {
      if (executionRequestRef.current !== requestId) return
      if (error instanceof DOMException && error.name === 'AbortError') return
      const message = error instanceof Error ? error.message : '请求失败'

      let requestSnapshot = ''
      try {
        const payload = buildRequestPayload()
        requestSnapshot = JSON.stringify(
          {
            method: payload.method,
            url: payload.url,
            headers: payload.headers,
            body: parseRequestBodyForSnapshot(payload.requestBodyText),
          },
          null,
          2,
        )
      } catch {
        requestSnapshot = JSON.stringify({ currentPath: activeEndpoint.path }, null, 2)
      }

      setDebugResult({
        status: null,
        ok: false,
        durationMs: Math.round(performance.now() - startedAt),
        timestamp: new Date().toLocaleString('zh-CN'),
        headers: [],
        body: '',
        request: requestSnapshot,
        curl: currentCurlText,
        error: message,
      })
      setResponseTab('error')
      window.requestAnimationFrame(() => responseSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    } finally {
      if (executionRequestRef.current === requestId) {
        executionControllerRef.current = null
        setIsSending(false)
      }
    }
  }

  const cancelExecution = () => {
    if (!isSending) return
    executionRequestRef.current += 1
    executionControllerRef.current?.abort()
    executionControllerRef.current = null
    setIsSending(false)
    setDebugResult({
      status: null,
      ok: false,
      durationMs: null,
      timestamp: new Date().toLocaleString('zh-CN'),
      headers: [],
      body: '',
      request: currentRequestPreviewText,
      curl: currentCurlText,
      error: '已取消等待后端代理返回。目标服务可能已收到请求，请在再次执行前核对业务状态。',
    })
    setResponseTab('error')
    toast.warning('已取消等待，执行按钮已恢复')
  }

  const invalidateActiveWork = () => {
    executionRequestRef.current += 1
    executionControllerRef.current?.abort()
    executionControllerRef.current = null
    restoreRequestRef.current += 1
    restoreInFlightRef.current = false
    setIsSending(false)
    setIsRestoring(false)
    setConfirmExecutionOpen(false)
    setExampleReplacementAction(null)
  }

  const selectEndpoint = (endpointSlug: string) => {
    invalidateActiveWork()
    setActiveEndpointId(endpointSlug)
    onEndpointChange?.(endpointSlug)
  }

  const selectModule = (moduleSlug: string) => {
    invalidateActiveWork()
    onModuleChange(moduleSlug)
  }

  const selectStoredEndpoint = (moduleSlug: string, endpointSlug: string) => {
    invalidateActiveWork()
    if (moduleSlug !== activeModule.slug) onModuleChange(moduleSlug)
    setActiveEndpointId(endpointSlug)
    onEndpointChange?.(endpointSlug)
  }

  const requestExampleReplacement = (action: ExampleReplacementAction) => {
    if (requestHasChanges) {
      setExampleReplacementAction(action)
      return
    }
    if (action === 'fill') void fillExample()
    else void resetRequest()
  }

  const activeEndpointStorageKey = endpointStorageKey(activeModule.slug, activeEndpoint.slug)
  const legacyFavoriteOwnerCount = modules.filter(
    (module) => module.endpoints.some((endpoint) => endpoint.slug === activeEndpoint.slug),
  ).length
  const isFavorite = favorites.includes(activeEndpointStorageKey)
    || (legacyFavoriteOwnerCount === 1 && favorites.includes(activeEndpoint.slug))
  const toggleFavorite = () => {
    const nextFavorites = isFavorite
      ? favorites.filter((item) => item !== activeEndpointStorageKey && item !== activeEndpoint.slug)
      : [activeEndpointStorageKey, ...favorites.filter((item) => item !== activeEndpointStorageKey && item !== activeEndpoint.slug)].slice(0, 30)
    setFavorites(nextFavorites)
    window.localStorage.setItem(debuggerStorageKey(DEBUGGER_FAVORITES_KEY, debuggerStorageScope), JSON.stringify(nextFavorites))
    toast.success(isFavorite ? '已取消收藏' : '已收藏当前接口')
  }

  const requestTabs: Array<{ id: RequestConfigTab; label: string; count?: number }> = [
    { id: 'overview', label: '接口说明' },
    { id: 'path', label: '路径参数', count: groupedParams.path.length },
    { id: 'query', label: '查询参数', count: groupedParams.query.length },
    { id: 'headers', label: '请求头', count: groupedParams.header.length },
    { id: 'body', label: '请求体 JSON', count: requestBodyFieldCount },
    { id: 'example', label: '请求示例' },
    { id: 'preview', label: '请求预览' },
  ]

  const responseTabs: Array<{ id: ResponseTab; label: string }> = [
    { id: 'body', label: '响应报文' },
    { id: 'headers', label: '响应头' },
    { id: 'request', label: '请求详情' },
    { id: 'curl', label: 'cURL' },
    { id: 'error', label: '错误诊断' },
  ]

  const favoriteEndpoints = favorites.map((value) => resolveStoredEndpoint(value, modules)).filter(isResolvedStoredEndpoint)
  const recentEndpoints = recentEntries.map((value) => resolveStoredEndpoint(value, modules)).filter(isResolvedStoredEndpoint)
  const visibleHistory = history.flatMap((item) => {
    const owner = item.moduleSlug
      ? modules.find((module) => module.slug === item.moduleSlug && module.endpoints.some((endpoint) => endpoint.slug === item.endpointSlug))
      : modules.filter((module) => module.endpoints.some((endpoint) => endpoint.slug === item.endpointSlug)).length === 1
        ? modules.find((module) => module.endpoints.some((endpoint) => endpoint.slug === item.endpointSlug))
        : undefined
    return owner ? [{ item, moduleSlug: owner.slug }] : []
  })

  const renderEmptyState = (message: string) => (
    <div className="rounded-[8px] border border-dashed border-slate-200 bg-slate-50 px-5 py-8 text-center text-sm font-semibold text-slate-400">
      {message}
    </div>
  )

  const renderParamEditor = (
    title: string,
    description: string,
    params: typeof groupedParams.path,
    location: 'path' | 'query' | 'header',
  ) => (
    <div>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-black text-slate-900">{title}</h3>
          <p className="mt-1 text-sm leading-6 text-slate-500">{description}</p>
        </div>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-[10px] font-black text-slate-500">{params.length}</span>
      </div>
      {params.length ? (
        <div className="grid gap-3">
          {params.map((param) => (
            <label key={`${location}-${param.name}`} className="grid gap-3 rounded-[8px] border border-slate-100 bg-slate-50 p-4 xl:grid-cols-[minmax(180px,0.35fr)_minmax(0,1fr)]">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="truncate text-sm font-black text-slate-900">{param.name}</code>
                  <span className={`rounded-[6px] px-1.5 py-0.5 text-[10px] font-black ${param.required ? 'bg-rose-50 text-rose-600' : 'bg-slate-200 text-slate-500'}`}>
                    {param.required ? '必填' : '可选'}
                  </span>
                  <span className="rounded-[6px] bg-violet-50 px-2 py-1 text-[10px] font-black text-violet-700">{param.type}</span>
                </div>
                <p className="mt-2 text-[12px] leading-6 text-slate-500">{param.description || '暂无参数说明'}</p>
                {param.defaultValue !== undefined && param.defaultValue !== null && stringifyDefaultValue(param.defaultValue) ? (
                  <p className="mt-1 truncate font-mono text-[11px] text-slate-400">默认值：{stringifyDefaultValue(param.defaultValue)}</p>
                ) : null}
              </div>
              <input
                value={requestState[location][param.name] ?? ''}
                onChange={(event) => updateRequestField(location, param.name, event.target.value)}
                className="h-10 w-full rounded-[8px] border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
                placeholder={param.description || param.name}
              />
            </label>
          ))}
        </div>
      ) : renderEmptyState('当前接口没有该类参数')}
    </div>
  )

  if (!modules.length || !activeModule) {
    return (
      <div className={`flex items-center justify-center rounded-[8px] border border-dashed border-slate-300 bg-white p-10 text-sm text-slate-500 ${embedded ? 'h-full' : 'min-h-[60vh]'}`}>
        暂无可展示的 API 参考模块，请先在接口控制台中完成配置。
      </div>
    )
  }

  const ActiveModuleIcon = moduleIconMap[activeModule.slug] ?? FileCode2
  const summaryItems = [
    {
      label: '接口基址',
      value: activeModule.slug === 'local-model'
        ? localModelBaseUrl
        : activeModule.endpointBase || '待配置',
      technical: true,
    },
    { label: '呈现方式', value: activeModule.rendererType === 'api-reference' ? '交互式 API 参考' : activeModule.rendererType || '接口参考', technical: false },
    {
      label: '内容来源',
      value: ({ markdown: 'Markdown 文档', openapi: 'OpenAPI 定义', manual: '手工维护', seed: '系统预置' } as Record<string, string>)[activeModule.sourceType] || activeModule.sourceType || '手工维护',
      technical: false,
    },
  ]

  return (
    <div className={`${embedded ? 'h-full overflow-hidden bg-transparent' : 'h-[calc(100vh-64px)] overflow-hidden bg-slate-50'}`}>
      <div className="flex h-full flex-col">
        {showModuleTabs ? (
          <div className="border-b border-slate-200 bg-white px-5">
            <div className="flex h-11 items-center gap-3 overflow-x-auto">
              {!embedded && onBackToDocs ? (
                <button
                  onClick={onBackToDocs}
                  className="flex items-center gap-2 pr-4 text-[11px] font-bold text-slate-400 transition hover:text-blue-600"
                >
                  <ArrowLeft size={14} />
                  <span>返回文档中心</span>
                </button>
              ) : null}
              {modules.map((module) => {
                const Icon = moduleIconMap[module.slug] ?? FileCode2
                const isActive = module.slug === activeModule.slug
                return (
                  <button
                    key={module.slug}
                    onClick={() => selectModule(module.slug)}
                    className={`flex h-full items-center gap-2 whitespace-nowrap border-b-2 px-3 text-[12px] font-bold transition ${
                      isActive ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    <Icon size={14} />
                    <span>{module.title}</span>
                  </button>
                )
              })}
            </div>
          </div>
        ) : null}

        <div className="flex h-full min-h-0">
          {/* 左侧接口目录 */}
          {showSidebar ? (
            <aside className="hidden w-[276px] shrink-0 border-r border-slate-200 bg-white lg:flex lg:flex-col">
              <div className="border-b border-slate-100 px-5 py-5">
                <div className="mb-2 inline-flex rounded-[6px] bg-blue-50 px-3 py-1 text-[10px] font-black text-blue-600">
                  API 参考
                </div>
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] bg-blue-50 text-blue-600">
                    <ActiveModuleIcon size={18} />
                  </div>
                  <div className="min-w-0">
                    <h2 className="text-[13px] font-black leading-6 text-slate-900">{activeModule.title}</h2>
                    <p className="mt-1 text-[11px] leading-5 text-slate-500">{activeModule.subtitle}</p>
                  </div>
                </div>
              </div>

              <div className="border-b border-slate-100 px-4 py-3">
                <div className="relative">
                  <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    aria-label="搜索 API 端点"
                    value={filterText}
                    onChange={(event) => setFilterText(event.target.value)}
                    className="w-full rounded-[8px] border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-sm text-slate-700 outline-none transition focus:border-blue-300 focus:bg-white focus:ring-2 focus:ring-blue-100"
                    placeholder="搜索端点..."
                  />
                </div>
              </div>

              <div className="docs-api-scroll flex-1 overflow-y-auto px-3 py-4">
                {filteredGroups.map((group) => (
                  <div key={group.id} className="mb-5">
                    <p className="mb-2 px-2 text-[10px] font-black text-slate-400">{group.label}</p>
                    <div className="space-y-1">
                      {group.endpoints.map((endpoint) => (
                        <button
                          key={endpoint.slug}
                          onClick={() => selectEndpoint(endpoint.slug)}
                          className={`w-full rounded-[8px] px-3 py-3 text-left transition ${
                            activeEndpoint.slug === endpoint.slug ? 'bg-blue-50' : 'hover:bg-slate-50'
                          }`}
                        >
                          <div className="flex items-start gap-3">
                            <span className={`mt-0.5 rounded-[6px] px-2 py-1 text-[10px] font-black ${methodStyles[endpoint.method]}`}>
                              {endpoint.method}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className={`truncate text-[12px] font-bold ${activeEndpoint.slug === endpoint.slug ? 'text-blue-700' : 'text-slate-800'}`}>
                                {endpoint.path}
                              </div>
                              <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-slate-500">{endpoint.summary}</p>
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex items-center gap-2 border-t border-slate-100 px-4 py-3 text-[11px] text-slate-500">
                <span className="h-2 w-2 rounded-full bg-blue-500" />
                <span>当前接口支持调试操作</span>
              </div>
            </aside>
          ) : null}

          {/* 右侧主内容区 */}
          <main className="docs-api-scroll min-w-0 flex-1 overflow-y-auto bg-slate-50 p-3 sm:p-5">
            <div className="mx-auto grid max-w-[1500px] gap-4">

              {/* ── 统计卡片行 ── */}
              <MetricStrip
                columns={4}
                className="xl:grid-cols-[0.72fr_1.18fr_1.05fr_1.05fr]"
                items={[
                  { label: '接口数量', value: activeModule.endpoints.length, detail: `${filteredGroups.length} 个分组`, icon: FileCode2 },
                  { label: '当前模块', value: activeModule.title, detail: activeModule.status === 'planned' ? '规划中' : '已配置', icon: ActiveModuleIcon, wrapValue: true, valueClassName: 'text-base leading-5 sm:text-lg sm:leading-6' },
                  { label: '当前端点', value: activeEndpoint.summary || activeEndpoint.path, detail: activeEndpoint.method, icon: Workflow, wrapValue: true, valueClassName: 'text-base leading-5 sm:text-lg sm:leading-6' },
                  { label: '当前执行状态', value: debugStatus.label, detail: debugStatus.detail, icon: debugResult.ok ? CheckCircle2 : debugResult.timestamp ? TriangleAlert : Clock3, tone: debugStatus.tone === 'success' ? 'success' : debugStatus.tone === 'danger' ? 'danger' : debugStatus.tone === 'warning' ? 'warning' : 'default' },
                ]}
              />

              {/* ── 主内容大卡（接口配置 + 响应 + 历史 合并为一个容器）── */}
              <div className="overflow-hidden rounded-[8px] border border-slate-200 bg-white">

                {/* 接口标题栏 */}
                <div className="border-b border-slate-100 px-5 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <span className={`rounded px-2.5 py-0.5 text-[10px] font-black tracking-[0.08em] ${methodStyles[activeEndpoint.method]}`}>
                          {activeEndpoint.method}
                        </span>
                        <code className="min-w-0 truncate rounded bg-slate-100 px-2 py-0.5 font-mono text-[12px] font-bold text-slate-700">
                          {activeEndpoint.path}
                        </code>
                        <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold ${canRealDebug ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-700'}`}>
                          {canRealDebug ? '代理执行' : '静态预览'}
                        </span>
                      </div>
                      <h1 className="truncate text-lg font-black text-slate-900">{activeEndpoint.summary}</h1>
                      <p className="mt-1 max-w-3xl text-[13px] leading-6 text-slate-500">{activeEndpoint.description || activeModule.description}</p>
                    </div>
                    <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0">
                      <button
                        onClick={() => copyText(activeEndpoint.path, '已复制路径')}
                        className="inline-flex h-9 items-center gap-1.5 rounded-[7px] border border-slate-200 bg-white px-3 text-[13px] font-bold text-slate-600 transition hover:border-blue-200 hover:text-blue-600"
                      >
                        <Clipboard size={14} />复制路径
                      </button>
                      <button
                        onClick={toggleFavorite}
                        className={`inline-flex h-9 items-center gap-1.5 rounded-[7px] border px-3 text-[13px] font-bold transition ${
                          isFavorite ? 'border-rose-200 bg-rose-50 text-rose-600' : 'border-slate-200 bg-white text-slate-600 hover:border-blue-200 hover:text-blue-600'
                        }`}
                      >
                        <Heart size={14} className={isFavorite ? 'fill-current' : undefined} />
                        {isFavorite ? '已收藏' : '收藏'}
                      </button>
                      <button
                        onClick={() => requestExampleReplacement('reset')}
                        disabled={isRestoring || isSending}
                        className="inline-flex h-9 items-center gap-1.5 rounded-[7px] border border-slate-200 bg-white px-3 text-[13px] font-bold text-slate-600 transition hover:border-blue-200 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {isRestoring ? <Loader2 size={14} className="animate-spin" /> : <RefreshCcw size={14} />}
                        {isRestoring ? '正在恢复' : '恢复示例'}
                      </button>
                      {isSending ? (
                        <button onClick={cancelExecution} className="inline-flex h-9 items-center gap-1.5 rounded-[7px] border border-amber-200 bg-amber-50 px-4 text-[13px] font-black text-amber-800 transition hover:bg-amber-100">
                          <Square size={13} />取消等待
                        </button>
                      ) : (
                        <button
                          onClick={() => void sendRequest()}
                          disabled={!canRealDebug}
                          title={canRealDebug ? '通过后端代理发送真实请求' : '当前端点仅提供文档示例'}
                          className={`inline-flex h-9 items-center gap-1.5 rounded-[7px] px-4 text-[13px] font-black text-white transition ${
                            !canRealDebug ? 'cursor-not-allowed bg-slate-300' : 'bg-blue-600 hover:bg-blue-700'
                          }`}
                        >
                          <Play size={14} />{canRealDebug ? '执行调试' : '仅文档示例'}
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/* 请求配置 Tab 栏（下划线风格，无额外Card包裹） */}
                <div className="docs-api-scroll flex gap-0 overflow-x-auto border-b border-slate-100 px-5" role="tablist" aria-label="请求配置视图">
                  {requestTabs.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      id={`request-config-tab-${tab.id}`}
                      data-tab-id={tab.id}
                      aria-selected={requestConfigTab === tab.id}
                      aria-controls="request-config-panel"
                      tabIndex={requestConfigTab === tab.id ? 0 : -1}
                      onClick={() => setRequestConfigTab(tab.id)}
                      onKeyDown={(event) => handleTabListKeyDown(event, requestTabs.map((item) => item.id), requestConfigTab, setRequestConfigTab)}
                      className={`inline-flex shrink-0 items-center gap-1.5 border-b-2 px-4 py-3 text-[13px] font-bold transition ${
                        requestConfigTab === tab.id
                          ? 'border-blue-600 text-blue-600'
                          : 'border-transparent text-slate-500 hover:text-slate-800'
                      }`}
                    >
                      {tab.label}
                      {tab.count !== undefined ? (
                        <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-black ${
                          requestConfigTab === tab.id ? 'bg-blue-100 text-blue-600' : 'bg-slate-100 text-slate-500'
                        }`}>{tab.count}</span>
                      ) : null}
                    </button>
                  ))}
                </div>

                {/* 请求配置内容区（去掉内层 Card 包裹，直接铺在白底上） */}
                <div id="request-config-panel" role="tabpanel" aria-labelledby={`request-config-tab-${requestConfigTab}`} className="px-5 py-5">

                  {/* 接口说明 Tab */}
                  {requestConfigTab === 'overview' ? (
                    <div className="grid gap-6">
                      <div className="grid gap-5 xl:grid-cols-[1.15fr_0.85fr]">
                        {/* 左：接口说明 */}
                        <div>
                          <div className="mb-3 flex items-center gap-2">
                            <ActiveModuleIcon size={16} className="text-blue-600" />
                            <h2 className="text-sm font-black text-slate-700">接口说明</h2>
                          </div>
                          <p className="text-[13px] leading-7 text-slate-600">{activeModule.description}</p>
                          <div className="mt-4 grid gap-2 md:grid-cols-3">
                            {summaryItems.map((item) => (
                              <div key={item.label} className="min-w-0 rounded-[7px] bg-slate-50 px-3 py-2.5">
                                <div className="text-[10px] font-black text-slate-400">{item.label}</div>
                                {item.technical ? (
                                  <TechnicalId value={item.value} label={item.label} compact className="mt-1" />
                                ) : (
                                  <div className="mt-1 break-words text-[12px] font-bold text-slate-700">{item.value}</div>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                        {/* 右：标签 & 注意 */}
                        <div>
                          <div className="mb-3 text-sm font-black text-slate-700">标签与注意事项</div>
                          <div className="mb-3 flex flex-wrap gap-1.5">
                            {activeEndpoint.tags.length ? activeEndpoint.tags.map((tag) => (
                              <span key={tag} className="rounded-2xl bg-blue-50 px-2.5 py-1 text-[11px] font-black text-blue-600">{tag}</span>
                            )) : <span className="text-[13px] text-slate-400">暂无标签</span>}
                          </div>
                          {visibleEndpointNotes.length ? (
                            <ul className="space-y-1.5 text-[13px] text-amber-700">
                              {visibleEndpointNotes.map((note) => (
                                <li key={note} className="flex gap-2 rounded-[7px] bg-amber-50 px-3 py-2.5">
                                  <span aria-hidden="true" className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
                                  <span className="min-w-0 break-words">{note.replace(/^[-*]\s+/, '')}</span>
                                </li>
                              ))}
                            </ul>
                          ) : renderEmptyState('当前接口没有额外注意事项')}
                        </div>
                      </div>

                      {/* 返回字段 */}
                      <div>
                        <div className="mb-3 flex items-center justify-between gap-2">
                          <span className="text-sm font-black text-slate-700">返回字段</span>
                          <span className="rounded-[6px] bg-slate-100 px-2.5 py-0.5 text-[10px] font-black text-slate-500">{activeEndpoint.responses.length}</span>
                        </div>
                        {activeEndpoint.responses.length ? (
                          <div className="overflow-hidden rounded-[8px] border border-slate-100">
                            {(showAllResponseFields ? activeEndpoint.responses : activeEndpoint.responses.slice(0, 6)).map((field) => (
                              <div key={field.name} className="grid gap-3 border-b border-slate-100 px-4 py-3 last:border-b-0 md:grid-cols-[180px_110px_minmax(0,1fr)]">
                                <div className="truncate font-mono text-[12px] font-black text-slate-900">{field.name}</div>
                                <div className="inline-flex h-fit w-fit rounded-[6px] bg-violet-50 px-2 py-0.5 text-[10px] font-black text-violet-700">{field.type}</div>
                                <p className="text-[12px] leading-5 text-slate-500">{field.description}</p>
                              </div>
                            ))}
                            {activeEndpoint.responses.length > 6 ? (
                              <button
                                type="button"
                                onClick={() => setShowAllResponseFields((current) => !current)}
                                className="w-full border-t border-slate-100 px-4 py-2.5 text-center text-xs font-bold text-blue-600 transition hover:bg-blue-50"
                              >
                                {showAllResponseFields ? '收起返回字段' : `展开其余 ${activeEndpoint.responses.length - 6} 个字段`}
                              </button>
                            ) : null}
                          </div>
                        ) : renderEmptyState('当前接口没有配置返回字段')}
                      </div>
                    </div>
                  ) : null}

                  {requestConfigTab === 'path' ? renderParamEditor('路径参数', '用于替换 URL 路径中的占位符，执行前会编码到最终请求地址。', groupedParams.path, 'path') : null}
                  {requestConfigTab === 'query' ? renderParamEditor('查询参数', '用于拼接 URL query string，空值不会写入最终请求。', groupedParams.query, 'query') : null}
                  {requestConfigTab === 'headers' ? renderParamEditor('请求头', '用于补充接口文档声明的 Header，鉴权头由后端代理自动添加。', groupedParams.header, 'header') : null}

                  {/* 请求体 Tab */}
                  {requestConfigTab === 'body' ? (
                    <div>
                      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <span className="text-sm font-black text-slate-700">请求体 JSON</span>
                          <p className="mt-0.5 text-[13px] text-slate-500">
                            {groupedParams.body.length
                              ? '支持按参数表单生成，也可以直接编辑完整 JSON。'
                              : '当前接口没有请求体，请在对应参数页签中完成配置。'}
                          </p>
                        </div>
                        {groupedParams.body.length ? <div className="inline-flex rounded-[8px] border border-slate-200 bg-slate-50 p-0.5">
                          {([
                            { id: 'form', label: '表单模式' },
                            { id: 'json', label: 'JSON 模式' },
                          ] as const).map((item) => (
                            <button
                              key={item.id}
                              onClick={() => changeBodyMode(item.id)}
                              className={`rounded-[6px] px-3 py-1.5 text-xs font-bold transition ${
                                bodyMode === item.id ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'
                              }`}
                            >
                              {item.label}
                            </button>
                          ))}
                        </div> : null}
                      </div>

                      {!groupedParams.body.length ? (
                        renderEmptyState('当前接口没有请求体；请在路径参数或查询参数中配置请求。')
                      ) : bodyMode === 'form' ? (
                        <div className="grid gap-3">
                          {groupedParams.body.map((param) => (
                            <label key={param.name} className="grid gap-3 rounded-[8px] border border-slate-100 bg-slate-50 p-4 xl:grid-cols-[minmax(180px,0.35fr)_minmax(0,1fr)]">
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <code className="truncate text-sm font-black text-slate-900">{param.name}</code>
                                  <span className="rounded bg-violet-50 px-1.5 py-0.5 text-[10px] font-black text-violet-700">{param.type}</span>
                                </div>
                                <p className="mt-1.5 text-[12px] leading-5 text-slate-500">{param.description || '暂无参数说明'}</p>
                              </div>
                              {looksLikeComplexType(param.type) ? (
                                <textarea
                                  value={requestState.body[param.name] ?? ''}
                                  onChange={(event) => updateRequestField('body', param.name, event.target.value)}
                                  className="min-h-24 w-full resize-y rounded-[8px] border border-slate-200 bg-white px-3 py-2.5 font-mono text-sm text-slate-800 outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
                                  placeholder={param.description || param.name}
                                />
                              ) : (
                                <input
                                  value={requestState.body[param.name] ?? ''}
                                  onChange={(event) => updateRequestField('body', param.name, event.target.value)}
                                  className="h-10 w-full rounded-[8px] border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
                                  placeholder={param.description || param.name}
                                />
                              )}
                            </label>
                          ))}
                        </div>
                      ) : (
                        <div className="overflow-hidden rounded-[8px] border border-slate-200">
                          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50 px-4 py-2.5">
                            <span className="text-[11px] font-black text-slate-400">JSON 请求体</span>
                            <div className="flex gap-1">
                              <button onClick={() => requestExampleReplacement('fill')} disabled={isRestoring || isSending} className="inline-flex items-center gap-1.5 rounded-[6px] px-3 py-1.5 text-[11px] font-bold text-slate-500 transition hover:bg-white hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-60">
                                {isRestoring ? <Loader2 size={12} className="animate-spin" /> : null}{isRestoring ? '正在填充' : '填充示例'}
                              </button>
                              <button onClick={formatBodyJson} className="rounded-[6px] px-3 py-1.5 text-[11px] font-bold text-slate-500 transition hover:bg-white hover:text-blue-600">格式化 JSON</button>
                            </div>
                          </div>
                          <textarea
                            aria-label="请求体 JSON"
                            value={requestState.bodyJson}
                            onChange={(event) => setRequestState((prev) => ({ ...prev, bodyJson: event.target.value }))}
                            spellCheck={false}
                            className="min-h-72 w-full resize-y border-0 bg-white px-4 py-4 font-mono text-[13px] leading-7 text-slate-800 outline-none focus:ring-0"
                            placeholder="{\n  \n}"
                          />
                        </div>
                      )}
                    </div>
                  ) : null}

                  {/* 请求示例 Tab */}
                  {requestConfigTab === 'example' ? (
                    <div>
                      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <span className="text-sm font-black text-slate-700">请求示例</span>
                          <p className="mt-0.5 text-[13px] text-slate-500">
                            {groupedParams.body.length
                              ? '来自接口文档，可直接填入当前请求体。'
                              : '来自接口文档，用于展示路径或查询参数默认值；当前接口没有请求体。'}
                          </p>
                        </div>
                        <div className="flex gap-2">
                          <button onClick={() => requestExampleReplacement('fill')} disabled={isRestoring || isSending} className="inline-flex items-center gap-1.5 rounded-[8px] border border-slate-200 px-3 py-1.5 text-[13px] font-bold text-slate-600 transition hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-60">
                            {isRestoring ? <Loader2 size={13} className="animate-spin" /> : null}{isRestoring ? '正在填充' : '填充示例'}
                          </button>
                          <button onClick={() => copyText(requestExampleText || '{}', '已复制请求示例')} className="rounded-[8px] border border-slate-200 px-3 py-1.5 text-[13px] font-bold text-slate-600 transition hover:text-blue-600">复制示例</button>
                        </div>
                      </div>
                      <div className="overflow-hidden rounded-[8px] border border-slate-100">
                        <MonacoBlock
                          code={requestExampleText || '{}'}
                          language={inferCodeLanguage(requestExampleText || '{}', 'json')}
                          emptyPlaceholder="# 当前接口没有请求示例"
                          minHeight={200}
                          maxHeight={420}
                        />
                      </div>
                    </div>
                  ) : null}

                  {/* 请求预览 Tab */}
                  {requestConfigTab === 'preview' ? (
                    <div className="grid gap-4 xl:grid-cols-2">
                      <div>
                        <div className="mb-2 flex items-center justify-between">
                          <span className="text-sm font-black text-slate-700">请求预览</span>
                          <button onClick={copyCurrentRequest} className="inline-flex items-center gap-1.5 rounded-[6px] px-2.5 py-1.5 text-[12px] font-bold text-slate-500 transition hover:bg-slate-50 hover:text-blue-600"><Copy size={12} />复制</button>
                        </div>
                        <div className="overflow-hidden rounded-[8px] border border-slate-100">
                          <MonacoBlock code={currentRequestPreviewText} language="json" emptyPlaceholder="# 暂无请求预览" minHeight={200} maxHeight={420} />
                        </div>
                      </div>
                      <div>
                        <div className="mb-2 flex items-center justify-between">
                          <span className="text-sm font-black text-slate-700">cURL 命令</span>
                          <button onClick={copyCurrentCurl} className="inline-flex items-center gap-1.5 rounded-[6px] px-2.5 py-1.5 text-[12px] font-bold text-slate-500 transition hover:bg-slate-50 hover:text-blue-600"><Clipboard size={12} />复制</button>
                        </div>
                        <div className="overflow-hidden rounded-[8px] border border-slate-100">
                          <MonacoBlock code={currentCurlText} language="shell" emptyPlaceholder="# 暂无 cURL" minHeight={200} maxHeight={420} />
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>

                {/* ── 响应结果区（同一容器内，border-t 分割）── */}
                <div className="border-t border-slate-100">
                  {/* 响应标题 + 状态 badge */}
                  <div ref={responseSectionRef} className="flex scroll-mt-3 flex-wrap items-center justify-between gap-3 px-5 py-3">
                    <span className="text-sm font-black text-slate-700">响应结果</span>
                    <StatusBadge status={debugStatus.status} tone={debugStatus.tone} label={debugStatus.label} />
                  </div>

                  {/* 响应摘要：行内展示，无卡片 */}
                  <div className="flex flex-wrap gap-x-6 gap-y-1 border-b border-slate-100 bg-slate-50/60 px-5 py-2.5 text-[12px]">
                    {[
                      { label: '状态码', value: debugResult.status ?? '—' },
                      { label: '耗时', value: debugResult.durationMs !== null ? formatMilliseconds(debugResult.durationMs) : '—' },
                      { label: '请求时间', value: debugResult.timestamp || '—' },
                      { label: '响应头', value: `${debugResult.headers.length} 个` },
                    ].map((item) => (
                      <span key={item.label} className="text-slate-500">
                        <span className="font-black text-slate-400">{item.label}：</span>
                        <span className="font-bold text-slate-700">{item.value}</span>
                      </span>
                    ))}
                  </div>

                  {/* 响应 Tab 栏（下划线风格） */}
                  <div className="docs-api-scroll flex gap-0 overflow-x-auto border-b border-slate-100 px-5" role="tablist" aria-label="调试响应视图">
                    {responseTabs.map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        role="tab"
                        id={`response-tab-${tab.id}`}
                        data-tab-id={tab.id}
                        aria-selected={responseTab === tab.id}
                        aria-controls="response-tab-panel"
                        tabIndex={responseTab === tab.id ? 0 : -1}
                        onClick={() => setResponseTab(tab.id)}
                        onKeyDown={(event) => handleTabListKeyDown(event, responseTabs.map((item) => item.id), responseTab, setResponseTab)}
                        className={`shrink-0 border-b-2 px-4 py-2.5 text-[13px] font-bold transition ${
                          responseTab === tab.id ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-800'
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>

                  {/* 响应代码区 Monaco */}
                  <div id="response-tab-panel" role="tabpanel" aria-labelledby={`response-tab-${responseTab}`}>
                    {responseTab === 'headers' ? (
                      <MonacoBlock
                        code={debugResult.headers.length ? debugResult.headers.map(([k, v]) => `${k}: ${v}`).join('\n') : ''}
                        language="shell"
                        emptyPlaceholder="# 暂无响应头"
                        minHeight={200}
                        maxHeight={500}
                      />
                    ) : responseTab === 'request' ? (
                      <MonacoBlock code={requestDetailsText} language={requestCodeLanguage} emptyPlaceholder="# 尚未发送请求" minHeight={200} maxHeight={500} />
                    ) : responseTab === 'curl' ? (
                      <MonacoBlock code={debugResult.curl || currentCurlText} language="shell" emptyPlaceholder="# 暂无 cURL" minHeight={200} maxHeight={500} />
                    ) : responseTab === 'error' ? (
                      <MonacoBlock code={debugResult.error || ''} language={errorCodeLanguage} emptyPlaceholder="# 当前没有错误信息" minHeight={200} maxHeight={500} />
                    ) : (
                      <MonacoBlock code={debugResult.body} language={responseBodyLanguage} emptyPlaceholder="# 尚未收到响应" minHeight={200} maxHeight={500} />
                    )}
                  </div>
                </div>

                <AppDialog
                  open={confirmExecutionOpen}
                  onClose={() => setConfirmExecutionOpen(false)}
                  title="确认执行真实请求"
                  description="该操作会通过后端代理发送到真实服务，不是文档示例。"
                  danger
                  maxWidth="max-w-xl"
                  footer={(
                    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                      <button type="button" onClick={() => setConfirmExecutionOpen(false)} className="inline-flex min-h-10 items-center justify-center rounded-[7px] border border-slate-200 px-4 text-sm font-bold text-slate-700 transition hover:border-blue-200 hover:text-blue-700">取消</button>
                      <button type="button" onClick={() => void sendRequest(true)} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-[7px] bg-rose-600 px-4 text-sm font-black text-white transition hover:bg-rose-700"><Play size={14} />确认执行</button>
                    </div>
                  )}
                >
                  <div className="space-y-4">
                    <div className="flex items-start gap-3 rounded-[8px] border border-rose-100 bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-800">
                      <TriangleAlert size={18} className="mt-0.5 shrink-0" />
                      <p>当前请求可能改变设备状态、模型文件、系统配置或业务数据。请先核对方法、路径和请求参数。</p>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-[88px_minmax(0,1fr)] sm:items-start">
                      <span className="text-xs font-bold text-slate-500">请求方法</span>
                      <span className={`w-fit rounded px-2.5 py-1 text-[11px] font-black ${methodStyles[activeEndpoint.method]}`}>{activeEndpoint.method}</span>
                      <span className="text-xs font-bold text-slate-500">请求路径</span>
                      <code className="break-all rounded-[7px] bg-slate-100 px-3 py-2 text-xs font-bold text-slate-800">{activeEndpoint.path}</code>
                    </div>
                  </div>
                </AppDialog>

                <AppDialog
                  open={Boolean(exampleReplacementAction)}
                  onClose={() => setExampleReplacementAction(null)}
                  title="替换当前请求参数"
                  description="当前参数已经修改，继续操作会用接口示例覆盖这些改动。"
                  maxWidth="max-w-md"
                  footer={(
                    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                      <button type="button" onClick={() => setExampleReplacementAction(null)} className="inline-flex min-h-10 items-center justify-center rounded-[7px] border border-slate-200 px-4 text-sm font-bold text-slate-700 transition hover:border-blue-200 hover:text-blue-700">保留当前参数</button>
                      <button type="button" onClick={() => {
                        const action = exampleReplacementAction
                        setExampleReplacementAction(null)
                        if (action === 'fill') void fillExample()
                        else if (action === 'reset') void resetRequest()
                      }} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-[7px] bg-blue-600 px-4 text-sm font-black text-white transition hover:bg-blue-700"><RefreshCcw size={14} />确认替换</button>
                    </div>
                  )}
                >
                  <div className="flex items-start gap-3 rounded-[8px] border border-amber-100 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800">
                    <TriangleAlert size={18} className="mt-0.5 shrink-0" />
                    <p>路径、查询、请求头和请求体中的当前编辑内容都会被替换。该操作不会发送请求。</p>
                  </div>
                </AppDialog>

                {/* ── 收藏 & 历史（同一容器，border-t 分割）── */}
                <div className="border-t border-slate-100">
                  <div className="flex items-center gap-2 px-5 py-3">
                    <History size={14} className="text-slate-400" />
                    <span className="text-sm font-black text-slate-700">收藏与历史</span>
                  </div>
                  <div className="grid gap-5 px-5 pb-5 md:grid-cols-3">
                  {/* 收藏接口 */}
                  <div>
                    <div className="mb-3 text-[10px] font-black text-slate-400">收藏接口</div>
                    <div className="grid gap-2">
                      {favoriteEndpoints.length ? favoriteEndpoints.slice(0, 6).map(({ ownerModule, endpoint }) => (
                        <button
                          key={`${ownerModule.slug}-${endpoint.slug}`}
                          onClick={() => selectStoredEndpoint(ownerModule.slug, endpoint.slug)}
                          className="min-w-0 rounded-[8px] bg-rose-50 px-3 py-2 text-left text-[12px] font-bold text-rose-700 transition hover:bg-rose-100"
                        >
                          <span className="block truncate">{endpoint.summary}</span>
                          <span className="block truncate text-[10px] text-rose-500">{ownerModule.title} · <span className="font-mono">{endpoint.path}</span></span>
                        </button>
                      )) : renderEmptyState('暂无收藏接口')}
                    </div>
                  </div>

                  {/* 最近调试 */}
                  <div>
                    <div className="mb-3 text-[10px] font-black text-slate-400">最近调试</div>
                    <div className="grid gap-2">
                      {recentEndpoints.length ? recentEndpoints.slice(0, 6).map(({ ownerModule, endpoint }) => (
                        <button
                          key={`${ownerModule.slug}-${endpoint.slug}`}
                          onClick={() => selectStoredEndpoint(ownerModule.slug, endpoint.slug)}
                          className="min-w-0 rounded-[8px] bg-slate-50 px-3 py-2 text-left text-[12px] font-bold text-slate-700 transition hover:bg-blue-50 hover:text-blue-700"
                        >
                          <span className="block truncate">{endpoint.summary}</span>
                          <span className="block truncate text-[10px] text-slate-400">{ownerModule.title} · <span className="font-mono">{endpoint.path}</span></span>
                        </button>
                      )) : renderEmptyState('暂无最近调试')}
                    </div>
                  </div>

                  {/* 调试历史 */}
                  <div>
                    <div className="mb-3 text-[10px] font-black text-slate-400">调试历史</div>
                    {visibleHistory.length ? (
                      <div className="overflow-hidden rounded-[8px] border border-slate-100">
                        {visibleHistory.slice(0, 8).map(({ item, moduleSlug }) => (
                          <button
                            key={`${moduleSlug}-${item.endpointSlug}-${item.createdAt}`}
                            onClick={() => selectStoredEndpoint(moduleSlug, item.endpointSlug)}
                            className="flex w-full items-center justify-between gap-3 border-b border-slate-100 px-3 py-2.5 text-left last:border-b-0 hover:bg-slate-50"
                          >
                            <div className="min-w-0 flex-1">
                              <span className="block truncate text-[12px] font-bold text-slate-700">{item.summary}</span>
                              <span className="block text-[10px] text-slate-400">{item.createdAt}</span>
                            </div>
                            <span className={`shrink-0 rounded-2xl px-2 py-1 text-[10px] font-black ${
                              item.success === true || (item.success === undefined && item.status !== null && item.status < 400)
                                ? 'bg-emerald-50 text-emerald-600'
                                : 'bg-rose-50 text-rose-600'
                            }`}>
                              {item.status ?? '失败'}
                            </span>
                          </button>
                        ))}
                      </div>
                    ) : renderEmptyState('暂无调试历史')}
                  </div>
                </div>
                </div>
              </div>

            </div>
          </main>
        </div>
      </div>
    </div>
  )
}
