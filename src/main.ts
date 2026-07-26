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
    name: '輕快版',
    size: '1.4 GB',
    description: '適合日常短句與辦公內容，一般電腦首選',
    recommended: true,
  },
  {
    id: 'qwen3:4b-instruct',
    name: '細膩版',
    size: '2.5 GB',
    description: '長句與微妙語氣更穩定',
  },
  {
    id: 'qwen3:8b',
    name: '進階版',
    size: '5.2 GB',
    description: '語氣更細緻，建議 16 GB 以上',
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
      ? '歷史檔來自較新的版本；目前保持唯讀，不會覆寫原檔。'
      : 'Windows 暫時無法讀取本機歷史檔；為避免覆寫，歷史已暫停，重新開啟程式後會再嘗試。'
  } else if (
    !snapshot.clearPending
    && (
      state.historyWarning.includes('磁碟清除')
      || state.historyWarning.includes('保持唯讀')
      || state.historyWarning.includes('無法讀取本機歷史檔')
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
        state.historyWarning = '舊版歷史已安全搬移，但舊儲存區暫時無法移除。'
      }
    } else {
      state.history = legacyHistory
      state.historyWarning = '舊版歷史尚未完成搬移，原資料仍保留，下次啟動會重試。'
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
      ? '設定已從備份安全復原；涉及隱私的開關暫時保持關閉。重新開啟後會讀取已復原偏好，也可在此重新選擇。'
      : state.settingsPersistence.writable
        ? 'Windows 暫時無法保存設定；本次隱私開關已立即生效，但重啟前請保持程式開啟。'
      : state.settingsPersistence.reason === 'UNREADABLE'
        ? 'Windows 暫時鎖住設定檔；為避免覆寫，變更只在目前執行期間生效。'
        : '設定檔來自較新的版本；本次變更只在目前執行期間生效，舊檔不會被覆寫。')
  }
  if (state.historyClearPending) {
    warnings.push(state.settings.saveHistory
      ? '歷史清除尚未完成，新的歷史已暫停寫入，等待 Windows 解除檔案占用。'
      : '歷史已停止顯示與新增，但磁碟清除仍在等待 Windows 解除檔案占用。')
  } else if (state.historyWarning) {
    warnings.push(state.historyWarning)
  }
  return [...new Set(warnings)].join(' ')
}

function renderPersistenceWarning(): string {
  const message = persistenceWarningMessage()
  return message
    ? `<div class="persistence-warning">${icon('info', 17)}<span>${escapeHtml(message)}</span><button type="button" data-action="open-settings">查看設定</button></div>`
    : ''
}

function languageTag(language: LanguageCode): string {
  return language === 'zh' ? 'zh-Hant' : 'en'
}

