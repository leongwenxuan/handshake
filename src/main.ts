import { waitForEvenAppBridge, OsEventTypeList } from '@evenrealities/even_hub_sdk'
import { showCard, showText, updateCardText, CARD_ACTIONS } from './glasses'
import { Capture, type StopReason } from './listen'
import { BACKEND_URL, cardText, lookup, saveLead as saveToBackend, verify, type Check, type LookupResult } from './api'

// Flow: idle --tap--> listening --silence/tap--> thinking --> card --Save/Skip--> idle
// The card shows at once, then fills in when the role check returns.
// Double-tap: from idle exits the app; from anywhere else goes back to idle.

type State =
  | { kind: 'idle' }
  | { kind: 'listening'; capture: Capture }
  | { kind: 'thinking' }
  | { kind: 'card'; result: LookupResult; check: Check }

const bridge = await waitForEvenAppBridge()
let state: State = { kind: 'idle' }

const IDLE_TEXT = 'Handshake\n\nTap when someone introduces themselves.'

async function goIdle(message?: string) {
  if (FIXTURE && state.kind === 'card') void bridge.audioControl(false)
  state = { kind: 'idle' }
  await showText(bridge, message ? `${message}\n\n${IDLE_TEXT}` : IDLE_TEXT)
}

// Dev only: ?fixture=<name> plays backend/fixtures/<name>.wav into the
// capture instead of the mic, for repeatable end-to-end runs in the simulator.
const FIXTURE = import.meta.env.DEV ? new URLSearchParams(location.search).get('fixture') : null

async function startListening() {
  const capture = new Capture(reason => void finishListening(capture, reason))
  state = { kind: 'listening', capture }
  await showText(bridge, 'Listening...\n\nTap when they finish.')
  if (FIXTURE) return void playFixture(FIXTURE, capture)
  await bridge.audioControl(true)
}

async function playFixture(name: string, capture: Capture) {
  const wav = new Uint8Array(await (await fetch(`${BACKEND_URL}/fixtures/${encodeURIComponent(name)}.wav`)).arrayBuffer())
  const noise = (ms: number) => {
    const out = new Int16Array(16 * ms)
    for (let i = 0; i < out.length; i++) out[i] = Math.round((Math.random() * 2 - 1) * 40)
    return new Uint8Array(out.buffer)
  }
  const lead = noise(1000)
  const tail = noise(3000)
  const pcm = new Uint8Array(lead.length + wav.length - 44 + tail.length)
  pcm.set(lead, 0)
  pcm.set(wav.subarray(44), lead.length)
  pcm.set(tail, lead.length + wav.length - 44)
  // All at once: the simulator throttles timers in a background window, and
  // the capture measures time by chunk count anyway.
  for (let off = 0; off + 3200 <= pcm.length; off += 3200) {
    if (!capture.push(pcm.slice(off, off + 3200))) return
  }
}

async function finishListening(capture: Capture, reason: StopReason) {
  if (state.kind !== 'listening' || state.capture !== capture) return
  await bridge.audioControl(false)
  const micDelay = capture.firstChunkAt === null ? null : Math.round(capture.firstChunkAt - capture.startedAt)
  console.log(`capture stopped: ${reason}, ${capture.elapsedMs} ms audio, first chunk after ${micDelay} ms`)
  console.log(`levels (x1000): ${capture.levelTrace}`)

  if (!capture.speech) return goIdle("Didn't catch that.")

  state = { kind: 'thinking' }
  await showText(bridge, 'Checking fit...')
  const t0 = performance.now()
  try {
    const result = await lookup(capture.audio())
    const roundTrip = Math.round(performance.now() - t0)
    console.log(`lookup ${roundTrip} ms round trip`, result.timings, `"${result.transcript}"`)
    if (state.kind !== 'thinking') return // user backed out
    if (!result.card.name && !result.card.company) return goIdle("Didn't catch a name. Tap to try again.")
    const check: Check = result.card.company || result.card.company_domain ? 'pending' : 'off'
    const shown: State = { kind: 'card', result, check }
    state = shown
    await showCard(bridge, cardText(result.card, check))
    // The simulator freezes a page that gets no events, so in fixture mode
    // keep mic events flowing while the card waits for the role check.
    // They're ignored outside listening; goIdle turns the mic off.
    if (FIXTURE && check === 'pending') await bridge.audioControl(true)
    if (check === 'pending') void checkRole(shown, t0)
  } catch (err) {
    console.error('lookup failed:', err)
    if (state.kind === 'thinking') await goIdle('Lookup failed. Try again.')
  }
}

