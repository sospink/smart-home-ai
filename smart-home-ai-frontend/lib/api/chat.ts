/**
 * Chat API Client — 对接后端 /api/v1/chat 路由
 */
import { getAuthCacheScope, getToken, handleUnauthorized } from '@/lib/auth-storage'
import { apiClient } from './client'
import { waitForSharedRead } from '@/lib/api/shared-read'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || '/api'
const CHAT_READ_CACHE_TTL_MS = 30_000
const CHAT_READ_TIMEOUT_MS = 10_000
const CHAT_WRITE_TIMEOUT_MS = 20_000
const CHAT_STREAM_IDLE_TIMEOUT_MS = 45_000

const conversationCache = new Map<string, { expiresAt: number; value: ConversationsResponse }>()
const conversationPending = new Map<string, Promise<ConversationsResponse>>()
const conversationGeneration = new Map<string, number>()
const messageCache = new Map<string, { expiresAt: number; value: MessagesResponse }>()
const messagePending = new Map<string, Promise<MessagesResponse>>()
const messageGeneration = new Map<string, number>()
const overviewCache = new Map<string, { expiresAt: number; value: AgentRuntimeOverview }>()
const overviewPending = new Map<string, Promise<AgentRuntimeOverview>>()
const overviewGeneration = new Map<string, number>()
const workflowDetailCache = new Map<string, { expiresAt: number; value: WorkflowRunDetail }>()
const workflowDetailPending = new Map<string, Promise<WorkflowRunDetail>>()
const workflowDetailGeneration = new Map<string, number>()

async function responseError(response: Response, fallback: string) {
    const payload = await response.json().catch(() => null) as { detail?: unknown; message?: unknown } | null
    const detail = payload?.detail ?? payload?.message
    const message = typeof detail === 'string'
        ? detail
        : Array.isArray(detail)
            ? detail.map((item) => typeof item === 'object' && item ? String((item as { msg?: unknown }).msg || '') : '').filter(Boolean).join('；')
            : fallback
    return new Error(`${message || fallback}（HTTP ${response.status}）`)
}

function readCacheKey(parts: Array<string | number>) {
    return [getAuthCacheScope(), ...parts]
        .map(value => encodeURIComponent(String(value)))
        .join(':')
}

export function clearChatReadCache(conversationId = '') {
    for (const key of new Set([...conversationCache.keys(), ...conversationPending.keys(), ...conversationGeneration.keys()])) {
        conversationGeneration.set(key, (conversationGeneration.get(key) || 0) + 1)
    }
    conversationCache.clear()
    conversationPending.clear()
    if (!conversationId) {
        for (const key of new Set([...messageCache.keys(), ...messagePending.keys(), ...messageGeneration.keys()])) {
            messageGeneration.set(key, (messageGeneration.get(key) || 0) + 1)
        }
        messageCache.clear()
        messagePending.clear()
        return
    }
    const conversationKeyPart = `:${encodeURIComponent(conversationId)}:`
    for (const key of messageCache.keys()) {
        if (key.includes(conversationKeyPart)) messageCache.delete(key)
    }
    for (const key of messagePending.keys()) {
        if (key.includes(conversationKeyPart)) messagePending.delete(key)
    }
    for (const key of messageGeneration.keys()) {
        if (key.includes(conversationKeyPart)) messageGeneration.set(key, (messageGeneration.get(key) || 0) + 1)
    }
}

export async function checkChatPlatformReachable(signal?: AbortSignal): Promise<boolean> {
    try {
        const result = await apiClient.get<{ status?: string }>('/system/health', {
            signal,
            timeoutMs: 5_000,
            redirectOnUnauthorized: false,
        })
        return result.status === 'ok'
    } catch {
        return false
    }
}

export function clearAgentRuntimeOverviewCache() {
    const keys = new Set([...overviewCache.keys(), ...overviewPending.keys(), ...overviewGeneration.keys()])
    keys.forEach((key) => overviewGeneration.set(key, (overviewGeneration.get(key) || 0) + 1))
    overviewCache.clear()
    overviewPending.clear()
}

