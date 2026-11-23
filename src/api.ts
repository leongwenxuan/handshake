export interface Card {
  name: string | null
  company: string | null
  role: string | null
  fit: 'strong' | 'maybe' | 'weak' | 'unknown'
  score: number | null
  why: string
  opener: string
}

export interface LookupResult {
  card: Card
  transcript: string
  timings: { audio_s: number; stt_ms: number; score_ms: number; server_ms: number }
}

// Same host as the dev server by default, so it works from the simulator
// (localhost) and from a phone on the LAN (the QR code's IP).
const BACKEND_URL: string =
  import.meta.env.VITE_BACKEND_URL ?? `${location.protocol}//${location.hostname}:8787`

export async function lookup(pcm: Uint8Array<ArrayBuffer>): Promise<LookupResult> {
  const res = await fetch(`${BACKEND_URL}/lookup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: pcm,
  })
  if (!res.ok) throw new Error(`backend ${res.status}: ${await res.text()}`)
  return res.json()
}

// Formats the card for the 576x288 display: short lines, most important first.
export function cardText(card: Card): string {
  const who = [card.name ?? 'Unknown', card.company].filter(Boolean).join(', ')
  const verdict =
    card.fit === 'unknown' || card.score === null
      ? 'NOT SURE'
      : `${card.fit.toUpperCase()} FIT ${card.score}/10`
  return [who, verdict, card.why, card.opener].join('\n')
}
