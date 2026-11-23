import { readFileSync } from 'node:fs'
import type { Card, Scorer } from './score.ts'
import type { Transcriber } from './stt.ts'
import { pcmToWav } from './wav.ts'

const API = 'https://api.openai.com/v1'

const CARD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'company', 'role', 'fit', 'score', 'why', 'opener'],
  properties: {
    name: { type: ['string', 'null'], description: "The other person's name as they said it, or null" },
    company: { type: ['string', 'null'], description: 'Their company, or null' },
    role: { type: ['string', 'null'], description: 'Their role in a few words, or null' },
    fit: { type: 'string', enum: ['strong', 'maybe', 'weak', 'unknown'] },
    score: { type: ['integer', 'null'], description: '0-10 fit score, null when fit is unknown' },
    why: { type: 'string', description: 'One reason for the verdict, at most 45 characters' },
    opener: { type: 'string', description: 'Suggested next line to say, starting with Ask:, at most 60 characters' },
  },
}

function instructions(icp: string) {
  return `You help someone at an in-person event decide, in one glance, whether the person who just introduced themselves fits their ideal customer profile (ICP). The result is shown on smart glasses with a tiny monochrome display, so every field must be short.

The transcript is a few seconds of audio from a noisy room, recorded right after a handshake. It may include the wearer's own voice, filler, or misheard words.

Rules:
- Use only what the person said about themselves, plus well-known public facts about large, famous companies. Never invent facts about a company you don't recognise.
- If the company is unknown to you or the role is unclear, set fit to "unknown", score to null, and make the opener a qualifying question that would settle it.
- Fix an obvious mishearing of a famous company name (for example "Stride" said in a fintech context is probably "Stripe") only when you are confident. Keep personal names as heard.
- If no name or company was said, return nulls for them and fit "unknown".
- Score 8-10 strong fit, 5-7 maybe, 0-4 weak.
- "why" is at most 45 characters. "opener" starts with "Ask: " and is at most 60 characters, specific to them and the ICP.

ICP:
${icp}`
}

export function openaiScorer(
  apiKey: string,
  model = process.env.OPENAI_MODEL || 'gpt-5.4-mini',
  // For reasoning models (gpt-5 family). Lowest effort keeps lookups fast.
  reasoningEffort = process.env.OPENAI_REASONING_EFFORT || (model.startsWith('gpt-5') ? 'none' : undefined),
): Scorer {
  const icpPath = new URL('../icp.md', import.meta.url)
  return {
    name: `OpenAI ${model}${reasoningEffort ? ` (${reasoningEffort})` : ''}`,
    async score(transcript) {
      // Re-read each time so edits to icp.md apply without a restart.
      const icp = readFileSync(icpPath, 'utf8')
      const res = await fetch(`${API}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: instructions(icp) },
            { role: 'user', content: `Transcript: "${transcript}"` },
          ],
          response_format: { type: 'json_schema', json_schema: { name: 'card', strict: true, schema: CARD_SCHEMA } },
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        }),
      })
      if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`)
      const body = (await res.json()) as { choices: { message: { content: string | null; refusal?: string | null } }[] }
      const msg = body.choices[0]?.message
      if (!msg?.content) throw new Error(`OpenAI returned no content${msg?.refusal ? `: ${msg.refusal}` : ''}`)
      return JSON.parse(msg.content) as Card
    },
  }
}

export function openaiTranscriber(apiKey: string, model = process.env.OPENAI_STT_MODEL || 'gpt-4o-mini-transcribe'): Transcriber {
  return {
    name: `OpenAI ${model}`,
    async transcribe(pcm) {
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(pcmToWav(pcm))], { type: 'audio/wav' }), 'clip.wav')
      form.append('model', model)
      form.append('language', 'en')
      form.append('prompt', 'A person introducing themselves at a business event: name, role, company.')
      const res = await fetch(`${API}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      })
      if (!res.ok) throw new Error(`OpenAI transcription ${res.status}: ${await res.text()}`)
      const body = (await res.json()) as { text?: string }
      return (body.text ?? '').trim()
    },
  }
}