export function clearWorkflowRunDetailCache(workflowRunId = '') {
    const encodedRunId = workflowRunId ? `:${encodeURIComponent(workflowRunId)}` : ''
    const keys = new Set([...workflowDetailCache.keys(), ...workflowDetailPending.keys(), ...workflowDetailGeneration.keys()])
    keys.forEach((key) => {
        if (!encodedRunId || key.endsWith(encodedRunId)) {
            workflowDetailGeneration.set(key, (workflowDetailGeneration.get(key) || 0) + 1)
            workflowDetailCache.delete(key)
            workflowDetailPending.delete(key)
        }
    })
}

export interface DifySSEEvent {
    event: string
    task_id?: string
    message_id?: string
    conversation_id?: string
    answer?: string
    created_at?: number
    metadata?: {
        usage?: Record<string, unknown>
        retriever_resources?: unknown[]
        execution_source?: string
        device_id?: string
        entity_id?: string
        action?: string
        success?: boolean
        confirmation?: 'confirmed' | 'accepted' | 'physical_pending' | string
    }
    // workflow events
    workflow_run_id?: string
    data?: Record<string, unknown>
    // error
    message?: string
    code?: string
}

export interface MessageFeedback {
    rating?: 'like' | 'dislike'
    content?: string
}

export interface ConversationItem {
    id: string
    name: string
    inputs: Record<string, unknown>
    status: string
    created_at: number
    updated_at: number
}

export interface ConversationsResponse {
    data: ConversationItem[]
    has_more: boolean
    limit: number
    external_service_error?: string
}

export interface AgentRuntimeOverview {
    agent: {
        id: number | null
        name: string
        runtime_name: string
        model: string
        status: 'running' | 'degraded' | 'unconfigured' | string
        instance_type: string
        knowledge_bindings: number
    }
    window: {
        label: string
        hours: number
        since: string
    }
    coverage?: {
        complete: boolean
        conversation_limit: number
        message_limit_per_conversation: number
        conversation_count_loaded: number
        conversation_has_more: boolean
        message_truncated_conversations: number
        message_load_error_count: number
        dify_records_available?: boolean
        dify_metrics_complete?: boolean
        token_message_count?: number
        token_coverage_complete?: boolean
        knowledge_available?: boolean
        home_assistant_available?: boolean
    }
    metrics: {
        conversation_count: number | null
        message_count: number | null
        feedback_count: number | null
        positive_feedback_count: number | null
        negative_feedback_count: number | null
        positive_feedback_rate: number | null
        retrieval_message_count: number | null
        retrieval_segment_count: number | null
        device_control_count: number
        device_control_success_count: number
        device_control_success_rate: number | null
        local_run_count: number
        local_run_success_rate: number | null
        total_tokens: number | null
    }
    services: Array<{
        key: 'dify' | 'knowledge' | 'home_assistant' | string
        name: string
        status: string
        latency_ms: number | null
        http_status?: number | null
        detail: string
        error: string
    }>
    latest_activity_at: number | null
    generated_at: string
    cache_ttl_seconds: number
    data_sources: string[]
    cache: 'hit' | 'miss'
}

export interface HistoryMessage {
    id: string
    conversation_id: string
    inputs: Record<string, unknown>
    query: string
    answer: string
    created_at: number
    feedback: MessageFeedback | null
    workflow_run_id?: string
    workflow_run?: { id?: string } | null
    task_id?: string
    task?: { id?: string } | null
    usage?: Record<string, unknown>
    message_tokens?: Record<string, unknown>
    retriever_resources: unknown[]
}

export interface MessagesResponse {
    data: HistoryMessage[]
    has_more: boolean
    limit: number
}

export interface WorkflowRunDetail {
    id: string
    workflow_id?: string
    status?: string
    elapsed_time?: number
    total_tokens?: number
    total_steps?: number
    created_at?: number | string
    finished_at?: number | string
    error?: string
    outputs?: Record<string, unknown>
    inputs?: Record<string, unknown>
}

