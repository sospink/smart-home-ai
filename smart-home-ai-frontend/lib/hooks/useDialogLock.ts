'use client'

import { useEffect, useRef, type RefObject } from 'react'

let dialogLockCount = 0
const focusTrapStack: symbol[] = []

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function useDialogLock(open: boolean) {
  useEffect(() => {
    if (!open) return undefined

    dialogLockCount += 1
    document.body.classList.add('dialog-open')

    return () => {
      dialogLockCount = Math.max(0, dialogLockCount - 1)
      if (dialogLockCount === 0) document.body.classList.remove('dialog-open')
    }
  }, [open])
}

export function useDialogFocusTrap(
  open: boolean,
  containerRef: RefObject<HTMLElement | null>,
  onEscape?: () => void,
  initialFocusRef?: RefObject<HTMLElement | null>,
) {
  const onEscapeRef = useRef(onEscape)

  useEffect(() => {
    onEscapeRef.current = onEscape
  }, [onEscape])

  useEffect(() => {
    if (!open) return undefined

    const token = Symbol('dialog-focus-trap')
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    focusTrapStack.push(token)

    const focusFirst = () => {
      if (focusTrapStack.at(-1) !== token) return
      const container = containerRef.current
      if (!container) return
      const initialFocus = initialFocusRef?.current
      if (initialFocus && container.contains(initialFocus) && initialFocus.offsetParent !== null) {
        initialFocus.focus()
        return
      }
      const first = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .find((element) => element.offsetParent !== null)
      ;(first || container).focus()
    }
    const frame = window.requestAnimationFrame(focusFirst)

    const handleKeyDown = (event: KeyboardEvent) => {
      if (focusTrapStack.at(-1) !== token) return
      if (event.key === 'Escape' && onEscapeRef.current) {
        event.preventDefault()
        onEscapeRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const container = containerRef.current
      if (!container) return
      const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((element) => element.offsetParent !== null)
      if (!focusable.length) {
        event.preventDefault()
        container.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !container.contains(document.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', handleKeyDown)
      const index = focusTrapStack.lastIndexOf(token)
      if (index >= 0) focusTrapStack.splice(index, 1)
      if (previousFocus?.isConnected) window.requestAnimationFrame(() => previousFocus.focus())
    }
  }, [containerRef, initialFocusRef, open])
}
