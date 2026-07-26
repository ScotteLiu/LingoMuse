import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { renameWithRetry } from './settings-store.mjs'

export const HISTORY_SCHEMA_VERSION = 1
const MAX_HISTORY_ENTRIES = 50
const MAX_HISTORY_IMPORT_ENTRIES = 100
const MAX_HISTORY_JSON_CHARACTERS = 1_500_000
const MAX_HISTORY_FILE_BYTES = 6_000_000
const TRANSIENT_FILE_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY'])

function isString(value) {
  return typeof value === 'string'
}

function isBoundedString(value, maximum, { allowEmpty = true } = {}) {
  return isString(value) && value.length <= maximum && (allowEmpty || value.trim().length > 0)
}

export function isHistoryTranslationResult(value) {
  return value && typeof value === 'object'
    && ['zh', 'en'].includes(value.detectedLanguage)
    && ['zh', 'en'].includes(value.targetLanguage)
    && value.detectedLanguage !== value.targetLanguage
    && isBoundedString(value.translation, 12_000, { allowEmpty: false })
    && isBoundedString(value.literalMeaning, 8_000)
    && isBoundedString(value.naturalnessNote, 8_000)
    && value.pronunciation
    && isBoundedString(value.pronunciation.text, 12_000)
    && isBoundedString(value.pronunciation.ipa, 2_000)
    && Array.isArray(value.alternatives) && value.alternatives.length <= 3
    && value.alternatives.every((item) => isBoundedString(item?.text, 8_000) && isBoundedString(item?.label, 200))
    && Array.isArray(value.examples) && value.examples.length <= 3
    && value.examples.every((item) => isBoundedString(item?.source, 8_000) && isBoundedString(item?.target, 8_000) && isBoundedString(item?.note, 2_000))
    && Array.isArray(value.usageTips) && value.usageTips.length <= 3
    && value.usageTips.every((item) => isBoundedString(item, 2_000))
    && Array.isArray(value.keywords) && value.keywords.length <= 5
    && value.keywords.every((item) => isBoundedString(item?.term, 500) && isBoundedString(item?.meaning, 2_000))
}

export function isHistoryEntry(value) {
  if (!(value && typeof value === 'object'
    && isBoundedString(value.id, 120, { allowEmpty: false })
    && isBoundedString(value.source, 12_000, { allowEmpty: false })
    && Number.isFinite(value.createdAt)
    && isHistoryTranslationResult(value.result))) return false
  try {
    return JSON.stringify(value).length <= 200_000
  } catch {
    return false
  }
}

function fitHistory(entries) {
  const deduplicated = []
  const seenSources = new Set()
  for (const entry of entries.filter(isHistoryEntry).sort((a, b) => b.createdAt - a.createdAt)) {
    if (seenSources.has(entry.source)) continue
    const candidate = [...deduplicated, entry]
    if (JSON.stringify(candidate).length > MAX_HISTORY_JSON_CHARACTERS) break
    seenSources.add(entry.source)
    deduplicated.push(entry)
    if (deduplicated.length >= MAX_HISTORY_ENTRIES) break
  }
  return deduplicated
}

function unsupportedVersionError() {
  return Object.assign(new Error('UNSUPPORTED_HISTORY_VERSION'), { code: 'UNSUPPORTED_HISTORY_VERSION' })
}

function historyFileTooLargeError() {
  return Object.assign(new Error('HISTORY_FILE_TOO_LARGE'), { code: 'HISTORY_FILE_TOO_LARGE' })
}

function readHistoryPayload(path) {
  if (statSync(path).size > MAX_HISTORY_FILE_BYTES) throw historyFileTooLargeError()
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  if (Array.isArray(parsed)) return { history: fitHistory(parsed), legacy: true }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('INVALID_HISTORY')
  if (parsed.schemaVersion !== HISTORY_SCHEMA_VERSION) throw unsupportedVersionError()
  if (!Array.isArray(parsed.history)) throw new Error('INVALID_HISTORY_ENVELOPE')
  return { history: fitHistory(parsed.history), legacy: false }
}

