'use client'

/**
 * 模型拉取与验证页
 * 承接官方模型库、预检、持久拉取任务、安装后验证和运行状态。
 */

import Link from 'next/link'
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import {
  Activity, ArrowLeft, CheckCircle2, ClipboardCheck, DownloadCloud,
  AlertTriangle, GaugeCircle, Info, ListChecks, Loader2, PlayCircle, RefreshCw, RotateCcw,
  Search, Star, StopCircle, Wifi, WifiOff, X, XCircle,
} from 'lucide-react'
import { AnimatePresence } from 'motion/react'
import { getToken, handleUnauthorized } from '@/lib/auth-storage'
import { useAuth } from '@/lib/hooks/useAuth'
import { UnifiedSelect } from '@/components/ui/UnifiedSelect'
import { AppDrawer } from '@/components/ui/AppDrawer'
import { clearModelCache, modelApi, type ModelDetail } from '@/lib/api/models'
import { ApiError } from '@/lib/api/client'
import { clearSystemOverviewCache } from '@/lib/api/system'
import { InlineToast } from '@/components/ui/InlineToast'
import { Pagination } from '@/components/ui/Pagination'
import { TechnicalId } from '@/components/ui/TechnicalId'
import { formatMilliseconds } from '@/lib/ui/format-duration'
import { businessErrorMessage } from '@/lib/ui/business-error'

interface Model {
  name: string
  model: string
  size: number
  size_display: string
  parameter_size: string
  quantization_level: string
  family: string
  format: string
  modified_at: string
  modified_display: string
  digest: string
}

interface RunningModel {
  name: string
  size_display: string
  size_vram_display: string
}

interface MetricsBar {
  label: string
  value: number
  unit?: '%' | '°C'
}

interface SystemMetrics {
  cpu: { percent: number; count: number; freq_mhz: number | null }
  memory: { total_gb: number; used_gb: number; percent: number }
  disk: { total_gb: number; used_gb: number; percent: number }
  gpus: Array<{ name: string; utilization_percent: number; memory_percent: number; temperature_c: number; memory_used_mb: number; memory_total_mb: number }>
  metrics_bars: MetricsBar[]
}

const TASK_STREAM_IDLE_TIMEOUT_MS = 20_000
const INFERENCE_PROMPT_EXAMPLE = '请用一句话说明当前本地模型推理服务是否可用。'

interface LibraryTag {
  tag: string
  full_name: string
  size: string
  size_bytes: number
  context: string
  input: string
  updated: string
  installed?: boolean | null
}

interface LibraryModel {
  name: string
  desc: string
  tags: LibraryTag[]
  default_tag: string
  family: string
  category: string
  installed: boolean | null
  recommended: boolean
  capabilities: string[]
  parameter_sizes: string[]
}

interface PrecheckResult {
  ok: boolean
  model_name: string
  checks: Array<{
    key: string
    ok: boolean
    message: string
    detail?: { free_bytes?: number; required_bytes?: number; [key: string]: unknown }
  }>
  errors: string[]
  installed?: boolean
  catalog?: { source?: string; last_synced_at?: string | null; tag?: LibraryTag & { base_model?: LibraryModel } }
}

interface PullTask {
  id: number
  model_name: string
  status: 'pending' | 'running' | 'retrying' | 'succeeded' | 'failed' | 'canceled' | 'interrupted'
  attempt: number
  max_attempts: number
  total_bytes: number
  completed_bytes: number
  progress_percent: number
  last_status: string
  error_type: string
  error_message: string
  started_at: string | null
  finished_at: string | null
  updated_at: string | null
}

interface PullTaskPage {
  tasks: PullTask[]
  total: number
  page: number
  size: number
  page_count: number
  summary: {
    total: number
    active: number
    succeeded: number
    failed: number
    canceled: number
  }
}

interface InferenceTestResult {
  success: boolean
  model: string
  prompt: string
  response?: string
  latency_ms?: number
  tested_at: string
  error?: string
}

function formatBytes(b: number) {
  if (!b) return '—'
  if (b >= 1_073_741_824) return `${(b / 1_073_741_824).toFixed(1)} GB`
  if (b >= 1_048_576) return `${(b / 1_048_576).toFixed(0)} MB`
  return `${Math.max(1, Math.round(b / 1024))} KB`
}

function errorMessage(error: unknown, fallback: string) {
  return businessErrorMessage(error, { fallback, service: 'Ollama' })
}

function isPulledModelMissing(
  taskStatus: PullTask['status'],
  modelName: string,
  inventoryLoaded: boolean,
  installedNames: ReadonlySet<string>,
) {
  return taskStatus === 'succeeded' && inventoryLoaded && !installedNames.has(modelName)
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

function formatTaskTime(value?: string | null) {
  if (!value) return '时间未记录'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return '时间未记录'
  return parsed.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function quantizationLabel(value?: string | null) {
  const raw = String(value || '').trim().toUpperCase()
  if (!raw || raw === '—') return '量化规格未提供'
  if (raw === 'F32') return '32 位浮点'
  if (raw === 'F16') return '16 位浮点'
  if (raw === 'BF16') return '16 位脑浮点'
  const quantized = raw.match(/^Q(\d+)(?:_([A-Z0-9_]+))?$/)
  if (!quantized) return '其他量化规格'
  const bits = quantized[1]
  const variant = quantized[2]
  if (!variant || variant === '0') return `${bits} 位标准量化`
  return `${bits} 位 ${variant.replaceAll('_', '-')} 量化`
}

function formatRuntimeTime(value?: string | null, fallback = '时间未取得') {
  if (!value) return fallback
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? '时间未取得' : parsed.toLocaleString('zh-CN')
}

function parameterSizeLabel(value: string) {
  return `参数 ${value.toUpperCase()}`
}

function taskStatusLabel(status: string) {
  const labels: Record<string, string> = {
    pending: '队列中',
    running: '下载中',
    retrying: '重试中',
    succeeded: '已完成',
    failed: '失败',
    canceled: '已取消',
    interrupted: '已中断',
  }
  return labels[status] || '状态待确认'
}

function taskStatusTone(status: string) {
  if (status === 'succeeded') return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
  if (status === 'failed' || status === 'interrupted') return 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300'
  if (status === 'canceled') return 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300'
  if (status === 'pending' || status === 'running' || status === 'retrying') return 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300'
  return 'bg-slate-100 text-slate-600 dark:bg-white/[0.08] dark:text-slate-300'
}

function taskErrorTypeLabel(errorType: string) {
  const labels: Record<string, string> = {
    retryable_network: '可重试网络错误',
    invalid_model: '模型名称或模型库校验失败',
    model_not_found: '模型或版本不存在',
    already_installed: '模型已安装',
    canceled: '用户已取消',
    disk_space: '磁盘空间不足',
    disk_insufficient: '磁盘空间不足',
    ollama_offline: 'Ollama 服务不可达',
    http_5xx: 'Ollama 服务端异常',
    timeout: '拉取超时',
    unknown: '未分类拉取异常',
  }
  return labels[errorType] || '拉取异常'
}

function taskStageLabel(value?: string | null) {
  const raw = String(value || '').trim()
  if (!raw) return '等待任务更新'
  if (/[一-鿿]/.test(raw)) return raw
  const normalized = raw.toLowerCase()
  if (normalized === 'success') return '拉取完成'
  if (normalized.includes('pulling manifest')) return '正在获取模型清单'
  if (normalized.startsWith('pulling ')) return '正在下载模型文件'
  if (normalized.includes('verifying sha256')) return '正在校验模型文件'
  if (normalized.includes('writing manifest')) return '正在写入模型清单'
  if (normalized.includes('removing any unused layers')) return '正在清理未使用模型层'
  return '任务阶段待确认'
}

function taskErrorDescription(errorType: string, message?: string | null) {
  const raw = String(message || '').trim()
  const descriptions: Record<string, string> = {
    retryable_network: '网络连接中断，平台会按重试策略继续尝试；也可检查代理和 Ollama 服务状态。',
    invalid_model: '模型名称、版本或请求参数未通过 Ollama 校验，请核对模型目录与标签。',
    model_not_found: 'Ollama 模型库中未找到该模型或版本，请核对名称和标签。',
    already_installed: '本机已经安装该模型，无需重复创建拉取任务。',
    canceled: '任务已由用户取消；已下载的模型层可能继续保留并用于下次续传。',
    disk_space: '模型存储目录可用空间不足，请清理磁盘后重试。',
    disk_insufficient: '模型存储目录可用空间不足，请清理磁盘后重试。',
    ollama_offline: '当前无法连接 Ollama，请检查服务地址和运行状态。',
    http_5xx: 'Ollama 服务返回内部错误，请稍后重试并检查服务日志。',
    timeout: '拉取等待超时，请检查网络、代理和 Ollama 下载状态。',
  }
  if (descriptions[errorType]) return descriptions[errorType]
  return raw && /[\u4e00-\u9fff]/.test(raw)
    ? raw
    : '拉取任务返回未分类错误，请展开技术错误核对原始信息。'
}

function InfoPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex h-10 min-w-0 flex-col justify-center rounded-[8px] border border-slate-200 bg-white px-3 dark:border-white/[0.08] dark:bg-slate-700">
      <p className="text-xs font-semibold leading-none text-slate-400">{label}</p>
      <p className="mt-1 truncate text-xs font-black leading-none text-slate-800 dark:text-white" title={value}>{value}</p>
    </div>
  )
}

function TagPill({ children, tone = 'neutral', title }: { children: React.ReactNode; tone?: 'neutral' | 'muted' | 'blue' | 'emerald'; title?: string }) {
  const tones = {
    neutral: 'bg-white text-slate-500 dark:bg-slate-700 dark:text-slate-300',
    muted: 'bg-slate-200/70 text-slate-500 dark:bg-white/[0.08] dark:text-slate-300',
    blue: 'bg-blue-100 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300',
    emerald: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300',
  }
  return (
    <span title={title} className={`inline-flex h-6 shrink-0 items-center justify-center whitespace-nowrap rounded-full px-2 text-xs font-black leading-none ${tones[tone]}`}>
      {children}
    </span>
  )
}

function capabilityLabel(capability: string) {
  const labels: Record<string, string> = {
    tools: '工具调用',
    thinking: '推理思考',
    vision: '图像理解',
    embedding: '文本向量化',
    cloud: '云端模型',
    audio: '音频理解',
    completion: '文本生成',
  }
  return labels[capability.toLowerCase()] || '其他模型能力'
}

function categoryLabel(category: string) {
  const normalized = String(category || '').trim()
  const labels: Record<string, string> = {
    embedding: '向量模型',
    completion: '文本生成模型',
    chat: '对话模型',
    vision: '多模态模型',
    multimodal: '多模态模型',
    reasoning: '推理模型',
    code: '代码模型',
  }
  if (labels[normalized.toLowerCase()]) return labels[normalized.toLowerCase()]
  return /[\u3400-\u9fff]/.test(normalized) ? normalized : '其他模型'
}

function inputTypeLabel(input?: string) {
  const text = String(input || '').toLowerCase()
  if (text.includes('image') || text.includes('vision')) return '文本与图像输入'
  if (text.includes('audio')) return '文本与音频输入'
  if (text.includes('embedding')) return '文本向量输入'
  return '文本输入'
}

