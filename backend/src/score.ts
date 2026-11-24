// The card the glasses show. Kept small: it has to fit 576x288 monochrome.
export interface Card {
  name: string | null
  company: string | null
  company_domain: string | null // only when the model is confident which company it is
  role: string | null
  checked_title: string | null // database title, when consistent with what they said
  relation: 'prospect' | 'colleague' | 'competitor' // competitor is set by the server from the profile's list
  competitor?: string | null // which listed competitor the model matched
  company_fit: 'yes' | 'no' | 'unknown'
  buyer: string | null // which buyer role from the profile they match
  fit: 'strong' | 'maybe' | 'weak' | 'unknown'
  score: number | null // 0-10, null when we can't judge
  why: string
  opener: string
}

// What to do with this person, from the two things the scorer judges.
// Same rule as the app's action() in src/api.ts.
export type Action = 'pitch' | 'intro' | 'unsure' | 'pass' | 'competitor' | 'colleague'

export function action(card: Card): Action {
  if (card.relation === 'competitor') return 'competitor'
  if (card.relation === 'colleague') return 'colleague'
  if (card.company_fit === 'no') return 'pass'
  if (card.company_fit === 'yes') return card.buyer ? 'pitch' : 'intro'
  return card.buyer || card.fit !== 'weak' ? 'unsure' : 'pass'
}

export const ACTION_LABEL: Record<Action, string> = {
  pitch: 'Pitch them',
  intro: 'Get an intro',
  unsure: 'Not sure yet',
  pass: 'Not a fit',
  competitor: 'Competitor',
  colleague: 'Colleague',
}

export interface Scorer {
  name: string
  // facts: checked information from the role lookup, used for a second pass
  score(transcript: string, facts?: string): Promise<Card>
}

// Placeholder until an OpenAI key is set. Pulls name/company/role out with
// simple patterns and returns a canned verdict, so the rest of the flow
// (audio, STT, card, save) can be built and timed for real.
export function mockScorer(): Scorer {
  return {
    name: 'mock (no OpenAI key)',
    async score(transcript) {
      const t = transcript.replace(/[.,!?]/g, ' ')
      const name = match(t, /\b(?:I'm|I am|my name is|this is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/)
      const company = match(t, /\b(?:at|from|with)\s+([A-Z][A-Za-z0-9&]+(?:\s+[A-Z][A-Za-z0-9&]+)?)/)
      const role = match(t, /\b(?:I run|I lead|I head|I'm the|I am the|I work in|I do)\s+([a-z][a-z ]{2,30}?)(?=\s+(?:at|for|from|with)\b|$)/i)
      const unchecked = { company_domain: null, checked_title: null, relation: 'prospect', competitor: null, company_fit: 'unknown', buyer: null } as const
      if (!name && !company) {
        return {
          ...unchecked, name: null, company: null, role: null, fit: 'unknown', score: null,
          why: 'Did not catch a name or company',
          opener: 'Ask: "Sorry, what was your name?"',
        }
      }
      return {
        ...unchecked, name, company, role,
        fit: company ? 'maybe' : 'unknown',
        score: company ? 5 : null,
        why: 'MOCK: no OpenAI key yet',
        opener: company ? `Ask: "What does ${company} focus on?"` : 'Ask: "Where are you working?"',
      }
    },
  }
}

function match(text: string, re: RegExp): string | null {
  return re.exec(text)?.[1]?.trim() ?? null
}
