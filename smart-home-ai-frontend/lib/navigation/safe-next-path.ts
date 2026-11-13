export function safeNextPath(candidate: string | null | undefined, fallback = '/dashboard') {
  if (!candidate || !candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\')) {
    return fallback
  }
  try {
    const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin
    const target = new URL(candidate, origin)
    if (target.origin !== origin || target.pathname === '/login') return fallback
    if (target.pathname === '/home' && target.searchParams.get('login') === '1') return fallback
    return `${target.pathname}${target.search}${target.hash}`
  } catch {
    return fallback
  }
}
