export const STAGE_NAMES = new Set([
  'copy detected',
  'popup requested',
  'popup visible',
  'model ready',
  'translation started',
  'first result available',
  'examples ready',
  'speech ready',
])

export function createStageTimer({ enabled = false, log = console.log, now = Date.now } = {}) {
  let originAt = 0
  return {
    get enabled() {
      return enabled
    },
    begin(timestamp) {
      if (!enabled) return
      const numeric = Number(timestamp)
      originAt = Number.isFinite(numeric) && numeric > 0 ? numeric : now()
    },
    mark(stage, meta) {
      if (!enabled || !STAGE_NAMES.has(stage)) return false
      const atMs = now()
      log(`LINGOMUSE_STAGE=${JSON.stringify({
        stage,
        atMs,
        sinceCopyMs: originAt ? Math.max(0, atMs - originAt) : null,
        ...(meta && typeof meta === 'object' ? meta : {}),
      })}`)
      return true
    },
  }
}
