// Collects mic chunks after a tap and decides when the person has finished
// their introduction: after a short silence that follows speech, on a second
// tap, or at a hard time limit.
//
// The glasses tag each chunk with who they think is speaking (self = the
// wearer). If the wearer introduces themselves first and pauses, the capture
// keeps waiting for the other person instead of ending, and the wearer's part
// is left out of the clip. Tags are only trusted that far: anything less
// clear-cut is sent as is and the backend sorts out who said what.

const CHUNK_MS = 100
const END_SILENCE_MS = 1100 // quiet after speech that ends the capture; a pause between "I'm Sarah" and "I run..." is often 0.8 s
const NO_SPEECH_MS = 5000 // give up if nobody speaks
const MAX_MS = 12000 // long intros (name, role, company, what they do) run 7-9 s
const MIN_SPEECH_MS = 300 // loud audio needed before it counts as speech, not a bump or cough
const WEARER_EXTRA_MS = 6000 // more time when the wearer spoke first
const WEARER_MIN_CHUNKS = 3 // loud chunks tagged self before it counts as the wearer's intro
const KEEP_GAP_CHUNKS = 5 // of the pause after the wearer, kept at the start of the clip

// Thresholds adapt to the room: speech must be clearly above the noise floor
// to start, and only has to stay a little above it to continue, so short
// pauses between words don't end the capture (hysteresis).
const START_FACTOR = 4
const CONTINUE_FACTOR = 2.5
const MIN_START = 0.006 // absolute floors, for a near-silent room
const MIN_CONTINUE = 0.004
const FLOOR_CHUNKS = 5 // noise floor = quietest of the first few non-empty chunks

export type StopReason = 'silence' | 'tap' | 'max' | 'no-speech'
export type Speaker = 'self' | 'other' | 'unknown'

export class Capture {
  private chunks: Uint8Array[] = []
  private levels: number[] = []
  private floorSamples: number[] = []
  private heardSpeech = false
  private silentMs = 0
  private loudMs = 0
  private stopped = false
  private waitFrom = 0 // chunk where waiting for speech (re)started
  private selfLoud = 0 // loud chunks since then, by tagged speaker
  private otherLoud = 0
  private wearerUntil: number | null = null // chunk where the wearer's own intro ended
  private speakers = { self: 0, other: 0, unknown: 0 }
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
  push(pcm: Uint8Array, speaker: Speaker = 'unknown'): boolean {
    if (this.stopped) return false
    if (this.firstChunkAt === null) this.firstChunkAt = performance.now()
    this.chunks.push(pcm)
    this.speakers[speaker] = (this.speakers[speaker] ?? 0) + 1
    const level = rms(pcm)
    this.levels.push(level)
    // The mic's first chunks can be digital silence; don't let them set the floor.
    if (level > 0 && this.floorSamples.length < FLOOR_CHUNKS) this.floorSamples.push(level)

    const floor = this.noiseFloor
    const start = Math.max(MIN_START, floor * START_FACTOR)
    const keep = Math.max(MIN_CONTINUE, floor * CONTINUE_FACTOR)

    if (level > keep && speaker === 'self') this.selfLoud++
    if (level > keep && speaker === 'other') this.otherLoud++

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

    if (this.heardSpeech && this.silentMs >= END_SILENCE_MS) {
      if (!this.wearerSpokeFirst()) return this.stop('silence')
      // Only once, so a mic that tags everyone as the wearer still ends.
      this.wearerUntil = this.chunks.length
      this.waitFrom = this.chunks.length
      this.heardSpeech = false
      this.loudMs = this.silentMs = this.selfLoud = this.otherLoud = 0
      return true
    }
    if (!this.heardSpeech && (this.chunks.length - this.waitFrom) * CHUNK_MS >= NO_SPEECH_MS) return this.stop('no-speech')
    if (this.elapsedMs >= MAX_MS + (this.wearerUntil === null ? 0 : WEARER_EXTRA_MS)) return this.stop('max')
    return true
  }

  // The speech that just paused was all tagged as the wearer.
  private wearerSpokeFirst() {
    return this.wearerUntil === null && this.selfLoud >= WEARER_MIN_CHUNKS && this.otherLoud <= 1
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

  // How many chunks each speaker tag had, to check the tags on real glasses.
  get speakerTrace(): string {
    const s = this.speakers
    return `self ${s.self}, other ${s.other}, unknown ${s.unknown}${this.wearerUntil === null ? '' : `, wearer first until ${this.wearerUntil * CHUNK_MS} ms`}`
  }

  // Speech worth sending. A wearer's intro with no one after it is still sent:
  // the tags may be wrong, and the backend can tell from the words.
  get speech() {
    return this.heardSpeech || this.wearerUntil !== null
  }

  // Where the clip starts: after the wearer's intro, but only once someone
  // tagged as the other person has clearly spoken after it.
  private get clipStart() {
    if (this.wearerUntil === null || !this.heardSpeech || this.otherLoud < WEARER_MIN_CHUNKS) return 0
    return Math.max(0, this.wearerUntil - KEEP_GAP_CHUNKS)
  }

  audio(): Uint8Array<ArrayBuffer> {
    const chunks = this.chunks.slice(this.clipStart)
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0))
    let offset = 0
    for (const c of chunks) {
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
