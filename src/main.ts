import { waitForEvenAppBridge, OsEventTypeList } from '@evenrealities/even_hub_sdk'
import { actionsFor, showCard, showText, updateCard, updateCardText } from './glasses'
import { Capture, type StopReason } from './listen'
import { BACKEND_URL, lookup, saveLead as saveToBackend, verify, withContact, type Check, type LookupResult } from './api'

// Flow: idle --tap--> listening --silence/tap--> thinking --> card --Save/Skip--> idle
// If the lookup fails, the clip is kept: tap retries it without asking again.
// The card shows at once, then fills in when the role check returns.
// Double-tap: from idle exits the app; from anywhere else goes back to idle.

type State =
  | { kind: 'idle' }
  | { kind: 'listening'; capture: Capture }
  | { kind: 'thinking' }
  | { kind: 'failed'; audio: Uint8Array<ArrayBuffer> }
  | CardState

// roleCheck resolves once result and check hold the role-checked card, even
// after the card has left the screen, so a Save tapped early still gets the
// verified details. "Other buyer" changes them too.
type CardState = { kind: 'card'; result: LookupResult; check: Check; roleCheck: Promise<Final> | null; saving: boolean }
type Final = { card: LookupResult['card']; check: Check }

const bridge = await waitForEvenAppBridge()
let state: State = { kind: 'idle' }

// People say their name in the first second, so tap as they start.
const HINT = 'Tap as someone starts introducing themselves.\nDouble-tap to exit.'
const idleText = (message?: string) => (message ? `${message}\n\n${HINT}` : `Handshake\n\n${HINT}`)

async function goIdle(message?: string) {
  if (FIXTURE && state.kind === 'card') void bridge.audioControl(false)
  state = { kind: 'idle' }
  await showText(bridge, idleText(message))
}

// Dev only: ?fixture=<name> plays backend/fixtures/<name>.wav into the
// capture instead of the mic, for repeatable end-to-end runs in the simulator.
const FIXTURE = import.meta.env.DEV ? new URLSearchParams(location.search).get('fixture') : null

async function startListening() {
  const capture = new Capture(reason => void finishListening(capture, reason))
  state = { kind: 'listening', capture }
  await showText(bridge, 'Listening...\n\nStops when they pause.\nTap to finish now. Double-tap to cancel.')
  // The capture's own limits count audio chunks; this covers a mic that
  // never starts sending them.
  setTimeout(() => capture.stop('max'), 15000)
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
  if (state.kind !== 'listening' || state.capture !== capture) return // cancelled meanwhile
  const micDelay = capture.firstChunkAt === null ? null : Math.round(capture.firstChunkAt - capture.startedAt)
  console.log(`capture stopped: ${reason}, ${capture.elapsedMs} ms audio, first chunk after ${micDelay} ms`)
  console.log(`levels (x1000): ${capture.levelTrace}`)

  if (!capture.speech) return goIdle("Didn't catch that.")
  await checkFit(capture.audio())
}

// Sends the clip for a card. On failure the clip stays in memory (only
// until the next tap or double-tap) so the wearer can retry.
async function checkFit(audio: Uint8Array<ArrayBuffer>) {
  const thinking: State = { kind: 'thinking' }
  state = thinking
  await showText(bridge, 'Checking fit...')
  const t0 = performance.now()
  try {
    const result = await lookup(audio)
    const roundTrip = Math.round(performance.now() - t0)
    console.log(`lookup ${roundTrip} ms round trip`, result.timings, `"${result.transcript}"`)
    if (state !== thinking) return // backed out, maybe already listening to someone else
    if (result.only_wearer) return goIdle('Only heard you. Tap again as they start.')
    if (!result.card.name && !result.card.company) return goIdle("Didn't catch a name.")
    const checkable = (result.card.company || result.card.company_domain) && (result.card.relation ?? 'prospect') === 'prospect'
    const check: Check = checkable ? 'pending' : 'off'
    const shown: CardState = { kind: 'card', result, check, roleCheck: null, saving: false }
    state = shown
    // Start the role check before Save can be tapped, so any Save waits for it.
    const rendered = showCard(bridge, result.card, check)
    if (check === 'pending') shown.roleCheck = checkRole(shown, t0, rendered)
    await rendered
    // The simulator freezes a page that gets no events, so in fixture mode
    // keep mic events flowing while the card waits for the role check.
    // They're ignored outside listening; goIdle turns the mic off.
    if (FIXTURE && check === 'pending' && state === shown) await bridge.audioControl(true)
  } catch (err) {
    console.error('lookup failed:', err)
    if (state !== thinking) return
    state = { kind: 'failed', audio }
    await showText(bridge, "Couldn't check fit.\n\nTap to try again (no need to ask them).\nDouble-tap to skip.")
  }
}

