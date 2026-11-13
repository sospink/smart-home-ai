'use client'

/**
 * 知识库管理 · 列表页
 * 展示 Dify 中所有 Dataset，支持筛选、新建、进入详情、删除、排序、分页
 */

import { Suspense, useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import {
  Plus, FileText, Folder, Scale, ChevronDown, ListFilter, Loader2,
  Database, BookOpen, Trash2, ChevronUp, Search, Copy, Check, Settings, RefreshCw,
} from 'lucide-react'
import { motion, AnimatePresence } from 'motion/react'
import { ApiError } from '@/lib/api/client'
import {
  createDataset,
  deleteDataset,
  fetchDatasets,
  type KnowledgeDataset,
} from '@/lib/api/knowledge'
import { useAuth } from '@/lib/hooks/useAuth'
import { InlineToast } from '@/components/ui/InlineToast'
import { AppDialog } from '@/components/ui/AppDialog'
import { Pagination } from '@/components/ui/Pagination'
import { TechnicalId } from '@/components/ui/TechnicalId'
import { copyTextToClipboard } from '@/lib/clipboard'
import { businessErrorMessage } from '@/lib/ui/business-error'

type KnowledgeIcon = typeof FileText

/* ── Types ── */
type Dataset = KnowledgeDataset

/* ── Helpers ── */
function formatWordCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}m`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`
  return String(count)
}

const KB_ICONS = [
  { icon: FileText, bg: 'bg-blue-50 dark:bg-blue-500/10', color: 'text-blue-600 dark:text-blue-400' },
  { icon: Database, bg: 'bg-emerald-50 dark:bg-emerald-500/10', color: 'text-emerald-600 dark:text-emerald-400' },
  { icon: Folder, bg: 'bg-slate-50 dark:bg-white/[0.05]', color: 'text-slate-600 dark:text-slate-400' },
  { icon: BookOpen, bg: 'bg-orange-50 dark:bg-orange-500/10', color: 'text-orange-600 dark:text-orange-400' },
  { icon: Scale, bg: 'bg-purple-50 dark:bg-purple-500/10', color: 'text-purple-600 dark:text-purple-400' },
]

const SORT_OPTIONS = [
  { id: 'created_desc', label: '创建时间（最新）' },
  { id: 'created_asc', label: '创建时间（最早）' },
  { id: 'updated_desc', label: '更新时间（最新）' },
  { id: 'name_asc', label: '名称（A-Z）' },
  { id: 'docs_desc', label: '文档数量（最多）' },
  { id: 'words_desc', label: '词数（最多）' },
] as const

type DatasetSort = (typeof SORT_OPTIONS)[number]['id']

function getErrorMessage(error: unknown, fallback: string) {
  return businessErrorMessage(error, { fallback, service: 'Dify 知识库' })
}

function displayDatasetDescription(description: string) {
  const value = description.trim()
  if (!value) return '暂无描述'
  if (/^useful for when you want to answer queries about/i.test(value)) return '已接入知识资料，可用于语义检索与智慧家居问答。'
  if (!/[\u4e00-\u9fff]/.test(value)) return '已接入知识资料，可用于语义检索与问答。'
  return value
}