function updatedLabel(updated?: string) {
  const value = String(updated || '').trim()
  if (!value) return '更新时间未知'
  const match = value.match(/^(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago$/i)
  if (!match) return `更新于 ${value}`
  const units: Record<string, string> = {
    minute: '分钟前',
    hour: '小时前',
    day: '天前',
    week: '周前',
    month: '个月前',
    year: '年前',
  }
  return `${match[1]} ${units[match[2].toLowerCase()]}`
}

function modelPurposeDescription(model: LibraryModel) {
  const capabilities = model.capabilities || []
  if (capabilities.includes('embedding')) return '面向知识库检索和语义匹配的文本向量模型。'
  if (capabilities.includes('vision')) return '支持图像理解的多模态模型，适合图文问答与视觉分析。'
  if (model.category === '代码') return '面向代码生成、补全和开发辅助的开源模型。'
  if (model.category === '推理' || capabilities.includes('thinking')) return '面向复杂问题、逻辑分析和推理任务的开源模型。'
  if (capabilities.includes('tools')) return '支持文本生成和工具调用，适合智能体编排与中文对话。'
  return '适合本地文本生成和多轮对话的开源大语言模型。'
}

function DetailDrawer({ model, onClose }: { model: ModelDetail | null; onClose: () => void }) {
  if (!model) return null

  const formatExactNumber = (value: number) => new Intl.NumberFormat('zh-CN').format(value)

  return (
    <AppDrawer
      title="模型详情"
      description={model.name}
      onClose={onClose}
      widthClassName="max-w-lg"
      zIndexClassName="z-[120]"
      bodyClassName="p-8 sm:p-8"
    >
        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {[
            { label: '参数量', value: model.details?.parameter_size },
            { label: '量化方式', value: quantizationLabel(model.details?.quantization_level) },
            { label: '模型格式', value: model.details?.format?.toUpperCase() },
            { label: '架构', value: model.architecture?.architecture },
            { label: '上下文长度', value: model.architecture?.context_length ? `${formatExactNumber(model.architecture.context_length)} 个词元` : null },
            { label: '模型家族', value: model.details?.family },
          ].filter(item => item.value).map(item => (
            <div key={item.label} className="rounded-[8px] border border-slate-200 bg-slate-50 p-4 dark:border-white/[0.08] dark:bg-white/[0.04]">
              <p className="text-xs font-semibold text-slate-400 dark:text-slate-500">{item.label}</p>
              <p className="mt-1 break-words text-sm font-black text-slate-900 dark:text-white">{item.value}</p>
            </div>
          ))}
        </div>
        {model.details?.quantization_level && model.details.quantization_level !== '—' ? (
          <TechnicalId value={model.details.quantization_level} label="原始量化规格" compact className="mt-3" />
        ) : null}
        {model.capabilities?.length > 0 && (
          <div className="mt-6">
            <p className="mb-2 text-xs font-semibold text-slate-400 dark:text-slate-500">模型能力</p>
            <div className="flex flex-wrap gap-2">
              {model.capabilities.map((cap: string) => (
                <span key={cap} className="rounded-[6px] bg-blue-100 px-3 py-1.5 text-xs font-bold text-blue-600 dark:bg-blue-500/15 dark:text-blue-300">{capabilityLabel(cap)}</span>
              ))}
            </div>
          </div>
        )}
        {model.system && (
          <div className="mt-6">
            <p className="mb-2 text-xs font-semibold text-slate-400 dark:text-slate-500">系统提示词</p>
            <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-[8px] border border-slate-200 bg-slate-50 p-4 text-xs leading-relaxed text-slate-700 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-slate-300">{model.system}</pre>
          </div>
        )}
    </AppDrawer>
  )
}

function sourceLabel(source?: string) {
  if (source === 'fresh') return '官方实时'
  if (source === 'cache') return '官方缓存'
  if (source === 'seed') return '内置参考'
  return '来源未取得'
}

function catalogHeading(source?: string) {
  if (!source) return '模型目录状态待确认'
  if (source === 'seed') return '内置参考模型目录'
  if (source === 'cache') return '官方模型库缓存'
  return 'Ollama 官方模型库'
}

function catalogDescription(source?: string) {
  if (!source) return '正在读取目录来源、更新时间和可用筛选条件。'
  if (source === 'seed') return '当前内容用于离线选型参考，不代表 Ollama 官网实时目录；拉取前仍会执行真实预检。'
  if (source === 'cache') return '当前展示最近一次成功同步的官方目录快照，更新时间以“最近同步”为准。'
  return '当前展示 Ollama 官方模型目录；版本拉取前仍会执行本机服务与磁盘预检。'
}

const LIBRARY_PAGE_SIZES = [8, 16, 32]
const TASK_PAGE_SIZES = [6, 12, 24]

function validPageSize(value: string | null, options: number[], fallback: number) {
  const parsed = Number(value)
  return options.includes(parsed) ? parsed : fallback
}

function libraryViewKey(query: string, category: string, capability: string, installed: string, recommended: boolean, page: number, size: number) {
  return JSON.stringify({ query: query.trim(), category, capability, installed, recommended, page, size })
}

function ModelPullsContent() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { isAdmin, loading: authLoading } = useAuth()
  const [library, setLibrary] = useState<LibraryModel[]>([])
  const [catalogMeta, setCatalogMeta] = useState<{ source?: string; last_synced_at?: string | null; error?: string }>({})
  const [loadingLib, setLoadingLib] = useState(true)
  const [libraryError, setLibraryError] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [query, setQuery] = useState(() => searchParams.get('catalogQ') || '')
  const [category, setCategory] = useState(() => searchParams.get('category') || '全部')
  const [capability, setCapability] = useState(() => searchParams.get('capability') || '全部')
  const [installedFilter, setInstalledFilter] = useState(() => {
    const value = searchParams.get('installed')
    return value === 'yes' ? '已安装' : value === 'no' ? '未安装' : '全部'
  })
  const [recommendedOnly, setRecommendedOnly] = useState(() => searchParams.get('recommended') === '1')
  const [libraryPage, setLibraryPage] = useState(() => {
    const value = Number(searchParams.get('catalogPage') || 1)
    return Number.isInteger(value) && value > 0 ? value : 1
  })
  const [libraryPageSize, setLibraryPageSize] = useState(() => validPageSize(searchParams.get('catalogSize'), LIBRARY_PAGE_SIZES, 8))
  const [libraryTotal, setLibraryTotal] = useState(0)
  const [libraryLoaded, setLibraryLoaded] = useState(false)
  const [loadedLibraryViewKey, setLoadedLibraryViewKey] = useState('')
  const [loadedLibraryPage, setLoadedLibraryPage] = useState(1)
  const [loadedLibraryPageSize, setLoadedLibraryPageSize] = useState(8)
  const [debouncedLibraryQuery, setDebouncedLibraryQuery] = useState(() => (searchParams.get('catalogQ') || '').trim())
  const [librarySearchSettled, setLibrarySearchSettled] = useState(true)
  const [libraryCategories, setLibraryCategories] = useState<string[]>([])
  const [libraryCapabilities, setLibraryCapabilities] = useState<string[]>([])
  const [selectedTags, setSelectedTags] = useState<Record<string, string>>({})
  const [modelName, setModelName] = useState('')
  const [precheck, setPrecheck] = useState<PrecheckResult | null>(null)
  const [prechecking, setPrechecking] = useState(false)
  const [creating, setCreating] = useState(false)
  const [tasks, setTasks] = useState<PullTask[]>([])
  const [taskPage, setTaskPage] = useState(() => {
    const value = Number(searchParams.get('taskPage') || 1)
    return Number.isInteger(value) && value > 0 ? value : 1
  })
  const [taskPageSize, setTaskPageSize] = useState(() => validPageSize(searchParams.get('taskSize'), TASK_PAGE_SIZES, 6))
  const [taskTotal, setTaskTotal] = useState(0)
  const [taskSummary, setTaskSummary] = useState<PullTaskPage['summary'] | null>(null)
  const [tasksLoaded, setTasksLoaded] = useState(false)
  const [loadedTaskViewKey, setLoadedTaskViewKey] = useState('')
  const [loadedTaskPage, setLoadedTaskPage] = useState(1)
  const [loadedTaskPageSize, setLoadedTaskPageSize] = useState(6)
  const [taskStatus, setTaskStatus] = useState(() => {
    const value = searchParams.get('taskStatus') || ''
    return ['pending', 'running', 'retrying', 'succeeded', 'failed', 'interrupted', 'canceled'].includes(value) ? value : ''
  })
  const [taskQuery, setTaskQuery] = useState(() => searchParams.get('taskQ') || '')
  const [debouncedTaskQuery, setDebouncedTaskQuery] = useState(() => (searchParams.get('taskQ') || '').trim())
  const [taskSearchSettled, setTaskSearchSettled] = useState(true)
  const [tasksLoading, setTasksLoading] = useState(true)
  const [tasksError, setTasksError] = useState('')
  const [taskStreamErrors, setTaskStreamErrors] = useState<Record<number, string>>({})
  const [pageVisible, setPageVisible] = useState(true)
  const [models, setModels] = useState<Model[]>([])
  const [installedModelTotal, setInstalledModelTotal] = useState<number | null>(null)
  const [installedInventoryLoaded, setInstalledInventoryLoaded] = useState(false)
  const [running, setRunning] = useState<RunningModel[]>([])
  const [currentModel, setCurrentModel] = useState('')
  const [sysMetrics, setSysMetrics] = useState<SystemMetrics | null>(null)
  const [ollamaOnline, setOllamaOnline] = useState<boolean | null>(null)
  const [runtimeLoading, setRuntimeLoading] = useState(true)
  const [runtimeError, setRuntimeError] = useState('')
  const [runtimeUpdatedAt, setRuntimeUpdatedAt] = useState<string | null>(null)
  const [testModel, setTestModel] = useState('')
  const [testPrompt, setTestPrompt] = useState('')
  const [testing, setTesting] = useState(false)
  const [testingModel, setTestingModel] = useState('')
  const [testResult, setTestResult] = useState<InferenceTestResult | null>(null)
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'warning' | 'error' } | null>(null)
  const [detailModel, setDetailModel] = useState<ModelDetail | null>(null)
  const [detailLoadingName, setDetailLoadingName] = useState('')
  const detailTriggerRef = useRef<HTMLButtonElement | null>(null)
  const detailAbortRef = useRef<AbortController | null>(null)
  const [settingCurrentName, setSettingCurrentName] = useState('')
  const [pendingTaskActions, setPendingTaskActions] = useState<Record<number, 'retry' | 'cancel'>>({})
  const [error, setError] = useState('')
  const subscribedTasksRef = useRef<Set<number>>(new Set())
  const taskRequestSequenceRef = useRef(0)
  const libraryRequestSequenceRef = useRef(0)
  const runtimeRequestSequenceRef = useRef(0)
  const precheckRequestSequenceRef = useRef(0)
  const detailRequestSequenceRef = useRef(0)
  const inferenceRequestSequenceRef = useRef(0)
  const currentRequestSequenceRef = useRef(0)
  const createRequestSequenceRef = useRef(0)
  const taskActionSequenceRef = useRef<Map<number, number>>(new Map())
  const taskEventControllersRef = useRef<Map<number, AbortController>>(new Map())
  const taskStreamRetryAtRef = useRef<Map<number, number>>(new Map())
  const taskActionInFlightRef = useRef<Set<number>>(new Set())
  const createInFlightRef = useRef(false)
  const syncInFlightRef = useRef(false)
  const precheckInFlightRef = useRef<{ key: string; promise: Promise<PrecheckResult | null> } | null>(null)
  const detailInFlightRef = useRef<Set<string>>(new Set())
  const currentInFlightRef = useRef('')
  const inferenceInFlightRef = useRef(false)
  const inferenceControllerRef = useRef<AbortController | null>(null)
  const inferenceReconcileRef = useRef(0)
  const inferenceReconcileTimerRef = useRef<number | null>(null)
  const createAbortRef = useRef<AbortController | null>(null)
  const currentAbortRef = useRef<AbortController | null>(null)
  const taskActionControllersRef = useRef<Map<number, AbortController>>(new Map())
  const runtimeControllerRef = useRef<AbortController | null>(null)
  const runtimeUpdatedAtRef = useRef(0)
  const libraryControllerRef = useRef<AbortController | null>(null)
  const taskListControllerRef = useRef<AbortController | null>(null)
  const mutationReconcileRef = useRef(0)
  const mutationReconcileTimerRef = useRef<number | null>(null)
  const librarySearchSettledRef = useRef(true)
  const taskSearchSettledRef = useRef(true)
  const writtenSearchRef = useRef(searchParams.toString())
  const taskViewKey = `${debouncedTaskQuery}:${taskStatus}:${taskPage}:${taskPageSize}`
  const taskViewKeyRef = useRef(taskViewKey)
  const runtimeErrorRef = useRef(runtimeError)
  const libraryErrorRef = useRef(libraryError)
  const tasksErrorRef = useRef(tasksError)
  const taskStreamErrorsRef = useRef(taskStreamErrors)
  const hasActiveTasksRef = useRef(false)
  taskViewKeyRef.current = taskViewKey
  runtimeErrorRef.current = runtimeError
  libraryErrorRef.current = libraryError
  tasksErrorRef.current = tasksError
  taskStreamErrorsRef.current = taskStreamErrors
  hasActiveTasksRef.current = (taskSummary?.active ?? 0) > 0
    || tasks.some(task => ['pending', 'running', 'retrying'].includes(task.status))

  const loadRuntime = useCallback(async (force = false) => {
    runtimeControllerRef.current?.abort()
    const controller = new AbortController()
    runtimeControllerRef.current = controller
    const requestSequence = ++runtimeRequestSequenceRef.current
    setRuntimeLoading(true)
    const [versionResult, modelsResult, statusResult, currentResult, metricsResult] = await Promise.allSettled([
      modelApi.version(force, controller.signal),
      modelApi.listAllInstalled(force, controller.signal),
      modelApi.running(force, controller.signal),
      modelApi.current(force, controller.signal),
      modelApi.metrics(force, controller.signal),
    ])
    if (requestSequence !== runtimeRequestSequenceRef.current) return

    const errors: string[] = []
    if (versionResult.status === 'fulfilled') {
      setOllamaOnline(versionResult.value.online)
      if (!versionResult.value.online) errors.push(errorMessage(versionResult.value.error, 'Ollama 服务当前不可达'))
    } else if (!isAbortError(versionResult.reason)) {
      setOllamaOnline(false)
      errors.push(errorMessage(versionResult.reason, 'Ollama 连接检测失败'))
    }
    if (modelsResult.status === 'fulfilled') {
      const installedModels = modelsResult.value.models || []
      setModels(installedModels)
      setInstalledModelTotal(modelsResult.value.summary?.total ?? modelsResult.value.total ?? installedModels.length)
      setInstalledInventoryLoaded(true)
    } else if (!isAbortError(modelsResult.reason)) {
      errors.push(errorMessage(modelsResult.reason, '已安装模型读取失败'))
    }
    if (statusResult.status === 'fulfilled') setRunning(statusResult.value.running || [])
    else if (!isAbortError(statusResult.reason)) errors.push(errorMessage(statusResult.reason, '运行中模型读取失败'))
    if (currentResult.status === 'fulfilled') {
      const current = currentResult.value.current_model || ''
      setCurrentModel(current)
      setTestModel(previous => previous || current)
    } else if (!isAbortError(currentResult.reason)) {
      errors.push(errorMessage(currentResult.reason, '当前模型读取失败'))
    }
    if (metricsResult.status === 'fulfilled') setSysMetrics(metricsResult.value)
    else if (!isAbortError(metricsResult.reason)) errors.push(errorMessage(metricsResult.reason, '系统资源读取失败'))
    if ([versionResult, modelsResult, statusResult, currentResult, metricsResult].some(result => result.status === 'fulfilled')) {
      const updatedAt = Date.now()
      runtimeUpdatedAtRef.current = updatedAt
      setRuntimeUpdatedAt(new Date(updatedAt).toISOString())
    }
    setRuntimeError([...new Set(errors)].join('；'))
    if (runtimeControllerRef.current === controller) runtimeControllerRef.current = null
    if (requestSequence === runtimeRequestSequenceRef.current) setRuntimeLoading(false)
  }, [])

  const loadLibrary = useCallback(async (sync = false) => {
    if (sync && !isAdmin) {
      setToast({ message: '同步官方模型库需要管理员权限', type: 'error' })
      return
    }
    if (!librarySearchSettledRef.current) return
    if (sync && syncInFlightRef.current) return
    if (sync) syncInFlightRef.current = true
    libraryControllerRef.current?.abort()
    const controller = new AbortController()
    libraryControllerRef.current = controller
    const requestSequence = ++libraryRequestSequenceRef.current
    try {
      if (sync) setSyncing(true)
      else setLoadingLib(true)
      const syncResult = sync ? await modelApi.syncLibrary(controller.signal) : null
      const res = await modelApi.library({
        page: libraryPage,
        size: libraryPageSize,
        keyword: debouncedLibraryQuery || undefined,
        category: category !== '全部' ? category : undefined,
        capability: capability !== '全部' ? capability : undefined,
        installed: installedFilter !== '全部' ? installedFilter === '已安装' : undefined,
        recommended: recommendedOnly || undefined,
      }, sync, controller.signal)
      if (requestSequence !== libraryRequestSequenceRef.current) return
      const nextLibrary = res.models || []
      const nextMeta = {
        source: res.source,
        last_synced_at: res.last_synced_at,
        error: res.error,
      }
      const tags: Record<string, string> = {}
      nextLibrary.forEach((m: LibraryModel) => { tags[m.name] = m.default_tag })
      setLibrary(nextLibrary)
      setLibraryTotal(res.total || 0)
      setLibraryPage(res.page || libraryPage)
      const responsePageSize = validPageSize(String(res.size || ''), LIBRARY_PAGE_SIZES, libraryPageSize)
      setLibraryPageSize(responsePageSize)
      setLibraryLoaded(true)
      setLoadedLibraryPage(res.page || libraryPage)
      setLoadedLibraryPageSize(responsePageSize)
      setLoadedLibraryViewKey(libraryViewKey(
        debouncedLibraryQuery,
        category,
        capability,
        installedFilter,
        recommendedOnly,
        res.page || libraryPage,
        responsePageSize,
      ))
      setLibraryCategories(res.available_filters?.categories || [])
      setLibraryCapabilities(res.available_filters?.capabilities || [])
      if (typeof res.ollama_online === 'boolean') setOllamaOnline(res.ollama_online)
      setCatalogMeta(nextMeta)
      setSelectedTags(tags)
      setLibraryError('')
      setError('')
      if (sync && syncResult) {
        const fallback = Boolean(syncResult.error) || syncResult.source !== 'fresh'
        setToast({
          message: fallback
            ? `官方同步失败，已保留${sourceLabel(syncResult.source)}`
            : '官方模型库同步完成',
          type: fallback ? 'warning' : 'success',
        })
      }
    } catch (caught) {
      if (requestSequence !== libraryRequestSequenceRef.current || controller.signal.aborted) return
      setLibraryError(errorMessage(caught, '模型目录读取失败'))
    } finally {
      if (sync) {
        syncInFlightRef.current = false
        setSyncing(false)
      }
      if (libraryControllerRef.current === controller) libraryControllerRef.current = null
      if (requestSequence === libraryRequestSequenceRef.current) setLoadingLib(false)
    }
  }, [capability, category, debouncedLibraryQuery, installedFilter, isAdmin, libraryPage, libraryPageSize, recommendedOnly])

  const loadTasks = useCallback(async (force = false, requestedPage = taskPage) => {
    if (!taskSearchSettledRef.current) return
    taskListControllerRef.current?.abort()
    const controller = new AbortController()
    taskListControllerRef.current = controller
    const requestSequence = ++taskRequestSequenceRef.current
    try {
      setTasksLoading(true)
      const res = await modelApi.pullTasks({
        page: requestedPage,
        size: taskPageSize,
        status: taskStatus || undefined,
        model_name: debouncedTaskQuery || undefined,
      }, force, controller.signal)
      if (requestSequence !== taskRequestSequenceRef.current) return
      setTasks(res.tasks || [])
      setTaskTotal(res.total || 0)
      setTaskPage(res.page || requestedPage)
      const responsePageSize = validPageSize(String(res.size || ''), TASK_PAGE_SIZES, taskPageSize)
      setTaskPageSize(responsePageSize)
      setTaskSummary(res.summary || null)
      setTasksLoaded(true)
      setLoadedTaskViewKey(`${debouncedTaskQuery}:${taskStatus}:${res.page || requestedPage}:${responsePageSize}`)
      setLoadedTaskPage(res.page || requestedPage)
      setLoadedTaskPageSize(responsePageSize)
      setTasksError('')
    } catch (caught) {
      if (requestSequence !== taskRequestSequenceRef.current || controller.signal.aborted) return
      setTasksError(errorMessage(caught, '拉取任务读取失败，当前保留上次成功数据'))
    } finally {
      if (requestSequence !== taskRequestSequenceRef.current) return
      if (taskListControllerRef.current === controller) taskListControllerRef.current = null
      setTasksLoading(false)
    }
  }, [debouncedTaskQuery, taskPage, taskPageSize, taskStatus])

  useEffect(() => {
    void loadRuntime()
  }, [loadRuntime])

  useEffect(() => {
    let timer: number | null = null

    const stopRefresh = () => {
      if (timer === null) return
      window.clearInterval(timer)
      timer = null
    }
    const refreshIfStale = () => {
      if (runtimeControllerRef.current || Date.now() - runtimeUpdatedAtRef.current < 60_000) return
      void loadRuntime(false)
    }
    const startRefresh = () => {
      stopRefresh()
      if (document.hidden) return
      refreshIfStale()
      timer = window.setInterval(refreshIfStale, 60_000)
    }
    const handleVisibilityChange = () => {
      if (document.hidden) stopRefresh()
      else startRefresh()
    }

    const initialTimer = window.setTimeout(startRefresh, 0)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.clearTimeout(initialTimer)
      stopRefresh()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [loadRuntime])

  useEffect(() => () => {
    runtimeRequestSequenceRef.current += 1
    libraryRequestSequenceRef.current += 1
    taskRequestSequenceRef.current += 1
    precheckRequestSequenceRef.current += 1
    detailRequestSequenceRef.current += 1
    inferenceRequestSequenceRef.current += 1
    currentRequestSequenceRef.current += 1
    createRequestSequenceRef.current += 1
    mutationReconcileRef.current += 1
    inferenceReconcileRef.current += 1
    taskActionSequenceRef.current.clear()
    taskActionInFlightRef.current.clear()
    if (mutationReconcileTimerRef.current !== null) window.clearTimeout(mutationReconcileTimerRef.current)
    mutationReconcileTimerRef.current = null
    if (inferenceReconcileTimerRef.current !== null) window.clearTimeout(inferenceReconcileTimerRef.current)
    inferenceReconcileTimerRef.current = null
    inferenceControllerRef.current?.abort()
    inferenceControllerRef.current = null
    createAbortRef.current?.abort()
    createAbortRef.current = null
    currentAbortRef.current?.abort()
    currentAbortRef.current = null
    detailAbortRef.current?.abort()
    detailAbortRef.current = null
    taskActionControllersRef.current.forEach(controller => controller.abort())
    taskActionControllersRef.current.clear()
    runtimeControllerRef.current?.abort()
    runtimeControllerRef.current = null
    libraryControllerRef.current?.abort()
    libraryControllerRef.current = null
    taskListControllerRef.current?.abort()
    taskListControllerRef.current = null
    taskEventControllersRef.current.forEach(controller => controller.abort())
    taskEventControllersRef.current.clear()
    taskStreamRetryAtRef.current.clear()
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const nextQuery = query.trim()
      if (nextQuery !== debouncedLibraryQuery) {
        setDebouncedLibraryQuery(nextQuery)
        setLibraryPage(1)
      }
      librarySearchSettledRef.current = true
      setLibrarySearchSettled(true)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [debouncedLibraryQuery, query])

  useEffect(() => {
    if (!librarySearchSettled || query.trim() !== debouncedLibraryQuery) return
    void loadLibrary()
  }, [debouncedLibraryQuery, librarySearchSettled, loadLibrary, query])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const nextQuery = taskQuery.trim()
      if (nextQuery !== debouncedTaskQuery) {
        setDebouncedTaskQuery(nextQuery)
        setTaskPage(1)
      }
      taskSearchSettledRef.current = true
      setTaskSearchSettled(true)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [debouncedTaskQuery, taskQuery])

  useEffect(() => {
    if (pathname !== '/models/pulls') return
    const url = new URL(window.location.href)
    const values: Record<string, string> = {
      catalogQ: query.trim(),
      category: category === '全部' ? '' : category,
      capability: capability === '全部' ? '' : capability,
      installed: installedFilter === '已安装' ? 'yes' : installedFilter === '未安装' ? 'no' : '',
      recommended: recommendedOnly ? '1' : '',
      catalogPage: libraryPage === 1 ? '' : String(libraryPage),
      catalogSize: libraryPageSize === 8 ? '' : String(libraryPageSize),
      taskQ: taskQuery.trim(),
      taskStatus,
      taskPage: taskPage === 1 ? '' : String(taskPage),
      taskSize: taskPageSize === 6 ? '' : String(taskPageSize),
    }
    Object.entries(values).forEach(([key, value]) => {
      if (value) url.searchParams.set(key, value)
      else url.searchParams.delete(key)
    })
    const nextSearch = url.searchParams.toString()
    writtenSearchRef.current = nextSearch
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }, [capability, category, installedFilter, libraryPage, libraryPageSize, pathname, query, recommendedOnly, taskPage, taskPageSize, taskQuery, taskStatus])

  useEffect(() => {
    if (pathname !== '/models/pulls') return
    const nextSearch = searchParams.toString()
    if (nextSearch === writtenSearchRef.current) return
    writtenSearchRef.current = nextSearch
    const nextCatalogQuery = searchParams.get('catalogQ') || ''
    const nextTaskQuery = searchParams.get('taskQ') || ''
    const rawInstalled = searchParams.get('installed')
    const rawTaskStatus = searchParams.get('taskStatus') || ''
    const rawCatalogPage = Number(searchParams.get('catalogPage') || 1)
    const rawTaskPage = Number(searchParams.get('taskPage') || 1)
    invalidateLibraryView()
    invalidateTaskView()
    setQuery(nextCatalogQuery)
    setDebouncedLibraryQuery(nextCatalogQuery.trim())
    librarySearchSettledRef.current = true
    setLibrarySearchSettled(true)
    setCategory(searchParams.get('category') || '全部')
    setCapability(searchParams.get('capability') || '全部')
    setInstalledFilter(rawInstalled === 'yes' ? '已安装' : rawInstalled === 'no' ? '未安装' : '全部')
    setRecommendedOnly(searchParams.get('recommended') === '1')
    setLibraryPage(Number.isInteger(rawCatalogPage) && rawCatalogPage > 0 ? rawCatalogPage : 1)
    setLibraryPageSize(validPageSize(searchParams.get('catalogSize'), LIBRARY_PAGE_SIZES, 8))
    setTaskQuery(nextTaskQuery)
    setDebouncedTaskQuery(nextTaskQuery.trim())
    taskSearchSettledRef.current = true
    setTaskSearchSettled(true)
    setTaskStatus(['pending', 'running', 'retrying', 'succeeded', 'failed', 'interrupted', 'canceled'].includes(rawTaskStatus) ? rawTaskStatus : '')
    setTaskPage(Number.isInteger(rawTaskPage) && rawTaskPage > 0 ? rawTaskPage : 1)
    setTaskPageSize(validPageSize(searchParams.get('taskSize'), TASK_PAGE_SIZES, 6))
  }, [pathname, searchParams])

  useEffect(() => {
    if (!taskSearchSettled || taskQuery.trim() !== debouncedTaskQuery) return
    void loadTasks()
  }, [debouncedTaskQuery, loadTasks, taskQuery, taskSearchSettled])

  const invalidateLibraryView = () => {
    libraryControllerRef.current?.abort()
    libraryControllerRef.current = null
    libraryRequestSequenceRef.current += 1
    setError('')
    setLibraryError('')
    setLoadingLib(true)
  }

  const invalidateTaskView = () => {
    taskListControllerRef.current?.abort()
    taskListControllerRef.current = null
    taskRequestSequenceRef.current += 1
    taskEventControllersRef.current.forEach(controller => controller.abort())
    taskEventControllersRef.current.clear()
    taskStreamRetryAtRef.current.clear()
    subscribedTasksRef.current.clear()
    setTasksError('')
    setTaskStreamErrors({})
    setTasksLoading(true)
  }

  useEffect(() => {
    if (!libraryLoaded || loadingLib) return
    const categoryInvalid = category !== '全部' && !libraryCategories.includes(category)
    const capabilityInvalid = capability !== '全部' && !libraryCapabilities.includes(capability)
    if (!categoryInvalid && !capabilityInvalid) return

    invalidateLibraryView()
    if (categoryInvalid) setCategory('全部')
    if (capabilityInvalid) setCapability('全部')
    setLibraryPage(1)
    setToast({ message: '模型目录已更新，失效的筛选条件已恢复为全部', type: 'warning' })
  }, [capability, category, libraryCapabilities, libraryCategories, libraryLoaded, loadingLib])

  const mergeTask = useCallback((task: PullTask, insert = false) => {
    setTasks(prev => {
      const exists = prev.some(item => item.id === task.id)
      const matchesStatus = !taskStatus || task.status === taskStatus
      const matchesQuery = !debouncedTaskQuery
        || task.model_name.toLowerCase().includes(debouncedTaskQuery.toLowerCase())
      if (!matchesStatus || !matchesQuery) {
        return exists ? prev.filter(item => item.id !== task.id) : prev
      }
      if (!exists && !insert) return prev
      const next = exists ? prev.map(item => item.id === task.id ? task : item) : [task, ...prev]
      return next.sort((a, b) => b.id - a.id).slice(0, taskPageSize)
    })
  }, [debouncedTaskQuery, taskPageSize, taskStatus])

  const subscribeTask = useCallback(async (taskId: number) => {
    if (subscribedTasksRef.current.has(taskId)) return
    if ((taskStreamRetryAtRef.current.get(taskId) || 0) > Date.now()) return
    subscribedTasksRef.current.add(taskId)
    const controller = new AbortController()
    taskEventControllersRef.current.set(taskId, controller)
    let streamTimedOut = false
    let idleTimeoutId: number | null = null
    const armIdleTimeout = () => {
      if (idleTimeoutId !== null) window.clearTimeout(idleTimeoutId)
      idleTimeoutId = window.setTimeout(() => {
        streamTimedOut = true
        controller.abort()
      }, TASK_STREAM_IDLE_TIMEOUT_MS)
    }
    try {
      armIdleTimeout()
      const token = getToken()
      const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || '/api'
      const response = await fetch(`${baseUrl}/models/pull-tasks/${taskId}/events`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: controller.signal,
      })
      if (response.status === 401) {
        handleUnauthorized()
        throw new Error('登录已过期，正在返回登录页')
      }
      if (!response.ok) throw new Error(`任务事件订阅失败：HTTP ${response.status}`)
      const reader = response.body?.getReader()
      if (!reader) throw new Error('实时进度连接未返回可读取的数据流')
      const decoder = new TextDecoder()
      let buffer = ''
      let terminalEventReceived = false
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        armIdleTimeout()
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop() || ''
        for (const part of parts) {
          const line = part.split('\n').find(item => item.startsWith('data: '))
          if (!line) continue
          const task = JSON.parse(line.slice(6)) as PullTask
          setTaskStreamErrors(current => {
            if (!current[taskId]) return current
            const next = { ...current }
            delete next[taskId]
            return next
          })
          taskStreamRetryAtRef.current.delete(taskId)
          mergeTask(task)
          if (['succeeded', 'failed', 'canceled', 'interrupted'].includes(task.status)) {
            terminalEventReceived = true
            clearModelCache()
            if (task.status === 'succeeded') clearSystemOverviewCache()
            await loadRuntime()
            await Promise.all([loadTasks(true), loadLibrary(false)])
          }
        }
      }
      if (!terminalEventReceived && !controller.signal.aborted) {
        throw new Error('实时进度连接提前结束')
      }
    } catch (caught) {
      if (!controller.signal.aborted || streamTimedOut) {
        taskStreamRetryAtRef.current.set(taskId, Date.now() + 15_000)
        setTaskStreamErrors(current => ({
          ...current,
          [taskId]: streamTimedOut
            ? '实时进度连接超过 20 秒未收到心跳，已切换为定时刷新'
            : errorMessage(caught, '实时进度连接中断'),
        }))
        void loadTasks(true)
      }
    } finally {
      if (idleTimeoutId !== null) window.clearTimeout(idleTimeoutId)
      if (taskEventControllersRef.current.get(taskId) === controller) {
        taskEventControllersRef.current.delete(taskId)
      }
      subscribedTasksRef.current.delete(taskId)
    }
  }, [loadLibrary, mergeTask, loadRuntime, loadTasks])

  useEffect(() => {
    setPageVisible(document.visibilityState === 'visible')
    const recoverFailedReads = () => {
      if (!navigator.onLine || document.hidden) return
      if (runtimeErrorRef.current && !runtimeControllerRef.current) void loadRuntime(true)
      if (libraryErrorRef.current && !libraryControllerRef.current) void loadLibrary(false)
      if (
        !taskListControllerRef.current
        && (hasActiveTasksRef.current || tasksErrorRef.current || Object.keys(taskStreamErrorsRef.current).length)
      ) {
        taskStreamRetryAtRef.current.clear()
        void loadTasks(true)
      }
    }
    const handleVisibilityChange = () => {
      const visible = document.visibilityState === 'visible'
      setPageVisible(visible)
      if (!visible) {
        taskEventControllersRef.current.forEach(controller => controller.abort())
        return
      }
      taskStreamRetryAtRef.current.clear()
      if (!navigator.onLine) return
      if (
        !taskListControllerRef.current
        && (hasActiveTasksRef.current || tasksErrorRef.current || Object.keys(taskStreamErrorsRef.current).length)
      ) void loadTasks(true)
      if (runtimeErrorRef.current && !runtimeControllerRef.current) void loadRuntime(true)
      if (libraryErrorRef.current && !libraryControllerRef.current) void loadLibrary(false)
    }
    window.addEventListener('online', recoverFailedReads)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('online', recoverFailedReads)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [loadLibrary, loadRuntime, loadTasks])

  useEffect(() => {
    if (!pageVisible || !navigator.onLine || document.visibilityState !== 'visible') return
    const activeTaskIds = new Set(
      tasks.filter(task => ['pending', 'running', 'retrying'].includes(task.status)).map(task => task.id),
    )
    setTaskStreamErrors(current => {
      const next = Object.fromEntries(Object.entries(current).filter(([taskId]) => activeTaskIds.has(Number(taskId))))
      return Object.keys(next).length === Object.keys(current).length ? current : next
    })
    taskStreamRetryAtRef.current.forEach((_retryAt, taskId) => {
      if (!activeTaskIds.has(taskId)) taskStreamRetryAtRef.current.delete(taskId)
    })
    tasks
      .filter(task => ['pending', 'running', 'retrying'].includes(task.status))
      .forEach(task => { void subscribeTask(task.id) })
  }, [pageVisible, tasks, subscribeTask])

  const visibleActiveTaskCount = tasks.filter(task => ['pending', 'running', 'retrying'].includes(task.status)).length
  const activeTaskCount = taskSummary?.active ?? visibleActiveTaskCount
  const interruptedStreamCount = Object.keys(taskStreamErrors).length
  const taskPollingRequired = interruptedStreamCount > 0 || activeTaskCount > visibleActiveTaskCount
  const taskSnapshotMatchesView = Boolean(
    tasksLoaded
    && taskSearchSettled
    && taskQuery.trim() === debouncedTaskQuery
    && loadedTaskViewKey === taskViewKey,
  )

  useEffect(() => {
    if (!taskPollingRequired || !pageVisible) return
    const refreshActiveTasks = () => void loadTasks(true)
    const timer = window.setInterval(refreshActiveTasks, 15_000)
    return () => window.clearInterval(timer)
  }, [loadTasks, pageVisible, taskPollingRequired])

  const categories = useMemo(() => ['全部', ...libraryCategories], [libraryCategories])
  const capabilities = useMemo(() => ['全部', ...libraryCapabilities], [libraryCapabilities])
  const findLibraryModel = useCallback((name: string) => {
    const normalized = name.trim()
    const baseName = normalized.split(':')[0]
    return library.find(model =>
      model.name === baseName
      || model.tags.some(tag => tag.full_name === normalized)
    )
  }, [library])
  const isEmbeddingOnlyModel = useCallback((name: string) => {
    const model = findLibraryModel(name)
    const caps = model?.capabilities || []
    if (caps.includes('embedding')) {
      return !caps.some(cap => ['completion', 'tools', 'thinking', 'vision'].includes(cap))
    }
    return /(^|[-_/])(?:embed|embedding)(?:[-_/:]|$)/i.test(name)
  }, [findLibraryModel])
  const chatModels = useMemo(
    () => models.filter(model => !isEmbeddingOnlyModel(model.name)),
    [models, isEmbeddingOnlyModel],
  )
  const installedModelNames = useMemo(
    () => new Set(models.flatMap(model => [model.name, model.model].filter(Boolean))),
    [models],
  )

  const modelRemovedAfterPull = (name: string) => (
    isPulledModelMissing('succeeded', name, installedInventoryLoaded, installedModelNames)
  )

  useEffect(() => {
    if (!testModel) return
    if (isEmbeddingOnlyModel(testModel)) {
      setTestModel(chatModels[0]?.name || '')
    }
  }, [testModel, chatModels, isEmbeddingOnlyModel])

  const reconcileMutationState = () => {
    const reconcileId = ++mutationReconcileRef.current
    if (mutationReconcileTimerRef.current !== null) window.clearTimeout(mutationReconcileTimerRef.current)
    const readFinalState = () => Promise.allSettled([
      loadTasks(true),
      loadRuntime(),
      loadLibrary(false),
    ])
    void readFinalState().finally(() => {
      if (mutationReconcileRef.current !== reconcileId) return
      mutationReconcileTimerRef.current = window.setTimeout(() => {
        if (mutationReconcileRef.current !== reconcileId) return
        mutationReconcileTimerRef.current = null
        void readFinalState()
      }, 1200)
    })
  }

  const mutationResultUncertain = (caught: unknown) => (
    caught instanceof ApiError && caught.status === 0
    || caught instanceof Error && /超时|网络中断|无法连接|network|timeout/i.test(caught.message)
  )

  const runPrecheck = (target: string, allowCustom = false, force = false, signal?: AbortSignal): Promise<PrecheckResult | null> => {
    const normalizedTarget = target.trim()
    if (!normalizedTarget) return Promise.resolve(null)
    const requestKey = JSON.stringify({ target: normalizedTarget, allowCustom, force })
    const activeRequest = precheckInFlightRef.current
    if (activeRequest?.key === requestKey) return activeRequest.promise
    const requestSequence = ++precheckRequestSequenceRef.current
    const promise = (async () => {
      try {
        setPrechecking(true)
        setError('')
        const result = await modelApi.precheck(normalizedTarget, allowCustom, force, signal)
        if (requestSequence !== precheckRequestSequenceRef.current) return null
        setPrecheck(result)
        return result
      } catch (caught) {
        if (requestSequence !== precheckRequestSequenceRef.current || signal?.aborted) return null
        setError(errorMessage(caught, '预检失败'))
        return null
      } finally {
        if (precheckInFlightRef.current?.key === requestKey) precheckInFlightRef.current = null
        if (requestSequence === precheckRequestSequenceRef.current) setPrechecking(false)
      }
    })()
    precheckInFlightRef.current = { key: requestKey, promise }
    return promise
  }

  const createTask = async (target: string, allowCustom = false, force = false) => {
    if (!isAdmin) {
      setToast({ message: '模型拉取任务仅允许管理员创建', type: 'error' })
      return
    }
    if (createInFlightRef.current) {
      createRequestSequenceRef.current += 1
      precheckRequestSequenceRef.current += 1
      createAbortRef.current?.abort()
      createAbortRef.current = null
      createInFlightRef.current = false
      precheckInFlightRef.current = null
      setCreating(false)
      setPrechecking(false)
      setToast({ message: '已取消创建等待；任务可能已经建立，正在重新读取拉取任务和运行状态', type: 'warning' })
      reconcileMutationState()
      return
    }
    const requestSequence = ++createRequestSequenceRef.current
    const controller = new AbortController()
    createInFlightRef.current = true
    createAbortRef.current = controller
    try {
      setCreating(true)
      const check = precheck?.model_name === target ? precheck : await runPrecheck(target, allowCustom, force, controller.signal)
      if (requestSequence !== createRequestSequenceRef.current || controller.signal.aborted) return
      if (!check?.ok) return
      const res = await modelApi.createPull(target, allowCustom, force, controller.signal)
      if (requestSequence !== createRequestSequenceRef.current) return
      const task = res.task
      clearModelCache('tasks:')
      setTaskPage(1)
      mergeTask(task, true)
      setError('')
      setToast({ message: `已创建 ${task.model_name} 拉取任务`, type: 'success' })
      void subscribeTask(task.id)
      void loadTasks(true, 1)
    } catch (caught) {
      if (controller.signal.aborted || requestSequence !== createRequestSequenceRef.current) return
      if (mutationResultUncertain(caught)) {
        setToast({ message: '创建请求超时或网络中断，任务可能已经建立；请勿重复提交，正在重新读取最终状态', type: 'warning' })
        reconcileMutationState()
        return
      }
      setError(errorMessage(caught, '创建拉取任务失败'))
    } finally {
      if (createAbortRef.current === controller) {
        createAbortRef.current = null
        createInFlightRef.current = false
      }
      if (requestSequence === createRequestSequenceRef.current) setCreating(false)
    }
  }

  const selectOfficialTag = (model: LibraryModel, tagValue?: string) => {
    const tag = model.tags.find(t => t.tag === (tagValue || selectedTags[model.name])) || model.tags[0]
    if (!tag) return
    setSelectedTags(prev => ({ ...prev, [model.name]: tag.tag }))
    setModelName(tag.full_name)
    setPrecheck(null)
    void runPrecheck(tag.full_name, false, false)
  }

  const handleRetryTask = async (taskId: number) => {
    if (!isAdmin) return
    if (taskActionInFlightRef.current.has(taskId)) {
      taskActionSequenceRef.current.set(taskId, (taskActionSequenceRef.current.get(taskId) || 0) + 1)
      taskActionControllersRef.current.get(taskId)?.abort()
      taskActionControllersRef.current.delete(taskId)
      taskActionInFlightRef.current.delete(taskId)
      setPendingTaskActions(current => {
        const next = { ...current }
        delete next[taskId]
        return next
      })
      setToast({ message: '已取消重试命令的等待；任务状态可能已改变，正在重新读取最终状态', type: 'warning' })
      reconcileMutationState()
      return
    }
    if (!taskSnapshotMatchesView) {
      setToast({ message: '当前任务卡片来自上次成功快照，请等待筛选结果更新后再操作', type: 'warning' })
      return
    }
    taskActionInFlightRef.current.add(taskId)
    const controller = new AbortController()
    taskActionControllersRef.current.set(taskId, controller)
    const requestSequence = (taskActionSequenceRef.current.get(taskId) || 0) + 1
    const requestViewKey = taskViewKeyRef.current
    taskActionSequenceRef.current.set(taskId, requestSequence)
    try {
      setPendingTaskActions(current => ({ ...current, [taskId]: 'retry' }))
      const task = await modelApi.retry(taskId, controller.signal)
      if (taskActionSequenceRef.current.get(taskId) !== requestSequence) return
      if (taskViewKeyRef.current === requestViewKey) mergeTask(task)
      setToast({ message: '已重新提交拉取任务', type: 'success' })
      void subscribeTask(task.id)
    } catch (caught) {
      if (controller.signal.aborted || taskActionSequenceRef.current.get(taskId) !== requestSequence) return
      if (mutationResultUncertain(caught)) {
        setToast({ message: '重试请求超时或网络中断，任务可能已重新提交；正在重新读取最终状态', type: 'warning' })
        reconcileMutationState()
        return
      }
      setToast({ message: errorMessage(caught, '重试失败'), type: 'error' })
    } finally {
      if (taskActionControllersRef.current.get(taskId) === controller) {
        taskActionControllersRef.current.delete(taskId)
        taskActionInFlightRef.current.delete(taskId)
      }
      if (taskActionSequenceRef.current.get(taskId) === requestSequence) {
        setPendingTaskActions(current => {
          if (!current[taskId]) return current
          const next = { ...current }
          delete next[taskId]
          return next
        })
      }
    }
  }

  const handleCancelTask = async (taskId: number) => {
    if (!isAdmin) return
    if (taskActionInFlightRef.current.has(taskId)) {
      taskActionSequenceRef.current.set(taskId, (taskActionSequenceRef.current.get(taskId) || 0) + 1)
      taskActionControllersRef.current.get(taskId)?.abort()
      taskActionControllersRef.current.delete(taskId)
      taskActionInFlightRef.current.delete(taskId)
      setPendingTaskActions(current => {
        const next = { ...current }
        delete next[taskId]
        return next
      })
      setToast({ message: '已取消等待取消命令；这不会撤回后端命令，正在重新读取任务最终状态', type: 'warning' })
      reconcileMutationState()
      return
    }
    if (!taskSnapshotMatchesView) {
      setToast({ message: '当前任务卡片来自上次成功快照，请等待筛选结果更新后再操作', type: 'warning' })
      return
    }
    taskActionInFlightRef.current.add(taskId)
    const controller = new AbortController()
    taskActionControllersRef.current.set(taskId, controller)
    const requestSequence = (taskActionSequenceRef.current.get(taskId) || 0) + 1
    const requestViewKey = taskViewKeyRef.current
    taskActionSequenceRef.current.set(taskId, requestSequence)
    try {
      setPendingTaskActions(current => ({ ...current, [taskId]: 'cancel' }))
      const task = await modelApi.cancel(taskId, controller.signal)
      if (taskActionSequenceRef.current.get(taskId) !== requestSequence) return
      if (taskViewKeyRef.current === requestViewKey) mergeTask(task)
      setToast({ message: '已取消拉取任务，已下载层会保留并可续传', type: 'success' })
    } catch (caught) {
      if (controller.signal.aborted || taskActionSequenceRef.current.get(taskId) !== requestSequence) return
      if (mutationResultUncertain(caught)) {
        setToast({ message: '取消命令超时或网络中断，后端可能已经受理；正在重新读取任务最终状态', type: 'warning' })
        reconcileMutationState()
        return
      }
      setToast({ message: errorMessage(caught, '取消失败'), type: 'error' })
    } finally {
      if (taskActionControllersRef.current.get(taskId) === controller) {
        taskActionControllersRef.current.delete(taskId)
        taskActionInFlightRef.current.delete(taskId)
      }
      if (taskActionSequenceRef.current.get(taskId) === requestSequence) {
        setPendingTaskActions(current => {
          if (!current[taskId]) return current
          const next = { ...current }
          delete next[taskId]
          return next
        })
      }
    }
  }

  const handleSetCurrent = async (name: string) => {
    if (!isAdmin) {
      setToast({ message: '切换当前模型需要管理员权限', type: 'error' })
      return
    }
    if (isEmbeddingOnlyModel(name)) {
      setToast({ message: `${name} 是向量模型，不能设为对话推理模型`, type: 'error' })
      return
    }
    if (modelRemovedAfterPull(name)) {
      setToast({ message: `${name} 的历史拉取任务已完成，但模型当前未安装，请重新预检并拉取`, type: 'warning' })
      return
    }
    if (name === currentModel) {
      setToast({ message: `${name} 已是当前使用模型`, type: 'success' })
      return
    }
    if (currentInFlightRef.current) {
      if (currentInFlightRef.current !== name) return
      currentRequestSequenceRef.current += 1
      currentAbortRef.current?.abort()
      currentAbortRef.current = null
      currentInFlightRef.current = ''
      setSettingCurrentName('')
      setToast({ message: '已取消切换等待；当前模型可能已经变更，正在重新读取最终状态', type: 'warning' })
      reconcileMutationState()
      return
    }
    if (!taskSnapshotMatchesView) {
      setToast({ message: '当前任务卡片来自上次成功快照，请等待筛选结果更新后再操作', type: 'warning' })
      return
    }
    currentInFlightRef.current = name
    const requestSequence = ++currentRequestSequenceRef.current
    const controller = new AbortController()
    currentAbortRef.current = controller
    try {
      setSettingCurrentName(name)
      const response = await modelApi.setCurrent(name, controller.signal)
      if (requestSequence !== currentRequestSequenceRef.current) return
      setCurrentModel(response.current_model)
      setTestModel(response.current_model)
      setToast({ message: `已将 ${name} 设为当前使用模型`, type: 'success' })
    } catch (caught) {
      if (controller.signal.aborted || requestSequence !== currentRequestSequenceRef.current) return
      if (mutationResultUncertain(caught)) {
        setToast({ message: '切换请求超时或网络中断，当前模型可能已经变更；正在重新读取最终状态', type: 'warning' })
        reconcileMutationState()
        return
      }
      setToast({ message: errorMessage(caught, '设置失败，请重试'), type: 'error' })
    } finally {
      if (currentAbortRef.current === controller) {
        currentAbortRef.current = null
        currentInFlightRef.current = ''
      }
      if (requestSequence === currentRequestSequenceRef.current) setSettingCurrentName('')
    }
  }

  const handleInferenceTest = async (modelOverride?: string) => {
    if (modelOverride && !taskSnapshotMatchesView) {
      setToast({ message: '当前任务卡片来自上次成功快照，请等待筛选结果更新后再测试', type: 'warning' })
      return
    }
    if (modelOverride && modelRemovedAfterPull(modelOverride)) {
      setToast({ message: `${modelOverride} 当前未安装，不能执行推理测试`, type: 'warning' })
      return
    }
    inferenceReconcileRef.current += 1
    if (inferenceReconcileTimerRef.current !== null) {
      window.clearTimeout(inferenceReconcileTimerRef.current)
      inferenceReconcileTimerRef.current = null
    }
    const prompt = testPrompt.trim()
    if (!prompt) {
      setToast({ message: '请输入测试提示词', type: 'error' })
      return
    }
    const targetModel = modelOverride || testModel || undefined
    if (targetModel && isEmbeddingOnlyModel(targetModel)) {
      setToast({ message: `${targetModel} 是向量模型，请选择对话模型执行推理测试`, type: 'error' })
      return
    }
    if (inferenceInFlightRef.current) return
    inferenceInFlightRef.current = true
    const requestSequence = ++inferenceRequestSequenceRef.current
    const controller = new AbortController()
    inferenceControllerRef.current = controller
    try {
      setTesting(true)
      setTestingModel(targetModel || currentModel || '')
      setTestResult(null)
      const result = await modelApi.inference(targetModel || '', prompt, controller.signal)
      if (requestSequence !== inferenceRequestSequenceRef.current) return
      setTestResult(result)
      if (modelOverride) setTestModel(modelOverride)
      setToast({ message: '模型推理测试已完成', type: 'success' })
      await loadRuntime()
    } catch (caught) {
      if (requestSequence !== inferenceRequestSequenceRef.current) return
      if (controller.signal.aborted) return
      const failed: InferenceTestResult = {
        success: false,
        model: targetModel || currentModel || '未选择',
        prompt,
        tested_at: new Date().toISOString(),
        error: errorMessage(caught, '推理测试失败'),
      }
      setTestResult(failed)
      setToast({ message: failed.error || '推理测试失败', type: 'error' })
    } finally {
      if (inferenceControllerRef.current === controller) inferenceControllerRef.current = null
      if (requestSequence === inferenceRequestSequenceRef.current) inferenceInFlightRef.current = false
      if (requestSequence === inferenceRequestSequenceRef.current) {
        setTesting(false)
        setTestingModel('')
      }
    }
  }

  const invalidateInference = () => {
    inferenceRequestSequenceRef.current += 1
    inferenceControllerRef.current?.abort()
    inferenceControllerRef.current = null
    inferenceInFlightRef.current = false
    setTesting(false)
    setTestingModel('')
    setTestResult(null)
  }

  const cancelInference = () => {
    if (!inferenceInFlightRef.current) return
    invalidateInference()
    const sequence = ++inferenceReconcileRef.current
    if (inferenceReconcileTimerRef.current !== null) window.clearTimeout(inferenceReconcileTimerRef.current)
    setToast({ message: '已取消前端等待，Ollama 推理可能仍在处理；正在重新读取运行状态', type: 'warning' })
    void Promise.allSettled([loadRuntime(), loadTasks(true)]).then(() => {
      if (inferenceReconcileRef.current !== sequence) return
      inferenceReconcileTimerRef.current = window.setTimeout(() => {
        if (inferenceReconcileRef.current === sequence) void Promise.allSettled([loadRuntime(), loadTasks(true)])
      }, 1200)
    })
  }

  const closeModelDetail = () => {
    setDetailModel(null)
    window.requestAnimationFrame(() => detailTriggerRef.current?.focus())
  }

  const handleModelDetail = async (name: string, trigger: HTMLButtonElement) => {
    if (!taskSnapshotMatchesView) {
      setToast({ message: '当前任务卡片来自上次成功快照，请等待筛选结果更新后再查看详情', type: 'warning' })
      return
    }
    if (modelRemovedAfterPull(name)) {
      setToast({ message: `${name} 当前未安装，Ollama 已没有可读取的模型详情`, type: 'warning' })
      return
    }
    if (detailInFlightRef.current.has(name)) return
    detailTriggerRef.current = trigger
    detailAbortRef.current?.abort()
    detailInFlightRef.current.clear()
    const controller = new AbortController()
    detailAbortRef.current = controller
    detailInFlightRef.current.add(name)
    const requestSequence = ++detailRequestSequenceRef.current
    try {
      setDetailLoadingName(name)
      const detail = await modelApi.detail(name, controller.signal)
      if (requestSequence !== detailRequestSequenceRef.current) return
      setDetailModel(detail)
    } catch (caught) {
      if (controller.signal.aborted) return
      if (requestSequence !== detailRequestSequenceRef.current) return
      setToast({ message: errorMessage(caught, '获取模型详情失败'), type: 'error' })
    } finally {
      detailInFlightRef.current.delete(name)
      if (detailAbortRef.current === controller) detailAbortRef.current = null
      if (requestSequence === detailRequestSequenceRef.current) setDetailLoadingName('')
    }
  }

  const syncTime = loadingLib && !catalogMeta.source
    ? '正在读取'
    : catalogMeta.last_synced_at
      ? formatRuntimeTime(catalogMeta.last_synced_at)
      : '尚未同步'
  const latestTestTime = formatRuntimeTime(testResult?.tested_at, '尚未执行')
  const currentLibraryViewKey = libraryViewKey(debouncedLibraryQuery, category, capability, installedFilter, recommendedOnly, libraryPage, libraryPageSize)
  const librarySnapshotMatchesView = libraryLoaded
    && librarySearchSettled
    && query.trim() === debouncedLibraryQuery
    && loadedLibraryViewKey === currentLibraryViewKey
  const libraryInteractionsAllowed = librarySnapshotMatchesView

  return (
    <div className="mx-auto max-w-7xl">
      <AnimatePresence>{toast && <InlineToast message={toast.message} tone={toast.type} onClose={() => setToast(null)} duration={3500} />}</AnimatePresence>
      <AnimatePresence>{detailModel && <DetailDrawer model={detailModel} onClose={closeModelDetail} />}</AnimatePresence>

      <div className="mb-8 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <Link href="/models" className="mb-4 inline-flex min-h-9 items-center gap-2 rounded-[8px] px-3 py-2 text-xs font-bold text-slate-500 transition hover:bg-slate-100 hover:text-blue-600 dark:text-slate-400 dark:hover:bg-white/[0.06]">
            <ArrowLeft size={14} /> 返回模型运行状态
          </Link>
          <h2 className="text-4xl font-black text-slate-900 dark:text-white">模型拉取与验证</h2>
          <p className="mt-2 max-w-2xl text-sm font-medium leading-6 text-slate-500 dark:text-slate-400">
            从 Ollama 官方模型库选择版本，完成预检、持久拉取、失败诊断、安装后推理验证和操作日志留证。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-xs font-bold ${
            ollamaOnline === null
              ? 'bg-slate-100 text-slate-500 dark:bg-white/[0.06] dark:text-slate-300'
              : ollamaOnline
              ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400'
              : 'bg-red-50 text-red-500 dark:bg-red-500/15 dark:text-red-400'
          }`}>
            {ollamaOnline === null ? <Loader2 size={14} className="animate-spin" /> : ollamaOnline ? <Wifi size={14} /> : <WifiOff size={14} />}
            Ollama {ollamaOnline === null ? '检测中' : ollamaOnline ? '运行中' : '未连接'}
          </div>
          {!authLoading && isAdmin ? (
            <button onClick={() => loadLibrary(true)} disabled={syncing} className="inline-flex items-center gap-2 rounded-[8px] bg-slate-900 px-5 py-3 text-sm font-black text-white transition hover:bg-slate-700 disabled:opacity-50 dark:bg-white dark:text-slate-900">
              {syncing ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
              同步官方库
            </button>
          ) : null}
          <button onClick={() => void loadRuntime(true)} disabled={runtimeLoading} className="inline-flex items-center gap-2 rounded-[8px] bg-white px-5 py-3 text-sm font-black text-slate-600 shadow-sm transition hover:bg-slate-50 disabled:opacity-50 dark:bg-white/[0.08] dark:text-slate-200 dark:hover:bg-white/[0.12]">
            <Activity size={16} className={runtimeLoading ? 'animate-pulse' : ''} />
            {runtimeLoading ? '正在读取运行状态' : '刷新运行状态'}
          </button>
        </div>
      </div>

      <div className="mb-8 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {[
          { label: '模型库来源', value: loadingLib ? `${catalogMeta.source ? sourceLabel(catalogMeta.source) : '模型目录'} · 正在读取` : `${sourceLabel(catalogMeta.source)} · ${libraryTotal} 个` },
          { label: '最近同步', value: syncTime },
          { label: '已安装模型', value: installedModelTotal === null ? '—' : `${installedModelTotal} 个` },
          { label: '当前模型', value: runtimeLoading && !runtimeUpdatedAt ? '正在读取' : runtimeError && !currentModel ? '—' : currentModel || '未设置' },
        ].map(item => (
          <div key={item.label} className="min-w-0 rounded-2xl border border-slate-100 bg-white px-4 py-4 shadow-sm sm:px-5 dark:border-white/[0.06] dark:bg-white/[0.05]">
            <p className="text-xs font-semibold text-slate-400 dark:text-slate-500">{item.label}</p>
            <p className="mt-2 break-words text-sm font-black leading-5 text-slate-900 [overflow-wrap:anywhere] dark:text-white">{item.value}</p>
          </div>
        ))}
      </div>

      {catalogMeta.error && (
        <div className="mb-6 rounded-[8px] border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-bold leading-5 text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/15 dark:text-amber-300">
          <p>官方同步失败，当前继续使用{sourceLabel(catalogMeta.source)}。{errorMessage(catalogMeta.error, 'Ollama 官方模型目录同步失败，请检查网络和服务日志')}</p>
          <details className="mt-2 font-semibold">
            <summary className="cursor-pointer">查看技术错误</summary>
            <code className="mt-2 block whitespace-pre-wrap break-all text-[11px] font-normal opacity-80">{catalogMeta.error}</code>
          </details>
        </div>
      )}
      {runtimeError && (
        <div className="mb-6 flex items-start gap-2 rounded-[8px] border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-bold leading-5 text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/15 dark:text-amber-200">
          <WifiOff size={15} className="mt-0.5 shrink-0" />
          <span>{runtimeError}{installedModelTotal !== null ? '，页面继续保留上次成功读取的运行数据。' : '。'}</span>
        </div>
      )}
      {!authLoading && !isAdmin ? (
        <div className="mb-6 rounded-[8px] border border-blue-100 bg-blue-50 px-4 py-3 text-xs font-bold leading-5 text-blue-700 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-200">
          当前账号可浏览模型库、执行预检、查看任务与模型详情，并使用已安装模型进行推理验证；同步模型库、创建或操作拉取任务、切换当前模型由管理员负责。
        </div>
      ) : null}

      <div className="mb-10 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <section className="rounded-2xl border border-slate-100 bg-white shadow-sm dark:border-white/[0.06] dark:bg-white/[0.05]">
          <div className="border-b border-slate-100 p-6 dark:border-white/[0.06]">
            <p className="mb-2 text-xs font-semibold text-blue-500">{loadingLib && !catalogMeta.source ? '正在读取目录' : sourceLabel(catalogMeta.source)}</p>
            <h3 className="text-xl font-black text-slate-900 dark:text-white">{loadingLib && !catalogMeta.source ? '模型目录读取中' : catalogHeading(catalogMeta.source)}</h3>
            <p className="mt-2 text-xs font-semibold leading-5 text-slate-500 dark:text-slate-400">{catalogDescription(catalogMeta.source)}</p>
            <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-[1.4fr_repeat(4,minmax(0,0.8fr))]">
              <label className="flex items-center gap-2 rounded-[8px] border border-slate-200 bg-slate-50 px-4 py-2 transition focus-within:border-blue-300 focus-within:ring-2 focus-within:ring-blue-100 sm:col-span-2 dark:border-white/[0.08] dark:bg-white/[0.05] dark:focus-within:ring-blue-400/15 2xl:col-span-1">
                <Search size={16} className="text-slate-400" />
                <input value={query} onChange={e => {
                  invalidateLibraryView()
                  librarySearchSettledRef.current = false
                  setLibrarySearchSettled(false)
                  setQuery(e.target.value)
                }} placeholder="搜索模型名称或描述" aria-label="搜索模型目录" className="w-full bg-transparent text-sm font-bold text-slate-800 outline-none placeholder:text-slate-400 dark:text-white" />
              </label>
              <div className="min-w-0">
                <p className="mb-1.5 px-1 text-xs font-black text-slate-400 dark:text-slate-500">模型类别</p>
                <UnifiedSelect
                  ariaLabel="筛选模型类别"
                  value={category}
                  className="[&>button]:rounded-[8px]"
                  size="sm"
                  options={categories.map(item => ({ value: item, label: item === '全部' ? '全部类别' : categoryLabel(item) }))}
                  onChange={(value) => { invalidateLibraryView(); setCategory(value); setLibraryPage(1) }}
                />
              </div>
              <div className="min-w-0">
                <p className="mb-1.5 px-1 text-xs font-black text-slate-400 dark:text-slate-500">模型能力</p>
                <UnifiedSelect
                  ariaLabel="筛选模型能力"
                  value={capability}
                  className="[&>button]:rounded-[8px]"
                  size="sm"
                  options={capabilities.map(item => ({ value: item, label: item === '全部' ? '全部能力' : capabilityLabel(item) }))}
                  onChange={(value) => { invalidateLibraryView(); setCapability(value); setLibraryPage(1) }}
                />
              </div>
              <div className="min-w-0">
                <p className="mb-1.5 px-1 text-xs font-black text-slate-400 dark:text-slate-500">安装状态</p>
                <UnifiedSelect
                  ariaLabel="筛选模型安装状态"
                  value={installedFilter}
                  className="[&>button]:rounded-[8px]"
                  size="sm"
                  options={['全部', '已安装', '未安装'].map(item => ({ value: item, label: item === '全部' ? '全部状态' : item }))}
                  onChange={(value) => { invalidateLibraryView(); setInstalledFilter(value); setLibraryPage(1) }}
                />
              </div>
              <div className="min-w-0">
                <p className="mb-1.5 px-1 text-xs font-black text-slate-400 dark:text-slate-500">目录范围</p>
                <button
                  type="button"
                  aria-pressed={recommendedOnly}
                  onClick={() => { invalidateLibraryView(); setRecommendedOnly(value => !value); setLibraryPage(1) }}
                  className={`inline-flex h-10 w-full items-center justify-center rounded-[8px] px-3 text-xs font-black transition ${recommendedOnly ? 'bg-blue-600 text-white' : 'border border-slate-200 bg-white text-slate-600 hover:border-blue-200 hover:text-blue-600 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-slate-300'}`}
                >
                  {recommendedOnly ? '仅看推荐模型' : '全部模型'}
                </button>
              </div>
            </div>
            <div className={`mt-4 grid grid-cols-1 gap-3 ${!authLoading && isAdmin ? 'md:grid-cols-[1fr_auto_auto]' : 'md:grid-cols-[1fr_auto]'}`}>
              <input value={modelName} onChange={e => {
                precheckRequestSequenceRef.current += 1
                setPrechecking(false)
                setModelName(e.target.value)
                setPrecheck(null)
              }} aria-label="自定义模型名称" placeholder="或输入自定义模型，例如 qwen3:8b" className="rounded-[8px] border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold text-slate-800 outline-none focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-white" />
              <button
                onClick={() => runPrecheck(modelName, true, false)}
                disabled={prechecking || !modelName.trim()}
                title={prechecking ? '正在执行模型预检' : !modelName.trim() ? '请先输入自定义模型名称' : '执行模型拉取预检'}
                className="inline-flex items-center justify-center gap-2 rounded-[8px] bg-slate-900 px-5 py-3 text-sm font-black text-white disabled:opacity-50 dark:bg-white dark:text-slate-900"
              >
                {prechecking ? <Loader2 size={16} className="animate-spin" /> : <ListChecks size={16} />}预检
              </button>
              {!authLoading && isAdmin ? (
                <button onClick={() => createTask(modelName, true, false)} disabled={!creating && (!modelName.trim() || (!!precheck && !precheck.ok))} className="inline-flex items-center justify-center gap-2 rounded-[8px] bg-blue-600 px-5 py-3 text-sm font-black text-white shadow-lg shadow-blue-500/20 disabled:opacity-50">
                  {creating ? <XCircle size={16} /> : <DownloadCloud size={16} />}{creating ? '取消等待' : '创建任务'}
                </button>
              ) : null}
            </div>
          </div>

          <div className="max-h-[720px] overflow-y-auto p-6">
            {(loadingLib || libraryError) && libraryLoaded ? (
              <div className={`mb-4 flex items-center gap-2 border-l-2 px-3 py-2 text-xs font-semibold ${libraryError ? 'border-amber-500 bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300' : 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300'}`} role="status">
                {loadingLib ? <Loader2 size={14} className="animate-spin" /> : <AlertTriangle size={14} />}
                {libraryError
                  ? librarySnapshotMatchesView
                    ? `${libraryError}；当前保留同一条件下的上一次成功${library.length ? '目录' : '空结果'}，版本选择、预检和分页仍可用。`
                    : `${libraryError}；下方旧目录不代表当前筛选条件，版本选择、预检和分页已暂停。`
                  : `正在更新模型目录，${librarySnapshotMatchesView ? '当前暂时显示同一条件下的上一次成功结果。' : '下方旧目录不代表当前筛选条件，版本选择、预检和分页暂不可用。'}`}
              </div>
            ) : null}
            {loadingLib && library.length === 0 ? (
              <div className="flex items-center justify-center py-24"><Loader2 size={26} className="animate-spin text-slate-300" /></div>
            ) : library.length === 0 ? (
              <div className="py-14 text-center">
                <p className={`text-sm font-black ${libraryError ? 'text-rose-700 dark:text-rose-300' : 'text-slate-700 dark:text-slate-200'}`}>
                  {libraryError && !librarySnapshotMatchesView ? '模型目录未取得' : query || category !== '全部' || capability !== '全部' || installedFilter !== '全部' || recommendedOnly ? '没有匹配的模型' : '模型目录为空'}
                </p>
                <p className={`mx-auto mt-2 max-w-md text-xs leading-5 ${libraryError && !librarySnapshotMatchesView ? 'text-rose-600 dark:text-rose-300/80' : 'text-slate-400 dark:text-slate-500'}`}>
                  {libraryError && !librarySnapshotMatchesView ? libraryError : (query || category !== '全部' || capability !== '全部' || installedFilter !== '全部' || recommendedOnly
                    ? '调整搜索或筛选条件后重试。'
                    : '当前模型目录没有可展示的条目，可由管理员同步官方模型库。')}
                </p>
                {libraryError && !librarySnapshotMatchesView ? (
                  <button type="button" onClick={() => void loadLibrary(false)} className="mt-4 inline-flex min-h-9 items-center gap-2 rounded-[8px] border border-rose-200 bg-white px-3 text-xs font-black text-rose-700 transition hover:bg-rose-50 dark:border-rose-500/30 dark:bg-white/[0.04] dark:text-rose-300">
                    <RefreshCw size={14} />重新读取目录
                  </button>
                ) : null}
              </div>
            ) : (
              <fieldset disabled={!libraryInteractionsAllowed} className="space-y-3 disabled:opacity-70">
                {library.map(m => {
                  const tag = m.tags.find(t => t.tag === selectedTags[m.name]) || m.tags[0]
                  const selectedVersionInstalled = tag?.installed === true
                  return (
                    <div key={m.name} className="rounded-2xl border border-slate-100 bg-slate-50 px-4 py-3.5 dark:border-white/[0.06] dark:bg-white/[0.04]">
                      <div className="flex flex-col gap-4 2xl:flex-row 2xl:items-center">
                        <div className="min-w-0 flex-1">
                          <div className="mb-2 flex flex-wrap items-center gap-1.5">
                            <span className="max-w-full break-all text-sm font-black text-slate-900 dark:text-white">{m.name}</span>
                            <TagPill tone="muted" title={categoryLabel(m.category) === '其他模型' ? `原始类型：${m.category || '未返回'}` : undefined}>{categoryLabel(m.category)}</TagPill>
                            {m.recommended && <TagPill tone="blue">推荐</TagPill>}
                            {m.installed === true && <TagPill tone="emerald">已有已安装版本</TagPill>}
                          </div>
                          <p className="line-clamp-2 text-[13px] leading-5 text-slate-500 dark:text-slate-400" title={modelPurposeDescription(m)}>{modelPurposeDescription(m)}</p>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {(m.capabilities || []).slice(0, 3).map(cap => <TagPill key={cap} title={capabilityLabel(cap) === '其他模型能力' ? `原始能力：${cap}` : undefined}>{capabilityLabel(cap)}</TagPill>)}
                            {(m.capabilities || []).length > 3 ? <span className="inline-flex items-center px-1 text-xs font-bold text-slate-400" title={(m.capabilities || []).map(capabilityLabel).join('、')}>另 {(m.capabilities || []).length - 3} 项</span> : null}
                          </div>
                          {(m.parameter_sizes || []).length ? (
                            <p className="mt-2 line-clamp-2 min-h-9 text-xs font-bold leading-[1.125rem] text-slate-400 dark:text-slate-500 sm:min-h-0 sm:truncate sm:leading-normal" title={(m.parameter_sizes || []).map(size => parameterSizeLabel(size)).join(' / ')}>
                              可选规格：{(m.parameter_sizes || []).map(size => size.toUpperCase()).join(' / ')}
                            </p>
                          ) : null}
                        </div>
                        <div className="grid items-center gap-2 sm:grid-cols-[130px_82px_82px_76px]">
                          <UnifiedSelect
                            ariaLabel={`${m.name} 模型版本`}
                            value={tag?.tag || ''}
                            className="[&>button]:rounded-[8px]"
                            size="sm"
                            options={m.tags.map(t => ({ value: t.tag, label: t.tag }))}
                            onChange={(nextValue) => selectOfficialTag(m, nextValue)}
                          />
                          <InfoPill label="大小" value={tag?.size || '—'} />
                          <InfoPill label="上下文" value={tag?.context || '—'} />
                          <button
                            onClick={() => selectOfficialTag(m)}
                            disabled={selectedVersionInstalled}
                            title={selectedVersionInstalled ? `${tag?.full_name || '当前版本'} 已安装` : '对当前选择版本执行拉取预检'}
                            className="inline-flex h-10 items-center justify-center rounded-[8px] bg-blue-600 px-4 text-xs font-black text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-emerald-100 disabled:text-emerald-700 dark:disabled:bg-emerald-500/15 dark:disabled:text-emerald-300"
                          >
                            {selectedVersionInstalled ? '已安装' : '预检'}
                          </button>
                        </div>
                      </div>
                      {tag && (
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          {selectedVersionInstalled && <TagPill tone="emerald">当前版本已安装</TagPill>}
                          <p className="break-all text-xs font-bold leading-5 text-slate-400 dark:text-slate-500">{tag.full_name} · {inputTypeLabel(tag.input)} · {updatedLabel(tag.updated)}</p>
                        </div>
                      )}
                    </div>
                  )
                })}
              </fieldset>
            )}
            {libraryLoaded ? <Pagination
              page={loadedLibraryPage}
              pageSize={loadedLibraryPageSize}
              total={libraryTotal}
              loading={loadingLib}
              navigationDisabled={!libraryInteractionsAllowed}
              onPageChange={(target) => { invalidateLibraryView(); setLibraryPage(target) }}
              onPageSizeChange={(size) => {
                if (size === libraryPageSize) return
                invalidateLibraryView()
                setLibraryPageSize(size)
                setLibraryPage(1)
              }}
              pageSizeOptions={LIBRARY_PAGE_SIZES}
              itemName="个目录模型"
              className="mt-5 px-0 pb-0"
            /> : null}
          </div>
        </section>

        <aside className="space-y-6">
          <section className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm dark:border-white/[0.06] dark:bg-white/[0.05]">
            <h3 className="text-lg font-black text-slate-900 dark:text-white">拉取预检</h3>
            {precheck ? (
              <div className="mt-5 space-y-3">
                {precheck.checks.map(check => (
                  <div key={check.key} className={`rounded-[8px] border px-4 py-3 ${check.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/15 dark:text-emerald-200' : 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/20 dark:bg-red-500/15 dark:text-red-200'}`}>
                    <div className="flex items-center gap-2 text-xs font-black">{check.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}{check.message}</div>
                    {check.detail?.free_bytes !== undefined && <p className="mt-2 text-xs opacity-75">可用 {formatBytes(check.detail.free_bytes)} · 需要 {check.detail.required_bytes !== undefined ? formatBytes(check.detail.required_bytes) : '未提供'}</p>}
                  </div>
                ))}
                {!authLoading && isAdmin ? (
                  <button onClick={() => createTask(precheck.model_name, true, false)} disabled={!creating && !precheck.ok} className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-[8px] bg-blue-600 px-5 py-3 text-sm font-black text-white disabled:opacity-50">
                    {creating ? <XCircle size={16} /> : <DownloadCloud size={16} />}{creating ? '取消等待' : '确认创建拉取任务'}
                  </button>
                ) : null}
              </div>
            ) : (
              <div className="mt-5 rounded-[8px] border border-dashed border-slate-200 px-4 py-6 text-sm leading-7 text-slate-500 dark:border-white/[0.08] dark:text-slate-400">
                选择模型版本或输入自定义模型后执行预检。预检会检查 Ollama 状态、磁盘空间、模型库命中和已安装状态。
              </div>
            )}
            {error && <div className="mt-4 break-words rounded-[8px] border border-red-200 bg-red-50 px-4 py-3 text-xs font-bold text-red-600 dark:border-red-500/20 dark:bg-red-500/15 dark:text-red-300">{error}</div>}
          </section>

          <section className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm dark:border-white/[0.06] dark:bg-white/[0.05]">
            <p className="mb-2 text-xs font-semibold text-emerald-500">运行状态</p>
            <h3 className="text-lg font-black text-slate-900 dark:text-white">模型运行状态</h3>
            <div className="mt-5 grid grid-cols-2 gap-x-4">
              {[
                { label: 'Ollama 状态', value: runtimeLoading && ollamaOnline === null ? '检测中' : ollamaOnline ? '运行中' : '未连接' },
                { label: '运行中模型', value: runtimeLoading && !runtimeUpdatedAt ? '—' : `${running.length} 个` },
                { label: 'CPU/内存', value: runtimeLoading && !sysMetrics ? '正在读取' : sysMetrics ? `${sysMetrics.cpu.percent}% / ${sysMetrics.memory.percent}%` : '未取得' },
                { label: '最近测试', value: latestTestTime },
              ].map(item => (
                <div key={item.label} className="border-b border-slate-100 px-1 py-3 dark:border-white/[0.06]">
                  <p className="text-xs font-semibold text-slate-400 dark:text-slate-500">{item.label}</p>
                  <p className="mt-2 break-all text-sm font-black text-slate-900 dark:text-white">{item.value}</p>
                </div>
              ))}
            </div>
            {testResult ? (
              <div className={`mt-4 min-w-0 rounded-[8px] border px-4 py-3 ${testResult.success ? 'border-emerald-100 bg-emerald-50 text-emerald-800 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-200' : 'border-red-100 bg-red-50 text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-200'}`}>
                <div className="mb-2 flex items-center gap-2 text-sm font-black">
                  <GaugeCircle size={16} />
                  {testResult.success ? `${testResult.model} · ${formatMilliseconds(testResult.latency_ms)}` : `${testResult.model} · 测试失败`}
                </div>
                <p className="break-words text-xs leading-6 opacity-80">提示词：{testResult.prompt}</p>
                <p className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-7">{testResult.success ? (testResult.response || '模型未返回内容') : (testResult.error || '未知错误')}</p>
              </div>
            ) : (
              <div className="mt-4 rounded-[8px] border border-dashed border-slate-200 px-4 py-5 text-sm leading-7 text-slate-500 dark:border-white/[0.08] dark:text-slate-400">
                尚未执行推理测试。完成后这里会保留最近一次响应、延迟和失败原因。
              </div>
            )}
          </section>
        </aside>
      </div>

      <section className="mb-10 rounded-2xl border border-slate-100 bg-white p-6 shadow-sm dark:border-white/[0.06] dark:bg-white/[0.05]">
        <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="mb-2 text-xs font-semibold text-blue-500">拉取任务</p>
            <h3 className="text-xl font-black text-slate-900 dark:text-white">拉取任务记录</h3>
            <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
              {!tasksLoaded && tasksError
                ? '拉取任务统计未取得。'
                : tasksLoading
                ? '正在应用筛选条件并读取拉取任务。'
                : tasksError
                  ? `任务更新失败，当前保留上一次成功快照：筛选结果 ${taskTotal} 条；全部 ${taskSummary?.total ?? taskTotal} 条。`
                : `当前筛选 ${taskTotal} 条；全部 ${taskSummary?.total ?? taskTotal} 条，进行中 ${taskSummary?.active ?? 0} 条，失败/中断 ${taskSummary?.failed ?? 0} 条。活动任务通过事件流更新，页面可见时每 15 秒补偿刷新。`}
            </p>
          </div>
          <button onClick={() => void loadTasks(true)} disabled={tasksLoading} className="inline-flex min-h-9 items-center gap-2 rounded-[8px] bg-slate-100 px-4 py-2 text-xs font-black text-slate-600 transition hover:bg-slate-200 disabled:opacity-50 dark:bg-white/[0.06] dark:text-slate-300">
            <RefreshCw size={14} className={tasksLoading ? 'animate-spin' : ''} /> 刷新任务
          </button>
        </div>
        <div className="mb-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_180px]">
          <label className="relative min-w-0">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={taskQuery}
              onChange={(event) => {
                invalidateTaskView()
                taskSearchSettledRef.current = false
                setTaskSearchSettled(false)
                setTaskQuery(event.target.value)
              }}
              placeholder="搜索模型名称"
              aria-label="搜索模型拉取任务"
              className="h-10 w-full rounded-[8px] border border-slate-200 bg-slate-50 pl-9 pr-4 text-sm text-slate-800 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-white"
            />
          </label>
          <UnifiedSelect
            ariaLabel="筛选模型拉取任务状态"
            value={taskStatus}
            className="[&>button]:rounded-[8px]"
            size="sm"
            options={[
              { value: '', label: '全部任务状态' },
              { value: 'pending', label: '队列中' },
              { value: 'running', label: '下载中' },
              { value: 'retrying', label: '重试中' },
              { value: 'succeeded', label: '已完成' },
              { value: 'failed', label: '失败' },
              { value: 'interrupted', label: '已中断' },
              { value: 'canceled', label: '已取消' },
            ]}
            onChange={(value) => { invalidateTaskView(); setTaskStatus(value); setTaskPage(1) }}
          />
        </div>
        {tasksError && tasksLoaded && (
          <div className="mb-4 flex items-start gap-2 rounded-[8px] border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-bold leading-5 text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/15 dark:text-amber-200" role="alert">
            <Info size={15} className="mt-0.5 shrink-0" />
            <span>{tasksError}，下方继续展示上次成功读取的{tasks.length ? '记录' : '空结果'}。</span>
          </div>
        )}
        {tasksLoading && tasks.length ? (
          <div className="mb-4 flex items-center gap-2 border-l-2 border-blue-500 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700 dark:bg-blue-500/10 dark:text-blue-300" role="status">
            <Loader2 size={14} className="animate-spin" />
            正在更新拉取任务，当前暂时显示上一次成功结果
          </div>
        ) : null}
        {!tasksError && interruptedStreamCount > 0 && (
          <div className="mb-4 flex items-start gap-2 rounded-[8px] border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-bold leading-5 text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/15 dark:text-amber-200">
            <WifiOff size={15} className="mt-0.5 shrink-0" />
            <span>{interruptedStreamCount} 个任务的实时进度连接已中断，页面已切换为每 15 秒自动刷新；连接恢复后会自动回到实时更新。</span>
          </div>
        )}
        {!tasksLoaded && tasksLoading ? (
          <div className="flex min-h-28 items-center justify-center gap-2 text-sm font-bold text-slate-400">
            <Loader2 size={18} className="animate-spin" /> 正在读取拉取任务
          </div>
        ) : !tasksLoaded && tasksError ? (
          <div className="rounded-[8px] border border-dashed border-amber-200 px-4 py-8 text-center text-sm text-amber-700 dark:border-amber-500/20 dark:text-amber-300" role="alert">
            <p className="font-bold">拉取任务记录未取得。</p>
            <p className="mx-auto mt-2 max-w-xl break-words text-xs leading-5">{tasksError}</p>
            <p className="mt-1 text-xs opacity-80">当前不能确认任务总数或运行状态，不按零条任务统计。</p>
            <button type="button" onClick={() => void loadTasks(true)} disabled={tasksLoading} className="mt-4 inline-flex min-h-9 items-center justify-center gap-2 rounded-[6px] border border-amber-200 bg-white px-3 text-xs font-black text-amber-800 disabled:cursor-wait disabled:opacity-50 dark:border-amber-400/20 dark:bg-white/[0.06] dark:text-amber-200"><RefreshCw size={14} className={tasksLoading ? 'animate-spin' : ''} />{tasksLoading ? '正在重新读取' : '重新读取任务'}</button>
          </div>
        ) : tasks.length === 0 ? (
          <div className="rounded-[8px] border border-dashed border-slate-200 px-4 py-5 text-sm text-slate-500 dark:border-white/[0.08] dark:text-slate-400">
            {!taskSnapshotMatchesView
              ? '当前保留的上一次成功快照中没有拉取任务。'
              : taskQuery || taskStatus ? '当前筛选条件没有匹配的拉取任务。' : '暂无拉取任务。创建任务后，刷新浏览器也能从这里恢复进度。'}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {tasks.map(task => {
              const isEmbeddingOnly = isEmbeddingOnlyModel(task.model_name)
              const removedAfterPull = isPulledModelMissing(task.status, task.model_name, installedInventoryLoaded, installedModelNames)
              const hasCredibleByteProgress = task.total_bytes >= 1_048_576 && task.completed_bytes <= task.total_bytes
              const hasReportedProgress = Number.isFinite(task.progress_percent) && task.progress_percent > 0
              const displayProgress = task.status === 'succeeded' ? 100 : hasReportedProgress ? task.progress_percent : null
              const bytesText = hasCredibleByteProgress
                ? `${formatBytes(task.completed_bytes)} / ${formatBytes(task.total_bytes)}`
                : '正在等待模型层进度'
              const progressText = task.status === 'succeeded'
                ? (hasCredibleByteProgress ? '已完成' : '已完成 · 历史大小未记录')
                : displayProgress == null ? bytesText : `${bytesText} · ${displayProgress}%`
              return (
              <div key={task.id} className="rounded-2xl border border-slate-100 bg-slate-50 p-4 dark:border-white/[0.06] dark:bg-white/[0.04]">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <p className="min-w-0 max-w-full truncate text-sm font-black text-slate-900 dark:text-white" title={task.model_name}>{task.model_name}</p>
                      {isEmbeddingOnly && (
                        <span className="inline-flex h-6 items-center rounded-full bg-teal-100 px-2 text-xs font-black leading-none text-teal-700 dark:bg-teal-500/15 dark:text-teal-300">向量模型</span>
                      )}
                    </div>
                    <p className="mt-1 text-xs font-bold text-slate-400 dark:text-slate-500">最近更新 {formatTaskTime(task.updated_at || task.finished_at || task.started_at)}</p>
                  </div>
                  <span className={`inline-flex h-6 shrink-0 items-center rounded-full px-2 text-xs font-black leading-none ${taskStatusTone(task.status)}`}>{taskStatusLabel(task.status)}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-white/[0.08]">
                  <div className={`h-full rounded-full transition-all ${task.status === 'succeeded' ? 'bg-emerald-500' : 'bg-blue-600'}`} style={{ width: `${displayProgress == null ? 0 : Math.max(0, Math.min(100, displayProgress))}%` }} />
                </div>
                <div className="mt-2 flex flex-col gap-1 text-xs font-bold text-slate-400 sm:flex-row sm:items-center sm:justify-between dark:text-slate-500">
                  <span className="min-w-0 truncate" title={task.last_status || '等待任务更新'}>{taskStageLabel(task.last_status)}</span>
                  <span className="shrink-0">{progressText}</span>
                </div>
                {(task.status === 'failed' || task.status === 'interrupted') && (
                  <div className="mt-3 break-words rounded-[8px] border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-700 dark:border-red-500/20 dark:bg-red-500/15 dark:text-red-200">
                    <p><strong>{taskErrorTypeLabel(task.error_type)}：</strong>{taskErrorDescription(task.error_type, task.error_message)}</p>
                    {task.error_message ? <details className="mt-2"><summary className="cursor-pointer font-bold">技术错误</summary><code className="mt-1 block whitespace-pre-wrap break-all text-[11px] opacity-80">{task.error_message}</code></details> : null}
                  </div>
                )}
                {task.status === 'canceled' && (
                  <div className="mt-3 rounded-[8px] border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/15 dark:text-amber-200">
                    平台任务已取消；Ollama 已下载层会保留，下次拉取同模型可续传。
                  </div>
                )}
                {task.attempt > 1 || ['failed', 'interrupted', 'retrying'].includes(task.status) ? (
                  <p className="mt-3 text-xs font-bold text-slate-400 dark:text-slate-500">
                    已尝试 {task.attempt}/{task.max_attempts} 次
                  </p>
                ) : null}
                {removedAfterPull ? (
                  <div className="mt-3 border-l-2 border-amber-400 bg-amber-50 px-3 py-2 text-xs font-semibold leading-5 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
                    历史拉取已完成，但该模型当前不在 Ollama 已安装清单中。详情、切换和推理不可用，可重新预检后创建拉取任务。
                  </div>
                ) : task.status === 'succeeded' && !installedInventoryLoaded ? (
                  <div className="mt-3 border-l-2 border-slate-300 bg-slate-100 px-3 py-2 text-xs font-semibold leading-5 text-slate-600 dark:border-slate-600 dark:bg-white/[0.05] dark:text-slate-300">
                    历史拉取已完成，当前安装状态暂未取得。
                  </div>
                ) : null}
                <div className="mt-4 flex flex-wrap gap-2">
                  {!authLoading && isAdmin && ['pending', 'running', 'retrying'].includes(task.status) && (
                    <button disabled={!taskSnapshotMatchesView || Boolean(pendingTaskActions[task.id] && pendingTaskActions[task.id] !== 'cancel')} title={!taskSnapshotMatchesView ? '等待当前筛选结果更新后再操作' : undefined} onClick={() => handleCancelTask(task.id)} className="inline-flex min-h-9 items-center gap-1 rounded-[8px] bg-slate-200 px-3 py-2 text-xs font-black text-slate-600 hover:bg-red-100 hover:text-red-600 disabled:cursor-wait disabled:opacity-50 dark:bg-white/[0.08] dark:text-slate-300">
                      {pendingTaskActions[task.id] === 'cancel' ? <XCircle size={13} /> : <StopCircle size={13} />}
                      {pendingTaskActions[task.id] === 'cancel' ? '取消等待' : '取消任务'}
                    </button>
                  )}
                  {!authLoading && isAdmin && ['failed', 'canceled', 'interrupted'].includes(task.status) && (
                    <button disabled={!taskSnapshotMatchesView || Boolean(pendingTaskActions[task.id] && pendingTaskActions[task.id] !== 'retry')} title={!taskSnapshotMatchesView ? '等待当前筛选结果更新后再操作' : undefined} onClick={() => handleRetryTask(task.id)} className="inline-flex min-h-9 items-center gap-1 rounded-[8px] bg-blue-600 px-3 py-2 text-xs font-black text-white disabled:cursor-wait disabled:opacity-50">
                      {pendingTaskActions[task.id] === 'retry' ? <XCircle size={13} /> : <RotateCcw size={13} />}
                      {pendingTaskActions[task.id] === 'retry' ? '取消等待' : '重试'}
                    </button>
                  )}
                  {task.status === 'succeeded' && !removedAfterPull && (
                    <>
                      {!isEmbeddingOnly && !authLoading && isAdmin && (
                        <>
                          {task.model_name === currentModel ? (
                            <span className="inline-flex min-h-9 items-center gap-1 rounded-[8px] bg-amber-50 px-3 py-2 text-xs font-black text-amber-700 dark:bg-amber-500/10 dark:text-amber-300"><Star size={13} />当前使用</span>
                          ) : (
                            <button disabled={!taskSnapshotMatchesView || Boolean(settingCurrentName && settingCurrentName !== task.model_name)} title={!taskSnapshotMatchesView ? '等待当前筛选结果更新后再操作' : undefined} onClick={() => handleSetCurrent(task.model_name)} className="inline-flex min-h-9 items-center gap-1 rounded-[8px] bg-amber-500 px-3 py-2 text-xs font-black text-white disabled:cursor-wait disabled:opacity-50">
                              {settingCurrentName === task.model_name ? <XCircle size={13} /> : <Star size={13} />}
                              {settingCurrentName === task.model_name ? '取消等待' : '设为当前使用模型'}
                            </button>
                          )}
                          <button disabled={!taskSnapshotMatchesView || testing} title={!taskSnapshotMatchesView ? '等待当前筛选结果更新后再测试' : undefined} onClick={() => handleInferenceTest(task.model_name)} className="inline-flex min-h-9 items-center gap-1 rounded-[8px] bg-blue-600 px-3 py-2 text-xs font-black text-white disabled:cursor-wait disabled:opacity-50">
                            {testing && testingModel === task.model_name ? <Loader2 size={13} className="animate-spin" /> : <PlayCircle size={13} />}
                            {testing && testingModel === task.model_name ? '正在测试' : '执行推理测试'}
                          </button>
                        </>
                      )}
                      {isEmbeddingOnly && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-teal-100 px-3 py-1.5 text-xs font-black text-teal-700 dark:bg-teal-500/15 dark:text-teal-300">向量模型不支持对话推理测试</span>
                      )}
                      <button disabled={!taskSnapshotMatchesView || detailLoadingName === task.model_name} title={!taskSnapshotMatchesView ? '等待当前筛选结果更新后再查看详情' : undefined} onClick={(event) => handleModelDetail(task.model_name, event.currentTarget)} className="inline-flex min-h-9 items-center gap-1 rounded-[8px] bg-slate-200 px-3 py-2 text-xs font-black text-slate-600 disabled:cursor-wait disabled:opacity-50 dark:bg-white/[0.08] dark:text-slate-300">
                        {detailLoadingName === task.model_name ? <Loader2 size={13} className="animate-spin" /> : <Info size={13} />}
                        {detailLoadingName === task.model_name ? '正在读取' : '查看模型详情'}
                      </button>
                    </>
                  )}
                  {removedAfterPull ? (
                    <button
                      type="button"
                      disabled={!taskSnapshotMatchesView || prechecking}
                      title={!taskSnapshotMatchesView ? '等待当前筛选结果更新后再预检' : undefined}
                      onClick={() => {
                        setModelName(task.model_name)
                        setPrecheck(null)
                        void runPrecheck(task.model_name, !findLibraryModel(task.model_name), false)
                      }}
                      className="inline-flex min-h-9 items-center gap-1 rounded-[8px] bg-blue-600 px-3 py-2 text-xs font-black text-white disabled:cursor-wait disabled:opacity-50"
                    >
                      {prechecking && modelName === task.model_name ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
                      重新预检
                    </button>
                  ) : null}
                  <button onClick={() => { window.location.href = '/activity-logs?type=model_pull' }} className="inline-flex min-h-9 items-center gap-1 rounded-[8px] bg-slate-200 px-3 py-2 text-xs font-black text-slate-600 dark:bg-white/[0.08] dark:text-slate-300">
                    <ClipboardCheck size={13} /> 操作日志
                  </button>
                </div>
              </div>
            )})}
          </div>
        )}
        {tasksLoaded ? <Pagination
          page={loadedTaskPage}
          pageSize={loadedTaskPageSize}
          total={taskTotal}
          loading={tasksLoading}
          navigationDisabled={!taskSnapshotMatchesView}
          onPageChange={(target) => { invalidateTaskView(); setTaskPage(target) }}
          onPageSizeChange={(size) => {
            if (size === taskPageSize) return
            invalidateTaskView()
            setTaskPageSize(size)
            setTaskPage(1)
          }}
          pageSizeOptions={TASK_PAGE_SIZES}
          itemName="条拉取任务"
          className="mt-5 px-0 pb-0"
        /> : null}
      </section>

      <section className="mb-10 grid grid-cols-1 gap-6 xl:grid-cols-[1.05fr_0.95fr]">
        <div className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm dark:border-white/[0.06] dark:bg-white/[0.05]">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <p className="mb-2 text-xs font-semibold text-blue-500">推理测试</p>
              <h3 className="text-xl font-black text-slate-900 dark:text-white">本地模型推理测试</h3>
              <p className="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400">调用 Ollama 推理接口，查看模型可用性、响应内容与耗时。</p>
            </div>
            <PlayCircle className="shrink-0 text-blue-500" size={24} />
          </div>
          <div className="space-y-4">
            <div>
              <label className="mb-2 block text-xs font-semibold text-slate-500 dark:text-slate-400">测试模型</label>
              <UnifiedSelect
                value={testModel}
                ariaLabel="测试模型"
                disabled={testing}
                className="[&>button]:rounded-[8px]"
                options={[
                  { value: '', label: currentModel && !isEmbeddingOnlyModel(currentModel) ? `使用当前模型：${currentModel}` : '请选择对话模型' },
                  ...chatModels.map((model) => ({ value: model.name, label: model.name })),
                ]}
                onChange={(value) => {
                  if (value === testModel) return
                  invalidateInference()
                  setTestModel(value)
                }}
              />
              {models.length > chatModels.length && (
                <p className="mt-2 text-xs font-bold text-slate-400 dark:text-slate-500">
                  已过滤 {models.length - chatModels.length} 个仅支持向量化的模型；它们不支持对话生成测试。
                </p>
              )}
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between gap-3">
                <label htmlFor="model-inference-test-prompt" className="text-xs font-semibold text-slate-500 dark:text-slate-400">测试提示词</label>
                <button
                  type="button"
                  disabled={testing || testPrompt === INFERENCE_PROMPT_EXAMPLE}
                  onClick={() => {
                    invalidateInference()
                    setTestPrompt(INFERENCE_PROMPT_EXAMPLE)
                  }}
                  className="inline-flex min-h-8 items-center rounded-[6px] px-2 text-xs font-semibold text-blue-600 transition hover:bg-blue-50 hover:text-blue-700 disabled:cursor-default disabled:bg-transparent disabled:text-slate-300 dark:text-blue-300 dark:hover:bg-blue-400/10 dark:hover:text-blue-200 dark:disabled:text-slate-600"
                >
                  使用示例
                </button>
              </div>
              <textarea
                id="model-inference-test-prompt"
                value={testPrompt}
                disabled={testing}
                onChange={(e) => {
                  if (e.target.value === testPrompt) return
                  invalidateInference()
                  setTestPrompt(e.target.value)
                }}
                rows={4}
                placeholder={INFERENCE_PROMPT_EXAMPLE}
                className="w-full resize-none rounded-[8px] border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-800 outline-none focus:border-blue-300 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-white"
              />
            </div>
            <button
              onClick={() => testing ? cancelInference() : handleInferenceTest()}
              disabled={!testing && (!ollamaOnline || !testPrompt.trim())}
              title={testing ? '取消等待本次推理结果' : !ollamaOnline ? 'Ollama 未连接，暂不能执行推理测试' : !testPrompt.trim() ? '请先输入测试提示词' : '执行本地模型推理测试'}
              className={`inline-flex items-center gap-2 rounded-[8px] px-6 py-3 text-sm font-black text-white shadow-lg transition disabled:cursor-not-allowed disabled:opacity-50 ${testing ? 'bg-slate-800 shadow-slate-500/20 hover:bg-slate-700' : 'bg-blue-600 shadow-blue-500/20 hover:bg-blue-700'}`}
            >
              {testing ? <X size={16} /> : <PlayCircle size={16} />}
              {testing ? '取消等待' : '执行推理测试'}
            </button>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm dark:border-white/[0.06] dark:bg-white/[0.05]">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <p className="mb-2 text-xs font-semibold text-slate-500 dark:text-slate-400">运行资源</p>
              <h3 className="text-xl font-black text-slate-900 dark:text-white">资源与运行状态</h3>
              <p className="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400">
                展示当前推理环境的 CPU、内存和已加载模型状态。{runtimeUpdatedAt ? `最近读取：${formatRuntimeTime(runtimeUpdatedAt)}` : '运行快照尚未取得。'}
              </p>
            </div>
            <Activity className="shrink-0 text-emerald-500" size={24} />
          </div>
          <div className="grid grid-cols-2 gap-x-4">
            {[
              { label: 'CPU', value: runtimeLoading && !sysMetrics ? '正在读取' : sysMetrics ? `${sysMetrics.cpu.percent}%` : '未取得', tone: '' },
              { label: '内存', value: runtimeLoading && !sysMetrics ? '正在读取' : sysMetrics ? `${sysMetrics.memory.percent}%` : '未取得', tone: '' },
              { label: '磁盘', value: runtimeLoading && !sysMetrics ? '正在读取' : sysMetrics ? `${sysMetrics.disk.percent}%` : '未取得', tone: sysMetrics && sysMetrics.disk.percent >= 90 ? 'text-red-600 dark:text-red-300' : sysMetrics && sysMetrics.disk.percent >= 80 ? 'text-amber-600 dark:text-amber-300' : '' },
              { label: 'GPU', value: runtimeLoading && !sysMetrics ? '正在检测' : sysMetrics?.gpus?.length ? `${sysMetrics.gpus.length} 张` : '未检测到', tone: '' },
            ].map(item => (
              <div key={item.label} className="border-b border-slate-100 px-1 py-4 dark:border-white/[0.06]">
                <p className="text-xs font-semibold text-slate-400 dark:text-slate-500">{item.label}</p>
                <p className={`mt-2 text-lg font-black ${item.tone || 'text-slate-900 dark:text-white'}`}>{item.value}</p>
              </div>
            ))}
          </div>
          {sysMetrics && sysMetrics.disk.percent >= 90 ? (
            <div role="status" className="mt-5 flex items-start gap-3 border-t border-red-100 pt-4 text-sm leading-6 text-red-700 dark:border-red-400/20 dark:text-red-200">
              <AlertTriangle size={17} className="mt-1 shrink-0" />
              <p><strong>磁盘空间紧张。</strong>当前已使用 {sysMetrics.disk.used_gb} / {sysMetrics.disk.total_gb} GB；拉取新模型前请先释放空间，任务创建仍会执行模型大小加 20% 缓冲的真实预检。</p>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  )
}

export default function ModelPullsPage() {
  return (
    <Suspense fallback={<div className="flex min-h-[50vh] items-center justify-center text-sm font-bold text-slate-400">正在读取模型目录...</div>}>
      <ModelPullsContent />
    </Suspense>
  )
}
