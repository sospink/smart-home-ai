'use client'

/**
 * Global Toast Notification System
 * Usage:
 *   import { toast } from '@/components/ui/toast'
 *   toast.success('操作成功')
 *   toast.error('操作失败')
 *   toast.info('提示信息')
 *   toast.warning('警告信息')
 */

import { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { CheckCircle2, XCircle, Info, AlertTriangle, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/* ── Types ── */
type ToastType = 'success' | 'error' | 'info' | 'warning'

interface Toast {
  id: string
  type: ToastType
  message: string
  duration?: number
}

interface ToastContextValue {
  success: (message: string, duration?: number) => void
  error: (message: string, duration?: number) => void
  info: (message: string, duration?: number) => void
  warning: (message: string, duration?: number) => void
}

/* ── Styling ── */
const TOAST_CONFIG: Record<ToastType, { icon: LucideIcon; bg: string; border: string; text: string; iconColor: string }> = {
  success: {
    icon: CheckCircle2,
    bg: 'bg-white dark:bg-[#18181b]',
    border: 'border-emerald-200 dark:border-emerald-500/20',
    text: 'text-slate-900 dark:text-white',
    iconColor: 'text-emerald-500',
  },
  error: {
    icon: XCircle,
    bg: 'bg-white dark:bg-[#18181b]',
    border: 'border-red-200 dark:border-red-500/20',
    text: 'text-slate-900 dark:text-white',
    iconColor: 'text-red-500',
  },
  info: {
    icon: Info,
    bg: 'bg-white dark:bg-[#18181b]',
    border: 'border-blue-200 dark:border-blue-500/20',
    text: 'text-slate-900 dark:text-white',
    iconColor: 'text-blue-500',
  },
  warning: {
    icon: AlertTriangle,
    bg: 'bg-white dark:bg-[#18181b]',
    border: 'border-amber-200 dark:border-amber-500/20',
    text: 'text-slate-900 dark:text-white',
    iconColor: 'text-amber-500',
  },
}

/* ── Context ── */
const ToastContext = createContext<ToastContextValue | null>(null)

let globalToast: ToastContextValue | null = null

export const toast = {
  success: (msg: string, dur?: number) => globalToast?.success(msg, dur),
  error: (msg: string, dur?: number) => globalToast?.error(msg, dur),
  info: (msg: string, dur?: number) => globalToast?.info(msg, dur),
  warning: (msg: string, dur?: number) => globalToast?.warning(msg, dur),
}

/* ── Toast Item ── */
function ToastItem({ toast: t, onRemove }: { toast: Toast; onRemove: (id: string) => void }) {
  const config = TOAST_CONFIG[t.type]
  const Icon = config.icon

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 80, scale: 0.95 }}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
      role={t.type === 'error' ? 'alert' : 'status'}
      className={`flex w-full min-w-0 items-start gap-3 rounded-[8px] border px-4 py-3 shadow-lg backdrop-blur-md sm:min-w-[280px] sm:max-w-[420px] sm:px-5 sm:py-3.5 dark:shadow-none ${config.bg} ${config.border} ${config.text}`}
    >
      <Icon size={20} className={`${config.iconColor} shrink-0`} />
      <p className="min-w-0 flex-1 [overflow-wrap:anywhere] text-sm font-medium leading-6">{t.message}</p>
      <button
        type="button"
        onClick={() => onRemove(t.id)}
        aria-label="关闭通知"
        title="关闭通知"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-100 dark:text-slate-500 dark:hover:bg-white/[0.06]"
      >
        <X size={14} />
      </button>
    </motion.div>
  )
}

