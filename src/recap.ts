import { glyph } from './badge'
import { ACTION_LABEL, BACKEND_URL, action, type Action, type Card, type Verification } from './api'

// The phone's "People you met" list: every lead saved from the glasses,
// grouped by what to do next (pitch, get an intro, find out more). Each row opens to who to ask for, the
// drafted email and what they said. Refreshes while the page is open, so a
// save on the glasses shows up here.

interface Lead {
  id: string
  card: Card
  verification: Verification | null
  transcript: string
  savedAt: string
  followUp: { subject: string; body: string } | null
  notion: { id: string; url: string } | null
  hubspot?: { id: string; url: string | null } | null
  meetings?: number
}

const section = document.getElementById('leads') as HTMLElement
let shown = ''
let leads: Lead[] = []
let known: Set<string> | null = null // lead ids seen so far; null before the first load
const freshUntil = new Map<string, number>() // new lead id -> when its highlight ends
const open = new Set<string>() // rows the wearer opened

function esc(s: string) {
  return s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
}

// The groups, in order. Competitors and colleagues sit with "Not a fit":
// none of them gets a sales follow-up.
const GROUPS: { title: string; has: Action[] }[] = [
  { title: 'Pitch them', has: ['pitch'] },
  { title: 'Get an intro', has: ['intro'] },
  { title: 'Not sure yet', has: ['unsure'] },
  { title: 'Not a fit', has: ['pass', 'competitor', 'colleague'] },
]

const byScore = (a: Lead, b: Lead) => (b.card.score ?? -1) - (a.card.score ?? -1) || b.savedAt.localeCompare(a.savedAt)
const verdict = (card: Card) => ACTION_LABEL[action(card)]

// The same ring as the glasses' badge: the next step as one mark.
function ring(card: Card) {
  const { text, fill } = glyph(card)
  const r = 16
  const c = 2 * Math.PI * r
  return `<span class="ring" aria-label="${esc(verdict(card))}">
    <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
      <circle class="track" cx="20" cy="20" r="${r}" fill="none" stroke-width="3.5"/>
      ${fill ? `<circle class="fill" cx="20" cy="20" r="${r}" fill="none" stroke-width="3.5" stroke-dasharray="${fill * c} ${c}"/>` : ''}
    </svg>
    <b>${text}</b>
  </span>`
}

function logo(l: Lead) {
  const v = l.verification
  const company = v?.company?.name ?? l.card.company
  const domain = v?.company?.domain ?? l.card.company_domain
  const initial = esc((company ?? l.card.name ?? '?').trim()[0]?.toUpperCase() ?? '?')
  // Company logo by domain; the initial shows if there's none.
  return `<span class="logo" aria-hidden="true">${initial}${
    domain ? `<img src="https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico" alt="" loading="lazy" onerror="this.remove()">` : ''
  }</span>`
}

// Who to ask for an intro. With several buyers found there, the others are
// one tap away, and so is no one; picking redrafts the email.
function askFor(l: Lead) {
  const v = l.verification
  const all = v?.contacts ?? []
  const pick = v?.contact ?? null
  if (!pick && all.length === 0) return ''
  const others = all.filter(c => c.name !== pick?.name)
  const label = (c: { name: string; title: string | null }) => `${esc(c.name)}${c.title ? `<small>${esc(c.title)}</small>` : ''}`
  const buttons = [
    ...others.map(c => `<button type="button" class="chip" data-lead="${esc(l.id)}" data-name="${esc(c.name)}">${label(c)}</button>`),
    pick && all.length ? `<button type="button" class="chip none" data-lead="${esc(l.id)}" data-name="">No one</button>` : '',
  ].join('')
  return `<div class="block">
    <h3>${pick ? 'Ask them for an intro to' : 'No intro asked for'}</h3>
    ${pick ? `<p class="ask">${esc(pick.name)}${pick.title ? `<small>${esc(pick.title)}</small>` : ''}</p>` : ''}
    ${buttons ? `<div class="pick" aria-label="${pick ? 'Or ask for' : 'Ask for'}">${buttons}</div>` : ''}
  </div>`
}

