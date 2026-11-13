'use client'

/**
 * 知识库管理 · 详情页
 * 语义检索(真实API)、文档列表、数据集健康度、文档上传、文档筛选
 */

import { Suspense, useState, useEffect, useCallback, useRef } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import {
  ArrowLeft, FileText, FileCode, FileSpreadsheet,
    UploadCloud, Database, ChevronRight, Zap,
  Loader2, X, Trash2, Plus, File as FileIcon, Search, Pencil, BrainCircuit, Layers3,
  Settings, ChevronDown, ChevronUp, RefreshCw,
} from 'lucide-react'
import { motion, AnimatePresence } from 'motion/react'
import { ApiError } from '@/lib/api/client'
import {
  createTextDocument,
  deleteDocument,
  fetchDataset,
  fetchDocuments,
  hitTestDataset,
  replaceDocumentFile,
  updateTextDocument,
  uploadDocument,
  type HitRecord,
  type HitTestingResponse,
  type KnowledgeDataset,
  type KnowledgeDocument,
} from '@/lib/api/knowledge'
import { useAuth } from '@/lib/hooks/useAuth'
import { AppDialog } from '@/components/ui/AppDialog'
import { Pagination } from '@/components/ui/Pagination'
import { InlineToast } from '@/components/ui/InlineToast'
import { TechnicalId } from '@/components/ui/TechnicalId'
import { businessErrorMessage } from '@/lib/ui/business-error'

/* ── Types ── */
type Document = KnowledgeDocument
type DatasetInfo = KnowledgeDataset
type KnowledgeReadSelection = {
  dataset?: boolean
  documents?: boolean
}

const SUPPORTED_DOCUMENT_FORMATS = 'PDF、TXT、DOCX、CSV、MD、XLSX'
const DOCUMENT_ACCEPT = '.pdf,.txt,.docx,.csv,.md,.xlsx'

function getErrorMessage(error: unknown, fallback: string) {
  return businessErrorMessage(error, { fallback, service: 'Dify 知识库' })
}

function indexingTechniqueLabel(value?: string) {
  if (value === 'high_quality') return '高质量向量索引'
  if (value === 'economy') return '经济型索引'
  return value ? '索引方式待识别' : '由平台自动管理'
}

function embeddingModelLabel(value?: string | null) {
  if (!value) return '由平台自动管理'
  if (value === 'multimodal-embedding-v1') return '多模态向量模型'
  return value
}

function embeddingProviderLabel(value?: string | null) {
  if (!value) return '由平台自动管理'
  if (value.toLowerCase().includes('tongyi')) return '通义千问'
  if (value.toLowerCase().includes('openai')) return 'OpenAI'
  return '模型提供方待识别'
}

function formatDocumentTime(timestamp: number) {
  if (!timestamp) return '时间未取得'
  const value = new Date(timestamp * 1000)
  if (Number.isNaN(value.getTime())) return '时间未取得'
  return value.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function formatExecutionTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未取得'
  return date.toLocaleString('zh-CN', { hour12: false })
}

/* ── Document row (保留原有样式) ── */
function DocumentRow({ name, wordCount, status, createdAt, canManage, interactionDisabled, onEdit, onDelete }: {
  name: string; wordCount: number; status: string; createdAt: number; canManage: boolean; interactionDisabled: boolean; onEdit: () => void; onDelete: () => void
}) {
const statusMap: Record<string, { dot: string; text: string; label: string }> = {
    completed: { dot: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400', label: '索引完成' },
    indexing:  { dot: 'bg-blue-500 animate-pulse', text: 'text-blue-600 dark:text-blue-400', label: '索引中' },
    parsing:   { dot: 'bg-blue-500 animate-pulse', text: 'text-blue-600 dark:text-blue-400', label: '解析中' },
    cleaning:  { dot: 'bg-blue-500 animate-pulse', text: 'text-blue-600 dark:text-blue-400', label: '清洗中' },
    splitting: { dot: 'bg-blue-500 animate-pulse', text: 'text-blue-600 dark:text-blue-400', label: '切分中' },
    queuing:   { dot: 'bg-amber-500 animate-pulse', text: 'text-amber-600 dark:text-amber-400', label: '排队中' },
    error:     { dot: 'bg-red-500', text: 'text-red-600 dark:text-red-400', label: '失败' },
    waiting:   { dot: 'bg-amber-500 animate-pulse', text: 'text-amber-600 dark:text-amber-400', label: '等待中' },
    paused:    { dot: 'bg-slate-400', text: 'text-slate-500 dark:text-slate-400', label: '已暂停' },
  }
  const s = statusMap[status] || {
    dot: 'bg-slate-300 dark:bg-slate-600',
    text: 'text-slate-500 dark:text-slate-400',
    label: '待确认',
  }

  const ext = name.split('.').pop()?.toLowerCase()
  let Icon = FileText
  let iconColor = 'bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400'
  if (ext === 'csv' || ext === 'xlsx') { Icon = FileSpreadsheet; iconColor = 'bg-orange-50 dark:bg-orange-500/10 text-orange-600 dark:text-orange-400' }
  if (ext === 'json' || ext === 'py' || ext === 'js') { Icon = FileCode; iconColor = 'bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400' }
  if (ext === 'txt' || ext === 'md') { Icon = FileIcon; iconColor = 'bg-slate-50 dark:bg-white/[0.05] text-slate-600 dark:text-slate-400' }

  const timeStr = formatDocumentTime(createdAt)

  return (
    <tr className="group border-b border-slate-100 transition-colors last:border-0 hover:bg-slate-50 dark:border-white/[0.06] dark:hover:bg-white/[0.03]">
      <td className="px-5 py-3.5 sm:px-6">
        <div className="flex items-center gap-3">
          <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] ${iconColor}`}><Icon size={17} /></div>
          <span title={name} className="block min-w-0 max-w-[360px] truncate text-sm font-bold text-slate-900 dark:text-white">{name}</span>
        </div>
      </td>
      <td className="whitespace-nowrap px-5 py-3.5 text-sm text-slate-500 dark:text-slate-400 sm:px-6">{wordCount.toLocaleString()} 词</td>
      <td className="px-5 py-3.5 sm:px-6">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${s.dot}`} />
          <span className={`text-xs font-bold whitespace-nowrap ${s.text}`}>{s.label}</span>
        </div>
      </td>
      <td className="whitespace-nowrap px-5 py-3.5 text-sm text-slate-500 dark:text-slate-400 sm:px-6">{timeStr}</td>
      <td className="px-5 py-3.5 sm:px-6">
        {canManage ? (
          <div className="flex items-center gap-3 opacity-100 transition-all md:opacity-0 md:focus-within:opacity-100 md:group-hover:opacity-100">
            <button type="button" title={`修改文档：${name}`} aria-label={`修改文档：${name}`} onClick={onEdit} disabled={interactionDisabled} className="text-slate-400 transition-all hover:text-blue-500 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-slate-400"><Pencil size={16} /></button>
            <button type="button" title={`删除文档：${name}`} aria-label={`删除文档：${name}`} onClick={onDelete} disabled={interactionDisabled} className="text-slate-400 transition-all hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-slate-400"><Trash2 size={16} /></button>
          </div>
        ) : null}
      </td>
    </tr>
  )
}

