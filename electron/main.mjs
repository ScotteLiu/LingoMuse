import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  powerMonitor,
  screen,
  shell,
  Tray,
} from 'electron'
import { existsSync } from 'node:fs'
import { availableParallelism, freemem, totalmem } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createDoubleCopyDetector } from './double-copy.mjs'
import {
  calculatePopupResizeBounds,
  POPUP_MIN_HEIGHT,
  POPUP_MIN_WIDTH,
} from './popup-bounds.mjs'
import { clampPopupOpacity, sanitizePopupDimension } from './popup-preferences.mjs'
import { createClipboardCapture } from './clipboard-capture.mjs'
import { createStageTimer } from './stage-timing.mjs'
import {
  getOfflineBundle,
  OFFLINE_BASE_URL,
  OFFLINE_MODEL,
  startOfflineEngine,
  stopOfflineEngine,
  unloadOfflineModel,
  warmOfflineModel,
} from './bundled-engine.mjs'
import {
  resolvePerformanceProfile,
  sanitizePerformanceMode,
} from './performance-profile.mjs'
import { normalizeBaseUrl, translateWithOllama } from './translation.mjs'
import { createTranslationCache } from './translation-cache.mjs'
import { PRIVACY_DEFAULTS } from './privacy-defaults.mjs'
import { loadSettingsFile, saveSettingsFile } from './settings-store.mjs'
import { createHistoryStore } from './history-store.mjs'
import { validateTranslationInput } from './input-policy.mjs'
import { createSerialTaskQueue } from './serial-task-queue.mjs'
import { decideResumeRecovery } from './resume-recovery.mjs'
import { createAppStateSnapshot } from './app-state-snapshot.mjs'
import {
  getRecoveryProtectedValues,
  isHistoryClearPreferenceExplicit,
  preserveRecoveredPrivacyValues,
  releaseExplicitRecoveryPreferences,
  shouldClearHistoryOnStartup,
} from './startup-privacy.mjs'
import {
  isAllowedRendererUrl,
  normalizeLoopbackEngineUrl,
  resolveTrustedDevServerUrl,
} from './security-policy.mjs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const rootDir = join(__dirname, '..')
const packagedEntryUrl = pathToFileURL(join(rootDir, 'dist', 'index.html')).href
const devServerUrl = resolveTrustedDevServerUrl({
  isPackaged: app.isPackaged,
  rawUrl: process.env.VITE_DEV_SERVER_URL,
})
const allowTestOverrides = !app.isPackaged
const isSmokeTest = allowTestOverrides && process.env.LINGOMUSE_SMOKE_TEST === '1'
const isOfflineIntegrationTest = allowTestOverrides && process.env.LINGOMUSE_OFFLINE_INTEGRATION_TEST === '1'
const isPopupIntegrationTest = allowTestOverrides && process.env.LINGOMUSE_POPUP_INTEGRATION_TEST === '1'
const offlineBundle = getOfflineBundle(process.resourcesPath, { allowOverride: allowTestOverrides })
const edition = offlineBundle.available ? 'offline' : 'light'
let offlineEngineStart = { ok: false, error: '' }
let offlineWarmup = { ok: false, error: '' }

const DEFAULT_SETTINGS = {
  ...PRIVACY_DEFAULTS,
  doubleCopyInterval: 720,
  voiceRate: 0.92,
  popupPinned: true,
  popupOpacity: 1,
  popupWidth: 0,
  popupHeight: 0,
  launchAtLogin: false,
  performanceMode: 'auto',
  model: 'qwen3:1.7b',
  baseUrl: 'http://127.0.0.1:11434',
}

let mainWindow = null
let popupWindow = null
let pendingPopupPayload = null
let popupRendererReady = false
let popupResizeSession = null
let popupUserResized = false
let tray = null
let keyboardHook = null
let hookStarted = false
let isQuitting = false
let settings = { ...DEFAULT_SETTINGS }
let settingsFileWritable = true
let settingsFileReadOnlyReason = ''
let settingsPersistence = { writable: true, persisted: true, reason: '' }
let settingsRecoveryProtectedValues = null
let historyStore = null
let historyClearPending = false
let startupHistoryClearAuthorized = false
const inferenceQueue = createSerialTaskQueue()
const translationCache = createTranslationCache(24)
let pullInProgress = false
let pendingModelUnload = false
let engineLifecycle = Promise.resolve()
let engineLifecycleGeneration = 0
let engineLifecycleController = new AbortController()
let engineStatusEpoch = 0
let engineStatusInFlight = null
let cachedEngineStatus = {
  online: false,
  modelReady: false,
  models: [],
  model: DEFAULT_SETTINGS.model,
}
let resumeRecoveryTimer = null
let resumeRecoveryGeneration = 0
const doubleCopy = createDoubleCopyDetector({ interval: DEFAULT_SETTINGS.doubleCopyInterval })
const stageTimer = createStageTimer({ enabled: process.env.LINGOMUSE_TIMING === '1' })
const captureClipboard = createClipboardCapture({
  readText: () => clipboard.readText(),
  onCapture: (text, triggeredAt) => showClipboardPopup(text, triggeredAt),
})
const hardware = {
  totalMemoryBytes: totalmem(),
  availableMemoryBytes: freemem(),
  logicalCores: availableParallelism(),
}

function getPerformanceProfile(textLength = 0) {
  return resolvePerformanceProfile({
    mode: settings.performanceMode,
    ...hardware,
    textLength,
  })
}

const settingsPath = () => join(app.getPath('userData'), 'settings.json')
const historyPath = () => join(app.getPath('userData'), 'history.json')

