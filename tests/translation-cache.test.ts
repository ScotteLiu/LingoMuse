import { describe, expect, it } from 'vitest'
import { createTranslationCache } from '../electron/translation-cache.mjs'

describe('translation memory cache', () => {
  it('returns a repeated translation without recomputing it', () => {
    const cache = createTranslationCache(2)
    cache.set('hello', { translation: '你好' })
    expect(cache.get('hello')).toEqual({ translation: '你好' })
  })

  it('evicts the least recently used result', () => {
    const cache = createTranslationCache(2)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.get('a')
    cache.set('c', 3)
    expect(cache.get('a')).toBe(1)
    expect(cache.get('b')).toBeUndefined()
  })
})