export type ConversationRecordView = 'history' | 'runs' | 'feedback'
export type ConversationRunKind = '' | 'workflow_run' | 'task_run' | 'device_control' | 'device_status' | 'platform_test' | 'platform_run'

export interface ConversationRecordItem {
    conversation_id: string
    conversation_name: string
    conversation_updated_at?: number
    message_id: string
    query: string
    answer: string
    created_at: number
    feedback: MessageFeedback | null
    workflow_run_id?: string
    task_id?: string
    usage?: unknown
    retriever_resources?: unknown[]
    record_source?: string
    run_status?: string
    debug_available?: boolean
    feedback_supported?: boolean
    record_kind?: Exclude<ConversationRunKind, ''> | 'conversation_message'
    available_views?: ConversationRecordView[]
}

export interface ConversationRecordsResponse {
    items: ConversationRecordItem[]
    total: number
    page: number
    size: number
    stats: ConversationRecordStats
    snapshot_stats: ConversationRecordStats
    meta: ConversationRecordMeta
}

export interface ConversationRecordStats {
    conversation_count: number
    message_count: number
    record_count: number
    feedback_count: number
    positive_feedback_count: number
    negative_feedback_count: number
    run_count: number
    workflow_run_count: number
    platform_run_count: number
    device_control_count: number
    device_status_count: number
    platform_test_count: number
    abnormal_count: number
}

export interface ConversationRecordMeta {
    generated_at: string
    cache_ttl_seconds: number
    conversation_limit: number
    message_limit_per_conversation: number
    local_run_limit: number
    data_sources: string[]
    dify_available: boolean
    dify_error: string
    snapshot_truncated: boolean
    conversation_has_more: boolean
    message_truncated_conversations: number
    message_load_error_count: number
    local_run_has_more?: boolean
    cache: 'hit' | 'miss' | 'shared' | string
}

/**
 * 流式对话 — 使用 fetch + ReadableStream 消费 SSE
 */
