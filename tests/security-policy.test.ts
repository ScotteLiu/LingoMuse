import { describe, expect, it } from 'vitest'
import {
  isAllowedRendererUrl,
  normalizeLoopbackEngineUrl,
  resolveTrustedDevServerUrl,
} from '../electron/security-policy.mjs'

describe('desktop security policy', () => {
  it('ignores renderer overrides in packaged builds', () => {
    expect(resolveTrustedDevServerUrl({
      isPackaged: true,
      rawUrl: 'https://attacker.example',
    })).toBe('')
  })

  it('only accepts an explicit loopback HTTP development origin', () => {
    expect(resolveTrustedDevServerUrl({ rawUrl: 'http://127.0.0.1:5173/' }))
      .toBe('http://127.0.0.1:5173')
    expect(resolveTrustedDevServerUrl({ rawUrl: 'https://127.0.0.1:5173' })).toBe('')
    expect(resolveTrustedDevServerUrl({ rawUrl: 'http://127.0.0.1.attacker.test:5173' })).toBe('')
    expect(resolveTrustedDevServerUrl({ rawUrl: 'http://localhost.attacker.test:5173' })).toBe('')
  })

  it('keeps engine requests on loopback', () => {
    expect(normalizeLoopbackEngineUrl('http://localhost:11434///'))
      .toBe('http://localhost:11434')
    expect(normalizeLoopbackEngineUrl('https://api.example.test/v1'))
      .toBe('http://127.0.0.1:11434')
  })

  it('allows only the exact application page and popup query', () => {
    const options = { fileUrl: 'file:///C:/LingoMuse/dist/index.html' }
    expect(isAllowedRendererUrl('file:///C:/LingoMuse/dist/index.html', options)).toBe(true)
    expect(isAllowedRendererUrl('file:///C:/LingoMuse/dist/index.html?view=popup', options)).toBe(true)
    expect(isAllowedRendererUrl('file:///C:/Users/Public/evil.html', options)).toBe(false)
  })
})
