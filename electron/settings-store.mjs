import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'

export const SETTINGS_SCHEMA_VERSION = 1
const MAX_SETTINGS_FILE_BYTES = 512_000

function readSettingsPayload(path) {
  if (statSync(path).size > MAX_SETTINGS_FILE_BYTES) {
    throw Object.assign(new Error('SETTINGS_FILE_TOO_LARGE'), { code: 'SETTINGS_FILE_TOO_LARGE' })
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('INVALID_SETTINGS')
  if (!('schemaVersion' in parsed)) return { settings: parsed, legacy: true }
  if (parsed.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    const error = new Error('UNSUPPORTED_SETTINGS_VERSION')
    error.code = 'UNSUPPORTED_SETTINGS_VERSION'
    throw error
  }
  if (!parsed.settings || typeof parsed.settings !== 'object' || Array.isArray(parsed.settings)) {
    throw new Error('INVALID_SETTINGS_ENVELOPE')
  }
  return { settings: parsed.settings, legacy: false }
}

const TRANSIENT_FILE_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY'])

export function readSettingsPayloadWithRetry(path, {
  read = readSettingsPayload,
  sleep = waitMilliseconds,
  retryDelays = [25, 75, 150],
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return read(path)
    } catch (error) {
      if (!TRANSIENT_FILE_ERRORS.has(error?.code) || attempt >= retryDelays.length) throw error
      sleep(retryDelays[attempt])
    }
  }
}

function containsReadableJsonObject(path) {
  try {
    readSettingsPayload(path)
    return true
  } catch {
    return false
  }
}

export function loadSettingsFile(path, { defaults, sanitize, recoveryOverrides = {} }) {
  const backupPath = `${path}.bak`
  try {
    const primary = readSettingsPayloadWithRetry(path)
    return {
      settings: sanitize({ ...defaults, ...primary.settings }),
      source: 'primary',
      writable: true,
      needsMigration: primary.legacy,
    }
  } catch (error) {
    if (error?.code === 'UNSUPPORTED_SETTINGS_VERSION') {
      return {
        settings: sanitize({ ...defaults, ...recoveryOverrides }),
        source: 'unsupported',
        writable: false,
        needsMigration: false,
      }
    }
    if (TRANSIENT_FILE_ERRORS.has(error?.code) || error?.code === 'SETTINGS_FILE_TOO_LARGE') {
      return {
        settings: sanitize({ ...defaults, ...recoveryOverrides }),
        source: 'unreadable',
        writable: false,
        needsMigration: false,
      }
    }
  }

  for (const candidate of [backupPath]) {
    try {
      const recovered = readSettingsPayloadWithRetry(candidate)
      const migrationSettings = sanitize({ ...defaults, ...recovered.settings })
      const settings = sanitize({ ...migrationSettings, ...recoveryOverrides })
      return {
        settings,
        migrationSettings,
        source: 'backup',
        writable: true,
        needsMigration: true,
      }
    } catch (error) {
      if (error?.code === 'UNSUPPORTED_SETTINGS_VERSION') {
        return {
          settings: sanitize({ ...defaults, ...recoveryOverrides }),
          source: 'unsupported',
          writable: false,
          needsMigration: false,
        }
      }
      if (TRANSIENT_FILE_ERRORS.has(error?.code) || error?.code === 'SETTINGS_FILE_TOO_LARGE') {
        return {
          settings: sanitize({ ...defaults, ...recoveryOverrides }),
          source: 'unreadable',
          writable: false,
          needsMigration: false,
        }
      }
      // Try the last-known-good copy before falling back to privacy-safe defaults.
    }
  }
  return {
    settings: sanitize({ ...defaults, ...recoveryOverrides }),
    source: 'defaults',
    writable: true,
    needsMigration: false,
  }
}

function waitMilliseconds(milliseconds) {
  if (milliseconds <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

export function renameWithRetry(source, destination, {
  rename = renameSync,
  sleep = waitMilliseconds,
  retryDelays = [25, 75, 150],
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rename(source, destination)
      return
    } catch (error) {
      const retryable = ['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)
      if (!retryable || attempt >= retryDelays.length) throw error
      sleep(retryDelays[attempt])
    }
  }
}

function flushFile(path) {
  // Windows cannot flush a descriptor opened read-only (EINVAL). Open the
  // private temporary copy for writing so it is durable before the rename.
  const descriptor = openSync(path, 'r+')
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

export function saveSettingsFile(path, settings) {
  const backupPath = `${path}.bak`
  const suffix = `${process.pid}-${randomUUID()}`
  const temporaryPath = `${path}.tmp-${suffix}`
  const backupTemporaryPath = `${backupPath}.tmp-${suffix}`
  try {
    writeFileSync(temporaryPath, JSON.stringify({
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      settings,
    }, null, 2), { encoding: 'utf8', flush: true })

    if (existsSync(path) && containsReadableJsonObject(path)) {
      try {
        copyFileSync(path, backupTemporaryPath)
        flushFile(backupTemporaryPath)
        renameWithRetry(backupTemporaryPath, backupPath)
      } catch {
        try {
          if (existsSync(backupTemporaryPath)) unlinkSync(backupTemporaryPath)
        } catch {
          // Preserve the previous backup when refreshing it fails.
        }
      }
    }
    renameWithRetry(temporaryPath, path)
    return true
  } catch (error) {
    try {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
      if (existsSync(backupTemporaryPath)) unlinkSync(backupTemporaryPath)
    } catch {
      // A failed cleanup is harmless; the .tmp file is never read as settings.
    }
    return { ok: false, error: String(error?.message || error) }
  }
}
