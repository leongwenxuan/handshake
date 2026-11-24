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
}

const section = document.getElementById('leads') as HTMLElement
const FIT_ORDER = { strong: 0, maybe: 1, weak: 2, unknown: 3 }
let shown = ''

function esc(s: string) {
  return s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
}

function sortLeads(leads: Lead[]) {
  return [...leads].sort(
    (a, b) => FIT_ORDER[a.card.fit] - FIT_ORDER[b.card.fit] || (b.card.score ?? -1) - (a.card.score ?? -1) || b.savedAt.localeCompare(a.savedAt),
  )
}

function summary(leads: Lead[]) {
  const strong = leads.filter(l => l.card.fit === 'strong').length
  const intros = leads.filter(l => l.verification?.contact).length
  const parts = [`${leads.length} ${leads.length === 1 ? 'person' : 'people'}`, `${strong} strong fit`]
  if (intros) parts.push(`${intros} intro${intros === 1 ? '' : 's'} to ask for`)
  return parts.join(' · ')
}

function leadHTML(l: Lead, i: number) {
  const { card, verification: v } = l
  const company = v?.company?.name ?? card.company
  const time = new Date(l.savedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const verdict = card.fit === 'unknown' || card.score === null ? 'Not sure' : `${card.fit[0].toUpperCase()}${card.fit.slice(1)} ${card.score}/10`
  const facts = [
    card.checked_title ? `<span class="ok">Verified: ${esc(card.checked_title)}</span>` : card.role ? esc(card.role) : null,
    card.buyer ? `Buyer: ${esc(card.buyer)}` : null,
    v?.company?.employees ? `${v.company.employees.toLocaleString()} people` : null,
  ].filter(Boolean)
  const email = l.followUp
  const mailto = email ? `mailto:?subject=${encodeURIComponent(email.subject)}&body=${encodeURIComponent(email.body)}` : null
  return `<article class="lead card fit-${card.fit}">
    <div class="top">
      <div><span class="who">${esc(card.name ?? 'Unknown')}</span>${company ? `<span class="at">${esc(company)}</span>` : ''}</div>
      <span class="badge">${verdict}</span>
    </div>
    ${facts.length ? `<p class="facts">${facts.join(' · ')}</p>` : ''}
    <p class="why">${esc(card.why)}</p>
    ${v?.contact ? `<p class="ask">Ask for ${esc(v.contact.name)}${v.contact.title ? `, ${esc(v.contact.title)}` : ''}</p>` : ''}
    ${
      email
        ? `<details>
            <summary>Follow-up email</summary>
            <p class="subject">${esc(email.subject)}</p>
            <pre id="mail-${i}">${esc(email.body)}</pre>
            <div class="actions">
              <button type="button" data-copy="${i}">Copy</button>
              <a class="btn" href="${mailto}">Open in Mail</a>
              ${l.notion ? `<a class="btn" href="${esc(l.notion.url)}" target="_blank" rel="noopener">Notion</a>` : ''}
            </div>
          </details>`
        : l.notion
          ? `<div class="actions"><a class="btn" href="${esc(l.notion.url)}" target="_blank" rel="noopener">Notion</a></div>`
          : ''
    }
    <p class="time">Met ${time}</p>
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
  if (!leads.length) {
    section.hidden = true
    return
  }
  const sorted = sortLeads(leads)
  section.hidden = false
  section.innerHTML = `<h2>People you met</h2>
    <p class="summary">${summary(leads)}</p>
    <div class="leads">${sorted.map(leadHTML).join('')}</div>`
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