function loadSettings() {
  const loaded = loadSettingsFile(settingsPath(), {
    defaults: DEFAULT_SETTINGS,
    sanitize: sanitizeSettings,
    recoveryOverrides: { autoSpeak: false, saveHistory: false },
  })
  settings = loaded.settings
  settingsRecoveryProtectedValues = loaded.source === 'backup'
    ? getRecoveryProtectedValues(loaded.settings, loaded.migrationSettings)
    : null
  settingsFileWritable = loaded.writable
  settingsFileReadOnlyReason = loaded.writable
    ? ''
    : loaded.source === 'unreadable' ? 'UNREADABLE' : 'UNSUPPORTED_VERSION'
  settingsPersistence = loaded.writable
    ? settingsRecoveryProtectedValues
      ? { writable: true, persisted: false, reason: 'RECOVERED_BACKUP' }
      : { writable: true, persisted: true, reason: '' }
    : { writable: false, persisted: false, reason: settingsFileReadOnlyReason }
  if (edition === 'offline') {
    settings.model = OFFLINE_MODEL
    settings.baseUrl = OFFLINE_BASE_URL
  }
  invalidateEngineStatus()
  doubleCopy.setInterval(settings.doubleCopyInterval)
  if (loaded.needsMigration) {
    const migrationSettings = { ...(loaded.migrationSettings ?? settings) }
    if (edition === 'offline') {
      migrationSettings.model = OFFLINE_MODEL
      migrationSettings.baseUrl = OFFLINE_BASE_URL
    }
    saveSettings(migrationSettings)
  }
  return loaded
}

function saveSettings(settingsToPersist = settings) {
  if (!settingsFileWritable) {
    console.warn('Settings file belongs to a newer app version; changes will remain in memory only.')
    settingsPersistence = { writable: false, persisted: false, reason: settingsFileReadOnlyReason || 'UNSUPPORTED_VERSION' }
    broadcastSettingsPersistence()
    return false
  }
  const persistedSettings = preserveRecoveredPrivacyValues(
    settingsToPersist,
    settingsRecoveryProtectedValues,
  )
  const saved = saveSettingsFile(settingsPath(), persistedSettings)
  if (saved !== true) console.error('Unable to save local settings:', saved.error)
  settingsPersistence = saved === true
    ? settingsRecoveryProtectedValues
      ? { writable: true, persisted: false, reason: 'RECOVERED_BACKUP' }
      : { writable: true, persisted: true, reason: '' }
    : { writable: true, persisted: false, reason: 'WRITE_FAILED' }
  broadcastSettingsPersistence()
  return saved === true && !settingsRecoveryProtectedValues
}

function sanitizeSettings(value) {
  return {
    autoClipboard: value.autoClipboard === true,
    autoSpeak: value.autoSpeak === true,
    doubleCopyInterval: Math.max(300, Math.min(1500, Number(value.doubleCopyInterval) || 720)),
    voiceRate: Math.max(0.6, Math.min(1.35, Number(value.voiceRate) || 0.92)),
    popupPinned: value.popupPinned === true,
    popupOpacity: clampPopupOpacity(value.popupOpacity),
    popupWidth: sanitizePopupDimension(value.popupWidth, POPUP_MIN_WIDTH),
    popupHeight: sanitizePopupDimension(value.popupHeight, POPUP_MIN_HEIGHT),
    launchAtLogin: value.launchAtLogin === true,
    saveHistory: value.saveHistory === true,
    performanceMode: sanitizePerformanceMode(value.performanceMode),
    model: String(value.model || DEFAULT_SETTINGS.model).slice(0, 120),
    baseUrl: normalizeLoopbackEngineUrl(value.baseUrl),
  }
}

function allowRendererNavigation(event, url) {
  if (isAllowedRendererUrl(url, { devServerUrl, fileUrl: packagedEntryUrl })) return
  event.preventDefault()
}

function requireTrustedSender(event, allowedRoles = ['main', 'popup']) {
  const window = BrowserWindow.fromWebContents(event.sender)
  const role = window === mainWindow ? 'main' : window === popupWindow ? 'popup' : ''
  if (!allowedRoles.includes(role)) throw new Error('UNTRUSTED_RENDERER')
  return role
}

function createWindow() {
  const { workAreaSize } = screen.getPrimaryDisplay()
  mainWindow = new BrowserWindow({
    width: Math.max(640, Math.min(1460, workAreaSize.width - 32)),
    height: Math.max(360, Math.min(920, workAreaSize.height - 24)),
    minWidth: 640,
    minHeight: 360,
    show: false,
    frame: false,
    backgroundColor: '#f2f0e9',
    icon: getIconPath(),
    title: 'LingoMuse 靈譯',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.once('ready-to-show', () => {
    if (!isSmokeTest) mainWindow?.show()
  })
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
      if (Notification.isSupported()) {
        new Notification({
          title: 'LingoMuse 仍在背景運作',
          body: '連按兩次 Ctrl+C 仍可喚醒翻譯；可從系統匣完全結束。',
          silent: true,
        }).show()
      }
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    allowRendererNavigation(event, url)
  })

  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl)
  } else {
    mainWindow.loadFile(join(rootDir, 'dist', 'index.html'))
  }
}

