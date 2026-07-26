import { describe, expect, it } from 'vitest'
import {
  estimateInputTokens,
  MAX_INPUT_CHARACTERS,
  validateTranslationInput,
} from '../electron/input-policy.mjs'

describe('translation input policy', () => {
  it('keeps the 12,000-character allowance for compact Latin text', () => {
    expect(validateTranslationInput('a'.repeat(MAX_INPUT_CHARACTERS)).ok).toBe(true)
    expect(validateTranslationInput('a'.repeat(MAX_INPUT_CHARACTERS + 1)).code).toBe('INPUT_TOO_LONG')
  })

  it('uses a conservative CJK budget for the 8K context window', () => {
    expect(validateTranslationInput('中'.repeat(3_000)).ok).toBe(true)
    expect(validateTranslationInput('中'.repeat(3_001)).code).toBe('INPUT_TOKEN_BUDGET')
  })

  it('accounts for mixed-language input', () => {
    expect(estimateInputTokens('中文 test')).toEqual({ cjkCharacters: 2, estimatedTokens: 5 })
  })
})