export function readHistoryPayloadWithRetry(path, {
  read = readHistoryPayload,
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

function isUnreadableHistoryError(error) {
  return TRANSIENT_FILE_ERRORS.has(error?.code) || error?.code === 'HISTORY_FILE_TOO_LARGE'
}

export function readInitialHistory(path, readOptions = {}) {
  if (existsSync(`${path}.clearing`)) {
    const clearing = completeHistoryClear(path)
    return {
      history: [],
      source: 'clearing',
      writable: true,
      legacy: false,
      clearPending: !clearing.ok,
    }
  }
  try {
    const primary = readHistoryPayloadWithRetry(path, readOptions)
    return { ...primary, source: 'primary', writable: true }
  } catch (error) {
    if (error?.code === 'UNSUPPORTED_HISTORY_VERSION') {
      return { history: [], source: 'unsupported', writable: false, legacy: false }
    }
    if (isUnreadableHistoryError(error)) {
      return { history: [], source: 'unreadable', writable: false, legacy: false }
    }
  }

  try {
    const backup = readHistoryPayloadWithRetry(`${path}.bak`, readOptions)
    return { ...backup, source: 'backup', writable: true, legacy: true }
  } catch (error) {
    if (error?.code === 'UNSUPPORTED_HISTORY_VERSION') {
      return { history: [], source: 'unsupported', writable: false, legacy: false }
    }
    if (isUnreadableHistoryError(error)) {
      return { history: [], source: 'unreadable', writable: false, legacy: false }
    }
  }

  return { history: [], source: 'empty', writable: true, legacy: false }
}

function historyEnvelope(history) {
  return JSON.stringify({ schemaVersion: HISTORY_SCHEMA_VERSION, history })
}

function flushFile(path) {
  const descriptor = openSync(path, 'r+')
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

function isReadableHistory(path) {
  try {
    readHistoryPayload(path)
    return true
  } catch {
    return false
  }
}

function writeHistoryFile(path, history) {
  const suffix = `${process.pid}-${randomUUID()}`
  const temporaryPath = `${path}.tmp-${suffix}`
  const backupPath = `${path}.bak`
  const backupTemporaryPath = `${backupPath}.tmp-${suffix}`
  try {
    writeFileSync(temporaryPath, historyEnvelope(history), { encoding: 'utf8', flush: true })
    if (existsSync(path) && isReadableHistory(path)) {
      try {
        copyFileSync(path, backupTemporaryPath)
        flushFile(backupTemporaryPath)
        renameWithRetry(backupTemporaryPath, backupPath)
      } catch {
        try {
          if (existsSync(backupTemporaryPath)) unlinkSync(backupTemporaryPath)
        } catch {
          // The previous known-good backup remains untouched.
        }
      }
    }
    renameWithRetry(temporaryPath, path)
    return true
  } catch {
    try {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
      if (existsSync(backupTemporaryPath)) unlinkSync(backupTemporaryPath)
    } catch {
      // Unique temporary files are never considered history on startup.
    }
    return false
  }
}

function waitMilliseconds(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function unlinkWithRetry(path, retryDelays = [25, 75, 150]) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      if (existsSync(path)) unlinkSync(path)
      return true
    } catch (error) {
      if (!TRANSIENT_FILE_ERRORS.has(error?.code) || attempt >= retryDelays.length) return false
      waitMilliseconds(retryDelays[attempt])
    }
  }
}

function eraseHistoryFile(path) {
  if (!existsSync(path)) return true
  const temporaryPath = `${path}.erase-${process.pid}-${randomUUID()}`
  try {
    writeFileSync(temporaryPath, historyEnvelope([]), { encoding: 'utf8', flush: true })
    renameWithRetry(temporaryPath, path)
    // Failure to remove an already-empty envelope is not a privacy failure.
    unlinkWithRetry(path)
    return true
  } catch {
    try {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
    } catch {
      // Fall through and try deleting the original directly.
    }
    return unlinkWithRetry(path)
  }
}

function completeHistoryClear(path) {
  const markerPath = `${path}.clearing`
  if (!existsSync(path) && !existsSync(`${path}.bak`)) {
    return { ok: unlinkWithRetry(markerPath), protected: true }
  }
  try {
    // Existence of this durable marker makes startup fail closed even if the
    // process or computer stops between clearing the primary and its backup.
    writeFileSync(markerPath, 'clear-history', { encoding: 'utf8', flush: true })
  } catch {
    return { ok: false, protected: false }
  }

  const primaryCleared = eraseHistoryFile(path)
  const backupCleared = eraseHistoryFile(`${path}.bak`)
  if (!primaryCleared || !backupCleared) return { ok: false, protected: true }
  const markerCleared = unlinkWithRetry(markerPath)
  return { ok: markerCleared, protected: true }
}

function cloneHistory(history) {
  return structuredClone(history)
}

export function createHistoryStore(path, readOptions = {}) {
  const loaded = readInitialHistory(path, readOptions)
  let history = loaded.history
  let writable = loaded.writable
  let clearPending = loaded.clearPending === true
  let revision = 0
  const readOnlyError = loaded.source === 'unsupported' ? 'UNSUPPORTED_VERSION' : 'WRITE_FAILED'
  const readOnlyReason = loaded.source === 'unsupported'
    ? 'UNSUPPORTED_VERSION'
    : loaded.writable ? '' : 'UNREADABLE'

  const snapshot = () => ({
    revision,
    history: cloneHistory(history),
    clearPending,
    writable,
    reason: writable ? '' : readOnlyReason,
  })
  const failure = (error) => ({ ok: false, error, ...snapshot() })

  return {
    list() {
      return cloneHistory(history)
    },
    snapshot,
    add(entry) {
      if (!writable) return failure(readOnlyError)
      let completedPendingClear = false
      if (clearPending) {
        const clearing = completeHistoryClear(path)
        clearPending = !clearing.ok
        if (clearPending) return failure('CLEAR_PENDING')
        completedPendingClear = true
      }
      if (!isHistoryEntry(entry)) {
        if (completedPendingClear) revision += 1
        return failure('INVALID')
      }
      const next = fitHistory([entry, ...history])
      if (!writeHistoryFile(path, next)) {
        if (completedPendingClear) revision += 1
        return failure('WRITE_FAILED')
      }
      history = next
      revision += 1
      return { ok: true, error: '', ...snapshot() }
    },
    import(entries) {
      if (!writable) return failure(readOnlyError)
      let completedPendingClear = false
      if (clearPending) {
        const clearing = completeHistoryClear(path)
        clearPending = !clearing.ok
        if (clearPending) return failure('CLEAR_PENDING')
        completedPendingClear = true
      }
      if (
        !Array.isArray(entries)
        || entries.length > MAX_HISTORY_IMPORT_ENTRIES
        || !entries.every(isHistoryEntry)
      ) {
        if (completedPendingClear) revision += 1
        return failure('INVALID')
      }
      const next = fitHistory([...history, ...entries])
      if (!writeHistoryFile(path, next)) {
        if (completedPendingClear) revision += 1
        return failure('WRITE_FAILED')
      }
      history = next
      revision += 1
      return { ok: true, error: '', ...snapshot() }
    },
    clear() {
      const previousClearPending = clearPending
      const previouslyVisibleHistory = history.length > 0
      const clearing = completeHistoryClear(path)
      clearPending = !clearing.ok
      if (clearing.protected) history = []
      if (!clearing.ok) {
        if (
          previousClearPending !== clearPending
          || previouslyVisibleHistory !== (history.length > 0)
        ) revision += 1
        return failure('CLEAR_FAILED')
      }
      writable = true
      revision += 1
      return { ok: true, error: '', ...snapshot() }
    },
  }
}
