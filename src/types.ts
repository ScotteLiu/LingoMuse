export type LanguageCode = 'zh' | 'en'
export type PerformanceMode = 'auto' | 'fast' | 'eco'

export interface TranslationResult {
  detectedLanguage: LanguageCode
  targetLanguage: LanguageCode
  translation: string
  literalMeaning: string
  naturalnessNote: string
  pronunciation: {
    text: string
    ipa: string
  }
  alternatives: Array<{
    text: string
    label: string
  }>
  examples: Array<{
    source: string
    target: string
    note: string
  }>
  usageTips: string[]
  keywords: Array<{
    term: string
    meaning: string
  }>
}

export interface Settings {
  autoClipboard: boolean
  autoSpeak: boolean
  doubleCopyInterval: number
  voiceRate: number
  popupPinned: boolean
  popupOpacity: number
  popupWidth: number
  popupHeight: number
  launchAtLogin: boolean
  saveHistory: boolean
  performanceMode: PerformanceMode
  model: string
  baseUrl: string
}

export interface EngineModel {
  name: string
  size: number
  parameterSize: string
}

export interface EngineStatus {
  online: boolean
  modelReady: boolean
  models: EngineModel[]
  model: string
}

export interface HookStatus {
  active: boolean
  available: boolean
  error?: string
}

export interface PerformanceProfile {
  selectedMode: PerformanceMode
  resolvedMode: 'balanced' | 'fast' | 'eco'
  totalMemoryGb: number
  availableMemoryGb: number
  logicalCores: number
  warmOnStart: boolean
  keepAlive: number | string
  detailLevel: 'full' | 'compact'
  numCtx: number
  numPredict: number
  numThread: number
}

export interface SettingsPersistence {
  writable: boolean
  persisted: boolean
  reason: string
}

export interface AppSnapshot {
  settings: Settings
  platform: string
  version: string
  edition: 'light' | 'offline'
  offlineEngineStart?: { ok: boolean; error?: string; starting?: boolean }
  offlineWarmup?: { ok: boolean; error?: string; elapsedMs?: number; skipped?: boolean; reason?: string }
  settingsPersistence: SettingsPersistence
  historyClearPending: boolean
  historyClearAuthorized: boolean
  performance: PerformanceProfile
  hook: HookStatus
  engine: EngineStatus
}

export interface HistoryEntry {
  id: string
  source: string
  result: TranslationResult
  createdAt: number
}

export interface HistorySnapshot {
  revision: number
  history: HistoryEntry[]
  clearPending: boolean
  writable?: boolean
  reason?: '' | 'UNREADABLE' | 'UNSUPPORTED_VERSION'
}

export interface HistoryMutation extends HistorySnapshot {
  ok: boolean
  error: '' | 'DISABLED' | 'INVALID' | 'WRITE_FAILED' | 'CLEAR_FAILED' | 'CLEAR_PENDING' | 'UNSUPPORTED_VERSION'
}

export interface ModelProgress {
  status: string
  percent: number
  completed: number
  total: number
}

export interface DesktopApi {
  getState: () => Promise<AppSnapshot>
  updateSettings: (patch: Partial<Settings>) => Promise<{
    settings: Settings
    settingsPersisted: boolean
    settingsPersistence: SettingsPersistence
    historyClearOk: boolean
    historyClearPending: boolean
    historySnapshot?: HistorySnapshot
    performance: PerformanceProfile
    engine: EngineStatus
  }>
  listHistory: () => Promise<HistorySnapshot>
  addHistory: (entry: HistoryEntry) => Promise<HistoryMutation>
  importHistory: (entries: HistoryEntry[]) => Promise<HistoryMutation>
  clearHistory: () => Promise<HistoryMutation>
  translate: (text: string, requestId?: string) => Promise<
    | { ok: true; result: TranslationResult }
    | { ok: false; error: string; code: string }
  >
  cancelTranslation: () => Promise<{ ok: boolean }>
  getEngineStatus: () => Promise<EngineStatus>
  restartOfflineEngine: () => Promise<{
    ok: boolean
    error?: string
    offlineEngineStart?: AppSnapshot['offlineEngineStart']
    offlineWarmup?: AppSnapshot['offlineWarmup']
    engine: EngineStatus
  }>
  pullModel: (model: string) => Promise<{ ok: boolean; error?: string }>
  openOllamaDownload: () => Promise<unknown>
  openExternal: (url: string) => Promise<unknown>
  minimize: () => Promise<unknown>
  close: () => Promise<unknown>
  popupReady: () => Promise<{
    payload: { text: string; timestamp: number } | null
    settings: Settings
    edition: 'light' | 'offline'
  } | null>
  closePopup: () => Promise<unknown>
  openMainFromPopup: (payload?: { source: string; result: TranslationResult | null }) => Promise<unknown>
  setPopupHeight: (height: number) => Promise<unknown>
  startPopupResize: (payload: { direction: string; x: number; y: number }) => Promise<unknown>
  movePopupResize: (payload: { x: number; y: number }) => Promise<unknown>
  endPopupResize: () => Promise<unknown>
  setPopupPinned: (pinned: boolean) => Promise<{ ok: boolean; pinned?: boolean; persisted?: boolean }>
  setPopupOpacity: (opacity: number, persist?: boolean) => Promise<{ ok: boolean; opacity?: number; persisted?: boolean }>
  markPerfStage: (stage: string) => Promise<boolean>
  onClipboardTrigger: (listener: (payload: { text: string; timestamp: number }) => void) => () => void
  onPopupResult: (listener: (payload: { source: string; result: TranslationResult }) => void) => () => void
  onHookStatus: (listener: (payload: HookStatus) => void) => () => void
  onSettingsChanged: (listener: (settings: Settings) => void) => () => void
  onSettingsPersistence: (listener: (status: SettingsPersistence) => void) => () => void
  onHistoryChanged: (listener: (snapshot: HistorySnapshot) => void) => () => void
  onModelProgress: (listener: (payload: ModelProgress) => void) => () => void
  onTranslationPartial: (listener: (payload: {
    requestId: string
    detectedLanguage: LanguageCode
    targetLanguage: LanguageCode
    translation: string
    elapsedMs: number
  }) => void) => () => void
  onEngineState: (listener: (payload: {
    engine: EngineStatus
    performance?: PerformanceProfile
    offlineEngineStart?: AppSnapshot['offlineEngineStart']
    offlineWarmup?: AppSnapshot['offlineWarmup']
  }) => void) => () => void
}

declare global {
  interface Window {
    lingomuse?: DesktopApi
  }
}
