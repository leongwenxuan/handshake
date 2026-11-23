// The card the glasses show. Kept small: it has to fit 576x288 monochrome.
export interface Card {
  name: string | null
  company: string | null
  role: string | null
  fit: 'strong' | 'maybe' | 'weak' | 'unknown'
  score: number | null // 0-10, null when we can't judge
  why: string
  opener: string
}

export interface Scorer {
  name: string
  score(transcript: string): Promise<Card>
}

// Placeholder until a Claude key is set. Pulls name/company/role out with
// simple patterns and returns a canned verdict, so the rest of the flow
// (audio, STT, card, save) can be built and timed for real.
export function mockScorer(): Scorer {
  return {
    name: 'mock (no Claude key)',
    async score(transcript) {
      const t = transcript.replace(/[.,!?]/g, ' ')
      const name = match(t, /\b(?:I'm|I am|my name is|this is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/)
      const company = match(t, /\b(?:at|from|with)\s+([A-Z][A-Za-z0-9&]+(?:\s+[A-Z][A-Za-z0-9&]+)?)/)
      const role = match(t, /\b(?:I run|I lead|I head|I'm the|I am the|I work in|I do)\s+([a-z][a-z ]{2,30}?)(?=\s+(?:at|for|from|with)\b|$)/i)
      if (!name && !company) {
        return {
          name: null, company: null, role: null, fit: 'unknown', score: null,
          why: 'Did not catch a name or company',
          opener: 'Ask: "Sorry, what was your name?"',
        }
      }
      return {
        name, company, role,
        fit: company ? 'maybe' : 'unknown',
        score: company ? 5 : null,
        why: 'MOCK: no Claude key yet',
        opener: company ? `Ask: "What does ${company} focus on?"` : 'Ask: "Where are you working?"',
      }
    },
  }
}

function match(text: string, re: RegExp): string | null {
  return re.exec(text)?.[1]?.trim() ?? null
}
