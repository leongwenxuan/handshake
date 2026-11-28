import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { chatJSON } from './openai.ts'
import type { Profile } from './profile.ts'
import { action, type Card } from './score.ts'
import type { Verification } from './verify.ts'

// Leads saved from the glasses. Kept in backend/data/leads.jsonl (one JSON
// object per line, git-ignored) for the end-of-night recap, and copied to
// the CRM (HubSpot or Notion) when a token is set.

export interface FollowUp {
  subject: string
  body: string
}

export interface Lead {
  id: string
  card: Card
  verification: Verification | null
  transcript: string
  savedAt: string
  followUp: FollowUp | null
  notion: { id: string; url: string } | null
  hubspot?: { id: string; url: string | null } | null // contact id, when HubSpot is the CRM
  meetings?: number // times saved; missing means 1
  firstMet?: string
  saves?: string[] // the glasses' id for each save, so a resent one isn't counted twice
}

const norm = (s: string | null | undefined) =>
  (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

// An earlier save of the same person: same name at the same company, or
// same full name when neither save caught a company.
export function findSame(leads: Lead[], lead: Pick<Lead, 'card' | 'verification'>): Lead | null {
  const name = norm(lead.card.name)
  if (!name || !name.includes(' ')) return null // a first name alone is too ambiguous
  const company = (l: Pick<Lead, 'card' | 'verification'>) => norm(l.verification?.company?.domain ?? l.card.company_domain ?? l.card.company)
  const at = company(lead)
  return leads.find(l => norm(l.card.name) === name && company(l) === at) ?? null
}

const DATA_DIR = new URL('../data/', import.meta.url)
const LEADS_FILE = new URL('leads.jsonl', DATA_DIR)

export function appendLead(lead: Lead) {
  mkdirSync(DATA_DIR, { recursive: true })
  appendFileSync(LEADS_FILE, `${JSON.stringify(lead)}\n`)
}

// Deletes every line of a lead (the file only ever appends otherwise).
export function removeLead(id: string) {
  if (!existsSync(LEADS_FILE)) return
  const keep = readFileSync(LEADS_FILE, 'utf8')
    .split('\n')
    .filter(line => {
      if (!line.trim()) return false
      try {
        return (JSON.parse(line) as Lead).id !== id
      } catch {
        return false
      }
    })
  writeFileSync(LEADS_FILE, keep.length ? `${keep.join('\n')}\n` : '')
}

// Later lines win, so a lead updated after its Notion save replaces itself.
export function readLeads(): Lead[] {
  if (!existsSync(LEADS_FILE)) return []
  const byId = new Map<string, Lead>()
  for (const line of readFileSync(LEADS_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const lead = JSON.parse(line) as Lead
      byId.set(lead.id, lead)
    } catch {
      // skip a torn line
    }
  }
  return [...byId.values()]
}

const FOLLOW_UP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['subject', 'body'],
  properties: {
    subject: { type: 'string', description: 'Short, specific subject line, at most 60 characters' },
    body: { type: 'string', description: 'The email body, plain text, paragraphs separated by a blank line' },
  },
}

// The verdict in words for the email writer.
const VERDICT: Record<ReturnType<typeof action>, (card: Card) => string> = {
  pitch: card => `Pitch them: their company fits and they match the buyer role "${card.buyer}"`,
  intro: () => "Get an intro: their company fits, but they aren't the buyer",
  unsure: () => 'Not sure yet: too little was said to tell if their company fits',
  pass: () => 'Not a fit for what the sender sells',
  competitor: () => 'Competitor',
  colleague: () => 'Colleague',
}

export function draftFollowUp(apiKey: string, lead: Pick<Lead, 'card' | 'verification' | 'transcript'>, profile: Profile | null) {
  const { card, verification: v } = lead
  const facts = [
    `Name: ${card.name ?? 'unknown'}`,
    `Company: ${v?.company?.name ?? card.company ?? 'unknown'}`,
    `Role (as they said it): ${card.role ?? 'unknown'}`,
    card.checked_title ? `Checked job title: ${card.checked_title}` : null,
    card.relation === 'competitor' ? 'They work at a competitor.' : card.relation === 'colleague' ? "They work at the sender's own company." : null,
    `Verdict: ${VERDICT[action(card)](card)} (${card.why})`,
    v?.contact ? `Better person to reach at their company: ${v.contact.name}, ${v.contact.title ?? v.contact.buyer}` : null,
    `What they said when we met: "${lead.transcript}"`,
  ].filter(Boolean)
  const seller = profile
    ? `The sender works at ${profile.company}: ${profile.one_liner}. Problem it solves: ${profile.problem}`
    : 'The sender’s company is not known; keep the pitch generic.'
  return chatJSON<FollowUp>(apiKey, {
    system: `You write a short follow-up email from someone who just met this person at an in-person event.
Rules:
- 60 to 110 words. Warm, plain and specific; no hype, no buzzwords, no exclamation marks.
- Open with one natural line that it was good to meet them, recalling something they said in your own words (never quote them back, never invent details).
- One sentence on why the sender's product may matter to them, tied to their role and company.
- If a better person to reach is named below, end by asking for a short intro to that person by name.
- Never name anyone else. If the verdict is "Get an intro" and no one is named, end by asking who on their team looks after this.
- If the verdict is "Not a fit", or they work at a competitor or the sender's own company, write a friendly keep-in-touch note with no sales ask.
- Otherwise end with one clear, low-effort ask, such as a 20-minute call next week.
- Start with "Hi <first name>," and end with "Best," on its own line and nothing after it (the sender adds their name).`,
    user: `${seller}\n\nThe person:\n${facts.join('\n')}`,
    schemaName: 'follow_up',
    schema: FOLLOW_UP_SCHEMA,
  })
}