function createPopupWindow() {
  popupRendererReady = false
  popupResizeSession = null
  popupUserResized = false
  const { workAreaSize } = screen.getPrimaryDisplay()
  const savedWidth = sanitizePopupDimension(settings.popupWidth, POPUP_MIN_WIDTH)
  const savedHeight = sanitizePopupDimension(settings.popupHeight, POPUP_MIN_HEIGHT)
  popupUserResized = savedWidth > 0 || savedHeight > 0
  popupWindow = new BrowserWindow({
    width: Math.min(savedWidth || 468, workAreaSize.width),
    height: Math.min(savedHeight || 248, workAreaSize.height),
    minWidth: POPUP_MIN_WIDTH,
    minHeight: POPUP_MIN_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: settings.popupPinned,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    icon: getIconPath(),
    title: 'LingoMuse 雙擊快譯',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  popupWindow.setAlwaysOnTop(settings.popupPinned, 'floating')
  popupWindow.setOpacity(settings.popupOpacity)
  popupWindow.on('will-resize', () => {
    popupUserResized = true
  })
  popupWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  popupWindow.webContents.on('will-navigate', (event, url) => {
    allowRendererNavigation(event, url)
  })
  popupWindow.on('closed', () => {
    popupWindow = null
    popupRendererReady = false
    popupResizeSession = null
  })

  if (devServerUrl) {
    popupWindow.loadURL(`${devServerUrl}?view=popup`)
  } else {
    popupWindow.loadFile(join(rootDir, 'dist', 'index.html'), { query: { view: 'popup' } })
  }
}

function positionPopupWindow() {
  if (!popupWindow) return
  const point = screen.getCursorScreenPoint()
  const { workArea } = screen.getDisplayNearestPoint(point)
  const [width, height] = popupWindow.getSize()
  const preferredX = point.x + 18
  const preferredY = point.y + 18
  const x = Math.max(workArea.x + 12, Math.min(preferredX, workArea.x + workArea.width - width - 12))
  const y = Math.max(workArea.y + 12, Math.min(preferredY, workArea.y + workArea.height - height - 12))
  popupWindow.setPosition(Math.round(x), Math.round(y), false)
}

function deliverPopupPayload() {
  if (!popupWindow || !pendingPopupPayload || !popupRendererReady || popupWindow.webContents.isLoadingMainFrame()) return
  positionPopupWindow()
  safeSend(popupWindow, 'clipboard:trigger', pendingPopupPayload)
  pendingPopupPayload = null
  popupWindow.showInactive()
  stageTimer.mark('popup visible')
}

function showClipboardPopup(text, timestamp = Date.now()) {
  stageTimer.mark('popup requested', { textLength: text.length })
  pendingPopupPayload = { text, timestamp }
  if (!popupWindow || popupWindow.isDestroyed()) createPopupWindow()
  deliverPopupPayload()
}

function getIconPath() {
  const ico = join(rootDir, 'build', 'icon.ico')
  const png = join(rootDir, 'build', 'icon.png')
  return existsSync(ico) ? ico : png
}

function createTray() {
  tray?.destroy()
  let icon = nativeImage.createFromPath(getIconPath())
  if (icon.isEmpty()) icon = nativeImage.createEmpty()
  tray = new Tray(icon.resize({ width: 18, height: 18 }))
  tray.setToolTip('LingoMuse 靈譯 — 連按兩次 Ctrl+C 快速翻譯')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '開啟 LingoMuse', click: showWindow },
      {
        label: settings.autoClipboard ? '暫停雙擊複製' : '啟用雙擊複製',
        click: () => {
          settings.autoClipboard = !settings.autoClipboard
          saveSettings()
          safeSend(popupWindow, 'settings:changed', settings)
          safeSend(mainWindow, 'settings:changed', settings)
          createTray()
          sendHookStatus()
        },
      },
      { type: 'separator' },
      {
        label: '完全結束',
        click: () => {
          isQuitting = true
          app.quit()
        },
      },
    ]),
  )
  tray.on('double-click', showWindow)
}

function showWindow() {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

async function startKeyboardHook() {
  try {
    const { uIOhook, UiohookKey } = await import('uiohook-napi')
    keyboardHook = uIOhook
    keyboardHook.on('keydown', (event) => {
      if (!settings.autoClipboard) return
      const isCopy = event.keycode === UiohookKey.C && (event.ctrlKey || event.metaKey)
      if (!isCopy || !doubleCopy.noteCopy(Date.now())) return

      const triggeredAt = Date.now()
      stageTimer.begin(triggeredAt)
      stageTimer.mark('copy detected')
      captureClipboard(triggeredAt)
    })
    keyboardHook.start()
    hookStarted = true
    sendHookStatus()
  } catch (error) {
    hookStarted = false
    console.error('Global keyboard hook failed:', error)
    sendHookStatus(String(error?.message || error))
  }
}

function sendHookStatus(error = '') {
  safeSend(mainWindow, 'hook:status', {
    active: hookStarted && settings.autoClipboard,
    available: hookStarted,
    error,
  })
}

function broadcastEngineState(engine = cachedEngineStatus) {
  cachedEngineStatus = engine
  const payload = {
    engine,
    offlineEngineStart,
    offlineWarmup,
    performance: getPerformanceProfile(),
  }
  safeSend(mainWindow, 'engine:state', payload)
  safeSend(popupWindow, 'engine:state', payload)
}

function safeSend(window, channel, payload) {
  try {
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(channel, payload)
      return true
    }
  } catch (error) {
    console.warn(`Unable to send ${channel}:`, error)
  }
  return false
}

function broadcastSettingsPersistence() {
  safeSend(mainWindow, 'settings:persistence', settingsPersistence)
  safeSend(popupWindow, 'settings:persistence', settingsPersistence)
}

function broadcastHistory() {
  const snapshot = currentHistorySnapshot()
  // A renderer reload must never turn a successful disk commit into failure.
  safeSend(mainWindow, 'history:changed', snapshot)
}

function currentHistorySnapshot() {
  return {
    ...(historyStore?.snapshot() ?? { revision: 0, history: [], clearPending: historyClearPending }),
    clearPending: historyClearPending,
  }
}

function serializeEngineLifecycle(task) {
  const operation = engineLifecycle.catch(() => undefined).then(task)
  engineLifecycle = operation.catch(() => undefined)
  return operation
}

function supersedeEngineLifecycle() {
  engineLifecycleController.abort()
  engineLifecycleController = new AbortController()
  engineLifecycleGeneration += 1
  return {
    generation: engineLifecycleGeneration,
    signal: engineLifecycleController.signal,
  }
}

function isLifecycleTokenCurrent(token) {
  return !isQuitting
    && token?.generation === engineLifecycleGeneration
    && !token.signal.aborted
}

function offlineStatus() {
  return { online: false, modelReady: false, models: [], model: settings.model }
}

