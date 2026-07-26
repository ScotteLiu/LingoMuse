import { describe, expect, it } from 'vitest'
import {
  CLIPBOARD_TEXT_LIMIT,
  createClipboardCapture,
  truncateClipboardText,
} from '../electron/clipboard-capture.mjs'

function captureHarness(reads: string[]) {
  let readIndex = 0
  const captured: Array<{ text: string; triggeredAt: number; immediate: boolean }> = []
  let followUp: (() => void) | null = null
  let followUpDelay = 0
  let nextHandle = 0
  const cancelledHandles: number[] = []
  const capture = createClipboardCapture({
    readText: () => reads[Math.min(readIndex++, reads.length - 1)],
    onCapture: (text: string, triggeredAt: number, { immediate }: { immediate: boolean }) => {
      captured.push({ text, triggeredAt, immediate })
    },
    schedule: (task: () => void, delay: number) => {
      followUp = task
      followUpDelay = delay
      nextHandle += 1
      return nextHandle
    },
    cancelSchedule: (handle: number) => cancelledHandles.push(handle),
  })
  return {
    capture,
    captured,
    runFollowUp: () => followUp?.(),
    followUpDelay: () => followUpDelay,
    cancelledHandles,
  }
}

describe('truncateClipboardText', () => {
  it('trims and passes normal text through', () => {
    expect(truncateClipboardText('  hello \n')).toBe('hello')
    expect(truncateClipboardText(null)).toBe('')
  })

  it('keeps one character above the limit so the length error can trigger', () => {
    const long = 'a'.repeat(CLIPBOARD_TEXT_LIMIT + 500)
    expect(truncateClipboardText(long)).toHaveLength(CLIPBOARD_TEXT_LIMIT + 1)
  })
})

describe('createClipboardCapture', () => {
  it('captures immediately when the clipboard already has the copied text', () => {
    const { capture, captured, runFollowUp } = captureHarness(['你好', '你好'])
    capture(1_000)
    expect(captured).toEqual([{ text: '你好', triggeredAt: 1_000, immediate: true }])
    runFollowUp()
    expect(captured).toHaveLength(1)
  })

  it('recovers when a slow application commits the copy after the trigger', () => {
    const { capture, captured, runFollowUp } = captureHarness(['', 'late text'])
    capture(2_000)
    expect(captured).toHaveLength(0)
    runFollowUp()
    expect(captured).toEqual([{ text: 'late text', triggeredAt: 2_000, immediate: false }])
  })

  it('corrects stale clipboard content on the follow-up read', () => {
    const { capture, captured, runFollowUp } = captureHarness(['old copy', 'fresh copy'])
    capture(3_000)
    runFollowUp()
    expect(captured.map((entry) => entry.text)).toEqual(['old copy', 'fresh copy'])
  })

  it('stays silent when the clipboard has no text at all', () => {
    const { capture, captured, runFollowUp } = captureHarness(['', '   '])
    capture(4_000)
    runFollowUp()
    expect(captured).toHaveLength(0)
  })

  it('schedules the follow-up read with the configured delay', () => {
    const { capture, followUpDelay } = captureHarness(['text'])
    capture(5_000)
    expect(followUpDelay()).toBe(160)
  })

  it('cancels a pending follow-up when a later copy event starts', () => {
    const { capture, cancelledHandles } = captureHarness(['first', 'second'])
    capture(5_000)
    expect(capture.cancelPending()).toBe(true)
    expect(cancelledHandles).toEqual([1])
    expect(capture.cancelPending()).toBe(false)
  })

  it('replaces an earlier pending follow-up when capture runs again', () => {
    const { capture, cancelledHandles } = captureHarness(['first', 'second'])
    capture(5_000)
    capture(5_100)
    expect(cancelledHandles).toEqual([1])
  })
})
