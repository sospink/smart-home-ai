'use client'

import { Fragment, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  AlertTriangle,
  ArrowLeft,
  Copy,
  Download,
  Eye,
  FileCode2,
  Loader2,
  Pencil,
  RefreshCw,
  Rocket,
  Search,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react'
import { AppDialog } from '@/components/ui/AppDialog'
import { Pagination } from '@/components/ui/Pagination'
import { UnifiedSelect } from '@/components/ui/UnifiedSelect'
import { toast } from '@/components/ui/toast'
import { agentsApi, validateAgentDslFile } from '@/lib/api/agents'
import type { AgentTemplateLibraryDetail, AgentTemplateLibraryItem, AgentTemplateLibraryListResponse } from '@/types/agents'
import { businessErrorMessage } from '@/lib/ui/business-error'
import { copyTextToClipboard } from '@/lib/clipboard'

const EMPTY_LIBRARY: AgentTemplateLibraryListResponse = {
  items: [],
  total: 0,
  page: 1,
  pageSize: 6,
  pageCount: 1,
  summary: { totalTemplates: 0, builtinTemplates: 0, uploadedTemplates: 0 },
  canManage: false,
  generatedAt: null,
  cacheTtlSeconds: 30,
}

function formatDateTime(value?: string) {
  if (!value) return '时间未取得'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未取得'
  return date.toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function sourceLabel(source: string) {
  if (source === 'builtin') return '内置模板'
  if (source === 'uploaded') return '上传模板'
  return '来源待确认'
}

function sourceTimeLabel(item: AgentTemplateLibraryItem) {
  if (item.source === 'builtin') return '随系统提供'
  if (item.source === 'uploaded') return `更新于 ${formatDateTime(item.updatedAt || item.createdAt)}`
  return '来源与更新时间待确认'
}

function useDebouncedValue<T>(value: T, delay = 300) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timeoutId = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(timeoutId)
  }, [delay, value])
  return debounced
}

function templateViewKey(keyword: string, source: string, page: number, pageSize: number) {
  return JSON.stringify({ keyword: keyword.trim(), source, page, pageSize })
}

function displayTags(item: AgentTemplateLibraryItem) {
  const genericTags = new Set(['app', 'dsl', 'yaml', 'yml', '内置模板', '上传模板'])
  return item.tags.filter((tag) => {
    const normalized = tag.trim().toLowerCase()
    return normalized && !genericTags.has(normalized) && !/^v?\d+(?:\.\d+){0,3}$/i.test(normalized)
  })
}

function isMissingTemplateDescription(value: string) {
  return !value.trim() || ['未填写描述', '暂无用途说明', 'DSL 未提供用途说明'].includes(value.trim())
}

function templateDescription(item: AgentTemplateLibraryItem, canManage = false) {
  if (!isMissingTemplateDescription(item.description)) return item.description
  return canManage && !item.readonly
    ? 'DSL 未提供用途说明，可通过“编辑信息”补充。'
    : '模板暂未填写用途说明。'
}

function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName || 'template.yml'
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function splitYamlComment(value: string) {
  let quote: '"' | "'" | null = null
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    const prev = value[index - 1]
    if ((char === '"' || char === "'") && prev !== '\\') {
      quote = quote === char ? null : quote || char
    }
    if (char === '#' && !quote && (index === 0 || /\s/.test(value[index - 1]))) {
      return [value.slice(0, index), value.slice(index)] as const
    }
  }
  return [value, ''] as const
}