function invalidateEngineStatus(status = offlineStatus()) {
  engineStatusEpoch += 1
  engineStatusInFlight = null
  cachedEngineStatus = status
  return status
}

function recordTranslationEngineFailure(code) {
  if (code !== 'ENGINE_OFFLINE' && code !== 'MODEL_NOT_FOUND') return
  const engine = code === 'ENGINE_OFFLINE'
    ? invalidateEngineStatus(offlineStatus())
    : invalidateEngineStatus({
        ...cachedEngineStatus,
        online: true,
        modelReady: false,
        model: settings.model,
      })
  if (edition === 'offline') {
    const error = code === 'ENGINE_OFFLINE' ? 'ENGINE_OFFLINE' : 'OFFLINE_MODEL_MISSING'
    offlineEngineStart = { ok: false, error }
    offlineWarmup = { ok: false, error }
  }
  broadcastEngineState(engine)
}

function clearResumeRecoveryTimer() {
  if (!resumeRecoveryTimer) return
  clearTimeout(resumeRecoveryTimer)
  resumeRecoveryTimer = null
}

function handleSystemSuspend() {
  resumeRecoveryGeneration += 1
  supersedeEngineLifecycle()
  clearResumeRecoveryTimer()
  inferenceQueue.cancelAll()
}

function handleSystemResume() {
  if (isQuitting || edition !== 'offline') return
  const generation = ++resumeRecoveryGeneration
  clearResumeRecoveryTimer()
  const token = supersedeEngineLifecycle()
  resumeRecoveryTimer = setTimeout(() => {
    resumeRecoveryTimer = null
    void serializeEngineLifecycle(async () => {
      if (!isLifecycleTokenCurrent(token) || generation !== resumeRecoveryGeneration) return
      hardware.availableMemoryBytes = freemem()
      const status = await engineStatus()
      if (!isLifecycleTokenCurrent(token) || generation !== resumeRecoveryGeneration) return
      const decision = decideResumeRecovery({
        quitting: isQuitting,
        offlineMode: edition === 'offline',
        engineStarted: offlineEngineStart.ok,
        status,
      })
      if (decision.action === 'healthy' || decision.action === 'ignore') {
        if (getPerformanceProfile().resolvedMode === 'eco' && inferenceQueue.size === 0) {
          await unloadOfflineModel({ signal: token.signal })
          if (!isLifecycleTokenCurrent(token) || generation !== resumeRecoveryGeneration) return
          offlineWarmup = { ok: true, skipped: true, reason: 'eco' }
        }
        if (!isLifecycleTokenCurrent(token) || generation !== resumeRecoveryGeneration) return
        broadcastEngineState(status)
        return decision
      }
      if (!isLifecycleTokenCurrent(token) || generation !== resumeRecoveryGeneration) return
      return restartOfflineEngineNow(token)
    }).catch((error) => {
      if (!isLifecycleTokenCurrent(token) || generation !== resumeRecoveryGeneration) return
      console.error('Unable to recover the offline engine after resume:', error)
      broadcastEngineState(invalidateEngineStatus(offlineStatus()))
    })
  }, 1_500)
}

