/**
 * Decide what the app should do after Windows resumes from sleep.
 *
 * This function deliberately has no Electron or engine dependencies so the
 * recovery policy can be tested without starting either one.
 */
export function decideResumeRecovery({
  quitting = false,
  offlineMode = false,
  engineStarted = false,
  status = {},
} = {}) {
  if (quitting) return { action: 'ignore', reason: 'quitting' }
  if (!offlineMode) return { action: 'ignore', reason: 'not-offline-mode' }

  if (
    engineStarted === true
    && status?.online === true
    && status?.modelReady === true
  ) {
    return { action: 'healthy', reason: 'engine-ready' }
  }

  if (engineStarted !== true) return { action: 'restart', reason: 'engine-not-started' }
  if (status?.online !== true) return { action: 'restart', reason: 'engine-offline' }
  return { action: 'restart', reason: 'model-not-ready' }
}
