'use client'

/**
 * 登录弹窗组件 — 可在任何页面通过 <LoginDialog> 使用
 * 遵循 auth-dialog.md 设计规范：双层 backdrop + scrim + slide-up 动画
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { Eye, EyeOff, RefreshCw } from 'lucide-react'
import { useAuth } from '@/lib/hooks/useAuth'
import { useDialogLock } from '@/lib/hooks/useDialogLock'
import { authApi } from '@/lib/api/auth'
import { businessErrorMessage } from '@/lib/ui/business-error'

interface LoginDialogProps {
  open: boolean
  onClose: () => void
  /** 登录成功后回调，返回用户角色。不传则默认按角色跳转 */
  onSuccess?: (role: 'user' | 'admin') => void
}

export default function LoginDialog({ open, onClose, onSuccess }: LoginDialogProps) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirmation, setPasswordConfirmation] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [isRegister, setIsRegister] = useState(false)
  const [allowRegistration, setAllowRegistration] = useState(false)
  const [passwordMinLength, setPasswordMinLength] = useState(6)
  const [configLoading, setConfigLoading] = useState(false)
  const [configError, setConfigError] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [hovSubmit, setHovSubmit] = useState(false)
  const [pressSubmit, setPressSubmit] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const usernameRef = useRef<HTMLInputElement>(null)
  const submitInFlightRef = useRef(false)
  const submitControllerRef = useRef<AbortController | null>(null)
  const configControllerRef = useRef<AbortController | null>(null)
  const submitRequestRef = useRef(0)
  const configRequestRef = useRef(0)
  const openerRef = useRef<HTMLElement | null>(null)
  const { login } = useAuth()

  useDialogLock(open)

  useEffect(() => () => {
    submitRequestRef.current += 1
    submitControllerRef.current?.abort()
    submitControllerRef.current = null
    configRequestRef.current += 1
    configControllerRef.current?.abort()
    configControllerRef.current = null
    submitInFlightRef.current = false
  }, [])

  const loadPublicConfig = useCallback(async () => {
    configControllerRef.current?.abort()
    const controller = new AbortController()
    configControllerRef.current = controller
    const requestId = ++configRequestRef.current
    setConfigLoading(true)
    setConfigError('')
    try {
      const data = await authApi.getPublicConfig(controller.signal)
      if (configRequestRef.current !== requestId) return
      setAllowRegistration(!!data.allow_registration)
      setPasswordMinLength(Number(data.password_min_length || 6))
    } catch (loadError) {
      if (configRequestRef.current !== requestId || controller.signal.aborted) return
      setAllowRegistration(false)
      setConfigError(businessErrorMessage(loadError, { fallback: '账号策略读取失败，请稍后重试', service: '账号策略' }))
    } finally {
      if (configRequestRef.current === requestId) {
        configControllerRef.current = null
        setConfigLoading(false)
      }
    }
  }, [])

  // Reset on open
  useEffect(() => {
    if (open) {
      configControllerRef.current?.abort()
      configControllerRef.current = null
      configRequestRef.current += 1
      submitControllerRef.current?.abort()
      submitControllerRef.current = null
      submitRequestRef.current += 1
      openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setUsername(''); setPassword(''); setPasswordConfirmation(''); setError('')
      setIsRegister(false); setLoading(false); setShowPassword(false)
      submitInFlightRef.current = false
      void loadPublicConfig()
      const frame = requestAnimationFrame(() => usernameRef.current?.focus())
      return () => cancelAnimationFrame(frame)
    }
    submitControllerRef.current?.abort()
    submitControllerRef.current = null
    submitRequestRef.current += 1
    submitInFlightRef.current = false
    configControllerRef.current?.abort()
    configControllerRef.current = null
    configRequestRef.current += 1
    openerRef.current?.focus()
    openerRef.current = null
  }, [open, loadPublicConfig])

  useEffect(() => {
    if (!open || !configError) return
    const recoverPublicConfig = () => {
      if (!navigator.onLine || document.visibilityState !== 'visible' || configLoading || loading) return
      void loadPublicConfig()
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') recoverPublicConfig()
    }
    window.addEventListener('online', recoverPublicConfig)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('online', recoverPublicConfig)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [configError, configLoading, loadPublicConfig, loading, open])

  // 锁定弹窗焦点；提交期间不能通过 Escape 关闭并丢失执行反馈。
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!submitInFlightRef.current) onClose()
        return
      }
      if (e.key !== 'Tab') return
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ) || [])
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handler)
    return () => {
      document.removeEventListener('keydown', handler)
    }
  }, [open, onClose])

  const cancelSubmitWait = useCallback(() => {
    if (!submitInFlightRef.current) return
    const wasRegister = isRegister
    submitRequestRef.current += 1
    submitControllerRef.current?.abort()
    submitControllerRef.current = null
    submitInFlightRef.current = false
    setLoading(false)
    setPassword('')
    setPasswordConfirmation('')
    setError(wasRegister
      ? '已取消等待；注册请求可能已经完成，请先尝试登录或联系管理员核对账号。'
      : '已取消登录等待，密码已清空，可重新输入后再试。')
    requestAnimationFrame(() => usernameRef.current?.focus())
  }, [isRegister])

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (submitInFlightRef.current) return
    setError('')
    const normalizedUsername = username.trim()
    if (normalizedUsername.length < 2) {
      setError('用户名至少需要 2 个字符。')
      return
    }
    if (/\s|[\u0000-\u001f\u007f]/u.test(normalizedUsername)) {
      setError('用户名不能包含空格或控制字符。')
      return
    }
    if (isRegister && password !== passwordConfirmation) {
      setError('两次输入的密码不一致。')
      return
    }
    const requestId = ++submitRequestRef.current
    const controller = new AbortController()
    submitControllerRef.current = controller
    submitInFlightRef.current = true
    setLoading(true)
    try {
      if (isRegister) {
        if (!allowRegistration) {
          throw new Error('当前系统已关闭公开注册，请联系管理员')
        }
        await authApi.register({ username: normalizedUsername, password, nickname: normalizedUsername }, controller.signal)
      }
      const user = await login(normalizedUsername, password, controller.signal)
      if (submitRequestRef.current !== requestId) return
      if (onSuccess && user) {
        onSuccess(user.role)
      } else if (user) {
        window.location.href = '/dashboard'
      }
      onClose()
    } catch (err: unknown) {
      if (submitRequestRef.current !== requestId || (err instanceof DOMException && err.name === 'AbortError')) return
      setError(businessErrorMessage(err, {
        fallback: isRegister ? '注册失败，请检查账号信息后重试' : '登录失败，请检查账号信息后重试',
        service: isRegister ? '账号注册' : '平台登录',
      }))
    } finally {
      if (submitRequestRef.current === requestId) {
        submitControllerRef.current = null
        submitInFlightRef.current = false
        setLoading(false)
      }
    }
  }, [username, password, passwordConfirmation, isRegister, login, onSuccess, onClose, allowRegistration])

  if (!open) return null

  const scale = loading ? 1 : pressSubmit ? 0.96 : hovSubmit ? 1.03 : 1
  const canSubmit = username.trim().length >= 2
    && password.length >= (isRegister ? passwordMinLength : 4)
    && (!isRegister || passwordConfirmation.length >= passwordMinLength)

  return (
    <>
      {/* ── Blur backdrop ── */}
      <div style={{
        position: 'fixed', inset: 0,
        backdropFilter: 'blur(3px)',
        transition: 'backdrop-filter 100ms ease',
        zIndex: 1000, pointerEvents: 'none',
      }} />

      {/* ── Scrim + centering ── */}
      <div
        onClick={e => { if (e.target === e.currentTarget && !submitInFlightRef.current) onClose() }}
        style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(4, 2, 23, 0.32)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          animation: 'scrimFadeIn 0.18s ease both',
        }}
      >
        {/* ── Dialog box ── */}
        <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="login-dialog-title" style={{
          position: 'relative', width: 'min(380px, calc(100vw - 32px))',
          maxHeight: 'calc(100dvh - 32px)',
          background: 'hsl(var(--card))',
          borderRadius: 24,
          boxShadow: 'rgba(55, 65, 81, 0.15) 0px 8px 36px 0px',
          overflowX: 'hidden', overflowY: 'auto',
          animation: 'dialogSlideUp 0.22s cubic-bezier(0.25, 0.8, 0.25, 1) both',
          zIndex: 1001,
        }}>
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            textAlign: 'center', fontSize: 14, lineHeight: '20px',
            padding: '0 28px 24px',
          }}>

            {/* Logo */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              margin: '32px 0 20px',
              fontFamily: "var(--font-heading)",
              fontSize: 18, fontWeight: 500,
              color: 'hsl(var(--foreground))',
              lineHeight: '28px',
            }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <rect x="3" y="3" width="18" height="18" rx="4" stroke="rgba(13,89,242,0.75)" strokeWidth="1.8"/>
                <path d="M8 8h3l1 3 1-3h3" stroke="rgba(13,89,242,0.75)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M8 13h8M8 16h5" stroke="rgba(13,89,242,0.75)" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
              <span style={{ textAlign: 'left' }}>
                智慧家居智能体科研一体机
              </span>
            </div>

            {/* Heading */}
            <p id="login-dialog-title" style={{
              fontSize: 18, fontWeight: 500,
              color: 'hsl(var(--foreground))',
              marginBottom: 24,
              fontFamily: 'var(--font-body)',
            }}>
              {isRegister ? '创建系统账号' : '登录管理后台'}
            </p>

            <form onSubmit={handleSubmit} style={{ width: '100%' }}>
              {/* Error */}
              {error && (
                <div style={{
                  background: 'hsl(0 80% 96%)',
                  color: 'var(--color-error)',
                  padding: '8px 14px', borderRadius: 10,
                  fontSize: 13, marginBottom: 12, textAlign: 'left',
                }}>{error}</div>
              )}

              {/* Username field */}
              <div style={{ position: 'relative', width: '100%', marginBottom: 10 }}>
                <span style={{
                  position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: 28, height: 28,
                  background: 'hsl(237, 100%, 96%)',
                  borderRadius: 8,
                  color: 'hsl(237, 100%, 70%)',
                  pointerEvents: 'none',
                }}>
                  <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
                    <circle cx="10" cy="7" r="4" stroke="currentColor" strokeWidth="1.6"/>
                    <path d="M3 18c0-3.3 2.7-6 7-6s7 2.7 7 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
                  </svg>
                </span>
                <input
                  type="text"
                  aria-label="用户名"
                  autoComplete={isRegister ? 'username' : 'username'}
                  placeholder="请输入用户名"
                  value={username}
                  onChange={e => { setUsername(e.target.value); setError('') }}
                  maxLength={64}
                  required
                  ref={usernameRef}
                  disabled={loading}
                  style={{
                    width: '100%', height: 52,
                    background: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: 12,
                    padding: '12px 16px 12px 52px',
                    fontSize: 14, color: 'hsl(var(--foreground))',
                    fontFamily: 'inherit', outline: 'none',
                    transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
                  }}
                  onFocus={e => {
                    e.target.style.borderColor = 'hsl(var(--button-primary))'
                    e.target.style.boxShadow = '0 0 0 3px hsl(var(--button-primary) / 0.12)'
                  }}
                  onBlur={e => {
                    e.target.style.borderColor = 'hsl(var(--border))'
                    e.target.style.boxShadow = 'none'
                  }}
                />
              </div>

              {/* Password field */}
              <div style={{ position: 'relative', width: '100%', marginBottom: 16 }}>
                <span style={{
                  position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: 28, height: 28,
                  background: 'hsl(237, 100%, 96%)',
                  borderRadius: 8,
                  color: 'hsl(237, 100%, 70%)',
                  pointerEvents: 'none',
                }}>
                  <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
                    <rect x="4" y="9" width="12" height="9" rx="2" stroke="currentColor" strokeWidth="1.6"/>
                    <path d="M7 9V6a3 3 0 016 0v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
                    <circle cx="10" cy="13.5" r="1.5" fill="currentColor"/>
                  </svg>
                </span>
                <input
                  type={showPassword ? 'text' : 'password'}
                  aria-label="密码"
                  autoComplete={isRegister ? 'new-password' : 'current-password'}
                  placeholder="请输入密码"
                  value={password}
                  onChange={e => { setPassword(e.target.value); setError('') }}
                  required
                  disabled={loading}
                  style={{
                    width: '100%', height: 52,
                    background: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: 12,
                    padding: '12px 48px 12px 52px',
                    fontSize: 14, color: 'hsl(var(--foreground))',
                    fontFamily: 'inherit', outline: 'none',
                    transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
                  }}
                  onFocus={e => {
                    e.target.style.borderColor = 'hsl(var(--button-primary))'
                    e.target.style.boxShadow = '0 0 0 3px hsl(var(--button-primary) / 0.12)'
                  }}
                  onBlur={e => {
                    e.target.style.borderColor = 'hsl(var(--border))'
                    e.target.style.boxShadow = 'none'
                  }}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((visible) => !visible)}
                  disabled={loading}
                  aria-label={showPassword ? '隐藏密码' : '显示密码'}
                  title={showPassword ? '隐藏密码' : '显示密码'}
                  style={{
                    position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
                    display: 'flex', width: 32, height: 32, alignItems: 'center', justifyContent: 'center',
                    border: 'none', borderRadius: 8, background: 'transparent',
                    color: 'hsl(var(--muted-foreground))', cursor: loading ? 'not-allowed' : 'pointer',
                  }}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>

              {isRegister ? (
                <div style={{ position: 'relative', width: '100%', marginBottom: 16 }}>
                  <span style={{
                    position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    width: 28, height: 28, background: 'hsl(237, 100%, 96%)', borderRadius: 8,
                    color: 'hsl(237, 100%, 70%)', pointerEvents: 'none',
                  }}>
                    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                      <rect x="4" y="9" width="12" height="9" rx="2" stroke="currentColor" strokeWidth="1.6" />
                      <path d="M7 9V6a3 3 0 016 0v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                    </svg>
                  </span>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    aria-label="确认密码"
                    autoComplete="new-password"
                    placeholder="请再次输入密码"
                    value={passwordConfirmation}
                    onChange={(event) => { setPasswordConfirmation(event.target.value); setError('') }}
                    required
                    disabled={loading}
                    style={{
                      width: '100%', height: 52, background: 'hsl(var(--card))',
                      border: '1px solid hsl(var(--border))', borderRadius: 12,
                      padding: '12px 48px 12px 52px', fontSize: 14,
                      color: 'hsl(var(--foreground))', fontFamily: 'inherit', outline: 'none',
                      transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
                    }}
                    onFocus={(event) => {
                      event.target.style.borderColor = 'hsl(var(--button-primary))'
                      event.target.style.boxShadow = '0 0 0 3px hsl(var(--button-primary) / 0.12)'
                    }}
                    onBlur={(event) => {
                      event.target.style.borderColor = 'hsl(var(--border))'
                      event.target.style.boxShadow = 'none'
                    }}
                  />
                </div>
              ) : null}

              {/* Submit — CobaltBtn */}
              <div
                className="liquid-glass-wrapper liquid-glass-pill liquid-glass-cobalt liquid-glass-blur-minimal"
                style={{
                  cursor: loading || canSubmit ? 'pointer' : 'not-allowed',
                  transition: 'transform 0.38s cubic-bezier(0.34,1.56,0.64,1)',
                  transform: `scale(${scale})`,
                  opacity: loading || canSubmit ? 1 : 0.55,
                  width: '100%',
                }}
              >
                <div className="liquid-glass-visual-layers">
                  <div className="liquid-glass-effect"></div>
                  <div className="liquid-glass-tint"></div>
                  <div className="liquid-glass-shine"></div>
                </div>
                <div className="liquid-glass-content">
                  <button
                    type={loading ? 'button' : 'submit'}
                    disabled={!loading && !canSubmit}
                    onClick={loading ? cancelSubmitWait : undefined}
                    onMouseEnter={() => setHovSubmit(true)}
                    onMouseLeave={() => { setHovSubmit(false); setPressSubmit(false) }}
                    onMouseDown={() => setPressSubmit(true)}
                    onMouseUp={() => setPressSubmit(false)}
                    style={{
                      background: 'transparent', border: 'none',
                      cursor: loading || canSubmit ? 'pointer' : 'not-allowed',
                      padding: '11px 20px', width: '100%',
                      fontSize: 14, fontWeight: 500, color: '#fff',
                      letterSpacing: '0.01em', whiteSpace: 'nowrap',
                      fontFamily: 'inherit',
                    }}
                  >
                    {loading ? '取消等待' : isRegister ? '注 册' : '登 录'}
                  </button>
                </div>
              </div>
            </form>

            {/* Toggle register/login link */}
            {allowRegistration ? (
              <button
                type="button"
                disabled={loading}
                onClick={() => { setIsRegister(!isRegister); setError(''); setPassword(''); setPasswordConfirmation('') }}
                style={{
                  marginTop: 18, fontSize: 14, fontWeight: 400,
                  color: 'hsl(var(--button-primary))',
                  background: 'none', border: 'none',
                  cursor: 'pointer', fontFamily: 'inherit',
                  padding: 0, transition: 'opacity 0.15s ease',
                }}
                onMouseEnter={e => (e.currentTarget.style.opacity = '0.75')}
                onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
              >
                {isRegister ? '已有账号？去登录' : '没有账号？注册'}
              </button>
            ) : configLoading ? (
              <p style={{ marginTop: 18, fontSize: 13, color: 'hsl(var(--muted-foreground))' }}>
                正在读取账号策略…
              </p>
            ) : configError ? (
              <div style={{ marginTop: 18, display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'hsl(var(--muted-foreground))' }}>
                <span>注册策略暂时无法读取</span>
                <button type="button" onClick={() => void loadPublicConfig()} disabled={configLoading || loading} aria-label="重新读取注册策略" title="重新读取注册策略" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, border: '1px solid hsl(var(--border))', borderRadius: 8, background: 'transparent', color: 'inherit', cursor: 'pointer' }}>
                  <RefreshCw size={14} className={configLoading ? 'animate-spin' : ''} />
                </button>
              </div>
            ) : (
              <p style={{
                marginTop: 18,
                fontSize: 13,
                color: 'hsl(var(--muted-foreground))',
              }}>
                当前系统已关闭公开注册
              </p>
            )}

            {/* Legal */}
            <p style={{
              marginTop: 16, fontSize: 12,
              color: 'hsl(var(--muted-foreground))', lineHeight: 1.5,
            }}>
              基于智慧家居场景的大语言模型智能体科研应用平台
            </p>

            {/* Version */}
            <div style={{
              marginTop: 10, marginBottom: 4,
              fontSize: 12, color: 'hsl(var(--muted-foreground))',
              display: 'flex', alignItems: 'center', gap: 5,
            }}>
              平台版本 v1.0.0
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
