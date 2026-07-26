import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  containsOfflineModel,
  startOfflineEngine,
  stopBundledProcessesAsync,
  warmOfflineModel,
} from '../electron/bundled-engine.mjs'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('bundled engine identity', () => {
  it('accepts the bundled model with or without the latest tag', () => {
    expect(containsOfflineModel([{ name: 'qwen3:1.7b' }])).toBe(true)
    expect(containsOfflineModel([{ model: 'qwen3:1.7b:latest' }])).toBe(true)
  })

  it('does not reuse an unrelated service on the offline port', () => {
    expect(containsOfflineModel([{ name: 'llama3.2:latest' }])).toBe(false)
    expect(containsOfflineModel([])).toBe(false)
  })

  it('reports a port conflict instead of sending text to an unrelated local engine', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      models: [{ name: 'unrelated-model:latest' }],
    }), { status: 200 })))

    await expect(startOfflineEngine({
      available: true,
      enginePath: 'unused.exe',
      modelsPath: 'unused-models',
    })).resolves.toEqual({ ok: false, error: 'OFFLINE_PORT_IN_USE' })
  })

  it('also refuses an existing service that advertises the expected model', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      models: [{ name: 'qwen3:1.7b' }],
    }), { status: 200 })))

    await expect(startOfflineEngine({
      available: true,
      enginePath: 'unused.exe',
      modelsPath: 'unused-models',
    })).resolves.toEqual({ ok: false, error: 'OFFLINE_PORT_IN_USE' })
  })

  it('turns an asynchronous spawn failure into a recoverable result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      killed: false,
      kill: vi.fn(() => true),
      unref: vi.fn(),
    })
    const resultPromise = startOfflineEngine({
      available: true,
      enginePath: 'missing.exe',
      modelsPath: 'unused-models',
    }, {
      timeoutMs: 500,
      spawnProcess: () => {
        queueMicrotask(() => child.emit('error', new Error('access denied')))
        return child
      },
    })
    await expect(resultPromise).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('ENGINE_SPAWN_ERROR'),
    })
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('stops a spawned engine before reporting startup timeout', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      killed: false,
      kill: vi.fn(() => true),
      unref: vi.fn(),
    })
    const pending = startOfflineEngine({
      available: true,
      enginePath: 'ollama.exe',
      modelsPath: 'models',
    }, {
      timeoutMs: 1,
      cleanupProcesses: async () => true,
      spawnProcess: () => child,
    })

    await vi.advanceTimersByTimeAsync(250)
    await expect(pending).resolves.toEqual({ ok: false, error: 'ENGINE_START_TIMEOUT' })
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('does not spawn an engine after its lifecycle was cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(startOfflineEngine({
      available: true,
      enginePath: 'unused.exe',
      modelsPath: 'unused-models',
    }, { signal: controller.signal })).resolves.toEqual({
      ok: false,
      error: 'ENGINE_START_CANCELLED',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not probe or spawn when cleanup cannot confirm that it exited', async () => {
    const fetchMock = vi.fn()
    const engineSpawn = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(startOfflineEngine({
      available: true,
      root: 'bundled-runtime',
      enginePath: 'ollama.exe',
      modelsPath: 'models',
    }, {
      cleanupProcesses: async () => false,
      spawnProcess: engineSpawn,
    })).resolves.toEqual({ ok: false, error: 'ENGINE_CLEANUP_TIMEOUT' })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(engineSpawn).not.toHaveBeenCalled()
  })

  it('kills a timed-out cleanup and fails closed when exit is not confirmed', async () => {
    vi.useFakeTimers()
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) })
    const pending = stopBundledProcessesAsync('C:\\bundled-runtime', {
      platform: 'win32',
      timeoutMs: 20,
      exitGraceMs: 30,
      spawnProcess: () => child,
    })

    let settled = false
    void pending.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(20)
    expect(child.kill).toHaveBeenCalledOnce()
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(29)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toBe(false)
  })

  it('continues only after a killed cleanup confirms its exit', async () => {
    vi.useFakeTimers()
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) })
    const pending = stopBundledProcessesAsync('C:\\bundled-runtime', {
      platform: 'win32',
      timeoutMs: 20,
      exitGraceMs: 30,
      spawnProcess: () => child,
    })

    await vi.advanceTimersByTimeAsync(20)
    expect(child.kill).toHaveBeenCalledOnce()
    child.emit('exit', 1)
    await expect(pending).resolves.toBe(true)
  })

  it('waits for cleanup exit after cancellation and never spawns the engine', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const cleanupChild = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) })
    const engineSpawn = vi.fn()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const pending = startOfflineEngine({
      available: true,
      root: 'C:\\bundled-runtime',
      enginePath: 'ollama.exe',
      modelsPath: 'models',
    }, {
      signal: controller.signal,
      spawnProcess: engineSpawn,
      cleanupProcesses: (root, { signal }) => stopBundledProcessesAsync(root, {
        signal,
        platform: 'win32',
        timeoutMs: 1_000,
        exitGraceMs: 30,
        spawnProcess: () => cleanupChild,
      }),
    })

    let settled = false
    void pending.then(() => { settled = true })
    controller.abort()
    expect(cleanupChild.kill).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(29)
    expect(settled).toBe(false)

    cleanupChild.emit('close', 0)
    await expect(pending).resolves.toEqual({ ok: false, error: 'ENGINE_START_CANCELLED' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(engineSpawn).not.toHaveBeenCalled()
  })

  it('aborts a long model warmup during suspend or application exit', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn((_url, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })))
    const pending = warmOfflineModel({ timeoutMs: 5_000, signal: controller.signal })
    controller.abort()
    await expect(pending).resolves.toMatchObject({ ok: false, error: expect.stringContaining('aborted') })
  })
})
