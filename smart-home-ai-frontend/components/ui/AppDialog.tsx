'use client'

import { useId, useRef, useSyncExternalStore, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { motion } from 'motion/react'
import { useDialogFocusTrap, useDialogLock } from '@/lib/hooks/useDialogLock'

type AppDialogProps = {
  open?: boolean
  title?: string
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  onClose: () => void
  maxWidth?: string
  danger?: boolean
  closeOnOverlay?: boolean
  closeOnEscape?: boolean
  showClose?: boolean
  panelClassName?: string
  bodyClassName?: string
  footerClassName?: string
  zIndexClass?: string
  initialFocusRef?: RefObject<HTMLElement | null>
}

export function AppDialog({
  open = true,
  title,
  description,
  children,
  footer,
  onClose,
  maxWidth = 'max-w-md',
  danger = false,
  closeOnOverlay = true,
  closeOnEscape,
  showClose = true,
  panelClassName = '',
  bodyClassName = '',
  footerClassName = '',
  zIndexClass = 'z-[100]',
  initialFocusRef,
}: AppDialogProps) {
  const titleId = useId()
  const descriptionId = useId()
  const panelRef = useRef<HTMLElement | null>(null)
  const mounted = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  )

  useDialogLock(open)
  const escapeHandler = (closeOnEscape ?? (closeOnOverlay || showClose)) ? onClose : undefined

  useDialogFocusTrap(open, panelRef, escapeHandler, initialFocusRef)

  if (!open || !mounted) return null

  return createPortal(
    <div
      className={`fixed inset-0 ${zIndexClass} flex items-center justify-center bg-black/40 p-3 backdrop-blur-sm sm:p-4`}
      onClick={closeOnOverlay ? onClose : undefined}
      role="presentation"
    >
      <motion.section
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={description ? descriptionId : undefined}
        aria-label={!title ? '操作对话框' : undefined}
        initial={{ opacity: 0, scale: 0.95, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 8 }}
        transition={{ duration: 0.16, ease: [0.25, 0.8, 0.25, 1] }}
        className={`relative flex max-h-[calc(100dvh-1.5rem)] w-full min-w-0 ${maxWidth} flex-col overflow-hidden rounded-[8px] border border-slate-200 bg-white font-sans shadow-[0_18px_48px_rgba(15,23,42,0.16)] sm:max-h-[calc(100dvh-2rem)] dark:border-white/[0.08] dark:bg-[#18181b] dark:shadow-[0_20px_52px_rgba(0,0,0,0.42)] ${panelClassName}`}
        onClick={(event) => event.stopPropagation()}
      >
        {(title || description || showClose) ? (
          <div className="flex items-start justify-between gap-5 px-6 pt-6">
            <div className="min-w-0 space-y-2">
              {title ? (
                <h3 id={titleId} className={`break-words font-sans text-lg font-extrabold leading-7 ${danger ? 'text-red-600 dark:text-red-300' : 'text-slate-900 dark:text-white'}`}>
                  {title}
                </h3>
              ) : null}
              {description ? (
                <div id={descriptionId} className="break-words text-sm leading-6 text-slate-500 dark:text-slate-400">{description}</div>
              ) : null}
            </div>
            {showClose ? (
              <button
                type="button"
                onClick={onClose}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[6px] border border-slate-200 text-slate-400 transition hover:border-blue-200 hover:text-blue-700 dark:border-white/[0.08] dark:hover:border-blue-400/30 dark:hover:text-white"
                aria-label="关闭"
              >
                <X size={20} />
              </button>
            ) : null}
          </div>
        ) : null}

        <div className={`dialog-scrollbar min-h-0 flex-1 overflow-y-auto px-6 ${title || description || showClose ? 'pt-5' : 'pt-6'} ${footer ? 'pb-2' : 'pb-6'} ${bodyClassName}`}>
          {children}
        </div>

        {footer ? (
          <div className={`max-w-full shrink-0 border-t border-slate-100 px-6 pb-6 pt-4 dark:border-white/[0.08] ${footerClassName}`}>
            {footer}
          </div>
        ) : null}
      </motion.section>
    </div>,
    document.body,
  )
}
