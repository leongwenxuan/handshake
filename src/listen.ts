// Collects mic chunks after a tap and decides when the person has finished
// their introduction: after a short silence that follows speech, on a second
// tap, or at a hard time limit.

const CHUNK_MS = 100
const END_SILENCE_MS = 800 // quiet after speech that ends the capture
const NO_SPEECH_MS = 5000 // give up if nobody speaks
const MAX_MS = 8000
const MIN_SPEECH_MS = 300 // loud audio needed before it counts as speech, not a bump or cough

// Thresholds adapt to the room: speech must be clearly above the noise floor
// to start, and only has to stay a little above it to continue, so short
// pauses between words don't end the capture (hysteresis).
const START_FACTOR = 4
const CONTINUE_FACTOR = 2.5
const MIN_START = 0.006 // absolute floors, for a near-silent room
const MIN_CONTINUE = 0.004
const FLOOR_CHUNKS = 5 // noise floor = quietest of the first few non-empty chunks

export type StopReason = 'silence' | 'tap' | 'max' | 'no-speech'

export class Capture {
  private chunks: Uint8Array[] = []
  private levels: number[] = []
  private floorSamples: number[] = []
  private heardSpeech = false
  private silentMs = 0
  private loudMs = 0
  private stopped = false
  private onStop: (reason: StopReason) => void
  readonly startedAt = performance.now()
  firstChunkAt: number | null = null

  constructor(onStop: (reason: StopReason) => void) {
    this.onStop = onStop
  }

  get elapsedMs() {
    return this.chunks.length * CHUNK_MS
  }

  get noiseFloor() {
    return this.floorSamples.length ? Math.min(...this.floorSamples) : 0
  }

  // Returns false once the capture has stopped.
  push(pcm: Uint8Array): boolean {
    if (this.stopped) return false
    if (this.firstChunkAt === null) this.firstChunkAt = performance.now()
    this.chunks.push(pcm)
    const level = rms(pcm)
    this.levels.push(level)
    // The mic's first chunks can be digital silence; don't let them set the floor.
    if (level > 0 && this.floorSamples.length < FLOOR_CHUNKS) this.floorSamples.push(level)

    const floor = this.noiseFloor
    const start = Math.max(MIN_START, floor * START_FACTOR)
    const keep = Math.max(MIN_CONTINUE, floor * CONTINUE_FACTOR)

    if (!this.heardSpeech) {
      if (level > start) {
        this.loudMs += CHUNK_MS
        if (this.loudMs >= MIN_SPEECH_MS) this.heardSpeech = true
      }
    } else if (level > keep) {
      this.silentMs = 0
    } else {
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

  // Per-chunk loudness, for tuning the thresholds.
  get levelTrace(): string {
    return this.levels.map(l => Math.round(l * 1000)).join(' ')
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
