import { describe, expect, it } from 'vitest'
import { createDoubleCopyDetector } from '../electron/double-copy.mjs'

describe('double-copy detector', () => {
  it('triggers on the second copy within the configured interval', () => {
    const detector = createDoubleCopyDetector({ interval: 720 })
    expect(detector.noteCopy(1_000)).toBe(false)
    expect(detector.noteCopy(1_500)).toBe(true)
  })

  it('ignores an expired second copy', () => {
    const detector = createDoubleCopyDetector({ interval: 720 })
    expect(detector.noteCopy(1_000)).toBe(false)
    expect(detector.noteCopy(1_800)).toBe(false)
  })

  it('filters keyboard repeat noise and resets after a valid pair', () => {
    const detector = createDoubleCopyDetector({ interval: 720, minimumGap: 80 })
    expect(detector.noteCopy(1_000)).toBe(false)
    expect(detector.noteCopy(1_030)).toBe(false)
    expect(detector.noteCopy(1_450)).toBe(true)
    expect(detector.noteCopy(1_700)).toBe(false)
  })

  it('clamps the live interval update', () => {
    const detector = createDoubleCopyDetector({ interval: 720 })
    detector.setInterval(100)
    expect(detector.noteCopy(1_000)).toBe(false)
    expect(detector.noteCopy(1_350)).toBe(false)
  })
})
