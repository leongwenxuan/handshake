// The phone's live pill: what the glasses are doing right now, so whoever
// holds the phone (or watches a demo) sees the same moment as the wearer.
// main.ts announces states; this file draws them. Nothing shows in a plain
// browser, where there are no glasses.

export type Live =
  | { kind: 'idle'; text: string }
  | { kind: 'listening' }
  | { kind: 'busy'; text: string }
  | { kind: 'card'; text: string }
  | { kind: 'error'; text: string }

const EVENT = 'handshake:live'

export function announce(state: Live) {
  window.dispatchEvent(new CustomEvent<Live>(EVENT, { detail: state }))
}

const pill = document.getElementById('live')
let timer: ReturnType<typeof setInterval> | undefined

if (pill) {
  const msg = pill.querySelector('.msg') as HTMLElement
  const time = pill.querySelector('.time') as HTMLElement
  window.addEventListener(EVENT, e => {
    const state = (e as CustomEvent<Live>).detail
    clearInterval(timer)
    time.textContent = ''
    pill.hidden = false
    pill.className = `live ${state.kind}`
    if (state.kind === 'listening') {
      msg.textContent = 'Listening'
      const start = Date.now()
      const tick = () => {
        const s = Math.floor((Date.now() - start) / 1000)
        time.textContent = `0:${String(s).padStart(2, '0')}`
      }
      tick()
      timer = setInterval(tick, 500)
    } else {
      msg.textContent = state.text
    }
  })
}
