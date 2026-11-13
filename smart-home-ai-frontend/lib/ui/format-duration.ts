export function formatMilliseconds(
  value: number | null | undefined,
  fallback = '耗时未取得',
) {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return fallback
  return `${Math.round(value)} 毫秒`
}
