import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  loadSettingsFile,
  readSettingsPayloadWithRetry,
  renameWithRetry,
  saveSettingsFile,
  SETTINGS_SCHEMA_VERSION,
} from '../electron/settings-store.mjs'

const roots: string[] = []
const defaults = { autoClipboard: true, autoSpeak: false, saveHistory: false, voiceRate: 0.92 }
const sanitize = (value: typeof defaults) => ({
  autoClipboard: value.autoClipboard === true,
  autoSpeak: value.autoSpeak === true,
  saveHistory: value.saveHistory === true,
  voiceRate: Math.max(0.6, Math.min(1.35, Number(value.voiceRate) || 0.92)),
})

function settingsPath() {
  const root = mkdtempSync(join(tmpdir(), 'lingomuse-settings-'))
  roots.push(root)
  return join(root, 'settings.json')
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('settings store', () => {
  it('migrates the legacy plain-object format', () => {
    const path = settingsPath()
    writeFileSync(path, JSON.stringify({ autoSpeak: true, saveHistory: true }))
    expect(loadSettingsFile(path, { defaults, sanitize })).toMatchObject({
      source: 'primary',
      needsMigration: true,
      settings: { autoSpeak: true, saveHistory: true },
    })
  })

  it('writes a versioned envelope and retains the previous good copy', () => {
    const path = settingsPath()
    expect(saveSettingsFile(path, defaults)).toBe(true)
    expect(saveSettingsFile(path, { ...defaults, voiceRate: 1.1 })).toBe(true)
    const current = JSON.parse(readFileSync(path, 'utf8'))
    const backup = JSON.parse(readFileSync(`${path}.bak`, 'utf8'))
    expect(current.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
    expect(current.settings.voiceRate).toBe(1.1)
    expect(backup.settings.voiceRate).toBe(0.92)
  })

  it('recovers from a truncated primary without re-enabling speech or history', () => {
    const path = settingsPath()
    expect(saveSettingsFile(path, defaults)).toBe(true)
    expect(saveSettingsFile(path, { ...defaults, voiceRate: 1.1 })).toBe(true)
    writeFileSync(path, '{"schemaVersion":1,"settings":')
    const recovered = loadSettingsFile(path, {
      defaults,
      sanitize,
      recoveryOverrides: { autoSpeak: false, saveHistory: false },
    })
    expect(recovered.source).toBe('backup')
    expect(recovered.settings).toMatchObject({ autoSpeak: false, saveHistory: false })
    expect(recovered.migrationSettings).toMatchObject({ autoSpeak: false, saveHistory: false })
  })

  it('fails closed when both copies are damaged or from an unknown future schema', () => {
    const path = settingsPath()
    writeFileSync(path, JSON.stringify({ schemaVersion: 99, settings: { autoSpeak: true } }))
    writeFileSync(`${path}.bak`, 'not json')
    expect(loadSettingsFile(path, { defaults, sanitize })).toEqual({
      source: 'unsupported',
      settings: defaults,
      writable: false,
      needsMigration: false,
    })
  })

  it('does not overwrite a future-version backup when the primary is damaged', () => {
    const path = settingsPath()
    writeFileSync(path, '{damaged')
    writeFileSync(`${path}.bak`, JSON.stringify({ schemaVersion: 99, settings: { autoSpeak: true } }))
    expect(loadSettingsFile(path, { defaults, sanitize })).toMatchObject({
      source: 'unsupported',
      writable: false,
      settings: { autoSpeak: false, saveHistory: false },
    })
  })

  it('does not fall back from a future primary to an older valid backup', () => {
    const path = settingsPath()
    const future = JSON.stringify({ schemaVersion: 99, settings: { autoSpeak: true } })
    writeFileSync(path, future)
    writeFileSync(`${path}.bak`, JSON.stringify({
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      settings: defaults,
    }))
    expect(loadSettingsFile(path, { defaults, sanitize })).toMatchObject({
      source: 'unsupported',
      writable: false,
    })
    expect(readFileSync(path, 'utf8')).toBe(future)
  })

  it('does not trust permissive values from a backup after primary corruption', () => {
    const path = settingsPath()
    saveSettingsFile(path, { ...defaults, autoSpeak: true, saveHistory: true })
    saveSettingsFile(path, { ...defaults, autoSpeak: true, saveHistory: true, voiceRate: 1.1 })
    writeFileSync(path, '{broken')
    const recovered = loadSettingsFile(path, {
      defaults,
      sanitize,
      recoveryOverrides: { autoSpeak: false, saveHistory: false },
    })
    expect(recovered.settings).toMatchObject({ autoSpeak: false, saveHistory: false })
    expect(recovered.migrationSettings).toMatchObject({ autoSpeak: true, saveHistory: true })
  })

  it('does not treat the string false as an enabled privacy setting', () => {
    const path = settingsPath()
    writeFileSync(path, JSON.stringify({ autoSpeak: 'false', saveHistory: 'false' }))
    expect(loadSettingsFile(path, { defaults, sanitize }).settings)
      .toMatchObject({ autoSpeak: false, saveHistory: false })
  })

  it('retries transient Windows rename errors without deleting the destination', () => {
    let attempts = 0
    const delays: number[] = []
    renameWithRetry('source', 'destination', {
      rename: () => {
        attempts += 1
        if (attempts < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      },
      sleep: (delay: number) => delays.push(delay),
    })
    expect(attempts).toBe(3)
    expect(delays).toEqual([25, 75])
  })

  it('retries transient Windows read locks before treating a file as damaged', () => {
    let attempts = 0
    const delays: number[] = []
    const result = readSettingsPayloadWithRetry('settings.json', {
      read: () => {
        attempts += 1
        if (attempts < 3) throw Object.assign(new Error('locked'), { code: 'EACCES' })
        return { settings: { autoSpeak: false }, legacy: false }
      },
      sleep: (delay: number) => delays.push(delay),
    })
    expect(result).toEqual({ settings: { autoSpeak: false }, legacy: false })
    expect(delays).toEqual([25, 75])
  })
})
