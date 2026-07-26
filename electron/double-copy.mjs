export function createDoubleCopyDetector({ interval = 720, minimumGap = 80 } = {}) {
  let lastCopyAt = 0

  return {
    noteCopy(now = Date.now()) {
      const gap = now - lastCopyAt
      lastCopyAt = now
      if (gap >= minimumGap && gap <= interval) {
        lastCopyAt = 0
        return true
      }
      return false
    },
    reset() {
      lastCopyAt = 0
    },
    setInterval(nextInterval) {
      interval = Math.max(300, Math.min(1500, Number(nextInterval) || 720))
    },
  }
}
