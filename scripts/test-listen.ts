import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Capture, type Speaker, type StopReason } from '../src/listen.ts'
import { wavToPcm } from '../backend/src/wav.ts'

// Feeds the fixture intros through the silence detector the way the glasses
// deliver audio (100 ms chunks), with room noise before and after, at several
// mic volumes. Checks that capture ends on silence, after the whole
// introduction, and soon enough to keep the card fast.
// Usage: npm run test:listen

const CHUNK = 3200 // 100 ms of 16 kHz s16le
const dir = new URL('../backend/fixtures/', import.meta.url).pathname
const clips = readdirSync(dir).filter(f => f.endsWith('.wav')).sort()

function roomNoise(ms: number, amplitude: number): Int16Array {
  const out = new Int16Array((16000 * ms) / 1000)
  let b = 0
  for (let i = 0; i < out.length; i++) {
    b = 0.97 * b + 0.03 * (Math.random() * 2 - 1) // soft, low-frequency hum
    out[i] = Math.round(b * amplitude * 32767 * 4)
  }
  return out
}

function run(samples: Int16Array): { reason: StopReason | null; stoppedAtMs: number } {
  let reason: StopReason | null = null
  const capture = new Capture(r => (reason = r))
  const bytes = new Uint8Array(samples.buffer)
  for (let off = 0; off + CHUNK <= bytes.length; off += CHUNK) {
    if (!capture.push(bytes.slice(off, off + CHUNK))) break
  }
  return { reason, stoppedAtMs: capture.elapsedMs }
}

let failures = 0
const LEAD_MS = 1000
const TAIL_MS = 3000

for (const clip of clips) {
  const pcm = wavToPcm(readFileSync(join(dir, clip)))
  const speech = new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength))
  // Where the speech really ends: last 100 ms chunk with real energy.
  let lastLoud = 0
  for (let i = 0; i < speech.length; i += 1600) {
    let sum = 0
    for (let j = i; j < Math.min(i + 1600, speech.length); j++) sum += (speech[j] / 32768) ** 2
    if (Math.sqrt(sum / 1600) > 0.01) lastLoud = i
  }
  const speechEndMs = LEAD_MS + ((lastLoud + 1600) / 16000) * 1000

  for (const gain of [1, 0.3, 0.1]) {
    const lead = roomNoise(LEAD_MS, 0.0015)
    const tail = roomNoise(TAIL_MS, 0.0015)
    const mixed = new Int16Array(lead.length + speech.length + tail.length)
    mixed.set(lead, 0)
    speech.forEach((s, i) => (mixed[lead.length + i] = Math.round(s * gain) + lead[i % lead.length]))
    mixed.set(tail, lead.length + speech.length)

    const { reason, stoppedAtMs } = run(mixed)
    const lag = stoppedAtMs - speechEndMs
    const ok = reason === 'silence' && lag >= 0 && lag <= 1300
    if (!ok) failures++
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${clip.padEnd(24)} gain ${String(gain).padEnd(4)} ` +
        `stop=${reason} at ${stoppedAtMs} ms, speech ends ${Math.round(speechEndMs)} ms, lag ${Math.round(lag)} ms`,
    )
  }
}

// Nobody speaks: only room noise, and a couple of short bumps.
const quiet = roomNoise(6000, 0.0015)
for (const at of [16000, 48000]) for (let i = 0; i < 1600; i++) quiet[at + i] += Math.round(Math.sin(i / 3) * 3000)
const q = run(quiet)
const quietOk = q.reason === 'no-speech'
if (!quietOk) failures++
console.log(`${quietOk ? 'ok  ' : 'FAIL'} room noise + bumps only        stop=${q.reason} at ${q.stoppedAtMs} ms`)

// Speaker tags from the glasses: the wearer introduces themselves first.
// Each part is [samples, tag]; chunks take the tag of the part they start in.
function runTagged(parts: [Int16Array, Speaker][]) {
  const samples = new Int16Array(parts.reduce((n, [p]) => n + p.length, 0))
  const tags: Speaker[] = []
  let at = 0
  for (const [p, tag] of parts) {
    samples.set(p, at)
    for (let k = Math.ceil(at / (CHUNK / 2)); k * (CHUNK / 2) < at + p.length; k++) tags[k] = tag
    at += p.length
  }
  let reason: StopReason | null = null
  const capture = new Capture(r => (reason = r))
  const bytes = new Uint8Array(samples.buffer)
  for (let off = 0, i = 0; off + CHUNK <= bytes.length; off += CHUNK, i++) {
    if (!capture.push(bytes.slice(off, off + CHUNK), tags[i] ?? 'unknown')) break
  }
  return { reason: reason as StopReason | null, stoppedAtMs: capture.elapsedMs, clipMs: capture.audio().length / 32, speech: capture.speech }
}

const clipOf = (name: string) => {
  const pcm = wavToPcm(readFileSync(join(dir, name)))
  return new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength))
}
const ms = (samples: Int16Array) => (samples.length / 16000) * 1000
const wearer = clipOf('karri-linear.wav')
const them = clipOf('sarah-stripe.wav')
const check = (ok: boolean, label: string, detail: string) => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(32)} ${detail}`)
}

{
  const r = runTagged([[roomNoise(LEAD_MS, 0.0015), 'unknown'], [wearer, 'self'], [roomNoise(1500, 0.0015), 'unknown'], [them, 'other'], [roomNoise(TAIL_MS, 0.0015), 'unknown']])
  const end = LEAD_MS + ms(wearer) + 1500 + ms(them)
  const expectedClip = r.stoppedAtMs - (LEAD_MS + ms(wearer)) - 600
  check(
    r.reason === 'silence' && r.stoppedAtMs > end - 1000 && r.stoppedAtMs <= end + 1300 && Math.abs(r.clipMs - expectedClip) < 1200,
    'wearer first, then them',
    `stop=${r.reason} at ${r.stoppedAtMs} ms (they end ~${Math.round(end)}), clip ${Math.round(r.clipMs)} ms of ${r.stoppedAtMs}`,
  )
}
{
  const r = runTagged([[roomNoise(LEAD_MS, 0.0015), 'unknown'], [them, 'self'], [roomNoise(8000, 0.0015), 'unknown']])
  check(
    r.reason === 'no-speech' && r.speech && r.clipMs === r.stoppedAtMs,
    'everyone tagged as the wearer',
    `stop=${r.reason} at ${r.stoppedAtMs} ms, still sent: ${r.speech}, clip ${Math.round(r.clipMs)} ms (whole)`,
  )
}
{
  const r = runTagged([[roomNoise(LEAD_MS, 0.0015), 'unknown'], [wearer, 'self'], [roomNoise(1500, 0.0015), 'unknown'], [them, 'self'], [roomNoise(TAIL_MS, 0.0015), 'unknown']])
  check(
    r.reason === 'silence' && r.clipMs === r.stoppedAtMs,
    'them also tagged as the wearer',
    `stop=${r.reason} at ${r.stoppedAtMs} ms, clip ${Math.round(r.clipMs)} ms (whole, nothing cut)`,
  )
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
