import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral'

const STATUS_META: Record<string, { label: string; tone: StatusTone }> = {
  running: { label: '运行正常', tone: 'success' },
  online: { label: '在线', tone: 'success' },
  healthy: { label: '健康', tone: 'success' },
  success: { label: '成功', tone: 'success' },
  confirmed: { label: '已确认', tone: 'success' },
  connected: { label: '已连接', tone: 'success' },
  completed: { label: '索引完成', tone: 'success' },
  active: { label: '已启用', tone: 'success' },
  enabled: { label: '已启用', tone: 'success' },
  available: { label: '可用', tone: 'success' },
  ready: { label: '就绪', tone: 'info' },
  info: { label: '信息', tone: 'info' },
  processing: { label: '处理中', tone: 'info' },
  running_pull: { label: '下载中', tone: 'info' },
  retrying: { label: '重试中', tone: 'warning' },
  indexing: { label: '索引中', tone: 'info' },
  queuing: { label: '排队中', tone: 'info' },
  syncing: { label: '同步中', tone: 'info' },
  pending: { label: '待处理', tone: 'warning' },
  succeeded: { label: '已完成', tone: 'success' },
  canceled: { label: '已取消', tone: 'neutral' },
  interrupted: { label: '已中断', tone: 'warning' },
  waiting: { label: '等待处理', tone: 'warning' },
  paused: { label: '已暂停', tone: 'warning' },
  degraded: { label: '部分可用', tone: 'warning' },
  warning: { label: '需关注', tone: 'warning' },
  unconfigured: { label: '未配置', tone: 'warning' },
  draft: { label: '草稿', tone: 'neutral' },
  disabled: { label: '已停用', tone: 'neutral' },
  inactive: { label: '未启用', tone: 'neutral' },
  stopped: { label: '已停止', tone: 'danger' },
  idle: { label: '待机', tone: 'warning' },
  offline: { label: '离线', tone: 'danger' },
  error: { label: '异常', tone: 'danger' },
  failed: { label: '失败', tone: 'danger' },
  unavailable: { label: '不可用', tone: 'danger' },
  unknown: { label: '未知', tone: 'neutral' },
}

const TONE_CLASS: Record<StatusTone, string> = {
  success: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-300',
  warning: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-300',
  danger: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-400/20 dark:bg-rose-400/10 dark:text-rose-300',
  info: 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-400/20 dark:bg-blue-400/10 dark:text-blue-300',
  neutral: 'border-slate-200 bg-slate-100 text-slate-600 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-slate-300',
}

type StatusBadgeProps = {
  status?: string | null
  label?: ReactNode
  tone?: StatusTone
  showDot?: boolean
  className?: string
}

export function getStatusMeta(status?: string | null) {
  const raw = String(status || '').trim()
  const normalized = (raw || 'unknown').toLowerCase()
  const known = STATUS_META[normalized]
  if (known) return { ...known, raw, known: true }
  if (/[^\u0000-\u00ff]/.test(raw)) return { label: raw, tone: 'neutral' as const, raw, known: false }
  return { label: '状态待确认', tone: 'neutral' as const, raw, known: false }
}

export function StatusBadge({ status, label, tone, showDot = true, className }: StatusBadgeProps) {
  const meta = getStatusMeta(status)
  const resolvedTone = tone || meta.tone
  const resolvedLabel = label ?? meta.label
  const technicalStatusTitle = label == null && !meta.known && meta.raw
    ? `状态待确认（技术状态：${meta.raw}）`
    : undefined
  return (
    <span
      title={technicalStatusTitle || (typeof resolvedLabel === 'string' || typeof resolvedLabel === 'number' ? String(resolvedLabel) : undefined)}
      className={cn(
        'inline-flex min-h-6 max-w-full items-center gap-1.5 rounded-[6px] border px-2 py-0.5 text-xs font-semibold leading-5',
        TONE_CLASS[resolvedTone],
        className,
      )}
    >
      {showDot ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-80" aria-hidden="true" /> : null}
      <span className="truncate">{resolvedLabel}</span>
    </span>
  )
}
