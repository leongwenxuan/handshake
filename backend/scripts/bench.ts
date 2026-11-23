import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { wavToPcm } from '../src/wav.ts'

// Sends every WAV in backend/fixtures to /lookup and prints timings.
// Fixtures must be 16 kHz mono s16le (see `npm run fixtures`).
// Usage: npm run bench [-- runsPerClip]

const BACKEND = process.env.BACKEND_URL ?? 'http://localhost:8787'
const runs = Number(process.argv[2] ?? 3)
const dir = new URL('../fixtures/', import.meta.url).pathname
const clips = readdirSync(dir).filter(f => f.endsWith('.wav')).sort()

if (clips.length === 0) {
  console.error(`No WAV files in ${dir}. Run: npm run fixtures`)
  process.exit(1)
}

for (const clip of clips) {
  const pcm = wavToPcm(readFileSync(join(dir, clip)))
  const totals: number[] = []
  let last: any
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    const res = await fetch(`${BACKEND}/lookup`, { method: 'POST', body: new Uint8Array(pcm) })
    last = await res.json()
    totals.push(Math.round(performance.now() - t0))
  }
  const sorted = [...totals].sort((a, b) => a - b)
  console.log(`\n${clip}`)
  console.log(`  transcript: "${last.transcript}"`)
  console.log(`  card:       ${last.card?.name ?? '-'} · ${last.card?.company ?? '-'} · ${last.card?.fit} ${last.card?.score ?? ''}`)
  console.log(`  last run:   ${JSON.stringify(last.timings)}`)
  console.log(`  round trip: median ${sorted[Math.floor(sorted.length / 2)]} ms, all ${totals.join(', ')} ms`)
}
