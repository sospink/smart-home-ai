import { apiClient } from '@/lib/api/client'
import { waitForSharedRead } from '@/lib/api/shared-read'

export type HelpCatalogItem = {
  id: number
  slug: string
  title: string
  subtitle: string
  description: string
  endpointBase: string
  capabilityTags: string[]
  endpointCount: number
}

export type HelpCatalogResponse = {
  summary: { moduleTotal: number; endpointTotal: number }
  items: HelpCatalogItem[]
  total: number
  page: number
  size: number
  pageCount: number
}

export type HelpCatalogQuery = {
  keyword?: string
  page?: number
  size?: number
}

const CACHE_TTL_MS = 30_000
const cache = new Map<string, { expiresAt: number; value: HelpCatalogResponse }>()
const pending = new Map<string, Promise<HelpCatalogResponse>>()
const generation = new Map<string, number>()

export function clearHelpCatalogCache() {
  const keys = new Set([...cache.keys(), ...pending.keys(), ...generation.keys()])
  keys.forEach((key) => generation.set(key, (generation.get(key) || 0) + 1))
  cache.clear()
  pending.clear()
}

export async function fetchHelpCatalog(query: HelpCatalogQuery = {}, force = false, signal?: AbortSignal) {
  const key = JSON.stringify(query)
  const hit = cache.get(key)
  if (!force && hit && hit.expiresAt > Date.now()) return structuredClone(hit.value)
  const active = pending.get(key)
  if (!force && active) return structuredClone(await waitForSharedRead(active, signal))
  const requestGeneration = (generation.get(key) || 0) + 1
  generation.set(key, requestGeneration)
  const request = apiClient.get<HelpCatalogResponse>('/api-docs/catalog', {
    params: Object.fromEntries(
      Object.entries(query).filter(([, value]) => value !== undefined && value !== ''),
    ) as Record<string, string | number | boolean>,
    timeoutMs: 15_000,
  }).then((value) => {
    if (generation.get(key) === requestGeneration) {
      cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS })
    }
    return value
  }).finally(() => {
    if (pending.get(key) === request) pending.delete(key)
  })
  pending.set(key, request)
  return structuredClone(await waitForSharedRead(request, signal))
}
