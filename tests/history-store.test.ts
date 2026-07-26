import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createHistoryStore,
  HISTORY_SCHEMA_VERSION,
  readInitialHistory,
} from '../electron/history-store.mjs'
import { DEMO_RESULT, ZH_DEMO_RESULT } from '../src/demo'

const roots: string[] = []

function storePath() {
  const root = mkdtempSync(join(tmpdir(), 'lingomuse-history-'))
  roots.push(root)
  return join(root, 'history.json')
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('main-process history store', () => {
  it('serializes interleaved popup and main-window additions without losing either', () => {
    const path = storePath()
    const store = createHistoryStore(path)
    expect(store.add({ id: 'popup', source: 'popup source', result: DEMO_RESULT, createdAt: 1 }).ok).toBe(true)
    expect(store.add({ id: 'main', source: '主視窗', result: ZH_DEMO_RESULT, createdAt: 2 }).ok).toBe(true)
    expect(createHistoryStore(path).list().map((entry) => entry.id)).toEqual(['main', 'popup'])
  })

  it('imports legacy entries, deduplicates by source, and keeps the newest item', () => {
    const store = createHistoryStore(storePath())
    store.add({ id: 'new', source: 'same', result: DEMO_RESULT, createdAt: 20 })
    const result = store.import([
      { id: 'old', source: 'same', result: DEMO_RESULT, createdAt: 10 },
      { id: 'other', source: 'other', result: DEMO_RESULT, createdAt: 15 },
    ])
    expect(result.history.map((entry) => entry.id)).toEqual(['new', 'other'])
  })

  it('clears persistent history completely', () => {
    const path = storePath()
    const store = createHistoryStore(path)
    store.add({ id: 'one', source: 'source', result: DEMO_RESULT, createdAt: 1 })
    expect(store.clear().ok).toBe(true)
    expect(createHistoryStore(path).list()).toEqual([])
    expect(existsSync(path)).toBe(false)
    expect(existsSync(`${path}.bak`)).toBe(false)
  })

  it('writes a versioned envelope and can recover the previous good snapshot', () => {
    const path = storePath()
    const store = createHistoryStore(path)
    store.add({ id: 'first', source: 'first', result: DEMO_RESULT, createdAt: 1 })
    store.add({ id: 'second', source: 'second', result: DEMO_RESULT, createdAt: 2 })
    expect(JSON.parse(readFileSync(path, 'utf8')).schemaVersion).toBe(HISTORY_SCHEMA_VERSION)
    writeFileSync(path, '{truncated')
    expect(createHistoryStore(path).list().map((entry) => entry.id)).toEqual(['first'])
  })

  it('does not overwrite a history file from a newer app version', () => {
    const path = storePath()
    const future = JSON.stringify({ schemaVersion: 99, history: [] })
    writeFileSync(path, future)
    const result = createHistoryStore(path).add({
      id: 'new', source: 'new', result: DEMO_RESULT, createdAt: 1,
    })
    expect(result).toMatchObject({ ok: false, error: 'UNSUPPORTED_VERSION' })
    expect(readFileSync(path, 'utf8')).toBe(future)
  })

  it('finishes an interrupted clear before considering either copy on startup', () => {
    const path = storePath()
    const saved = JSON.stringify({
      schemaVersion: HISTORY_SCHEMA_VERSION,
      history: [{ id: 'private', source: 'private', result: DEMO_RESULT, createdAt: 1 }],
    })
    writeFileSync(path, saved)
    writeFileSync(`${path}.bak`, saved)
    writeFileSync(`${path}.clearing`, 'clear-history')
    expect(createHistoryStore(path).list()).toEqual([])
    expect(existsSync(path)).toBe(false)
    expect(existsSync(`${path}.bak`)).toBe(false)
    expect(existsSync(`${path}.clearing`)).toBe(false)
  })

  it('rejects unbounded renderer imports before sorting or writing them', () => {
    const store = createHistoryStore(storePath())
    const entries = Array.from({ length: 101 }, (_, index) => ({
      id: String(index), source: `source-${index}`, result: DEMO_RESULT, createdAt: index,
    }))
    expect(store.import(entries)).toMatchObject({ ok: false, error: 'INVALID' })
  })

  it('advances the revision when a protected failed clear changes the public snapshot', () => {
    const path = storePath()
    const store = createHistoryStore(path)
    store.add({ id: 'private', source: 'private', result: DEMO_RESULT, createdAt: 1 })
    const revisionBeforeClear = store.snapshot().revision

    // A directory cannot be erased as the backup file. The durable clearing
    // marker still protects the old data, so the visible history becomes empty
    // even though the overall clear operation must report failure.
    mkdirSync(`${path}.bak`)
    const result = store.clear()

    expect(result).toMatchObject({
      ok: false,
      error: 'CLEAR_FAILED',
      revision: revisionBeforeClear + 1,
      history: [],
      clearPending: true,
    })
    expect(existsSync(`${path}.clearing`)).toBe(true)

    rmSync(`${path}.bak`, { recursive: true, force: true })
    const afterPendingClear = store.add({ invalid: true })
    expect(afterPendingClear).toMatchObject({
      ok: false,
      error: 'INVALID',
      revision: result.revision + 1,
      history: [],
      clearPending: false,
    })
  })

  it('retries a transient primary read without falling back to a stale backup', () => {
    const path = storePath()
    writeFileSync(path, 'newest-primary-must-not-be-overwritten')
    const reads: string[] = []
    const delays: number[] = []
    const readOptions = {
      read: (candidate: string) => {
        reads.push(candidate)
        if (candidate === path) {
          throw Object.assign(new Error('busy'), { code: 'EBUSY' })
        }
        return { history: [], legacy: false }
      },
      sleep: (delay: number) => delays.push(delay),
      retryDelays: [5, 15],
    }
    const loaded = readInitialHistory(path, readOptions)

    expect(loaded).toMatchObject({ source: 'unreadable', writable: false, history: [] })
    expect(reads).toEqual([path, path, path])
    expect(delays).toEqual([5, 15])
    expect(reads).not.toContain(`${path}.bak`)

    reads.length = 0
    delays.length = 0
    const store = createHistoryStore(path, readOptions)
    expect(store.snapshot()).toMatchObject({ writable: false, reason: 'UNREADABLE' })
    expect(store.add({
      id: 'new', source: 'new', result: DEMO_RESULT, createdAt: 1,
    })).toMatchObject({ ok: false, error: 'WRITE_FAILED' })
    expect(readFileSync(path, 'utf8')).toBe('newest-primary-must-not-be-overwritten')
  })

  it('makes the store read-only when transient backup reads remain blocked', () => {
    const path = storePath()
    const reads: string[] = []
    const loaded = readInitialHistory(path, {
      read: (candidate: string) => {
        reads.push(candidate)
        if (candidate === path) throw new SyntaxError('damaged primary')
        throw Object.assign(new Error('access denied'), { code: 'EACCES' })
      },
      sleep: () => undefined,
      retryDelays: [1],
    })

    expect(loaded).toMatchObject({ source: 'unreadable', writable: false, history: [] })
    expect(reads).toEqual([path, `${path}.bak`, `${path}.bak`])
  })

  it('does not overwrite an oversized primary history file', () => {
    const path = storePath()
    writeFileSync(path, 'x'.repeat(6_000_001))
    const originalSize = statSync(path).size
    const store = createHistoryStore(path)

    expect(store.snapshot()).toMatchObject({ writable: false, reason: 'UNREADABLE' })
    expect(store.add({
      id: 'new', source: 'new', result: DEMO_RESULT, createdAt: 1,
    })).toMatchObject({ ok: false, error: 'WRITE_FAILED' })
    expect(statSync(path).size).toBe(originalSize)
    expect(readFileSync(path, 'utf8').startsWith('xxxxx')).toBe(true)
  })
})
