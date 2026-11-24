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
  note: string | null
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const form = $<HTMLFormElement>('setup')
const companyInput = $<HTMLInputElement>('company')
const noteInput = $<HTMLInputElement>('note')
const button = $<HTMLButtonElement>('build')
const status = $<HTMLParagraphElement>('status')
const section = $<HTMLElement>('profile')

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
            <div class="top"><span class="role">${esc(b.role)}</span><span class="kind">${KIND[b.kind]}</span></div>
            <p class="why">${esc(b.why)}</p>
            <p class="titles">${b.titles.map(esc).join(' · ')}</p>
          </div>`,
        )
        .join('')}
    </div>

    <h2>Ideal companies</h2>
    <div class="chips">
      ${[...p.icp.industries, p.icp.company_size, p.icp.stage, ...p.icp.regions].map(t => `<span class="chip">${esc(t)}</span>`).join('')}
    </div>

    <h2>Buying signals</h2>
    <ul>${p.icp.signals.map(s => `<li>${esc(s)}</li>`).join('')}</ul>

    <h2>Not a fit</h2>
    <ul>${p.not_a_fit.map(s => `<li>${esc(s)}</li>`).join('')}</ul>

    <p class="foot">The glasses use this for every introduction. Build again to change it.</p>`
}

async function loadExisting() {
  try {
    const res = await fetch(`${BACKEND_URL}/profile`)
    const { profile } = (await res.json()) as { profile: Profile | null }
    if (!profile) return setStatus('No company yet. The glasses use the sample profile until you build one.')
    companyInput.value = profile.domain ?? profile.company
    noteInput.value = profile.note ?? ''
    render(profile)
  } catch {
    setStatus(`Can't reach the backend at ${BACKEND_URL}.`, true)
  }
}

form.addEventListener('submit', async e => {
  e.preventDefault()
  const company = companyInput.value.trim()
  if (!company) return companyInput.focus()
  button.disabled = true
  setStatus(`Reading ${company} and working out who buys… (about 6 s)`)
  try {
    const res = await fetch(`${BACKEND_URL}/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company, note: noteInput.value.trim() || undefined }),
    })
    const body = (await res.json()) as { profile?: Profile; error?: string }
    if (!res.ok || !body.profile) throw new Error(body.error ?? `backend ${res.status}`)
    render(body.profile)
    setStatus('Ready. Tap the ring when someone introduces themselves.')
  } catch (err) {
    setStatus((err as Error).message, true)
  } finally {
    button.disabled = false
  }
})

void loadExisting()
