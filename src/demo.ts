import type { TranslationResult } from './types'

export const DEMO_SOURCE = "It's not really my cup of tea, but I can see why people love it."

export const DEMO_RESULT: TranslationResult = {
  detectedLanguage: 'en',
  targetLanguage: 'zh',
  translation: '這不太合我的胃口，但我能理解大家為什麼喜歡。',
  literalMeaning: '它不是我的那杯茶，但我看得出人們為什麼喜愛它。',
  naturalnessNote:
    '「not my cup of tea」不是在談飲料，而是委婉表示「不合喜好」。譯成「不太合我的胃口」保留了輕鬆、不批判的語氣。',
  pronunciation: {
    text: 'not really my cup of tea',
    ipa: '/nɑt ˈrɪəli maɪ kʌp əv tiː/',
  },
  alternatives: [
    { text: '這不是我的菜，不過我懂它為什麼這麼受歡迎。', label: '口語自然' },
    { text: '我個人沒有特別喜歡，但確實能理解它的魅力。', label: '溫和正式' },
    { text: '雖然不對我的味，但我看得出大家喜歡它的理由。', label: '保留原味' },
  ],
  examples: [
    {
      source: "Horror movies aren't my cup of tea.",
      target: '恐怖片不是我的菜。',
      note: '直接談個人喜好，不帶批評。',
    },
    {
      source: "Camping isn't really her cup of tea, but she gave it a try.",
      target: '露營不太合她的胃口，不過她還是試了一次。',
      note: 'really 讓否定更委婉。',
    },
    {
      source: "Jazz may not be your cup of tea, and that's okay.",
      target: '爵士樂也許不是你的菜，這很正常。',
      note: '用於尊重彼此不同的偏好。',
    },
  ],
  usageTips: [
    '適合日常對話；正式文件可改用 not to my taste 或 not my preference。',
    '談別人的偏好時保持委婉：It may not be their cup of tea.',
  ],
  keywords: [
    { term: 'my cup of tea', meaning: '我喜歡或擅長的事物' },
    { term: 'I can see why', meaning: '我能理解為什麼' },
  ],
}

export const ZH_DEMO_RESULT: TranslationResult = {
  detectedLanguage: 'zh',
  targetLanguage: 'en',
  translation: "I didn't mean to put you on the spot.",
  literalMeaning: '我不是故意要讓你站在那個位置上。',
  naturalnessNote: '「讓你為難」在這個語境中是突然施加壓力，因此用 put you on the spot 最自然。',
  pronunciation: {
    text: 'put you on the spot',
    ipa: '/pʊt ju ɑn ðə spɑt/',
  },
  alternatives: [
    { text: "I didn't mean to make things awkward for you.", label: '比較溫和' },
    { text: "Sorry, I didn't mean to pressure you.", label: '直接道歉' },
  ],
  examples: [
    {
      source: 'I hope I didn’t put you on the spot during the meeting.',
      target: '希望我剛才在會議上沒有讓你為難。',
      note: '會議場合的委婉說法。',
    },
    {
      source: 'She put me on the spot by asking for an answer right away.',
      target: '她要我立刻回答，讓我很為難。',
      note: '描述被迫當場回應。',
    },
    {
      source: "Don't put him on the spot—give him time to think.",
      target: '別逼他當場表態，給他時間想想。',
      note: '依語境翻成「逼人表態」。',
    },
  ],
  usageTips: ['put someone on the spot 常指要求對方立刻回答、決定或表態。'],
  keywords: [{ term: 'on the spot', meaning: '處於必須立即反應的壓力下' }],
}
