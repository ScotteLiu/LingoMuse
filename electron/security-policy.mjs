const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

export function resolveTrustedDevServerUrl({ isPackaged = false, rawUrl = '' } = {}) {
  if (isPackaged || !rawUrl) return ''
  try {
    const url = new URL(String(rawUrl))
    if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) return ''
    if (url.username || url.password || !url.port) return ''
    url.hash = ''
    url.search = ''
    url.pathname = url.pathname.replace(/\/+$/, '') || '/'
    return url.href.replace(/\/$/, '')
  } catch {
    return ''
  }
}

export function normalizeLoopbackEngineUrl(value = '', fallback = 'http://127.0.0.1:11434') {
  try {
    const url = new URL(String(value).trim() || fallback)
    if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) return fallback
    if (url.username || url.password) return fallback
    url.hash = ''
    url.search = ''
    url.pathname = url.pathname.replace(/\/+$/, '')
    return url.href.replace(/\/$/, '')
  } catch {
    return fallback
  }
}

export function isAllowedRendererUrl(targetUrl, { devServerUrl = '', fileUrl = '' } = {}) {
  try {
    const target = new URL(String(targetUrl))
    if (devServerUrl) {
      const trusted = new URL(devServerUrl)
      return target.origin === trusted.origin && target.pathname === trusted.pathname
    }
    if (!fileUrl) return false
    const trustedFile = new URL(fileUrl)
    return target.protocol === 'file:'
      && target.pathname === trustedFile.pathname
      && (!target.search || target.search === '?view=popup')
  } catch {
    return false
  }
}
