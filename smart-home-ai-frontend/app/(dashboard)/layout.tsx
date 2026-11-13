'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useAuth } from '@/lib/hooks/useAuth'
import { getToken, setToken } from '@/lib/auth-storage'
import { GlobalNavSearch } from '@/components/navigation/GlobalNavSearch'
import {
  LayoutDashboard, BookOpen, Cpu, Bot, Settings, MessageSquare,
  Lightbulb, Box, Activity, DownloadCloud,
  LogOut, Users, FileText,
  Bell, Ship, PanelLeftClose, PanelLeftOpen, ChevronDown, ChevronRight, PanelsTopLeft, History, House, AppWindow,
  SlidersHorizontal, BrainCircuit, Workflow, Network, LibraryBig, Database, Menu, X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { MotionConfig } from 'motion/react'

type NavItem = {
  icon: LucideIcon
  label: string
  href: string
  adminOnly?: boolean
}

type NavGroup = {
  id: 'system_overview' | 'model' | 'agent' | 'iot' | 'knowledge_docs'
  icon: LucideIcon
  label: string
  items: NavItem[]
}

const NAV_GROUPS: NavGroup[] = [
  {
    id: 'system_overview',
    icon: SlidersHorizontal,
    label: '系统总览与配置',
    items: [
      { icon: LayoutDashboard, label: '设备与系统状态查看', href: '/dashboard' },
      { icon: Settings,        label: '系统设置',  href: '/settings' },
      { icon: Activity,        label: '操作日志', href: '/activity-logs' },
      { icon: Users,           label: '用户管理',     href: '/users', adminOnly: true },
    ],
  },
  {
    id: 'model',
    icon: BrainCircuit,
    label: '本地大语言模型',
    items: [
      { icon: Cpu,             label: '开源大语言模型',    href: '/models' },
      { icon: DownloadCloud,   label: '模型拉取与验证', href: '/models/pulls' },
    ],
  },
  {
    id: 'agent',
    icon: Workflow,
    label: '智能体框架与应用',
    items: [
      { icon: Bot,             label: '智能体框架与应用',    href: '/agents' },
      { icon: LibraryBig,      label: '应用模板库', href: '/agents/templates' },
      { icon: MessageSquare,   label: '智能体对话',      href: '/chat' },
      { icon: History,         label: '会话与运行记录', href: '/conversation-records' },
      { icon: AppWindow,       label: 'Dify 平台', href: '/dify' },
      { icon: PanelsTopLeft,   label: '接口控制台', href: '/api-console', adminOnly: true },
    ],
  },
  {
    id: 'iot',
    icon: Network,
    label: '智能家居对接能力',
    items: [
      { icon: House,           label: 'Home Assistant', href: '/home-assistant' },
      { icon: Lightbulb,       label: '设备控制',   href: '/devices' },
      { icon: Activity,        label: '设备状态与系统监控',   href: '/monitor' },
      { icon: Database,        label: '时序数据', href: '/time-series' },
      { icon: Box,             label: '电子沙盘',   href: '/sandbox' },
    ],
  },
  {
    id: 'knowledge_docs',
    icon: LibraryBig,
    label: '知识增强',
    items: [
      { icon: BookOpen,        label: '知识库管理', href: '/knowledge' },
      { icon: FileText,        label: '帮助文档和教程', href: '/help-docs' },
      { icon: FileText,        label: '文档中心与 API 参考', href: '/docs' },
    ],
  },
]

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'sidebar-collapsed'

/* ── Sidebar nav item ── */
function SidebarItem({ icon: Icon, label, active, href, collapsed }: {
  icon: LucideIcon; label: string; active: boolean; href: string; collapsed: boolean
}) {
  const handleClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    const token = getToken()
    if (token) {
      setToken(token)
    }

    // Admin-only routes are guarded by middleware. Force a full navigation
    // after syncing the cookie so the server sees the latest auth state.
    if (href === '/users') {
      event.preventDefault()
      window.location.href = href
    }
  }

  return (
    <Link
      href={href}
      onClick={handleClick}
      className={`group/item relative w-[calc(100%-16px)] flex items-center ${collapsed ? 'justify-center px-0' : 'px-4'} py-3 mx-2 rounded-full transition-all duration-200 ${
        active
          ? 'bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-400 shadow-sm dark:shadow-none'
          : 'text-slate-500 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 hover:translate-x-1 dark:hover:bg-white/[0.04]'
      }`}
      style={{ textDecoration: 'none' }}
    >
      <Icon size={20} className={`${collapsed ? '' : 'mr-3'} shrink-0`} />
      {!collapsed && <span className="min-w-0 pr-1 text-[14px] leading-6 font-semibold">{label}</span>}
      {/* Tooltip when collapsed */}
      {collapsed && (
        <span className="absolute left-full ml-3 px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-xs font-medium whitespace-nowrap opacity-0 group-hover/item:opacity-100 pointer-events-none transition-opacity z-[100] shadow-lg">
          {label}
        </span>
      )}
    </Link>
  )
}

