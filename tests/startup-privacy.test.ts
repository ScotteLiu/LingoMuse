import { describe, expect, it } from 'vitest'
import {
  getRecoveryProtectedValues,
  isHistoryClearPreferenceExplicit,
  preserveRecoveredPrivacyValues,
  releaseExplicitRecoveryPreferences,
  shouldClearHistoryOnStartup,
} from '../electron/startup-privacy.mjs'

const trustedDisabledPreference = {
  saveHistory: false,
  settingsSource: 'primary',
  settingsWritable: true,
  historyWritable: true,
}

describe('startup history privacy decision', () => {
  it('clears only when a readable primary explicitly has history disabled', () => {
    expect(shouldClearHistoryOnStartup(trustedDisabledPreference)).toBe(true)
    expect(shouldClearHistoryOnStartup({
      ...trustedDisabledPreference,
      saveHistory: true,
    })).toBe(false)
  })

  it.each(['backup', 'defaults', 'unsupported', 'unreadable'])(
    'does not erase history when settings came from %s recovery',
    (settingsSource) => {
      expect(shouldClearHistoryOnStartup({
        ...trustedDisabledPreference,
        settingsSource,
      })).toBe(false)
    },
  )

  it('does not erase a newer or temporarily unreadable history file', () => {
    expect(shouldClearHistoryOnStartup({
      ...trustedDisabledPreference,
      historyWritable: false,
    })).toBe(false)
  })

  it('separates an explicit preference from permission to overwrite history storage', () => {
    expect(isHistoryClearPreferenceExplicit(trustedDisabledPreference)).toBe(true)
    expect(isHistoryClearPreferenceExplicit({
      ...trustedDisabledPreference,
      settingsSource: 'backup',
    })).toBe(false)
  })
})

describe('backup recovery privacy persistence', () => {
  it('keeps recovered preferences on disk while runtime switches fail closed', () => {
    const runtime = { autoSpeak: false, saveHistory: false, voiceRate: 1 }
    const recovered = { autoSpeak: true, saveHistory: true, voiceRate: 0.9 }
    const protectedValues = getRecoveryProtectedValues(runtime, recovered)

    expect(protectedValues).toEqual({ autoSpeak: true, saveHistory: true })
    expect(preserveRecoveredPrivacyValues(
      { ...runtime, voiceRate: 1.1 },
      protectedValues,
    )).toMatchObject({ autoSpeak: true, saveHistory: true, voiceRate: 1.1 })
  })

  it('releases only the privacy preference explicitly changed by the user', () => {
    const protectedValues = { autoSpeak: true, saveHistory: true }
    const afterUnrelatedChange = releaseExplicitRecoveryPreferences(protectedValues, { voiceRate: 1.1 })
    expect(afterUnrelatedChange).toEqual(protectedValues)
    expect(releaseExplicitRecoveryPreferences(afterUnrelatedChange, { saveHistory: false }))
      .toEqual({ autoSpeak: true })
    expect(releaseExplicitRecoveryPreferences({ autoSpeak: true }, { autoSpeak: false }))
      .toBeNull()
  })
})