export async function chatStream(
    query: string,
    conversationId: string = '',
    onEvent: (event: DifySSEEvent) => void,
    signal?: AbortSignal,
): Promise<void> {
    const token = getToken()
    const requestController = new AbortController()
    let connectTimedOut = false
    const handleExternalAbort = () => requestController.abort()
    if (signal?.aborted) requestController.abort()
    else signal?.addEventListener('abort', handleExternalAbort, { once: true })
    const connectTimeoutId = window.setTimeout(() => {
        connectTimedOut = true
        requestController.abort()
    }, CHAT_WRITE_TIMEOUT_MS)

    try {
        let res: Response
        try {
            res = await fetch(`${API_BASE}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
                body: JSON.stringify({ query, conversation_id: conversationId }),
                signal: requestController.signal,
            })
        } catch (error) {
            if (connectTimedOut) {
                throw new Error('智能体服务 20 秒内未建立响应连接，请检查平台后端、Dify 和网络状态后重试')
            }
            if (error instanceof DOMException && error.name === 'AbortError') throw error
            if (typeof navigator !== 'undefined' && navigator.onLine === false) {
                throw new Error('当前设备已离线，请恢复网络后重试')
            }
            throw new Error('无法连接平台后端，请刷新页面或检查本地服务状态后重试')
        } finally {
            window.clearTimeout(connectTimeoutId)
        }

        if (!res.ok) {
            if (res.status === 401) {
                handleUnauthorized()
                throw new Error('登录已过期，正在返回登录页')
            }
            throw await responseError(res, '智能体请求失败')
        }

        const reader = res.body?.getReader()
        if (!reader) throw new Error('浏览器未收到可读取的流式响应')

        const decoder = new TextDecoder()
        let buffer = ''
        let terminalEventReceived = false

        while (true) {
            let timeoutId: ReturnType<typeof setTimeout> | undefined
            const idleTimeout = new Promise<never>((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error('智能体 45 秒内未返回新内容，本次等待已结束，请重试或检查 Dify 运行状态')), CHAT_STREAM_IDLE_TIMEOUT_MS)
            })
            let chunk: ReadableStreamReadResult<Uint8Array>
            try {
                chunk = await Promise.race([reader.read(), idleTimeout])
            } catch (error) {
                await reader.cancel().catch(() => undefined)
                throw error
            } finally {
                if (timeoutId !== undefined) clearTimeout(timeoutId)
            }
            const { done, value } = chunk
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''

            for (const line of lines) {
                if (line.startsWith('data:')) {
                    const jsonStr = line.slice(5).trim()
                    if (!jsonStr) continue
                    try {
                        const event = JSON.parse(jsonStr) as DifySSEEvent
                        if (event.event === 'message_end' || event.event === 'workflow_finished' || event.event === 'error') terminalEventReceived = true
                        onEvent(event)
                    } catch {
                        // ignore parse errors
                    }
                }
            }
        }

        if (!terminalEventReceived) {
            throw new Error('智能体响应提前结束，已保留收到的内容，请重试确认完整结果')
        }
    } finally {
        window.clearTimeout(connectTimeoutId)
        signal?.removeEventListener('abort', handleExternalAbort)
    }
}

/**
 * 获取会话列表
 */
export async function getConversations(lastId = '', limit = 20, force = false, signal?: AbortSignal): Promise<ConversationsResponse> {
    const key = readCacheKey([lastId, limit])
    const cached = conversationCache.get(key)
    if (!force && cached && cached.expiresAt > Date.now()) return structuredClone(cached.value)
    const running = conversationPending.get(key)
    if (!force && running) return structuredClone(await waitForSharedRead(running, signal))
    const generation = (conversationGeneration.get(key) || 0) + 1
    conversationGeneration.set(key, generation)
    const pending = apiClient.get<ConversationsResponse>('/chat/conversations', {
        params: { last_id: lastId, limit },
        timeoutMs: CHAT_READ_TIMEOUT_MS,
    }).then((value) => {
        if (conversationGeneration.get(key) === generation) {
            conversationCache.set(key, { value, expiresAt: Date.now() + CHAT_READ_CACHE_TTL_MS })
        }
        return value
    }).finally(() => {
        if (conversationPending.get(key) === pending) conversationPending.delete(key)
    })
    conversationPending.set(key, pending)
    return structuredClone(await waitForSharedRead(pending, signal))
}

export async function getAgentRuntimeOverview(refresh = false, signal?: AbortSignal): Promise<AgentRuntimeOverview> {
    const key = readCacheKey(['overview'])
    const cached = overviewCache.get(key)
    if (!refresh && cached && cached.expiresAt > Date.now()) return structuredClone(cached.value)
    const running = overviewPending.get(key)
    if (!refresh && running) return structuredClone(await waitForSharedRead(running, signal))
    const generation = (overviewGeneration.get(key) || 0) + 1
    overviewGeneration.set(key, generation)
    const pending = apiClient.get<AgentRuntimeOverview>('/chat/overview', {
        params: { refresh },
        timeoutMs: CHAT_READ_TIMEOUT_MS,
    }).then((value) => {
        if (overviewGeneration.get(key) === generation) {
            overviewCache.set(key, { value, expiresAt: Date.now() + CHAT_READ_CACHE_TTL_MS })
        }
        return value
    }).finally(() => {
        if (overviewPending.get(key) === pending) overviewPending.delete(key)
    })
    overviewPending.set(key, pending)
    return structuredClone(await waitForSharedRead(pending, signal))
}

/**
 * 获取历史消息
 */
export async function getMessages(conversationId: string, firstId = '', limit = 20, force = false, signal?: AbortSignal): Promise<MessagesResponse> {
    const key = readCacheKey([conversationId, firstId, limit])
    const cached = messageCache.get(key)
    if (!force && cached && cached.expiresAt > Date.now()) return structuredClone(cached.value)
    const running = messagePending.get(key)
    if (!force && running) return structuredClone(await waitForSharedRead(running, signal))
    const generation = (messageGeneration.get(key) || 0) + 1
    messageGeneration.set(key, generation)
    const pending = apiClient.get<MessagesResponse>('/chat/messages', {
        params: { conversation_id: conversationId, first_id: firstId, limit },
        timeoutMs: CHAT_READ_TIMEOUT_MS,
    }).then((value) => {
        if (messageGeneration.get(key) === generation) {
            messageCache.set(key, { value, expiresAt: Date.now() + CHAT_READ_CACHE_TTL_MS })
        }
        return value
    }).finally(() => {
        if (messagePending.get(key) === pending) messagePending.delete(key)
    })
    messagePending.set(key, pending)
    return structuredClone(await waitForSharedRead(pending, signal))
}

/**
 * 删除会话
 */
export async function deleteConversation(conversationId: string, signal?: AbortSignal): Promise<void> {
    try {
        await apiClient.delete(`/chat/conversations/${encodeURIComponent(conversationId)}`, { timeoutMs: 20_000, signal })
    } finally {
        // 中止只代表浏览器停止等待，服务端写入仍可能已经发生。
        clearChatReadCache(conversationId)
        clearConversationRecordCache()
        clearWorkflowRunDetailCache()
    }
}

export async function stopChatStream(taskId: string, signal?: AbortSignal): Promise<void> {
    try {
        await apiClient.post('/chat/stop', { task_id: taskId }, { timeoutMs: CHAT_WRITE_TIMEOUT_MS, signal })
    } finally {
        // 停止指令会改变运行记录；无论确认、超时或取消等待，都不能继续使用旧快照。
        clearChatReadCache()
        clearConversationRecordCache()
        clearWorkflowRunDetailCache()
    }
}

export async function submitMessageFeedback(
    messageId: string,
    rating: 'like' | 'dislike',
    content = '',
    signal?: AbortSignal,
): Promise<void> {
    try {
        await apiClient.post(`/chat/messages/${encodeURIComponent(messageId)}/feedback`, { rating, content }, { timeoutMs: 20_000, signal })
    } finally {
        // 请求中止后无法断言 Dify 是否已落库，因此下一次读取必须绕开旧缓存。
        messageCache.clear()
        messagePending.clear()
        clearConversationRecordCache()
    }
}

export async function getWorkflowRunDetail(workflowRunId: string, signal?: AbortSignal, force = false): Promise<WorkflowRunDetail> {
    const key = readCacheKey(['workflow-detail', workflowRunId])
    const cached = workflowDetailCache.get(key)
    if (!force && cached && cached.expiresAt > Date.now()) return structuredClone(cached.value)
    const running = workflowDetailPending.get(key)
    if (!force && running) return structuredClone(await waitForSharedRead(running, signal))

    const generation = (workflowDetailGeneration.get(key) || 0) + 1
    workflowDetailGeneration.set(key, generation)
    const pending = apiClient.get<WorkflowRunDetail>(`/chat/workflow-runs/${encodeURIComponent(workflowRunId)}`, {
        timeoutMs: 10_000,
        signal: force ? signal : undefined,
    }).then((value) => {
        if (workflowDetailGeneration.get(key) === generation) {
            workflowDetailCache.set(key, { value, expiresAt: Date.now() + CHAT_READ_CACHE_TTL_MS })
        }
        return value
    }).finally(() => {
        if (workflowDetailPending.get(key) === pending) workflowDetailPending.delete(key)
    })

    if (force) return structuredClone(await pending)
    workflowDetailPending.set(key, pending)
    return structuredClone(await waitForSharedRead(pending, signal))
}

export async function getConversationRecords(params: {
    view: ConversationRecordView
    keyword?: string
    conversationId?: string
    rating?: '' | 'like' | 'dislike'
    hasWorkflowRun?: boolean
    runKind?: ConversationRunKind
    startTime?: number
    endTime?: number
    page?: number
    size?: number
    groupConversations?: boolean
    refresh?: boolean
}, signal?: AbortSignal): Promise<ConversationRecordsResponse> {
    const query: Record<string, string | number | boolean> = {
        view: params.view,
        page: params.page || 1,
        size: params.size || 20,
    }
    if (params.keyword) query.keyword = params.keyword
    if (params.conversationId) query.conversation_id = params.conversationId
    if (params.rating) query.rating = params.rating
    if (typeof params.hasWorkflowRun === 'boolean') query.has_workflow_run = params.hasWorkflowRun
    if (params.runKind) query.run_kind = params.runKind
    if (params.startTime) query.start_time = params.startTime
    if (params.endTime) query.end_time = params.endTime
    if (params.groupConversations) query.group_conversations = true
    if (params.refresh) query.refresh = true

    const queryKey = Object.entries(query)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => `${name}=${String(value)}`)
        .join('&')
    const key = `${encodeURIComponent(getAuthCacheScope())}:${queryKey}`
    const cached = conversationRecordCache.get(key)
    if (!params.refresh && cached && cached.expiresAt > Date.now()) return cached.value
    const active = conversationRecordPending.get(key)
    if (!params.refresh && active) return waitForSharedRead(active, signal)

    const requestGeneration = conversationRecordGeneration
    const pending = apiClient.get<ConversationRecordsResponse>('/chat/records', {
        params: query,
        timeoutMs: 15_000,
        signal: params.refresh ? signal : undefined,
    })
        .then((value) => {
            if (
                conversationRecordGeneration === requestGeneration
                && (params.refresh || conversationRecordPending.get(key) === pending)
            ) {
                conversationRecordCache.set(key, { value, expiresAt: Date.now() + CONVERSATION_RECORD_CACHE_TTL_MS })
            }
            return value
        })
        .finally(() => {
            if (conversationRecordPending.get(key) === pending) conversationRecordPending.delete(key)
        })
    if (params.refresh) return pending
    conversationRecordPending.set(key, pending)
    return waitForSharedRead(pending, signal)
}

export async function exportConversationRecords(params: {
    view: ConversationRecordView
    keyword?: string
    conversationId?: string
    rating?: '' | 'like' | 'dislike'
    hasWorkflowRun?: boolean
    runKind?: ConversationRunKind
    startTime?: number
    endTime?: number
    format: 'csv' | 'json'
}, signal?: AbortSignal): Promise<{ blob: Blob; filename: string; count: number; truncated: boolean; snapshotTruncated: boolean }> {
    const query: Record<string, string | number | boolean> = { view: params.view, format: params.format }
    if (params.keyword) query.keyword = params.keyword
    if (params.conversationId) query.conversation_id = params.conversationId
    if (params.rating) query.rating = params.rating
    if (typeof params.hasWorkflowRun === 'boolean') query.has_workflow_run = params.hasWorkflowRun
    if (params.runKind) query.run_kind = params.runKind
    if (params.startTime) query.start_time = params.startTime
    if (params.endTime) query.end_time = params.endTime
    const result = await apiClient.download('/chat/records/export', { params: query, timeoutMs: 45_000, signal })
    const disposition = result.headers.get('content-disposition')
    const filename = disposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
        || disposition?.match(/filename="?([^";]+)"?/i)?.[1]
        || `conversation-records.${params.format}`
    return {
        blob: result.blob,
        filename: decodeURIComponent(filename),
        count: Number(result.headers.get('X-Export-Count') || 0),
        truncated: result.headers.get('X-Export-Truncated') === 'true',
        snapshotTruncated: result.headers.get('X-Snapshot-Truncated') === 'true',
    }
}

const CONVERSATION_RECORD_CACHE_TTL_MS = 30_000
const conversationRecordCache = new Map<string, { expiresAt: number; value: ConversationRecordsResponse }>()
const conversationRecordPending = new Map<string, Promise<ConversationRecordsResponse>>()
let conversationRecordGeneration = 0

export function clearConversationRecordCache() {
    conversationRecordGeneration += 1
    conversationRecordCache.clear()
    conversationRecordPending.clear()
}