/* ── Provider ── */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const timersRef = useRef<Map<string, number>>(new Map())
  const toastByIdRef = useRef<Map<string, Toast>>(new Map())
  const toastKeyToIdRef = useRef<Map<string, string>>(new Map())
  const toastIdToKeyRef = useRef<Map<string, string>>(new Map())
  const toastOrderRef = useRef<string[]>([])

  const syncToasts = useCallback(() => {
    setToasts(toastOrderRef.current.flatMap(id => {
      const item = toastByIdRef.current.get(id)
      return item ? [item] : []
    }))
  }, [])

  const removeToast = useCallback((id: string) => {
    const timer = timersRef.current.get(id)
    if (timer) window.clearTimeout(timer)
    timersRef.current.delete(id)
    toastByIdRef.current.delete(id)
    const key = toastIdToKeyRef.current.get(id)
    if (key && toastKeyToIdRef.current.get(key) === id) toastKeyToIdRef.current.delete(key)
    toastIdToKeyRef.current.delete(id)
    toastOrderRef.current = toastOrderRef.current.filter(itemId => itemId !== id)
    syncToasts()
  }, [syncToasts])

  const addToast = useCallback((type: ToastType, message: string, duration?: number) => {
    const normalizedMessage = message.trim() || '操作结果未提供详细说明'
    const key = `${type}\u0000${normalizedMessage}`
    const duplicateId = toastKeyToIdRef.current.get(key)
    const id = duplicateId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const resolvedDuration = duration ?? (type === 'error' ? 6000 : type === 'warning' ? 4500 : 3000)
    const item = { id, type, message: normalizedMessage, duration: resolvedDuration }

    const previousTimer = timersRef.current.get(id)
    if (previousTimer) window.clearTimeout(previousTimer)
    toastByIdRef.current.set(id, item)
    toastKeyToIdRef.current.set(key, id)
    toastIdToKeyRef.current.set(id, key)
    toastOrderRef.current = [...toastOrderRef.current.filter(itemId => itemId !== id), id]

    while (toastOrderRef.current.length > 5) {
      const removedId = toastOrderRef.current.shift()
      if (!removedId) break
      const removedTimer = timersRef.current.get(removedId)
      if (removedTimer) window.clearTimeout(removedTimer)
      timersRef.current.delete(removedId)
      toastByIdRef.current.delete(removedId)
      const removedKey = toastIdToKeyRef.current.get(removedId)
      if (removedKey && toastKeyToIdRef.current.get(removedKey) === removedId) toastKeyToIdRef.current.delete(removedKey)
      toastIdToKeyRef.current.delete(removedId)
    }

    syncToasts()

    const timer = window.setTimeout(() => removeToast(id), resolvedDuration)
    timersRef.current.set(id, timer)
  }, [removeToast, syncToasts])

  const contextValue = useMemo<ToastContextValue>(() => ({
    success: (msg, dur) => addToast('success', msg, dur),
    error: (msg, dur) => addToast('error', msg, dur),
    info: (msg, dur) => addToast('info', msg, dur),
    warning: (msg, dur) => addToast('warning', msg, dur),
  }), [addToast])

  useEffect(() => {
    const timers = timersRef.current
    const toastById = toastByIdRef.current
    const toastKeyToId = toastKeyToIdRef.current
    const toastIdToKey = toastIdToKeyRef.current
    globalToast = contextValue
    return () => {
      if (globalToast === contextValue) globalToast = null
      timers.forEach(timer => window.clearTimeout(timer))
      timers.clear()
      toastById.clear()
      toastKeyToId.clear()
      toastIdToKey.clear()
      toastOrderRef.current = []
    }
  }, [contextValue])

  return (
    <ToastContext.Provider value={contextValue}>
      {children}

      {/* Toast Container — fixed top-right */}
      <div className="pointer-events-none fixed inset-x-4 bottom-4 z-[200] flex max-h-[calc(100vh-6rem)] flex-col-reverse items-stretch gap-3 overflow-y-auto sm:inset-x-auto sm:right-6 sm:top-6 sm:bottom-auto sm:flex-col sm:items-end">
        <AnimatePresence mode="popLayout">
          {toasts.map(t => (
            <div key={t.id} className="pointer-events-auto">
              <ToastItem toast={t} onRemove={removeToast} />
            </div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be inside ToastProvider')
  return ctx
}
