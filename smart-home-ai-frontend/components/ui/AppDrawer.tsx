'use client'

import { useId, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { motion } from 'motion/react'
import { useDialogFocusTrap, useDialogLock } from '@/lib/hooks/useDialogLock'
import { cn } from '@/lib/utils'

type AppDrawerProps = {
  open?: boolean
  title: string
  description?: ReactNode
  children: ReactNode
  onClose: () => void
  widthClassName?: string
  zIndexClassName?: string
  headerActions?: ReactNode
  bodyClassName?: string
  footer?: ReactNode
  footerClassName?: string
}

/** 统一的右侧工作抽屉：处理门户、遮罩、Escape、滚动锁和可访问语义。 */
export function AppDrawer({
  open = true,
  title,
  description,
  children,
  onClose,
  widthClassName = 'max-w-xl',
  zIndexClassName = 'z-[120]',
  headerActions,
  bodyClassName,
  footer,
  footerClassName,
}: AppDrawerProps) {
  const titleId = useId()
  const descriptionId = useId()
  const panelRef = useRef<HTMLElement | null>(null)
  const mounted = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  )

  useDialogLock(open)
  useDialogFocusTrap(open, panelRef, onClose)

  if (!open || !mounted) return null

  return createPortal(
    <div className={cn('fixed inset-0 flex justify-end bg-slate-950/35 backdrop-blur-sm', zIndexClassName)}>
      <div className="absolute inset-0" onClick={onClose} aria-hidden="true" />
      <motion.aside
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        initial={{ opacity: 0, x: 24 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.16, ease: [0.25, 0.8, 0.25, 1] }}
        className={cn(
          'relative flex h-[100dvh] w-full min-w-0 flex-col overflow-hidden border-l border-slate-200 bg-white shadow-2xl shadow-slate-950/20 sm:my-2 sm:mr-2 sm:h-[calc(100dvh-1rem)] sm:rounded-l-[8px] dark:border-white/[0.08] dark:bg-[#18181b]',
          widthClassName,
        )}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-100 px-5 py-5 sm:px-6 dark:border-white/[0.08]">
          <div className="min-w-0">
            <h2 id={titleId} className="break-words text-xl font-extrabold leading-7 text-slate-950 dark:text-white">{title}</h2>
            {description ? <div id={descriptionId} className="mt-1.5 break-words text-sm leading-6 text-slate-500 dark:text-slate-400">{description}</div> : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {headerActions}
            <button type="button" onClick={onClose} className="inline-flex h-9 w-9 items-center justify-center rounded-[6px] border border-slate-200 text-slate-500 transition hover:border-blue-200 hover:text-blue-700 dark:border-white/[0.08] dark:text-slate-300" aria-label="关闭">
              <X size={18} />
            </button>
          </div>
        </header>
        <div className={cn('dialog-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 sm:px-6', bodyClassName)}>
          {children}
        </div>
        {footer ? (
          <footer className={cn('shrink-0 border-t border-slate-100 bg-white px-5 py-4 sm:px-6 dark:border-white/[0.08] dark:bg-[#18181b]', footerClassName)}>
            {footer}
          </footer>
        ) : null}
      </motion.aside>
    </div>,
    document.body,
  )
}
