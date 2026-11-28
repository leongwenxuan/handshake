import { existsSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { whisperLocal } from './stt.ts'
import { action, mockScorer, plainWhy } from './score.ts'
import { openaiScorer, openaiTranscriber } from './openai.ts'
import { buildProfile, loadProfile, profileText, saveProfile, toDomain, type Profile } from './profile.ts'
import { treg as makeTreg } from './treg.ts'
import { factsText, similarity, verify } from './verify.ts'
import type { Card } from './score.ts'
import { appendLead, draftFollowUp, findSame, readLeads, removeLead, type Lead } from './leads.ts'
import { notion as makeNotion } from './notion.ts'
import { hubspot as makeHubSpot } from './hubspot.ts'
import type { Verification } from './verify.ts'

// POST /lookup with raw PCM (s16le, 16 kHz, mono) as the body.
// Returns the card, the transcript and how long each step took.
// POST /verify {transcript, card}: checks the person's work role through
// Treg and rescores with what it found (second, slower pass).
// GET /profile, POST /profile {company, note?}: the wearer's company profile
// (ideal customers and buyer roles) that every card is judged against.
// POST /leads {card, verification, transcript}: saves a lead, drafts a
// follow-up email and adds both to the CRM: HubSpot when HUBSPOT_TOKEN is
// set, otherwise Notion. GET /leads lists saved leads.
// Audio is only held in memory for the request and never written to disk.

const PORT = Number(process.env.PORT ?? 8787)
const MAX_BYTES = 16000 * 2 * 15 // 15 s of audio

const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim()
const TREG_API_KEY = process.env.TREG_API_KEY?.trim()
const NOTION_TOKEN = process.env.NOTION_TOKEN?.trim()
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN?.trim()

let profile: Profile | null = loadProfile()
const treg = TREG_API_KEY ? makeTreg(TREG_API_KEY) : null
// One CRM gets the leads: HubSpot if it's set up, otherwise Notion.
const hubspot = HUBSPOT_TOKEN ? makeHubSpot(HUBSPOT_TOKEN) : null
const notion = !hubspot && NOTION_TOKEN ? makeNotion(NOTION_TOKEN) : null
// OpenAI transcription hears names far better than local Whisper base
// ("Patrick Collison" vs "Patrick Carlson"), which the role check depends on.
const transcriber = process.env.STT !== 'whisper' && OPENAI_API_KEY ? openaiTranscriber(OPENAI_API_KEY, () => (profile ? `The listener is ${profile.you ? `${profile.you} from ` : 'from '}${profile.company}.` : null)) : whisperLocal()
const baseScorer = OPENAI_API_KEY ? openaiScorer(OPENAI_API_KEY, () => profileText(profile)) : mockScorer()
// Competitors are matched here, by name or domain against the profile's
// list, not judged by the model: asked to, it called almost any company a
// competitor (Stripe, for a CRM), and that leaked into its verdict, reason
// and opener. A listed competitor gets no pitch, just a question about the
// market.
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
function listedCompetitor(card: Card): string | null {
  const heard = [card.company, card.company_domain, card.company_domain?.split('.')[0]].filter((s): s is string => !!s).map(key)
  return profile?.competitors?.find(c => heard.includes(key(c)) || heard.includes(key(c.split('.')[0]))) ?? null
}

const scorer = {
  name: baseScorer.name,
  async score(transcript: string, facts?: string): Promise<Card> {
    const card = await baseScorer.score(transcript, facts)
    const competitor = listedCompetitor(card)
    if (!competitor) {
      // A reason that still says "competitor" gets the plain one instead.
      const why = /\b(competitor|competing|competes|rival)/i.test(card.why) ? plainWhy(card) : card.why
      return { ...card, competitor: null, why }
    }
    return {
      ...card,
      competitor,
      relation: 'competitor',
      fit: 'unknown',
      score: null,
      buyer: null,
      why: `Works at ${competitor}, a competitor`.slice(0, 45),
      opener: 'Ask: What are buyers asking for lately?',
    }
  },
}

// "attio.com", "https://attio.com/" and "Attio" all name the current profile.
function sameCompany(p: Profile, input: string) {
  const d = toDomain(input)
  return d ? d === p.domain : input.trim().toLowerCase() === p.company.toLowerCase()
}

// The card is about the wearer: their first name, and their own company
// (or no company at all).
function isWearer(card: Card) {
  const you = profile?.you?.trim().toLowerCase().split(/\s+/)[0]
  const first = card.name?.trim().toLowerCase().split(/\s+/)[0]
  if (!you || first !== you) return false
  return card.relation === 'colleague' || !card.company || similarity(card.company, profile!.company) > 0.8
}

function cors(res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage, max = MAX_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > max) throw new Error('request too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

const server = createServer(async (req, res) => {
  cors(res)
  if (req.method === 'OPTIONS') return res.writeHead(204).end()

  if (req.method === 'GET' && req.url === '/health') {
    return json(res, 200, { ok: true, stt: transcriber.name, scorer: scorer.name, treg: !!treg, notion: !!notion, hubspot: !!hubspot, profile: profile?.company ?? null })
  }

  // Test recordings, for the app's ?fixture= dev mode.
  const fixture = req.method === 'GET' && /^\/fixtures\/([a-z0-9-]+)\.wav$/.exec(req.url ?? '')
  if (fixture) {
    const file = new URL(`../fixtures/${fixture[1]}.wav`, import.meta.url)
    if (!existsSync(file)) return json(res, 404, { error: 'no such fixture' })
    res.writeHead(200, { 'Content-Type': 'audio/wav' })
    return res.end(readFileSync(file))
  }

  if (req.method === 'GET' && req.url === '/profile') {
    return json(res, 200, { profile })
  }

  // Builds the profile, streaming progress as JSON lines ({step}, then
  // {profile} or {error}). With only: 'you', just your name changes.
  if (req.method === 'POST' && req.url === '/profile') {
    let streaming = false
    try {
      const body = JSON.parse((await readBody(req, 10_000)).toString() || '{}') as { company?: string; note?: string; you?: string; only?: 'you' }
      const company = body.company?.trim()
      const note = body.note?.trim() || null
      const you = body.you?.trim() || null
      if (!company) return json(res, 400, { error: 'Type your company name or website.' })
      if (body.only === 'you' && profile && sameCompany(profile, company)) {
        profile = { ...profile, you }
        saveProfile(profile)
        return json(res, 200, { profile })
      }
      if (!OPENAI_API_KEY) return json(res, 503, { error: 'Set OPENAI_API_KEY in backend/.env first.' })
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' })
      streaming = true
      const send = (o: object) => res.write(`${JSON.stringify(o)}\n`)
      const built = await buildProfile(company, note, { openaiKey: OPENAI_API_KEY, treg }, send)
      profile = { ...built, you }
      saveProfile(profile)
      send({ profile })
      return res.end()
    } catch (err) {
      console.error('profile failed:', err)
      if (streaming) return res.end(`${JSON.stringify({ error: (err as Error).message })}\n`)
      return json(res, 500, { error: (err as Error).message })
    }
  }

  if (req.method === 'POST' && req.url === '/lookup') {
    const t0 = performance.now()
    try {
      const pcm = await readBody(req)
      if (pcm.length < 3200) return json(res, 400, { error: 'no audio' })

      const t1 = performance.now()
      const transcript = await transcriber.transcribe(pcm)
      const t2 = performance.now()
      let card = await scorer.score(transcript)
      // Only the wearer was heard (they introduced themselves first and the
      // capture ended): that's not a lead.
      const you = profile?.you?.trim().split(/\s+/)[0]
      const onlyWearer =
        isWearer(card) || (!card.name && !card.company && !!you && new RegExp(`\\b${you.replace(/[^\p{L}]/gu, '')}\\b`, 'i').test(transcript))
      if (onlyWearer) card = { ...card, name: null, company: null, company_domain: null }
      const t3 = performance.now()

      const timings = {
        audio_s: +(pcm.length / 32000).toFixed(2),
        stt_ms: Math.round(t2 - t1),
        score_ms: Math.round(t3 - t2),
        server_ms: Math.round(t3 - t0),
      }
      console.log(`lookup ${JSON.stringify(timings)} "${transcript}"`)
      return json(res, 200, { card, transcript, timings, only_wearer: onlyWearer })
    } catch (err) {
      console.error('lookup failed:', err)
      return json(res, 500, { error: (err as Error).message })
    }
  }

  if (req.method === 'POST' && req.url === '/verify') {
    const t0 = performance.now()
    try {
      const { transcript, card } = JSON.parse((await readBody(req, 20_000)).toString() || '{}') as { transcript?: string; card?: Card }
      if (!card || typeof transcript !== 'string') return json(res, 400, { error: 'need transcript and card' })
      if (!treg || (card.relation && card.relation !== 'prospect')) return json(res, 200, { card, verification: null, timings: { server_ms: 0 } })

      const verification = await verify(card, profile, treg)
      const t1 = performance.now()
      const facts = factsText(verification, card)
      let updated = card
      if (facts) {
        updated = await scorer.score(transcript, facts)
        // Keep the database row only if the scorer found its title consistent
        // with what they said; otherwise it's probably someone else.
        if (verification.person && updated.checked_title) updated.name = verification.person.name
        else {
          verification.person = null
          updated.checked_title = null
        }
        // Only suggest asking for someone else if the final verdict says
        // this person isn't the buyer and their company could be.
        // The first card's opener never names anyone, so fall back to it.
        const named = !!verification.contact
        if (updated.buyer || updated.company_fit !== 'yes') {
          verification.contact = null
          verification.contacts = []
        }
        // The card updates in place while the wearer reads it: keep the lines
        // that didn't need to change so only the new facts move.
        const same = action(updated) === action(card)
        if (same) updated.why = card.why
        if (!verification.contact && (same || named)) updated.opener = card.opener
      }
      const t2 = performance.now()
      const timings = { lookup_ms: Math.round(t1 - t0), rescore_ms: Math.round(t2 - t1), server_ms: Math.round(t2 - t0) }
      console.log(`verify ${JSON.stringify(timings)} person=${verification.person?.name ?? '-'} contact=${verification.contact?.name ?? '-'}`)
      return json(res, 200, { card: updated, verification, timings })
    } catch (err) {
      console.error('verify failed:', err)
      return json(res, 500, { error: (err as Error).message })
    }
  }

  if (req.method === 'GET' && req.url === '/leads') {
    return json(res, 200, { leads: readLeads() })
  }

  if (req.method === 'POST' && req.url === '/leads') {
    const t0 = performance.now()
    try {
      const body = JSON.parse((await readBody(req, 20_000)).toString() || '{}') as {
        card?: Card
        verification?: Verification | null
        transcript?: string
        saveId?: string
      }
      if (!body.card || typeof body.transcript !== 'string') return json(res, 400, { error: 'need card and transcript' })
      const verification = body.verification ?? null
      // The glasses resend a save whose reply they never got; it may have
      // landed already.
      const saveId = typeof body.saveId === 'string' ? body.saveId : null
      const landed = saveId ? readLeads().find(l => l.saves?.includes(saveId)) : null
      if (landed) {
        return json(res, 200, { lead: landed, notion: notion ? (landed.notion ? 'saved' : 'failed') : 'off', notionError: null, hubspot: hubspot ? (landed.hubspot ? 'saved' : 'failed') : 'off', again: (landed.meetings ?? 1) > 1, drafted: !!landed.followUp, resent: true })
      }
      // Met before: update that lead (and its CRM record) instead of adding one.
      const before = findSame(readLeads(), { card: body.card, verification })
      const lead: Lead = {
        id: before?.id ?? crypto.randomUUID(),
        card: body.card,
        verification,
        transcript: body.transcript,
        savedAt: new Date().toISOString(),
        followUp: null,
        notion: before?.notion ?? null,
        hubspot: before?.hubspot ?? null,
        meetings: (before?.meetings ?? (before ? 1 : 0)) + 1,
        firstMet: before?.firstMet ?? before?.savedAt ?? undefined,
        saves: saveId ? [...(before?.saves ?? []), saveId] : before?.saves,
      }
      appendLead(lead) // kept even if the steps below fail
      if (OPENAI_API_KEY) {
        lead.followUp = await draftFollowUp(OPENAI_API_KEY, lead, profile).catch(err => {
          console.error('follow-up draft failed:', err)
          return null
        })
      }
      const t1 = performance.now()
      let notionError: string | null = null
      if (notion) {
        const existing = lead.notion
        lead.notion = await (existing ? notion.updateLead(existing.id, lead).then(() => existing) : notion.addLead(lead)).catch(err => {
          console.error('notion save failed:', err)
          notionError = (err as Error).message
          return existing
        })
      }
      let hubspotError: string | null = null
      if (hubspot) {
        const existing = lead.hubspot ?? null
        lead.hubspot = await (existing ? hubspot.updateLead(existing.id, lead).then(() => existing) : hubspot.addLead(lead)).catch(err => {
          console.error('hubspot save failed:', err)
          hubspotError = (err as Error).message
          return existing
        })
      }
      appendLead(lead)
      const t2 = performance.now()
      const timings = { draft_ms: Math.round(t1 - t0), crm_ms: Math.round(t2 - t1), server_ms: Math.round(t2 - t0) }
      console.log(`lead ${JSON.stringify(timings)} ${lead.card.name ?? '-'} notion=${lead.notion ? 'ok' : notion ? 'failed' : 'off'} hubspot=${lead.hubspot ? 'ok' : hubspot ? 'failed' : 'off'}`)
      return json(res, 200, { lead, notion: notion ? (notionError ? 'failed' : 'saved') : 'off', notionError, hubspot: hubspot ? (hubspotError ? 'failed' : 'saved') : 'off', hubspotError, again: !!before, drafted: !!lead.followUp, timings })
    } catch (err) {
      console.error('save lead failed:', err)
      return json(res, 500, { error: (err as Error).message })
    }
  }

  // POST /leads/contact {id, name}: ask for a different buyer at their company
  // (one of the people the role check found), or no one (name null). The
  // follow-up is redrafted and the CRM record updated.
  if (req.method === 'POST' && req.url === '/leads/contact') {
    try {
      const body = JSON.parse((await readBody(req, 5_000)).toString() || '{}') as { id?: string; name?: string | null }
      const lead = readLeads().find(l => l.id === body.id)
      if (!lead?.verification) return json(res, 404, { error: 'no such lead' })
      const pick = body.name ? lead.verification.contacts?.find(c => c.name === body.name) : null
      if (body.name && !pick) return json(res, 400, { error: 'not one of the buyers found' })
      lead.verification = { ...lead.verification, contact: pick ?? null }
      if (OPENAI_API_KEY) lead.followUp = await draftFollowUp(OPENAI_API_KEY, lead, profile).catch(() => lead.followUp)
      let crmError: string | null = null
      if (notion && lead.notion) await notion.switchContact(lead.notion.id, lead).catch(err => {
        console.error('notion update failed:', err)
        crmError = (err as Error).message
      })
      if (hubspot && lead.hubspot) await hubspot.switchContact(lead.hubspot.id, lead).catch(err => {
        console.error('hubspot update failed:', err)
        crmError = (err as Error).message
      })
      appendLead(lead)
      console.log(`lead ${lead.card.name ?? '-'}: ask for ${pick?.name ?? 'no one'}`)
      return json(res, 200, { lead, crmError })
    } catch (err) {
      console.error('switch contact failed:', err)
      return json(res, 500, { error: (err as Error).message })
    }
  }

  // POST /leads/remove {id}: forget a lead (a mis-hear or a test), and move
  // its CRM record to the trash (Notion) or recycling bin (HubSpot).
  if (req.method === 'POST' && req.url === '/leads/remove') {
    try {
      const body = JSON.parse((await readBody(req, 2_000)).toString() || '{}') as { id?: string }
      const lead = readLeads().find(l => l.id === body.id)
      if (!lead) return json(res, 404, { error: 'no such lead' })
      let crmError: string | null = null
      if (notion && lead.notion) await notion.trash(lead.notion.id).catch(err => {
        console.error('notion trash failed:', err)
        crmError = (err as Error).message
      })
      if (hubspot && lead.hubspot) await hubspot.trash(lead.hubspot.id).catch(err => {
        console.error('hubspot delete failed:', err)
        crmError = (err as Error).message
      })
      removeLead(lead.id)
      const crm = lead.hubspot ? 'HubSpot contact' : lead.notion ? 'Notion row' : null
      console.log(`lead ${lead.card.name ?? '-'} removed${crm ? (crmError ? ` (${crm} kept)` : ` and its ${crm} deleted`) : ''}`)
      return json(res, 200, { ok: true, crmError })
    } catch (err) {
      console.error('remove lead failed:', err)
      return json(res, 500, { error: (err as Error).message })
    }
  }

  json(res, 404, { error: 'not found' })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(
    `Handshake backend on :${PORT} · STT: ${transcriber.name} · scorer: ${scorer.name} · Treg: ${treg ? 'on' : 'off'} · CRM: ${hubspot ? 'HubSpot' : notion ? 'Notion' : 'off'} · profile: ${profile?.company ?? 'none (using icp.md)'}`,
  )
})
