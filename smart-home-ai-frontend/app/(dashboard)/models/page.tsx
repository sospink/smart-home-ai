'use client'

/**
 * 模型运行状态页
 * 查看已安装模型、当前模型、运行中模型和系统资源。
 */

import { Suspense, useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import {
  Cpu, DownloadCloud, Trash2, Info, Star, Activity,
  Loader2, XCircle, Wifi, WifiOff,
  Box, Lightbulb, ChevronDown, RefreshCw, Search, AlertTriangle, Copy,
} from 'lucide-react'
import { motion, AnimatePresence } from 'motion/react'
import { AppDialog } from '@/components/ui/AppDialog'
import { AppDrawer } from '@/components/ui/AppDrawer'
import {
  modelApi,
  type InstalledModel as Model,
  type ModelDetail,
  type RunningModel,
  type SystemMetrics,
} from '@/lib/api/models'
import { ApiError } from '@/lib/api/client'
import { useAuth } from '@/lib/hooks/useAuth'
import { InlineToast } from '@/components/ui/InlineToast'
import { Pagination } from '@/components/ui/Pagination'
import { TechnicalId } from '@/components/ui/TechnicalId'
import { businessErrorMessage } from '@/lib/ui/business-error'

/* ══════════════════════════════════════════════
   Types
   ══════════════════════════════════════════════ */

type ReadSection = 'connectivity' | 'inventory' | 'running' | 'current' | 'metrics'

const MODEL_PAGE_SIZES = [6, 12, 24]

function modelPageSizeFromParam(value: string | null, fallback = 6) {
  const parsed = Number(value)
  return MODEL_PAGE_SIZES.includes(parsed) ? parsed : fallback
}

const READ_SECTION_LABELS: Record<ReadSection, string> = {
  connectivity: 'Ollama 连接',
  inventory: '模型清单',
  running: '运行状态',
  current: '当前模型',
  metrics: '系统资源',
}

function readErrorMessage(error: unknown, fallback: string) {
  return businessErrorMessage(error, { fallback, service: 'Ollama' })
}

function modelFamilyDescription(model: Model) {
  const family = String(model.family || '').trim()
  if (!family || family === '—') return '底层架构信息暂未提供'
  const modelBase = model.name.split(':')[0].toLowerCase()
  const normalizedFamily = family.toLowerCase()
  return modelBase.includes(normalizedFamily) || normalizedFamily.includes(modelBase)
    ? `${family} 模型家族`
    : `底层架构 · ${family}`
}

function formatModelDate(value?: string | null) {
  if (!value) return '时间未取得'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未取得' : date.toLocaleDateString('zh-CN')
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

/* ══════════════════════════════════════════════
   Sub-components
   ══════════════════════════════════════════════ */

/* ── Confirm Dialog ── */
function ConfirmDialog({ title, message, onConfirm, onCancel, loading }: {
  title: string; message: string; onConfirm: () => void; onCancel: () => void; loading: boolean
}) {
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null)
  return (
    <AppDialog
      title={title}
      onClose={loading ? () => undefined : onCancel}
      maxWidth="max-w-sm"
      danger
      closeOnOverlay={!loading}
      showClose={!loading}
      initialFocusRef={cancelButtonRef}
      footer={(
        <div className="flex justify-end gap-3">
          <button ref={cancelButtonRef} onClick={onCancel} className="rounded-[8px] px-5 py-2.5 text-sm font-bold text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 transition-colors">
            {loading ? <><Loader2 size={14} className="mr-2 inline animate-spin" />取消等待</> : '取消'}
          </button>
          {!loading ? (
            <button onClick={onConfirm} className="px-5 py-2.5 bg-red-500 text-white text-sm font-bold rounded-[8px] hover:bg-red-600 transition-colors flex items-center gap-2">
              确认删除
            </button>
          ) : null}
        </div>
      )}
    >
      <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">{message}</p>
      {loading ? (
        <p className="mt-3 text-xs font-medium leading-5 text-amber-700 dark:text-amber-300">
          删除请求已发送。取消等待只会停止当前页面等待，不会撤销 Ollama 可能正在执行的删除；页面随后会重新读取最终状态。
        </p>
      ) : null}
    </AppDialog>
  )
}

function CopyConfirmDialog({ source, destination, onConfirm, onCancel, loading }: {
  source: string; destination: string; onConfirm: () => void; onCancel: () => void; loading: boolean
}) {
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null)
  return (
    <AppDialog
      title="复制模型别名"
      description="此操作会在 Ollama 中创建一个指向同一模型数据的新名称。"
      onClose={loading ? () => undefined : onCancel}
      maxWidth="max-w-md"
      zIndexClass="z-[140]"
      closeOnOverlay={!loading}
      showClose={!loading}
      initialFocusRef={cancelButtonRef}
      footer={(
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button ref={cancelButtonRef} type="button" onClick={onCancel} className="min-h-10 rounded-[8px] px-5 py-2.5 text-sm font-bold text-slate-500 transition-colors hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200">
            {loading ? <><Loader2 size={14} className="mr-2 inline animate-spin" />取消等待</> : '返回修改'}
          </button>
          {!loading ? (
            <button type="button" onClick={onConfirm} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-[8px] bg-blue-600 px-5 py-2.5 text-sm font-bold text-white transition-colors hover:bg-blue-700">
              <Copy size={15} />确认创建别名
            </button>
          ) : null}
        </div>
      )}
    >
      <dl className="space-y-3 rounded-[8px] border border-slate-200 bg-slate-50 p-4 text-sm dark:border-white/[0.08] dark:bg-white/[0.04]">
        <div className="grid grid-cols-[4rem_minmax(0,1fr)] gap-3"><dt className="text-slate-400">源模型</dt><dd className="break-all font-bold text-slate-800 dark:text-slate-100">{source}</dd></div>
        <div className="grid grid-cols-[4rem_minmax(0,1fr)] gap-3"><dt className="text-slate-400">新名称</dt><dd className="break-all font-bold text-blue-700 dark:text-blue-300">{destination}</dd></div>
      </dl>
      {loading ? <p className="mt-3 text-xs font-medium leading-5 text-amber-700 dark:text-amber-300">请求已发送。取消等待不会撤销 Ollama 可能正在执行的复制，页面随后会重新读取最终模型清单。</p> : null}
    </AppDialog>
  )
}

