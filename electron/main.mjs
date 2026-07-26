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
import { clampPopupOpacity } from './popup-preferences.mjs'
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
    title: 'LingoMuse éˆè­¯',
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
          title: 'LingoMuse ä»åœ¨èƒŒæ™¯é‹ä½œ',
          body: 'é€£æŒ‰å…©æ¬¡ Ctrl+C ä»å¯å–šé†’ç¿»è­¯ï¼›å¯å¾žç³»çµ±åŒ£å®Œå…¨çµæŸã€‚',
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
  popupWindow = new BrowserWindow({
    width: 468,
    height: 248,
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
    title: 'LingoMuse é›™æ“Šå¿«è­¯',
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
}

function showClipboardPopup(text, timestamp = Date.now()) {
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
  tray.setToolTip('LingoMuse éˆè­¯ â€” é€£æŒ‰å…©æ¬¡ Ctrl+C å¿«é€Ÿç¿»è­¯')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'é–‹å•Ÿ LingoMuse', click: showWindow },
      {
        label: settings.autoClipboard ? 'æš«åœé›™æ“Šè¤‡è£½' : 'å•Ÿç”¨é›™æ“Šè¤‡è£½',
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
        label: 'å®Œå…¨çµæŸ',
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
      setTimeout(() => {
        const text = clipboard.readText().trim()
        if (!text) return
        showClipboardPopup(text.length > 12_000 ? text.slice(0, 12_001) : text, triggeredAt)
      }, 140)
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
  safeSend(mainWindow, 'settingsçm<¶‰žËkºwµçqÐ¹½¬(€€€‰É½…‘…ÍÑ!¥ÍÑ½Éä ¤(€€€É•ÑÕÉ¸ì€¸¸¹É•ÍÕ±Ð°±•…ÉA•¹‘¥¹œè¡¥ÍÑ½Éå±•…ÉA•¹‘¥¹œô(€ô¤((€¥Á5…¥¸¹¡…¹‘±” ÑÉ…¹Í±…Ñ¥½¸éÉÕ¸œ°…Íå¹Œ€¡•Ù•¹Ð°É…ÝI•ÅÕ•ÍÐ¤€ôøì(€€€É•ÅÕ¥É•QÉÕÍÑ•‘M•¹‘•È¡•Ù•¹Ð¤(€€€½¹ÍÐÉ…ÝQ•áÐ€ôÉ…ÝI•ÅÕ•ÍÐ€˜˜ÑåÁ•½˜É…ÝI•ÅÕ•ÍÐ€ôôô€½‰©•Ðœ€üÉ…ÝI•ÅÕ•ÍÐ¹Ñ•áÐ€èÉ…ÝI•ÅÕ•ÍÐ(€€€½¹ÍÐÉ•ÅÕ•ÍÑ%€ôÉ…ÝI•ÅÕ•ÍÐ€˜˜ÑåÁ•½˜É…ÝI•ÅÕ•ÍÐ€ôôô€½‰©•Ðœ(€€€€€€üMÑÉ¥¹œ¡É…ÝI•ÅÕ•ÍÐ¹É•ÅÕ•ÍÑ%ñð€œœ¤¹Í±¥” À°€ØÐ¤(€€€€€€è€œœ(€€€½¹ÍÐÑ•áÐ€ôMÑÉ¥¹œ¡É…ÝQ•áÐñð€œœ¤¹ÑÉ¥´ ¤(€€€½¹ÍÐ¥¹ÁÕÑY…±¥‘…Ñ¥½¸€ôÙ…±¥‘…Ñ•QÉ…¹Í±…Ñ¥½¹%¹ÁÕÐ¡Ñ•áÐ¤(€€€¥˜€¡¥¹ÁÕÑY…±¥‘…Ñ¥½¸¹½‘”€ôôô€5AQe}%9AUPœ¤ì(€€€€€É•ÑÕÉ¸ì½¬è™…±Í”°•ÉÉ½Èè€Ÿ¢®/–#¢òã–—¢šžþï¢¶¿žj–Ÿ–ºçŽœ°½‘”è¥¹ÁÕÑY…±¥‘…Ñ¥½¸¹½‘”ô(€€€ô(€€€¥˜€¡¥¹ÁÕÑY…±¥‘…Ñ¥½¸¹½‘”€ôôô€%9AUQ}Q==}1=9œ¤ì(€€€€€É•ÑÕÉ¸ì½¬è™…±Í”°•ÉÉ½Èè€Ÿ–Z»š²‡žþï¢¶¿’â+¦fCž
è€ÄÈ°ÀÀÀƒ–/–¶_–Žœ°½‘”è€%9AUQ}Q==}1=9œô(€€€ô(€€€¥˜€¡¥¹ÁÕÑY…±¥‘…Ñ¥½¸¹½‘”€ôôô€%9AUQ}Q=-9}	UPœ¤ì(€€€€€É•ÑÕÉ¸ì(€€€€€€€½¬è™…±Í”°(€€€€€€€•ÉÉ½Èè€Ÿž
ë¦ÿ–7¦VßšZ¢Š¯š¢‡–z/¦vs¦îcš"«šZß¾ò3’â·šZŽš^—šZš"[¦~OšZ–Ÿ–ºç–Z»š²‡–îë¢¶Ã’â7¢Ú¦;žÒ€Ì°ÀÀÀƒ–¶_Ž¢®/–"šº×žþï¢¶¿Žœ°(€€€€€€€½‘”è€%9AUQ}Q=-9}	UPœ°(€€€€€ô(€€€ô(€€€¥˜€¡•‘¥Ñ¥½¸€ôôô€½™™±¥¹”œ€˜˜€…½™™±¥¹•¹¥¹•MÑ…ÉÐ¹½¬¤ì(€€€€€É•ÑÕÉ¸ì(€€€€€€€½¬è™…±Í”°(€€€€€€€•ÉÉ½Èè½™™±¥¹•¹¥¹•MÑ…ÉÐ¹ÍÑ…ÉÑ¥¹œ€ü€Ÿ¦n‹žÞk–òWšN;’î7–r£šê[–
g’â·¾ò3¢®/ž¢7–g–7¢¦›Žœ€è€Ÿ–Ÿ–îë¦n‹žÞk–òWšN;–Âkšr«–ÂÇžÞKŽœ°(€€€€€€€½‘”è€9%9}=1%9œ°(€€€€€ô(€€€ô((€€€½¹ÍÐÍ•¹‘•É%€ô•Ù•¹Ð¹Í•¹‘•È¹¥(€€€É•ÑÕÉ¸¥¹™•É•¹•EÕ•Õ”¹ÉÕ¸¡Í•¹‘•É%°…Íå¹Œ€¡Í¥¹…°¤€ôøì(€€€€€ÑÉäì(€€€€€½¹ÍÐÁ•É™½Éµ…¹”€ô•ÑA•É™½Éµ…¹•AÉ½™¥±”¡Ñ•áÐ¹±•¹Ñ ¤(€€€€€½¹ÍÐ…¡•-•ä€ô€‘íÍ•ÑÑ¥¹Ì¹‰…Í•UÉ±õq¸‘íÍ•ÑÑ¥¹Ì¹µ½‘•±õq¸‘íÁ•É™½Éµ…¹”¹‘•Ñ…¥±1•Ù•±õq¸‘íÑ•áÑõ€(€€€€€½¹ÍÐ…¡•‘I•ÍÕ±Ð€ôÑ•áÐ¹±•¹Ñ €ðô€É|ÀÀÀ€üÑÉ…¹Í±…Ñ¥½¹…¡”¹•Ð¡…¡•-•ä¤€èÕ¹‘•™¥¹•(€€€€€¥˜€¡…¡•‘I•ÍÕ±Ð¤É•ÑÕÉ¸ì½¬èÑÉÕ”°É•ÍÕ±Ðè…¡•‘I•ÍÕ±Ð°…¡•èÑÉÕ”ô(€€€€€½¹ÍÐÉ•ÍÕ±Ð€ô…Ý…¥ÐÑÉ…¹Í±…Ñ•]¥Ñ¡=±±…µ„¡ì(€€€€€€€Ñ•áÐ°(€€€€€€€µ½‘•°èÍ•ÑÑ¥¹Ì¹µ½‘•°°(€€€€€€€‰…Í•UÉ°èÍ•ÑÑ¥¹Ì¹‰…Í•UÉ°°(€€€€€€€Í¥¹…°°(€€€€€€€­••Á±¥Ù”è•‘¥Ñ¥½¸€ôôô€½™™±¥¹”œ€üÁ•É™½Éµ…¹”¹­••Á±¥Ù”€è€œÄÁ´œ°(€€€€€€€‘•Ñ…¥±1•Ù•°èÁ•É™½Éµ…¹”¹‘•Ñ…¥±1•Ù•°°(€€€€€€€¹ÕµÑàèÁ•É™½Éµ…¹”¹¹ÕµÑà°(€€€€€€€¹ÕµAÉ•‘¥ÐèÁ•É™½Éµ…¹”¹¹ÕµAÉ•‘¥Ð°(€€€€€€€¹ÕµQ¡É•…èÁ•É™½Éµ…¹”¹¹ÕµQ¡É•…°(€€€€€€€½¹A…ÉÑ¥…°èÉ•ÅÕ•ÍÑ%(€€€€€€€€€€ü€¡Á…ÉÑ¥…°¤€ôøì(€€€€€€€€€€€€€¥˜€¡Í¥¹…°¹…‰½ÉÑ•¤É•ÑÕÉ¸(€€€€€€€€€€€€€¥˜€¡•Ù•¹Ð¹Í•¹‘•È¹¥Í•ÍÑÉ½å• ¤¤É•ÑÕÉ¸(€€€€€€€€€€€€€¥˜€¡¥ÍA½ÁÕÁ%¹Ñ•É…Ñ¥½¹Q•ÍÐ€˜˜Á½ÁÕÁ]¥¹‘½Üü¹Ý•‰½¹Ñ•¹ÑÌ¹¥€ôôôÍ•¹‘•É%¤ì(€€€€€€€€€€€€€€€½¹Í½±”¹±½œ¡1%9=5UM}A=AUA}AIQ%1}=,ô‘í)M=8¹ÍÑÉ¥¹¥™ä¡Á…ÉÑ¥…°¥õ€¤(€€€€€€€€€€€€€ô(€€€€€€€€€€€€€•Ù•¹Ð¹Í•¹‘•È¹Í•¹ ÑÉ…¹Í±…Ñ¥½¸éÁ…ÉÑ¥…°œ°ìÉ•ÅÕ•ÍÑ%°€¸¸¹Á…ÉÑ¥…°ô¤(€€€€€€€€€€€ô(€€€€€€€€€€èÕ¹‘•™¥¹•°(€€€€€ô¤(€€€€€¥˜€¡Ñ•áÐ¹±•¹Ñ €ðô€É|ÀÀÀ¤ÑÉ…¹Í±…Ñ¥½¹…¡”¹Í•Ð¡…¡•-•ä°É•ÍÕ±Ð¤(€€€€€¥˜€¡¥ÍA½ÁÕÁ%¹Ñ•É…Ñ¥½¹Q•ÍÐ€˜˜Á½ÁÕÁ]¥¹‘½Üü¹Ý•‰½¹Ñ•¹ÑÌ¹¥€ôôôÍ•¹‘•É%¤ì(€€€€€€€ÑÉäì(€€€€€€€€€Á½ÁÕÁ]¥¹‘½Ü¹Í•Ñ	½Õ¹‘Ì¡ìàè€ÄÀÀ°äè€ÄÀÀ°Ý¥‘Ñ è€ÐØà°¡•¥¡Ðè€ÈÐàô°™…±Í”¤(€€€€€€€€€½¹ÍÐ‰•™½É•I•Í¥é”€ôÁ½ÁÕÁ]¥¹‘½Ü¹•Ñ	½Õ¹‘Ì ¤(€€€€€€€€€½¹ÍÐÍÑ…ÉÑA½¥¹Ð€ôì(€€€€€€€€€€€àè‰•™½É•I•Í¥é”¹à€¬‰•™½É•I•Í¥é”¹Ý¥‘Ñ °(€€€€€€€€€€€äè‰•™½É•I•Í¥é”¹ä€¬‰•™½É•I•Í¥é”¹¡•¥¡Ð°(€€€€€€€€€ô(€€€€€€€€€…Ý…¥ÐÁ½ÁÕÁ]¥¹‘½Ü¹Ý•‰½¹Ñ•¹ÑÌ¹•á•ÕÑ•)…Ù…MÉ¥ÁÐ¡€¡…Íå¹Œ€ ¤€ôøì(€€€€€€€€€€€…Ý…¥ÐÝ¥¹‘½Ü¹±¥¹½µÕÍ”¹ÍÑ…ÉÑA½ÁÕÁI•Í¥é” ‘í)M=8¹ÍÑÉ¥¹¥™ä¡ì‘¥É•Ñ¥½¸è€Í”œ°€¸¸¹ÍÑ…ÉÑA½¥¹Ðô¥ô¤ì(€€€€€€€€€€€…Ý…¥ÐÝ¥¹‘½Ü¹±¥¹½µÕÍ”¹µ½Ù•A½ÁÕÁI•Í¥é” ‘í)M=8¹ÍÑÉ¥¹¥™ä¡ìàèÍÑ…ÉÑA½¥¹Ð¹à€¬€àÀ°äèÍÑ…ÉÑA½¥¹Ð¹ä€¬€ØÀô¥ô¤ì(€€€€€€€€€€€…Ý…¥ÐÝ¥¹‘½Ü¹±¥¹½µÕÍ”¹•¹‘A½ÁÕÁI•Í¥é” ¤ì(€€€€€€€€€ô¤ ¥€¤(€€€€€€€€€½¹ÍÐ…™Ñ•ÉI•Í¥é”€ôÁ½ÁÕÁ]¥¹‘½Ü¹•Ñ	½Õ¹‘Ì ¤(€€€€€€€€€½¹ÍÐÉ•Í¥é•=¬€ô…™Ñ•ÉI•Í¥é”¹Ý¥‘Ñ €ôôô‰•™½É•I•Í¥é”¹Ý¥‘Ñ €¬€àÀ(€€€€€€€€€€€€˜˜…™Ñ•ÉI•Í¥é”¹¡•¥¡Ð€ôôô‰•™½É•I•Í¥é”¹¡•¥¡Ð€¬€ØÀ(€€€€€€€€€½¹Í½±”¹±½œ¡1%9=5UM}A=AUA}IM%i}=,ô‘í)M=8¹ÍÑÉ¥¹¥™ä¡ìÉ•Í¥é•=¬°‰•™½É•I•Í¥é”°…™Ñ•ÉI•Í¥é”ô¥õ€¤(€€€€€€€€€¥˜€ …É•Í¥é•=¬¤ÁÉ½•ÍÌ¹•á¥Ñ½‘”€ô€Ä((€€€€€€€€€…Ý…¥ÐÁ½ÁÕÁ]¥¹‘½Ü¹Ý•‰½¹Ñ•¹ÑÌ¹•á•ÕÑ•)…Ù…MÉ¥ÁÐ¡€¡…Íå¹Œ€ ¤€ôøì(€€€€€€€€€€€…Ý…¥ÐÝ¥¹‘½Ü¹±¥¹½µÕÍ”¹Í•ÑA½ÁÕÁA¥¹¹•¡™…±Í”¤ì(€€€€€€€€€€€…Ý…¥ÐÝ¥¹‘½Ü¹±¥¹½µÕÍ”¹Í•ÑA½ÁÕÁ=Á…¥Ñä À¸Øà°™…±Í”¤ì(€€€€€€€€€ô¤ ¥€¤(€€€€€€€€€½¹ÍÐ½¹ÑÉ½±MÑ…Ñ”€ôì(€€€€€€€€€€€Á¥¹¹•èÁ½ÁÕÁ]¥¹‘½Ü¹¥Í±Ý…åÍ=¹Q½À ¤°(€€€€€€€€€€€½Á…¥ÑäèÁ½ÁÕÁ]¥¹‘½Ü¹•Ñ=Á…¥Ñä ¤°(€€€€€€€€€ô(€€€€€€€€€½¹ÍÐ½¹ÑÉ½±Í=¬€ô½¹ÑÉ½±MÑ…Ñ”¹Á¥¹¹•€ôôô™…±Í”(€€€€€€€€€€€€˜˜5…Ñ ¹…‰Ì¡½¹ÑÉ½±MÑ…Ñ”¹½Á…¥Ñä€´€À¸Øà¤€ð€À¸ÀÈ(€€€€€€€€€½¹Í½±”¹±½œ¡1%9=5UM}A=AUA}=9QI=1M}=,ô‘í)M=8¹ÍÑÉ¥¹¥™ä¡ì½¹ÑÉ½±Í=¬°€¸¸¹½¹ÑÉ½±MÑ…Ñ”ô¥õ€¤(€€€€€€€€€¥˜€ …½¹ÑÉ½±Í=¬¤ÁÉ½•ÍÌ¹•á¥Ñ½‘”€ô€Ä(€€€€€€€€€…Ý…¥ÐÁ½ÁÕÁ]¥¹‘½Ü¹Ý•‰½¹Ñ•¹ÑÌ¹•á•ÕÑ•)…Ù…MÉ¥ÁÐ¡€¡…Íå¹Œ€ ¤€ôøì(€€€€€€€€€€€…Ý…¥ÐÝ¥¹‘½Ü¹±¥¹½µÕÍ”¹Í•ÑA½ÁÕÁ=Á…¥Ñä Ä°ÑÉÕ”¤ì(€€€€€€€€€€€…Ý…¥ÐÝ¥¹‘½Ü¹±¥¹½µÕÍ”¹Í•ÑA½ÁÕÁA¥¹¹•¡ÑÉÕ”¤ì(€€€€€€€€€ô¤ ¥€¤(€€€€€€€ô…Ñ €¡¥¹Ñ•É…Ñ¥½¹ÉÉ½È¤ì(€€€€€€€€€½¹Í½±”¹•ÉÉ½È¡1%9=5UM}A=AUA}]%9=]}%9QIQ%=9}%1ô‘íMÑÉ¥¹œ¡¥¹Ñ•É…Ñ¥½¹ÉÉ½Èü¹µ•ÍÍ…”ñð¥¹Ñ•É…Ñ¥½¹ÉÉ½È¥õ€¤(€€€€€€€€€ÁÉ½•ÍÌ¹•á¥Ñ½‘”€ô€Ä(€€€€€€€ô(€€€€€€€½¹Í½±”¹±½œ¡1%9=5UM}A=AUA}QI9M1Q%=9}=,ô‘í)M=8¹ÍÑÉ¥¹¥™ä¡ì(€€€€€€€€€ÑÉ…¹Í±…Ñ¥½¸èÉ•ÍÕ±Ð¹ÑÉ…¹Í±…Ñ¥½¸°(€€€€€€€€€•á…µÁ±•ÌèÉ•ÍÕ±Ð¹•á…µÁ±•Ìü¹±•¹Ñ °(€€€€€€€ô¥õ€¤(€€€€€€€Í•ÑQ¥µ•½ÕÐ  ¤€ôøì(€€€€€€€€€¥ÍEÕ¥ÑÑ¥¹œ€ôÑÉÕ”(€€€€€€€€€…ÁÀ¹ÅÕ¥Ð ¤(€€€€€€€ô°€ÈÔÀ¤(€€€€€ô(€€€€€É•ÑÕÉ¸ì½¬èÑÉÕ”°É•ÍÕ±Ðô(€€€€€ô…Ñ €¡•ÉÉ½È¤ì(€€€€€½¹ÍÐ•ÉÉ½É½‘”€ô•ÉÉ½Èü¹½‘”ñð€U9-9=]8œ(€€€€€É•½É‘QÉ…¹Í±…Ñ¥½¹¹¥¹•…¥±ÕÉ”¡•ÉÉ½É½‘”¤(€€€€€¥˜€¡¥ÍA½ÁÕÁ%¹Ñ•É…Ñ¥½¹Q•ÍÐ€˜˜Á½ÁÕÁ]¥¹‘½Üü¹Ý•‰½¹Ñ•¹ÑÌ¹¥€ôôôÍ•¹‘•É%¤ì(€€€€€€€½¹Í½±”¹•ÉÉ½È¡1%9=5UM}A=AUA}QI9M1Q%=9}%1ô‘íMÑÉ¥¹œ¡•ÉÉ½Èü¹µ•ÍÍ…”ñð•ÉÉ½È¥õ€¤(€€€€€€€ÁÉ½•ÍÌ¹•á¥Ñ½‘”€ô€Ä(€€€€€€€Í•ÑQ¥µ•½ÕÐ  ¤€ôøì(€€€€€€€€€¥ÍEÕ¥ÑÑ¥¹œ€ôÑÉÕ”(€€€€€€€€€…ÁÀ¹ÅÕ¥Ð ¤(€€€€€€€ô°€ÈÔÀ¤(€€€€€ô(€€€€€É•ÑÕÉ¸ì(€€€€€€€½¬è™…±Í”°(€€€€€€€•ÉÉ½ÈèMÑÉ¥¹œ¡•ÉÉ½Èü¹µ•ÍÍ…”ñð•ÉÉ½È¤°(€€€€€€€½‘”è•ÉÉ½É½‘”°(€€€€€ô(€€€€€ô™¥¹…±±äì(€€€€€€€Í•ÑQ¥µ•½ÕÐ  ¤€ôøì(€€€€€€€€€¥˜€ …Á•¹‘¥¹5½‘•±U¹±½…ñð¥¹™•É•¹•EÕ•Õ”¹Í¥é”€„ôô€À¤É•ÑÕÉ¸(€€€€€€€€€Á•¹‘¥¹5½‘•±U¹±½…€ô™…±Í”(€€€€€€€€€½¹ÍÐÑ½­•¸€ôÍÕÁ•ÉÍ•‘•¹¥¹•1¥™•å±” ¤(€€€€€€€€€Ù½¥Í•É¥…±¥é•¹¥¹•1¥™•å±”¡…Íå¹Œ€ ¤€ôøì(€€€€€€€€€€€¥˜€ …¥Í1¥™•å±•Q½­•¹ÕÉÉ•¹Ð¡Ñ½­•¸¤¤É•ÑÕÉ¸(€€€€€€€€€€€…Ý…¥ÐÕ¹±½…‘=™™±¥¹•5½‘•°¡ìÍ¥¹…°èÑ½­•¸¹Í¥¹…°ô¤(€€€€€€€€€ô¤(€€€€€€€ô°€À¤(€€€€€ô(€€€ô¤¹…Ñ  ¡•ÉÉ½È¤€ôø€¡ì(€€€€€½¬è™…±Í”°(€€€€€•ÉÉ½ÈèMÑÉ¥¹œ¡•ÉÉ½Èü¹µ•ÍÍ…”ñð•ÉÉ½È¤°(€€€€€½‘”è•ÉÉ½Èü¹½‘”ñð€U9-9=]8œ°(€€€ô¤¤(€ô¤((€¥Á5…¥¸¹¡…¹‘±” ÑÉ…¹Í±…Ñ¥½¸é…¹•°œ°€¡•Ù•¹Ð¤€ôøì(€€€É•ÅÕ¥É•QÉÕÍÑ•‘M•¹‘•È¡•Ù•¹Ð¤(€€€¥¹™•É•¹•EÕ•Õ”¹…¹•°¡•Ù•¹Ð¹Í•¹‘•È¹¥¤(€€€É•ÑÕÉ¸ì½¬èÑÉÕ”ô(€ô¤(€¥Á5…¥¸¹¡…¹‘±” •¹¥¹”éÍÑ…ÑÕÌœ°€¡•Ù•¹Ð¤€ôøì(€€€É•ÅÕ¥É•QÉÕÍÑ•‘M•¹‘•È¡•Ù•¹Ð°lµ…¥¸t¤(€€€É•ÑÕÉ¸•¹¥¹•MÑ…ÑÕÌ ¤(€ô¤(€¥Á5…¥¸¹¡…¹‘±” •¹¥¹”éÉ•ÍÑ…ÉÐµ½™™±¥¹”œ°€¡•Ù•¹Ð¤€ôøì(€€€É•ÅÕ¥É•QÉÕÍÑ•‘M•¹‘•È¡•Ù•¹Ð°lµ…¥¸t¤(€€€É•ÑÕÉ¸É•ÍÑ…ÉÑ=™™±¥¹•¹¥¹” ¤(€ô¤(€¥Á5…¥¸¹¡…¹‘±” •¹¥¹”éÁÕ±°œ°€¡•Ù•¹Ð°µ½‘•°¤€ôøì(€€€É•ÅÕ¥É•QÉÕÍÑ•‘M•¹‘•È¡•Ù•¹Ð°lµ…¥¸t¤(€€€É•ÑÕÉ¸ÁÕ±±5½‘•°¡MÑÉ¥¹œ¡µ½‘•°ñðÍ•ÑÑ¥¹Ì¹µ½‘•°¤¤(€ô¤(€¥Á5…¥¸¹¡…¹‘±” •¹¥¹”é‘½Ý¹±½…œ°€¡•Ù•¹Ð¤€ôøì(€€€É•ÅÕ¥É•QÉÕÍÑ•‘M•¹‘•È¡•Ù•¹Ð°lµ…¥¸t¤(€€€É•ÑÕÉ¸Í¡•±°¹½Á•¹áÑ•É¹…° ¡ÑÑÁÌè¼½½±±…µ„¹½´½‘½Ý¹±½…½Ý¥¹‘½ÝÌœ¤(€ô¤(€¥Á5…¥¸¹¡…¹‘±” …ÁÀé½Á•¸µ•áÑ•É¹…°œ°€¡•Ù•¹Ð°ÕÉ°¤€ôøì(€€€É•ÅÕ¥É•QÉÕÍÑ•‘M•¹‘•È¡•Ù•¹Ð°lµ…¥¸t¤(€€€¥˜€ ½y¡ÑÑÁÌüép½p¼½¤¹Ñ•ÍÐ¡MÑÉ¥¹œ¡ÕÉ°¤¤¤É•ÑÕÉ¸Í¡•±°¹½Á•¹áÑ•É¹…°¡MÑÉ¥¹œ¡ÕÉ°¤¤(€€€É•ÑÕÉ¸™…±Í”(€ô¤(€¥Á5…¥¸¹¡…¹‘±” Ý¥¹‘½Üéµ¥¹¥µ¥é”œ°€¡•Ù•¹Ð¤€ôøì(€€€É•ÅÕ¥É•QÉÕÍÑ•‘M•¹‘•È¡•Ù•¹Ð°lµ…¥¸t¤(€€€É•ÑÕÉ¸µ…¥¹]¥¹‘½Üü¹µ¥¹¥µ¥é” ¤(€ô¤(€¥Á5…¥¸¹¡…¹‘±” Ý¥¹‘½Üé±½Í”œ°€¡•Ù•¹Ð¤€ôøì(€€€É•ÅÕ¥É•QÉÕÍÑ•‘M•¹‘•È¡•Ù•¹Ð°lµ…¥¸t¤(€€€É•ÑÕÉ¸µ…¥¹]¥¹‘½Üü¹±½Í” ¤(€ô¤(€¥Á5…¥¸¹¡…¹‘±” Á½ÁÕÀéÉ•…‘äœ°€¡•Ù•¹Ð¤€ôøì(€€€¥˜€ …Á½ÁÕÁ]¥¹‘½Üñð	É½ÝÍ•É]¥¹‘½Ü¹™É½µ]•‰½¹Ñ•¹ÑÌ¡•Ù•¹Ð¹Í•¹‘•È¤€„ôôÁ½ÁÕÁ]¥¹‘½Ü¤É•ÑÕÉ¸¹Õ±°(€€€Á½ÁÕÁI•¹‘•É•ÉI•…‘ä€ôÑÉÕ”(€€€½¹ÍÐÁ…å±½…€ôÁ•¹‘¥¹A½ÁÕÁA…å±½…(€€€Á•¹‘¥¹A½ÁÕÁA…å±½…€ô¹Õ±°(€€€¥˜€¡Á…å±½…¤ì(€€€€€Á½Í¥Ñ¥½¹A½ÁÕÁ]¥¹‘½Ü ¤(€€€€€Á½ÁÕÁ]¥¹‘½Ü¹Í¡½Ý%¹…Ñ¥Ù” ¤(€€€ô(€€€É•ÑÕÉ¸ìÁ…å±½…°Í•ÑÑ¥¹Ì°•‘¥Ñ¥½¸ô(€ô¤(€¥Á5…¥¸¹¡…¹‘±” Á½ÁÕÀé±½Í”œ°€¡•Ù•¹Ð¤€ôøì(€€€½¹ÍÐÝ¥¹‘½Ü€ô	É½ÝÍ•É]¥¹‘½Ü¹™É½µ]•‰½¹Ñ•¹ÑÌ¡•Ù•¹Ð¹Í•¹‘•È¤(€€€¥¹™•É•¹•EÕ•Õ”¹…¹•°¡•Ù•¹Ð¹Í•¹‘•È¹¥¤(€€€¥˜€¡Ý¥¹‘½Ü€ôôôÁ½ÁÕÁ]¥¹‘½Ü¤Ý¥¹‘½Ü¹¡¥‘” ¤(€€€É•ÑÕÉ¸ì½¬èÑÉÕ”ô(€ô¤(€¥Á5…¥¸¹¡…¹‘±” Á½ÁÕÀé½Á•¸µµ…¥¸œ°€¡•Ù•¹Ð°Á…å±½…¤€ôøì(€€€½¹ÍÐÝ¥¹‘½Ü€ô	É½ÝÍ•É]¥¹‘½Ü¹™É½µ]•‰½¹Ñ•¹ÑÌ¡•Ù•¹Ð¹Í•¹‘•È¤(€€€¥¹™•É•¹•EÕ•Õ”¹…¹•°¡•Ù•¹Ð¹Í•¹‘•È¹¥¤(€€€¥˜€¡Ý¥¹‘½Ü€ôôôÁ½ÁÕÁ]¥¹‘½Ü¤Ý¥¹‘½Ü¹¡¥‘” ¤(€€€Í¡½Ý]¥¹‘½Ü ¤(€€€¥˜€¡Á…å±½…ü¹Í½ÕÉ”€˜˜Á…å±½…ü¹É•ÍÕ±Ð¤ì(€€€€€Í…™•M•¹¡µ…¥¹]¥¹‘½Ü°€Á½ÁÕÀéÉ•ÍÕ±Ðœ°Á…å±½…¤(€€€ô(€€€É•ÑÕÉ¸ì½¬èÑÉÕ”ô(€ô¤(€¥Á5…¥¸¹¡…¹‘±” Á½ÁÕÀéÍ•Ðµ¡•¥¡Ðœ°€¡•Ù•¹Ð°É…Ý!•¥¡Ð¤€ôøì(€€€½¹ÍÐÝ¥¹‘½Ü€ô	É½ÝÍ•É]¥¹‘½Ü¹™É½µ]•‰½¹Ñ•¹ÑÌ¡•Ù•¹Ð¹Í•¹‘•È¤(€€€¥˜€ …Ý¥¹‘½ÜñðÝ¥¹‘½Ü€„ôôÁ½ÁÕÁ]¥¹‘½Ü¤É•ÑÕÉ¸ì½¬è™…±Í”ô(€€€¥˜€¡Á½ÁÕÁUÍ•ÉI•Í¥é•¤É•ÑÕÉ¸ì½¬èÑÉÕ”°Í­¥ÁÁ•èÑÉÕ”ô(€€€½¹ÍÐ‘¥ÍÁ±…å!•¥¡Ð€ôÍÉ••¸¹•Ñ¥ÍÁ±…å5…Ñ¡¥¹œ¡Ý¥¹‘½Ü¹•Ñ	½Õ¹‘Ì ¤¤¹Ý½É­É•„¹¡•¥¡Ð(€€€½¹ÍÐ¡•¥¡Ð€ô5…Ñ ¹µ…à¡A=AUA}5%9}!%!P°5…Ñ ¹µ¥¸¡‘¥ÍÁ±…å!•¥¡Ð°5…Ñ ¹É½Õ¹¡9Õµ‰•È¡É…Ý!•¥¡Ð¤ñð€ÈÐà¤¤¤(€€€Ý¥¹‘½Ü¹Í•ÑM¥é”¡Ý¥¹‘½Ü¹•ÑM¥é” ¥lÁt°¡•¥¡Ð°™…±Í”¤(€€€Á½Í¥Ñ¥½¹A½ÁÕÁ]¥¹‘½Ü ¤(€€€É•ÑÕÉ¸ì½¬èÑÉÕ”ô(€ô¤(€¥Á5…¥¸¹¡…¹‘±” Á½ÁÕÀéÍ•ÐµÁ¥¹¹•œ°€¡•Ù•¹Ð°É…ÝA¥¹¹•¤€ôøì(€€€½¹ÍÐÝ¥¹‘½Ü€ô	É½ÝÍ•É]¥¹‘½Ü¹™É½µ]•‰½¹Ñ•¹ÑÌ¡•Ù•¹Ð¹Í•¹‘•È¤(€€€¥˜€ …Ý¥¹‘½ÜñðÝ¥¹‘½Ü€„ôôÁ½ÁÕÁ]¥¹‘½Ü¤É•ÑÕÉ¸ì½¬è™…±Í”ô(€€€Í•ÑÑ¥¹Ì¹Á½ÁÕÁA¥¹¹•€ôÉ…ÝA¥¹¹•€ôôôÑÉÕ”(€€€Ý¥¹‘½Ü¹Í•Ñ±Ý…åÍ=¹Q½À¡Í•ÑÑ¥¹Ì¹Á½ÁÕÁA¥¹¹•°€™±½…Ñ¥¹œœ¤(€€€½¹ÍÐÁ•ÉÍ¥ÍÑ•€ôÍ…Ù•M•ÑÑ¥¹Ì ¤(€€€É•ÑÕÉ¸ì½¬èÑÉÕ”°Á¥¹¹•èÍ•ÑÑ¥¹Ì¹Á½ÁÕÁA¥¹¹•°Á•ÉÍ¥ÍÑ•ô(€ô¤(€¥Á5…¥¸¹¡…¹‘±” Á½ÁÕÀéÍ•Ðµ½Á…¥Ñäœ°€¡•Ù•¹Ð°É…Ý=Á…¥Ñä°Á•ÉÍ¥ÍÐ€ô™…±Í”¤€ôøì(€€€½¹ÍÐÝ¥¹‘½Ü€ô	É½ÝÍ•É]¥¹‘½Ü¹™É½µ]•‰½¹Ñ•¹ÑÌ¡•Ù•¹Ð¹Í•¹‘•È¤(€€€¥˜€ …Ý¥¹‘½ÜñðÝ¥¹‘½Ü€„ôôÁ½ÁÕÁ]¥¹‘½Ü¤É•ÑÕÉ¸ì½¬è™…±Í”ô(€€€Í•ÑÑ¥¹Ì¹Á½ÁÕÁ=Á…¥Ñä€ô±…µÁA½ÁÕÁ=Á…¥Ñä¡É…Ý=Á…¥Ñä¤(€€€Ý¥¹‘½Ü¹Í•Ñ=Á…¥Ñä¡Í•ÑÑ¥¹Ì¹Á½ÁÕÁ=Á…¥Ñä¤(€€€½¹ÍÐÁ•ÉÍ¥ÍÑ•€ôÁ•ÉÍ¥ÍÐ€üÍ…Ù•M•ÑÑ¥¹Ì ¤€èÑÉÕ”(€€€É•ÑÕÉ¸ì½¬èÑÉÕ”°½Á…¥ÑäèÍ•ÑÑ¥¹Ì¹Á½ÁÕÁ=Á…¥Ñä°Á•ÉÍ¥ÍÑ•ô(€ô¤(€¥Á5…¥¸¹¡…¹‘±” Á½ÁÕÀéÉ•Í¥é”µÍÑ…ÉÐœ°€¡•Ù•¹Ð°Á…å±½…¤€ôøì(€€€½¹ÍÐÝ¥¹‘½Ü€ô	É½ÝÍ•É]¥¹‘½Ü¹™É½µ]•‰½¹Ñ•¹ÑÌ¡•Ù•¹Ð¹Í•¹‘•È¤(€€€½¹ÍÐ‘¥É•Ñ¥½¸€ôMÑÉ¥¹œ¡Á…å±½…ü¹‘¥É•Ñ¥½¸ñð€œœ¤(€€€½¹ÍÐà€ô9Õµ‰•È¡Á…å±½…ü¹à¤(€€€½¹ÍÐä€ô9Õµ‰•È¡Á…å±½…ü¹ä¤(€€€¥˜€ …Ý¥¹‘½ÜñðÝ¥¹‘½Ü€„ôôÁ½ÁÕÁ]¥¹‘½Üñð€„½x¡¹ñ¹•ñ•ñÍ•ñÍñÍÝñÝñ¹Ü¤¼¹Ñ•ÍÐ¡‘¥É•Ñ¥½¸¤¤ì(€€€€€É•ÑÕÉ¸ì½¬è™…±Í”ô(€€€ô(€€€¥˜€ …9Õµ‰•È¹¥Í¥¹¥Ñ”¡à¤ñð€…9Õµ‰•È¹¥Í¥¹¥Ñ”¡ä¤¤É•ÑÕÉ¸ì½¬è™…±Í”ô(€€€½¹ÍÐÍÑ…ÉÑ	½Õ¹‘Ì€ôÝ¥¹‘½Ü¹•Ñ	½Õ¹‘Ì ¤(€€€Á½ÁÕÁI•Í¥é•M•ÍÍ¥½¸€ôì(€€€€€Í•¹‘•É%è•Ù•¹Ð¹Í•¹‘•È¹¥°(€€€€€‘¥É•Ñ¥½¸°(€€€€€ÍÑ…ÉÑ	½Õ¹‘Ì°(€€€€€ÍÑ…ÉÑA½¥¹Ðèìà°äô°(€€€€€Ý½É­É•„èÍÉ••¸¹•Ñ¥ÍÁ±…å5…Ñ¡¥¹œ¡ÍÑ…ÉÑ	½Õ¹‘Ì¤¹Ý½É­É•„°(€€€ô(€€€Á½ÁÕÁUÍ•ÉI•Í¥é•€ôÑÉÕ”(€€€É•ÑÕÉ¸ì½¬èÑÉÕ”ô(€ô¤(€¥Á5…¥¸¹¡…¹‘±” Á½ÁÕÀéÉ•Í¥é”µµ½Ù”œ°€¡•Ù•¹Ð°Á…å±½…¤€ôøì(€€€¥˜€ …Á½ÁÕÁ]¥¹‘½Üñð€…Á½ÁÕÁI•Í¥é•M•ÍÍ¥½¸ñðÁ½ÁÕÁI•Í¥é•M•ÍÍ¥½¸¹Í•¹‘•É%€„ôô•Ù•¹Ð¹Í•¹‘•È¹¥¤ì(€€€€€É•ÑÕÉ¸ì½¬è™…±Í”ô(€€€ô(€€€½¹ÍÐà€ô9Õµ‰•È¡Á…å±½…ü¹à¤(€€€½¹ÍÐä€ô9Õµ‰•È¡Á…å±½…ü¹ä¤(€€€¥˜€ …9Õµ‰•È¹¥Í¥¹¥Ñ”¡à¤ñð€…9Õµ‰•È¹¥Í¥¹¥Ñ”¡ä¤¤É•ÑÕÉ¸ì½¬è™…±Í”ô(€€€½¹ÍÐ‰½Õ¹‘Ì€ô…±Õ±…Ñ•A½ÁÕÁI•Í¥é•	½Õ¹‘Ì¡ì(€€€€€€¸¸¹Á½ÁÕÁI•Í¥é•M•ÍÍ¥½¸°(€€€€€ÕÉÉ•¹ÑA½¥¹Ðèìà°äô°(€€€ô¤(€€€Á½ÁÕÁ]¥¹‘½Ü¹Í•Ñ	½Õ¹‘Ì¡‰½Õ¹‘Ì°™…±Í”¤(€€€É•ÑÕÉ¸ì½¬èÑÉÕ”°‰½Õ¹‘Ìô(€ô¤(€¥Á5…¥¸¹¡…¹‘±” Á½ÁÕÀéÉ•Í¥é”µ•¹œ°€¡•Ù•¹Ð¤€ôøì(€€€¥˜€¡Á½ÁÕÁI•Í¥é•M•ÍÍ¥½¸ü¹Í•¹‘•É%€ôôô•Ù•¹Ð¹Í•¹‘•È¹¥¤Á½ÁÕÁI•Í¥é•M•ÍÍ¥½¸€ô¹Õ±°(€€€É•ÑÕÉ¸ì½¬èÑÉÕ”ô(€ô¤)ô()½¹ÍÐ½Ñ1½¬€ô…ÁÀ¹É•ÅÕ•ÍÑM¥¹±•%¹ÍÑ…¹•1½¬ ¤)¥˜€ …½Ñ1½¬¤ì(€…ÁÀ¹ÅÕ¥Ð ¤)ô•±Í”ì(€…ÁÀ¹½¸ Í•½¹µ¥¹ÍÑ…¹”œ°Í¡½Ý]¥¹‘½Ü¤(€…ÁÀ¹Ý¡•¹I•…‘ä ¤¹Ñ¡•¸¡…Íå¹Œ€ ¤€ôøì(€€€…ÁÀ¹Í•ÑÁÁUÍ•É5½‘•±% ÑÜ¹±¥¹½µÕÍ”¹‘•Í­Ñ½Àœ¤(€€€¹…Ñ¥Ù•Q¡•µ”¹Ñ¡•µ•M½ÕÉ”€ô€±¥¡Ðœ(€€€½¹ÍÐ±½…‘•‘M•ÑÑ¥¹Ì€ô±½…‘M•ÑÑ¥¹Ì ¤(€€€¡¥ÍÑ½ÉåMÑ½É”€ôÉ•…Ñ•!¥ÍÑ½ÉåMÑ½É”¡¡¥ÍÑ½ÉåA…Ñ  ¤¤(€€€¡¥ÍÑ½Éå±•…ÉA•¹‘¥¹œ€ô¡¥ÍÑ½ÉåMÑ½É”¹Í¹…ÁÍ¡½Ð ¤¹±•…ÉA•¹‘¥¹œ(€€€½¹ÍÐ¥¹¥Ñ¥…±!¥ÍÑ½ÉåM¹…ÁÍ¡½Ð€ô¡¥ÍÑ½ÉåMÑ½É”¹Í¹…ÁÍ¡½Ð ¤(€€€ÍÑ…ÉÑÕÁ!¥ÍÑ½Éå±•…ÉÕÑ¡½É¥é•€ô¥Í!¥ÍÑ½Éå±•…ÉAÉ•™•É•¹•áÁ±¥¥Ð¡ì(€€€€€Í…Ù•!¥ÍÑ½ÉäèÍ•ÑÑ¥¹Ì¹Í…Ù•!¥ÍÑ½Éä°(€€€€€Í•ÑÑ¥¹ÍM½ÕÉ”è±½…‘•‘M•ÑÑ¥¹Ì¹Í½ÕÉ”°(€€€€€Í•ÑÑ¥¹Í]É¥Ñ…‰±”è±½…‘•‘M•ÑÑ¥¹Ì¹ÝÉ¥Ñ…‰±”°(€€€ô¤(€€€¥˜€¡Í¡½Õ±‘±•…É!¥ÍÑ½Éå=¹MÑ…ÉÑÕÀ¡ì(€€€€€Í…Ù•!¥ÍÑ½ÉäèÍ•ÑÑ¥¹Ì¹Í…Ù•!¥ÍÑ½Éä°(€€€€€Í•ÑÑ¥¹ÍM½ÕÉ”è±½…‘•‘M•ÑÑ¥¹Ì¹Í½ÕÉ”°(€€€€€Í•ÑÑ¥¹Í]É¥Ñ…‰±”è±½…‘•‘M•ÑÑ¥¹Ì¹ÝÉ¥Ñ…‰±”°(€€€€€¡¥ÍÑ½Éå]É¥Ñ…‰±”è¥¹¥Ñ¥…±!¥ÍÑ½ÉåM¹…ÁÍ¡½Ð¹ÝÉ¥Ñ…‰±”°(€€€ô¤¤ì(€€€€€¡¥ÍÑ½Éå±•…ÉA•¹‘¥¹œ€ô€…¡¥ÍÑ½ÉåMÑ½É”¹±•…È ¤¹½¬(€€€ô(€€€¥˜€¡•‘¥Ñ¥½¸€ôôô€½™™±¥¹”œ¤½™™±¥¹•¹¥¹•MÑ…ÉÐ€ôì½¬è™…±Í”°ÍÑ…ÉÑ¥¹œèÑÉÕ”°•ÉÉ½Èè€œœô(€€€É•¥ÍÑ•É%ÁŒ ¤(€€€É•…Ñ•]¥¹‘½Ü ¤(€€€¥˜€ …¥ÍMµ½­•Q•ÍÐ¤É•…Ñ•QÉ…ä ¤(€€€¥˜€ …¥ÍMµ½­•Q•ÍÐ€˜˜•ÑA•É™½Éµ…¹•AÉ½™¥±” ¤¹É•Í½±Ù•‘5½‘”€„ôô€•¼œ¤ì(€€€€€É•…Ñ•A½ÁÕÁ]¥¹‘½Ü ¤(€€€ô(€€€½¹ÍÐ¡½½­%¹¥Ñ¥…±¥é…Ñ¥½¸€ôÍÑ…ÉÑ-•å‰½…É‘!½½¬ ¤(€€€½¹ÍÐ•¹¥¹•%¹¥Ñ¥…±¥é…Ñ¥½¸€ô¥¹¥Ñ¥…±¥é•=™™±¥¹•¹¥¹” ¤(€€€Á½Ý•É5½¹¥Ñ½È¹½¸ ÍÕÍÁ•¹œ°¡…¹‘±•MåÍÑ•µMÕÍÁ•¹¤(€€€Á½Ý•É5½¹¥Ñ½È¹½¸ É•ÍÕµ”œ°¡…¹‘±•MåÍÑ•µI•ÍÕµ”¤(€€€…Ý…¥Ð¡½½­%¹¥Ñ¥…±¥é…Ñ¥½¸((€€€¥˜€¡¥ÍMµ½­•Q•ÍÐ¤ì(€€€€€…Ý…¥Ð•¹¥¹•%¹¥Ñ¥…±¥é…Ñ¥½¸(€€€€€½¹Í½±”¹±½œ 1%9=5UM}M5=-}Idœ¤(€€€€€¥˜€¡¥ÍA½ÁÕÁ%¹Ñ•É…Ñ¥½¹Q•ÍÐ¤ì(€€€€€€€½¹Í½±”¹±½œ 1%9=5UM}A=AUA}QI%Iœ¤(€€€€€€€Í¡½Ý±¥Á‰½…É‘A½ÁÕÀ Ÿš"G’â7šb¿šVš?¢ºO’öƒž
ë¦nŽœ¤(€€€€€€€Í•ÑQ¥µ•½ÕÐ  ¤€ôøì(€€€€€€€€€½¹Í½±”¹•ÉÉ½È 1%9=5UM}A=AUA}QI9M1Q%=9}Q%5=UPœ¤(€€€€€€€€€ÁÉ½•ÍÌ¹•á¥Ñ½‘”€ô€Ä(€€€€€€€€€¥ÍEÕ¥ÑÑ¥¹œ€ôÑÉÕ”(€€€€€€€€€…ÁÀ¹ÅÕ¥Ð ¤(€€€€€€€ô°€ÄÈÁ|ÀÀÀ¤(€€€€€ô•±Í”¥˜€¡¥Í=™™±¥¹•%¹Ñ•É…Ñ¥½¹Q•ÍÐ¤ì(€€€€€€€ÑÉäì(€€€€€€€€€½¹ÍÐÁ•É™½Éµ…¹”€ô•ÑA•É™½Éµ…¹•AÉ½™¥±” ÄÈ¤(€€€€€€€€€½¹ÍÐÉ•ÍÕ±Ð€ô…Ý…¥ÐÑÉ…¹Í±…Ñ•]¥Ñ¡=±±…µ„¡ì(€€€€€€€€€€€Ñ•áÐè€Ÿš"G’â7šb¿šVš?¢ºO’öƒž
ë¦nŽœ°(€€€€€€€€€€€µ½‘•°èÍ•ÑÑ¥¹Ì¹µ½‘•°°(€€€€€€€€€€€‰…Í•UÉ°èÍ•ÑÑ¥¹Ì¹‰…Í•UÉ°°(€€€€€€€€€€€­••Á±¥Ù”èÁ•É™½Éµ…¹”¹­••Á±¥Ù”°(€€€€€€€€€€€‘•Ñ…¥±1•Ù•°èÁ•É™½Éµ…¹”¹‘•Ñ…¥±1•Ù•°°(€€€€€€€€€€€¹ÕµÑàèÁ•É™½Éµ…¹”¹¹ÕµÑà°(€€€€€€€€€€€¹ÕµAÉ•‘¥ÐèÁ•É™½Éµ…¹”¹¹ÕµAÉ•‘¥Ð°(€€€€€€€€€€€¹ÕµQ¡É•…èÁ•É™½Éµ…¹”¹¹ÕµQ¡É•…°(€€€€€€€€€ô¤(€€€€€€€€€½¹Í½±”¹±½œ¡1%9=5UM}=1%9}QI9M1Q%=9}=,ô‘í)M=8¹ÍÑÉ¥¹¥™ä¡ì(€€€€€€€€€€€‘•Ñ•Ñ•‘1…¹Õ…”èÉ•ÍÕ±Ð¹‘•Ñ•Ñ•‘1…¹Õ…”°(€€€€€€€€€€€Ñ…É•Ñ1…¹Õ…”èÉ•ÍÕ±Ð¹Ñ…É•Ñ1…¹Õ…”°(€€€€€€€€€€€ÑÉ…¹Í±…Ñ¥½¸èÉ•ÍÕ±Ð¹ÑÉ…¹Í±…Ñ¥½¸°(€€€€€€€€€€€•á…µÁ±•ÌèÉ•ÍÕ±Ð¹•á…µÁ±•Ìü¹±•¹Ñ °(€€€€€€€€€ô¥õ€¤(€€€€€€€ô…Ñ €¡•ÉÉ½È¤ì(€€€€€€€€€½¹Í½±”¹•ÉÉ½È¡1%9=5UM}=1%9}QI9M1Q%=9}%1ô‘íMÑÉ¥¹œ¡•ÉÉ½Èü¹µ•ÍÍ…”ñð•ÉÉ½È¥õ€¤(€€€€€€€€€ÁÉ½•ÍÌ¹•á¥Ñ½‘”€ô€Ä(€€€€€€€ô(€€€€€€€¥ÍEÕ¥ÑÑ¥¹œ€ôÑÉÕ”(€€€€€€€…ÁÀ¹ÅÕ¥Ð ¤(€€€€€ô•±Í”ì(€€€€€€€Í•ÑQ¥µ•½ÕÐ  ¤€ôøì(€€€€€€€€€¥ÍEÕ¥ÑÑ¥¹œ€ôÑÉÕ”(€€€€€€€€€…ÁÀ¹ÅÕ¥Ð ¤(€€€€€€€ô°€àÀÀ¤(€€€€€ô(€€€ô((€€€…ÁÀ¹½¸ …Ñ¥Ù…Ñ”œ°€ ¤€ôøì(€€€€€¥˜€¡	É½ÝÍ•É]¥¹‘½Ü¹•Ñ±±]¥¹‘½ÝÌ ¤¹±•¹Ñ €ôôô€À¤É•…Ñ•]¥¹‘½Ü ¤(€€€€€•±Í”Í¡½Ý]¥¹‘½Ü ¤(€€€ô¤(€ô¤)ô()…ÁÀ¹½¸ ‰•™½É”µÅÕ¥Ðœ°€ ¤€ôøì(€¥ÍEÕ¥ÑÑ¥¹œ€ôÑÉÕ”(€É•ÍÕµ•I•½Ù•Éå•¹•É…Ñ¥½¸€¬ô€Ä(€•¹¥¹•1¥™•å±••¹•É…Ñ¥½¸€¬ô€Ä(€•¹¥¹•1¥™•å±•½¹ÑÉ½±±•È¹…‰½ÉÐ ¤(€±•…ÉI•ÍÕµ•I•½Ù•ÉåQ¥µ•È ¤(€¥¹™•É•¹•EÕ•Õ”¹…¹•±±° ¤(€ÍÑ½Á=™™±¥¹•¹¥¹” ¤(€ÑÉäì(€€€¥˜€¡¡½½­MÑ…ÉÑ•¤­•å‰½…É‘!½½¬ü¹ÍÑ½À ¤(€ô…Ñ ì(€€€€¼¼9…Ñ¥Ù”¡½½¬µ…ä…±É•…‘ä‰”Í¡ÕÑÑ¥¹œ‘½Ý¸¸(€ô)ô¤()…ÁÀ¹½¸ Ý¥¹‘½Üµ…±°µ±½Í•œ°€ ¤€ôøì(€¥˜€¡ÁÉ½•ÍÌ¹Á±…Ñ™½É´€„ôô€‘…ÉÝ¥¸œ¤ì(€€€€¼¼-••ÀÑ¡”ÑÉ…ä…ÁÀ…±¥Ù”™½È‘½Õ‰±”µ½ÁäÑÉ…¹Í±…Ñ¥½¸¸(€ô)ô¤(