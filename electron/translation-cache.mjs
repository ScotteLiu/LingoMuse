export function createTranslationCache(maxEntries = 24) {
  const capacity = Math.max(1, Math.round(Number(maxEntries) || 24))
  const entries = new Map()

  return {
    get(key) {
      if (!entries.has(key)) return undefined
      const value = entries.get(key)
      entries.delete(key)
      entries.set(key, value)
      return value
    },
    set(key, value) {
      entries.delete(key)
      entries.set(key, value)
      while (entries.size > capacity) {
        entries.delete(entries.keys().next().value)
      }
    },
    clear() {
      entries.clear()
    },
    get size() {
      return entries.size
    },
  }
}