/* ── Create Text Doc Dialog ── */
function TextDocDialog({ datasetId, onClose, onSuccess }: { datasetId: string; onClose: (verify?: boolean) => void; onSuccess: () => void }) {
  const [name, setName] = useState('')
  const [text, setText] = useState('')
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
    if (!name.trim() || !text.trim()) return
    if (submittingRef.current) return
    submittingRef.current = true
    const sequence = ++requestSequenceRef.current
    const controller = new AbortController()
    abortControllerRef.current = controller
    try {
      setLoading(true)
      setError('')
      await createTextDocument(datasetId, { name: name.trim(), text: text.trim() }, controller.signal)
      if (sequence !== requestSequenceRef.current) return
      onSuccess(); onClose()
    } catch (requestError) {
      if (sequence !== requestSequenceRef.current) return
      if (controller.signal.aborted) {
        setError('已取消添加等待；Dify 可能仍在处理中，请刷新文档列表确认后再重试')
        return
      }
      setError(getErrorMessage(requestError, '添加文本文档失败'))
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
      title="添加文本文档"
      onClose={closeDialog}
      closeOnOverlay={!loading}
      showClose
      maxWidth="max-w-lg"
      initialFocusRef={nameInputRef}
      footer={(
        <div className="flex gap-3">
          <button onClick={closeDialog} className="flex-1 py-3 bg-slate-100 dark:bg-white/[0.05] text-slate-600 dark:text-slate-300 rounded-[8px] text-sm font-bold">{loading ? '取消等待' : '取消'}</button>
          <button onClick={handleCreate} disabled={!name.trim() || !text.trim() || loading}
            className="flex-1 py-3 bg-blue-600 text-white rounded-[8px] text-sm font-bold disabled:opacity-50 flex items-center justify-center gap-2">
            {loading && <Loader2 size={14} className="animate-spin" />} {loading ? '正在添加' : '添加'}
          </button>
        </div>
      )}
    >
        <div className="space-y-4">
          {error ? <div className="rounded-[8px] bg-red-50 px-4 py-3 text-xs font-semibold text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</div> : null}
          <div>
            <label htmlFor="knowledge-document-create-name" className="mb-2 block text-xs font-bold text-slate-500 dark:text-slate-400">文档名称</label>
            <input ref={nameInputRef} id="knowledge-document-create-name" value={name} onChange={e => setName(e.target.value)} disabled={loading} placeholder="my_document.txt"
              className="w-full bg-slate-50 dark:bg-white/[0.05] border-none rounded-[8px] py-3 px-4 text-sm font-medium text-slate-900 dark:text-white placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-blue-500/20" />
          </div>
          <div>
            <label htmlFor="knowledge-document-create-content" className="mb-2 block text-xs font-bold text-slate-500 dark:text-slate-400">文本内容</label>
            <textarea id="knowledge-document-create-content" value={text} onChange={e => setText(e.target.value)} disabled={loading} placeholder="粘贴文本内容..." rows={6}
              className="w-full bg-slate-50 dark:bg-white/[0.05] border-none rounded-[8px] py-3 px-4 text-sm font-medium text-slate-900 dark:text-white placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-blue-500/20 resize-none" />
          </div>
        </div>
    </AppDialog>
  )
}

function UpdateDocumentDialog({
  datasetId,
  document,
  onClose,
  onSuccess,
}: {
  datasetId: string
  document: Document
  onClose: (verify?: boolean) => void
  onSuccess: (message: string) => void
}) {
  const [name, setName] = useState(document.name)
  const [text, setText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const submittingRef = useRef(false)
  const requestSequenceRef = useRef(0)
  const operationAbortControllerRef = useRef<AbortController | null>(null)
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const closeDialog = () => {
    const verify = loading
    requestSequenceRef.current += 1
    operationAbortControllerRef.current?.abort()
    operationAbortControllerRef.current = null
    submittingRef.current = false
    onClose(verify)
  }

  useEffect(() => () => {
    requestSequenceRef.current += 1
    operationAbortControllerRef.current?.abort()
  }, [])

  const isTextDocument =
    document.data_source_type === 'text' ||
    document.doc_form === 'text_model' ||
    /\.(txt|md)$/i.test(document.name)

  const handleUpdate = async () => {
    if (submittingRef.current) return
    if (isTextDocument ? (!name.trim() || !text.trim()) : !file) return
    submittingRef.current = true
    const sequence = ++requestSequenceRef.current
    const controller = new AbortController()
    operationAbortControllerRef.current = controller
    try {
      setLoading(true)
      setError('')
      if (isTextDocument) {
        await updateTextDocument(datasetId, document.id, {
          name: name.trim(),
          text: text.trim(),
        }, controller.signal)
        if (sequence !== requestSequenceRef.current) return
        onSuccess('文本文档已修改')
      } else {
        if (!file) return
        await replaceDocumentFile(datasetId, document.id, file, controller.signal)
        if (sequence !== requestSequenceRef.current) return
        onSuccess('文件文档已替换')
      }
      onClose()
    } catch (requestError) {
      if (sequence !== requestSequenceRef.current) return
      if (controller.signal.aborted) {
        setError(`已取消${isTextDocument ? '修改' : '文件替换'}等待；Dify 可能仍在处理中，请稍后刷新确认`)
      } else {
        setError(getErrorMessage(requestError, '修改文档失败'))
      }
    } finally {
      if (operationAbortControllerRef.current === controller) operationAbortControllerRef.current = null
      if (sequence === requestSequenceRef.current) {
        submittingRef.current = false
        setLoading(false)
      }
    }
  }

  return (
    <AppDialog
      title="知识库的增量更新与管理"
      description={(
        <>
            当前文档支持修改操作，可与动态添加、删除一起形成完整的增量更新链路。
        </>
      )}
      onClose={closeDialog}
      closeOnOverlay={!loading}
      showClose
      maxWidth="max-w-lg"
      initialFocusRef={isTextDocument ? nameInputRef : fileInputRef}
      footer={(
        <div className="flex gap-3">
          <button onClick={closeDialog} className="flex-1 py-3 bg-slate-100 dark:bg-white/[0.05] text-slate-600 dark:text-slate-300 rounded-[8px] text-sm font-bold disabled:opacity-50">{loading ? '取消等待' : '取消'}</button>
          <button onClick={handleUpdate} disabled={loading || (isTextDocument ? (!name.trim() || !text.trim()) : !file)}
            className="flex-1 py-3 bg-blue-600 text-white rounded-[8px] text-sm font-bold disabled:opacity-50 flex items-center justify-center gap-2">
            {loading && <Loader2 size={14} className="animate-spin" />} {loading ? '正在修改' : '修改文档'}
          </button>
        </div>
      )}
    >
      <div className="space-y-6">
        {error ? <div className="rounded-[8px] bg-red-50 px-4 py-3 text-xs font-semibold text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</div> : null}
        {isTextDocument ? (
          <div className="space-y-4">
            <div>
              <label htmlFor="knowledge-document-update-name" className="mb-2 block text-xs font-bold text-slate-500 dark:text-slate-400">文档名称</label>
              <input ref={nameInputRef} id="knowledge-document-update-name" value={name} onChange={e => setName(e.target.value)} disabled={loading}
                className="w-full bg-slate-50 dark:bg-white/[0.05] border-none rounded-[8px] py-3 px-4 text-sm font-medium text-slate-900 dark:text-white placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-blue-500/20" />
            </div>
            <div>
              <label htmlFor="knowledge-document-update-content" className="mb-2 block text-xs font-bold text-slate-500 dark:text-slate-400">文档内容</label>
              <textarea id="knowledge-document-update-content" value={text} onChange={e => setText(e.target.value)} disabled={loading} placeholder="粘贴新的完整文档内容..." rows={8}
                className="w-full bg-slate-50 dark:bg-white/[0.05] border-none rounded-[8px] py-3 px-4 text-sm font-medium text-slate-900 dark:text-white placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-blue-500/20 resize-none" />
            </div>
          </div>
        ) : (
          <div className="space-y-3 rounded-[8px] border border-dashed border-slate-200 bg-slate-50 px-6 py-8 text-center dark:border-white/[0.08] dark:bg-white/[0.03]">
            <p className="text-sm font-bold text-slate-900 dark:text-white">替换当前文件文档</p>
            <p className="text-sm text-slate-500 dark:text-slate-400">上传新的文件版本，以完成知识库文档修改。</p>
            <label className={`inline-flex items-center rounded-[8px] bg-blue-600 px-5 py-2 text-sm font-bold text-white focus-within:ring-2 focus-within:ring-blue-300 focus-within:ring-offset-2 ${loading ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
              选择替换文件
              <input ref={fileInputRef} type="file" aria-label="选择替换文件" className="sr-only" disabled={loading} accept={DOCUMENT_ACCEPT} onChange={e => setFile(e.target.files?.[0] || null)} />
            </label>
            <p className="text-xs text-slate-400 dark:text-slate-500">{file ? `当前选择：${file.name}` : '尚未选择文件'}</p>
          </div>
        )}
      </div>
    </AppDialog>
  )
}

/* ══════════════════════════════════════════════
   Knowledge Base Detail Page
   ══════════════════════════════════════════════ */

function KnowledgeBaseDetailContent() {
  const params = useParams()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const datasetId = params.id as string
  const fileInputRef = useRef<HTMLInputElement>(null)
  const requestSequence = useRef(0)
  const dataAbortControllerRef = useRef<AbortController | null>(null)
  const documentsLoadedRef = useRef(false)
  const datasetInfoRef = useRef<DatasetInfo | null>(null)
  const searchRequestSequence = useRef(0)
  const searchInFlightSequence = useRef<number | null>(null)
  const searchAbortControllerRef = useRef<AbortController | null>(null)
  const uploadInFlightRef = useRef(false)
  const uploadRequestSequence = useRef(0)
  const uploadAbortControllerRef = useRef<AbortController | null>(null)
  const deleteInFlightRef = useRef(false)
  const deleteRequestSequence = useRef(0)
  const deleteAbortControllerRef = useRef<AbortController | null>(null)
  const mutationReconcileRef = useRef(0)
  const mutationReconcileTimerRef = useRef<number | null>(null)
  const { isAdmin, loading: authLoading } = useAuth()

  const [documents, setDocuments] = useState<Document[]>([])
  const [datasetInfo, setDatasetInfo] = useState<DatasetInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [uploading, setUploading] = useState(false)
  const [showTextDoc, setShowTextDoc] = useState(false)
  const [editTarget, setEditTarget] = useState<Document | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Document | null>(null)
  const [deletingDocumentId, setDeletingDocumentId] = useState('')
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)

  // 语义检索
  const [searchQuery, setSearchQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [hitRecords, setHitRecords] = useState<HitRecord[]>([])
  const [showResults, setShowResults] = useState(false)
  const [lastSearchQuery, setLastSearchQuery] = useState('')
  const [searchError, setSearchError] = useState('')
  const [searchEvidence, setSearchEvidence] = useState<Pick<HitTestingResponse, 'duration_ms' | 'executed_at' | 'audit_recorded'> | null>(null)

  // 文档筛选
  const [docFilter, setDocFilter] = useState(() => searchParams.get('docQ') || '')
  const [debouncedDocFilter, setDebouncedDocFilter] = useState(() => (searchParams.get('docQ') || '').trim())
  const [docPage, setDocPage] = useState(() => {
    const value = Number(searchParams.get('page') || 1)
    return Number.isInteger(value) && value > 0 ? value : 1
  })
  const [docPageSize, setDocPageSize] = useState(() => {
    const value = Number(searchParams.get('size') || 10)
    return [10, 20, 50].includes(value) ? value : 10
  })
  const [docTotal, setDocTotal] = useState(0)
  const [loadedDocFilter, setLoadedDocFilter] = useState('')
  const [loadedDocPage, setLoadedDocPage] = useState(1)
  const [loadedDocPageSize, setLoadedDocPageSize] = useState(10)
  const [documentsLoaded, setDocumentsLoaded] = useState(false)
  const [datasetReadAvailable, setDatasetReadAvailable] = useState(false)
  const [documentsReadAvailable, setDocumentsReadAvailable] = useState(false)
  const [datasetReadFailed, setDatasetReadFailed] = useState(false)
  const [documentsReadFailed, setDocumentsReadFailed] = useState(false)
  const [showTechnical, setShowTechnical] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const writtenSearchRef = useRef(searchParams.toString())

  const invalidateDocumentView = useCallback(() => {
    dataAbortControllerRef.current?.abort()
    dataAbortControllerRef.current = null
    requestSequence.current += 1
    setLoading(true)
    setLoadError('')
  }, [])

  const loadData = useCallback(async (force = false, selection: KnowledgeReadSelection = {}) => {
    dataAbortControllerRef.current?.abort()
    const controller = new AbortController()
    dataAbortControllerRef.current = controller
    const sequence = ++requestSequence.current
    try {
      setLoading(true)
      const errors: string[] = []
      let datasetNotFound = false
      const shouldReadDataset = selection.dataset ?? (force || !datasetInfoRef.current)
      const shouldReadDocuments = selection.documents ?? true
      if (shouldReadDataset) {
        setDatasetReadAvailable(false)
        setDatasetReadFailed(false)
      }
      if (shouldReadDocuments) {
        setDocumentsReadAvailable(false)
        setDocumentsReadFailed(false)
      }
      const datasetRequest = shouldReadDataset
        ? fetchDataset(datasetId, force, controller.signal)
          .then((value) => {
            if (sequence !== requestSequence.current) return
            datasetInfoRef.current = value
            setDatasetInfo(value)
            setDatasetReadAvailable(true)
            setDatasetReadFailed(false)
          })
          .catch((error) => {
            if (controller.signal.aborted) return
            if (error instanceof ApiError && error.status === 404) datasetNotFound = true
            errors.push(getErrorMessage(error, '获取知识库详情失败'))
            setDatasetReadFailed(true)
          })
        : Promise.resolve()
      const documentsRequest = shouldReadDocuments ? fetchDocuments(
        { datasetId, page: docPage, limit: docPageSize, keyword: debouncedDocFilter },
        force,
        controller.signal,
      )
        .then((value) => {
          if (sequence !== requestSequence.current) return
          setDocuments(value.documents || [])
          setDocTotal(value.total || 0)
          setLoadedDocFilter(debouncedDocFilter)
          setLoadedDocPage(value.page || docPage)
          setLoadedDocPageSize(docPageSize)
          if (value.page && value.page !== docPage) setDocPage(value.page)
          documentsLoadedRef.current = true
          setDocumentsLoaded(true)
          setDocumentsReadAvailable(true)
          setDocumentsReadFailed(false)
        }) : Promise.resolve()
        .catch((error) => {
          if (controller.signal.aborted) return
          if (error instanceof ApiError && error.status === 404) datasetNotFound = true
          const retained = documentsLoadedRef.current ? '，当前保留上一次成功读取的文档列表' : ''
          errors.push(`${getErrorMessage(error, '获取文档列表失败')}${retained}`)
          setDocumentsReadFailed(true)
        })

      await Promise.all([datasetRequest, documentsRequest])
      if (sequence !== requestSequence.current) return

      const message = controller.signal.aborted
        ? ''
        : datasetNotFound
          ? '知识库不存在、已被删除或当前 Dataset Key 无权访问'
          : errors.join('；')
      setLoadError(message)
      if (message) setToast({ message, type: 'error' })
    } finally {
      if (dataAbortControllerRef.current === controller) dataAbortControllerRef.current = null
      if (sequence === requestSequence.current) setLoading(false)
    }
  }, [datasetId, debouncedDocFilter, docPage, docPageSize])
  const loadDataRef = useRef(loadData)

  useEffect(() => {
    loadDataRef.current = loadData
  }, [loadData])

  useEffect(() => { loadData() }, [loadData])

  useEffect(() => {
    if (!datasetReadFailed && !documentsReadFailed) return
    const recoverFailedReads = () => {
      if (!navigator.onLine || document.hidden || dataAbortControllerRef.current) return
      void loadDataRef.current(true, {
        dataset: datasetReadFailed,
        documents: documentsReadFailed,
      })
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
  }, [datasetReadFailed, documentsReadFailed])

  useEffect(() => () => {
    requestSequence.current += 1
    dataAbortControllerRef.current?.abort()
    dataAbortControllerRef.current = null
    searchRequestSequence.current += 1
    searchAbortControllerRef.current?.abort()
    searchAbortControllerRef.current = null
    uploadRequestSequence.current += 1
    uploadAbortControllerRef.current?.abort()
    uploadAbortControllerRef.current = null
    deleteRequestSequence.current += 1
    deleteAbortControllerRef.current?.abort()
    deleteAbortControllerRef.current = null
    mutationReconcileRef.current += 1
    if (mutationReconcileTimerRef.current !== null) window.clearTimeout(mutationReconcileTimerRef.current)
  }, [])

  const reconcileDocuments = () => {
    const reconcileId = ++mutationReconcileRef.current
    if (mutationReconcileTimerRef.current !== null) window.clearTimeout(mutationReconcileTimerRef.current)
    void loadDataRef.current(true).finally(() => {
      if (mutationReconcileRef.current !== reconcileId) return
      mutationReconcileTimerRef.current = window.setTimeout(() => {
        if (mutationReconcileRef.current !== reconcileId) return
        mutationReconcileTimerRef.current = null
        void loadDataRef.current(true)
      }, 1200)
    })
  }

  const mutationResultUncertain = (error: unknown) => (
    error instanceof ApiError && error.status === 0
    || error instanceof Error && /超时|网络中断|无法连接|network|timeout/i.test(error.message)
  )

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const nextFilter = docFilter.trim()
      if (nextFilter !== debouncedDocFilter) {
        setDocPage(1)
        setDebouncedDocFilter(nextFilter)
      }
    }, 300)
    return () => window.clearTimeout(timer)
  }, [debouncedDocFilter, docFilter])

  useEffect(() => {
    if (pathname !== `/knowledge/${datasetId}`) return
    const url = new URL(window.location.href)
    const values = { docQ: docFilter.trim(), page: docPage === 1 ? '' : String(docPage), size: docPageSize === 10 ? '' : String(docPageSize) }
    Object.entries(values).forEach(([key, value]) => value ? url.searchParams.set(key, value) : url.searchParams.delete(key))
    const nextSearch = url.searchParams.toString()
    writtenSearchRef.current = nextSearch
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }, [datasetId, docFilter, docPage, docPageSize, pathname])

  useEffect(() => {
    if (pathname !== `/knowledge/${datasetId}`) return
    const nextSearch = searchParams.toString()
    if (nextSearch === writtenSearchRef.current) return
    writtenSearchRef.current = nextSearch
    const nextFilter = searchParams.get('docQ') || ''
    const rawPage = Number(searchParams.get('page') || 1)
    const rawSize = Number(searchParams.get('size') || 10)
    invalidateDocumentView()
    setDocFilter(nextFilter)
    setDebouncedDocFilter(nextFilter.trim())
    setDocPage(Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1)
    setDocPageSize([10, 20, 50].includes(rawSize) ? rawSize : 10)
  }, [datasetId, invalidateDocumentView, pathname, searchParams])

  const handleDeleteDoc = async (docId: string) => {
    if (!isAdmin) {
      setToast({ message: '仅管理员可删除知识库文档', type: 'error' })
      return
    }
    if (!datasetOperational) {
      setToast({ message: 'Dify 实时详情或文档列表当前不可用，请刷新成功后再删除', type: 'error' })
      return
    }
    if (deleteInFlightRef.current) return
    deleteInFlightRef.current = true
    const sequence = ++deleteRequestSequence.current
    const controller = new AbortController()
    deleteAbortControllerRef.current = controller
    try {
      setDeletingDocumentId(docId)
      await deleteDocument(datasetId, docId, controller.signal)
      if (sequence !== deleteRequestSequence.current) return
      const shouldGoToPreviousPage = documents.length === 1 && docPage > 1
      setDocuments((current) => current.filter((document) => document.id !== docId))
      setDocTotal((current) => Math.max(0, current - 1))
      setToast({ message: '文档已删除', type: 'success' })
      setDeleteTarget(null)
      if (shouldGoToPreviousPage) setDocPage((value) => value - 1)
      else void loadDataRef.current(true)
    } catch (error) {
      if (sequence !== deleteRequestSequence.current) return
      if (controller.signal.aborted) {
        setToast({ message: '已取消删除等待；Dify 可能仍在处理中，正在重新读取文档列表', type: 'error' })
        reconcileDocuments()
        return
      }
      if (mutationResultUncertain(error)) {
        setDeleteTarget(null)
        setToast({ message: '删除请求超时或网络中断，文档可能已经删除；正在重新读取最终列表', type: 'error' })
        reconcileDocuments()
        return
      }
      setToast({ message: getErrorMessage(error, '删除文档失败'), type: 'error' })
    }
    finally {
      if (deleteAbortControllerRef.current === controller) deleteAbortControllerRef.current = null
      if (sequence === deleteRequestSequence.current) {
        deleteInFlightRef.current = false
        setDeletingDocumentId('')
      }
    }
  }

  const cancelDeleteWait = () => {
    deleteRequestSequence.current += 1
    deleteAbortControllerRef.current?.abort()
    deleteAbortControllerRef.current = null
    deleteInFlightRef.current = false
    setDeletingDocumentId('')
    setDeleteTarget(null)
    setToast({ message: '已取消删除等待；Dify 可能仍在处理中，正在重新读取文档列表', type: 'error' })
    reconcileDocuments()
  }

  const uploadSelectedFile = async (file?: File) => {
    if (!file) return
    if (!isAdmin) {
      setToast({ message: '仅管理员可上传知识库文档', type: 'error' })
      return
    }
    if (!datasetOperational) {
      setToast({ message: 'Dify 实时详情或文档列表当前不可用，请刷新成功后再上传文件', type: 'error' })
      return
    }
    if (uploadInFlightRef.current) {
      setToast({ message: '已有文档正在上传，请等待完成', type: 'error' })
      return
    }
    uploadInFlightRef.current = true
    const sequence = ++uploadRequestSequence.current
    const controller = new AbortController()
    uploadAbortControllerRef.current = controller
    try {
      setUploading(true)
      await uploadDocument(datasetId, file, controller.signal)
      if (sequence !== uploadRequestSequence.current) return
      setToast({ message: `${file.name} 上传成功`, type: 'success' })
      void loadDataRef.current(true)
    } catch (error) {
      if (sequence !== uploadRequestSequence.current || controller.signal.aborted) return
      if (mutationResultUncertain(error)) {
        setToast({ message: '上传请求超时或网络中断，文件可能已经保存；正在重新读取文档列表，请勿立即重复上传', type: 'error' })
        reconcileDocuments()
        return
      }
      setToast({ message: getErrorMessage(error, '上传文档失败'), type: 'error' })
    }
    finally {
      if (sequence === uploadRequestSequence.current) {
        uploadInFlightRef.current = false
        uploadAbortControllerRef.current = null
        setUploading(false)
        if (fileInputRef.current) fileInputRef.current.value = ''
      }
    }
  }

  const cancelUpload = () => {
    if (!uploadInFlightRef.current) return
    uploadRequestSequence.current += 1
    uploadAbortControllerRef.current?.abort()
    uploadAbortControllerRef.current = null
    uploadInFlightRef.current = false
    setUploading(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
    setToast({ message: '已取消上传等待；文件可能仍在服务端处理中，正在重新读取文档列表', type: 'error' })
    reconcileDocuments()
  }

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    await uploadSelectedFile(e.target.files?.[0])
  }

  // 语义检索
  const handleHitTesting = async () => {
    if (searchInFlightSequence.current !== null) {
      searchRequestSequence.current += 1
      searchInFlightSequence.current = null
      searchAbortControllerRef.current?.abort()
      searchAbortControllerRef.current = null
      setSearching(false)
      setShowResults(false)
      setHitRecords([])
      setSearchError('')
      setSearchEvidence(null)
      setToast({ message: '已取消语义检索等待', type: 'success' })
      return
    }
    if (!datasetRetrievalAvailable) {
      setToast({ message: 'Dify 实时知识库详情当前不可用，请刷新成功后再执行语义检索', type: 'error' })
      return
    }
    const query = searchQuery.trim()
    if (!query) return
    const sequence = ++searchRequestSequence.current
    const controller = new AbortController()
    searchAbortControllerRef.current = controller
    searchInFlightSequence.current = sequence
    try {
      setSearching(true)
      setShowResults(true)
      setLastSearchQuery(query)
      setSearchError('')
      setHitRecords([])
      setSearchEvidence(null)
      const data = await hitTestDataset(datasetId, query, controller.signal)
      if (sequence !== searchRequestSequence.current) return
      setHitRecords(data.records || [])
      setSearchEvidence({ duration_ms: data.duration_ms, executed_at: data.executed_at, audit_recorded: data.audit_recorded })
    } catch (error) {
      if (sequence !== searchRequestSequence.current) return
      if (controller.signal.aborted) return
      const message = getErrorMessage(error, '语义检索失败，请重试')
      setSearchError(message)
      setHitRecords([])
      setSearchEvidence(null)
      setToast({ message, type: 'error' })
    } finally {
      if (searchInFlightSequence.current === sequence) searchInFlightSequence.current = null
      if (searchAbortControllerRef.current === controller) searchAbortControllerRef.current = null
      if (sequence === searchRequestSequence.current) setSearching(false)
    }
  }

  const handleSearchQueryChange = (value: string) => {
    searchRequestSequence.current += 1
    searchInFlightSequence.current = null
    searchAbortControllerRef.current?.abort()
    searchAbortControllerRef.current = null
    setSearching(false)
    setShowResults(false)
    setHitRecords([])
    setLastSearchQuery('')
    setSearchError('')
    setSearchEvidence(null)
    setSearchQuery(value)
  }

  const handleDocumentFilterChange = (value: string) => {
    if (value === docFilter) return
    invalidateDocumentView()
    setDocFilter(value)
  }

  const handleDocumentPageChange = (value: number) => {
    if (!documentSnapshotMatchesView) return
    if (value === docPage) {
      void loadDataRef.current(true)
      return
    }
    invalidateDocumentView()
    setDocPage(value)
  }

  const handleDocumentPageSizeChange = (value: number) => {
    if (!documentSnapshotMatchesView) return
    if (value === docPageSize && docPage === 1) {
      void loadDataRef.current(true)
      return
    }
    invalidateDocumentView()
    setDocPageSize(value)
    setDocPage(1)
  }

  const unfilteredDocumentListLoaded = documentsLoaded && loadedDocFilter === ''
  const allDatasetDocumentsLoaded = unfilteredDocumentListLoaded
    && loadedDocPage === 1
    && docTotal === documents.length
  const datasetDocumentTotal: number | null = datasetInfo?.document_count
    ?? (unfilteredDocumentListLoaded ? docTotal : null)
  const totalWords: number | null = datasetInfo?.word_count
    ?? (allDatasetDocumentsLoaded ? documents.reduce((sum, d) => sum + d.word_count, 0) : null)
  const datasetDocumentTotalLabel = datasetDocumentTotal === null ? '文档数未取得' : `${datasetDocumentTotal} 份文档`
  const totalWordsLabel = totalWords === null ? '词数未取得' : `${totalWords.toLocaleString()} 词`
  const completedDocs = documents.filter(d => d.indexing_status === 'completed').length
  const healthPercent = documents.length > 0 ? Math.round((completedDocs / documents.length) * 100) : 0
  const activelyIndexingStatuses = new Set(['indexing', 'parsing', 'cleaning', 'splitting', 'queuing'])
  const activelyIndexingDocs = documents.filter(d => activelyIndexingStatuses.has(d.indexing_status)).length
  const errorDocs = documents.filter(d => d.indexing_status === 'error').length
  const indexingSummary = {
    completed: completedDocs,
    indexing: activelyIndexingDocs,
    waiting: Math.max(0, documents.length - completedDocs - activelyIndexingDocs - errorDocs),
    error: errorDocs,
  }
  const hasUnreadyDocs = documents.length > 0 && completedDocs < documents.length
  const allFilteredDocumentsLoaded = documentsLoaded
    && Boolean(loadedDocFilter)
    && loadedDocPage === 1
    && docTotal === documents.length
  const indexingScope = allDatasetDocumentsLoaded
    ? '全部文档'
    : allFilteredDocumentsLoaded ? '当前筛选结果' : '当前页'
  const indexingHeadline = !documents.length
    ? '—'
    : allDatasetDocumentsLoaded
      ? `${healthPercent}%`
      : `${completedDocs}/${documents.length}`
  const indexingHeadlineLabel = allDatasetDocumentsLoaded ? '全部文档完成率' : `${indexingScope}已索引`
  const indexingStatusText = !documents.length
    ? loading ? '正在读取' : documentsLoaded ? '当前范围暂无文档' : '未取得'
    : allDatasetDocumentsLoaded
      ? `全部文档 ${healthPercent}% 完成`
      : `${indexingScope} ${completedDocs}/${documents.length} 已索引`
  const documentFilterTransition = loading && (
    loadedDocFilter !== debouncedDocFilter
    || loadedDocPage !== docPage
    || loadedDocPageSize !== docPageSize
    || docFilter.trim() !== debouncedDocFilter
  )
  const retainedDocumentSnapshot = documentsLoaded && !loading && (
    loadedDocFilter !== debouncedDocFilter
    || loadedDocPage !== docPage
    || loadedDocPageSize !== docPageSize
  )
  const documentSnapshotMatchesView = documentsLoaded
    && docFilter.trim() === debouncedDocFilter
    && loadedDocFilter === debouncedDocFilter
    && loadedDocPage === docPage
    && loadedDocPageSize === docPageSize
  const datasetRetrievalAvailable = Boolean(datasetInfo) && datasetReadAvailable && !loading
  const datasetOperational = datasetRetrievalAvailable && documentsReadAvailable && documentSnapshotMatchesView
  const updatingDocumentSnapshot = documentsLoaded && documentFilterTransition
  const hasLoadedData = Boolean(datasetInfo) || documentsLoaded

  return (
    <div className="max-w-7xl mx-auto space-y-8">
      <AnimatePresence>{toast && <InlineToast message={toast.message} tone={toast.type} onClose={() => setToast(null)} />}</AnimatePresence>
      <AnimatePresence>{showTextDoc && isAdmin && datasetOperational && <TextDocDialog datasetId={datasetId} onClose={(verify) => { setShowTextDoc(false); if (verify) { setToast({ message: '已取消添加等待；Dify 可能仍在处理中，正在重新读取文档列表', type: 'error' }); reconcileDocuments() } }} onSuccess={() => { reconcileDocuments(); setToast({ message: '文档创建成功', type: 'success' }) }} />}</AnimatePresence>
      <AnimatePresence>{editTarget && isAdmin && datasetOperational && <UpdateDocumentDialog datasetId={datasetId} document={editTarget} onClose={(verify) => { setEditTarget(null); if (verify) { setToast({ message: '已取消修改等待；Dify 可能仍在处理中，正在重新读取文档列表', type: 'error' }); reconcileDocuments() } }} onSuccess={(message) => { reconcileDocuments(); setToast({ message, type: 'success' }) }} />}</AnimatePresence>
      <AnimatePresence>{deleteTarget && isAdmin && datasetOperational ? (
        <AppDialog
          title="删除文档"
          description={`确定删除「${deleteTarget.name}」吗？此操作会同步删除 Dify 中的文档和索引数据，且不可撤销。`}
          onClose={() => { if (deletingDocumentId) cancelDeleteWait(); else setDeleteTarget(null) }}
          closeOnOverlay={!deletingDocumentId}
          showClose
          maxWidth="max-w-sm"
          danger
          footer={(
            <div className="flex gap-3">
              <button type="button" onClick={() => { if (deletingDocumentId) cancelDeleteWait(); else setDeleteTarget(null) }} className="flex-1 rounded-[8px] bg-slate-100 py-3 text-sm font-bold text-slate-600 dark:bg-white/[0.05] dark:text-slate-300">{deletingDocumentId ? '取消等待' : '取消'}</button>
              <button type="button" onClick={() => void handleDeleteDoc(deleteTarget.id)} disabled={Boolean(deletingDocumentId)} className="flex-1 rounded-[8px] bg-red-600 py-3 text-sm font-bold text-white disabled:opacity-60">
                <span className="inline-flex items-center justify-center gap-2">{deletingDocumentId ? <Loader2 size={14} className="animate-spin" /> : null}{deletingDocumentId ? '正在删除' : '确认删除'}</span>
              </button>
            </div>
          )}
        >
          <div className="rounded-[8px] bg-red-50 px-4 py-3 text-xs font-semibold leading-5 text-red-700 dark:bg-red-500/10 dark:text-red-300">删除后，使用该文档片段的知识检索结果也会随索引更新而变化。</div>
        </AppDialog>
      ) : null}</AnimatePresence>
      <input ref={fileInputRef} type="file" aria-label="选择要上传的知识库文档" className="hidden" disabled={!datasetOperational || uploading} accept={DOCUMENT_ACCEPT} onChange={handleFileUpload} />

      {/* Header (保留原有样式) */}
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-center">
        <div className="flex min-w-0 items-center gap-4 sm:gap-6">
          <Link href="/knowledge"
            className="w-10 h-10 rounded-full bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 flex items-center justify-center hover:bg-blue-100 dark:hover:bg-blue-500/20 transition-colors">
            <ArrowLeft size={20} />
          </Link>
          <div className="min-w-0">
            <h2 className="truncate text-3xl font-black text-slate-900 dark:text-white" title={!datasetInfo && loading ? '加载中...' : datasetInfo?.name || '知识库详情'}>
              {!datasetInfo && loading ? '加载中...' : datasetInfo?.name || '知识库详情'}
            </h2>
            <p className="mt-1 text-xs font-bold text-blue-600 dark:text-blue-400">{datasetDocumentTotalLabel} · {totalWordsLabel}</p>
            {!authLoading && !isAdmin ? <p className="mt-2 text-xs font-semibold leading-5 text-blue-700 dark:text-blue-300">当前账号可查看文档、索引状态并执行语义检索；上传、添加、修改和删除文档由管理员负责。</p> : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-3">
          <button type="button" onClick={() => void loadData(true)} disabled={loading} title="刷新文档与索引状态" aria-label="刷新文档与索引状态" className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] border border-slate-200 bg-white text-slate-500 transition hover:border-blue-200 hover:text-blue-600 disabled:cursor-wait disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-slate-300">
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
          </button>
          {authLoading ? <div className="inline-flex min-h-10 items-center gap-2 rounded-[8px] border border-slate-200 bg-white px-4 text-xs font-semibold text-slate-400 dark:border-white/[0.08] dark:bg-white/[0.04]"><Loader2 size={14} className="animate-spin" />正在确认权限</div> : isAdmin ? <>
            <button onClick={() => { if (datasetOperational) setShowTextDoc(true) }} disabled={!datasetOperational} title={datasetOperational ? '添加文本文档' : '请等待知识库详情与当前文档列表读取完成'} className="px-6 py-2 bg-slate-100 dark:bg-white/[0.05] text-slate-700 dark:text-slate-300 rounded-[8px] text-sm font-bold flex items-center gap-2 hover:bg-slate-200 dark:hover:bg-white/[0.04] transition-colors disabled:cursor-not-allowed disabled:opacity-50">
              <Plus size={18} /> 添加文本
            </button>
            <button onClick={() => uploading ? cancelUpload() : datasetOperational ? fileInputRef.current?.click() : undefined} disabled={!datasetOperational && !uploading} title={uploading ? '取消当前上传等待' : datasetOperational ? '上传知识库文档' : '请等待知识库详情与当前文档列表读取完成'}
              className="px-6 py-2 bg-blue-600 text-white rounded-[8px] text-sm font-bold shadow-lg shadow-blue-500/20 active:scale-95 transition-transform flex items-center gap-2 disabled:opacity-50">
              {uploading ? <X size={16} /> : <UploadCloud size={16} />} {uploading ? '取消等待' : '上传文件'}
            </button>
          </> : null}
        </div>
      </div>

      <div className="border-b border-slate-100 pb-3 dark:border-white/[0.06]">
        <button type="button" onClick={() => setShowTechnical((value) => !value)} aria-expanded={showTechnical}
          className="inline-flex items-center gap-2 text-xs font-bold text-slate-400 transition hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200">
          <Settings size={14} /> 技术详情 {showTechnical ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
        {showTechnical ? (
          <div className="mt-3 grid gap-3 rounded-[8px] bg-slate-50 px-4 py-3 text-xs text-slate-600 dark:bg-white/[0.04] dark:text-slate-300 sm:grid-cols-3">
            <TechnicalId value={datasetId} label="知识库 ID" />
            <TechnicalId value={datasetInfo?.indexing_technique} label="原始索引方式" />
            <TechnicalId value={datasetInfo?.embedding_model_provider} label="原始模型提供方" />
          </div>
        ) : null}
      </div>

      {loadError && hasLoadedData ? (
        <div className="rounded-[8px] border border-amber-200 bg-amber-50 px-5 py-4 text-sm font-semibold text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100" role="alert">
          {loadError}
          <button type="button" onClick={() => loadData(true)} disabled={loading} className="ml-3 font-black text-blue-600 hover:underline disabled:cursor-wait disabled:opacity-50 dark:text-blue-300">{loading ? '正在重新读取' : '重新加载'}</button>
        </div>
      ) : null}

      {loading && !hasLoadedData ? (
        <div className="flex items-center justify-center py-32">
          <Loader2 size={32} className="animate-spin text-slate-300 dark:text-slate-600" />
        </div>
      ) : !hasLoadedData && loadError ? (
        <div className="rounded-[8px] border border-dashed border-amber-200 px-6 py-20 text-center text-sm font-semibold text-amber-800 dark:border-amber-500/20 dark:text-amber-200" role="alert">
          <p className="font-black">知识库详情与文档列表未取得</p>
          <p className="mx-auto mt-2 max-w-xl break-words text-xs leading-5">{loadError}</p>
          <button type="button" onClick={() => loadData(true)} disabled={loading} className="mt-4 inline-flex min-h-9 items-center justify-center gap-2 rounded-[6px] border border-amber-200 bg-white px-3 text-xs font-black text-amber-800 disabled:cursor-wait disabled:opacity-50 dark:border-amber-400/20 dark:bg-white/[0.06] dark:text-amber-200">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />{loading ? '正在重新读取' : '重新读取知识库'}
          </button>
        </div>
      ) : (
        <div className="grid min-w-0 grid-cols-1 gap-8 lg:grid-cols-3">
          {/* Left Column */}
          <div className="min-w-0 space-y-8 lg:col-span-2">
            <div className="grid grid-cols-1 border border-slate-200 bg-white dark:border-white/[0.08] dark:bg-transparent xl:grid-cols-2">
              <section className="px-1 py-5 sm:px-5 xl:border-r xl:border-slate-200 dark:xl:border-white/[0.08]">
                <div className="flex items-start gap-4">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400">
                    <Layers3 size={22} />
                  </div>
                  <div className="space-y-2 min-w-0">
                    <h3 className="text-base font-black leading-tight text-slate-900 dark:text-white">文档接入</h3>
                    <p className="text-sm text-slate-500 dark:text-slate-400">{datasetDocumentTotal === null ? '文档总数暂未取得' : `当前共 ${datasetDocumentTotal} 份文档`}，支持按名称筛选和增量维护。</p>
                  </div>
                </div>
                <div className="mt-5 grid grid-cols-2 divide-x divide-slate-200 text-sm dark:divide-white/[0.08]">
                  <div className="pr-4"><span className="block text-xs font-bold text-slate-400">文档总数</span><strong className="mt-1 block text-slate-900 dark:text-white">{datasetDocumentTotal === null ? '未取得' : `${datasetDocumentTotal} 份`}</strong></div>
                  <div className="pl-4"><span className="block text-xs font-bold text-slate-400">总词数</span><strong className="mt-1 block text-slate-900 dark:text-white">{totalWords === null ? '未取得' : `${totalWords.toLocaleString()} 词`}</strong></div>
                </div>
              </section>

              <section className="border-t border-slate-200 px-1 py-5 dark:border-white/[0.08] sm:px-5 xl:border-t-0">
                <div className="flex items-start gap-4">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] bg-purple-50 text-purple-600 dark:bg-purple-500/10 dark:text-purple-400">
                    <BrainCircuit size={22} />
                  </div>
                  <div className="space-y-2 min-w-0">
                    <h3 className="text-base font-black leading-tight text-slate-900 dark:text-white">索引配置</h3>
                    <p className="text-sm text-slate-500 dark:text-slate-400">{indexingTechniqueLabel(datasetInfo?.indexing_technique)} · {embeddingProviderLabel(datasetInfo?.embedding_model_provider)}</p>
                  </div>
                </div>
                <div className="mt-5 grid grid-cols-2 divide-x divide-slate-200 text-sm dark:divide-white/[0.08]">
                  <div className="min-w-0 pr-4"><span className="block text-xs font-bold text-slate-400">嵌入模型</span><strong title={datasetInfo?.embedding_model || ''} className="mt-1 block truncate text-slate-900 dark:text-white">{embeddingModelLabel(datasetInfo?.embedding_model)}</strong></div>
                  <div className="min-w-0 pl-4"><span className="block text-xs font-bold text-slate-400">支持格式</span><strong className="mt-1 block truncate text-slate-900 dark:text-white" title={SUPPORTED_DOCUMENT_FORMATS}>{SUPPORTED_DOCUMENT_FORMATS}</strong></div>
                </div>
              </section>
            </div>

            {/* Semantic Retrieval Card (保留原有样式, 接入真实 API) */}
            <div className="space-y-6 rounded-2xl border border-slate-100 bg-white p-5 shadow-sm dark:border-white/[0.06] dark:bg-transparent dark:bg-gradient-to-b dark:from-white/[0.06] dark:to-white/[0.02] sm:p-8">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 space-y-2">
                  <h3 className="text-xl font-bold text-slate-900 dark:text-white">语义检索</h3>
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    支持用户问题的相关内容匹配与知识调用。
                  </p>
                </div>
                <span className="inline-flex h-6 items-center rounded-full bg-blue-50 px-3 text-xs font-bold leading-none text-blue-600 dark:bg-blue-500/10 dark:text-blue-400">
                  {datasetInfo?.embedding_available ? '检索已启用' : '检索能力待确认'}
                </span>
              </div>

              <div className="flex flex-wrap gap-2">
                <span className="inline-flex h-6 items-center rounded-full bg-emerald-50 px-3 text-xs font-bold leading-none text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400">
                  相关内容匹配
                </span>
                <span className="inline-flex h-6 items-center rounded-full bg-blue-50 px-3 text-xs font-bold leading-none text-blue-600 dark:bg-blue-500/10 dark:text-blue-400">
                  知识调用
                </span>
              </div>

              <div className="flex min-w-0 flex-col gap-2 sm:relative sm:block">
                <div className="absolute left-4 top-1/2 -translate-y-1/2 text-blue-600">
                  <Zap size={20} fill="currentColor" />
                </div>
                <input
                  type="text"
                  aria-label="输入语义检索问题"
                  value={searchQuery}
                  maxLength={2000}
                  disabled={!datasetRetrievalAvailable || searching}
                  onChange={e => handleSearchQueryChange(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleHitTesting()}
                  placeholder="输入用户问题以进行语义检索..."
                  className="w-full rounded-[8px] border-none bg-slate-50 py-4 pl-12 pr-4 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:ring-2 focus:ring-blue-500/20 dark:bg-white/[0.05] dark:text-white dark:placeholder:text-slate-500 sm:pr-36"
                />
                <button onClick={handleHitTesting} disabled={!searching && (!datasetRetrievalAvailable || !searchQuery.trim())}
                  className={`flex min-h-10 w-full items-center justify-center gap-2 rounded-[8px] px-5 py-2 text-sm font-bold text-white shadow-sm disabled:opacity-50 sm:absolute sm:right-2 sm:top-1/2 sm:min-h-0 sm:w-auto sm:-translate-y-1/2 ${searching ? 'bg-amber-600' : 'bg-blue-600'}`}>
                  {searching ? <X size={14} /> : null}
                  {searching ? '取消检索' : '开始检索'}
                </button>
              </div>
              {searchQuery.length >= 1600 ? <p className="text-right text-xs font-semibold text-slate-400">{searchQuery.length} / 2000 字</p> : null}

              {/* Hit Testing Results */}
              <AnimatePresence>
                {showResults && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="space-y-3 overflow-hidden"
                  >
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-bold text-slate-500 dark:text-slate-400">
                        检索结果 ({hitRecords.length})
                      </p>
                      {searchEvidence || hitRecords.length > 0 ? (
                        <button onClick={() => { setShowResults(false); setHitRecords([]); setSearchEvidence(null) }}
                          className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 font-bold">清除</button>
                      ) : null}
                    </div>

                    {searching ? (
                      <div className="flex items-center justify-center py-6">
                        <Loader2 size={20} className="animate-spin text-blue-500" />
                        <span className="ml-2 text-sm text-slate-400">正在检索...</span>
                      </div>
                    ) : hitRecords.length > 0 ? (
                      <div className="space-y-4">
                      <div className="rounded-[8px] border border-blue-100 bg-blue-50/60 px-4 py-3 text-sm text-blue-700 dark:border-blue-500/10 dark:bg-blue-500/10 dark:text-blue-300">
                          <span className="font-bold">知识调用结果:</span> 系统已根据用户问题完成相关内容匹配，并返回可直接用于知识调用的检索片段。
                          <div className="mt-2 grid gap-2 text-xs md:grid-cols-2">
                            <span>检索问题：<span className="font-bold">{lastSearchQuery || searchQuery}</span></span>
                            <span>命中片段：<span className="font-bold">{hitRecords.length} 条</span></span>
                            {searchEvidence ? <span>执行时间：<span className="font-bold">{formatExecutionTime(searchEvidence.executed_at)}</span></span> : null}
                            {searchEvidence ? <span>执行耗时：<span className="font-bold">{searchEvidence.duration_ms} ms</span></span> : null}
                          </div>
                          {searchEvidence?.audit_recorded ? <Link href="/activity-logs?type=knowledge_management" className="mt-2 inline-flex items-center gap-1 text-xs font-bold text-blue-700 hover:underline dark:text-blue-300">查看检索操作记录<ChevronRight size={13} /></Link> : null}
                        </div>
                        {hitRecords.map((rec, i) => (
                          <motion.div
                            key={rec.segment_id || i}
                            initial={{ y: 10, opacity: 0 }}
                            animate={{ y: 0, opacity: 1 }}
                            transition={{ delay: i * 0.1 }}
                            className="space-y-2 border-t border-slate-100 py-4 first:border-t-0 dark:border-white/[0.06]"
                          >
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-bold text-blue-600 dark:text-blue-400">
                                来源: {rec.document_name}
                              </span>
                              <span className="inline-flex h-6 shrink-0 items-center rounded-full bg-slate-100 px-2 text-xs font-bold leading-none text-slate-500 dark:bg-white/[0.06] dark:text-slate-300">
                                相关度: {(rec.score * 100).toFixed(1)}%
                              </span>
                            </div>
                            <p className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed line-clamp-3">
                              {rec.content}
                            </p>
                            <details className="text-xs font-bold text-slate-500 dark:text-slate-400">
                              <summary className="cursor-pointer select-none">技术详情</summary>
                              <div className="mt-3 grid gap-3 md:grid-cols-2">
                                <TechnicalId value={rec.document_id} label="文档 ID" compact />
                                <TechnicalId value={rec.segment_id} label="片段 ID" compact />
                                <span className="md:col-span-2">原始分数：{rec.score.toFixed(4)} · {rec.word_count} 词</span>
                              </div>
                            </details>
                          </motion.div>
                        ))}
                      </div>
                    ) : searchError ? (
                      <div className="rounded-[8px] bg-red-50 px-4 py-4 text-sm font-semibold text-red-700 dark:bg-red-500/10 dark:text-red-300">{searchError}</div>
                    ) : (
                      <div className="space-y-2 py-6 text-center text-sm text-slate-400 dark:text-slate-500">
                        <p>没有匹配的检索结果。可以换一个更具体的问题，或检查文档是否已完成索引。</p>
                        {searchEvidence ? <p className="text-xs">本次耗时 {searchEvidence.duration_ms} ms · {formatExecutionTime(searchEvidence.executed_at)}{searchEvidence.audit_recorded ? ' · 已记录到活动日志' : ' · 活动日志记录失败'}</p> : null}
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Document Library (保留原有样式, 增加筛选) */}
            <div className="bg-white dark:bg-transparent dark:bg-gradient-to-b dark:from-white/[0.06] dark:to-white/[0.02] rounded-2xl shadow-sm border border-slate-100 dark:border-white/[0.06] overflow-hidden">
              <div className="flex flex-col gap-4 border-b border-slate-100 px-5 py-5 dark:border-white/[0.06] sm:px-8 sm:py-6 lg:flex-row lg:items-center lg:justify-between">
                <div className="space-y-2">
                  <h3 className="text-xl font-bold text-slate-900 dark:text-white">知识库的增量更新与管理</h3>
                  <p className="text-sm text-slate-500 dark:text-slate-400">支持动态添加、修改、删除文档，并通过筛选和状态管理持续更新知识内容。</p>
                </div>
                <div className="relative w-full lg:w-64">
                  <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input value={docFilter} onChange={e => handleDocumentFilterChange(e.target.value)} placeholder="搜索文档名称"
                    aria-label="搜索文档名称"
                    className="h-10 w-full rounded-[8px] border border-slate-200 bg-slate-50 pl-9 pr-16 text-sm text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-blue-400 focus:bg-white dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-white dark:focus:border-blue-500 dark:focus:bg-white/[0.08]" />
                  {docFilter ? <button type="button" onClick={() => handleDocumentFilterChange('')} aria-label="清除文档搜索" className="absolute right-1.5 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-[6px] text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-white/[0.08] dark:hover:text-white"><X size={14} /></button> : null}
                  {loading && debouncedDocFilter ? <Loader2 size={14} className={`absolute top-1/2 -translate-y-1/2 animate-spin text-blue-500 ${docFilter ? 'right-10' : 'right-3'}`} /> : null}
                </div>
              </div>
              <div className="border-b border-slate-100 px-5 py-5 dark:border-white/[0.06] sm:px-8">
                <p className="mb-3 text-xs font-bold text-slate-400 dark:text-slate-500">{documentsLoaded ? `${indexingScope}索引状态` : '文档索引状态'}</p>
                <div className="grid overflow-hidden rounded-[8px] border border-slate-200 bg-white sm:grid-cols-4 dark:border-white/[0.08] dark:bg-transparent">
                  {[
                    { key: 'completed', label: '索引完成', value: indexingSummary.completed, color: 'text-emerald-600 dark:text-emerald-400' },
                    { key: 'indexing', label: '正在索引', value: indexingSummary.indexing, color: 'text-blue-600 dark:text-blue-400' },
                    { key: 'waiting', label: '等待 / 待确认', value: indexingSummary.waiting, color: 'text-amber-600 dark:text-amber-400' },
                    { key: 'error', label: '处理失败', value: indexingSummary.error, color: 'text-red-600 dark:text-red-400' },
                  ].map((item) => (
                    <div key={item.key} className="border-b border-slate-100 px-4 py-3 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0 dark:border-white/[0.06]">
                      <p className="text-xs font-bold text-slate-400 dark:text-slate-500">{item.label}</p>
                      <p className={`mt-1 text-xl font-black ${documentsLoaded ? item.color : 'text-slate-400 dark:text-slate-500'}`}>{documentsLoaded ? item.value : '—'}</p>
                    </div>
                  ))}
                </div>
                {!documentsLoaded ? (
                  <div className="mt-4 rounded-[8px] bg-amber-50 px-4 py-3 text-xs font-semibold leading-5 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
                    {loading ? '正在读取文档索引状态。' : '文档索引状态未取得，请检查 Dify 知识库连接后重新加载。'}
                  </div>
                ) : documents.length === 0 ? (
                  <div className="mt-4 rounded-[8px] bg-slate-50 px-4 py-3 text-xs font-semibold text-slate-600 dark:bg-white/[0.04] dark:text-slate-300">
                    当前范围暂无文档，尚无可判断的索引状态。
                  </div>
                ) : hasUnreadyDocs ? (
                  <div className="mt-4 rounded-[8px] bg-amber-50 px-4 py-3 text-xs font-semibold leading-5 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
                    正在索引或等待处理的文档请稍后刷新；处理失败的文档可替换内容或重新上传，再执行语义检索验证。
                  </div>
                ) : (
                  <div className="mt-4 rounded-[8px] bg-emerald-50 px-4 py-3 text-xs font-semibold text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
                    {indexingScope === '全部文档' ? '全部文档索引均已完成' : `${indexingScope}的文档索引均已完成`}，当前范围可用于语义检索验证。
                  </div>
                )}
                {retainedDocumentSnapshot ? (
                  <div className="mt-4 border-l-2 border-amber-400 bg-amber-50 px-4 py-3 text-xs font-semibold leading-5 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
                    当前条件读取失败，下方暂时保留上一次成功结果：{loadedDocFilter ? `“${loadedDocFilter}”筛选` : '全部文档'}第 {loadedDocPage} 页。
                  </div>
                ) : null}
              </div>
              {updatingDocumentSnapshot ? (
                <div className="flex items-center gap-2 border-b border-blue-100 bg-blue-50/60 px-5 py-2.5 text-xs font-semibold text-blue-700 dark:border-blue-500/10 dark:bg-blue-500/10 dark:text-blue-300 sm:px-6" role="status">
                  <Loader2 size={14} className="animate-spin" />
                  正在更新文档，当前暂时显示上一次成功结果
                </div>
              ) : null}
              <div className="max-w-full overflow-x-auto overscroll-x-contain [contain:inline-size_layout_paint]" tabIndex={0} role="region" aria-label="知识库文档列表，可横向滚动">
                <table className="w-full min-w-[720px] table-auto text-left [&_td]:align-middle [&_th]:whitespace-nowrap">
                  <colgroup>
                    <col className="w-[42%]" />
                    <col className="w-[14%]" />
                    <col className="w-[16%]" />
                    <col className="w-[20%]" />
                    <col className="w-[8%]" />
                  </colgroup>
                  <thead>
                    <tr className="bg-slate-50/50 dark:bg-white/[0.04]">
                      <th className="px-5 py-3 text-xs font-bold text-slate-500 dark:text-slate-400 sm:px-6">文档名称</th>
                      <th className="px-5 py-3 text-xs font-bold text-slate-500 dark:text-slate-400 sm:px-6">词数</th>
                      <th className="px-5 py-3 text-xs font-bold text-slate-500 dark:text-slate-400 sm:px-6">状态</th>
                      <th className="px-5 py-3 text-xs font-bold text-slate-500 dark:text-slate-400 sm:px-6">创建时间</th>
                      <th className="px-5 py-3 sm:px-6"><span className="sr-only">操作</span></th>
                    </tr>
                  </thead>
                  <tbody>
                  {documents.length > 0 ? (
                      documents.map(doc => (
                        <DocumentRow key={doc.id} name={doc.name} wordCount={doc.word_count}
                          status={doc.indexing_status} createdAt={doc.created_at}
                          canManage={isAdmin}
                          interactionDisabled={!datasetOperational}
                          onEdit={() => {
                            if (!datasetOperational) {
                              setToast({ message: 'Dify 实时详情或文档列表当前不可用，请刷新成功后再修改', type: 'error' })
                              return
                            }
                            setEditTarget(doc)
                          }}
                          onDelete={() => {
                            if (!datasetOperational) {
                              setToast({ message: 'Dify 实时详情或文档列表当前不可用，请刷新成功后再删除', type: 'error' })
                              return
                            }
                            setDeleteTarget(doc)
                          }} />
                      ))
                    ) : (
                      <tr>
                        <td colSpan={5} className="px-8 py-12 text-center text-slate-400 dark:text-slate-500">
                          {!documentsLoaded
                            ? '文档列表未取得，请检查 Dify 知识库配置后重试'
                            : debouncedDocFilter
                              ? `没有匹配「${debouncedDocFilter}」的文档`
                              : isAdmin ? '暂无文档，点击上方「上传文件」或「添加文本」添加' : '暂无文档'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {documentsLoaded ? <Pagination
                page={loadedDocPage}
                pageSize={loadedDocPageSize}
                total={docTotal}
                itemName="份文档"
                loading={loading}
                navigationDisabled={!documentSnapshotMatchesView}
                onPageChange={handleDocumentPageChange}
                onPageSizeChange={handleDocumentPageSizeChange}
                pageSizeOptions={[10, 20, 50]}
              /> : null}
            </div>
          </div>

          {/* Right Column (保留原有样式) */}
          <div className="min-w-0 space-y-8">
            {/* Dataset Health Card */}
            <div className="bg-blue-600 p-8 rounded-2xl text-white shadow-xl shadow-blue-500/20 space-y-8">
              <p className="text-xs font-bold opacity-80">知识库索引概览</p>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-4xl font-black">{totalWords === null ? '—' : totalWords >= 1000 ? `${(totalWords / 1000).toFixed(1)}k` : totalWords}</p>
                  <p className="text-xs font-bold opacity-70">总词数</p>
                </div>
                <div className="text-right">
                  <p className="text-4xl font-black">{indexingHeadline}</p>
                  <p className="text-xs font-bold opacity-70">{indexingHeadlineLabel}</p>
                </div>
              </div>
              <div className="h-2 bg-white/20 rounded-full overflow-hidden">
                <motion.div initial={{ width: 0 }} animate={{ width: documents.length ? `${healthPercent}%` : '0%' }}
                  transition={{ duration: 1, delay: 0.5 }} className="h-full bg-white rounded-full" />
              </div>
              <p className="text-xs font-semibold leading-5 text-white/75">
                {totalWords === null ? '总词数尚未取得；' : '总词数来自知识库详情；'}{allDatasetDocumentsLoaded ? '完成率覆盖全部文档。' : `${indexingScope}只显示已索引数量，不用分页样本推算整个知识库。`}
              </p>
            </div>

            <div className="min-w-0 overflow-hidden rounded-[8px] border border-slate-300 bg-white ring-1 ring-inset ring-slate-100 dark:border-white/[0.18] dark:bg-transparent dark:ring-white/[0.04]">
              <div className="space-y-2 px-5 py-5">
                <h3 className="text-base font-black leading-tight text-slate-900 dark:text-white">向量检索能力</h3>
                <p className="text-sm text-slate-500 dark:text-slate-400">当前知识库的真实向量化和索引状态。</p>
              </div>
              <div className="divide-y divide-slate-200 border-t border-slate-200 text-sm dark:divide-white/[0.08] dark:border-white/[0.08]">
                <div className="flex min-w-0 items-start justify-between gap-5 px-5 py-3"><span className="shrink-0 font-semibold leading-5 text-slate-500 dark:text-slate-400">向量功能</span><strong className="min-w-0 max-w-[65%] break-words text-right leading-5 text-slate-900 [overflow-wrap:anywhere] dark:text-white">{datasetInfo?.embedding_available ? '已启用' : '待确认'}</strong></div>
                <div className="flex min-w-0 items-start justify-between gap-5 px-5 py-3"><span className="shrink-0 font-semibold leading-5 text-slate-500 dark:text-slate-400">检索方式</span><strong className="min-w-0 max-w-[65%] break-words text-right leading-5 text-slate-900 [overflow-wrap:anywhere] dark:text-white">文本查询 / 语义检索</strong></div>
                <div className="flex min-w-0 items-start justify-between gap-5 px-5 py-3"><span className="shrink-0 font-semibold leading-5 text-slate-500 dark:text-slate-400">向量模型</span><strong title={datasetInfo?.embedding_model || ''} className="min-w-0 max-w-[65%] break-words text-right leading-5 text-slate-900 [overflow-wrap:anywhere] dark:text-white">{embeddingModelLabel(datasetInfo?.embedding_model)}</strong></div>
                <div className="flex min-w-0 items-start justify-between gap-5 px-5 py-3"><span className="shrink-0 font-semibold leading-5 text-slate-500 dark:text-slate-400">索引状态</span><strong className="min-w-0 max-w-[65%] break-words text-right leading-5 text-slate-900 [overflow-wrap:anywhere] dark:text-white">{indexingStatusText}</strong></div>
              </div>
            </div>

            {/* Upload Document Card */}
            {isAdmin ? <div onClick={() => datasetOperational && !uploading && fileInputRef.current?.click()}
              role="button" tabIndex={datasetOperational ? 0 : -1} aria-disabled={!datasetOperational} onKeyDown={(event) => { if (datasetOperational && (event.key === 'Enter' || event.key === ' ')) fileInputRef.current?.click() }}
              onDragEnter={(event) => { event.preventDefault(); if (datasetOperational) setDragActive(true) }}
              onDragOver={(event) => { event.preventDefault(); if (datasetOperational) setDragActive(true) }}
              onDragLeave={(event) => { event.preventDefault(); if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false) }}
              onDrop={(event) => { event.preventDefault(); setDragActive(false); if (datasetOperational) void uploadSelectedFile(event.dataTransfer.files?.[0]) }}
              className={`bg-white dark:bg-transparent dark:bg-gradient-to-b dark:from-white/[0.06] dark:to-white/[0.02] p-8 rounded-2xl border-2 border-dashed flex flex-col items-center text-center space-y-4 transition-colors ${!datasetOperational ? 'cursor-not-allowed border-slate-200 opacity-55 dark:border-white/[0.06]' : dragActive ? 'cursor-pointer border-blue-500 bg-blue-50/50 dark:border-blue-400 dark:bg-blue-500/10' : 'cursor-pointer border-slate-200 hover:border-blue-400 dark:border-white/[0.06] dark:hover:border-blue-500'}`}>
              <div className="w-16 h-16 rounded-full bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 flex items-center justify-center">
                {uploading ? <Loader2 size={32} className="animate-spin" /> : <UploadCloud size={32} />}
              </div>
              <div>
                <h4 className="font-bold text-slate-900 dark:text-white">上传文档</h4>
                <p className="text-sm text-slate-500 dark:text-slate-400 px-4">拖放文件到此处或点击浏览</p>
              </div>
              <p className="text-xs font-bold text-slate-400 dark:text-slate-500">
                支持格式：{SUPPORTED_DOCUMENT_FORMATS}（最大 50MB）
              </p>
            </div> : null}

            {/* Storage Insight Card */}
            <div className="bg-slate-50 dark:bg-gradient-to-b dark:from-white/[0.06] dark:to-white/[0.02] p-6 rounded-2xl space-y-6 border border-transparent dark:border-white/[0.06]">
              <p className="text-xs font-bold text-slate-400 dark:text-slate-500">存储洞察</p>
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-full bg-white dark:bg-white/[0.05] shadow-sm flex items-center justify-center text-slate-400 dark:text-slate-500">
                  <Database size={24} />
                </div>
                <div>
                  <p className="text-sm font-bold text-slate-900 dark:text-white">向量存储</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{datasetDocumentTotalLabel} · {totalWordsLabel}</p>
                </div>
              </div>
              <Link href="/docs?view=api&module=knowledge" className="w-full flex items-center justify-between text-blue-600 dark:text-blue-400 text-xs font-bold hover:underline">
                了解向量化
                <ChevronRight size={14} />
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default function KnowledgeBaseDetailPage() {
  return (
    <Suspense fallback={<div className="flex min-h-[50vh] items-center justify-center text-sm font-bold text-slate-400">正在读取知识库...</div>}>
      <KnowledgeBaseDetailContent />
    </Suspense>
  )
}
