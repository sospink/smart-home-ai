/**
 * 认证状态 Hook
 */
'use client'
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { AUTH_STORAGE_EVENT, getToken, setToken, clearToken } from '@/lib/auth-storage'
import { authApi } from '@/lib/api/auth'
import { ApiError } from '@/lib/api/client'
import { businessErrorMessage } from '@/lib/ui/business-error'

interface AuthUser {
  user_id: number
  role: 'user' | 'admin'
  username: string
}

type AuthState = {
  user: AuthUser | null
  loading: boolean
  error: string
}

let authState: AuthState = { user: null, loading: true, error: '' }
const serverAuthState: AuthState = { user: null, loading: true, error: '' }
let verifiedToken: string | null | undefined
let pendingToken: string | null = null
let pendingSynchronization: Promise<void> | null = null
let authGeneration = 0
const authListeners = new Set<(state: AuthState) => void>()

function subscribeAuth(listener: () => void) {
  const wrapped = () => listener()
  authListeners.add(wrapped)
  return () => { authListeners.delete(wrapped) }
}

function publishAuthState(next: AuthState) {
  authState = next
  authListeners.forEach((listener) => listener(authState))
}

function synchronizeAuth(): Promise<void> {
  const token = getToken()
  if (token === verifiedToken && !authState.loading) return Promise.resolve()
  if (pendingSynchronization && token === pendingToken) return pendingSynchronization

  const generation = ++authGeneration
  if (!token) {
    verifiedToken = null
    pendingToken = null
    publishAuthState({ user: null, loading: false, error: '' })
    return Promise.resolve()
  }

  pendingToken = token
  publishAuthState({
    user: verifiedToken === token ? authState.user : null,
    loading: true,
    error: '',
  })
  const request = authApi.getMe()
    .then((current) => {
      if (generation !== authGeneration || getToken() !== token) return
      // Middleware 只能读取 cookie；本地持久 token 校验成功后同步一次，避免后台路由反复跳回登录入口。
      setToken(token, { notify: false, reason: 'refresh' })
      verifiedToken = token
      publishAuthState({
        user: { user_id: current.id, role: current.role, username: current.username },
        loading: false,
        error: '',
      })
    })
    .catch((error) => {
      if (generation !== authGeneration) return
      if (error instanceof ApiError && [401, 403].includes(error.status)) {
        clearToken({ reason: 'unauthorized' })
        verifiedToken = null
        publishAuthState({ user: null, loading: false, error: '登录已过期，请重新登录' })
      } else {
        if (getToken() !== token) return
        verifiedToken = undefined
        publishAuthState({
          user: null,
          loading: false,
          error: businessErrorMessage(error, { fallback: '身份校验失败，请检查平台服务后重试', service: '身份校验' }),
        })
      }
    })
    .finally(() => {
      if (pendingSynchronization === request) {
        pendingSynchronization = null
        pendingToken = null
      }
    })
  pendingSynchronization = request
  return request
}

function retryAuthSynchronization(): Promise<void> {
  verifiedToken = undefined
  return synchronizeAuth()
}

export function useAuth() {
  const state = useSyncExternalStore(
    subscribeAuth,
    () => authState,
    () => serverAuthState,
  )

  useEffect(() => {
    void synchronizeAuth()

    const synchronizeAfterTokenChange = () => {
      verifiedToken = undefined
      void synchronizeAuth()
    }
    const retryTransientFailure = () => {
      if (!authState.error || authState.loading || !getToken()) return
      verifiedToken = undefined
      void synchronizeAuth()
    }
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') retryTransientFailure()
    }

    window.addEventListener(AUTH_STORAGE_EVENT, synchronizeAfterTokenChange)
    window.addEventListener('storage', synchronizeAfterTokenChange)
    window.addEventListener('online', retryTransientFailure)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.removeEventListener(AUTH_STORAGE_EVENT, synchronizeAfterTokenChange)
      window.removeEventListener('storage', synchronizeAfterTokenChange)
      window.removeEventListener('online', retryTransientFailure)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [])

  const login = useCallback(async (username: string, password: string, signal?: AbortSignal) => {
    const res = await authApi.login({ username, password }, signal)
    setToken(res.access_token, { notify: false, reason: 'login' })
    const generation = ++authGeneration
    verifiedToken = undefined
    publishAuthState({ user: null, loading: true, error: '' })
    try {
      const current = await authApi.getMe(signal)
      const authenticated = { user_id: current.id, role: current.role, username: current.username } as AuthUser
      if (generation === authGeneration) {
        verifiedToken = res.access_token
        publishAuthState({ user: authenticated, loading: false, error: '' })
      }
      return authenticated
    } catch (error) {
      if (generation === authGeneration && getToken() === res.access_token) {
        clearToken({ notify: false, reason: 'unauthorized' })
        verifiedToken = null
        publishAuthState({ user: null, loading: false, error: '' })
      }
      throw error
    }
  }, [])

  const logout = useCallback(() => {
    authGeneration += 1
    clearToken({ notify: false, reason: 'logout' })
    verifiedToken = null
    pendingToken = null
    // 直接离开后台，避免向尚未卸载的业务页广播匿名中间态并触发一轮无凭证请求。
    authState = { user: null, loading: false, error: '' }
    window.location.replace('/home')
  }, [])

  return {
    user: state.user,
    loading: state.loading,
    login,
    logout,
    error: state.error,
    retry: retryAuthSynchronization,
    isAdmin: state.user?.role === 'admin',
    isLoggedIn: !!state.user,
  }
}
