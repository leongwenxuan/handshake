import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'

// Mic check: tap toggles the microphone; the glasses show how much PCM has
// arrived and the current loudness. Proves audio reaches the app before any
// speech-to-text is wired up.

const bridge = await waitForEvenAppBridge()

const CONTAINER_ID = 1
const CONTAINER_NAME = 'main'

const created = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({
    containerTotalNum: 1,
    textObject: [
      new TextContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: 576,
        height: 288,
        borderWidth: 0,
        borderColor: 5,
        paddingLength: 4,
        containerID: CONTAINER_ID,
        containerName: CONTAINER_NAME,
        content: 'Handshake mic check\nTap to start listening',
        isEventCapture: 1,
      }),
    ],
  }),
)
console.log('Page created:', created === 0 ? 'success' : `failed (${created})`)

let micOn = false
let bytes = 0
let chunks = 0
let level = 0
let renderTimer: number | null = null

// Root-mean-square loudness of one s16le chunk, 0..1.
function rms(pcm: Uint8Array): number {
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

function render() {
  const seconds = (bytes / 32000).toFixed(1) // 16 kHz * 2 bytes
  const bar = '#'.repeat(Math.min(30, Math.round(level * 150)))
  const content = micOn
    ? `Listening\n${seconds}s audio, ${chunks} chunks\nLevel ${bar}\nTap to stop`
    : `Stopped\n${seconds}s audio, ${chunks} chunks\nTap to start`
  bridge.textContainerUpgrade(
    new TextContainerUpgrade({ containerID: CONTAINER_ID, containerName: CONTAINER_NAME, content }),
  )
}

// Debounce glasses writes; the display queue can't take one per audio chunk.
function scheduleRender() {
  if (renderTimer !== null) return
  renderTimer = window.setTimeout(() => {
    renderTimer = null
    render()
  }, 150)
}

function toggleMic() {
  micOn = !micOn
  bridge.audioControl(micOn)
  console.log(micOn ? 'Mic on' : `Mic off after ${bytes} bytes in ${chunks} chunks`)
  scheduleRender()
}

// CLICK_EVENT is 0 and protobuf drops zero values, so a tap arrives with
// eventType undefined. Resolve the default inside the envelope check, or
// every audio frame (which has no sysEvent) would read as a tap.
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

const unsubscribe = bridge.onEvenHubEvent(event => {
  const pcm = event.audioEvent?.audioPcm
  if (pcm) {
    bytes += pcm.byteLength
    chunks += 1
    level = rms(pcm)
    scheduleRender()
    return
  }

  const sysType = eventTypeOf(event.sysEvent)
  const textType = eventTypeOf(event.textEvent)

  if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    bridge.shutDownPageContainer(1)
    return
  }

  if (sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT) {
    toggleMic()
    return
  }

  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    if (micOn) bridge.audioControl(false)
    unsubscribe()
  }
})
