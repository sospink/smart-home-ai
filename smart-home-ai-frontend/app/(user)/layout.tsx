'use client'

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'
import Navbar from '@/components/home/Navbar'
import { useTheme } from '@/lib/theme'

export default function UserLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const { setTheme } = useTheme()

  useEffect(() => {
    setTheme('light', { persist: false })
  }, [setTheme])

  /* ── Docs page has its own full layout — bypass user chrome ── */
  if (pathname.startsWith('/docs')) {
    return <>{children}</>
  }

  /* ── Home page uses its own page-level layout (hero, etc.) ── */
  if (pathname.startsWith('/home')) {
    return (
      <>
        <Navbar />
        {children}
      </>
    )
  }

  return (
    <div style={{ minHeight: '100vh', background: 'hsl(var(--background))', transition: 'background 0.25s ease' }}>
      {/* ═══ Shared morphing Navbar (includes login/avatar/workspace entry) ═══ */}
      <Navbar />

      {/* ═══ Main content below navbar ═══ */}
      <main style={{ paddingTop: 56 }}>
        {children}
      </main>
    </div>
  )
}
