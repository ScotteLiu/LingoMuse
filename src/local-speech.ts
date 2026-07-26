export interface LocalSpeechVoice {
  lang: string
  localService: boolean
}

export interface LocalSpeechSource<T extends LocalSpeechVoice> {
  getVoices: () => readonly T[]
  addEventListener: (type: 'voiceschanged', listener: () => void) => void
  removeEventListener: (type: 'voiceschanged', listener: () => void) => void
}

export type LocalSpeechDecision<T extends LocalSpeechVoice = LocalSpeechVoice> =
  | { status: 'ready'; voice: T }
  | { status: 'loading'; voice: null }
  | { status: 'unavailable'; voice: null }

function normalizeLanguageTag(language: string): string {
  return language.trim().replaceAll('_', '-').toLowerCase()
}

export function selectLocalSpeechVoice<T extends LocalSpeechVoice>(
  voices: readonly T[],
  requestedLanguage: string,
): LocalSpeechDecision<T> {
  const requestedTag = normalizeLanguageTag(requestedLanguage)
  if (!requestedTag) return { status: 'unavailable', voice: null }
  if (voices.length === 0) return { status: 'loading', voice: null }

  const localVoices = voices.filter((voice) => voice.localService === true)
  const exactMatch = localVoices.find(
    (voice) => normalizeLanguageTag(voice.lang) === requestedTag,
  )
  if (exactMatch) return { status: 'ready', voice: exactMatch }

  const primaryLanguage = requestedTag.split('-', 1)[0]
  const primaryLanguageVoices = localVoices.filter(
    (voice) => normalizeLanguageTag(voice.lang).split('-', 1)[0] === primaryLanguage,
  )
  const wantsTraditionalChinese = primaryLanguage === 'zh'
    && /(?:^|-)(?:tw|hant|hk|mo)(?:-|$)/.test(requestedTag)
  const primaryLanguageMatch = wantsTraditionalChinese
    ? primaryLanguageVoices.find((voice) => (
        /(?:^|-)(?:tw|hant|hk|mo)(?:-|$)/.test(normalizeLanguageTag(voice.lang))
      )) ?? primaryLanguageVoices[0]
    : primaryLanguageVoices[0]
  if (primaryLanguageMatch) return { status: 'ready', voice: primaryLanguageMatch }

  return { status: 'unavailable', voice: null }
}

export function waitForLocalSpeechVoice<T extends LocalSpeechVoice>(
  source: LocalSpeechSource<T>,
  requestedLanguage: string,
  { timeoutMs = 1_500, signal }: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<LocalSpeechDecision<T>> {
  const initial = selectLocalSpeechVoice(source.getVoices(), requestedLanguage)
  if (initial.status !== 'loading') return Promise.resolve(initial)
  if (signal?.aborted) return Promise.resolve({ status: 'unavailable', voice: null })

  return new Promise((resolve) => {
    let settled = false
    const finish = (decision: LocalSpeechDecision<T>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      source.removeEventListener('voiceschanged', handleVoicesChanged)
      signal?.removeEventListener('abort', handleAbort)
      resolve(decision)
    }
    const handleVoicesChanged = () => {
      const decision = selectLocalSpeechVoice(source.getVoices(), requestedLanguage)
      if (decision.status !== 'loading') finish(decision)
    }
    const handleAbort = () => finish({ status: 'unavailable', voice: null })
    const timer = setTimeout(
      () => finish({ status: 'unavailable', voice: null }),
      Math.max(0, Math.min(5_000, Number(timeoutMs) || 0)),
    )
    source.addEventListener('voiceschanged', handleVoicesChanged)
    signal?.addEventListener('abort', handleAbort, { once: true })
    // Close the gap between the initial read and listener registration.
    handleVoicesChanged()
  })
}
