import { describe, expect, it } from 'vitest'
import { PRIVACY_DEFAULTS } from '../electron/privacy-defaults.mjs'

describe('new-user privacy defaults', () => {
  it('keeps the explicit double-copy gesture but does not speak or persist by default', () => {
    expect(PRIVACY_DEFAULTS).toEqual({
      autoClipboard: true,
      autoSpeak: false,
      saveHistory: false,
    })
  })
})
