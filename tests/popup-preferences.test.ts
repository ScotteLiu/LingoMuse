import { describe, expect, it } from 'vitest'
import { clampPopupOpacity } from '../electron/popup-preferences.mjs'

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
