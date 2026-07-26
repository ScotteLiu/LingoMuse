import './popup.css'
import { desktopApi, isDesktop } from './api'
import { icon } from './icons'
import { waitForLocalSpeechVoice } from './local-speech'
import { PRIVACY_DEFAULTS } from '../electron/privacy-defaults.mjs'
import type { HistoryEntry, LanguageCode, Settings, TranslationResult } from './types'

const root = document.querySelector<HTMLDivElement>('#app')!
const announcer = document.createElement('div')
announcer.className = 'sr-only'
announcer.setAttribute('role', 'status')
announcer.setAttribute('aria-live', 'polite')
announcer.setAttribute('aria-atomic', 'true')
document.body.appendChild(announcer)

const settings: Settings = {
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

const popupState: {
  source: string
  result: TranslationResult | null
  loading: boolean
  error: string
  copied: boolean
  edition: 'light' | 'offline'
  pinned: boolean
  opacity: number
  opacityPanelOpen: boolean
  partial: {
    detectedLanguage: LanguageCode
    targetLanguage: LanguageCode
    translation: string
    elapsedMs: number
  } | null
  detailsError: string
  speechNotice: string
  storageNotice: string
} = {
  source: '',
  result: null,
  loading: false,
  error: '',
  copied: false,
  edition: 'offline',
  pinned: true,
  opacity: 1,
  opacityPanelOpen: false,
  partial: null,
  detailsError: '',
  speechNotice: '',
  storageNotice: '',
}

let requestSequence = 0
let copiedTimer = 0
let activeResize: { pointerId: number; handle: HTMLElement } | null = null
let pendingResizePoint: { x: number; y: number } | null = null
let resizeFrame = 0
let renderPending = false
let spokenSequence = 0
let speechAttempt = 0
let speechWaitController: AbortController | null = null
let currentTriggerStartedAt = 0
const resizeDirections = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']

function announce(message: string): void {
  announcer.textContent = ''
  window.requestAnimationFrame(() => {
    announcer.textContent = message
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

function languageTag(language: LanguageCode): string {
  return language === 'zh' ? 'zh-Hant' : 'en'
}

function captureFocus(): { action: string; index: string; opacity: boolean } | null {
  const element = document.activeElement as HTMLElement | null
  if (!element || element === document.body) return null
  return {
    action: element.dataset.action || '',
    index: element.dataset.index || '',
    opacity: element.matches('[data-opacity]'),
  }
}

function restoreFocus(snapshot: ReturnType<typeof captureFocus>): void {
  if (!snapshot) return
  window.requestAnimationFrame(() => {
    const controls = Array.from(root.querySelectorAll<HTMLElement>('button, input'))
    const target = controls.find((candidate) => (
      (snapshot.opacity && candidate.matches('[data-opacity]'))
      || (snapshot.action && candidate.dataset.action === snapshot.action
        && (!snapshot.index || candidate.dataset.index === snapshot.index))
    ))
    target?.focus()
  })
}

function render(): void {
  if (activeResize) {
    renderPending = true
    return
  }
  const focusSnapshot = captureFocus()
  root.innerHTML = `
    <main class="quick-popup ${popupState.loading ? 'is-loading' : ''}">
      <header class="popup-titlebar">
        <div class="popup-brand">
          <span class="brand-mark">LM</span>
          <span><strong>雙擊快譯</strong><small>${popupState.edition === 'offline' ? '完整離線' : '本機翻譯'} · 零費用</small></span>
        </div>
        <div class="window-actions">
          <button class="${popupState.pinned ? 'is-pinned' : ''}" type="button" data-action="toggle-pin" title="${popupState.pinned ? '取消置頂' : '保持置頂'}" aria-label="${popupState.pinned ? '取消視窗置頂' : '將視窗保持置頂'}" aria-pressed="${popupState.pinned}">${icon('pin', 15)}</button>
          <button class="${popupState.opacityPanelOpen ? 'is-active' : ''}" type="button" data-action="toggle-opacity" title="調整透明度（${Math.round(popupState.opacity * 100)}%）" aria-label="調整小窗透明度" aria-expanded="${popupState.opacityPanelOpen}">${icon('opacity', 16)}</button>
          <button type="button" data-action="open-main" title="開啟主視窗" aria-label="開啟主視窗">${icon('arrow', 15)}</button>
          <button type="button" data-action="close" title="關閉小窗" aria-label="關閉小窗">${icon('x', 16)}</button>
        </div>
      </header>
      ${popupState.opacityPanelOpen ? renderOpacityPanel() : ''}
      ${popupState.speechNotice ? `<div class="speech-notice">${icon('info', 15)}<span>${escapeHtml(popupState.speechNotice)}</span></div>` : ''}
      ${popupState.storageNotice ? `<div class="storage-notice">${icon('info', 15)}<span>${escapeHtml(popupState.storageNotice)}</span></div>` : ''}
      ${renderBody()}
    </main>
    ${resizeDirections.map((direction) => `<div class="resize-handle resize-${direction}" data-resize="${direction}" aria-hidden="true"></div>`).join('')}
  `
  restoreFocus(focusSnapshot)
}

function renderOpacityPanel(): string {
  const percent = Math.round(popupState.opacity * 100)
  return `
    <section class="opacity-panel" aria-label="小窗透明度">
      <div class="opacity-heading"><strong>小窗透明度</strong><output id="opacity-value">${percent}%</output></div>
      <input type="range" min="45" max="100" step="1" value="${percent}" data-opacity aria-label="透明度百分比" />
      <div class="opacity-footer"><span>45%</span><button type="button" data-action="reset-opacity">恢復 100%</button></div>
    </section>
  `
}

function renderBody(): string {
  if (popupState.partial && !popupState.result) return renderPartialResult()

  if (popupState.loading) {
    return `
      <section class="popup-loading">
        <div class="loading-orbit">${icon('sparkles', 22)}</div>
        <div><strong>正在自然翻譯</strong><p>${escapeHtml(popupState.source)}</p></div>
      </section>
      <footer class="privacy-line">${icon('shield', 14)} 內容只在這台電腦處理</footer>
    `
  }

  if (popupState.error) {
    return `
      <section class="popup-error">
        <span>${icon('info', 20)}</span>
        <div><strong>這次沒有翻譯成功</strong><p>${escapeHtml(popupState.error)}</p></div>
      </section>
      <div class="error-actions">
        <button class="soft-button" type="button" data-action="retry">再試一次</button>
        <button class="text-button" type="button" data-action="open-main">開啟主視窗檢查</button>
      </div>
    `
  }

  if (!popupState.result) {
    return `
      <section class="popup-empty">
        ${icon('clipboard', 26)}
        <strong>選取文字，連按兩次 Ctrl+C</strong>
        <p>自然翻譯會在這個小窗顯示。</p>
      </section>
    `
  }

  const result = popupState.result
  const sourceLabel = result.detectedLanguage === 'zh' ? '中文原文' : '英文原文'
  const resultLabel = result.targetLanguage === 'zh' ? '自然中文' : '自然英文'
  const examples = result.examples.slice(0, 2)

  return `
    <div class="popup-scroll">
      <section class="source-block">
        <span class="section-label">${sourceLabel}</span>
        <p lang="${languageTag(result.detectedLanguage)}">${escapeHtml(popupState.source)}</p>
      </section>

      <section class="result-block">
        <div class="result-heading">
          <span class="section-label">${resultLabel}</span>
          <div class="result-actions">
            <button type="button" data-action="speak" title="朗讀英文" aria-label="朗讀英文">${icon('volume', 17)}</button>
            <button type="button" data-action="copy" title="複製翻譯" aria-label="${popupState.copied ? '已複製' : '複製翻譯'}">${popupState.copied ? icon('check', 17) : icon('copy', 17)}</button>
          </div>
        </div>
        <h1 lang="${languageTag(result.targetLanguage)}">${escapeHtml(result.translation)}</h1>
        ${result.pronunciation?.ipa ? `<p class="ipa">${escapeHtml(result.pronunciation.ipa)}</p>` : ''}
      </section>

      ${result.naturalnessNote ? `
        <section class="nuance-card">
          ${icon('sparkles', 16)}
          <div><strong>這樣說更自然</strong><p>${escapeHtml(result.naturalnessNote)}</p></div>
        </section>
      ` : ''}

      ${examples.length ? `
        <section class="examples-block">
          <span class="section-label">例句</span>
          ${examples.map((example, index) => `
            <article class="example-row">
              <button type="button" data-action="speak-example" data-index="${index}" aria-label="朗讀例句">${icon('volume', 14)}</button>
              <div><strong lang="${languageTag(result.detectedLanguage)}">${escapeHtml(example.source)}</strong><p lang="${languageTag(result.targetLanguage)}">${escapeHtml(example.target)}</p></div>
            </article>
          `).join('')}
        </section>
      ` : ''}
    </div>
    <footer class="popup-footer">
      <span>${icon('shield', 13)} 完全本機處理</span>
      <div class="footer-actions">
        <button type="button" data-action="open-main">查看完整解析 ${icon('arrow', 13)}</button>
        <i class="resize-grip" title="拖曳邊緣可調整大小" aria-hidden="true"></i>
      </div>
    </footer>
  `
}

function renderPartialResult(): string {
  const partial = popupState.partial!
  const sourceLabel = partial.detectedLanguage === 'zh' ? '中文原文' : '英文原文'
  const resultLabel = partial.targetLanguage === 'zh' ? '自然中文' : '自然英文'
  return `
    <div class="popup-scroll">
      <section class="source-block partial-source">
        <span class="section-label">${sourceLabel}</span>
        <p lang="${languageTag(partial.detectedLanguage)}">${escapeHtml(popupState.source)}</p>
      </section>
      <section class="result-block partial-result">
        <div class="result-heading">
          <span class="section-label">${resultLabel} · 快速預覽</span>
          <div class="result-actions">
            <button type="button" data-action="speak" title="朗讀英文" aria-label="朗讀英文">${icon('volume', 17)}</button>
            <button type="button" data-action="copy" title="複製翻譯" aria-label="${popupState.copied ? '已複製' : '複製翻譯'}">${popupState.copied ? icon('check', 17) : icon('copy', 17)}</button>
          </div>
        </div>
        <h1 lang="${languageTag(partial.targetLanguage)}">${escapeHtml(partial.translation)}</h1>
      </section>
      <section class="details-progress ${popupState.detailsError ? 'has-error' : ''}">
        ${popupState.detailsError ? icon('info', 15) : '<i></i>'}
        <div><strong>${popupState.detailsError ? '快速預覽可供參考' : '快速預覽，尚在核對'}</strong><p>${popupState.detailsError ? escapeHtml(popupState.detailsError) : '正在背景核對並補齊例句與語氣說明…'}</p></div>
      </section>
    </div>
    <footer class="popup-footer partial-footer">
      <span>${icon('shield', 13)} 完全本機處理</span>
      <div class="footer-actions"><em>${popupState.detailsError ? '重要內容請核對原文' : `快速預覽 ${partial.elapsedMs} ms`}</em><i class="resize-grip" aria-hidden="true"></i></div>
    </footer>
  `
}

async function handleClipboardTrigger(payload: { text: string; timestamp: number }): Promise<void> {
  const text = String(payload.text || '').trim()
  if (!text) return

  cancelSpeech()
  const sequence = ++requestSequence
  currentTriggerStartedAt = Number(payload.timestamp) || Date.now()
  popupState.source = text
  popupState.result = null
  popupState.partial = null
  popupState.loading = true
  popupState.error = ''
  popupState.detailsError = ''
  popupState.speechNotice = ''
  popupState.storageNotice = ''
  popupState.copied = false
  render()
  announce('正在使用本機模型翻譯。')
  void desktopApi.setPopupHeight(248)

  const response = await desktopApi.translate(text, String(sequence))
  if (sequence !== requestSequence) return
  popupState.loading = false

  if (!response.ok) {
    if (response.code === 'CANCELLED') return
    if (popupState.partial) {
      popupState.detailsError = humanizeError(response.error, response.code)
      render()
      announce(popupState.detailsError)
      return
    }
    popupState.error = humanizeError(response.error, response.code)
    render()
    announce(popupState.error)
    void desktopApi.setPopupHeight(330)
    return
  }

  popupState.result = response.result
  popupState.partial = null
  render()
  announce('完整翻譯與例句已完成。')
  if (settings.saveHistory) void recordHistory(text, response.result, sequence)
  void desktopApi.setPopupHeight(640)

  if (settings.autoSpeak && spokenSequence !== sequence) {
    spokenSequence = sequence
    speakEnglishSide(response.result, text)
  }
}

function cancelPopupWork(): void {
  requestSequence += 1
  spokenSequence = 0
  popupState.loading = false
  popupState.partial = null
  if (activeResize) {
    if (resizeFrame) window.cancelAnimationFrame(resizeFrame)
    resizeFrame = 0
    pendingResizePoint = null
    activeResize = null
    renderPending = false
    void desktopApi.endPopupResize()
  }
  cancelSpeech()
  void desktopApi.cancelTranslation()
}

function humanizeError(message: string, code: string): string {
  if (code === 'MODEL_NOT_FOUND') return '尚未準備好本機語言模型，請開啟主視窗查看設定。'
  if (code === 'ENGINE_OFFLINE') return popupState.edition === 'offline'
    ? '離線翻譯引擎尚未啟動完成，請稍候幾秒再試。'
    : '找不到本機翻譯引擎，請開啟主視窗查看設定。'
  if (code === 'INVALID_RESPONSE') return '本機模型這次沒有產生完整結果，請再試一次。'
  if (code === 'INPUT_TOKEN_BUDGET') return '內容過長，為避免被模型截斷，請把中文、日文或韓文分成約 3,000 字以內。'
  if (code === 'RESPONSE_TOO_LARGE') return '模型回傳內容異常過大，已為保護記憶體而停止。'
  return message || '翻譯暫時失敗，請稍後再試。'
}

function showSpeechNotice(message: string): void {
  popupState.speechNotice = message
  render()
  announce(message)
}

function showStorageNotice(message: string): void {
  popupState.storageNotice = message
  render()
  announce(message)
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
    showSpeechNotice('這台電腦不支援本機語音，因此未朗讀；文字沒有送出電腦。')
    return false
  }
  window.speechSynthesis.cancel()
  if (window.speechSynthesis.getVoices().length === 0) showSpeechNotice('正在準備 Windows 本機語音…')
  const decision = await waitForLocalSpeechVoice(window.speechSynthesis, language, {
    timeoutMs: 1_500,
    signal: controller.signal,
  })
  if (controller.signal.aborted || attempt !== speechAttempt) return false
  speechWaitController = null
  if (decision.status !== 'ready') {
    showSpeechNotice('找不到相符的 Windows 本機語音，因此未朗讀；文字沒有送出電腦。')
    return false
  }
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = language
  utterance.rate = settings.voiceRate
  utterance.voice = decision.voice
  utterance.onstart = () => {
    if (attempt !== speechAttempt) return
    void desktopApi.markPerfStage('speech ready')
  }
  utterance.onend = () => {
    if (attempt !== speechAttempt) return
    popupState.speechNotice = ''
    render()
  }
  utterance.onerror = () => {
    if (attempt === speechAttempt) showSpeechNotice('Windows 本機語音朗讀失敗；文字沒有送出電腦。')
  }
  window.speechSynthesis.speak(utterance)
  showSpeechNotice('正在使用 Windows 本機語音朗讀')
  return true
}

function speakEnglishSide(result: TranslationResult, source: string): void {
  void speak(result.detectedLanguage === 'en' ? source : result.translation, 'en-US')
}

async function copyResult(): Promise<void> {
  const translation = popupState.result?.translation ?? popupState.partial?.translation
  if (!translation) return
  try {
    await navigator.clipboard.writeText(translation)
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = translation
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    textarea.remove()
  }
  popupState.copied = true
  announce('已複製翻譯。')
  window.clearTimeout(copiedTimer)
  copiedTimer = window.setTimeout(() => {
    popupState.copied = false
    render()
  }, 1400)
  render()
}

async function recordHistory(source: string, result: TranslationResult, sequence: number): Promise<void> {
  const entry: HistoryEntry = {
    id: crypto.randomUUID(),
    source,
    result,
    createdAt: Date.now(),
  }
  try {
    const saved = await desktopApi.addHistory(entry)
    if (sequence !== requestSequence || saved.ok || saved.error === 'DISABLED') return
    showStorageNotice('翻譯已完成，但 Windows 暫時無法寫入本機歷史。')
  } catch {
    if (sequence !== requestSequence) return
    showStorageNotice('翻譯已完成，但本機歷史服務暫時沒有回應。')
  }
}

function queueResizeMove(event: PointerEvent): void {
  pendingResizePoint = { x: event.screenX, y: event.screenY }
  if (resizeFrame) return
  resizeFrame = window.requestAnimationFrame(() => {
    resizeFrame = 0
    if (!pendingResizePoint) return
    const point = pendingResizePoint
    pendingResizePoint = null
    void desktopApi.movePopupResize(point)
  })
}

function finishResize(event: PointerEvent): void {
  if (!activeResize || event.pointerId !== activeResize.pointerId) return
  if (resizeFrame) window.cancelAnimationFrame(resizeFrame)
  resizeFrame = 0
  if (pendingResizePoint) void desktopApi.movePopupResize(pendingResizePoint)
  pendingResizePoint = null
  activeResize = null
  void desktopApi.endPopupResize()
  if (renderPending) {
    renderPending = false
    render()
  }
}

root.addEventListener('pointerdown', (event) => {
  const handle = (event.target as HTMLElement).closest<HTMLElement>('[data-resize]')
  if (!handle || event.button !== 0) return
  event.preventDefault()
  activeResize = { pointerId: event.pointerId, handle }
  handle.setPointerCapture(event.pointerId)
  void desktopApi.startPopupResize({
    direction: handle.dataset.resize || '',
    x: event.screenX,
    y: event.screenY,
  })
})

root.addEventListener('pointermove', (event) => {
  if (!activeResize || event.pointerId !== activeResize.pointerId) return
  queueResizeMove(event)
})

root.addEventListener('pointerup', finishResize)
root.addEventListener('pointercancel', finishResize)
root.addEventListener('lostpointercapture', finishResize)

root.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]')
  if (!target) {
    if (popupState.opacityPanelOpen && !(event.target as HTMLElement).closest('.opacity-panel')) {
      popupState.opacityPanelOpen = false
      render()
    }
    return
  }

  switch (target.dataset.action) {
    case 'close':
      cancelPopupWork()
      void desktopApi.closePopup()
      break
    case 'open-main': {
      const payload = { source: popupState.source, result: popupState.result }
      cancelPopupWork()
      void desktopApi.openMainFromPopup(payload)
      break
    }
    case 'toggle-pin': {
      popupState.pinned = !popupState.pinned
      const pinned = popupState.pinned
      render()
      void desktopApi.setPopupPinned(pinned).then((response) => {
        if (!response.ok) {
          popupState.pinned = !pinned
          render()
        } else if (response.persisted === false) {
          showStorageNotice('置頂已在本次執行中生效，但 Windows 暫時無法保存設定。')
        }
      })
      break
    }
    case 'toggle-opacity':
      popupState.opacityPanelOpen = !popupState.opacityPanelOpen
      render()
      if (popupState.opacityPanelOpen) {
        window.requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-opacity]')?.focus())
      }
      break
    case 'reset-opacity':
      popupState.opacity = 1
      render()
      void desktopApi.setPopupOpacity(1, true).then((response) => {
        if (response.persisted === false) showStorageNotice('透明度已套用，但 Windows 暫時無法保存設定。')
      })
      break
    case 'retry':
      void handleClipboardTrigger({ text: popupState.source, timestamp: Date.now() })
      break
    case 'copy':
      void copyResult()
      break
    case 'speak':
      if (popupState.result) speakEnglishSide(popupState.result, popupState.source)
      else if (popupState.partial) {
        void speak(
          popupState.partial.detectedLanguage === 'en' ? popupState.source : popupState.partial.translation,
          'en-US',
        )
      }
      break
    case 'speak-example': {
      const example = popupState.result?.examples[Number(target.dataset.index)]
      if (example && popupState.result) {
        void speak(example.source, popupState.result.detectedLanguage === 'zh' ? 'zh-TW' : 'en-US')
      }
      break
    }
  }
})

