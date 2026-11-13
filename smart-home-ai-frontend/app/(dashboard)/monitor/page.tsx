'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
    RefreshCw, Cpu, Bot,
    BarChart2, Terminal, Network,
    Home, Database, Router, CheckCircle, AlertTriangle,
    User, Sparkles, Loader2, Server,
    Download, Search, X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
    fetchActivityStats,
    fetchAgentQuery,
    fetchAIStatus,
    fetchControlTrends,
    fetchOperationLogList,
    fetchResources,
    fetchSensorHistory,
    fetchServiceHealth,
} from '@/lib/api/monitor'
import { fetchDevices } from '@/lib/api/devices'
import type {
    ActivityStats,
    AgentQueryResponse,
    AIStatus,
    ControlTrends,
    OperationLogItem,
    ResourceMetrics,
    SensorHistory,
    ServiceStatus,
} from '@/lib/api/monitor'
import type { DeviceSummary, LogicalDevice } from '@/lib/api/devices'
import { TechnicalId } from '@/components/ui/TechnicalId'
import { useAuth } from '@/lib/hooks/useAuth'
import { businessErrorMessage } from '@/lib/ui/business-error'

type PrimaryResourceKey = 'resources' | 'ai' | 'activity' | 'devices' | 'logs'
type SlowResourceKey = 'services' | 'trends'
type SnapshotSectionKey = PrimaryResourceKey | SlowResourceKey | 'sensor_history' | 'agent_query_result'
type QueuedResourceRead<T extends string> = {
    keys: Set<T>
    promise: Promise<void>
    resolve: () => void
}

const PRIMARY_RESOURCE_KEYS: PrimaryResourceKey[] = ['resources', 'ai', 'activity', 'devices', 'logs']
const SLOW_RESOURCE_KEYS: SlowResourceKey[] = ['services', 'trends']

/* ═══════════════════════════════════════════
   Components
   ═══════════════════════════════════════════ */

interface CircularProgressProps {
    value: number | null
    label: string
    sublabel: string
    strokeClass: string
}

const CircularProgress = ({ value, label, sublabel, strokeClass }: CircularProgressProps) => {
    const radius = 40
    const circumference = 2 * Math.PI * radius
    const safeValue = value === null ? 0 : Math.min(100, Math.max(0, value))
    const offset = circumference - (safeValue / 100) * circumference

    return (
        <div className="glass-card p-6 rounded-2xl flex flex-col items-center text-center shadow-[0_8px_30px_rgb(0,0,0,0.04)]">
            <div className="relative w-24 h-24 mb-4">
                <svg className="w-full h-full" style={{ transform: 'rotate(-90deg)' }}>
                    {/* Background Circle */}
                    <circle cx="48" cy="48" r={radius} fill="transparent" stroke="currentColor" strokeWidth="8" className="text-slate-100" />
                    {/* Progress Circle */}
                    <circle
                        cx="48" cy="48" r={radius} fill="transparent" stroke="currentColor" strokeWidth="8"
                        strokeDasharray={circumference} strokeDashoffset={offset}
                        strokeLinecap="round"
                        className={`${strokeClass} transition-all duration-1000 ease-out`}
                    />
                </svg>
                <div className="absolute inset-0 flex items-center justify-center font-bold text-2xl text-slate-800 font-headline">
                    {value === null ? '—' : `${value}%`}
                </div>
            </div>
            <h3 className="font-semibold text-slate-800 font-body">{label}</h3>
            <p className="text-xs text-slate-500 font-medium mt-1 font-body">{sublabel}</p>
        </div>
    )
}

interface DialogueTrendsChartProps {
    data: { time: string; today: number; yesterday: number }[] | null
    loading: boolean
}

const DialogueTrendsChart = ({ data, loading }: DialogueTrendsChartProps) => {
    if (!data) {
        return (
            <div className="mt-4 flex h-[200px] w-full items-center justify-center text-center text-sm font-medium text-slate-300">
                {loading ? '正在读取真实操作趋势' : '操作趋势暂未取得'}
            </div>
        )
    }
    const maxVal = Math.max(...data.flatMap(d => [d.today, d.yesterday]), 1)
    const hasData = data.some(d => d.today > 0 || d.yesterday > 0)
    const chartH = 200 // chart area height in px

    return (
        <div className="mt-4 w-full">
            {/* Chart area */}
            <div className="relative" style={{ height: `${chartH}px` }}>
                {/* Y-axis grid lines */}
                {[0, 0.25, 0.5, 0.75, 1].map((ratio, i) => (
                    <div
                        key={i}
                        className="absolute left-8 right-0 border-t border-dashed border-slate-100 flex items-center"
                        style={{ top: `${(1 - ratio) * chartH}px` }}
                    >
                        <span className="absolute -left-8 w-7 text-right text-[10px] leading-4 text-slate-400">
                            {Math.round(maxVal * ratio)}
                        </span>
                    </div>
                ))}

                {/* No data hint */}
                {!hasData && (
                    <div className="absolute inset-0 flex items-center justify-center z-10">
                        <span className="max-w-sm px-6 text-center text-sm font-medium leading-6 text-slate-400">今日和昨日暂无已确认成功的设备控制；已下发但待实机确认的记录不计入此趋势。</span>
                    </div>
                )}

                {/* Bar groups */}
                <div className="absolute left-7 right-0 bottom-0 flex items-end justify-around" style={{ height: `${chartH}px` }}>
                    {data.map((d, i) => {
                        const tPx = maxVal > 0 ? (d.today / maxVal) * chartH : 0
                        const yPx = maxVal > 0 ? (d.yesterday / maxVal) * chartH : 0
                        const tH = d.today > 0 ? Math.max(tPx, 8) : 0
                        const yH = d.yesterday > 0 ? Math.max(yPx, 8) : 0
                        return (
                            <div key={i} className="flex min-w-0 flex-col items-center group relative" style={{ width: '7%' }}>
                                {/* Bars */}
                                <div className="flex items-end justify-center gap-[3px] flex-1 w-full">
                                    {/* Yesterday — only render if has data */}
                                    {yH > 0 && (
                                        <div
                                            className="rounded-t-[3px] transition-all duration-500"
                                            style={{
                                                width: '10px',
                                                height: `${yH}px`,
                                                backgroundColor: '#93C5FD',
                                            }}
                                        />
                                    )}
                                    {/* Today — only render if has data */}
                                    {tH > 0 && (
                                        <div
                                            className="rounded-t-[3px] transition-all duration-500"
                                            style={{
                                                width: '10px',
                                                height: `${tH}px`,
                                                backgroundColor: '#2563EB',
                                            }}
                                        />
                                    )}
                                </div>
                                {/* X-axis label — inside same container = perfect alignment */}
                                <span className={`${i % 2 === 1 ? 'hidden sm:inline' : ''} mt-2 whitespace-nowrap text-[10px] font-bold text-slate-400 font-body`}>
                                    {d.time}
                                </span>
                                {/* Value label */}
                                {d.today > 0 && (
                                    <span
                                        className="absolute text-[10px] font-bold text-blue-700"
                                        style={{ bottom: `${tH + 24}px`, left: '50%', transform: 'translateX(-50%)' }}
                                    >
                                        {d.today}
                                    </span>
                                )}
                                {/* Hover tooltip */}
                                {(d.today > 0 || d.yesterday > 0) && (
                                    <div className="absolute left-1/2 -translate-x-1/2 bg-slate-800 text-white text-[10px] px-2.5 py-1 rounded-md opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-20 shadow-lg"
                                         style={{ bottom: `${Math.max(tH, yH) + 40}px` }}>
                                        今日 {d.today} / 昨日 {d.yesterday}
                                    </div>
                                )}
                            </div>
                        )
                    })}
                </div>
            </div>
        </div>
    )
}

interface SensorHistoryChartProps {
    temperature: { time: string; value: number }[]
    humidity: { time: string; value: number }[]
    pm25: { time: string; value: number }[]
}

type SensorChartSeries = {
    key: string
    label: string
    unit: string
    color: string
    fill: string
    baselineMinimum: number
    baselineMaximum: number
    points: { time: string; timestamp: number; value: number }[]
}

function sensorTimestamp(value: string) {
    const timestamp = new Date(value).getTime()
    return Number.isFinite(timestamp) ? timestamp : null
}

