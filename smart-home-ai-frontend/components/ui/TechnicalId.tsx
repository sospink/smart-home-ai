'use client'

import { useState } from 'react'
import { Check, Copy, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { copyTextToClipboard } from '@/lib/clipboard'

type TechnicalIdProps = {
  value?: string | null
  label?: string
  emptyText?: string
  className?: string
  compact?: boolean
}

export function TechnicalId({
  value,
  label = '技术标识',
  emptyText = '未提供',
  className,
  compact = false,
}: TechnicalIdProps) {
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const text = String(value || '').trim()

  const copy = async () => {
    if (!text) return
    const success = await copyTextToClipboard(text)
    setCopied(success)
    setCopyFailed(!success)
    window.setTimeout(() => {
      setCopied(false)
      setCopyFailed(false)
    }, 1600)
  }

  return (
    <div className={cn('min-w-0', className)}>
      {!compact ? <p className="mb-1 text-[11px] font-medium text-slate-500 dark:text-slate-500">{label}</p> : null}
      <div className="flex min-w-0 items-center gap-1.5">
        <code
          title={text || emptyText}
          className="min-w-0 flex-1 truncate rounded-[6px] bg-slate-100 px-2 py-1 text-[11px] leading-5 text-slate-600 dark:bg-white/[0.05] dark:text-slate-400"
        >
          {text || emptyText}
        </code>
        {text ? (
          <button
            type="button"
            onClick={copy}
            title={copied ? '已复制' : copyFailed ? '复制失败，请手动选择内容' : `复制${label}`}
            aria-label={copied ? `${label}已复制` : copyFailed ? `${label}复制失败` : `复制${label}`}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[6px] text-slate-500 transition hover:bg-slate-100 hover:text-blue-600 dark:hover:bg-white/[0.06] dark:hover:text-blue-300"
          >
            {copied ? <Check size={14} className="text-emerald-600" /> : copyFailed ? <TriangleAlert size={14} className="text-rose-600" /> : <Copy size={14} />}
          </button>
        ) : null}
      </div>
    </div>
  )
}
