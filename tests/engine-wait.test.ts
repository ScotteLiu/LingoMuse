import { describe, expect, it } from 'vitest'
import { waitForEngineReady } from '../electron/engine-wait.mjs'

interface HarnessOptions {
  ready?: boolean
  starting?: boolean
  timeoutMs?: number
  signal?: AbortSignal
}

function waiterHarness({ ready = false, starting = true, timeoutMs = 30_000, signal }: HarnessOptions = {}) {
  const state = { ready, starting }
  let currentTime = 0
  const pending: Array<() => void> = []
  const promise = waitForEngineReady({
    isReady: () => state.ready,
    isStarting: () => state.starting,
    signal,
    timeoutMs,
    intervalMs: 150,
    setTimeoutFn: ((task: () => void) => {
      pending.push(task)
      return pending.length
    }) as unknown as typeof setTimeout,
    clearTimeoutFn: (() => undefined) as unknown as typeof clearTimeout,
    now: () => currentTime,
  })
  return {
    state,
    promise,
    tick(elapsedMs: number) {
      currentTime += elapsedMs
      const task = pending.shift()
      task?.()
    },
  }
}

describe('waitForEngineReady', () => {
  it('resolves immediately when the engine is already ready', async () => {
    const { promise } = waiterHarness({ ready: true })
    await expect(promise).resolves.toBe(true)
  })

  it('polls until the engine start completes', async () => {
    const harness = waiterHarness()
    harness.tick(150)
    harness.state.ready = true
    harness.tick(150)
    await expect(harness.promise).resolves.toBe(true)
  })

  it('gives up as soon as the engine start fails', async () => {
    const harness = waiterHarness()
    harness.state.starting = false
    harness.tick(150)
    await expect(harness.promise).resolves.toBe(false)
  })

  it('gives up after the timeout budget', async () => {
    const harness = waiterHarness({ timeoutMs: 400 })
    harness.tick(150)
    harness.tick(150)
    harness.tick(150)
    await expect(harness.promise).resolves.toBe(false)
  })

  it('stops waiting when the request is cancelled', async () => {
    const controller = new AbortController()
    const harness = waiterHarness({ signal: controller.signal })
    controller.abort()
    await expect(harness.promise).resolves.toBe(false)
  })

  it('resolves false without polling for an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const { promise } = waiterHarness({ signal: controller.signal, ready: true })
    await expect(promise).resolves.toBe(false)
  })
})