function formatSensorChartTime(timestamp: number, rangeMs: number) {
    const value = new Date(timestamp)
    if (rangeMs > 48 * 60 * 60 * 1000) {
        return value.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit' })
    }
    return value.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

const SensorHistoryChart = ({ temperature, humidity, pm25 }: SensorHistoryChartProps) => {
    const height = 248
    const width = 1000
    const normalizePoints = (points: { time: string; value: number }[]) => points
        .flatMap((point) => {
            const timestamp = sensorTimestamp(point.time)
            const value = Number(point.value)
            return timestamp === null || !Number.isFinite(value) ? [] : [{ ...point, timestamp, value }]
        })
        .sort((left, right) => left.timestamp - right.timestamp)
    const series: SensorChartSeries[] = [
        { key: 'temperature', label: '温度', unit: '°C', color: '#2563eb', fill: 'url(#grad-temp)', baselineMinimum: 0, baselineMaximum: 50, points: normalizePoints(temperature) },
        { key: 'humidity', label: '湿度', unit: '%', color: '#10b981', fill: 'url(#grad-hum)', baselineMinimum: 0, baselineMaximum: 100, points: normalizePoints(humidity) },
        { key: 'pm25', label: 'PM2.5', unit: 'μg/m³', color: '#f59e0b', fill: 'url(#grad-pm25)', baselineMinimum: 0, baselineMaximum: 200, points: normalizePoints(pm25) },
    ]
    const allTimestamps = series.flatMap((item) => item.points.map((point) => point.timestamp))

    if (!allTimestamps.length) {
        return (
            <div className="flex h-80 w-full items-center justify-center rounded-xl border border-slate-100 bg-white/50 px-6 text-center text-sm leading-6 text-slate-400">
                当前时间范围内没有真实传感器历史，趋势图保持空白。
            </div>
        )
    }

    const startTimestamp = Math.min(...allTimestamps)
    const endTimestamp = Math.max(...allTimestamps)
    const rangeMs = Math.max(0, endTimestamp - startTimestamp)
    const xPosition = (timestamp: number) => rangeMs > 0
        ? ((timestamp - startTimestamp) / rangeMs) * width
        : width / 2
    const yPosition = (value: number, minimum: number, maximum: number) => {
        const normalized = (value - minimum) / Math.max(1, maximum - minimum)
        return height - normalized * height
    }
    const chartSeries = series.map((item) => {
        const observedMinimum = item.points.length ? Math.min(...item.points.map((point) => point.value)) : item.baselineMinimum
        const observedMaximum = item.points.length ? Math.max(...item.points.map((point) => point.value)) : item.baselineMaximum
        const minimum = Math.min(item.baselineMinimum, Math.floor(observedMinimum))
        const maximum = Math.max(item.baselineMaximum, Math.ceil(observedMaximum))
        const coordinates = item.points.map((point) => ({
            ...point,
            x: xPosition(point.timestamp),
            y: yPosition(point.value, minimum, maximum),
        }))
        const path = coordinates.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ')
        const area = coordinates.length > 1
            ? `${path} L ${coordinates.at(-1)?.x ?? width} ${height} L ${coordinates[0].x} ${height} Z`
            : ''
        const markerStep = Math.max(1, Math.ceil(coordinates.length / 12))
        const markers = coordinates.filter((_, index) => index % markerStep === 0 || index === coordinates.length - 1)
        return { ...item, minimum, maximum, rangeExtended: minimum !== item.baselineMinimum || maximum !== item.baselineMaximum, coordinates, path, area, markers }
    })
    const tickRatios = rangeMs > 0 ? [0, 0.25, 0.5, 0.75, 1] : [0.5]

    return (
        <div className="w-full overflow-hidden rounded-xl border border-slate-100 bg-white/50 backdrop-blur-sm">
            <div className="flex flex-wrap gap-x-4 gap-y-1 border-b border-slate-100 px-4 py-2 text-xs font-semibold text-slate-500">
                {chartSeries.map((item) => <span key={item.key}>{item.label}量程 {item.minimum}–{item.maximum}{item.unit}{item.rangeExtended ? '（按观测值扩展）' : ''}</span>)}
            </div>
            <div className="relative h-[280px] px-3 pt-3">
            <svg viewBox={`0 0 ${width} ${height}`} className="h-[248px] w-full" preserveAspectRatio="none" role="img" aria-label="温度、湿度和 PM2.5 真实历史趋势">
                <defs>
                    <linearGradient id="grad-temp" x1="0" x2="0" y1="0" y2="1">
                        <stop offset="0%" stopColor="#2563eb" stopOpacity="0.2" />
                        <stop offset="100%" stopColor="#2563eb" stopOpacity="0" />
                    </linearGradient>
                    <linearGradient id="grad-hum" x1="0" x2="0" y1="0" y2="1">
                        <stop offset="0%" stopColor="#10b981" stopOpacity="0.1" />
                        <stop offset="100%" stopColor="#10b981" stopOpacity="0" />
                    </linearGradient>
                    <linearGradient id="grad-pm25" x1="0" x2="0" y1="0" y2="1">
                        <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.1" />
                        <stop offset="100%" stopColor="#f59e0b" stopOpacity="0" />
                    </linearGradient>
                </defs>

                {[0.25, 0.5, 0.75].map((percent, i) => (
                    <line key={i} x1="0" y1={height * percent} x2={width} y2={height * percent} stroke="#f1f5f9" strokeWidth="2" />
                ))}

                {chartSeries.map((item) => item.area ? <path key={`${item.key}-area`} d={item.area} fill={item.fill} /> : null)}
                {chartSeries.map((item) => item.path ? <path key={`${item.key}-line`} d={item.path} fill="none" stroke={item.color} strokeWidth="3" strokeLinejoin="round" vectorEffect="non-scaling-stroke" /> : null)}
                {chartSeries.flatMap((item) => item.markers.map((point) => (
                    <circle key={`${item.key}-${point.timestamp}`} cx={point.x} cy={point.y} r="4" fill={item.color} stroke="white" strokeWidth="2" vectorEffect="non-scaling-stroke" tabIndex={0}>
                        <title>{item.label} {point.value}{item.unit} · {new Date(point.timestamp).toLocaleString('zh-CN')}</title>
                    </circle>
                )))}
            </svg>
            <div className="pointer-events-none absolute inset-x-3 bottom-1 grid text-[10px] font-semibold text-slate-400" style={{ gridTemplateColumns: `repeat(${tickRatios.length}, minmax(0, 1fr))` }}>
                {tickRatios.map((ratio, index) => (
                    <span key={ratio} className={index === 0 ? 'text-left' : index === tickRatios.length - 1 ? 'text-right' : 'text-center'}>
                        {formatSensorChartTime(startTimestamp + rangeMs * ratio, rangeMs)}
                    </span>
                ))}
            </div>
            </div>
        </div>
    )
}

/* ═══════════════════════════════════════════
   Service Icon Mapping
   ═══════════════════════════════════════════ */

const SERVICE_ICONS: Record<string, LucideIcon> = {
    'FastAPI 后端': Server,
    'Ollama 推理引擎': Terminal,
    'Home Assistant': Home,
    'Dify 智能体框架': Network,
    'InfluxDB 时序库': Database,
    'MySQL / Redis': Database,
    'Nginx 网关': Router,
}

const STATUS_STYLE: Record<string, string> = {
    running: 'bg-emerald-100 text-emerald-700',
    stopped: 'bg-red-100 text-red-700',
    error: 'bg-amber-100 text-amber-700',
    auth_error: 'bg-amber-100 text-amber-700',
    unconfigured: 'bg-slate-200 text-slate-600',
}

const STATUS_TEXT: Record<string, string> = {
    running: '运行中',
    stopped: '当前不可用',
    error: '服务异常',
    auth_error: '认证异常',
    unconfigured: '未配置',
}

const DEVICE_STATUS_STYLE: Record<string, string> = {
    online: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100',
    offline: 'bg-amber-50 text-amber-700 ring-1 ring-amber-100',
    unmapped: 'bg-slate-100 text-slate-500 ring-1 ring-slate-200',
    disabled: 'bg-slate-100 text-slate-500 ring-1 ring-slate-200',
}

const DEVICE_STATUS_TEXT: Record<string, string> = {
    online: '在线',
    offline: '离线 / 待联调',
    unmapped: '未映射',
    disabled: '已禁用',
}

const DEVICE_CATEGORY_TEXT: Record<string, string> = {
    light: '灯光',
    climate: '环境',
    sensor: '传感器',
    switch: '开关',
    lock: '门锁',
    cover: '窗帘',
    camera: '摄像头',
    appliance: '家电',
    media: '影音',
}

const DEVICE_VALUE_TEXT: Record<string, string> = {
    on: '开启',
    off: '关闭',
    open: '已打开',
    closed: '已关闭',
    locked: '已锁定',
    unlocked: '未锁定',
    home: '在家',
    not_home: '离家',
    idle: '待机',
}

function deviceStateText(value: unknown, emptyLabel = '状态未取得') {
    const normalized = String(value ?? '').trim()
    if (!normalized) return emptyLabel
    if (DEVICE_VALUE_TEXT[normalized]) return DEVICE_VALUE_TEXT[normalized]
    if (/^-?\d+(?:\.\d+)?$/.test(normalized) || /[\u4e00-\u9fff]/.test(normalized)) return normalized
    return '状态待确认'
}

const GATEWAY_TYPE_TEXT: Record<string, string> = {
    homeassistant: 'Home Assistant',
    xiaomi: '小米设备接入',
    mqtt: 'MQTT',
    modbus: 'Modbus',
    http: 'HTTP',
}

const ACTIVITY_FIELD_TEXT: Record<string, string> = {
    conversations_today: '今日对话',
    controls_today: '今日控制',
    knowledge_docs: '知识库文档',
    model_count: '本地模型',
}

const SENSOR_SOURCE_TEXT: Record<string, string> = {
    no_real_data: '暂无真实数据',
    partial: '部分真实数据',
    influxdb: 'InfluxDB 时序数据',
    home_assistant_history: 'Home Assistant 历史数据',
}

const QUERY_STATUS_TEXT: Record<string, string> = {
    success: '查询成功',
    no_real_data: '暂无真实数据',
}

const QUERY_TYPE_TEXT: Record<string, string> = {
    realtime: '设备实时状态',
    device_history: '设备历史记录',
    sensor_history: '传感器趋势',
    services: '服务健康状态',
}

const DATA_SOURCE_TEXT: Record<string, string> = {
    no_real_data: '暂无真实数据',
    partial: '部分真实数据',
    influxdb: 'InfluxDB 时序库',
    home_assistant_history: 'Home Assistant 历史记录',
    home_assistant_realtime_state: 'Home Assistant 实时回读',
    platform_service_health: '平台服务健康检查',
}

function valueText(value: number | null | undefined, suffix = '') {
    return value === null || value === undefined ? '—' : `${value}${suffix}`
}

function sensorSourceText(source?: string) {
    if (!source) return '正在读取'
    return SENSOR_SOURCE_TEXT[source] || '其他数据源'
}

type QueryResultRecord = Record<string, unknown>

function queryResultRecord(value: unknown): QueryResultRecord {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as QueryResultRecord : {}
}

function queryResultRecords(value: unknown): QueryResultRecord[] {
    return Array.isArray(value) ? value.filter((item): item is QueryResultRecord => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : []
}

function queryObjectText(result: AgentQueryResponse) {
    if (result.query_type === 'services') return '平台与外部服务'
    if (result.query_type === 'sensor_history') return `温度、湿度与 PM2.5 · 最近 ${result.hours || 24} 小时`
    return result.entity_id ? '指定设备或传感器' : '设备对象未匹配'
}

function formatQueryTime(value: unknown) {
    if (typeof value !== 'string' || !value) return '时间未记录'
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('zh-CN', { hour12: false })
}

function QueryBusinessResult({ response }: { response: AgentQueryResponse }) {
    const result = queryResultRecord(response.result)

    if (response.query_type === 'services') {
        const services = queryResultRecords(result.services)
        const running = services.filter((service) => service.status === 'running').length
        return (
            <div className="overflow-hidden rounded-lg border border-white/10">
                <div className="flex items-center justify-between gap-4 border-b border-white/10 bg-white/5 px-4 py-3">
                    <span className="text-sm font-semibold text-slate-200">服务状态汇总</span>
                    <span className="text-xs font-bold text-emerald-200">{running}/{services.length} 项运行正常</span>
                </div>
                <div className="divide-y divide-white/10">
                    {services.map((service, index) => {
                        const status = typeof service.status === 'string' ? service.status : ''
                        const latency = typeof service.latency_ms === 'number' ? `${service.latency_ms} 毫秒` : ''
                        return (
                            <div key={`${String(service.name || '服务')}-${index}`} className="grid gap-1 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-4">
                                <div className="min-w-0">
                                    <p className="break-words text-sm font-semibold text-white">{String(service.name || '未命名服务')}</p>
                                    <p className="mt-1 break-words text-xs leading-5 text-slate-400">{String(service.diagnostic || '未返回诊断说明')}</p>
                                </div>
                                <div className="flex items-center gap-2 sm:justify-end">
                                    {latency ? <span className="text-xs tabular-nums text-slate-400">{latency}</span> : null}
                                    <span className={`text-xs font-bold ${status === 'running' ? 'text-emerald-200' : 'text-amber-200'}`}>{STATUS_TEXT[status] || '状态待确认'}</span>
                                </div>
                            </div>
                        )
                    })}
                    {!services.length ? <p className="px-4 py-6 text-center text-sm text-slate-400">服务列表未取得</p> : null}
                </div>
            </div>
        )
    }

    if (response.query_type === 'sensor_history') {
        const metrics = queryResultRecord(queryResultRecord(result._meta).metrics)
        const rows = ['temperature', 'humidity', 'pm25'].map((key) => {
            const metric = queryResultRecord(metrics[key])
            const points = queryResultRecords(result[key])
            return {
                key,
                label: String(metric.label || ({ temperature: '温度', humidity: '湿度', pm25: 'PM2.5' } as Record<string, string>)[key]),
                count: points.length,
                source: sensorSourceText(typeof metric.source === 'string' ? metric.source : undefined),
                coverage: points.length ? `${formatQueryTime(points[0].time)} 至 ${formatQueryTime(points.at(-1)?.time)}` : String(metric.missing_reason || '当前范围没有真实历史点'),
            }
        })
        return (
            <div className="divide-y divide-white/10 overflow-hidden rounded-lg border border-white/10">
                {rows.map((row) => (
                    <div key={row.key} className="grid gap-1 px-4 py-3 sm:grid-cols-[72px_minmax(0,1fr)_auto] sm:items-center sm:gap-4">
                        <strong className="text-sm text-white">{row.label}</strong>
                        <span className="min-w-0 break-words text-xs leading-5 text-slate-400">{row.coverage}</span>
                        <span className="text-xs font-bold tabular-nums text-slate-200">{row.count} 个真实点{row.count ? ` · ${row.source}` : ''}</span>
                    </div>
                ))}
            </div>
        )
    }

    if (response.query_type === 'device_history') {
        const history = queryResultRecords(result.history)
        const latest = history.at(-1)
        return (
            <div className="grid gap-3 sm:grid-cols-3">
                <QuerySummary label="历史记录" value={`${history.length} 条`} />
                <QuerySummary label="最近状态" value={latest ? deviceStateText(latest.state) : '暂无记录'} />
                <QuerySummary label="最近变化" value={latest ? formatQueryTime(latest.time) : '时间未取得'} />
            </div>
        )
    }

    const state = typeof result.state === 'string' ? result.state : ''
    return (
        <div className="grid gap-3 sm:grid-cols-3">
            <QuerySummary label="设备名称" value={String(result.name || '设备名称未取得')} />
            <QuerySummary label="当前状态" value={deviceStateText(state)} />
            <QuerySummary label="最后更新" value={formatQueryTime(result.last_updated)} />
        </div>
    )
}

function QuerySummary({ label, value }: { label: string; value: string }) {
    return (
        <div className="min-w-0 rounded-lg bg-white/8 px-4 py-3">
            <p className="text-xs font-semibold text-slate-400">{label}</p>
            <p className="mt-2 break-words text-sm font-semibold leading-6 text-white">{value}</p>
        </div>
    )
}

function sensorSeriesSummary(points: { time: string; value: number }[], unit: string) {
    const values = points.map(point => Number(point.value)).filter(Number.isFinite)
    if (!values.length) return { latest: `—${unit}`, range: '范围未取得', pointCount: 0 }
    const latest = values.at(-1) as number
    const minimum = Math.min(...values)
    const maximum = Math.max(...values)
    return {
        latest: `${latest}${unit}`,
        range: minimum === maximum ? `范围 ${minimum}${unit}` : `范围 ${minimum}–${maximum}${unit}`,
        pointCount: values.length,
    }
}

function sensorCoverageText(firstPointAt?: string, lastPointAt?: string) {
    const first = firstPointAt ? sensorTimestamp(firstPointAt) : null
    const last = lastPointAt ? sensorTimestamp(lastPointAt) : null
    if (first === null || last === null) return '实际覆盖时间未取得'
    const format = (timestamp: number) => new Date(timestamp).toLocaleString('zh-CN', {
        month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    })
    return first === last ? `实际点位 ${format(first)}` : `实际覆盖 ${format(first)} 至 ${format(last)}`
}

function errorMessage(error: unknown, fallback: string) {
    return businessErrorMessage(error, { fallback, service: '运行监控' })
}

function getPrimaryEntity(device: LogicalDevice) {
    const entities = Object.values(device.entities || {})
    return entities.find(entity => entity.state && entity.state !== 'unknown' && entity.state !== 'unavailable') || entities[0]
}

function formatDeviceValue(device: LogicalDevice) {
    const entity = getPrimaryEntity(device)
    if (!entity) return '未配置映射'
    if (!entity.state || entity.state === 'unknown' || entity.state === 'unavailable') return '暂无回读'
    const normalized = String(entity.state).trim()
    const translated = DEVICE_VALUE_TEXT[normalized]
    if (translated) return `${translated}${entity.unit || ''}`
    if (/^-?\d+(?:\.\d+)?$/.test(normalized)) return `${normalized}${entity.unit || ''}`
    return '状态待确认'
}

function formatDeviceUpdatedAt(device: LogicalDevice) {
    const entity = getPrimaryEntity(device)
    if (!entity?.last_changed) return '暂无更新时间'
    const date = new Date(entity.last_changed)
    if (Number.isNaN(date.getTime())) return '暂无更新时间'
    return date.toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    })
}

