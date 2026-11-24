import { BACKEND_URL } from './api'

// The phone screen: set up the company profile the glasses judge people
// against. Runs without the glasses bridge, so it also works in a browser.

interface Buyer { role: string; kind: 'decision_maker' | 'champion' | 'user'; titles: string[]; why: string; pain: string }
interface Profile {
  company: string
  domain: string | null
  one_liner: string
  problem: string
  solution: string
  icp: { industries: string[]; company_size: string; stage: string; regions: string[]; signals: string[] }
  buyers: Buyer[]
  not_a_fit: string[]
  competitors?: string[]
  you?: string | null
  note: string | null
}

type SetupEvent =
  | { step: 'company'; found: boolean; detail: string | null }
  | { step: 'site'; found: boolean; detail: string | null }
  | { step: 'profile' }
  | { profile: Profile }
  | { error: string }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const form = $<HTMLFormElement>('setup')
const companyInput = $<HTMLInputElement>('company')
const noteInput = $<HTMLInputElement>('note')
const youInput = $<HTMLInputElement>('you')
const progress = $<HTMLOListElement>('progress')
let active: Profile | null = null // the profile on screen
const button = $<HTMLButtonElement>('build')
const status = $<HTMLParagraphElement>('status')
const section = $<HTMLElement>('profile')
const current = $<HTMLButtonElement>('current')
const panel = $<HTMLDivElement>('setup-panel')
const sheet = $<HTMLDialogElement>('sheet')

// Once a profile exists, setup moves into a sheet behind the company pill in
// the top bar, so the people you met come first.
function collapse(p: Profile) {
  active = p
  $('current-name').textContent = p.company
  $('current-logo').innerHTML =
    esc(p.company[0]?.toUpperCase() ?? '?') +
    (p.domain ? `<img src="https://icons.duckduckgo.com/ip3/${encodeURIComponent(p.domain)}.ico" alt="" onerror="this.remove()">` : '')
  current.hidden = false
  $('intro').hidden = true
  button.textContent = 'Rebuild'
  if (panel.parentElement !== $('sheet-body')) $('sheet-body').append(panel)
}

current.addEventListener('click', () => sheet.showModal())
$('sheet-close').addEventListener('click', () => sheet.close())
// Tapping the dimmed area outside the sheet closes it.
sheet.addEventListener('click', e => {
  if (e.target === sheet) sheet.close()
})

const KIND = { decision_maker: 'Decision maker', champion: 'Champion', user: 'User' }

function esc(s: string) {
  return s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
}

function setStatus(text: string, error = false) {
  status.textContent = text
  status.classList.toggle('error', error)
}

function render(p: Profile) {
  section.hidden = false
  section.innerHTML = `
    <div class="company card">
      <div class="name">${esc(p.company)}${p.domain ? `<span class="domain">${esc(p.domain)}</span>` : ''}</div>
      <p class="one">${esc(p.one_liner)}</p>
      <dl>
        <div><dt>Problem</dt><dd>${esc(p.problem)}</dd></div>
        <div><dt>Solution</dt><dd>${esc(p.solution)}</dd></div>
      </dl>
    </div>

    <h2>Who buys</h2>
    <div class="buyers">
      ${p.buyers
        .map(
          b => `<div class="buyer card">
            <div class="head"><span class="role">${esc(b.role)}</span><span class="kind">${KIND[b.kind]}</span></div>
            <p class="why">${esc(b.why)}</p>
            <p class="titles">${b.titles.map(esc).join(' · ')}</p>
          </div>`,
        )
        .join('')}
    </div>

    <h2>Ideal companies</h2>
    <div class="chips">
      ${[...p.icp.industries, p.icp.company_size, p.icp.stage, ...p.icp.regions].map(t => `<span>${esc(t)}</span>`).join('')}
    </div>

    <h2>Buying signals</h2>
    <ul>${p.icp.signals.map(s => `<li>${esc(s)}</li>`).join('')}</ul>

    <h2>Not a fit</h2>
    <ul>${p.not_a_fit.map(s => `<li>${esc(s)}</li>`).join('')}</ul>
    ${
      p.competitors?.length
        ? `<h2>Competitors</h2>
    <div class="chips">${p.competitors.map(c => `<span>${esc(c)}</span>`).join('')}</div>
    <p class="foot">People from these companies get a "Competitor" card instead of a pitch.</p>`
        : ''
    }

    <p class="foot">The glasses judge every introduction against this.${p.you ? ` Your own voice (${esc(p.you)}) is ignored.` : ''}</p>`
}

