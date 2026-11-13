'use client'

import React, { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react'
import {
    Lightbulb,
    Settings, RotateCcw, Mic, MicOff,
    ShieldCheck, Bot, BarChart2,
    PanelLeftClose, PanelLeftOpen, Plus, Trash2,
    ThumbsUp, ThumbsDown, Bug, ExternalLink, Loader2, X,
    Activity, Server, Copy, Check, Database, MessageSquare, TriangleAlert, ArrowDown
} from 'lucide-react'
import { AnimatedOrb } from '@/components/chat/AnimatedOrb'
import { ChatMarkdownRenderer } from '@/components/chat/ChatMarkdownRenderer'
import { AppDialog } from '@/components/ui/AppDialog'
import { AppDrawer } from '@/components/ui/AppDrawer'
import { TechnicalId } from '@/components/ui/TechnicalId'
import { useDialogFocusTrap, useDialogLock } from '@/lib/hooks/useDialogLock'
import {
    chatStream,
    getConversations,
    getMessages,
    deleteConversation,
    getWorkflowRunDetail,
    stopChatStream,
    submitMessageFeedback,
    getAgentRuntimeOverview,
    clearChatReadCache,
    checkChatPlatformReachable,
} from '@/lib/api/chat'
import type { AgentRuntimeOverview, ConversationItem, HistoryMessage, MessageFeedback, WorkflowRunDetail } from '@/lib/api/chat'
import { ApiError } from '@/lib/api/client'
import { formatMilliseconds } from '@/lib/ui/format-duration'
import { businessErrorMessage } from '@/lib/ui/business-error'
import { copyTextToClipboard } from '@/lib/clipboard'
import { getAuthCacheScope } from '@/lib/auth-storage'

interface ChatMessage {
    id: string
    role: 'user' | 'ai'
    text: string
    time: string
    messageId?: string
    conversationId?: string
    workflowRunId?: string
    taskId?: string
    createdAt?: number
    feedback?: MessageFeedback | null
    usage?: Record<string, unknown>
    retrieverResources?: unknown[]
    executionSource?: string
    executionSuccess?: boolean
    executionConfirmation?: string
    deviceId?: string
    entityId?: string
    action?: string
    streamStatus?: 'streaming' | 'complete' | 'stopped' | 'error'
}

type ChatRetryTarget = {
    messageId: string
    query: string
    conversationId: string
}

type ChatNoticeTone = 'info' | 'success' | 'warning' | 'danger'

type RetrievalResourceSummary = {
    title: string
    datasetName: string
    content: string
    score: number | null
}

type SpeechRecognitionResultEvent = Event & {
    resultIndex: number
    results: ArrayLike<{
        readonly isFinal: boolean
        readonly 0: { transcript: string }
    }>
}

type BrowserSpeechRecognition = {
    lang: string
    continuous: boolean
    interimResults: boolean
    onresult: ((event: SpeechRecognitionResultEvent) => void) | null
    onerror: ((event: Event & { error?: string }) => void) | null
    onend: (() => void) | null
    start: () => void
    stop: () => void
    abort: () => void
}

type SpeechRecognitionConstructor = new () => BrowserSpeechRecognition
type SpeechWindow = Window & {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
}

const CHAT_DRAFT_PREFIX = 'smart-home-chat-draft'
const CHAT_CONVERSATION_SNAPSHOT_PREFIX = 'smart-home-chat-conversation-snapshot'
const CHAT_CONVERSATION_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000
const CHAT_QUERY_MAX_LENGTH = 20_000
const CHAT_FEEDBACK_MAX_LENGTH = 2_000

type ConversationSnapshot = {
    savedAt: string
    hasMore: boolean
    items: ConversationSnapshotItem[]
}

type ConversationSnapshotItem = Pick<ConversationItem, 'id' | 'name' | 'status' | 'created_at' | 'updated_at'>

function snapshotConversation(item: ConversationItem): ConversationSnapshotItem {
    return {
        id: item.id,
        name: item.name,
        status: item.status,
        created_at: item.created_at,
        updated_at: item.updated_at,
    }
}

function chatDraftKey(conversationId: string) {
    return `${CHAT_DRAFT_PREFIX}:${encodeURIComponent(getAuthCacheScope())}:${encodeURIComponent(conversationId || 'new')}`
}

function readChatDraft(conversationId: string) {
    if (typeof window === 'undefined') return ''
    try {
        return window.sessionStorage.getItem(chatDraftKey(conversationId)) || ''
    } catch {
        return ''
    }
}

function writeChatDraft(conversationId: string, value: string) {
    if (typeof window === 'undefined') return
    try {
        const key = chatDraftKey(conversationId)
        if (value) window.sessionStorage.setItem(key, value)
        else window.sessionStorage.removeItem(key)
    } catch {
        // 浏览器禁用会话存储时继续使用当前内存草稿。
    }
}

function removeChatDraft(conversationId: string) {
    if (typeof window === 'undefined' || !conversationId) return
    try {
        window.sessionStorage.removeItem(chatDraftKey(conversationId))
    } catch {
        // 浏览器禁用会话存储时无需额外处理。
    }
}

function conversationSnapshotKey() {
    return `${CHAT_CONVERSATION_SNAPSHOT_PREFIX}:${encodeURIComponent(getAuthCacheScope())}`
}

function readConversationSnapshot(): ConversationSnapshot | null {
    if (typeof window === 'undefined') return null
    const key = conversationSnapshotKey()
    try {
        const parsed = JSON.parse(window.sessionStorage.getItem(key) || 'null') as Partial<ConversationSnapshot> | null
        if (!parsed) return null
        if (typeof parsed.savedAt !== 'string' || typeof parsed.hasMore !== 'boolean' || !Array.isArray(parsed.items)) {
            window.sessionStorage.removeItem(key)
            return null
        }
        const savedAt = new Date(parsed.savedAt).getTime()
        if (!Number.isFinite(savedAt) || Date.now() - savedAt > CHAT_CONVERSATION_SNAPSHOT_MAX_AGE_MS || savedAt > Date.now() + 60_000) {
            window.sessionStorage.removeItem(key)
            return null
        }
        const items = parsed.items.filter((item): item is ConversationSnapshotItem => Boolean(
            item
            && typeof item.id === 'string'
            && typeof item.name === 'string'
            && typeof item.status === 'string'
            && typeof item.created_at === 'number'
            && typeof item.updated_at === 'number',
        )).slice(0, 20)
        return { savedAt: parsed.savedAt, hasMore: parsed.hasMore, items }
    } catch {
        try {
            window.sessionStorage.removeItem(key)
        } catch {
            // 存储不可用时保持内存流程，不阻塞页面。
        }
        return null
    }
}

function writeConversationSnapshot(items: ConversationItem[], hasMore: boolean, savedAt = new Date().toISOString()) {
    if (typeof window === 'undefined') return ''
    try {
        const snapshot: ConversationSnapshot = { savedAt, hasMore, items: items.slice(0, 20).map(snapshotConversation) }
        window.sessionStorage.setItem(conversationSnapshotKey(), JSON.stringify(snapshot))
    } catch {
        // 浏览器禁用会话存储时继续使用当前内存目录。
    }
    return savedAt
}

function messageSourceLabel(message: ChatMessage) {
    if (message.executionSource === 'local_dynamic_device_control') return '本地动态设备控制 / Home Assistant'
    if (message.executionSource === 'local_dynamic_device_status') return '本地动态设备台账 / Home Assistant'
    if (message.workflowRunId) return 'Dify 工作流'
    if (message.retrieverResources?.length) return 'Dify 知识检索'
    if (message.messageId) return 'Dify 对话流'
    return '等待回传'
}

function messageSupportsFeedback(message: ChatMessage) {
    if (!message.messageId) return false
    if (message.executionSource?.startsWith('local_') || message.messageId.startsWith('local-control-')) return false
    return message.streamStatus !== 'streaming' && message.streamStatus !== 'error' && message.streamStatus !== 'stopped'
}

function messageFeedbackUnavailableReason(message: ChatMessage) {
    if (message.executionSource?.startsWith('local_') || message.messageId?.startsWith('local-control-')) return '本地设备操作由平台记录，不属于 Dify 消息评价范围。'
    if (message.streamStatus === 'streaming') return '回复完成后才能提交效果评估。'
    if (message.streamStatus === 'error' || message.streamStatus === 'stopped') return '未完整结束的回复不能提交效果评估。'
    return '该回复未取得 Dify 消息标识，不能提交效果评估。'
}

function deviceActionLabel(action?: string) {
    if (!action) return '—'
    const labels: Record<string, string> = {
        turn_on: '打开',
        turn_off: '关闭',
        toggle: '切换开关',
        set_value: '设置数值',
        select_option: '选择模式',
        lock: '上锁',
        unlock: '解锁',
        open_cover: '打开窗帘',
        close_cover: '关闭窗帘',
        stop_cover: '停止窗帘',
        set_brightness: '设置亮度',
        set_color_temperature: '设置色温',
        set_position: '设置位置',
        set_temperature: '设置温度',
        set_hvac_mode: '设置空调模式',
        set_percentage: '设置百分比',
        set_effect: '设置灯效',
    }
    return labels[action.toLowerCase()] || '设备操作'
}

function workflowStatusLabel(status?: string | null) {
    if (!status) return '未取得'
    const labels: Record<string, string> = {
        running: '运行中',
        succeeded: '运行成功',
        success: '运行成功',
        completed: '已完成',
        failed: '运行失败',
        error: '运行失败',
        stopped: '已停止',
        canceled: '已取消',
        cancelled: '已取消',
        paused: '已暂停',
    }
    return labels[status.toLowerCase()] || '状态待确认'
}

function streamFailureMessage(value: unknown) {
    return businessErrorMessage(value, {
        fallback: '智能体执行失败，请检查服务运行状态后重试',
        service: '智能体服务',
    })
}

function applyStreamFailure(message: ChatMessage, value: unknown): ChatMessage {
    if (message.streamStatus === 'error') return message
    const reason = streamFailureMessage(value)
    return {
        ...message,
        text: message.text
            ? `${message.text}\n\n---\n回复中断：${reason}`
            : `请求未完成：${reason}`,
        streamStatus: 'error',
    }
}

function normalizeFeedback(feedback: unknown): MessageFeedback | null {
    if (!feedback || typeof feedback !== 'object') return null
    const rating = (feedback as Record<string, unknown>).rating
    const content = (feedback as Record<string, unknown>).content
    return {
        rating: rating === 'like' || rating === 'dislike' ? rating : undefined,
        content: typeof content === 'string' ? content : undefined,
    }
}

function formatDetailTime(value?: number | string) {
    if (!value) return '—'
    const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value)
    if (Number.isNaN(date.getTime())) return '—'
    return date.toLocaleString('zh-CN')
}

function conversationDateGroup(value?: number) {
    if (!value || !Number.isFinite(value)) return '时间未取得'
    const date = new Date(value * 1000)
    if (Number.isNaN(date.getTime())) return '时间未取得'
    const now = new Date()
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
    const daysAgo = Math.floor((startOfToday - dayStart) / 86_400_000)
    if (daysAgo <= 0) return '今天'
    if (daysAgo === 1) return '昨天'
    if (daysAgo < 7) return '近 7 天'
    return '更早'
}

function groupConversations(items: ConversationItem[]) {
    const groups: Array<{ label: string; items: ConversationItem[] }> = []
    for (const item of items) {
        const label = conversationDateGroup(item.updated_at || item.created_at)
        const current = groups.at(-1)
        if (current?.label === label) current.items.push(item)
        else groups.push({ label, items: [item] })
    }
    return groups
}

function retrievalResourceSummary(resource: unknown, index: number): RetrievalResourceSummary {
    const item = resource && typeof resource === 'object' ? resource as Record<string, unknown> : {}
    const text = (key: string) => typeof item[key] === 'string' ? item[key].trim() : ''
    const scoreValue = item.score ?? item.relevance_score
    const rawScore = typeof scoreValue === 'number' ? scoreValue : Number(scoreValue)
    return {
        title: text('document_name') || text('name') || text('title') || text('segment_name') || `检索片段 ${index + 1}`,
        datasetName: text('dataset_name') || text('dataset'),
        content: text('content') || text('segment_content') || text('text') || '该检索记录未返回可展示的正文。',
        score: Number.isFinite(rawScore) ? rawScore : null,
    }
}

function formatRetrievalScore(score: number | null) {
    if (score === null) return '相关度未返回'
    return `相关度 ${score >= 0 && score <= 1 ? `${(score * 100).toFixed(1)}%` : score.toFixed(3)}`
}

function formatElapsedSeconds(value?: number | null) {
    if (value === null || value === undefined) return '—'
    return `${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} 秒`
}

function messageUsageSummary(value?: Record<string, unknown>) {
    const usage = value || {}
    const numberValue = (...keys: string[]) => {
        for (const key of keys) {
            const raw = usage[key]
            const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : Number.NaN
            if (Number.isFinite(parsed)) return parsed
        }
        return null
    }
    const promptTokens = numberValue('prompt_tokens', 'input_tokens', 'prompt_token')
    const completionTokens = numberValue('completion_tokens', 'output_tokens', 'answer_tokens', 'completion_token')
    const totalTokens = numberValue('total_tokens', 'total_token', 'tokens')
    const totalPrice = numberValue('total_price', 'price', 'cost')
    const currencyValue = usage.currency ?? usage.currency_type
    const currency = typeof currencyValue === 'string' ? currencyValue.trim().toUpperCase() : ''
    return { promptTokens, completionTokens, totalTokens, totalPrice, currency }
}

function historyMessages(items: HistoryMessage[], conversationId: string): ChatMessage[] {
    const messages: ChatMessage[] = []
    for (const item of [...items].reverse()) {
        const date = new Date(item.created_at * 1000)
        const time = Number.isNaN(date.getTime())
            ? '—'
            : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
        if (item.query) {
            messages.push({ id: `user-${item.id}`, role: 'user', text: item.query, time, createdAt: item.created_at, conversationId })
        }
        if (item.answer) {
            messages.push({
                id: `ai-${item.id}`,
                role: 'ai',
                text: item.answer,
                time,
                messageId: item.id,
                conversationId,
                createdAt: item.created_at,
                feedback: normalizeFeedback(item.feedback),
                workflowRunId: item.workflow_run_id || item.workflow_run?.id,
                taskId: item.task_id || item.task?.id,
                usage: item.usage || item.message_tokens,
                retrieverResources: item.retriever_resources || [],
            })
        }
    }
    return messages
}

function deepLinkedConversation(conversationId: string): ConversationItem {
    return {
        id: conversationId,
        name: '指定会话',
        inputs: {},
        status: 'unknown',
        created_at: 0,
        updated_at: 0,
    }
}

function formatMetricRate(value: number | null, recordsAvailable: boolean) {
    if (!recordsAvailable) return '—'
    return value === null ? '暂无评价' : `${value}%`
}

function runtimeStatusLabel(status: string) {
    if (status === 'running') return '运行正常'
    if (status === 'degraded') return '部分可用'
    if (status === 'unconfigured') return '未配置'
    if (status === 'error') return '连接失败'
    return '待检测'
}

function overviewCoverageLabel(overview: AgentRuntimeOverview | null) {
    if (!overview) return '正在读取统计范围'
    if (!overview.coverage) return '统计范围未返回，当前数字仅供参考'
    if (overview.coverage.complete) return '完整快照'
    const reasons = []
    if (overview.coverage.dify_records_available === false) reasons.push('Dify 会话记录未取得')
    if (overview.coverage.knowledge_available === false) reasons.push('知识库状态未取得')
    if (overview.coverage.home_assistant_available === false) reasons.push('Home Assistant 状态未取得')
    if (overview.coverage.conversation_has_more) reasons.push('仍有会话未载入')
    if (overview.coverage.message_truncated_conversations) reasons.push(`${overview.coverage.message_truncated_conversations} 个会话仍有更早消息`)
    if (overview.coverage.message_load_error_count) reasons.push(`${overview.coverage.message_load_error_count} 个会话读取失败`)
    if (overview.coverage.token_coverage_complete === false) reasons.push(`Token 覆盖 ${overview.coverage.token_message_count || 0}/${overview.metrics.message_count || 0} 条回复`)
    return reasons.length ? `部分快照：${reasons.join('，')}` : '部分快照'
}

function runtimeServiceDiagnostic(item: AgentRuntimeOverview['services'][number]) {
    if (item.status === 'running') return item.detail
    return businessErrorMessage(item.error, {
        fallback: item.detail || `${item.name}当前不可用，请检查服务配置和运行状态`,
        service: item.name,
    })
}

function runtimeServiceStatusLabel(status: string) {
    if (status === 'running') return '运行正常'
    if (status === 'auth_error') return '认证异常'
    if (status === 'error') return '服务异常'
    if (status === 'stopped') return '当前不可用'
    if (status === 'unconfigured') return '未配置'
    return '待检测'
}

function workflowErrorDiagnostic(value?: string | null) {
    return businessErrorMessage(value, {
        fallback: '智能体工作流执行失败，请检查 Dify 应用配置和运行日志',
        service: 'Dify 工作流',
    })
}

function runtimeMetricLabel(label: string, complete: boolean) {
    return complete ? label : `已载入${label}`
}

function speechErrorMessage(error?: string) {
    if (error === 'not-allowed' || error === 'service-not-allowed') return '未获得麦克风权限，请在浏览器设置中允许后重试。'
    if (error === 'audio-capture') return '未检测到可用麦克风，请检查设备连接。'
    if (error === 'network') return '语音识别网络连接失败，可以继续使用文字输入。'
    if (error === 'no-speech') return '没有识别到语音，请靠近麦克风后重试。'
    if (error === 'aborted') return ''
    return '语音识别失败，可以继续使用文字输入。'
}