/* ── Detail Drawer ── */
function DetailDrawer({ model, onClose, canManage, managementBusy, onRequestCopy }: {
  model: ModelDetail | null
  onClose: () => void
  canManage: boolean
  managementBusy: boolean
  onRequestCopy: (source: string, destination: string) => void
}) {
  const [showRaw, setShowRaw] = useState(false)
  const [showRuntimeConfig, setShowRuntimeConfig] = useState(false)
  const [showCopy, setShowCopy] = useState(false)
  const [copyName, setCopyName] = useState('')
  const [copyError, setCopyError] = useState('')
  if (!model) return null

  const validateCopyName = (value: string) => {
    const normalized = value.trim()
    if (!normalized) return '请输入新模型名称'
    if (normalized === model.name) return '新名称不能与源模型相同'
    if (normalized.length > 255) return '模型名称不能超过 255 个字符'
    if (/\s|[\u0000-\u001f\u007f]/.test(normalized)) return '模型名称不能包含空格或控制字符'
    if (/^[/:]|[/:]$/.test(normalized) || normalized.includes('//')) return '模型名称格式不正确，请检查路径和标签'
    return ''
  }

  const requestCopy = () => {
    const normalized = copyName.trim()
    const error = validateCopyName(normalized)
    setCopyError(error)
    if (error) return
    onRequestCopy(model.name, normalized)
  }

  const formatNum = (n: number | null | undefined) => {
    if (!n) return '—'
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
    return String(n)
  }

  const formatExactNumber = (n: number | null | undefined) => (
    n ? new Intl.NumberFormat('zh-CN').format(n) : '—'
  )

  const capColors: Record<string, string> = {
    completion: 'bg-blue-100 dark:bg-blue-500/15 text-blue-600 dark:text-blue-400',
    tools: 'bg-purple-100 dark:bg-purple-500/15 text-purple-600 dark:text-purple-400',
    thinking: 'bg-amber-100 dark:bg-amber-500/15 text-amber-600 dark:text-amber-400',
    vision: 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
    embedding: 'bg-teal-100 dark:bg-teal-500/15 text-teal-600 dark:text-teal-400',
  }
  const capLabels: Record<string, string> = {
    completion: '文本生成', tools: '工具调用', thinking: '思维链',
    vision: '视觉理解', embedding: '文本嵌入',
  }

  const arch = model.architecture
  const parameterSize = String(model.details.parameter_size || '').trim()
  const exactParameterSize = arch?.parameter_count ? formatNum(arch.parameter_count) : ''
  const primaryArchitecture = String(arch?.architecture || '').trim()
  const architectureFamily = String(model.details.families?.join(', ') || model.details.family || '').trim()
  const normalizedArchitecture = (value: string) => value.toLocaleLowerCase().replace(/[\s_-]+/g, '')
  const basicInfo = [
    { label: '参数量', value: parameterSize },
    { label: '量化方式', value: quantizationLabel(model.details.quantization_level), technicalValue: model.details.quantization_level },
    { label: '模型格式', value: model.details.format },
    { label: '架构', value: primaryArchitecture },
    {
      label: '精确参数量',
      value: exactParameterSize && normalizedArchitecture(exactParameterSize) !== normalizedArchitecture(parameterSize)
        ? exactParameterSize
        : null,
    },
    {
      label: '架构族',
      value: architectureFamily && normalizedArchitecture(architectureFamily) !== normalizedArchitecture(primaryArchitecture)
        ? architectureFamily
        : null,
    },
  ].filter(item => item.value && item.value !== '—' && item.value !== '0')
  const archGrid = [
    { label: '上下文长度', value: arch?.context_length ? `${formatExactNumber(arch.context_length)} 个词元` : null },
    { label: '嵌入维度', value: arch?.embedding_length ? formatExactNumber(arch.embedding_length) : null },
    { label: '网络层数', value: arch?.block_count ? formatExactNumber(arch.block_count) : null },
    { label: '注意力头数', value: arch?.head_count ? formatExactNumber(arch.head_count) : null },
    { label: '键值注意力头数', value: arch?.head_count_kv ? formatExactNumber(arch.head_count_kv) : null },
    { label: '前馈网络维度', value: arch?.feed_forward_length ? formatExactNumber(arch.feed_forward_length) : null },
  ].filter(x => x.value)

  return (
    <AppDrawer
      open={Boolean(model)}
      title="模型详情"
      onClose={onClose}
      widthClassName="max-w-lg"
      bodyClassName="p-0 sm:p-0"
    >
        <div className="p-8 space-y-6">
          {/* Name */}
          <div>
            <p className="mb-1 break-words text-2xl font-black text-slate-900 dark:text-white">{model.name}</p>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-slate-400 dark:text-slate-500">底层架构 · {model.details.family || '暂未提供'}</span>
              {model.details.parent_model && (
                <span className="text-xs text-slate-400 dark:text-slate-500">• 基于 {model.details.parent_model}</span>
              )}
              {model.modified_at && (
                <span className="text-xs text-slate-400 dark:text-slate-500">• {formatModelDate(model.modified_at)}</span>
              )}
            </div>
          </div>

          {/* Capabilities */}
          {model.capabilities && model.capabilities.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-semibold text-slate-400 dark:text-slate-500">模型能力</p>
              <div className="flex gap-2 flex-wrap">
                {model.capabilities.map(cap => (
                  <span key={cap} title={capLabels[cap] ? undefined : `技术能力：${cap}`} className={`px-3 py-1.5 rounded-full text-xs font-bold ${capColors[cap] || 'bg-slate-100 dark:bg-slate-700 text-slate-500'}`}>
                    {capLabels[cap] || '其他模型能力'}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Basic Info Grid */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {basicInfo.map(item => (
              <div key={item.label} className="rounded-lg border border-slate-100 bg-slate-50 p-4 dark:border-white/[0.06] dark:bg-white/[0.04]">
                <p className="mb-1 text-xs font-semibold text-slate-400 dark:text-slate-500">{item.label}</p>
                <p title={item.technicalValue ? `原始量化规格：${item.technicalValue}` : undefined} className="break-words text-sm font-bold text-slate-900 dark:text-white">{item.label === '模型格式' ? String(item.value).toUpperCase() : item.value || '—'}</p>
              </div>
            ))}
          </div>

          {model.details.quantization_level && model.details.quantization_level !== '—' ? (
            <TechnicalId value={model.details.quantization_level} label="原始量化规格" compact />
          ) : null}

          {canManage ? (
            <div className="border-y border-slate-100 py-3 dark:border-white/[0.06]">
              <button
                type="button"
                aria-expanded={showCopy}
                aria-controls="model-copy-alias"
                disabled={managementBusy}
                onClick={() => { setShowCopy(value => !value); setCopyError('') }}
                className="flex min-h-9 w-full items-center justify-between gap-3 text-left text-xs font-bold text-blue-600 transition hover:text-blue-700 disabled:cursor-wait disabled:opacity-60 dark:text-blue-400 dark:hover:text-blue-300"
              >
                <span className="inline-flex items-center gap-2"><Copy size={14} />复制模型别名</span>
                <ChevronDown size={15} className={`shrink-0 transition-transform ${showCopy ? 'rotate-180' : ''}`} />
              </button>
              {showCopy ? (
                <div id="model-copy-alias" className="mt-3 rounded-[8px] border border-slate-200 bg-slate-50 p-4 dark:border-white/[0.08] dark:bg-white/[0.04]">
                  <label htmlFor="model-copy-name" className="text-xs font-bold text-slate-600 dark:text-slate-300">新模型名称</label>
                  <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                    <input
                      id="model-copy-name"
                      value={copyName}
                      disabled={managementBusy}
                      onChange={(event) => { setCopyName(event.target.value); if (copyError) setCopyError('') }}
                      onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); requestCopy() } }}
                      placeholder={`${model.name.split(':')[0]}-copy:latest`}
                      aria-invalid={Boolean(copyError)}
                      aria-describedby={copyError ? 'model-copy-error' : 'model-copy-help'}
                      className="h-10 min-w-0 flex-1 rounded-[8px] border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none transition focus:border-blue-400 disabled:cursor-wait disabled:opacity-60 dark:border-white/[0.08] dark:bg-[#18181b] dark:text-white"
                    />
                    <button type="button" disabled={managementBusy} onClick={requestCopy} className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-[8px] bg-blue-600 px-4 text-sm font-bold text-white transition hover:bg-blue-700 disabled:cursor-wait disabled:opacity-60">
                      {managementBusy ? <Loader2 size={15} className="animate-spin" /> : <Copy size={15} />} 创建别名
                    </button>
                  </div>
                  {copyError ? <p id="model-copy-error" className="mt-2 text-xs font-semibold text-red-600 dark:text-red-300">{copyError}</p> : <p id="model-copy-help" className="mt-2 text-xs leading-5 text-slate-400 dark:text-slate-500">仅创建新名称，不会重复占用完整模型磁盘空间。</p>}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Architecture Stats */}
          {archGrid.length > 0 && (
            <div>
              <p className="mb-3 text-xs font-semibold text-slate-400 dark:text-slate-500">网络结构参数</p>
              <div className="space-y-3 rounded-lg border border-slate-100 bg-slate-50 p-4 dark:border-white/[0.06] dark:bg-white/[0.04]">
                {archGrid.map(item => (
                  <div key={item.label} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-4">
                    <span className="min-w-0 text-xs leading-5 text-slate-500 dark:text-slate-400">{item.label}</span>
                    <span className="max-w-52 break-words text-right text-xs font-bold leading-5 text-slate-900 dark:text-white">{item.value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {(model.system || model.template || model.parameters || model.license) && (
            <div className="border-y border-slate-100 py-3 dark:border-white/[0.06]">
              <button
                type="button"
                aria-expanded={showRuntimeConfig}
                aria-controls="model-runtime-config"
                onClick={() => setShowRuntimeConfig((value) => !value)}
                className="flex min-h-9 w-full items-center justify-between gap-3 text-left text-xs font-bold text-blue-600 transition hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
              >
                <span>{showRuntimeConfig ? '收起' : '展开'}高级运行配置</span>
                <ChevronDown size={15} className={`shrink-0 transition-transform ${showRuntimeConfig ? 'rotate-180' : ''}`} />
              </button>
              {showRuntimeConfig ? (
                <div id="model-runtime-config" className="mt-3 space-y-5">
                  {model.system ? <div><p className="mb-2 text-xs font-semibold text-slate-400 dark:text-slate-500">系统提示词</p><pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-slate-100 bg-slate-50 p-4 text-xs leading-relaxed text-slate-700 dark:border-white/[0.06] dark:bg-white/[0.04] dark:text-slate-300">{model.system}</pre></div> : null}
                  {model.template ? <div><p className="mb-2 text-xs font-semibold text-slate-400 dark:text-slate-500">对话模板</p><pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-all rounded-lg border border-slate-100 bg-slate-50 p-4 font-mono text-xs leading-relaxed text-slate-700 dark:border-white/[0.06] dark:bg-white/[0.04] dark:text-slate-300">{model.template}</pre></div> : null}
                  {model.parameters ? <div><p className="mb-2 text-xs font-semibold text-slate-400 dark:text-slate-500">推理参数</p><pre className="whitespace-pre-wrap break-all rounded-lg border border-slate-100 bg-slate-50 p-4 font-mono text-xs text-slate-700 dark:border-white/[0.06] dark:bg-white/[0.04] dark:text-slate-300">{model.parameters}</pre></div> : null}
                  {model.license ? <div><p className="mb-2 text-xs font-semibold text-slate-400 dark:text-slate-500">许可证</p><pre className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg border border-slate-100 bg-slate-50 p-4 text-xs text-slate-700 dark:border-white/[0.06] dark:bg-white/[0.04] dark:text-slate-300">{model.license}</pre></div> : null}
                </div>
              ) : null}
            </div>
          )}

          {/* Raw model_info toggle */}
          {model.model_info && Object.keys(model.model_info).length > 0 && (
            <div>
              <button
                type="button"
                aria-expanded={showRaw}
                aria-controls="model-raw-metadata"
                onClick={() => setShowRaw(!showRaw)}
                className="flex min-h-9 w-full items-center justify-between gap-3 text-left text-xs font-semibold text-blue-500 transition hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300"
              >
                <span>{showRaw ? '收起' : '展开'}原始元数据（{Object.keys(model.model_info).length} 项）</span>
                <ChevronDown size={15} className={`shrink-0 transition-transform ${showRaw ? 'rotate-180' : ''}`} />
              </button>
              {showRaw && (
                <pre id="model-raw-metadata" className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-slate-100 bg-slate-50 p-4 font-mono text-[11px] leading-relaxed text-slate-600 dark:border-white/[0.06] dark:bg-white/[0.04] dark:text-slate-400">
                  {JSON.stringify(model.model_info, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>
    </AppDrawer>
  )
}

/* ── Model Card ── */
function ModelCard({ model, onDelete, onDetail, onCancelDetail, isCurrent, onSetCurrent, runtimeUnavailable, interactionDisabled, managementBusy, pendingAction, canManage }: {
  model: Model; onDelete: (name: string) => void; onDetail: (name: string, trigger: HTMLButtonElement) => void; onCancelDetail: () => void;
  isCurrent: boolean; onSetCurrent: (name: string) => void; runtimeUnavailable: boolean; interactionDisabled: boolean; managementBusy: boolean;
  pendingAction?: 'detail' | 'current'; canManage: boolean;
}) {
  const familyColors: Record<string, string> = {
    'qwen2': 'bg-blue-500', 'qwen2.5': 'bg-blue-500', 'qwen3': 'bg-blue-500',
    'llama': 'bg-orange-500', 'gemma': 'bg-emerald-500', 'gemma2': 'bg-emerald-500',
    'phi': 'bg-purple-500', 'mistral': 'bg-indigo-500', 'deepseek': 'bg-cyan-500',
    'nomic-bert': 'bg-teal-500', 'bert': 'bg-teal-500',
  }
  const brandFamily = model.name.toLowerCase().includes('deepseek') ? 'deepseek' : model.family
  const iconColor = familyColors[brandFamily] || 'bg-slate-500'
  const familyDescription = modelFamilyDescription(model)

  return (
    <motion.div layout initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95 }}
      className={`bg-white dark:bg-white/[0.05] p-8 rounded-2xl border-2 shadow-sm hover:shadow-md transition-all ${
        isCurrent
          ? 'border-amber-400 dark:border-amber-500 ring-2 ring-amber-400/20 dark:ring-amber-500/20'
          : 'border-slate-100 dark:border-white/[0.06]'
      }`}
    >
      <div className="flex justify-between items-start mb-6">
        <div className={`flex h-12 w-12 items-center justify-center rounded-lg text-white shadow-lg ${iconColor}`}><Cpu size={24} /></div>
        <div className="flex items-center gap-2">
          {isCurrent && (
            <span className="flex min-h-6 items-center gap-1 rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-600 dark:bg-amber-500/15 dark:text-amber-400">
              <Star size={12} className="fill-current" /> 当前使用模型
            </span>
          )}
          <span title={model.quantization_level && model.quantization_level !== '—' ? `原始量化规格：${model.quantization_level}` : undefined} className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-500 dark:bg-slate-700 dark:text-slate-400">{quantizationLabel(model.quantization_level)}</span>
        </div>
      </div>
      <h3 title={model.name} className="mb-2 min-w-0 break-words text-2xl font-black leading-tight text-slate-900 [overflow-wrap:anywhere] dark:text-white">{model.name}</h3>
      <p title={familyDescription} className="mb-8 text-sm text-slate-500 dark:text-slate-400">{familyDescription}</p>
      <div className="grid grid-cols-3 gap-4 mb-8 pt-6 border-t border-slate-50 dark:border-white/[0.06]">
        <div>
          <p className="mb-1 text-xs font-semibold text-slate-400 dark:text-slate-500">参数量</p>
          <p className="text-sm font-bold text-slate-900 dark:text-white">{model.parameter_size}</p>
        </div>
        <div>
          <p className="mb-1 text-xs font-semibold text-slate-400 dark:text-slate-500">磁盘占用</p>
          <p className="text-sm font-bold text-slate-900 dark:text-white">{model.size_display}</p>
        </div>
        <div>
          <p className="mb-1 text-xs font-semibold text-slate-400 dark:text-slate-500">修改时间</p>
          <p className="text-sm font-bold text-slate-900 dark:text-white">{model.modified_display}</p>
        </div>
      </div>
      <div className="flex gap-3">
        {!isCurrent && canManage ? (
          <button disabled={runtimeUnavailable || interactionDisabled || managementBusy} title={managementBusy ? '请等待当前模型管理操作完成' : '设为当前使用模型'} onClick={() => onSetCurrent(model.name)} className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-amber-500 px-6 py-3 text-sm font-bold text-white transition-colors hover:bg-amber-600 active:scale-95 disabled:cursor-not-allowed disabled:opacity-45">
            {pendingAction === 'current' ? <Loader2 size={16} className="animate-spin" /> : <Star size={16} />}
            {pendingAction === 'current' ? '正在切换' : '设为当前使用模型'}
          </button>
        ) : (
          <button disabled={runtimeUnavailable || interactionDisabled} onClick={(event) => pendingAction === 'detail' ? onCancelDetail() : onDetail(model.name, event.currentTarget)} className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-blue-600 px-6 py-3 text-sm font-bold text-white transition-colors hover:bg-blue-700 active:scale-95 disabled:cursor-not-allowed disabled:opacity-45">
            {pendingAction === 'detail' ? <XCircle size={16} /> : <Info size={16} />}
            {pendingAction === 'detail' ? '取消详情等待' : '详情'}
          </button>
        )}
        {!isCurrent && canManage && (
          <button disabled={runtimeUnavailable || interactionDisabled} aria-label={pendingAction === 'detail' ? `取消读取${model.name}详情` : `查看${model.name}详情`} title={pendingAction === 'detail' ? '取消详情等待' : '查看详情'} onClick={(event) => pendingAction === 'detail' ? onCancelDetail() : onDetail(model.name, event.currentTarget)} className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-slate-50 text-slate-400 transition-colors hover:bg-blue-50 hover:text-blue-500 disabled:cursor-not-allowed disabled:opacity-45 dark:bg-slate-700 dark:text-slate-500 dark:hover:bg-blue-500/15 dark:hover:text-blue-400">
            {pendingAction === 'detail' ? <XCircle size={18} /> : <Info size={18} />}
          </button>
        )}
        {canManage && !isCurrent ? (
          <button disabled={runtimeUnavailable || interactionDisabled || managementBusy} aria-label={`删除${model.name}`} title={managementBusy ? '请等待当前模型管理操作完成' : '删除模型'} onClick={() => onDelete(model.name)} className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-slate-50 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-45 dark:bg-slate-700 dark:text-slate-500 dark:hover:bg-red-500/15 dark:hover:text-red-400">
            <Trash2 size={18} />
          </button>
        ) : null}
      </div>
    </motion.div>
  )
}

/* ══════════════════════════════════════════════
   Main Page
   ══════════════════════════════════════════════ */

function ModelsContent() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { isAdmin, loading: authLoading } = useAuth()
  const [models, setModels] = useState<Model[]>([])
  const [running, setRunning] = useState<RunningModel[]>([])
  const [loading, setLoading] = useState(true)
  const [ollamaOnline, setOllamaOnline] = useState<boolean | null>(null)
  const [ollamaVersion, setOllamaVersion] = useState('')
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [confirmCopy, setConfirmCopy] = useState<{ source: string; destination: string } | null>(null)
  const [copying, setCopying] = useState(false)
  const [detailLoadingName, setDetailLoadingName] = useState('')
  const [settingCurrentName, setSettingCurrentName] = useState('')
  const [detailModel, setDetailModel] = useState<ModelDetail | null>(null)
  const [currentModel, setCurrentModel] = useState('')
  const [sysMetrics, setSysMetrics] = useState<SystemMetrics | null>(null)
  const [sectionErrors, setSectionErrors] = useState<Partial<Record<ReadSection, string>>>({})
  const [refreshing, setRefreshing] = useState(false)
  const [inventoryRefreshing, setInventoryRefreshing] = useState(false)
  const [modelPage, setModelPage] = useState(() => {
    const value = Number(searchParams.get('page') || 1)
    return Number.isInteger(value) && value > 0 ? value : 1
  })
  const [modelPageSize, setModelPageSize] = useState(() => modelPageSizeFromParam(searchParams.get('size')))
  const [modelTotal, setModelTotal] = useState(0)
  const [modelInventoryTotal, setModelInventoryTotal] = useState(0)
  const [modelInventorySize, setModelInventorySize] = useState(0)
  const [modelQuery, setModelQuery] = useState(() => searchParams.get('q') || '')
  const [debouncedModelQuery, setDebouncedModelQuery] = useState(() => (searchParams.get('q') || '').trim())
  const [modelSearchSettled, setModelSearchSettled] = useState(true)
  const [inventoryLoaded, setInventoryLoaded] = useState(false)
  const [loadedModelQuery, setLoadedModelQuery] = useState('')
  const [loadedModelPage, setLoadedModelPage] = useState(1)
  const [loadedModelPageSize, setLoadedModelPageSize] = useState(6)
  const [inventoryRefreshVersion, setInventoryRefreshVersion] = useState(0)
  const [runningLoaded, setRunningLoaded] = useState(false)
  const [currentLoaded, setCurrentLoaded] = useState(false)
  const [metricsLoaded, setMetricsLoaded] = useState(false)
  const [lastSuccessfulReadAt, setLastSuccessfulReadAt] = useState<Date | null>(null)
  const hasLoadedRef = useRef(false)
  const lastSuccessfulReadAtRef = useRef(0)
  const requestSequenceRef = useRef(0)
  const inventoryRequestSequenceRef = useRef(0)
  const detailRequestSequenceRef = useRef(0)
  const currentRequestSequenceRef = useRef(0)
  const deleteRequestSequenceRef = useRef(0)
  const copyRequestSequenceRef = useRef(0)
  const refreshInFlightRef = useRef(0)
  const detailInFlightRef = useRef('')
  const detailAbortRef = useRef<AbortController | null>(null)
  const detailReturnFocusRef = useRef<HTMLButtonElement | null>(null)
  const currentInFlightRef = useRef('')
  const currentAbortRef = useRef<AbortController | null>(null)
  const deleteInFlightRef = useRef('')
  const deleteAbortRef = useRef<AbortController | null>(null)
  const copyInFlightRef = useRef('')
  const copyAbortRef = useRef<AbortController | null>(null)
  const mutationReconcileRef = useRef(0)
  const mutationReconcileTimerRef = useRef<number | null>(null)
  const overviewAbortRef = useRef<AbortController | null>(null)
  const inventoryAbortRef = useRef<AbortController | null>(null)
  const writtenSearchRef = useRef(searchParams.toString())
  const loadModels = useCallback(async (force = false) => {
    overviewAbortRef.current?.abort()
    const requestSequence = ++requestSequenceRef.current
    const overviewController = new AbortController()
    overviewAbortRef.current = overviewController
    if (force) refreshInFlightRef.current = requestSequence
    if (!hasLoadedRef.current) setLoading(true)
    else setRefreshing(true)

    const updateError = (section: ReadSection, message?: string) => {
      if (requestSequence !== requestSequenceRef.current) return
      setSectionErrors(previous => {
        const next = { ...previous }
        if (message) next[section] = message
        else delete next[section]
        return next
      })
    }

    const markSuccess = () => {
      if (requestSequence !== requestSequenceRef.current) return
      const now = Date.now()
      lastSuccessfulReadAtRef.current = now
      setLastSuccessfulReadAt(new Date(now))
    }

    const versionRequest = modelApi.version(force, overviewController.signal).then(response => {
      if (requestSequence !== requestSequenceRef.current) return response
      setOllamaOnline(response.online)
      setOllamaVersion(response.version && response.version !== 'unknown' ? response.version : '')
      updateError('connectivity', response.online ? undefined : readErrorMessage(response.error, 'Ollama 服务当前不可达'))
      markSuccess()
      return response
    }).catch(error => {
      if (requestSequence === requestSequenceRef.current) {
        setOllamaOnline(false)
        updateError('connectivity', readErrorMessage(error, 'Ollama 连接检测失败'))
      }
      throw error
    })

    const runningRequest = modelApi.running(force, overviewController.signal).then(response => {
      if (requestSequence !== requestSequenceRef.current) return response
      setRunning(response.running || [])
      setRunningLoaded(true)
      updateError('running')
      markSuccess()
      return response
    }).catch(error => {
      updateError('running', readErrorMessage(error, '运行状态读取失败'))
      throw error
    })

    const currentRequest = modelApi.current(force, overviewController.signal).then(response => {
      if (requestSequence !== requestSequenceRef.current) return response
      setCurrentModel(response.current_model || '')
      setCurrentLoaded(true)
      updateError('current')
      markSuccess()
      return response
    }).catch(error => {
      updateError('current', readErrorMessage(error, '当前模型读取失败'))
      throw error
    })

    const metricsRequest = modelApi.metrics(force, overviewController.signal).then(response => {
      if (requestSequence !== requestSequenceRef.current) return response
      setSysMetrics(response)
      setMetricsLoaded(true)
      updateError('metrics')
      markSuccess()
      return response
    }).catch(error => {
      updateError('metrics', readErrorMessage(error, '系统资源读取失败'))
      throw error
    })

    await Promise.allSettled([versionRequest, runningRequest, currentRequest, metricsRequest])
    if (requestSequence === requestSequenceRef.current) {
      hasLoadedRef.current = true
      setLoading(false)
      setRefreshing(false)
    }
    if (refreshInFlightRef.current === requestSequence) refreshInFlightRef.current = 0
    if (overviewAbortRef.current === overviewController) overviewAbortRef.current = null
  }, [])

  const loadInventory = useCallback(async (force = false) => {
    inventoryAbortRef.current?.abort()
    const requestSequence = ++inventoryRequestSequenceRef.current
    const controller = new AbortController()
    inventoryAbortRef.current = controller
    setInventoryRefreshing(true)
    try {
      const response = await modelApi.listInstalled({
        page: modelPage,
        size: modelPageSize,
        ...(debouncedModelQuery ? { keyword: debouncedModelQuery } : {}),
      }, force, controller.signal)
      if (requestSequence !== inventoryRequestSequenceRef.current) return
      setModels(response.models || [])
      setModelTotal(response.total || 0)
      setModelPage(response.page || modelPage)
      const responsePageSize = modelPageSizeFromParam(String(response.size || ''), modelPageSize)
      setModelPageSize(responsePageSize)
      setModelInventoryTotal(response.summary?.total ?? response.total ?? 0)
      setModelInventorySize(response.summary?.total_size ?? response.total_size ?? 0)
      setLoadedModelQuery(debouncedModelQuery)
      setLoadedModelPage(response.page || modelPage)
      setLoadedModelPageSize(responsePageSize)
      setInventoryLoaded(true)
      setSectionErrors(previous => {
        if (!previous.inventory) return previous
        const next = { ...previous }
        delete next.inventory
        return next
      })
      const now = Date.now()
      lastSuccessfulReadAtRef.current = now
      setLastSuccessfulReadAt(new Date(now))
    } catch (error) {
      if (controller.signal.aborted) return
      if (requestSequence !== inventoryRequestSequenceRef.current) return
      setSectionErrors(previous => ({ ...previous, inventory: readErrorMessage(error, '模型清单读取失败') }))
    } finally {
      if (inventoryAbortRef.current === controller) inventoryAbortRef.current = null
      if (requestSequence === inventoryRequestSequenceRef.current) setInventoryRefreshing(false)
    }
  }, [debouncedModelQuery, modelPage, modelPageSize])

  useEffect(() => {
    if (!hasLoadedRef.current) void loadModels()
  }, [loadModels])

  useEffect(() => {
    let timer: number | null = null

    const stopRefresh = () => {
      if (timer === null) return
      window.clearInterval(timer)
      timer = null
    }
    const refreshIfStale = () => {
      if (overviewAbortRef.current || Date.now() - lastSuccessfulReadAtRef.current < 60_000) return
      void loadModels(false)
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
  }, [loadModels])

  useEffect(() => {
    if (!modelSearchSettled || modelQuery.trim() !== debouncedModelQuery) return
    void loadInventory()
  }, [debouncedModelQuery, inventoryRefreshVersion, loadInventory, modelQuery, modelSearchSettled])

  useEffect(() => {
    if (!Object.keys(sectionErrors).length) return
    const recoverFailedReads = () => {
      if (!navigator.onLine || document.hidden) return
      if (sectionErrors.inventory && !inventoryAbortRef.current) void loadInventory(true)
      if (
        !overviewAbortRef.current
        && (sectionErrors.connectivity || sectionErrors.running || sectionErrors.current || sectionErrors.metrics)
      ) {
        void loadModels(true)
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
  }, [loadInventory, loadModels, sectionErrors])

  useEffect(() => () => {
    requestSequenceRef.current += 1
    inventoryRequestSequenceRef.current += 1
    detailRequestSequenceRef.current += 1
    currentRequestSequenceRef.current += 1
    deleteRequestSequenceRef.current += 1
    copyRequestSequenceRef.current += 1
    refreshInFlightRef.current = 0
    detailAbortRef.current?.abort()
    currentAbortRef.current?.abort()
    deleteAbortRef.current?.abort()
    copyAbortRef.current?.abort()
    overviewAbortRef.current?.abort()
    inventoryAbortRef.current?.abort()
    detailInFlightRef.current = ''
    currentInFlightRef.current = ''
    deleteInFlightRef.current = ''
    copyInFlightRef.current = ''
    mutationReconcileRef.current += 1
    if (mutationReconcileTimerRef.current !== null) window.clearTimeout(mutationReconcileTimerRef.current)
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const nextQuery = modelQuery.trim()
      if (nextQuery !== debouncedModelQuery) {
        setDebouncedModelQuery(nextQuery)
        setModelPage(1)
      }
      setModelSearchSettled(true)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [debouncedModelQuery, modelQuery])

  useEffect(() => {
    if (pathname !== '/models') return
    const url = new URL(window.location.href)
    const values: Record<string, string> = {
      q: modelQuery.trim(),
      page: modelPage === 1 ? '' : String(modelPage),
      size: modelPageSize === 6 ? '' : String(modelPageSize),
    }
    Object.entries(values).forEach(([key, value]) => {
      if (value) url.searchParams.set(key, value)
      else url.searchParams.delete(key)
    })
    const nextSearch = url.searchParams.toString()
    writtenSearchRef.current = nextSearch
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }, [modelPage, modelPageSize, modelQuery, pathname])

  useEffect(() => {
    if (pathname !== '/models') return
    const nextSearch = searchParams.toString()
    if (nextSearch === writtenSearchRef.current) return
    writtenSearchRef.current = nextSearch
    const nextQuery = searchParams.get('q') || ''
    const rawPage = Number(searchParams.get('page') || 1)
    const nextPage = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1
    invalidateInventoryView()
    setModelQuery(nextQuery)
    setDebouncedModelQuery(nextQuery.trim())
    setModelSearchSettled(true)
    setModelPage(nextPage)
    setModelPageSize(modelPageSizeFromParam(searchParams.get('size')))
  }, [pathname, searchParams])

  const invalidateInventoryView = () => {
    inventoryRequestSequenceRef.current += 1
    inventoryAbortRef.current?.abort()
    inventoryAbortRef.current = null
    setInventoryRefreshing(true)
    setSectionErrors(previous => {
      if (!previous.inventory) return previous
      const next = { ...previous }
      delete next.inventory
      return next
    })
  }

  const reconcileModelState = () => {
    const reconcileId = ++mutationReconcileRef.current
    if (mutationReconcileTimerRef.current !== null) window.clearTimeout(mutationReconcileTimerRef.current)
    void Promise.allSettled([loadModels(true), loadInventory(true)]).then(() => {
      if (mutationReconcileRef.current !== reconcileId) return
      mutationReconcileTimerRef.current = window.setTimeout(() => {
        if (mutationReconcileRef.current !== reconcileId) return
        mutationReconcileTimerRef.current = null
        void Promise.allSettled([loadModels(true), loadInventory(true)])
      }, 1200)
    })
  }

  const mutationResultUncertain = (error: unknown) => (
    error instanceof ApiError && error.status === 0
    || error instanceof Error && /超时|网络中断|无法连接|network|timeout/i.test(error.message)
  )

  const handleDelete = async () => {
    if (!isAdmin) {
      setConfirmDelete(null)
      setToast({ message: '仅管理员可删除本地模型', type: 'error' })
      return
    }
    if (!confirmDelete || deleteInFlightRef.current) return
    if (currentInFlightRef.current || copyInFlightRef.current) {
      setConfirmDelete(null)
      setToast({ message: '已有模型管理操作正在处理，请等待完成后再删除', type: 'error' })
      return
    }
    if (!inventorySnapshotMatchesView) {
      setConfirmDelete(null)
      setToast({ message: '当前模型清单不属于正在查看的搜索条件，请等待重新读取后再删除', type: 'error' })
      return
    }
    if (confirmDelete === currentModel) {
      setConfirmDelete(null)
      setToast({ message: '当前使用模型不能删除，请先选择其他模型', type: 'error' })
      return
    }
    const target = confirmDelete
    const requestSequence = ++deleteRequestSequenceRef.current
    const controller = new AbortController()
    deleteInFlightRef.current = target
    deleteAbortRef.current = controller
    try {
      setDeleting(true)
      await modelApi.remove(target, controller.signal)
      if (requestSequence !== deleteRequestSequenceRef.current) return
      setToast({ message: `模型 ${target} 已删除`, type: 'success' })
      setConfirmDelete(null)
      setInventoryRefreshVersion(version => version + 1)
    } catch (error) {
      if (controller.signal.aborted) return
      if (requestSequence === deleteRequestSequenceRef.current) {
        if (mutationResultUncertain(error)) {
          setConfirmDelete(null)
          setToast({ message: '删除请求超时或网络中断，模型可能已经删除；正在重新读取模型状态', type: 'error' })
          reconcileModelState()
          return
        }
        setToast({ message: readErrorMessage(error, '删除失败，请重试'), type: 'error' })
      }
    } finally {
      if (deleteInFlightRef.current === target) {
        deleteInFlightRef.current = ''
        deleteAbortRef.current = null
      }
      if (requestSequence === deleteRequestSequenceRef.current) setDeleting(false)
    }
  }

  const cancelDeleteWait = () => {
    if (!deleteInFlightRef.current) {
      setConfirmDelete(null)
      return
    }
    deleteRequestSequenceRef.current += 1
    deleteAbortRef.current?.abort()
    deleteAbortRef.current = null
    deleteInFlightRef.current = ''
    setDeleting(false)
    setConfirmDelete(null)
    setToast({ message: '已取消删除等待；Ollama 可能仍在处理中，正在重新读取模型状态', type: 'error' })
    reconcileModelState()
  }

  const requestCopyConfirmation = (source: string, destination: string) => {
    if (!isAdmin) {
      setToast({ message: '仅管理员可复制本地模型', type: 'error' })
      return
    }
    if (copyInFlightRef.current || currentInFlightRef.current || deleteInFlightRef.current) {
      setToast({ message: '已有模型管理操作正在处理，请等待完成后再复制', type: 'error' })
      return
    }
    setConfirmCopy({ source, destination })
  }

  const handleCopy = async () => {
    if (!isAdmin) {
      setConfirmCopy(null)
      setToast({ message: '仅管理员可复制本地模型', type: 'error' })
      return
    }
    if (!confirmCopy || copyInFlightRef.current) return
    if (currentInFlightRef.current || deleteInFlightRef.current) {
      setConfirmCopy(null)
      setToast({ message: '已有模型管理操作正在处理，请等待完成后再复制', type: 'error' })
      return
    }
    if (!inventorySnapshotMatchesView) {
      setConfirmCopy(null)
      setToast({ message: '当前模型清单正在更新，请等待读取完成后再复制', type: 'error' })
      return
    }
    if (!models.some(model => model.name === confirmCopy.source)) {
      setConfirmCopy(null)
      setToast({ message: '源模型已不在当前模型清单中，请刷新后重试', type: 'error' })
      return
    }
    const target = confirmCopy
    const requestSequence = ++copyRequestSequenceRef.current
    const controller = new AbortController()
    copyInFlightRef.current = target.destination
    copyAbortRef.current = controller
    try {
      setCopying(true)
      await modelApi.copy(target.source, target.destination, controller.signal)
      if (requestSequence !== copyRequestSequenceRef.current) return
      setConfirmCopy(null)
      setDetailModel(null)
      setToast({ message: `模型别名 ${target.destination} 已创建`, type: 'success' })
      setInventoryRefreshVersion(version => version + 1)
    } catch (error) {
      if (controller.signal.aborted) return
      if (requestSequence !== copyRequestSequenceRef.current) return
      if (mutationResultUncertain(error)) {
        setConfirmCopy(null)
        setDetailModel(null)
        setToast({ message: '复制请求超时或网络中断，模型别名可能已经创建；正在重新读取模型清单', type: 'error' })
        reconcileModelState()
        return
      }
      setToast({ message: readErrorMessage(error, '复制模型失败，请重试'), type: 'error' })
    } finally {
      if (copyInFlightRef.current === target.destination) {
        copyInFlightRef.current = ''
        copyAbortRef.current = null
      }
      if (requestSequence === copyRequestSequenceRef.current) setCopying(false)
    }
  }

  const cancelCopyWait = () => {
    if (!copyInFlightRef.current) {
      setConfirmCopy(null)
      return
    }
    copyRequestSequenceRef.current += 1
    copyAbortRef.current?.abort()
    copyAbortRef.current = null
    copyInFlightRef.current = ''
    setCopying(false)
    setConfirmCopy(null)
    setDetailModel(null)
    setToast({ message: '已取消复制等待；模型别名可能已经创建，正在重新读取最终模型清单', type: 'error' })
    reconcileModelState()
  }

  const handleDetail = async (name: string, trigger: HTMLButtonElement) => {
    if (!inventorySnapshotMatchesView) {
      setToast({ message: '当前模型清单不属于正在查看的搜索条件，请等待重新读取后再查看详情', type: 'error' })
      return
    }
    if (detailInFlightRef.current === name) return
    detailReturnFocusRef.current = trigger
    detailAbortRef.current?.abort()
    const requestSequence = ++detailRequestSequenceRef.current
    const controller = new AbortController()
    detailInFlightRef.current = name
    detailAbortRef.current = controller
    try {
      setDetailLoadingName(name)
      const detail = await modelApi.detail(name, controller.signal)
      if (requestSequence !== detailRequestSequenceRef.current) return
      setDetailModel(detail)
    } catch (error) {
      if (controller.signal.aborted) return
      if (requestSequence !== detailRequestSequenceRef.current) return
      setToast({ message: readErrorMessage(error, '获取模型详情失败'), type: 'error' })
    } finally {
      if (detailInFlightRef.current === name) {
        detailInFlightRef.current = ''
        detailAbortRef.current = null
      }
      if (requestSequence === detailRequestSequenceRef.current) setDetailLoadingName('')
    }
  }

  const cancelDetailWait = () => {
    if (!detailInFlightRef.current) return
    detailRequestSequenceRef.current += 1
    detailAbortRef.current?.abort()
    detailAbortRef.current = null
    detailInFlightRef.current = ''
    setDetailLoadingName('')
    setToast({ message: '已取消模型详情读取', type: 'success' })
    const returnTarget = detailReturnFocusRef.current
    window.setTimeout(() => {
      if (returnTarget?.isConnected) returnTarget.focus()
      detailReturnFocusRef.current = null
    }, 0)
  }

  const closeDetail = () => {
    const returnTarget = detailReturnFocusRef.current
    setDetailModel(null)
    window.setTimeout(() => {
      if (returnTarget?.isConnected) returnTarget.focus()
      detailReturnFocusRef.current = null
    }, 450)
  }

  const handleSetCurrent = async (name: string) => {
    if (!isAdmin) {
      setToast({ message: '仅管理员可切换当前使用模型', type: 'error' })
      return
    }
    if (!inventorySnapshotMatchesView) {
      setToast({ message: '当前模型清单不属于正在查看的搜索条件，请等待重新读取后再切换', type: 'error' })
      return
    }
    if (name === currentModel) return
    if (currentInFlightRef.current || deleteInFlightRef.current || copyInFlightRef.current) {
      setToast({ message: '已有模型管理操作正在处理，请等待完成后再切换', type: 'error' })
      return
    }
    const requestSequence = ++currentRequestSequenceRef.current
    const controller = new AbortController()
    currentInFlightRef.current = name
    currentAbortRef.current = controller
    try {
      setSettingCurrentName(name)
      const response = await modelApi.setCurrent(name, controller.signal)
      if (requestSequence !== currentRequestSequenceRef.current) return
      setCurrentModel(response.current_model)
      setCurrentLoaded(true)
      setToast({ message: `已将 ${name} 设为当前使用模型`, type: 'success' })
    } catch (error) {
      if (controller.signal.aborted) return
      if (requestSequence !== currentRequestSequenceRef.current) return
      if (mutationResultUncertain(error)) {
        setToast({ message: '切换请求超时或网络中断，当前模型可能已经变更；正在重新读取最终状态', type: 'error' })
        reconcileModelState()
        return
      }
      setToast({ message: readErrorMessage(error, '设置失败，请重试'), type: 'error' })
    } finally {
      if (currentInFlightRef.current === name) {
        currentInFlightRef.current = ''
        currentAbortRef.current = null
      }
      if (requestSequence === currentRequestSequenceRef.current) setSettingCurrentName('')
    }
  }

  const cancelCurrentWait = () => {
    if (!currentInFlightRef.current) return
    currentRequestSequenceRef.current += 1
    currentAbortRef.current?.abort()
    currentAbortRef.current = null
    currentInFlightRef.current = ''
    setSettingCurrentName('')
    setToast({ message: '已取消切换等待；当前模型可能已经变更，正在重新读取最终状态', type: 'error' })
    reconcileModelState()
  }

  const totalSize = modelInventorySize
  const totalSizeDisplay = totalSize >= 1_073_741_824
    ? `${(totalSize / 1_073_741_824).toFixed(1)}`
    : totalSize >= 1_048_576
      ? `${(totalSize / 1_048_576).toFixed(0)}`
      : '0'
  const totalSizeUnit = totalSize >= 1_073_741_824 ? 'GB' : 'MB'
  const installedModelFootprint = `${totalSizeDisplay} ${totalSizeUnit}`
  const gpuCount = sysMetrics?.gpus?.length ?? 0
  const runtimeSummary = !metricsLoaded
    ? loading
      ? '正在检测运行环境'
      : sectionErrors.metrics
        ? '运行环境读取失败'
        : '运行环境等待检测'
    : gpuCount === 1
      ? '当前为单卡 GPU 环境'
      : gpuCount > 1
        ? `当前检测到 ${gpuCount} 张 GPU`
        : '当前未检测到 NVIDIA GPU'
  const currentModelRunning = Boolean(
    currentLoaded
    && currentModel
    && runningLoaded
    && running.some((item) => item.name === currentModel || item.model === currentModel),
  )
  const activeModelDescription = currentLoaded && currentModel
    ? ollamaOnline === false
      ? '已配置，Ollama 当前离线'
      : sectionErrors.running
        ? '已配置，运行状态读取失败'
        : currentModelRunning
          ? '正在运行'
          : '已设为当前使用模型，当前未加载到内存'
    : runningLoaded && running.length > 0
      ? running.map(r => r.name).join(', ')
      : inventoryLoaded && modelInventoryTotal > 0
        ? `已部署 ${modelInventoryTotal} 个模型，请选择当前使用模型`
        : inventoryLoaded
          ? '暂无可用模型'
          : '正在读取模型状态'
  const readErrors = (Object.entries(sectionErrors) as Array<[ReadSection, string]>).filter(([section, message]) => (
    Boolean(message) && (section !== 'inventory' || inventoryLoaded)
  ))
  const hasRetainedData = inventoryLoaded || runningLoaded || currentLoaded || metricsLoaded
  const retainingInventorySnapshot = inventoryLoaded && (
    inventoryRefreshing
    || !modelSearchSettled
    || modelQuery.trim() !== debouncedModelQuery
    || loadedModelQuery !== debouncedModelQuery
    || loadedModelPage !== modelPage
    || loadedModelPageSize !== modelPageSize
  )
  const inventorySnapshotMatchesView = Boolean(
    inventoryLoaded
    && modelSearchSettled
    && modelQuery.trim() === debouncedModelQuery
    && loadedModelQuery === debouncedModelQuery
    && loadedModelPage === modelPage
    && loadedModelPageSize === modelPageSize
  )
  const metricLabel = (label: string) => ({
    Swap: '交换空间',
    Load: '系统负载',
    GPU: '图形处理器',
    VRAM: '显存',
    磁盘: '模型存储卷',
  }[label] || label)
  const metricValueLabel = (metric: { value: number; unit?: '%' | '°C' }) => `${metric.value}${metric.unit || '%'}`
  const pressuredResources = (sysMetrics?.metrics_bars || [])
    .filter((metric) => metric.unit === '°C' ? metric.value >= 85 : metric.value >= 90)
    .map((metric) => `${metricLabel(metric.label)} ${metricValueLabel(metric)}`)
  const modelVolumePressured = Boolean(sysMetrics && sysMetrics.disk.percent >= 90)
  const swapPressured = Boolean(sysMetrics && sysMetrics.swap.percent >= 90)
  const managementBusy = Boolean(settingCurrentName || deleting || copying)
  return (
    <div className="max-w-7xl mx-auto">
      <AnimatePresence>{toast && <InlineToast message={toast.message} tone={toast.type} onClose={() => setToast(null)} duration={3500} />}</AnimatePresence>
      <AnimatePresence>{confirmDelete && <ConfirmDialog title="删除模型" message={`确定要删除模型「${confirmDelete}」吗？删除后需重新拉取才能使用。`} onConfirm={handleDelete} onCancel={cancelDeleteWait} loading={deleting} />}</AnimatePresence>
      <AnimatePresence>{detailModel && <DetailDrawer key={detailModel.name} model={detailModel} onClose={closeDetail} canManage={!authLoading && isAdmin} managementBusy={managementBusy} onRequestCopy={requestCopyConfirmation} />}</AnimatePresence>
      <AnimatePresence>{confirmCopy && <CopyConfirmDialog source={confirmCopy.source} destination={confirmCopy.destination} onConfirm={handleCopy} onCancel={cancelCopyWait} loading={copying} />}</AnimatePresence>

      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-6 mb-12">
        <div>
          <h2 className="mb-2 text-4xl font-black text-slate-900 dark:text-white">模型运行状态查看</h2>
          <p className="text-slate-500 dark:text-slate-400 font-medium">管理本地开源大语言模型、量化规格、当前配置与真实运行状态。</p>
          <p className="mt-2 text-xs font-medium text-slate-400 dark:text-slate-500">
            30 秒读取缓存 · {lastSuccessfulReadAt ? `最近成功读取 ${lastSuccessfulReadAt.toLocaleTimeString('zh-CN')}` : loading ? '正在读取真实状态' : '尚未取得运行数据'}
          </p>
          {!authLoading && !isAdmin ? <p className="mt-2 max-w-2xl text-xs font-semibold leading-5 text-blue-700 dark:text-blue-300">当前账号可查看模型运行状态、资源信息和技术详情；切换当前模型、复制和删除模型由管理员负责。</p> : null}
        </div>
        <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center">
          <div className="flex items-center gap-3">
            <div className={`flex items-center gap-2 px-4 py-2 rounded-full text-xs font-bold ${
              ollamaOnline === null
                ? 'bg-slate-100 text-slate-500 dark:bg-white/[0.06] dark:text-slate-300'
                : ollamaOnline
                ? 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                : 'bg-red-50 dark:bg-red-500/15 text-red-500 dark:text-red-400'
            }`}>
              {ollamaOnline === null ? <Loader2 size={14} className="animate-spin" /> : ollamaOnline ? <Wifi size={14} /> : <WifiOff size={14} />}
              {ollamaOnline === null ? '正在检测 Ollama' : `Ollama ${ollamaOnline ? '运行中' : '未连接'}`}
            </div>
            <button
              type="button"
              aria-label="刷新模型运行状态"
              title="刷新运行状态"
              disabled={loading || refreshing || inventoryRefreshing}
              onClick={() => void Promise.allSettled([loadModels(true), loadInventory(true)])}
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition hover:border-blue-200 hover:text-blue-600 disabled:cursor-wait disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-slate-300"
            >
              <RefreshCw size={16} className={refreshing || inventoryRefreshing ? 'animate-spin' : ''} />
            </button>
          </div>
          <Link href="/models/pulls" className="flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-blue-600 px-6 py-3 text-sm font-bold text-white shadow-lg shadow-blue-500/20 transition-colors hover:bg-blue-700">
            <DownloadCloud size={18} /> 拉取与验证模型
          </Link>
        </div>
      </div>

      {readErrors.length > 0 && (
        <div className="mb-6 flex flex-col gap-3 rounded-lg border border-amber-100 bg-amber-50 px-5 py-4 text-sm text-amber-700 dark:border-amber-300/10 dark:bg-amber-500/10 dark:text-amber-200 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <WifiOff size={18} className="mt-0.5 shrink-0" />
            <div>
              <p className="font-bold">部分模型状态读取失败</p>
              <div className="mt-1 space-y-1 leading-6">
                {readErrors.map(([section, message]) => (
                  <p key={section}>{READ_SECTION_LABELS[section]}：{message}</p>
                ))}
              </div>
              {hasRetainedData ? <p className="mt-1 leading-6">其他成功区域与上次读取数据继续保留。</p> : null}
            </div>
          </div>
          <button type="button" disabled={refreshing || inventoryRefreshing} onClick={() => void Promise.allSettled([sectionErrors.inventory ? loadInventory(true) : Promise.resolve(), sectionErrors.connectivity || sectionErrors.running || sectionErrors.current || sectionErrors.metrics ? loadModels(true) : Promise.resolve()])} className="inline-flex min-h-9 shrink-0 items-center justify-center gap-2 rounded-lg bg-white px-4 py-2 text-xs font-black text-amber-700 shadow-sm disabled:cursor-wait disabled:opacity-50 dark:bg-white/[0.08] dark:text-amber-100">
            <RefreshCw size={14} /> 重新读取
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-10">
        <div className="rounded-2xl border border-slate-100 bg-white px-6 py-5 shadow-sm dark:border-white/[0.06] dark:bg-white/[0.05]">
          <p className="mb-2 text-xs font-semibold text-slate-400 dark:text-slate-500">参数规模</p>
          <p className="text-lg font-black text-slate-900 dark:text-white">支持多种参数规模</p>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">当前实际安装 {inventoryLoaded ? `${modelInventoryTotal} 个模型` : '数量读取中'}，参数量以模型详情为准。</p>
        </div>
        <div className="rounded-2xl border border-slate-100 bg-white px-6 py-5 shadow-sm dark:border-white/[0.06] dark:bg-white/[0.05]">
          <p className="mb-2 text-xs font-semibold text-slate-400 dark:text-slate-500">推理模式</p>
          <p className="text-lg font-black text-slate-900 dark:text-white">支持低比特量化推理</p>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">页面以中文展示量化精度，原始 Ollama 规格保留在模型详情中。</p>
        </div>
        <div className="rounded-2xl border border-slate-100 bg-white px-6 py-5 shadow-sm dark:border-white/[0.06] dark:bg-white/[0.05]">
          <p className="mb-2 text-xs font-semibold text-slate-400 dark:text-slate-500">运行环境</p>
          <p className="text-lg font-black text-slate-900 dark:text-white">{runtimeSummary}</p>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">系统利用率区域展示 CPU、内存、磁盘与 GPU/显存等运行状态。</p>
        </div>
      </div>

      {loading && !hasLoadedRef.current && (
        <div className="mb-6 flex items-center gap-3 rounded-lg border border-blue-100 bg-blue-50 px-5 py-4 text-sm font-semibold text-blue-700 dark:border-blue-300/10 dark:bg-blue-500/10 dark:text-blue-200">
          <Loader2 size={18} className="shrink-0 animate-spin" />
          正在读取模型清单和真实资源指标，页面结构可先查看。
        </div>
      )}
      <>
          {/* Stats */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
            {/* 系统利用率 — col-span-2 */}
            <div className="md:col-span-2 bg-white dark:bg-white/[0.05] p-6 rounded-2xl border border-slate-100 dark:border-white/[0.06] shadow-sm flex flex-col h-full">
              <div className="flex justify-between items-start mb-4">
                <span className="text-xs font-semibold text-slate-400 dark:text-slate-500">系统利用率</span>
                <Activity size={18} className="text-blue-600 dark:text-blue-400" />
              </div>
              <div className="flex items-baseline gap-2 mb-2">
                {sysMetrics ? (
                  <>
                    <span className="text-4xl font-black text-slate-900 dark:text-white">
                      {sysMetrics.cpu.percent}%
                    </span>
                    <span className="text-sm font-bold text-slate-400 dark:text-slate-500">
                      CPU 使用率 · {sysMetrics.cpu.count} 个逻辑核心
                    </span>
                  </>
                ) : running.length > 0 ? (
                  <>
                    <span className="text-4xl font-black text-slate-900 dark:text-white">
                      {running.map(r => r.size_vram_display || r.size_display || '—').join(' / ')}
                    </span>
                    <span className="text-sm font-bold text-slate-400 dark:text-slate-500">显存占用 (VRAM)</span>
                  </>
                ) : (
                  <>
                    <span className="text-4xl font-black text-slate-900 dark:text-white">{inventoryLoaded ? totalSizeDisplay : '—'}</span>
                    <span className="text-sm font-bold text-slate-400 dark:text-slate-500">
                      {inventoryLoaded ? `${totalSizeUnit} 磁盘占用 · ${modelInventoryTotal} 个模型已部署` : sectionErrors.inventory ? '模型清单暂时无法确认' : '正在读取模型清单'}
                    </span>
                  </>
                )}
              </div>
              {/* 柱状图 — 6 根，使用真实系统指标 */}
              {sysMetrics?.metrics_bars?.length ? (
                <div className="mt-auto flex h-16 items-end gap-1 pt-4">
                  {sysMetrics.metrics_bars.map((bar, i) => {
                  const h = Math.min(Math.max(bar.value, 0), 100)
                  const warningThreshold = bar.unit === '°C' ? 85 : 80
                  const cautionThreshold = bar.unit === '°C' ? 75 : 60
                  const barColor = bar.value > warningThreshold
                    ? 'bg-red-400 dark:bg-red-600/70'
                    : bar.value > cautionThreshold
                      ? 'bg-amber-300 dark:bg-amber-600/60'
                      : running.length > 0
                        ? 'bg-emerald-300 dark:bg-emerald-700/60'
                        : 'bg-blue-200 dark:bg-blue-900/50'
                  return (
                    <motion.div
                      key={bar.label}
                      initial={{ height: 0 }}
                      animate={{ height: `${h}%` }}
                      transition={{ delay: i * 0.1, duration: 0.5 }}
                      className={`flex-1 rounded-t-lg ${barColor}`}
                      title={`${metricLabel(bar.label)}：${metricValueLabel(bar)}`}
                    />
                  )
                })}
                </div>
              ) : (
                <div className="mt-auto flex h-16 items-center justify-center rounded-lg border border-dashed border-slate-200 px-4 text-center text-xs font-semibold leading-5 text-slate-400 dark:border-white/[0.08] dark:text-slate-500">
                  暂未取得真实资源指标，不展示模拟柱状数据
                </div>
              )}
              {sysMetrics?.metrics_bars?.length ? (
                <div className="mt-3 flex gap-2">
                  {sysMetrics.metrics_bars.map((bar) => (
                    <span key={bar.label} className="min-w-0 flex-1 text-center text-xs leading-4">
                      <strong className="block font-black tabular-nums text-slate-700 dark:text-slate-200">{metricValueLabel(bar)}</strong>
                      <span className="mt-0.5 block break-words font-semibold text-slate-500 dark:text-slate-400">{metricLabel(bar.label)}</span>
                    </span>
                  ))}
                </div>
              ) : null}
              {pressuredResources.length > 0 ? (
                <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs font-semibold leading-5 text-red-700 dark:border-red-300/10 dark:bg-red-500/10 dark:text-red-200">
                  <Activity size={14} className="mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <p className="font-bold">资源压力较高：{pressuredResources.join('、')}。模型拉取或推理可能受影响。</p>
                    {modelVolumePressured ? (
                      <p className="mt-2 border-t border-red-200/80 pt-2 font-medium text-red-600 dark:border-red-300/15 dark:text-red-300" title={`Ollama 模型目录采样路径：${sysMetrics?.disk.path}`}>
                        Ollama 所在磁盘卷还可用 {sysMetrics?.disk.available_gb} GB；已安装模型自身合计 {installedModelFootprint}，卷占用率并非单个模型大小。
                      </p>
                    ) : null}
                    {swapPressured ? (
                      <p className="mt-2 border-t border-red-200/80 pt-2 font-medium text-red-600 dark:border-red-300/15 dark:text-red-300">
                        交换空间已用 {sysMetrics?.swap.used_gb}/{sysMetrics?.swap.total_gb} GB，建议结束无关高内存进程后再执行模型拉取或推理。
                      </p>
                    ) : null}
                  </div>
                </div>
              ) : sysMetrics ? (
                <p className="mt-3 text-xs font-semibold leading-5 text-slate-400 dark:text-slate-500">
                  <span title={`Ollama 模型目录采样路径：${sysMetrics.disk.path}`}>Ollama 所在磁盘卷可用 {sysMetrics.disk.available_gb} GB</span> · 已安装 {modelInventoryTotal} 个模型，共 {installedModelFootprint}
                </p>
              ) : null}
            </div>

            {/* 当前使用模型 */}
            <div className="relative flex min-w-0 flex-col justify-center overflow-hidden rounded-2xl bg-blue-600 p-6 text-white dark:bg-blue-700 sm:p-8">
              <div className="relative z-10 min-w-0">
                <span className="mb-4 block text-xs font-semibold text-blue-200 dark:text-blue-300">当前使用模型</span>
                <p title={currentModel || undefined} className="mb-3 min-w-0 break-words text-2xl font-black leading-tight [overflow-wrap:anywhere]">
                  {currentLoaded ? currentModel || '尚未配置' : '正在读取'}
                </p>
                {currentLoaded && currentModel ? (
                  <span className={`mb-3 inline-flex min-h-6 items-center rounded-full px-2.5 py-1 text-xs font-bold ${
                    sectionErrors.running
                      ? 'bg-white/15 text-blue-50'
                      : currentModelRunning
                        ? 'bg-emerald-400/20 text-emerald-50'
                        : 'bg-white/15 text-blue-50'
                  }`}>
                    {sectionErrors.running ? '内存状态未取得' : currentModelRunning ? '已加载到内存' : '当前未加载到内存'}
                  </span>
                ) : null}
                <p
                  title={activeModelDescription}
                  className="max-w-full break-words text-sm font-medium leading-relaxed text-blue-100 opacity-80 dark:text-blue-200"
                >
                  {activeModelDescription}
                </p>
              </div>
            </div>
          </div>

          <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-xl font-black text-slate-900 dark:text-white">已安装模型</h3>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                {inventoryRefreshing || !modelSearchSettled || modelQuery.trim() !== debouncedModelQuery
                  ? '正在应用筛选条件并读取模型清单。'
                  : inventoryLoaded
                  ? `当前筛选 ${modelTotal} 个，系统共安装 ${modelInventoryTotal} 个${sectionErrors.inventory ? '（保留上次成功数据）' : ''}。`
                  : sectionErrors.inventory
                    ? '模型清单暂时无法确认，请重新读取。'
                    : '正在读取已安装模型清单。'}
              </p>
            </div>
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            {settingCurrentName ? (
              <button type="button" onClick={cancelCurrentWait} className="inline-flex h-10 items-center justify-center gap-2 rounded-[8px] border border-amber-200 bg-amber-50 px-4 text-sm font-bold text-amber-700 hover:bg-amber-100 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
                <XCircle size={15} />取消等待
              </button>
            ) : null}
            <label className="relative w-full sm:w-72">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input aria-label="搜索已安装模型" value={modelQuery} onChange={(event) => {
                invalidateInventoryView()
                setModelSearchSettled(false)
                setModelQuery(event.target.value)
              }} placeholder="搜索模型名称、家族或量化方式" className="h-10 w-full rounded-[8px] border border-slate-200 bg-white pl-9 pr-4 text-sm text-slate-800 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-white" />
              {inventoryRefreshing && <Loader2 size={14} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-blue-500" />}
            </label>
            </div>
          </div>

          {retainingInventorySnapshot ? (
            <div className={`mb-5 flex items-center gap-2 border-l-2 px-3 py-2 text-xs font-semibold ${inventoryRefreshing ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300' : 'border-amber-400 bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200'}`} role="status">
              {inventoryRefreshing ? <Loader2 size={14} className="animate-spin" /> : <AlertTriangle size={14} />}
              {inventoryRefreshing ? '正在更新模型清单，' : '模型清单更新未成功，'}下方旧快照不代表当前搜索条件，详情、切换、删除和分页暂不可用
            </div>
          ) : null}

          {/* Models Grid or Empty */}
          {models.length > 0 ? (
            <div className="mb-12">
              <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
                <AnimatePresence>
                  {models.map(m => (
                    <ModelCard
                      key={m.name}
                      model={m}
                      onDelete={setConfirmDelete}
                      onDetail={handleDetail}
                      onCancelDetail={cancelDetailWait}
                      isCurrent={m.name === currentModel}
                      onSetCurrent={handleSetCurrent}
                      runtimeUnavailable={ollamaOnline !== true}
                      interactionDisabled={!inventorySnapshotMatchesView}
                      managementBusy={managementBusy}
                      pendingAction={settingCurrentName === m.name ? 'current' : detailLoadingName === m.name ? 'detail' : undefined}
                      canManage={!authLoading && isAdmin}
                    />
                  ))}
                </AnimatePresence>
              </div>
              {inventoryLoaded ? <Pagination
                page={inventoryRefreshing ? loadedModelPage : modelPage}
                pageSize={loadedModelPageSize}
                total={modelTotal}
                loading={loading || inventoryRefreshing}
                navigationDisabled={!inventorySnapshotMatchesView}
                onPageChange={(target) => { if (!inventorySnapshotMatchesView) return; invalidateInventoryView(); setModelPage(target) }}
                onPageSizeChange={(size) => {
                  if (!inventorySnapshotMatchesView || size === modelPageSize) return
                  invalidateInventoryView()
                  setModelPageSize(size)
                  setModelPage(1)
                }}
                pageSizeOptions={MODEL_PAGE_SIZES}
                itemName="个已安装模型"
                className="mt-6 px-0 pb-0"
              /> : null}
            </div>
          ) : (loading && !hasLoadedRef.current) || inventoryRefreshing || !modelSearchSettled ? (
            <div className="mb-12 flex min-h-48 items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-white text-sm font-semibold text-slate-400 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-slate-500">
              <Loader2 size={18} className="mr-2 animate-spin" /> {modelSearchSettled ? '正在读取已安装模型' : '正在应用搜索条件'}
            </div>
          ) : (
            <div className="mb-12">
              <div className="bg-white dark:bg-white/[0.05] p-10 rounded-2xl border-2 border-dashed border-slate-200 dark:border-white/[0.06] flex flex-col items-center justify-center text-center">
                <div className="w-16 h-16 bg-slate-50 dark:bg-slate-700 rounded-full flex items-center justify-center text-slate-400 dark:text-slate-500 mb-6"><Box size={32} /></div>
                <h3 className="mb-2 text-xl font-black text-slate-900 dark:text-white">
                  {sectionErrors.inventory ? '模型清单读取失败' : ollamaOnline === false ? 'Ollama 未连接' : modelQuery ? '没有匹配的模型' : '暂无模型'}
                </h3>
                <p className="mb-6 max-w-xs break-words text-sm leading-6 text-slate-500 dark:text-slate-400" role={sectionErrors.inventory ? 'alert' : undefined}>
                  {sectionErrors.inventory || (ollamaOnline === false
                    ? '请确认 Ollama 服务已启动，再重新读取模型清单。'
                    : modelQuery
                      ? '调整搜索条件后重试。'
                      : '点击「拉取模型」从模型库下载模型。')}
                </p>
                {sectionErrors.inventory && !inventoryLoaded ? (
                  <button
                    type="button"
                    onClick={() => void loadInventory(true)}
                    disabled={inventoryRefreshing}
                    className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 text-sm font-bold text-amber-700 transition hover:bg-amber-100 disabled:cursor-wait disabled:opacity-50 dark:border-amber-400/20 dark:bg-amber-500/10 dark:text-amber-200"
                  >
                    <RefreshCw size={15} className={inventoryRefreshing ? 'animate-spin' : ''} />
                    {inventoryRefreshing ? '正在重新读取' : '重新读取模型清单'}
                  </button>
                ) : null}
                {ollamaOnline === true && !sectionErrors.inventory && !modelQuery && (
                  <Link href="/models/pulls" className="flex items-center gap-2 rounded-lg bg-blue-600 px-6 py-3 text-sm font-bold text-white hover:bg-blue-700">
                    <DownloadCloud size={16} /> 拉取与验证模型
                  </Link>
                )}
              </div>
              {inventoryLoaded ? <Pagination
                page={loadedModelPage}
                pageSize={loadedModelPageSize}
                total={modelTotal}
                loading={loading || inventoryRefreshing}
                navigationDisabled={!inventorySnapshotMatchesView}
                onPageChange={(target) => { if (!inventorySnapshotMatchesView) return; invalidateInventoryView(); setModelPage(target) }}
                onPageSizeChange={(size) => {
                  if (!inventorySnapshotMatchesView || size === modelPageSize) return
                  invalidateInventoryView()
                  setModelPageSize(size)
                  setModelPage(1)
                }}
                pageSizeOptions={MODEL_PAGE_SIZES}
                itemName="个已安装模型"
                className="mt-4 px-0 pb-0"
              /> : null}
            </div>
          )}

          {/* Bottom CTA */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <Link href="/models/pulls" className="bg-white dark:bg-white/[0.05] p-10 rounded-2xl border-2 border-dashed border-slate-200 dark:border-white/[0.06] flex flex-col items-center justify-center text-center group hover:border-blue-400 dark:hover:border-blue-500 transition-colors cursor-pointer">
                <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-lg bg-slate-50 text-slate-400 transition-colors group-hover:bg-blue-50 group-hover:text-blue-500 dark:bg-slate-700 dark:text-slate-500 dark:group-hover:bg-blue-900/30 dark:group-hover:text-blue-400"><DownloadCloud size={32} /></div>
              <h3 className="mb-2 text-xl font-black text-slate-900 dark:text-white">拉取与验证模型</h3>
              <p className="text-sm text-slate-500 dark:text-slate-400 max-w-xs">进入独立工作台，完成模型库筛选、预检、拉取任务和推理验证。</p>
            </Link>
            <div className="bg-indigo-50 dark:bg-indigo-900/20 p-10 rounded-2xl flex flex-col">
              <div className="flex items-center gap-3 mb-6">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-600 text-white dark:bg-indigo-500"><Lightbulb size={20} /></div>
                <h3 className="text-lg font-black text-indigo-900 dark:text-indigo-100">运行与存储摘要</h3>
              </div>
              <div className="space-y-3 flex-1">
                {[
                  { name: 'Ollama 版本', desc: ollamaOnline === null ? '服务版本读取中' : ollamaVersion || '版本未取得' },
                  { name: '已安装模型', desc: inventoryLoaded ? `${modelInventoryTotal} 个 · ${totalSizeDisplay} ${totalSizeUnit}` : '模型清单读取中' },
                  { name: '内存加载', desc: runningLoaded ? (running.length ? `${running.length} 个模型正在运行` : '当前没有模型加载到内存') : '运行状态读取中' },
                ].map(item => (
                  <div key={item.name} className="border-b border-indigo-100 px-1 py-3 last:border-b-0 dark:border-indigo-300/10">
                    <div>
                      <p className="text-xs font-bold text-indigo-600/70 dark:text-indigo-300/70">{item.name}</p>
                      <p className="mt-1 break-words text-sm font-bold text-indigo-900 dark:text-indigo-100">{item.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
    </div>
  )
}

export default function ModelsPage() {
  return (
    <Suspense fallback={<div className="flex min-h-[50vh] items-center justify-center text-sm font-bold text-slate-400">正在读取模型状态...</div>}>
      <ModelsContent />
    </Suspense>
  )
}