function renderYamlValue(value: string) {
  const [rawValue, comment] = splitYamlComment(value)
  const trimmed = rawValue.trim()
  const leading = rawValue.match(/^\s*/)?.[0] || ''

  let valueNode: ReactNode = rawValue
  if (trimmed) {
    const tone = /^['"]/.test(trimmed)
      ? 'text-emerald-300'
      : /^(true|false|null|yes|no|on|off)$/i.test(trimmed)
        ? 'text-purple-300'
        : /^-?\d+(\.\d+)?$/.test(trimmed)
          ? 'text-amber-300'
          : /^(\[.*\]|\{.*\})$/.test(trimmed)
            ? 'text-cyan-200'
            : 'text-slate-100'
    valueNode = (
      <>
        {leading}
        <span className={tone}>{trimmed}</span>
      </>
    )
  }

  return (
    <>
      {valueNode}
      {comment ? <span className="text-slate-500">{comment}</span> : null}
    </>
  )
}

function renderYamlLine(line: string) {
  if (!line.trim()) return <span>&nbsp;</span>
  if (line.trimStart().startsWith('#')) {
    return <span className="text-slate-500">{line}</span>
  }

  const listMatch = line.match(/^(\s*)(-\s+)(.*)$/)
  const body = listMatch ? listMatch[3] : line
  const keyMatch = body.match(/^(\s*)(["']?[\w.$/@-][\w\s.$/@-]*["']?)(\s*:\s*)(.*)$/)

  if (!keyMatch) {
    return (
      <>
        {listMatch ? (
          <>
            {listMatch[1]}
            <span className="text-blue-300">{listMatch[2]}</span>
          </>
        ) : null}
        {renderYamlValue(listMatch ? body : line)}
      </>
    )
  }

  return (
    <>
      {listMatch ? (
        <>
          {listMatch[1]}
          <span className="text-blue-300">{listMatch[2]}</span>
        </>
      ) : null}
      {keyMatch[1]}
      <span className="text-sky-300">{keyMatch[2]}</span>
      <span className="text-slate-400">{keyMatch[3]}</span>
      {renderYamlValue(keyMatch[4])}
    </>
  )
}

function YamlPreview({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false)
  const lines = content.split('\n')
  const visibleLines = expanded ? lines : lines.slice(0, 500)
  const hiddenLineCount = Math.max(0, lines.length - visibleLines.length)
  return (
    <div className="overflow-hidden rounded-[8px] border border-slate-800 bg-slate-950 font-mono text-xs leading-6 text-slate-100">
      <div className="docs-api-scroll max-h-[62vh] overflow-auto py-4">
        <div className="min-w-0">
          {visibleLines.map((line, index) => (
            <div key={`${index}-${line}`} className="grid min-w-0 grid-cols-[3.25rem_minmax(0,1fr)] px-0 transition hover:bg-white/[0.04]">
              <span className="select-none border-r border-white/[0.06] pr-3 text-right text-slate-600">
                {index + 1}
              </span>
              <code className="min-w-0 whitespace-pre-wrap break-words px-4 [overflow-wrap:anywhere]">
                <Fragment>{renderYamlLine(line)}</Fragment>
              </code>
            </div>
          ))}
        </div>
      </div>
      {hiddenLineCount > 0 ? <div className="flex flex-col gap-2 border-t border-white/[0.08] bg-slate-900 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <span className="font-sans text-xs font-semibold text-slate-400">为保证预览流畅，暂未渲染后续 {hiddenLineCount} 行；复制和下载仍包含完整内容。</span>
        <button type="button" onClick={() => setExpanded(true)} className="shrink-0 rounded-[6px] border border-white/[0.12] px-3 py-1.5 font-sans text-xs font-bold text-slate-200 transition hover:border-blue-400 hover:text-white">显示完整 DSL</button>
      </div> : null}
    </div>
  )
}

function AgentTemplatesContent() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const initialPage = Number(searchParams.get('page') || 1)
  const initialPageSize = Number(searchParams.get('size') || 6)
  const initialSource = searchParams.get('source') || ''
  const fileInputRef = useRef<HTMLInputElement>(null)
  const editNameRef = useRef<HTMLInputElement>(null)
  const [library, setLibrary] = useState<AgentTemplateLibraryListResponse>({
    ...EMPTY_LIBRARY,
    page: Number.isInteger(initialPage) && initialPage > 0 ? initialPage : 1,
    pageSize: [6, 12, 18].includes(initialPageSize) ? initialPageSize : 6,
  })
  const [requestedPage, setRequestedPage] = useState(Number.isInteger(initialPage) && initialPage > 0 ? initialPage : 1)
  const [requestedPageSize, setRequestedPageSize] = useState([6, 12, 18].includes(initialPageSize) ? initialPageSize : 6)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [keyword, setKeyword] = useState(searchParams.get('q') || '')
  const debouncedKeyword = useDebouncedValue(keyword)
  const [source, setSource] = useState<'' | 'builtin' | 'uploaded'>(['builtin', 'uploaded'].includes(initialSource) ? initialSource as 'builtin' | 'uploaded' : '')
  const [templatesLoaded, setTemplatesLoaded] = useState(false)
  const [loadedTemplateViewKey, setLoadedTemplateViewKey] = useState('')
  const [contextLoading, setContextLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [previewLoadingId, setPreviewLoadingId] = useState('')
  const [previewItem, setPreviewItem] = useState<AgentTemplateLibraryDetail | null>(null)
  const [downloadingId, setDownloadingId] = useState('')
  const [editTarget, setEditTarget] = useState<AgentTemplateLibraryItem | null>(null)
  const [editForm, setEditForm] = useState({ name: '', description: '', tagsText: '' })
  const [savingEdit, setSavingEdit] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<AgentTemplateLibraryItem | null>(null)
  const [deletingId, setDeletingId] = useState('')
  const [createTarget, setCreateTarget] = useState<AgentTemplateLibraryItem | null>(null)
  const [createForm, setCreateForm] = useState({ name: '', description: '', enabled: true })
  const [creating, setCreating] = useState(false)
  const listRequestRef = useRef(0)
  const previewRequestRef = useRef(0)
  const downloadRequestRef = useRef(0)
  const uploadRequestRef = useRef(0)
  const editRequestRef = useRef(0)
  const deleteRequestRef = useRef(0)
  const createRequestRef = useRef(0)
  const refreshInFlightRef = useRef(false)
  const refreshQueuedRef = useRef<{ page: number; pageSize: number } | null>(null)
  const uploadInFlightRef = useRef(false)
  const previewInFlightRef = useRef(new Set<string>())
  const downloadInFlightRef = useRef(new Set<string>())
  const saveEditInFlightRef = useRef(false)
  const deleteInFlightRef = useRef(new Set<string>())
  const createInFlightRef = useRef(false)
  const libraryRef = useRef(library)
  const listAbortRef = useRef<AbortController | null>(null)
  const previewAbortRef = useRef<AbortController | null>(null)
  const uploadAbortRef = useRef<AbortController | null>(null)
  const downloadAbortRef = useRef<AbortController | null>(null)
  const editAbortRef = useRef<AbortController | null>(null)
  const deleteAbortRef = useRef<AbortController | null>(null)
  const createAbortRef = useRef<AbortController | null>(null)
  const mutationReconcileTimerRef = useRef<number | null>(null)
  const mutationReconcileRequestRef = useRef(0)
  const writtenSearchRef = useRef(searchParams.toString())

  const items = library.items
  const hasPreviousData = templatesLoaded
  const currentTemplateViewKey = templateViewKey(debouncedKeyword, source, requestedPage, requestedPageSize)
  const templateSnapshotMatchesView = Boolean(
    templatesLoaded
    && keyword.trim() === debouncedKeyword.trim()
    && loadedTemplateViewKey === currentTemplateViewKey
  )
  const templateWritesAllowed = templateSnapshotMatchesView && !error && !contextLoading
  const generatedAt = useMemo(() => formatDateTime(library.generatedAt || undefined), [library.generatedAt])

  const loadData = useCallback(async (page = 1, pageSize = 6, force = false) => {
    if (force && refreshInFlightRef.current) {
      refreshQueuedRef.current = { page, pageSize }
      return
    }
    if (force) refreshInFlightRef.current = true
    listAbortRef.current?.abort()
    const controller = new AbortController()
    listAbortRef.current = controller
    const requestId = ++listRequestRef.current
    setLoading(true)
    if (force) setRefreshing(true)
    if (!force) setContextLoading(true)
    setError('')
    try {
      const response = await agentsApi.listTemplateLibrary({
        page,
        pageSize,
        keyword: debouncedKeyword.trim(),
        source,
      }, force, controller.signal)
      if (controller.signal.aborted || listRequestRef.current !== requestId) return
      setLibrary(response)
      setTemplatesLoaded(true)
      setLoadedTemplateViewKey(templateViewKey(debouncedKeyword, source, response.page, response.pageSize))
      setRequestedPage(response.page)
      setRequestedPageSize(response.pageSize)
    } catch (loadError) {
      if (controller.signal.aborted || listRequestRef.current !== requestId) return
      setError(businessErrorMessage(loadError, { fallback: '应用模板库加载失败', service: '应用模板库' }))
    } finally {
      const ownsCurrentRequest = listRequestRef.current === requestId
      if (ownsCurrentRequest) {
        setLoading(false)
        setContextLoading(false)
      }
      if (listAbortRef.current === controller) listAbortRef.current = null
      if (force && ownsCurrentRequest) {
        refreshInFlightRef.current = false
        setRefreshing(false)
        const queuedRefresh = refreshQueuedRef.current
        if (queuedRefresh) {
          refreshQueuedRef.current = null
          window.queueMicrotask(() => {
            void loadDataRef.current(
              queuedRefresh.page,
              queuedRefresh.pageSize,
              true,
            )
          })
        }
      }
    }
  }, [debouncedKeyword, source])

  const loadDataRef = useRef(loadData)

  useEffect(() => {
    loadDataRef.current = loadData
    libraryRef.current = library
  }, [library, loadData])

  useEffect(() => {
    void loadData(requestedPage, requestedPageSize)
  }, [loadData, requestedPage, requestedPageSize])

  useEffect(() => {
    if (!error) return

    const retryFailedRead = () => {
      if (!navigator.onLine || document.visibilityState !== 'visible' || listAbortRef.current) return
      void loadDataRef.current(
        requestedPage,
        requestedPageSize,
        true,
      )
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') retryFailedRead()
    }

    window.addEventListener('online', retryFailedRead)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('online', retryFailedRead)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [error, requestedPage, requestedPageSize])

  useEffect(() => {
    if (pathname !== '/agents/templates') return
    const url = new URL(window.location.href)
    const values: Record<string, string> = {
      q: keyword.trim(),
      source,
      page: requestedPage === 1 ? '' : String(requestedPage),
      size: requestedPageSize === 6 ? '' : String(requestedPageSize),
    }
    Object.entries(values).forEach(([key, value]) => {
      if (value) url.searchParams.set(key, value)
      else url.searchParams.delete(key)
    })
    writtenSearchRef.current = url.searchParams.toString()
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }, [keyword, pathname, requestedPage, requestedPageSize, source])

  useEffect(() => {
    if (pathname !== '/agents/templates') return
    const incomingSearch = searchParams.toString()
    if (incomingSearch === writtenSearchRef.current) return
    writtenSearchRef.current = incomingSearch
    const nextPage = Number(searchParams.get('page') || 1)
    const nextSize = Number(searchParams.get('size') || 6)
    const nextSource = searchParams.get('source') || ''
    listRequestRef.current += 1
    listAbortRef.current?.abort()
    setKeyword(searchParams.get('q') || '')
    setSource(['builtin', 'uploaded'].includes(nextSource) ? nextSource as 'builtin' | 'uploaded' : '')
    setRequestedPage(Number.isInteger(nextPage) && nextPage > 0 ? nextPage : 1)
    setRequestedPageSize([6, 12, 18].includes(nextSize) ? nextSize : 6)
    setPreviewItem(null)
    setEditTarget(null)
    setDeleteTarget(null)
    setCreateTarget(null)
  }, [pathname, searchParams])

  useEffect(() => () => {
    listRequestRef.current += 1
    previewRequestRef.current += 1
    downloadRequestRef.current += 1
    uploadRequestRef.current += 1
    editRequestRef.current += 1
    deleteRequestRef.current += 1
    createRequestRef.current += 1
    mutationReconcileRequestRef.current += 1
    refreshInFlightRef.current = false
    refreshQueuedRef.current = null
    uploadInFlightRef.current = false
    previewInFlightRef.current.clear()
    downloadInFlightRef.current.clear()
    saveEditInFlightRef.current = false
    deleteInFlightRef.current.clear()
    createInFlightRef.current = false
    listAbortRef.current?.abort()
    listAbortRef.current = null
    previewAbortRef.current?.abort()
    previewAbortRef.current = null
    uploadAbortRef.current?.abort()
    uploadAbortRef.current = null
    downloadAbortRef.current?.abort()
    downloadAbortRef.current = null
    editAbortRef.current?.abort()
    editAbortRef.current = null
    deleteAbortRef.current?.abort()
    deleteAbortRef.current = null
    createAbortRef.current?.abort()
    createAbortRef.current = null
    if (mutationReconcileTimerRef.current !== null) window.clearTimeout(mutationReconcileTimerRef.current)
  }, [])

  const handleKeywordChange = (value: string) => {
    listRequestRef.current += 1
    listAbortRef.current?.abort()
    listAbortRef.current = null
    refreshInFlightRef.current = false
    refreshQueuedRef.current = null
    setRefreshing(false)
    setLoading(true)
    setContextLoading(true)
    setError('')
    setRequestedPage(1)
    setKeyword(value)
  }

  const handleSourceChange = (value: typeof source) => {
    listRequestRef.current += 1
    listAbortRef.current?.abort()
    listAbortRef.current = null
    refreshInFlightRef.current = false
    refreshQueuedRef.current = null
    setRefreshing(false)
    setLoading(true)
    setContextLoading(true)
    setError('')
    setRequestedPage(1)
    setSource(value)
  }

  const reconcileTemplateLibrary = (page = libraryRef.current.page) => {
    const requestId = ++mutationReconcileRequestRef.current
    if (mutationReconcileTimerRef.current !== null) window.clearTimeout(mutationReconcileTimerRef.current)
    void loadDataRef.current(page, libraryRef.current.pageSize, true).finally(() => {
      if (mutationReconcileRequestRef.current !== requestId) return
      mutationReconcileTimerRef.current = window.setTimeout(() => {
        if (mutationReconcileRequestRef.current !== requestId) return
        mutationReconcileTimerRef.current = null
        void loadDataRef.current(page, libraryRef.current.pageSize, true)
      }, 1200)
    })
  }

  const mutationResultUncertain = (error: unknown) => (
    error instanceof Error && /超时|网络中断|无法连接|network|timeout/i.test(error.message)
  )

  const openCreateDialog = (item: AgentTemplateLibraryItem) => {
    if (!templateWritesAllowed || !libraryRef.current.canManage) return
    setCreateTarget(item)
    setCreateForm({
      name: item.name,
      description: isMissingTemplateDescription(item.description) ? '' : item.description,
      enabled: true,
    })
  }

  const closeCreateDialog = () => {
    if (creating) return
    setCreateTarget(null)
    setCreateForm({ name: '', description: '', enabled: true })
  }

  const cancelCreateWait = () => {
    createRequestRef.current += 1
    createAbortRef.current?.abort()
    createAbortRef.current = null
    createInFlightRef.current = false
    setCreating(false)
    setCreateTarget(null)
    toast.warning('已取消前端等待；实例可能已经创建，请前往实例管理核对后再重试')
  }

  const handleCreateInstance = async () => {
    if (!createTarget || createInFlightRef.current) return
    if (!templateWritesAllowed) {
      toast.warning('模板目录当前未完成实时读取，请恢复后重新选择模板创建实例')
      return
    }
    const name = createForm.name.trim()
    if (!name) {
      toast.error('实例名称不能为空')
      return
    }
    createInFlightRef.current = true
    const requestId = ++createRequestRef.current
    const controller = new AbortController()
    createAbortRef.current = controller
    setCreating(true)
    try {
      await agentsApi.createInstance({
        name,
        description: createForm.description.trim(),
        sourceType: 'template_library',
        sourceTemplate: createTarget.id,
        enabled: createForm.enabled,
        isDefault: false,
      }, controller.signal)
      if (controller.signal.aborted || requestId !== createRequestRef.current) return
      toast.success('智能体实例已创建，可继续绑定 Dify 应用并执行测试')
      setCreateTarget(null)
      router.push('/agents?scope=all')
    } catch (createError) {
      if (controller.signal.aborted || requestId !== createRequestRef.current) return
      const message = businessErrorMessage(createError, { fallback: '智能体实例创建失败', service: '智能体管理' })
      if (mutationResultUncertain(createError)) {
        toast.warning(`${message}；请求结果不确定，请前往实例管理核对后再重试`)
      } else {
        toast.error(message)
      }
    } finally {
      if (createAbortRef.current === controller) createAbortRef.current = null
      if (requestId === createRequestRef.current) {
        createInFlightRef.current = false
        setCreating(false)
      }
    }
  }

  const handleUpload = async (files?: FileList | null) => {
    const selectedFiles = Array.from(files || [])
    if (!selectedFiles.length) return
    if (!libraryRef.current.canManage) {
      if (fileInputRef.current) fileInputRef.current.value = ''
      toast.error('当前账号只能查看和下载模板，上传模板需要管理员权限')
      return
    }
    if (!templateWritesAllowed) {
      if (fileInputRef.current) fileInputRef.current.value = ''
      toast.warning('模板目录当前未完成实时读取，请恢复后再上传模板')
      return
    }
    if (uploadInFlightRef.current) return
    const invalidFile = selectedFiles.find((file) => {
      try {
        validateAgentDslFile(file)
        return false
      } catch {
        return true
      }
    })
    if (invalidFile) {
      try {
        validateAgentDslFile(invalidFile)
      } catch (error) {
        toast.error(`${error instanceof Error ? error.message : '模板文件不可用'}：${invalidFile.name}`)
      }
      if (fileInputRef.current) fileInputRef.current.value = ''
      return
    }
    uploadInFlightRef.current = true
    const requestId = ++uploadRequestRef.current
    const controller = new AbortController()
    uploadAbortRef.current = controller
    setUploading(true)
    let successCount = 0
    let duplicateCount = 0
    try {
      for (const file of selectedFiles) {
        const result = await agentsApi.uploadTemplateLibraryFile(file, controller.signal)
        if (controller.signal.aborted || requestId !== uploadRequestRef.current) return
        if (result.created) successCount += 1
        else duplicateCount += 1
      }
      if (successCount > 0) {
        toast.success(
          duplicateCount > 0
            ? `新增 ${successCount} 个模板，另有 ${duplicateCount} 个内容相同的模板已存在`
            : successCount > 1 ? `${successCount} 个模板上传成功` : '模板上传成功',
        )
      } else {
        toast.info(duplicateCount > 1 ? `${duplicateCount} 个模板内容均已存在，未重复创建` : '相同内容的模板已存在，未重复创建')
      }
    } catch (uploadError) {
      if (controller.signal.aborted || requestId !== uploadRequestRef.current) return
      if (mutationResultUncertain(uploadError)) {
        toast.warning('上传请求超时或网络中断，部分模板可能已经保存；正在重新读取模板目录，请勿立即重复上传')
        reconcileTemplateLibrary(1)
        return
      }
      const completedCount = successCount + duplicateCount
      const prefix = completedCount > 0 ? `已处理 ${completedCount} 个，` : ''
      toast.error(`${prefix}${businessErrorMessage(uploadError, { fallback: '模板上传失败', service: '应用模板库' })}`)
    } finally {
      if (uploadAbortRef.current === controller) uploadAbortRef.current = null
      if (requestId === uploadRequestRef.current) {
        setUploading(false)
        uploadInFlightRef.current = false
        if (fileInputRef.current) fileInputRef.current.value = ''
      }
      if (successCount > 0 && requestId === uploadRequestRef.current) {
        void loadDataRef.current(1, libraryRef.current.pageSize, true)
      }
    }
  }

  const cancelUploadWait = () => {
    if (!uploadInFlightRef.current) return
    uploadRequestRef.current += 1
    uploadAbortRef.current?.abort()
    uploadAbortRef.current = null
    uploadInFlightRef.current = false
    setUploading(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
    toast.warning('已取消上传等待；服务端可能仍在处理中，正在重新读取模板目录')
    reconcileTemplateLibrary(1)
  }

  const handlePreview = async (item: AgentTemplateLibraryItem) => {
    if (!templateSnapshotMatchesView) {
      toast.warning('当前模板目录不属于正在查看的筛选条件，请等待重新读取后再预览')
      return
    }
    if (previewInFlightRef.current.has(item.id)) return
    previewAbortRef.current?.abort()
    const controller = new AbortController()
    previewAbortRef.current = controller
    previewInFlightRef.current.add(item.id)
    const requestId = ++previewRequestRef.current
    setPreviewLoadingId(item.id)
    try {
      const detail = await agentsApi.getTemplateLibraryItem(item.id, controller.signal)
      if (controller.signal.aborted || previewRequestRef.current !== requestId) return
      setPreviewItem(detail)
    } catch (previewError) {
      if (previewRequestRef.current !== requestId) return
      toast.error(businessErrorMessage(previewError, { fallback: 'DSL 文件读取失败', service: '模板 DSL' }))
    } finally {
      previewInFlightRef.current.delete(item.id)
      if (previewAbortRef.current === controller) previewAbortRef.current = null
      if (previewRequestRef.current === requestId) setPreviewLoadingId('')
    }
  }

  const handleDownload = async (item: AgentTemplateLibraryItem) => {
    if (!templateSnapshotMatchesView) {
      toast.warning('当前模板目录不属于正在查看的筛选条件，请等待重新读取后再下载')
      return
    }
    if (downloadInFlightRef.current.has(item.id)) return
    downloadInFlightRef.current.add(item.id)
    downloadAbortRef.current?.abort()
    const controller = new AbortController()
    downloadAbortRef.current = controller
    const requestId = ++downloadRequestRef.current
    setDownloadingId(item.id)
    try {
      const { blob, fileName } = await agentsApi.downloadTemplateLibraryFile(item.id, controller.signal)
      if (downloadRequestRef.current !== requestId) return
      saveBlob(blob, fileName || item.fileName)
    } catch (downloadError) {
      if (controller.signal.aborted) return
      if (downloadRequestRef.current !== requestId) return
      toast.error(businessErrorMessage(downloadError, { fallback: '模板下载失败', service: '应用模板库' }))
    } finally {
      downloadInFlightRef.current.delete(item.id)
      if (downloadAbortRef.current === controller) downloadAbortRef.current = null
      if (downloadRequestRef.current === requestId) setDownloadingId('')
    }
  }

  const handleCopyDsl = async () => {
    if (!previewItem?.dslContent) return
    const success = await copyTextToClipboard(previewItem.dslContent)
    if (success) toast.success('DSL 内容已复制')
    else toast.error('复制失败，请手动选择内容复制')
  }

  const openEditDialog = (item: AgentTemplateLibraryItem) => {
    if (!libraryRef.current.canManage || item.readonly) {
      toast.error(item.readonly ? '内置模板为只读内容，不能修改展示信息' : '修改模板信息需要管理员权限')
      return
    }
    if (!templateWritesAllowed) {
      toast.warning('模板目录当前未完成实时读取，请等待恢复后再编辑')
      return
    }
    setEditTarget(item)
    setEditForm({
      name: item.name,
      description: isMissingTemplateDescription(item.description) ? '' : item.description,
      tagsText: item.tags.join('，'),
    })
  }

  const closeEditDialog = () => {
    setEditTarget(null)
    setEditForm({ name: '', description: '', tagsText: '' })
  }

  const handleSaveEdit = async () => {
    if (!editTarget || saveEditInFlightRef.current) return
    if (!libraryRef.current.canManage || editTarget.readonly) {
      closeEditDialog()
      toast.error(editTarget.readonly ? '内置模板为只读内容，不能修改展示信息' : '修改模板信息需要管理员权限')
      return
    }
    if (!templateWritesAllowed) {
      toast.warning('模板目录当前未完成实时读取，请恢复后重新打开目标模板再保存')
      return
    }
    const name = editForm.name.trim()
    if (!name) {
      toast.error('模板名称不能为空')
      return
    }
    const tags = editForm.tagsText
      .split(/[,，\n]/)
      .map((tag) => tag.trim())
      .filter(Boolean)
      .filter((tag, index, array) => array.indexOf(tag) === index)
    saveEditInFlightRef.current = true
    const requestId = ++editRequestRef.current
    const controller = new AbortController()
    editAbortRef.current = controller
    setSavingEdit(true)
    try {
      const updated = await agentsApi.updateTemplateLibraryItem(editTarget.id, {
        name,
        description: editForm.description.trim(),
        tags,
      }, controller.signal)
      if (controller.signal.aborted || requestId !== editRequestRef.current) return
      setLibrary((current) => ({
        ...current,
        items: current.items.map((item) => (item.id === updated.id ? updated : item)),
      }))
      if (previewItem?.id === updated.id) {
        setPreviewItem({ ...previewItem, ...updated })
      }
      toast.success('模板信息已保存')
      closeEditDialog()
    } catch (saveError) {
      if (controller.signal.aborted || requestId !== editRequestRef.current) return
      if (mutationResultUncertain(saveError)) {
        closeEditDialog()
        toast.warning('保存请求超时或网络中断，模板信息可能已经更新；正在重新读取模板目录')
        reconcileTemplateLibrary()
        return
      }
      toast.error(businessErrorMessage(saveError, { fallback: '模板信息保存失败', service: '应用模板库' }))
    } finally {
      if (editAbortRef.current === controller) editAbortRef.current = null
      if (requestId === editRequestRef.current) {
        setSavingEdit(false)
        saveEditInFlightRef.current = false
      }
    }
  }

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return
    if (!libraryRef.current.canManage || deleteTarget.readonly) {
      setDeleteTarget(null)
      toast.error(deleteTarget.readonly ? '内置模板为只读内容，不能删除' : '删除模板需要管理员权限')
      return
    }
    if (!templateWritesAllowed) {
      setDeleteTarget(null)
      toast.warning('模板目录当前未完成实时读取，请恢复后重新选择目标模板再删除')
      return
    }
    const target = deleteTarget
    if (deleteInFlightRef.current.has(target.id)) return
    deleteInFlightRef.current.add(target.id)
    const requestId = ++deleteRequestRef.current
    const controller = new AbortController()
    deleteAbortRef.current = controller
    setDeletingId(target.id)
    try {
      await agentsApi.deleteTemplateLibraryItem(target.id, controller.signal)
      if (controller.signal.aborted || requestId !== deleteRequestRef.current) return
      toast.success('模板已删除')
      if (previewItem?.id === target.id) setPreviewItem(null)
      setLibrary((current) => ({
        ...current,
        items: current.items.filter((item) => item.id !== target.id),
        total: Math.max(0, current.total - 1),
        summary: {
          ...current.summary,
          totalTemplates: Math.max(0, current.summary.totalTemplates - 1),
          uploadedTemplates: Math.max(0, current.summary.uploadedTemplates - 1),
        },
      }))
      setDeleteTarget(null)
      const currentLibrary = libraryRef.current
      void loadDataRef.current(currentLibrary.page, currentLibrary.pageSize, true)
    } catch (deleteError) {
      if (controller.signal.aborted || requestId !== deleteRequestRef.current) return
      if (mutationResultUncertain(deleteError)) {
        setDeleteTarget(null)
        toast.warning('删除请求超时或网络中断，模板可能已经删除；正在重新读取模板目录')
        reconcileTemplateLibrary()
        return
      }
      toast.error(businessErrorMessage(deleteError, { fallback: '模板删除失败', service: '应用模板库' }))
    } finally {
      if (deleteAbortRef.current === controller) {
        deleteAbortRef.current = null
        deleteInFlightRef.current.delete(target.id)
      }
      if (requestId === deleteRequestRef.current) setDeletingId('')
    }
  }

  const cancelEditWait = () => {
    editRequestRef.current += 1
    editAbortRef.current?.abort()
    editAbortRef.current = null
    saveEditInFlightRef.current = false
    setSavingEdit(false)
    setEditTarget(null)
    toast.warning('已取消保存等待；服务端可能仍在处理中，正在重新读取模板目录')
    reconcileTemplateLibrary()
  }

  const cancelDeleteWait = () => {
    deleteRequestRef.current += 1
    deleteAbortRef.current?.abort()
    deleteAbortRef.current = null
    deleteInFlightRef.current.clear()
    setDeletingId('')
    setDeleteTarget(null)
    toast.warning('已取消删除等待；服务端可能仍在处理中，正在重新读取模板目录')
    reconcileTemplateLibrary()
  }

  return (
    <main className="min-h-screen bg-[#f8f9fb] px-6 py-8 text-slate-900 dark:bg-[#09090b] dark:text-slate-100 lg:px-10">
      <section className="mx-auto max-w-7xl">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <Link href="/agents" className="mb-4 inline-flex min-h-9 items-center gap-2 rounded-[8px] px-3 py-2 text-xs font-bold text-slate-500 transition hover:bg-slate-100 hover:text-blue-600 dark:text-slate-400 dark:hover:bg-white/[0.06]">
              <ArrowLeft size={14} /> 返回智能体框架与应用
            </Link>
            <h1 className="text-4xl font-black text-slate-950 dark:text-white">智能体应用模板库</h1>
            <p className="mt-3 max-w-3xl text-base font-semibold leading-8 text-slate-600 dark:text-slate-300">
              {library.canManage
                ? '上传和管理 Dify DSL 模板文件，支持一次选择多个 YAML 模板。模板库操作不会直接改变当前运行智能体。'
                : '查看、预览和下载 Dify DSL 模板文件；上传、编辑、创建实例和删除由管理员负责。模板库内容不会直接改变当前运行智能体。'}
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void loadData(requestedPage, requestedPageSize, true)}
              disabled={refreshing}
                className="inline-flex items-center justify-center gap-2 rounded-[8px] border border-slate-200 bg-white px-5 py-3 text-sm font-black text-slate-700 shadow-sm transition hover:border-blue-200 hover:text-blue-700 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-slate-200"
            >
              <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
              {refreshing ? '正在刷新' : '刷新'}
            </button>
            {library.canManage ? (
              <button
              type="button"
              onClick={() => uploading ? cancelUploadWait() : templateWritesAllowed && fileInputRef.current?.click()}
              disabled={!uploading && !templateWritesAllowed}
              className="inline-flex items-center justify-center gap-2 rounded-[8px] bg-blue-600 px-5 py-3 text-sm font-black text-white shadow-lg shadow-blue-500/20 transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
                {uploading ? <X size={16} /> : <UploadCloud size={16} />}
                {uploading ? '取消上传等待' : '上传模板'}
              </button>
            ) : (
              <span className="inline-flex items-center rounded-[8px] border border-slate-200 bg-white px-4 py-3 text-xs font-black text-slate-500 dark:border-white/[0.08] dark:bg-white/[0.04]">当前账号只读</span>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept=".yml,.yaml"
              multiple
              disabled={!library.canManage || uploading || !templateWritesAllowed}
              aria-label="选择要上传的 YAML 模板文件"
              className="sr-only"
              onChange={(event) => handleUpload(event.target.files)}
            />
          </div>
        </div>

        <div className="mt-8 flex flex-col gap-3 rounded-[8px] border border-slate-200 bg-white p-4 shadow-sm sm:flex-row sm:items-center dark:border-white/[0.08] dark:bg-white/[0.04]">
          <label className="relative min-w-0 flex-1">
            <Search size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              aria-label="搜索应用模板"
              value={keyword}
              onChange={(event) => handleKeywordChange(event.target.value)}
              placeholder="搜索应用名称、描述、标签或文件名"
              className="h-12 w-full rounded-[8px] border border-slate-200 bg-slate-50 pl-11 pr-4 text-sm font-semibold text-slate-900 outline-none transition focus:border-blue-300 focus:bg-white focus:ring-4 focus:ring-blue-100 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-white dark:focus:ring-blue-500/20"
            />
          </label>
          <UnifiedSelect
            value={source}
            onChange={(value) => handleSourceChange(value as typeof source)}
            ariaLabel="模板来源"
            className="w-full sm:w-40 [&>button]:min-h-12 [&>button]:bg-slate-50 dark:[&>button]:bg-white/[0.04]"
            options={[{ value: '', label: '全部来源' }, { value: 'builtin', label: '内置模板' }, { value: 'uploaded', label: '上传模板' }]}
          />
          <div className="flex flex-wrap items-center gap-2 px-1 text-xs font-bold text-slate-500">
            <span>共 {library.summary.totalTemplates} 个</span>
            <span>内置 {library.summary.builtinTemplates}</span>
            <span>上传 {library.summary.uploadedTemplates}</span>
            <span title={library.generatedAt ? `目录快照更新于 ${generatedAt}` : undefined}>更新 {generatedAt}</span>
          </div>
        </div>

        {error && hasPreviousData ? (
          <div className="mt-4 break-words rounded-[8px] border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
            刷新失败：{error}。{templateSnapshotMatchesView ? '继续显示同一条件下上次成功读取的模板。' : '下方旧模板不代表当前筛选条件，卡片操作和分页暂不可用。'}
          </div>
        ) : null}

        {contextLoading && hasPreviousData ? (
          <div className="mt-4 flex items-center gap-2 border-l-2 border-blue-500 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700 dark:bg-blue-500/10 dark:text-blue-300" role="status">
            <Loader2 size={14} className="animate-spin" />正在更新模板目录，{templateSnapshotMatchesView ? '当前暂时显示同一条件下的上一次成功结果' : '下方旧模板不代表当前筛选条件，卡片操作和分页暂不可用'}
          </div>
        ) : null}

        {contextLoading && !hasPreviousData ? (
          <div className="mt-10 flex min-h-[300px] items-center justify-center rounded-[8px] border border-slate-200 bg-white text-slate-500 dark:border-white/[0.08] dark:bg-white/[0.04]">
            <Loader2 size={24} className="mr-3 animate-spin text-blue-600" />
            正在读取当前条件的模板...
          </div>
        ) : error && !hasPreviousData ? (
          <div className="mt-10 break-words rounded-[8px] border border-rose-200 bg-rose-50 p-6 text-center text-sm font-semibold leading-7 text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-200" role="alert">
            <p className="font-black">应用模板库未取得</p>
            <p className="mt-2">{error}</p>
            <p className="mt-1 text-xs opacity-80">当前没有可展示的成功快照，不按零个模板统计。</p>
            <button type="button" onClick={() => void loadData(requestedPage, requestedPageSize, true)} disabled={refreshing} className="mt-4 inline-flex min-h-9 items-center gap-2 rounded-[8px] border border-rose-200 bg-white px-3 text-xs font-black text-rose-700 disabled:cursor-wait disabled:opacity-50 dark:border-rose-500/30 dark:bg-white/[0.05] dark:text-rose-200">
              {refreshing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}{refreshing ? '正在重新读取' : '重新读取模板库'}
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className="mt-10 rounded-[8px] border border-dashed border-slate-300 bg-white p-10 text-center dark:border-white/[0.12] dark:bg-white/[0.04]">
            <FileCode2 size={34} className="mx-auto text-slate-400" />
            <h2 className="mt-4 text-xl font-black text-slate-900 dark:text-white">暂无模板文件</h2>
            <p className="mt-2 text-sm font-semibold text-slate-500 dark:text-slate-400">{keyword || source ? '调整搜索或来源筛选后重试。' : library.canManage ? '上传 .yml 或 .yaml 文件后会显示在这里。' : '当前模板目录为空，请联系管理员上传模板。'}</p>
          </div>
        ) : (
          <div className="mt-10 grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {items.map((item) => (
              (() => {
                const visibleTags = displayTags(item)
                return (
              <article
                key={item.id}
                className="flex min-h-[260px] flex-col rounded-3xl border border-slate-200 bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:border-blue-200 hover:shadow-lg hover:shadow-blue-100/50 dark:border-white/[0.08] dark:bg-white/[0.04] dark:hover:border-blue-500/30 dark:hover:shadow-none"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[8px] bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300">
                    <FileCode2 size={22} />
                  </div>
                  <span title={item.source === 'builtin' || item.source === 'uploaded' ? undefined : `原始来源：${item.source || '空值'}`} className={`rounded-full px-3 py-1 text-xs font-black ${item.source === 'builtin' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' : item.source === 'uploaded' ? 'bg-slate-100 text-slate-600 dark:bg-white/[0.08] dark:text-slate-300' : 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300'}`}>
                    {sourceLabel(item.source)}
                  </span>
                </div>

                <h2 className="mt-5 line-clamp-2 min-w-0 [overflow-wrap:anywhere] text-xl font-black leading-7 text-slate-950 dark:text-white" title={item.name}>
                  {item.name}
                </h2>
                <p className="mt-3 line-clamp-3 min-h-[4.5rem] min-w-0 [overflow-wrap:anywhere] text-sm font-semibold leading-6 text-slate-500 dark:text-slate-400" title={templateDescription(item, library.canManage)}>
                  {templateDescription(item, library.canManage)}
                </p>

                {visibleTags.length ? <div className="mt-4 flex flex-wrap gap-2">
                  {visibleTags.slice(0, 2).map((tag) => (
                    <span key={tag} className="max-w-full break-all rounded-full bg-slate-100 px-2.5 py-1 text-xs font-black text-slate-600 dark:bg-white/[0.06] dark:text-slate-300">
                      {tag}
                    </span>
                  ))}
                  {visibleTags.length > 2 ? <span className="px-1 py-1 text-xs font-bold text-slate-400">另有 {visibleTags.length - 2} 项</span> : null}
                </div> : null}

                <div className="mt-5 text-xs font-semibold text-slate-400">{sourceTimeLabel(item)}</div>

                <div className="mt-auto grid grid-cols-2 gap-3 pt-5">
                  {library.canManage ? (
                    <button
                      type="button"
                      onClick={() => openCreateDialog(item)}
                      disabled={!templateWritesAllowed || creating}
                      className="col-span-2 inline-flex items-center justify-center gap-2 rounded-[8px] bg-blue-600 px-4 py-3 text-sm font-black text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <Rocket size={16} />
                      创建智能体实例
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => handlePreview(item)}
                    disabled={!templateSnapshotMatchesView || previewLoadingId === item.id}
                    className="inline-flex items-center justify-center gap-2 rounded-[8px] border border-slate-200 px-4 py-3 text-sm font-black text-slate-700 transition hover:border-blue-200 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/[0.08] dark:text-slate-200"
                  >
                    {previewLoadingId === item.id ? <Loader2 size={16} className="animate-spin" /> : <Eye size={16} />}
                    查看 DSL
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDownload(item)}
                    disabled={!templateSnapshotMatchesView || downloadingId === item.id}
                    className="inline-flex items-center justify-center gap-2 rounded-[8px] border border-blue-100 bg-blue-50 px-4 py-3 text-sm font-black text-blue-700 transition hover:border-blue-200 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-300"
                  >
                    {downloadingId === item.id ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                    下载模板
                  </button>
                  {library.canManage && !item.readonly ? (
                    <>
                      <button
                        type="button"
                        onClick={() => openEditDialog(item)}
                        disabled={!templateWritesAllowed}
                        className="inline-flex items-center justify-center gap-2 rounded-[8px] border border-blue-100 bg-blue-50 px-4 py-3 text-sm font-black text-blue-700 transition hover:border-blue-200 hover:bg-blue-100 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-300"
                      >
                        <Pencil size={16} />
                        编辑信息
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (!templateWritesAllowed) {
                            toast.warning('当前模板目录不属于正在查看的筛选条件，请等待重新读取后再删除')
                            return
                          }
                          setDeleteTarget(item)
                        }}
                        disabled={!templateWritesAllowed || deletingId === item.id}
                        className="inline-flex items-center justify-center gap-2 rounded-[8px] border border-rose-200 px-4 py-3 text-sm font-black text-rose-600 transition hover:border-rose-300 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-rose-500/30 dark:text-rose-300 dark:hover:bg-rose-500/10"
                      >
                        {deletingId === item.id ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                        删除
                      </button>
                    </>
                  ) : null}
                </div>
              </article>
                )
              })()
            ))}
          </div>
        )}

        {templatesLoaded && library.total > 0 ? (
          <Pagination
            page={library.page}
            pageSize={library.pageSize}
            total={library.total}
            pageSizeOptions={[6, 12, 18]}
            itemName="个匹配模板"
            loading={loading}
            navigationDisabled={!templateSnapshotMatchesView}
            onPageChange={(page) => { if (templateSnapshotMatchesView) setRequestedPage(page) }}
            onPageSizeChange={(pageSize) => {
              if (!templateSnapshotMatchesView) return
              setRequestedPage(1)
              setRequestedPageSize(pageSize)
            }}
            className="mt-8 rounded-[8px] border border-slate-200 bg-white dark:border-white/[0.08] dark:bg-white/[0.04]"
          />
        ) : null}
      </section>

      <AppDialog
        open={Boolean(previewItem)}
        title={previewItem?.name || '查看 DSL'}
        description={previewItem ? `${previewItem.fileName} · ${sourceLabel(previewItem.source)}` : undefined}
        onClose={() => {
          previewRequestRef.current += 1
          previewAbortRef.current?.abort()
          previewAbortRef.current = null
          setPreviewLoadingId('')
          setPreviewItem(null)
        }}
        maxWidth="max-w-5xl"
        bodyClassName="pb-4"
        footer={previewItem ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={handleCopyDsl}
              className="inline-flex items-center justify-center gap-2 rounded-[8px] border border-slate-200 px-5 py-3 text-sm font-black text-slate-700 transition hover:border-blue-200 hover:text-blue-700 dark:border-white/[0.08] dark:text-slate-200"
            >
              <Copy size={16} />
              复制内容
            </button>
            <button
              type="button"
              onClick={() => handleDownload(previewItem)}
              disabled={downloadingId === previewItem.id}
              className="inline-flex items-center justify-center gap-2 rounded-[8px] bg-blue-600 px-5 py-3 text-sm font-black text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {downloadingId === previewItem.id ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
              {downloadingId === previewItem.id ? '正在下载' : '下载模板'}
            </button>
          </div>
        ) : null}
      >
        <div className="mb-3 border-l-2 border-blue-400 bg-blue-50 px-3 py-2 text-xs font-semibold leading-5 text-blue-800 dark:bg-blue-500/10 dark:text-blue-200">
          为保护运行凭证，预览、复制和下载不会包含密钥明文；导入 Dify 后请重新配置 Secret 类型变量。
        </div>
        <YamlPreview key={previewItem?.id || 'empty'} content={previewItem?.dslContent || ''} />
      </AppDialog>

      <AppDialog
        open={Boolean(createTarget)}
        title="从模板创建智能体实例"
        description={createTarget ? `实例将保存「${createTarget.fileName}」当前 DSL 的独立快照，之后模板修改或删除不会改变该实例。` : undefined}
        onClose={() => { if (creating) cancelCreateWait(); else closeCreateDialog() }}
        closeOnOverlay={!creating}
        showClose
        maxWidth="max-w-2xl"
        footer={createTarget ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={() => creating ? cancelCreateWait() : closeCreateDialog()}
              className="inline-flex items-center justify-center rounded-[8px] border border-slate-200 px-5 py-3 text-sm font-black text-slate-700 transition hover:border-blue-200 hover:text-blue-700 dark:border-white/[0.08] dark:text-slate-200"
            >
              {creating ? '取消等待' : '取消'}
            </button>
            <button
              type="button"
              onClick={handleCreateInstance}
              disabled={creating || !createForm.name.trim()}
              className="inline-flex items-center justify-center gap-2 rounded-[8px] bg-blue-600 px-5 py-3 text-sm font-black text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {creating ? <Loader2 size={16} className="animate-spin" /> : <Rocket size={16} />}
              {creating ? '正在创建' : '创建实例'}
            </button>
          </div>
        ) : null}
      >
        <fieldset disabled={creating} className="space-y-5">
          <label className="block space-y-2">
            <span className="text-sm font-black text-slate-700 dark:text-slate-200">实例名称</span>
            <input
              value={createForm.name}
              onChange={(event) => setCreateForm((form) => ({ ...form, name: event.target.value }))}
              className="w-full rounded-[8px] border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-900 outline-none transition focus:border-blue-300 focus:ring-4 focus:ring-blue-100 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-white dark:focus:ring-blue-500/20"
              maxLength={120}
            />
          </label>
          <label className="block space-y-2">
            <span className="text-sm font-black text-slate-700 dark:text-slate-200">用途说明</span>
            <textarea
              value={createForm.description}
              onChange={(event) => setCreateForm((form) => ({ ...form, description: event.target.value }))}
              className="min-h-28 w-full resize-y rounded-[8px] border border-slate-200 bg-white px-4 py-3 text-sm font-semibold leading-7 text-slate-900 outline-none transition focus:border-blue-300 focus:ring-4 focus:ring-blue-100 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-white dark:focus:ring-blue-500/20"
              placeholder="说明该实例的用途和适用场景"
              maxLength={500}
            />
          </label>
          <label className="flex items-start gap-3 rounded-[8px] border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-slate-200">
            <input
              type="checkbox"
              checked={createForm.enabled}
              onChange={(event) => setCreateForm((form) => ({ ...form, enabled: event.target.checked }))}
              className="mt-0.5 h-4 w-4 shrink-0 accent-blue-600"
            />
            <span>创建后启用实例。模板实例还需在实例管理中绑定已发布的 Dify 应用与 API 密钥后才能真实调用。</span>
          </label>
        </fieldset>
      </AppDialog>

      <AppDialog
        open={Boolean(editTarget)}
        title="编辑模板信息"
        description={editTarget ? `只更新「${editTarget.fileName}」的展示信息，不修改 YAML 文件内容。` : undefined}
        onClose={() => { if (savingEdit) cancelEditWait(); else closeEditDialog() }}
        closeOnOverlay={!savingEdit}
        showClose
        maxWidth="max-w-2xl"
        initialFocusRef={editNameRef}
        footer={editTarget ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={() => savingEdit ? cancelEditWait() : closeEditDialog()}
              className="inline-flex items-center justify-center rounded-[8px] border border-slate-200 px-5 py-3 text-sm font-black text-slate-700 transition hover:border-blue-200 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/[0.08] dark:text-slate-200"
            >
              {savingEdit ? '取消等待' : '取消'}
            </button>
            <button
              type="button"
              onClick={handleSaveEdit}
              disabled={savingEdit}
              className="inline-flex items-center justify-center gap-2 rounded-[8px] bg-blue-600 px-5 py-3 text-sm font-black text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {savingEdit ? <Loader2 size={16} className="animate-spin" /> : <Pencil size={16} />}
              保存信息
            </button>
          </div>
        ) : null}
      >
        <div className="space-y-5">
          <div>
            <label htmlFor="agent-template-edit-name" className="text-sm font-black text-slate-700 dark:text-slate-200">应用名称</label>
            <input
              ref={editNameRef}
              id="agent-template-edit-name"
              value={editForm.name}
              onChange={(event) => setEditForm((form) => ({ ...form, name: event.target.value }))}
              disabled={savingEdit}
              className="mt-2 w-full rounded-[8px] border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-900 outline-none transition focus:border-blue-300 focus:ring-4 focus:ring-blue-100 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-white dark:focus:ring-blue-500/20"
              placeholder="例如：智慧家居统一 Chatflow"
              maxLength={120}
            />
          </div>
          <div>
            <label htmlFor="agent-template-edit-description" className="text-sm font-black text-slate-700 dark:text-slate-200">描述</label>
            <textarea
              id="agent-template-edit-description"
              value={editForm.description}
              onChange={(event) => setEditForm((form) => ({ ...form, description: event.target.value }))}
              disabled={savingEdit}
              className="mt-2 min-h-28 w-full resize-y rounded-[8px] border border-slate-200 bg-white px-4 py-3 text-sm font-semibold leading-7 text-slate-900 outline-none transition focus:border-blue-300 focus:ring-4 focus:ring-blue-100 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-white dark:focus:ring-blue-500/20"
              placeholder="填写模板用途、适配场景或主要能力"
              maxLength={500}
            />
          </div>
          <div>
            <label htmlFor="agent-template-edit-tags" className="text-sm font-black text-slate-700 dark:text-slate-200">标签</label>
            <input
              id="agent-template-edit-tags"
              value={editForm.tagsText}
              onChange={(event) => setEditForm((form) => ({ ...form, tagsText: event.target.value }))}
              disabled={savingEdit}
              className="mt-2 w-full rounded-[8px] border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-900 outline-none transition focus:border-blue-300 focus:ring-4 focus:ring-blue-100 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-white dark:focus:ring-blue-500/20"
              placeholder="用逗号分隔，例如：Chatflow，设备控制，知识问答"
            />
            <span className="mt-2 block text-xs font-semibold text-slate-400">多个标签可用中文逗号、英文逗号或换行分隔。</span>
          </div>
        </div>
      </AppDialog>

      <AppDialog
        open={Boolean(deleteTarget)}
        title="删除上传模板"
        description={deleteTarget ? `将从模板库中删除「${deleteTarget.name}」。内置 00 模板和智能体实例不会受影响。` : undefined}
        onClose={() => { if (deletingId) cancelDeleteWait(); else setDeleteTarget(null) }}
        closeOnOverlay={!deletingId}
        showClose
        maxWidth="max-w-md"
        danger
        footer={deleteTarget ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={() => deletingId ? cancelDeleteWait() : setDeleteTarget(null)}
              className="inline-flex items-center justify-center rounded-[8px] border border-slate-200 px-5 py-3 text-sm font-black text-slate-700 transition hover:border-blue-200 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/[0.08] dark:text-slate-200"
            >
              {deletingId ? '取消等待' : '取消'}
            </button>
            <button
              type="button"
              onClick={handleConfirmDelete}
              disabled={deletingId === deleteTarget.id}
              className="inline-flex items-center justify-center gap-2 rounded-[8px] bg-rose-600 px-5 py-3 text-sm font-black text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {deletingId === deleteTarget.id ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
              确认删除
            </button>
          </div>
        ) : null}
      >
        <div className="flex gap-4 rounded-[8px] border border-rose-100 bg-rose-50 p-4 text-sm font-semibold leading-7 text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-200">
          <AlertTriangle size={20} className="mt-1 shrink-0" />
          <p>删除后该 YAML 记录将不再显示在模板库中。如需恢复，需要重新上传本地模板文件。</p>
        </div>
      </AppDialog>
    </main>
  )
}

export default function AgentTemplatesPage() {
  return <Suspense fallback={null}><AgentTemplatesContent /></Suspense>
}
