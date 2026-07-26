import { describe, expect, it } from 'vitest'
import { createAppStateSnapshot } from '../electron/app-state-snapshot.mjs'

describe('desktop app state snapshot', () => {
  it('carries startup history-clear authorization to the renderer', () => {
    const snapshot = createAppStateSnapshot({
      settings: { saveHistory: false },
      platform: 'win32',
      version: 'test',
      edition: 'offline',
      offlineEngineStart: { ok: false },
      offlineWarmup: { ok: false },
      settingsPersistence: { writable: true, persisted: true, reason: '' },
      historyClearPending: false,
      historyClearAuthorized: true,
      performance: {},
      hook: { active: false, available: false },
      engine: { online: false, modelReady: false, models: [], model: 'test' },
    })

    expect(snapshot.historyClearAuthorized).toBe(true)
    expect(snapshot.historyClearPending).toBe(false)
  })
})