function isAbortError(error: unknown) {
    return error instanceof DOMException && error.name === 'AbortError'
}

function replaceConversationUrl(conversationId: string) {
    const url = new URL(window.location.href)
    if (conversationId) url.searchParams.set('conversation', conversationId)
    else url.searchParams.delete('conversation')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
}

function FeedbackDialog({
    target,
    rating,
    note,
    submitting,
    onRatingChange,
    onNoteChange,
    onClose,
    onCancelSubmit,
    onSubmit,
}: {
    target: ChatMessage
    rating: 'like' | 'dislike'
    note: string
    submitting: boolean
    onRatingChange: (value: 'like' | 'dislike') => void
    onNoteChange: (value: string) => void
    onClose: () => void
    onCancelSubmit: () => void
    onSubmit: () => void
}) {
    const noteTooLong = note.length > CHAT_FEEDBACK_MAX_LENGTH

    return (
        <AppDialog
            title="效果评估"
            description="对当前智能体回复进行好评、差评和备注记录。"
            onClose={submitting ? () => undefined : onClose}
            closeOnOverlay={!submitting}
            showClose={!submitting}
            maxWidth="max-w-lg"
            footer={(
                <div className="flex justify-end gap-3">
                    <button onClick={submitting ? onCancelSubmit : onClose} className="rounded-[8px] px-5 py-2.5 text-sm font-semibold text-[var(--on-surface-variant)] transition hover:bg-[var(--surface-container-low)]">
                        {submitting ? '取消等待' : '取消'}
                    </button>
                    <button
                        onClick={onSubmit}
                        disabled={submitting || noteTooLong}
                        title={noteTooLong ? `评价说明不能超过 ${CHAT_FEEDBACK_MAX_LENGTH.toLocaleString('zh-CN')} 个字符` : '提交评估'}
                        className="inline-flex items-center gap-2 rounded-[8px] bg-[var(--primary)] px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
                    >
                        {submitting && <Loader2 size={16} className="animate-spin" />}
                        提交评估
                    </button>
                </div>
            )}
        >
            <div className="space-y-4">
                <div className="mb-4 rounded-[8px] border border-[var(--outline-variant)]/10 bg-[var(--surface-container-lowest)] px-4 py-3">
                    <p className="line-clamp-4 text-sm leading-6 text-[var(--on-surface)]/85">{target.text || '当前回复内容为空'}</p>
                </div>

                <div className="mb-4 grid grid-cols-2 gap-3">
                    <button
                        type="button"
                        onClick={() => onRatingChange('like')}
                        disabled={submitting}
                        className={`flex items-center justify-center gap-2 rounded-[8px] px-4 py-3 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${rating === 'like' ? 'bg-emerald-500 text-white' : 'bg-[var(--surface-container-low)] text-[var(--on-surface)] hover:bg-[var(--surface-container)]'}`}
                    >
                        <ThumbsUp size={16} />
                        好评
                    </button>
                    <button
                        type="button"
                        onClick={() => onRatingChange('dislike')}
                        disabled={submitting}
                        className={`flex items-center justify-center gap-2 rounded-[8px] px-4 py-3 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${rating === 'dislike' ? 'bg-rose-500 text-white' : 'bg-[var(--surface-container-low)] text-[var(--on-surface)] hover:bg-[var(--surface-container)]'}`}
                    >
                        <ThumbsDown size={16} />
                        待改进
                    </button>
                </div>

                <textarea
                    aria-label="补充回复评价说明"
                    aria-invalid={noteTooLong}
                    aria-describedby="chat-feedback-note-hint"
                    value={note}
                    onChange={(e) => onNoteChange(e.target.value)}
                    disabled={submitting}
                    placeholder="可选：补充调试结论、效果问题或优化建议"
                    className="min-h-[120px] w-full rounded-[8px] border border-[var(--outline-variant)]/10 bg-[var(--surface-container-lowest)] px-4 py-3 text-sm leading-6 text-[var(--on-surface)] outline-none transition focus:border-[var(--primary)]/30 focus:ring-2 focus:ring-[var(--primary)]/10 disabled:cursor-not-allowed disabled:opacity-60"
                />
                <div id="chat-feedback-note-hint" className={`flex items-start justify-between gap-3 text-xs leading-5 ${noteTooLong ? 'font-semibold text-rose-600' : 'text-[var(--on-surface-variant)]/65'}`}>
                    <span>{noteTooLong ? `评价说明超出 ${CHAT_FEEDBACK_MAX_LENGTH.toLocaleString('zh-CN')} 字符限制，请删减后提交。` : '选填，仅记录效果问题和优化建议。'}</span>
                    <span className="shrink-0 tabular-nums">{note.length.toLocaleString('zh-CN')} / {CHAT_FEEDBACK_MAX_LENGTH.toLocaleString('zh-CN')}</span>
                </div>
            </div>
        </AppDialog>
    )
}

