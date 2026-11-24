import { BACKEND_URL, type Card, type Verification } from './api'

// The phone's "People you met" list: every lead saved from the glasses,
// best fit first, with the drafted follow-up ready to copy or send.
// Refreshes while the page is open, so a save on the glasses shows up here.

interface Lead {
  id: string
  card: Card
  verification: Verification | null
  transcript: string
  savedAt: string
  followUp: { subject: string; body: string } | null
  notion: { id: string; url: string } | null
  meetings?: number
}

const section = document.getElementById('leads') as HTMLElement
const FIT_ORDER = { strong: 0, maybe: 1, weak: 2, unknown: 3 }
let shown = ''
let known: Set<string> | null = null // lead ids seen so far; null before the first load
const freshUntil = new Map<string, number>() // new lead id -> when its highlight ends

function esc(s: string) {
  return s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
}

// Colleagues and competitors go last, whatever the model scored them.
const rank = (l: Lead) => ((l.card.relation ?? 'prospect') === 'prospect' ? FIT_ORDER[l.card.fit] : 4)

function sortLeads(leads: Lead[]) {
  return [...leads].sort(
    (a, b) => rank(a) - rank(b) || (b.card.score ?? -1) - (a.card.score ?? -1) || b.savedAt.localeCompare(a.savedAt),
  )
}

function summary(leads: Lead[]) {
  const strong = leads.filter(l => l.card.fit === 'strong' && (l.card.relation ?? 'prospect') === 'prospect').length
  const intros = leads.filter(l => l.verification?.contact).length
  const parts = [`${leads.length} ${leads.length === 1 ? 'person' : 'people'}`, `${strong} strong fit`]
  if (intros) parts.push(`${intros} intro${intros === 1 ? '' : 's'} to ask for`)
  return parts.join(' · ')
}

function leadHTML(l: Lead, i: number, fresh: boolean) {
  const { card, verification: v } = l
  const company = v?.company?.name ?? card.company
  const time = new Date(l.savedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const other = card.relation === 'competitor' || card.relation === 'colleague'
  const verdict = other
    ? card.relation === 'competitor' ? 'Competitor' : 'Colleague'
    : card.fit === 'unknown' || card.score === null ? 'Not sure' : `${card.fit[0].toUpperCase()}${card.fit.slice(1)} ${card.score}/10`
  const domain = v?.company?.domain ?? card.company_domain
  const initial = esc((company ?? card.name ?? '?').trim()[0]?.toUpperCase() ?? '?')
  // Company logo by domain; the initial shows if there's none.
  const logo = `<span class="logo" aria-hidden="true">${initial}${
    domain ? `<img src="https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico" alt="" loading="lazy" onerror="this.remove()">` : ''
  }</span>`
  const bar = !other && card.score !== null ? `<span class="bar"><span style="width:${card.score * 10}%"></span></span>` : ''
  const again = (l.meetings ?? 1) > 1 ? ` · met ${l.meetings} times` : ''
  const facts = [
    card.checked_title ? `<span class="ok">Verified: ${esc(card.checked_title)}</span>` : card.role ? esc(card.role) : null,
    card.buyer ? `Buyer: ${esc(card.buyer)}` : null,
    v?.company?.employees ? `${v.company.employees.toLocaleString()} people` : null,
  ].filter(Boolean)
  const email = l.followUp
  const mailto = email ? `mailto:?subject=${encodeURIComponent(email.subject)}&body=${encodeURIComponent(email.body)}` : null
  return `<article class="lead card ${other ? 'other' : `fit-${card.fit}`}${fresh ? ' new' : ''}">
    <div class="top">
      <div class="ident">${logo}<div><span class="who">${esc(card.name ?? 'Unknown')}</span>${company ? `<span class="at">${esc(company)}</span>` : ''}</div></div>
      <span class="score"><span class="badge">${verdict}</span>${bar}</span>
    </div>
    ${facts.length ? `<p class="facts">${facts.join(' · ')}</p>` : ''}
    <p class="why">${esc(card.why)}</p>
    ${v?.contact ? `<p class="ask">Ask for ${esc(v.contact.name)}${v.contact.title ? `, ${esc(v.contact.title)}` : ''}</p>` : ''}
    ${
      email
        ? `<details${fresh ? ' open' : ''}>
            <summary>Follow-up email</summary>
            <p class="subject">${esc(email.subject)}</p>
            <pre id="mail-${i}">${esc(email.body)}</pre>
            <div class="actions">
              <button type="button" data-copy="${i}">Copy</button>
              <a class="btn" href="${mailto}">Open in Mail</a>
            </div>
          </details>`
        : ''
    }
    <div class="meta"><span>Met ${time}${again}</span>${l.notion ? `<a href="${esc(l.notion.url)}" target="_blank" rel="noopener">Open in Notion</a>` : ''}</div>
  </article>`
}

async function refresh() {
  let leads: Lead[]
  try {
    const res = await fetch(`${BACKEND_URL}/leads`)
    leads = ((await res.json()) as { leads: Lead[] }).leads
  } catch {
    return // the setup section already reports an unreachable backend
  }
  const key = JSON.stringify(leads.map(l => [l.id, !!l.notion, !!l.followUp]))
  if (key === shown) return // don't redraw (it would close an open email)
  shown = key
  // The lead first appears before its email and Notion row are ready, so the
  // highlight lasts a minute rather than one redraw.
  const now = Date.now()
  if (known) for (const l of leads) if (!known.has(l.id)) freshUntil.set(l.id, now + 60_000)
  known = new Set(leads.map(l => l.id)) // an empty first load is the baseline too
  if (!leads.length) {
    section.hidden = false
    section.innerHTML = `<h2>People you met</h2><p class="empty">No one yet. Tap the ring as someone starts introducing themselves, then Save; they show up here with a follow-up email.</p>`
    return
  }
  const sorted = sortLeads(leads)
  // A lead that arrived while the page was open is outlined with its email
  // open, so a save on the glasses visibly lands here.
  const fresh = new Set(leads.filter(l => (freshUntil.get(l.id) ?? 0) > now).map(l => l.id))
  section.hidden = false
  section.innerHTML = `<h2>People you met</h2>
    <p class="summary">${summary(leads)}</p>
    <div class="leads">${sorted.map((l, i) => leadHTML(l, i, fresh.has(l.id))).join('')}</div>`
  section.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach(button => {
    button.addEventListener('click', async () => {
      const lead = sorted[Number(button.dataset.copy)]
      const text = `${lead.followUp!.subject}\n\n${lead.followUp!.body}`
      try {
        await navigator.clipboard.writeText(text)
        button.textContent = 'Copied'
      } catch {
        // WebViews may block the clipboard: select the text instead.
        const pre = document.getElementById(`mail-${button.dataset.copy}`)!
        getSelection()?.selectAllChildren(pre)
        button.textContent = 'Selected'
      }
      setTimeout(() => (button.textContent = 'Copy'), 1500)
    })
  })
}

void refresh()
setInterval(() => {
  if (document.visibilityState === 'visible') void refresh()
}, 5000)
