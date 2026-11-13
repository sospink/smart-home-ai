'use client'

import Link from 'next/link'
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import {
  AlertTriangle,
  ArrowUpRight,
  BookOpen,
  Bot,
  CheckCircle2,
  Code2,
  Database,
  FileCode2,
  FileJson,
  FileSearch,
  HelpCircle,
  Lightbulb,
  Loader2,
  RefreshCw,
  Search,
  Settings2,
} from 'lucide-react'
import { fetchHelpCatalog, type HelpCatalogResponse } from '@/lib/api/help-docs'
import { fetchSystemDashboardRuntime, type SystemDashboardRuntime, type SystemDashboardService } from '@/lib/api/system'
import { Pagination } from '@/components/ui/Pagination'
import { useAuth } from '@/lib/hooks/useAuth'
import { businessErrorMessage } from '@/lib/ui/business-error'

const MODULE_ICONS: Record<string, typeof BookOpen> = {
  'local-model': FileCode2,
  'agent-external': Bot,
  'smart-home': Lightbulb,
  sandbox: Database,
  'device-data': Database,
  'device-control': Lightbulb,
  knowledge: FileSearch,
  system: Settings2,
}

const referenceEntries = [
  {
    title: 'Swagger UI',
    desc: '交互式接口控制台，适合调试参数、查看请求响应以及快速联调。',
    href: '/api/docs',
    icon: Code2,
    external: true,
  },
  {
    title: 'ReDoc',
    desc: '更适合连续阅读的接口参考视图，适合做长期查阅和说明比对。',
    href: '/api/redoc',
    icon: BookOpen,
    external: true,
  },
  {
    title: 'OpenAPI JSON',
    desc: '原始接口结构定义，可用于生成 SDK、导入 Postman 或做自动化对接。',
    href: '/api/openapi.json',
    icon: FileJson,
    external: true,
  },
]

const tutorialEntries = [
  '先按页面中的接口能力模块查看当前平台已经具备的对接、数据访问、设备控制与电子沙盘能力。',
  '进入文档中心的 API 参考，使用请求示例生成参数，并在执行前核对请求预览。',
  '需要对接外部工作流或智能体时，优先使用 OpenAPI JSON 生成调用定义，减少手写参数误差。',
]

function catalogViewKey(keyword: string, page: number, pageSize: number) {
  return JSON.stringify({ keyword: keyword.trim(), page, pageSize })
}

function serviceName(service: SystemDashboardService) {
  const labels: Record<string, string> = {
    backend: '平台后端',
    database: '业务数据库',
    dify: 'Dify 应用',
    dify_app: 'Dify 应用',
    knowledge: '知识库服务',
    dify_knowledge: 'Dify 知识库',
    home_assistant: 'Home Assistant',
    homeassistant: 'Home Assistant',
    ollama: '本地模型',
    influxdb: 'InfluxDB',
  }
  return labels[service.key] || service.name || '外部服务'
}

function serviceHref(service: SystemDashboardService) {
  if (['dify', 'dify_app', 'knowledge', 'dify_knowledge'].includes(service.key)) return '/dify'
  if (service.key === 'home_assistant' || service.key === 'homeassistant') return '/home-assistant'
  if (service.key === 'ollama') return '/models/pulls'
  if (service.key === 'influxdb') return '/time-series'
  return '/settings'
}

