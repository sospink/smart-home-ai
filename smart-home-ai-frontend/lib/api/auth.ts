/**
 * 认证 API
 */
import { apiClient } from '@/lib/api/client'
import type { LoginRequest, TokenResponse, User } from '@/types/api'

export const authApi = {
  login: (data: LoginRequest, signal?: AbortSignal) =>
    apiClient.post<TokenResponse>('/auth/login', data, { redirectOnUnauthorized: false, timeoutMs: 15_000, signal }),

  register: (data: LoginRequest & { nickname?: string }, signal?: AbortSignal) =>
    apiClient.post<User>('/auth/register', data, { redirectOnUnauthorized: false, timeoutMs: 20_000, signal }),

  getMe: (signal?: AbortSignal) =>
    apiClient.get<User>('/auth/me', { redirectOnUnauthorized: false, timeoutMs: 15_000, signal }),

  getPublicConfig: (signal?: AbortSignal) =>
    apiClient.get<{ allow_registration: boolean; password_min_length: number; jwt_expire_hours: number }>('/auth/public-config', { redirectOnUnauthorized: false, timeoutMs: 15_000, signal }),

  changePassword: (oldPassword: string, newPassword: string, signal?: AbortSignal) =>
    apiClient.put<{ success: boolean; message: string }>('/auth/password', {
      old_password: oldPassword,
      new_password: newPassword,
    }, { timeoutMs: 20_000, signal }),
}
