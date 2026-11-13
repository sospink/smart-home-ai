'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import {
  Activity,
  AlertCircle,
  DoorOpen,
  Flame,
  Lock,
  Power,
  RefreshCw,
  Search,
  ShieldCheck,
  Thermometer,
  Trash2,
  TriangleAlert,
  Waves,
  Wind,
} from 'lucide-react'
import { AppDialog } from '@/components/ui/AppDialog'
import { Pagination } from '@/components/ui/Pagination'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { TechnicalId } from '@/components/ui/TechnicalId'
import { UnifiedSelect } from '@/components/ui/UnifiedSelect'
import {
  clearSandboxLogs,
  controlSandboxDevice,
  executeScene,
  fetchSandboxDevices,
  fetchSandboxLogs,
  fetchScenePresets,
  injectData,
  type SandboxLog,
  type SceneExecutionResult,
  type ScenePreset,
  type VirtualDevice,
} from '@/lib/api/sandbox'
import { useAuth } from '@/lib/hooks/useAuth'
import { businessErrorMessage } from '@/lib/ui/business-error'

type SensorControlState = {
  [entityId: string]: number
}

type LogSummary = {
  total: number
  successful: number
  attention: number
  last_24h: number
  latest_at: string | null
}

const EMPTY_LOG_SUMMARY: LogSummary = {
  total: 0,
  successful: 0,
  attention: 0,
  last_24h: 0,
  latest_at: null,
}

const WRITE_UI_TIMEOUT_MS = 12_000
const SCENE_UI_TIMEOUT_MS = 20_000

type DeviceAction = {
  label: string
  service: string
  data?: Record<string, unknown>
}

type PendingControls = Record<string, string>
type ScenePreflight = {
  total: number
  available: number
  unavailable: number
  byEntityId: Record<string, boolean>
}
type SandboxReadSelection = {
  devices?: boolean
  scenes?: boolean
}

const SENSOR_UNITS: Record<string, string> = {
  'sensor.shi_nei_wen_du': '°C',
  'sensor.shi_nei_shi_du': '%',
  'sensor.pm2_5': 'μg/m³',
  'sensor.dang_qian_gong_hao': 'W',
}

const SENSOR_ICONS: Record<string, typeof Thermometer> = {
  'sensor.shi_nei_wen_du': Thermometer,
  'sensor.shi_nei_shi_du': Waves,
  'sensor.pm2_5': Wind,
  'sensor.dang_qian_gong_hao': Flame,
}

const DEVICE_ICONS: Record<string, typeof Activity> = {
  light: Power,
  switch: Power,
  climate: Thermometer,
  lock: Lock,
  binary_sensor: DoorOpen,
}

const DEVICE_CATEGORY_LABELS: Record<string, string> = {
  light: '灯光',
  switch: '开关',
  climate: '温控',
  lock: '门锁',
  binary_sensor: '门磁',
  sensor: '传感器',
}

const REAL_SANDBOX_REQUIREMENTS = [
  '通信协议',
  '点位表',
  '命令表',
  '状态回传',
  '错误码',
  '刷新频率',
  '鉴权方式',
  '联调负责人',
]

function formatState(value: unknown) {
  if (value === null || value === undefined || value === '') return '--'
  const text = String(value).trim()
  const known = ({
    on: '开启',
    off: '关闭',
    open: '打开',
    closed: '关闭',
    locked: '已上锁',
    unlocked: '未上锁',
    开: '开启',
    关: '关闭',
    unavailable: '不可用',
    unknown: '未知',
  } as Record<string, string>)[text.toLowerCase()]
  if (known) return known
  if (/^-?\d+(?:\.\d+)?$/.test(text) || /[\u4e00-\u9fff]/.test(text)) return text
  return '状态待确认'
}

function deviceStateLabel(device: VirtualDevice, value: unknown) {
  const normalized = String(value ?? '').toLowerCase()
  if (device.category === 'lock') {
    if (['on', 'locked'].includes(normalized)) return '已上锁'
    if (['off', 'unlocked'].includes(normalized)) return '未上锁'
  }
  return formatState(value)
}

function stateIsActive(value: unknown) {
  return ['on', 'open', 'locked', '开启', '打开', '开', '已上锁'].includes(String(value ?? '').toLowerCase())
}

function formatDateTime(value?: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date)
}

function formatLatestLogTime(value?: string | null) {
  return value ? formatDateTime(value) : '暂无记录'
}

function normalizeSensorDraft(value: number, config?: VirtualDevice['inject_config']) {
  if (!config) return value
  const min = config.min ?? 0
  const max = config.max ?? 100
  const step = config.step > 0 ? config.step : 1
  const clamped = Math.min(max, Math.max(min, value))
  const stepped = min + Math.round((clamped - min) / step) * step
  const precision = String(step).includes('.') ? String(step).split('.')[1].length : 0
  return Number(stepped.toFixed(precision))
}

function logActionLabel(action: SandboxLog['action']) {
  return ({
    inject: '传感器注入',
    control: '设备控制',
    scene: '场景执行',
    system: '系统记录',
  } as const)[action] || '系统记录'
}

function logSourceLabel(source: SandboxLog['source']) {
  return ({ manual: '手动操作', preset: '场景预设', auto: '自动任务' } as const)[source] || '系统来源'
}

function logResultLabel(log: SandboxLog) {
  if (log.level === 'error') return '执行失败'
  if (log.level === 'warning' || log.confirmed === false) return '需要关注'
  if (log.level === 'success' || log.confirmed === true) return '执行成功'
  return '信息记录'
}

function logBusinessDetail(log: SandboxLog) {
  if (log.action === 'scene' && log.total !== null) {
    return `共 ${log.total} 项，成功 ${log.succeeded ?? 0} 项，失败 ${log.failed ?? 0} 项`
  }
  if (log.error) return sandboxBusinessError(log.error)
  if (log.requested_value || log.actual_state) {
    return `目标 ${formatState(log.requested_value)} · 回读 ${formatState(log.actual_state)}`
  }
  return `${logActionLabel(log.action)} · ${logSourceLabel(log.source)}`
}

function stripLeadingEmoji(value: string) {
  return value.replace(/^[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D\s]+/u, '').trim()
}

function logSnapshotKey(keyword: string, action: string, level: string, page: number, pageSize: number) {
  return JSON.stringify({ keyword: keyword.trim(), action, level, page, pageSize })
}

function getPrimaryEntityId(device: VirtualDevice) {
  const entityIds = Object.values(device.entities || {})
  return entityIds[0] || ''
}

function getPrimaryEntityState(device: VirtualDevice) {
  const primaryKey = Object.keys(device.entities || {})[0]
  if (!primaryKey) return null
  return device.entity_states?.[primaryKey] ?? null
}

function entityStateAvailable(state: VirtualDevice['entity_states'][string] | null | undefined) {
  const value = String(state?.state ?? '').trim().toLowerCase()
  return Boolean(value && !['unknown', 'unavailable'].includes(value))
}

function deviceAvailabilityLabel(device: VirtualDevice) {
  if (device.availability === 'partial') {
    return `部分实体不可用（${device.available_entity_count}/${device.total_entity_count}）`
  }
  if (device.availability === 'unavailable') return '设备实体不可用'
  return '设备实体可用'
}

function withAvailability(device: VirtualDevice, entityStates: VirtualDevice['entity_states']): VirtualDevice {
  const roles = Object.keys(device.entities || {})
  const missingRoles = roles.filter((role) => !entityStateAvailable(entityStates[role]))
  const availableEntityCount = roles.length - missingRoles.length
  return {
    ...device,
    entity_states: entityStates,
    availability: missingRoles.length === 0 ? 'available' : availableEntityCount > 0 ? 'partial' : 'unavailable',
    available_entity_count: availableEntityCount,
    total_entity_count: roles.length,
    missing_roles: missingRoles,
  }
}

function scenePreflight(scene: ScenePreset, devices: VirtualDevice[]): ScenePreflight {
  const availableByEntityId = new Map<string, boolean>()
  for (const device of devices) {
    for (const [role, entityId] of Object.entries(device.entities || {})) {
      availableByEntityId.set(entityId, entityStateAvailable(device.entity_states?.[role]))
    }
  }
  const byEntityId: Record<string, boolean> = {}
  let available = 0
  for (const operation of scene.operations) {
    const operationAvailable = availableByEntityId.get(operation.entity_id) === true
    byEntityId[operation.entity_id] = operationAvailable
    if (operationAvailable) available += 1
  }
  return {
    total: scene.operations.length,
    available,
    unavailable: Math.max(0, scene.operations.length - available),
    byEntityId,
  }
}

function classifySandboxError(message: string) {
  if (/真实|硬件|协议|沙盘/i.test(message)) return '真实硬件未接入'
  if (/entity|实体|not found|404|unavailable|unknown/i.test(message)) return '虚拟实体缺失或不可用'
  if (/Home Assistant|HA|连接|timeout|503|502|network|fetch/i.test(message)) return 'HA 不可用或连接失败'
  return '沙盘操作失败'
}

function sandboxBusinessError(value: string) {
  const message = String(value || '').trim()
  if (!message) return '沙盘操作未完成，请查看运行日志'
  const containsTechnicalDetail = /https?:\/\/|\b(?:entity|service|action|result|state|http|json|timeout|connect|unavailable|unknown|not found|server disconnected)\b|(?:light|sensor|switch|scene|input_[a-z]+)\.[a-z0-9_]+/i.test(message)
  if (!containsTechnicalDetail && /[\u4e00-\u9fff]/.test(message)) return message
  return classifySandboxError(message)
}

function businessActionLabel(value: string) {
  const label = String(value || '').trim()
  if (label && /[\u4e00-\u9fff]/.test(label)) return label
  return '设备操作'
}

function sandboxLoadErrorMessage(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message.trim() : String(error || '').trim()
  const normalized = message.toLowerCase()
  if (!message) return fallback
  if (/all connection attempts failed|connection refused|connecterror|network is unreachable|server disconnected/i.test(message)) {
    return 'Home Assistant 当前无法建立连接，请检查服务地址、网络和运行状态'
  }
  if (/timeout|timed out|connecttimeout|readtimeout/i.test(normalized)) {
    return 'Home Assistant 连接超时，请检查服务地址、网络和运行状态'
  }
  return /[\u4e00-\u9fff]/.test(message) ? message : fallback
}