function HelpDocsContent() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { isAdmin, loading: authLoading } = useAuth()
  const [catalog, setCatalog] = useState<HelpCatalogResponse | null>(null)
  const [runtime, setRuntime] = useState<SystemDashboardRuntime | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [runtimeLoading, setRuntimeLoading] = useState(true)
  const [catalogRefreshing, setCatalogRefreshing] = useState(false)
  const [runtimeRefreshing, setRuntimeRefreshing] = useState(false)
  const [catalogError, setCatalogError] = useState('')
  const [runtimeError, setRuntimeError] = useState('')
  const [apiDefinitionBase, setApiDefinitionBase] = useState('')
  const [keyword, setKeyword] = useState(() => searchParams.get('q') || '')
  const [debouncedKeyword, setDebouncedKeyword] = useState(() => (searchParams.get('q') || '').trim())
  const [searchSettled, setSearchSettled] = useState(true)
  const [page, setPage] = useState(() => {
    const value = Number(searchParams.get('page') || 1)
    return Number.isInteger(value) && value > 0 ? value : 1
  })
  const [pageSize, setPageSize] = useState(() => {
    const value = Number(searchParams.get('size') || 5)
    return [5, 10, 20].includes(value) ? value : 5
  })
  const [loadedCatalogViewKey, setLoadedCatalogViewKey] = useState('')
  const [loadedCatalogPageSize, setLoadedCatalogPageSize] = useState(5)
  const catalogRequestRef = useRef(0)
  const runtimeRequestRef = useRef(0)
  const catalogAbortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => entries.forEach((entry) => {
        if (!entry.isIntersecting) return
        entry.target.classList.add('in')
        observer.unobserve(entry.target)
      }),
      { threshold: 0.06, rootMargin: '0px 0px -40px 0px' },
    )
    const frame = window.requestAnimationFrame(() => {
      document.querySelectorAll('.reveal').forEach((element) => observer.observe(element))
    })
    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [])
  const runtimeAbortRef = useRef<AbortController | null>(null)
  const catalogRefreshInFlightRef = useRef(false)
  const runtimeRefreshInFlightRef = useRef(false)
  const writtenSearchRef = useRef(searchParams.toString())

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      const nextKeyword = keyword.trim()
      if (nextKeyword !== debouncedKeyword) {
        setDebouncedKeyword(nextKeyword)
        setPage(1)
      }
      setSearchSettled(true)
    }, 300)
    return () => window.clearTimeout(timeoutId)
  }, [debouncedKeyword, keyword])

  useEffect(() => {
    if (pathname !== '/help-docs') return
    const url = new URL(window.location.href)
    const values = { q: keyword.trim(), page: page === 1 ? '' : String(page), size: pageSize === 5 ? '' : String(pageSize) }
    Object.entries(values).forEach(([key, value]) => value ? url.searchParams.set(key, value) : url.searchParams.delete(key))
    const nextSearch = url.searchParams.toString()
    writtenSearchRef.current = nextSearch
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }, [keyword, page, pageSize, pathname])

  useEffect(() => {
    if (pathname !== '/help-docs') return
    const nextSearch = searchParams.toString()
    if (nextSearch === writtenSearchRef.current) return
    writtenSearchRef.current = nextSearch
    const nextKeyword = searchParams.get('q') || ''
    const rawPage = Number(searchParams.get('page') || 1)
    const rawSize = Number(searchParams.get('size') || 5)
    invalidateCatalog()
    setKeyword(nextKeyword)
    setDebouncedKeyword(nextKeyword.trim())
    setSearchSettled(true)
    setPage(Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1)
    setPageSize([5, 10, 20].includes(rawSize) ? rawSize : 5)
  }, [pathname, searchParams])

  const loadCatalog = useCallback(async (force = false) => {
    if (force && catalogRefreshInFlightRef.current) return false
    catalogAbortRef.current?.abort()
    const controller = new AbortController()
    catalogAbortRef.current = controller
    if (force) {
      catalogRefreshInFlightRef.current = true
      setCatalogRefreshing(true)
    }
    const requestId = ++catalogRequestRef.current
    setCatalogLoading(true)
    setCatalogError('')
    try {
      const response = await fetchHelpCatalog({ keyword: debouncedKeyword, page, size: pageSize }, force, controller.signal)
      if (catalogRequestRef.current !== requestId) return false
      setCatalog(response)
      setLoadedCatalogViewKey(catalogViewKey(debouncedKeyword, response.page, response.size || pageSize))
      setLoadedCatalogPageSize(response.size || pageSize)
      if (response.page !== page) setPage(response.page)
      return true
    } catch (error) {
      if (controller.signal.aborted) return false
      if (catalogRequestRef.current === requestId) {
        setCatalogError(businessErrorMessage(error, { fallback: '接口目录读取失败', service: '接口目录' }))
      }
      return false
    } finally {
      if (catalogAbortRef.current === controller) catalogAbortRef.current = null
      if (catalogRequestRef.current === requestId) setCatalogLoading(false)
      if (force) {
        catalogRefreshInFlightRef.current = false
        setCatalogRefreshing(false)
      }
    }
  }, [debouncedKeyword, page, pageSize])

  const loadRuntime = useCallback(async (force = false) => {
    if (force && runtimeRefreshInFlightRef.current) return false
    runtimeAbortRef.current?.abort()
    const controller = new AbortController()
    runtimeAbortRef.current = controller
    if (force) {
      runtimeRefreshInFlightRef.current = true
      setRuntimeRefreshing(true)
    }
    const requestId = ++runtimeRequestRef.current
    setRuntimeLoading(true)
    setRuntimeError('')
    try {
      const response = await fetchSystemDashboardRuntime(force, controller.signal)
      if (runtimeRequestRef.current !== requestId) return false
      setRuntime(response)
      return true
    } catch (error) {
      if (controller.signal.aborted) return false
      if (runtimeRequestRef.current === requestId) {
        setRuntimeError(businessErrorMessage(error, { fallback: '运行状态读取失败', service: '平台运行状态' }))
      }
      return false
    } finally {
      if (runtimeAbortRef.current === controller) runtimeAbortRef.current = null
      if (runtimeRequestRef.current === requestId) setRuntimeLoading(false)
      if (force) {
        runtimeRefreshInFlightRef.current = false
        setRuntimeRefreshing(false)
      }
    }
  }, [])

  useEffect(() => {
    if (!searchSettled || keyword.trim() !== debouncedKeyword) return
    void loadCatalog()
  }, [debouncedKeyword, keyword, loadCatalog, searchSettled])
  useEffect(() => { void loadRuntime() }, [loadRuntime])
  useEffect(() => {
    if (!catalogError && !runtimeError) return
    const recoverFailedReads = () => {
      if (!navigator.onLine || document.visibilityState !== 'visible') return
      if (catalogError && !catalogAbortRef.current) void loadCatalog(true)
      if (runtimeError && !runtimeAbortRef.current) void loadRuntime(true)
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
  }, [catalogError, loadCatalog, loadRuntime, runtimeError])
  useEffect(() => {
    const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL || '/api'
    try {
      const apiUrl = new URL(apiBase, window.location.origin)
      setApiDefinitionBase(apiUrl.origin === window.location.origin ? '' : apiUrl.origin)
    } catch {
      setApiDefinitionBase('')
    }
  }, [])
  useEffect(() => () => {
    catalogRequestRef.current += 1
    runtimeRequestRef.current += 1
    catalogAbortRef.current?.abort()
    runtimeAbortRef.current?.abort()
    catalogRefreshInFlightRef.current = false
    runtimeRefreshInFlightRef.current = false
  }, [])

  const diagnostics = useMemo(() => {
    if (!runtime) return []
    const normalizeDiagnostic = (value: string) => value.toLowerCase().replace(/[\s:：，,。；;、_-]+/g, '')
    const items = runtime.services
      .filter((service) => service.status !== 'running')
      .map((service) => ({
        key: `service-${service.key}`,
        title: `${serviceName(service)} · ${service.status === 'unconfigured' ? '尚未配置' : '需要检查'}`,
        detail: service.detail || '当前探测未返回正常状态，请进入对应页面检查配置和服务日志。',
        href: serviceHref(service),
      }))
    runtime.warnings.forEach((warning, index) => {
      const normalizedWarning = normalizeDiagnostic(warning)
      const duplicatesService = runtime.services.some((service) => {
        if (service.status === 'running') return false
        return [service.key, service.name, serviceName(service)]
          .filter(Boolean)
          .some((label) => normalizedWarning.includes(normalizeDiagnostic(label)))
      })
      const duplicatesDetail = items.some((item) => {
        const detail = normalizeDiagnostic(item.detail)
        return detail === normalizedWarning || normalizedWarning.includes(detail) || detail.includes(normalizedWarning)
      })
      if (!duplicatesService && !duplicatesDetail) {
        items.push({ key: `warning-${index}`, title: '平台运行提醒', detail: warning, href: '/dashboard' })
      }
    })
    return items
  }, [runtime])

  const invalidateCatalog = () => {
    catalogRequestRef.current += 1
    setCatalogError('')
    setCatalogLoading(true)
  }
  const currentCatalogViewKey = catalogViewKey(debouncedKeyword, page, pageSize)
  const catalogSnapshotMatchesView = Boolean(
    catalog
    && searchSettled
    && keyword.trim() === debouncedKeyword
    && loadedCatalogViewKey === currentCatalogViewKey
  )

  return (
    <div className="space-y-8">
      <section className="reveal overflow-hidden rounded-[8px] border border-slate-200 bg-white px-8 py-10 dark:border-white/[0.08] dark:bg-white/[0.03]">
        <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl space-y-4">
            <p className="text-xs font-semibold text-blue-500">帮助中心</p>
            <div className="space-y-3">
              <h1 className="text-4xl font-black text-slate-900 dark:text-white">
                帮助文档和教程
              </h1>
              <p className="max-w-2xl text-sm leading-7 text-slate-500 dark:text-slate-400">
                面向“基于智慧家居场景的大语言模型智能体科研应用一体机”的使用说明、接口参考与联调入口。
                这里统一汇总帮助文档、教程以及智能体外部接口、设备对接、数据访问、电子沙盘联调等能力入口。
              </p>
            </div>
          </div>

          <div className={`grid gap-3 ${!authLoading && isAdmin ? 'sm:grid-cols-2' : ''}`}>
            <Link
              href="/docs?view=api"
              className="flex items-center justify-between rounded-[8px] border border-slate-200 bg-slate-50 px-5 py-4 text-sm font-bold text-slate-700 transition hover:border-blue-200 hover:text-blue-600 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-slate-200 dark:hover:text-blue-400"
            >
              <span>进入 API 调试器</span>
              <ArrowUpRight size={16} />
            </Link>
            {!authLoading && isAdmin ? (
              <Link
                href="/api-console"
                className="flex items-center justify-between rounded-[8px] border border-blue-200 bg-blue-50 px-5 py-4 text-sm font-bold text-blue-700 transition hover:bg-blue-100 dark:border-blue-400/20 dark:bg-blue-500/10 dark:text-blue-300"
              >
                <span>打开接口控制台</span>
                <ArrowUpRight size={16} />
              </Link>
            ) : null}
          </div>
        </div>
      </section>

      <section className="reveal space-y-4">
        <div className="overflow-hidden rounded-[8px] border border-blue-300 bg-blue-50 px-6 py-5 shadow-[inset_0_0_0_1px_rgba(219,234,254,0.9)] dark:border-blue-400/40 dark:bg-blue-500/10 dark:shadow-[inset_0_0_0_1px_rgba(96,165,250,0.1)]">
          <h2 className="text-xl font-black text-slate-900 dark:text-white">文档入口分工</h2>
          <div className="mt-4 grid divide-y divide-blue-100 lg:grid-cols-2 lg:divide-x lg:divide-y-0 dark:divide-blue-400/20">
            <div className="py-2 pr-5 lg:py-0">
              <p className="text-sm font-black text-blue-700 dark:text-blue-200">/docs</p>
              <p className="mt-2 text-sm leading-7 text-slate-600 dark:text-slate-300">公共文档中心、API 参考、请求示例与真实调试、模板说明和功能能力索引。</p>
            </div>
            <div className="py-2 lg:py-0 lg:pl-5">
              <p className="text-sm font-black text-blue-700 dark:text-blue-200">/help-docs</p>
              <p className="mt-2 text-sm leading-7 text-slate-600 dark:text-slate-300">后台帮助入口、接口能力分组、常用联调入口和原生接口定义。</p>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-2xl font-black text-slate-900 dark:text-white">外部功能接口</h2>
              {catalog ? <span className="text-xs font-bold text-slate-400">{catalog.summary.moduleTotal} 个模块 · {catalog.summary.endpointTotal} 个端点</span> : null}
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-400">目录来自当前公开 API 配置，选择模块后进入文档中心查看参数、示例和真实调试结果。</p>
          </div>
          <div className="flex w-full gap-2 lg:w-auto">
            <label className="relative min-w-0 flex-1 lg:w-72">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={keyword} onChange={(event) => {
                invalidateCatalog()
                setSearchSettled(false)
                setKeyword(event.target.value)
                setPage(1)
              }} className="h-10 w-full rounded-[8px] border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none transition placeholder:text-slate-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:border-white/[0.08] dark:bg-white/[0.03] dark:focus:ring-blue-400/15" placeholder="搜索模块名称、说明或能力" aria-label="搜索接口模块" />
            </label>
            <button type="button" onClick={() => void loadCatalog(true)} disabled={catalogLoading || catalogRefreshing} className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] border border-slate-200 text-slate-500 transition hover:border-blue-200 hover:text-blue-700 disabled:opacity-50" title="刷新接口目录" aria-label="刷新接口目录">
              <RefreshCw size={16} className={catalogRefreshing ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        {catalogLoading && catalog ? <div className="flex items-center gap-2 border-l-2 border-blue-500 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700 dark:bg-blue-500/10 dark:text-blue-300" role="status"><Loader2 size={14} className="animate-spin" />正在更新接口目录，{catalogSnapshotMatchesView ? '当前暂时显示同一条件下的上一次成功结果' : '下方旧目录不代表当前条件，模块入口和分页暂不可用'}</div> : null}
        {catalogError && catalog ? <div className="border-l-2 border-amber-400 bg-amber-50 px-3 py-2 text-xs font-semibold leading-5 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">接口目录更新失败：{catalogError}。{catalogSnapshotMatchesView ? '当前保留同一条件下的上一次成功结果。' : '下方保留的旧目录不代表当前条件，模块入口和分页暂不可用。'}</div> : null}
        <div className="overflow-hidden rounded-[8px] border border-slate-200 bg-white dark:border-white/[0.08] dark:bg-white/[0.03]">
          <div className="overflow-x-auto">
          <div className="min-w-[980px]">
          <div className="grid grid-cols-[180px_minmax(240px,1fr)_minmax(210px,0.8fr)_100px_88px] gap-4 bg-slate-50 px-5 py-3 text-xs font-bold text-slate-500 dark:bg-white/[0.035]">
            <span>接口模块</span><span>模块说明</span><span>能力范围</span><span className="text-right">可用端点</span><span />
          </div>
          <div className="divide-y divide-slate-100 dark:divide-white/[0.06]">
            {catalog?.items.map((item) => {
              const Icon = MODULE_ICONS[item.slug] || BookOpen
              return (
                <div key={item.id} className="grid min-h-16 grid-cols-[180px_minmax(240px,1fr)_minmax(210px,0.8fr)_100px_88px] items-center gap-4 px-5 py-3 transition hover:bg-slate-50/70 dark:hover:bg-white/[0.025]">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300"><Icon size={17} /></span>
                    <p className="min-w-0 truncate text-sm font-black text-slate-900 dark:text-white" title={item.title}>{item.title}</p>
                  </div>
                  <div className="truncate text-sm text-slate-600 dark:text-slate-300" title={item.subtitle || item.description || '暂无模块说明'}>{item.subtitle || item.description || '暂无模块说明'}</div>
                  <div className="truncate text-sm font-semibold text-slate-600 dark:text-slate-300" title={item.capabilityTags.join('、') || '暂无能力标签'}>{item.capabilityTags.length ? item.capabilityTags.slice(0, 2).join('、') + (item.capabilityTags.length > 2 ? ` 等 ${item.capabilityTags.length} 项` : '') : '暂无能力标签'}</div>
                  <div className="text-right text-sm font-black text-slate-900 dark:text-white">{item.endpointCount}</div>
                  <Link href={`/docs?view=api&module=${encodeURIComponent(item.slug)}`} onClick={(event) => { if (!catalogSnapshotMatchesView) event.preventDefault() }} aria-disabled={!catalogSnapshotMatchesView} tabIndex={catalogSnapshotMatchesView ? undefined : -1} aria-label={`打开${item.title} API 参考`} className={`inline-flex min-h-8 items-center gap-1 text-sm font-bold md:justify-end ${catalogSnapshotMatchesView ? 'text-blue-600 hover:underline dark:text-blue-300' : 'cursor-not-allowed text-slate-400 opacity-60'}`}>打开<ArrowUpRight size={14} /></Link>
                </div>
              )
            })}
            {catalogLoading && !catalog ? <div className="flex items-center justify-center gap-2 px-5 py-12 text-sm text-slate-500"><Loader2 size={16} className="animate-spin" />正在读取接口目录</div> : null}
            {catalogError && !catalog ? <div className="px-5 py-10 text-center"><p className="text-sm font-bold text-rose-700">接口目录读取失败</p><p className="mt-2 text-xs text-slate-500">{catalogError}</p><button type="button" onClick={() => void loadCatalog(true)} className="mt-4 rounded-[8px] border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700">重新读取</button></div> : null}
            {!catalogLoading && !catalogError && catalog && !catalog.items.length ? <div className="px-5 py-10 text-center text-sm text-slate-500">未找到匹配的接口模块，请调整搜索词。</div> : null}
          </div>
          </div>
          </div>
          {catalog ? <Pagination page={catalog.page} pageSize={loadedCatalogPageSize} total={catalog.total} itemName="个接口模块" loading={catalogLoading} navigationDisabled={!catalogSnapshotMatchesView} onPageChange={(value) => { if (!catalogSnapshotMatchesView) return; invalidateCatalog(); setPage(value) }} onPageSizeChange={(size) => { if (!catalogSnapshotMatchesView) return; invalidateCatalog(); setPageSize(size); setPage(1) }} pageSizeOptions={[5, 10, 20]} /> : null}
        </div>
      </section>

      <section className="reveal grid gap-6 xl:grid-cols-[1.25fr_0.75fr]">
        <div className="overflow-hidden rounded-[8px] border border-slate-300 bg-white px-6 py-7 shadow-[inset_0_0_0_1px_rgba(226,232,240,0.75)] dark:border-white/[0.16] dark:bg-transparent dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]">
          <div className="mb-6 space-y-2">
            <h2 className="text-2xl font-black text-slate-900 dark:text-white">接口参考入口</h2>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              日常请求调试统一进入文档中心；这里保留后端原生定义，用于查阅、生成 SDK 和工具导入。
            </p>
          </div>

          <div className="grid overflow-hidden rounded-[8px] border border-slate-300 md:grid-cols-3 md:divide-x md:divide-slate-200 dark:border-white/[0.16] dark:divide-white/[0.08]">
            {referenceEntries.map((entry) => (
              <Link
                key={entry.title}
                href={`${apiDefinitionBase}${entry.href}`}
                target={entry.external ? '_blank' : undefined}
                rel={entry.external ? 'noreferrer' : undefined}
                className="border-b border-slate-200 bg-slate-50 px-5 py-4 transition last:border-b-0 hover:bg-blue-50/70 dark:border-white/[0.08] dark:bg-white/[0.03] md:border-b-0"
              >
                <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-[8px] bg-white text-slate-700 dark:bg-slate-900 dark:text-slate-200">
                  <entry.icon size={20} />
                </div>
                <div className="space-y-2">
                  <h3 className="text-base font-black text-slate-900 dark:text-white">{entry.title}</h3>
                  <p className="text-sm leading-6 text-slate-500 dark:text-slate-400">{entry.desc}</p>
                </div>
              </Link>
            ))}
          </div>
        </div>

        <div className="overflow-hidden rounded-[8px] border border-slate-400/70 bg-white px-6 py-7 ring-1 ring-inset ring-slate-200/70 dark:border-white/[0.16] dark:bg-transparent dark:ring-white/[0.04]">
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-[8px] bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-300">
              <HelpCircle size={20} />
            </div>
            <div>
              <h2 className="text-xl font-black text-slate-900 dark:text-white">使用建议</h2>
              <p className="text-sm text-slate-500 dark:text-slate-400">更贴合你当前平台联调方式的文档使用顺序。</p>
            </div>
          </div>

          <div className="space-y-4">
            {tutorialEntries.map((item, index) => (
              <div
                key={item}
                className="flex gap-4 border-b border-slate-100 px-1 py-3 last:border-b-0 dark:border-white/[0.06]"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-black text-white">
                  {index + 1}
                </div>
                <p className="text-sm leading-7 text-slate-600 dark:text-slate-300">{item}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="reveal overflow-hidden rounded-[8px] border border-slate-200 bg-white px-6 py-8 dark:border-white/[0.08] dark:bg-transparent">
        <div className="mb-6 space-y-2">
          <h2 className="text-2xl font-black text-slate-900 dark:text-white">接口能力说明</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            当前公开接口已经接入文档中心的全屏调试工作台；执行结果以真实后端代理响应为准，示例响应不会包装成执行成功。
          </p>
        </div>

        <div className="grid border-t border-slate-100 lg:grid-cols-2 dark:border-white/[0.06]">
          {[
            {
              title: '智能体调用外部功能接口',
              detail: '统一汇总设备控制接口、数据查询接口、知识库检索接口、文件与系统接口，便于智能体与外部能力联动。',
            },
            {
              title: '智能家居系统与虚拟设备系统对接能力',
              detail: '通过 Home Assistant 与电子沙盘虚拟设备系统完成设备数据接入、状态同步与设备控制。',
            },
            {
              title: '标准化接口获取设备状态、传感器数据、场景信息',
              detail: '通过统一接口分组查询逻辑设备状态、传感器数据和场景预设信息。',
            },
            {
              title: '统一的设备数据访问接口',
              detail: '当前已提供实时状态数据、历史趋势数据、设备运行状态等访问入口，并可在文档中心按端点查看参数与执行调试。',
            },
            {
              title: '统一的设备控制接口',
              detail: '支持智能体向外部系统发送控制请求，并返回执行结果与状态反馈。',
            },
            {
              title: '虚拟设备与电子沙盘交互控制',
              detail: '支持向虚拟设备系统或电子沙盘系统发送控制请求，并对虚拟设备和场景进行交互控制。',
            },
          ].map((item) => (
            <div
              key={item.title}
              className="border-b border-slate-100 px-5 py-4 lg:odd:border-r dark:border-white/[0.06]"
            >
              <h3 className="text-base font-black text-slate-900 dark:text-white">{item.title}</h3>
              <p className="mt-2 text-sm leading-7 text-slate-500 dark:text-slate-400">{item.detail}</p>
            </div>
          ))}
        </div>

        <div className="mt-8 border-t border-slate-200 pt-6 dark:border-white/[0.08]">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-xl font-black text-slate-900 dark:text-white">当前运行排查</h2>
              <p className="mt-1 text-sm text-slate-500">建议来自当前服务探测，不使用固定模拟状态。</p>
            </div>
            <div className="flex items-center gap-3">
              {runtime ? <div className="flex items-center gap-2 text-xs font-bold text-slate-500"><CheckCircle2 size={15} className={diagnostics.length ? 'text-amber-500' : 'text-emerald-600'} />{runtime.services.filter((service) => service.status === 'running').length}/{runtime.services.length} 项服务运行正常</div> : null}
              <button type="button" onClick={() => void loadRuntime(true)} disabled={runtimeLoading || runtimeRefreshing} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] border border-slate-200 text-slate-500 transition hover:border-blue-200 hover:text-blue-700 disabled:opacity-50" title="重新探测运行状态" aria-label="重新探测运行状态">
                <RefreshCw size={15} className={runtimeRefreshing ? 'animate-spin' : ''} />
              </button>
            </div>
          </div>
          {runtimeLoading && !runtime ? <div className="mt-4 flex items-center gap-2 rounded-[8px] border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800"><Loader2 size={15} className="animate-spin" />正在读取当前服务状态</div> : null}
          {runtimeError && !runtime ? <div className="mt-4 flex min-w-0 items-start gap-2 rounded-[8px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"><AlertTriangle size={16} className="mt-0.5 shrink-0" /><div className="min-w-0"><p className="font-bold">运行状态读取失败</p><p className="mt-1 break-words text-xs">{runtimeError}</p></div></div> : null}
          {runtime && !diagnostics.length ? <div className="mt-4 flex items-center gap-2 rounded-[8px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800"><CheckCircle2 size={16} className="shrink-0" />基础服务探测未发现异常，具体业务结果仍以目标页面执行反馈为准。</div> : null}
          {diagnostics.length ? <div className="mt-4 divide-y divide-slate-200 overflow-hidden rounded-[8px] border border-slate-200 dark:divide-white/[0.08] dark:border-white/[0.08]">{diagnostics.map((item) => <div key={item.key} className="grid min-w-0 gap-2 px-4 py-4 sm:grid-cols-[minmax(180px,0.7fr)_minmax(0,1.5fr)_100px] sm:items-center sm:gap-4"><div className="flex min-w-0 items-center gap-2 text-sm font-black text-slate-900 dark:text-white"><AlertTriangle size={15} className="shrink-0 text-amber-600" /><span className="break-words">{item.title}</span></div><p className="min-w-0 break-words text-sm leading-6 text-slate-600 dark:text-slate-300">{item.detail}</p><Link href={item.href} className="inline-flex min-h-9 items-center gap-1 text-xs font-bold text-blue-600 sm:justify-end">查看诊断<ArrowUpRight size={13} /></Link></div>)}</div> : null}
          {(catalogError && catalog) || (runtimeError && runtime) ? <p className="mt-3 text-xs text-amber-700">刷新存在部分失败，页面保留上一次成功数据：{[catalogError && `接口目录 ${catalogError}`, runtimeError && `运行状态 ${runtimeError}`].filter(Boolean).join('；')}</p> : null}
        </div>
      </section>
    </div>
  )
}

export default function HelpDocsPage() {
  return (
    <Suspense fallback={<div className="flex min-h-[50vh] items-center justify-center text-sm font-bold text-slate-400">正在读取帮助目录...</div>}>
      <HelpDocsContent />
    </Suspense>
  )
}