/* ── KB card component (保留原有样式) ── */
function KBCard({
  id, title, description, sourceDescription, docCount, tokenCount, status, appCount, embeddingAvailable, embeddingModel,
  icon: Icon, iconBg, iconColor, canManage, interactionDisabled, managementDisabled, onDelete,
}: {
  id: string
  title: string
  description: string
  sourceDescription: string
  docCount: string
  tokenCount: string
  status: 'HAS_DOCUMENTS' | 'EMPTY'
  appCount: number
  embeddingAvailable: boolean
  embeddingModel: string | null
  icon: KnowledgeIcon
  iconBg: string
  iconColor: string
  canManage: boolean
  interactionDisabled: boolean
  managementDisabled: boolean
  onDelete: () => void
}) {
  const [showTechnical, setShowTechnical] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const statusColors: Record<string, string> = {
    HAS_DOCUMENTS: 'bg-emerald-50 text-emerald-500 dark:bg-emerald-500/10 dark:text-emerald-400',
    EMPTY: 'bg-slate-50 text-slate-400 dark:bg-white/[0.05] dark:text-slate-500',
  }
  const statusLabels: Record<string, string> = {
    HAS_DOCUMENTS: '包含文档', EMPTY: '空知识库',
  }
  const dotColors: Record<string, string> = {
    HAS_DOCUMENTS: 'bg-emerald-500', EMPTY: 'bg-slate-300 dark:bg-slate-600',
  }

  return (
    <motion.div
      whileHover={{ y: -4 }}
      className="bg-white dark:bg-transparent dark:bg-gradient-to-b dark:from-white/[0.06] dark:to-white/[0.02] p-8 rounded-2xl border border-slate-100 dark:border-white/[0.06] shadow-sm hover:shadow-xl hover:shadow-slate-200/50 dark:hover:shadow-blue-500/10 transition-all group h-full relative"
    >
      <Link
        href={`/knowledge/${id}`}
        style={{ textDecoration: 'none' }}
        onClick={(event) => { if (interactionDisabled) event.preventDefault() }}
        aria-disabled={interactionDisabled}
        tabIndex={interactionDisabled ? -1 : undefined}
        className={`block ${interactionDisabled ? 'cursor-not-allowed opacity-75' : ''}`}
      >
        <div className="flex justify-between items-start mb-8">
          <div className={`w-12 h-12 ${iconBg} ${iconColor} rounded-2xl flex items-center justify-center shadow-sm`}>
            <Icon size={24} />
          </div>
          <div className={`flex items-center gap-2 ${canManage ? 'mr-8' : ''}`}>
            <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full ${statusColors[status]}`}>
              <div className={`w-1.5 h-1.5 rounded-full ${dotColors[status]}`} />
              <span className="text-xs font-bold">{statusLabels[status]}</span>
            </div>
          </div>
        </div>

        <h3 title={title} className="min-h-14 line-clamp-2 break-words text-xl font-black leading-7 text-slate-900 transition-colors group-hover:text-blue-600 dark:text-white">{title}</h3>
        <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed mb-10 line-clamp-2 font-medium" title={description}>
          {description}
        </p>

        <div className="grid grid-cols-2 gap-8 pt-6 border-t border-slate-50 dark:border-white/[0.06]">
          <div>
            <p className="mb-2 text-xs font-bold text-slate-400 dark:text-slate-500">文档数量</p>
            <p className="text-2xl font-black text-slate-900 dark:text-white">{docCount}</p>
          </div>
          <div>
            <p className="mb-2 text-xs font-bold text-slate-400 dark:text-slate-500">词数统计</p>
            <p className="text-2xl font-black text-slate-900 dark:text-white">{tokenCount}</p>
          </div>
        </div>
      </Link>

      {canManage ? (
        <button
          type="button"
          title={`删除知识库：${title}`}
          aria-label={`删除知识库：${title}`}
          onClick={onDelete}
          disabled={managementDisabled}
          className="absolute right-8 top-8 flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 text-slate-300 opacity-0 transition-all hover:bg-red-50 hover:text-red-500 focus:opacity-100 group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-20 dark:bg-white/[0.06] dark:text-slate-600 dark:hover:bg-red-500/10"
        >
          <Trash2 size={15} />
        </button>
      ) : null}

      <div className="mt-5 border-t border-slate-50 pt-4 dark:border-white/[0.06]">
        <button
          type="button"
          onClick={() => setShowTechnical((value) => !value)}
          disabled={interactionDisabled}
          aria-expanded={showTechnical}
          className="flex min-h-9 w-full items-center justify-between text-xs font-bold text-slate-400 transition-colors hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200"
        >
          <span className="inline-flex items-center gap-2"><Settings size={14} />技术详情</span>
          {showTechnical ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
        {showTechnical ? (
          <div className="mt-3 space-y-2 rounded-[8px] bg-slate-50 px-4 py-3 text-xs dark:bg-white/[0.04]">
            <div className="flex items-center justify-between gap-3">
              <span className="font-bold text-slate-400 dark:text-slate-500">知识库 ID</span>
              <button
                type="button"
                title={copied ? '知识库 ID 已复制' : copyFailed ? '复制失败，请手动选择知识库 ID' : '复制知识库 ID'}
                aria-label={copied ? '知识库 ID 已复制' : copyFailed ? '知识库 ID 复制失败' : '复制知识库 ID'}
                onClick={async () => {
                  const success = await copyTextToClipboard(id)
                  setCopied(success)
                  setCopyFailed(!success)
                  window.setTimeout(() => {
                    setCopied(false)
                    setCopyFailed(false)
                  }, 1500)
                }}
                className="inline-flex min-w-0 items-center gap-2 font-black text-slate-700 dark:text-slate-200"
              >
                <span className="max-w-[150px] truncate" title={id}>{id}</span>
                {copied ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} className={copyFailed ? 'text-rose-500' : undefined} />}
              </button>
            </div>
            {sourceDescription && sourceDescription !== description ? (
              <div className="space-y-1 border-t border-slate-200/70 pt-2 dark:border-white/[0.06]">
                <span className="font-bold text-slate-400 dark:text-slate-500">原始描述</span>
                <p className="break-words font-medium leading-5 text-slate-600 dark:text-slate-300">{sourceDescription}</p>
              </div>
            ) : null}
            <div className="flex items-center justify-between gap-3">
              <span className="font-bold text-slate-400 dark:text-slate-500">向量模型</span>
              <span title={embeddingModel || ''} className={`max-w-[150px] truncate font-black ${embeddingAvailable ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
                {embeddingAvailable ? (embeddingModel || '已启用') : '未确认'}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="font-bold text-slate-400 dark:text-slate-500">关联应用</span>
              <span className="font-black text-slate-700 dark:text-slate-200">{appCount} 个</span>
            </div>
          </div>
        ) : null}
      </div>
    </motion.div>
  )
}