function serviceActionsForDevice(device: VirtualDevice) {
  const primaryEntityId = getPrimaryEntityId(device)
  if (!primaryEntityId || device.injectable) return []

  const domain = primaryEntityId.split('.')[0]
  if (domain === 'binary_sensor' || domain === 'sensor') return []
  if (domain === 'input_select') {
    return [
      { label: '开启', service: 'input_select.select_option', data: { option: '开' } },
      { label: '关闭', service: 'input_select.select_option', data: { option: '关' } },
    ]
  }
  if (domain === 'input_boolean') {
    return [
      { label: device.category === 'lock' ? '上锁' : '开启', service: 'input_boolean.turn_on' },
      { label: device.category === 'lock' ? '解锁' : '关闭', service: 'input_boolean.turn_off' },
    ]
  }
  return []
}

function currentDeviceActions(device: VirtualDevice, actions: DeviceAction[]) {
  const state = getPrimaryEntityState(device)?.state
  if (!state || ['unknown', 'unavailable'].includes(String(state).toLowerCase())) return actions
  const active = stateIsActive(state)
  return actions.filter((action) => {
    const service = action.service.toLowerCase()
    if (service.endsWith('turn_on')) return !active
    if (service.endsWith('turn_off')) return active
    const option = String(action.data?.option || '').toLowerCase()
    if (option === '开') return !active
    if (option === '关') return active
    return true
  })
}

function SensorBlock({
  device,
  value,
  onChange,
  onInject,
  onCancel,
  pending,
  operational,
  dirty,
}: {
  device: VirtualDevice
  value: number | null
  onChange: (value: number) => void
  onInject: () => void
  onCancel: () => void
  pending: boolean
  operational: boolean
  dirty: boolean
}) {
  const primaryEntityId = getPrimaryEntityId(device)
  const primaryState = getPrimaryEntityState(device)
  const config = device.inject_config
  const Icon = SENSOR_ICONS[primaryEntityId] || Activity
  const unit = config?.unit || SENSOR_UNITS[primaryEntityId] || ''
  const hasDraftValue = value !== null && Number.isFinite(value)
  const entityOperational = operational && entityStateAvailable(primaryState)
  const displayedState = entityStateAvailable(primaryState) ? formatState(primaryState?.state) : '—'

  return (
    <div className="rounded-2xl bg-[#dfe8ff] p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
            <Icon size={18} />
          </div>
          <div>
            <div className="text-sm font-bold text-slate-900">{device.name}</div>
            <div className="text-xs text-slate-500">{device.area}</div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-sm font-black text-blue-600">{displayedState}{displayedState === '—' ? '' : ` ${unit}`}</div>
          <div className="text-xs text-slate-400">HA 回读值</div>
        </div>
      </div>
      <div className="mb-2 flex items-center justify-between text-xs text-slate-500">
        <span>{dirty ? '待注入值 · 已调整' : hasDraftValue ? '拖动滑块设置待注入值' : 'HA 回读值尚未取得'}</span>
        {hasDraftValue ? <span className={dirty ? 'font-bold text-blue-700' : ''}>{dirty ? `${value}${unit}` : '未调整'}</span> : null}
      </div>
      <div className="flex items-center gap-3">
        {hasDraftValue ? (
          <input
            type="range"
            aria-label={`调整${device.name}虚拟传感器数值`}
            aria-valuetext={`${dirty ? '待注入值' : 'HA 当前回读值'} ${value}${unit}`}
            min={config?.min ?? 0}
            max={config?.max ?? 100}
            step={dirty ? config?.step ?? 1 : 'any'}
            value={value}
            onChange={(event) => onChange(normalizeSensorDraft(Number(event.target.value), config))}
            disabled={!entityOperational}
            className="h-2 flex-1 cursor-pointer accent-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
          />
        ) : (
          <div className="h-2 flex-1 rounded-full border border-dashed border-blue-300 bg-white/50" aria-hidden="true" />
        )}
        <button
          onClick={pending ? onCancel : onInject}
          disabled={!pending && (!entityOperational || !hasDraftValue || !dirty)}
          title={pending ? '取消等待当前注入结果' : !operational ? 'HA 离线，暂不可执行' : !entityStateAvailable(primaryState) ? '当前传感器实体不可用，无法注入' : !hasDraftValue ? '尚未取得传感器回读值' : dirty ? '注入调整后的虚拟传感器数值' : '调整数值后可注入'}
          className="min-h-9 rounded-lg bg-blue-600 px-3 py-2 text-xs font-bold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? '取消等待' : entityOperational ? '注入' : operational ? '实体不可用' : 'HA 离线'}
        </button>
      </div>
      {operational && !entityStateAvailable(primaryState) ? <p className="mt-3 text-xs font-medium text-amber-700">当前传感器实体不可用，已暂停数值调整和注入。</p> : null}
    </div>
  )
}