async function engineStatus() {
  const epoch = engineStatusEpoch
  if (engineStatusInFlight?.epoch === epoch) return engineStatusInFlight.promise
  const baseUrl = normalizeBaseUrl(settings.baseUrl)
  const model = settings.model
  const promise = (async () => {
    let status
    try {
      const response = await fetch(`${baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(1_200),
      })
      if (!response.ok) throw new Error(`status_${response.status}`)
      const data = await response.json()
      const models = Array.isArray(data.models)
        ? data.models.map((item) => ({
            name: item.name || item.model,
            size: item.size || 0,
            parameterSize: item.details?.parameter_size || '',
          }))
        : []
      const wanted = model.toLowerCase()
      const modelReady = models.some((item) => {
        const name = String(item.name).toLowerCase()
        return name === wanted || name === `${wanted}:latest`
      })
      status = { online: true, modelReady, models, model }
    } catch {
      status = { online: false, modelReady: false, models: [], model }
    }
    if (epoch !== engineStatusEpoch) return cachedEngineStatus
    cachedEngineStatus = status
    return status
  })().finally(() => {
    if (engineStatusInFlight?.epoch === epoch) engineStatusInFlight = null
  })
  engineStatusInFlight = { epoch, promise }
  return promise
}

async function pullModel(model) {
  if (pullInProgress) return { ok: false, error: 'PULL_IN_PROGRESS' }
  pullInProgress = true
  try {
    const response = await fetch(`${normalizeBaseUrl(settings.baseUrl)}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
    })
    if (!response.ok || !response.body) {
      const payload = await response.json().catch(() => ({}))
      throw new Error(payload.error || `下載失敗 (${response.status})`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.trim()) continue
        const progress = JSON.parse(line)
        const percent = progress.total
          ? Math.min(100, Math.round((progress.completed / progress.total) * 100))
          : progress.status === 'success'
            ? 100
            : 0
        safeSend(mainWindow, 'engine:pull-progress', {
          status: progress.status || '下載中',
          percent,
          completed: progress.completed || 0,
          total: progress.total || 0,
        })
      }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  } finally {
    pullInProgress = false
  }
}

function cancelledEngineLifecycleResult({
  error = isQuitting ? 'APP_QUITTING' : 'ENGINE_LIFECYCLE_CANCELLED',
  mutated = false,
} = {}) {
  if (!mutated) {
    return {
      ok: false,
      error,
      offlineEngineStart,
      offlineWarmup,
      engine: cachedEngineStatus,
    }
  }

  stopOfflineEngine()
  const engine = invalidateEngineStatus(offlineStatus())
  offlineEngineStart = { ok: false, error }
  offlineWarmup = { ok: false, error }
  return { ok: false, error, offlineEngineStart, offlineWarmup, engine }
}

async function restartOfflineEngineNow(token) {
  let mutated = false
  if (!isLifecycleTokenCurrent(token)) return cancelledEngineLifecycleResult()
  if (edition !== 'offline') {
    return { ok: false, error: 'OFFLINE_EDITION_REQUIRED', engine: await engineStatus() }
  }

  inferenceQueue.cancelAll()
  await inferenceQueue.whenIdle()
  if (!isLifecycleTokenCurrent(token)) return cancelledEngineLifecycleResult()

  mutated = true
  pendingModelUnload = false
  stopOfflineEngine()
  invalidateEngineStatus(offlineStatus())
  if (!isLifecycleTokenCurrent(token)) return cancelledEngineLifecycleResult({ mutated })
  offlineWarmup = { ok: false, error: '' }
  offlineEngineStart = { ok: false, starting: true, error: '' }
  broadcastEngineState(cachedEngineStatus)
  const engineStart = await startOfflineEngine(offlineBundle, { signal: token.signal })
  if (!isLifecycleTokenCurrent(token)) {
    return cancelledEngineLifecycleResult({ mutated })
  }
  offlineEngineStart = engineStart
  invalidateEngineStatus(offlineStatus())

  if (offlineEngineStart.ok) {
    hardware.availableMemoryBytes = freemem()
    const performance = getPerformanceProfile()
    const warmup = performance.warmOnStart
      ? await warmOfflineModel({
          keepAlive: performance.keepAlive,
          numCtx: performance.numCtx,
          numThread: performance.numThread,
          signal: token.signal,
        })
      : { ok: true, skipped: true, reason: 'eco' }
    if (!isLifecycleTokenCurrent(token)) {
      return cancelledEngineLifecycleResult({ mutated })
    }
    offlineWarmup = warmup
    if (warmup.ok) stageTimer.mark('model ready', { skipped: warmup.skipped === true })
  }

  const engine = await engineStatus()
  if (!isLifecycleTokenCurrent(token)) {
    return cancelledEngineLifecycleResult({ mutated })
  }
  const result = {
    ok: offlineEngineStart.ok,
    error: offlineEngineStart.error || offlineWarmup.error || '',
    offlineEngineStart,
    offlineWarmup,
    settingsPersistence,
    historyClearPending,
    engine,
  }
  broadcastEngineState(engine)
  return result
}

function restartOfflineEngine() {
  const token = supersedeEngineLifecycle()
  return serializeEngineLifecycle(() => restartOfflineEngineNow(token))
}

function initializeOfflineEngine() {
  if (edition !== 'offline') return Promise.resolve({ ok: true, skipped: true })
  const token = supersedeEngineLifecycle()
  offlineEngineStart = { ok: false, starting: true, error: '' }
  broadcastEngineState(invalidateEngineStatus(offlineStatus()))
  return serializeEngineLifecycle(() => restartOfflineEngineNow(token)).then((result) => {
    console.log(`LINGOMUSE_OFFLINE_WARMUP=${JSON.stringify(offlineWarmup)}`)
    return result
  })
}

function registerIpc() {
  ipcMain.handle('app:get-state', async (event) => {
    requireTrustedSender(event)
    return createAppStateSnapshot({
      settings,
      platform: process.platform,
      version: app.getVersion(),
      edition,
      offlineEngineStart,
      offlineWarmup,
      settingsPersistence,
      historyClearPending,
      historyClearAuthorized: startupHistoryClearAuthorized,
      performance: getPerformanceProfile(),
      hook: { active: hookStarted && settings.autoClipboard, available: hookStarted },
      engine: await engineStatus(),
    })
  })

  ipcMain.handle('settings:update', async (event, patch) => {
    requireTrustedSender(event, ['main'])
    settingsRecoveryProtectedValues = releaseExplicitRecoveryPreferences(
      settingsRecoveryProtectedValues,
      patch,
    )
    const previousPerformanceMode = settings.performanceMode
    const previouslySavedHistory = settings.saveHistory
    const previousModel = settings.model
    const previousBaseUrl = settings.baseUrl
    settings = sanitizeSettings({ ...settings, ...patch })
    if (patch && typeof patch === 'object' && Object.hasOwn(patch, 'saveHistory')) {
      startupHistoryClearAuthorized = settings.saveHistory === false
    }
    if (edition === 'offline') {
      settings.model = OFFLINE_MODEL
      settings.baseUrl = OFFLINE_BASE_URL
    }
    if (previousModel !== settings.model || previousBaseUrl !== settings.baseUrl) {
      invalidateEngineStatus()
    } else if (cachedEngineStatus.model !== settings.model) {
      cachedEngineStatus = { ...cachedEngineStatus, model: settings.model }
    }
    doubleCopy.setInterval(settings.doubleCopyInterval)
    let historyClearResult = null
    if (!settings.saveHistory) {
      historyClearResult = historyStore?.clear() ?? {
        ok: true, error: '', revision: 0, history: [],
      }
      historyClearPending = !historyClearResult.ok
      if (previouslySavedHistory || historyClearPending) broadcastHistory()
    }
    const settingsPersisted = saveSettings()
    safeSend(popupWindow, 'settings:changed', settings)
    if (app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin })
    }
    createTray()
    sendHookStatus()
    if (
      edition === 'offline'
      && offlineEngineStart.ok
      && previousPerformanceMode !== settings.performanceMode
    ) {
      const profile = getPerformanceProfile()
      if (profile.warmOnStart) {
        pendingModelUnload = false
        const token = supersedeEngineLifecycle()
        void serializeEngineLifecycle(async () => {
          if (!isLifecycleTokenCurrent(token)) return
          const result = await warmOfflineModel({
            keepAlive: profile.keepAlive,
            numCtx: profile.numCtx,
            numThread: profile.numThread,
            signal: token.signal,
          })
          if (!isLifecycleTokenCurrent(token)) return
          offlineWarmup = result
          broadcastEngineState(cachedEngineStatus)
        })
      } else if (inferenceQueue.size > 0) {
        pendingModelUnload = true
        offlineWarmup = { ok: true, skipped: true, reason: 'eco' }
      } else {
        pendingModelUnload = false
        offlineWarmup = { ok: true, skipped: true, reason: 'eco' }
        const token = supersedeEngineLifecycle()
        void serializeEngineLifecycle(async () => {
          if (!isLifecycleTokenCurrent(token)) return
          await unloadOfflineModel({ signal: token.signal })
        })
      }
    }
    return {
      settings,
      settingsPersisted,
      settingsPersistence,
      historyClearOk: historyClearResult?.ok ?? true,
      historyClearPending,
      historySnapshot: currentHistorySnapshot(),
      performance: getPerformanceProfile(),
      engine: cachedEngineStatus,
    }
  })

  ipcMain.handle('history:list', (event) => {
    requireTrustedSender(event, ['main'])
    return {
      ...(historyStore?.snapshot() ?? { revision: 0, history: [], clearPending: historyClearPending }),
      clearPending: historyClearPending,
    }
  })

  ipcMain.handle('history:add', (event, entry) => {
    requireTrustedSender(event)
    if (!settings.saveHistory || !historyStore) {
      const snapshot = historyStore?.snapshot() ?? { revision: 0, history: [], clearPending: historyClearPending }
      return { ok: false, error: 'DISABLED', ...snapshot, clearPending: historyClearPending }
    }
    const result = historyStore.add(entry)
    historyClearPending = result.clearPending
    if (result.ok) broadcastHistory()
    return { ...result, clearPending: historyClearPending }
  })

  ipcMain.handle('history:import', (event, entries) => {
    requireTrustedSender(event, ['main'])
    if (!settings.saveHistory || !historyStore) {
      const snapshot = historyStore?.snapshot() ?? { revision: 0, history: [], clearPending: historyClearPending }
      return { ok: false, error: 'DISABLED', ...snapshot, clearPending: historyClearPending }
    }
    const result = historyStore.import(entries)
    historyClearPending = result.clearPending
    if (result.ok) broadcastHistory()
    return { ...result, clearPending: historyClearPending }
  })

  ipcMain.handle('history:clear', (event) => {
    requireTrustedSender(event, ['main'])
    const result = historyStore?.clear() ?? {
      ok: true, error: '', revision: 0, history: [],
    }
    historyClearPending = !result.ok
    broadcastHistory()
    return { ...result, clearPending: historyClearPending }
  })

  ipcMain.handle('translation:run', async (event, rawRequest) => {
    requireTrustedSender(event)
    const rawText = rawRequest && typeof rawRequest === 'object' ? rawRequest.text : rawRequest
    const requestId = rawRequest && typeof rawRequest === 'object'
      ? String(rawRequest.requestId || '').slice(0, 64)
      : ''
    const text = String(rawText || '').trim()
    const inputValidation = validateTranslationInput(text)
    if (inputValidation.code === 'EMPTY_INPUT') {
      return { ok: false, error: '請先輸入要翻譯的內容。', code: inputValidation.code }
    }
    if (inputValidation.code === 'INPUT_TOO_LONG') {
      return { ok: false, error: '單次翻譯上限為 12,000 個字元。', code: 'INPUT_TOO_LONG' }
    }
    if (inputValidation.code === 'INPUT_TOKEN_BUDGET') {
      return {
        ok: false,
        error: '為避免長文被模型靜默截斷，中文、日文或韓文內容單次建議不超過約 3,000 字。請分段翻譯。',
        code: 'INPUT_TOKEN_BUDGET',
      }
    }
    if (edition === 'offline' && !offlineEngineStart.ok) {
      return {
        ok: false,
        error: offlineEngineStart.starting ? '離線引擎仍在準備中，請稍候再試。' : '內建離線引擎尚未就緒。',
        code: 'ENGINE_OFFLINE',
      }
    }

    const senderId = event.sender.id
    return inferenceQueue.run(senderId, async (signal) => {
      try {
      const performance = getPerformanceProfile(text.length)
      const cacheKey = `${settings.baseUrl}\n${settings.model}\n${performance.detailLevel}\n${text}`
      const cachedResult = text.length <= 2_000 ? translationCache.get(cacheKey) : undefined
      if (cachedResult) {
        stageTimer.mark('first result available', { cached: true })
        stageTimer.mark('examples ready', { cached: true })
        return { ok: true, result: cachedResult, cached: true }
      }
      stageTimer.mark('translation started', { textLength: text.length })
      let firstPartialMarked = false
      const result = await translateWithOllama({
        text,
        model: settings.model,
        baseUrl: settings.baseUrl,
        signal,
        keepAlive: edition === 'offline' ? performance.keepAlive : '10m',
        detailLevel: performance.detailLevel,
        numCtx: performance.numCtx,
        numPredict: performance.numPredict,
        numThread: performance.numThread,
        onPartial: requestId
          ? (partial) => {
              if (signal.aborted) return
              if (event.sender.isDestroyed()) return
              if (!firstPartialMarked) {
                firstPartialMarked = true
                stageTimer.mark('first result available', { elapsedMs: partial.elapsedMs })
              }
              if (isPopupIntegrationTest && popupWindow?.webContents.id === senderId) {
                console.log(`LINGOMUSE_POPUP_PARTIAL_OK=${JSON.stringify(partial)}`)
              }
              event.sender.send('translation:partial', { requestId, ...partial })
            }
          : undefined,
      })
      stageTimer.mark('examples ready', { examples: result.examples?.length || 0 })
      if (text.length <= 2_000) translationCache.set(cacheKey, result)
      if (isPopupIntegrationTest && popupWindow?.webContents.id === senderId) {
        try {
          popupWindow.setBounds({ x: 100, y: 100, width: 468, height: 248 }, false)
          const beforeResize = popupWindow.getBounds()
          const startPoint = {
            x: beforeResize.x + beforeResize.width,
            y: beforeResize.y + beforeResize.height,
          }
          await popupWindow.webContents.executeJavaScript(`(async () => {
            await window.lingomuse.startPopupResize(${JSON.stringify({ direction: 'se', ...startPoint })});
            await window.lingomuse.movePopupResize(${JSON.stringify({ x: startPoint.x + 80, y: startPoint.y + 60 })});
            await window.lingomuse.endPopupResize();
          })()`)
          const afterResize = popupWindow.getBounds()
          const resizeOk = afterResize.width === beforeResize.width + 80
            && afterResize.height === beforeResize.height + 60
          console.log(`LINGOMUSE_POPUP_RESIZE_OK=${JSON.stringify({ resizeOk, beforeResize, afterResize })}`)
          if (!resizeOk) process.exitCode = 1

          await popupWindow.webContents.executeJavaScript(`(async () => {
            await window.lingomuse.setPopupPinned(false);
            await window.lingomuse.setPopupOpacity(0.68, false);
          })()`)
          const controlState = {
            pinned: popupWindow.isAlwaysOnTop(),
            opacity: popupWindow.getOpacity(),
          }
          const controlsOk = controlState.pinned === false
            && Math.abs(controlState.opacity - 0.68) < 0.02
          console.log(`LINGOMUSE_POPUP_CONTROLS_OK=${JSON.stringify({ controlsOk, ...controlState })}`)
          if (!controlsOk) process.exitCode = 1
          await popupWindow.webContents.executeJavaScript(`(async () => {
            await window.lingomuse.setPopupOpacity(1, true);
            await window.lingomuse.setPopupPinned(true);
          })()`)
        } catch (integrationError) {
          console.error(`LINGOMUSE_POPUP_WINDOW_INTEGRATION_FAILED=${String(integrationError?.message || integrationError)}`)
          process.exitCode = 1
        }
        console.log(`LINGOMUSE_POPUP_TRANSLATION_OK=${JSON.stringify({
          translation: result.translation,
          examples: result.examples?.length,
        })}`)
        setTimeout(() => {
          isQuitting = true
          app.quit()
        }, 250)
      }
      return { ok: true, result }
      } catch (error) {
      const errorCode = error?.code || 'UNKNOWN'
      recordTranslationEngineFailure(errorCode)
      if (isPopupIntegrationTest && popupWindow?.webContents.id === senderId) {
        console.error(`LINGOMUSE_POPUP_TRANSLATION_FAILED=${String(error?.message || error)}`)
        process.exitCode = 1
        setTimeout(() => {
          isQuitting = true
          app.quit()
        }, 250)
      }
      return {
        ok: false,
        error: String(error?.message || error),
        code: errorCode,
      }
      } finally {
        setTimeout(() => {
          if (!pendingModelUnload || inferenceQueue.size !== 0) return
          pendingModelUnload = false
          const token = supersedeEngineLifecycle()
          void serializeEngineLifecycle(async () => {
            if (!isLifecycleTokenCurrent(token)) return
            await unloadOfflineModel({ signal: token.signal })
          })
        }, 0)
      }
    }).catch((error) => ({
      ok: false,
      error: String(error?.message || error),
      code: error?.code || 'UNKNOWN',
    }))
  })

  ipcMain.handle('translation:cancel', (event) => {
    requireTrustedSender(event)
    inferenceQueue.cancel(event.sender.id)
    return { ok: true }
  })
  ipcMain.handle('engine:status', (event) => {
    requireTrustedSender(event, ['main'])
    return engineStatus()
  })
  ipcMain.handle('engine:restart-offline', (event) => {
    requireTrustedSender(event, ['main'])
    return restartOfflineEngine()
  })
  ipcMain.handle('engine:pull', (event, model) => {
    requireTrustedSender(event, ['main'])
    return pullModel(String(model || settings.model))
  })
  ipcMain.handle('engine:download', (event) => {
    requireTrustedSender(event, ['main'])
    return shell.openExternal('https://ollama.com/download/windows')
  })
  ipcMain.handle('app:open-external', (event, url) => {
    requireTrustedSender(event, ['main'])
    if (/^https?:\/\//i.test(String(url))) return shell.openExternal(String(url))
    return false
  })
  ipcMain.handle('window:minimize', (event) => {
    requireTrustedSender(event, ['main'])
    return mainWindow?.minimize()
  })
  ipcMain.handle('window:close', (event) => {
    requireTrustedSender(event, ['main'])
    return mainWindow?.close()
  })
  ipcMain.handle('popup:ready', (event) => {
    if (!popupWindow || BrowserWindow.fromWebContents(event.sender) !== popupWindow) return null
    popupRendererReady = true
    const payload = pendingPopupPayload
    pendingPopupPayload = null
    if (payload) {
      positionPopupWindow()
      popupWindow.showInactive()
      stageTimer.mark('popup visible', { coldStart: true })
    }
    return { payload, settings, edition }
  })
  ipcMain.handle('popup:close', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    inferenceQueue.cancel(event.sender.id)
    if (window === popupWindow) window.hide()
    return { ok: true }
  })
  ipcMain.handle('popup:open-main', (event, payload) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    inferenceQueue.cancel(event.sender.id)
    if (window === popupWindow) window.hide()
    showWindow()
    if (payload?.source && payload?.result) {
      safeSend(mainWindow, 'popup:result', payload)
    }
    return { ok: true }
  })
  ipcMain.handle('popup:set-height', (event, rawHeight) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || window !== popupWindow) return { ok: false }
    if (popupUserResized) return { ok: true, skipped: true }
    const displayHeight = screen.getDisplayMatching(window.getBounds()).workArea.height
    const height = Math.max(POPUP_MIN_HEIGHT, Math.min(displayHeight, Math.round(Number(rawHeight) || 248)))
    window.setSize(window.getSize()[0], height, false)
    positionPopupWindow()
    return { ok: true }
  })
  ipcMain.handle('popup:set-pinned', (event, rawPinned) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || window !== popupWindow) return { ok: false }
    settings.popupPinned = rawPinned === true
    window.setAlwaysOnTop(settings.popupPinned, 'floating')
    const persisted = saveSettings()
    return { ok: true, pinned: settings.popupPinned, persisted }
  })
  ipcMain.handle('popup:set-opacity', (event, rawOpacity, persist = false) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || window !== popupWindow) return { ok: false }
    settings.popupOpacity = clampPopupOpacity(rawOpacity)
    window.setOpacity(settings.popupOpacity)
    const persisted = persist ? saveSettings() : true
    return { ok: true, opacity: settings.popupOpacity, persisted }
  })
  ipcMain.handle('popup:resize-start', (event, payload) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const direction = String(payload?.direction || '')
    const x = Number(payload?.x)
    const y = Number(payload?.y)
    if (!window || window !== popupWindow || !/^(n|ne|e|se|s|sw|w|nw)$/.test(direction)) {
      return { ok: false }
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false }
    const startBounds = window.getBounds()
    popupResizeSession = {
      senderId: event.sender.id,
      direction,
      startBounds,
      startPoint: { x, y },
      workArea: screen.getDisplayMatching(startBounds).workArea,
    }
    popupUserResized = true
    return { ok: true }
  })
  ipcMain.handle('popup:resize-move', (event, payload) => {
    if (!popupWindow || !popupResizeSession || popupResizeSession.senderId !== event.sender.id) {
      return { ok: false }
    }
    const x = Number(payload?.x)
    const y = Number(payload?.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false }
    const bounds = calculatePopupResizeBounds({
      ...popupResizeSession,
      currentPoint: { x, y },
    })
    popupWindow.setBounds(bounds, false)
    return { ok: true, bounds }
  })
  ipcMain.handle('popup:resize-end', (event) => {
    if (popupResizeSession?.senderId === event.sender.id) {
      popupResizeSession = null
      if (popupWindow && !popupWindow.isDestroyed()) {
        const [width, height] = popupWindow.getSize()
        if (settings.popupWidth !== width || settings.popupHeight !== height) {
          settings.popupWidth = width
          settings.popupHeight = height
          saveSettings()
        }
      }
    }
    return { ok: true }
  })
  ipcMain.handle('perf:mark', (event, stage) => {
    requireTrustedSender(event)
    return stageTimer.mark(String(stage || ''))
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', showWindow)
  app.whenReady().then(async () => {
    app.setAppUserModelId('tw.lingomuse.desktop')
    nativeTheme.themeSource = 'light'
    const loadedSettings = loadSettings()
    historyStore = createHistoryStore(historyPath())
    historyClearPending = historyStore.snapshot().clearPending
    const initialHistorySnapshot = historyStore.snapshot()
    startupHistoryClearAuthorized = isHistoryClearPreferenceExplicit({
      saveHistory: settings.saveHistory,
      settingsSource: loadedSettings.source,
      settingsWritable: loadedSettings.writable,
    })
    if (shouldClearHistoryOnStartup({
      saveHistory: settings.saveHistory,
      settingsSource: loadedSettings.source,
      settingsWritable: loadedSettings.writable,
      historyWritable: initialHistorySnapshot.writable,
    })) {
      historyClearPending = !historyStore.clear().ok
    }
    if (edition === 'offline') offlineEngineStart = { ok: false, starting: true, error: '' }
    registerIpc()
    createWindow()
    if (!isSmokeTest) createTray()
    if (!isSmokeTest && getPerformanceProfile().resolvedMode !== 'eco') {
      createPopupWindow()
    }
    const hookInitialization = startKeyboardHook()
    const engineInitialization = initializeOfflineEngine()
    powerMonitor.on('suspend', handleSystemSuspend)
    powerMonitor.on('resume', handleSystemResume)
    await hookInitialization

    if (isSmokeTest) {
      await engineInitialization
      console.log('LINGOMUSE_SMOKE_READY')
      if (isPopupIntegrationTest) {
        console.log('LINGOMUSE_POPUP_TRIGGERED')
        showClipboardPopup('我不是故意讓你為難。')
        setTimeout(() => {
          console.error('LINGOMUSE_POPUP_TRANSLATION_TIMEOUT')
          process.exitCode = 1
          isQuitting = true
          app.quit()
        }, 120_000)
      } else if (isOfflineIntegrationTest) {
        try {
          const performance = getPerformanceProfile(12)
          const result = await translateWithOllama({
            text: '我不是故意讓你為難。',
            model: settings.model,
            baseUrl: settings.baseUrl,
            keepAlive: performance.keepAlive,
            detailLevel: performance.detailLevel,
            numCtx: performance.numCtx,
            numPredict: performance.numPredict,
            numThread: performance.numThread,
          })
          console.log(`LINGOMUSE_OFFLINE_TRANSLATION_OK=${JSON.stringify({
            detectedLanguage: result.detectedLanguage,
            targetLanguage: result.targetLanguage,
            translation: result.translation,
            examples: result.examples?.length,
          })}`)
        } catch (error) {
          console.error(`LINGOMUSE_OFFLINE_TRANSLATION_FAILED=${String(error?.message || error)}`)
          process.exitCode = 1
        }
        isQuitting = true
        app.quit()
      } else {
        setTimeout(() => {
          isQuitting = true
          app.quit()
        }, 800)
      }
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else showWindow()
    })
  })
}

app.on('before-quit', () => {
  isQuitting = true
  resumeRecoveryGeneration += 1
  engineLifecycleGeneration += 1
  engineLifecycleController.abort()
  clearResumeRecoveryTimer()
  inferenceQueue.cancelAll()
  stopOfflineEngine()
  try {
    if (hookStarted) keyboardHook?.stop()
  } catch {
    // Native hook may already be shutting down.
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Keep the tray app alive for double-copy translation.
  }
})
