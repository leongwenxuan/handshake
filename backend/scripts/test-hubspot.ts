// Checks the HubSpot client against a fake API: what it sends for a new lead,
// a repeat meeting, a new contact pick and a removal. No network, no token.
// Run: node backend/scripts/test-hubspot.ts
import assert from 'node:assert/strict'
import { hubspot } from '../src/hubspot.ts'
import type { Lead } from '../src/leads.ts'

const calls: { method: string; path: string; body: any; auth: string | null }[] = []
globalThis.fetch = (async (url: string, init: RequestInit) => {
  const path = new URL(url).pathname
  const method = init.method ?? 'GET'
  calls.push({ method, path, body: init.body ? JSON.parse(init.body as string) : null, auth: new Headers(init.headers).get('authorization') })
  const reply = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status })
  if (path === '/account-info/v3/details') return reply(200, { portalId: 123, uiDomain: 'app-eu1.hubspot.com' })
  if (method === 'POST' && path === '/crm/v3/objects/contacts') return reply(201, { id: '501' })
  if (method === 'POST' && path === '/crm/v3/objects/notes') return reply(201, { id: '900' })
  if (method === 'PATCH') return reply(200, { id: '501' })
  if (method === 'DELETE') return reply(204, null)
  return reply(404, { message: 'unexpected' })
}) as typeof fetch

const lead = {
  id: 'l1',
  card: {
    name: 'Nina Park', company: 'Bananapay', company_domain: 'bananapay.com', role: 'Partnerships', checked_title: 'Head of Partnerships',
    score: 7, buyer: null, company_fit: 'yes', fit: 'maybe', why: 'Good company, but partnerships does not buy a CRM.', opener: 'Ask: Could you intro me to Omar?', relation: 'prospect', competitor: null,
  },
  verification: { company: { name: 'Bananapay', domain: 'bananapay.com' }, person: { title: 'Head of Partnerships' }, contact: { name: 'Omar Reyes', title: 'RevOps lead' }, contacts: [] },
  transcript: "Hi, I'm Nina. I run partnerships at Bananapay.",
  savedAt: '2026-11-29T10:00:00.000Z',
  followUp: { subject: 'Great meeting you', body: 'Hi Nina,\n\nGood to meet you <3.\n\nBest,' },
  notion: null,
} as unknown as Lead

const hs = hubspot('pat-test')

// New lead: a contact, then a note linked to it, and a link to the record.
const saved = await hs.addLead(lead)
assert.deepEqual(saved, { id: '501', url: 'https://app-eu1.hubspot.com/contacts/123/record/0-1/501' })
const contact = calls.find(c => c.method === 'POST' && c.path === '/crm/v3/objects/contacts')!
assert.equal(contact.auth, 'Bearer pat-test')
assert.deepEqual(contact.body.properties, {
  firstname: 'Nina', lastname: 'Park', company: 'Bananapay', jobtitle: 'Head of Partnerships', website: 'https://bananapay.com', lifecyclestage: 'lead', hs_lead_status: 'NEW',
})
const note = calls.find(c => c.path === '/crm/v3/objects/notes')!
assert.equal(note.body.associations[0].to.id, '501')
assert.equal(note.body.associations[0].types[0].associationTypeId, 202)
assert.equal(note.body.properties.hs_timestamp, lead.savedAt)
const html: string = note.body.properties.hs_note_body
assert.match(html, /Get an intro/)
assert.match(html, /Ask for: Omar Reyes, RevOps lead/)
assert.match(html, /Next line to say: Could you intro me to Omar\?/)
assert.match(html, /Subject: Great meeting you/)
assert.match(html, /&lt;3/, 'text is escaped')
assert.match(html, /<blockquote>Hi, I'm Nina/)

// Met again: the contact is updated (without touching lead status) and gets a note.
calls.length = 0
await hs.updateLead('501', lead)
assert.equal(calls[0].method, 'PATCH')
assert.equal(calls[0].path, '/crm/v3/objects/contacts/501')
assert.equal(calls[0].body.properties.hs_lead_status, undefined)
assert.equal(calls[0].body.properties.lifecyclestage, undefined)
assert.match(calls[1].body.properties.hs_note_body, /Met again/)

// A different person to ask for: one note.
calls.length = 0
await hs.switchContact('501', lead)
assert.equal(calls.length, 1)
assert.match(calls[0].body.properties.hs_note_body, /Now asking for Omar Reyes/)

// Removed on the phone: the contact is deleted (HubSpot keeps it in the recycling bin).
calls.length = 0
await hs.trash('501')
assert.deepEqual([calls[0].method, calls[0].path], ['DELETE', '/crm/v3/objects/contacts/501'])

// A one-word name has no last name; an API error is reported with HubSpot's message.
calls.length = 0
await hs.addLead({ ...lead, card: { ...lead.card, name: 'Mia' }, verification: null } as Lead)
assert.deepEqual(Object.keys(calls[0].body.properties).sort(), ['company', 'firstname', 'hs_lead_status', 'jobtitle', 'lifecyclestage', 'website'])
globalThis.fetch = (async () => new Response('{"message":"This oauth-token is invalid"}', { status: 401 })) as unknown as typeof fetch
await assert.rejects(hubspot('bad').addLead(lead), /HubSpot POST \/crm\/v3\/objects\/contacts 401: .*invalid/)

console.log('hubspot: all checks passed')
