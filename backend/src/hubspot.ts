import type { Lead } from './leads.ts'
import { ACTION_LABEL, action } from './score.ts'

// Saved leads can also go to HubSpot, the CRM most sales teams already use.
// Setup is one step: create a private app (Settings, Integrations, Private
// Apps) with the crm.objects.contacts read and write scopes, and put its
// token in HUBSPOT_TOKEN. Each lead becomes a contact, and each conversation
// a note on it with the verdict, who to ask for, the follow-up email and
// what they said.

const API = 'https://api.hubapi.com'
const NOTE_TO_CONTACT = 202 // HubSpot's built-in note-to-contact association

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const p = (s: string) => `<p>${esc(s)}</p>`

export function hubspot(token: string) {
  let account: Promise<{ portalId: number; uiDomain: string } | null> | null = null

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`HubSpot ${method} ${path} ${res.status}: ${await res.text()}`)
    return (res.status === 204 ? null : res.json()) as Promise<T>
  }

  // The account's id and domain, for links to a contact. A link is a nicety:
  // if this fails the save still counts.
  function accountInfo() {
    account ??= call<{ portalId: number; uiDomain?: string }>('GET', '/account-info/v3/details')
      .then(a => ({ portalId: a.portalId, uiDomain: a.uiDomain ?? 'app.hubspot.com' }))
      .catch(err => {
        console.error('hubspot account info failed:', err)
        account = null
        return null
      })
    return account
  }

  async function contactUrl(id: string) {
    const a = await accountInfo()
    return a ? `https://${a.uiDomain}/contacts/${a.portalId}/record/0-1/${id}` : null
  }

  // Contact fields. Lifecycle stage and lead status are only set when the
  // contact is created, so later changes made in HubSpot are kept.
  function properties(lead: Lead): Record<string, string> {
    const { card, verification: v } = lead
    const [first, ...rest] = (card.name ?? 'Unknown').trim().split(/\s+/)
    const props: Record<string, string> = { firstname: first }
    if (rest.length) props.lastname = rest.join(' ')
    const company = v?.company?.name ?? card.company
    if (company) props.company = company
    const title = card.checked_title ?? v?.person?.title ?? card.role
    if (title) props.jobtitle = title
    const domain = v?.company?.domain ?? card.company_domain
    if (domain) props.website = `https://${domain}`
    return props
  }

  function noteBody(lead: Lead, title: string) {
    const { card, verification: v } = lead
    const contact = v?.contact ? [v.contact.name, v.contact.title].filter(Boolean).join(', ') : null
    const email = lead.followUp
      ? [`<p><strong>Follow-up email (draft)</strong></p>`, p(`Subject: ${lead.followUp.subject}`), ...lead.followUp.body.split(/\n{2,}/).map(p)]
      : []
    return [
      `<p><strong>${esc(title)}: ${esc(ACTION_LABEL[action(card)])}</strong></p>`,
      p(card.why),
      contact ? p(`Ask for: ${contact}`) : '',
      p(`Next line to say: ${card.opener.replace(/^Ask:\s*/, '')}`),
      ...email,
      `<p><strong>What they said</strong></p>`,
      `<blockquote>${esc(lead.transcript)}</blockquote>`,
    ].join('')
  }

  async function addNote(contactId: string, lead: Lead, title: string) {
    await call('POST', '/crm/v3/objects/notes', {
      properties: { hs_timestamp: lead.savedAt, hs_note_body: noteBody(lead, title) },
      associations: [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: NOTE_TO_CONTACT }] }],
    })
  }

  async function addLead(lead: Lead): Promise<{ id: string; url: string | null }> {
    const contact = await call<{ id: string }>('POST', '/crm/v3/objects/contacts', {
      properties: { ...properties(lead), lifecyclestage: 'lead', hs_lead_status: 'NEW' },
    })
    await addNote(contact.id, lead, 'Met at an event (Handshake)')
    return { id: contact.id, url: await contactUrl(contact.id) }
  }

  // Met the same person again: refresh the contact and add a note.
  async function updateLead(contactId: string, lead: Lead): Promise<void> {
    await call('PATCH', `/crm/v3/objects/contacts/${contactId}`, { properties: properties(lead) })
    await addNote(contactId, lead, 'Met again (Handshake)')
  }

  // The wearer picked a different person to ask for: a note with the new email.
  async function switchContact(contactId: string, lead: Lead): Promise<void> {
    const who = lead.verification?.contact?.name
    await addNote(contactId, lead, who ? `Now asking for ${who}` : 'No intro needed')
  }

  // A lead removed on the phone: the contact goes to HubSpot's recycling bin.
  async function trash(contactId: string): Promise<void> {
    await call('DELETE', `/crm/v3/objects/contacts/${contactId}`)
  }

  return { addLead, updateLead, switchContact, trash }
}

export type HubSpot = ReturnType<typeof hubspot>
