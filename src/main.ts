import { waitForEvenAppBridge, OsEventTypeList } from '@evenrealities/even_hub_sdk'
import { showCard, showText, CARD_ACTIONS } from './glasses'
import { Capture, type StopReason } from './listen'
import { cardText, lookup, type LookupResult } from './api'

// Flow: idle --tap--> listening --silence/tap--> thinking --> card --Save/Skip--> idle
// Double-tap: from idle exits the app; from anywhere else goes back to idle.

type State =
  | { kind: 'idle' }
  | { kind: 'listening'; capture: Capture }
  | { kind: 'thinking' }
  | { kind: 'card'; result: LookupResult }

const bridge = await waitForEvenAppBridge()
let state: State = { kind: 'idle' }

const IDLE_TEXT = 'Handshake\n\nTap when someone introduces themselves.'

async function goIdle(message?: string) {
  state = { kind: 'idle' }
  await showText(bridge, message ? `${message}\n\n${IDLE_TEXT}` : IDLE_TEXT)
}

async function startListening() {
  const capture = new Capture(reason => void finishListening(capture, reason))
  state = { kind: 'listening', capture }
  await showText(bridge, 'Listening...\n\nTap when they finish.')
  await bridge.audioControl(true)
}

async function finishListening(capture: Capture, reason: StopReason) {
  if (state.kind !== 'listening' || state.capture !== capture) return
  await bridge.audioControl(false)
  const micDelay = capture.firstChunkAt === null ? null : Math.round(capture.firstChunkAt - capture.startedAt)
  console.log(`capture stopped: ${reason}, ${capture.elapsedMs} ms audio, first chunk after ${micDelay} ms`)

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
    state = { kind: 'card', result }
    await showCard(bridge, cardText(result.card))
  } catch (err) {
    console.error('lookup failed:', err)
    if (state.kind === 'thinking') await goIdle('Lookup failed. Try again.')
  }
}

async function saveLead(result: LookupResult) {
  const leads = await loadLeads()
  leads.push({ ...result.card, transcript: result.transcript, savedAt: new Date().toISOString() })
  await bridge.setLocalStorage('leads', JSON.stringify(leads))
  console.log(`saved lead #${leads.length}`, result.card)
  await goIdle(`Saved ${result.card.name ?? 'lead'}.`)
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
    if (action === 'Save lead') void saveLead(state.result)
    else void goIdle()
    return
  }

  const tapped = sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT
  if (!tapped) return
  if (state.kind === 'idle') void startListening()
  else if (state.kind === 'listening') state.capture.stop('tap')
})

await goIdle()