function truncate(value: string, length = 42): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length > length ? `${clean.slice(0, length)}…` : clean
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
            <span>${icon('shield', 15)} 本機運算 · 不上傳內容 · 永久零 API 費用</span>
            <button type="button" data-action="open-guide">使用指南</button>
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
            <span class="history-langs">${entry.result.detectedLanguage.toUpperCase()} → ${entry.result.targetLanguage.toUpperCase()}</span>
            <strong>${escapeHtml(truncate(entry.source))}</strong>
            <small>${escapeHtml(formatDate(entry.createdAt))}</small>
          </button>`,
        )
        .join('')
    : `<div class="empty-history">${icon('history', 24)}<span>${state.settings.saveHistory ? '翻譯後只會保存在這台電腦' : '最近翻譯目前不會保存'}</span></div>`

  const engineClass = state.engine.online && state.engine.modelReady ? 'ready' : 'needs-setup'
  const engineLabel = state.edition === 'offline' && state.engine.online && state.engine.modelReady
    ? '完整離線引擎已就緒'
    : !state.engine.online
      ? state.edition === 'offline'
        ? state.offlineEngineStart?.starting ? '正在啟動內建引擎' : '內建引擎啟動失敗'
        : '尚未連接本機引擎'
      : state.engine.modelReady
        ? '本機語言引擎就緒'
        : state.edition === 'offline' ? '正在載入內建模型' : '需要下載語言模型'

  return `
    <aside class="sidebar">
      <div class="brand-block">
        <div class="brand-mark" aria-hidden="true"><span>L</span><i>↗</i></div>
        <div><strong>LingoMuse</strong><small>靈譯</small></div>
      </div>

      <button class="new-button" type="button" data-action="new">
        ${icon('plus', 18)} 新的翻譯
      </button>

      <div class="side-label">
        <span>最近查詢</span>
        ${state.history.length ? `<button type="button" data-action="clear-history" aria-label="清除歷史">${icon('trash', 14)}</button>` : ''}
      </div>
      <div class="history-list">${history}</div>

      <button class="engine-mini ${engineClass}" type="button" data-action="open-settings">
        <span class="engine-dot"></span>
        <span><strong>${escapeHtml(engineLabel)}</strong><small>${escapeHtml(state.settings.model)}</small></span>
        ${icon('chevron', 16)}
      </button>
      <div class="zero-cost-stamp">NT$ 0 <span>永久零用量費</span></div>
    </aside>
  `
}

function renderTitlebar(): string {
  const statusText = state.engine.online && state.engine.modelReady
    ? state.edition === 'offline' ? '完整離線版已就緒' : '離線翻譯已就緒'
    : state.edition === 'offline' ? '正在啟動內建引擎' : '等待本機引擎'
  return `
    <header class="titlebar">
      <div class="drag-zone"></div>
      <button class="status-pill ${state.engine.online && state.engine.modelReady ? 'online' : ''}" type="button" data-action="open-settings">
        <span></span><b>${escapeHtml(statusText)}</b>
      </button>
      <div class="clipboard-status ${state.hook.active ? 'active' : ''}">
        ${icon('clipboard', 15)} ${state.hook.active ? '雙擊複製已開啟' : '雙擊複製未啟用'}
      </div>
      <button class="title-icon" type="button" data-action="open-settings" aria-label="設定">${icon('settings', 17)}</button>
      ${isDesktop ? `<button class="window-button" type="button" data-action="minimize" aria-label="最小化">${icon('minus', 16)}</button><button class="window-button close" type="button" data-action="close-window" aria-label="關閉">${icon('x', 16)}</button>` : ''}
    </header>
  `
}

function renderHero(): string {
  return `
    <section class="hero">
      <div>
        <p class="eyebrow">CHINESE <span>↔</span> ENGLISH</p>
        <h1>翻的不只字面，<em>是語氣。</em></h1>
        <p class="hero-copy">本機 AI 理解情境與語氣，優先避免逐字硬譯；重要內容仍請核對原文。</p>
      </div>
      <div class="shortcut-card">
        <div class="keycaps"><kbd>Ctrl</kbd><b>+</b><kbd>C</kbd><i>× 2</i></div>
        <span>在任何軟體連按兩次</span>
        <strong>複製、翻譯、發音</strong>
      </div>
    </section>
  `
}

function renderSetupNotice(): string {
  if (state.engine.online && state.engine.modelReady) return ''
  const online = state.engine.online
  const offline = state.edition === 'offline'
  const starting = offline && state.offlineEngineStart?.starting
  return `
    <section class="setup-notice">
      <div class="setup-symbol">${online ? icon('download', 21) : icon('info', 21)}</div>
      <div>
        <strong>${offline ? starting ? '正在準備完整離線引擎' : '完整離線引擎尚未就緒' : online ? '再一步，就能永久免費翻譯' : '先啟用免費的本機語言引擎'}</strong>
        <p>${offline ? starting ? '主畫面已可操作；模型正在背景載入，雙擊複製功能也已開始監聽。' : '引擎與模型都已隨附，可查看狀態並自動重試。' : online ? `下載 ${escapeHtml(state.settings.model)} 後，所有翻譯都只在這台電腦完成。` : '不需帳號、不需信用卡；安裝 Ollama 後即可離線使用。'}</p>
      </div>
      <button class="text-button" type="button" data-action="open-settings">${offline ? '查看狀態' : online ? '下載模型' : '開始設定'} ${icon('arrow', 16)}</button>
    </section>
  `
}

function renderTranslator(): string {
  return `
    <section class="translator-grid">
      <div class="translation-column">
        <article class="input-card">
          <div class="card-topline">
            <div class="language-route">
              <span>自動偵測</span>${icon('arrow', 15)}<strong>中英互譯</strong>
            </div>
            <span class="char-count" id="char-count">${state.input.length.toLocaleString()} / 12,000 · 中日韓約 3,000</span>
          </div>
          <textarea id="source-input" maxlength="12000" spellcheck="true" lang="${/[\u3400-\u9fff]/.test(state.input) ? 'zh-Hant' : 'en'}" aria-label="要翻譯的中文或英文" placeholder="輸入中文或英文…">${escapeHtml(state.input)}</textarea>
          <div class="input-actions">
            <div>
              <button class="icon-button" type="button" data-action="paste" title="貼上">${icon('clipboard', 18)}</button>
              <button class="icon-button" type="button" data-action="speak-source" title="朗讀原文">${icon('volume', 18)}</button>
              ${state.input ? `<button class="subtle-action" type="button" data-action="clear-input">清除</button>` : ''}
            </div>
            ${
              state.loading
                ? `<button class="translate-button stop" type="button" data-action="cancel">停止 ${icon('x', 17)}</button>`
                : `<button class="translate-button" type="button" data-action="translate">自然翻譯 ${icon('arrow', 18)}</button>`
            }
          </div>
        </article>

        ${state.error ? `<div class="error-banner" role="alert">${icon('info', 18)}<span>${escapeHtml(state.error)}</span><button type="button" data-action="open-settings">檢查設定</button></div>` : ''}
        ${renderResult()}
      </div>
      <aside class="learning-column">${renderLearningPanel()}</aside>
    </section>
  `
}

function renderResult(): string {
  if (state.partial) {
    const partial = state.partial
    return `
      <article class="result-card main-partial-card">
        <div class="result-label">
          <span>${partial.targetLanguage === 'zh' ? '繁體中文' : 'NATURAL ENGLISH'}</span>
          <b class="local-badge">快速預覽</b>
        </div>
        <div class="translation-row">
          <h2 lang="${languageTag(partial.targetLanguage)}">${escapeHtml(partial.translation)}</h2>
          <div class="result-actions">
            <button class="icon-button" type="button" data-action="speak-partial" title="朗讀英文" aria-label="朗讀英文">${icon('volume', 19)}</button>
            <button class="icon-button" type="button" data-action="copy-partial" title="複製譯文" aria-label="複製譯文">${icon('copy', 18)}</button>
          </div>
        </div>
        <div class="main-partial-progress ${state.loading ? '' : 'has-error'}">
          ${state.loading ? '<i></i>' : icon('info', 15)}
          <span><strong>${state.loading ? '快速預覽尚在核對，並補齊語氣說明與例句' : '完整核對沒有完成'}</strong><small>${state.loading ? `快速預覽 ${partial.elapsedMs} ms · 重要內容請等完整結果` : '上方內容僅供參考，可重新翻譯取得完整結果'}</small></span>
        </div>
      </article>
    `
  }
  if (state.loading) {
    return `
      <article class="result-card loading-card">
        <div class="loading-head"><span class="thinking-orbit"></span><div><strong>正在理解語氣與情境</strong><small>本機模型運算中，不會上傳內容</small></div></div>
        <div class="skeleton wide"></div><div class="skeleton medium"></div>
        <div class="skeleton-block"><div class="skeleton short"></div><div class="skeleton wide"></div></div>
      </article>
    `
  }
  if (!state.result) {
    return `
      <article class="result-card empty-result">
        <div class="empty-symbol">譯</div>
        <strong>自然譯文會出現在這裡</strong>
        <p>除了翻譯，還會附上語氣說明、替代說法與實用雙語例句。</p>
      </article>
    `
  }

  const result = state.result
  return `
    <article class="result-card">
      <div class="result-label">
        <span>${result.targetLanguage === 'zh' ? '繁體中文' : 'NATURAL ENGLISH'}</span>
        ${state.isDemo ? '<b>介面示範</b>' : '<b class="local-badge">本機生成</b>'}
      </div>
      <div class="translation-row">
        <h2 lang="${languageTag(result.targetLanguage)}">${escapeHtml(result.translation)}</h2>
        <div class="result-actions">
          <button class="icon-button" type="button" data-action="speak-english" title="朗讀英文">${icon('volume', 19)}</button>
          <button class="icon-button" type="button" data-action="copy-result" title="複製譯文">${icon('copy', 18)}</button>
        </div>
      </div>
      <div class="pronunciation">
        <span lang="en">${escapeHtml(result.pronunciation.text)}</span>
        <strong>${escapeHtml(result.pronunciation.ipa)}</strong>
      </div>
      <div class="nuance-box">
        <span class="nuance-label">為什麼這樣翻</span>
        <p>${escapeHtml(result.naturalnessNote)}</p>
      </div>
      <details class="literal-detail">
        <summary>查看直譯差異</summary>
        <p>${escapeHtml(result.literalMeaning)}</p>
      </details>
    </article>
  `
}

function renderLearningPanel(): string {
  if (state.loading) {
    return `
      <div class="learning-head"><span>語感筆記</span><b>LEARN</b></div>
      <div class="learning-skeleton"><div></div><div></div><div></div></div>
    `
  }
  const result = state.result
  if (!result) {
    return `
      <div class="learning-head"><span>語感筆記</span><b>LEARN</b></div>
      <div class="learning-empty">完成翻譯後，這裡會整理不同語氣與實用例句。</div>
    `
  }

  const alternatives = result.alternatives
    .map(
      (item, index) => `
        <div class="alternative-item">
          <span>${String(index + 1).padStart(2, '0')}</span>
          <div><small>${escapeHtml(item.label)}</small><strong lang="${languageTag(result.targetLanguage)}">${escapeHtml(item.text)}</strong></div>
          <button type="button" data-action="copy-alternative" data-index="${index}" aria-label="複製">${icon('copy', 15)}</button>
        </div>`,
    )
    .join('')

  const examples = result.examples
    .map(
      (example, index) => `
        <div class="example-item">
          <div class="example-number">${index + 1}</div>
          <div>
            <p lang="${languageTag(result.detectedLanguage)}">${escapeHtml(example.source)}</p>
            <strong lang="${languageTag(result.targetLanguage)}">${escapeHtml(example.target)}</strong>
            <small>${escapeHtml(example.note)}</small>
          </div>
          <button type="button" data-action="speak-example" data-index="${index}" aria-label="朗讀例句">${icon('volume', 15)}</button>
        </div>`,
    )
    .join('')

  const keywords = result.keywords
    .map((item) => `<span class="keyword"><strong>${escapeHtml(item.term)}</strong>${escapeHtml(item.meaning)}</span>`)
    .join('')

  return `
    <div class="learning-head"><span>語感筆記</span><b>LEARN</b></div>
    <section class="learning-section">
      <h3>換個語氣說</h3>
      ${alternatives}
    </section>
    <section class="learning-section examples-section">
      <h3>放進情境裡</h3>
      ${examples}
    </section>
    <section class="learning-section">
      <h3>關鍵用法</h3>
      <div class="keyword-list">${keywords}</div>
      <ul class="usage-list">${result.usageTips.map((tip) => `<li>${escapeHtml(tip)}</li>`).join('')}</ul>
    </section>
  `
}

function renderSettings(): string {
  if (!state.settingsOpen) return ''
  const offline = state.edition === 'offline'
  const engineStarting = offline && state.offlineEngineStart?.starting
  const selectedModel = MODEL_CHOICES.find((item) => item.id === state.settings.model)
  const progress = state.progress
  const resolvedModeLabels = {
    balanced: '平衡模式',
    fast: '速度優先',
    eco: '低資源模式',
  }
  const performanceModes: Array<{
    id: Settings['performanceMode']
    name: string
    description: string
    recommended?: boolean
  }> = [
    {
      id: 'auto',
      name: '自動',
      description: '依啟動／喚醒時可用記憶體與處理器，自動保留辦公空間',
      recommended: true,
    },
    {
      id: 'fast',
      name: '速度優先',
      description: '模型常駐記憶體，適合性能較好的電腦',
    },
    {
      id: 'eco',
      name: '低資源',
      description: '不在啟動時載入模型，閒置約 3 分鐘後釋放記憶體',
    },
  ]
  const performanceCards = performanceModes.map((mode) => `
    <button class="performance-card ${state.settings.performanceMode === mode.id ? 'selected' : ''}" type="button" data-action="select-performance" data-mode="${mode.id}" aria-pressed="${state.settings.performanceMode === mode.id}">
      <span class="radio-mark"></span>
      <span><strong>${mode.name}${mode.recommended ? '<em>建議</em>' : ''}</strong><small>${mode.description}</small></span>
    </button>
  `).join('')
  const modelCards = (offline ? MODEL_CHOICES.filter((model) => model.id === 'qwen3:1.7b') : MODEL_CHOICES).map((model) => {
    const installed = isModelInstalled(model.id)
    return `
      <button class="model-card ${state.settings.model === model.id ? 'selected' : ''}" type="button" data-action="select-model" data-model="${model.id}" aria-pressed="${state.settings.model === model.id}">
        <span class="radio-mark"></span>
        <span><strong>${model.name}${model.recommended ? '<em>建議</em>' : ''}</strong><small>${model.description}</small></span>
        <b>${model.size}</b>
        ${installed ? `<i>${icon('check', 12)} 已下載</i>` : ''}
      </button>
    `
  }).join('')

  const engineAction = offline
    ? engineStarting
      ? `<div class="engine-ready-row is-loading">${icon('refresh', 17)} <span><strong>正在背景準備離線引擎</strong><small>主畫面與雙擊複製已先啟動，不需重新開啟程式</small></span></div>`
      : state.engine.online && state.engine.modelReady
      ? `<div class="engine-ready-row">${icon('check', 17)} <span><strong>完整離線版已可使用</strong><small>引擎與 ${escapeHtml(state.settings.model)} 均由程式自動管理</small></span></div>`
      : `<div class="engine-recovery"><div class="offline-engine-error">${icon('info', 17)}<span><strong>內建引擎尚未就緒</strong><small>${escapeHtml(humanizeOfflineEngineError(state.offlineEngineStart?.error || ''))}</small></span></div><button class="primary-action" type="button" data-action="restart-engine" ${state.restartingEngine ? 'disabled' : ''}>${state.restartingEngine ? '正在重新啟動…' : '自動修復並重新啟動'} ${icon('refresh', 16)}</button></div>`
    : !state.engine.online
    ? `<button class="primary-action" type="button" data-action="download-ollama">免費下載 Ollama ${icon('arrow', 17)}</button>`
    : !state.engine.modelReady
      ? `<button class="primary-action" type="button" data-action="pull-model" ${state.pulling ? 'disabled' : ''}>${state.pulling ? '正在下載…' : `下載 ${escapeHtml(selectedModel?.name || '模型')}`} ${icon('download', 17)}</button>`
      : `<div class="engine-ready-row">${icon('check', 17)} <span><strong>已可離線翻譯</strong><small>${escapeHtml(state.settings.model)} 已就緒</small></span></div>`

  return `
    <div class="drawer-backdrop" data-action="close-settings"></div>
    <aside class="settings-drawer" role="dialog" aria-modal="true" aria-label="設定">
      <header>
        <div><span>SETTINGS</span><h2>讓靈譯更像你</h2></div>
        <button type="button" data-action="close-settings" aria-label="關閉">${icon('x', 19)}</button>
      </header>
      <div class="settings-scroll">
        <section class="settings-section engine-settings">
          <div class="section-heading"><span>01</span><div><h3>免費本機語言引擎</h3><p>翻譯只在你的電腦執行，不使用付費 API。</p></div></div>
          <div class="engine-health ${state.engine.online ? 'online' : ''}">
            <span></span><strong>${state.engine.online ? offline ? '內建 Ollama 已啟動' : 'Ollama 已連線' : offline ? '內建 Ollama 未啟動' : 'Ollama 尚未連線'}</strong>
            <button type="button" data-action="refresh-engine">${icon('refresh', 15)} 重新偵測</button>
          </div>
          <div class="model-list">${modelCards}</div>
          ${
            state.pulling && progress
              ? `<div class="download-progress"><div><span>${escapeHtml(progress.status)}</span><strong>${progress.percent}%</strong></div><div class="progress-track"><i style="width:${progress.percent}%"></i></div><small>${progress.total ? `${formatBytes(progress.completed)} / ${formatBytes(progress.total)}` : '正在準備檔案…'}</small></div>`
              : ''
          }
          ${engineAction}
          <div class="performance-settings">
            <div class="performance-title"><strong>電腦性能</strong><small>避免翻譯影響 Word、瀏覽器與視訊會議</small></div>
            <div class="performance-options">${performanceCards}</div>
            <p class="hardware-summary">${icon('sparkles', 14)} 已偵測 ${state.performance.totalMemoryGb} GB RAM · 啟動時可用 ${state.performance.availableMemoryGb} GB · ${state.performance.logicalCores} 個邏輯核心 · 目前採用 ${resolvedModeLabels[state.performance.resolvedMode]}</p>
            ${state.performance.resolvedMode === 'eco' ? '<p class="eco-note">低資源模式仍保留自然翻譯、發音與例句；完整說明會精簡為兩個例句，減少等待與耗電。</p>' : ''}
          </div>
          <p class="cost-proof">${icon('shield', 15)} ${offline ? '引擎與模型已完整隨附，不需安裝、下載或連線。' : 'Ollama 與所選模型皆可免費在本機使用；本程式不含任何付費端點。'}</p>
        </section>

        <section class="settings-section">
          <div class="section-heading"><span>02</span><div><h3>雙擊複製</h3><p>在其他軟體也能即時喚醒翻譯。</p></div></div>
          ${renderToggle('autoClipboard', '連按兩次 Ctrl+C 自動翻譯', '不會改變原本的複製功能', state.settings.autoClipboard)}
          ${renderToggle('autoSpeak', '自動朗讀英文', '只使用 Windows 明確標示的本機語音', state.settings.autoSpeak)}
          ${!state.hook.available ? `<div class="hook-warning">${icon('info', 16)}<div><strong>雙擊複製目前無法使用</strong><small>仍可在主畫面正常翻譯；重新啟動程式後會再次嘗試載入全域快速鍵。</small></div></div>` : ''}
          <div class="popup-mode-note">${icon('sparkles', 17)}<div><strong>翻譯改用懸浮小窗顯示</strong><small>雙擊複製不再打開整個主畫面；可拖曳邊緣調整大小，也能朗讀、複製或查看完整解析。</small></div></div>
          <label class="range-setting">
            <span><strong>雙擊間隔</strong><small id="interval-label">${state.settings.doubleCopyInterval} 毫秒</small></span>
            <input type="range" min="350" max="1200" step="10" value="${state.settings.doubleCopyInterval}" data-setting="doubleCopyInterval" aria-valuetext="${state.settings.doubleCopyInterval} 毫秒" />
          </label>
          <label class="range-setting">
            <span><strong>朗讀速度</strong><small id="rate-label">${state.settings.voiceRate.toFixed(2)}×</small></span>
            <input type="range" min="0.65" max="1.25" step="0.01" value="${state.settings.voiceRate}" data-setting="voiceRate" aria-valuetext="${state.settings.voiceRate.toFixed(2)} 倍" />
          </label>
        </section>

        <section class="settings-section">
          <div class="section-heading"><span>03</span><div><h3>應用程式</h3><p>常駐系統匣，隨時可以翻譯。</p></div></div>
          ${renderToggle('saveHistory', '儲存最近翻譯', '只保存在這台電腦；關閉時會立即清除現有記錄', state.settings.saveHistory)}
          ${renderToggle('launchAtLogin', '開機時自動啟動', '安裝版可使用此功能', state.settings.launchAtLogin)}
          ${offline ? '' : `<details class="advanced-settings">
            <summary>進階設定</summary>
            <label>本機引擎網址<input type="url" data-setting="baseUrl" value="${escapeHtml(state.settings.baseUrl)}" /></label>
          </details>`}
          <button class="diagnostic-button" type="button" data-action="copy-diagnostics">${icon('copy', 15)} 複製診斷資訊 <small>不包含翻譯或剪貼簿內容</small></button>
        </section>
        <div class="settings-meta">LingoMuse v${escapeHtml(state.version)} · MIT License</div>
      </div>
    </aside>
  `
}

function renderToggle(key: keyof Settings, title: string, description: string, checked: boolean): string {
  return `
    <label class="toggle-setting">
      <span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(description)}</small></span>
      <input type="checkbox" data-setting="${String(key)}" ${checked ? 'checked' : ''}/><i></i>
    </label>
  `
}

function renderGuide(): string {
  if (!state.guideOpen) return ''
  return `
    <div class="modal-backdrop" data-action="close-guide"></div>
    <section class="guide-modal" role="dialog" aria-modal="true" aria-label="使用指南">
      <button class="modal-close" type="button" data-action="close-guide" aria-label="關閉使用指南">${icon('x', 19)}</button>
      <p class="eyebrow">3 STEPS · ZERO COST</p>
      <h2>三步開始自然語感翻譯</h2>
      <div class="guide-steps">
        <article><span>1</span><div><strong>${state.edition === 'offline' ? '直接開啟即可使用' : '安裝本機引擎'}</strong><p>${state.edition === 'offline' ? '完整版已包含 Ollama 與 1.7B 語言模型，不需要任何設定。' : '在設定中免費安裝 Ollama，再下載輕量的 1.7B 語言模型。'}</p></div></article>
        <article><span>2</span><div><strong>在任何地方複製兩次</strong><p>選取中文或英文，於 720 毫秒內連按兩次 Ctrl+C。</p></div></article>
        <article><span>3</span><div><strong>聽發音，也學語感</strong><p>翻譯會顯示例句與語氣說明；需要時可按朗讀，自動朗讀可在設定開啟。</p></div></article>
      </div>
      <div class="privacy-callout">${icon('shield', 22)}<div><strong>內容留在你的電腦</strong><p>不需要帳號、API 金鑰或信用卡，也沒有按次或按字計費。最近翻譯預設不保存，可在設定中自行開啟。</p></div></div>
      ${state.engine.online && state.engine.modelReady
        ? `<button class="primary-action" type="button" data-action="finish-guide">開始使用 ${icon('arrow', 17)}</button>`
        : `<button class="primary-action" type="button" data-action="guide-to-settings">檢查本機引擎 ${icon('arrow', 17)}</button>`}
    </section>
  `
}

function updateVoiceLabels(): void {
  const intervalInput = document.querySelector<HTMLInputElement>('[data-setting="doubleCopyInterval"]')
  intervalInput?.addEventListener('input', () => {
    const label = document.querySelector('#interval-label')
    if (label) label.textContent = `${intervalInput.value} 毫秒`
    intervalInput.setAttribute('aria-valuetext', `${intervalInput.value} 毫秒`)
  })
  const rateInput = document.querySelector<HTMLInputElement>('[data-setting="voiceRate"]')
  rateInput?.addEventListener('input', () => {
    const label = document.querySelector('#rate-label')
    if (label) label.textContent = `${Number(rateInput.value).toFixed(2)}×`
    rateInput.setAttribute('aria-valuetext', `${Number(rateInput.value).toFixed(2)} 倍`)
  })
}

function showToast(message: string): void {
  state.toast = message
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    state.toast = ''
    render()
  }, 2600)
  render()
  announce(message)
}

async function runTranslation(trigger: Trigger): Promise<void> {
  const text = state.input.trim()
  if (!text) {
    state.error = '請先輸入或貼上要翻譯的內容。'
    render()
    return
  }
  cancelSpeech()
  const requestId = `main-${++mainRequestSequence}`
  activeMainRequestId = requestId
  activeMainSource = text
  state.loading = true
  state.partial = null
  state.result = null
  state.error = ''
  state.isDemo = false
  render()
  announce('正在使用本機模型翻譯。')

  let response: Awaited<ReturnType<typeof desktopApi.translate>>
  try {
    response = await desktopApi.translate(text, requestId)
  } catch {
    if (activeMainRequestId !== requestId) return
    activeMainRequestId = ''
    state.loading = false
    state.error = '桌面翻譯服務暫時沒有回應，請重新啟動離線引擎後再試。'
    render()
    return
  }
  if (activeMainRequestId !== requestId) return
  activeMainRequestId = ''
  state.loading = false
    if (!response.ok) {
      if (response.code === 'CANCELLED') {
        state.partial = null
        render()
        return
      }
      state.error = humanizeError(response.error, response.code)
      if (['ENGINE_OFFLINE', 'MODEL_NOT_FOUND'].includes(response.code)) state.settingsOpen = true
      render()
      if (state.settingsOpen) focusActiveDialog()
      return
  }

  state.result = response.result
  state.partial = null
  const entry: HistoryEntry = {
    id: crypto.randomUUID(),
    source: text,
    result: response.result,
    createdAt: Date.now(),
  }
  render()
  announce('完整翻譯與例句已完成。')

  if (state.settings.saveHistory) {
    void desktopApi.addHistory(entry).then((saved) => {
      const applied = applyHistorySnapshot(saved, state.settings.saveHistory)
      if (!saved.ok) {
        if (saved.error !== 'DISABLED') {
          state.historyWarning = '翻譯已完成，但 Windows 暫時無法寫入本機歷史。'
          showToast(state.historyWarning)
        }
        return
      }
      state.historyWarning = ''
      if (applied) render()
    }).catch(() => showToast('翻譯已完成，但這次無法寫入本機歷史。'))
  }

  if (trigger === 'clipboard' && state.settings.autoSpeak) {
    speakEnglishSide(response.result, text)
  }
}

function humanizeError(message: string, code: string): string {
  if (code === 'MODEL_NOT_FOUND') return '尚未下載所選的免費語言模型，請在設定中下載。'
  if (code === 'ENGINE_OFFLINE') {
    return state.edition === 'offline'
      ? '內建離線引擎尚未就緒，請開啟設定並使用「自動修復並重新啟動」。'
      : '找不到 Ollama 本機引擎；請先完成免費安裝並啟動。'
  }
  if (code === 'INVALID_RESPONSE') return '本機模型這次沒有產生完整結果，請再試一次。'
  if (code === 'INPUT_TOKEN_BUDGET') return '內容超過安全的模型上下文預算；中文、日文或韓文請分成約 3,000 字以內再翻譯。'
  if (code === 'RESPONSE_TOO_LARGE') return '本機模型回傳的內容異常過大，已為保護電腦記憶體而停止。'
  return message || '翻譯暫時失敗，請稍後再試。'
}

function humanizeOfflineEngineError(code: string): string {
  if (code === 'OFFLINE_BUNDLE_MISSING') return '離線引擎檔案不完整，請重新取得完整離線版。'
  if (code === 'OFFLINE_PORT_IN_USE') return '本機連接埠 11435 已被其他程式占用，請先關閉該程式再重試。'
  if (code === 'OFFLINE_MODEL_MISSING') return '找不到隨附的語言模型，離線版檔案可能不完整。'
  if (code === 'ENGINE_START_TIMEOUT') return '引擎啟動時間過長，可按下方按鈕自動重試。'
  if (code.startsWith('ENGINE_SPAWN_ERROR')) return 'Windows 無法啟動內建引擎，請確認檔案未被防毒軟體隔離後再重試。'
  if (code.startsWith('ENGINE_EXITED_')) return '離線引擎意外結束，可按下方按鈕自動重試。'
  return '可先使用下方自動修復；翻譯內容不會傳送到網路。'
}

function cancelSpeech(): void {
  speechAttempt += 1
  speechWaitController?.abort()
  speechWaitController = null
  window.speechSynthesis?.cancel()
}

async function speak(text: string, language: 'en-US' | 'zh-TW'): Promise<boolean> {
  if (!text.trim()) return false
  const attempt = ++speechAttempt
  speechWaitController?.abort()
  const controller = new AbortController()
  speechWaitController = controller
  if (!('speechSynthesis' in window)) {
    speechWaitController = null
    const message = '這台電腦不支援本機語音，因此未朗讀；文字沒有送出電腦。'
    showToast(message)
    return false
  }
  window.speechSynthesis.cancel()
  if (window.speechSynthesis.getVoices().length === 0) showToast('正在準備 Windows 本機語音…')
  const decision = await waitForLocalSpeechVoice(window.speechSynthesis, language, {
    timeoutMs: 1_500,
    signal: controller.signal,
  })
  if (controller.signal.aborted || attempt !== speechAttempt) return false
  speechWaitController = null
  if (decision.status !== 'ready') {
    const message = '找不到相符的 Windows 本機語音，因此未朗讀；文字沒有送出電腦。'
    showToast(message)
    return false
  }
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = language
  utterance.rate = state.settings.voiceRate
  utterance.voice = decision.voice
  utterance.onerror = () => {
    if (attempt === speechAttempt) showToast('Windows 本機語音朗讀失敗；文字沒有送出電腦。')
  }
  window.speechSynthesis.speak(utterance)
  showToast('正在使用 Windows 本機語音朗讀')
  return true
}

function speakEnglishSide(result: TranslationResult, source: string): void {
  void speak(result.detectedLanguage === 'en' ? source : result.translation, 'en-US')
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = text
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    textarea.remove()
  }
  showToast('已複製到剪貼簿')
}

async function refreshEngine(showFeedback = false): Promise<void> {
  state.engine = await desktopApi.getEngineStatus()
  if (showFeedback) showToast(state.engine.online ? '已找到本機語言引擎' : '目前仍找不到 Ollama')
  else render()
}

async function updateSetting(key: keyof Settings, value: Settings[keyof Settings]): Promise<void> {
  const disablingHistory = key === 'saveHistory' && value === false
  if (disablingHistory) {
    historyMigrationGeneration += 1
    state.settings = { ...state.settings, saveHistory: false }
    state.history = []
    render()
  }
  const response = await desktopApi.updateSettings({ [key]: value } as Partial<Settings>)
  const persistenceFailureAlreadyVisible = !state.settingsPersistence.persisted
  state.settings = response.settings
  state.settingsPersistence = response.settingsPersistence
  if (response.historySnapshot) {
    applyHistorySnapshot(response.historySnapshot, response.settings.saveHistory)
  } else {
    state.historyClearPending = response.historyClearPending
  }
  state.performance = response.performance
  state.engine = response.engine
  if (key === 'saveHistory' && !state.settings.saveHistory) {
    state.history = []
    if (!clearLegacyHistory() || response.historyClearOk === false) {
      state.historyWarning = '歷史已停止保存，但仍有本機檔案等待 Windows 解除占用後清除。'
      showToast(state.historyWarning)
    } else {
      state.historyWarning = ''
    }
  } else if (key === 'saveHistory' && state.settings.saveHistory) {
    await synchronizeSavedHistory()
  }
  if (key === 'autoSpeak' && !state.settings.autoSpeak) cancelSpeech()
  if (!response.settingsPersistence.persisted && !persistenceFailureAlreadyVisible) {
    showToast(persistenceWarningMessage())
  }
  render()
}

async function pullSelectedModel(): Promise<void> {
  state.pulling = true
  state.progress = { status: '準備下載', percent: 0, completed: 0, total: 0 }
  render()
  const result = await desktopApi.pullModel(state.settings.model)
  state.pulling = false
  if (!result.ok) {
    state.error = `模型下載失敗：${result.error || '請檢查網路後再試。'}`
    render()
    return
  }
  state.engine = await desktopApi.getEngineStatus()
  state.progress = null
  showToast('免費語言模型已安裝完成')
}

function loadLegacyHistory(): HistoryEntry[] {
  return readHistory(localStorage)
}

function clearLegacyHistory(): boolean {
  try {
    localStorage.removeItem(HISTORY_KEY)
    return true
  } catch {
    return false
  }
}

async function handleAction(action: string, target: HTMLElement): Promise<void> {
  switch (action) {
    case 'translate':
      await runTranslation('manual')
      break
    case 'cancel':
      activeMainRequestId = ''
      mainRequestSequence += 1
      await desktopApi.cancelTranslation()
      state.loading = false
      state.partial = null
      state.error = '已停止這次翻譯。'
      render()
      break
    case 'new':
      state.input = ''
      state.result = null
      state.error = ''
      state.isDemo = false
      render()
      document.querySelector<HTMLTextAreaElement>('#source-input')?.focus()
      break
    case 'clear-input':
      state.input = ''
      render()
      document.querySelector<HTMLTextAreaElement>('#source-input')?.focus()
      break
    case 'paste':
      try {
        state.input = await navigator.clipboard.readText()
        render()
      } catch {
        showToast('請使用 Ctrl+V 貼上內容')
      }
      break
    case 'speak-source':
      void speak(state.input, /[\u3400-\u9fff]/.test(state.input) ? 'zh-TW' : 'en-US')
      break
    case 'speak-english':
      if (state.result) speakEnglishSide(state.result, state.input)
      break
    case 'speak-example': {
      const example = state.result?.examples[Number(target.dataset.index)]
      if (example && state.result) {
        void speak(example.source, state.result.detectedLanguage === 'zh' ? 'zh-TW' : 'en-US')
      }
      break
    }
    case 'copy-result':
      if (state.result) await copyText(state.result.translation)
      break
    case 'copy-partial':
      if (state.partial) await copyText(state.partial.translation)
      break
    case 'speak-partial':
      if (state.partial) {
        void speak(
          state.partial.detectedLanguage === 'en' ? state.partial.source : state.partial.translation,
          'en-US',
        )
      }
      break
    case 'copy-alternative': {
      const alternative = state.result?.alternatives[Number(target.dataset.index)]
      if (alternative) await copyText(alternative.text)
      break
    }
    case 'history': {
      const item = state.history.find((entry) => entry.id === target.dataset.id)
      if (item) {
        state.input = item.source
        state.result = item.result
        state.isDemo = false
        state.error = ''
        render()
      }
      break
    }
    case 'clear-history': {
      historyMigrationGeneration += 1
      const cleared = await desktopApi.clearHistory()
      applyHistorySnapshot(cleared, state.settings.saveHistory)
      if (!cleared.ok) {
        state.historyWarning = 'Windows 暫時無法完成磁碟清除；請關閉可能占用檔案的程式後再試。'
        showToast(state.historyWarning)
      } else {
        state.historyWarning = ''
        render()
      }
      break
    }
    case 'copy-diagnostics':
      await copyText(JSON.stringify({
        app: 'LingoMuse',
        version: state.version,
        edition: state.edition,
        platform: state.platform,
        engine: {
          online: state.engine.online,
          modelReady: state.engine.modelReady,
          model: state.engine.model,
          startError: state.offlineEngineStart?.error || '',
          warmupError: state.offlineWarmup?.error || '',
        },
        performance: state.performance,
        hook: {
          active: state.hook.active,
          available: state.hook.available,
          error: state.hook.error || '',
        },
      }, null, 2))
      break
    case 'open-settings':
      state.settingsOpen = true
      render()
      focusActiveDialog()
      break
    case 'close-settings':
      state.settingsOpen = false
      render()
      break
    case 'select-model':
      await updateSetting('model', target.dataset.model || defaultSettings.model)
      break
    case 'select-performance':
      await updateSetting('performanceMode', (target.dataset.mode || 'auto') as Settings['performanceMode'])
      break
    case 'refresh-engine':
      await refreshEngine(true)
      break
    case 'restart-engine': {
      state.restartingEngine = true
      state.error = ''
      render()
      const response = await desktopApi.restartOfflineEngine()
      state.restartingEngine = false
      state.engine = response.engine
      if (response.offlineEngineStart) state.offlineEngineStart = response.offlineEngineStart
      if (response.offlineWarmup) state.offlineWarmup = response.offlineWarmup
      if (response.ok) showToast('離線引擎已恢復，可以繼續翻譯')
      else {
        state.error = humanizeOfflineEngineError(response.error || '')
        render()
      }
      break
    }
    case 'download-ollama':
      await desktopApi.openOllamaDownload()
      showToast('已開啟 Ollama 官方下載頁')
      break
    case 'pull-model':
      await pullSelectedModel()
      break
    case 'open-guide':
      state.guideOpen = true
      render()
      focusActiveDialog()
      break
    case 'close-guide':
      completeOnboarding()
      state.guideOpen = false
      render()
      break
    case 'finish-guide':
      completeOnboarding()
      state.guideOpen = false
      render()
      document.querySelector<HTMLTextAreaElement>('#source-input')?.focus()
      break
    case 'guide-to-settings':
      completeOnboarding()
      state.guideOpen = false
      state.settingsOpen = true
      render()
      focusActiveDialog()
      break
    case 'minimize':
      await desktopApi.minimize()
      break
    case 'close-window':
      await desktopApi.close()
      break
  }
}

root.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]')
  if (!target) return
  void handleAction(target.dataset.action || '', target)
})

root.addEventListener('input', (event) => {
  const target = event.target as HTMLInputElement | HTMLTextAreaElement
  if (target.id === 'source-input') {
    state.input = target.value
    const counter = document.querySelector('#char-count')
    if (counter) counter.textContent = `${target.value.length.toLocaleString()} / 12,000 · 中日韓約 3,000`
  }
})

root.addEventListener('change', (event) => {
  const target = event.target as HTMLInputElement
  const key = target.dataset.setting as keyof Settings | undefined
  if (!key) return
  let value: string | number | boolean = target.value
  if (target.type === 'checkbox') value = target.checked
  if (target.type === 'range') value = Number(target.value)
  void updateSetting(key, value)
})

window.addEventListener('keydown', (event) => {
  if (event.key === 'Tab' && (state.guideOpen || state.settingsOpen)) {
    const dialog = document.querySelector<HTMLElement>(state.guideOpen ? '.guide-modal' : '.settings-drawer')
    const focusable = dialog
      ? Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'))
      : []
    if (focusable.length) {
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!dialog?.contains(document.activeElement)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
  }
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !state.guideOpen && !state.settingsOpen) {
    event.preventDefault()
    void runTranslation('manual')
  }
  if (event.key === 'Escape') {
    if (state.guideOpen) {
      completeOnboarding()
      state.guideOpen = false
    }
    else if (state.settingsOpen) state.settingsOpen = false
    else return
    render()
  }
})

desktopApi.onClipboardTrigger(({ text }) => {
  state.input = text
  state.error = ''
  showToast('已擷取剪貼簿，正在自然翻譯')
  void runTranslation('clipboard')
})

desktopApi.onPopupResult(({ source, result }) => {
  state.input = source
  state.result = result
  state.error = ''
  state.isDemo = false
  render()
})

desktopApi.onHookStatus((hook: HookStatus) => {
  state.hook = hook
  render()
})

desktopApi.onSettingsChanged((nextSettings) => {
  state.settings = nextSettings
  if (!nextSettings.saveHistory) {
    historyMigrationGeneration += 1
    state.history = []
    if (!clearLegacyHistory()) {
      state.historyWarning = '歷史已停止保存，但舊儲存區仍等待 Windows 解除占用後清除。'
    }
  }
  render()
})

desktopApi.onSettingsPersistence((status) => {
  const becameUnpersisted = state.settingsPersistence.persisted && !status.persisted
  state.settingsPersistence = status
  render()
  if (becameUnpersisted) announce(persistenceWarningMessage())
})

desktopApi.onHistoryChanged((history) => {
  applyHistorySnapshot(history, state.settings.saveHistory)
  if (!state.settings.saveHistory) state.history = []
  render()
})

desktopApi.onTranslationPartial((partial) => {
  if (partial.requestId !== activeMainRequestId) return
  state.partial = { ...partial, source: activeMainSource }
  render()
  announce('快速翻譯預覽已顯示，完整結果仍在核對。')
})

desktopApi.onEngineState((payload) => {
  state.engine = payload.engine
  if (payload.performance) state.performance = payload.performance
  if (payload.offlineEngineStart) state.offlineEngineStart = payload.offlineEngineStart
  if (payload.offlineWarmup) state.offlineWarmup = payload.offlineWarmup
  render()
})

desktopApi.onModelProgress((progress: ModelProgress) => {
  state.progress = progress
  if (progress.percent !== lastProgressPercent) {
    lastProgressPercent = progress.percent
    render()
  }
})

async function initialize(): Promise<void> {
  render()
  try {
    const snapshot = await desktopApi.getState()
    Object.assign(state, snapshot)
    if (state.historyClearPending) {
      state.historyWarning = '歷史已停止保存；磁碟清除仍在等待 Windows 解除檔案占用。'
    }
    if (state.settings.saveHistory) {
      await synchronizeSavedHistory()
    } else {
      state.history = []
      applyHistorySnapshot(await desktopApi.listHistory(), false)
      if (state.historyClearAuthorized && !clearLegacyHistory()) {
        state.historyWarning = '歷史已停止保存，但舊儲存區仍等待 Windows 解除占用後清除。'
      }
    }
    if (isDesktop && !onboardingCompleted()) state.guideOpen = true
  } catch {
    state.error = '無法讀取桌面程式狀態。'
  }
  render()
  const persistenceWarning = persistenceWarningMessage()
  if (persistenceWarning) announce(persistenceWarning)
  if (state.guideOpen) focusActiveDialog()

  window.setInterval(() => {
    if (document.visibilityState !== 'visible') return
    if (!state.engine.online || state.settingsOpen) void refreshEngine()
  }, 15_000)
}

void initialize()