/* ── Create Dataset Dialog ── */
function CreateDialog({ onClose, onSuccess }: { onClose: (verify?: boolean) => void; onSuccess: () => void }) {
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const submittingRef = useRef(false)
  const requestSequenceRef = useRef(0)
  const abortControllerRef = useRef<AbortController | null>(null)
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  const closeDialog = () => {
    const verify = loading
    requestSequenceRef.current += 1
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
    submittingRef.current = false
    onClose(verify)
  }

  useEffect(() => () => {
    requestSequenceRef.current += 1
    abortControllerRef.current?.abort()
  }, [])

  const handleCreate = async () => {
    if (!name.trim() || submittingRef.current) return
    submittingRef.current = true
    const sequence = ++requestSequenceRef.current
    const controller = new AbortController()
    abortControllerRef.current = controller
    try {
      setLoading(true)
      setError('')
      await createDataset({ name: name.trim(), description: desc.trim() }, controller.signal)
      if (sequence !== requestSequenceRef.current) return
      onSuccess()
      onClose()
    } catch (requestError) {
      if (sequence !== requestSequenceRef.current) return
      if (controller.signal.aborted) {
        setError('已取消创建等待；Dify 可能仍在处理中，请刷新列表确认后再重试')
        return
      }
      setError(getErrorMessage(requestError, '创建知识库失败'))
    } finally {
      if (abortControllerRef.current === controller) abortControllerRef.current = null
      if (sequence === requestSequenceRef.current) {
        submittingRef.current = false
        setLoading(false)
      }
    }
  }

  return (
    <AppDialog
      title="新建知识库"
      onClose={closeDialog}
      closeOnOverlay={!loading}
      showClose
      maxWidth="max-w-md"
      initialFocusRef={nameInputRef}
      footer={(
        <div className="flex gap-3">
          <button onClick={closeDialog} className="flex-1 py-3 bg-slate-100 dark:bg-white/[0.05] text-slate-600 dark:text-slate-300 rounded-[8px] text-sm font-bold hover:bg-slate-200 dark:hover:bg-white/[0.04] transition-colors">{loading ? '取消等待' : '取消'}</button>
          <button onClick={handleCreate} disabled={!name.trim() || loading}
            className="flex-1 py-3 bg-blue-600 text-white rounded-[8px] text-sm font-bold disabled:opacity-50 hover:bg-blue-700 transition-colors flex items-center justify-center gap-2">
            {loading && <Loader2 size={14} className="animate-spin" />} {loading ? '正在创建' : '创建'}
          </button>
        </div>
      )}
    >
        <div className="space-y-4">
          {error ? <div className="rounded-[8px] bg-red-50 px-4 py-3 text-xs font-semibold text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</div> : null}
          <div>
            <label htmlFor="knowledge-create-name" className="mb-2 block text-xs font-bold text-slate-500 dark:text-slate-400">知识库名称</label>
            <input ref={nameInputRef} id="knowledge-create-name" value={name} onChange={e => setName(e.target.value)} placeholder="输入知识库名称"
              disabled={loading} className="w-full bg-slate-50 dark:bg-white/[0.05] border-none rounded-[8px] py-3 px-4 text-sm font-medium text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:ring-2 focus:ring-blue-500/20 outline-none" />
          </div>
          <div>
            <label htmlFor="knowledge-create-description" className="mb-2 block text-xs font-bold text-slate-500 dark:text-slate-400">描述（可选）</label>
            <textarea id="knowledge-create-description" value={desc} onChange={e => setDesc(e.target.value)} placeholder="描述知识库的用途..." rows={3}
              disabled={loading} className="w-full bg-slate-50 dark:bg-white/[0.05] border-none rounded-[8px] py-3 px-4 text-sm font-medium text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:ring-2 focus:ring-blue-500/20 outline-none resize-none" />
          </div>
        </div>
    </AppDialog>
  )
}

/* ── Delete Confirm Dialog ── */
function DeleteConfirm({ name, onClose, onConfirm }: { name: string; onClose: (verify?: boolean) => void; onConfirm: (signal: AbortSignal) => Promise<void> }) {
  const [loading, setLoading] = useState(false)
  const submittingRef = useRef(false)
  const requestSequenceRef = useRef(0)
  const abortControllerRef = useRef<AbortController | null>(null)
  const closeDialog = () => {
    const verify = loading
    requestSequenceRef.current += 1
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
    submittingRef.current = false
    onClose(verify)
  }
  useEffect(() => () => {
    requestSequenceRef.current += 1
    abortControllerRef.current?.abort()
  }, [])
  const confirmDelete = async () => {
    if (submittingRef.current) return
    submittingRef.current = true
    const sequence = ++requestSequenceRef.current
    const controller = new AbortController()
    abortControllerRef.current = controller
    try {
      setLoading(true)
      await onConfirm(controller.signal)
    } finally {
      if (abortControllerRef.current === controller) abortControllerRef.current = null
      if (sequence === requestSequenceRef.current) {
        submittingRef.current = false
        setLoading(false)
      }
    }
  }
  return (
    <AppDialog
      title="确认删除"
      onClose={closeDialog}
      closeOnOverlay={!loading}
      showClose
      maxWidth="max-w-sm"
      danger
      footer={(
        <div className="flex gap-3">
          <button onClick={closeDialog} className="flex-1 py-3 bg-slate-100 dark:bg-white/[0.05] text-slate-600 dark:text-slate-300 rounded-[8px] text-sm font-bold">{loading ? '取消等待' : '取消'}</button>
          <button onClick={() => void confirmDelete()} disabled={loading}
            className="flex-1 py-3 bg-red-600 text-white rounded-[8px] text-sm font-bold disabled:opacity-50 flex items-center justify-center gap-2">
            {loading && <Loader2 size={14} className="animate-spin" />} {loading ? '正在删除' : '删除'}
          </button>
        </div>
      )}
    >
      <div className="space-y-5">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          确定要删除知识库「<span className="font-bold text-slate-900 dark:text-white">{name}</span>」吗？此操作会删除 Dify 中的知识库及其全部文档数据，且不可撤销。
        </p>
        <div className="rounded-[8px] bg-red-50 px-4 py-3 text-xs font-semibold leading-5 text-red-700 dark:bg-red-500/10 dark:text-red-300">
          删除前请确认该知识库未绑定到目标环境的知识检索工作流。
        </div>
      </div>
    </AppDialog>
  )
}

/* ══════════════════════════════════════════════
   Knowledge Base List Page
   ══════════════════════════════════════════════ */

function KnowledgeBaseContent() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { isAdmin, loading: authLoading } = useAuth()
  const [activeTab, setActiveTab] = useState(() => ['recent', 'shared'].includes(searchParams.get('scope') || '') ? searchParams.get('scope')! : 'all')
  const [datasets, setDatasets] = useState<Dataset[]>([])
  const [datasetsLoaded, setDatasetsLoaded] = useState(false)
  const [loadedDatasetViewKey, setLoadedDatasetViewKey] = useState('')
  const [loadedDatasetPage, setLoadedDatasetPage] = useState(1)
  const [loadedDatasetSize, setLoadedDatasetSize] = useState(9)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(() => {
    const value = Number(searchParams.get('page') || 1)
    return Number.isInteger(value) && value > 0 ? value : 1
  })
  const [pageSize, setPageSize] = useState(() => {
    const value = Number(searchParams.get('size') || 9)
    return [9, 18, 36].includes(value) ? value : 9
  })
  const [showCreate, setShowCreate] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Dataset | null>(null)
  const [sortBy, setSortBy] = useState<DatasetSort>(() => {
    const value = searchParams.get('sort')
    return SORT_OPTIONS.some(option => option.id === value) ? value as DatasetSort : 'created_desc'
  })
  const [showSortMenu, setShowSortMenu] = useState(false)
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)
  const [loadError, setLoadError] = useState('')
  const [keyword, setKeyword] = useState(() => searchParams.get('q') || '')
  const [debouncedKeyword, setDebouncedKeyword] = useState(() => (searchParams.get('q') || '').trim())
  const [searchSettled, setSearchSettled] = useState(true)
  const [inventoryTotal, setInventoryTotal] = useState(0)
  const [snapshotMeta, setSnapshotMeta] = useState<{ snapshotAt: number; status: 'live' | 'fresh' | 'stale'; cacheTtlSeconds: number } | null>(null)
  const [snapshotNotice, setSnapshotNotice] = useState<{ snapshotAt: number; error: string } | null>(null)
  const [viewVersion, setViewVersion] = useState(0)
  const requestSequence = useRef(0)
  const datasetAbortRef = useRef<AbortController | null>(null)
  const refreshInFlightRef = useRef(false)
  const deleteInFlightRef = useRef(false)
  const mutationReconcileRef = useRef(0)
  const mutationReconcileTimerRef = useRef<number | null>(null)
  const writtenSearchRef = useRef(searchParams.toString())

  const tabs = [
    { id: 'all', label: '全部知识库' },
    { id: 'recent', label: '最近更新' },
    { id: 'shared', label: '团队共享' },
  ]

  const effectiveSort = activeTab === 'recent' ? 'updated_desc' : sortBy
  const permission = activeTab === 'shared' ? 'all_team_members' as const : '' as const
  const datasetViewKey = JSON.stringify({ scope: activeTab, keyword: debouncedKeyword, sort: effectiveSort, page, size: pageSize })
  const datasetSnapshotMatchesView = Boolean(datasetsLoaded && searchSettled && keyword.trim() === debouncedKeyword && loadedDatasetViewKey === datasetViewKey)
  const datasetWritable = datasetSnapshotMatchesView && !loading && !loadError && !snapshotNotice

  const invalidateDatasetView = () => {
    requestSequence.current += 1
    datasetAbortRef.current?.abort()
    datasetAbortRef.current = null
    setLoadError('')
    setLoading(true)
    setViewVersion(version => version + 1)
  }

  const loadDatasets = useCallback(async (p = page, force = false) => {
    if (!searchSettled || keyword.trim() !== debouncedKeyword) return
    datasetAbortRef.current?.abort()
    const sequence = ++requestSequence.current
    const controller = new AbortController()
    datasetAbortRef.current = controller
    try {
      setLoading(true)
      const data = await fetchDatasets({
        page: p,
        limit: pageSize,
        keyword: debouncedKeyword,
        permission,
        sort: effectiveSort,
      }, force, controller.signal)
      if (sequence !== requestSequence.current) return
      setDatasets(data.datasets || [])
      setDatasetsLoaded(true)
      setLoadedDatasetPage(data.page || p)
      setLoadedDatasetSize(pageSize)
      setLoadedDatasetViewKey(JSON.stringify({ scope: activeTab, keyword: debouncedKeyword, sort: effectiveSort, page: data.page || p, size: pageSize }))
      setLoadError('')
      setSnapshotMeta(data.snapshot ? {
        snapshotAt: data.snapshot.snapshot_at,
        status: data.snapshot.status,
        cacheTtlSeconds: data.cache_ttl_seconds || 0,
      } : null)
      setSnapshotNotice(data.snapshot?.stale ? {
        snapshotAt: data.snapshot.snapshot_at,
        error: data.snapshot.error,
      } : null)
      setTotal(data.total || 0)
      setInventoryTotal(data.summary?.total ?? data.total ?? 0)
      setPage(data.page || p)
    } catch (error) {
      if (controller.signal.aborted) return
      if (sequence !== requestSequence.current) return
      const message = getErrorMessage(error, '获取知识库列表失败')
      setLoadError(message)
      setToast({ message, type: 'error' })
    } finally {
      if (datasetAbortRef.current === controller) datasetAbortRef.current = null
      if (sequence === requestSequence.current) setLoading(false)
    }
  }, [activeTab, debouncedKeyword, effectiveSort, keyword, page, pageSize, permission, searchSettled])

  useEffect(() => {
    if (searchSettled && keyword.trim() === debouncedKeyword) return
    const timer = window.setTimeout(() => {
      setDebouncedKeyword(keyword.trim())
      setSearchSettled(true)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [debouncedKeyword, keyword, searchSettled])

  useEffect(() => {
    if (pathname !== '/knowledge') return
    const url = new URL(window.location.href)
    const values: Record<string, string> = {
      scope: activeTab === 'all' ? '' : activeTab,
      q: keyword.trim(),
      sort: sortBy === 'created_desc' ? '' : sortBy,
      page: page === 1 ? '' : String(page),
      size: pageSize === 9 ? '' : String(pageSize),
    }
    Object.entries(values).forEach(([key, value]) => {
      if (value) url.searchParams.set(key, value)
      else url.searchParams.delete(key)
    })
    const nextSearch = url.searchParams.toString()
    writtenSearchRef.current = nextSearch
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }, [activeTab, keyword, page, pageSize, pathname, sortBy])

  useEffect(() => {
    if (pathname !== '/knowledge') return
    const nextSearch = searchParams.toString()
    if (nextSearch === writtenSearchRef.current) return
    writtenSearchRef.current = nextSearch
    const nextKeyword = searchParams.get('q') || ''
    const rawScope = searchParams.get('scope') || ''
    const nextScope = ['recent', 'shared'].includes(rawScope) ? rawScope : 'all'
    const rawSort = searchParams.get('sort')
    const nextSort = SORT_OPTIONS.some(option => option.id === rawSort) ? rawSort as DatasetSort : 'created_desc'
    const rawPage = Number(searchParams.get('page') || 1)
    const nextPage = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1
    const rawSize = Number(searchParams.get('size') || 9)
    const nextSize = [9, 18, 36].includes(rawSize) ? rawSize : 9
    invalidateDatasetView()
    setKeyword(nextKeyword)
    setDebouncedKeyword(nextKeyword.trim())
    setSearchSettled(true)
    setActiveTab(nextScope)
    setSortBy(nextSort)
    setPage(nextPage)
    setPageSize(nextSize)
  }, [pathname, searchParams])

  useEffect(() => {
    void viewVersion
    void loadDatasets()
  }, [loadDatasets, viewVersion])

  useEffect(() => {
    if (!loadError && !snapshotNotice) return
    const recoverDatasetRead = () => {
      if (!navigator.onLine || document.hidden || datasetAbortRef.current) return
      void loadDatasets(page, true)
    }
    const handleVisibilityChange = () => {
      if (!document.hidden) recoverDatasetRead()
    }
    window.addEventListener('online', recoverDatasetRead)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('online', recoverDatasetRead)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [loadDatasets, loadError, page, snapshotNotice])

  useEffect(() => () => {
    requestSequence.current += 1
    datasetAbortRef.current?.abort()
    datasetAbortRef.current = null
    refreshInFlightRef.current = false
    deleteInFlightRef.current = false
    mutationReconcileRef.current += 1
    if (mutationReconcileTimerRef.current !== null) window.clearTimeout(mutationReconcileTimerRef.current)
  }, [])

  const reconcileDatasets = (requestedPage = page) => {
    const reconcileId = ++mutationReconcileRef.current
    if (mutationReconcileTimerRef.current !== null) window.clearTimeout(mutationReconcileTimerRef.current)
    void loadDatasets(requestedPage, true).finally(() => {
      if (mutationReconcileRef.current !== reconcileId) return
      mutationReconcileTimerRef.current = window.setTimeout(() => {
        if (mutationReconcileRef.current !== reconcileId) return
        mutationReconcileTimerRef.current = null
        void loadDatasets(requestedPage, true)
      }, 1200)
    })
  }

  const mutationResultUncertain = (error: unknown) => (
    error instanceof ApiError && error.status === 0
    || error instanceof Error && /超时|网络中断|无法连接|network|timeout/i.test(error.message)
  )

  const handleRefresh = async () => {
    if (refreshInFlightRef.current) return
    refreshInFlightRef.current = true
    setRefreshing(true)
    try {
      await loadDatasets(page, true)
    } finally {
      refreshInFlightRef.current = false
      setRefreshing(false)
    }
  }

  const handleDelete = async (ds: Dataset, signal: AbortSignal) => {
    if (!isAdmin) {
      setToast({ message: '仅管理员可删除知识库', type: 'error' })
      return
    }
    if (!datasetWritable) {
      setToast({ message: 'Dify 实时列表当前不可用，请刷新成功后再删除知识库', type: 'error' })
      return
    }
    if (deleteInFlightRef.current) return
    deleteInFlightRef.current = true
    try {
      await deleteDataset(ds.id, signal)
      if (signal.aborted) return
      setToast({ message: `「${ds.name}」已删除`, type: 'success' })
      setDeleteTarget(null)
      void loadDatasets(page, true)
    } catch (error) {
      if (signal.aborted) return
      if (mutationResultUncertain(error)) {
        setDeleteTarget(null)
        setToast({ message: '删除请求超时或网络中断，知识库可能已经删除；正在重新读取最终列表', type: 'error' })
        reconcileDatasets(page)
        return
      }
      setToast({ message: getErrorMessage(error, '删除失败'), type: 'error' })
    } finally {
      deleteInFlightRef.current = false
    }
  }

  const displayDatasets = datasets
  const currentSortLabel = SORT_OPTIONS.find(s => s.id === effectiveSort)?.label || '创建时间'

  return (
    <div className="max-w-7xl mx-auto space-y-10">
      <AnimatePresence>{toast && <InlineToast message={toast.message} tone={toast.type} onClose={() => setToast(null)} />}</AnimatePresence>
      <AnimatePresence>{showCreate && isAdmin && datasetWritable && <CreateDialog onClose={(verify) => { setShowCreate(false); if (verify) { setToast({ message: '已取消创建等待；Dify 可能仍在处理中，正在重新读取知识库列表', type: 'error' }); reconcileDatasets(page) } }} onSuccess={() => { setPage(1); reconcileDatasets(1); setToast({ message: '知识库创建成功', type: 'success' }) }} />}</AnimatePresence>
      <AnimatePresence>{deleteTarget && isAdmin && datasetWritable && <DeleteConfirm name={deleteTarget.name} onClose={(verify) => { setDeleteTarget(null); if (verify) { setToast({ message: '已取消删除等待；Dify 可能仍在处理中，正在重新读取知识库列表', type: 'error' }); reconcileDatasets(page) } }} onConfirm={(signal) => handleDelete(deleteTarget, signal)} />}</AnimatePresence>

      {/* Header */}
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-start">
        <div className="space-y-3">
          <h2 className="text-4xl font-black text-slate-900 dark:text-white">知识库</h2>
          <p className="text-slate-500 dark:text-slate-400 font-medium text-lg">
            管理您的非结构化数据，为 RAG 应用提供精准的检索上下文支持。
          </p>
          <p className="text-xs font-semibold text-slate-400 dark:text-slate-500">
            {snapshotMeta
              ? `列表快照生成于 ${new Date(snapshotMeta.snapshotAt * 1000).toLocaleString('zh-CN')} · ${snapshotMeta.status === 'live' ? '本次直接读取' : snapshotMeta.status === 'fresh' ? `${snapshotMeta.cacheTtlSeconds || 45} 秒缓存` : '历史快照'}`
              : loading ? '正在读取知识库列表快照' : '知识库列表快照尚未取得'}
          </p>
          {!authLoading && !isAdmin ? <p className="text-xs font-semibold leading-5 text-blue-700 dark:text-blue-300">当前账号可查看知识库、文档和检索结果；新建、修改、上传与删除由管理员负责。</p> : null}
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void handleRefresh()}
            disabled={loading || refreshing}
            title="刷新知识库"
            aria-label="刷新知识库"
            className="inline-flex h-12 w-12 items-center justify-center rounded-[8px] border border-slate-200 bg-white text-slate-500 transition hover:bg-slate-50 disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-slate-300"
          >
            <RefreshCw size={18} className={refreshing ? 'animate-spin' : ''} />
          </button>
          {authLoading ? <div className="inline-flex h-12 items-center gap-2 rounded-[8px] border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-400 dark:border-white/[0.08] dark:bg-white/[0.04]"><Loader2 size={16} className="animate-spin" />正在确认权限</div> : isAdmin ? <button onClick={() => { if (datasetWritable) setShowCreate(true) }} disabled={!datasetWritable}
            title={datasetWritable ? '新建知识库' : '请先恢复 Dify 实时连接并刷新列表'}
            className="flex items-center gap-3 rounded-[8px] bg-blue-600 px-8 py-4 text-base font-bold text-white shadow-xl shadow-blue-500/30 transition-all hover:bg-blue-700 active:scale-95 disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none">
            <Plus size={20} strokeWidth={3} />
            新建知识库
          </button> : null}
        </div>
      </div>

      {loadError && datasetsLoaded && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm font-semibold text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              {loadError}
              <div className="mt-1 text-xs font-black">{datasetSnapshotMatchesView ? '当前仍显示同一条件下的上一次成功快照；详情和分页仍可用，新建与删除已暂停。' : '保留的旧知识库快照不代表当前筛选条件，详情、删除与分页已暂停。'}</div>
            </div>
            <button type="button" onClick={() => void handleRefresh()} disabled={loading} className="shrink-0 rounded-[8px] bg-white px-4 py-2 text-xs font-black text-amber-800 shadow-sm disabled:opacity-50 dark:bg-white/[0.08] dark:text-amber-100">
              {loading ? '正在重新读取' : '重新读取'}
            </button>
          </div>
        </div>
      )}

      {snapshotNotice ? (
        <div className="border-l-2 border-amber-400 bg-amber-50 px-5 py-4 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200" role="status">
          <p className="font-black">Dify 实时列表暂不可读取，当前保留上次成功结果</p>
          <p className="mt-1 leading-6">
            快照时间：{new Date(snapshotNotice.snapshotAt * 1000).toLocaleString('zh-CN')}。{getErrorMessage(snapshotNotice.error, 'Dify 知识库实时列表读取失败，请检查服务状态和运行日志')}
          </p>
          {snapshotNotice.error ? <details className="mt-2 text-xs font-semibold"><summary className="cursor-pointer">查看技术错误</summary><TechnicalId value={snapshotNotice.error} label="Dify 原始错误" className="mt-2" /></details> : null}
        </div>
      ) : null}

      {/* Tabs & Sort */}
      <div className="flex flex-col justify-between gap-4 border-b border-slate-100 pb-2 dark:border-white/[0.06] lg:flex-row lg:items-end">
        <div className="flex gap-6 overflow-x-auto">
          {tabs.map(tab => (
            <button key={tab.id} onClick={() => { invalidateDatasetView(); setActiveTab(tab.id); setPage(1) }}
              className={`pb-4 text-sm font-bold transition-all relative ${activeTab === tab.id ? 'text-blue-600' : 'text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300'}`}>
              {tab.label}
              {activeTab === tab.id && <motion.div layoutId="kbActiveTab" className="absolute bottom-0 left-0 right-0 h-1 bg-blue-600 rounded-full" />}
            </button>
          ))}
        </div>
        {/* Sort dropdown */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <label className="relative block">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              aria-label="搜索知识库"
              value={keyword}
              onChange={(event) => { invalidateDatasetView(); setSearchSettled(false); setKeyword(event.target.value); setPage(1) }}
              placeholder="搜索知识库"
              className="h-9 w-full rounded-[8px] border border-slate-200 bg-white pl-9 pr-4 text-xs font-medium text-slate-700 outline-none transition focus:border-blue-400 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-slate-200 sm:w-52"
            />
          </label>
          <div className="relative">
          <button onClick={() => setShowSortMenu(!showSortMenu)}
            className="flex min-h-9 items-center gap-2 rounded-[8px] px-3 py-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:text-slate-500 dark:hover:bg-white/[0.06] dark:hover:text-slate-300">
            <ListFilter size={16} />
            <span className="text-xs font-bold">排序方式: {currentSortLabel}</span>
            {showSortMenu ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          <AnimatePresence>
            {showSortMenu && (
              <motion.div
                initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
                className="absolute right-0 top-full z-50 mt-2 w-48 rounded-[8px] border border-slate-100 bg-white py-2 shadow-xl dark:border-white/[0.06] dark:bg-slate-800"
              >
                {SORT_OPTIONS.map(opt => (
                  <button key={opt.id}
                    onClick={() => { invalidateDatasetView(); setSortBy(opt.id); setActiveTab('all'); setPage(1); setShowSortMenu(false) }}
                    className={`w-full text-left px-4 py-2.5 text-xs font-bold transition-colors ${
                      sortBy === opt.id ? 'text-blue-600 bg-blue-50 dark:bg-blue-500/10' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-white/[0.04]'
                    }`}>
                    {opt.label}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
          </div>
        </div>
      </div>

      {/* Loading */}
      {loading && datasets.length === 0 ? (
        <div className="flex items-center justify-center py-32">
          <Loader2 size={32} className="animate-spin text-slate-300 dark:text-slate-600" />
        </div>
      ) : (
        <>
          {/* Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-8">
            {displayDatasets.map((ds, index) => {
              const iconSet = KB_ICONS[index % KB_ICONS.length]
              const status: 'HAS_DOCUMENTS' | 'EMPTY' = ds.document_count > 0 ? 'HAS_DOCUMENTS' : 'EMPTY'
              return (
                <KBCard key={ds.id} id={ds.id} title={ds.name} description={displayDatasetDescription(ds.description)} sourceDescription={ds.description}
                  docCount={String(ds.document_count)} tokenCount={formatWordCount(ds.word_count)}
                  status={status} appCount={ds.app_count} embeddingAvailable={ds.embedding_available} embeddingModel={ds.embedding_model}
                  canManage={isAdmin}
                  interactionDisabled={!datasetSnapshotMatchesView}
                  managementDisabled={!datasetWritable}
                  icon={iconSet.icon} iconBg={iconSet.bg} iconColor={iconSet.color}
                  onDelete={() => setDeleteTarget(ds)} />
              )
            })}

            {!loading && displayDatasets.length === 0 ? (
              <div className={`col-span-full rounded-[8px] border border-dashed px-6 py-16 text-center text-sm ${!datasetsLoaded && loadError ? 'border-amber-200 text-amber-700 dark:border-amber-500/30 dark:text-amber-300' : 'border-slate-200 text-slate-400 dark:border-white/[0.08] dark:text-slate-500'}`} role={!datasetsLoaded && loadError ? 'alert' : undefined}>
                {!datasetsLoaded && loadError ? (
                  <div>
                    <p className="font-black">知识库列表未取得</p>
                    <p className="mx-auto mt-2 max-w-lg break-words text-xs leading-5">{loadError}</p>
                    <p className="mt-1 text-xs opacity-80">当前没有可展示的成功快照，不按零个知识库统计。</p>
                    <button type="button" onClick={() => void handleRefresh()} disabled={loading} className="mt-4 inline-flex min-h-9 items-center gap-2 rounded-[8px] border border-amber-200 bg-white px-3 text-xs font-black text-amber-800 disabled:cursor-wait disabled:opacity-50 dark:border-amber-500/30 dark:bg-white/[0.05] dark:text-amber-200">
                      {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}{loading ? '正在重新读取' : '重新读取知识库'}
                    </button>
                  </div>
                ) : keyword
                    ? `没有找到包含「${keyword}」的知识库`
                    : activeTab === 'shared' ? '暂无共享知识库' : '暂无知识库'}
              </div>
            ) : null}
          </div>

          {datasetsLoaded && (loading || !datasetSnapshotMatchesView) ? (
            <div className="flex items-center justify-center gap-2 border-l-2 border-blue-500 bg-blue-50 px-3 py-2 text-xs font-bold text-blue-700 dark:bg-blue-500/10 dark:text-blue-300" role="status">
              {loading ? <Loader2 size={14} className="animate-spin" /> : null}
              {loading ? '正在更新知识库列表，' : '正在应用新的筛选条件，'}{datasetSnapshotMatchesView ? '当前暂时显示同一条件下的上一次成功结果。' : '下方旧快照不代表当前条件，详情、删除和分页暂不可用。'}
            </div>
          ) : null}

          {datasetsLoaded ? (
            <Pagination
              page={loadedDatasetPage}
              pageSize={loadedDatasetSize}
              total={total}
              loading={loading}
              navigationDisabled={!datasetSnapshotMatchesView}
              onPageChange={(nextPage) => { invalidateDatasetView(); setPage(nextPage) }}
              onPageSizeChange={(nextSize) => { invalidateDatasetView(); setPageSize(nextSize); setPage(1) }}
              pageSizeOptions={[9, 18, 36]}
              itemName="个知识库"
              className="mt-8 px-0 pb-0"
            />
          ) : null}
          {inventoryTotal !== total ? <p className="mt-2 text-center text-xs font-bold text-slate-400 dark:text-slate-500">系统共 {inventoryTotal} 个知识库</p> : null}
        </>
      )}
    </div>
  )
}

export default function KnowledgeBasePage() {
  return (
    <Suspense fallback={<div className="flex min-h-[50vh] items-center justify-center text-sm font-bold text-slate-400">正在读取知识库...</div>}>
      <KnowledgeBaseContent />
    </Suspense>
  )
}
