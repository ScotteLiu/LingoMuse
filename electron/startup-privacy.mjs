export function shouldClearHistoryOnStartup({
  saveHistory,
  settingsSource,
  settingsWritable,
  historyWritable,
}) {
  return isHistoryClearPreferenceExplicit({
    saveHistory,
    settingsSource,
    settingsWritable,
  })
    && historyWritable === true
}

export function isHistoryClearPreferenceExplicit({
  saveHistory,
  settingsSource,
  settingsWritable,
}) {
  return saveHistory === false
    && settingsWritable === true
    && settingsSource === 'primary'
}

const RECOVERED_PRIVACY_KEYS = ['autoSpeak', 'saveHistory']

export function getRecoveryProtectedValues(runtimeSettings, migrationSettings) {
  if (!runtimeSettings || !migrationSettings) return null
  const protectedValues = {}
  for (const key of RECOVERED_PRIVACY_KEYS) {
    if (migrationSettings[key] !== runtimeSettings[key]) {
      protectedValues[key] = migrationSettings[key]
    }
  }
  return Object.keys(protectedValues).length ? protectedValues : null
}

export function preserveRecoveredPrivacyValues(settings, protectedValues) {
  return protectedValues ? { ...settings, ...protectedValues } : settings
}

export function releaseExplicitRecoveryPreferences(protectedValues, patch) {
  if (!protectedValues || !patch || typeof patch !== 'object') return protectedValues
  const remaining = { ...protectedValues }
  for (const key of RECOVERED_PRIVACY_KEYS) {
    if (Object.hasOwn(patch, key)) delete remaining[key]
  }
  return Object.keys(remaining).length ? remaining : null
}
