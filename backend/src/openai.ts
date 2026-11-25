import type { Card, Scorer } from './score.ts'
import type { Transcriber } from './stt.ts'
import { pcmToWav } from './wav.ts'

const API = 'https://api.openai.com/v1'

export const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-5.4-mini'

// One structured-output chat call: returns the parsed JSON object.
export async function chatJSON<T>(
  apiKey: string,
  opts: { system: string; user: string; schemaName: string; schema: object; model?: string; reasoningEffort?: string },
): Promise<T> {
  const model = opts.model ?? DEFAULT_MODEL
  const reasoningEffort = opts.reasoningEffort ?? (model.startsWith('gpt-5') ? 'none' : undefined)
  const res = await fetch(`${API}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.user },
      ],
      response_format: { type: 'json_schema', json_schema: { name: opts.schemaName, strict: true, schema: opts.schema } },
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    }),
  })
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`)
  const body = (await res.json()) as { choices: { message: { content: string | null; refusal?: string | null } }[] }
  const msg = body.choices[0]?.message
  if (!msg?.content) throw new Error(`OpenAI returned no content${msg?.refusal ? `: ${msg.refusal}` : ''}`)
  return JSON.parse(msg.content) as T
}

const CARD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'company', 'company_domain', 'role', 'checked_title', 'relation', 'company_fit', 'buyer', 'fit', 'score', 'why', 'opener'],
  properties: {
    name: { type: ['string', 'null'], description: "The other person's name as they said it, or null" },
    company: { type: ['string', 'null'], description: 'Their company, or null' },
    company_domain: {
      type: ['string', 'null'],
      description: "The company's main website domain (e.g. stripe.com) only if you are confident which company it is; otherwise null",
    },
    role: { type: ['string', 'null'], description: 'Their role in a few words, as they described it, or null' },
    checked_title: {
      type: ['string', 'null'],
      description:
        'Only when checked facts are given: their job title from the facts, if it is consistent with what they said about their role. Null if it conflicts (it may be a different person with the same name) or there are no facts',
    },
    relation: { type: 'string', enum: ['prospect', 'colleague'], description: "colleague: works at the wearer's company. Otherwise prospect" },
    company_fit: {
      type: 'string',
      enum: ['yes', 'no', 'unknown'],
      description: "Does their company look like an ideal customer company? Judge the company alone: this person's role does not change it",
    },
    buyer: {
      type: ['string', 'null'],
      description: 'The buyer role label from the profile that this person matches, exactly as written there, or null',
    },
    fit: { type: 'string', enum: ['strong', 'maybe', 'weak', 'unknown'] },
    score: { type: ['integer', 'null'], description: '0-10 fit score, null when fit is unknown' },
    why: { type: 'string', description: 'One reason for the verdict, at most 45 characters' },
    opener: { type: 'string', description: 'Suggested next line to say, starting with Ask:, at most 60 characters' },
  },
}

function instructions(profile: string) {
  return `You help someone at an in-person event decide, in one glance, whether the person who just introduced themselves is a potential customer for the wearer's company. The result is shown on smart glasses with a tiny monochrome display, so every field must be short.

The transcript is a few seconds of audio from a noisy room, recorded right after a handshake. It may include the wearer's own voice (they may introduce themselves too), filler, or misheard words. Never score the wearer: the card is about the other person. If only the wearer is heard, return nulls for name and company.

Rules:
- Use only what the person said about themselves, plus well-known public facts about large, famous companies (size, industry). Never invent facts about a company you don't recognise; judge it from what they said it does.
- Judge a company by what kind of company it is, not by who its customers are: a startup that builds software is a software company even if it sells to cafes.
- Judge two things: does their company look like an ideal customer company, and does their role match one of the buyer roles? Set "buyer" to the matching role label, or null. A founder or CEO of a small company counts as its decision maker.
- Strong fit (8-10): ideal company and a buyer role. Maybe (5-7): one of the two, or a partial match. Weak (0-4): clearly a poor fit, such as students, job seekers, or companies listed as not a fit.
- A clear role that is not a buyer role is still a verdict (maybe or weak), not unknown. Then the opener asks who owns the most relevant buyer role there.
- Use fit "unknown" and score null only when you cannot tell their role and have no idea what their company does. Then the opener is a qualifying question that would settle it.
- Fix an obvious mishearing of a famous company name (for example "Stride" said in a fintech context is probably "Stripe") only when you are confident. Keep personal names as heard.
- If no name or company was said, return nulls for them and fit "unknown".
- A colleague is not a prospect: set fit "unknown", score null and buyer null, and keep the opener friendly.
- Checked facts, when given, come from a business database looked up by the name and company you heard. Trust them for company size and industry. A person row may be someone else with the same name: use their title only if it fits what they said (a "Cofounder" title fits "one of the founders"; "Software Engineer" does not fit "I run partnerships"). If it conflicts, ignore that row and trust what they said.
- "why" is at most 45 characters, in whole words: shorten the phrase rather than cutting a word off. "opener" starts with "Ask: " and is at most 60 characters, specific to them and to what the wearer sells.

${profile}`
}

// profile() is called on every lookup, so a rebuilt profile applies at once.
export function openaiScorer(apiKey: string, profile: () => string, model = DEFAULT_MODEL): Scorer {
  return {
    name: `OpenAI ${model}`,
    score: (transcript, facts) =>
      chatJSON<Card>(apiKey, {
        model,
        system: instructions(profile()),
        user: `Transcript: "${transcript}"${facts ? `\n\n${facts}` : ''}`,
        schemaName: 'card',
        schema: CARD_SCHEMA,
        reasoningEffort: process.env.OPENAI_REASONING_EFFORT || undefined,
      }),
  }
}

// hint(): extra context for the prompt, such as the wearer's name and
// company, which the clip often starts with and which are easy to mishear.
export function openaiTranscriber(
  apiKey: string,
  hint: () => string | null = () => null,
  model = process.env.OPENAI_STT_MODEL || 'gpt-4o-transcribe',
): Transcriber {
  return {
    name: `OpenAI ${model}`,
    async transcribe(pcm) {
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(pcmToWav(pcm))], { type: 'audio/wav' }), 'clip.wav')
      form.append('model', model)
      form.append('language', 'en')
      form.append('prompt', ['A person introducing themselves at a business event: name, role, company.', hint()].filter(Boolean).join(' '))
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
