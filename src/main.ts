import './styles.css'
import { desktopApi, isDesktop } from './api'
import { DEMO_RESULT, DEMO_SOURCE } from './demo'
import { HISTORY_KEY, readHistory } from './history'
import { icon } from './icons'
import { waitForLocalSpeechVoice } from './local-speech'
import { PRIVACY_DEFAULTS } from '../electron/privacy-defaults.mjs'
import type {
  AppSnapshot,
  HistoryEntry,
  HookStatus,
  LanguageCode,
  ModelProgress,
  Settings,
  TranslationResult,
} from './types'

const root = document.querySelector<HTMLDivElement>('#app')!
const announcer = document.createElement('div')
announcer.className = 'sr-only'
announcer.setAttribute('role', 'status')
announcer.setAttribute('aria-live', 'polite')
announcer.setAttribute('aria-atomic', 'true')
document.body.appendChild(announcer)

type Trigger = 'manual' | 'clipboard'

interface UiState extends AppSnapshot {
  input: string
  result: TranslationResult | null
  history: HistoryEntry[]
  historyRevision: number
  historyWarning: string
  loading: boolean
  pulling: boolean
  restartingEngine: boolean
  progress: ModelProgress | null
  error: string
  isDemo: boolean
  settingsOpen: boolean
  guideOpen: boolean
  toast: string
  partial: {
    source: string
    detectedLanguage: LanguageCode
    targetLanguage: LanguageCode
    translation: string
    elapsedMs: number
  } | null
}

const defaultSettings: Settings = {
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

const state: UiState = {
  settings: defaultSettings,
  platform: 'browser',
  version: '1.0.0',
  edition: 'light',
  offlineEngineStart: { ok: false },
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
  hook: { active: false, available: false },
  engine: { online: false, modelReady: false, models: [], model: defaultSettings.model },
  input: DEMO_SOURCE,
  result: DEMO_RESULT,
  history: [],
  // Revision 0 is a valid first snapshot from the main process. Starting at
  // -1 lets us reject equal-revision late replies after the first snapshot.
  historyRevision: -1,
  historyWarning: '',
  loading: false,
  pulling: false,
  restartingEngine: false,
  progress: null,
  error: '',
  isDemo: true,
  settingsOpen: false,
  guideOpen: false,
  toast: '',
  partial: null,
}

const MODEL_CHOICES = [
  {
    id: 'qwen3:1.7b',
    name: 'è¼•å¿«ç‰ˆ',
    size: '1.4 GB',
    description: 'é©åˆæ—¥å¸¸çŸ­å¥èˆ‡è¾¦å…¬å…§å®¹ï¼Œä¸€èˆ¬é›»è…¦é¦–é¸',
    recommended: true,
  },
  {
    id: 'qwen3:4b-instruct',
    name: 'ç´°è†©ç‰ˆ',
    size: '2.5 GB',
    description: 'é•·å¥èˆ‡å¾®å¦™èªæ°£æ›´ç©©å®š',
  },
  {
    id: 'qwen3:8b',
    name: 'é€²éšç‰ˆ',
    size: '5.2 GB',
    description: 'èªæ°£æ›´ç´°ç·»ï¼Œå»ºè­° 16 GB ä»¥ä¸Š',
  },
]

let toastTimer = 0
let lastProgressPercent = -1
let mainRequestSequence = 0
let speechAttempt = 0
let speechWaitController: AbortController | null = null
let activeMainRequestId = ''
let activeMainSource = ''
let historyMigrationGeneration = 0
const ONBOARDING_KEY = 'lingomuse:onboarding-complete'

function announce(message: string): void {
  announcer.textContent = ''
  window.requestAnimationFrame(() => {
    announcer.textContent = message
  })
}

function captureFocus(): {
  id: string
  action: string
  setting: string
  mode: string
  model: string
  index: string
  selectionStart: number | null
  selectionEnd: number | null
} | null {
  const element = document.activeElement as HTMLInputElement | HTMLTextAreaElement | HTMLElement | null
  if (!element || element === document.body) return null
  return {
    id: element.id || '',
    action: element.dataset?.action || '',
    setting: element.dataset?.setting || '',
    mode: element.dataset?.mode || '',
    model: element.dataset?.model || '',
    index: element.dataset?.index || '',
    selectionStart: 'selectionStart' in element ? element.selectionStart : null,
    selectionEnd: 'selectionEnd' in element ? element.selectionEnd : null,
  }
}

function restoreFocus(snapshot: ReturnType<typeof captureFocus>): void {
  if (!snapshot) return
  window.requestAnimationFrame(() => {
    const controls = Array.from(root.querySelectorAll<HTMLElement>('button, input, textarea, summary'))
    const element = controls.find((candidate) => (
      (snapshot.id && candidate.id === snapshot.id)
      || (snapshot.action && candidate.dataset.action === snapshot.action
        && (!snapshot.mode || candidate.dataset.mode === snapshot.mode)
        && (!snapshot.model || candidate.dataset.model === snapshot.model)
        && (!snapshot.index || candidate.dataset.index === snapshot.index))
      || (snapshot.setting && candidate.dataset.setting === snapshot.setting)
    )) as HTMLInputElement | HTMLTextAreaElement | HTMLElement | undefined
    element?.focus()
    if (
      element
      && 'setSelectionRange' in element
      && snapshot.selectionStart !== null
      && snapshot.selectionEnd !== null
    ) {
      element.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd)
    }
  })
}

function onboardingCompleted(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_KEY) === '1'
  } catch {
    return false
  }
}

function completeOnboarding(): void {
  try {
    localStorage.setItem(ONBOARDING_KEY, '1')
  } catch {
    // The guide remains usable even if browser storage is unavailable.
  }
}

function focusActiveDialog(): void {
  window.requestAnimationFrame(() => {
    const dialog = document.querySelector<HTMLElement>('.guide-modal, .settings-drawer')
    dialog?.querySelector<HTMLElement>('button, input, summary, [tabindex]:not([tabindex="-1"])')?.focus()
  })
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function applyHistorySnapshot(
  snapshot: {
    revision: number
    history: HistoryEntry[]
    clearPending: boolean
    writable?: boolean
    reason?: string
  },
  showEntries = state.settings.saveHistory,
): boolean {
  if (snapshot.revision <= state.historyRevision) return false
  state.historyRevision = snapshot.revision
  state.history = showEntries ? snapshot.history : []
  state.historyClearPending = snapshot.clearPending
  if (snapshot.writable === false) {
    state.historyWarning = snapshot.reason === 'UNSUPPORTED_VERSION'
      ? 'æ­·å²æª”ä¾†è‡ªè¼ƒæ–°çš„ç‰ˆæœ¬ï¼›ç›®å‰ä¿æŒå”¯è®€ï¼Œä¸æœƒè¦†å¯«åŸæª”ã€‚'
      : 'Windows æš«æ™‚ç„¡æ³•è®€å–æœ¬æ©Ÿæ­·å²æª”ï¼›ç‚ºé¿å…è¦†å¯«ï¼Œæ­·å²å·²æš«åœï¼Œé‡æ–°é–‹å•Ÿç¨‹å¼å¾Œæœƒå†å˜—è©¦ã€‚'
  } else if (
    !snapshot.clearPending
    && (
      state.historyWarning.includes('ç£ç¢Ÿæ¸…é™¤')
      || state.historyWarning.includes('ä¿æŒå”¯è®€')
      || state.historyWarning.includes('ç„¡æ³•è®€å–æœ¬æ©Ÿæ­·å²æª”')
    )
  ) {
    state.historyWarning = ''
  }
  return true
}

async function synchronizeSavedHistory(): Promise<void> {
  const migrationGeneration = ++historyMigrationGeneration
  const legacyHistory = loadLegacyHistory()
  if (legacyHistory.length) {
    const migrated = await desktopApi.importHistory(legacyHistory)
    const migrationIsCurrent = migrationGeneration === historyMigrationGeneration
      && state.settings.saveHistory
    if (!migrationIsCurrent) {
      state.history = []
      return
    }
    if (migrated.ok) {
      applyHistorySnapshot(migrated)
      if (!clearLegacyHistory()) {
        state.historyWarning = 'èˆŠç‰ˆæ­·å²å·²å®‰å…¨æ¬ç§»ï¼Œä½†èˆŠå„²å­˜å€æš«æ™‚ç„¡æ³•ç§»é™¤ã€‚'
      }
    } else {
      state.history = legacyHistory
      state.historyWarning = 'èˆŠç‰ˆæ­·å²å°šæœªå®Œæˆæ¬ç§»ï¼ŒåŸè³‡æ–™ä»ä¿ç•™ï¼Œä¸‹æ¬¡å•Ÿå‹•æœƒé‡è©¦ã€‚'
    }
    return
  }

  const savedHistory = await desktopApi.listHistory()
  if (migrationGeneration === historyMigrationGeneration && state.settings.saveHistory) {
    applyHistorySnapshot(savedHistory)
  } else {
    state.history = []
  }
}

function persistenceWarningMessage(): string {
  const warnings: string[] = []
  if (!state.settingsPersistence.persisted) {
    warnings.push(state.settingsPersistence.reason === 'RECOVERED_BACKUP'
      ? 'è¨­å®šå·²å¾å‚™ä»½å®‰å…¨å¾©åŸï¼›æ¶‰åŠéš±ç§çš„é–‹é—œæš«æ™‚ä¿æŒé—œé–‰ã€‚é‡æ–°é–‹å•Ÿå¾Œæœƒè®€å–å·²å¾©åŸåå¥½ï¼Œä¹Ÿå¯åœ¨æ­¤é‡æ–°é¸æ“‡ã€‚'
      : state.settingsPersistence.writable
        ? 'Windows æš«æ™‚ç„¡æ³•ä¿å­˜è¨­å®šï¼›æœ¬æ¬¡éš±ç§é–‹é—œå·²ç«‹å³ç”Ÿæ•ˆï¼Œä½†é‡å•Ÿå‰è«‹ä¿æŒç¨‹å¼é–‹å•Ÿã€‚'
      : state.settingsPersistence.reason === 'UNREADABLE'
        ? 'Windows æš«æ™‚é–ä½è¨­å®šæª”ï¼›ç‚ºé¿å…è¦†å¯«ï¼Œè®Šæ›´åªåœ¨ç›®å‰åŸ·è¡ŒæœŸé–“ç”Ÿæ•ˆã€‚'
        : 'è¨­å®šæª”ä¾†è‡ªè¼ƒæ–°çš„ç‰ˆæœ¬ï¼›æœ¬æ¬¡è®Šæ›´åªåœ¨ç›®å‰åŸ·è¡ŒæœŸé–“ç”Ÿæ•ˆï¼ŒèˆŠæª”ä¸æœƒè¢«è¦†å¯«ã€‚')
  }
  if (state.historyClearPending) {
    warnings.push(state.settings.saveHistory
      ? 'æ­·å²æ¸…é™¤å°šæœªå®Œæˆï¼Œæ–°çš„æ­·å²å·²æš«åœå¯«å…¥ï¼Œç­‰å¾… Windows è§£é™¤æª”æ¡ˆå ç”¨ã€‚'
      : 'æ­·å²å·²åœæ­¢é¡¯ç¤ºèˆ‡æ–°å¢ï¼Œä½†ç£ç¢Ÿæ¸…é™¤ä»åœ¨ç­‰å¾… Windows è§£é™¤æª”æ¡ˆå ç”¨ã€‚')
  } else if (state.historyWarning) {
    warnings.push(state.historyWarning)
  }
  return [...new Set(warnings)].join(' ')
}

function renderPersistenceWarning(): string {
  const message = persistenceWarningMessage()
  return message
    ? `<div class="persistence-warning">${icon('info', 17)}<span>${escapeHtml(message)}</span><button type="button" data-action="open-settings">æŸ¥çœ‹è¨­å®š</button></div>`
    : ''
}

function languageTag(language: LanguageCode): string {
  return language === 'zh' ? 'zh-Hant' : 'en'
}

function truncate(value: string, length = 42): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length > length ? `${clean.slice(0, length)}â€¦` : clean
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp)
  const today = new Date()
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString('zh-TW', { month: 'short', day: 'numeric' })
}

