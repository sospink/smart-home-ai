import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

type MetricItem = {
  label: string
  value: string | number
  detail?: string
  icon?: LucideIcon
  tone?: 'default' | 'success' | 'warning' | 'danger'
  wrapValue?: boolean
  valueClassName?: string
}

type MetricStripProps = {
  items: MetricItem[]
  columns?: 2 | 3 | 4 | 5
  className?: string
}

const TONE_CLASS = {
  default: 'text-slate-950 dark:text-white',
  success: 'text-emerald-700 dark:text-emerald-300',
  warning: 'text-amber-700 dark:text-amber-300',
  danger: 'text-rose-700 dark:text-rose-300',
}

const COLUMN_CLASS = {
  2: 'grid-cols-2',
  3: 'grid-cols-2 sm:grid-cols-3',
  4: 'grid-cols-2 xl:grid-cols-4',
  5: 'grid-cols-2 lg:grid-cols-3 xl:grid-cols-5',
}

const ODD_LAST_ITEM_CLASS = {
  2: '',
  3: 'sm:col-span-1',
  4: '',
  5: 'lg:col-span-1',
}

export function MetricStrip({ items, columns = 4, className }: MetricStripProps) {
  return (
    <div className={cn('grid gap-px overflow-hidden rounded-[8px] border border-slate-200/80 bg-slate-200/80 dark:border-white/[0.08] dark:bg-white/[0.08]', COLUMN_CLASS[columns], className)}>
      {items.map((item, index) => {
        const Icon = item.icon
        const fillsMobileRow = items.length % 2 === 1 && index === items.length - 1
        return (
          <div
            key={item.label}
            className={cn(
              'min-w-0 bg-white px-3 py-3 dark:bg-slate-950/70 sm:px-4 sm:py-3.5',
              fillsMobileRow ? `col-span-2 ${ODD_LAST_ITEM_CLASS[columns]}` : '',
            )}
          >
            <div className="flex items-center gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">
              {Icon ? <Icon size={14} className="shrink-0" /> : null}
              <span className="truncate">{item.label}</span>
            </div>
            <p
              className={cn(
                'mt-2 text-lg font-bold sm:text-xl',
                item.wrapValue ? 'line-clamp-2 break-words leading-6' : 'truncate',
                TONE_CLASS[item.tone || 'default'],
                item.valueClassName,
              )}
              title={String(item.value)}
            >
              {item.value}
            </p>
            {item.detail ? (
              <p className="mt-1 truncate text-[11px] text-slate-500 dark:text-slate-500" title={item.detail}>
                {item.detail}
              </p>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
