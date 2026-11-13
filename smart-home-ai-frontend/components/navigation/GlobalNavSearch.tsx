'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRight, Search } from 'lucide-react'

export type GlobalNavSearchOption = {
  label: string
  href: string
  group: string
  keywords?: string[]
}

type GlobalNavSearchProps = {
  options: GlobalNavSearchOption[]
}

function normalized(value: string) {
  return value.trim().toLocaleLowerCase('zh-CN').replace(/[\s/_-]+/g, '')
}

export function GlobalNavSearch({ options }: GlobalNavSearchProps) {
  const router = useRouter()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)

  const results = useMemo(() => {
    const target = normalized(query)
    if (!target) return []
    return options
      .map((option) => {
        const fields = [option.label, option.group, option.href, ...(option.keywords || [])]
          .map(normalized)
        const exactLabel = normalized(option.label) === target
        const labelStarts = normalized(option.label).startsWith(target)
        const match = fields.some((field) => field.includes(target))
        return { option, match, score: exactLabel ? 0 : labelStarts ? 1 : 2 }
      })
      .filter((item) => item.match)
      .sort((left, right) => left.score - right.score || left.option.label.localeCompare(right.option.label, 'zh-CN'))
      .slice(0, 8)
      .map((item) => item.option)
  }, [options, query])

  const close = useCallback(() => {
    setOpen(false)
    setActiveIndex(0)
  }, [])

  const navigate = useCallback((href: string) => {
    setQuery('')
    close()
    router.push(href)
  }, [close, router])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault()
        inputRef.current?.focus()
        setOpen(Boolean(inputRef.current?.value.trim()))
      }
      if (event.key === 'Escape' && document.activeElement === inputRef.current) {
        close()
        inputRef.current?.blur()
      }
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) close()
    }
    window.addEventListener('keydown', handleKeyDown)
    document.addEventListener('mousedown', handlePointerDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('mousedown', handlePointerDown)
    }
  }, [close])

  const safeActiveIndex = Math.min(activeIndex, Math.max(0, results.length - 1))
  const activeId = open && results[safeActiveIndex] ? `global-nav-result-${safeActiveIndex}` : undefined

  return (
    <div ref={containerRef} className="relative min-w-0 flex-1 sm:max-w-md">
      <Search size={16} className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-slate-400 dark:text-slate-500" />
      <input
        ref={inputRef}
        type="search"
        value={query}
        onChange={(event) => {
          const value = event.target.value
          setQuery(value)
          setActiveIndex(0)
          setOpen(Boolean(value.trim()))
        }}
        onFocus={() => setOpen(Boolean(query.trim()))}
        onKeyDown={(event) => {
          if (!open || !results.length) return
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setActiveIndex((index) => (index + 1) % results.length)
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setActiveIndex((index) => (index - 1 + results.length) % results.length)
          } else if (event.key === 'Enter') {
            event.preventDefault()
            navigate(results[safeActiveIndex].href)
          }
        }}
        placeholder="搜索功能入口"
        aria-label="全局功能搜索"
        aria-autocomplete="list"
        aria-controls="global-nav-results"
        aria-expanded={open}
        aria-activedescendant={activeId}
        role="combobox"
        className="h-10 w-full rounded-full border border-slate-100 bg-slate-50 pl-9 pr-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-blue-300 focus:bg-white focus:ring-2 focus:ring-blue-100 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:border-blue-400/50 dark:focus:bg-white/[0.07] dark:focus:ring-blue-400/10"
      />

      {open ? (
        <div
          id="global-nav-results"
          role="listbox"
          aria-label="功能入口搜索结果"
          className="absolute left-0 right-0 top-[calc(100%+8px)] z-[80] overflow-hidden rounded-[8px] border border-slate-200 bg-white p-2 shadow-[0_18px_44px_rgba(15,23,42,0.16)] dark:border-white/[0.08] dark:bg-slate-900"
        >
          {results.length ? results.map((option, index) => (
            <button
              key={option.href}
              id={`global-nav-result-${index}`}
              type="button"
              role="option"
              aria-selected={index === safeActiveIndex}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => navigate(option.href)}
              className={`flex w-full items-center justify-between gap-3 rounded-[6px] px-3 py-2.5 text-left transition ${
                index === safeActiveIndex
                  ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-200'
                  : 'text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-white/[0.06]'
              }`}
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold">{option.label}</span>
                <span className="mt-0.5 block truncate text-xs text-slate-400">{option.group}</span>
              </span>
              <ArrowRight size={15} className="shrink-0" />
            </button>
          )) : (
            <div className="px-3 py-5 text-center">
              <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">未找到匹配入口</p>
              <p className="mt-1 text-xs text-slate-400">可搜索设备、模型、智能体、文档或设置</p>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
