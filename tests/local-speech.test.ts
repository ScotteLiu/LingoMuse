import { afterEach, describe, expect, it, vi } from 'vitest'
import { selectLocalSpeechVoice, waitForLocalSpeechVoice } from '../src/local-speech'

interface TestVoice {
  name: string
  lang: string
  localService: boolean
}

function voice(name: string, lang: string, localService: boolean): TestVoice {
  return { name, lang, localService }
}

describe('local speech voice selection', () => {
  afterEach(() => vi.useRealTimers())
  it('reports loading while the browser voice list is still empty', () => {
    expect(selectLocalSpeechVoice([], 'en-US')).toEqual({
      status: 'loading',
      voice: null,
    })
  })

  it('never selects a remote-only voice', () => {
    const remoteExact = voice('Remote English', 'en-US', false)

    expect(selectLocalSpeechVoice([remoteExact], 'en-US')).toEqual({
      status: 'unavailable',
      voice: null,
    })
  })

  it('prefers an exact local language tag over an earlier same-language voice', () => {
    const localBritish = voice('Local British', 'en-GB', true)
    const localAmerican = voice('Local American', 'en-US', true)

    expect(selectLocalSpeechVoice([localBritish, localAmerican], 'en-US')).toEqual({
      status: 'ready',
      voice: localAmerican,
    })
  })

  it('falls back to a local voice from the same primary language', () => {
    const remoteExact = voice('Remote American', 'en-US', false)
    const localBritish = voice('Local British', 'en-GB', true)

    expect(selectLocalSpeechVoice([remoteExact, localBritish], 'en-US')).toEqual({
      status: 'ready',
      voice: localBritish,
    })
  })

  it('does not fall back to a local voice from another language', () => {
    const localChinese = voice('Local Chinese', 'zh-TW', true)

    expect(selectLocalSpeechVoice([localChinese], 'en-US')).toEqual({
      status: 'unavailable',
      voice: null,
    })
  })

  it('normalizes language tag case and underscores', () => {
    const localAmerican = voice('Local American', 'EN_us', true)

    expect(selectLocalSpeechVoice([localAmerican], 'en-US')).toEqual({
      status: 'ready',
      voice: localAmerican,
    })
  })

  it('prefers a Traditional Chinese local voice before a Simplified fallback', () => {
    const simplified = voice('Local Simplified', 'zh-CN', true)
    const traditional = voice('Local Traditional', 'zh-Hant', true)
    expect(selectLocalSpeechVoice([simplified, traditional], 'zh-TW')).toEqual({
      status: 'ready',
      voice: traditional,
    })
  })

  function speechSource(initial: TestVoice[] = []) {
    let voices = initial
    const listeners = new Set<() => void>()
    return {
      getVoices: () => voices,
      addEventListener: (_type: 'voiceschanged', listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: 'voiceschanged', listener: () => void) => listeners.delete(listener),
      update(next: TestVoice[]) {
        voices = next
        for (const listener of listeners) listener()
      },
    }
  }

  it('waits briefly for a local voice that loads asynchronously', async () => {
    const source = speechSource()
    const pending = waitForLocalSpeechVoice(source, 'en-US')
    const local = voice('Local American', 'en-US', true)
    source.update([local])
    await expect(pending).resolves.toEqual({ status: 'ready', voice: local })
  })

  it('still rejects an asynchronously loaded remote-only voice', async () => {
    const source = speechSource()
    const pending = waitForLocalSpeechVoice(source, 'en-US')
    source.update([voice('Remote American', 'en-US', false)])
    await expect(pending).resolves.toEqual({ status: 'unavailable', voice: null })
  })

  it('stops waiting after the bounded timeout', async () => {
    vi.useFakeTimers()
    const pending = waitForLocalSpeechVoice(speechSource(), 'en-US', { timeoutMs: 50 })
    await vi.advanceTimersByTimeAsync(50)
    await expect(pending).resolves.toEqual({ status: 'unavailable', voice: null })
  })

  it('can cancel a stale voice wait before a new translation', async () => {
    const controller = new AbortController()
    const source = speechSource()
    const pending = waitForLocalSpeechVoice(source, 'en-US', { signal: controller.signal })
    controller.abort()
    source.update([voice('Late Local', 'en-US', true)])
    await expect(pending).resolves.toEqual({ status: 'unavailable', voice: null })
  })
})
