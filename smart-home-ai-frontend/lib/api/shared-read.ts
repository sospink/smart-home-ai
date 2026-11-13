/**
 * 只取消当前调用方对共享读请求的等待，不中止底层网络请求。
 * 适用于可缓存、可并发去重的 GET；写操作不得使用。
 */
export function waitForSharedRead<T>(request: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return request
  if (signal.aborted) return Promise.reject(new DOMException('请求已取消', 'AbortError'))

  return new Promise<T>((resolve, reject) => {
    const handleAbort = () => reject(new DOMException('请求已取消', 'AbortError'))
    signal.addEventListener('abort', handleAbort, { once: true })
    request.then(resolve, reject).finally(() => signal.removeEventListener('abort', handleAbort))
  })
}
