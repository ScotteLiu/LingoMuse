export function waitForEngineReady({
  isReady,
  isStarting,
  signal,
  timeoutMs = 30_000,
  intervalMs = 150,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  now = Date.now,
} = {}) {
  return new Promise((resolve) => {
    const startedAt = now()
    let timer = null
    let settled = false

    const finish = (ready) => {
      if (settled) return
      settled = true
      if (timer) clearTimeoutFn(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(ready)
    }
    const onAbort = () => finish(false)

    const check = () => {
      timer = null
      if (isReady()) return finish(true)
      if (!isStarting()) return finish(false)
      if (now() - startedAt >= timeoutMs) return finish(false)
      timer = setTimeoutFn(check, intervalMs)
    }

    if (signal?.aborted) return finish(false)
    signal?.addEventListener('abort', onAbort, { once: true })
    check()
  })
}
