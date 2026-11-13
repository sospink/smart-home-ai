import type { KeyboardEvent } from 'react'

/** 为视觉不变的页签组补齐方向键、Home/End 与焦点移动。 */
export function handleTabListKeyDown<T extends string>(
  event: KeyboardEvent<HTMLElement>,
  items: readonly T[],
  current: T,
  onChange: (value: T) => void,
) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  const currentIndex = Math.max(0, items.indexOf(current))
  const nextIndex = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? items.length - 1
      : event.key === 'ArrowRight'
        ? (currentIndex + 1) % items.length
        : (currentIndex - 1 + items.length) % items.length
  const next = items[nextIndex]
  if (!next) return
  event.preventDefault()
  onChange(next)
  const list = event.currentTarget.closest('[role="tablist"]')
  requestAnimationFrame(() => list?.querySelector<HTMLElement>(`[role="tab"][data-tab-id="${next}"]`)?.focus())
}