function leadHTML(l: Lead, fresh: boolean) {
  const { card, verification: v } = l
  const company = v?.company?.name ?? card.company
  const time = new Date(l.savedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const tone = `is-${action(card)}`
  const isOpen = open.has(l.id) || fresh
  const tags = [
    `<span class="tag verdict">${verdict(card)}</span>`,
    card.checked_title ? `<span class="tag ok">✓ ${esc(card.checked_title)}</span>` : card.role ? `<span class="tag">${esc(card.role)}</span>` : '',
    card.buyer ? `<span class="tag">Buyer: ${esc(card.buyer)}</span>` : '',
    v?.company?.employees ? `<span class="tag">${v.company.employees.toLocaleString()} people</span>` : '',
  ].join('')
  const email = l.followUp
  const mailto = email ? `mailto:?subject=${encodeURIComponent(email.subject)}&body=${encodeURIComponent(email.body)}` : null
  const again = (l.meetings ?? 1) > 1 ? ` · met ${l.meetings} times` : ''
  return `<article class="lead ${tone}${fresh ? ' new' : ''}${isOpen ? ' open' : ''}" data-id="${esc(l.id)}">
    <button type="button" class="row" aria-expanded="${isOpen}">
      ${logo(l)}
      <span class="text">
        <span class="who">${esc(card.name ?? 'Unknown')}${company ? ` <span class="at">· ${esc(company)}</span>` : ''}</span>
        <span class="why">${esc(card.why)}</span>
        ${v?.contact ? `<span class="intro">Ask for ${esc(v.contact.name)}</span>` : ''}
      </span>
      ${ring(card)}
    </button>
    <div class="detail">
      <div class="tags">${tags}</div>
      ${askFor(l)}
      ${
        email
          ? `<div class="block mail">
              <h3>Follow-up email</h3>
              <p class="subject">${esc(email.subject)}</p>
              <pre>${esc(email.body)}</pre>
              <div class="actions">
                <a class="btn primary" href="${mailto}">Open in Mail</a>
                <button type="button" class="btn" data-copy="${esc(l.id)}">Copy</button>
              </div>
            </div>`
          : ''
      }
      <div class="block"><h3>What they said</h3><p class="quote">“${esc(l.transcript)}”</p></div>
      <div class="meta"><span>Met ${time}${again}</span><span class="links"><button type="button" class="remove" data-remove="${esc(l.id)}">Remove</button>${l.notion ? `<a href="${esc(l.notion.url)}" target="_blank" rel="noopener">Open in Notion ↗</a>` : ''}${l.hubspot?.url ? `<a href="${esc(l.hubspot.url)}" target="_blank" rel="noopener">Open in HubSpot ↗</a>` : ''}</span></div>
    </div>
  </article>`
}

function stats(list: Lead[]) {
  const pitch = list.filter(l => action(l.card) === 'pitch').length
  const intros = list.filter(l => action(l.card) === 'intro').length
  return [
    `<span class="stat"><b>${list.length}</b> met</span>`,
    pitch ? `<span class="stat good"><b>${pitch}</b> to pitch</span>` : '',
    intros ? `<span class="stat good"><b>${intros}</b> intro${intros === 1 ? '' : 's'} to get</span>` : '',
  ].join('')
}

function draw() {
  const now = Date.now()
  section.hidden = false
  if (!leads.length) {
    section.innerHTML = `<h1>People you met</h1>
      <div class="empty">
        <svg width="36" height="36" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="36 48" stroke-linecap="round" transform="rotate(-90 10 10)"/></svg>
        <strong>No one yet</strong>
        Tap the ring as someone starts introducing themselves, then Save. They land here with a follow-up email.
      </div>`
    return
  }
  const fresh = new Set(leads.filter(l => (freshUntil.get(l.id) ?? 0) > now).map(l => l.id))
  const sorted = [...leads].sort(byScore)
  const groups = GROUPS.map(g => {
    const list = sorted.filter(l => g.has.includes(action(l.card)))
    return list.length ? `<p class="label">${g.title}</p><div class="list">${list.map(l => leadHTML(l, fresh.has(l.id))).join('')}</div>` : ''
  })
  section.innerHTML = `<h1>People you met</h1>
    <div class="stats">${stats(leads)}</div>
    ${groups.join('')}`
}

section.addEventListener('click', e => {
  const target = e.target as HTMLElement
  const pick = target.closest<HTMLButtonElement>('[data-lead]')
  if (pick) return void switchContact(pick)
  const remove = target.closest<HTMLButtonElement>('[data-remove]')
  if (remove) return void removeLead(remove)
  const copy = target.closest<HTMLButtonElement>('[data-copy]')
  if (copy) return void copyEmail(copy)
  const row = target.closest<HTMLButtonElement>('.row')
  if (!row) return
  const article = row.closest<HTMLElement>('.lead')!
  const id = article.dataset.id!
  const nowOpen = !article.classList.contains('open')
  if (nowOpen) open.add(id)
  else {
    open.delete(id)
    freshUntil.delete(id) // closing a new lead's row ends its highlight
    article.classList.remove('new')
  }
  article.classList.toggle('open', nowOpen)
  row.setAttribute('aria-expanded', String(nowOpen))
})

async function copyEmail(button: HTMLButtonElement) {
  const lead = leads.find(l => l.id === button.dataset.copy)
  if (!lead?.followUp) return
  try {
    await navigator.clipboard.writeText(`${lead.followUp.subject}\n\n${lead.followUp.body}`)
    button.textContent = 'Copied'
  } catch {
    // WebViews may block the clipboard: select the text instead.
    const pre = button.closest('.mail')?.querySelector('pre')
    if (pre) getSelection()?.selectAllChildren(pre)
    button.textContent = 'Selected'
  }
  setTimeout(() => (button.textContent = 'Copy'), 1500)
}

async function switchContact(button: HTMLButtonElement) {
  const box = button.closest('.pick')!
  box.querySelectorAll('button').forEach(b => (b.disabled = true))
  button.classList.add('busy')
  const id = button.dataset.lead!
  try {
    const res = await fetch(`${BACKEND_URL}/leads/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name: button.dataset.name || null }),
    })
    if (!res.ok) throw new Error(await res.text())
    open.add(id) // keep the row open on its new email
  } catch (err) {
    console.error('switch contact failed:', err)
    box.querySelectorAll('button').forEach(b => (b.disabled = false))
    button.classList.remove('busy')
    return
  }
  shown = ''
  await refresh()
}

// Two taps: the first arms the button, so a stray tap can't delete anyone.
async function removeLead(button: HTMLButtonElement) {
  if (!button.classList.contains('armed')) {
    button.classList.add('armed')
    button.textContent = 'Remove?'
    setTimeout(() => {
      button.classList.remove('armed')
      button.textContent = 'Remove'
    }, 3000)
    return
  }
  button.disabled = true
  button.textContent = 'Removing...'
  try {
    const res = await fetch(`${BACKEND_URL}/leads/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: button.dataset.remove }),
    })
    if (!res.ok) throw new Error(await res.text())
  } catch (err) {
    console.error('remove failed:', err)
    button.disabled = false
    button.textContent = 'Remove'
    button.classList.remove('armed')
    return
  }
  open.delete(button.dataset.remove!)
  shown = ''
  await refresh()
}

async function refresh() {
  let next: Lead[]
  try {
    const res = await fetch(`${BACKEND_URL}/leads`)
    next = ((await res.json()) as { leads: Lead[] }).leads
  } catch {
    return // the setup section already reports an unreachable backend
  }
  const key = JSON.stringify(next.map(l => [l.id, !!l.notion, !!l.hubspot, l.followUp?.body ?? null, l.verification?.contact?.name ?? null]))
  if (key === shown) return // nothing changed: don't redraw under the reader
  shown = key
  // The lead first appears before its email and Notion row are ready, so the
  // highlight lasts a minute rather than one redraw.
  const now = Date.now()
  if (known) for (const l of next) if (!known.has(l.id)) freshUntil.set(l.id, now + 60_000)
  known = new Set(next.map(l => l.id)) // an empty first load is the baseline too
  leads = next
  draw()
}

void refresh()
setInterval(() => {
  if (document.visibilityState === 'visible') void refresh()
}, 5000)
