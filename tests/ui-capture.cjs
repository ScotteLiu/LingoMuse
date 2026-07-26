const { app, BrowserWindow, ipcMain } = require('electron')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const captureDirectory = join(root, 'work', 'ui-check')
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

// Software compositing keeps capturePage deterministic for hidden frameless
// windows; the production app continues to use normal hardware acceleration.
app.disableHardwareAcceleration()

const settings = {
  autoClipboard: true,
  autoSpeak: false,
  doubleCopyInterval: 720,
  voiceRate: 0.92,
  popupPinned: true,
  popupOpacity: 1,
  launchAtLogin: false,
  saveHistory: false,
  performanceMode: 'auto',
  model: 'qwen3:1.7b',
  baseUrl: 'http://127.0.0.1:11435',
}

const performance = {
  selectedMode: 'auto',
  resolvedMode: 'eco',
  totalMemoryGb: 8,
  availableMemoryGb: 3.8,
  logicalCores: 4,
  warmOnStart: false,
  keepAlive: '3m',
  detailLevel: 'compact',
  numCtx: 4096,
  numPredict: 700,
  numThread: 3,
}

const popupIpcCalls = {
  setPinned: [],
  setOpacity: [],
  resizeStart: [],
  resizeMove: [],
  resizeEnd: 0,
}

const result = {
  detectedLanguage: 'zh',
  targetLanguage: 'en',
  translation: 'I did not mean to put you in a difficult position.',
  literalMeaning: 'I did not intentionally make things difficult for you.',
  naturalnessNote: 'This sounds considerate and natural in everyday conversation.',
  pronunciation: { text: 'I did not mean to put you in a difficult position.', ipa: '/aɪ dɪd nɑt min tə pʊt ju ɪn ə ˈdɪfɪkəlt pəˈzɪʃən/' },
  alternatives: [{ text: "I wasn't trying to make things hard for you.", label: 'More casual' }],
  examples: [
    { source: '我不是故意讓你為難。', target: 'I did not mean to put you in a difficult position.', note: 'A considerate apology.' },
    { source: '我無意增加你的負擔。', target: 'I did not mean to add to your burden.', note: 'Useful at work.' },
  ],
  usageTips: ['Use “did not mean to” to clarify that an outcome was not intentional.'],
  keywords: [{ term: 'mean to', meaning: 'intend to do something' }],
}

function registerMocks() {
  const snapshot = {
    settings,
    platform: 'win32',
    version: '1.1.1-dev',
    edition: 'offline',
    offlineEngineStart: { ok: true },
    offlineWarmup: { ok: true, skipped: true, reason: 'eco' },
    settingsPersistence: { writable: true, persisted: true, reason: '' },
    historyClearPending: false,
    historyClearAuthorized: true,
    performance,
    hook: { active: true, available: true },
    engine: { online: true, modelReady: true, models: [], model: settings.model },
  }
  ipcMain.handle('app:get-state', () => snapshot)
  ipcMain.handle('history:list', () => ({ revision: 0, history: [], clearPending: false }))
  ipcMain.handle('history:import', () => ({ ok: true, error: '', revision: 0, history: [], clearPending: false }))
  ipcMain.handle('history:add', () => ({ ok: false, error: 'DISABLED', revision: 0, history: [], clearPending: false }))
  ipcMain.handle('popup:ready', () => ({
    payload: { text: '我不是故意讓你為難。', timestamp: Date.now() },
    settings,
    edition: 'offline',
  }))
  ipcMain.handle('translation:run', () => ({ ok: true, result }))
  ipcMain.handle('translation:cancel', () => ({ ok: true }))
  ipcMain.handle('popup:set-height', () => ({ ok: true }))
  ipcMain.handle('popup:set-pinned', (_event, pinned) => {
    popupIpcCalls.setPinned.push(pinned)
    return { ok: true, pinned, persisted: true }
  })
  ipcMain.handle('popup:set-opacity', (_event, opacity, persist) => {
    popupIpcCalls.setOpacity.push({ opacity, persist })
    return { ok: true, opacity, persisted: true }
  })
  ipcMain.handle('popup:resize-start', (_event, payload) => {
    popupIpcCalls.resizeStart.push(payload)
    return { ok: true }
  })
  ipcMain.handle('popup:resize-move', (_event, payload) => {
    popupIpcCalls.resizeMove.push(payload)
    return { ok: true }
  })
  ipcMain.handle('popup:resize-end', () => {
    popupIpcCalls.resizeEnd += 1
    return { ok: true }
  })
}

