import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { whisperLocal } from './stt.ts'
import { mockScorer } from './score.ts'
import { openaiScorer, openaiTranscriber } from './openai.ts'
import { buildProfile, loadProfile, profileText, saveProfile, type Profile } from './profile.ts'
import { treg as makeTreg } from './treg.ts'

// POST /lookup with raw PCM (s16le, 16 kHz, mono) as the body.
// Returns the card, the transcript and how long each step took.
// GET /profile, POST /profile {company, note?}: the wearer's company profile
// (ideal customers and buyer roles) that every card is judged against.
// Audio is only held in memory for the request and never written to disk.

const PORT = Number(process.env.PORT ?? 8787)
const MAX_BYTES = 16000 * 2 * 15 // 15 s of audio

const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim()
const TREG_API_KEY = process.env.TREG_API_KEY?.trim()

let profile: Profile | null = loadProfile()
const treg = TREG_API_KEY ? makeTreg(TREG_API_KEY) : null
const transcriber = process.env.STT === 'openai' && OPENAI_API_KEY ? openaiTranscriber(OPENAI_API_KEY) : whisperLocal()
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
    return json(res, 200, { ok: true, stt: transcriber.name, scorer: scorer.name, treg: !!treg, profile: profile?.company ?? null })
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

  json(res, 404, { error: 'not found' })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(
    `Handshake backend on :${PORT} · STT: ${transcriber.name} · scorer: ${scorer.name} · Treg: ${treg ? 'on' : 'off'} · profile: ${profile?.company ?? 'none (using icp.md)'}`,
  )
})
