import { DEMO_RESULT, ZH_DEMO_RESULT } from './demo'
import { PRIVACY_DEFAULTS } from '../electron/privacy-defaults.mjs'
import { upsertHistory } from './history'
import type { AppSnapshot, DesktopApi, HistoryEntry, Settings } from './types'

const mockSettings: Settings = {
  ...PRIVACY_DEFAULTS,
  doubleCopyInterval: 720,
  voiceRate: 0.92,
  popupPinned: true,
  popupOpacity: 1,
  launchAtLogin: false,
  performanceMode: 'auto',
  model: 'qwen3:1.7b',
  baseUrl: 'http://127.0.0.1:11434',
}

const mockSnapshot: AppSnapshot = {
  settings: mockSettings,
  platform: 'browser',
  version: '1.0.0-preview',
  edition: 'offline',
  offlineEngineStart: { ok: true },
  settingsPersistence: { writable: true, persisted: true, reason: '' },
  historyClearPending: false,
  historyClearAuthorized: false,
  performance: {
    selectedMode: 'auto',
    resolvedMode: 'balanced',
    totalMemoryGb: 16,
    availableMemoryGb: 10,
    logicalCores: 8,
    warmOnStart: true,
    keepAlive: '30m',
    detailLevel: 'full',
    numCtx: 4096,
    numPredict: 900,
    numThread: 6,
  },
  hook: { active: true, available: true },
  engine: { online: true, modelReady: true, models: [], model: mockSettings.model },
}

const noopUnsubscribe = () => undefined
const mockPartialListeners = new Set<Parameters<DesktopApi['onTranslationPartial']>[0]>()
const mockHistoryListeners = new Set<Parameters<DesktopApi['onHistoryChanged']>[0]>()
let mockHistory: HistoryEntry[] = []
let mockHistoryRevision = 0

function emitMockHistory(): void {
  const snapshot = { revision: mockHistoryRevision, history: structuredClone(mockHistory), clearPending: false }
  for (const listener of mockHistoryListeners) listener(snapshot)
}

const mockApi: DesktopApi = {
  getState: async () => mockSnapshot,
  updateSettings: async (patch) => {
    Object.assign(mockSettings, patch)
    if (!mockSettings.saveHistory) {
      mockHistory = []
      mockHistoryRevision += 1
      emitMockHistory()
    }
    const resolvedMode = mockSettings.performanceMode === 'auto'
      ? 'balanced'
      : mockSettings.performanceMode
    Object.assign(mockSnapshot.performance, {
      selectedMode: mockSettings.performanceMode,
      resolvedMode,
      warmOnStart: resolvedMode !== 'eco',
      keepAlive: resolvedMode === 'fast' ? -1 : resolvedMode === 'eco' ? '3m' : '30m',
      detailLevel: resolvedMode === 'eco' ? 'compact' : 'full',
      numPredict: resolvedMode === 'eco' ? 700 : resolvedMode === 'fast' ? 1100 : 900,
      numThread: resolvedMode === 'eco' ? 4 : 6,
    })
    return {
      settings: mockSettings,
      settingsPersisted: true,
      settingsPersistence: mockSnapshot.settingsPersistence,
      historyClearOk: true,
      historyClearPending: false,
      performance: mockSnapshot.performance,
      engine: mockSnapshot.engine,
    }
  },
  listHistory: async () => ({ revision: mockHistoryRevision, history: structuredClone(mockHistory), clearPending: false }),
  addHistory: async (entry) => {
    if (!mockSettings.saveHistory) {
      return { ok: false, error: 'DISABLED', revision: mockHistoryRevision, history: structuredClone(mockHistory), clearPending: false }
    }
    mockHistory = upsertHistory(mockHistory, entry)
    mockHistoryRevision += 1
    emitMockHistory()
    return { ok: true, error: '', revision: mockHistoryRevision, history: structuredClone(mockHistory), clearPending: false }
  },
  importHistory: async (entries) => {
    if (!mockSettings.saveHistory) {
      return { ok: false, error: 'DISABLED', revision: mockHistoryRevision, history: structuredClone(mockHistory), clearPending: false }
    }
    for (const entry of [...entries].sort((a, b) => a.createdAt - b.createdAt)) {
      mockHistory = upsertHistory(mockHistory, entry)
    }
    mockHistoryRevision += 1
    emitMockHistory()
    return { ok: true, error: '', revision: mockHistoryRevision, history: structuredClone(mockHistory), clearPending: false }
  },
  clearHistory: async () => {
    mockHistory = []
    mockHistoryRevision += 1
    emitMockHistory()
    return { ok: true, error: '', revision: mockHistoryRevision, history: [], clearPending: false }
  },
  translate: async (text, requestId = '') => {
    const result = /[\u3400-\u9fff]/.test(text) ? ZH_DEMO_RESULT : DEMO_RESULT
    await new Promise((resolve) => setTimeout(resolve, 180))
    if (requestId) {
      for (const listener of mockPartialListeners) {
        listener({
          requestId,
          detectedLanguage: result.detectedLanguage,
          targetLanguage: result.targetLanguage,
          translation: result.translation,
          elapsedMs: 180,
        })
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 520))
    return { ok: true, result }
  },
  cancelTranslation: async () => ({ ok: true }),
  getEngineStatus: async () => mockSnapshot.engine,
  restartOfflineEngine: async () => ({
    ok: true,
    offlineEngineStart: { ok: true },
    offlineWarmup: { ok: true, elapsedMs: 800 },
    engine: mockSnapshot.engine,
  }),
  pullModel: async () => ({ ok: true }),
  openOllamaDownload: async () => undefined,
  openExternal: async () => undefined,
  minimize: async () => undefined,
  close: async () => undefined,
  popupReady: async () => null,
  closePopup: async () => undefined,
  openMainFromPopup: async () => undefined,
  setPopupHeight: async () => undefined,
  startPopupResize: async () => undefined,
  movePopupResize: async () => undefined,
  endPopupResize: async () => undefined,
  setPopupPinned: async (pinned) => ({ ok: true, pinned }),
  setPopupOpacity: async (opacity) => ({ ok: true, opacity }),
  markPerfStage: async () => false,
  onClipboardTrigger: () => noopUnsubscribe,
  onPopupResult: () => noopUnsubscribe,
  onHookStatus: () => noopUnsubscribe,
  onSettingsChanged: () => noopUnsubscribe,
  onSettingsPersistence: () => noopUnsubscribe,
  onHistoryChanged: (listener) => {
    mockHistoryListeners.add(listener)
    return () => mockHistoryListeners.delete(listener)
  },
  onModelProgress: () => noopUnsubscribe,
  onTranslationPartial: (listener) => {
    mockPartialListeners.add(listener)
    return () => mockPartialListeners.delete(listener)
  },
  onEngineState: () => noopUnsubscribe,
}

export const desktopApi = window.lingomuse ?? mockApi
export const isDesktop = Boolean(window.lingomuse)