async function capture(window, name) {
  const image = await window.webContents.capturePage()
  writeFileSync(join(captureDirectory, name), image.toPNG())
}

async function assertViewport(window, label) {
  const metrics = await window.webContents.executeJavaScript(`(() => {
    const buttons = [...document.querySelectorAll('.window-actions button')].map((button) => {
      const rect = button.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    });
    return {
      innerWidth,
      innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      buttons,
      noticeVisible: Boolean(document.querySelector('.speech-notice')),
    };
  })()`)
  const overflow = metrics.scrollWidth > metrics.innerWidth
  const buttonOutside = metrics.buttons.some((rect) => (
    rect.left < 0 || rect.right > metrics.innerWidth || rect.top < 0 || rect.bottom > metrics.innerHeight
  ))
  console.log(`LINGOMUSE_UI_${label}=${JSON.stringify({ ...metrics, overflow, buttonOutside })}`)
  if (overflow || buttonOutside) throw new Error(`${label}_VIEWPORT_OVERFLOW`)
  return metrics
}

app.whenReady().then(async () => {
  mkdirSync(captureDirectory, { recursive: true })
  registerMocks()
  const preload = join(root, 'electron', 'preload.cjs')
  const entry = join(root, 'dist', 'index.html')

  const mainWindow = new BrowserWindow({
    width: 640,
    height: 480,
    show: false,
    frame: false,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Hidden test windows otherwise pause the drawer's compositor animation
      // and capture a misleading half-transparent frame.
      backgroundThrottling: false,
    },
  })
  await mainWindow.loadFile(entry)
  await mainWindow.webContents.executeJavaScript(`
    localStorage.setItem('lingomuse:onboarding-complete', '1');
    localStorage.setItem('lingomuse:history', '["legacy-sentinel"]');
  `)
  await mainWindow.reload()
  await delay(150)
  const legacyHistory = await mainWindow.webContents.executeJavaScript(
    "localStorage.getItem('lingomuse:history')",
  )
  if (legacyHistory !== null) throw new Error('AUTHORIZED_LEGACY_HISTORY_NOT_CLEARED')
  await capture(mainWindow, 'main-640x480.png')
  await mainWindow.webContents.executeJavaScript("document.querySelector('[data-action=open-settings]')?.click()")
  await delay(450)
  const drawerMetrics = await mainWindow.webContents.executeJavaScript(`(() => {
    const drawer = document.querySelector('.settings-drawer');
    const backdrop = document.querySelector('.drawer-backdrop');
    const style = drawer && getComputedStyle(drawer);
    const centerElements = document.elementsFromPoint(innerWidth / 2, innerHeight / 2);
    const topCenterElement = centerElements[0];
    return {
      opacity: style?.opacity,
      background: style?.backgroundColor,
      zIndex: style?.zIndex,
      backdropZIndex: backdrop && getComputedStyle(backdrop).zIndex,
      topAtCenter: centerElements
        .slice(0, 5)
        .map((element) => element.className || element.tagName),
      topAtCenterInsideDrawer: Boolean(topCenterElement?.closest('.settings-drawer')),
      topAtCenterIsBackdrop: Boolean(topCenterElement?.classList.contains('drawer-backdrop')),
      animations: drawer?.getAnimations().map((animation) => ({
        playState: animation.playState,
        currentTime: animation.currentTime,
      })) || [],
    };
  })()`)
  console.log(`LINGOMUSE_UI_SETTINGS=${JSON.stringify(drawerMetrics)}`)
  if (
    drawerMetrics.opacity !== '1'
    || drawerMetrics.zIndex !== '21'
    || !drawerMetrics.topAtCenterInsideDrawer
    || drawerMetrics.topAtCenterIsBackdrop
  ) {
    throw new Error('SETTINGS_DRAWER_NOT_FULLY_VISIBLE')
  }
  await capture(mainWindow, 'settings-640x480.png')

  const popupWindow = new BrowserWindow({
    width: 360,
    height: 380,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  })
  await popupWindow.loadFile(entry, { query: { view: 'popup' } })
  await delay(250)
  await popupWindow.webContents.executeJavaScript(`
    Object.defineProperty(window.speechSynthesis, 'getVoices', { configurable: true, value: () => [] });
    document.querySelector('[data-action=speak]')?.click();
  `)
  await delay(1_700)
  const metrics = await assertViewport(popupWindow, 'POPUP_360X380')
  if (!metrics.noticeVisible) throw new Error('POPUP_SPEECH_NOTICE_MISSING')
  await capture(popupWindow, 'popup-speech-360x380.png')

  await popupWindow.webContents.executeJavaScript(`(async () => {
    document.querySelector('[data-action=toggle-pin]')?.click();

    document.querySelector('[data-action=toggle-opacity]')?.click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const opacity = document.querySelector('[data-opacity]');
    if (!opacity) throw new Error('POPUP_OPACITY_CONTROL_MISSING');
    opacity.value = '68';
    opacity.dispatchEvent(new Event('input', { bubbles: true }));
    opacity.dispatchEvent(new Event('change', { bubbles: true }));

    const handle = document.querySelector('[data-resize=se]');
    if (!handle) throw new Error('POPUP_RESIZE_HANDLE_MISSING');
    Object.defineProperty(handle, 'setPointerCapture', {
      configurable: true,
      value: () => {},
    });
    const rect = handle.getBoundingClientRect();
    const clientX = Math.max(0, rect.right - 1);
    const clientY = Math.max(0, rect.bottom - 1);
    handle.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      pointerId: 41,
      pointerType: 'mouse',
      button: 0,
      buttons: 1,
      clientX,
      clientY,
      screenX: 900,
      screenY: 700,
    }));
    handle.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true,
      pointerId: 41,
      pointerType: 'mouse',
      button: 0,
      buttons: 1,
      clientX: clientX + 20,
      clientY: clientY + 16,
      screenX: 920,
      screenY: 716,
    }));
    handle.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true,
      pointerId: 41,
      pointerType: 'mouse',
      button: 0,
      buttons: 0,
      clientX: clientX + 20,
      clientY: clientY + 16,
      screenX: 920,
      screenY: 716,
    }));
  })()`)
  await delay(100)

  console.log(`LINGOMUSE_UI_POPUP_CONTROLS=${JSON.stringify(popupIpcCalls)}`)
  const opacityPreview = popupIpcCalls.setOpacity.find((call) => call.opacity === 0.68 && call.persist === false)
  const opacityPersist = popupIpcCalls.setOpacity.find((call) => call.opacity === 0.68 && call.persist === true)
  if (
    popupIpcCalls.setPinned.length !== 1
    || popupIpcCalls.setPinned[0] !== false
    || !opacityPreview
    || !opacityPersist
    || popupIpcCalls.resizeStart.length !== 1
    || popupIpcCalls.resizeStart[0]?.direction !== 'se'
    || popupIpcCalls.resizeMove.length < 1
    || popupIpcCalls.resizeEnd !== 1
  ) {
    throw new Error('POPUP_CONTROLS_IPC_FLOW_INCOMPLETE')
  }

  mainWindow.destroy()
  popupWindow.destroy()
  app.quit()
}).catch((error) => {
  console.error(`LINGOMUSE_UI_CAPTURE_FAILED=${String(error?.stack || error)}`)
  process.exitCode = 1
  app.quit()
})
