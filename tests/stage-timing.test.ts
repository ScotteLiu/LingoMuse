import { describe, expect, it } from 'vitest'
import { createStageTimer, STAGE_NAMES } from '../electron/stage-timing.mjs'

function collectingTimer({ enabled = true, startAt = 10_000 } = {}) {
  const lines: string[] = []
  let currentTime = startAt
  const timer = createStageTimer({
    enabled,
    log: (line: string) => lines.push(line),
    now: () => currentTime,
  })
  return {
    timer,
    lines,
    advance(byMs: number) {
      currentTime += byMs
    },
    parse(index: number) {
      return JSON.parse(lines[index].replace('LINGOMUSE_STAGE=', ''))
    },
  }
}

describe('createStageTimer', () => {
  it('logs known stages with elapsed time since the copy origin', () => {
    const { timer, lines, advance, parse } = collectingTimer()
    timer.begin(10_000)
    advance(140)
    expect(timer.mark('popup requested', { textLength: 12 })).toBe(true)
    expect(lines).toHaveLength(1)
    expect(parse(0)).toEqual({
      stage: 'popup requested',
      atMs: 10_140,
      sinceCopyMs: 140,
      textLength: 12,
    })
  })

  it('reports a null origin delta before begin is called', () => {
    const { timer, parse } = collectingTimer()
    timer.mark('model ready')
    expect(parse(0).sinceCopyMs).toBeNull()
  })

  it('ignores unknown stages', () => {
    const { timer, lines } = collectingTimer()
    expect(timer.mark('made up stage')).toBe(false)
    expect(lines).toHaveLength(0)
  })

  it('does nothing when disabled', () => {
    const { timer, lines } = collectingTimer({ enabled: false })
    timer.begin(1)
    expect(timer.mark('copy detected')).toBe(false)
    expect(lines).toHaveLength(0)
  })

  it('falls back to the clock for invalid begin timestamps', () => {
    const { timer, advance, parse } = collectingTimer()
    timer.begin(Number.NaN)
    advance(50)
    timer.mark('copy detected')
    expect(parse(0).sinceCopyMs).toBe(50)
  })

  it('covers every stage requested by the performance audit', () => {
    expect([...STAGE_NAMES]).toEqual([
      'copy detected',
      'popup requested',
      'popup visible',
      'model ready',
      'translation started',
      'first result available',
      'examples ready',
      'speech ready',
    ])
  })
})
