'use client'

import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { UnifiedSelect } from '@/components/ui/UnifiedSelect'

type PaginationProps = {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
  onPageSizeChange?: (pageSize: number) => void
  pageSizeOptions?: number[]
  className?: string
  itemName?: string
  loading?: boolean
  totalKnown?: boolean
  navigationDisabled?: boolean
}

function pageItems(page: number, pageCount: number): Array<number | 'ellipsis-left' | 'ellipsis-right'> {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, index) => index + 1)
  if (page <= 4) return [1, 2, 3, 4, 5, 'ellipsis-right', pageCount]
  if (page >= pageCount - 3) {
    return [1, 'ellipsis-left', pageCount - 4, pageCount - 3, pageCount - 2, pageCount - 1, pageCount]
  }
  return [1, 'ellipsis-left', page - 1, page, page + 1, 'ellipsis-right', pageCount]
}

function loadingItemName(itemName: string) {
  return itemName.replace(/^(条|个|台|份|项|位|组|次|张|套|类)/, '') || '记录'
}

function itemUnit(itemName: string) {
  const unit = itemName.match(/^(条|个|台|份|项|位|组|次|张|套|类)/)?.[1]
  return unit || '条'
}

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 20, 50],
  className,
  itemName = '条记录',
  loading = false,
  totalKnown = true,
  navigationDisabled = false,
}: PaginationProps) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const safePage = Math.min(Math.max(page, 1), pageCount)
  const start = total ? (safePage - 1) * pageSize + 1 : 0
  const end = Math.min(safePage * pageSize, total)
  const unit = itemUnit(itemName)
  const normalizedPageSizeOptions = Array.from(new Set([...pageSizeOptions, pageSize]))
    .filter((option) => Number.isFinite(option) && option > 0)
    .sort((left, right) => left - right)
  const rangeText = !totalKnown
    ? `${loadingItemName(itemName)}总数未取得`
    : total
      ? `第 ${start}-${end} ${unit}，共 ${total} ${itemName}`
      : `共 0 ${itemName}`
  const summaryText = loading && totalKnown && total > 0
    ? `${rangeText} · 正在更新`
    : loading
      ? `正在读取${loadingItemName(itemName)}`
      : rangeText
  const minimumPageSize = normalizedPageSizeOptions[0] || pageSize
  const showPageSizeControl = Boolean(onPageSizeChange) && totalKnown && total > minimumPageSize
  const showNavigation = totalKnown && pageCount > 1
  const showControls = showPageSizeControl || showNavigation

  return (
    <div aria-busy={loading} className={cn('flex min-w-0 flex-col gap-3 border-t border-slate-200/80 px-4 py-3 sm:flex-row sm:items-center sm:justify-between dark:border-white/[0.08]', className)}>
      <span aria-live="polite" className="min-w-0 break-words text-xs leading-5 text-slate-500 dark:text-slate-400">{summaryText}</span>
      {showControls ? <div className="flex w-full min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 sm:w-auto sm:shrink-0 sm:justify-end">
        {showPageSizeControl ? (
          <div className="h-9 w-[8rem] shrink-0">
            <UnifiedSelect
              ariaLabel={`每页${loadingItemName(itemName)}数量`}
              value={pageSize}
              disabled={loading || !totalKnown || navigationDisabled}
              onChange={(value) => onPageSizeChange?.(Number(value))}
              options={normalizedPageSizeOptions.map((option) => ({
                value: String(option),
                label: `每页 ${option} ${unit}`,
              }))}
              size="xs"
              className="h-9 w-full"
              maxPanelHeight={220}
            />
          </div>
        ) : null}

      {showNavigation ? <nav className="ml-auto flex max-w-full shrink-0 items-center gap-1 overflow-x-auto pb-1 sm:pb-0" aria-label="分页">
        <button
          type="button"
          onClick={() => onPageChange(safePage - 1)}
          disabled={loading || !totalKnown || navigationDisabled || safePage <= 1}
          title="上一页"
          aria-label="上一页"
          className="inline-flex h-9 w-9 items-center justify-center rounded-[6px] text-slate-500 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-white/[0.06]"
        >
          <ChevronLeft size={16} />
        </button>
        {pageItems(safePage, pageCount).map((item) => typeof item === 'number' ? (
          <button
            key={item}
            type="button"
            onClick={() => onPageChange(item)}
            disabled={loading || !totalKnown || navigationDisabled}
            aria-current={item === safePage ? 'page' : undefined}
            aria-label={`第 ${item} 页${item === safePage ? '，当前页' : ''}`}
            title={`第 ${item} 页`}
            className={cn(
              'h-9 min-w-9 rounded-[6px] px-2 text-xs font-semibold transition',
              item === safePage
                ? 'bg-blue-600 text-white'
                : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/[0.06]',
            )}
          >
            {item}
          </button>
        ) : <span key={item} className="w-6 text-center text-xs text-slate-400">...</span>)}
        <button
          type="button"
          onClick={() => onPageChange(safePage + 1)}
          disabled={loading || !totalKnown || navigationDisabled || safePage >= pageCount}
          title="下一页"
          aria-label="下一页"
          className="inline-flex h-9 w-9 items-center justify-center rounded-[6px] text-slate-500 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-white/[0.06]"
        >
          <ChevronRight size={16} />
        </button>
      </nav> : null}
      </div> : null}
    </div>
  )
}