function DeviceCard({
  device,
  pendingControls,
  onControl,
  onCancel,
  operational,
}: {
  device: VirtualDevice
  pendingControls: PendingControls
  onControl: (device: VirtualDevice, action: DeviceAction) => void
  onCancel: (entityId: string) => void
  operational: boolean
}) {
  const primaryState = getPrimaryEntityState(device)
  const actions = currentDeviceActions(device, serviceActionsForDevice(device))
  const primaryEntityId = getPrimaryEntityId(device)
  const Icon = DEVICE_ICONS[device.category] || Activity
  const stateLabel = deviceStateLabel(device, primaryState?.state)
  const pendingActionKey = pendingControls[primaryEntityId] || ''
  const primaryEntityAvailable = entityStateAvailable(primaryState)
  const actionOperational = operational && primaryEntityAvailable

  return (
    <div className="rounded-2xl bg-[#dfe8ff] p-4">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
            <Icon size={18} />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-black text-slate-900" title={device.name}>{device.name}</div>
            <div className="mt-1 text-xs text-slate-500">{device.area} · {DEVICE_CATEGORY_LABELS[device.category] || '虚拟设备'}</div>
          </div>
        </div>
        <span className={`inline-flex shrink-0 rounded-full px-3 py-1 text-xs font-bold ${stateIsActive(primaryState?.state) ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>
          {stateLabel}
        </span>
      </div>

      {actions.length ? (
        <div className="mt-4 flex items-center gap-2 border-t border-blue-100 pt-3">
          {actions.map((action) => {
            const actionKey = `${primaryEntityId}:${action.service}:${action.label}`
            const isPending = pendingActionKey === actionKey
            return (
              <button
                key={actionKey}
                onClick={() => onControl(device, action)}
                disabled={Boolean(pendingActionKey) || !actionOperational}
                title={!operational ? 'HA 离线，暂不可执行' : !primaryEntityAvailable ? '当前控制实体不可用，暂不可执行' : pendingActionKey && !isPending ? '当前设备仍有操作未结束，可先取消等待' : `${action.label}${device.name}`}
                className="flex-1 rounded-[8px] bg-slate-900 px-3 py-2 text-sm font-bold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isPending ? `正在${action.label}` : action.label}
              </button>
            )
          })}
          {pendingActionKey ? (
            <button type="button" onClick={() => onCancel(primaryEntityId)} className="rounded-[8px] border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800">
              取消等待
            </button>
          ) : null}
        </div>
      ) : null}
      {!operational ? <p className="mt-3 text-xs font-medium text-amber-700">HA 离线，暂不可执行</p> : null}
      {operational && device.availability !== 'available' ? <p className="mt-3 text-xs font-medium text-amber-700">{deviceAvailabilityLabel(device)}{!primaryEntityAvailable && actions.length ? '，控制已暂停。' : '。'}</p> : null}
    </div>
  )
}

function SceneCard({
  scene,
  onExecute,
  onCancel,
  pending,
  blocked,
  operational,
  preflight,
}: {
  scene: ScenePreset
  onExecute: (scene: ScenePreset) => void
  onCancel: () => void
  pending: boolean
  blocked: boolean
  operational: boolean
  preflight: ScenePreflight
}) {
  const allTargetsUnavailable = preflight.total > 0 && preflight.available === 0
  return (
    <div className="flex h-full flex-col rounded-2xl bg-[#dfe8ff] p-5">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="text-base font-black text-slate-900">{stripLeadingEmoji(scene.name)}</div>
        <ShieldCheck size={18} className="shrink-0 text-slate-400" />
      </div>
      <p className="line-clamp-3 min-h-[72px] text-sm leading-6 text-slate-500" title={scene.description}>{scene.description}</p>
      <div className="mb-4 mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs font-semibold text-slate-500">
        <span>共 {scene.operation_count} 项</span>
        <span>数据注入 {scene.injection_count}</span>
        <span>设备控制 {scene.control_count}</span>
      </div>
      {operational && preflight.unavailable > 0 ? (
        <div className={`mb-3 border-l-2 px-3 py-2 text-xs font-semibold leading-5 ${allTargetsUnavailable ? 'border-rose-400 bg-rose-50 text-rose-700' : 'border-amber-400 bg-amber-50 text-amber-800'}`}>
          {allTargetsUnavailable ? '所需虚拟实体全部不可用' : `预计可执行 ${preflight.available} 项，${preflight.unavailable} 项实体不可用`}
        </div>
      ) : null}
      <button
        onClick={pending ? onCancel : () => onExecute(scene)}
        disabled={!pending && (!operational || allTargetsUnavailable || blocked)}
        title={!operational
          ? 'HA 离线，暂不可执行'
          : allTargetsUnavailable
            ? '场景所需虚拟实体全部不可用，未发送任何步骤'
          : pending
            ? '取消等待当前场景结果'
            : blocked
              ? '另一个场景仍在执行，请先等待结果或取消等待后核对状态'
              : `执行${stripLeadingEmoji(scene.name)}`}
        className="mt-auto w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? '取消等待' : blocked ? '等待其他场景' : allTargetsUnavailable ? '场景目标不可用' : operational ? '执行场景' : 'HA 离线，暂不可执行'}
      </button>
    </div>
  )
}

function SceneConfirmationDialog({ scene, preflight, onClose, onConfirm }: { scene: ScenePreset | null; preflight: ScenePreflight | null; onClose: () => void; onConfirm: () => void }) {
  const allTargetsUnavailable = Boolean(preflight?.total && preflight.available === 0)
  return (
    <AppDialog
      open={Boolean(scene)}
      onClose={onClose}
      title={`确认执行${stripLeadingEmoji(scene?.name || '虚拟场景')}`}
      description="该操作只写入预定义的 Home Assistant 虚拟实体，不代表真实硬件已经动作。"
      maxWidth="max-w-lg"
      footer={(
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="min-h-10 rounded-lg border border-slate-200 px-4 text-sm font-bold text-slate-700 hover:bg-slate-50">取消</button>
          <button type="button" onClick={onConfirm} disabled={allTargetsUnavailable} className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-bold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50">
            <ShieldCheck size={15} />确认执行
          </button>
        </div>
      )}
    >
      {scene ? (
        <div className="space-y-4">
          <p className="text-sm leading-6 text-slate-600">{scene.description}</p>
          <div className="grid grid-cols-3 overflow-hidden rounded-[8px] border border-slate-200 text-center">
            {[
              ['总操作', scene.operation_count],
              ['数据注入', scene.injection_count],
              ['设备控制', scene.control_count],
            ].map(([label, value], index) => (
              <div key={label} className={`${index < 2 ? 'border-r border-slate-200' : ''} bg-slate-50 px-3 py-3`}>
                <div className="text-xs font-semibold text-slate-500">{label}</div>
                <div className="mt-1 text-lg font-black text-slate-900">{value}</div>
              </div>
            ))}
          </div>
          <div className="max-h-64 overflow-y-auto rounded-lg border border-slate-200 px-2">
            {scene.operations.map((item, index) => {
              const available = preflight?.byEntityId[item.entity_id] === true
              return (
              <div key={`${item.device_name}-${item.action_label}-${index}`} className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(88px,auto)] gap-x-3 gap-y-1 border-b border-slate-100 px-2 py-2.5 text-xs last:border-b-0 sm:grid-cols-[minmax(100px,1fr)_100px_minmax(110px,1fr)] sm:gap-3">
                <span className="min-w-0 font-bold text-slate-800">{item.device_name}<span className={`ml-2 whitespace-nowrap text-xs ${available ? 'text-emerald-700' : 'text-rose-700'}`}>{available ? '可执行' : '实体不可用'}</span></span>
                <span className="col-start-1 row-start-2 min-w-0 text-slate-500 sm:col-auto sm:row-auto" title={/[\u4e00-\u9fff]/.test(item.action_label) ? undefined : `技术动作：${item.action_label || '未返回'}`}>{businessActionLabel(item.action_label)}</span>
                <span className="col-start-2 row-span-2 row-start-1 min-w-0 self-center break-words text-right font-semibold text-slate-700 [overflow-wrap:anywhere] sm:col-auto sm:row-auto">{item.target_label}</span>
              </div>
              )
            })}
          </div>
          <div className={`border-l-2 px-4 py-3 text-xs font-semibold leading-5 ${allTargetsUnavailable ? 'border-rose-400 bg-rose-50 text-rose-800' : 'border-amber-400 bg-amber-50 text-amber-800'}`}>
            {allTargetsUnavailable ? '当前所有目标实体均不可用，确认执行已禁用，不会发送场景请求。' : preflight?.unavailable ? `当前有 ${preflight.unavailable} 项实体不可用；继续执行时其余步骤仍会逐项回读，结果不会包装成整体成功。` : '执行后将逐项回读目标状态；部分步骤失败时不会包装成整体成功。'}
          </div>
        </div>
      ) : null}
    </AppDialog>
  )
}

function SceneResultDialog({ result, onClose }: { result: SceneExecutionResult | null; onClose: () => void }) {
  return (
    <AppDialog
      open={Boolean(result)}
      onClose={onClose}
      title={result ? `${stripLeadingEmoji(result.scene)}执行结果` : '场景执行结果'}
      description={result ? `成功 ${result.succeeded_count} 项，失败 ${result.failed_count} 项；以下状态来自 Home Assistant 逐项回读。` : undefined}
      maxWidth="max-w-3xl"
      footer={<button type="button" onClick={onClose} className="min-h-10 rounded-lg border border-slate-200 px-4 text-sm font-bold text-slate-700 hover:bg-slate-50">关闭</button>}
    >
      {result ? (
        <div className="overflow-hidden rounded-[8px] border border-slate-200">
          <div className="hidden grid-cols-[88px_minmax(130px,1fr)_110px_minmax(180px,1.3fr)] gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs font-bold text-slate-500 sm:grid">
            <div>结果</div><div>联调对象</div><div>动作</div><div>目标与回读</div>
          </div>
          <div className="divide-y divide-slate-100">
            {result.results.map((item, index) => (
              <div key={`${item.entity_id}-${index}`} className="px-4 py-3">
                <div className="grid min-w-0 grid-cols-[88px_minmax(0,1fr)] items-start gap-x-3 gap-y-2 sm:grid-cols-[88px_minmax(130px,1fr)_110px_minmax(180px,1.3fr)] sm:gap-3">
                  <StatusBadge status={item.success ? 'success' : 'error'} label={item.success ? '已确认' : '失败'} />
                  <div className="min-w-0 text-sm font-bold text-slate-900">{stripLeadingEmoji(item.device_name)}</div>
                  <div className="col-start-1 row-start-2 text-xs font-semibold leading-5 text-slate-600 sm:col-auto sm:row-auto" title={/[\u4e00-\u9fff]/.test(item.action_label) ? undefined : `技术动作：${item.action_label || '未返回'}`}>{businessActionLabel(item.action_label)}</div>
                  <div className={`col-start-2 row-start-2 min-w-0 break-words text-xs leading-5 [overflow-wrap:anywhere] sm:col-auto sm:row-auto ${item.error ? 'font-semibold text-rose-700' : 'text-slate-600'}`}>
                    {item.error ? sandboxBusinessError(item.error) : `目标 ${formatState(item.requested_value)} · 回读 ${formatState(item.actual_state)}`}
                  </div>
                </div>
                <details className="mt-2 text-xs text-slate-500">
                  <summary className="w-fit cursor-pointer font-semibold hover:text-slate-700">技术详情</summary>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <TechnicalId value={item.entity_id} label="HA 实体 ID" />
                    <TechnicalId value={item.service || ''} label="HA 服务" />
                    {item.error ? <TechnicalId value={item.error} label="原始错误" /> : null}
                  </div>
                </details>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </AppDialog>
  )
}

function LogPanel({
  logs,
  summary,
  total,
  page,
  pageSize,
  loading,
  refreshing,
  error,
  loaded,
  snapshotMatchesView,
  keyword,
  action,
  level,
  isAdmin,
  onKeywordChange,
  onActionChange,
  onLevelChange,
  onPageChange,
  onRefresh,
  onClear,
}: {
  logs: SandboxLog[]
  summary: LogSummary
  total: number
  page: number
  pageSize: number
  loading: boolean
  refreshing: boolean
  error: string | null
  loaded: boolean
  snapshotMatchesView: boolean
  keyword: string
  action: string
  level: string
  isAdmin: boolean
  onKeywordChange: (value: string) => void
  onActionChange: (value: string) => void
  onLevelChange: (value: string) => void
  onPageChange: (value: number) => void
  onRefresh: () => void
  onClear: (signal: AbortSignal) => Promise<number>
}) {
  const [selectedLog, setSelectedLog] = useState<SandboxLog | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [clearError, setClearError] = useState<string | null>(null)
  const clearLockRef = useRef(false)
  const clearControllerRef = useRef<AbortController | null>(null)
  const clearCancelRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (!snapshotMatchesView) setSelectedLog(null)
  }, [snapshotMatchesView])

  const openClearConfirmation = () => {
    if (!isAdmin) {
      setClearError('仅管理员可清空仿真日志')
      return
    }
    setClearError(null)
    setConfirmClear(true)
  }

  const closeClearConfirmation = () => {
    if (clearing) return
    setConfirmClear(false)
    setClearError(null)
  }

  const confirmClearLogs = async () => {
    if (!isAdmin) {
      setClearError('仅管理员可清空仿真日志')
      return
    }
    if (clearLockRef.current) {
      clearControllerRef.current?.abort()
      return
    }
    clearLockRef.current = true
    const controller = new AbortController()
    clearControllerRef.current = controller
    setClearing(true)
    setClearError(null)
    try {
      await onClear(controller.signal)
      setConfirmClear(false)
    } catch (reason) {
      if (controller.signal.aborted) {
        setClearError('已取消等待；日志可能已经清空，请刷新后确认。')
        onRefresh()
        return
      }
      setClearError(businessErrorMessage(reason, { fallback: '日志清理失败', service: '沙盘日志' }))
    } finally {
      if (clearControllerRef.current === controller) {
        clearControllerRef.current = null
        clearLockRef.current = false
        setClearing(false)
      }
    }
  }

  useEffect(() => () => clearControllerRef.current?.abort(), [])

  return (
    <>
      <div className="rounded-2xl bg-[#e9efff] p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <div className="text-base font-black text-slate-900">仿真日志</div>
            <div className="mt-1 text-xs text-slate-500">虚拟操作、HA 回读与失败诊断</div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onRefresh}
              disabled={loading}
              title="刷新日志"
              aria-label="刷新日志"
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 transition hover:bg-white/70 hover:text-slate-700 disabled:opacity-50"
            >
              <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
            </button>
            {isAdmin ? (
              <button
              type="button"
              onClick={openClearConfirmation}
              disabled={!loaded || !snapshotMatchesView}
                title="清空全部仿真日志"
                aria-label="清空全部仿真日志"
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 transition hover:bg-white/70 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Trash2 size={15} />
              </button>
            ) : null}
          </div>
        </div>

        <div className="mb-4 grid grid-cols-2 overflow-hidden rounded-[8px] border border-white/80">
          {[
            { label: '全部记录', value: summary.total },
            { label: '执行成功', value: summary.successful },
            { label: '需要关注', value: summary.attention },
            { label: '最近 24 小时', value: summary.last_24h },
          ].map((item) => (
            <div key={item.label} className="border-b border-r border-white/80 bg-white/55 px-3 py-2.5 even:border-r-0 [&:nth-last-child(-n+2)]:border-b-0">
              <div className="text-xs font-bold text-slate-400">{item.label}</div>
              <div className="mt-0.5 text-base font-black text-slate-800">{loaded ? item.value : '—'}</div>
            </div>
          ))}
        </div>

        <div className="mb-4 space-y-2">
          <label className="relative block min-w-0">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              aria-label="搜索仿真日志"
              value={keyword}
              onChange={(event) => onKeywordChange(event.target.value)}
              placeholder="搜索操作、设备或人员"
              className="min-h-10 w-full rounded-lg border border-white bg-white/80 py-2 pl-9 pr-3 text-xs text-slate-700 outline-none transition placeholder:text-slate-400 focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <UnifiedSelect
              ariaLabel="仿真日志操作类型"
              value={action}
              onChange={onActionChange}
              size="sm"
              options={[
                { value: '', label: '全部操作' },
                { value: 'inject', label: '传感器注入' },
                { value: 'control', label: '设备控制' },
                { value: 'scene', label: '场景执行' },
              ]}
            />
            <UnifiedSelect
              ariaLabel="仿真日志执行结果"
              value={level}
              onChange={onLevelChange}
              size="sm"
              options={[
                { value: '', label: '全部结果' },
                { value: 'success', label: '执行成功' },
                { value: 'warning', label: '需要关注' },
                { value: 'error', label: '执行失败' },
                { value: 'info', label: '信息记录' },
              ]}
            />
          </div>
        </div>

        {error ? (
          <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700">
            {loaded ? `刷新失败，${snapshotMatchesView ? '已保留同一条件下的上次日志' : '下方旧日志不代表当前筛选条件，详情和分页暂不可用'}：${error}` : `仿真日志未取得：${error}`}
          </div>
        ) : null}

        {loading && logs.length ? (
          <div className="mb-3 border-l-2 border-blue-500 bg-blue-50 px-3 py-2 text-xs font-semibold leading-5 text-blue-700" role="status" aria-live="polite">
            正在应用筛选条件并更新日志，{snapshotMatchesView ? '当前继续显示同一条件下的上次成功结果。' : '下方旧日志不代表当前筛选条件，详情和分页暂不可用。'}
          </div>
        ) : null}

        <div className="docs-api-scroll max-h-[430px] divide-y divide-white/90 overflow-y-auto border-y border-white/80" aria-busy={loading}>
          {logs.length ? (
            logs.map((log) => (
              <button
                key={log.id}
                type="button"
                onClick={() => setSelectedLog(log)}
                disabled={!snapshotMatchesView}
                className="w-full bg-white/45 px-3 py-3 text-left transition hover:bg-white/80 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-white/45"
              >
                <div className="mb-2 flex min-w-0 items-start justify-between gap-2">
                  <span className="min-w-0 flex-1 text-xs font-bold leading-5 text-slate-700">{log.title}</span>
                  <StatusBadge status={log.level} label={logResultLabel(log)} className="shrink-0" />
                </div>
                <div className="line-clamp-2 text-xs leading-5 text-slate-500" title={logBusinessDetail(log)}>{logBusinessDetail(log)}</div>
                <div className="mt-2 flex items-center justify-between gap-2 text-xs text-slate-400">
                  <span>{logActionLabel(log.action)} · {log.operator || '系统'}</span>
                  <span className="shrink-0">{formatDateTime(log.created_at)}</span>
                </div>
              </button>
            ))
          ) : (
            <div className="bg-white/45 px-4 py-8 text-center text-sm text-slate-400">
              {!loaded ? loading ? '正在读取日志...' : '仿真日志未取得' : loading ? '正在更新日志...' : keyword || action || level ? '没有符合条件的日志' : '暂无日志'}
            </div>
          )}
        </div>

        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          loading={loading}
          totalKnown={loaded}
          navigationDisabled={!snapshotMatchesView}
          onPageChange={onPageChange}
          itemName="条仿真日志"
          className="mt-4 border-white/80 px-0 pb-0 dark:border-white/80"
        />
      </div>

      <AppDialog
        open={Boolean(selectedLog)}
        onClose={() => setSelectedLog(null)}
        title="仿真日志详情"
        description={selectedLog ? `${logActionLabel(selectedLog.action)} · ${formatDateTime(selectedLog.created_at)}` : undefined}
        maxWidth="max-w-2xl"
        footer={(
          <button type="button" onClick={() => setSelectedLog(null)} className="min-h-10 rounded-lg border border-slate-200 px-4 text-sm font-bold text-slate-700 hover:bg-slate-50">
            关闭
          </button>
        )}
      >
        {selectedLog ? (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={selectedLog.level} label={logResultLabel(selectedLog)} />
              <span className="text-sm font-bold text-slate-900">{selectedLog.title}</span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-slate-100 bg-slate-50 p-4">
                <div className="text-xs text-slate-500">目标值</div>
                <div className="mt-1 text-sm font-bold text-slate-800">{formatState(selectedLog.requested_value)}</div>
              </div>
              <div className="rounded-lg border border-slate-100 bg-slate-50 p-4">
                <div className="text-xs text-slate-500">HA 实际回读</div>
                <div className="mt-1 text-sm font-bold text-slate-800">{formatState(selectedLog.actual_state)}</div>
              </div>
              {selectedLog.action === 'scene' ? (
                <>
                  <div className="rounded-lg border border-slate-100 bg-slate-50 p-4">
                    <div className="text-xs text-slate-500">场景执行</div>
                    <div className="mt-1 text-sm font-bold text-slate-800">共 {selectedLog.total ?? 0} 项</div>
                  </div>
                  <div className="rounded-lg border border-slate-100 bg-slate-50 p-4">
                    <div className="text-xs text-slate-500">成功 / 失败</div>
                    <div className="mt-1 text-sm font-bold text-slate-800">{selectedLog.succeeded ?? 0} / {selectedLog.failed ?? 0}</div>
                  </div>
                </>
              ) : null}
              <div className="rounded-lg border border-slate-100 bg-slate-50 p-4">
                <div className="text-xs text-slate-500">操作人员</div>
                <div className="mt-1 text-sm font-bold text-slate-800">{selectedLog.operator || '系统'}</div>
              </div>
              <div className="rounded-lg border border-slate-100 bg-slate-50 p-4">
                <div className="text-xs text-slate-500">记录时间</div>
                <div className="mt-1 text-sm font-bold text-slate-800">{formatDateTime(selectedLog.created_at)}</div>
              </div>
            </div>
            {selectedLog.error ? (
              <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm leading-6 text-rose-700">
                {sandboxBusinessError(selectedLog.error)}
              </div>
            ) : null}
            <details className="rounded-lg border border-slate-200 bg-white p-4">
              <summary className="cursor-pointer text-sm font-bold text-slate-700">技术详情</summary>
              <div className="mt-4 space-y-3">
                <TechnicalId value={selectedLog.entity_id} label="HA 实体 ID" />
                <TechnicalId value={selectedLog.service} label="HA 服务" />
                <TechnicalId value={String(selectedLog.id)} label="日志 ID" />
                {selectedLog.error ? <TechnicalId value={selectedLog.error} label="原始错误" /> : null}
                <div className="text-xs leading-5 text-slate-500">来源：{logSourceLabel(selectedLog.source)}</div>
              </div>
            </details>
          </div>
        ) : null}
      </AppDialog>

      <AppDialog
        open={confirmClear}
        onClose={closeClearConfirmation}
        title="确认清空仿真日志"
        description={`将删除全部 ${summary.total} 条仿真日志，此操作无法撤销。`}
        danger
        closeOnOverlay={!clearing}
        showClose={!clearing}
        initialFocusRef={clearCancelRef}
        footer={(
          <div className="flex justify-end gap-2">
            <button ref={clearCancelRef} type="button" onClick={clearing ? () => void confirmClearLogs() : closeClearConfirmation} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-slate-200 px-4 text-sm font-bold text-slate-700 hover:bg-slate-50">
              {clearing ? <AlertCircle size={14} /> : null}{clearing ? '取消等待' : '取消'}
            </button>
            {!clearing ? (
              <button type="button" onClick={() => void confirmClearLogs()} className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-rose-600 px-4 text-sm font-bold text-white hover:bg-rose-700">
                <Trash2 size={14} />确认清空
              </button>
            ) : null}
          </div>
        )}
      >
        <div className="space-y-3">
          <div className="flex items-start gap-3 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm leading-6 text-rose-700">
            <TriangleAlert size={18} className="mt-0.5 shrink-0" />
            清空后，传感器注入、虚拟设备控制和场景执行的历史证据将无法在平台中恢复。
          </div>
          {clearing ? <div className="text-xs font-medium leading-5 text-amber-700">清空请求已发送。取消等待只停止当前页面等待，不会撤销服务端可能已经完成的清理；页面随后会重新读取日志。</div> : null}
          {clearError ? <div className="text-sm text-rose-600">{clearError}</div> : null}
        </div>
      </AppDialog>
    </>
  )
}

export default function SandboxClient() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const initialLogPage = Number(searchParams.get('logPage') || 1)
  const initialLogAction = searchParams.get('action') || ''
  const initialLogLevel = searchParams.get('level') || ''
  const initialLogKeyword = searchParams.get('logQ') || ''
  const { isAdmin } = useAuth()
  const [devices, setDevices] = useState<VirtualDevice[]>([])
  const [scenes, setScenes] = useState<ScenePreset[]>([])
  const [logs, setLogs] = useState<SandboxLog[]>([])
  const [logSummary, setLogSummary] = useState<LogSummary>(EMPTY_LOG_SUMMARY)
  const [logTotal, setLogTotal] = useState(0)
  const [logPage, setLogPage] = useState(Number.isInteger(initialLogPage) && initialLogPage > 0 ? initialLogPage : 1)
  const [logKeyword, setLogKeyword] = useState(initialLogKeyword)
  const [debouncedLogKeyword, setDebouncedLogKeyword] = useState(initialLogKeyword.trim())
  const [logAction, setLogAction] = useState(['inject', 'control', 'scene', 'system'].includes(initialLogAction) ? initialLogAction : '')
  const [logLevel, setLogLevel] = useState(['success', 'warning', 'error', 'info'].includes(initialLogLevel) ? initialLogLevel : '')
  const [logViewVersion, setLogViewVersion] = useState(0)
  const [logsLoading, setLogsLoading] = useState(false)
  const [logsRefreshing, setLogsRefreshing] = useState(false)
  const [logsLoaded, setLogsLoaded] = useState(false)
  const [loadedLogViewKey, setLoadedLogViewKey] = useState('')
  const [loadedLogPage, setLoadedLogPage] = useState(1)
  const [loadedLogPageSize, setLoadedLogPageSize] = useState(20)
  const [latestLogTime, setLatestLogTime] = useState('正在读取')
  const [sensorValues, setSensorValues] = useState<SensorControlState>({})
  const [dirtySensorValues, setDirtySensorValues] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [haConnected, setHaConnected] = useState(false)
  const [deviceSnapshotAvailable, setDeviceSnapshotAvailable] = useState(false)
  const [sceneSnapshotAvailable, setSceneSnapshotAvailable] = useState(false)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  const [scenesError, setScenesError] = useState<string | null>(null)
  const [logsError, setLogsError] = useState<string | null>(null)
  const [operationError, setOperationError] = useState<string | null>(null)
  const [pendingControls, setPendingControls] = useState<PendingControls>({})
  const [pendingSceneId, setPendingSceneId] = useState<string | null>(null)
  const [sceneToConfirm, setSceneToConfirm] = useState<ScenePreset | null>(null)
  const [sceneResult, setSceneResult] = useState<SceneExecutionResult | null>(null)
  const [pendingInjections, setPendingInjections] = useState<Record<string, boolean>>({})
  const [sensorPage, setSensorPage] = useState(1)
  const [sensorPageSize, setSensorPageSize] = useState(4)
  const [devicePage, setDevicePage] = useState(1)
  const [devicePageSize, setDevicePageSize] = useState(4)
  const [scenePage, setScenePage] = useState(1)
  const [scenePageSize, setScenePageSize] = useState(4)
  const [lastEvidence, setLastEvidence] = useState('等待执行控制、注入或场景操作')
  const dirtySensorIdsRef = useRef(new Set<string>())
  const workspaceRequestRef = useRef<Promise<void> | null>(null)
  const logRequestsRef = useRef(new Map<string, Promise<void>>())
  const workspaceControllerRef = useRef<AbortController | null>(null)
  const logControllerRef = useRef<AbortController | null>(null)
  const refreshLockRef = useRef(false)
  const forceLogRefreshRef = useRef(false)
  const currentLogRequestKeyRef = useRef('')
  const workspaceRequestIdRef = useRef(0)
  const devicesUpdatedAtRef = useRef(0)
  const scenesUpdatedAtRef = useRef(0)
  const pendingControlEntitiesRef = useRef(new Set<string>())
  const pendingInjectionEntitiesRef = useRef(new Set<string>())
  const controlSequenceRef = useRef(new Map<string, number>())
  const injectionSequenceRef = useRef(new Map<string, number>())
  const sceneSequenceRef = useRef(0)
  const controlControllersRef = useRef(new Map<string, AbortController>())
  const injectionControllersRef = useRef(new Map<string, AbortController>())
  const sceneControllerRef = useRef<AbortController | null>(null)
  const writeTimeoutsRef = useRef(new Map<string, number>())
  const writeReconcileRef = useRef(0)
  const writeReconcileTimerRef = useRef<number | null>(null)
  const pageLoadingRequestRef = useRef(0)
  const mountedRef = useRef(true)
  const didInitialLoadRef = useRef(false)
  const didInitializeLogKeywordRef = useRef(false)
  const writtenSearchRef = useRef(searchParams.toString())
  const logPageSize = 20

  const sensorDevices = useMemo(() => devices.filter((device) => device.injectable), [devices])
  const controllableDevices = useMemo(() => devices.filter((device) => !device.injectable), [devices])
  const sensorSafePage = Math.min(sensorPage, Math.max(1, Math.ceil(sensorDevices.length / sensorPageSize)))
  const deviceSafePage = Math.min(devicePage, Math.max(1, Math.ceil(controllableDevices.length / devicePageSize)))
  const sceneSafePage = Math.min(scenePage, Math.max(1, Math.ceil(scenes.length / scenePageSize)))
  const visibleSensorDevices = useMemo(() => {
    const pageItems = sensorDevices.slice((sensorSafePage - 1) * sensorPageSize, sensorSafePage * sensorPageSize)
    const pendingItems = sensorDevices.filter((device) => pendingInjections[getPrimaryEntityId(device)])
    return [...pendingItems, ...pageItems.filter((device) => !pendingItems.some((pending) => pending.id === device.id))]
  }, [pendingInjections, sensorDevices, sensorPageSize, sensorSafePage])
  const visibleControllableDevices = useMemo(() => {
    const pageItems = controllableDevices.slice((deviceSafePage - 1) * devicePageSize, deviceSafePage * devicePageSize)
    const pendingItems = controllableDevices.filter((device) => Object.values(device.entities || {}).some((entityId) => pendingControls[entityId]))
    return [...pendingItems, ...pageItems.filter((device) => !pendingItems.some((pending) => pending.id === device.id))]
  }, [controllableDevices, devicePageSize, deviceSafePage, pendingControls])
  const visibleScenes = useMemo(() => {
    const pageItems = scenes.slice((sceneSafePage - 1) * scenePageSize, sceneSafePage * scenePageSize)
    const pendingItem = pendingSceneId ? scenes.find((scene) => scene.id === pendingSceneId) : undefined
    return pendingItem && !pageItems.some((scene) => scene.id === pendingItem.id) ? [pendingItem, ...pageItems] : pageItems
  }, [pendingSceneId, scenePageSize, sceneSafePage, scenes])
  const scenePreflights = useMemo(() => new Map(
    scenes.map((scene) => [scene.id, scenePreflight(scene, devices)]),
  ), [devices, scenes])
  const currentLogViewKey = logSnapshotKey(debouncedLogKeyword, logAction, logLevel, logPage, logPageSize)
  const logSnapshotMatchesView = Boolean(
    logsLoaded
    && logKeyword.trim() === debouncedLogKeyword
    && loadedLogViewKey === currentLogViewKey
  )
  const sandboxOperational = haConnected && deviceSnapshotAvailable && !runtimeError
  const scenesOperational = sandboxOperational && sceneSnapshotAvailable && !scenesError
  const evidenceStats = [
    { label: '虚拟设备', value: loading ? '读取中' : controllableDevices.length },
    { label: '传感器', value: loading ? '读取中' : sensorDevices.length },
    { label: '场景', value: loading ? '读取中' : scenes.length },
    { label: '最近日志', value: latestLogTime },
  ]

  const loadWorkspace = useCallback((
    forceDraftSync: false | true | string = false,
    refresh = false,
    selection: SandboxReadSelection = {},
  ) => {
    if (!refresh && workspaceRequestRef.current) return workspaceRequestRef.current
    const readDevices = selection.devices ?? true
    const readScenes = selection.scenes ?? true
    if (!readDevices && !readScenes) return Promise.resolve()
    workspaceControllerRef.current?.abort()
    const controller = new AbortController()
    workspaceControllerRef.current = controller
    const requestId = ++workspaceRequestIdRef.current
    // 后台刷新继续保留上一次成功快照，避免周期请求期间控制区反复锁定。
    if (readDevices && !refresh) setDeviceSnapshotAvailable(false)
    if (readScenes && !refresh) setSceneSnapshotAvailable(false)
    const devicesRequest = readDevices ? fetchSandboxDevices(refresh, controller.signal)
      .then((result) => {
        if (workspaceRequestIdRef.current !== requestId) return
        setDevices(result.devices)
        setHaConnected(result.ha_connected)
        setRuntimeError(result.error)
        setDeviceSnapshotAvailable(true)
        devicesUpdatedAtRef.current = Date.now()
        setSensorValues((prev) => {
          const next = { ...prev }
          for (const device of result.devices) {
            if (!device.injectable) continue
            const entityId = getPrimaryEntityId(device)
            const numeric = Number(getPrimaryEntityState(device)?.state)
            const shouldSyncDraft = forceDraftSync === true || forceDraftSync === entityId || !dirtySensorIdsRef.current.has(entityId)
            if (!Number.isNaN(numeric) && entityId && shouldSyncDraft) {
              // 首次草稿必须忠实保留 HA 回读；只有用户拖动时才按控件步长变化。
              next[entityId] = numeric
            }
          }
          return next
        })
      })
      .catch((reason) => {
        if (workspaceRequestIdRef.current !== requestId) return
        if (controller.signal.aborted) return
        setHaConnected(false)
        setDeviceSnapshotAvailable(false)
        setRuntimeError(sandboxLoadErrorMessage(reason, '虚拟设备状态暂时无法读取'))
      }) : Promise.resolve()
    const scenesRequest = readScenes ? fetchScenePresets(controller.signal, refresh)
      .then((result) => {
        if (workspaceRequestIdRef.current !== requestId) return
        setScenes(result.scenes)
        setScenesError(null)
        setSceneSnapshotAvailable(true)
        scenesUpdatedAtRef.current = Date.now()
      }) : Promise.resolve()
      .catch((reason) => {
        if (controller.signal.aborted) return
        if (workspaceRequestIdRef.current === requestId) {
          setSceneSnapshotAvailable(false)
          setScenesError(sandboxLoadErrorMessage(reason, '场景定义暂时无法读取'))
        }
      })
    const request = Promise.allSettled([devicesRequest, scenesRequest])
      .then(() => undefined)
      .finally(() => {
        if (workspaceControllerRef.current === controller) workspaceControllerRef.current = null
        if (workspaceRequestRef.current === request) workspaceRequestRef.current = null
      })
    workspaceRequestRef.current = request
    return request
  }, [])

  const loadLogs = useCallback(() => {
    if (logKeyword.trim() !== debouncedLogKeyword) {
      setLogsLoading(true)
      return Promise.resolve()
    }
    const requestKey = JSON.stringify([logPage, logPageSize, logLevel, logAction, debouncedLogKeyword, logViewVersion])
    currentLogRequestKeyRef.current = requestKey
    const existing = logRequestsRef.current.get(requestKey)
    if (existing) return existing
    logControllerRef.current?.abort()
    const controller = new AbortController()
    logControllerRef.current = controller
    setLogsLoading(true)
    const forceRefresh = forceLogRefreshRef.current
    forceLogRefreshRef.current = false
    const request = fetchSandboxLogs({
      page: logPage,
      size: logPageSize,
      level: logLevel,
      action: logAction,
      keyword: debouncedLogKeyword,
    }, controller.signal, forceRefresh)
      .then((result) => {
        if (currentLogRequestKeyRef.current !== requestKey) return
        const nextLogs = result.items || result.logs || []
        const nextSummary = { ...EMPTY_LOG_SUMMARY, ...(result.summary || {}) }
        setLogs(nextLogs)
        setLogSummary(nextSummary)
        setLogTotal(result.total)
        setLogsLoaded(true)
        setLoadedLogPage(result.page)
        setLoadedLogPageSize(result.size || logPageSize)
        setLoadedLogViewKey(logSnapshotKey(debouncedLogKeyword, logAction, logLevel, result.page, result.size || logPageSize))
        setLatestLogTime(formatLatestLogTime(nextSummary.latest_at))
        if (result.page !== logPage) setLogPage(result.page)
        setLogsError(null)
      })
      .catch((reason) => {
        if (currentLogRequestKeyRef.current !== requestKey) return
        if (controller.signal.aborted) return
        setLogsError(sandboxLoadErrorMessage(reason, '历史仿真日志暂时无法读取'))
      })
      .finally(() => {
        if (logControllerRef.current === controller) logControllerRef.current = null
        logRequestsRef.current.delete(requestKey)
        if (currentLogRequestKeyRef.current === requestKey) setLogsLoading(false)
        if (currentLogRequestKeyRef.current === requestKey) setLogsRefreshing(false)
      })
    logRequestsRef.current.set(requestKey, request)
    return request
  }, [debouncedLogKeyword, logAction, logKeyword, logLevel, logPage, logViewVersion])

  const invalidateLogView = useCallback((triggerRequest = true, manualRefresh = false) => {
    currentLogRequestKeyRef.current = ''
    logControllerRef.current?.abort()
    logControllerRef.current = null
    setLogsError(null)
    setLogsLoading(true)
    setLogsRefreshing(manualRefresh)
    if (manualRefresh) forceLogRefreshRef.current = true
    if (triggerRequest) setLogViewVersion((current) => current + 1)
  }, [])

  const loadData = useCallback(async (withLoading = false, forceDraftSync: false | true | string = false, refresh = false) => {
    const requestId = ++pageLoadingRequestRef.current
    if (withLoading) setLoading(true)
    const workspaceRequest = loadWorkspace(forceDraftSync, refresh)
    void loadLogs()
    await workspaceRequest
    if (mountedRef.current && pageLoadingRequestRef.current === requestId) setLoading(false)
  }, [loadLogs, loadWorkspace])

  const applyEntityReadback = useCallback((entityId: string, readback: VirtualDevice['entity_states'][string]) => {
    setDevices((current) => current.map((device) => {
      const role = Object.entries(device.entities || {}).find(([, id]) => id === entityId)?.[0]
      if (!role) return device
      return withAvailability(device, {
        ...device.entity_states,
        [role]: readback,
      })
    }))
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const nextKeyword = logKeyword.trim()
      if (!didInitializeLogKeywordRef.current) {
        didInitializeLogKeywordRef.current = true
        setDebouncedLogKeyword(nextKeyword)
        return
      }
      setLogPage(1)
      setDebouncedLogKeyword(nextKeyword)
      setLogViewVersion((current) => current + 1)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [logKeyword])

  useEffect(() => {
    if (pathname !== '/sandbox') return
    const url = new URL(window.location.href)
    const values: Record<string, string> = {
      logQ: logKeyword.trim(),
      action: logAction,
      level: logLevel,
      logPage: logPage === 1 ? '' : String(logPage),
    }
    Object.entries(values).forEach(([key, value]) => {
      if (value) url.searchParams.set(key, value)
      else url.searchParams.delete(key)
    })
    writtenSearchRef.current = url.searchParams.toString()
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }, [logAction, logKeyword, logLevel, logPage, pathname])

  useEffect(() => {
    if (pathname !== '/sandbox') return
    const incomingSearch = searchParams.toString()
    if (incomingSearch === writtenSearchRef.current) return
    writtenSearchRef.current = incomingSearch
    const nextKeyword = searchParams.get('logQ') || ''
    const nextAction = searchParams.get('action') || ''
    const nextLevel = searchParams.get('level') || ''
    const nextPage = Number(searchParams.get('logPage') || 1)
    invalidateLogView(false)
    setLogKeyword(nextKeyword)
    setDebouncedLogKeyword(nextKeyword.trim())
    setLogAction(['inject', 'control', 'scene', 'system'].includes(nextAction) ? nextAction : '')
    setLogLevel(['success', 'warning', 'error', 'info'].includes(nextLevel) ? nextLevel : '')
    setLogPage(Number.isInteger(nextPage) && nextPage > 0 ? nextPage : 1)
    setLogViewVersion((current) => current + 1)
  }, [invalidateLogView, pathname, searchParams])

  useEffect(() => {
    if (didInitialLoadRef.current) void loadLogs()
  }, [loadLogs])

  useEffect(() => {
    if (didInitialLoadRef.current) return
    mountedRef.current = true
    didInitialLoadRef.current = true
    void loadData(true)
  }, [loadData])

  useEffect(() => {
    let timer: number | null = null
    const stopRefresh = () => {
      if (timer !== null) window.clearInterval(timer)
      timer = null
    }
    const refreshVisibleWorkspace = () => {
      if (document.visibilityState !== 'visible' || workspaceRequestRef.current) return
      const now = Date.now()
      const refreshDevices = Boolean(runtimeError) || now - devicesUpdatedAtRef.current >= 30_000
      const refreshScenes = Boolean(scenesError) || now - scenesUpdatedAtRef.current >= 5 * 60_000
      if (!refreshDevices && !refreshScenes) return
      void loadWorkspace(false, true, {
        devices: refreshDevices,
        scenes: refreshScenes,
      })
    }
    const startRefresh = () => {
      stopRefresh()
      if (document.visibilityState !== 'visible') return
      refreshVisibleWorkspace()
      timer = window.setInterval(refreshVisibleWorkspace, 30_000)
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') startRefresh()
      else stopRefresh()
    }
    startRefresh()
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      stopRefresh()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [loadWorkspace, runtimeError, scenesError])

  useEffect(() => {
    if (!runtimeError && !scenesError && !logsError) return
    const recoverFailedReads = () => {
      if (!navigator.onLine || document.visibilityState !== 'visible') return
      if ((runtimeError || scenesError) && !workspaceRequestRef.current) {
        void loadWorkspace(false, true, {
          devices: Boolean(runtimeError),
          scenes: Boolean(scenesError),
        })
      }
      if (logsError && !logControllerRef.current) {
        forceLogRefreshRef.current = true
        void loadLogs()
      }
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') recoverFailedReads()
    }
    window.addEventListener('online', recoverFailedReads)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('online', recoverFailedReads)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [loadLogs, loadWorkspace, logsError, runtimeError, scenesError])

  useEffect(() => {
    mountedRef.current = true
    const controlSequences = controlSequenceRef.current
    const injectionSequences = injectionSequenceRef.current
    const controlControllers = controlControllersRef.current
    const injectionControllers = injectionControllersRef.current
    const logRequests = logRequestsRef.current
    const writeTimeouts = writeTimeoutsRef.current
    return () => {
      mountedRef.current = false
      didInitialLoadRef.current = false
      pageLoadingRequestRef.current += 1
      workspaceRequestIdRef.current += 1
      currentLogRequestKeyRef.current = ''
      controlSequences.forEach((value, key) => controlSequences.set(key, value + 1))
      injectionSequences.forEach((value, key) => injectionSequences.set(key, value + 1))
      sceneSequenceRef.current += 1
      writeReconcileRef.current += 1
      controlControllers.forEach((controller) => controller.abort())
      injectionControllers.forEach((controller) => controller.abort())
      sceneControllerRef.current?.abort()
      workspaceControllerRef.current?.abort()
      logControllerRef.current?.abort()
      sceneControllerRef.current = null
      workspaceControllerRef.current = null
      logControllerRef.current = null
      workspaceRequestRef.current = null
      logRequests.clear()
      refreshLockRef.current = false
      writeTimeouts.forEach((timeoutId) => window.clearTimeout(timeoutId))
      writeTimeouts.clear()
      if (writeReconcileTimerRef.current !== null) window.clearTimeout(writeReconcileTimerRef.current)
      writeReconcileTimerRef.current = null
    }
  }, [])

  const reconcileWriteState = () => {
    const reconcileId = ++writeReconcileRef.current
    if (writeReconcileTimerRef.current !== null) window.clearTimeout(writeReconcileTimerRef.current)
    const readFinalState = async () => {
      currentLogRequestKeyRef.current = ''
      logControllerRef.current?.abort()
      logControllerRef.current = null
      logRequestsRef.current.clear()
      forceLogRefreshRef.current = true
      await Promise.allSettled([
        loadWorkspace(true, true),
        loadLogs(),
      ])
    }
    void readFinalState().finally(() => {
      if (!mountedRef.current || writeReconcileRef.current !== reconcileId) return
      writeReconcileTimerRef.current = window.setTimeout(() => {
        if (!mountedRef.current || writeReconcileRef.current !== reconcileId) return
        writeReconcileTimerRef.current = null
        void readFinalState()
      }, 1200)
    })
  }

  const cancelControlWait = (entityId: string, notify = true) => {
    controlSequenceRef.current.set(entityId, (controlSequenceRef.current.get(entityId) || 0) + 1)
    controlControllersRef.current.get(entityId)?.abort()
    controlControllersRef.current.delete(entityId)
    const timeoutKey = `control:${entityId}`
    const timeoutId = writeTimeoutsRef.current.get(timeoutKey)
    if (timeoutId !== undefined) window.clearTimeout(timeoutId)
    writeTimeoutsRef.current.delete(timeoutKey)
    pendingControlEntitiesRef.current.delete(entityId)
    setPendingControls((current) => {
      if (!current[entityId]) return current
      const next = { ...current }
      delete next[entityId]
      return next
    })
    if (notify) {
      setOperationError('已取消等待 Home Assistant 返回。命令可能已经发送，正在重新读取状态和日志。')
      reconcileWriteState()
    }
  }

  const cancelInjectionWait = (entityId: string, notify = true) => {
    injectionSequenceRef.current.set(entityId, (injectionSequenceRef.current.get(entityId) || 0) + 1)
    injectionControllersRef.current.get(entityId)?.abort()
    injectionControllersRef.current.delete(entityId)
    const timeoutKey = `inject:${entityId}`
    const timeoutId = writeTimeoutsRef.current.get(timeoutKey)
    if (timeoutId !== undefined) window.clearTimeout(timeoutId)
    writeTimeoutsRef.current.delete(timeoutKey)
    pendingInjectionEntitiesRef.current.delete(entityId)
    setPendingInjections((current) => {
      if (!current[entityId]) return current
      const next = { ...current }
      delete next[entityId]
      return next
    })
    if (notify) {
      setOperationError('已取消等待传感器注入结果。注入请求可能已经发送，正在重新读取状态和日志。')
      reconcileWriteState()
    }
  }

  const cancelSceneWait = (notify = true) => {
    sceneSequenceRef.current += 1
    sceneControllerRef.current?.abort()
    sceneControllerRef.current = null
    const timeoutId = writeTimeoutsRef.current.get('scene')
    if (timeoutId !== undefined) window.clearTimeout(timeoutId)
    writeTimeoutsRef.current.delete('scene')
    setPendingSceneId(null)
    if (notify) {
      setOperationError('已取消等待场景执行结果。已发送的场景步骤可能仍在后端继续执行，正在重新读取状态和日志。')
      reconcileWriteState()
    }
  }

  const handleControl = async (device: VirtualDevice, action: DeviceAction) => {
    if (!sandboxOperational) return
    const entityId = getPrimaryEntityId(device)
    if (!entityId) return
    if (!entityStateAvailable(getPrimaryEntityState(device))) {
      setOperationError(`${device.name}的控制实体当前不可用，未发送控制请求。请刷新状态或检查 Home Assistant 虚拟实体。`)
      return
    }

    const key = `${entityId}:${action.service}:${action.label}`
    if (pendingControlEntitiesRef.current.has(entityId)) {
      setOperationError('当前设备仍在执行上一项控制，请等待结果，或先取消等待并刷新状态后再操作。')
      return
    }
    const sequence = (controlSequenceRef.current.get(entityId) || 0) + 1
    controlSequenceRef.current.set(entityId, sequence)
    const controller = new AbortController()
    controlControllersRef.current.set(entityId, controller)
    pendingControlEntitiesRef.current.add(entityId)
    setPendingControls((current) => ({ ...current, [entityId]: key }))
    writeTimeoutsRef.current.set(`control:${entityId}`, window.setTimeout(() => {
      if (controlSequenceRef.current.get(entityId) !== sequence) return
      cancelControlWait(entityId, false)
      setOperationError(`${device.name}${action.label}等待超过 12 秒，按钮已恢复。命令可能已经发送，请刷新状态和日志后确认。`)
      reconcileWriteState()
    }, WRITE_UI_TIMEOUT_MS))
    try {
      const result = await controlSandboxDevice({ entity_id: entityId, service: action.service, data: action.data }, controller.signal)
      if (!mountedRef.current || controlSequenceRef.current.get(entityId) !== sequence) return
      applyEntityReadback(entityId, result.readback)
      setOperationError(null)
      setLastEvidence(`${device.name}${action.label}已${result.confirmed ? '完成回读确认' : '下发但未确认目标状态'}，运行证据将更新到右侧日志。`)
    } catch (controlError) {
      if (!mountedRef.current || controlSequenceRef.current.get(entityId) !== sequence) return
      if (controlError instanceof DOMException && controlError.name === 'AbortError') return
      const message = controlError instanceof Error ? controlError.message : '设备控制失败'
      setOperationError(`${classifySandboxError(message)}：${message}`)
      reconcileWriteState()
    } finally {
      if (mountedRef.current && controlSequenceRef.current.get(entityId) === sequence) {
        cancelControlWait(entityId, false)
        void loadData(false, false, true)
      }
    }
  }

  const handleInject = async (device: VirtualDevice) => {
    if (!sandboxOperational) return
    const entityId = getPrimaryEntityId(device)
    if (!entityId) return
    if (!entityStateAvailable(getPrimaryEntityState(device))) {
      setOperationError(`${device.name}的传感器实体当前不可用，未发送注入请求。请刷新状态或检查 Home Assistant 虚拟实体。`)
      return
    }

    if (pendingInjectionEntitiesRef.current.has(entityId)) return
    const sequence = (injectionSequenceRef.current.get(entityId) || 0) + 1
    injectionSequenceRef.current.set(entityId, sequence)
    const controller = new AbortController()
    injectionControllersRef.current.set(entityId, controller)
    pendingInjectionEntitiesRef.current.add(entityId)
    setPendingInjections((current) => ({ ...current, [entityId]: true }))
    writeTimeoutsRef.current.set(`inject:${entityId}`, window.setTimeout(() => {
      if (injectionSequenceRef.current.get(entityId) !== sequence) return
      cancelInjectionWait(entityId, false)
      setOperationError(`${device.name}注入等待超过 12 秒，按钮已恢复；当前草稿仍保留，请刷新状态和日志后确认。`)
      reconcileWriteState()
    }, WRITE_UI_TIMEOUT_MS))
    try {
      const injectedValue = sensorValues[entityId] ?? 0
      const result = await injectData({
        entity_id: entityId,
        value: String(injectedValue),
        source: 'manual',
      }, controller.signal)
      if (!mountedRef.current || injectionSequenceRef.current.get(entityId) !== sequence) return
      dirtySensorIdsRef.current.delete(entityId)
      setDirtySensorValues((prev) => ({ ...prev, [entityId]: false }))
      applyEntityReadback(entityId, result.readback)
      setOperationError(null)
      setLastEvidence(`注入 ${device.name}：${injectedValue} 已${result.confirmed ? '完成回读确认' : '写入但未确认回读值'}，日志可在右侧查看。`)
    } catch (injectError) {
      if (!mountedRef.current || injectionSequenceRef.current.get(entityId) !== sequence) return
      if (injectError instanceof DOMException && injectError.name === 'AbortError') return
      const message = injectError instanceof Error ? injectError.message : '传感器数据注入失败'
      setOperationError(`${classifySandboxError(message)}：${message}`)
      reconcileWriteState()
    } finally {
      if (mountedRef.current && injectionSequenceRef.current.get(entityId) === sequence) {
        cancelInjectionWait(entityId, false)
        void loadData(false, entityId, true)
      }
    }
  }

  const handleExecuteScene = async (sceneId: string) => {
    if (!scenesOperational) return
    const preflight = scenePreflights.get(sceneId)
    if (preflight?.total && preflight.available === 0) {
      setOperationError('场景所需虚拟实体当前全部不可用，未发送场景请求。请刷新状态或检查 Home Assistant 虚拟实体。')
      return
    }
    if (pendingSceneId && pendingSceneId !== sceneId) {
      setOperationError('另一个场景仍在执行。请等待结果，或先取消等待并刷新核对状态后再执行新场景。')
      return
    }
    if (pendingSceneId === sceneId) return
    const sequence = sceneSequenceRef.current + 1
    sceneSequenceRef.current = sequence
    const controller = new AbortController()
    sceneControllerRef.current = controller
    setPendingSceneId(sceneId)
    writeTimeoutsRef.current.set('scene', window.setTimeout(() => {
      if (sceneSequenceRef.current !== sequence) return
      cancelSceneWait(false)
      setOperationError('场景执行等待超过 20 秒，按钮已恢复。部分步骤可能仍在后端执行，请刷新状态和日志后确认。')
      reconcileWriteState()
    }, SCENE_UI_TIMEOUT_MS))
    try {
      const result = await executeScene(sceneId, controller.signal)
      if (!mountedRef.current || sceneSequenceRef.current !== sequence) return
      for (const item of result.results) {
        applyEntityReadback(item.entity_id, {
          state: item.actual_state || 'unknown',
          attributes: {},
          last_updated: new Date().toISOString(),
        })
      }
      dirtySensorIdsRef.current.clear()
      setDirtySensorValues({})
      setSceneResult(result)
      const scene = scenes.find((item) => item.id === sceneId)
      const failedNames = result.results.filter((item) => !item.success).map((item) => stripLeadingEmoji(item.device_name)).slice(0, 3)
      setOperationError(result.failed_count
        ? `场景部分执行失败：${failedNames.length ? failedNames.join('、') : `${result.failed_count} 个步骤`}。请查看右侧日志和各设备回读状态。`
        : null)
      setLastEvidence(`场景 ${stripLeadingEmoji(scene?.name || '未命名场景')} 已执行：成功 ${result.succeeded_count} 项，失败 ${result.failed_count} 项；日志可在右侧查看。`)
    } catch (sceneError) {
      if (!mountedRef.current || sceneSequenceRef.current !== sequence) return
      if (sceneError instanceof DOMException && sceneError.name === 'AbortError') return
      const message = sceneError instanceof Error ? sceneError.message : '场景执行失败'
      setOperationError(`${classifySandboxError(message)}：${message}`)
      reconcileWriteState()
    } finally {
      if (mountedRef.current && sceneSequenceRef.current === sequence) {
        cancelSceneWait(false)
        void loadData(false, true, true)
      }
    }
  }

  const handleRefresh = async () => {
    if (refreshLockRef.current) return
    refreshLockRef.current = true
    try {
      await loadData(false, false, true)
    } finally {
      refreshLockRef.current = false
    }
  }

  return (
    <div className="mx-auto max-w-[1480px] px-6 py-6">
      <div className="mb-6">
        <h2 className="text-[2rem] font-black text-slate-900">电子沙盘</h2>
        <p className="mt-2 flex items-center gap-2 text-sm text-slate-500">
          <span className={`inline-block h-2 w-2 rounded-full ${haConnected ? 'bg-emerald-500' : 'bg-amber-500'}`} />
          {loading
            ? '正在读取虚拟设备定义与 Home Assistant 状态，本地仿真日志可先查看'
            : haConnected
            ? '支持获取虚拟设备状态、传感器数据、场景信息，并支持虚拟设备与场景交互控制'
            : '虚拟设备定义和历史记录可查看，Home Assistant 离线期间暂停所有交互控制'}
        </p>
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
        <section className="rounded-2xl border border-blue-100 bg-blue-50/70 p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="text-xs font-semibold text-blue-600">当前模式</div>
              <h3 className="mt-1 text-xl font-black text-slate-900">虚拟沙盘联调模式</h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                当前页面提供 HA 虚拟实体、传感器注入、虚拟设备控制和场景执行能力，适合无真实硬件时进行联调。
              </p>
            </div>
            <div className={`rounded-lg border border-white/90 bg-white/80 px-4 py-3 text-sm font-bold ${haConnected ? 'text-blue-700' : 'text-amber-700'}`}>
              {loading ? 'HA 虚拟实体：正在读取' : haConnected ? 'HA 虚拟实体：已连接' : 'HA 虚拟实体：离线'}
            </div>
          </div>
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {evidenceStats.map((item) => (
              <div key={item.label} className="rounded-lg border border-white/90 bg-white/80 px-4 py-3">
                <div className="text-xs font-semibold text-slate-400">{item.label}</div>
                <div className="mt-1 text-lg font-black text-slate-900">{item.value}</div>
              </div>
            ))}
          </div>
          <div className="mt-4 rounded-lg border border-white/90 bg-white/80 px-4 py-3 text-sm leading-6 text-slate-600">
            <span className="font-black text-slate-900">最近操作：</span>{lastEvidence}
          </div>
        </section>

        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
          <div className="mb-3 flex items-center gap-2 text-amber-800">
            <AlertCircle size={18} />
            <h3 className="text-base font-black">真实沙盘前置资料清单</h3>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {REAL_SANDBOX_REQUIREMENTS.map((item) => (
              <div key={item} className="rounded-lg border border-amber-100 bg-white/80 px-3 py-2 text-xs font-bold text-slate-600">
                {item}
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs leading-5 text-amber-800">
            未取得上述资料前，页面不提供真实沙盘控制入口，避免把虚拟联调能力包装成最终硬件实现。
          </p>
        </section>
      </div>

      {runtimeError || scenesError || operationError ? (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{operationError || runtimeError || scenesError}</span>
            <button type="button" onClick={() => void handleRefresh()} className="inline-flex min-h-8 items-center font-bold text-amber-800 hover:underline">
              重新检测
            </button>
          </div>
        </div>
      ) : null}

      <div className="grid min-w-0 gap-6 2xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-6">
          {loading ? (
            <div className="flex min-h-36 items-center justify-center rounded-lg border border-blue-100 bg-blue-50/70 px-6 text-center text-sm font-semibold text-blue-700" role="status">
              <RefreshCw className="mr-3 animate-spin" size={18} />正在读取虚拟设备、传感器与场景；右侧日志不受外部 HA 探测阻塞。
            </div>
          ) : null}
          <section className="rounded-2xl bg-[#e9efff] p-6">
            <div className="mb-4">
              <h3 className="text-lg font-black text-slate-900">虚拟设备状态、传感器数据与场景信息</h3>
              <p className="mt-1 text-sm text-slate-500">查看虚拟设备状态、传感器数据和场景信息。</p>
            </div>

            <div className="grid min-w-0 gap-6 2xl:grid-cols-[280px_minmax(0,1fr)]">
              <div className="space-y-4">
                <div className="text-sm font-bold text-slate-900">传感器数据</div>
                <div className="space-y-4">
                  {visibleSensorDevices.map((device) => {
                    const entityId = getPrimaryEntityId(device)
                    return (
                      <SensorBlock
                        key={device.id}
                        device={device}
                        value={sensorValues[entityId] ?? null}
                        onChange={(value) => {
                          dirtySensorIdsRef.current.add(entityId)
                          setDirtySensorValues((prev) => ({ ...prev, [entityId]: true }))
                          setSensorValues((prev) => ({ ...prev, [entityId]: value }))
                        }}
                        onInject={() => void handleInject(device)}
                        onCancel={() => cancelInjectionWait(entityId)}
                        pending={Boolean(pendingInjections[entityId])}
                        operational={sandboxOperational}
                        dirty={Boolean(dirtySensorValues[entityId])}
                      />
                    )
                  })}
                </div>
                <Pagination page={sensorSafePage} pageSize={sensorPageSize} total={sensorDevices.length} itemName="个传感器" pageSizeOptions={[4, 8, 16]} className="mt-4 border-slate-300/70 px-0" onPageChange={setSensorPage} onPageSizeChange={(value) => { setSensorPageSize(value); setSensorPage(1) }} />
              </div>

              <div>
                <div className="mb-4 text-sm font-bold text-slate-900">虚拟设备状态</div>
                <div className="grid min-w-0 gap-4 md:grid-cols-2">
                  {visibleControllableDevices.map((device) => (
                    <DeviceCard
                      key={device.id}
                      device={device}
                      pendingControls={pendingControls}
                      onControl={handleControl}
                      onCancel={cancelControlWait}
                      operational={sandboxOperational}
                    />
                  ))}
                </div>
                <Pagination page={deviceSafePage} pageSize={devicePageSize} total={controllableDevices.length} itemName="个虚拟设备" pageSizeOptions={[4, 8, 16]} className="mt-4 border-slate-300/70 px-0" onPageChange={setDevicePage} onPageSizeChange={(value) => { setDevicePageSize(value); setDevicePage(1) }} />
              </div>
            </div>

            <div className="mt-6">
              <div className="mb-4 text-sm font-bold text-slate-900">场景信息</div>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {visibleScenes.map((scene) => (
                  <SceneCard
                    key={scene.id}
                    scene={scene}
                    onExecute={setSceneToConfirm}
                    onCancel={() => cancelSceneWait()}
                    pending={pendingSceneId === scene.id}
                    blocked={Boolean(pendingSceneId)}
                    operational={scenesOperational}
                    preflight={scenePreflights.get(scene.id) || { total: 0, available: 0, unavailable: 0, byEntityId: {} }}
                  />
                ))}
              </div>
              <Pagination page={sceneSafePage} pageSize={scenePageSize} total={scenes.length} itemName="个场景" pageSizeOptions={[4, 8, 16]} className="mt-4 border-slate-300/70 px-0" onPageChange={setScenePage} onPageSizeChange={(value) => { setScenePageSize(value); setScenePage(1) }} />
            </div>
          </section>
        </div>

        <aside className="space-y-6">
          <LogPanel
            logs={logs}
            summary={logSummary}
            total={logTotal}
            page={loadedLogPage}
            pageSize={loadedLogPageSize}
            loading={logsLoading}
            refreshing={logsRefreshing}
            error={logsError}
            loaded={logsLoaded}
            snapshotMatchesView={logSnapshotMatchesView}
            keyword={logKeyword}
            action={logAction}
            level={logLevel}
            isAdmin={isAdmin}
            onKeywordChange={(value) => {
              invalidateLogView(false)
              setLogKeyword(value)
            }}
            onActionChange={(value) => {
              invalidateLogView()
              setLogAction(value)
              setLogPage(1)
            }}
            onLevelChange={(value) => {
              invalidateLogView()
              setLogLevel(value)
              setLogPage(1)
            }}
            onPageChange={(value) => {
              if (!logSnapshotMatchesView) return
              invalidateLogView()
              setLogPage(value)
            }}
            onRefresh={() => {
              invalidateLogView(true, true)
            }}
            onClear={async (signal) => {
              if (!isAdmin) throw new Error('仅管理员可清空仿真日志')
              const result = await clearSandboxLogs(signal)
              setLogs([])
              setLogSummary(EMPTY_LOG_SUMMARY)
              setLogTotal(0)
              setLogPage(1)
              setLatestLogTime('暂无记录')
              setLogsLoaded(true)
              setLoadedLogPage(1)
              setLoadedLogPageSize(logPageSize)
              setLoadedLogViewKey(logSnapshotKey(debouncedLogKeyword, logAction, logLevel, 1, logPageSize))
              return result.deleted
            }}
          />
        </aside>
      </div>
      <SceneConfirmationDialog
        scene={scenesOperational ? sceneToConfirm : null}
        preflight={sceneToConfirm ? scenePreflights.get(sceneToConfirm.id) || null : null}
        onClose={() => setSceneToConfirm(null)}
        onConfirm={() => {
          const target = sceneToConfirm
          setSceneToConfirm(null)
          if (target) void handleExecuteScene(target.id)
        }}
      />
      <SceneResultDialog result={sceneResult} onClose={() => setSceneResult(null)} />
    </div>
  )
}