/* ── Inner layout ── */
function DashboardLayoutInner({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const { user, logout, isAdmin, loading: authLoading, error: authError, retry: retryAuth } = useAuth()
  const isChatPage = pathname === '/chat'
  const [mobileOpen, setMobileOpen] = useState(false)
  const mobileMenuButtonRef = useRef<HTMLButtonElement | null>(null)
  const mobileCloseButtonRef = useRef<HTMLButtonElement | null>(null)
  const mobileSidebarRef = useRef<HTMLElement | null>(null)
  const previousMobileOpenRef = useRef(false)

  /* Sidebar collapse state with localStorage */
  const [collapsed, setCollapsed] = useState(false)
  useEffect(() => {
    const saved = localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)
    if (saved !== 'true') return
    const frame = window.requestAnimationFrame(() => setCollapsed(true))
    return () => window.cancelAnimationFrame(frame)
  }, [])

  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({
    system_overview: true,
    model: true,
    agent: true,
    iot: true,
    knowledge_docs: true,
  })

  useEffect(() => {
    const saved = localStorage.getItem('sidebar-groups')
    if (!saved) return

    try {
      const parsed = JSON.parse(saved)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
      const valid = Object.fromEntries(
        NAV_GROUPS.map(group => [group.id, parsed[group.id]])
          .filter((entry): entry is [NavGroup['id'], boolean] => typeof entry[1] === 'boolean')
      )
      const frame = window.requestAnimationFrame(() => {
        setExpandedGroups(prev => ({ ...prev, ...valid }))
      })
      return () => window.cancelAnimationFrame(frame)
    } catch {
      // Ignore malformed saved state.
    }
  }, [])

  const toggleCollapsed = () => {
    setCollapsed(prev => {
      localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(!prev))
      return !prev
    })
  }

  const visibleGroups = useMemo(() => NAV_GROUPS.map(group => ({
      ...group,
      items: group.items.filter(item => !item.adminOnly || isAdmin),
    })).filter(group => group.items.length > 0), [isAdmin])
  const sidebarCollapsed = collapsed && !mobileOpen
  const searchOptions = visibleGroups.flatMap(group => group.items.map(item => ({
    label: item.label,
    href: item.href,
    group: group.label,
  })))

  const isActiveHref = useCallback((href: string) => pathname === href || (!['/models', '/agents'].includes(href) && pathname.startsWith(href + '/')), [pathname])

  useEffect(() => {
    const activeGroup = visibleGroups.find(group =>
      group.items.some(item => isActiveHref(item.href))
    )

    if (!activeGroup) return

    const frame = window.requestAnimationFrame(() => {
      setExpandedGroups(prev => {
        if (prev[activeGroup.id]) return prev
        const next = { ...prev, [activeGroup.id]: true }
        localStorage.setItem('sidebar-groups', JSON.stringify(next))
        return next
      })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [isActiveHref, visibleGroups])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setMobileOpen(false))
    return () => window.cancelAnimationFrame(frame)
  }, [pathname])

  useEffect(() => {
    const wasOpen = previousMobileOpenRef.current
    previousMobileOpenRef.current = mobileOpen
    if (!mobileOpen) {
      if (wasOpen) mobileMenuButtonRef.current?.focus()
      return
    }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.requestAnimationFrame(() => mobileCloseButtonRef.current?.focus())
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false)
      if (event.key !== 'Tab') return
      const focusable = Array.from(mobileSidebarRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ) || []).filter(element => element.offsetParent !== null)
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [mobileOpen])

  const toggleGroup = (groupId: string) => {
    setExpandedGroups(prev => {
      const next = { ...prev, [groupId]: !prev[groupId] }
      localStorage.setItem('sidebar-groups', JSON.stringify(next))
      return next
    })
  }

  return (
    <div className="admin-scope flex min-h-screen bg-[#f8f9fb] dark:bg-[#09090b] text-slate-900 dark:text-slate-100 font-sans transition-colors">

      {/* ═══ Sidebar ═══ */}
      {mobileOpen ? (
        <button type="button" aria-label="关闭导航菜单" onClick={() => setMobileOpen(false)} className="fixed inset-0 z-[45] bg-slate-950/35 backdrop-blur-[1px] lg:hidden" />
      ) : null}
      <aside
        ref={mobileSidebarRef}
        aria-label="后台功能导航"
        aria-modal={mobileOpen ? true : undefined}
        role={mobileOpen ? 'dialog' : undefined}
        className={`${mobileOpen ? 'flex w-[280px]' : 'hidden'} ${collapsed ? 'lg:w-[72px]' : 'lg:w-64'} fixed h-screen bg-white dark:bg-[#09090b] border-r border-slate-200/50 dark:border-white/[0.06] lg:flex flex-col py-6 z-50 transition-all duration-300 ease-in-out`}
      >
        {mobileOpen ? (
          <button ref={mobileCloseButtonRef} type="button" title="关闭导航菜单" aria-label="关闭导航菜单" onClick={() => setMobileOpen(false)} className="absolute right-4 top-4 z-10 flex h-9 w-9 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-700 lg:hidden dark:hover:bg-white/[0.06] dark:hover:text-white"><X size={18} /></button>
        ) : null}
        {/* Brand */}
        <div className={`${sidebarCollapsed ? 'px-0 flex justify-center' : 'px-4'} mb-6 transition-all duration-300`}>
          {sidebarCollapsed
            ? <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center text-white"><Ship size={20} /></div>
            : (
              <div className="flex items-center gap-3 px-4 py-3 rounded-2xl bg-slate-50 dark:bg-transparent dark:bg-gradient-to-b dark:from-white/[0.08] dark:to-white/[0.02]">
                <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center text-white">
                  <Ship size={20} />
                </div>
                <div>
                  <h1 className="text-sm font-black text-slate-900 dark:text-white">功能导航</h1>
                </div>
              </div>
            )
          }
        </div>

        {/* Navigation */}
        <div className="workspace-sidebar-scroll flex-1 min-h-0 px-2 overflow-y-auto overflow-x-hidden">
          <nav className="space-y-3 pb-4">
            {visibleGroups.map((group, groupIndex) => (
              <div key={group.id} className="space-y-1">
                {sidebarCollapsed ? (
                  <>
                    {group.items.map(item => {
                      const isActive = isActiveHref(item.href)
                      return (
                        <SidebarItem
                          key={item.href}
                          icon={item.icon}
                          label={item.label}
                          active={isActive}
                          href={item.href}
                          collapsed={sidebarCollapsed}
                        />
                      )
                    })}
                    {groupIndex < visibleGroups.length - 1 && (
                      <div className="mx-3 pt-2">
                        <div className="h-px bg-slate-200 dark:bg-white/[0.08]" />
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => toggleGroup(group.id)}
                      aria-expanded={expandedGroups[group.id]}
                      aria-controls={`sidebar-group-${group.id}`}
                      className="w-full flex items-center justify-between px-3 py-2.5 rounded-2xl text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-white/[0.04] transition-colors"
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        <group.icon size={20} className="shrink-0 text-slate-500 dark:text-slate-400" />
                        <span className="min-w-0 text-left text-[14px] leading-6 font-semibold text-slate-600 dark:text-slate-300">
                          {group.label}
                        </span>
                      </span>
                      {expandedGroups[group.id] ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    </button>

                    {expandedGroups[group.id] && (
                      <div id={`sidebar-group-${group.id}`} className="space-y-1">
                        {group.items.map(item => {
                          const isActive = isActiveHref(item.href)
                          return (
                            <SidebarItem
                              key={item.href}
                              icon={item.icon}
                              label={item.label}
                              active={isActive}
                              href={item.href}
                              collapsed={sidebarCollapsed}
                            />
                          )
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}
          </nav>
        </div>

        {/* User profile card */}
        <div className={`${sidebarCollapsed ? 'px-2' : 'px-4'} mt-auto transition-all duration-300`}>
          {sidebarCollapsed ? (
            /* Collapsed: avatar only */
            <div className="flex flex-col items-center gap-2">
              <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center text-white font-bold text-xs shadow-lg shadow-blue-500/20">
                {user?.username?.charAt(0).toUpperCase() || '—'}
              </div>
              <button
                onClick={logout}
                title="退出登录"
                aria-label="退出登录"
                className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-200 hover:text-red-500 dark:text-slate-500 dark:hover:bg-white/[0.08]"
              >
                <LogOut size={16} />
              </button>
              <button
                onClick={toggleCollapsed}
                title="展开侧边栏"
                aria-label="展开侧边栏"
                className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-200 hover:text-blue-600 dark:text-slate-500 dark:hover:bg-white/[0.08] dark:hover:text-blue-400"
              >
                <PanelLeftOpen size={16} />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-3 p-3 bg-slate-50 dark:bg-transparent dark:bg-gradient-to-b dark:from-white/[0.08] dark:to-white/[0.02] rounded-2xl">
              <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center text-white font-bold text-xs shadow-lg shadow-blue-500/20">
                {user?.username?.charAt(0).toUpperCase() || '—'}
              </div>
              <div className="overflow-hidden flex-1">
                <p className="text-sm font-bold text-slate-900 dark:text-slate-100 truncate" title={authLoading ? '正在确认身份' : user?.username || '身份未确认'}>{authLoading ? '正在确认身份' : user?.username || '身份未确认'}</p>
                <p className="truncate text-xs font-bold text-slate-400 dark:text-slate-500" title={authLoading ? '请稍候' : user?.role === 'admin' ? '超级管理员' : user?.role === 'user' ? '普通用户' : '无法读取账号信息'}>
                  {authLoading ? '请稍候' : user?.role === 'admin' ? '超级管理员' : user?.role === 'user' ? '普通用户' : '无法读取账号信息'}
                </p>
              </div>
              <button
                onClick={logout}
                title="退出登录"
                aria-label="退出登录"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-200 hover:text-red-500 dark:text-slate-500 dark:hover:bg-white/[0.08]"
              >
                <LogOut size={16} />
              </button>
              <button
                onClick={toggleCollapsed}
                title="收缩侧边栏"
                aria-label="收缩侧边栏"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-200 hover:text-blue-600 dark:text-slate-500 dark:hover:bg-white/[0.08] dark:hover:text-blue-400"
              >
                <PanelLeftClose size={16} />
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* ═══ Main content (offset by sidebar width) ═══ */}
      <div
        aria-hidden={mobileOpen ? true : undefined}
        inert={mobileOpen ? true : undefined}
        className={`${collapsed ? 'lg:ml-[72px]' : 'lg:ml-64'} ml-0 flex min-w-0 flex-1 flex-col overflow-x-hidden transition-all duration-300 ease-in-out`}
      >

        {/* ── Top header bar ── */}
        <header className="sticky top-0 h-16 bg-white/80 dark:bg-[#09090b]/80 backdrop-blur-xl border-b border-slate-200/50 dark:border-white/[0.06] flex items-center justify-between gap-3 px-4 md:px-8 z-40 transition-colors">
          {/* Left: brand + search */}
          <div className="flex min-w-0 flex-1 items-center gap-3 md:gap-8">
            <button ref={mobileMenuButtonRef} type="button" title="打开导航菜单" aria-label="打开导航菜单" aria-expanded={mobileOpen} onClick={() => setMobileOpen(true)} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 lg:hidden dark:text-slate-400 dark:hover:bg-white/[0.06]"><Menu size={19} /></button>
            <span className="hidden shrink-0 text-sm font-black text-blue-600 lg:block">基于智慧家居场景的大语言模型智能体科研应用一体机</span>
            <GlobalNavSearch key={`${pathname}:${isAdmin ? 'admin' : 'user'}`} options={searchOptions} />
          </div>

          {/* Right */}
          <div className="flex items-center gap-4">
            {/* Icon buttons */}
            <div className="flex gap-2">
              <Link
                href="/activity-logs?level=error"
                title="查看异常日志"
                aria-label="查看异常日志"
                className="inline-flex h-9 w-9 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-white/[0.06]"
              >
                <Bell size={18} />
              </Link>
              <Link
                href="/settings"
                title="打开系统设置"
                aria-label="打开系统设置"
                className="inline-flex h-9 w-9 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-white/[0.06]"
              >
                <Settings size={18} />
              </Link>
            </div>

            {/* Divider */}
            <div className="hidden h-8 w-[1px] bg-slate-200 dark:bg-white/[0.08] sm:block" />

            {/* Avatar */}
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-white font-bold text-[10px] shadow-lg shadow-blue-500/20">
                {user?.username?.charAt(0).toUpperCase() || '—'}
              </div>
            </div>
          </div>
        </header>

        {!authLoading && authError && !user ? (
          <div className="border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-sm font-semibold text-amber-900 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-100 md:px-8" role="alert">
            <span>{authError}</span>
            <button type="button" onClick={() => void retryAuth()} className="ml-3 font-black text-blue-700 hover:underline dark:text-blue-300">重新校验</button>
          </div>
        ) : null}

        {/* ── Page content ── */}
        <main className={isChatPage ? 'min-w-0 flex-1 p-0' : 'min-w-0 flex-1 overflow-x-hidden p-4 pt-6 md:p-8 md:pt-8'}>
          {children}
        </main>

      </div>
    </div>
  )
}

/* ── Root layout with providers ── */
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <MotionConfig reducedMotion="user">
      <DashboardLayoutInner>{children}</DashboardLayoutInner>
    </MotionConfig>
  )
}