function DebugDrawer({
    target,
    detail,
    loading,
    error,
    difyConsoleUrl,
    onClose,
    onRetry,
}: {
    target: ChatMessage
    detail: WorkflowRunDetail | null
    loading: boolean
    error: string
    difyConsoleUrl: string
    onClose: () => void
    onRetry: () => void
}) {
    const isLocalExecution = Boolean(target.executionSource?.startsWith('local_') || target.messageId?.startsWith('local-control-'))
    const usage = messageUsageSummary(target.usage)
    const hasUsage = usage.promptTokens !== null || usage.completionTokens !== null || usage.totalTokens !== null || usage.totalPrice !== null || detail?.total_tokens !== undefined
    const hasWorkflowEvidence = Boolean(target.workflowRunId || detail)
    const technicalRows = [
        { label: '会话 ID', value: target.conversationId || '—' },
        { label: '消息 ID', value: target.messageId || '—' },
        { label: '工作流运行 ID', value: target.workflowRunId || '—' },
        { label: '任务 ID', value: target.taskId || '—' },
        { label: '设备 ID', value: target.deviceId || '—' },
        { label: 'HA 实体 ID', value: target.entityId || '—' },
        { label: '原始设备动作', value: target.action || '—' },
    ]
    const businessRows = [
        { label: '执行来源', value: messageSourceLabel(target) },
        { label: '创建时间', value: formatDetailTime(target.createdAt) },
        { label: isLocalExecution ? '运行状态' : hasWorkflowEvidence ? '工作流状态' : '消息状态', value: isLocalExecution ? target.executionSuccess === false ? '执行失败' : target.executionConfirmation === 'physical_pending' ? '已受理，待实机确认' : '执行完成' : hasWorkflowEvidence ? workflowStatusLabel(detail?.status) : target.streamStatus === 'error' ? '回复失败' : target.streamStatus === 'stopped' ? '回复已停止' : target.text ? '回复已完成' : '未取得有效回复' },
        ...(isLocalExecution ? [
            { label: '执行确认', value: target.executionConfirmation === 'physical_pending' ? 'HA 已接受，待实机确认' : target.executionConfirmation === 'confirmed' ? '状态回读已确认' : '未返回确认状态' },
            { label: '设备动作', value: deviceActionLabel(target.action) },
        ] : []),
        ...(!isLocalExecution && hasWorkflowEvidence ? [
            { label: '总步骤数', value: detail?.total_steps ?? '未返回' },
            { label: '耗时', value: detail?.elapsed_time === undefined ? '未返回' : formatElapsedSeconds(detail.elapsed_time) },
        ] : []),
        ...(!isLocalExecution && hasUsage ? [
            { label: '输入 Token', value: usage.promptTokens ?? '未返回' },
            { label: '输出 Token', value: usage.completionTokens ?? '未返回' },
            { label: '总 Token', value: usage.totalTokens ?? detail?.total_tokens ?? '未返回' },
            { label: '调用费用', value: usage.totalPrice === null ? '未返回' : `${usage.totalPrice}${usage.currency ? ` ${usage.currency}` : ''}` },
        ] : !isLocalExecution ? [
            { label: 'Token 与费用', value: 'Dify 未返回消息级使用量' },
        ] : []),
    ]

    return (
        <AppDrawer
            title="运行记录与调试"
            description={isLocalExecution ? '查看平台设备操作结果、状态确认和技术标识。' : '查看当前回复的执行结果、工作流详情和技术标识，并可联动 Dify 控制台继续调试。'}
            onClose={onClose}
            widthClassName="max-w-xl"
            bodyClassName="p-5 sm:p-7"
        >
                <div className="mb-6 rounded-[8px] border border-[var(--outline-variant)]/10 bg-[var(--surface-container-lowest)] p-5">
                    <p className="mb-3 text-xs font-bold text-[var(--on-surface-variant)]/70">当前回复</p>
                    <div className="max-h-48 overflow-y-auto text-sm leading-7 text-[var(--on-surface)]/85">
                        {target.text ? <ChatMarkdownRenderer content={target.text} /> : <p>暂无回复内容</p>}
                    </div>
                </div>

                <div className="overflow-hidden rounded-[8px] border border-[var(--outline-variant)]/15 divide-y divide-[var(--outline-variant)]/10">
                    {businessRows.map((row) => (
                        <div key={row.label} className="grid grid-cols-1 gap-1.5 px-4 py-3 text-sm sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-4">
                            <span className="text-[var(--on-surface-variant)]/65">{row.label}</span>
                            <span className="min-w-0 break-words font-semibold text-[var(--on-surface)] sm:text-right">{String(row.value)}</span>
                        </div>
                    ))}
                </div>

                <details className="mt-5 rounded-[8px] border border-[var(--outline-variant)]/15 p-4">
                    <summary className="cursor-pointer text-sm font-semibold text-[var(--on-surface-variant)]">技术标识</summary>
                    <div className="mt-4 space-y-3">
                        {technicalRows.map((row) => <TechnicalId key={row.label} label={row.label} value={String(row.value === '—' ? '' : row.value)} compact />)}
                    </div>
                </details>

                {!isLocalExecution ? <div className="mt-6 rounded-[8px] border border-[var(--outline-variant)]/10 bg-[var(--surface-container-lowest)] p-5">
                    <div className="mb-4 flex items-center justify-between">
                        <p className="text-xs font-bold text-[var(--on-surface-variant)]/60">工作流详情</p>
                        {loading && <Loader2 size={16} className="animate-spin text-[var(--primary)]" />}
                    </div>
                    {error ? (
                        <div className="border-l-2 border-amber-400 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800">
                            <p>{error}</p>
                            <button type="button" onClick={onRetry} disabled={loading} className="mt-2 font-bold text-amber-900 hover:underline disabled:opacity-50">
                                重新读取工作流详情
                            </button>
                        </div>
                    ) : target.workflowRunId ? (
                        detail ? (
                            <div className="space-y-4 text-sm text-[var(--on-surface)]/85">
                                {detail.error && (
                                    <div className="rounded-[8px] bg-rose-50 px-4 py-3 text-rose-600">
                                        <p>{workflowErrorDiagnostic(detail.error)}</p>
                                        <details className="mt-2 text-xs font-semibold">
                                            <summary className="cursor-pointer">查看技术错误</summary>
                                            <TechnicalId value={detail.error} label="Dify 原始错误" className="mt-2" />
                                        </details>
                                    </div>
                                )}
                                <details className="rounded-[8px] border border-[var(--outline-variant)]/15 bg-white p-4">
                                    <summary className="cursor-pointer text-xs font-bold text-[var(--on-surface-variant)]">查看原始工作流输入与输出</summary>
                                    <div className="mt-4 space-y-4">
                                        <div>
                                            <p className="mb-2 text-xs font-bold text-[var(--on-surface-variant)]/60">输入</p>
                                            <pre className="max-h-48 overflow-auto rounded-[8px] bg-slate-950 px-4 py-3 text-xs leading-6 text-slate-200">{JSON.stringify(detail.inputs ?? {}, null, 2)}</pre>
                                        </div>
                                        <div>
                                            <p className="mb-2 text-xs font-bold text-[var(--on-surface-variant)]/60">输出</p>
                                            <pre className="max-h-48 overflow-auto rounded-[8px] bg-slate-950 px-4 py-3 text-xs leading-6 text-slate-200">{JSON.stringify(detail.outputs ?? {}, null, 2)}</pre>
                                        </div>
                                    </div>
                                </details>
                            </div>
                        ) : (
                            <p className="text-sm leading-7 text-[var(--on-surface-variant)]/80">当前尚未获取到工作流详情，请稍后重试。</p>
                        )
                    ) : (
                        <p className="text-sm leading-7 text-[var(--on-surface-variant)]/80">该回复没有工作流运行记录，当前只能查看消息级证据；节点级详情请前往 Dify 控制台核对。</p>
                    )}
                </div> : null}

                {!!target.retrieverResources?.length && (
                    <div className="mt-6 rounded-[8px] border border-[var(--outline-variant)]/10 bg-[var(--surface-container-lowest)] p-5">
                        <div className="mb-3 flex items-center justify-between gap-3">
                            <p className="text-xs font-bold text-[var(--on-surface-variant)]/65">知识检索证据</p>
                            <span className="shrink-0 text-xs font-semibold text-[var(--on-surface-variant)]/60">{target.retrieverResources.length} 个片段</span>
                        </div>
                        <div className="divide-y divide-[var(--outline-variant)]/10 border-y border-[var(--outline-variant)]/10">
                            {target.retrieverResources.map((resource, index) => {
                                const summary = retrievalResourceSummary(resource, index)
                                return (
                                    <article key={`${summary.title}-${index}`} className="py-4">
                                        <div className="flex flex-col items-start gap-2 sm:flex-row sm:justify-between sm:gap-4">
                                            <div className="min-w-0">
                                                <p className="break-words text-sm font-bold text-[var(--on-surface)]">{summary.title}</p>
                                                {summary.datasetName ? <p className="mt-1 text-xs text-[var(--on-surface-variant)]/65">知识库：{summary.datasetName}</p> : null}
                                            </div>
                                            <span className="shrink-0 text-xs font-semibold text-[var(--primary)]">{formatRetrievalScore(summary.score)}</span>
                                        </div>
                                        <p className="mt-3 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-[6px] bg-white px-3 py-2.5 text-xs leading-6 text-slate-700">{summary.content}</p>
                                    </article>
                                )
                            })}
                        </div>
                        <details className="mt-4">
                            <summary className="cursor-pointer text-xs font-semibold text-[var(--on-surface-variant)]">查看原始检索数据</summary>
                            <pre className="mt-3 max-h-64 overflow-auto rounded-[8px] bg-slate-950 px-4 py-3 text-xs leading-6 text-slate-200">{JSON.stringify(target.retrieverResources, null, 2)}</pre>
                        </details>
                    </div>
                )}

                <div className="mt-6 flex justify-end gap-3">
                    <button onClick={onClose} className="rounded-[8px] px-5 py-2.5 text-sm font-semibold text-[var(--on-surface-variant)] transition hover:bg-[var(--surface-container-low)]">
                        关闭
                    </button>
                    {isLocalExecution ? (
                        <a
                            href="/activity-logs"
                            className="inline-flex items-center gap-2 rounded-[8px] bg-[var(--primary)] px-5 py-2.5 text-sm font-semibold text-white"
                        >
                            查看平台活动日志
                            <ExternalLink size={14} />
                        </a>
                    ) : difyConsoleUrl ? (
                        <a
                            href={difyConsoleUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-2 rounded-[8px] bg-[var(--primary)] px-5 py-2.5 text-sm font-semibold text-white"
                        >
                            前往 Dify 调试
                            <ExternalLink size={14} />
                        </a>
                    ) : null}
                </div>
        </AppDrawer>
    )
}

export default function ChatPage() {
    const [messages, setMessages] = useState<ChatMessage[]>([])
    const [inputText, setInputText] = useState(() => readChatDraft(''))
    const [hasAnimated, setHasAnimated] = useState(true)
    const [conversationId, setConversationId] = useState('')
    const [requestedConversationId, setRequestedConversationId] = useState('')
    const [isSending, setIsSending] = useState(false)
    const [checkingConnection, setCheckingConnection] = useState(false)
    // 避免 SSR 与客户端 navigator.onLine 不一致；真实可达性由同源读取和健康探测校正。
    const [isOnline, setIsOnline] = useState(true)
    const [sidebarOpen, setSidebarOpen] = useState(false)
    const [sidebarModal, setSidebarModal] = useState(false)
    const [conversations, setConversations] = useState<ConversationItem[]>([])
    const [conversationLoading, setConversationLoading] = useState(true)
    const [conversationsLoaded, setConversationsLoaded] = useState(false)
    const [conversationHasMore, setConversationHasMore] = useState(false)
    const [conversationError, setConversationError] = useState('')
    const [conversationMoreError, setConversationMoreError] = useState('')
    const [conversationSnapshotAt, setConversationSnapshotAt] = useState('')
    const [loadingMoreConversations, setLoadingMoreConversations] = useState(false)
    const [deletingConversationId, setDeletingConversationId] = useState('')
    const [deleteConversationTarget, setDeleteConversationTarget] = useState<ConversationItem | null>(null)
    const [loadingHistory, setLoadingHistory] = useState(false)
    const [loadingConversationId, setLoadingConversationId] = useState('')
    const [historyLoadedConversationId, setHistoryLoadedConversationId] = useState('')
    const [historyError, setHistoryError] = useState('')
    const [historyHasMore, setHistoryHasMore] = useState(false)
    const [loadingMoreHistory, setLoadingMoreHistory] = useState(false)
    const [statusNotice, setStatusNotice] = useState<{ id: number; message: string; tone: ChatNoticeTone }>({ id: 0, message: '', tone: 'info' })
    const [feedbackTarget, setFeedbackTarget] = useState<ChatMessage | null>(null)
    const [feedbackRating, setFeedbackRating] = useState<'like' | 'dislike'>('like')
    const [feedbackNote, setFeedbackNote] = useState('')
    const [submittingFeedback, setSubmittingFeedback] = useState(false)
    const [debugTarget, setDebugTarget] = useState<ChatMessage | null>(null)
    const [workflowDetail, setWorkflowDetail] = useState<WorkflowRunDetail | null>(null)
    const [loadingWorkflow, setLoadingWorkflow] = useState(false)
    const [workflowError, setWorkflowError] = useState('')
    const [runtimeOverview, setRuntimeOverview] = useState<AgentRuntimeOverview | null>(null)
    const [statusLoading, setStatusLoading] = useState(true)
    const [statusError, setStatusError] = useState('')
    const [mobileStatusOpen, setMobileStatusOpen] = useState(false)
    const [copiedMessageId, setCopiedMessageId] = useState('')
    const [copyFailedMessageId, setCopyFailedMessageId] = useState('')
    const [retryTarget, setRetryTarget] = useState<ChatRetryTarget | null>(null)
    const [quickPromptTarget, setQuickPromptTarget] = useState('')
    const [followingLatest, setFollowingLatest] = useState(true)
    const chatContainerRef = useRef<HTMLDivElement>(null)
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const conversationSidebarRef = useRef<HTMLElement>(null)
    const abortRef = useRef<AbortController | null>(null)
    const activeMessageIdRef = useRef('')
    const currentTaskIdRef = useRef('')
    const sendingRef = useRef(false)
    const streamGenerationRef = useRef(0)
    const conversationListRequestRef = useRef(0)
    const conversationMoreRequestRef = useRef(0)
    const historyRequestRef = useRef(0)
    const historyMoreRequestRef = useRef(0)
    const workflowRequestRef = useRef(0)
    const feedbackRequestRef = useRef(0)
    const statusRequestRef = useRef(0)
    const deleteRequestRef = useRef(0)
    const conversationListAbortRef = useRef<AbortController | null>(null)
    const conversationMoreAbortRef = useRef<AbortController | null>(null)
    const historyAbortRef = useRef<AbortController | null>(null)
    const historyMoreAbortRef = useRef<AbortController | null>(null)
    const workflowAbortRef = useRef<AbortController | null>(null)
    const feedbackAbortRef = useRef<AbortController | null>(null)
    const stopAbortRef = useRef<AbortController | null>(null)
    const statusAbortRef = useRef<AbortController | null>(null)
    const connectionCheckAbortRef = useRef<AbortController | null>(null)
    const connectionCheckBusyRef = useRef(false)
    const networkStatusAbortRef = useRef<AbortController | null>(null)
    const statusUpdatedAtRef = useRef(0)
    const deleteAbortRef = useRef<AbortController | null>(null)
    const deleteCancelRef = useRef<HTMLButtonElement | null>(null)
    const retryCancelRef = useRef<HTMLButtonElement | null>(null)
    const quickPromptCancelRef = useRef<HTMLButtonElement | null>(null)
    const debugTriggerRef = useRef<HTMLButtonElement | null>(null)
    const conversationMoreBusyRef = useRef(false)
    const conversationListBusyRef = useRef(false)
    const conversationRefreshQueuedRef = useRef(false)
    const conversationSnapshotBootstrappedRef = useRef(false)
    const conversationReloadRef = useRef<(force?: boolean) => void>(() => undefined)
    const historyMoreBusyRef = useRef(false)
    const feedbackBusyRef = useRef(false)
    const statusBusyRef = useRef(false)
    const statusRefreshQueuedRef = useRef(false)
    const statusReloadRef = useRef<(refresh?: boolean) => void>(() => undefined)
    const deleteBusyRef = useRef(false)
    const deleteReconcileRef = useRef(0)
    const deleteReconcileTimerRef = useRef<number | null>(null)
    const feedbackReconcileRef = useRef(0)
    const feedbackReconcileTimerRef = useRef<number | null>(null)
    const copyFeedbackTimerRef = useRef<number | null>(null)
    const copyRequestRef = useRef(0)
    const historyScrollRef = useRef<{ height: number; top: number } | null>(null)
    const historyTargetRef = useRef('')
    const historyReloadRef = useRef<(conversation: ConversationItem) => void>(() => undefined)
    const currentConversationIdRef = useRef(conversationId)
    currentConversationIdRef.current = conversationId
    /* ── 语音识别 (Web Speech API) ── */
    const [isListening, setIsListening] = useState(false)
    const recognitionRef = useRef<BrowserSpeechRecognition | null>(null)

    const setStatusMessage = useCallback((message: string, tone: ChatNoticeTone = 'info') => {
        setStatusNotice(previous => ({ id: previous.id + 1, message, tone }))
    }, [])
    const dismissStatusNotice = useCallback((noticeId: number) => {
        setStatusNotice(previous => previous.id === noticeId ? { ...previous, message: '' } : previous)
    }, [])
    const statusMessage = statusNotice.message

    const markPlatformReachable = useCallback(() => {
        setIsOnline(true)
    }, [])

    useEffect(() => {
        const media = window.matchMedia('(max-width: 1279px)')
        const update = () => setSidebarModal(media.matches)
        update()
        media.addEventListener('change', update)
        return () => media.removeEventListener('change', update)
    }, [])

    useEffect(() => {
        setRequestedConversationId(new URL(window.location.href).searchParams.get('conversation') || '')
        setInputText(readChatDraft(''))
    }, [])

    useDialogLock(sidebarOpen && sidebarModal)
    useDialogFocusTrap(sidebarOpen && sidebarModal, conversationSidebarRef, () => setSidebarOpen(false))

    // 初始化 SpeechRecognition
    useEffect(() => {
        const speechWindow = window as SpeechWindow
        const SpeechRecognition = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition
        if (!SpeechRecognition) return

        const recognition = new SpeechRecognition()
        recognition.lang = 'zh-CN'
        recognition.continuous = true
        recognition.interimResults = true

        recognition.onresult = (event) => {
            let finalTranscript = ''
            for (let i = event.resultIndex; i < event.results.length; i++) {
                const transcript = event.results[i][0].transcript
                if (event.results[i].isFinal) {
                    finalTranscript += transcript
                }
            }
            if (finalTranscript) {
                setInputText(prev => prev + finalTranscript)
            }
        }

        recognition.onerror = (event) => {
            setIsListening(false)
            const message = speechErrorMessage(event.error)
            if (message) setStatusMessage(message, 'warning')
        }

        recognition.onend = () => {
            setIsListening(false)
        }

        recognitionRef.current = recognition

        return () => {
            recognition.abort()
        }
    }, [setStatusMessage])

    const toggleVoice = () => {
        if (conversationId && historyLoadedConversationId !== conversationId) {
            setStatusMessage('请先重新读取当前会话消息，或新建对话后再使用语音输入。', 'warning')
            return
        }
        const recognition = recognitionRef.current
        if (!recognition) {
            setStatusMessage('当前浏览器不支持语音识别，可以继续使用文字输入。', 'warning')
            return
        }
        if (isListening) {
            recognition.stop()
            setIsListening(false)
        } else {
            try {
                recognition.start()
                setIsListening(true)
                setStatusMessage('')
            } catch {
                setIsListening(false)
                setStatusMessage('语音识别暂时无法启动，请稍后重试或继续使用文字输入。', 'warning')
            }
        }
    }

    const MIN_H = 48
    const MAX_H = 160

    const autoResize = () => {
        const ta = textareaRef.current
        if (!ta) return
        ta.style.height = 'auto'
        ta.style.height = Math.min(ta.scrollHeight, MAX_H) + 'px'
        ta.style.overflowY = ta.scrollHeight > MAX_H ? 'auto' : 'hidden'
    }

    useLayoutEffect(() => {
        autoResize()
    }, [inputText])

    useEffect(() => {
        writeChatDraft(conversationId, inputText)
    }, [conversationId, inputText])

    useEffect(() => {
        const handleOffline = async () => {
            // navigator.onLine 对局域网和内置浏览器并不可靠，先用同源健康接口确认。
            networkStatusAbortRef.current?.abort()
            const controller = new AbortController()
            networkStatusAbortRef.current = controller
            setCheckingConnection(true)
            const reachable = await checkChatPlatformReachable(controller.signal)
            if (networkStatusAbortRef.current !== controller) return
            networkStatusAbortRef.current = null
            setCheckingConnection(false)
            if (reachable) {
                markPlatformReachable()
                return
            }
            setIsOnline(false)
            setStatusMessage('当前网络已断开。草稿会保留，恢复网络后请手动发送或重新执行失败回复。', 'warning')
        }
        const handleOnline = () => {
            networkStatusAbortRef.current?.abort()
            networkStatusAbortRef.current = null
            setCheckingConnection(false)
            setIsOnline(true)
            setStatusMessage('网络已恢复。为避免重复触发设备控制，页面不会自动重发消息。', 'success')
        }
        window.addEventListener('offline', handleOffline)
        window.addEventListener('online', handleOnline)
        if (navigator.onLine === false) void handleOffline()
        return () => {
            networkStatusAbortRef.current?.abort()
            networkStatusAbortRef.current = null
            window.removeEventListener('offline', handleOffline)
            window.removeEventListener('online', handleOnline)
        }
    }, [markPlatformReachable, setStatusMessage])

    const selectedHistoryUnavailable = Boolean(
        conversationId
        && !loadingHistory
        && historyLoadedConversationId !== conversationId
    )
    const selectedHistoryLoadedEmpty = Boolean(
        conversationId
        && historyLoadedConversationId === conversationId
        && messages.length === 0
    )
    const runtimeService = (key: string) => runtimeOverview?.services.find(item => item.key === key)
    const difyUnavailable = Boolean(runtimeService('dify') && runtimeService('dify')?.status !== 'running')
    const knowledgeUnavailable = Boolean(runtimeService('knowledge') && runtimeService('knowledge')?.status !== 'running')
    const homeAssistantUnavailable = Boolean(runtimeService('home_assistant') && runtimeService('home_assistant')?.status !== 'running')
    const conversationExecutionUnavailable = difyUnavailable && homeAssistantUnavailable
    const composerLocked = loadingHistory || selectedHistoryUnavailable
    const isIdle = !conversationId && messages.length === 0 && !loadingHistory
    const latestMessage = messages.at(-1)
    const canRetryLastQuestion = Boolean(
        !loadingHistory
        && !isSending
        && !conversationExecutionUnavailable
        && messages.some(message => message.role === 'user')
        && (
            latestMessage?.role === 'user'
            || (latestMessage?.role === 'ai' && (latestMessage.streamStatus === 'error' || latestMessage.streamStatus === 'stopped'))
        )
    )

    // 仅在用户仍停留于底部时跟随流式回复，向上阅读时不抢夺滚动位置。
    const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
        if (chatContainerRef.current) {
            chatContainerRef.current.scrollTo({ top: chatContainerRef.current.scrollHeight, behavior })
            setFollowingLatest(true)
        }
    }, [])

    const handleMessageScroll = () => {
        const container = chatContainerRef.current
        if (!container) return
        const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight
        setFollowingLatest(distanceToBottom <= 80)
    }

    useLayoutEffect(() => {
        const container = chatContainerRef.current
        const previous = historyScrollRef.current
        if (container && previous) {
            container.scrollTop = previous.top + container.scrollHeight - previous.height
            historyScrollRef.current = null
            return
        }
        if (followingLatest) scrollToBottom()
    }, [followingLatest, messages, scrollToBottom])

    // 加载会话列表
    const loadConversations = useCallback(async (force = false) => {
        if (conversationListBusyRef.current) {
            if (force) conversationRefreshQueuedRef.current = true
            return
        }
        conversationListBusyRef.current = true
        const requestId = ++conversationListRequestRef.current
        conversationMoreRequestRef.current += 1
        conversationMoreAbortRef.current?.abort()
        conversationMoreAbortRef.current = null
        conversationMoreBusyRef.current = false
        setLoadingMoreConversations(false)
        conversationListAbortRef.current?.abort()
        const controller = new AbortController()
        conversationListAbortRef.current = controller
        if (!conversationSnapshotBootstrappedRef.current) {
            conversationSnapshotBootstrappedRef.current = true
            const snapshot = readConversationSnapshot()
            if (snapshot) {
                setConversations(snapshot.items.map(item => ({ ...item, inputs: {} })))
                setConversationHasMore(snapshot.hasMore)
                setConversationsLoaded(true)
                setConversationSnapshotAt(snapshot.savedAt)
                writeConversationSnapshot(snapshot.items.map(item => ({ ...item, inputs: {} })), snapshot.hasMore, snapshot.savedAt)
            }
        }
        setConversationLoading(true)
        setConversationError('')
        setConversationMoreError('')
        try {
            const res = await getConversations('', 20, force, controller.signal)
            if (conversationListRequestRef.current !== requestId) return
            markPlatformReachable()
            if (res.external_service_error) {
                setConversationError(res.external_service_error)
                return
            }
            const nextConversations = res.data || []
            const nextHasMore = Boolean(res.has_more)
            setConversations(nextConversations)
            setConversationHasMore(nextHasMore)
            setConversationsLoaded(true)
            setConversationSnapshotAt(writeConversationSnapshot(nextConversations, nextHasMore))
        } catch (error) {
            if (conversationListRequestRef.current === requestId && !isAbortError(error)) setConversationError(businessErrorMessage(error, { fallback: '会话历史加载失败', service: '智能体会话' }))
        } finally {
            if (conversationListRequestRef.current === requestId) {
                conversationListBusyRef.current = false
                setConversationLoading(false)
                if (conversationListAbortRef.current === controller) conversationListAbortRef.current = null
                if (conversationRefreshQueuedRef.current) {
                    conversationRefreshQueuedRef.current = false
                    conversationReloadRef.current(true)
                }
            }
        }
    }, [markPlatformReachable])
    conversationReloadRef.current = (force = false) => { void loadConversations(force) }

    const loadMoreConversations = async () => {
        const lastId = conversations.at(-1)?.id
        if (!lastId || !conversationHasMore || conversationMoreBusyRef.current) return
        conversationMoreBusyRef.current = true
        const requestId = ++conversationMoreRequestRef.current
        const controller = new AbortController()
        conversationMoreAbortRef.current?.abort()
        conversationMoreAbortRef.current = controller
        setLoadingMoreConversations(true)
        setConversationMoreError('')
        try {
            const res = await getConversations(lastId, 20, false, controller.signal)
            if (conversationMoreRequestRef.current !== requestId) return
            markPlatformReachable()
            if (res.external_service_error) {
                setConversationMoreError(res.external_service_error)
                return
            }
            const merged = [
                ...conversations,
                ...(res.data || []).filter(item => !conversations.some(existing => existing.id === item.id)),
            ]
            const nextHasMore = Boolean(res.has_more)
            setConversations(merged)
            setConversationHasMore(nextHasMore)
            setConversationSnapshotAt(writeConversationSnapshot(merged, nextHasMore))
        } catch (error) {
            if (conversationMoreRequestRef.current === requestId && !isAbortError(error)) setConversationMoreError(businessErrorMessage(error, { fallback: '更多会话加载失败', service: '智能体会话' }))
        } finally {
            if (conversationMoreRequestRef.current === requestId) {
                conversationMoreBusyRef.current = false
                setLoadingMoreConversations(false)
                if (conversationMoreAbortRef.current === controller) conversationMoreAbortRef.current = null
            }
        }
    }

    useEffect(() => {
        loadConversations()
    }, [loadConversations])

    const loadRuntimeStatus = useCallback(async (refresh = false) => {
        if (statusBusyRef.current) {
            if (refresh) statusRefreshQueuedRef.current = true
            return
        }
        statusBusyRef.current = true
        const requestId = ++statusRequestRef.current
        const controller = new AbortController()
        statusAbortRef.current = controller
        setStatusLoading(true)
        setStatusError('')
        try {
            const overview = await getAgentRuntimeOverview(refresh, controller.signal)
            if (statusRequestRef.current === requestId) {
                markPlatformReachable()
                statusUpdatedAtRef.current = Date.now()
                setRuntimeOverview(overview)
            }
        } catch (error) {
            if (statusRequestRef.current === requestId && !isAbortError(error)) setStatusError(businessErrorMessage(error, { fallback: '智能体概览加载失败', service: '智能体运行状态' }))
        } finally {
            if (statusRequestRef.current === requestId) {
                statusBusyRef.current = false
                setStatusLoading(false)
                if (statusAbortRef.current === controller) statusAbortRef.current = null
                if (statusRefreshQueuedRef.current) {
                    statusRefreshQueuedRef.current = false
                    statusReloadRef.current(true)
                }
            }
        }
    }, [markPlatformReachable])
    statusReloadRef.current = (refresh = false) => { void loadRuntimeStatus(refresh) }

    useEffect(() => {
        loadRuntimeStatus()
    }, [loadRuntimeStatus])

    useEffect(() => {
        if (!conversationError && !statusError) return

        const retryFailedReads = () => {
            if (!navigator.onLine || document.visibilityState !== 'visible') return
            if (conversationError && !conversationListAbortRef.current) void loadConversations(true)
            if (statusError && !statusBusyRef.current) void loadRuntimeStatus(true)
        }
        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible') retryFailedReads()
        }

        window.addEventListener('online', retryFailedReads)
        document.addEventListener('visibilitychange', handleVisibilityChange)
        return () => {
            window.removeEventListener('online', retryFailedReads)
            document.removeEventListener('visibilitychange', handleVisibilityChange)
        }
    }, [conversationError, loadConversations, loadRuntimeStatus, statusError])

    useEffect(() => {
        let timer: number | null = null

        const stopRefresh = () => {
            if (timer === null) return
            window.clearInterval(timer)
            timer = null
        }
        const refreshIfStale = () => {
            if (statusBusyRef.current || Date.now() - statusUpdatedAtRef.current < 300_000) return
            void loadRuntimeStatus(false)
        }
        const startRefresh = () => {
            stopRefresh()
            if (document.hidden) return
            refreshIfStale()
            timer = window.setInterval(refreshIfStale, 300_000)
        }
        const handleVisibilityChange = () => {
            if (document.hidden) stopRefresh()
            else startRefresh()
        }

        const initialTimer = window.setTimeout(startRefresh, 0)
        document.addEventListener('visibilitychange', handleVisibilityChange)
        return () => {
            window.clearTimeout(initialTimer)
            stopRefresh()
            document.removeEventListener('visibilitychange', handleVisibilityChange)
        }
    }, [loadRuntimeStatus])

    useEffect(() => () => {
        conversationListRequestRef.current += 1
        conversationMoreRequestRef.current += 1
        historyRequestRef.current += 1
        historyMoreRequestRef.current += 1
        workflowRequestRef.current += 1
        feedbackRequestRef.current += 1
        statusRequestRef.current += 1
        deleteRequestRef.current += 1
        deleteReconcileRef.current += 1
        feedbackReconcileRef.current += 1
        copyRequestRef.current += 1
        streamGenerationRef.current += 1
        sendingRef.current = false
        currentTaskIdRef.current = ''
        abortRef.current?.abort()
        conversationListAbortRef.current?.abort()
        conversationMoreAbortRef.current?.abort()
        historyAbortRef.current?.abort()
        historyMoreAbortRef.current?.abort()
        workflowAbortRef.current?.abort()
        feedbackAbortRef.current?.abort()
        stopAbortRef.current?.abort()
        statusAbortRef.current?.abort()
        connectionCheckAbortRef.current?.abort()
        connectionCheckBusyRef.current = false
        networkStatusAbortRef.current?.abort()
        networkStatusAbortRef.current = null
        deleteAbortRef.current?.abort()
        if (deleteReconcileTimerRef.current !== null) window.clearTimeout(deleteReconcileTimerRef.current)
        deleteReconcileTimerRef.current = null
        if (feedbackReconcileTimerRef.current !== null) window.clearTimeout(feedbackReconcileTimerRef.current)
        feedbackReconcileTimerRef.current = null
        if (copyFeedbackTimerRef.current !== null) window.clearTimeout(copyFeedbackTimerRef.current)
        copyFeedbackTimerRef.current = null
        conversationMoreBusyRef.current = false
        conversationListBusyRef.current = false
        conversationRefreshQueuedRef.current = false
        conversationReloadRef.current = () => undefined
        historyMoreBusyRef.current = false
        feedbackBusyRef.current = false
        statusBusyRef.current = false
        setCheckingConnection(false)
        statusRefreshQueuedRef.current = false
        statusReloadRef.current = () => undefined
        deleteBusyRef.current = false
    }, [])

    // 切换到已有会话
    const switchConversation = async (conv: ConversationItem) => {
        if (historyTargetRef.current === conv.id) return
        if (conv.id === conversationId && !loadingHistory && historyLoadedConversationId === conv.id) return
        workflowRequestRef.current += 1
        workflowAbortRef.current?.abort()
        workflowAbortRef.current = null
        debugTriggerRef.current = null
        setDebugTarget(null)
        setWorkflowDetail(null)
        setWorkflowError('')
        setLoadingWorkflow(false)
        if (!feedbackBusyRef.current) {
            setFeedbackTarget(null)
            setFeedbackNote('')
        }
        historyTargetRef.current = conv.id
        const requestId = ++historyRequestRef.current
        historyMoreRequestRef.current += 1
        historyAbortRef.current?.abort()
        historyMoreAbortRef.current?.abort()
        historyMoreBusyRef.current = false
        const historyController = new AbortController()
        historyAbortRef.current = historyController
        streamGenerationRef.current += 1
        sendingRef.current = false
        const taskId = currentTaskIdRef.current
        abortRef.current?.abort()
        abortRef.current = null
        activeMessageIdRef.current = ''
        currentTaskIdRef.current = ''
        setIsSending(false)
        if (taskId) void stopChatStream(taskId).catch(() => undefined)
        currentConversationIdRef.current = conv.id
        setInputText(readChatDraft(conv.id))
        setFollowingLatest(true)
        setConversationId(conv.id)
        replaceConversationUrl(conv.id)
        setMessages([])
        setHistoryLoadedConversationId('')
        setHistoryError('')
        setHistoryHasMore(false)
        setLoadingMoreHistory(false)
        historyScrollRef.current = null
        setLoadingHistory(true)
        setLoadingConversationId(conv.id)
        setStatusMessage('')
        setRetryTarget(null)
        recognitionRef.current?.abort()
        setIsListening(false)
        try {
            const res = await getMessages(conv.id, '', 20, false, historyController.signal)
            if (historyRequestRef.current !== requestId) return
            markPlatformReachable()
            setMessages(historyMessages(res.data || [], conv.id))
            setHistoryLoadedConversationId(conv.id)
            setHistoryHasMore(Boolean(res.has_more))
            setHasAnimated(false)
            setStatusMessage('')
        } catch (error) {
            if (historyRequestRef.current === requestId && !isAbortError(error)) {
                setHistoryError(businessErrorMessage(error, { fallback: '会话消息加载失败', service: '智能体会话' }))
            }
        } finally {
            if (historyRequestRef.current === requestId) {
                setLoadingHistory(false)
                setLoadingConversationId('')
                if (historyTargetRef.current === conv.id) historyTargetRef.current = ''
                if (historyAbortRef.current === historyController) historyAbortRef.current = null
            }
        }
    }
    historyReloadRef.current = (conversation) => { void switchConversation(conversation) }

    useEffect(() => {
        if (!historyError || !conversationId || loadingHistory || historyLoadedConversationId === conversationId) return

        const recoverFailedHistory = () => {
            if (
                !navigator.onLine
                || document.visibilityState !== 'visible'
                || historyAbortRef.current
                || historyTargetRef.current === conversationId
            ) return
            const target = conversations.find(item => item.id === conversationId)
                || deepLinkedConversation(conversationId)
            historyReloadRef.current(target)
        }
        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible') recoverFailedHistory()
        }

        window.addEventListener('online', recoverFailedHistory)
        document.addEventListener('visibilitychange', handleVisibilityChange)
        return () => {
            window.removeEventListener('online', recoverFailedHistory)
            document.removeEventListener('visibilitychange', handleVisibilityChange)
        }
    }, [conversationId, conversations, historyError, historyLoadedConversationId, loadingHistory])

    const loadMoreHistory = async () => {
        const firstMessageId = messages.find(message => message.messageId)?.messageId
        if (!conversationId || !firstMessageId || !historyHasMore || historyMoreBusyRef.current) return
        historyMoreBusyRef.current = true
        setLoadingMoreHistory(true)
        const requestId = ++historyMoreRequestRef.current
        const targetConversationId = conversationId
        const controller = new AbortController()
        historyMoreAbortRef.current?.abort()
        historyMoreAbortRef.current = controller
        try {
            const res = await getMessages(targetConversationId, firstMessageId, 20, false, controller.signal)
            if (historyMoreRequestRef.current !== requestId || currentConversationIdRef.current !== targetConversationId) return
            markPlatformReachable()
            const older = historyMessages(res.data || [], targetConversationId)
            const container = chatContainerRef.current
            historyScrollRef.current = container ? { height: container.scrollHeight, top: container.scrollTop } : null
            setMessages(prev => [...older.filter(item => !prev.some(existing => existing.id === item.id)), ...prev])
            setHistoryHasMore(Boolean(res.has_more))
        } catch (error) {
            if (historyMoreRequestRef.current === requestId && !isAbortError(error)) setStatusMessage(businessErrorMessage(error, { fallback: '更早消息加载失败', service: '智能体会话' }), 'danger')
        } finally {
            if (historyMoreRequestRef.current === requestId) {
                historyMoreBusyRef.current = false
                setLoadingMoreHistory(false)
                if (historyMoreAbortRef.current === controller) historyMoreAbortRef.current = null
            }
        }
    }

    // 新建对话
    const startNewChat = () => {
        workflowRequestRef.current += 1
        workflowAbortRef.current?.abort()
        workflowAbortRef.current = null
        debugTriggerRef.current = null
        setDebugTarget(null)
        setWorkflowDetail(null)
        setWorkflowError('')
        setLoadingWorkflow(false)
        if (!feedbackBusyRef.current) {
            setFeedbackTarget(null)
            setFeedbackNote('')
        }
        historyRequestRef.current += 1
        historyMoreRequestRef.current += 1
        historyAbortRef.current?.abort()
        historyMoreAbortRef.current?.abort()
        historyMoreBusyRef.current = false
        historyTargetRef.current = ''
        streamGenerationRef.current += 1
        sendingRef.current = false
        const taskId = currentTaskIdRef.current
        abortRef.current?.abort()
        if (taskId) void stopChatStream(taskId).catch(() => undefined)
        activeMessageIdRef.current = ''
        currentTaskIdRef.current = ''
        currentConversationIdRef.current = ''
        setInputText(readChatDraft(''))
        setFollowingLatest(true)
        setMessages([])
        setHistoryLoadedConversationId('')
        setHistoryError('')
        setConversationId('')
        setRequestedConversationId('')
        replaceConversationUrl('')
        setHasAnimated(true)
        setIsSending(false)
        setStatusMessage('')
        setRetryTarget(null)
        setHistoryHasMore(false)
        setLoadingHistory(false)
        setLoadingMoreHistory(false)
        setLoadingConversationId('')
        recognitionRef.current?.abort()
        setIsListening(false)
    }

    useEffect(() => {
        if (!requestedConversationId || conversationLoading) return
        const target = conversations.find(item => item.id === requestedConversationId)
            || deepLinkedConversation(requestedConversationId)
        setConversations(previous => previous.some(item => item.id === target.id) ? previous : [target, ...previous])
        setRequestedConversationId('')
        void switchConversation(target)
    // 首次会话目录返回后只消费一次地址栏目标。目标不在首批目录时直接按 ID 读取，
    // 由消息接口判断是否存在，避免把较旧会话误判为无效链接。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [conversationLoading, conversations, requestedConversationId])

    // 删除会话
    const reconcileDeletedConversation = (targetId: string) => {
        const reconcileId = ++deleteReconcileRef.current
        if (deleteReconcileTimerRef.current !== null) window.clearTimeout(deleteReconcileTimerRef.current)
        const readFinalDirectory = async () => {
            const requestId = ++conversationListRequestRef.current
            conversationListAbortRef.current?.abort()
            conversationListAbortRef.current = null
            conversationListBusyRef.current = true
            try {
                const result = await getConversations('', Math.max(20, conversations.length), true)
                if (deleteReconcileRef.current !== reconcileId || conversationListRequestRef.current !== requestId) return
                if (result.external_service_error) {
                    setConversationError(result.external_service_error)
                    return
                }
                const nextConversations = result.data || []
                setConversations(nextConversations)
                setConversationHasMore(Boolean(result.has_more))
                setConversationsLoaded(true)
                setConversationError('')
                if (!nextConversations.some(item => item.id === targetId)) {
                    removeChatDraft(targetId)
                    if (targetId === currentConversationIdRef.current) startNewChat()
                }
            } finally {
                if (conversationListRequestRef.current === requestId) {
                    conversationListBusyRef.current = false
                    if (conversationRefreshQueuedRef.current) {
                        conversationRefreshQueuedRef.current = false
                        conversationReloadRef.current(true)
                    }
                }
            }
        }
        void readFinalDirectory().catch(error => {
            if (deleteReconcileRef.current === reconcileId && !isAbortError(error)) {
                setConversationError(businessErrorMessage(error, { fallback: '会话最终状态读取失败', service: '智能体会话' }))
            }
        }).finally(() => {
            if (deleteReconcileRef.current !== reconcileId) return
            deleteReconcileTimerRef.current = window.setTimeout(() => {
                if (deleteReconcileRef.current !== reconcileId) return
                deleteReconcileTimerRef.current = null
                void readFinalDirectory().catch(error => {
                    if (deleteReconcileRef.current === reconcileId && !isAbortError(error)) {
                        setConversationError(businessErrorMessage(error, { fallback: '会话最终状态读取失败', service: '智能体会话' }))
                    }
                })
            }, 1200)
        })
    }

    const chatMutationResultUncertain = (error: unknown) => (
        error instanceof ApiError && error.status === 0
        || error instanceof Error && /超时|网络中断|无法连接|network|timeout/i.test(error.message)
    )

    const openDeleteConversation = (e: React.MouseEvent, target: ConversationItem) => {
        e.stopPropagation()
        if (deleteBusyRef.current) return
        setDeleteConversationTarget(target)
    }

    const cancelDeleteConversationWait = () => {
        const targetId = deleteConversationTarget?.id
        if (!targetId) return
        if (!deleteBusyRef.current) {
            setDeleteConversationTarget(null)
            return
        }
        deleteRequestRef.current += 1
        deleteBusyRef.current = false
        deleteAbortRef.current?.abort()
        deleteAbortRef.current = null
        setDeletingConversationId('')
        setDeleteConversationTarget(null)
        setStatusMessage('已取消删除等待；会话可能已经删除，正在重新读取最终目录。', 'warning')
        reconcileDeletedConversation(targetId)
    }

    const confirmDeleteConversation = async () => {
        const convId = deleteConversationTarget?.id
        if (!convId || deleteBusyRef.current) return
        const requestId = ++deleteRequestRef.current
        const controller = new AbortController()
        deleteBusyRef.current = true
        deleteAbortRef.current = controller
        setDeletingConversationId(convId)
        try {
            await deleteConversation(convId, controller.signal)
            if (deleteRequestRef.current !== requestId) return
            removeChatDraft(convId)
            setConversations(prev => prev.filter(c => c.id !== convId))
            if (convId === currentConversationIdRef.current) startNewChat()
            setDeleteConversationTarget(null)
            setStatusMessage('会话已删除。', 'success')
        } catch (error) {
            if (controller.signal.aborted || deleteRequestRef.current !== requestId) return
            if (chatMutationResultUncertain(error)) {
                setDeleteConversationTarget(null)
                setStatusMessage('删除请求超时或网络中断，会话可能已经删除；请勿重复操作，正在重新读取最终目录。', 'warning')
                reconcileDeletedConversation(convId)
                return
            }
            setStatusMessage(businessErrorMessage(error, { fallback: '会话删除失败', service: '智能体会话' }), 'danger')
        } finally {
            if (deleteAbortRef.current === controller) {
                deleteAbortRef.current = null
                deleteBusyRef.current = false
            }
            if (deleteRequestRef.current === requestId) setDeletingConversationId('')
        }
    }

    const copyMessage = async (message: ChatMessage) => {
        if (!message.text) return
        const requestId = ++copyRequestRef.current
        const success = await copyTextToClipboard(message.text)
        if (copyRequestRef.current !== requestId) return
        setCopiedMessageId(success ? message.id : '')
        setCopyFailedMessageId(success ? '' : message.id)
        if (copyFeedbackTimerRef.current !== null) window.clearTimeout(copyFeedbackTimerRef.current)
        copyFeedbackTimerRef.current = window.setTimeout(() => {
            setCopiedMessageId('')
            setCopyFailedMessageId('')
        }, 1600)
    }

    const openFeedbackDialog = (msg: ChatMessage) => {
        if (!messageSupportsFeedback(msg)) {
            setStatusMessage(messageFeedbackUnavailableReason(msg), 'warning')
            return
        }
        setFeedbackTarget(msg)
        setFeedbackRating(msg.feedback?.rating === 'dislike' ? 'dislike' : 'like')
        setFeedbackNote(msg.feedback?.content || '')
    }

    const loadWorkflowDetail = async (msg: ChatMessage, force = false) => {
        const requestId = ++workflowRequestRef.current
        workflowAbortRef.current?.abort()
        const controller = new AbortController()
        workflowAbortRef.current = controller
        setDebugTarget(msg)
        setWorkflowDetail(null)
        setWorkflowError('')
        setLoadingWorkflow(Boolean(msg.workflowRunId))
        if (!msg.workflowRunId) {
            workflowAbortRef.current = null
            return
        }
        try {
            const detail = await getWorkflowRunDetail(msg.workflowRunId, controller.signal, force)
            if (workflowRequestRef.current === requestId) setWorkflowDetail(detail)
        } catch (error) {
            if (workflowRequestRef.current === requestId && !isAbortError(error)) {
                setWorkflowError(businessErrorMessage(error, { fallback: '工作流详情读取失败', service: 'Dify 工作流' }))
            }
        } finally {
            if (workflowRequestRef.current === requestId) {
                setLoadingWorkflow(false)
                if (workflowAbortRef.current === controller) workflowAbortRef.current = null
            }
        }
    }

    const closeDebugDrawer = () => {
        workflowRequestRef.current += 1
        workflowAbortRef.current?.abort()
        workflowAbortRef.current = null
        setLoadingWorkflow(false)
        setWorkflowError('')
        setDebugTarget(null)
        window.requestAnimationFrame(() => debugTriggerRef.current?.focus())
    }

    const openDebugDrawer = (msg: ChatMessage, trigger: HTMLButtonElement) => {
        debugTriggerRef.current = trigger
        void loadWorkflowDetail(msg)
    }

    const reconcileMessageFeedback = (target: ChatMessage) => {
        if (!target.messageId || !target.conversationId) return
        const reconcileId = ++feedbackReconcileRef.current
        if (feedbackReconcileTimerRef.current !== null) window.clearTimeout(feedbackReconcileTimerRef.current)
        const loadedMessageCount = Math.max(20, messages.filter(message => message.role === 'ai').length)
        const readFinalFeedback = async () => {
            let cursor = ''
            let remaining = loadedMessageCount
            let finalMessage: HistoryMessage | undefined
            while (remaining > 0 && !finalMessage) {
                const limit = Math.min(100, Math.max(20, remaining))
                const result = await getMessages(target.conversationId || '', cursor, limit, true)
                if (feedbackReconcileRef.current !== reconcileId) return
                finalMessage = result.data.find(item => item.id === target.messageId)
                const oldestId = result.data.at(-1)?.id || ''
                if (finalMessage || !result.has_more || !oldestId || oldestId === cursor) break
                cursor = oldestId
                remaining -= result.data.length
            }
            if (!finalMessage) return
            setMessages(previous => previous.map(message => message.id === target.id
                ? { ...message, feedback: normalizeFeedback(finalMessage.feedback) }
                : message))
        }
        void readFinalFeedback().catch(error => {
            if (feedbackReconcileRef.current === reconcileId && !isAbortError(error)) {
                setStatusMessage(businessErrorMessage(error, { fallback: '评价最终状态读取失败', service: '智能体评价' }), 'danger')
            }
        }).finally(() => {
            if (feedbackReconcileRef.current !== reconcileId) return
            feedbackReconcileTimerRef.current = window.setTimeout(() => {
                if (feedbackReconcileRef.current !== reconcileId) return
                feedbackReconcileTimerRef.current = null
                void readFinalFeedback().catch(error => {
                    if (feedbackReconcileRef.current === reconcileId && !isAbortError(error)) {
                        setStatusMessage(businessErrorMessage(error, { fallback: '评价最终状态读取失败', service: '智能体评价' }), 'danger')
                    }
                })
            }, 1200)
        })
        void loadRuntimeStatus(true)
    }

    const submitFeedback = async () => {
        if (!feedbackTarget?.messageId || feedbackBusyRef.current) return
        if (
            feedbackTarget.conversationId !== currentConversationIdRef.current
            || !messages.some(message => message.id === feedbackTarget.id && messageSupportsFeedback(message))
        ) {
            setFeedbackTarget(null)
            setStatusMessage('当前会话或回复状态已经变化，本次评价未提交；请在当前回复上重新操作。', 'warning')
            return
        }
        if (feedbackNote.length > CHAT_FEEDBACK_MAX_LENGTH) {
            setStatusMessage(`评价说明不能超过 ${CHAT_FEEDBACK_MAX_LENGTH.toLocaleString('zh-CN')} 个字符，请删减后提交。`, 'warning')
            return
        }
        feedbackBusyRef.current = true
        const target = feedbackTarget
        const messageId = feedbackTarget.messageId
        const rating = feedbackRating
        const note = feedbackNote
        const requestId = ++feedbackRequestRef.current
        const controller = new AbortController()
        feedbackAbortRef.current = controller
        setSubmittingFeedback(true)
        try {
            await submitMessageFeedback(messageId, rating, note, controller.signal)
            if (feedbackRequestRef.current !== requestId) return
            setMessages(prev => prev.map(msg => (
                msg.id === target.id
                    ? { ...msg, feedback: { rating, content: note } }
                    : msg
            )))
            setStatusMessage('效果评估已提交，可在会话与运行记录中追踪。', 'success')
            setFeedbackTarget(null)
            setFeedbackNote('')
            void loadRuntimeStatus(true)
        } catch (error) {
            if (feedbackRequestRef.current !== requestId || isAbortError(error)) return
            if (chatMutationResultUncertain(error)) {
                setFeedbackTarget(null)
                setStatusMessage('评价提交结果暂时无法确认，正在重新读取当前消息，请勿立即重复提交。', 'warning')
                reconcileMessageFeedback(target)
                return
            }
            setStatusMessage(businessErrorMessage(error, { fallback: '效果评估提交失败', service: '智能体评价' }), 'danger')
        } finally {
            if (feedbackRequestRef.current === requestId) {
                feedbackBusyRef.current = false
                setSubmittingFeedback(false)
                if (feedbackAbortRef.current === controller) feedbackAbortRef.current = null
            }
        }
    }

    const cancelFeedbackWait = () => {
        if (!feedbackBusyRef.current) return
        const target = feedbackTarget
        feedbackRequestRef.current += 1
        feedbackBusyRef.current = false
        feedbackAbortRef.current?.abort()
        feedbackAbortRef.current = null
        setSubmittingFeedback(false)
        setFeedbackTarget(null)
        setStatusMessage('已取消等待评价结果；Dify 可能已经保存，正在重新读取当前消息。', 'warning')
        if (target) reconcileMessageFeedback(target)
    }

    const handleStop = async () => {
        if (!sendingRef.current) return
        const taskId = currentTaskIdRef.current
        const stopGeneration = ++streamGenerationRef.current
        sendingRef.current = false
        abortRef.current?.abort()
        abortRef.current = null
        const activeMessageId = activeMessageIdRef.current
        activeMessageIdRef.current = ''
        currentTaskIdRef.current = ''
        setMessages(prev => prev.map(message => message.id === activeMessageId
            ? { ...message, text: message.text || '回复已停止。', streamStatus: 'stopped' }
            : message))
        setIsSending(false)
        setStatusMessage(taskId ? '已停止本地接收，正在通知 Dify 终止任务。' : '已停止当前回复。')
        if (!taskId) return
        stopAbortRef.current?.abort()
        const controller = new AbortController()
        stopAbortRef.current = controller
        try {
            await stopChatStream(taskId, controller.signal)
            if (streamGenerationRef.current === stopGeneration) setStatusMessage('当前回复已停止，Dify 任务终止指令已送达。', 'success')
        } catch (error) {
            if (controller.signal.aborted) return
            if (streamGenerationRef.current === stopGeneration) setStatusMessage(businessErrorMessage(error, { fallback: '本地接收已停止，但 Dify 终止结果待确认', service: 'Dify 对话' }), 'warning')
        } finally {
            if (stopAbortRef.current === controller) stopAbortRef.current = null
            void loadRuntimeStatus(true)
        }
    }

    const retryQueryForMessage = (messageId: string) => {
        const messageIndex = messages.findIndex(message => message.id === messageId)
        if (messageIndex < 0) return ''
        for (let index = messageIndex - 1; index >= 0; index -= 1) {
            if (messages[index].role === 'user') return messages[index].text
        }
        return ''
    }

    const openRetryConfirmation = (message: ChatMessage) => {
        if (isSending || (message.streamStatus !== 'error' && message.streamStatus !== 'stopped')) return
        if (conversationExecutionUnavailable) {
            setStatusMessage('Dify 与 Home Assistant 当前均不可用，暂不能重新执行；原问题和草稿仍会保留。', 'warning')
            return
        }
        if (messages.at(-1)?.id !== message.id) {
            setStatusMessage('只能重新执行当前最后一轮提问；更早回复已不处于当时的会话上下文。', 'warning')
            return
        }
        const query = retryQueryForMessage(message.id)
        if (!query) {
            setStatusMessage('未找到该回复对应的原问题，无法安全地重新执行。', 'warning')
            return
        }
        setRetryTarget({ messageId: message.id, query, conversationId })
    }

    const retryLastQuestion = () => {
        if (!canRetryLastQuestion || !latestMessage) return
        if (latestMessage.role === 'ai') {
            openRetryConfirmation(latestMessage)
            return
        }
        setRetryTarget({ messageId: '', query: latestMessage.text, conversationId })
    }

    // 发送消息 → SSE 流式对话
    const sendQuery = async (query: string, options?: { keepInput?: boolean; retryMessageId?: string; appendReplyOnly?: boolean }) => {
        query = query.trim()
        if (!query || sendingRef.current || connectionCheckBusyRef.current || networkStatusAbortRef.current || loadingHistory) return
        if (query.length > CHAT_QUERY_MAX_LENGTH) {
            setStatusMessage(`单次问题不能超过 ${CHAT_QUERY_MAX_LENGTH.toLocaleString('zh-CN')} 个字符，内容未发送；请删减后重试。`, 'warning')
            return
        }
        if (conversationExecutionUnavailable) {
            setStatusMessage('Dify 与 Home Assistant 当前均不可用，消息未发送；草稿已保留。请查看运行状态或刷新状态后重试。', 'warning')
            return
        }
        if (!isOnline) {
            const controller = new AbortController()
            connectionCheckAbortRef.current?.abort()
            connectionCheckAbortRef.current = controller
            connectionCheckBusyRef.current = true
            setCheckingConnection(true)
            setStatusMessage('正在确认平台连接，确认成功后才会发送消息。')
            const reachable = await checkChatPlatformReachable(controller.signal)
            if (connectionCheckAbortRef.current === controller) connectionCheckAbortRef.current = null
            connectionCheckBusyRef.current = false
            setCheckingConnection(false)
            if (!reachable) {
                setIsOnline(false)
                setStatusMessage('当前无法连接平台后端，消息未发送；草稿已保留。', 'danger')
                return
            }
            markPlatformReachable()
        }
        if (conversationId && historyLoadedConversationId !== conversationId) {
            setStatusMessage('当前会话消息尚未成功读取。请先重新读取会话消息，或新建对话后再发送。', 'warning')
            return
        }
        const streamGeneration = ++streamGenerationRef.current
        sendingRef.current = true
        currentTaskIdRef.current = ''
        clearChatReadCache(conversationId)
        let resolvedConversationId = conversationId
        let localExecution = false

        const userMsg: ChatMessage = {
            id: `user-${Date.now()}`,
            role: 'user',
            text: query,
            time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
        }

        const aiMsgId = options?.retryMessageId || `ai-${Date.now()}`
        const aiMsg: ChatMessage = {
            id: aiMsgId,
            role: 'ai',
            text: '',
            time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
            conversationId,
            streamStatus: 'streaming',
        }

        setMessages(prev => options?.retryMessageId
            ? prev.map(message => message.id === options.retryMessageId ? aiMsg : message)
            : options?.appendReplyOnly
                ? [...prev, aiMsg]
                : [...prev, userMsg, aiMsg])
        setFollowingLatest(true)
        if (!options?.keepInput) {
            writeChatDraft(conversationId, '')
            setInputText('')
        }
        setHasAnimated(false)
        setIsSending(true)
        setStatusMessage('')

        // 重置 textarea 高度
        requestAnimationFrame(() => {
            if (textareaRef.current) {
                textareaRef.current.style.height = MIN_H + 'px'
                textareaRef.current.style.overflowY = 'hidden'
            }
        })

        // SSE 流式调用
        const controller = new AbortController()
        abortRef.current = controller
        activeMessageIdRef.current = aiMsgId

        try {
            await chatStream(
                query,
                conversationId,
                (event) => {
                    if (streamGenerationRef.current !== streamGeneration) return
                    setMessages(prev =>
                        prev.map(m =>
                            m.id === aiMsgId
                                ? {
                                    ...m,
                                    taskId: event.task_id ?? m.taskId,
                                    messageId: event.message_id ?? m.messageId,
                                    workflowRunId: event.workflow_run_id ?? m.workflowRunId,
                                    conversationId: event.conversation_id ?? m.conversationId,
                                    createdAt: event.created_at ?? m.createdAt,
                                    usage: event.metadata?.usage ?? m.usage,
                                    retrieverResources: event.metadata?.retriever_resources ?? m.retrieverResources,
                                    executionSource: event.metadata?.execution_source ?? m.executionSource,
                                    executionSuccess: event.metadata?.success ?? m.executionSuccess,
                                    executionConfirmation: event.metadata?.confirmation ?? m.executionConfirmation,
                                    deviceId: event.metadata?.device_id ?? m.deviceId,
                                    entityId: event.metadata?.entity_id ?? m.entityId,
                                    action: event.metadata?.action ?? m.action,
                                }
                                : m
                        )
                    )
                    if (event.task_id) {
                        currentTaskIdRef.current = event.task_id
                    }
                    if (event.metadata?.execution_source?.startsWith('local_')) localExecution = true
                    if (event.event === 'message' && event.answer) {
                        setMessages(prev =>
                            prev.map(m =>
                                m.id === aiMsgId
                                    ? { ...m, text: m.text + event.answer }
                                    : m
                            )
                        )
                    } else if (event.event === 'message_end') {
                        if (event.conversation_id) {
                            resolvedConversationId = event.conversation_id
                            currentConversationIdRef.current = event.conversation_id
                            setConversationId(event.conversation_id)
                            setHistoryLoadedConversationId(event.conversation_id)
                            replaceConversationUrl(event.conversation_id)
                        }
                        // Dify 工作流可能返回 JSON 格式，提取 message 字段
                        setMessages(prev =>
                            prev.map(m => {
                                if (m.id !== aiMsgId) return m
                                try {
                                    const parsed = JSON.parse(m.text)
                                    if (parsed.message) {
                                        return { ...m, text: parsed.message, streamStatus: 'complete' }
                                    }
                                } catch {
                                    // 不是 JSON，保持原样
                                }
                                return { ...m, streamStatus: 'complete' }
                            })
                        )
                    } else if (event.event === 'workflow_finished') {
                        const workflowStatus = String(event.data?.status || '').toLowerCase()
                        const workflowFailed = workflowStatus === 'failed' || workflowStatus === 'error'
                        const workflowError = String(event.data?.error || event.message || '智能体工作流执行失败')
                        if (!workflowFailed && event.conversation_id) {
                            resolvedConversationId = event.conversation_id
                            currentConversationIdRef.current = event.conversation_id
                            setConversationId(event.conversation_id)
                            setHistoryLoadedConversationId(event.conversation_id)
                            replaceConversationUrl(event.conversation_id)
                        }
                        setMessages(prev =>
                            prev.map(m => {
                                if (m.id !== aiMsgId) return m
                                if (workflowFailed) {
                                    return applyStreamFailure(m, workflowError)
                                }
                                try {
                                    const parsed = JSON.parse(m.text)
                                    if (parsed.message) return { ...m, text: parsed.message, streamStatus: 'complete' }
                                } catch {
                                    // 普通文本保持原样。
                                }
                                return { ...m, streamStatus: 'complete' }
                            })
                        )
                    } else if (event.event === 'error') {
                        setMessages(prev =>
                            prev.map(m =>
                                m.id === aiMsgId
                                    ? applyStreamFailure(m, event.message || '智能体工作流执行失败')
                                    : m
                            )
                        )
                    }
                },
                controller.signal,
            )
        } catch (err: unknown) {
            if (streamGenerationRef.current !== streamGeneration) return
            if (err instanceof Error && err.name !== 'AbortError') {
                setMessages(prev =>
                    prev.map(m =>
                        m.id === aiMsgId
                            ? applyStreamFailure(m, err)
                            : m
                    )
                )
            }
        } finally {
            if (streamGenerationRef.current !== streamGeneration) return
            setMessages(prev => prev.map(message => message.id === aiMsgId && message.streamStatus === 'streaming'
                ? { ...message, text: message.text || '智能体未返回有效内容，请稍后重试。', streamStatus: message.text ? 'complete' : 'error' }
                : message))
            setIsSending(false)
            sendingRef.current = false
            abortRef.current = null
            activeMessageIdRef.current = ''
            currentTaskIdRef.current = ''
            clearChatReadCache(resolvedConversationId)
            if (localExecution) {
                setStatusMessage('本地设备操作已保存到“会话与运行记录”；该记录不加入 Dify 会话目录。', 'success')
            } else {
                void loadConversations(true)
            }
            void loadRuntimeStatus(true)
        }
    }

    const handleSend = async () => {
        await sendQuery(inputText)
    }

    const chooseQuickPrompt = (prompt: string) => {
        if (inputText.trim() && inputText !== prompt) {
            setQuickPromptTarget(prompt)
            return
        }
        setInputText(prompt)
        window.requestAnimationFrame(() => textareaRef.current?.focus())
    }

    const replaceDraftWithQuickPrompt = () => {
        if (!quickPromptTarget) return
        setInputText(quickPromptTarget)
        setQuickPromptTarget('')
        window.requestAnimationFrame(() => textareaRef.current?.focus())
    }

    const confirmRetry = () => {
        const target = retryTarget
        if (!target || isSending) return
        if (conversationExecutionUnavailable) {
            setRetryTarget(null)
            setStatusMessage('Dify 与 Home Assistant 当前均不可用，本次重新执行未提交。', 'warning')
            return
        }
        if (target.conversationId !== conversationId) {
            setRetryTarget(null)
            setStatusMessage('当前会话已经切换，已取消旧会话的重新执行。', 'warning')
            return
        }
        if (target.messageId && !messages.some(message => message.id === target.messageId && (message.streamStatus === 'error' || message.streamStatus === 'stopped'))) {
            setRetryTarget(null)
            setStatusMessage('该回复状态已经变化，请根据当前结果重新操作。', 'warning')
            return
        }
        setRetryTarget(null)
        void sendQuery(target.query, {
            keepInput: true,
            retryMessageId: target.messageId || undefined,
            appendReplyOnly: !target.messageId,
        })
    }

    const runtimeMetrics = runtimeOverview?.metrics
    const runtimeCoverage = runtimeOverview?.coverage
    const difyMetricsComplete = runtimeCoverage?.dify_metrics_complete ?? Boolean(
        runtimeCoverage?.dify_records_available
        && !runtimeCoverage.conversation_has_more
        && !runtimeCoverage.message_truncated_conversations
        && !runtimeCoverage.message_load_error_count
    )
    const tokenMetricComplete = runtimeCoverage?.token_coverage_complete ?? difyMetricsComplete
    const tokenMetricAvailable = Boolean(runtimeCoverage?.token_message_count)
        || runtimeMetrics?.total_tokens !== null && runtimeMetrics?.total_tokens !== undefined
    const tokenMetricValue = tokenMetricAvailable ? runtimeMetrics?.total_tokens ?? '—' : '未返回'
    const tokenMetricLabel = tokenMetricAvailable ? runtimeMetricLabel('Token', tokenMetricComplete) : 'Token'
    const selectedConversation = conversations.find(item => item.id === conversationId)
        || (conversationId ? deepLinkedConversation(conversationId) : undefined)
    const conversationGroups = groupConversations(conversations)
    const composerHint = loadingHistory
        ? '会话消息加载完成后可发送'
        : selectedHistoryUnavailable
            ? '请先重新读取当前会话消息，或新建对话'
            : conversationExecutionUnavailable
                ? 'Dify 与 Home Assistant 当前不可用，可先保留草稿并查看运行状态'
            : '输入消息，与 AI 助手对话...'
    const inputTooLong = inputText.trim().length > CHAT_QUERY_MAX_LENGTH
    const sendControlDisabled = !isSending && (
        composerLocked
        || conversationExecutionUnavailable
        || checkingConnection
        || !inputText.trim()
        || inputTooLong
    )
    const sendControlLabel = isSending
        ? '停止生成'
        : composerLocked || conversationExecutionUnavailable
            ? composerHint
            : checkingConnection
                ? '正在检查平台连接'
                : !inputText.trim()
                    ? '请输入消息后发送'
                    : inputTooLong
                        ? `问题不能超过 ${CHAT_QUERY_MAX_LENGTH.toLocaleString('zh-CN')} 个字符`
                    : !isOnline
                        ? '检查连接并发送'
                        : '发送消息'
    const sendControlTitle = isSending
        ? '停止生成'
        : composerLocked || conversationExecutionUnavailable
            ? composerHint
            : checkingConnection
                ? '正在检查平台连接'
                : !inputText.trim()
                    ? '请输入消息后发送'
                    : inputTooLong
                        ? `问题不能超过 ${CHAT_QUERY_MAX_LENGTH.toLocaleString('zh-CN')} 个字符，请删减后发送`
                    : !isOnline
                        ? '先检查平台连接，成功后发送'
                        : '发送'
    const statusNoticeClass = statusNotice.tone === 'success'
        ? 'bg-emerald-50 text-emerald-700'
        : statusNotice.tone === 'warning'
            ? 'bg-amber-50 text-amber-800'
            : statusNotice.tone === 'danger'
                ? 'bg-rose-50 text-rose-700'
                : 'bg-blue-50 text-blue-700'

    return (
        <div className="chat-scope h-[calc(100dvh-64px)] min-h-0 bg-[var(--surface)] text-[var(--on-surface)] font-body selection:bg-[var(--primary)]/10">
            <div className="flex h-full w-full min-w-0 overflow-x-hidden px-3 py-3 sm:px-6 sm:py-6" style={{ gap: sidebarOpen ? 24 : 8 }}>

                {sidebarOpen ? (
                    <button
                        type="button"
                        aria-label="关闭会话历史"
                        onClick={() => setSidebarOpen(false)}
                        className="fixed inset-0 top-16 z-40 bg-slate-950/25 backdrop-blur-[1px] xl:hidden"
                    />
                ) : null}

                {/* ═══ 左侧边栏：会话历史 ═══ */}
                <aside
                    ref={conversationSidebarRef}
                    data-open={sidebarOpen ? 'true' : 'false'}
                    role={sidebarModal && sidebarOpen ? 'dialog' : undefined}
                    aria-modal={sidebarModal && sidebarOpen ? true : undefined}
                    aria-label={sidebarModal && sidebarOpen ? '会话历史' : undefined}
                    aria-hidden={!sidebarOpen}
                    inert={!sidebarOpen ? true : undefined}
                    tabIndex={sidebarModal && sidebarOpen ? -1 : undefined}
                    className="chat-conversation-sidebar flex flex-col shrink-0 overflow-hidden"
                    style={{
                        width: sidebarOpen ? 220 : 0,
                        opacity: sidebarOpen ? 1 : 0,
                        marginRight: sidebarOpen ? 0 : -8,
                        transition: 'width 0.35s cubic-bezier(0.25, 1, 0.5, 1), opacity 0.25s ease, margin-right 0.35s ease',
                    }}
                >
                    <div className="flex flex-col h-full" style={{ width: 220 }}>
                        {/* 顶栏：新建对话 + 收缩 */}
                        <div className="flex items-center justify-between mb-2 px-1">
                            <button
                                onClick={startNewChat}
                                aria-label="新建对话"
                                className="flex items-center gap-2 px-3 py-2 text-sm font-semibold text-[var(--on-surface)] hover:bg-[var(--surface-container)] rounded-lg transition-colors"
                            >
                                <Plus size={16} strokeWidth={2.5} className="text-[var(--on-surface-variant)]" />
                                新对话
                            </button>
                            <div className="flex items-center gap-1">
                                <button
                                    type="button"
                                    onClick={() => void loadConversations(true)}
                                    disabled={conversationLoading}
                                    className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-[var(--on-surface-variant)] transition-colors hover:bg-[var(--surface-container)] disabled:opacity-50"
                                    title="刷新会话目录"
                                    aria-label="刷新会话目录"
                                >
                                    <RotateCcw size={15} className={conversationLoading ? 'animate-spin' : ''} />
                                </button>
                                <button
                                    onClick={() => setSidebarOpen(false)}
                                    className="inline-flex h-9 w-9 items-center justify-center rounded-lg transition-colors hover:bg-[var(--surface-container)]"
                                    title="收起侧栏"
                                    aria-label="收起会话历史"
                                >
                                    <PanelLeftClose size={16} className="text-[var(--on-surface-variant)]" />
                                </button>
                            </div>
                        </div>

                        {/* 会话列表 — Claude 极简风 */}
                        <div className="flex-1 overflow-y-auto custom-scrollbar">
                            {conversationLoading && !conversations.length && !conversationsLoaded ? (
                                <div className="flex items-center justify-center gap-2 py-16 text-xs text-[var(--on-surface-variant)]/60">
                                    <Loader2 size={14} className="animate-spin" />
                                    正在加载会话
                                </div>
                            ) : conversationError && !conversations.length ? (
                                <div className="mx-2 mt-4 rounded-xl bg-amber-50 px-3 py-3 text-xs leading-5 text-amber-700">
                                    <p className="font-semibold">{conversationsLoaded ? '会话目录刷新失败，保留上次的空目录。' : conversationError}</p>
                                    {conversationsLoaded && conversationSnapshotAt ? <p className="mt-1">上次成功读取：{formatDetailTime(conversationSnapshotAt)}</p> : null}
                                    {conversationsLoaded ? <p className="mt-1 text-amber-700/80">{conversationError}</p> : null}
                                    <button type="button" onClick={() => void loadConversations(true)} className="mt-2 flex min-h-8 w-fit items-center font-bold text-amber-800 hover:underline">重新加载</button>
                                </div>
                            ) : conversations.length === 0 ? (
                                <div className="text-center py-16">
                                    <p className="text-sm text-[var(--on-surface-variant)]/30">暂无会话</p>
                                </div>
                            ) : (
                                <div className="space-y-3">
                                    {conversationGroups.map((group) => (
                                    <section key={group.label} aria-label={`${group.label}的会话`}>
                                        <p className="px-3 pb-1 text-xs font-semibold text-[var(--on-surface-variant)]/55">{group.label}</p>
                                        <div className="space-y-0.5">
                                    {group.items.map((conv) => {
                                        const isActive = conv.id === conversationId
                                        return (
                                            <div
                                                key={conv.id}
                                                className={`group relative flex items-center rounded-lg transition-colors duration-150 ${
                                                    isActive
                                                        ? 'bg-[var(--surface-container)] shadow-[inset_2px_0_0_var(--primary)]'
                                                        : 'hover:bg-[var(--surface-container-low)]'
                                                }`}
                                            >
                                                <button
                                                    type="button"
                                                    onClick={() => void switchConversation(conv)}
                                                    aria-current={isActive ? 'page' : undefined}
                                                    className={`min-w-0 flex-1 rounded-lg px-3 py-2.5 pr-11 text-left text-[14px] leading-snug outline-none transition focus-visible:ring-2 focus-visible:ring-[var(--primary)]/20 ${
                                                        isActive
                                                            ? 'font-semibold text-[var(--on-surface)]'
                                                            : 'font-normal text-[var(--on-surface)]/80'
                                                    }`}
                                                >
                                                    <span className="flex items-center gap-2">
                                                        {loadingConversationId === conv.id ? <Loader2 size={13} className="shrink-0 animate-spin" /> : null}
                                                        <span className="truncate" title={conv.name || '新对话'}>{conv.name || '新对话'}</span>
                                                    </span>
                                                </button>
                                                <button
                                                    onClick={(e) => openDeleteConversation(e, conv)}
                                                    disabled={Boolean(deletingConversationId) || Boolean(conversationError)}
                                                    aria-label={conversationError ? `当前显示上次成功目录，恢复实时连接后才能删除会话：${conv.name || '新对话'}` : `删除会话：${conv.name || '新对话'}`}
                                                    className={`absolute right-1.5 inline-flex h-9 w-9 items-center justify-center rounded-lg text-[var(--on-surface-variant)]/50 transition-all hover:bg-[var(--surface-container-high)] group-hover:opacity-100 group-focus-within:opacity-100 disabled:opacity-30 ${deletingConversationId ? 'disabled:cursor-wait' : conversationError ? 'disabled:cursor-not-allowed' : ''} ${isActive ? 'opacity-70' : 'opacity-40 sm:opacity-0'}`}
                                                    title={conversationError ? '当前显示上次成功目录，恢复实时连接后才能删除' : '删除会话'}
                                                >
                                                    <Trash2 size={14} />
                                                </button>
                                            </div>
                                        )
                                    })}
                                        </div>
                                    </section>
                                    ))}
                                </div>
                            )}
                            {conversationError && conversations.length ? <div className="mx-2 mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700">
                                <p className="font-semibold">会话目录更新失败，继续显示上次成功结果。</p>
                                {conversationSnapshotAt ? <p className="mt-1">上次成功读取：{formatDetailTime(conversationSnapshotAt)}</p> : null}
                                <p className="mt-1 text-amber-700/80">{conversationError}</p>
                            </div> : null}
                            {conversationMoreError ? (
                                <div className="mx-2 mt-3 border-l-2 border-amber-400 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800" role="alert">
                                    <p className="font-semibold">更早会话未能载入，当前列表仍可正常使用。</p>
                                    <p className="mt-1 break-words text-amber-700/80">{conversationMoreError}</p>
                                </div>
                            ) : null}
                            {conversationHasMore && !conversationError ? (
                                <button type="button" onClick={loadMoreConversations} disabled={loadingMoreConversations} className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg py-2 text-xs font-semibold text-[var(--on-surface-variant)] transition hover:bg-[var(--surface-container-low)] disabled:opacity-50">
                                    {loadingMoreConversations ? <Loader2 size={14} className="animate-spin" /> : null}
                                    {conversationMoreError ? '重新加载更多会话' : '加载更多会话'}
                                </button>
                            ) : null}
                        </div>
                    </div>
                </aside>

                {/* 收缩态：紧凑展开按钮 */}
                {!sidebarOpen && (
                    <button
                        onClick={() => setSidebarOpen(true)}
                        className="mt-1 hidden h-9 w-9 shrink-0 items-center justify-center self-start rounded-lg border border-[var(--outline-variant)]/20 bg-[var(--surface-container-lowest)] shadow-sm transition-colors hover:bg-[var(--surface-container-low)] xl:inline-flex"
                        title="展开会话历史"
                        aria-label="展开会话历史"
                    >
                        <PanelLeftOpen size={16} className="text-[var(--on-surface-variant)]/60" />
                    </button>
                )}

                {/* ═══ 中间：AI 对话区 ═══ */}
                <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/40 chat-glass shadow-[0_10px_40px_-15px_rgba(0,0,0,0.05)] relative lg:min-w-[500px]">

                    {/* 对话头部 */}
                    <div className="relative z-10 flex items-center justify-between gap-2 p-4 sm:p-6">
                        <div className="min-w-0 flex-1">
                            <h2 className="truncate font-headline text-base font-bold leading-tight sm:text-lg">智慧空间智能体</h2>
                        </div>
                        <div className="flex shrink-0 gap-1 sm:gap-3">
                            <button
                                type="button"
                                onClick={() => setSidebarOpen(true)}
                                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[var(--surface-container)] xl:hidden"
                                title="查看会话历史"
                                aria-label="查看会话历史"
                            >
                                <PanelLeftOpen size={19} className="text-[var(--on-surface-variant)]" />
                            </button>
                            {isSending && (
                                <button
                                    onClick={handleStop}
                                    className="inline-flex h-9 w-9 items-center justify-center gap-2 rounded-full bg-rose-50 text-sm font-semibold text-rose-600 transition-colors hover:bg-rose-100 sm:w-auto sm:px-4"
                                    title="停止生成"
                                    aria-label="停止生成"
                                >
                                    <X size={16} />
                                    <span className="hidden sm:inline">停止</span>
                                </button>
                            )}
                            {canRetryLastQuestion && (
                                <button
                                    onClick={retryLastQuestion}
                                    disabled={isSending}
                                    className="inline-flex h-9 w-9 items-center justify-center gap-2 rounded-full bg-[var(--surface-container-low)] text-sm font-semibold text-[var(--on-surface-variant)] transition-colors hover:bg-[var(--surface-container)] disabled:opacity-50 sm:w-auto sm:px-4"
                                    title="重新执行最后一轮"
                                    aria-label="重新执行最后一轮"
                                >
                                    <RotateCcw size={16} />
                                    <span className="hidden sm:inline">重试</span>
                                </button>
                            )}
                            <a href="/agents" aria-label="打开智能体配置" className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[var(--surface-container)] sm:inline-flex" title="智能体配置">
                                <Settings size={20} className="text-[var(--on-surface-variant)]" />
                            </a>
                            <button
                                type="button"
                                onClick={() => setMobileStatusOpen(true)}
                                className="inline-flex h-9 w-9 items-center justify-center rounded-full transition-colors hover:bg-[var(--surface-container)] xl:hidden"
                                title="查看运行状态"
                                aria-label="查看智能体运行状态"
                            >
                                <Activity size={19} className="text-[var(--on-surface-variant)]" />
                            </button>
                            <button
                                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[var(--surface-container)]"
                                onClick={startNewChat}
                                title="新建对话"
                                aria-label="新建对话"
                            >
                                <Plus size={20} className="text-[var(--on-surface-variant)]" />
                            </button>
                        </div>
                    </div>

                    {statusMessage && (
                        <div
                            role={statusNotice.tone === 'danger' ? 'alert' : 'status'}
                            aria-live={statusNotice.tone === 'danger' ? 'assertive' : 'polite'}
                            className={`mx-3 mb-2 grid min-w-0 grid-cols-[minmax(0,1fr)_36px] items-start gap-2 rounded-[8px] py-2.5 pl-4 pr-2 text-sm font-medium leading-6 sm:mx-6 ${statusNoticeClass}`}
                        >
                            <span className="min-w-0 break-words py-1">{statusMessage}</span>
                            <button
                                type="button"
                                onClick={() => dismissStatusNotice(statusNotice.id)}
                                className="inline-flex h-9 w-9 items-center justify-center rounded-[6px] text-current/70 transition hover:bg-black/[0.05] hover:text-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current/25"
                                aria-label="关闭当前提示"
                                title="关闭提示"
                            >
                                <X size={15} />
                            </button>
                        </div>
                    )}

                    {/* 消息流 / 空态 */}
                    <div
                        ref={chatContainerRef}
                        onScroll={handleMessageScroll}
                        className={`flex-1 relative ${isIdle ? 'overflow-hidden' : 'overflow-y-auto'} custom-scrollbar`}
                    >
                        {/* 粒子背景已移除 */}

                        {loadingHistory ? (
                            <div className="relative z-10 flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-[var(--on-surface-variant)]">
                                <Loader2 size={22} className="animate-spin text-[var(--primary)]" />
                                <div>
                                    <p className="font-semibold text-[var(--on-surface)]">正在读取会话消息</p>
                                    <p className="mt-1 text-xs text-[var(--on-surface-variant)]/70">切换完成前暂不发送新消息，避免写入错误会话。</p>
                                </div>
                            </div>
                        ) : selectedHistoryUnavailable ? (
                            <div className="relative z-10 flex h-full items-center justify-center px-6 pb-28 text-center">
                                <div className="max-w-md rounded-[8px] border border-amber-200/70 bg-amber-50 px-6 py-5 text-amber-800 shadow-sm">
                                    <MessageSquare size={22} className="mx-auto text-amber-700" />
                                    <p className="mt-3 text-sm font-bold text-amber-900">当前会话消息未能读取</p>
                                    <p className="mt-2 text-xs leading-5 text-amber-800/80">
                                        {historyError || '服务未返回可用的会话消息'}。为避免在缺少上下文时误发消息，当前会话输入已暂停。
                                    </p>
                                    <div className="mt-4 flex flex-wrap justify-center gap-2">
                                        <button
                                            type="button"
                                            onClick={() => selectedConversation && void switchConversation(selectedConversation)}
                                            disabled={!selectedConversation}
                                            className="inline-flex min-h-9 items-center gap-2 rounded-[6px] bg-amber-700 px-4 py-2 text-xs font-bold text-white transition hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-50"
                                        >
                                            <RotateCcw size={14} />
                                            重新读取会话消息
                                        </button>
                                        <button
                                            type="button"
                                            onClick={startNewChat}
                                            className="inline-flex min-h-9 items-center gap-2 rounded-[6px] border border-amber-300 bg-white px-4 py-2 text-xs font-bold text-amber-800 transition hover:bg-amber-100"
                                        >
                                            <Plus size={14} />
                                            新建对话
                                        </button>
                                    </div>
                                </div>
                            </div>
                        ) : selectedHistoryLoadedEmpty ? (
                            <div className="relative z-10 flex h-full items-center justify-center px-6 pb-28 text-center">
                                <div className="max-w-sm text-[var(--on-surface-variant)]">
                                    <MessageSquare size={24} className="mx-auto text-[var(--primary)]/70" />
                                    <p className="mt-3 text-sm font-bold text-[var(--on-surface)]">该会话暂无消息</p>
                                    <p className="mt-1 text-xs leading-5 text-[var(--on-surface-variant)]/70">历史记录已成功读取，可以继续在该会话中发送消息。</p>
                                </div>
                            </div>
                        ) : isIdle ? (
                            /* ── 空态：Orb 入场 + 欢迎文字（上移） ── */
                            <div className="chat-idle-welcome relative z-10 flex h-full flex-col items-center px-4 pt-4 text-center sm:pt-[12vh]">
                                <div className={`mb-6 relative z-10 ${hasAnimated ? 'orb-intro' : ''}`}>
                                    <AnimatedOrb size={128} />
                                </div>
                                <p className={`relative z-10 text-lg font-bold text-[var(--on-surface)] ${hasAnimated ? 'text-blur-intro' : ''}`}>
                                    你好，我是智慧空间智能体
                                </p>
                                <p className={`relative z-10 mt-2 text-sm font-medium text-[var(--on-surface-variant)]/80 ${hasAnimated ? 'text-blur-intro-delay' : ''}`}>
                                    支持知识问答、运行诊断与智能家居设备协同
                                </p>
                            </div>
                        ) : (
                            /* ── 消息列表 ── */
                            <div className="space-y-4 px-4 pb-[calc(8rem+env(safe-area-inset-bottom))] pt-6 sm:px-6 sm:pb-40">
                                {historyHasMore ? (
                                    <div className="flex justify-center pb-2">
                                        <button type="button" onClick={loadMoreHistory} disabled={loadingMoreHistory} className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-xs font-semibold text-[var(--on-surface-variant)] shadow-sm transition hover:bg-[var(--surface-container-low)] disabled:opacity-50">
                                            {loadingMoreHistory ? <Loader2 size={14} className="animate-spin" /> : null}
                                            加载更早消息
                                        </button>
                                    </div>
                                ) : null}
                                {messages.map((msg) => (
                                    msg.role === 'ai' ? (
                                        /* AI 消息 */
                                        <div key={msg.id} className="mr-auto flex min-w-0 max-w-[85%] items-start gap-2">
                                            <div className="shrink-0 mt-5">
                                                <AnimatedOrb size={32} />
                                            </div>
                                            <div className="flex min-w-0 max-w-full flex-col" style={{ maxWidth: 'calc(100% - 40px)' }}>
                                                <span className="text-xs text-[var(--on-surface-variant)]/50 mb-1">AI 助手</span>
                                                <div
                                                    className="min-w-0 max-w-full overflow-hidden rounded-2xl rounded-tl-none border border-[var(--outline-variant)]/10 bg-white"
                                                    style={{ boxShadow: 'rgba(14,63,126,0.04) 0 0 0 1px, rgba(42,51,69,0.04) 0 1px 1px -0.5px, rgba(42,51,70,0.04) 0 3px 3px -1.5px' }}
                                                >
                                                    <div className="px-4 py-3">
                                                        {msg.text ? (
                                                            <ChatMarkdownRenderer content={msg.text} />
                                                        ) : msg.streamStatus === 'streaming' ? (
                                                            <div className="chat-typing-indicator flex items-center gap-1 py-1" role="status" aria-label="智能体正在生成回复">
                                                                <span className="w-2 h-2 bg-[var(--on-surface-variant)]/30 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                                                                <span className="w-2 h-2 bg-[var(--on-surface-variant)]/30 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                                                                <span className="w-2 h-2 bg-[var(--on-surface-variant)]/30 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                                                            </div>
                                                        ) : <p className="text-sm text-rose-600">智能体未返回有效内容，请稍后重试。</p>}
                                                    </div>
                                                </div>
                                                <div className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-1 text-[var(--on-surface-variant)]/70">
                                                    {msg.streamStatus !== 'streaming' ? (
                                                        <button
                                                            onClick={(event) => openDebugDrawer(msg, event.currentTarget)}
                                                            className="inline-flex h-8 items-center gap-1.5 rounded-[6px] px-2 text-xs font-semibold hover:bg-[var(--surface-container-low)] hover:text-[var(--on-surface)]"
                                                        >
                                                            <Bug size={13} />
                                                            运行记录
                                                        </button>
                                                    ) : null}
                                                    {messageSupportsFeedback(msg) ? (
                                                        <button
                                                            onClick={() => openFeedbackDialog(msg)}
                                                            className="inline-flex h-8 items-center gap-1.5 rounded-[6px] px-2 text-xs font-semibold hover:bg-[var(--surface-container-low)] hover:text-[var(--on-surface)]"
                                                        >
                                                            {msg.feedback?.rating === 'dislike' ? <ThumbsDown size={13} /> : <ThumbsUp size={13} />}
                                                            {msg.feedback?.rating === 'like' ? '已好评' : msg.feedback?.rating === 'dislike' ? '待改进' : '效果评估'}
                                                        </button>
                                                    ) : null}
                                                    <button
                                                        onClick={() => void copyMessage(msg)}
                                                        className="inline-flex h-8 items-center gap-1.5 rounded-[6px] px-2 text-xs font-semibold hover:bg-[var(--surface-container-low)] hover:text-[var(--on-surface)]"
                                                    >
                                                        {copiedMessageId === msg.id ? <Check size={13} className="text-emerald-600" /> : copyFailedMessageId === msg.id ? <TriangleAlert size={13} className="text-rose-600" /> : <Copy size={13} />}
                                                        {copiedMessageId === msg.id ? '已复制' : copyFailedMessageId === msg.id ? '复制失败' : '复制'}
                                                    </button>
                                                    {msg.id === latestMessage?.id && (msg.streamStatus === 'error' || msg.streamStatus === 'stopped') && !conversationExecutionUnavailable ? (
                                                        <button
                                                            type="button"
                                                            onClick={() => openRetryConfirmation(msg)}
                                                            disabled={isSending}
                                                            className="inline-flex h-8 items-center gap-1.5 rounded-[6px] px-2 text-xs font-semibold text-amber-700 transition hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-50"
                                                        >
                                                            <RotateCcw size={13} />
                                                            重新执行
                                                        </button>
                                                    ) : null}
                                                </div>
                                                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--on-surface-variant)]/60">
                                                    <span>来源：{messageSourceLabel(msg)}</span>
                                                    {msg.executionSource && (
                                                        <span className={`font-semibold ${msg.executionSuccess === false ? 'text-rose-600' : msg.executionConfirmation === 'physical_pending' ? 'text-amber-700' : 'text-emerald-700'}`}>
                                                            {msg.executionSuccess === false ? '执行失败' : msg.executionConfirmation === 'physical_pending' ? 'HA 已接受，待实机确认' : msg.executionConfirmation === 'confirmed' ? '状态回读已确认' : '执行已完成'}
                                                        </span>
                                                    )}
                                                    {msg.retrieverResources?.length ? <span>命中 {msg.retrieverResources.length} 个检索片段</span> : null}
                                                </div>
                                                <span className="text-xs text-[var(--on-surface-variant)]/40 mt-1">{msg.time}</span>
                                            </div>
                                        </div>
                                    ) : (
                                        /* 用户消息 — OpenClaw 风格 */
                                        <div key={msg.id} className="user-message-enter ml-auto flex min-w-0 max-w-[85%] flex-row-reverse gap-2">
                                            <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 bg-white"
                                                 style={{ boxShadow: 'rgba(14,63,126,0.04) 0 0 0 1px, rgba(42,51,69,0.04) 0 1px 1px -0.5px' }}>
                                                <svg className="w-4 h-4 text-[var(--on-surface-variant)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
                                                </svg>
                                            </div>
                                            <div className="flex min-w-0 max-w-full flex-col items-end">
                                                <span className="text-xs text-[var(--on-surface-variant)]/50 mb-1">你</span>
                                                <div
                                                    className="min-w-0 max-w-full overflow-hidden rounded-2xl rounded-tr-none bg-white"
                                                    style={{ boxShadow: 'rgba(14,63,126,0.04) 0 0 0 1px, rgba(42,51,69,0.04) 0 1px 1px -0.5px, rgba(42,51,70,0.04) 0 3px 3px -1.5px' }}
                                                >
                                                    <div className="px-4 py-3">
                                                        <p className="text-sm whitespace-pre-wrap break-words leading-relaxed">{msg.text}</p>
                                                    </div>
                                                </div>
                                                <button type="button" onClick={() => void copyMessage(msg)} className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-[var(--on-surface-variant)]/70 transition hover:text-[var(--primary)]">
                                                    {copiedMessageId === msg.id ? <Check size={13} className="text-emerald-600" /> : copyFailedMessageId === msg.id ? <TriangleAlert size={13} className="text-rose-600" /> : <Copy size={13} />}
                                                    {copiedMessageId === msg.id ? '已复制' : copyFailedMessageId === msg.id ? '复制失败' : '复制'}
                                                </button>
                                                <span className="text-xs text-[var(--on-surface-variant)]/40 mt-1">{msg.time}</span>
                                            </div>
                                        </div>
                                    )
                                ))}
                                {messages.length > 0 && !messages.some(message => message.role === 'ai') ? (
                                    <div className="mx-auto max-w-md rounded-[8px] bg-amber-50 px-4 py-3 text-center text-sm leading-6 text-amber-700">
                                        {conversationExecutionUnavailable
                                            ? '该会话暂未收到智能体回复。Dify 与 Home Assistant 均恢复后，可重新执行最后一个问题。'
                                            : '该会话暂未收到智能体回复，可点击顶部“重试”重新发送最后一个问题。'}
                                    </div>
                                ) : null}
                            </div>
                        )}
                    </div>

                    {!isIdle && !followingLatest ? (
                        <button
                            type="button"
                            onClick={() => scrollToBottom('smooth')}
                            className="absolute bottom-[calc(9rem+env(safe-area-inset-bottom))] left-1/2 z-20 inline-flex h-9 -translate-x-1/2 items-center gap-2 rounded-full border border-[var(--outline-variant)]/15 bg-white px-3 text-xs font-semibold text-[var(--on-surface-variant)] shadow-md transition hover:text-[var(--primary)] sm:bottom-40"
                            title="跳到最新消息"
                            aria-label="跳到最新消息"
                        >
                            <ArrowDown size={14} />
                            最新消息
                        </button>
                    ) : null}

                    {/* Composer 输入区 + 快捷标签 */}
                    <div className={`chat-composer absolute left-0 right-0 z-10 px-3 sm:px-8 ${isIdle ? 'chat-idle-composer bottom-[calc(0.75rem+env(safe-area-inset-bottom))] sm:bottom-[14%] composer-intro' : 'bottom-[calc(0.75rem+env(safe-area-inset-bottom))] sm:bottom-6'}`}
                         style={{ transition: 'bottom 0.4s cubic-bezier(0.16, 1, 0.3, 1)' }}>
                        <div className="relative mx-auto" style={{ maxWidth: 'min(100%, 720px)' }}>
                            <div
                                className="chat-composer-box relative flex flex-col rounded-2xl border border-[var(--outline-variant)]/30 bg-white p-4 pb-14 shadow-[0_12px_34px_-18px_rgba(15,23,42,0.42)] transition-all focus-within:border-[var(--primary)]/30 focus-within:ring-2 focus-within:ring-[var(--primary)]/10"
                            >
                                <div className="flex gap-3 items-end">
                                    <textarea
                                        aria-label={composerLocked ? composerHint : '对话消息'}
                                        aria-invalid={inputTooLong}
                                        aria-describedby="chat-query-length-hint"
                                        ref={textareaRef}
                                        className="flex-1 resize-none border-0 bg-transparent px-1 py-2 font-body text-[15px] text-[var(--on-surface)] placeholder:text-[var(--on-surface-variant)]/60 focus:outline-none focus:ring-0"
                                        style={{ minHeight: MIN_H, maxHeight: MAX_H, lineHeight: '1.6', overflowY: 'hidden' }}
                                        placeholder={composerHint}
                                        rows={1}
                                        value={inputText}
                                        disabled={composerLocked}
                                        onChange={(e) => setInputText(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' && !e.shiftKey) {
                                                e.preventDefault()
                                                handleSend()
                                            }
                                        }}
                                    />

                                    {/* 发送按钮 — AnimatedOrb */}
                                    <button
                                        onClick={isSending ? handleStop : handleSend}
                                        disabled={sendControlDisabled}
                                        aria-label={sendControlLabel}
                                        className={`relative h-10 w-10 shrink-0 rounded-full flex items-center justify-center transition-all ${
                                            sendControlDisabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer hover:scale-110 active:scale-95'
                                        }`}
                                        title={sendControlTitle}
                                    >
                                        {isSending ? (
                                            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-rose-500 text-white">
                                                <X size={18} />
                                            </span>
                                        ) : checkingConnection ? (
                                            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-600 text-white">
                                                <Loader2 size={18} className="animate-spin" />
                                            </span>
                                        ) : (
                                            <AnimatedOrb size={40} />
                                        )}
                                    </button>
                                </div>

                                <div
                                    id="chat-query-length-hint"
                                    className={`absolute bottom-3.5 right-16 text-[11px] font-semibold tabular-nums leading-5 ${inputTooLong ? 'text-rose-600' : inputText.length >= CHAT_QUERY_MAX_LENGTH * 0.8 ? 'text-amber-600' : 'text-[var(--on-surface-variant)]/45'} ${inputText ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
                                >
                                    {inputText.trim().length.toLocaleString('zh-CN')} / {CHAT_QUERY_MAX_LENGTH.toLocaleString('zh-CN')}
                                </div>

                                {/* 麦克风按钮 — 绝对定位底部左侧 */}
                                <button
                                    onClick={toggleVoice}
                                    disabled={composerLocked}
                                    aria-label={isListening ? '停止语音输入' : '开始语音输入'}
                                    className={`absolute bottom-3.5 left-4 h-9 w-9 shrink-0 rounded-full flex items-center justify-center transition-all duration-200 ${
                                        isListening
                                            ? 'bg-red-500 text-white voice-pulse'
                                            : 'bg-[var(--surface-container-low)] hover:bg-[var(--surface-container)] text-[var(--on-surface-variant)]/60'
                                    } ${composerLocked ? 'cursor-not-allowed opacity-40' : ''} ${
                                        inputText.trim() && !isListening ? 'opacity-0 pointer-events-none' : 'opacity-100'
                                    }`}
                                    title={composerLocked ? composerHint : isListening ? '停止语音输入' : '语音输入'}
                                >
                                    {isListening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                                </button>
                            </div>
                        </div>

                        {/* 快捷标签 — 仅空态显示 */}
                        {isIdle && (
                            <div className={`chat-quick-prompts mx-auto mt-3 max-w-[720px] ${hasAnimated ? 'text-blur-intro-delay' : ''}`}>
                                {conversationExecutionUnavailable ? (
                                    <p className="mb-2 text-center text-xs font-semibold leading-5 text-amber-700">
                                        对话服务与设备服务均不可用，消息不会提交；草稿仍会保留。
                                    </p>
                                ) : null}
                                <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-center">
                                {[
                                    { icon: <Lightbulb className="w-3.5 h-3.5" />, label: '筒灯现在是什么状态', unavailable: homeAssistantUnavailable, reason: 'Home Assistant 当前不可用' },
                                    { icon: <BarChart2 className="w-3.5 h-3.5" />, label: '查询最近的设备控制记录', unavailable: difyUnavailable, reason: 'Dify 智能体当前不可用' },
                                    { icon: <Database className="w-3.5 h-3.5" />, label: '介绍智慧家居知识库内容', unavailable: difyUnavailable || knowledgeUnavailable, reason: difyUnavailable ? 'Dify 智能体当前不可用' : '知识库当前不可用' },
                                    { icon: <ShieldCheck className="w-3.5 h-3.5" />, label: '查看当前服务运行状态', unavailable: false, reason: '' },
                                ].map((tag) => (
                                    <button
                                        key={tag.label}
                                        type="button"
                                        onClick={() => tag.label === '查看当前服务运行状态' ? setMobileStatusOpen(true) : chooseQuickPrompt(tag.label)}
                                        disabled={tag.unavailable}
                                        title={tag.unavailable ? tag.reason : tag.label}
                                        className="inline-flex min-h-11 min-w-0 items-center justify-center gap-1.5 rounded-2xl bg-white px-2 py-2 text-center text-xs font-medium leading-4 text-[var(--on-surface-variant)] transition-colors hover:bg-[var(--surface-container)] disabled:cursor-not-allowed disabled:bg-white/60 disabled:text-[var(--on-surface-variant)]/40 sm:rounded-full sm:px-4 sm:text-sm"
                                        style={{ boxShadow: 'rgba(14,63,126,0.04) 0 0 0 1px, rgba(42,51,69,0.03) 0 1px 2px' }}
                                    >
                                        {tag.icon}
                                        {tag.label}
                                    </button>
                                ))}
                                </div>
                            </div>
                        )}
                    </div>
                </section>

                {/* ═══ 右侧边栏：智能体真实运行概览 ═══ */}
                <aside className="no-sb hidden max-h-full min-h-0 w-80 shrink-0 flex-col gap-4 overflow-y-auto overscroll-contain pb-1 xl:flex">

                    <div className="bg-[var(--surface-container-lowest)] rounded-[8px] p-5">
                        <div className="mb-5 flex items-start justify-between gap-4">
                            <div>
                                <h3 className="font-headline text-sm font-bold text-[var(--on-surface)]">运行状态</h3>
                                <p className="mt-1 text-xs leading-5 text-[var(--on-surface-variant)]/70">
                                    {runtimeOverview?.window.label || '近 24 小时'}真实运行数据。
                                </p>
                            </div>
                            <button
                                onClick={() => void loadRuntimeStatus(true)}
                                disabled={statusLoading}
                                aria-label="刷新智能体运行状态"
                                className="inline-flex h-9 w-9 items-center justify-center rounded-[8px] text-[var(--on-surface-variant)] outline-none transition-colors hover:bg-[var(--surface-container)] focus-visible:ring-2 focus-visible:ring-[var(--primary)]/20 disabled:opacity-50"
                                title="刷新运行状态"
                            >
                                <RotateCcw size={16} className={statusLoading ? 'animate-spin' : ''} />
                            </button>
                        </div>

                        {statusError ? (
                            <div className="rounded-[8px] bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-700">
                                状态刷新失败：{statusError}{runtimeOverview ? '，继续展示上一次成功快照。' : ''}
                            </div>
                        ) : null}
                        {runtimeOverview ? (
                            <div>
                                <div className="border-b border-[var(--outline-variant)]/10 pb-4">
                                    <div className="flex items-center justify-between gap-3">
                                        <div className="min-w-0">
                                            <p className="truncate text-sm font-bold text-[var(--on-surface)]" title={runtimeOverview?.agent.name || '智慧空间智能体'}>{runtimeOverview?.agent.name || '智慧空间智能体'}</p>
                                            <p className="mt-1 truncate text-xs text-[var(--on-surface-variant)]/70" title={runtimeOverview?.agent.model || '正在读取模型配置'}>{runtimeOverview?.agent.model || '正在读取模型配置'}</p>
                                        </div>
                                        <span className={`shrink-0 rounded-[6px] px-2.5 py-1 text-xs font-bold ${runtimeOverview?.agent.status === 'running' ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-700'}`}>
                                            {runtimeStatusLabel(runtimeOverview?.agent.status || '')}
                                        </span>
                                    </div>
                                </div>
                                <div className="divide-y divide-[var(--outline-variant)]/10">
                                {(runtimeOverview?.services || []).map((item) => {
                                    const iconMap = { dify: Bot, knowledge: Database, home_assistant: ShieldCheck }
                                    const Icon = iconMap[item.key as keyof typeof iconMap] || Server
                                    const ok = item.status === 'running'
                                    return (
                                        <div key={item.key} className="py-3">
                                            <div className="flex items-center justify-between gap-3">
                                                <div className="flex min-w-0 items-center gap-3">
                                                    <Icon size={17} className={ok ? 'text-emerald-600' : 'text-amber-600'} />
                                                    <div className="min-w-0">
                                                        <p className="text-xs font-bold text-[var(--on-surface)]">{item.name}</p>
                                                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--on-surface-variant)]/70" title={item.error || item.detail}>{runtimeServiceDiagnostic(item)}</p>
                                                    </div>
                                                </div>
                                                <div className="shrink-0 text-right">
                                                    <span className={`block text-xs font-bold ${ok ? 'text-emerald-600' : 'text-amber-700'}`}>{runtimeServiceStatusLabel(item.status)}</span>
                                                    <span className="mt-1 block text-xs text-[var(--on-surface-variant)]/60">{item.latency_ms !== null ? formatMilliseconds(item.latency_ms) : '耗时未取得'}</span>
                                                </div>
                                            </div>
                                        </div>
                                    )
                                })}
                                </div>
                            </div>
                        ) : !statusError ? <div className="py-8 text-center text-xs text-[var(--on-surface-variant)]/60">正在读取运行状态...</div> : null}
                        {runtimeOverview ? (
                            <div className={`mt-4 border-l-2 px-3 py-2 text-xs leading-5 ${runtimeOverview.coverage?.complete ? 'border-emerald-400 bg-emerald-50 text-emerald-700' : 'border-amber-400 bg-amber-50 text-amber-800'}`}>
                                <div className="font-bold">{overviewCoverageLabel(runtimeOverview)}</div>
                                <div>采集于 {formatDetailTime(runtimeOverview.generated_at)}</div>
                            </div>
                        ) : null}
                    </div>

                    {/* 近 24 小时真实指标 */}
                    <div className="overflow-hidden rounded-[8px] border border-[var(--outline-variant)]/10 bg-[var(--surface-container-lowest)]">
                        <div className="flex flex-wrap items-center justify-between gap-1 border-b border-[var(--outline-variant)]/10 px-3 py-2 text-xs font-semibold leading-5 text-[var(--on-surface-variant)]/70">
                            <span>运行指标</span>
                            <span>统计范围：{runtimeOverview?.window.label || '近 24 小时'}</span>
                        </div>
                        <div className="grid grid-cols-2">
                        {[
                            { icon: MessageSquare, label: runtimeMetricLabel('会话', difyMetricsComplete), value: runtimeMetrics?.conversation_count ?? '—' },
                            { icon: Activity, label: runtimeMetricLabel('回复', difyMetricsComplete), value: runtimeMetrics?.message_count ?? '—' },
                            { icon: Database, label: runtimeMetricLabel('检索片段', difyMetricsComplete), value: runtimeMetrics?.retrieval_segment_count ?? '—' },
                            { icon: Lightbulb, label: '设备控制', value: runtimeMetrics?.device_control_count ?? '—' },
                            { icon: ThumbsUp, label: runtimeMetricLabel('好评率', difyMetricsComplete), value: formatMetricRate(runtimeMetrics?.positive_feedback_rate ?? null, runtimeOverview?.coverage?.dify_records_available === true) },
                            { icon: BarChart2, label: tokenMetricLabel, value: tokenMetricValue },
                        ].map((item) => {
                            const Icon = item.icon
                            return (
                                <div key={item.label} className="grid min-h-16 grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2 border-b border-r border-[var(--outline-variant)]/10 px-3 py-2.5 even:border-r-0 [&:nth-child(n+5)]:border-b-0">
                                    <Icon size={16} className="shrink-0 text-[var(--on-surface-variant)]/65" strokeWidth={1.5} />
                                    <span className="min-w-0 break-words text-xs font-semibold leading-4 text-[var(--on-surface-variant)]" title={item.label}>{item.label}</span>
                                    <span className="shrink-0 text-sm font-black text-[var(--on-surface)]">{item.value}</span>
                                </div>
                            )
                        })}
                        </div>
                    </div>

                </aside>
            </div>
            {feedbackTarget && (
                <FeedbackDialog
                    target={feedbackTarget}
                    rating={feedbackRating}
                    note={feedbackNote}
                    submitting={submittingFeedback}
                    onRatingChange={setFeedbackRating}
                    onNoteChange={setFeedbackNote}
                    onClose={() => {
                        if (!submittingFeedback) setFeedbackTarget(null)
                    }}
                    onCancelSubmit={cancelFeedbackWait}
                    onSubmit={submitFeedback}
                />
            )}
            {deleteConversationTarget ? (
                <AppDialog
                    title="删除会话"
                    description={`会话「${deleteConversationTarget.name || '新对话'}」删除后无法恢复。`}
                    onClose={deletingConversationId ? () => undefined : () => setDeleteConversationTarget(null)}
                    maxWidth="max-w-sm"
                    danger
                    closeOnOverlay={!deletingConversationId}
                    showClose={!deletingConversationId}
                    initialFocusRef={deleteCancelRef}
                    footer={(
                        <div className="flex justify-end gap-3">
                            <button ref={deleteCancelRef} type="button" onClick={cancelDeleteConversationWait} className="rounded-[8px] px-5 py-2.5 text-sm font-bold text-slate-500 transition hover:text-slate-700">
                                {deletingConversationId ? <><Loader2 size={14} className="mr-2 inline animate-spin" />取消等待</> : '取消'}
                            </button>
                            {!deletingConversationId ? (
                                <button type="button" onClick={() => void confirmDeleteConversation()} className="rounded-[8px] bg-red-500 px-5 py-2.5 text-sm font-bold text-white transition hover:bg-red-600">确认删除</button>
                            ) : null}
                        </div>
                    )}
                >
                    <p className="text-sm leading-6 text-slate-500">该操作会调用 Dify 会话删除接口。</p>
                    {deletingConversationId ? <p className="mt-3 text-xs font-medium leading-5 text-amber-700">删除请求已发送。取消等待只停止当前页面等待，不会撤销 Dify 可能已经完成的删除；页面随后会重新读取最终目录。</p> : null}
                </AppDialog>
            ) : null}
            {retryTarget ? (
                <AppDialog
                    title="重新执行这次提问"
                    description="重新执行可能再次触发设备控制、场景或其他外部操作，请确认原问题后继续。"
                    onClose={() => setRetryTarget(null)}
                    maxWidth="max-w-md"
                    initialFocusRef={retryCancelRef}
                    footer={(
                        <div className="flex flex-wrap justify-end gap-3">
                            <button ref={retryCancelRef} type="button" onClick={() => setRetryTarget(null)} className="rounded-[8px] px-5 py-2.5 text-sm font-bold text-slate-500 transition hover:text-slate-700">
                                取消
                            </button>
                            <button type="button" onClick={confirmRetry} className="inline-flex items-center gap-2 rounded-[8px] bg-amber-600 px-5 py-2.5 text-sm font-bold text-white transition hover:bg-amber-700">
                                <RotateCcw size={15} />
                                确认重新执行
                            </button>
                        </div>
                    )}
                >
                    <div className="space-y-3">
                        <p className="text-xs font-bold text-slate-500">原问题</p>
                        <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-[8px] border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-800">
                            {retryTarget.query}
                        </p>
                        <p className="text-xs leading-5 text-amber-700">页面不会重复追加这条用户消息；确认后会{retryTarget.messageId ? '在原失败回复位置重新生成结果' : '补充本轮智能体回复'}。</p>
                    </div>
                </AppDialog>
            ) : null}
            {quickPromptTarget ? (
                <AppDialog
                    title="替换当前草稿"
                    description="快捷问题会替换输入框中尚未发送的内容。"
                    onClose={() => setQuickPromptTarget('')}
                    maxWidth="max-w-md"
                    initialFocusRef={quickPromptCancelRef}
                    footer={(
                        <div className="flex flex-wrap justify-end gap-3">
                            <button ref={quickPromptCancelRef} type="button" onClick={() => setQuickPromptTarget('')} className="rounded-[8px] px-5 py-2.5 text-sm font-bold text-slate-500 transition hover:text-slate-700">
                                保留草稿
                            </button>
                            <button type="button" onClick={replaceDraftWithQuickPrompt} className="rounded-[8px] bg-[var(--primary)] px-5 py-2.5 text-sm font-bold text-white transition hover:opacity-90">
                                使用快捷问题
                            </button>
                        </div>
                    )}
                >
                    <div className="space-y-3">
                        <p className="text-xs font-bold text-slate-500">将填入</p>
                        <p className="whitespace-pre-wrap break-words rounded-[8px] border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-800">
                            {quickPromptTarget}
                        </p>
                        <p className="text-xs leading-5 text-amber-700">选择“保留草稿”不会修改当前输入。</p>
                    </div>
                </AppDialog>
            ) : null}
            {debugTarget && (
                <DebugDrawer
                    target={debugTarget}
                    detail={workflowDetail}
                    loading={loadingWorkflow}
                    error={workflowError}
                    difyConsoleUrl="/dify"
                    onRetry={() => void loadWorkflowDetail(debugTarget, true)}
                    onClose={closeDebugDrawer}
                />
            )}
            {mobileStatusOpen ? (
                <AppDialog
                    title="智能体运行状态"
                    description={`${runtimeOverview?.window.label || '近 24 小时'}真实运行数据。`}
                    onClose={() => setMobileStatusOpen(false)}
                    maxWidth="max-w-lg"
                    footer={(
                        <div className="flex justify-end gap-3">
                            <button
                                type="button"
                                onClick={() => void loadRuntimeStatus(true)}
                                disabled={statusLoading}
                                className="inline-flex min-h-10 items-center gap-2 rounded-[8px] border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 disabled:opacity-50"
                            >
                                <RotateCcw size={15} className={statusLoading ? 'animate-spin' : ''} />
                                刷新状态
                            </button>
                            <button type="button" onClick={() => setMobileStatusOpen(false)} className="min-h-10 rounded-[8px] bg-[var(--primary)] px-5 py-2 text-sm font-semibold text-white">关闭</button>
                        </div>
                    )}
                >
                    <div className="space-y-4">
                        {statusError ? (
                            <div className="rounded-[8px] bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-700">状态刷新失败：{statusError}{runtimeOverview ? '，继续展示上一次成功快照。' : ''}</div>
                        ) : null}
                        {runtimeOverview ? (
                            <div className="rounded-[8px] bg-[var(--surface-container-low)] px-4 py-4">
                                <div className="flex items-center justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="truncate text-sm font-bold text-[var(--on-surface)]" title={runtimeOverview?.agent.name || '智慧空间智能体'}>{runtimeOverview?.agent.name || '智慧空间智能体'}</p>
                                        <p className="mt-1 truncate text-xs text-[var(--on-surface-variant)]/70" title={runtimeOverview?.agent.model || '正在读取模型配置'}>{runtimeOverview?.agent.model || '正在读取模型配置'}</p>
                                    </div>
                                    <span className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-bold ${runtimeOverview?.agent.status === 'running' ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-700'}`}>
                                        {runtimeStatusLabel(runtimeOverview?.agent.status || '')}
                                    </span>
                                </div>
                            </div>
                        ) : !statusError ? <div className="py-8 text-center text-sm text-[var(--on-surface-variant)]">正在读取运行状态...</div> : null}
                        {runtimeOverview ? <div className={`border-l-2 px-3 py-2 text-xs leading-5 ${runtimeOverview.coverage?.complete ? 'border-emerald-400 bg-emerald-50 text-emerald-700' : 'border-amber-400 bg-amber-50 text-amber-800'}`}><div className="font-bold">{overviewCoverageLabel(runtimeOverview)}</div><div>采集于 {formatDetailTime(runtimeOverview.generated_at)}</div></div> : null}
                        <div className="text-xs font-semibold text-[var(--on-surface-variant)]">以下指标统计范围：{runtimeOverview?.window.label || '近 24 小时'}</div>
                        <div className="grid grid-cols-2 gap-3">
                            {[
                                [runtimeMetricLabel('会话', difyMetricsComplete), runtimeMetrics?.conversation_count ?? '—'],
                                [runtimeMetricLabel('回复', difyMetricsComplete), runtimeMetrics?.message_count ?? '—'],
                                [runtimeMetricLabel('检索片段', difyMetricsComplete), runtimeMetrics?.retrieval_segment_count ?? '—'],
                                ['设备控制', runtimeMetrics?.device_control_count ?? '—'],
                                [runtimeMetricLabel('好评率', difyMetricsComplete), formatMetricRate(runtimeMetrics?.positive_feedback_rate ?? null, runtimeOverview?.coverage?.dify_records_available === true)],
                                [tokenMetricLabel, tokenMetricValue],
                            ].map(([label, value]) => (
                                <div key={label} className="min-w-0 rounded-[8px] bg-[var(--surface-container-low)] px-3 py-4 text-center">
                                    <p className="text-xs font-semibold text-[var(--on-surface-variant)]">{label}</p>
                                    <p className="mt-2 break-words text-lg font-black text-[var(--on-surface)]">{value}</p>
                                </div>
                            ))}
                        </div>
                        <div className="space-y-2">
                            {(runtimeOverview?.services || []).map((item) => (
                                <div key={item.key} className="flex items-center justify-between gap-3 rounded-[8px] border border-[var(--outline-variant)]/10 px-4 py-3">
                                    <div className="min-w-0">
                                        <p className="text-sm font-bold text-[var(--on-surface)]">{item.name}</p>
                                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--on-surface-variant)]/70" title={item.error || item.detail}>{runtimeServiceDiagnostic(item)}</p>
                                    </div>
                                    <div className="shrink-0 text-right">
                                        <span className={`block text-xs font-bold ${item.status === 'running' ? 'text-emerald-600' : 'text-amber-700'}`}>{runtimeServiceStatusLabel(item.status)}</span>
                                        <span className="mt-1 block text-xs text-[var(--on-surface-variant)]/60">{item.latency_ms !== null ? formatMilliseconds(item.latency_ms) : '耗时未取得'}</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </AppDialog>
            ) : null}
        </div>
    )
}
