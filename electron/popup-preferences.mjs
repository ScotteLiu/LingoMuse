export const POPUP_MIN_OPACITY = 0.45
export const POPUP_MAX_OPACITY = 1

export function clampPopupOpacity(value, fallback = POPUP_MAX_OPACITY) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(POPUP_MIN_OPACITY, Math.min(POPUP_MAX_OPACITY, numeric))
}

// 0 means "no saved size": the popup keeps its built-in default dimensions.
export const POPUP_SIZE_AUTO = 0
const POPUP_MAX_DIMENSION = 4_000

export function sanitizePopupDimension(value, minimum) {
  const numeric = Math.round(Number(value))
  if (!Number.isFinite(numeric) || numeric <= 0) return POPUP_SIZE_AUTO
  return Math.max(minimum, Math.min(POPUP_MAX_DIMENSION, numeric))
}