// Second pass: verify their role and find who to ask for, then update the
// card in place if it's still on screen.
async function checkRole(shown: CardState, t0: number, rendered: Promise<void>): Promise<Final> {
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
  await rendered.catch(() => {}) // a fast answer must not update the page before it exists
  const before = actionsFor(shown.check)
  shown.result = { ...shown.result, card }
  shown.check = check
  if (state === shown) {
    // Several buyers found: rebuild once to add "Other buyer".
    if (actionsFor(check) !== before) await showCard(bridge, card, check)
    else await updateCard(bridge, card, check)
  }
  return { card, check }
}

// "Other buyer": ask for the next person found in a buyer role there. The
// person in front of you may say the first one left, or point to someone.
async function nextBuyer(shown: CardState) {
  const check = shown.check
  if (typeof check !== 'object' || !check.contact || !check.contacts || check.contacts.length < 2) return
  const i = check.contacts.findIndex(c => c.name === check.contact!.name)
  const next = withContact(shown.result.card, check, check.contacts[(i + 1) % check.contacts.length])
  shown.result = { ...shown.result, card: next.card }
  shown.check = next.check
  await updateCard(bridge, next.card, next.check)
}

// Saves on the glasses first, so a lead is never lost, then sends it to the
// backend, which drafts a follow-up email and adds both to Notion. The home
// screen shows at once and its first line updates when that finishes. A
// Save tapped while the role check runs waits for it before sending.
async function saveLead(shown: CardState) {
  if (shown.saving) return
  shown.saving = true
  const { result } = shown
  const savedAt = new Date().toISOString()
  const leads = await loadLeads()
  leads.push({ ...result.card, transcript: result.transcript, savedAt })
  await bridge.setLocalStorage('leads', JSON.stringify(leads))
  console.log(`saved lead #${leads.length}`, result.card)

  const who = result.card.name ?? 'lead'
  await goIdle(`Saved ${who}. Syncing...`)
  const idle = state
  if (FIXTURE) await bridge.audioControl(true) // keep the simulator awake (see above)
  let line = `Saved ${who}.`
  try {
    const t0 = performance.now()
    if (shown.roleCheck) await shown.roleCheck
    const { card } = shown.result
    const check = shown.check
    if (card !== result.card) await replaceLead(savedAt, { ...card, transcript: result.transcript, savedAt })
    const name = card.name ?? who
    const saved = await saveToBackend(card, typeof check === 'object' ? check : null, result.transcript)
    console.log(`lead sent in ${Math.round(performance.now() - t0)} ms`, saved)
    if (saved.notion === 'saved' && saved.again) line = `Met ${name} again: Notion updated.${saved.drafted ? '\nNew follow-up drafted.' : ''}`
    else if (saved.notion === 'saved') line = `Saved ${name} to Notion.${saved.drafted ? '\nFollow-up email drafted.' : ''}`
    else if (saved.notion === 'failed') line = `Saved ${name}. Notion failed.`
    else if (saved.drafted) line = `Saved ${name}. Follow-up email drafted.`
  } catch (err) {
    console.error('sending lead failed:', err)
    // The backend may have stored it before the connection failed.
    line = `Saved ${who} on glasses. Sync unconfirmed.`
  }
  if (FIXTURE) await bridge.audioControl(false)
  if (state === idle) await updateCardText(bridge, idleText(line))
}

// Swaps the glasses' copy of a lead for its role-checked version.
async function replaceLead(savedAt: string, lead: object) {
  const leads = (await loadLeads()) as { savedAt?: string }[]
  const i = leads.findIndex(l => l.savedAt === savedAt)
  if (i < 0) return
  leads[i] = lead
  await bridge.setLocalStorage('leads', JSON.stringify(leads))
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
    const action = actionsFor(state.check)[event.listEvent?.currentSelectItemIndex ?? 0]
    if (action === 'Save lead') void saveLead(state)
    else if (action === 'Other buyer') void nextBuyer(state)
    else void goIdle()
    return
  }

  const tapped = sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT
  if (!tapped) return
  if (state.kind === 'idle') void startListening()
  else if (state.kind === 'listening') state.capture.stop('tap')
  else if (state.kind === 'failed') void checkFit(state.audio)
})

await goIdle()
