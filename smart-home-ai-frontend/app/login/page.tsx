'use client'

/**
 * /login 路由 — 不再是独立登录页面
 * 重定向到首页并自动弹出登录弹窗
 */

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { safeNextPath } from '@/lib/navigation/safe-next-path'

export default function LoginRedirect() {
  const router = useRouter()
  useEffect(() => {
    const source = new URL(window.location.href)
    const target = new URL('/home', window.location.origin)
    target.searchParams.set('login', '1')
    const requestedNext = source.searchParams.get('next')
    if (requestedNext) target.searchParams.set('next', safeNextPath(requestedNext))
    router.replace(`${target.pathname}${target.search}`)
  }, [router])

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 text-sm text-slate-500">
      正在打开登录窗口…
    </main>
  )
}