root.addEventListener('input', (event) => {
  const target = event.target as HTMLInputElement
  if (!target.matches('[data-opacity]')) return
  const percent = Math.max(45, Math.min(100, Number(target.value) || 100))
  popupState.opacity = percent / 100
  const output = document.querySelector<HTMLOutputElement>('#opacity-value')
  if (output) output.value = `${percent}%`
  void desktopApi.setPopupOpacity(popupState.opacity, false)
})

root.addEventListener('change', (event) => {
  const target = event.target as HTMLInputElement
  if (!target.matches('[data-opacity]')) return
  const percent = Math.max(45, Math.min(100, Number(target.value) || 100))
  popupState.opacity = percent / 100
  void desktopApi.setPopupOpacity(popupState.opacity, true).then((response) => {
    if (response.persisted === false) showStorageNotice('透明度已套用，但 Windows 暫時無法保存設定。')
  })
})

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (popupState.opacityPanelOpen) {
      popupState.opacityPanelOpen = false
      render()
      return
    }
    cancelPopupWork()
    void desktopApi.closePopup()
  }
})

desktopApi.onClipboardTrigger((payload) => {
  void handleClipboardTrigger(payload)
})

desktopApi.onSettingsChanged((nextSettings) => {
  if (settings.autoSpeak && !nextSettings.autoSpeak) cancelSpeech()
  Object.assign(settings, nextSettings)
})

desktopApi.onTranslationPartial((partial) => {
  if (partial.requestId !== String(requestSequence) || popupState.result) return
  popupState.partial = {
    ...partial,
    elapsedMs: Math.max(partial.elapsedMs, Date.now() - currentTriggerStartedAt),
  }
  popupState.loading = false
  popupState.error = ''
  render()
  announce('快速翻譯預覽已顯示，完整結果仍在核對。')
  void desktopApi.setPopupHeight(390)
})

async function initialize(): Promise<void> {
  render()
  try {
    const initial = await desktopApi.popupReady()
    if (initial) {
      Object.assign(settings, initial.settings)
      popupState.edition = initial.edition
      popupState.pinned = initial.settings.popupPinned
      popupState.opacity = initial.settings.popupOpacity
    }
    render()
    if (initial?.payload) void handleClipboardTrigger(initial.payload)
  } catch {
    // Keep the popup ready; a translation request will surface a useful error.
  }

  if (!isDesktop) {
    void handleClipboardTrigger({ text: '我不是故意讓你為難。', timestamp: Date.now() })
  }
}

void initialize()
