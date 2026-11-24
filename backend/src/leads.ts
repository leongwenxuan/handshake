import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { chatJSON } from './openai.ts'
import type { Profile } from './profile.ts'
import type { Card } from './score.ts'
import type { Verification } from './verify.ts'

// Leads saved from the glasses. Kept in backend/data/leads.jsonl (one JSON
// object per line, git-ignored) for the end-of-night recap, and copied to
// Notion when a token is set.

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
}

const DATA_DIR = new URL('../data/', import.meta.url)
const LEADS_FILE = new URL('leads.jsonl', DATA_DIR)

export function appendLead(lead: Lead) {
  mkdirSync(DATA_DIR, { recursive: true })
  appendFileSync(LEADS_FILE, `${JSON.stringify(lead)}\n`)
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

export function draftFollowUp(apiKey: string, lead: Pick<Lead, 'card' | 'verification' | 'transcript'>, profile: Profile | null) {
  const { card, verification: v } = lead
  const facts = [
    `Name: ${card.name ?? 'unknown'}`,
    `Company: ${v?.company?.name ?? card.company ?? 'unknown'}`,
    `Role (as they said it): ${card.role ?? 'unknown'}`,
    card.checked_title ? `Checked job title: ${card.checked_title}` : null,
    `Fit verdict: ${card.fit}${card.buyer ? `, matches buyer role "${card.buyer}"` : ''} (${card.why})`,
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
- If a better person to reach is named below, ask for a short intro to that person by name. If none is named, never ask for an intro.
- If the fit verdict is weak, write a friendly keep-in-touch note with no sales ask.
- Otherwise end with one clear, low-effort ask, such as a 20-minute call next week.
- Start with "Hi <first name>," and end with "Best," on its own line and nothing after it (the sender adds their name).`,
    user: `${seller}\n\nThe person:\n${facts.join('\n')}`,
    schemaName: 'follow_up',
    schema: FOLLOW_UP_SCHEMA,
  })
}
