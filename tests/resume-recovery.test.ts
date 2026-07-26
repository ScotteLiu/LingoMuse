import { describe, expect, it } from 'vitest'
import { decideResumeRecovery } from '../electron/resume-recovery.mjs'

describe('resume recovery policy', () => {
  it('ignores resume work while the application is quitting', () => {
    expect(decideResumeRecovery({
      quitting: true,
      offlineMode: true,
      engineStarted: false,
      status: { online: false, modelReady: false },
    })).toEqual({ action: 'ignore', reason: 'quitting' })
  })

  it('ignores the bundled-engine recovery path outside offline mode', () => {
    expect(decideResumeRecovery({
      quitting: false,
      offlineMode: false,
      engineStarted: false,
      status: { online: false, modelReady: false },
    })).toEqual({ action: 'ignore', reason: 'not-offline-mode' })
  })

  it('leaves a started, online and model-ready engine alone', () => {
    expect(decideResumeRecovery({
      quitting: false,
      offlineMode: true,
      engineStarted: true,
      status: { online: true, modelReady: true },
    })).toEqual({ action: 'healthy', reason: 'engine-ready' })
  })

  it.each([
    {
      name: 'the engine never started',
      engineStarted: false,
      status: { online: true, modelReady: true },
      reason: 'engine-not-started',
    },
    {
      name: 'the engine is offline',
      engineStarted: true,
      status: { online: false, modelReady: false },
      reason: 'engine-offline',
    },
    {
      name: 'the model is not ready',
      engineStarted: true,
      status: { online: true, modelReady: false },
      reason: 'model-not-ready',
    },
    {
      name: 'health status is unavailable',
      engineStarted: true,
      status: undefined,
      reason: 'engine-offline',
    },
  ])('requests a restart when $name', ({ engineStarted, status, reason }) => {
    expect(decideResumeRecovery({
      quitting: false,
      offlineMode: true,
      engineStarted,
      status,
    })).toEqual({ action: 'restart', reason })
  })
})
