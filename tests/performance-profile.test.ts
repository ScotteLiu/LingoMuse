import { describe, expect, it } from 'vitest'
import {
  resolvePerformanceProfile,
  sanitizePerformanceMode,
} from '../electron/performance-profile.mjs'

const GIB = 1024 ** 3

describe('performance profiles', () => {
  it('protects an 8 GB, 4-core office computer in automatic mode', () => {
    const profile = resolvePerformanceProfile({
      mode: 'auto',
      totalMemoryBytes: 8 * GIB,
      logicalCores: 4,
      textLength: 80,
    })

    expect(profile.resolvedMode).toBe('eco')
    expect(profile.warmOnStart).toBe(false)
    expect(profile.keepAlive).toBe('3m')
    expect(profile.numThread).toBe(3)
    expect(profile.detailLevel).toBe('compact')
  })

  it('uses a balanced ceiling on a typical office computer', () => {
    const profile = resolvePerformanceProfile({
      mode: 'auto',
      totalMemoryBytes: 16 * GIB,
      availableMemoryBytes: 8 * GIB,
      logicalCores: 8,
    })

    expect(profile.resolvedMode).toBe('balanced')
    expect(profile.availableMemoryGb).toBe(8)
    expect(profile.warmOnStart).toBe(true)
    expect(profile.numThread).toBeLessThanOrEqual(6)
    expect(profile.numThread).toBeLessThan(8)
  })

  it('honors a manual speed override', () => {
    const profile = resolvePerformanceProfile({
      mode: 'fast',
      totalMemoryBytes: 8 * GIB,
      availableMemoryBytes: 2 * GIB,
      logicalCores: 4,
    })

    expect(profile.resolvedMode).toBe('fast')
    expect(profile.keepAlive).toBe(-1)
    expect(profile.warmOnStart).toBe(true)
  })

  it('protects an otherwise capable computer when available memory is low', () => {
    const profile = resolvePerformanceProfile({
      mode: 'auto',
      totalMemoryBytes: 16 * GIB,
      availableMemoryBytes: 4 * GIB,
      logicalCores: 8,
    })

    expect(profile.resolvedMode).toBe('eco')
    expect(profile.availableMemoryGb).toBe(4)
    expect(profile.warmOnStart).toBe(false)
  })

  it('raises context only for longer input and rejects unknown settings', () => {
    expect(resolvePerformanceProfile({ textLength: 100 }).numCtx).toBe(4096)
    expect(resolvePerformanceProfile({ textLength: 2_000 }).numCtx).toBe(6144)
    expect(resolvePerformanceProfile({ textLength: 8_000 }).numCtx).toBe(8192)
    expect(sanitizePerformanceMode('turbo')).toBe('auto')
  })

  it('fails safely into eco mode for invalid memory readings', () => {
    const profile = resolvePerformanceProfile({
      totalMemoryBytes: Number.POSITIVE_INFINITY,
      availableMemoryBytes: Number.NaN,
      logicalCores: 16,
    })
    expect(profile).toMatchObject({
      resolvedMode: 'eco',
      totalMemoryGb: 8,
      availableMemoryGb: 0,
      warmOnStart: false,
    })
  })
})
