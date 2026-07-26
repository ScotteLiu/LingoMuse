export const MAX_INPUT_CHARACTERS = 12_000
export const MAX_CJK_CHARACTERS = 3_000
export const MAX_ESTIMATED_INPUT_TOKENS = 5_000

const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/g

export function estimateInputTokens(text = '') {
  const value = String(text)
  const cjkCharacters = value.match(CJK_PATTERN)?.length || 0
  const otherCharacters = value.length - cjkCharacters
  return {
    cjkCharacters,
    estimatedTokens: Math.ceil(cjkCharacters * 1.5 + otherCharacters / 4),
  }
}

export function validateTranslationInput(text = '') {
  const value = String(text).trim()
  if (!value) return { ok: false, code: 'EMPTY_INPUT' }
  const estimate = estimateInputTokens(value)
  if (value.length > MAX_INPUT_CHARACTERS) {
    return { ok: false, code: 'INPUT_TOO_LONG', ...estimate }
  }
  if (
    estimate.cjkCharacters > MAX_CJK_CHARACTERS
    || estimate.estimatedTokens > MAX_ESTIMATED_INPUT_TOKENS
  ) {
    return { ok: false, code: 'INPUT_TOKEN_BUDGET', ...estimate }
  }
  return { ok: true, ...estimate }
}
