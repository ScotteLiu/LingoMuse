export const CLIPBOARD_TEXT_LIMIT = 12_000

export function truncateClipboardText(text) {
  const value = String(text ?? '').trim()
  if (!value) return ''
  // Keep one character above the limit so overlong copies surface the clear
  // INPUT_TOO_LONG message instead of being silently cut off.
  return value.length > CLIPBOARD_TEXT_LIMIT ? value.slice(0, CLIPBOARD_TEXT_LIMIT + 1) : value
}

export function createClipboardCapture({
  readText,
  onCapture,
  followUpDelayMs = 160,
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
} = {}) {
  let followUpHandle = null

  function cancelPending() {
    if (followUpHandle === null || followUpHandle === undefined) return false
    cancelSchedule(followUpHandle)
    followUpHandle = null
    return true
  }

  function capture(triggeredAt) {
    cancelPending()
    const first = truncateClipboardText(readText())
    if (first) onCapture(first, triggeredAt, { immediate: true })
    followUpHandle = schedule(() => {
      followUpHandle = null
      // Slow applications may commit the copy to the clipboard after the
      // second Ctrl+C arrives; a single follow-up read corrects the popup.
      const second = truncateClipboardText(readText())
      if (!second || second === first) return
      onCapture(second, triggeredAt, { immediate: false })
    }, followUpDelayMs)
    return first
  }

  capture.cancelPending = cancelPending
  return capture
}
