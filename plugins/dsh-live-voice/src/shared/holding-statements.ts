export const HOLDING_STATEMENT_LIBRARY = {
  LOOKUP: [
    'Let me check that carefully.',
    'Let me take a closer look.',
    'One moment while I check that.',
    'Let me look into that carefully.',
  ],
  ACTION: [
    'Let me work through that carefully.',
    'Give me a moment with that.',
    'Let me take that step by step.',
    'One moment while I work through that.',
  ],
  REVIEW: [
    'Let me review that carefully.',
    'Let me take a closer look.',
    'One moment while I review that.',
    'Let me check those details carefully.',
  ],
  COMPARE: [
    'Let me compare those options carefully.',
    'Let me weigh those details carefully.',
    'One moment while I compare those.',
    'Let me think through those options.',
  ],
  THINK: [
    'Let me think that through carefully.',
    'Give me a moment to consider that.',
    'Let me work through those details.',
    'One moment while I consider the options.',
  ],
} as const

export type HoldingStatementCategory = keyof typeof HOLDING_STATEMENT_LIBRARY

export type HoldingStatementDecision =
  | { readonly speak: false; readonly category?: never; readonly text?: never }
  | { readonly speak: true; readonly category: HoldingStatementCategory; readonly text: string }

type HoldingStatementRule = {
  readonly category: HoldingStatementCategory
  readonly patterns: readonly RegExp[]
}

// Keyword routing is intentionally retained only for the zero-latency canned
// fallback. The normal path asks the local contextual provider instead.
const HOLDING_STATEMENT_RULES: readonly HoldingStatementRule[] = [
  {
    category: 'LOOKUP',
    patterns: [
      /\blook up\b/, /\bsearch\b/, /\bresearch\b/, /\bfind out\b/, /\blatest\b/,
      /\bcurrent\b/, /\bweather\b/, /\bnews\b/,
    ],
  },
  {
    category: 'ACTION',
    patterns: [
      /\bfix\b/, /\bbuild\b/, /\bcreate\b/, /\badd\b/, /\bwrite\b/, /\bedit\b/,
      /\bupdate\b/, /\bchange\b/, /\bimplement\b/, /\binstall\b/, /\brun\b/,
      /\bdownload\b/, /\bremove\b/, /\bdelete\b/, /\bopen\b/,
    ],
  },
  {
    category: 'REVIEW',
    patterns: [
      /\breview\b/, /\bcheck\b/, /\bread\b/, /\binspect\b/, /\baudit\b/,
      /\bsummar(?:ize|ise)\b/,
    ],
  },
  {
    category: 'COMPARE',
    patterns: [
      /\bcompare\b/, /\bdifference(?:s)?\b/, /\bversus\b/, /\bvs\b/,
      /\bside by side\b/, /\btrade[- ]?off(?:s)?\b/, /\bweigh\b/,
    ],
  },
  {
    category: 'THINK',
    patterns: [
      /\bplan\b/, /\bstrategy\b/, /\bdesign\b/, /\binvestigat(?:e|ion)\b/,
      /\bfigure out\b/, /\breason through\b/, /\bwork through\b/,
    ],
  },
]

export function selectHoldingStatement(transcript: string): HoldingStatementDecision {
  const normalized = transcript
    .toLowerCase()
    .replace(/[^a-z0-9'’\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) return { speak: false }
  const rule = HOLDING_STATEMENT_RULES.find((candidate) => candidate.patterns.some((pattern) => pattern.test(normalized)))
  if (!rule) return { speak: false }
  const phrases = HOLDING_STATEMENT_LIBRARY[rule.category]
  return {
    speak: true,
    category: rule.category,
    text: phrases[Math.floor(Math.random() * phrases.length)]!,
  }
}
