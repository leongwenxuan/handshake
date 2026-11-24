export interface Card {
  name: string | null
  company: string | null
  company_domain: string | null
  role: string | null
  checked_title: string | null
  relation?: 'prospect' | 'colleague' | 'competitor'
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
  contact: Contact | null
  contacts?: Contact[] // every buyer found there, most senior first
}

export interface Contact {
  name: string
  title: string | null
  buyer: string
}

// Switches who to ask for, and the name in what to say.
export function withContact(card: Card, check: Verification, next: Contact): { card: Card; check: Verification } {
  const first = (n: string) => n.split(/\s+/)[0]
  const old = check.contact
  const opener =
    old && card.opener.includes(first(old.name))
      ? card.opener.replace(old.name, next.name).replaceAll(first(old.name), first(next.name))
      : `Ask: Could you intro me to ${first(next.name)}?`
  return { card: { ...card, opener }, check: { ...check, contact: next } }
}

export interface LookupResult {
  card: Card
  transcript: string
  timings: { audio_s: number; stt_ms: number; score_ms: number; server_ms: number }
  only_wearer?: boolean // only the wearer's own introduction was heard
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
  again: boolean // met before: the existing lead was updated
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

// The card's text for the glasses, in three blocks (see glasses.ts):
//   header: who / verdict / role check   ask: what to say   why: the reason
// The role check fills in inside the header, so what to say never moves.
export function cardParts(card: Card, check: Check): { header: string; ask: string; why: string } {
  const who = [card.name ?? 'Unknown', card.company].filter(Boolean).join(', ')
  const verdict =
    card.relation === 'competitor'
      ? 'COMPETITOR - no pitch'
      : card.relation === 'colleague'
        ? 'COLLEAGUE'
        : card.fit === 'unknown' || card.score === null
          ? 'NOT SURE'
          : `${card.fit.toUpperCase()} ${card.score}/10${card.buyer ? ` - Buyer: ${card.buyer}` : ''}`
  const header = [clip(who, 44), clip(verdict, 44)]
  if (check === 'pending') header.push('Checking role...')
  else if (check !== 'off') {
    if (check.contact) {
      // "2/3" when the wearer can switch to another buyer found there.
      const all = check.contacts ?? []
      const count = all.length > 1 ? ` ${all.findIndex(c => c.name === check.contact!.name) + 1}/${all.length}` : ''
      // Their own title tells the buyers apart; the buyer role if it won't fit.
      const c = check.contact
      const titled = c.title ? `Buyer there: ${c.name} (${c.title})` : ''
      header.push(titled && titled.length <= 44 - count.length ? titled + count : clip(`Buyer there: ${c.name} (${c.buyer})`, 44 - count.length) + count)
    }
    else if (check.person && card.checked_title) header.push(clip(`Verified: ${card.checked_title}`, 44))
    else if (card.buyer && check.company) header.push('Role not verified') // only matters if they claim a buyer role
  }
  return { header: header.join('\n'), ask: clip(card.opener, 60), why: clip(card.why, 52) }
}
