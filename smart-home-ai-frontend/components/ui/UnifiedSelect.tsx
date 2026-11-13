'use client'

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'

export type UnifiedSelectOption = {
  value: string
  label: ReactNode
  disabled?: boolean
}

type UnifiedSelectProps = {
  value: string | number
  options: UnifiedSelectOption[]
  onChange: (value: string) => void
  ariaLabel?: string
  placeholder?: string
  disabled?: boolean
  className?: string
  size?: 'xs' | 'sm' | 'md'
  maxPanelHeight?: number
}

type FloatingRect = {
  left: number
  top: number
  width: number
  maxHeight: number
  zIndex: number
}

// 紧凑菜单还要容纳选项内边距、间距和选中图标，112px 会挤断“每页 100 条”。
const COMPACT_PANEL_MIN_WIDTH = 152

function optionTitle(label: ReactNode) {
  return typeof label === 'string' || typeof label === 'number' ? String(label) : undefined
}

export function UnifiedSelect({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder = '请选择',
  disabled = false,
  className = '',
  size = 'md',
  maxPanelHeight = 320,
}: UnifiedSelectProps) {
  const id = useId()
  const listboxId = `${id}-listbox`
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [floatingRect, setFloatingRect] = useState<FloatingRect | null>(null)
  const currentValue = String(value)

  const selected = useMemo(
    () => options.find((option) => option.value === currentValue),
    [currentValue, options],
  )
  const enabledIndexes = useMemo(
    () => options.flatMap((option, index) => option.disabled ? [] : [index]),
    [options],
  )
  const selectedIndex = useMemo(
    () => options.findIndex((option) => option.value === currentValue && !option.disabled),
    [currentValue, options],
  )
  const triggerDisabled = disabled || enabledIndexes.length === 0

  const initialIndex = useCallback((preferLast = false) => {
    if (selectedIndex >= 0) return selectedIndex
    return preferLast ? enabledIndexes.at(-1) ?? -1 : enabledIndexes[0] ?? -1
  }, [enabledIndexes, selectedIndex])

  const moveActive = useCallback((direction: 1 | -1) => {
    if (!enabledIndexes.length) return
    setActiveIndex((current) => {
      const position = enabledIndexes.indexOf(current)
      if (position < 0) return direction > 0 ? enabledIndexes[0] : enabledIndexes.at(-1) ?? -1
      const nextPosition = (position + direction + enabledIndexes.length) % enabledIndexes.length
      return enabledIndexes[nextPosition]
    })
  }, [enabledIndexes])

  const restoreTriggerFocus = useCallback(() => {
    window.requestAnimationFrame(() => buttonRef.current?.focus())
  }, [])

  const closeAndRestoreFocus = useCallback(() => {
    setOpen(false)
    restoreTriggerFocus()
  }, [restoreTriggerFocus])

  const focusAdjacentControl = useCallback((backward: boolean) => {
    const trigger = buttonRef.current
    if (!trigger) return
    const dialog = trigger.closest<HTMLElement>('[role="dialog"]')
    const scope: Document | HTMLElement = dialog || document
    const focusable = Array.from(scope.querySelectorAll<HTMLElement>(
      'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )).filter((element) => {
      if (panelRef.current?.contains(element)) return false
      if (element.hasAttribute('disabled') || element.getAttribute('aria-hidden') === 'true' || element.closest('[inert], [aria-hidden="true"]')) return false
      const style = window.getComputedStyle(element)
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0
    })
    const triggerIndex = focusable.indexOf(trigger)
    const target = focusable[triggerIndex + (backward ? -1 : 1)]
      || (dialog ? (backward ? focusable.at(-1) : focusable[0]) : undefined)
    setOpen(false)
    window.requestAnimationFrame(() => target?.focus())
  }, [])

  const updateFloatingRect = useCallback(() => {
    const trigger = buttonRef.current
    const rect = trigger?.getBoundingClientRect()
    if (!trigger || !rect) return
    const viewportPadding = 12
    const visualViewport = window.visualViewport
    const viewportLeft = visualViewport?.offsetLeft || 0
    const viewportTop = visualViewport?.offsetTop || 0
    const viewportWidth = Math.max(0, visualViewport?.width || window.innerWidth)
    const viewportHeight = Math.max(0, visualViewport?.height || window.innerHeight)
    const viewportRight = viewportLeft + viewportWidth
    const viewportBottom = viewportTop + viewportHeight
    if (rect.bottom <= viewportTop || rect.top >= viewportBottom || rect.right <= viewportLeft || rect.left >= viewportRight) {
      setOpen(false)
      setFloatingRect(null)
      return
    }
    const availableWidth = Math.max(0, viewportWidth - viewportPadding * 2)
    const preferredPanelWidth = size === 'xs'
      ? Math.max(rect.width, COMPACT_PANEL_MIN_WIDTH)
      : rect.width
    const panelWidth = Math.min(preferredPanelWidth, availableWidth)
    const estimatedPanelHeight = Math.min(maxPanelHeight, options.length * 56 + 16)
    const spaceBelow = Math.max(0, viewportBottom - rect.bottom - viewportPadding)
    const spaceAbove = Math.max(0, rect.top - viewportTop - viewportPadding)
    const shouldOpenUp = spaceBelow < estimatedPanelHeight && spaceAbove > spaceBelow
    const availableHeight = shouldOpenUp ? spaceAbove : spaceBelow
    const panelHeight = Math.max(0, Math.min(maxPanelHeight, availableHeight))
    const left = Math.min(
      Math.max(viewportLeft + viewportPadding, rect.left),
      Math.max(viewportLeft + viewportPadding, viewportRight - viewportPadding - panelWidth),
    )
    let zIndex = 160
    for (let ancestor: HTMLElement | null = trigger; ancestor; ancestor = ancestor.parentElement) {
      const parsed = Number.parseInt(window.getComputedStyle(ancestor).zIndex, 10)
      if (Number.isFinite(parsed)) zIndex = Math.max(zIndex, parsed + 10)
    }
    setFloatingRect({
      left,
      top: shouldOpenUp ? Math.max(viewportTop + viewportPadding, rect.top - panelHeight - 8) : rect.bottom + 8,
      width: panelWidth,
      maxHeight: panelHeight,
      zIndex,
    })
  }, [maxPanelHeight, options.length, size])

  useEffect(() => {
    if (!open) return
    const frame = window.requestAnimationFrame(updateFloatingRect)

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return
      setOpen(false)
    }

    window.addEventListener('resize', updateFloatingRect)
    window.addEventListener('scroll', updateFloatingRect, true)
    window.visualViewport?.addEventListener('resize', updateFloatingRect)
    window.visualViewport?.addEventListener('scroll', updateFloatingRect)
    document.addEventListener('pointerdown', handlePointerDown)

    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', updateFloatingRect)
      window.removeEventListener('scroll', updateFloatingRect, true)
      window.visualViewport?.removeEventListener('resize', updateFloatingRect)
      window.visualViewport?.removeEventListener('scroll', updateFloatingRect)
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [open, updateFloatingRect])

  useEffect(() => {
    if (!open || activeIndex < 0) return
    const frame = window.requestAnimationFrame(() => optionRefs.current[activeIndex]?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [activeIndex, open])

  useEffect(() => {
    if (!triggerDisabled) return
    const frame = window.requestAnimationFrame(() => setOpen(false))
    return () => window.cancelAnimationFrame(frame)
  }, [triggerDisabled])

  useEffect(() => {
    if (!open || enabledIndexes.includes(activeIndex)) return
    const frame = window.requestAnimationFrame(() => setActiveIndex(initialIndex()))
    return () => window.cancelAnimationFrame(frame)
  }, [activeIndex, enabledIndexes, initialIndex, open])

  const openAt = (index: number) => {
    if (triggerDisabled || index < 0) return
    updateFloatingRect()
    setActiveIndex(index)
    setOpen(true)
  }

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (triggerDisabled) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      openAt(initialIndex())
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      openAt(initialIndex(true))
    } else if (event.key === 'Home') {
      event.preventDefault()
      openAt(enabledIndexes[0] ?? -1)
    } else if (event.key === 'End') {
      event.preventDefault()
      openAt(enabledIndexes.at(-1) ?? -1)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openAt(initialIndex())
    }
  }

  const handleOptionKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveActive(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveActive(-1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      setActiveIndex(enabledIndexes[0] ?? -1)
    } else if (event.key === 'End') {
      event.preventDefault()
      setActiveIndex(enabledIndexes.at(-1) ?? -1)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      const option = options[index]
      if (!option?.disabled) {
        if (option.value !== currentValue) onChange(option.value)
        closeAndRestoreFocus()
      }
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeAndRestoreFocus()
    } else if (event.key === 'Tab') {
      event.preventDefault()
      focusAdjacentControl(event.shiftKey)
    }
  }

  const buttonSizeClass =
    size === 'xs'
      ? 'h-9 min-h-9 px-2.5 py-1 text-xs font-semibold tabular-nums'
      : size === 'sm'
      ? 'min-h-10 px-3 py-2 text-xs font-bold'
      : 'min-h-11 px-3 py-2.5 text-sm font-medium'

  return (
    <div className={`relative min-w-0 ${className}`}>
      <button
        ref={buttonRef}
        id={id}
        type="button"
        disabled={triggerDisabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined}
        aria-expanded={open}
        onKeyDown={handleTriggerKeyDown}
        onClick={() => {
          if (triggerDisabled) return
          if (!open) setActiveIndex(initialIndex())
          updateFloatingRect()
          setOpen((prev) => !prev)
        }}
        className={`flex w-full items-center justify-between rounded-[8px] border bg-white text-left text-slate-800 outline-none transition focus-visible:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-100 dark:bg-white/[0.05] dark:text-white dark:focus-visible:border-blue-400 dark:focus-visible:ring-blue-400/15 ${
          open
            ? 'border-blue-400 dark:border-blue-400/60'
            : 'border-slate-200 hover:border-blue-200 dark:border-white/[0.08] dark:hover:border-blue-400/30'
        } ${triggerDisabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'} ${buttonSizeClass}`}
      >
        <span title={selected ? optionTitle(selected.label) : placeholder} className={`flex-1 truncate ${size === 'xs' ? 'min-w-[3ch] pr-1 tabular-nums' : 'min-w-0 pr-2'} ${selected ? '' : 'text-slate-400 dark:text-slate-500'}`}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown
          size={size === 'xs' ? 14 : 16}
          className={`shrink-0 text-slate-400 transition ${open ? 'rotate-180 text-blue-500' : ''}`}
        />
      </button>

      {open && floatingRect
        ? createPortal(
          <div
            ref={panelRef}
            id={listboxId}
            role="listbox"
            aria-labelledby={id}
            className="fixed overflow-hidden rounded-[8px] border border-slate-200 bg-white shadow-[0_12px_28px_rgba(15,23,42,0.12)] dark:border-white/[0.08] dark:bg-slate-900 dark:shadow-[0_16px_32px_rgba(0,0,0,0.32)]"
            style={{
              left: floatingRect.left,
              top: floatingRect.top,
              width: floatingRect.width,
              zIndex: floatingRect.zIndex,
            }}
          >
            <div className="docs-api-scroll overflow-y-auto p-2" style={{ maxHeight: floatingRect.maxHeight }}>
              {options.map((option, index) => {
                const active = option.value === currentValue
                return (
                  <button
                    key={option.value}
                    ref={(element) => { optionRefs.current[index] = element }}
                    type="button"
                    role="option"
                    tabIndex={index === activeIndex ? 0 : -1}
                    aria-selected={active}
                    disabled={option.disabled}
                    onFocus={() => setActiveIndex(index)}
                    onKeyDown={(event) => handleOptionKeyDown(event, index)}
                    onClick={() => {
                      if (option.disabled) return
                      if (option.value !== currentValue) onChange(option.value)
                      closeAndRestoreFocus()
                    }}
                    className={`flex w-full items-center justify-between gap-3 rounded-[6px] px-3 text-left text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 ${size === 'xs' ? 'py-2.5' : 'py-3'} ${
                      active
                        ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-200'
                        : 'text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-white/[0.06]'
                    } ${option.disabled ? 'cursor-not-allowed opacity-50' : ''}`}
                  >
                    <span title={optionTitle(option.label)} className={`min-w-0 font-bold leading-5 ${size === 'xs' ? 'whitespace-nowrap' : 'line-clamp-2 break-words'}`}>{option.label}</span>
                    {active ? (
                      <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white dark:bg-blue-500">
                        <Check size={13} strokeWidth={3} />
                      </span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          </div>,
          document.body,
        )
        : null}
    </div>
  )
}