function formatBytes(bytes: number): string {
  if (!bytes) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index >= 3 ? 1 : 0)} ${units[index]}`
}

function isModelInstalled(model: string): boolean {
  const wanted = model.toLowerCase()
  return state.engine.models.some((item) => {
    const name = item.name.toLowerCase()
    return name === wanted || name === `${wanted}:latest`
  })
}

function render(): void {
  const focusSnapshot = captureFocus()
  root.innerHTML = `
    <div class="app-shell">
      ${renderSidebar()}
      <section class="workspace">
        ${renderTitlebar()}
        <main class="main-scroll">
          ${renderPersistenceWarning()}
          ${renderHero()}
          ${renderSetupNotice()}
          ${renderTranslator()}
          <footer class="app-footer">
            <span>${icon('shield', 15)} æœ¬æ©Ÿé‹ç®— Â· ä¸ä¸Šå‚³å…§å®¹ Â· æ°¸ä¹…é›¶ API è²»ç”¨</span>
            <button type="button" data-action="open-guide">ä½¿ç”¨æŒ‡å—</button>
          </footer>
        </main>
      </section>
      ${renderSettings()}
      ${renderGuide()}
      ${state.toast ? `<div class="toast">${icon('check', 17)} ${escapeHtml(state.toast)}</div>` : ''}
    </div>
  `
  updateVoiceLabels()
  const backgroundIsInert = state.settingsOpen || state.guideOpen
  const sidebar = root.querySelector<HTMLElement>('.sidebar')
  const workspace = root.querySelector<HTMLElement>('.workspace')
  if (sidebar) sidebar.inert = backgroundIsInert
  if (workspace) workspace.inert = backgroundIsInert
  restoreFocus(focusSnapshot)
}

function renderSidebar(): string {
  const history = state.history.length
    ? state.history
        .slice(0, 12)
        .map(
          (entry) => `
          <button class="history-item" type="button" data-action="history" data-id="${escapeHtml(entry.id)}">
            <span class="history-langs">${entry.result.detectedLanguage.toUpperCase()} â†’ ${entry.result.targetLanguage.toUpperCase()}</span>
            <strong>${escapeHtml(truncate(entry.source))}</strong>
            <small>${escapeHtml(formatDate(entry.createdAt))}</small>
          </button>`,
        )
        .join('')
    : `<div class="empty-history">${icon('history', 24)}<span>${state.settings.saveHistory ? 'ç¿»è­¯å¾Œåªæœƒä¿å­˜åœ¨é€™å°é›»è…¦' : 'æœ€è¿‘ç¿»è­¯ç›®å‰ä¸æœƒä¿å­˜'}</span></div>`

  const engineClass = state.engine.online && state.engine.modelReady ? 'ready' : 'needs-setup'
  const engineLabel = state.edition === 'offline' && state.engine.online && state.engine.modelReady
    ? 'å®Œæ•´é›¢ç·šå¼•æ“å·²å°±ç·’'
    : !state.engine.online
      ? state.edition === 'offline'
        ? state.offlineEngineStart?.starting ? 'æ­£åœ¨å•Ÿå‹•å…§å»ºå¼•æ“' : 'å…§å»ºå¼•æ“å•Ÿå‹•å¤±æ•—'
        : 'å°šæœªé€£æ¥æœ¬æ©Ÿå¼•æ“'
      : state.engine.modelReady
        ? 'æœ¬æ©Ÿèªè¨€å¼•æ“å°±ç·’'
        : state.edition === 'offline' ? 'æ­£åœ¨è¼‰å…¥å…§å»ºæ¨¡å‹' : 'éœ€è¦ä¸‹è¼‰èªè¨€æ¨¡å‹'

  return `
    <aside class="sidebar">
      <div class="brand-block">
        <div class="brand-mark" aria-hidden="true"><span>L</span><i>â†—</i></div>
        <div><strong>LingoMuse</strong><small>éˆè­¯</small></div>
      </div>

      <button class="new-button" type="button" data-action="new">
        ${icon('plus', 18)} æ–°çš„ç¿»è­¯
      </button>

      <div class="side-label">
        <span>æœ€è¿‘æŸ¥è©¢</span>
        ${state.history.length ? `<button type="button" data-action="clear-history" aria-label="æ¸…é™¤æ­·å²">${icon('trash', 14)}</button>` : ''}
      </div>
      <div class="history-list">${history}</div>

      <button class="engine-mini ${engineClass}" type="button" data-action="open-settings">
        <span class="engine-dot"></span>
        <span><strong>${escapeHtml(engineLabel)}</strong><small>${escapeHtml(state.settings.model)}</small></span>
        ${icon('chevron', 16)}
      </button>
      <div class="zero-cost-stamp">NT$ 0 <span>æ°¸ä¹…é›¶ç”¨é‡è²»</span></div>
    </aside>
  `
}

function renderTitlebar(): string {
  const statusText = state.engine.online && state.engine.modelReady
    ? state.edition === 'offline' ? 'å®Œæ•´é›¢ç·šç‰ˆå·²å°±ç·’' : 'é›¢ç·šç¿»è­¯å·²å°±ç·’'
    : state.edition === 'offline' ? 'æ­£åœ¨å•Ÿå‹•å…§å»ºå¼•æ“' : 'ç­‰å¾…æœ¬æ©Ÿå¼•æ“'
  return `
    <header class="titlebar">
      <div class="drag-zone"></div>
     ÷_v¶‰ËkºwµçEÍĞ Ÿš¶–r£šê[–
d]¥¹‘½İÌƒšr³š¦¢ª{¦~ÏŠ˜œ¤(€½¹ÍĞ‘•¥Í¥½¸€ô…İ…¥Ğİ…¥Ñ½É1½…±MÁ••¡Y½¥”¡İ¥¹‘½Ü¹ÍÁ••¡Må¹Ñ¡•Í¥Ì°±…¹Õ…”°ì(€€€Ñ¥µ•½ÕÑ5Ìè€Å|ÔÀÀ°(€€€Í¥¹…°è½¹ÑÉ½±±•È¹Í¥¹…°°(€ô¤(€¥˜€¡½¹ÑÉ½±±•È¹Í¥¹…°¹…‰½ÉÑ•ñğ…ÑÑ•µÁĞ€„ôôÍÁ••¡ÑÑ•µÁĞ¤É•ÑÕÉ¸™…±Í”(€ÍÁ••¡]…¥Ñ½¹ÑÉ½±±•È€ô¹Õ±°(€¥˜€¡‘•¥Í¥½¸¹ÍÑ…ÑÕÌ€„ôô€É•…‘äœ¤ì(€€€½¹ÍĞµ•ÍÍ…”€ô€Ÿš&û’â7–"Ãnã²›j]¥¹‘½İÌƒšr³š¦¢ª{¦~Ï¾ò3–nƒš¶“šr«šr_¢º¾òošZ–¶_šÊKšr'¦–ë¦nï¢›œ(€€€Í¡½İQ½…ÍĞ¡µ•ÍÍ…”¤(€€€É•ÑÕÉ¸™…±Í”(€ô(€½¹ÍĞÕÑÑ•É…¹”€ô¹•ÜMÁ••¡Må¹Ñ¡•Í¥ÍUÑÑ•É…¹”¡Ñ•áĞ¤(€ÕÑÑ•É…¹”¹±…¹œ€ô±…¹Õ…”(€ÕÑÑ•É…¹”¹É…Ñ”€ôÍÑ…Ñ”¹Í•ÑÑ¥¹Ì¹Ù½¥•I…Ñ”(€ÕÑÑ•É…¹”¹Ù½¥”€ô‘•¥Í¥½¸¹Ù½¥”(€ÕÑÑ•É…¹”¹½¹•ÉÉ½È€ô€ ¤€ôøì(€€€¥˜€¡…ÑÑ•µÁĞ€ôôôÍÁ••¡ÑÑ•µÁĞ¤Í¡½İQ½…ÍĞ ]¥¹‘½İÌƒšr³š¦¢ª{¦~Ïšr_¢º–’ÇšV_¾òošZ–¶_šÊKšr'¦–ë¦nï¢›œ¤(€ô(€İ¥¹‘½Ü¹ÍÁ••¡Må¹Ñ¡•Í¥Ì¹ÍÁ•…¬¡ÕÑÑ•É…¹”¤(€Í¡½İQ½…ÍĞ Ÿš¶–r£’öÿR ]¥¹‘½İÌƒšr³š¦¢ª{¦~Ïšr_¢º œ¤(€É•ÑÕÉ¸ÑÉÕ”)ô()™Õ¹Ñ¥½¸ÍÁ•…­¹±¥Í¡M¥‘”¡É•ÍÕ±ĞèQÉ…¹Í±…Ñ¥½¹I•ÍÕ±Ğ°Í½ÕÉ”èÍÑÉ¥¹œ¤èÙ½¥ì(€Ù½¥ÍÁ•…¬¡É•ÍÕ±Ğ¹‘•Ñ•Ñ•‘1…¹Õ…”€ôôô€•¸œ€üÍ½ÕÉ”€èÉ•ÍÕ±Ğ¹ÑÉ…¹Í±…Ñ¥½¸°€•¸µULœ¤)ô()…Íå¹Œ™Õ¹Ñ¥½¸½ÁåQ•áĞ¡Ñ•áĞèÍÑÉ¥¹œ¤èAÉ½µ¥Í”ñÙ½¥øì(€ÑÉäì(€€€…İ…¥Ğ¹…Ù¥…Ñ½È¹±¥Á‰½…É¹İÉ¥Ñ•Q•áĞ¡Ñ•áĞ¤(€ô…Ñ ì(€€€½¹ÍĞÑ•áÑ…É•„€ô‘½Õµ•¹Ğ¹É•…Ñ•±•µ•¹Ğ Ñ•áÑ…É•„œ¤(€€€Ñ•áÑ…É•„¹Ù…±Õ”€ôÑ•áĞ(€€€‘½Õµ•¹Ğ¹‰½‘ä¹…ÁÁ•¹‘¡¥±¡Ñ•áÑ…É•„¤(€€€Ñ•áÑ…É•„¹Í•±•Ğ ¤(€€€‘½Õµ•¹Ğ¹•á•½µµ…¹ ½Áäœ¤(€€€Ñ•áÑ…É•„¹É•µ½Ù” ¤(€ô(€Í¡½İQ½…ÍĞ Ÿ–ŞË¢’¢÷–"Ã–&«¢ÊóÂüœ¤)ô()…Íå¹Œ™Õ¹Ñ¥½¸É•™É•Í¡¹¥¹”¡Í¡½İ••‘‰…¬€ô™…±Í”¤èAÉ½µ¥Í”ñÙ½¥øì(€ÍÑ…Ñ”¹•¹¥¹”€ô…İ…¥Ğ‘•Í­Ñ½ÁÁ¤¹•Ñ¹¥¹•MÑ…ÑÕÌ ¤(€¥˜€¡Í¡½İ••‘‰…¬¤Í¡½İQ½…ÍĞ¡ÍÑ…Ñ”¹•¹¥¹”¹½¹±¥¹”€ü€Ÿ–ŞËš&û–"Ãšr³š¦¢ª{¢¢–òWšN8œ€è€Ÿn»–&7’î7š&û’â7–"À=±±…µ„œ¤(€•±Í”É•¹‘•È ¤)ô()…Íå¹Œ™Õ¹Ñ¥½¸ÕÁ‘…Ñ•M•ÑÑ¥¹œ¡­•äè­•å½˜M•ÑÑ¥¹Ì°Ù…±Õ”èM•ÑÑ¥¹Ím­•å½˜M•ÑÑ¥¹Ít¤èAÉ½µ¥Í”ñÙ½¥øì(€½¹ÍĞ‘¥Í…‰±¥¹!¥ÍÑ½Éä€ô­•ä€ôôô€Í…Ù•!¥ÍÑ½Éäœ€˜˜Ù…±Õ”€ôôô™…±Í”(€¥˜€¡‘¥Í…‰±¥¹!¥ÍÑ½Éä¤ì(€€€¡¥ÍÑ½Éå5¥É…Ñ¥½¹•¹•É…Ñ¥½¸€¬ô€Ä(€€€ÍÑ…Ñ”¹Í•ÑÑ¥¹Ì€ôì€¸¸¹ÍÑ…Ñ”¹Í•ÑÑ¥¹Ì°Í…Ù•!¥ÍÑ½Éäè™…±Í”ô(€€€ÍÑ…Ñ”¹¡¥ÍÑ½Éä€ômt(€€€É•¹‘•È ¤(€ô(€½¹ÍĞÉ•ÍÁ½¹Í”€ô…İ…¥Ğ‘•Í­Ñ½ÁÁ¤¹ÕÁ‘…Ñ•M•ÑÑ¥¹Ì¡ìm­•åtèÙ…±Õ”ô…ÌA…ÉÑ¥…°ñM•ÑÑ¥¹Ìø¤(€½¹ÍĞÁ•ÉÍ¥ÍÑ•¹•…¥±ÕÉ•±É•…‘åY¥Í¥‰±”€ô€…ÍÑ…Ñ”¹Í•ÑÑ¥¹ÍA•ÉÍ¥ÍÑ•¹”¹Á•ÉÍ¥ÍÑ•(€ÍÑ…Ñ”¹Í•ÑÑ¥¹Ì€ôÉ•ÍÁ½¹Í”¹Í•ÑÑ¥¹Ì(€ÍÑ…Ñ”¹Í•ÑÑ¥¹ÍA•ÉÍ¥ÍÑ•¹”€ôÉ•ÍÁ½¹Í”¹Í•ÑÑ¥¹ÍA•ÉÍ¥ÍÑ•¹”(€¥˜€¡É•ÍÁ½¹Í”¹¡¥ÍÑ½ÉåM¹…ÁÍ¡½Ğ¤ì(€€€…ÁÁ±å!¥ÍÑ½ÉåM¹…ÁÍ¡½Ğ¡É•ÍÁ½¹Í”¹¡¥ÍÑ½ÉåM¹…ÁÍ¡½Ğ°É•ÍÁ½¹Í”¹Í•ÑÑ¥¹Ì¹Í…Ù•!¥ÍÑ½Éä¤(€ô•±Í”ì(€€€ÍÑ…Ñ”¹¡¥ÍÑ½Éå±•…ÉA•¹‘¥¹œ€ôÉ•ÍÁ½¹Í”¹¡¥ÍÑ½Éå±•…ÉA•¹‘¥¹œ(€ô(€ÍÑ…Ñ”¹Á•É™½Éµ…¹”€ôÉ•ÍÁ½¹Í”¹Á•É™½Éµ…¹”(€ÍÑ…Ñ”¹•¹¥¹”€ôÉ•ÍÁ½¹Í”¹•¹¥¹”(€¥˜€¡­•ä€ôôô€Í…Ù•!¥ÍÑ½Éäœ€˜˜€…ÍÑ…Ñ”¹Í•ÑÑ¥¹Ì¹Í…Ù•!¥ÍÑ½Éä¤ì(€€€ÍÑ…Ñ”¹¡¥ÍÑ½Éä€ômt(€€€¥˜€ …±•…É1•…å!¥ÍÑ½Éä ¤ñğÉ•ÍÁ½¹Í”¹¡¥ÍÑ½Éå±•…É=¬€ôôô™…±Í”¤ì(€€€€€ÍÑ…Ñ”¹¡¥ÍÑ½Éå]…É¹¥¹œ€ô€Ÿš¶ß–>Ë–ŞË–sš¶‹’şw–¶c¾ò3’ö’î7šr'šr³š¦šªSš†#¶'–ú]¥¹‘½İÌƒ¢¦f“–6ƒR£–ú3šâ¦f“œ(€€€€€Í¡½İQ½…ÍĞ¡ÍÑ…Ñ”¹¡¥ÍÑ½Éå]…É¹¥¹œ¤(€€€ô•±Í”ì(€€€€€ÍÑ…Ñ”¹¡¥ÍÑ½Éå]…É¹¥¹œ€ô€œœ(€€€ô(€ô•±Í”¥˜€¡­•ä€ôôô€Í…Ù•!¥ÍÑ½Éäœ€˜˜ÍÑ…Ñ”¹Í•ÑÑ¥¹Ì¹Í…Ù•!¥ÍÑ½Éä¤ì(€€€…İ…¥ĞÍå¹¡É½¹¥é•M…Ù•‘!¥ÍÑ½Éä ¤(€ô(€¥˜€¡­•ä€ôôô€…ÕÑ½MÁ•…¬œ€˜˜€…ÍÑ…Ñ”¹Í•ÑÑ¥¹Ì¹…ÕÑ½MÁ•…¬¤…¹•±MÁ••  ¤(€¥˜€ …É•ÍÁ½¹Í”¹Í•ÑÑ¥¹ÍA•ÉÍ¥ÍÑ•¹”¹Á•ÉÍ¥ÍÑ•€˜˜€…Á•ÉÍ¥ÍÑ•¹•…¥±ÕÉ•±É•…‘åY¥Í¥‰±”¤ì(€€€Í¡½İQ½…ÍĞ¡Á•ÉÍ¥ÍÑ•¹•]…É¹¥¹5•ÍÍ…” ¤¤(€ô(€É•¹‘•È ¤)ô()…Íå¹Œ™Õ¹Ñ¥½¸ÁÕ±±M•±•Ñ•‘5½‘•° ¤èAÉ½µ¥Í”ñÙ½¥øì(€ÍÑ…Ñ”¹ÁÕ±±¥¹œ€ôÑÉÕ”(€ÍÑ…Ñ”¹ÁÉ½É•ÍÌ€ôìÍÑ…ÑÕÌè€Ÿšê[–
g’â/¢ò$œ°Á•É•¹Ğè€À°½µÁ±•Ñ•è€À°Ñ½Ñ…°è€Àô(€É•¹‘•È ¤(€½¹ÍĞÉ•ÍÕ±Ğ€ô…İ…¥Ğ‘•Í­Ñ½ÁÁ¤¹ÁÕ±±5½‘•°¡ÍÑ…Ñ”¹Í•ÑÑ¥¹Ì¹µ½‘•°¤(€ÍÑ…Ñ”¹ÁÕ±±¥¹œ€ô™…±Í”(€¥˜€ …É•ÍÕ±Ğ¹½¬¤ì(€€€ÍÑ…Ñ”¹•ÉÉ½È€ôƒš¢‡–z/’â/¢ò'–’ÇšV_¾òh‘íÉ•ÍÕ±Ğ¹•ÉÉ½Èñğ€Ÿ¢®/šª‹š~—ÚË¢Ş¿–ú3–7¢¦›õ€(€€€É•¹‘•È ¤(€€€É•ÑÕÉ¸(€ô(€ÍÑ…Ñ”¹•¹¥¹”€ô…İ…¥Ğ‘•Í­Ñ½ÁÁ¤¹•Ñ¹¥¹•MÑ…ÑÕÌ ¤(€ÍÑ…Ñ”¹ÁÉ½É•ÍÌ€ô¹Õ±°(€Í¡½İQ½…ÍĞ Ÿ–7¢Êï¢ª{¢¢š¢‡–z/–ŞË–º'¢w–º3š"@œ¤)ô()™Õ¹Ñ¥½¸±½…‘1•…å!¥ÍÑ½Éä ¤è!¥ÍÑ½Éå¹ÑÉåmtì(€É•ÑÕÉ¸É•…‘!¥ÍÑ½Éä¡±½…±MÑ½É…”¤)ô()™Õ¹Ñ¥½¸±•…É1•…å!¥ÍÑ½Éä ¤è‰½½±•…¸ì(€ÑÉäì(€€€±½…±MÑ½É…”¹É•µ½Ù•%Ñ•´¡!%MQ=Ie}-d¤(€€€É•ÑÕÉ¸ÑÉÕ”(€ô…Ñ ì(€€€É•ÑÕÉ¸™…±Í”(€ô)ô()…Íå¹Œ™Õ¹Ñ¥½¸¡…¹‘±•Ñ¥½¸¡…Ñ¥½¸èÍÑÉ¥¹œ°Ñ…É•Ğè!Q51±•µ•¹Ğ¤èAÉ½µ¥Í”ñÙ½¥øì(€Íİ¥Ñ €¡…Ñ¥½¸¤ì(€€€…Í”€ÑÉ…¹Í±…Ñ”œè(€€€€€…İ…¥ĞÉÕ¹QÉ…¹Í±…Ñ¥½¸ µ…¹Õ…°œ¤(€€€€€‰É•…¬(€€€…Í”€…¹•°œè(€€€€€…Ñ¥Ù•5…¥¹I•ÅÕ•ÍÑ%€ô€œœ(€€€€€µ…¥¹I•ÅÕ•ÍÑM•ÅÕ•¹”€¬ô€Ä(€€€€€…İ…¥Ğ‘•Í­Ñ½ÁÁ¤¹…¹•±QÉ…¹Í±…Ñ¥½¸ ¤(€€€€€ÍÑ…Ñ”¹±½…‘¥¹œ€ô™…±Í”(€€€€€ÍÑ…Ñ”¹Á…ÉÑ¥…°€ô¹Õ±°(€€€€€ÍÑ…Ñ”¹•ÉÉ½È€ô€Ÿ–ŞË–sš¶‹¦gš²‡şï¢¶¿œ(€€€€€É•¹‘•È ¤(€€€€€‰É•…¬(€€€…Í”€¹•Üœè(€€€€€ÍÑ…Ñ”¹¥¹ÁÕĞ€ô€œœ(€€€€€ÍÑ…Ñ”¹É•ÍÕ±Ğ€ô¹Õ±°(€€€€€ÍÑ…Ñ”¹•ÉÉ½È€ô€œœ(€€€€€ÍÑ…Ñ”¹¥Í•µ¼€ô™…±Í”(€€€€€É•¹‘•È ¤(€€€€€‘½Õµ•¹Ğ¹ÅÕ•ÉåM•±•Ñ½Èñ!Q51Q•áÑÉ•…±•µ•¹Ğø œÍ½ÕÉ”µ¥¹ÁÕĞœ¤ü¹™½ÕÌ ¤(€€€€€‰É•…¬(€€€…Í”€±•…Èµ¥¹ÁÕĞœè(€€€€€ÍÑ…Ñ”¹¥¹ÁÕĞ€ô€œœ(€€€€€É•¹‘•È ¤(€€€€€‘½Õµ•¹Ğ¹ÅÕ•ÉåM•±•Ñ½Èñ!Q51Q•áÑÉ•…±•µ•¹Ğø œÍ½ÕÉ”µ¥¹ÁÕĞœ¤ü¹™½ÕÌ ¤(€€€€€‰É•…¬(€€€…Í”€Á…ÍÑ”œè(€€€€€ÑÉäì(€€€€€€€ÍÑ…Ñ”¹¥¹ÁÕĞ€ô…İ…¥Ğ¹…Ù¥…Ñ½È¹±¥Á‰½…É¹É•…‘Q•áĞ ¤(€€€€€€€É•¹‘•È ¤(€€€€€ô…Ñ ì(€€€€€€€Í¡½İQ½…ÍĞ Ÿ¢®/’öÿR ÑÉ°­Xƒ¢Êó’â+–Ÿ–ºäœ¤(€€€€€ô(€€€€€‰É•…¬(€€€…Í”€ÍÁ•…¬µÍ½ÕÉ”œè(€€€€€Ù½¥ÍÁ•…¬¡ÍÑ…Ñ”¹¥¹ÁÕĞ°€½mqÔÌĞÀÀµqÔå™™™t¼¹Ñ•ÍĞ¡ÍÑ…Ñ”¹¥¹ÁÕĞ¤€ü€é µQ\œ€è€•¸µULœ¤(€€€€€‰É•…¬(€€€…Í”€ÍÁ•…¬µ•¹±¥Í œè(€€€€€¥˜€¡ÍÑ…Ñ”¹É•ÍÕ±Ğ¤ÍÁ•…­¹±¥Í¡M¥‘”¡ÍÑ…Ñ”¹É•ÍÕ±Ğ°ÍÑ…Ñ”¹¥¹ÁÕĞ¤(€€€€€‰É•…¬(€€€…Í”€ÍÁ•…¬µ•á…µÁ±”œèì(€€€€€½¹ÍĞ•á…µÁ±”€ôÍÑ…Ñ”¹É•ÍÕ±Ğü¹•á…µÁ±•Ím9Õµ‰•È¡Ñ…É•Ğ¹‘…Ñ…Í•Ğ¹¥¹‘•à¥t(€€€€€¥˜€¡•á…µÁ±”€˜˜ÍÑ…Ñ”¹É•ÍÕ±Ğ¤ì(€€€€€€€Ù½¥ÍÁ•…¬¡•á…µÁ±”¹Í½ÕÉ”°ÍÑ…Ñ”¹É•ÍÕ±Ğ¹‘•Ñ•Ñ•‘1…¹Õ…”€ôôô€é œ€ü€é µQ\œ€è€•¸µULœ¤(€€€€€ô(€€€€€‰É•…¬(€€€ô(€€€…Í”€½ÁäµÉ•ÍÕ±Ğœè(€€€€€¥˜€¡ÍÑ…Ñ”¹É•ÍÕ±Ğ¤…İ…¥Ğ½ÁåQ•áĞ¡ÍÑ…Ñ”¹É•ÍÕ±Ğ¹ÑÉ…¹Í±…Ñ¥½¸¤(€€€€€‰É•…¬(€€€…Í”€½ÁäµÁ…ÉÑ¥…°œè(€€€€€¥˜€¡ÍÑ…Ñ”¹Á…ÉÑ¥…°¤…İ…¥Ğ½ÁåQ•áĞ¡ÍÑ…Ñ”¹Á…ÉÑ¥…°¹ÑÉ…¹Í±…Ñ¥½¸¤(€€€€€‰É•…¬(€€€…Í”€ÍÁ•…¬µÁ…ÉÑ¥…°œè(€€€€€¥˜€¡ÍÑ…Ñ”¹Á…ÉÑ¥…°¤ì(€€€€€€€Ù½¥ÍÁ•…¬ (€€€€€€€€€ÍÑ…Ñ”¹Á…ÉÑ¥…°¹‘•Ñ•Ñ•‘1…¹Õ…”€ôôô€•¸œ€üÍÑ…Ñ”¹Á…ÉÑ¥…°¹Í½ÕÉ”€èÍÑ…Ñ”¹Á…ÉÑ¥…°¹ÑÉ…¹Í±…Ñ¥½¸°(€€€€€€€€€€•¸µULœ°(€€€€€€€€¤(€€€€€ô(€€€€€‰É•…¬(€€€…Í”€½Áäµ…±Ñ•É¹…Ñ¥Ù”œèì(€€€€€½¹ÍĞ…±Ñ•É¹…Ñ¥Ù”€ôÍÑ…Ñ”¹É•ÍÕ±Ğü¹…±Ñ•É¹…Ñ¥Ù•Ím9Õµ‰•È¡Ñ…É•Ğ¹‘…Ñ…Í•Ğ¹¥¹‘•à¥t(€€€€€¥˜€¡…±Ñ•É¹…Ñ¥Ù”¤…İ…¥Ğ½ÁåQ•áĞ¡…±Ñ•É¹…Ñ¥Ù”¹Ñ•áĞ¤(€€€€€‰É•…¬(€€€ô(€€€…Í”€¡¥ÍÑ½Éäœèì(€€€€€½¹ÍĞ¥Ñ•´€ôÍÑ…Ñ”¹¡¥ÍÑ½Éä¹™¥¹ ¡•¹ÑÉä¤€ôø•¹ÑÉä¹¥€ôôôÑ…É•Ğ¹‘…Ñ…Í•Ğ¹¥¤(€€€€€¥˜€¡¥Ñ•´¤ì(€€€€€€€ÍÑ…Ñ”¹¥¹ÁÕĞ€ô¥Ñ•´¹Í½ÕÉ”(€€€€€€€ÍÑ…Ñ”¹É•ÍÕ±Ğ€ô¥Ñ•´¹É•ÍÕ±Ğ(€€€€€€€ÍÑ…Ñ”¹¥Í•µ¼€ô™…±Í”(€€€€€€€ÍÑ…Ñ”¹•ÉÉ½È€ô€œœ(€€€€€€€É•¹‘•È ¤(€€€€€ô(€€€€€‰É•…¬(€€€ô(€€€…Í”€±•…Èµ¡¥ÍÑ½Éäœèì(€€€€€¡¥ÍÑ½Éå5¥É…Ñ¥½¹•¹•É…Ñ¥½¸€¬ô€Ä(€€€€€½¹ÍĞ±•…É•€ô…İ…¥Ğ‘•Í­Ñ½ÁÁ¤¹±•…É!¥ÍÑ½Éä ¤(€€€€€…ÁÁ±å!¥ÍÑ½ÉåM¹…ÁÍ¡½Ğ¡±•…É•°ÍÑ…Ñ”¹Í•ÑÑ¥¹Ì¹Í…Ù•!¥ÍÑ½Éä¤(€€€€€¥˜€ …±•…É•¹½¬¤ì(€€€€€€€ÍÑ…Ñ”¹¡¥ÍÑ½Éå]…É¹¥¹œ€ô€]¥¹‘½İÌƒšj¯šf‡šÎW–º3š"CŠšâ¦f“¾òo¢®/¦^s¦Z'–>¿¢÷–6ƒR£šªSš†#j¢/–ò?–ú3–7¢¦›œ(€€€€€€€Í¡½İQ½…ÍĞ¡ÍÑ…Ñ”¹¡¥ÍÑ½Éå]…É¹¥¹œ¤(€€€€€ô•±Í”ì(€€€€€€€ÍÑ…Ñ”¹¡¥ÍÑ½Éå]…É¹¥¹œ€ô€œœ(€€€€€€€É•¹‘•È ¤(€€€€€ô(€€€€€‰É•…¬(€€€ô(€€€…Í”€½Áäµ‘¥…¹½ÍÑ¥Ìœè(€€€€€…İ…¥Ğ½ÁåQ•áĞ¡)M=8¹ÍÑÉ¥¹¥™ä¡ì(€€€€€€€…ÁÀè€1¥¹½5ÕÍ”œ°(€€€€€€€Ù•ÉÍ¥½¸èÍÑ…Ñ”¹Ù•ÉÍ¥½¸°(€€€€€€€•‘¥Ñ¥½¸èÍÑ…Ñ”¹•‘¥Ñ¥½¸°(€€€€€€€Á±…Ñ™½É´èÍÑ…Ñ”¹Á±…Ñ™½É´°(€€€€€€€•¹¥¹”èì(€€€€€€€€€½¹±¥¹”èÍÑ…Ñ”¹•¹¥¹”¹½¹±¥¹”°(€€€€€€€€€µ½‘•±I•…‘äèÍÑ…Ñ”¹•¹¥¹”¹µ½‘•±I•…‘ä°(€€€€€€€€€µ½‘•°èÍÑ…Ñ”¹•¹¥¹”¹µ½‘•°°(€€€€€€€€€ÍÑ…ÉÑÉÉ½ÈèÍÑ…Ñ”¹½™™±¥¹•¹¥¹•MÑ…ÉĞü¹•ÉÉ½Èñğ€œœ°(€€€€€€€€€İ…ÉµÕÁÉÉ½ÈèÍÑ…Ñ”¹½™™±¥¹•]…ÉµÕÀü¹•ÉÉ½Èñğ€œœ°(€€€€€€€ô°(€€€€€€€Á•É™½Éµ…¹”èÍÑ…Ñ”¹Á•É™½Éµ…¹”°(€€€€€€€¡½½¬èì(€€€€€€€€€…Ñ¥Ù”èÍÑ…Ñ”¹¡½½¬¹…Ñ¥Ù”°(€€€€€€€€€…Ù…¥±…‰±”èÍÑ…Ñ”¹¡½½¬¹…Ù…¥±…‰±”°(€€€€€€€€€•ÉÉ½ÈèÍÑ…Ñ”¹¡½½¬¹•ÉÉ½Èñğ€œœ°(€€€€€€€ô°(€€€€€ô°¹Õ±°°€È¤¤(€€€€€‰É•…¬(€€€…Í”€½Á•¸µÍ•ÑÑ¥¹Ìœè(€€€€€ÍÑ…Ñ”¹Í•ÑÑ¥¹Í=Á•¸€ôÑÉÕ”(€€€€€É•¹‘•È ¤(€€€€€™½ÕÍÑ¥Ù•¥…±½œ ¤(€€€€€‰É•…¬(€€€…Í”€±½Í”µÍ•ÑÑ¥¹Ìœè(€€€€€ÍÑ…Ñ”¹Í•ÑÑ¥¹Í=Á•¸€ô™…±Í”(€€€€€É•¹‘•È ¤(€€€€€‰É•…¬(€€€…Í”€Í•±•Ğµµ½‘•°œè(€€€€€…İ…¥ĞÕÁ‘…Ñ•M•ÑÑ¥¹œ µ½‘•°œ°Ñ…É•Ğ¹‘…Ñ…Í•Ğ¹µ½‘•°ñğ‘•™…Õ±ÑM•ÑÑ¥¹Ì¹µ½‘•°¤(€€€€€‰É•…¬(€€€…Í”€Í•±•ĞµÁ•É™½Éµ…¹”œè(€€€€€…İ…¥ĞÕÁ‘…Ñ•M•ÑÑ¥¹œ Á•É™½Éµ…¹•5½‘”œ°€¡Ñ…É•Ğ¹‘…Ñ…Í•Ğ¹µ½‘”ñğ€…ÕÑ¼œ¤…ÌM•ÑÑ¥¹ÍlÁ•É™½Éµ…¹•5½‘”t¤(€€€€€‰É•…¬(€€€…Í”€É•™É•Í µ•¹¥¹”œè(€€€€€…İ…¥ĞÉ•™É•Í¡¹¥¹”¡ÑÉÕ”¤(€€€€€‰É•…¬(€€€…Í”€É•ÍÑ…ÉĞµ•¹¥¹”œèì(€€€€€ÍÑ…Ñ”¹É•ÍÑ…ÉÑ¥¹¹¥¹”€ôÑÉÕ”(€€€€€ÍÑ…Ñ”¹•ÉÉ½È€ô€œœ(€€€€€É•¹‘•È ¤(€€€€€½¹ÍĞÉ•ÍÁ½¹Í”€ô…İ…¥Ğ‘•Í­Ñ½ÁÁ¤¹É•ÍÑ…ÉÑ=™™±¥¹•¹¥¹” ¤(€€€€€ÍÑ…Ñ”¹É•ÍÑ…ÉÑ¥¹¹¥¹”€ô™…±Í”(€€€€€ÍÑ…Ñ”¹•¹¥¹”€ôÉ•ÍÁ½¹Í”¹•¹¥¹”(€€€€€¥˜€¡É•ÍÁ½¹Í”¹½™™±¥¹•¹¥¹•MÑ…ÉĞ¤ÍÑ…Ñ”¹½™™±¥¹•¹¥¹•MÑ…ÉĞ€ôÉ•ÍÁ½¹Í”¹½™™±¥¹•¹¥¹•MÑ…ÉĞ(€€€€€¥˜€¡É•ÍÁ½¹Í”¹½™™±¥¹•]…ÉµÕÀ¤ÍÑ…Ñ”¹½™™±¥¹•]…ÉµÕÀ€ôÉ•ÍÁ½¹Í”¹½™™±¥¹•]…ÉµÕÀ(€€€€€¥˜€¡É•ÍÁ½¹Í”¹½¬¤Í¡½İQ½…ÍĞ Ÿ¦n‹Şk–òWšN;–ŞËš‹–ú§¾ò3–>¿’î—æóê3şï¢¶¼œ¤(€€€€€•±Í”ì(€€€€€€€ÍÑ…Ñ”¹•ÉÉ½È€ô¡Õµ…¹¥é•=™™±¥¹•¹¥¹•ÉÉ½È¡É•ÍÁ½¹Í”¹•ÉÉ½Èñğ€œœ¤(€€€€€€€É•¹‘•È ¤(€€€€€ô(€€€€€‰É•…¬(€€€ô(€€€…Í”€‘½İ¹±½…µ½±±…µ„œè(€€€€€…İ…¥Ğ‘•Í­Ñ½ÁÁ¤¹½Á•¹=±±…µ…½İ¹±½… ¤(€€€€€Í¡½İQ½…ÍĞ Ÿ–ŞË¦Z/–V|=±±…µ„ƒ–ºcšZç’â/¢ò'¦‚œ¤(€€€€€‰É•…¬(€€€…Í”€ÁÕ±°µµ½‘•°œè(€€€€€…İ…¥ĞÁÕ±±M•±•Ñ•‘5½‘•° ¤(€€€€€‰É•…¬(€€€…Í”€½Á•¸µÕ¥‘”œè(€€€€€ÍÑ…Ñ”¹Õ¥‘•=Á•¸€ôÑÉÕ”(€€€€€É•¹‘•È ¤(€€€€€™½ÕÍÑ¥Ù•¥…±½œ ¤(€€€€€‰É•…¬(€€€…Í”€±½Í”µÕ¥‘”œè(€€€€€½µÁ±•Ñ•=¹‰½…É‘¥¹œ ¤(€€€€€ÍÑ…Ñ”¹Õ¥‘•=Á•¸€ô™…±Í”(€€€€€É•¹‘•È ¤(€€€€€‰É•…¬(€€€…Í”€™¥¹¥Í µÕ¥‘”œè(€€€€€½µÁ±•Ñ•=¹‰½…É‘¥¹œ ¤(€€€€€ÍÑ…Ñ”¹Õ¥‘•=Á•¸€ô™…±Í”(€€€€€É•¹‘•È ¤(€€€€€‘½Õµ•¹Ğ¹ÅÕ•ÉåM•±•Ñ½Èñ!Q51Q•áÑÉ•…±•µ•¹Ğø œÍ½ÕÉ”µ¥¹ÁÕĞœ¤ü¹™½ÕÌ ¤(€€€€€‰É•…¬(€€€…Í”€Õ¥‘”µÑ¼µÍ•ÑÑ¥¹Ìœè(€€€€€½µÁ±•Ñ•=¹‰½…É‘¥¹œ ¤(€€€€€ÍÑ…Ñ”¹Õ¥‘•=Á•¸€ô™…±Í”(€€€€€ÍÑ…Ñ”¹Í•ÑÑ¥¹Í=Á•¸€ôÑÉÕ”(€€€€€É•¹‘•È ¤(€€€€€™½ÕÍÑ¥Ù•¥…±½œ ¤(€€€€€‰É•…¬(€€€…Í”€µ¥¹¥µ¥é”œè(€€€€€…İ…¥Ğ‘•Í­Ñ½ÁÁ¤¹µ¥¹¥µ¥é” ¤(€€€€€‰É•…¬(€€€…Í”€±½Í”µİ¥¹‘½Üœè(€€€€€…İ…¥Ğ‘•Í­Ñ½ÁÁ¤¹±½Í” ¤(€€€€€‰É•…¬(€ô)ô()É½½Ğ¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ±¥¬œ°€¡•Ù•¹Ğ¤€ôøì(€½¹ÍĞÑ…É•Ğ€ô€¡•Ù•¹Ğ¹Ñ…É•Ğ…Ì!Q51±•µ•¹Ğ¤¹±½Í•ÍĞñ!Q51±•µ•¹Ğø m‘…Ñ„µ…Ñ¥½¹tœ¤(€¥˜€ …Ñ…É•Ğ¤É•ÑÕÉ¸(€Ù½¥¡…¹‘±•Ñ¥½¸¡Ñ…É•Ğ¹‘…Ñ…Í•Ğ¹…Ñ¥½¸ñğ€œœ°Ñ…É•Ğ¤)ô¤()É½½Ğ¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ¥¹ÁÕĞœ°€¡•Ù•¹Ğ¤€ôøì(€½¹ÍĞÑ…É•Ğ€ô•Ù•¹Ğ¹Ñ…É•Ğ…Ì!Q51%¹ÁÕÑ±•µ•¹Ğğ!Q51Q•áÑÉ•…±•µ•¹Ğ(€¥˜€¡Ñ…É•Ğ¹¥€ôôô€Í½ÕÉ”µ¥¹ÁÕĞœ¤ì(€€€ÍÑ…Ñ”¹¥¹ÁÕĞ€ôÑ…É•Ğ¹Ù…±Õ”(€€€½¹ÍĞ½Õ¹Ñ•È€ô‘½Õµ•¹Ğ¹ÅÕ•ÉåM•±•Ñ½È œ¡…Èµ½Õ¹Ğœ¤(€€€¥˜€¡½Õ¹Ñ•È¤½Õ¹Ñ•È¹Ñ•áÑ½¹Ñ•¹Ğ€ô€‘íÑ…É•Ğ¹Ù…±Õ”¹±•¹Ñ ¹Ñ½1½…±•MÑÉ¥¹œ ¥ô€¼€ÄÈ°ÀÀÀƒ
Üƒ’â·š^—¦~OÒ€Ì°ÀÀÁ€(€ô)ô¤()É½½Ğ¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ¡…¹”œ°€¡•Ù•¹Ğ¤€ôøì(€½¹ÍĞÑ…É•Ğ€ô•Ù•¹Ğ¹Ñ…É•Ğ…Ì!Q51%¹ÁÕÑ±•µ•¹Ğ(€½¹ÍĞ­•ä€ôÑ…É•Ğ¹‘…Ñ…Í•Ğ¹Í•ÑÑ¥¹œ…Ì­•å½˜M•ÑÑ¥¹ÌğÕ¹‘•™¥¹•(€¥˜€ …­•ä¤É•ÑÕÉ¸(€±•ĞÙ…±Õ”èÍÑÉ¥¹œğ¹Õµ‰•Èğ‰½½±•…¸€ôÑ…É•Ğ¹Ù…±Õ”(€¥˜€¡Ñ…É•Ğ¹ÑåÁ”€ôôô€¡•­‰½àœ¤Ù…±Õ”€ôÑ…É•Ğ¹¡•­•(€¥˜€¡Ñ…É•Ğ¹ÑåÁ”€ôôô€É…¹”œ¤Ù…±Õ”€ô9Õµ‰•È¡Ñ…É•Ğ¹Ù…±Õ”¤(€Ù½¥ÕÁ‘…Ñ•M•ÑÑ¥¹œ¡­•ä°Ù…±Õ”¤)ô¤()İ¥¹‘½Ü¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ­•å‘½İ¸œ°€¡•Ù•¹Ğ¤€ôøì(€¥˜€¡•Ù•¹Ğ¹­•ä€ôôô€Q…ˆœ€˜˜€¡ÍÑ…Ñ”¹Õ¥‘•=Á•¸ñğÍÑ…Ñ”¹Í•ÑÑ¥¹Í=Á•¸¤¤ì(€€€½¹ÍĞ‘¥…±½œ€ô‘½Õµ•¹Ğ¹ÅÕ•ÉåM•±•Ñ½Èñ!Q51±•µ•¹Ğø¡ÍÑ…Ñ”¹Õ¥‘•=Á•¸€ü€œ¹Õ¥‘”µµ½‘…°œ€è€œ¹Í•ÑÑ¥¹Ìµ‘É…İ•Èœ¤(€€€½¹ÍĞ™½ÕÍ…‰±”€ô‘¥…±½œ(€€€€€€üÉÉ…ä¹™É½´¡‘¥…±½œ¹ÅÕ•ÉåM•±•Ñ½É±°ñ!Q51±•µ•¹Ğø ‰ÕÑÑ½¸é¹½Ğ¡m‘¥Í…‰±•‘t¤°¥¹ÁÕĞé¹½Ğ¡m‘¥Í…‰±•‘t¤°ÍÕµµ…Éä°mÑ…‰¥¹‘•áté¹½Ğ¡mÑ…‰¥¹‘•àôˆ´Ä‰t¤œ¤¤(€€€€€€èmt(€€€¥˜€¡™½ÕÍ…‰±”¹±•¹Ñ ¤ì(€€€€€½¹ÍĞ™¥ÉÍĞ€ô™½ÕÍ…‰±•lÁt(€€€€€½¹ÍĞ±…ÍĞ€ô™½ÕÍ…‰±•m™½ÕÍ…‰±”¹±•¹Ñ €´€Åt(€€€€€¥˜€ …‘¥…±½œü¹½¹Ñ…¥¹Ì¡‘½Õµ•¹Ğ¹…Ñ¥Ù•±•µ•¹Ğ¤¤ì(€€€€€€€•Ù•¹Ğ¹ÁÉ•Ù•¹Ñ•™…Õ±Ğ ¤(€€€€€€€€ì¡•Ù•¹Ğ¹Í¡¥™Ñ-•ä€ü±…ÍĞ€è™¥ÉÍĞ¤¹™½ÕÌ ¤(€€€€€ô•±Í”¥˜€¡•Ù•¹Ğ¹Í¡¥™Ñ-•ä€˜˜‘½Õµ•¹Ğ¹…Ñ¥Ù•±•µ•¹Ğ€ôôô™¥ÉÍĞ¤ì(€€€€€€€•Ù•¹Ğ¹ÁÉ•Ù•¹Ñ•™…Õ±Ğ ¤(€€€€€€€±…ÍĞ¹™½ÕÌ ¤(€€€€€ô•±Í”¥˜€ …•Ù•¹Ğ¹Í¡¥™Ñ-•ä€˜˜‘½Õµ•¹Ğ¹…Ñ¥Ù•±•µ•¹Ğ€ôôô±…ÍĞ¤ì(€€€€€€€•Ù•¹Ğ¹ÁÉ•Ù•¹Ñ•™…Õ±Ğ ¤(€€€€€€€™¥ÉÍĞ¹™½ÕÌ ¤(€€€€€ô(€€€ô(€ô(€¥˜€ ¡•Ù•¹Ğ¹ÑÉ±-•äñğ•Ù•¹Ğ¹µ•Ñ…-•ä¤€˜˜•Ù•¹Ğ¹­•ä€ôôô€¹Ñ•Èœ€˜˜€…ÍÑ…Ñ”¹Õ¥‘•=Á•¸€˜˜€…ÍÑ…Ñ”¹Í•ÑÑ¥¹Í=Á•¸¤ì(€€€•Ù•¹Ğ¹ÁÉ•Ù•¹Ñ•™…Õ±Ğ ¤(€€€Ù½¥ÉÕ¹QÉ…¹Í±…Ñ¥½¸ µ…¹Õ…°œ¤(€ô(€¥˜€¡•Ù•¹Ğ¹­•ä€ôôô€Í…Á”œ¤ì(€€€¥˜€¡ÍÑ…Ñ”¹Õ¥‘•=Á•¸¤ì(€€€€€½µÁ±•Ñ•=¹‰½…É‘¥¹œ ¤(€€€€€ÍÑ…Ñ”¹Õ¥‘•=Á•¸€ô™…±Í”(€€€ô(€€€•±Í”¥˜€¡ÍÑ…Ñ”¹Í•ÑÑ¥¹Í=Á•¸¤ÍÑ…Ñ”¹Í•ÑÑ¥¹Í=Á•¸€ô™…±Í”(€€€•±Í”É•ÑÕÉ¸(€€€É•¹‘•È ¤(€ô)ô¤()‘•Í­Ñ½ÁÁ¤¹½¹±¥Á‰½…É‘QÉ¥•È ¡ìÑ•áĞô¤€ôøì(€ÍÑ…Ñ”¹¥¹ÁÕĞ€ôÑ•áĞ(€ÍÑ…Ñ”¹•ÉÉ½È€ô€œœ(€Í¡½İQ½…ÍĞ Ÿ–ŞËšNß–>[–&«¢ÊóÂÿ¾ò3š¶–r£¢«Ûşï¢¶¼œ¤(€Ù½¥ÉÕ¹QÉ…¹Í±…Ñ¥½¸ ±¥Á‰½…Éœ¤)ô¤()‘•Í­Ñ½ÁÁ¤¹½¹A½ÁÕÁI•ÍÕ±Ğ ¡ìÍ½ÕÉ”°É•ÍÕ±Ğô¤€ôøì(€ÍÑ…Ñ”¹¥¹ÁÕĞ€ôÍ½ÕÉ”(€ÍÑ…Ñ”¹É•ÍÕ±Ğ€ôÉ•ÍÕ±Ğ(€ÍÑ…Ñ”¹•ÉÉ½È€ô€œœ(€ÍÑ…Ñ”¹¥Í•µ¼€ô™…±Í”(€É•¹‘•È ¤)ô¤()‘•Í­Ñ½ÁÁ¤¹½¹!½½­MÑ…ÑÕÌ ¡¡½½¬è!½½­MÑ…ÑÕÌ¤€ôøì(€ÍÑ…Ñ”¹¡½½¬€ô¡½½¬(€É•¹‘•È ¤)ô¤()‘•Í­Ñ½ÁÁ¤¹½¹M•ÑÑ¥¹Í¡…¹• ¡¹•áÑM•ÑÑ¥¹Ì¤€ôøì(€ÍÑ…Ñ”¹Í•ÑÑ¥¹Ì€ô¹•áÑM•ÑÑ¥¹Ì(€¥˜€ …¹•áÑM•ÑÑ¥¹Ì¹Í…Ù•!¥ÍÑ½Éä¤ì(€€€¡¥ÍÑ½Éå5¥É…Ñ¥½¹•¹•É…Ñ¥½¸€¬ô€Ä(€€€ÍÑ…Ñ”¹¡¥ÍÑ½Éä€ômt(€€€¥˜€ …±•…É1•…å!¥ÍÑ½Éä ¤¤ì(€€€€€ÍÑ…Ñ”¹¡¥ÍÑ½Éå]…É¹¥¹œ€ô€Ÿš¶ß–>Ë–ŞË–sš¶‹’şw–¶c¾ò3’ö¢"+–Ë–¶c–6’î7¶'–ú]¥¹‘½İÌƒ¢¦f“–6ƒR£–ú3šâ¦f“œ(€€€ô(€ô(€É•¹‘•È ¤)ô¤()‘•Í­Ñ½ÁÁ¤¹½¹M•ÑÑ¥¹ÍA•ÉÍ¥ÍÑ•¹” ¡ÍÑ…ÑÕÌ¤€ôøì(€½¹ÍĞ‰•…µ•U¹Á•ÉÍ¥ÍÑ•€ôÍÑ…Ñ”¹Í•ÑÑ¥¹ÍA•ÉÍ¥ÍÑ•¹”¹Á•ÉÍ¥ÍÑ•€˜˜€…ÍÑ…ÑÕÌ¹Á•ÉÍ¥ÍÑ•(€ÍÑ…Ñ”¹Í•ÑÑ¥¹ÍA•ÉÍ¥ÍÑ•¹”€ôÍÑ…ÑÕÌ(€É•¹‘•È ¤(€¥˜€¡‰•…µ•U¹Á•ÉÍ¥ÍÑ•¤…¹¹½Õ¹”¡Á•ÉÍ¥ÍÑ•¹•]…É¹¥¹5•ÍÍ…” ¤¤)ô¤()‘•Í­Ñ½ÁÁ¤¹½¹!¥ÍÑ½Éå¡…¹• ¡¡¥ÍÑ½Éä¤€ôøì(€…ÁÁ±å!¥ÍÑ½ÉåM¹…ÁÍ¡½Ğ¡¡¥ÍÑ½Éä°ÍÑ…Ñ”¹Í•ÑÑ¥¹Ì¹Í…Ù•!¥ÍÑ½Éä¤(€¥˜€ …ÍÑ…Ñ”¹Í•ÑÑ¥¹Ì¹Í…Ù•!¥ÍÑ½Éä¤ÍÑ…Ñ”¹¡¥ÍÑ½Éä€ômt(€É•¹‘•È ¤)ô¤()‘•Í­Ñ½ÁÁ¤¹½¹QÉ…¹Í±…Ñ¥½¹A…ÉÑ¥…° ¡Á…ÉÑ¥…°¤€ôøì(€¥˜€¡Á…ÉÑ¥…°¹É•ÅÕ•ÍÑ%€„ôô…Ñ¥Ù•5…¥¹I•ÅÕ•ÍÑ%¤É•ÑÕÉ¸(€ÍÑ…Ñ”¹Á…ÉÑ¥…°€ôì€¸¸¹Á…ÉÑ¥…°°Í½ÕÉ”è…Ñ¥Ù•5…¥¹M½ÕÉ”ô(€É•¹‘•È ¤(€…¹¹½Õ¹” Ÿ–ş¯¦şï¢¶¿¦‚C¢š÷–ŞË¦†¿’ë¾ò3–º3šVÓÖCšzs’î7–r£š‚ã–Â7œ¤)ô¤()‘•Í­Ñ½ÁÁ¤¹½¹¹¥¹•MÑ…Ñ” ¡Á…å±½…¤€ôøì(€ÍÑ…Ñ”¹•¹¥¹”€ôÁ…å±½…¹•¹¥¹”(€¥˜€¡Á…å±½…¹Á•É™½Éµ…¹”¤ÍÑ…Ñ”¹Á•É™½Éµ…¹”€ôÁ…å±½…¹Á•É™½Éµ…¹”(€¥˜€¡Á…å±½…¹½™™±¥¹•¹¥¹•MÑ…ÉĞ¤ÍÑ…Ñ”¹½™™±¥¹•¹¥¹•MÑ…ÉĞ€ôÁ…å±½…¹½™™±¥¹•¹¥¹•MÑ…ÉĞ(€¥˜€¡Á…å±½…¹½™™±¥¹•]…ÉµÕÀ¤ÍÑ…Ñ”¹½™™±¥¹•]…ÉµÕÀ€ôÁ…å±½…¹½™™±¥¹•]…ÉµÕÀ(€É•¹‘•È ¤)ô¤()‘•Í­Ñ½ÁÁ¤¹½¹5½‘•±AÉ½É•ÍÌ ¡ÁÉ½É•ÍÌè5½‘•±AÉ½É•ÍÌ¤€ôøì(€ÍÑ…Ñ”¹ÁÉ½É•ÍÌ€ôÁÉ½É•ÍÌ(€¥˜€¡ÁÉ½É•ÍÌ¹Á•É•¹Ğ€„ôô±…ÍÑAÉ½É•ÍÍA•É•¹Ğ¤ì(€€€±…ÍÑAÉ½É•ÍÍA•É•¹Ğ€ôÁÉ½É•ÍÌ¹Á•É•¹Ğ(€€€É•¹‘•È ¤(€ô)ô¤()…Íå¹Œ™Õ¹Ñ¥½¸¥¹¥Ñ¥…±¥é” ¤èAÉ½µ¥Í”ñÙ½¥øì(€É•¹‘•È ¤(€ÑÉäì(€€€½¹ÍĞÍ¹…ÁÍ¡½Ğ€ô…İ…¥Ğ‘•Í­Ñ½ÁÁ¤¹•ÑMÑ…Ñ” ¤(€€€=‰©•Ğ¹…ÍÍ¥¸¡ÍÑ…Ñ”°Í¹…ÁÍ¡½Ğ¤(€€€¥˜€¡ÍÑ…Ñ”¹¡¥ÍÑ½Éå±•…ÉA•¹‘¥¹œ¤ì(€€€€€ÍÑ…Ñ”¹¡¥ÍÑ½Éå]…É¹¥¹œ€ô€Ÿš¶ß–>Ë–ŞË–sš¶‹’şw–¶c¾òoŠšâ¦f“’î7–r£¶'–ú]¥¹‘½İÌƒ¢¦f“šªSš†#–6ƒR£œ(€€€ô(€€€¥˜€¡ÍÑ…Ñ”¹Í•ÑÑ¥¹Ì¹Í…Ù•!¥ÍÑ½Éä¤ì(€€€€€…İ…¥ĞÍå¹¡É½¹¥é•M…Ù•‘!¥ÍÑ½Éä ¤(€€€ô•±Í”ì(€€€€€ÍÑ…Ñ”¹¡¥ÍÑ½Éä€ômt(€€€€€…ÁÁ±å!¥ÍÑ½ÉåM¹…ÁÍ¡½Ğ¡…İ…¥Ğ‘•Í­Ñ½ÁÁ¤¹±¥ÍÑ!¥ÍÑ½Éä ¤°™…±Í”¤(€€€€€¥˜€¡ÍÑ…Ñ”¹¡¥ÍÑ½Éå±•…ÉÕÑ¡½É¥é•€˜˜€…±•…É1•…å!¥ÍÑ½Éä ¤¤ì(€€€€€€€ÍÑ…Ñ”¹¡¥ÍÑ½Éå]…É¹¥¹œ€ô€Ÿš¶ß–>Ë–ŞË–sš¶‹’şw–¶c¾ò3’ö¢"+–Ë–¶c–6’î7¶'–ú]¥¹‘½İÌƒ¢¦f“–6ƒR£–ú3šâ¦f“œ(€€€€€ô(€€€ô(€€€¥˜€¡¥Í•Í­Ñ½À€˜˜€…½¹‰½…É‘¥¹½µÁ±•Ñ• ¤¤ÍÑ…Ñ”¹Õ¥‘•=Á•¸€ôÑÉÕ”(€ô…Ñ ì(€€€ÍÑ…Ñ”¹•ÉÉ½È€ô€Ÿ‡šÎW¢º–>[š†3¦v‹¢/–ò?.š/œ(€ô(€É•¹‘•È ¤(€½¹ÍĞÁ•ÉÍ¥ÍÑ•¹•]…É¹¥¹œ€ôÁ•ÉÍ¥ÍÑ•¹•]…É¹¥¹5•ÍÍ…” ¤(€¥˜€¡Á•ÉÍ¥ÍÑ•¹•]…É¹¥¹œ¤…¹¹½Õ¹”¡Á•ÉÍ¥ÍÑ•¹•]…É¹¥¹œ¤(€¥˜€¡ÍÑ…Ñ”¹Õ¥‘•=Á•¸¤™½ÕÍÑ¥Ù•¥…±½œ ¤((€İ¥¹‘½Ü¹Í•Ñ%¹Ñ•ÉÙ…°  ¤€ôøì(€€€¥˜€¡‘½Õµ•¹Ğ¹Ù¥Í¥‰¥±¥ÑåMÑ…Ñ”€„ôô€Ù¥Í¥‰±”œ¤É•ÑÕÉ¸(€€€¥˜€ …ÍÑ…Ñ”¹•¹¥¹”¹½¹±¥¹”ñğÍÑ…Ñ”¹Í•ÑÑ¥¹Í=Á•¸¤Ù½¥É•™É•Í¡¹¥¹” ¤(€ô°€ÄÕ|ÀÀÀ¤)ô()Ù½¥¥¹¥Ñ¥…±¥é” ¤(