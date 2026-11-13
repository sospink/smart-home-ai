import type { LucideIcon } from 'lucide-react'
import { AlertCircle, Inbox, Loader2, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'

type StateProps = {
  title?: string
  description?: string
  className?: string
}

export function LoadingState({ title = '正在加载', description = '正在读取最新数据，请稍候。', className }: StateProps) {
  return (
    <StateFrame role="status" ariaLive="polite" icon={Loader2} iconClassName="animate-spin text-blue-600" title={title} description={description} className={className} />
  )
}

export function EmptyState({ title = '暂无数据', description = '当前筛选条件下没有可展示的记录。', className }: StateProps) {
  return <StateFrame role="status" ariaLive="polite" icon={Inbox} title={title} description={description} className={className} />
}

export function ErrorState({
  title = '数据加载失败',
  description = '请检查服务连接后重试。',
  className,
  onRetry,
}: StateProps & { onRetry?: () => void }) {
  return (
    <div role="alert" className={cn('flex min-h-40 min-w-0 flex-col items-center justify-center px-6 py-8 text-center', className)}>
      <AlertCircle size={24} className="text-rose-600" />
      <p className="mt-3 text-sm font-semibold text-slate-900 dark:text-white">{title}</p>
      <p className="mt-1 max-w-md break-words text-xs leading-5 text-slate-500 [overflow-wrap:anywhere] dark:text-slate-400">{description}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 inline-flex items-center gap-2 rounded-[8px] border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-blue-300 hover:text-blue-700 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-slate-200"
        >
          <RefreshCw size={14} />
          重新加载
        </button>
      ) : null}
    </div>
  )
}

function StateFrame({
  icon: Icon,
  iconClassName,
  title,
  description,
  className,
  role,
  ariaLive,
}: StateProps & { icon: LucideIcon; iconClassName?: string; role?: 'status'; ariaLive?: 'polite' }) {
  return (
    <div role={role} aria-live={ariaLive} className={cn('flex min-h-40 min-w-0 flex-col items-center justify-center px-6 py-8 text-center', className)}>
      <Icon size={24} className={cn('text-slate-400', iconClassName)} />
      <p className="mt-3 text-sm font-semibold text-slate-900 dark:text-white">{title}</p>
      <p className="mt-1 max-w-md break-words text-xs leading-5 text-slate-500 [overflow-wrap:anywhere] dark:text-slate-400">{description}</p>
    </div>
  )
}
