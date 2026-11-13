import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const PUBLIC_PATHS = new Set(['/', '/home', '/docs', '/login'])
const ADMIN_ONLY_PATHS = ['/users', '/admin/users']
const PROTECTED_PREFIXES = [
  '/dashboard',
  '/activity-logs',
  '/conversation-records',
  '/chat',
  '/devices',
  '/sandbox',
  '/monitor',
  '/time-series',
  '/knowledge',
  '/dify',
  '/home-assistant',
  '/models',
  '/agents',
  '/api-console',
  '/help-docs',
  '/settings',
  '/users',
  '/admin',
]

function mapLegacyAdminPath(pathname: string): string | null {
  if (pathname === '/admin') return '/dashboard'
  if (pathname === '/admin/docs') return '/help-docs'

  const mappings: Array<[string, string]> = [
    ['/admin/knowledge', '/knowledge'],
    ['/admin/models', '/models'],
    ['/admin/agents', '/agents'],
    ['/admin/settings', '/settings'],
    ['/admin/users', '/users'],
  ]

  for (const [legacy, nextPath] of mappings) {
    if (pathname === legacy) return nextPath
    if (pathname.startsWith(`${legacy}/`)) {
      return pathname.replace(legacy, nextPath)
    }
  }

  return null
}

function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(prefix =>
    pathname === prefix || pathname.startsWith(`${prefix}/`)
  )
}

function isAdminOnlyPath(pathname: string): boolean {
  return ADMIN_ONLY_PATHS.some(prefix =>
    pathname === prefix || pathname.startsWith(`${prefix}/`)
  )
}

function redirectToLogin(request: NextRequest, nextPath: string) {
  const url = new URL('/home', request.url)
  url.searchParams.set('login', '1')
  url.searchParams.set('next', `${nextPath}${request.nextUrl.search}`)
  return NextResponse.redirect(url)
}

function decodeTokenPayload(token: string): { role?: string; exp?: number } {
  const encoded = token.split('.')[1]
  if (!encoded) throw new Error('Token 结构无效')
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  return JSON.parse(atob(padded))
}

export function proxy(request: NextRequest) {
  const token = request.cookies.get('access_token')?.value
    || request.headers.get('authorization')?.replace('Bearer ', '')

  const { pathname } = request.nextUrl
  const canonicalPath = mapLegacyAdminPath(pathname) || pathname

  if (PUBLIC_PATHS.has(canonicalPath)) {
    if (canonicalPath !== pathname) {
      const url = request.nextUrl.clone()
      url.pathname = canonicalPath
      return NextResponse.redirect(url)
    }
    return NextResponse.next()
  }

  if (!isProtectedPath(canonicalPath)) {
    return NextResponse.next()
  }

  if (!token) {
    return redirectToLogin(request, canonicalPath)
  }

  try {
    const payload = decodeTokenPayload(token)
    if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) {
      return redirectToLogin(request, canonicalPath)
    }

    if (isAdminOnlyPath(canonicalPath) && payload.role !== 'admin') {
      return NextResponse.redirect(new URL('/dashboard', request.url))
    }

    if (canonicalPath !== pathname) {
      const url = request.nextUrl.clone()
      url.pathname = canonicalPath
      return NextResponse.redirect(url)
    }
  } catch {
    return redirectToLogin(request, canonicalPath)
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!api(?:/|$)|_next/static|_next/image|favicon.ico).*)'],
}
