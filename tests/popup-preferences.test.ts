import { describe, expect, it } from 'vitest'
import { clampPopupOpacity, POPUP_SIZE_AUTO, sanitizePopupDimension } from '../electron/popup-preferences.mjs'
import { POPUP_MIN_HEIGHT, POPUP_MIN_WIDTH } from '../electron/popup-bounds.mjs'

describe('popup preferences', () => {
  it('accepts an opacity inside the safe range', () => {
    expect(clampPopupOpacity(0.72)).toBe(0.72)
  })

  it('keeps the popup visible at the lower boundary', () => {
    expect(clampPopupOpacity(0.1)).toBe(0.45)
  })

  it('restores full opacity for invalid values', () => {
    expect(clampPopupOpacity('not-a-number')).toBe(1)
  })
})

describe('sanitizePopupDimension', () => {
  it('keeps a saved size inside the allowed range', () => {
    expect(sanitizePopupDimension(560, POPUP_MIN_WIDTH)).toBe(560)
  })

  it('never returns a size below the popup minimum', () => {
    expect(sanitizePopupDimension(90, POPUP_MIN_HEIGHT)).toBe(POPUP_MIN_HEIGHT)
  })

  it('caps absurdly large saved sizes', () => {
    expect(sanitizePopupDimension(99_999, POPUP_MIN_WIDTH)).toBe(4_000)
  })

  it('treats missing or invalid values as automatic sizing', () => {
    expect(sanitizePopupDimension(undefined, POPUP_MIN_WIDTH)).toBe(POPUP_SIZE_AUTO)
    expect(sanitizePopupDimension('junk', POPUP_MIN_WIDTH)).toBe(POPUP_SIZE_AUTO)
    expect(sanitizePopupDimension(-20, POPUP_MIN_WIDTH)).toBe(POPUP_SIZE_AUTO)
  })
})
