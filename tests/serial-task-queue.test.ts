import { describe, expect, it } from 'vitest'
import { createSerialTaskQueue } from '../electron/serial-task-queue.mjs'

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

describe('serial task queue', () => {
  it('never runs two inference tasks at once', async () => {
    const queue = createSerialTaskQueue()
    let running = 0
    let maximum = 0
    const task = async () => {
      running += 1
      maximum = Math.max(maximum, running)
      await wait(12)
      running -= 1
      return true
    }

    await Promise.all([
      queue.run('main', task),
      queue.run('popup', task),
      queue.run('other', task),
    ])
    expect(maximum).toBe(1)
  })

  it('cancels a queued task without disturbing another sender', async () => {
    const queue = createSerialTaskQueue()
    const first = queue.run('main', async () => {
      await wait(20)
      return 'main'
    })
    const cancelled = queue.run('popup', async () => 'old popup')
    const replacement = queue.run('popup', async () => 'new popup')

    await expect(cancelled).rejects.toMatchObject({ code: 'CANCELLED' })
    await expect(first).resolves.toBe('main')
    await expect(replacement).resolves.toBe('new popup')
  })

  it('aborts the active task for the requested sender', async () => {
    const queue = createSerialTaskQueue()
    const active = queue.run('popup', (signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    await wait(0)
    queue.cancel('popup')
    await expect(active).rejects.toMatchObject({ code: 'CANCELLED' })
    await expect(queue.whenIdle()).resolves.toBeUndefined()
    expect(queue.size).toBe(0)
  })
})
