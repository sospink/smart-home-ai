'use client'

import { useEffect, useRef } from 'react'
import { motion } from 'motion/react'
import { AlertTriangle, CheckCircle2, X, XCircle } from 'lucide-react'

export type InlineToastTone = 'success' | 'warning' | 'error'

const TONE_CLASS: Record<InlineToastTone, string> = {
  success: 'bg-emerald-500/95 text-white shadow-emerald-500/20',
  warning: 'bg-amber-500/95 text-white shadow-amber-500/20',
  error: 'bg-red-500/95 text-white shadow-red-500/20',
}

export function InlineToast({
  message,
  tone,
  onClose,
  duration = 3000,
}: {
  message: string
  tone: InlineToastTone
  onClose: () => void
  duration?: number
}) {
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose }, [onClose])
  useEffect(() => {
    const timer = window.setTimeout(() => closeRef.current(), duration)
    return () => window.clearTimeout(timer)
  }, [duration, message, tone])

  const Icon = tone === 'success' ? CheckCircle2 : tone === 'warning' ? AlertTriangle : XCircle
  return (
    <motion.div
      initial={{ opacity: 0, y: 16, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 12, scale: 0.98 }}
      role={tone === 'error' ? 'alert' : 'status'}
      className={`fixed inset-x-4 bottom-4 z-[200] flex max-h-[40vh] items-start gap-3 overflow-y-auto rounded-[8px] px-4 py-3 text-sm font-bold leading-6 shadow-xl backdrop-blur-lg sm:inset-x-auto sm:right-6 sm:top-6 sm:bottom-auto sm:max-w-[420px] sm:px-5 ${TONE_CLASS[tone]}`}
    >
      <Icon size={18} className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{message}</span>
      <button type="button" onClick={onClose} aria-label="关闭通知" title="关闭通知" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full opacity-80 transition hover:bg-white/10 hover:opacity-100">
        <X size={14} />
      </button>
    </motion.div>
  )
}
