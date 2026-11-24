export interface Card {
  name: string | null
  company: string | null
  company_domain: string | null
  role: string | null
  checked_title: string | null
  company_fit: 'yes' | 'no' | 'unknown'
  buyer: string | null
  fit: 'strong' | 'maybe' | 'weak' | 'unknown'
  score: number | null
  why: string
  opener: string
}

export interface Verification {
  company: { name: string | null; domain: string; employees: number | null; industry: string | null; matched_by: 'domain' | 'name' } | null
  person: { name: string; title: string | null; match: 'exact' | 'close'; profile_url: string | null } | null
  contact: { name: string; title: string | null; buyer: string } | null
}

export interface LookupResult {
  card: Card
  transcript: string
  timings: { audio_s: number; stt_ms: number; score_ms: number; server_ms: number }
}

export interface VerifyResult {
  card: Card
  verification: Verification | null // null when the backend has no Treg key
  timings: { lookup_ms?: number; rescore_ms?: number; server_ms: number }
}

// The role check: 'pending' while it runs, then its result, or 'off' when
// it isn't available or failed (the card is shown without that line).
export type Check = 'pending' | 'off' | Verification

// Same host as the dev server by default, so it works from the simulator
// (localhost) and from a phone on the LAN (the QR code's IP).
export const BACKEND_URL: string =
  import.meta.env.VITE_BACKEND_URL ?? `${location.protocol}//${location.hostname}:8787`

export async function lookup(pcm: Uint8Array<ArrayBuffer>): Promise<LookupResult> {
  const res = await fetch(`${BACKEND_URL}/lookup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: pcm,
    signal: AbortSignal.timeout(12000), // the wearer is waiting on "Checking fit..."
  })
  if (!res.ok) throw new Error(`backend ${res.status}: ${await res.text()}`)
  return res.json()
}

export async function verify(transcript: string, card: Card): Promise<VerifyResult> {
  const res = await fetch(`${BACKEND_URL}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript, card }),
    signal: AbortSignal.timeout(10000), // on failure the card just drops "Checking role..."
  })
  if (!res.ok) throw new Error(`backend ${res.status}: ${await res.text()}`)
  return res.json()
}

export interface SaveResult {
  notion: 'saved' | 'failed' | 'off'
  notionError: string | null
  drafted: boolean
}

export async function saveLead(card: Card, verification: Verification | null, transcript: string): Promise<SaveResult> {
  const res = await fetch(`${BACKEND_URL}/leads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ card, verification, transcript }),
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`backend ${res.status}: ${await res.text()}`)
  return res.json()
}

// Shortens to max characters at a word boundary, so nothing ends mid-word.
function clip(s: string, max: number) {
  if (s.length <= max) return s
  const cut = s.slice(0, max - 3)
  const space = cut.lastIndexOf(' ')
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}...`
}

// Formats the card for the 576x288 display, most important first:
//   who / verdict / what to say / role check / why
// The role-check line sits below what to say, so when it fills in, the
// lines the wearer is reading don't move.
export function cardText(card: Card, check: Check): string {
  const who = [card.name ?? 'Unknown', card.company].filter(Boolean).join(', ')
  const verdict =
    card.fit === 'unknown' || card.score === null
      ? 'NOT SURE'
      : `${card.fit.toUpperCase()} ${card.score}/10${card.buyer ? ` - Buyer: ${card.buyer}` : ''}`
  const lines = [clip(who, 48), clip(verdict, 48), clip(card.opener, 60)]
  if (check === 'pending') lines.push('Checking role...')
  else if (check !== 'off') {
    if (check.contact) lines.push(clip(`Buyer there: ${check.contact.name} (${check.contact.buyer})`, 48))
    else if (check.person && card.checked_title) lines.push(clip(`Verified: ${card.checked_title}`, 48))
    else if (card.buyer && check.company) lines.push('Role not verified') // only matters if they claim a buyer role
    else lines.push('') // keep the line, so "why" doesn't jump up when "Checking role..." goes
  }
  lines.push(clip(card.why, 48))
  return lines.join('\n')
}
