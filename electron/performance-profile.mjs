const GIB = 1024 ** 3

export const PERFORMANCE_MODES = ['auto', 'fast', 'eco']

function clampInteger(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, Math.round(Number(value) || minimum)))
}

export function sanitizePerformanceMode(value) {
  return PERFORMANCE_MODES.includes(value) ? value : 'auto'
}

export function resolvePerformanceProfile({
  mode = 'auto',
  totalMemoryBytes = 8 * GIB,
  availableMemoryBytes = totalMemoryBytes,
  logicalCores = 4,
  textLength = 0,
} = {}) {
  const selectedMode = sanitizePerformanceMode(mode)
  const rawTotalMemoryBytes = Number(totalMemoryBytes)
  const memoryGb = Number.isFinite(rawTotalMemoryBytes) && rawTotalMemoryBytes > 0
    ? Math.max(1, rawTotalMemoryBytes / GIB)
    : 8
  const rawAvailableMemoryBytes = Number(availableMemoryBytes)
  const availableMemoryGb = Math.max(
    0,
    Math.min(
      memoryGb,
      Number.isFinite(rawAvailableMemoryBytes) && rawAvailableMemoryBytes >= 0
        ? rawAvailableMemoryBytes / GIB
        : 0,
    ),
  )
  const cores = clampInteger(logicalCores, 1, 128)
  const resolvedMode = selectedMode === 'auto'
    ? memoryGb <= 10 || availableMemoryGb <= 4 || cores <= 4
      ? 'eco'
      : 'balanced'
    : selectedMode

  const hardwareSummary = {
    totalMemoryGb: Math.round(memoryGb * 10) / 10,
    availableMemoryGb: Math.round(availableMemoryGb * 10) / 10,
    logicalCores: cores,
  }

  const numCtx = textLength > 4_500 ? 8192 : textLength > 1_200 ? 6144 : 4096

  if (resolvedMode === 'eco') {
    return {
      selectedMode,
      resolvedMode,
      ...hardwareSummary,
      warmOnStart: false,
      keepAlive: '3m',
      detailLevel: 'compact',
      numCtx,
      numPredict: 700,
      numThread: Math.max(1, Math.min(4, cores - 1 || 1)),
    }
  }

  if (resolvedMode === 'fast') {
    return {
      selectedMode,
      resolvedMode,
      ...hardwareSummary,
      warmOnStart: true,
      keepAlive: -1,
      detailLevel: 'full',
      numCtx,
      numPredict: 1100,
      numThread: Math.max(1, Math.min(12, cores - 1 || 1)),
    }
  }

  return {
    selectedMode,
    resolvedMode,
    ...hardwareSummary,
    warmOnStart: true,
    keepAlive: '30m',
    detailLevel: 'full',
    numCtx,
    numPredict: 900,
    numThread: Math.max(1, Math.min(6, cores - 1 || 1)),
  }
}
