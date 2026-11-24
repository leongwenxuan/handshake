import { existsSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { whisperLocal } from './stt.ts'
import { mockScorer } from './score.ts'
import { openaiScorer, openaiTranscriber } from './openai.ts'
import { buildProfile, loadProfile, profileText, saveProfile, type Profile } from './profile.ts'
import { treg as makeTreg } from './treg.ts'
import { factsText, verify } from './verify.ts'
import type { Card } from './score.ts'
import { appendLead, draftFollowUp, readLeads, type Lead } from './leads.ts'
import { notion as makeNotion } from './notion.ts'
import type { Verification } from './verify.ts'

// POST /lookup with raw PCM (s16le, 16 kHz, mono) as the body.
// Returns the card, the transcript and how long each step took.
// POST /verify {transcript, card}: checks the person's work role through
// Treg and rescores with what it found (second, slower pass).
// GET /profile, POST /profile {company, note?}: the wearer's company profile
// (ideal customers and buyer roles) that every card is judged against.
// POST /leads {card, verification, transcript}: saves a lead, drafts a
// follow-up email and adds both to Notion. GET /leads lists saved leads.
// Audio is only held in memory for the request and never written to disk.

const PORT = Number(process.env.PORT ?? 8787)
const MAX_BYTES = 16000 * 2 * 15 // 15 s of audio

const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim()
const TREG_API_KEY = process.env.TREG_API_KEY?.trim()
const NOTION_TOKEN = process.env.NOTION_TOKEN?.trim()

let profile: Profile | null = loadProfile()
const treg = TREG_API_KEY ? makeTreg(TREG_API_KEY) : null
const notion = NOTION_TOKEN ? makeNotion(NOTION_TOKEN) : null
// OpenAI transcription hears names far better than local Whisper base
// ("Patrick Collison" vs "Patrick Carlson"), which the role check depends on.
const transcriber = process.env.STT !== 'whisper' && OPENAI_API_KEY ? openaiTranscriber(OPENAI_API_KEY) : whisperLocal()
const scorer = OPENAI_API_KEY ? openaiScorer(OPENAI_API_KEY, () => profileText(profile)) : mockScorer()

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
    return json(res, 200, { ok: true, stt: transcriber.name, scorer: scorer.name, treg: !!treg, notion: !!notion, profile: profile?.company ?? null })
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

  if (req.method === 'POST' && req.url === '/profile') {
    try {
      const { company, note } = JSON.parse((await readBody(req, 10_000)).toString() || '{}') as { company?: string; note?: string }
      if (!company?.trim()) return json(res, 400, { error: 'Type your company name or website.' })
      if (!OPENAI_API_KEY) return json(res, 503, { error: 'Set OPENAI_API_KEY in backend/.env first.' })
      const built = await buildProfile(company, note?.trim() || null, { openaiKey: OPENAI_API_KEY, treg })
      profile = built
      saveProfile(built)
      return json(res, 200, { profile })
    } catch (err) {
      console.error('profile failed:', err)
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
      const card = await scorer.score(transcript)
      const t3 = performance.now()

      const timings = {
        audio_s: +(pcm.length / 32000).toFixed(2),
        stt_ms: Math.round(t2 - t1),
        score_ms: Math.round(t3 - t2),
        server_ms: Math.round(t3 - t0),
      }
      console.log(`lookup ${JSON.stringify(timings)} "${transcript}"`)
      return json(res, 200, { card, transcript, timings })
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
      if (!treg) return json(res, 200, { card, verification: null, timings: { server_ms: 0 } })

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
        if (updated.buyer || updated.company_fit !== 'yes') verification.contact = null
        // The card updates in place while the wearer reads it: keep the lines
        // that didn't need to change so only the new facts move.
        if (updated.fit === card.fit) updated.why = card.why
        if (!verification.contact && (updated.fit === card.fit || named)) updated.opener = card.opener
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
      }
      if (!body.card || typeof body.transcript !== 'string') return json(res, 400, { error: 'need card and transcript' })
      const lead: Lead = {
        id: crypto.randomUUID(),
        card: body.card,
        verification: body.verification ?? null,
        transcript: body.transcript,
        savedAt: new Date().toISOString(),
        followUp: null,
        notion: null,
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
        lead.notion = await notion.addLead(lead).catch(err => {
          console.error('notion save failed:', err)
          notionError = (err as Error).message
          return null
        })
      }
      appendLead(lead)
      const t2 = performance.now()
      const timings = { draft_ms: Math.round(t1 - t0), notion_ms: Math.round(t2 - t1), server_ms: Math.round(t2 - t0) }
      console.log(`lead ${JSON.stringify(timings)} ${lead.card.name ?? '-'} notion=${lead.notion ? 'ok' : notion ? 'failed' : 'off'}`)
      return json(res, 200, { lead, notion: notion ? (lead.notion ? 'saved' : 'failed') : 'off', notionError, drafted: !!lead.followUp, timings })
    } catch (err) {
      console.error('save lead failed:', err)
      return json(res, 500, { error: (err as Error).message })
    }
  }

  json(res, 404, { error: 'not found' })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(
    `Handshake backend on :${PORT} · STT: ${transcriber.name} · scorer: ${scorer.name} · Treg: ${treg ? 'on' : 'off'} · Notion: ${notion ? 'on' : 'off'} · profile: ${profile?.company ?? 'none (using icp.md)'}`,
  )
})
