import type { HistoryEntry, TranslationResult } from './types'

export const HISTORY_KEY = 'lingomuse:history'
const MAX_HISTORY_ENTRIES = 50
const MAX_HISTORY_JSON_CHARS = 1_500_000

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

export function isTranslationResult(value: unknown): value is TranslationResult {
  if (!value || typeof value !== 'object') return false
  const result = value as Partial<TranslationResult>
  return (result.detectedLanguage === 'zh' || result.detectedLanguage === 'en')
    && (result.targetLanguage === 'zh' || result.targetLanguage === 'en')
    && isString(result.translation)
    && isString(result.literalMeaning)
    && isString(result.naturalnessNote)
    && Boolean(result.pronunciation)
    && isString(result.pronunciation?.text)
    && isString(result.pronunciation?.ipa)
    && Array.isArray(result.alternatives)
    && result.alternatives.every((item) => isString(item?.text) && isString(item?.label))
    && Array.isArray(result.examples)
    && result.examples.every((item) => isString(item?.source) && isString(item?.target) && isString(item?.note))
    && Array.isArray(result.usageTips)
    && result.usageTips.every(isString)
    && Array.isArray(result.keywords)
    && result.keywords.every((item) => isString(item?.term) && isString(item?.meaning))
}

export function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<HistoryEntry>
  return isString(entry.id)
    && isString(entry.source)
    && entry.source.length <= 12_000
    && Number.isFinite(entry.createdAt)
    && isTranslationResult(entry.result)
}

export function readHistory(storage: Pick<Storage, 'getItem'>): HistoryEntry[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(HISTORY_KEY) || '[]')
    return Array.isArray(parsed)
      ? parsed.filter(isHistoryEntry).slice(0, MAX_HISTORY_ENTRIES)
      : []
  } catch {
    return []
  }
}

export function upsertHistory(
  history: HistoryEntry[],
  entry: HistoryEntry,
): HistoryEntry[] {
  return [entry, ...history.filter((item) => item.source !== entry.source)]
    .filter(isHistoryEntry)
    .slice(0, MAX_HISTORY_ENTRIES)
}

export function writeHistory(
  storage: Pick<Storage, 'setItem'>,
  history: HistoryEntry[],
): boolean {
  const validHistory = history.filter(isHistoryEntry).slice(0, MAX_HISTORY_ENTRIES)
  const fitted: HistoryEntry[] = []

  for (const entry of validHistory) {
    const candidate = [...fitted, entry]
    if (JSON.stringify(candidate).length > MAX_HISTORY_JSON_CHARS) break
    fitted.push(entry)
  }

  for (let length = fitted.length; length >= 0; length = Math.floor(length / 2)) {
    try {
      storage.setItem(HISTORY_KEY, JSON.stringify(fitted.slice(0, length)))
      return true
    } catch {
      if (length === 0) break
    }
  }
  return false
}
