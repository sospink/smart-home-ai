/**
 * 用户管理 API - 与后端 /api/v1/users 对齐
 */
import { apiClient } from '@/lib/api/client'
import { getAuthCacheScope } from '@/lib/auth-storage'
import { clearSystemOverviewCache } from '@/lib/api/system'
import { waitForSharedRead } from '@/lib/api/shared-read'
import type { UserDetail, UserListResponse, ActionResult } from '@/types/api'

export interface CreateUserPayload {
  username: string
  password: string
  nickname?: string
  role?: 'user' | 'admin'
}

export interface UpdateUserPayload {
  nickname?: string
  role?: 'user' | 'admin'
  is_active?: boolean
}

export interface UserStats {
  total: number
  active: number
  inactive: number
  new_this_week: number
  admin_count: number
  active_admin_count: number
}

export interface UserAuditItem {
  id: number
  action: 'create' | 'update' | 'delete' | 'reset_password' | 'toggle_active' | 'unknown' | string
  target_user_id: number | null
  target_username: string
  changed_fields: string[]
  level: string
  operator: string
  created_at: string | null
}

export interface UserAuditPage {
  items: UserAuditItem[]
  total: number
  page: number
  size: number
}

export interface UserListQuery {
  page?: number
  size?: number
  keyword?: string
  role?: string
  is_active?: string
}

export interface UserAuditQuery {
  page?: number
  size?: number
  keyword?: string
  action?: string
}

const USER_CACHE_TTL_MS = 30_000
const USER_READ_TIMEOUT_MS = 15_000
const USER_WRITE_TIMEOUT_MS = 20_000
const cache = new Map<string, { expiresAt: number; value: unknown }>()
const pending = new Map<string, Promise<unknown>>()
const generation = new Map<string, number>()

async function cachedRequest<T>(key: string, loader: () => Promise<T>, force = false, signal?: AbortSignal): Promise<T> {
  const scopedKey = `${getAuthCacheScope()}:${key}`
  const hit = cache.get(scopedKey)
  if (!force && hit && hit.expiresAt > Date.now()) return structuredClone(hit.value) as T
  const active = pending.get(scopedKey)
  if (!force && active) return structuredClone(await waitForSharedRead(active as Promise<T>, signal)) as T

  const requestGeneration = (generation.get(scopedKey) || 0) + 1
  generation.set(scopedKey, requestGeneration)
  const request = loader()
    .then((value) => {
      if (generation.get(scopedKey) === requestGeneration) {
        cache.set(scopedKey, { value, expiresAt: Date.now() + USER_CACHE_TTL_MS })
      }
      return value
    })
    .finally(() => {
      if (pending.get(scopedKey) === request) pending.delete(scopedKey)
    })
  pending.set(scopedKey, request)
  return structuredClone(await waitForSharedRead(request, signal)) as T
}

export function clearUsersCache() {
  const keys = new Set([...cache.keys(), ...pending.keys(), ...generation.keys()])
  keys.forEach((key) => generation.set(key, (generation.get(key) || 0) + 1))
  cache.clear()
  pending.clear()
}

function invalidateUserMutation() {
  clearUsersCache()
  clearSystemOverviewCache({ scopes: ['all', 'platform'], publicSummary: false })
}

function queryKey(prefix: string, query: object) {
  return `${prefix}:${JSON.stringify(query)}`
}

export const usersApi = {
  /** 分页获取用户列表 */
  list: (params: UserListQuery = {}, force = false, signal?: AbortSignal) => cachedRequest(
    queryKey('list', params),
    () => apiClient.get<UserListResponse>('/users', {
      params: params as Record<string, string | number | boolean>,
      timeoutMs: USER_READ_TIMEOUT_MS,
    }),
    force,
    signal,
  ),

  stats: (force = false, signal?: AbortSignal) => cachedRequest(
    'stats',
    () => apiClient.get<UserStats>('/users/stats', { timeoutMs: USER_READ_TIMEOUT_MS }),
    force,
    signal,
  ),

  audit: (params: UserAuditQuery = {}, force = false, signal?: AbortSignal) => cachedRequest(
    queryKey('audit', params),
    () => apiClient.get<UserAuditPage>('/users/audit', {
      params: params as Record<string, string | number | boolean>,
      timeoutMs: USER_READ_TIMEOUT_MS,
    }),
    force,
    signal,
  ),

  /** 用户详情 */
  get: (id: number) => apiClient.get<UserDetail>(`/users/${id}`, { timeoutMs: USER_READ_TIMEOUT_MS }),

  /** 创建用户 */
  create: async (data: CreateUserPayload, signal?: AbortSignal) => {
    try {
      return await apiClient.post<UserDetail>('/users', data, { timeoutMs: USER_WRITE_TIMEOUT_MS, signal })
    } finally {
      invalidateUserMutation()
    }
  },

  /** 更新用户信息 */
  update: async (id: number, data: UpdateUserPayload, signal?: AbortSignal) => {
    try {
      return await apiClient.put<UserDetail>(`/users/${id}`, data, { timeoutMs: USER_WRITE_TIMEOUT_MS, signal })
    } finally {
      invalidateUserMutation()
    }
  },

  /** 删除用户 */
  delete: async (id: number, signal?: AbortSignal) => {
    try {
      return await apiClient.delete<void>(`/users/${id}`, { timeoutMs: USER_WRITE_TIMEOUT_MS, signal })
    } finally {
      invalidateUserMutation()
    }
  },

  /** 重置密码 */
  resetPassword: async (id: number, newPassword: string, signal?: AbortSignal) => {
    try {
      return await apiClient.patch<ActionResult>(`/users/${id}/reset-password`, {
        new_password: newPassword,
      }, { timeoutMs: USER_WRITE_TIMEOUT_MS, signal })
    } finally {
      invalidateUserMutation()
    }
  },

  /** 启用/禁用切换 */
  toggleActive: async (id: number, signal?: AbortSignal) => {
    try {
      return await apiClient.patch<{ success: boolean; is_active: boolean }>(
        `/users/${id}/toggle-active`,
        undefined,
        { timeoutMs: USER_WRITE_TIMEOUT_MS, signal },
      )
    } finally {
      invalidateUserMutation()
    }
  },
}
