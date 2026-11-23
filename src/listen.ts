// Collects mic chunks after a tap and decides when the person has finished
// their introduction: after a short silence that follows speech, on a second
// tap, or at a hard time limit.

const CHUNK_MS = 100
const END_SILENCE_MS = 800 // silence after speech that ends the capture
const NO_SPEECH_MS = 5000 // give up if nobody speaks
const MAX_MS = 8000
const MIN_THRESHOLD = 0.02 // RMS floor so a quiet room doesn't count as speech
const MIN_SPEECH_MS = 300 // loud audio needed before we treat it as speech, not a bump or cough

export type StopReason = 'silence' | 'tap' | 'max' | 'no-speech'

export class Capture {
  private chunks: Uint8Array[] = []
  private levels: number[] = []
  private heardSpeech = false
  private silentMs = 0
  private loudMs = 0
  private stopped = false
  readonly startedAt = performance.now()
  firstChunkAt: number | null = null

  constructor(private onStop: (reason: StopReason) => void) {}

  get elapsedMs() {
    return this.chunks.length * CHUNK_MS
  }

  // Returns false once the capture has stopped.
  push(pcm: Uint8Array): boolean {
    if (this.stopped) return false
    if (this.firstChunkAt === null) this.firstChunkAt = performance.now()
    this.chunks.push(pcm)
    const level = rms(pcm)
    this.levels.push(level)

    // Noise floor from the quietest of the chunks so far; speech must clear it.
    const floor = Math.min(...this.levels.slice(0, 5))
    const threshold = Math.max(MIN_THRESHOLD, floor * 3)

    if (level > threshold) {
      this.loudMs += CHUNK_MS
      if (this.loudMs >= MIN_SPEECH_MS) this.heardSpeech = true
      this.silentMs = 0
    } else if (this.heardSpeech) {
      this.silentMs += CHUNK_MS
    }

    if (this.heardSpeech && this.silentMs >= END_SILENCE_MS) return this.stop('silence')
    if (!this.heardSpeech && this.elapsedMs >= NO_SPEECH_MS) return this.stop('no-speech')
    if (this.elapsedMs >= MAX_MS) return this.stop('max')
    return true
  }

  stop(reason: StopReason): false {
    if (this.stopped) return false
    this.stopped = true
    this.onStop(reason)
    return false
  }

  get speech() {
    return this.heardSpeech
  }

  audio(): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(this.chunks.reduce((n, c) => n + c.byteLength, 0))
    let offset = 0
    for (const c of this.chunks) {
      out.set(c, offset)
      offset += c.byteLength
    }
    return out
  }
}

// Root-mean-square loudness of one s16le chunk, 0..1.
export function rms(pcm: Uint8Array): number {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const samples = Math.floor(pcm.byteLength / 2)
  if (samples === 0) return 0
  let sum = 0
  for (let i = 0; i < samples; i++) {
    const s = view.getInt16(i * 2, true) / 32768
    sum += s * s
  }
  return Math.sqrt(sum / samples)
}
