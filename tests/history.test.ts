import { describe, expect, it } from 'vitest'
import { DEMO_RESULT } from '../src/demo'
import { HISTORY_KEY, readHistory, upsertHistory, writeHistory } from '../src/history'
import type { HistoryEntry } from '../src/types'

function entry(id: string, source = `source-${id}`): HistoryEntry {
  return { id, source, result: DEMO_RESULT, createdAt: Date.now() }
}

describe('local translation history', () => {
  it('drops malformed or incompatible saved entries', () => {
    const storage = {
      getItem: () => JSON.stringify([
        entry('valid'),
        { id: 'broken', source: 'bad', createdAt: Date.now(), result: { translation: 'missing fields' } },
      ]),
    }
    expect(readHistory(storage)).toEqual([expect.objectContaining({ id: 'valid' })])
  })

  it('deduplicates repeated source text', () => {
    expect(upsertHistory([entry('old', 'same')], entry('new', 'same')).map((item) => item.id))
      .toEqual(['new'])
  })

  it('reduces retained entries when browser storage is nearly full', () => {
    let saved = ''
    const storage = {
      setItem: (key: string, value: string) => {
        expect(key).toBe(HISTORY_KEY)
        if (value.length > 1_000) throw new Error('QuotaExceededError')
        saved = value
      },
    }
    expect(writeHistory(storage, Array.from({ length: 20 }, (_, index) => entry(String(index))))).toBe(true)
    expect(JSON.parse(saved).length).toBeLessThan(20)
  })
})
