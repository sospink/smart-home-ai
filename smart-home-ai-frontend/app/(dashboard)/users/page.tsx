'use client'

/**
 * 用户管理页
 * 用户列表、搜索筛选、角色管理、分页、创建/编辑/删除
 * API: 对接后端 /users 路由 (page/size/keyword/role)
 */

import { Suspense, useEffect, useRef, useState, useCallback } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import {
  Users, UserPlus, UserCheck, ShieldCheck,
  Search, Plus,
  Trash2, Edit3, KeyRound, ScrollText, ShieldAlert, AlertTriangle, LoaderCircle, RefreshCw,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { motion } from 'motion/react'
import { usersApi, type UserAuditItem, type UserListQuery, type UserStats } from '@/lib/api/users'
import { authApi } from '@/lib/api/auth'
import { ApiError } from '@/lib/api/client'
import type { UserDetail } from '@/types/api'
import { toast } from '@/components/ui/toast'
import { UnifiedSelect } from '@/components/ui/UnifiedSelect'
import { AppDialog } from '@/components/ui/AppDialog'
import { Pagination } from '@/components/ui/Pagination'
import { useAuth } from '@/lib/hooks/useAuth'
import { businessErrorMessage } from '@/lib/ui/business-error'

/* ── Types ── */
type User = UserDetail
type UserRole = User['role']

type ModalType = 'create' | 'edit' | 'delete' | 'reset' | null
type SubmitAction = Exclude<ModalType, null>

const AUDIT_ACTION_LABELS: Record<string, string> = {
  create: '创建用户',
  update: '更新用户',
  delete: '删除用户',
  reset_password: '重置密码',
  toggle_active: '变更账号状态',
  unknown: '用户管理操作',
}

const AUDIT_FIELD_LABELS: Record<string, string> = {
  nickname: '昵称',
  role: '角色',
  is_active: '账号状态',
}

const AUDIT_PAGE_SIZES = [4, 8, 12]

function auditPageSizeFromParam(value: string | null, fallback = 4) {
  const parsed = Number(value)
  return AUDIT_PAGE_SIZES.includes(parsed) ? parsed : fallback
}

function formatAuditTime(value: string | null) {
  if (!value) return '时间未知'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? '时间未知'
    : date.toLocaleString('zh-CN', { hour12: false })
}

function auditSummary(item: UserAuditItem) {
  const normalizedOperator = String(item.operator || '').trim().toLowerCase()
  const operator = !normalizedOperator || normalizedOperator === 'system' || normalizedOperator === 'system_task'
    ? '系统任务'
    : item.operator
  const changed = item.changed_fields
    .map((field) => AUDIT_FIELD_LABELS[field] || '其他账号字段')
    .join('、')
  const actionSummary = item.action === 'reset_password'
    ? '密码凭证已更新，内容不记录'
    : item.action === 'delete'
      ? '账号已删除'
      : item.action === 'create'
        ? changed ? `初始字段：${changed}` : '账号已创建'
        : changed
          ? `变更字段：${changed}`
          : '未变更账号字段'
  return `操作人：${operator} · ${actionSummary}`
}

function errorMessage(error: unknown, fallback: string) {
  return businessErrorMessage(error, { fallback, service: '用户管理' })
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

function userListViewKey(query: UserListQuery) {
  return JSON.stringify({
    page: query.page || 1,
    size: query.size || 10,
    keyword: query.keyword?.trim() || '',
    role: query.role || '',
    is_active: query.is_active || '',
  })
}

/* ── Stat card (from elevated-admin-dashboard) ── */
function StatCard({ icon: Icon, value, label, trend, trendLabel, iconColor, iconBg }: {
  icon: LucideIcon; value: string; label: string; trend?: string; trendLabel?: string
  iconColor?: string; iconBg?: string
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="group rounded-2xl border border-transparent bg-white p-4 shadow-sm transition-shadow hover:shadow-md dark:border-white/[0.06] dark:bg-transparent dark:bg-gradient-to-b dark:from-white/[0.06] dark:to-white/[0.02] dark:shadow-none sm:p-6"
    >
      <div className="mb-3 flex items-start justify-between sm:mb-4">
        <div className={`rounded-full p-2.5 sm:p-3 ${iconBg || 'bg-blue-50 dark:bg-white/[0.05]'} ${iconColor || 'text-blue-600 dark:text-blue-400'} group-hover:bg-blue-600 group-hover:text-white transition-colors`}>
          <Icon size={18} className="sm:h-5 sm:w-5" />
        </div>
        {trend && (
          <span className={`text-xs font-bold ${trend.startsWith('+') ? 'text-emerald-600 bg-emerald-50 dark:bg-emerald-500/10 dark:text-emerald-400' : 'text-slate-400 bg-slate-50 dark:bg-white/[0.05] dark:text-slate-500'} px-2 py-1 rounded-full`}>
            {trend}
          </span>
        )}
        {trendLabel && (
          <span className="mt-1 text-xs font-bold text-slate-400 dark:text-slate-500">
            {trendLabel}
          </span>
        )}
      </div>
      <p className="text-3xl font-black text-slate-900 dark:text-white sm:text-4xl">{value}</p>
      <p className="mt-0.5 text-xs font-medium text-slate-500 dark:text-slate-400 sm:mt-0 sm:text-sm">{label}</p>
    </motion.div>
  )
}

function formatUserDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? '日期未知'
    : date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

function UserActions({ user, onEdit, onDelete, onReset, deleteDisabledReason, actionsDisabledReason }: {
  user: User
  onEdit: (u: User) => void
  onDelete: (u: User) => void
  onReset: (u: User) => void
  deleteDisabledReason?: string
  actionsDisabledReason?: string
}) {
  return (
    <div className="flex items-center justify-end gap-1">
      <button onClick={() => onEdit(user)} disabled={!!actionsDisabledReason} className="flex h-9 w-9 items-center justify-center rounded-[8px] text-slate-400 transition-colors hover:bg-slate-100 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-slate-400 dark:text-slate-500 dark:hover:bg-white/[0.06] dark:hover:text-blue-400 dark:disabled:hover:bg-transparent dark:disabled:hover:text-slate-500" title={actionsDisabledReason || '编辑'} aria-label={actionsDisabledReason ? `${user.username}：${actionsDisabledReason}` : `编辑用户：${user.username}`}><Edit3 size={16} /></button>
      <button onClick={() => onReset(user)} disabled={!!actionsDisabledReason} className="flex h-9 w-9 items-center justify-center rounded-[8px] text-slate-400 transition-colors hover:bg-amber-50 hover:text-amber-500 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-slate-400 dark:text-slate-500 dark:hover:bg-amber-500/15 dark:disabled:hover:bg-transparent dark:disabled:hover:text-slate-500" title={actionsDisabledReason || '重置密码'} aria-label={actionsDisabledReason ? `${user.username}：${actionsDisabledReason}` : `重置密码：${user.username}`}><KeyRound size={16} /></button>
      <button onClick={() => onDelete(user)} disabled={!!actionsDisabledReason || !!deleteDisabledReason} className="flex h-9 w-9 items-center justify-center rounded-[8px] text-slate-400 transition-colors hover:bg-red-50 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-slate-400 dark:text-slate-500 dark:hover:bg-red-900/20 dark:disabled:hover:bg-transparent dark:disabled:hover:text-slate-500" title={actionsDisabledReason || deleteDisabledReason || '删除'} aria-label={actionsDisabledReason ? `${user.username}：${actionsDisabledReason}` : deleteDisabledReason ? `${user.username}：${deleteDisabledReason}` : `删除用户：${user.username}`}><Trash2 size={16} /></button>
    </div>
  )
}

/* ── User table row ── */
function UserRow({ user, ...actionProps }: {
  user: User
  onEdit: (u: User) => void
  onDelete: (u: User) => void
  onReset: (u: User) => void
  deleteDisabledReason?: string
  actionsDisabledReason?: string
}) {
  const initials = user.username.slice(0, 2).toUpperCase()
  const colors = ['bg-blue-600', 'bg-purple-600', 'bg-emerald-600', 'bg-orange-600', 'bg-pink-600']
  const avatarColor = colors[user.id % colors.length]
  const isActive = user.is_active
  const roleLabel = user.role === 'admin' ? '管理员' : '普通用户'

  return (
    <tr className="group border-b border-slate-100 transition-colors last:border-0 hover:bg-slate-50 dark:border-white/[0.06] dark:hover:bg-white/[0.03]">
      <td className="px-4 py-4">
        <div className="flex items-center gap-3">
          <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${avatarColor} text-xs font-bold text-white`}>
            {initials}
          </div>
          <p className="min-w-0 truncate font-bold text-slate-900 dark:text-white" title={user.username}>{user.username}</p>
        </div>
      </td>
      <td className="truncate whitespace-nowrap px-4 py-4 text-sm text-slate-500 dark:text-slate-400" title={user.nickname || '未设置昵称'}>{user.nickname || '—'}</td>
      <td className="whitespace-nowrap px-4 py-4">
        <span className={`inline-flex h-7 items-center rounded-[6px] px-2 text-xs font-black ${
          user.role === 'admin' ? 'bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400' : 'bg-slate-100 dark:bg-white/[0.06] text-slate-500 dark:text-slate-400'
        }`}>
          {roleLabel}
        </span>
      </td>
      <td className="whitespace-nowrap px-4 py-4">
        <div className={`flex items-center gap-2 ${isActive ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400 dark:text-slate-500'}`}>
          <span className={`w-2 h-2 rounded-full ${isActive ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'}`} />
          <span className="text-xs font-medium">{isActive ? '启用' : '禁用'}</span>
        </div>
      </td>
      <td className="whitespace-nowrap px-4 py-4 text-sm text-slate-500 dark:text-slate-400">{formatUserDate(user.created_at)}</td>
      <td className="px-4 py-4 text-right">
        <UserActions user={user} {...actionProps} />
      </td>
    </tr>
  )
}

function MobileUserRow({ user, ...actionProps }: Parameters<typeof UserRow>[0]) {
  const roleLabel = user.role === 'admin' ? '管理员' : '普通用户'
  return (
    <article className="min-w-0 px-4 py-4">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0"><p className="break-words text-sm font-black text-slate-900 [overflow-wrap:anywhere] dark:text-white">{user.username}</p><p className="mt-1 break-words text-xs leading-5 text-slate-500 dark:text-slate-400">{user.nickname || '未设置昵称'}</p></div>
        <span className={`inline-flex h-7 shrink-0 items-center rounded-[6px] px-2 text-xs font-black ${user.role === 'admin' ? 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400' : 'bg-slate-100 text-slate-500 dark:bg-white/[0.06] dark:text-slate-400'}`}>{roleLabel}</span>
      </div>
      <dl className="mt-3 grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs leading-5">
        <dt className="font-semibold text-slate-400 dark:text-slate-500">账号状态</dt><dd className={`flex items-center gap-2 font-bold ${user.is_active ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500 dark:text-slate-400'}`}><span className={`h-2 w-2 rounded-full ${user.is_active ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'}`} />{user.is_active ? '启用' : '禁用'}</dd>
        <dt className="font-semibold text-slate-400 dark:text-slate-500">加入日期</dt><dd className="font-semibold text-slate-600 dark:text-slate-300">{formatUserDate(user.created_at)}</dd>
      </dl>
      <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-2 dark:border-white/[0.06]"><span className="text-xs text-slate-400">账号操作</span><UserActions user={user} {...actionProps} /></div>
    </article>
  )
}

/* ══════════════════════════════════════════════
   User Management Page
   ══════════════════════════════════════════════ */

function UsersContent() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { user: currentUser, loading: authLoading, isAdmin } = useAuth()
  const [users, setUsers] = useState<User[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(() => {
    const value = Number(searchParams.get('page') || 1)
    return Number.isInteger(value) && value > 0 ? value : 1
  })
  const [pageSize, setPageSize] = useState(() => {
    const value = Number(searchParams.get('size') || 10)
    return [10, 20, 50].includes(value) ? value : 10
  })
  const [search, setSearch] = useState(() => searchParams.get('q') || '')
  const [debouncedSearch, setDebouncedSearch] = useState(() => (searchParams.get('q') || '').trim())
  const [searchSettled, setSearchSettled] = useState(true)
  const [roleFilter, setRoleFilter] = useState(() => ['admin', 'user'].includes(searchParams.get('role') || '') ? searchParams.get('role')! : '')
  const [statusFilter, setStatusFilter] = useState(() => ['true', 'false'].includes(searchParams.get('status') || '') ? searchParams.get('status')! : '')
  const [modal, setModal] = useState<ModalType>(null)
  const [selectedUser, setSelectedUser] = useState<User | null>(null)
  const [createForm, setCreateForm] = useState<{ username: string; nickname: string; password: string; role: UserRole }>({ username: '', nickname: '', password: '', role: 'user' })
  const [editForm, setEditForm] = useState<{ nickname: string; role: UserRole; is_active: boolean }>({ nickname: '', role: 'user', is_active: true })
  const [resetPassword, setResetPassword] = useState('')
  const [passwordMinLength, setPasswordMinLength] = useState(6)
  const createUsernameRef = useRef<HTMLInputElement | null>(null)
  const editNicknameRef = useRef<HTMLInputElement | null>(null)
  const resetPasswordRef = useRef<HTMLInputElement | null>(null)
  const deleteCancelRef = useRef<HTMLButtonElement | null>(null)
  const [auditLogs, setAuditLogs] = useState<UserAuditItem[]>([])
  const [auditPage, setAuditPage] = useState(() => {
    const value = Number(searchParams.get('auditPage') || 1)
    return Number.isInteger(value) && value > 0 ? value : 1
  })
  const [auditPageSize, setAuditPageSize] = useState(() => auditPageSizeFromParam(searchParams.get('auditSize')))
  const [auditTotal, setAuditTotal] = useState(0)
  const [submitting, setSubmitting] = useState<{ action: SubmitAction; targetId: number | null } | null>(null)
  const [usersLoading, setUsersLoading] = useState(true)
  const [usersError, setUsersError] = useState('')
  const [usersLoaded, setUsersLoaded] = useState(false)
  const [loadedUserPage, setLoadedUserPage] = useState(1)
  const [loadedUserPageSize, setLoadedUserPageSize] = useState(10)
  const [loadedUserViewKey, setLoadedUserViewKey] = useState('')
  const [statsLoading, setStatsLoading] = useState(true)
  const [statsError, setStatsError] = useState('')
  const [auditLoading, setAuditLoading] = useState(true)
  const [auditError, setAuditError] = useState('')
  const [auditLoaded, setAuditLoaded] = useState(false)
  const [loadedAuditPage, setLoadedAuditPage] = useState(1)
  const [loadedAuditPageSize, setLoadedAuditPageSize] = useState(4)
  const [statsLoaded, setStatsLoaded] = useState(false)
  const [stats, setStats] = useState<UserStats>({ total: 0, active: 0, inactive: 0, new_this_week: 0, admin_count: 0, active_admin_count: 0 })
  const usersRequestId = useRef(0)
  const statsRequestId = useRef(0)
  const auditRequestId = useRef(0)
  const usersAbortRef = useRef<AbortController | null>(null)
  const statsAbortRef = useRef<AbortController | null>(null)
  const auditAbortRef = useRef<AbortController | null>(null)
  const submitInFlightRef = useRef<SubmitAction | null>(null)
  const submitAbortRef = useRef<AbortController | null>(null)
  const submitRequestId = useRef(0)
  const reconcileTimerRef = useRef<number | null>(null)
  const reconcileRequestIdRef = useRef(0)
  const auditRefreshInFlightRef = useRef(false)
  const skipNextAuditEffectRef = useRef(false)
  const currentListQueryRef = useRef<UserListQuery>({ page: 1, size: 10 })
  const searchSettledRef = useRef(true)
  const writtenSearchRef = useRef(searchParams.toString())
  /* ── Fetch stats from backend ── */
  const fetchStats = useCallback((force = false) => {
    statsAbortRef.current?.abort()
    const requestId = ++statsRequestId.current
    const controller = new AbortController()
    statsAbortRef.current = controller
    setStatsLoading(true)
    return usersApi.stats(force, controller.signal)
      .then((d) => {
        if (requestId !== statsRequestId.current) return
        setStats(d)
        setStatsError('')
        setStatsLoaded(true)
      })
      .catch((error) => {
        if (controller.signal.aborted) return
        if (requestId === statsRequestId.current) setStatsError(errorMessage(error, '用户统计读取失败'))
      })
      .finally(() => {
        if (statsAbortRef.current === controller) statsAbortRef.current = null
        if (requestId === statsRequestId.current) setStatsLoading(false)
      })
  }, [])

  /* ── Fetch users from backend ── */
  const fetchUsers = useCallback((force = false, queryOverride?: UserListQuery) => {
    usersAbortRef.current?.abort()
    const requestId = ++usersRequestId.current
    const controller = new AbortController()
    usersAbortRef.current = controller
    setUsersLoading(true)
    const params: UserListQuery = queryOverride || {
      page,
      size: pageSize,
      ...(debouncedSearch ? { keyword: debouncedSearch } : {}),
      ...(roleFilter ? { role: roleFilter } : {}),
      ...(statusFilter ? { is_active: statusFilter } : {}),
    }
    return usersApi.list(params, force, controller.signal)
      .then((d) => {
        if (requestId !== usersRequestId.current) return
        const responsePage = d.page || params.page || 1
        const responseSize = d.size || params.size || pageSize
        setUsers(d.items || [])
        setTotal(d.total ?? 0)
        setLoadedUserPage(responsePage)
        setLoadedUserPageSize(responseSize)
        setLoadedUserViewKey(userListViewKey({ ...params, page: responsePage, size: responseSize }))
        if (responsePage !== page) setPage(responsePage)
        setUsersLoaded(true)
        setUsersError('')
      })
      .catch((error) => {
        if (controller.signal.aborted) return
        if (requestId === usersRequestId.current) setUsersError(errorMessage(error, '用户列表读取失败'))
      })
      .finally(() => {
        if (usersAbortRef.current === controller) usersAbortRef.current = null
        if (requestId === usersRequestId.current) setUsersLoading(false)
      })
  }, [page, pageSize, debouncedSearch, roleFilter, statusFilter])

  const fetchAuditLogs = useCallback((force = false, requestedPage = auditPage) => {
    auditAbortRef.current?.abort()
    const requestId = ++auditRequestId.current
    const controller = new AbortController()
    auditAbortRef.current = controller
    setAuditLoading(true)
    return usersApi.audit({ page: requestedPage, size: auditPageSize }, force, controller.signal)
      .then((d) => {
        if (requestId !== auditRequestId.current) return
        setAuditLogs(d.items || [])
        setAuditTotal(d.total || 0)
        const responsePage = d.page || requestedPage
        const responsePageSize = auditPageSizeFromParam(String(d.size || ''), auditPageSize)
        setLoadedAuditPage(responsePage)
        setLoadedAuditPageSize(responsePageSize)
        if (responsePage !== auditPage || responsePageSize !== auditPageSize) {
          skipNextAuditEffectRef.current = true
        }
        setAuditPageSize(responsePageSize)
        if (responsePage !== auditPage) setAuditPage(responsePage)
        setAuditLoaded(true)
        setAuditError('')
      })
      .catch((error) => {
        if (controller.signal.aborted) return
        if (requestId === auditRequestId.current) setAuditError(errorMessage(error, '用户操作审计读取失败'))
      })
      .finally(() => {
        if (auditAbortRef.current === controller) auditAbortRef.current = null
        if (requestId === auditRequestId.current) setAuditLoading(false)
      })
  }, [auditPage, auditPageSize])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search.trim())
      searchSettledRef.current = true
      setSearchSettled(true)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [search])

  useEffect(() => {
    if (pathname !== '/users') return
    const url = new URL(window.location.href)
    const values: Record<string, string> = {
      q: search.trim(),
      role: roleFilter,
      status: statusFilter,
      page: page === 1 ? '' : String(page),
      size: pageSize === 10 ? '' : String(pageSize),
      auditPage: auditPage === 1 ? '' : String(auditPage),
      auditSize: auditPageSize === 4 ? '' : String(auditPageSize),
    }
    Object.entries(values).forEach(([key, value]) => {
      if (value) url.searchParams.set(key, value)
      else url.searchParams.delete(key)
    })
    const nextSearch = url.searchParams.toString()
    writtenSearchRef.current = nextSearch
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }, [auditPage, auditPageSize, page, pageSize, pathname, roleFilter, search, statusFilter])

  useEffect(() => {
    if (pathname !== '/users') return
    const nextSearch = searchParams.toString()
    if (nextSearch === writtenSearchRef.current) return
    writtenSearchRef.current = nextSearch
    const nextKeyword = searchParams.get('q') || ''
    const rawRole = searchParams.get('role') || ''
    const rawStatus = searchParams.get('status') || ''
    const rawPage = Number(searchParams.get('page') || 1)
    const rawPageSize = Number(searchParams.get('size') || 10)
    const rawAuditPage = Number(searchParams.get('auditPage') || 1)
    invalidateUserList()
    setSearch(nextKeyword)
    setDebouncedSearch(nextKeyword.trim())
    searchSettledRef.current = true
    setSearchSettled(true)
    setRoleFilter(['admin', 'user'].includes(rawRole) ? rawRole : '')
    setStatusFilter(['true', 'false'].includes(rawStatus) ? rawStatus : '')
    setPage(Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1)
    setPageSize([10, 20, 50].includes(rawPageSize) ? rawPageSize : 10)
    setAuditPage(Number.isInteger(rawAuditPage) && rawAuditPage > 0 ? rawAuditPage : 1)
    setAuditPageSize(auditPageSizeFromParam(searchParams.get('auditSize')))
  }, [pathname, searchParams])

  currentListQueryRef.current = {
    page,
    size: pageSize,
    ...(debouncedSearch ? { keyword: debouncedSearch } : {}),
    ...(roleFilter ? { role: roleFilter } : {}),
    ...(statusFilter ? { is_active: statusFilter } : {}),
  }

  useEffect(() => {
    if (!isAdmin || !searchSettled || search.trim() !== debouncedSearch) return
    fetchUsers()
  }, [debouncedSearch, fetchUsers, isAdmin, search, searchSettled])
  useEffect(() => { if (isAdmin) fetchStats() }, [fetchStats, isAdmin])
  useEffect(() => {
    if (!isAdmin) return
    const controller = new AbortController()
    void authApi.getPublicConfig(controller.signal)
      .then((config) => {
        const value = Number(config.password_min_length)
        if (Number.isInteger(value) && value >= 4 && value <= 128) setPasswordMinLength(value)
      })
      .catch((error) => {
        if (!isAbortError(error)) setPasswordMinLength(6)
      })
    return () => controller.abort()
  }, [isAdmin])
  useEffect(() => {
    if (!isAdmin) return
    if (skipNextAuditEffectRef.current) {
      skipNextAuditEffectRef.current = false
      return
    }
    void fetchAuditLogs()
  }, [fetchAuditLogs, isAdmin])

  useEffect(() => {
    if (authLoading || isAdmin) return
    usersRequestId.current += 1
    statsRequestId.current += 1
    auditRequestId.current += 1
    usersAbortRef.current?.abort()
    statsAbortRef.current?.abort()
    auditAbortRef.current?.abort()
    usersAbortRef.current = null
    statsAbortRef.current = null
    auditAbortRef.current = null
    setUsersLoading(false)
    setStatsLoading(false)
    setAuditLoading(false)
  }, [authLoading, isAdmin])

  useEffect(() => () => {
    usersRequestId.current += 1
    statsRequestId.current += 1
    auditRequestId.current += 1
    usersAbortRef.current?.abort()
    statsAbortRef.current?.abort()
    auditAbortRef.current?.abort()
    submitAbortRef.current?.abort()
    if (reconcileTimerRef.current !== null) window.clearTimeout(reconcileTimerRef.current)
    submitRequestId.current += 1
    reconcileRequestIdRef.current += 1
    submitInFlightRef.current = null
    auditRefreshInFlightRef.current = false
  }, [])

  const currentUserViewKey = userListViewKey(currentListQueryRef.current)
  const userSnapshotMatchesView = usersLoaded
    && searchSettled
    && search.trim() === debouncedSearch
    && loadedUserViewKey === currentUserViewKey
  const auditSnapshotMatchesPage = auditLoaded
    && loadedAuditPage === auditPage
    && loadedAuditPageSize === auditPageSize
  const userWorkspaceWritable = userSnapshotMatchesView && !usersLoading && !usersError
  const selectedIsCurrentUser = !!selectedUser && selectedUser.id === currentUser?.user_id
  const selectedAdminCountUnconfirmed = !!selectedUser
    && selectedUser.role === 'admin'
    && selectedUser.is_active
    && !statsLoaded
  const selectedIsLastActiveAdmin = !!selectedUser
    && selectedUser.role === 'admin'
    && selectedUser.is_active
    && statsLoaded
    && stats.active_admin_count <= 1
  const selectedAdminAccessLocked = selectedIsCurrentUser || selectedAdminCountUnconfirmed || selectedIsLastActiveAdmin
  const selectedAdminLockReason = selectedIsCurrentUser
    ? '当前登录账号只能修改昵称，不能移除自己的管理权限或禁用账号'
    : selectedAdminCountUnconfirmed
      ? '正在确认启用管理员数量，暂不允许移除管理权限或禁用账号'
    : selectedIsLastActiveAdmin
      ? '系统至少需保留一位启用管理员'
      : ''

  useEffect(() => {
    if (!isAdmin || (!usersError && !statsError && !auditError)) return
    const recoverFailedReads = () => {
      if (!navigator.onLine || document.visibilityState !== 'visible' || submitInFlightRef.current) return
      if (usersError && !usersAbortRef.current && searchSettledRef.current) {
        fetchUsers(true, currentListQueryRef.current)
      }
      if (statsError && !statsAbortRef.current) fetchStats(true)
      if (auditError && !auditAbortRef.current) void fetchAuditLogs(true, auditPage)
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
  }, [auditError, auditPage, fetchAuditLogs, fetchStats, fetchUsers, isAdmin, statsError, usersError])

  const deleteDisabledReason = (target: User) => {
    if (target.id === currentUser?.user_id) return '当前登录账号不可删除'
    if (target.role === 'admin' && target.is_active && !statsLoaded) {
      return '正在确认启用管理员数量，暂不可删除'
    }
    if (target.role === 'admin' && target.is_active && statsLoaded && stats.active_admin_count <= 1) {
      return '系统至少需保留一位启用管理员'
    }
    return ''
  }

  const closeModal = () => {
    if (submitInFlightRef.current) return
    setModal(null)
    setSelectedUser(null)
    setResetPassword('')
    setCreateForm((current) => ({ ...current, password: '' }))
  }

  const invalidateUserList = () => {
    usersAbortRef.current?.abort()
    usersAbortRef.current = null
    usersRequestId.current += 1
    setUsersError('')
    setUsersLoading(true)
  }

  const refreshCurrentUserList = () => {
    if (!searchSettledRef.current) return Promise.resolve()
    return fetchUsers(true, currentListQueryRef.current)
  }

  const refreshUserWorkspace = () => {
    if (!searchSettledRef.current) return
    refreshCurrentUserList()
    fetchStats(true)
  }

  const refreshAuditAfterMutation = () => {
    return fetchAuditLogs(true, 1)
  }

  const reconcileMutationState = () => {
    const reconcileRequestId = ++reconcileRequestIdRef.current
    if (reconcileTimerRef.current !== null) window.clearTimeout(reconcileTimerRef.current)
    void Promise.allSettled([
      refreshCurrentUserList(),
      fetchStats(true),
      refreshAuditAfterMutation(),
    ]).then(() => {
      if (reconcileRequestIdRef.current !== reconcileRequestId) return
      reconcileTimerRef.current = window.setTimeout(() => {
        if (reconcileRequestIdRef.current !== reconcileRequestId) return
        reconcileTimerRef.current = null
        void Promise.allSettled([
          refreshCurrentUserList(),
          fetchStats(true),
          fetchAuditLogs(true, 1),
        ])
      }, 1200)
    })
  }

  const beginSubmit = (action: SubmitAction, targetId: number | null) => {
    if (submitInFlightRef.current) return null
    const controller = new AbortController()
    const requestId = ++submitRequestId.current
    submitInFlightRef.current = action
    submitAbortRef.current = controller
    setSubmitting({ action, targetId })
    return { controller, requestId }
  }

  const endSubmit = (action: SubmitAction, requestId: number) => {
    if (submitInFlightRef.current !== action || submitRequestId.current !== requestId) return
    submitInFlightRef.current = null
    submitAbortRef.current = null
    setSubmitting(null)
  }

  const cancelSubmitWait = () => {
    const action = submitInFlightRef.current
    if (!action) return
    submitAbortRef.current?.abort()
    submitAbortRef.current = null
    submitRequestId.current += 1
    submitInFlightRef.current = null
    setSubmitting(null)
    setModal(null)
    setSelectedUser(null)
    setResetPassword('')
    setCreateForm((current) => ({ ...current, password: '' }))
    reconcileMutationState()
    toast.warning('已取消等待；操作可能已经完成，正在重新读取用户、统计和审计记录')
  }

  const handleUncertainMutation = () => {
    setModal(null)
    setSelectedUser(null)
    setResetPassword('')
    setCreateForm((current) => ({ ...current, password: '' }))
    reconcileMutationState()
    toast.warning('请求超时或网络中断，操作可能已经完成；正在重新读取最终状态，请勿立即重复提交')
  }

  const ensureAdminMutation = () => {
    if (currentUser?.role === 'admin') return true
    setModal(null)
    setSelectedUser(null)
    setResetPassword('')
    setCreateForm((current) => ({ ...current, password: '' }))
    toast.error('仅管理员可管理用户')
    return false
  }

  const ensureCurrentUserSnapshot = () => {
    if (userSnapshotMatchesView) return true
    toast.warning('当前列表仍是旧快照，请等待当前筛选条件读取完成后再操作')
    return false
  }

  const handleAuditRefresh = async () => {
    if (auditRefreshInFlightRef.current) return
    auditRefreshInFlightRef.current = true
    try {
      await fetchAuditLogs(true)
    } finally {
      auditRefreshInFlightRef.current = false
    }
  }

  /* ── Create user ── */
  const handleCreate = async () => {
    if (!ensureAdminMutation()) return
    if (createForm.username.trim().length < 2) {
      toast.warning('用户名至少需要 2 个字符')
      return
    }
    if (/\s|[\u0000-\u001f\u007f]/.test(createForm.username)) {
      toast.warning('用户名不能包含空格或控制字符')
      return
    }
    if (createForm.password.length < passwordMinLength) {
      toast.warning(`密码至少需要 ${passwordMinLength} 位`)
      return
    }
    const submission = beginSubmit('create', null)
    if (!submission) return
    try {
      await usersApi.create({
        username: createForm.username.trim(),
        password: createForm.password,
        nickname: createForm.nickname.trim() || createForm.username.trim(),
        role: createForm.role,
      }, submission.controller.signal)
      if (submitRequestId.current !== submission.requestId) return
      setModal(null)
      setCreateForm({ username: '', nickname: '', password: '', role: 'user' })
      refreshCurrentUserList()
      fetchStats(true)
      refreshAuditAfterMutation()
      toast.success('用户创建成功')
    } catch (error: unknown) {
      if (submitRequestId.current !== submission.requestId || isAbortError(error)) return
      if (error instanceof ApiError && error.status === 0) {
        handleUncertainMutation()
        return
      }
      toast.error(errorMessage(error, '创建失败'))
    } finally {
      setCreateForm((current) => ({ ...current, password: '' }))
      endSubmit('create', submission.requestId)
    }
  }

  /* ── Edit user ── */
  const handleEdit = async () => {
    if (!ensureAdminMutation()) return
    if (!ensureCurrentUserSnapshot()) return
    if (!selectedUser) return
    const targetId = selectedUser.id
    const submission = beginSubmit('edit', targetId)
    if (!submission) return
    try {
      await usersApi.update(targetId, {
        nickname: editForm.nickname.trim(),
        role: selectedAdminAccessLocked ? selectedUser.role : editForm.role,
        is_active: selectedAdminAccessLocked ? selectedUser.is_active : editForm.is_active,
      }, submission.controller.signal)
      if (submitRequestId.current !== submission.requestId) return
      setModal(null)
      setSelectedUser(null)
      refreshCurrentUserList()
      fetchStats(true)
      refreshAuditAfterMutation()
      toast.success('用户信息已更新')
    } catch (error: unknown) {
      if (submitRequestId.current !== submission.requestId || isAbortError(error)) return
      if (error instanceof ApiError && error.status === 0) {
        handleUncertainMutation()
        return
      }
      toast.error(errorMessage(error, '更新失败'))
    } finally {
      endSubmit('edit', submission.requestId)
    }
  }

  /* ── Delete user ── */
  const handleDelete = async () => {
    if (!ensureAdminMutation()) return
    if (!ensureCurrentUserSnapshot()) return
    if (!selectedUser) return
    const targetId = selectedUser.id
    const submission = beginSubmit('delete', targetId)
    if (!submission) return
    try {
      await usersApi.delete(targetId, submission.controller.signal)
      if (submitRequestId.current !== submission.requestId) return
      setModal(null)
      setSelectedUser(null)
      if (users.length === 1 && page > 1) setPage((value) => value - 1)
      else refreshCurrentUserList()
      fetchStats(true)
      refreshAuditAfterMutation()
      toast.success('用户已删除')
    } catch (error: unknown) {
      if (submitRequestId.current !== submission.requestId || isAbortError(error)) return
      if (error instanceof ApiError && error.status === 0) {
        handleUncertainMutation()
        return
      }
      toast.error(errorMessage(error, '删除失败'))
    } finally {
      endSubmit('delete', submission.requestId)
    }
  }

  /* ── Open edit modal ── */
  const openEditModal = (user: User) => {
    if (!ensureCurrentUserSnapshot()) return
    setSelectedUser(user)
    setEditForm({ nickname: user.nickname || '', role: user.role, is_active: user.is_active })
    setModal('edit')
  }

  const openResetModal = (user: User) => {
    if (!ensureCurrentUserSnapshot()) return
    setSelectedUser(user)
    setResetPassword('')
    setModal('reset')
  }

  const openDeleteModal = (user: User) => {
    if (!ensureCurrentUserSnapshot()) return
    setSelectedUser(user)
    setModal('delete')
  }

  const handleResetPassword = async () => {
    if (!ensureAdminMutation()) return
    if (!ensureCurrentUserSnapshot()) return
    if (!selectedUser) return
    if (resetPassword.length < passwordMinLength) {
      toast.warning(`新密码至少需要 ${passwordMinLength} 位`)
      return
    }
    const targetId = selectedUser.id
    const submission = beginSubmit('reset', targetId)
    if (!submission) return
    try {
      await usersApi.resetPassword(targetId, resetPassword, submission.controller.signal)
      if (submitRequestId.current !== submission.requestId) return
      setModal(null)
      setSelectedUser(null)
      setResetPassword('')
      refreshAuditAfterMutation()
      toast.success('密码已重置')
    } catch (error: unknown) {
      if (submitRequestId.current !== submission.requestId || isAbortError(error)) return
      if (error instanceof ApiError && error.status === 0) {
        handleUncertainMutation()
        return
      }
      toast.error(errorMessage(error, '重置失败'))
    } finally {
      setResetPassword('')
      endSubmit('reset', submission.requestId)
    }
  }

  const inputClass = "w-full rounded-[8px] border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-medium text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-blue-300 focus:ring-2 focus:ring-blue-500/10 dark:border-white/[0.08] dark:bg-white/[0.06] dark:text-white dark:placeholder:text-slate-500"
  const labelClass = "text-xs font-bold text-slate-500 dark:text-slate-400"
  const createUsernameHasInvalidCharacters = /\s|[\u0000-\u001f\u007f]/.test(createForm.username)
  const createUsernameInvalid = createForm.username.length > 0 && (
    createForm.username.trim().length < 2 || createUsernameHasInvalidCharacters
  )
  const createUsernameValid = createForm.username.trim().length >= 2 && !createUsernameHasInvalidCharacters
  const createPasswordInvalid = createForm.password.length > 0 && createForm.password.length < passwordMinLength
  const resetPasswordInvalid = resetPassword.length > 0 && resetPassword.length < passwordMinLength

  if (authLoading) {
    return <div className="flex min-h-[50vh] items-center justify-center text-sm font-bold text-slate-400"><LoaderCircle size={17} className="mr-2 animate-spin" />正在确认用户管理权限...</div>
  }

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-7xl">
        <section className="border-b border-slate-200 pb-8 dark:border-white/[0.08]">
          <p className="text-xs font-black text-blue-600 dark:text-blue-400">访问权限</p>
          <h2 className="mt-2 text-3xl font-black text-slate-900 dark:text-white">用户管理</h2>
          <p className="mt-3 max-w-2xl text-sm font-medium leading-7 text-slate-500 dark:text-slate-400">用户列表、角色、账号状态、密码重置和管理审计仅由管理员维护。当前账号不会读取任何用户管理数据。</p>
        </section>
        <section className="py-10 sm:py-14">
          <div className="flex max-w-2xl items-start gap-4">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[8px] bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-300"><ShieldAlert size={21} /></div>
            <div className="min-w-0">
              <h3 className="text-lg font-black text-slate-900 dark:text-white">需要管理员权限</h3>
              <p className="mt-2 text-sm leading-7 text-slate-500 dark:text-slate-400">如需创建账号、调整角色或查看用户操作审计，请联系系统管理员。你仍可正常使用智能体、设备、模型状态和帮助文档等已授权功能。</p>
              <div className="mt-5 flex flex-col gap-2 sm:flex-row">
                <Link href="/dashboard" className="inline-flex min-h-10 items-center justify-center rounded-[8px] bg-blue-600 px-5 text-sm font-bold text-white transition hover:bg-blue-700">返回系统总览</Link>
                <Link href="/docs" className="inline-flex min-h-10 items-center justify-center rounded-[8px] border border-slate-200 bg-white px-5 text-sm font-bold text-slate-600 transition hover:border-blue-200 hover:text-blue-700 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-slate-300">查看帮助文档</Link>
              </div>
            </div>
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-7xl space-y-8 sm:space-y-12">
      {/* Header */}
      <section>
        <h2 className="mb-2 text-3xl font-black text-slate-900 dark:text-white">用户管理</h2>
        <p className="text-slate-500 dark:text-slate-400 font-medium">管理系统用户、角色和访问权限</p>
        {statsError && (
          <div role="alert" className="mt-4 flex items-start gap-2 rounded-[8px] bg-amber-50 px-4 py-3 text-xs font-bold leading-5 text-amber-700 dark:bg-amber-500/10 dark:text-amber-200">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span>{statsError}{statsLoaded ? '；统计卡继续保留上次成功数据。' : '；统计卡暂不显示未经确认的数值。'}</span>
          </div>
        )}
      </section>

      {/* Stat cards */}
      <section className="grid grid-cols-2 gap-3 sm:gap-6 lg:grid-cols-4">
        <StatCard icon={Users} value={statsLoaded ? String(stats.total) : '—'} label="用户总数"
          iconColor="text-blue-600 dark:text-blue-400" iconBg="bg-blue-50 dark:bg-blue-500/10" />
        <StatCard icon={UserCheck} value={statsLoaded ? String(stats.active) : '—'} label="启用用户"
          iconColor="text-emerald-600 dark:text-emerald-400" iconBg="bg-emerald-50 dark:bg-emerald-500/10" />
        <StatCard icon={UserPlus} value={statsLoaded ? String(stats.new_this_week) : '—'} label="新增用户" trendLabel="本周"
          iconColor="text-purple-600 dark:text-purple-400" iconBg="bg-purple-50 dark:bg-purple-500/10" />
        <StatCard icon={ShieldCheck} value={statsLoaded ? `${stats.total > 0 ? Math.round(((stats.total - stats.admin_count) / stats.total) * 100) : 0}%` : '—'} label="普通用户占比" trendLabel={statsLoaded ? `${stats.admin_count} 位管理员` : '尚未取得统计'}
          iconColor="text-orange-600 dark:text-orange-400" iconBg="bg-orange-50 dark:bg-orange-500/10" />
      </section>

      <section className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <div className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm dark:border-white/[0.06] dark:bg-gradient-to-b dark:from-white/[0.06] dark:to-white/[0.02]">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300">
              <ShieldAlert size={18} />
            </div>
            <div>
              <h3 className="text-lg font-black text-slate-900 dark:text-white">角色权限说明</h3>
              <p className="text-sm text-slate-500 dark:text-slate-400">管理员负责用户和配置维护；普通用户使用对话、设备、文档等业务能力。</p>
            </div>
          </div>
          <div className="grid overflow-hidden rounded-[8px] border border-slate-100 sm:grid-cols-2 sm:divide-x sm:divide-slate-100 dark:border-white/[0.06] dark:sm:divide-white/[0.06]">
            <div className="px-4 py-3 sm:py-4">
              <p className="text-xs font-bold text-blue-500">管理员</p>
              <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">可创建、编辑、禁用、删除用户并重置密码；不可删除或禁用自己的账号。</p>
            </div>
            <div className="border-t border-slate-100 px-4 py-3 sm:border-t-0 sm:py-4 dark:border-white/[0.06]">
              <p className="text-xs font-bold text-slate-500 dark:text-slate-400">普通用户</p>
              <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">可使用业务页面和智能体能力；用户管理入口由管理员角色控制。</p>
            </div>
          </div>
        </div>
        <div className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm dark:border-white/[0.06] dark:bg-gradient-to-b dark:from-white/[0.06] dark:to-white/[0.02]">
          <div className="mb-4 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-300">
                <ScrollText size={18} />
              </div>
              <div>
                <h3 className="text-lg font-black text-slate-900 dark:text-white">用户操作审计</h3>
                <p className="text-sm text-slate-500 dark:text-slate-400">来自平台审计日志，仅记录操作对象和结果，不记录密码。</p>
              </div>
            </div>
            <button disabled={auditLoading} onClick={() => void handleAuditRefresh()} className="flex min-h-9 items-center gap-2 rounded-[8px] bg-slate-100 px-4 py-2 text-xs font-black text-slate-500 hover:bg-slate-200 disabled:cursor-wait disabled:opacity-60 dark:bg-white/[0.06] dark:text-slate-300">
              {auditLoading ? <LoaderCircle size={14} className="animate-spin" /> : null}
              {auditLoading ? '读取中' : '刷新'}
            </button>
          </div>
          {auditError && auditLoaded && (
            <div role="alert" className="mb-3 flex items-start gap-2 rounded-[8px] bg-amber-50 px-4 py-3 text-xs font-bold leading-5 text-amber-700 dark:bg-amber-500/10 dark:text-amber-200">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" />
              <span>{auditError}；下方保留第 {loadedAuditPage} 页上次成功读取的{auditLogs.length ? '记录' : '空结果'}。</span>
            </div>
          )}
          {auditLoaded && (auditLoading || !auditSnapshotMatchesPage) ? (
            <div className="mb-3 flex items-center gap-2 border-l-2 border-blue-500 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700 dark:bg-blue-500/10 dark:text-blue-300" role="status">
              {auditLoading ? <LoaderCircle size={14} className="animate-spin" /> : null}
              {auditLoading ? `正在读取第 ${auditPage} 页审计记录，` : `正在切换到第 ${auditPage} 页，`}下方暂时显示第 {loadedAuditPage} 页旧快照，不能代表当前页。
            </div>
          ) : null}
          <div className="max-h-44 divide-y divide-slate-100 overflow-y-auto rounded-[8px] border border-slate-100 dark:divide-white/[0.06] dark:border-white/[0.06]">
            {auditLogs.length ? auditLogs.map((log) => (
              <div key={log.id} className="px-1 py-3 pr-3 first:pt-2 last:pb-2">
                <div className="flex items-center justify-between gap-3">
                  <p className="min-w-0 truncate text-sm font-black text-slate-900 dark:text-white" title={`${AUDIT_ACTION_LABELS[log.action] || '用户管理操作'} · ${log.target_username || '未知用户'}`}>{AUDIT_ACTION_LABELS[log.action] || '用户管理操作'} · {log.target_username || '未知用户'}</p>
                  <span className="shrink-0 text-xs font-bold text-slate-400">{formatAuditTime(log.created_at)}</span>
                </div>
                <p className="mt-1 line-clamp-2 break-words text-xs leading-5 text-slate-500 dark:text-slate-400" title={auditSummary(log)}>{auditSummary(log)}</p>
              </div>
            )) : auditLoading ? (
              <div className="px-4 py-8 text-center text-sm text-slate-400">
                正在读取用户操作审计
              </div>
            ) : auditError ? (
              <div role="alert" className="break-words px-4 py-8 text-center text-sm leading-6 text-amber-600 dark:text-amber-300">
                {auditError}
              </div>
            ) : (
              <div className="px-4 py-8 text-center text-sm text-slate-400">
                暂无用户管理操作记录；后续创建、编辑、启停、重置密码或删除操作会显示在这里
              </div>
            )}
          </div>
          {auditLoaded ? <Pagination
            page={auditSnapshotMatchesPage ? auditPage : loadedAuditPage}
            pageSize={loadedAuditPageSize}
            total={auditTotal}
            loading={auditLoading}
            navigationDisabled={!auditSnapshotMatchesPage}
            onPageChange={(nextPage) => {
              if (!auditSnapshotMatchesPage) return
              auditAbortRef.current?.abort()
              auditRequestId.current += 1
              setAuditLoading(true)
              setAuditPage(nextPage)
            }}
            onPageSizeChange={(nextSize) => {
              if (!auditSnapshotMatchesPage || nextSize === auditPageSize) return
              auditAbortRef.current?.abort()
              auditRequestId.current += 1
              setAuditLoading(true)
              setAuditPageSize(nextSize)
              setAuditPage(1)
            }}
            pageSizeOptions={AUDIT_PAGE_SIZES}
            itemName="条审计记录"
            className="mt-3 px-0 pb-0"
          /> : null}
        </div>
      </section>

      {/* Filter bar */}
      <section className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-center gap-4 px-2">
          <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center sm:gap-4">
            <div className="relative flex-1 sm:w-80">
              <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500" />
              <input
                aria-label="搜索用户"
                type="text" value={search} onChange={e => {
                  invalidateUserList()
                  searchSettledRef.current = false
                  setSearchSettled(false)
                  setSearch(e.target.value)
                  setPage(1)
                }}
                placeholder="按用户名、昵称搜索..."
                className="min-h-10 w-full rounded-[8px] border border-slate-200 bg-slate-50 py-2 pl-10 pr-4 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-blue-400 focus:bg-white focus:ring-2 focus:ring-blue-500/10 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-white dark:placeholder:text-slate-500 dark:focus:border-blue-400/50 dark:focus:bg-white/[0.07]"
              />
            </div>
            <UnifiedSelect
              ariaLabel="筛选用户角色"
              value={roleFilter}
              className="w-full sm:w-36 [&>button]:rounded-[8px]"
              size="sm"
              options={[
                { value: '', label: '所有角色' },
                { value: 'admin', label: '管理员' },
                { value: 'user', label: '普通用户' },
              ]}
              onChange={(nextValue) => { invalidateUserList(); setRoleFilter(nextValue); setPage(1) }}
            />
            <UnifiedSelect
              ariaLabel="筛选用户状态"
              value={statusFilter}
              className="w-full sm:w-36 [&>button]:rounded-[8px]"
              size="sm"
              options={[
                { value: '', label: '全部状态' },
                { value: 'true', label: '启用' },
                { value: 'false', label: '禁用' },
              ]}
              onChange={(nextValue) => { invalidateUserList(); setStatusFilter(nextValue); setPage(1) }}
            />
          </div>
          <div className="flex w-full gap-2 sm:w-auto">
            <button
              type="button"
              onClick={refreshUserWorkspace}
              disabled={usersLoading || statsLoading}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] border border-slate-200 bg-white text-slate-500 transition hover:border-blue-200 hover:text-blue-600 disabled:cursor-wait disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-slate-300"
              title="刷新用户列表与统计"
              aria-label="刷新用户列表与统计"
            >
              <RefreshCw size={16} className={usersLoading || statsLoading ? 'animate-spin' : ''} />
            </button>
            <button
              onClick={() => { if (userWorkspaceWritable) { setCreateForm({ username: '', nickname: '', password: '', role: 'user' }); setModal('create') } }}
              disabled={!userWorkspaceWritable}
              title={userWorkspaceWritable ? '添加用户' : '当前用户列表成功读取后才可添加用户'}
              className="flex min-h-10 flex-1 items-center justify-center gap-2 rounded-[8px] bg-blue-600 px-6 py-2 text-sm font-bold text-white shadow-lg shadow-blue-500/20 transition-transform active:scale-95 disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none sm:flex-none"
            >
              <Plus size={18} />
              添加用户
            </button>
          </div>
        </div>

        {usersError && usersLoaded && (
          <div role="alert" className="flex items-start gap-2 rounded-[8px] bg-amber-50 px-4 py-3 text-xs font-bold leading-5 text-amber-700 dark:bg-amber-500/10 dark:text-amber-200">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span>{usersError}；列表继续保留上次成功读取的{users.length ? '数据' : '空结果'}。</span>
          </div>
        )}
        {usersLoaded && !userSnapshotMatchesView ? (
          <div className="flex items-center gap-2 border-l-2 border-blue-500 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700 dark:bg-blue-500/10 dark:text-blue-300" role="status">
            {usersLoading ? <LoaderCircle size={14} className="shrink-0 animate-spin" /> : <AlertTriangle size={14} className="shrink-0" />}
            <span>
              {usersLoading
                ? `正在读取当前筛选条件的第 ${page} 页，`
                : `当前筛选条件的第 ${page} 页尚未读取成功，`}
              下方暂时显示上次成功读取的第 {loadedUserPage} 页快照，操作与翻页已锁定。
            </span>
          </div>
        ) : null}

        {/* Table */}
        <div aria-busy={usersLoading} className="bg-white dark:bg-transparent dark:bg-gradient-to-b dark:from-white/[0.04] dark:to-transparent rounded-2xl overflow-hidden shadow-sm dark:shadow-none border border-slate-100 dark:border-white/[0.06]">
          {usersLoading && users.length > 0 ? (
            <div className="flex items-center justify-end gap-2 border-b border-slate-100 px-6 py-2 text-xs font-medium text-slate-400 dark:border-white/[0.06] dark:text-slate-500">
              <LoaderCircle size={13} className="animate-spin" />
              正在更新列表
            </div>
          ) : null}
          <div className="divide-y divide-slate-100 md:hidden dark:divide-white/[0.06]" aria-label="系统用户列表">
            {users.map(user => (
              <MobileUserRow
                key={user.id}
                user={user}
                onEdit={openEditModal}
                onReset={openResetModal}
                onDelete={openDeleteModal}
                actionsDisabledReason={!userSnapshotMatchesView ? '当前列表为旧快照，读取完成后才可操作' : undefined}
                deleteDisabledReason={deleteDisabledReason(user)}
              />
            ))}
            {users.length === 0 ? (
              <div role={!usersLoaded && usersError ? 'alert' : undefined} className={`break-words px-6 py-14 text-center text-sm leading-6 ${!usersLoaded && usersError ? 'text-amber-600 dark:text-amber-300' : 'text-slate-400 dark:text-slate-500'}`}>
                {!usersLoaded && usersLoading ? '正在应用筛选条件并读取用户列表' : !usersLoaded && usersError ? usersError : '暂无用户数据'}
              </div>
            ) : null}
          </div>
          <div className="hidden overflow-x-auto md:block" tabIndex={0} role="region" aria-label="系统用户列表，可横向滚动">
            <table className="w-full min-w-[920px] table-auto text-left [&_td]:align-middle [&_th]:whitespace-nowrap">
              <thead>
                <tr className="bg-slate-50/50 dark:bg-white/[0.04]">
                  <th className="w-[27%] px-4 py-4 text-xs font-bold text-slate-500 dark:text-slate-400">用户</th>
                  <th className="w-[20%] px-4 py-4 text-xs font-bold text-slate-500 dark:text-slate-400">昵称</th>
                  <th className="w-[12%] px-4 py-4 text-xs font-bold text-slate-500 dark:text-slate-400">角色</th>
                  <th className="w-[11%] px-4 py-4 text-xs font-bold text-slate-500 dark:text-slate-400">状态</th>
                  <th className="w-[15%] px-4 py-4 text-xs font-bold text-slate-500 dark:text-slate-400">加入日期</th>
                  <th className="w-[15%] px-4 py-4 text-right text-xs font-bold text-slate-500 dark:text-slate-400">操作</th>
                </tr>
              </thead>
              <tbody>
                {users.map(user => (
                  <UserRow
                    key={user.id} user={user}
                    onEdit={openEditModal}
                    onReset={openResetModal}
                    onDelete={openDeleteModal}
                    actionsDisabledReason={!userSnapshotMatchesView ? '当前列表为旧快照，读取完成后才可操作' : undefined}
                    deleteDisabledReason={deleteDisabledReason(user)}
                  />
                ))}
                {users.length === 0 && (
                  <tr>
                    <td colSpan={6} role={!usersLoaded && usersError ? 'alert' : undefined} className={`break-words px-8 py-16 text-center leading-6 ${!usersLoaded && usersError ? 'text-amber-600 dark:text-amber-300' : 'text-slate-400 dark:text-slate-500'}`}>
                      {!usersLoaded && usersLoading ? '正在应用筛选条件并读取用户列表' : !usersLoaded && usersError ? usersError : '暂无用户数据'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {usersLoaded ? <Pagination
            page={loadedUserPage}
            pageSize={loadedUserPageSize}
            total={total}
            itemName="位用户"
            loading={usersLoading}
            navigationDisabled={!userSnapshotMatchesView}
            onPageChange={(nextPage) => { invalidateUserList(); setPage(nextPage) }}
            onPageSizeChange={(nextSize) => { invalidateUserList(); setPageSize(nextSize); setPage(1) }}
            pageSizeOptions={[10, 20, 50]}
          /> : null}
        </div>
      </section>

      {/* ═══ Create User Modal ═══ */}
      {modal === 'create' && (
        <AppDialog
          title="创建用户"
          onClose={closeModal}
          maxWidth="max-w-md"
          initialFocusRef={createUsernameRef}
          closeOnOverlay={submitting?.action !== 'create'}
          showClose={submitting?.action !== 'create'}
          footer={(
            <button
              onClick={submitting?.action === 'create' ? cancelSubmitWait : handleCreate}
              disabled={!!submitting && submitting.action !== 'create' || (!submitting && (!createUsernameValid || createForm.password.length < passwordMinLength))}
              className="w-full bg-blue-600 text-white rounded-[8px] py-3 text-sm font-bold shadow-lg shadow-blue-500/20 active:scale-95 transition-transform disabled:opacity-50"
            >
              {submitting?.action === 'create' ? '取消等待' : '创建'}
            </button>
          )}
        >
            <div className="space-y-4">
              <div className="space-y-1">
                <label htmlFor="user-create-username" className={labelClass}>用户名</label>
                <input
                  ref={createUsernameRef}
                  id="user-create-username"
                  type="text" value={createForm.username}
                  disabled={!!submitting}
                  onChange={e => setCreateForm(prev => ({ ...prev, username: e.target.value }))}
                  placeholder="请输入用户名"
                  minLength={2}
                  maxLength={64}
                  aria-invalid={createUsernameInvalid}
                  aria-describedby="user-create-username-help"
                  className={`${inputClass} ${createUsernameInvalid ? 'border-red-300 focus:border-red-400 focus:ring-red-100 dark:border-red-400/40' : ''}`}
                />
                <p id="user-create-username-help" className={`text-xs leading-5 ${createUsernameInvalid ? 'font-semibold text-red-600 dark:text-red-300' : 'text-slate-400 dark:text-slate-500'}`}>{createUsernameHasInvalidCharacters ? '用户名不能包含空格或控制字符。' : '至少 2 个字符，不可包含空格。'}</p>
              </div>
              <div className="space-y-1">
                <label htmlFor="user-create-nickname" className={labelClass}>昵称</label>
                <input
                  id="user-create-nickname"
                  type="text" value={createForm.nickname}
                  disabled={!!submitting}
                  onChange={e => setCreateForm(prev => ({ ...prev, nickname: e.target.value }))}
                  placeholder="请输入昵称" maxLength={64} className={inputClass}
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="user-create-password" className={labelClass}>密码</label>
                <input
                  id="user-create-password"
                  type="password" value={createForm.password}
                  autoComplete="new-password"
                  disabled={!!submitting}
                  onChange={e => setCreateForm(prev => ({ ...prev, password: e.target.value }))}
                  placeholder="请输入密码"
                  minLength={passwordMinLength}
                  maxLength={128}
                  aria-invalid={createPasswordInvalid}
                  aria-describedby="user-create-password-help"
                  className={`${inputClass} ${createPasswordInvalid ? 'border-red-300 focus:border-red-400 focus:ring-red-100 dark:border-red-400/40' : ''}`}
                />
                <p id="user-create-password-help" className={`text-xs leading-5 ${createPasswordInvalid ? 'font-semibold text-red-600 dark:text-red-300' : 'text-slate-400 dark:text-slate-500'}`}>至少 {passwordMinLength} 位，提交后不会在页面或审计记录中显示。</p>
              </div>
              <div className="space-y-1">
                <label className={labelClass}>角色</label>
                <UnifiedSelect
                  ariaLabel="用户角色"
                  value={createForm.role}
                  disabled={!!submitting}
                  className="[&>button]:rounded-[8px]"
                  options={[
                    { value: 'user', label: '普通用户' },
                    { value: 'admin', label: '管理员' },
                  ]}
                  onChange={(nextValue) => setCreateForm(prev => ({ ...prev, role: nextValue as UserRole }))}
                />
              </div>
            </div>
        </AppDialog>
      )}

      {/* ═══ Edit User Modal ═══ */}
      {modal === 'edit' && selectedUser && (
        <AppDialog
          title="编辑用户"
          onClose={closeModal}
          maxWidth="max-w-md"
          initialFocusRef={editNicknameRef}
          closeOnOverlay={submitting?.action !== 'edit'}
          showClose={submitting?.action !== 'edit'}
          footer={(
            <button
              onClick={submitting?.action === 'edit' ? cancelSubmitWait : handleEdit}
              disabled={!!submitting && submitting.action !== 'edit'}
              className="w-full bg-blue-600 text-white rounded-[8px] py-3 text-sm font-bold shadow-lg shadow-blue-500/20 active:scale-95 transition-transform disabled:opacity-50"
            >
              {submitting?.action === 'edit' ? '取消等待' : '保存'}
            </button>
          )}
        >
            <div className="space-y-4">
              {/* Username (read-only) */}
              <div className="space-y-1">
                <label htmlFor="user-edit-username" className={labelClass}>用户名</label>
                <input
                  id="user-edit-username"
                  type="text" value={selectedUser.username} readOnly
                  className={`${inputClass} opacity-50 cursor-not-allowed`}
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="user-edit-nickname" className={labelClass}>昵称</label>
                <input
                  ref={editNicknameRef}
                  id="user-edit-nickname"
                  type="text" value={editForm.nickname}
                  disabled={!!submitting}
                  onChange={e => setEditForm(prev => ({ ...prev, nickname: e.target.value }))}
                  placeholder="请输入昵称" maxLength={64} className={inputClass}
                />
              </div>
              <div className="space-y-1">
                <label className={labelClass}>角色</label>
                <UnifiedSelect
                  ariaLabel="用户角色"
                  value={editForm.role}
                  className="[&>button]:rounded-[8px]"
                  disabled={selectedAdminAccessLocked || !!submitting}
                  options={[
                    { value: 'user', label: '普通用户' },
                    { value: 'admin', label: '管理员' },
                  ]}
                  onChange={(nextValue) => setEditForm(prev => ({ ...prev, role: nextValue as UserRole }))}
                />
                {selectedAdminAccessLocked && (
                  <p className="text-xs leading-5 text-amber-600 dark:text-amber-300">{selectedAdminLockReason}</p>
                )}
              </div>
              <div className="space-y-1">
                <label className={labelClass}>状态</label>
                {selectedAdminAccessLocked ? (
                  <div className="flex items-center gap-2 rounded-[8px] bg-slate-50 px-4 py-3 dark:bg-white/[0.06]">
                    <span className={`w-2 h-2 rounded-full ${selectedUser.is_active ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'}`} />
                    <span className="text-sm font-medium text-slate-500 dark:text-slate-400">{selectedUser.is_active ? '启用' : '禁用'}</span>
                    <span className="ml-auto text-right text-xs text-slate-400 dark:text-slate-500">{selectedIsCurrentUser ? '当前账号不可禁用' : selectedAdminCountUnconfirmed ? '正在确认管理员数量' : '最后一位启用管理员'}</span>
                  </div>
                ) : (
                <div className="flex gap-3">
                  <button
                    onClick={() => setEditForm(prev => ({ ...prev, is_active: true }))}
                    disabled={!!submitting}
                    className={`flex-1 rounded-[8px] py-3 text-sm font-bold transition-colors ${
                      editForm.is_active
                        ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-500/20'
                        : 'bg-slate-50 dark:bg-white/[0.06] text-slate-500 dark:text-slate-400'
                    }`}
                  >
                    启用
                  </button>
                  <button
                    onClick={() => setEditForm(prev => ({ ...prev, is_active: false }))}
                    disabled={!!submitting}
                    className={`flex-1 rounded-[8px] py-3 text-sm font-bold transition-colors ${
                      !editForm.is_active
                        ? 'bg-red-500 text-white shadow-lg shadow-red-500/20'
                        : 'bg-slate-50 dark:bg-white/[0.06] text-slate-500 dark:text-slate-400'
                    }`}
                  >
                    禁用
                  </button>
                </div>
                )}
              </div>
            </div>
        </AppDialog>
      )}

      {/* ═══ Reset Password Modal ═══ */}
      {modal === 'reset' && selectedUser && (
        <AppDialog
          title="重置密码"
          onClose={closeModal}
          maxWidth="max-w-md"
          initialFocusRef={resetPasswordRef}
          closeOnOverlay={submitting?.action !== 'reset'}
          showClose={submitting?.action !== 'reset'}
          footer={(
            <button
              onClick={submitting?.action === 'reset' ? cancelSubmitWait : handleResetPassword}
              disabled={!!submitting && submitting.action !== 'reset' || (!submitting && resetPassword.length < passwordMinLength)}
              className="w-full bg-amber-500 text-white rounded-[8px] py-3 text-sm font-bold shadow-lg shadow-amber-500/20 active:scale-95 transition-transform disabled:opacity-50"
            >
              {submitting?.action === 'reset' ? '取消等待' : '确认重置'}
            </button>
          )}
        >
          <div className="space-y-6">
            <div className="rounded-[8px] bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-700 dark:bg-amber-500/10 dark:text-amber-200">
              正在为 {selectedUser.username} 重置密码。后端审计只记录操作对象和结果，不记录新密码或密码哈希。
            </div>
            <div className="space-y-1">
              <label htmlFor="user-reset-password" className={labelClass}>新密码</label>
              <input
                ref={resetPasswordRef}
                id="user-reset-password"
                type="password"
                autoComplete="new-password"
                disabled={!!submitting}
                value={resetPassword}
                onChange={e => setResetPassword(e.target.value)}
                placeholder="请输入符合系统策略的新密码"
                minLength={passwordMinLength}
                maxLength={128}
                aria-invalid={resetPasswordInvalid}
                aria-describedby="user-reset-password-help"
                className={`${inputClass} ${resetPasswordInvalid ? 'border-red-300 focus:border-red-400 focus:ring-red-100 dark:border-red-400/40' : ''}`}
              />
              <p id="user-reset-password-help" className={`text-xs leading-5 ${resetPasswordInvalid ? 'font-semibold text-red-600 dark:text-red-300' : 'text-slate-400 dark:text-slate-500'}`}>至少 {passwordMinLength} 位；提交后不会在页面或审计记录中显示。</p>
            </div>
          </div>
        </AppDialog>
      )}

      {/* ═══ Delete Confirm Modal ═══ */}
      {modal === 'delete' && selectedUser && (
        <AppDialog
          title="确认删除"
          onClose={closeModal}
          maxWidth="max-w-sm"
          danger
          initialFocusRef={deleteCancelRef}
          closeOnOverlay={submitting?.action !== 'delete'}
          showClose={submitting?.action !== 'delete'}
          footer={(
            <div className="flex gap-3">
              <button ref={deleteCancelRef} onClick={submitting?.action === 'delete' ? cancelSubmitWait : closeModal} disabled={!!submitting && submitting.action !== 'delete'} className="flex-1 py-3 border border-slate-200 dark:border-white/[0.08] rounded-[8px] text-sm font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-white/[0.04] transition-colors disabled:cursor-wait disabled:opacity-50">
                {submitting?.action === 'delete' ? '取消等待' : '取消'}
              </button>
              {submitting?.action !== 'delete' ? (
                <button onClick={handleDelete} disabled={!!submitting} className="flex-1 py-3 bg-red-500 text-white rounded-[8px] text-sm font-bold shadow-lg shadow-red-500/20 active:scale-95 transition-transform disabled:cursor-wait disabled:opacity-50">
                  删除
                </button>
              ) : null}
            </div>
          )}
        >
          <div className="space-y-5 text-center">
            <div className="w-16 h-16 bg-red-50 dark:bg-red-500/10 rounded-full flex items-center justify-center mx-auto">
              <Trash2 size={28} className="text-red-500" />
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-400">确定要删除用户 {selectedUser.username} 吗？此操作不可撤销。</p>
            {submitting?.action === 'delete' ? (
              <p className="text-left text-xs font-medium leading-5 text-amber-700 dark:text-amber-300">
                删除请求已发送。取消等待只会停止当前页面等待，不会撤销服务端可能已经完成的删除；页面随后会重新读取用户、统计和审计记录。
              </p>
            ) : null}
          </div>
        </AppDialog>
      )}
    </div>
  )
}

export default function UsersPage() {
  return (
    <Suspense fallback={<div className="flex min-h-[50vh] items-center justify-center text-sm font-bold text-slate-400">正在读取用户数据...</div>}>
      <UsersContent />
    </Suspense>
  )
}
