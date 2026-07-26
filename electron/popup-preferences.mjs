export const POPUP_MIN_OPACITY = 0.45
export const POPUP_MAX_OPACITY = 1

export function clampPopupOpacity(value, fallback = POPUP_MAX_OPACITY) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(POPUP_MIN_OPACITY, Math.min(POPUP_MAX_OPACITY, numeric))
}
