import { pcmToWav } from './wav.ts'

// Speech-to-text behind one function, so the provider can be swapped
// (local Whisper today; OpenAI or ElevenLabs later) without touching callers.
export interface Transcriber {
  name: string
  transcribe(pcm: Buffer): Promise<string>
}

// Local whisper.cpp server (`npm run whisper`). The model stays loaded between
// requests, so each call only pays for inference.
export function whisperLocal(url = process.env.WHISPER_URL ?? 'http://127.0.0.1:8178'): Transcriber {
  return {
    name: 'whisper.cpp (local)',
    async transcribe(pcm) {
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(pcmToWav(pcm))], { type: 'audio/wav' }), 'clip.wav')
      form.append('response_format', 'json')
      form.append('temperature', '0')
      const res = await fetch(`${url}/inference`, { method: 'POST', body: form })
      if (!res.ok) throw new Error(`whisper-server ${res.status}: ${await res.text()}`)
      const body = (await res.json()) as { text?: string }
      return (body.text ?? '').replace(/\s+/g, ' ').trim()
    },
  }
}