function getDeviceCategoryLabel(category?: string) {
    if (!category) return '未分类'
    return DEVICE_CATEGORY_TEXT[category] || '其他设备'
}

function getGatewayTypeLabel(type?: string) {
    if (!type) return '未配置协议'
    return GATEWAY_TYPE_TEXT[type.toLowerCase()] || '其他接入方式'
}

function formatHoursRange(hours: number) {
    return hours === 168 ? '7 天' : `${hours} 小时`
}

function displayOperator(username?: string) {
    if (!username) return ''
    return username === 'system' ? '系统任务' : username
}

/* ═══════════════════════════════════════════
   Main Page
   ═══════════════════════════════════════════ */

export default function MonitorPage() {
    const router = useRouter()
    const { isAdmin } = useAuth()
    const [resources, setResources] = useState<ResourceMetrics | null>(null)
    const [aiStatus, setAIStatus] = useState<AIStatus | null>(null)
    const [services, setServices] = useState<ServiceStatus[]>([])
    const [activity, setActivity] = useState<ActivityStats | null>(null)
    const [sensorHistory, setSensorHistory] = useState<SensorHistory | null>(null)
    const [logs, setLogs] = useState<OperationLogItem[]>([])
    const [logTotal, setLogTotal] = useState<number | null>(null)
    const [logRawTotal, setLogRawTotal] = useState<number | null>(null)
    const [logCollapsedCount, setLogCollapsedCount] = useState<number | null>(null)
    const [deviceSummary, setDeviceSummary] = useState<DeviceSummary | null>(null)
    const [devices, setDevices] = useState<LogicalDevice[]>([])
    const [deviceHaError, setDeviceHaError] = useState('')
    const [trends, setTrends] = useState<ControlTrends | null>(null)
    const [logsLoaded, setLogsLoaded] = useState(false)
    const [servicesLoaded, setServicesLoaded] = useState(false)
    const [isRefreshing, setIsRefreshing] = useState(false)
    const [loading, setLoading] = useState(true)
    const [deviceLoading, setDeviceLoading] = useState(true)
    const [activityLoading, setActivityLoading] = useState(true)
    const [logsLoading, setLogsLoading] = useState(true)
    const [historyLoading, setHistoryLoading] = useState(true)
    const [loadedHistoryHours, setLoadedHistoryHours] = useState<number | null>(null)
    const [trendLoading, setTrendLoading] = useState(true)
    const [serviceLoading, setServiceLoading] = useState(true)
    const [resourceError, setResourceError] = useState('')
    const [aiError, setAIError] = useState('')
    const [activityError, setActivityError] = useState('')
    const [deviceError, setDeviceError] = useState('')
    const [logsError, setLogsError] = useState('')
    const [serviceError, setServiceError] = useState('')
    const [historyError, setHistoryError] = useState('')
    const [trendError, setTrendError] = useState('')
    const primaryError = [resourceError, aiError, activityError, deviceError, logsError].filter(Boolean).join('；')
    const retainedPrimaryErrors = [
        resources && resourceError,
        aiStatus && aiError,
        activity && activityError,
        deviceSummary && deviceError,
        logsLoaded && logsError,
    ].filter(Boolean) as string[]
    const retainedPrimaryError = retainedPrimaryErrors.join('；')
    const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null)
    const [sectionUpdatedAt, setSectionUpdatedAt] = useState<Partial<Record<SnapshotSectionKey, string>>>({})
    const [hoursRange, setHoursRange] = useState(24)
    const [agentQuery, setAgentQuery] = useState('')
    const [agentQueryLoading, setAgentQueryLoading] = useState(false)
    const [agentQueryResult, setAgentQueryResult] = useState<AgentQueryResponse | null>(null)
    const [agentQueryError, setAgentQueryError] = useState('')
    const hasLoadedRef = useRef(false)
    const primaryUpdatedAtRef = useRef(0)
    const slowUpdatedAtRef = useRef(0)
    const primaryRequestRef = useRef(0)
    const slowRequestRef = useRef(0)
    const historyRequestRef = useRef(0)
    const agentQueryRequestRef = useRef(0)
    const refreshRequestRef = useRef(0)
    const refreshInFlightRef = useRef(false)
    const agentQueryInFlightRef = useRef(false)
    const hoursRangeRef = useRef(24)
    const historyInFlightRef = useRef<{ request: number; hours: number; force: boolean; promise: Promise<void> } | null>(null)
    const primaryInFlightRef = useRef<{ request: number; force: boolean } | null>(null)
    const slowInFlightRef = useRef<{ request: number; force: boolean } | null>(null)
    const primaryQueuedRef = useRef<QueuedResourceRead<PrimaryResourceKey> | null>(null)
    const slowQueuedRef = useRef<QueuedResourceRead<SlowResourceKey> | null>(null)
    const primaryReloadRef = useRef<(force?: boolean, keys?: PrimaryResourceKey[]) => Promise<void>>(async () => undefined)
    const slowReloadRef = useRef<(force?: boolean, keys?: SlowResourceKey[]) => Promise<void>>(async () => undefined)
    const primaryAbortRef = useRef<AbortController | null>(null)
    const slowAbortRef = useRef<AbortController | null>(null)
    const historyAbortRef = useRef<AbortController | null>(null)
    const agentQueryAbortRef = useRef<AbortController | null>(null)
    const markSectionUpdated = useCallback((key: SnapshotSectionKey) => {
        const updatedAt = new Date().toISOString()
        setSectionUpdatedAt((current) => ({ ...current, [key]: updatedAt }))
        setLastUpdatedAt(new Date(updatedAt))
    }, [])

    const loadPrimaryData = useCallback(async (force = false, requestedKeys: PrimaryResourceKey[] = PRIMARY_RESOURCE_KEYS) => {
        const keys = requestedKeys.length ? Array.from(new Set(requestedKeys)) : PRIMARY_RESOURCE_KEYS
        if (force && primaryInFlightRef.current?.force) {
            let queued = primaryQueuedRef.current
            if (!queued) {
                let resolve: () => void = () => undefined
                const promise = new Promise<void>((done) => { resolve = done })
                queued = { keys: new Set<PrimaryResourceKey>(), promise, resolve }
                primaryQueuedRef.current = queued
            }
            keys.forEach((key) => queued.keys.add(key))
            return queued.promise
        }
        primaryAbortRef.current?.abort()
        const request = ++primaryRequestRef.current
        const controller = new AbortController()
        primaryAbortRef.current = controller
        primaryInFlightRef.current = { request, force }
        if (!hasLoadedRef.current) setLoading(true)
        if (keys.includes('devices')) setDeviceLoading(true)
        if (keys.includes('activity')) setActivityLoading(true)
        if (keys.includes('logs')) setLogsLoading(true)
        let successCount = 0
        const settle = async <T,>(key: PrimaryResourceKey, loader: Promise<T>, onSuccess: (value: T) => void, fallback: string, onFailure: (message: string) => void) => {
            try {
                const value = await loader
                if (request !== primaryRequestRef.current) return
                onSuccess(value)
                onFailure('')
                markSectionUpdated(key)
                successCount += 1
            } catch (error) {
                if (controller.signal.aborted) return
                if (request === primaryRequestRef.current) {
                    const message = errorMessage(error, fallback)
                    onFailure(message)
                }
            }
        }
        const loaders: Record<PrimaryResourceKey, () => Promise<void>> = {
            resources: () => settle('resources', fetchResources(force, controller.signal), setResources, '系统资源读取失败', setResourceError),
            ai: () => settle('ai', fetchAIStatus(force, controller.signal), setAIStatus, '模型状态读取失败', setAIError),
            activity: () => settle('activity', fetchActivityStats(force, controller.signal), setActivity, '使用统计读取失败', setActivityError)
                .finally(() => { if (request === primaryRequestRef.current) setActivityLoading(false) }),
            devices: () => settle(
                'devices',
                fetchDevices({ page: 1, size: 6, sort: 'name', refresh: force, signal: controller.signal }),
                value => {
                    setDeviceSummary(value.summary)
                    setDevices(value.devices || [])
                    setDeviceHaError(value.ha_error || '')
                },
                '设备状态读取失败',
                setDeviceError,
            ).finally(() => { if (request === primaryRequestRef.current) setDeviceLoading(false) }),
            logs: () => settle(
                'logs',
                fetchOperationLogList({ page: 1, size: 4, collapse_periodic: true }, force, controller.signal),
                value => {
                    setLogs(value.logs || [])
                    setLogTotal(typeof value.total === 'number' ? value.total : null)
                    setLogRawTotal(typeof value.raw_total === 'number' ? value.raw_total : null)
                    setLogCollapsedCount(typeof value.collapsed_count === 'number' ? value.collapsed_count : null)
                    setLogsLoaded(true)
                },
                '使用记录读取失败',
                setLogsError,
            ).finally(() => { if (request === primaryRequestRef.current) setLogsLoading(false) }),
        }
        await Promise.allSettled(keys.map((key) => loaders[key]()))
        if (request !== primaryRequestRef.current) return
        if (successCount > 0) {
            const updatedAt = Date.now()
            primaryUpdatedAtRef.current = updatedAt
            setLastUpdatedAt(new Date(updatedAt))
        }
        hasLoadedRef.current = true
        setLoading(false)
        if (primaryInFlightRef.current?.request === request) primaryInFlightRef.current = null
        if (primaryAbortRef.current === controller) primaryAbortRef.current = null
        const queued = primaryQueuedRef.current
        if (force && queued) {
            primaryQueuedRef.current = null
            try {
                await primaryReloadRef.current(true, Array.from(queued.keys))
            } finally {
                queued.resolve()
            }
        }
    }, [markSectionUpdated])
    primaryReloadRef.current = loadPrimaryData

    const loadSlowSections = useCallback(async (force = false, requestedKeys: SlowResourceKey[] = SLOW_RESOURCE_KEYS) => {
        const keys = requestedKeys.length ? Array.from(new Set(requestedKeys)) : SLOW_RESOURCE_KEYS
        if (force && slowInFlightRef.current?.force) {
            let queued = slowQueuedRef.current
            if (!queued) {
                let resolve: () => void = () => undefined
                const promise = new Promise<void>((done) => { resolve = done })
                queued = { keys: new Set<SlowResourceKey>(), promise, resolve }
                slowQueuedRef.current = queued
            }
            keys.forEach((key) => queued.keys.add(key))
            return queued.promise
        }
        slowAbortRef.current?.abort()
        const request = ++slowRequestRef.current
        const controller = new AbortController()
        slowAbortRef.current = controller
        slowInFlightRef.current = { request, force }
        if (keys.includes('trends')) setTrendLoading(true)
        if (keys.includes('services')) setServiceLoading(true)
        const loaders: Record<SlowResourceKey, () => Promise<void>> = {
        services: () => fetchServiceHealth(force, controller.signal)
            .then((value) => {
                if (request !== slowRequestRef.current) return
                setServices(value)
                setServicesLoaded(true)
                setServiceError('')
                slowUpdatedAtRef.current = Date.now()
                markSectionUpdated('services')
            })
            .catch((error) => {
                if (!controller.signal.aborted && request === slowRequestRef.current) setServiceError(errorMessage(error, '外部服务状态读取失败'))
            })
            .finally(() => {
                if (request === slowRequestRef.current) setServiceLoading(false)
            }),
        trends: () => fetchControlTrends(force, controller.signal)
            .then((value) => {
                if (request !== slowRequestRef.current) return
                setTrends(value)
                setTrendError('')
                slowUpdatedAtRef.current = Date.now()
                markSectionUpdated('trends')
            })
            .catch((error) => {
                if (!controller.signal.aborted && request === slowRequestRef.current) setTrendError(errorMessage(error, '操作趋势读取失败'))
            })
            .finally(() => {
                if (request === slowRequestRef.current) setTrendLoading(false)
            }),
        }
        await Promise.allSettled(keys.map((key) => loaders[key]()))
        if (slowInFlightRef.current?.request === request) slowInFlightRef.current = null
        if (slowAbortRef.current === controller) slowAbortRef.current = null
        const queued = slowQueuedRef.current
        if (force && queued) {
            slowQueuedRef.current = null
            try {
                await slowReloadRef.current(true, Array.from(queued.keys))
            } finally {
                queued.resolve()
            }
        }
    }, [markSectionUpdated])
    slowReloadRef.current = loadSlowSections

    const loadHistory = useCallback((hours: number, force = false): Promise<void> => {
        const activeRequest = historyInFlightRef.current
        if (force && activeRequest?.hours === hours && activeRequest.force) return activeRequest.promise
        historyAbortRef.current?.abort()
        const request = ++historyRequestRef.current
        const controller = new AbortController()
        historyAbortRef.current = controller
        setHistoryLoading(true)
        setHistoryError('')
        const promise = (async () => {
            try {
                const history = await fetchSensorHistory(hours, force, controller.signal)
                if (controller.signal.aborted || request !== historyRequestRef.current) return
                setSensorHistory(history)
                setLoadedHistoryHours(hours)
                markSectionUpdated('sensor_history')
            } catch (error) {
                if (request !== historyRequestRef.current) return
                setHistoryError(errorMessage(error, '传感器趋势读取失败'))
            } finally {
                if (request === historyRequestRef.current) {
                    if (historyInFlightRef.current?.request === request) historyInFlightRef.current = null
                    if (historyAbortRef.current === controller) historyAbortRef.current = null
                    setHistoryLoading(false)
                }
            }
        })()
        historyInFlightRef.current = { request, hours, force, promise }
        return promise
    }, [markSectionUpdated])

    const resetRangeDependentState = useCallback(() => {
        historyRequestRef.current += 1
        agentQueryRequestRef.current += 1
        historyAbortRef.current?.abort()
        agentQueryAbortRef.current?.abort()
        historyAbortRef.current = null
        agentQueryAbortRef.current = null
        historyInFlightRef.current = null
        agentQueryInFlightRef.current = false
        setHistoryError('')
        setHistoryLoading(true)
        setAgentQueryLoading(false)
        setAgentQueryResult(null)
        setAgentQueryError('')
    }, [])

    useEffect(() => {
        void loadPrimaryData()
        void loadSlowSections()
    }, [loadPrimaryData, loadSlowSections])

    useEffect(() => {
        let primaryTimer: number | null = null
        let slowTimer: number | null = null

        const stopRefresh = () => {
            if (primaryTimer !== null) window.clearInterval(primaryTimer)
            if (slowTimer !== null) window.clearInterval(slowTimer)
            primaryTimer = null
            slowTimer = null
        }
        const refreshPrimaryIfStale = () => {
            if (primaryInFlightRef.current || Date.now() - primaryUpdatedAtRef.current < 60_000) return
            void loadPrimaryData(false)
        }
        const refreshSlowIfStale = () => {
            if (slowInFlightRef.current || Date.now() - slowUpdatedAtRef.current < 300_000) return
            void loadSlowSections(false)
        }
        const startRefresh = () => {
            stopRefresh()
            if (document.hidden) return
            refreshPrimaryIfStale()
            refreshSlowIfStale()
            primaryTimer = window.setInterval(refreshPrimaryIfStale, 60_000)
            slowTimer = window.setInterval(refreshSlowIfStale, 300_000)
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
    }, [loadPrimaryData, loadSlowSections])

    useEffect(() => {
        const syncHoursFromUrl = () => {
            const rawHours = new URLSearchParams(window.location.search).get('hours')
            const parsedHours = Number(rawHours)
            const nextHours = rawHours && [6, 24, 72, 168].includes(parsedHours) ? parsedHours : 24
            if (hoursRangeRef.current === nextHours) return
            hoursRangeRef.current = nextHours
            resetRangeDependentState()
            setHoursRange(nextHours)
        }
        syncHoursFromUrl()
        window.addEventListener('popstate', syncHoursFromUrl)
        return () => window.removeEventListener('popstate', syncHoursFromUrl)
    }, [resetRangeDependentState])

    useEffect(() => {
        void loadHistory(hoursRange)
    }, [hoursRange, loadHistory])

    useEffect(() => {
        const failedPrimaryKeys: PrimaryResourceKey[] = [
            ...(resourceError ? ['resources' as const] : []),
            ...(aiError ? ['ai' as const] : []),
            ...(activityError ? ['activity' as const] : []),
            ...(deviceError ? ['devices' as const] : []),
            ...(logsError ? ['logs' as const] : []),
        ]
        const failedSlowKeys: SlowResourceKey[] = [
            ...(serviceError ? ['services' as const] : []),
            ...(trendError ? ['trends' as const] : []),
        ]
        if (!failedPrimaryKeys.length && !failedSlowKeys.length && !historyError) return

        const retryFailedReads = () => {
            if (!navigator.onLine || document.visibilityState !== 'visible') return
            if (failedPrimaryKeys.length && !primaryInFlightRef.current) void loadPrimaryData(true, failedPrimaryKeys)
            if (failedSlowKeys.length && !slowInFlightRef.current) void loadSlowSections(true, failedSlowKeys)
            if (historyError && !historyInFlightRef.current) void loadHistory(hoursRangeRef.current, true)
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
    }, [activityError, aiError, deviceError, historyError, loadHistory, loadPrimaryData, loadSlowSections, logsError, resourceError, serviceError, trendError])

    useEffect(() => () => {
        primaryRequestRef.current += 1
        slowRequestRef.current += 1
        historyRequestRef.current += 1
        agentQueryRequestRef.current += 1
        refreshRequestRef.current += 1
        primaryAbortRef.current?.abort()
        slowAbortRef.current?.abort()
        historyAbortRef.current?.abort()
        agentQueryAbortRef.current?.abort()
        refreshInFlightRef.current = false
        agentQueryInFlightRef.current = false
        historyInFlightRef.current = null
        primaryInFlightRef.current = null
        slowInFlightRef.current = null
        primaryQueuedRef.current?.resolve()
        slowQueuedRef.current?.resolve()
        primaryQueuedRef.current = null
        slowQueuedRef.current = null
        primaryReloadRef.current = async () => undefined
        slowReloadRef.current = async () => undefined
    }, [])

    const handleRefresh = async () => {
        if (refreshInFlightRef.current) return
        const request = ++refreshRequestRef.current
        refreshInFlightRef.current = true
        setIsRefreshing(true)
        try {
            await Promise.all([
                loadPrimaryData(true),
                loadSlowSections(true),
                loadHistory(hoursRange, true),
            ])
        } finally {
            if (request === refreshRequestRef.current) {
                refreshInFlightRef.current = false
                setIsRefreshing(false)
            }
        }
    }

    const handleAgentQuery = async () => {
        const query = agentQuery.trim()
        if (!query || agentQueryInFlightRef.current) return
        const request = ++agentQueryRequestRef.current
        const controller = new AbortController()
        agentQueryAbortRef.current = controller
        agentQueryInFlightRef.current = true
        setAgentQueryLoading(true)
        setAgentQueryError('')
        setAgentQueryResult(null)
        try {
            const result = await fetchAgentQuery({ query, hours: hoursRange }, controller.signal)
            if (controller.signal.aborted || request !== agentQueryRequestRef.current) return
            setAgentQueryResult(result)
            markSectionUpdated('agent_query_result')
        } catch (e) {
            if (request !== agentQueryRequestRef.current) return
            setAgentQueryError(businessErrorMessage(e, { fallback: '智能体数据查询失败', service: '智能体数据查询' }))
        } finally {
            if (request === agentQueryRequestRef.current) {
                if (agentQueryAbortRef.current === controller) agentQueryAbortRef.current = null
                agentQueryInFlightRef.current = false
                setAgentQueryLoading(false)
            }
        }
    }

    const handleHoursRangeChange = (hours: number) => {
        if (hours === hoursRangeRef.current) return
        hoursRangeRef.current = hours
        resetRangeDependentState()
        setHoursRange(hours)
        const url = new URL(window.location.href)
        if (hours === 24) url.searchParams.delete('hours')
        else url.searchParams.set('hours', String(hours))
        router.push(`${url.pathname}${url.search}`, { scroll: false })
    }

    const handleAgentQueryChange = (value: string) => {
        agentQueryRequestRef.current += 1
        agentQueryAbortRef.current?.abort()
        agentQueryAbortRef.current = null
        agentQueryInFlightRef.current = false
        setAgentQueryLoading(false)
        setAgentQueryResult(null)
        setAgentQueryError('')
        setAgentQuery(value)
    }

    const cancelAgentQuery = () => {
        if (!agentQueryInFlightRef.current) return
        agentQueryRequestRef.current += 1
        agentQueryAbortRef.current?.abort()
        agentQueryAbortRef.current = null
        agentQueryInFlightRef.current = false
        setAgentQueryLoading(false)
        setAgentQueryError('已取消本次查询等待')
    }

    const exportSnapshot = () => {
        if (!resources && !deviceSummary && !sensorHistory) return
        const sectionEvidence = {
            resources: { included: Boolean(resources), page_received_at: sectionUpdatedAt.resources || null, error: resourceError || null },
            ai_status: { included: Boolean(aiStatus), page_received_at: sectionUpdatedAt.ai || null, error: aiError || null },
            services: { included: servicesLoaded, page_received_at: sectionUpdatedAt.services || null, error: serviceError || null },
            activity: { included: Boolean(activity), page_received_at: sectionUpdatedAt.activity || null, error: activityError || null },
            sensor_history: {
                included: Boolean(sensorHistory),
                page_received_at: sectionUpdatedAt.sensor_history || null,
                error: historyError || null,
                requested_hours: hoursRange,
                snapshot_hours: historySnapshotHours,
                matches_current_range: Boolean(sensorHistory) && historySnapshotHours === hoursRange,
                requested_start_at: sensorHistory?._meta?.requested_start_at || null,
                requested_end_at: sensorHistory?._meta?.requested_end_at || null,
            },
            operation_logs: { included: logsLoaded, page_received_at: sectionUpdatedAt.logs || null, error: logsError || null },
            device_summary: {
                included: Boolean(deviceSummary),
                page_received_at: sectionUpdatedAt.devices || null,
                error: deviceError || null,
                ha_realtime_error: deviceHaError || null,
            },
            control_trends: { included: Boolean(trends), page_received_at: sectionUpdatedAt.trends || null, error: trendError || null },
        }
        const missingSections = Object.entries(sectionEvidence)
            .filter(([, evidence]) => !evidence.included)
            .map(([section]) => section)
        const retainedAfterError = Object.entries(sectionEvidence)
            .filter(([, evidence]) => evidence.included && evidence.error)
            .map(([section]) => section)
        const successfulTimes = Object.values(sectionEvidence)
            .flatMap((evidence) => evidence.page_received_at ? [new Date(evidence.page_received_at).getTime()] : [])
            .filter(Number.isFinite)
        const updateSpreadSeconds = successfulTimes.length > 1
            ? Math.round((Math.max(...successfulTimes) - Math.min(...successfulTimes)) / 1000)
            : 0
        const rangeMismatch = Boolean(sensorHistory) && historySnapshotHours !== hoursRange
        const completeness = missingSections.length || retainedAfterError.length || rangeMismatch
            ? 'partial'
            : updateSpreadSeconds > 120
                ? 'mixed_time'
                : 'complete'
        const blob = new Blob([
            JSON.stringify({
                exported_at: new Date().toISOString(),
                snapshot_scope: '当前监控页各区块最近一次成功结果；page_received_at 是页面接收时间，不等同于底层采集时间',
                completeness,
                section_evidence: sectionEvidence,
                page_receive_spread_seconds: updateSpreadSeconds,
                included_sections: Object.entries(sectionEvidence).filter(([, evidence]) => evidence.included).map(([section]) => section),
                missing_sections: missingSections,
                retained_after_error_sections: retainedAfterError,
                diagnostics: [primaryError, serviceError, historyError, trendError, agentQueryError].filter(Boolean),
                hours_range: hoursRange,
                data_source: sensorHistory?._meta?.data_source || 'no_real_data',
                resources,
                ai_status: aiStatus,
                services,
                activity,
                sensor_history: sensorHistory,
                logs,
                operation_log_summary: {
                    visible_total: logTotal,
                    raw_total: logRawTotal,
                    collapsed_count: logCollapsedCount,
                    collapse_periodic: true,
                },
                device_summary: deviceSummary,
                device_ha_realtime_error: deviceHaError || null,
                devices,
                control_trends: trends,
                agent_query_result: agentQueryResult ? {
                    page_received_at: sectionUpdatedAt.agent_query_result || null,
                    query: agentQuery,
                    result: agentQueryResult,
                } : null,
            }, null, 2),
        ], { type: 'application/json;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `monitor-snapshot-${Date.now()}.json`
        a.click()
        URL.revokeObjectURL(url)
    }

    if (!loading && !resources && !aiStatus && !deviceSummary && !activity && !logsLoaded) {
        return (
            <div className="monitor-scope bg-slate-50 text-slate-800 font-body flex items-center justify-center"
                 style={{ minHeight: 'calc(100vh - 56px)' }}>
                <div className="max-w-lg rounded-lg border border-slate-200 bg-white p-8 text-center shadow-sm">
                    <AlertTriangle className="mx-auto mb-4 h-10 w-10 text-amber-500" />
                    <h2 className="text-xl font-bold text-slate-900">监控数据加载失败</h2>
                    <p className="mt-2 text-sm leading-6 text-slate-500">{primaryError || '未获取到监控数据'}</p>
                    <button
                        onClick={() => void loadPrimaryData(true, PRIMARY_RESOURCE_KEYS.filter((key) => ({ resources: resourceError, ai: aiError, activity: activityError, devices: deviceError, logs: logsError })[key]))}
                        className="mt-6 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-bold text-white hover:bg-blue-700"
                    >
                        <RefreshCw size={16} />
                        重试
                    </button>
                </div>
            </div>
        )
    }

    const sensor_history = sensorHistory || { temperature: [], humidity: [], pm25: [] }
    const sensorSeries = [
        { key: 'temperature' as const, label: '温度', unit: '°C', color: 'bg-blue-600' },
        { key: 'humidity' as const, label: '湿度', unit: '%', color: 'bg-emerald-500' },
        { key: 'pm25' as const, label: 'PM2.5', unit: ' μg/m³', color: 'bg-amber-500' },
    ].map((series) => ({
        ...series,
        ...sensorSeriesSummary(sensor_history[series.key] || [], series.unit),
        meta: sensor_history._meta?.metrics?.[series.key],
    }))
    const hasSensorHistoryPoints = sensorSeries.some((series) => series.pointCount > 0)
    const historySnapshotHours = loadedHistoryHours ?? sensorHistory?._meta?.hours ?? hoursRange
    const historyRangeUpdating = historyLoading && Boolean(sensorHistory) && historySnapshotHours !== hoursRange
    const ai_status = aiStatus

    // 操作趋势（从 /control-trends API 获取真实数据）
    const validTrendSnapshot = trends
        && trends.hours.length > 0
        && trends.hours.length === trends.today.length
        && trends.hours.length === trends.yesterday.length
        && trends.today.every(Number.isFinite)
        && trends.yesterday.every(Number.isFinite)
    const chatTrends = validTrendSnapshot
        ? trends.hours.map((h, i) => ({
            time: h,
            today: trends.today[i],
            yesterday: trends.yesterday[i],
        }))
        : null

    // 设备分布数据
    const devTotal = deviceSummary?.total ?? 0
    const devOnline = deviceSummary?.online ?? 0
    const devOffline = deviceSummary?.offline ?? 0
    const devScenes = deviceSummary?.scene_count
    const deviceMetric = (value: number | null | undefined) => deviceSummary && value != null ? String(value) : '—'
    const recentDevices = devices.slice(0, 6)
    const unavailableActivityFields = Object.entries(activity?.sources || {})
        .filter(([, source]) => source.status === 'unavailable')
        .map(([field]) => ACTIVITY_FIELD_TEXT[field] || '其他统计项')

    // 环形图计算
    const circumference = 2 * Math.PI * 16
    const onlinePerc = devTotal > 0 ? (devOnline / devTotal) * circumference : 0
    const offlinePerc = devTotal > 0 ? (devOffline / devTotal) * circumference : 0

    return (
        <div className="monitor-scope bg-slate-50 text-slate-800 font-body selection:bg-blue-200 selection:text-blue-900"
             style={{ minHeight: 'calc(100vh - 56px)' }}>

            <main className="pt-6 pb-12 px-6 lg:px-8 max-w-7xl mx-auto space-y-8">

                {/* Page Header */}
                <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
                    <div className="min-w-0 xl:flex-1">
                        <h1 className="text-3xl md:text-4xl font-bold text-slate-900 font-headline">设备状态与系统监控</h1>
                        <p className="mt-2 flex flex-col items-start gap-1 text-sm font-medium text-slate-500 sm:flex-row sm:items-center sm:gap-2 font-body">
                            <span>集中查看智能家居设备状态、系统运行情况、使用统计和传感器趋势</span>
                            <span className="hidden text-slate-300 sm:inline">•</span>
                            <span className="opacity-70">
                                {lastUpdatedAt ? `最近一次区块成功更新于 ${lastUpdatedAt.toLocaleTimeString('zh-CN')}` : '正在读取平台数据'}
                            </span>
                        </p>
                    </div>
                    <div className="relative z-10 flex w-full flex-nowrap items-center gap-3 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden xl:w-auto xl:max-w-[65%] xl:shrink-0">
                        <div className="flex shrink-0 rounded-lg border border-slate-200 bg-white p-1 shadow-sm">
                            {[
                                { label: '6 小时', value: 6 },
                                { label: '24 小时', value: 24 },
                                { label: '72 小时', value: 72 },
                                { label: '7 天', value: 168 },
                            ].map((item) => (
                                <button
                                    type="button"
                                    key={item.value}
                                    onClick={() => handleHoursRangeChange(item.value)}
                                    aria-current={hoursRange === item.value ? 'page' : undefined}
                                    aria-pressed={hoursRange === item.value}
                                    data-testid={`monitor-range-${item.value}`}
                                    className={`shrink-0 rounded-md px-3 py-2 text-xs font-bold transition ${hoursRange === item.value ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-slate-50'}`}
                                >
                                    {item.label}
                                </button>
                            ))}
                        </div>
                        <button
                            type="button"
                            onClick={exportSnapshot}
                            disabled={isRefreshing || historyRangeUpdating || (!resources && !deviceSummary && !sensorHistory)}
                            title={isRefreshing || historyRangeUpdating ? '等待当前刷新完成后再导出' : '导出各区块最近一次成功结果及覆盖证据'}
                            className="flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-slate-200 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            <Download className="w-4 h-4" />
                            导出快照
                        </button>
                        <button
                            type="button"
                            onClick={handleRefresh}
                            disabled={isRefreshing}
                            className="flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-slate-200 bg-white px-6 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-60"
                        >
                            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
                            刷新数据
                        </button>
                        <Link
                            href="/time-series"
                            className="flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-700"
                        >
                            <Database className="h-4 w-4" />
                            时序数据
                        </Link>
                    </div>
                </header>

                {retainedPrimaryError ? (
                    <div className="flex flex-col gap-3 rounded-lg border border-amber-100 bg-amber-50 px-5 py-4 text-sm font-medium leading-6 text-amber-800 sm:flex-row sm:items-center sm:justify-between" role="alert">
                        <span>{retainedPrimaryError}。对应区块继续保留上一次成功结果。</span>
                        <button type="button" onClick={() => void loadPrimaryData(true, PRIMARY_RESOURCE_KEYS.filter((key) => ({ resources: resources && resourceError, ai: aiStatus && aiError, activity: activity && activityError, devices: deviceSummary && deviceError, logs: logsLoaded && logsError })[key]))} className="shrink-0 font-bold text-amber-800">重新读取旧快照失败项</button>
                    </div>
                ) : null}

                <div className="grid gap-3 md:grid-cols-4">
                    {[
                        { label: '设备状态', value: deviceLoading && !deviceSummary ? '正在读取设备台账' : deviceError && !deviceSummary ? '设备台账未取得' : `${devOnline}/${devTotal} 台账在线 · ${devOffline} 离线/待联调${deviceHaError ? ' · HA 实时状态未取得' : ''}` },
                        { label: '系统指标', value: resources?.available === false ? '主机资源指标未取得' : resources && aiStatus ? '主机资源与 Ollama 真实状态' : resourceError || aiError ? '部分指标读取失败' : '正在读取主机资源' },
                        { label: '传感器趋势', value: historyRangeUpdating
                            ? `正在切换到${formatHoursRange(hoursRange)} · 保留${formatHoursRange(historySnapshotHours)}快照`
                            : `${historyLoading ? '正在读取' : sensorSourceText(sensor_history._meta?.data_source)} · 最近 ${formatHoursRange(historySnapshotHours)}` },
                        { label: '操作日志', value: logsLoading && !logsLoaded ? `正在读取${isAdmin ? '平台' : '我的'}记录` : logsError && !logsLoaded ? `${isAdmin ? '平台' : '我的'}记录未取得` : logsError ? `保留上次${logTotal === null ? `${logs.length} 条` : `共 ${logTotal} 条`}记录` : logTotal === null ? `已显示 ${logs.length} 条最近记录` : `当前 ${logs.length} 条 · 共 ${logTotal} 条` },
                    ].map((item) => (
                        <div key={item.label} className="rounded-lg border border-slate-100 bg-white px-5 py-4 shadow-sm">
                            <p className="text-xs font-semibold text-slate-400">{item.label}</p>
                            <p className="mt-2 text-sm font-semibold leading-6 text-slate-700">{item.value}</p>
                        </div>
                    ))}
                </div>

                {/* Top Resource Cards Grid */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
                    <CircularProgress
                        value={resources && resources.available !== false ? Math.round(resources.cpu.percent) : null}
                        label="CPU 使用率"
                        sublabel={resources?.available === false ? resources.diagnostic || '主机资源指标未取得' : resources ? `${resources.cpu.model} · ${resources.cpu.cores} 核` : resourceError || '正在读取主机资源'}
                        strokeClass="text-blue-600"
                    />
                    <CircularProgress
                        value={resources && resources.available !== false ? Math.round(resources.memory.percent) : null}
                        label="内存"
                        sublabel={resources?.available === false ? resources.diagnostic || '主机资源指标未取得' : resources ? `${resources.memory.used_gb}GB / ${resources.memory.total_gb}GB` : resourceError || '正在读取主机资源'}
                        strokeClass="text-purple-500"
                    />
                    <CircularProgress
                        value={resources?.available !== false && resources?.gpu.available && resources.gpu.percent !== null ? Math.round(resources.gpu.percent) : null}
                        label="GPU 负载"
                        sublabel={!resources ? (resourceError || '正在读取主机资源') : resources.available === false
                            ? resources.diagnostic || '主机资源指标未取得'
                            : resources.gpu.available
                            ? `${resources.gpu.model} · ${resources.gpu.vram_used_gb}GB`
                            : '当前未检测到独立 GPU'}
                        strokeClass="text-emerald-500"
                    />
                    <CircularProgress
                        value={resources && resources.available !== false ? Math.round(resources.disk.percent) : null}
                        label="系统根卷"
                        sublabel={resources?.available === false
                            ? resources.diagnostic || '主机资源指标未取得'
                            : resources
                            ? resources.disk.available_gb != null
                                ? `已用 ${resources.disk.used_gb}GB · 可用 ${resources.disk.available_gb}GB · ${resources.disk.mount_path || '/'}`
                                : `已用 ${resources.disk.used_gb}GB · 总量 ${resources.disk.total_gb}GB · ${resources.disk.mount_path || '/'}`
                            : resourceError || '正在读取主机资源'}
                        strokeClass="text-amber-600"
                    />
                </div>

                {/* AI Model & Activity Row */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

                    {/* AI Model Status */}
                    <div className="relative overflow-hidden rounded-2xl p-5 sm:p-8">
                        <div className="absolute top-0 right-0 p-5 opacity-[0.04] pointer-events-none transform translate-x-4 -translate-y-4 sm:p-8">
                            <Bot size={180} />
                        </div>
                        <div className="relative z-10">
                            <h2 className="text-xl font-bold mb-6 flex items-center gap-2 text-slate-800 font-headline">
                                <Cpu className="text-blue-600 w-6 h-6" />
                                模型运行状态
                            </h2>
                            <div className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-6">
                                <div className="min-w-0 space-y-1">
                                    <p className="text-xs font-semibold text-slate-500 font-body">模型架构</p>
                                    <p className="break-words font-semibold text-slate-900 font-body">{ai_status?.model_name || (aiError || '正在读取模型状态')}</p>
                                </div>
                                <div className="min-w-0 space-y-1">
                                    <p className="text-xs font-semibold text-slate-500 font-body">执行模式</p>
                                    <div className="flex items-center gap-2">
                                        <span className={`w-2 h-2 rounded-full ${ai_status?.status === 'running' ? 'bg-emerald-500' : ai_status?.status === 'idle' ? 'bg-amber-500' : 'bg-red-500'}`}></span>
                                        <p className="font-semibold text-slate-900 font-body">
                                            {ai_status?.status === 'running' ? `运行中${ai_status.quantization ? `（${ai_status.quantization}）` : ''}` : ai_status?.status === 'idle' ? '待机' : ai_status ? '离线' : aiError ? '读取失败' : '正在读取'}
                                        </p>
                                    </div>
                                </div>
                                <div className="min-w-0 space-y-1">
                                    <p className="text-xs font-semibold text-slate-500 font-body">参数规模</p>
                                    <p className="font-semibold text-blue-600 font-body">{ai_status?.parameter_size || '—'}</p>
                                </div>
                                <div className="min-w-0 space-y-1">
                                    <p className="text-xs font-semibold text-slate-500 font-body">VRAM 占用</p>
                                    <p className="font-semibold text-orange-600 font-body">{ai_status?.status === 'idle' ? '未加载' : ai_status?.status === 'offline' ? '未取得' : valueText(ai_status?.vram_used_gb, ' GB')}</p>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Today's Activity Card */}
                    <div className="glass-card p-8 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.04)]">
                        <h2 className="text-xl font-bold mb-6 flex items-center gap-2 text-slate-800 font-headline">
                            <BarChart2 className="text-orange-500 w-6 h-6" />
                            今日使用情况
                        </h2>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                            {[
                                { val: activityLoading && !activity ? '…' : valueText(activity?.conversations_today), label: '我的对话' },
                                { val: activityLoading && !activity ? '…' : valueText(activity?.controls_today), label: isAdmin ? '平台控制' : '我的控制' },
                                { val: activityLoading && !activity ? '…' : valueText(activity?.model_count), label: '本地模型' },
                                { val: activityLoading && !activity ? '…' : valueText(activity?.knowledge_docs), label: '知识文档' }
                            ].map((stat, i) => (
                                <div key={i} className="bg-slate-100/80 p-4 rounded-md text-center md:text-left transition-transform hover:scale-105">
                                    <p className="text-3xl font-bold text-slate-800 font-headline">{stat.val}</p>
                                    <p className="mt-1 text-xs font-semibold text-slate-400 font-body">{stat.label}</p>
                                </div>
                            ))}
                        </div>
                        {activityError && !activity ? (
                            <p className="mt-4 text-xs font-medium leading-5 text-amber-700">
                                今日使用统计未取得：{activityError}
                            </p>
                        ) : unavailableActivityFields.length ? (
                            <p className="mt-4 text-xs font-medium leading-5 text-amber-700">
                                {unavailableActivityFields.join('、')}的数据源当前不可用，保持未知；真实零值仍显示为 0。
                            </p>
                        ) : null}
                    </div>
                </div>

                {/* Charts Row */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

                    {/* Device Distribution Donut */}
                    <div className="glass-card p-8 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.04)] lg:col-span-1">
                        <h3 className="text-lg font-bold mb-2 text-slate-800 font-headline">平台设备状态分布</h3>
                        <div className="flex items-center justify-center py-6">
                            <div className="relative w-48 h-48">
                                <svg className="w-full h-full" style={{ transform: 'rotate(-90deg)' }} viewBox="0 0 36 36">
                                    <circle cx="18" cy="18" r="16" fill="none" stroke="#f1f5f9" strokeWidth="4"></circle>
                                    <circle cx="18" cy="18" r="16" fill="none" stroke="#2563eb" strokeWidth="4"
                                        strokeDasharray={`${onlinePerc} ${circumference}`} strokeDashoffset="0"></circle>
                                    {devOffline > 0 && (
                                        <circle cx="18" cy="18" r="16" fill="none" stroke="#94a3b8" strokeWidth="4"
                                            strokeDasharray={`${offlinePerc} ${circumference}`} strokeDashoffset={`${-onlinePerc}`}></circle>
                                    )}
                                </svg>
                                <div className="absolute inset-0 flex flex-col items-center justify-center">
                                    <span className="text-3xl font-bold text-slate-800 font-headline">{deviceMetric(devTotal)}</span>
                                    <span className="text-xs font-semibold text-slate-400 font-body">总数</span>
                                </div>
                            </div>
                        </div>
                        <div className="space-y-3 mt-2 px-2">
                            <div className="flex items-center justify-between text-sm">
                                <div className="flex items-center gap-2"><span className="w-2.5 h-2.5 rounded-full bg-blue-600"></span> <span className="font-medium text-slate-600">台账在线</span></div>
                                <span className="font-bold text-slate-800">{deviceMetric(devOnline)}</span>
                            </div>
                            <div className="flex items-center justify-between text-sm">
                                <div className="flex items-center gap-2"><span className="w-2.5 h-2.5 rounded-full bg-slate-400"></span> <span className="font-medium text-slate-600">离线 / 待联调</span></div>
                                <span className="font-bold text-slate-800">{deviceMetric(devOffline)}</span>
                            </div>
                            <div className="flex items-center justify-between text-sm">
                                <div className="flex items-center gap-2"><span className="w-2.5 h-2.5 rounded-full bg-amber-500"></span> <span className="font-medium text-slate-600">场景</span></div>
                                <span className="font-bold text-slate-800">{deviceMetric(devScenes)}</span>
                            </div>
                        </div>
                        {deviceHaError ? (
                            <p className="mt-5 rounded-lg border border-amber-100 bg-amber-50 px-4 py-3 text-xs font-medium leading-5 text-amber-800">
                                Home Assistant 实时状态未取得；当前分布反映平台设备台账在本次快照中的在线/离线分类，不代表现场硬件实时状态。
                            </p>
                        ) : null}
                    </div>

                    {/* Dialogue Trends Bar Chart */}
                    <div className="glass-card p-8 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.04)] lg:col-span-2 flex flex-col">
                        <div className="flex items-start justify-between mb-4">
                            <h3 className="text-lg font-bold text-slate-800 font-headline">{isAdmin ? '平台控制确认趋势' : '我的控制确认趋势'}</h3>
                            <div className="flex gap-4 text-xs font-semibold font-body">
                                <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-blue-600"></span> <span className="text-slate-600">今日</span></div>
                                <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-blue-100"></span> <span className="text-slate-500">昨日</span></div>
                            </div>
                        </div>
                        <DialogueTrendsChart data={chatTrends} loading={trendLoading} />
                        {trendError ? (
                            <div className="mt-4 flex flex-col gap-2 rounded-lg border border-rose-100 bg-rose-50 px-4 py-3 text-sm text-rose-700 sm:flex-row sm:items-center sm:justify-between">
                                <span>{trendError}，趋势区保留空态，不生成模拟柱状数据。</span>
                                <button type="button" onClick={() => void loadSlowSections(true, ['trends'])} disabled={trendLoading} className="shrink-0 font-bold text-rose-700 disabled:opacity-50">重新读取趋势</button>
                            </div>
                        ) : null}
                    </div>
                </div>

                {/* Full Width Sensor History Trends */}
                <div className="bg-slate-100 p-8 rounded-2xl border border-slate-200/60 relative overflow-hidden">
                    <div className="flex flex-col sm:flex-row sm:items-end justify-between mb-6 gap-4 relative z-10">
                        <div>
                            <h3 className="text-2xl font-bold text-slate-800 font-headline">统计信息趋势</h3>
                            <p className="text-slate-500 text-sm mt-1 font-medium font-body">
                                温度 {valueText(sensor_history.temperature?.slice(-1)?.[0]?.value, '°C')}
                                · 湿度 {valueText(sensor_history.humidity?.slice(-1)?.[0]?.value, '%')}
                                · PM2.5 {valueText(sensor_history.pm25?.slice(-1)?.[0]?.value, ' μg/m³')}
                                · 最近 {formatHoursRange(historySnapshotHours)}
                                · 来源 {sensorSourceText(sensor_history._meta?.data_source)}
                            </p>
                        </div>
                        <div className="grid w-full overflow-hidden rounded-[8px] border border-slate-200/70 bg-white/55 backdrop-blur-sm sm:w-auto sm:grid-cols-3 sm:divide-x sm:divide-slate-200/70">
                            {sensorSeries.map((series) => (
                                <div key={series.key} className="min-w-0 border-b border-slate-200/70 px-4 py-2.5 last:border-b-0 sm:border-b-0">
                                    <div className="flex items-center gap-2">
                                        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${series.color}`} />
                                        <span className="text-xs font-bold text-slate-700 font-body">{series.label}</span>
                                        <span className="ml-auto text-xs font-black tabular-nums text-slate-900">{series.latest}</span>
                                    </div>
                                    <p
                                        title={`${series.pointCount} 个真实点 · ${series.range}`}
                                        className="mt-1 break-words text-xs font-semibold leading-5 text-slate-400"
                                    >
                                        {series.pointCount} 个真实点 · {series.range}
                                    </p>
                                </div>
                            ))}
                        </div>
                    </div>
                    {historyLoading && !sensorHistory ? (
                        <div className="flex h-80 w-full items-center justify-center gap-2 rounded-xl border border-slate-100 bg-white/50 text-sm text-slate-400">
                            <Loader2 size={16} className="animate-spin text-blue-600" />正在读取真实传感器历史
                        </div>
                    ) : hasSensorHistoryPoints ? (
                        <SensorHistoryChart
                            temperature={sensor_history.temperature || []}
                            humidity={sensor_history.humidity || []}
                            pm25={sensor_history.pm25 || []}
                        />
                    ) : (
                        <div className="flex min-h-20 items-center justify-center rounded-[8px] border border-dashed border-slate-300 bg-white/50 px-5 text-center text-sm font-semibold leading-6 text-slate-500">
                            当前时间范围内没有可绘制的真实传感器历史，未生成空坐标轴或模拟趋势。
                        </div>
                    )}
                    {historyRangeUpdating ? (
                        <div className="mt-4 flex items-center gap-2 rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm leading-6 text-blue-800" role="status">
                            <Loader2 size={15} className="shrink-0 animate-spin" />
                            正在切换到最近 {formatHoursRange(hoursRange)}，当前保留最近 {formatHoursRange(historySnapshotHours)} 的成功快照。
                        </div>
                    ) : null}
                    {sensor_history._meta?.fallback_note && !historyError && hasSensorHistoryPoints ? (
                        <div className={`mt-4 rounded-lg border px-4 py-3 text-sm leading-6 ${sensor_history._meta.data_source === 'no_real_data' ? 'border-amber-100 bg-amber-50 text-amber-800' : 'border-blue-100 bg-blue-50 text-blue-800'}`}>
                            {sensor_history._meta.fallback_note}
                        </div>
                    ) : null}
                    {sensor_history._meta?.metrics ? (
                        <div className="mt-4 overflow-hidden rounded-[8px] border border-slate-200 bg-white/70 text-sm">
                            {sensorSeries.map((series) => {
                                const location = [series.meta?.device_name, series.meta?.device_location].filter(Boolean).join(' · ')
                                return (
                                    <div key={series.key} className="grid gap-1 border-b border-slate-100 px-4 py-3 last:border-b-0 sm:grid-cols-[92px_minmax(0,1fr)_auto] sm:items-center sm:gap-4">
                                        <strong className="text-slate-800">{series.label}</strong>
                                        <span className="min-w-0 break-words text-slate-500">
                                            {series.pointCount > 0
                                                ? `${location || '已纳管传感器'} · ${sensorSourceText(series.meta?.source)} · ${sensorCoverageText(series.meta?.first_point_at, series.meta?.last_point_at)}${series.meta?.coverage_truncated ? ` · 原始 ${series.meta.raw_point_count || series.pointCount} 个点已采样为 ${series.pointCount} 个` : ''}`
                                                : series.meta?.missing_reason || '当前范围内没有真实历史点'}
                                        </span>
                                        <span className="text-xs font-bold tabular-nums text-slate-400 sm:text-right">{series.pointCount} 个点</span>
                                    </div>
                                )
                            })}
                        </div>
                    ) : null}
                    {sensor_history._meta?.requested_start_at && sensor_history._meta?.requested_end_at ? (
                        <p className="mt-3 text-xs font-semibold leading-5 text-slate-500">
                            请求范围 {sensorCoverageText(sensor_history._meta.requested_start_at, sensor_history._meta.requested_end_at).replace('实际覆盖 ', '')}
                            {sensor_history._meta.aggregation_window_minutes ? ` · InfluxDB 按 ${sensor_history._meta.aggregation_window_minutes} 分钟均值聚合` : ''}
                            {sensor_history._meta.target_points_per_metric ? ` · 每项最多展示 ${sensor_history._meta.target_points_per_metric} 个点` : ''}
                        </p>
                    ) : null}
                    {historyError ? (
                        <div className="mt-4 flex flex-col gap-3 rounded-lg border border-rose-100 bg-rose-50 px-4 py-3 text-sm text-rose-700 sm:flex-row sm:items-center sm:justify-between">
                            <span>{historyError}，其他监控区块仍可继续使用。</span>
                            <button type="button" onClick={() => void loadHistory(hoursRange, true)} className="shrink-0 font-bold text-rose-700">重新读取趋势</button>
                        </div>
                    ) : null}
                </div>

                {/* Dify Agent data-query verification */}
                <div className="grid grid-cols-1 gap-6 lg:grid-cols-[0.95fr_1.05fr]">
                    <div className="rounded-2xl bg-white p-8 shadow-sm">
                        <h3 className="text-xl font-bold text-slate-800 font-headline">智能体数据查询验证</h3>
                        <p className="mt-2 text-sm leading-6 text-slate-500">
                            输入自然语言查询，平台会路由到服务健康、Home Assistant 状态或真实历史数据源。
                        </p>
                        <div className="mt-5 flex flex-col gap-3 sm:flex-row">
                            <input
                                aria-label="智能数据查询"
                                value={agentQuery}
                                onChange={(event) => handleAgentQueryChange(event.target.value)}
                                className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-medium text-slate-700 outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
                                placeholder="例如：最近 24 小时室内温度趋势"
                            />
                            <button
                                type="button"
                                onClick={agentQueryLoading ? cancelAgentQuery : handleAgentQuery}
                                disabled={!agentQueryLoading && !agentQuery.trim()}
                                title={agentQueryLoading ? '取消等待本次查询结果' : !agentQuery.trim() ? '请先输入要查询的问题' : '执行智能体数据查询'}
                                className="inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-5 py-3 text-sm font-bold text-white hover:bg-slate-700 disabled:opacity-50"
                            >
                                {agentQueryLoading ? <X size={16} /> : <Search size={16} />}
                                {agentQueryLoading ? '取消查询' : '查询'}
                            </button>
                        </div>
                        {agentQueryError && (
                            <div className="mt-4 rounded-lg border border-rose-100 bg-rose-50 px-4 py-3 text-sm text-rose-600">
                                {agentQueryError}
                            </div>
                        )}
                    </div>

                    <div className="rounded-2xl bg-slate-900 p-6 text-white shadow-sm">
                        <div className="mb-4 flex items-center justify-between gap-3">
                            <div>
                                <p className="text-xs font-semibold text-slate-400">查询结果</p>
                                <h3 className="mt-1 text-lg font-bold">智能体查询结果</h3>
                            </div>
                            {agentQueryResult && (
                                <span className="rounded-full bg-emerald-400/15 px-3 py-1 text-xs font-bold text-emerald-200">
                                    {QUERY_STATUS_TEXT[agentQueryResult.status] || '查询完成'}
                                </span>
                            )}
                        </div>
                        {agentQueryResult ? (
                            <div className="space-y-4">
                                <div className="grid gap-3 sm:grid-cols-2">
                                    {[
                                        ['查询类型', QUERY_TYPE_TEXT[agentQueryResult.query_type] || '智能查询'],
                                        ['查询对象', queryObjectText(agentQueryResult)],
                                        ['数据来源', DATA_SOURCE_TEXT[agentQueryResult.data_source] || '其他数据源'],
                                    ].map(([label, value]) => (
                                        <div key={label} className="rounded-lg bg-white/8 px-4 py-3">
                                            <p className="text-xs font-semibold text-slate-400">{label}</p>
                                            <p className="mt-2 text-sm font-semibold text-white">{value}</p>
                                        </div>
                                    ))}
                                </div>
                                {agentQueryResult.fallback_note && (
                                    <div className="rounded-lg bg-amber-400/10 px-4 py-3 text-sm leading-6 text-amber-100">
                                        {agentQueryResult.fallback_note}
                                    </div>
                                )}
                                <QueryBusinessResult response={agentQueryResult} />
                                <details className="rounded-lg bg-white/5 px-4 py-3">
                                    <summary className="cursor-pointer text-sm font-semibold text-slate-300">技术详情</summary>
                                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                                        <TechnicalId value={agentQueryResult.entity_id} label="Home Assistant 实体" className="[&_code]:bg-white/10 [&_code]:text-slate-200" />
                                        <TechnicalId value={agentQueryResult.source_endpoint} label="来源接口" className="[&_code]:bg-white/10 [&_code]:text-slate-200" />
                                    </div>
                                    <pre className="mt-4 max-h-72 overflow-auto rounded-lg bg-black/25 p-4 text-xs leading-6 text-slate-200">
                                        {JSON.stringify(agentQueryResult.result, null, 2)}
                                    </pre>
                                </details>
                            </div>
                        ) : (
                            <div className="flex min-h-[220px] items-center justify-center rounded-lg bg-white/5 px-6 text-center text-sm leading-6 text-slate-400">
                                输入查询并执行后，这里显示真实业务结果；页面不会自动运行示例查询。
                            </div>
                        )}
                    </div>
                </div>

                <section className="grid grid-cols-1 xl:grid-cols-[0.9fr_1.1fr] gap-6">
                    <div className="rounded-2xl bg-white p-7 shadow-sm">
                        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                            <div>
                                <p className="text-xs font-semibold text-blue-500">设备状态汇总</p>
                                <h2 className="mt-2 text-2xl font-bold text-slate-900 font-headline">设备状态概览</h2>
                                <p className="mt-2 text-sm leading-6 text-slate-500">
                                    统计来自平台设备台账；Home Assistant 可用时会结合实体回读结果形成当前快照分类。
                                </p>
                            </div>
                            <Link
                                href="/devices"
                                className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-blue-700"
                            >
                                <Home className="h-4 w-4" />
                                设备台账
                            </Link>
                        </div>
                        <div className="mt-6 grid grid-cols-2 gap-3">
                            {[
                                { label: '设备总数', value: deviceMetric(devTotal), tone: 'text-slate-900' },
                                { label: '台账在线', value: deviceMetric(devOnline), tone: 'text-emerald-600' },
                                { label: '离线 / 待联调', value: deviceMetric(devOffline), tone: 'text-amber-600' },
                                { label: '场景预设', value: deviceMetric(devScenes), tone: 'text-blue-600' },
                            ].map((stat) => (
                                <div key={stat.label} className="rounded-lg border border-slate-100 bg-slate-50 px-4 py-4">
                                    <p className="text-xs font-bold text-slate-400">{stat.label}</p>
                                    <p className={`mt-2 text-3xl font-black ${stat.tone}`}>{stat.value}</p>
                                </div>
                            ))}
                        </div>
                        <div className={`mt-5 rounded-lg border px-4 py-3 text-sm leading-6 ${deviceHaError ? 'border-amber-100 bg-amber-50 text-amber-800' : 'border-blue-100 bg-blue-50 text-blue-800'}`}>
                            {deviceHaError
                                ? 'Home Assistant 实时状态未取得；当前数据仅表示本次平台台账快照，现场硬件状态仍待连接恢复后确认。'
                                : '当前页面集中呈现设备台账与 Home Assistant 回读快照；最终状态以现场硬件为准。'}
                        </div>
                    </div>

                    <div className="rounded-2xl bg-white p-7 shadow-sm">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                            <div>
                                <p className="text-xs font-semibold text-slate-400">实时设备快照</p>
                                <h2 className="mt-2 text-2xl font-bold text-slate-900 font-headline">设备状态快照</h2>
                            </div>
                            <p className="text-xs font-semibold text-slate-400">按名称展示前 6 台设备，完整列表进入设备控制页</p>
                        </div>
                        <div className="mt-5 overflow-hidden rounded-lg border border-slate-200">
                            {recentDevices.length > 0 ? (
                                <div className="divide-y divide-slate-100">
                                    {recentDevices.map((device) => {
                                        const status = device.status || 'unknown'
                                        const statusLabel = DEVICE_STATUS_TEXT[status] || '状态待确认'
                                        return (
                                            <div key={device.id} className="grid gap-3 px-4 py-4 md:grid-cols-[1.1fr_0.8fr_0.8fr_0.7fr] md:items-center">
                                                <div className="min-w-0">
                                                    <p className="truncate text-sm font-bold text-slate-900" title={device.name}>{device.name}</p>
                                                    <p className="mt-1 truncate text-xs font-medium text-slate-400" title={`${device.location || '未填写位置'} · ${getDeviceCategoryLabel(device.category)}`}>
                                                        {device.location || '未填写位置'} · {getDeviceCategoryLabel(device.category)}
                                                    </p>
                                                </div>
                                                <div className="min-w-0 text-xs font-semibold text-slate-500">
                                                    <p className="truncate" title={device.gateway_name || '未配置网关'}>{device.gateway_name || '未配置网关'}</p>
                                                    <p className="mt-1 truncate text-slate-400" title={getGatewayTypeLabel(device.gateway_type || device.protocol)}>{getGatewayTypeLabel(device.gateway_type || device.protocol)}</p>
                                                </div>
                                                <div className="min-w-0">
                                                    <p className="truncate text-sm font-bold text-slate-800" title={formatDeviceValue(device)}>{formatDeviceValue(device)}</p>
                                                    <p className="mt-1 text-xs font-medium text-slate-400">{formatDeviceUpdatedAt(device)}</p>
                                                </div>
                                                <div className="flex md:justify-end">
                                                    <span
                                                        className={`rounded-full px-3 py-1 text-xs font-bold ${DEVICE_STATUS_STYLE[status] || DEVICE_STATUS_STYLE.unmapped}`}
                                                        title={DEVICE_STATUS_TEXT[status] ? undefined : `技术状态：${status}`}
                                                    >
                                                        {statusLabel}
                                                    </span>
                                                </div>
                                            </div>
                                        )
                                    })}
                                </div>
                            ) : (
                                <div className="flex min-h-[220px] items-center justify-center px-6 text-center text-sm leading-6 text-slate-400">
                                    {deviceLoading ? '正在读取设备台账...' : deviceError ? `设备台账未取得：${deviceError}` : '暂无设备台账数据。请先在设备控制页添加设备或同步 Home Assistant 实体。'}
                                </div>
                            )}
                        </div>
                    </div>
                </section>

                {/* Bottom Lists Row */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

                    {/* Service Health */}
                    <div className="glass-card p-8 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.04)]">
                        <h3 className="text-xl font-bold mb-6 text-slate-800 font-headline">系统运行状况</h3>
                        <div className="space-y-3">
                            {services.map((svc, i) => {
                                const Icon = SERVICE_ICONS[svc.name] || Server
                                return (
                                    <div key={i} className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3.5 transition-colors hover:bg-slate-100 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                                        <div className="flex min-w-0 items-center gap-3">
                                            <Icon className="text-blue-600 w-5 h-5" />
                                            <div className="min-w-0">
                                                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                                    <span className="break-words font-semibold text-slate-800 text-sm font-body">{svc.name}</span>
                                                    {svc.latency_ms !== null && svc.latency_ms !== undefined ? <span className="text-xs text-slate-400 font-body">{svc.latency_ms} 毫秒</span> : null}
                                                    {svc.extra ? <span className="text-xs text-slate-400 font-body">{svc.extra}</span> : null}
                                                </div>
                                                {svc.diagnostic ? <p className="mt-1 break-words text-xs font-medium leading-5 text-slate-500">{svc.diagnostic}</p> : null}
                                            </div>
                                        </div>
                                        <span className={`w-fit shrink-0 rounded-full px-3 py-1 text-xs font-semibold sm:justify-self-end ${STATUS_STYLE[svc.status] || 'bg-slate-100 text-slate-500'}`}>
                                            {STATUS_TEXT[svc.status] || '状态待确认'}
                                        </span>
                                    </div>
                                )
                            })}
                            {serviceLoading && !services.length && !serviceError ? (
                                <div className="flex min-h-28 items-center justify-center gap-2 rounded-lg border border-slate-100 bg-slate-50 text-sm text-slate-400">
                                    <Loader2 size={16} className="animate-spin text-blue-600" />正在探测外部服务
                                </div>
                            ) : null}
                            {serviceError ? (
                                <div className="flex flex-col gap-2 rounded-lg border border-rose-100 bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-700 sm:flex-row sm:items-center sm:justify-between">
                                    <span>{serviceError}。{servicesLoaded ? `当前保留上一次成功探测的${services.length ? `${services.length} 项服务` : '空结果'}` : '服务状态尚未取得'}；主机、设备与使用记录不受影响。</span>
                                    <button type="button" onClick={() => void loadSlowSections(true, ['services'])} disabled={serviceLoading} className="shrink-0 font-bold text-rose-700 disabled:opacity-50">重新检查服务</button>
                                </div>
                            ) : null}
                            {!serviceLoading && servicesLoaded && !serviceError && services.length === 0 ? (
                                <div className="flex min-h-28 items-center justify-center rounded-lg border border-slate-100 bg-slate-50 px-5 text-center text-sm leading-6 text-slate-400">
                                    本次探测未返回需要展示的外部服务。
                                </div>
                            ) : null}
                        </div>
                    </div>

                    {/* Recent Activity Logs */}
                    <div className="glass-card p-8 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.04)]">
                        <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                            <div>
                                <h3 className="text-xl font-bold text-slate-800 font-headline">{isAdmin ? '最近平台使用记录' : '我的最近使用记录'}</h3>
                                <p className="mt-1 text-xs font-medium leading-5 text-slate-400">
                                    {logsLoaded
                                        ? logTotal === null
                                            ? `当前展示 ${logs.length} 条，完整总数未取得`
                                            : `当前展示 ${logs.length} 条，共 ${logTotal} 条`
                                        : '正在读取使用记录范围'}
                                    {logsLoaded && logCollapsedCount !== null && logCollapsedCount > 0
                                        ? ` · 已折叠 ${logCollapsedCount} 条周期记录${logRawTotal !== null ? `（原始 ${logRawTotal} 条）` : ''}`
                                        : ''}
                                </p>
                            </div>
                            <Link href="/activity-logs" className="inline-flex min-h-8 shrink-0 items-center text-xs font-bold text-blue-600 hover:underline">
                                查看全部记录
                            </Link>
                        </div>
                        <div className="space-y-6">
                            {(() => {
                                // 真实数据库日志
                                const dbLogs = logs

                                const LOG_ICONS: Record<string, LucideIcon> = {
                                    device_control: Home,
                                    user_login: User,
                                    system: CheckCircle,
                                    ai: Sparkles,
                                    warning: AlertTriangle,
                                }
                                const LOG_COLORS: Record<string, string> = {
                                    device_control: 'bg-blue-100 text-blue-600',
                                    user_login: 'bg-indigo-100 text-indigo-600',
                                    system: 'bg-emerald-100 text-emerald-600',
                                    ai: 'bg-purple-100 text-purple-600',
                                    warning: 'bg-amber-100 text-amber-600',
                                    info: 'bg-blue-100 text-blue-600',
                                }

                                // 使用记录只展示真实审计日志，系统状态由相邻区块单独承担。
                                if (dbLogs.length > 0) {
                                    return dbLogs.map((log, i) => {
                                        const Icon = LOG_ICONS[log.type] || CheckCircle
                                        const color = LOG_COLORS[log.type] || LOG_COLORS[log.level] || 'bg-slate-100 text-slate-500'
                                        return (
                                            <div key={log.id || i} className="flex items-center gap-4">
                                                <div className={`flex items-center justify-center w-10 h-10 rounded-full ${color} shrink-0`}>
                                                    <Icon className="w-4 h-4" />
                                                </div>
                                                <div className="min-w-0 flex-1">
                                                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                                                        <p className="min-w-0 truncate text-sm font-bold text-slate-800 font-body" title={log.title}>{log.title}</p>
                                                        {(log.repeat_count || 1) > 1 ? (
                                                            <span className="inline-flex h-6 shrink-0 items-center rounded-full bg-amber-50 px-2 text-xs font-bold leading-none text-amber-700">重复 {log.repeat_count} 次</span>
                                                        ) : null}
                                                    </div>
                                                    <p className="mt-1 text-xs font-medium text-slate-500 font-body">
                                                        {log.time} {log.username ? `· ${displayOperator(log.username)}` : ''}
                                                    </p>
                                                </div>
                                            </div>
                                        )
                                    })
                                }

                                return (
                                    <div className="flex min-h-40 items-center justify-center rounded-lg border border-slate-100 bg-slate-50 px-6 text-center text-sm leading-6 text-slate-400">
                                        {logsLoading && !logsLoaded
                                            ? `正在读取${isAdmin ? '平台' : '我的'}真实使用记录`
                                            : logsError && !logsLoaded
                                                ? `${isAdmin ? '平台' : '我的'}使用记录未取得：${logsError}`
                                                : logsError
                                                    ? `读取更新失败，保留上次确认的空记录：${logsError}`
                                                    : `当前没有${isAdmin ? '平台' : '我的'}使用记录`}
                                    </div>
                                )
                            })()}
                            {logsError && logsLoaded && logs.length > 0 ? (
                                <div className="rounded-lg border border-amber-100 bg-amber-50 px-4 py-3 text-xs font-semibold leading-5 text-amber-800">
                                    使用记录更新失败，当前保留上一次成功读取的 {logs.length} 条记录：{logsError}
                                </div>
                            ) : null}
                        </div>
                    </div>
                </div>

            </main>
        </div>
    )
}
