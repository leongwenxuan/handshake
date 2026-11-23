import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { whisperLocal } from './stt.ts'
import { mockScorer } from './score.ts'

// POST /lookup with raw PCM (s16le, 16 kHz, mono) as the body.
// Returns the card, the transcript and how long each step took.
// Audio is only held in memory for the request and never written to disk.

const PORT = Number(process.env.PORT ?? 8787)
const MAX_BYTES = 16000 * 2 * 15 // 15 s of audio

const transcriber = whisperLocal()
const scorer = mockScorer()

function cors(res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BYTES) throw new Error('audio too long')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

const server = createServer(async (req, res) => {
  cors(res)
  if (req.method === 'OPTIONS') return res.writeHead(204).end()

  if (req.method === 'GET' && req.url === '/health') {
    return json(res, 200, { ok: true, stt: transcriber.name, scorer: scorer.name })
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
  console.log(`Handshake backend on :${PORT} · STT: ${transcriber.name} · scorer: ${scorer.name}`)
})
