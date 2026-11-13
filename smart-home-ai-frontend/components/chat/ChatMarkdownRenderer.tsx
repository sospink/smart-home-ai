'use client'

import React, { isValidElement, useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Copy, TriangleAlert } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { copyTextToClipboard } from '@/lib/clipboard'

interface Props {
    content: string
    className?: string
}

function nodeText(node: ReactNode): string {
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(nodeText).join('')
    if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children)
    return ''
}

function CodeBlock({ children }: { children: ReactNode }) {
    const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
    const resetTimerRef = useRef<number | null>(null)
    const child = isValidElement<{ className?: string; children?: ReactNode }>(children) ? children : null
    const language = child?.props.className?.match(/language-([^\s]+)/)?.[1] || ''
    const code = nodeText(child?.props.children ?? children).replace(/\n$/, '')

    useEffect(() => () => {
        if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current)
    }, [])

    const copy = async () => {
        const success = await copyTextToClipboard(code)
        setCopyState(success ? 'copied' : 'failed')
        if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current)
        resetTimerRef.current = window.setTimeout(() => setCopyState('idle'), 1600)
    }

    const copyLabel = copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败' : '复制代码'

    return (
        <div className="my-3 max-w-full overflow-hidden rounded-[8px] border border-slate-700 bg-slate-950 text-slate-100">
            <div className="flex min-h-9 items-center justify-between gap-3 border-b border-white/10 px-3 text-[11px] text-slate-400">
                <span className="truncate font-mono" title={language || '代码'}>{language || '代码'}</span>
                <button
                    type="button"
                    onClick={copy}
                    disabled={!code}
                    title={copyState === 'failed' ? '复制失败，请手动选择代码' : copyLabel}
                    aria-label={copyLabel}
                    className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[6px] px-2 font-medium text-slate-300 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                    {copyState === 'copied' ? <Check size={13} className="text-emerald-400" /> : copyState === 'failed' ? <TriangleAlert size={13} className="text-rose-400" /> : <Copy size={13} />}
                    <span aria-live="polite">{copyLabel}</span>
                </button>
            </div>
            <pre className="max-w-full overflow-x-auto p-3 font-mono text-sm leading-6"><code>{code}</code></pre>
        </div>
    )
}

/**
 * ChatMarkdownRenderer
 * react-markdown + remark-gfm 实现 Markdown 渲染
 */
export const ChatMarkdownRenderer: React.FC<Props> = ({ content, className }) => {
    const components: React.ComponentProps<typeof ReactMarkdown>['components'] = {
        table: ({ children, ...props }) => (
            <div className="my-3 max-w-full overflow-x-auto rounded-[8px] border border-slate-200 dark:border-white/[0.08]" tabIndex={0} role="region" aria-label="消息表格，可横向滚动">
                <table className="min-w-[520px] table-auto border-collapse text-sm" {...props}>{children}</table>
            </div>
        ),
        thead: ({ children, ...props }) => (
            <thead className="border-b border-slate-200 bg-slate-50 dark:border-white/[0.08] dark:bg-white/[0.04]" {...props}>{children}</thead>
        ),
        tbody: ({ children, ...props }) => (
            <tbody className="divide-y divide-slate-100 dark:divide-white/[0.06]" {...props}>{children}</tbody>
        ),
        tr: ({ children, ...props }) => (
            <tr className="transition-colors hover:bg-slate-50/50 dark:hover:bg-white/[0.025]" {...props}>{children}</tr>
        ),
        th: ({ children, ...props }) => (
            <th className="whitespace-nowrap px-3 py-2.5 text-left text-xs font-bold text-slate-600 dark:text-slate-300" {...props}>{children}</th>
        ),
        td: ({ children, ...props }) => (
            <td className="min-w-[120px] break-words px-3 py-2.5 align-top text-sm leading-6 text-slate-700 dark:text-slate-300" {...props}>{children}</td>
        ),
        pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        code: ({ className: codeClassName, children, ...props }) => {
            const isInline = !codeClassName
            if (isInline) {
                return (
                    <code className="break-all rounded-[4px] bg-slate-100 px-1.5 py-0.5 font-mono text-sm text-slate-700 dark:bg-white/[0.08] dark:text-slate-200" {...props}>
                        {children}
                    </code>
                )
            }
            return <code className={codeClassName} {...props}>{children}</code>
        },
        h1: ({ children }) => <h1 className="mb-2 mt-4 text-lg font-bold text-slate-900 dark:text-white">{children}</h1>,
        h2: ({ children }) => <h2 className="mb-2 mt-3 text-base font-bold text-slate-800 dark:text-slate-100">{children}</h2>,
        h3: ({ children }) => <h3 className="mb-1 mt-2 text-sm font-bold text-slate-800 dark:text-slate-100">{children}</h3>,
        ul: ({ children }) => <ul className="my-1.5 ml-4 list-disc space-y-0.5 marker:text-slate-400">{children}</ul>,
        ol: ({ children }) => <ol className="my-1.5 ml-4 list-decimal space-y-0.5 marker:text-slate-400">{children}</ol>,
        li: ({ children }) => <li className="pl-0.5 text-sm text-slate-700 dark:text-slate-300">{children}</li>,
        hr: () => <hr className="my-3 border-slate-200 dark:border-white/[0.08]" />,
        p: ({ children }) => <p className="my-1">{children}</p>,
        a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="break-all text-blue-600 underline underline-offset-2 transition-colors hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300">
                {children}
            </a>
        ),
        strong: ({ children }) => <strong className="font-bold text-slate-900 dark:text-white">{children}</strong>,
        em: ({ children }) => <em className="italic">{children}</em>,
        blockquote: ({ children }) => (
            <blockquote className="my-2 rounded-r-md border-l-3 border-blue-300 bg-blue-50/30 py-1 pl-3 text-sm italic text-slate-600 dark:border-blue-400/50 dark:bg-blue-500/10 dark:text-slate-300">
                {children}
            </blockquote>
        ),
    }

    return (
        <div className={`min-w-0 max-w-full break-words text-sm leading-relaxed [overflow-wrap:anywhere] ${className ?? ''}`}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
                {content}
            </ReactMarkdown>
        </div>
    )
}