// Second pass: verify their role and find who to ask for, then update the
// card in place if it's still on screen.
async function checkRole(shown: Extract<State, { kind: 'card' }>, t0: number) {
  let check: Check = 'off'
  let card = shown.result.card
  try {
    const v = await verify(shown.result.transcript, card)
    console.log(`verify ${Math.round(performance.now() - t0)} ms after capture`, v.timings, v.verification)
    if (v.verification) {
      check = v.verification
      card = v.card
    }
  } catch (err) {
    console.error('verify failed:', err)
  }
  if (state !== shown) return // saved, skipped or backed out meanwhile
  shown.result = { ...shown.result, card }
  shown.check = check
  await updateCardText(bridge, cardText(card, check))
}

// Saves on the glasses first, so a lead is never lost, then sends it to the
// backend, which drafts a follow-up email and adds both to Notion. The idle
// screen shows at once and its first line updates when that finishes.
async function saveLead(result: LookupResult, check: Check) {
  const verification = typeof check === 'object' ? check : null
  const leads = await loadLeads()
  leads.push({ ...result.card, verification, transcript: result.transcript, savedAt: new Date().toISOString() })
  await bridge.setLocalStorage('leads', JSON.stringify(leads))
  console.log(`saved lead #${leads.length}`, result.card)

  const who = result.card.name ?? 'lead'
  await goIdle(`Saved ${who}. Adding to CRM...`)
  const idle = state
  if (FIXTURE) await bridge.audioControl(true) // keep the simulator awake (see above)
  let line = `Saved ${who}.`
  try {
    const t0 = performance.now()
    const saved = await saveToBackend(result.card, verification, result.transcript)
    console.log(`lead sent in ${Math.round(performance.now() - t0)} ms`, saved)
    if (saved.notion === 'saved') line = `Saved ${who} to Notion.\nFollow-up email drafted.`
    else if (saved.notion === 'failed') line = `Saved ${who}. Notion failed.`
  } catch (err) {
    console.error('sending lead failed:', err)
    line = `Saved ${who} on glasses only.`
  }
  if (FIXTURE) await bridge.audioControl(false)
  if (state === idle) await updateCardText(bridge, `${line}\n\n${IDLE_TEXT}`)
}

async function loadLeads(): Promise<unknown[]> {
  try {
    const raw = await bridge.getLocalStorage('leads')
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

// CLICK_EVENT is 0 and protobuf drops zero values, so a tap arrives with
// eventType undefined. Resolve the default inside the envelope check, or
// every audio frame (which has no sysEvent) would read as a tap.
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

function backOrExit() {
  if (state.kind === 'idle') return bridge.shutDownPageContainer(1)
  if (state.kind === 'listening') bridge.audioControl(false)
  return goIdle()
}

const unsubscribe = bridge.onEvenHubEvent(event => {
  const pcm = event.audioEvent?.audioPcm
  if (pcm) {
    if (state.kind === 'listening') state.capture.push(pcm)
    return
  }

  const sysType = eventTypeOf(event.sysEvent)
  const textType = eventTypeOf(event.textEvent)
  const listType = eventTypeOf(event.listEvent)

  if ([sysType, textType, listType].includes(OsEventTypeList.DOUBLE_CLICK_EVENT)) {
    void backOrExit()
    return
  }

  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    if (state.kind === 'listening') bridge.audioControl(false)
    unsubscribe()
    return
  }

  if (state.kind === 'card' && listType === OsEventTypeList.CLICK_EVENT) {
    const action = CARD_ACTIONS[event.listEvent?.currentSelectItemIndex ?? 0]
    if (action === 'Save lead') void saveLead(state.result, state.check)
    else void goIdle()
    return
  }

  const tapped = sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT
  if (!tapped) return
  if (state.kind === 'idle') void startListening()
  else if (state.kind === 'listening') state.capture.stop('tap')
})

await goIdle()