async function loadExisting() {
  try {
    const res = await fetch(`${BACKEND_URL}/profile`)
    const { profile } = (await res.json()) as { profile: Profile | null }
    if (!profile) return setStatus('No company yet. The glasses use the sample profile until you build one.')
    companyInput.value = profile.domain ?? profile.company
    noteInput.value = profile.note ?? ''
    youInput.value = profile.you ?? ''
    render(profile)
    collapse(profile)
  } catch {
    setStatus(`Can't reach the backend at ${BACKEND_URL}.`, true)
  }
}

// The three setup steps, shown as they happen.
function showSteps(company: string) {
  progress.hidden = false
  progress.innerHTML = [`Looking up ${esc(company)}`, 'Reading the website', 'Working out who buys']
    .map((t, i) => `<li class="${i === 0 ? 'active' : ''}"><span>${t} <span class="detail"></span></span></li>`)
    .join('')
}

function markStep(i: number, state: 'done' | 'miss' | 'active', label?: string, detail?: string | null) {
  const li = progress.children[i] as HTMLLIElement | undefined
  if (!li) return
  li.className = state
  if (label) (li.firstElementChild as HTMLElement).firstChild!.textContent = `${label} `
  ;(li.querySelector('.detail') as HTMLElement).textContent = detail ?? ''
}

async function build(company: string, note: string | null, you: string | null): Promise<Profile> {
  showSteps(company)
  const res = await fetch(`${BACKEND_URL}/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ company, note, you }),
  })
  if (!res.headers.get('Content-Type')?.includes('ndjson') || !res.body) {
    const body = (await res.json()) as { profile?: Profile; error?: string }
    if (!res.ok || !body.profile) throw new Error(body.error ?? `backend ${res.status}`)
    return body.profile
  }
  // One JSON object per line: progress steps, then the profile or an error.
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += value
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      const ev = JSON.parse(line) as SetupEvent
      if ('error' in ev) throw new Error(ev.error)
      if ('profile' in ev) {
        markStep(2, 'done', 'Worked out who buys')
        return ev.profile
      }
      if (ev.step === 'company') {
        markStep(0, ev.found ? 'done' : 'miss', ev.found ? 'Found' : 'No database match for', ev.detail ?? company)
        markStep(1, 'active')
      } else if (ev.step === 'site') {
        markStep(1, ev.found ? 'done' : 'miss', ev.found ? 'Read' : "Couldn't read", ev.detail ?? 'the website')
      } else if (ev.step === 'profile') {
        markStep(2, 'active', 'Working out who buys...')
      }
    }
  }
  throw new Error('Setup stopped before it finished. Try again.')
}

form.addEventListener('submit', async e => {
  e.preventDefault()
  const company = companyInput.value.trim()
  if (!company) return companyInput.focus()
  const note = noteInput.value.trim() || null
  const you = youInput.value.trim() || null
  button.disabled = true
  setStatus('')
  try {
    // Same company and focus: only the name changed, so don't rebuild.
    const sameCompany = active && (company === active.domain || company.toLowerCase() === active.company.toLowerCase())
    let profile: Profile
    if (active && sameCompany && (active.note ?? null) === note && (active.you ?? null) !== you) {
      const res = await fetch(`${BACKEND_URL}/profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company, you, only: 'you' }),
      })
      const body = (await res.json()) as { profile?: Profile; error?: string }
      if (!res.ok || !body.profile) throw new Error(body.error ?? `backend ${res.status}`)
      profile = body.profile
    } else {
      profile = await build(company, note, you)
    }
    render(profile)
    collapse(profile)
    setTimeout(() => (progress.hidden = true), 2500)
    setStatus('Ready. Tap the ring as someone starts introducing themselves.')
  } catch (err) {
    progress.hidden = true
    setStatus((err as Error).message, true)
  } finally {
    button.disabled = false
  }
})

void loadExisting()
