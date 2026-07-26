export function createAppStateSnapshot({
  settings,
  platform,
  version,
  edition,
  offlineEngineStart,
  offlineWarmup,
  settingsPersistence,
  historyClearPending,
  historyClearAuthorized,
  performance,
  hook,
  engine,
}) {
  return {
    settings,
    platform,
    version,
    edition,
    offlineEngineStart,
    offlineWarmup,
    settingsPersistence,
    historyClearPending: historyClearPending === true,
    historyClearAuthorized: historyClearAuthorized === true,
    performance,
    hook,
    engine,
  }
}
