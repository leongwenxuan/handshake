import type { Lead } from './leads.ts'

// Saved leads go to a "Handshake leads" database in the wearer's Notion.
// Setup is one step: create an internal integration, put its secret in
// NOTION_TOKEN, and connect it to any page. The database is found or created
// under that page on the first save.

const API = 'https://api.notion.com/v1'
const VERSION = '2025-09-03' // databases hold data sources from this version
const DB_TITLE = 'Handshake leads'

export interface NotionTarget {
  database_id: string
  data_source_id: string
  url: string | null
}

const text = (s: string | null | undefined) => (s ? [{ type: 'text', text: { content: s.slice(0, 2000) } }] : [])

const SCHEMA = {
  Name: { title: {} },
  Company: { rich_text: {} },
  Role: { rich_text: {} },
  Verified: { rich_text: {} },
  Fit: {
    select: {
      options: [
        { name: 'Strong', color: 'green' },
        { name: 'Maybe', color: 'yellow' },
        { name: 'Weak', color: 'gray' },
        { name: 'Unknown', color: 'default' },
      ],
    },
  },
  Score: { number: {} },
  Buyer: { select: {} },
  'Ask for': { rich_text: {} },
  Why: { rich_text: {} },
  Website: { url: {} },
  Employees: { number: {} },
  Profile: { url: {} },
  Met: { date: {} },
  Status: { select: { options: [{ name: 'New', color: 'blue' }, { name: 'Contacted', color: 'purple' }, { name: 'Meeting', color: 'green' }] } },
}

function label(card: Lead['card']) {
  if (card.relation === 'competitor') return 'Competitor'
  if (card.relation === 'colleague') return 'Colleague'
  return card.fit[0].toUpperCase() + card.fit.slice(1)
}

function icon(card: Lead['card']) {
  const emoji = card.relation && card.relation !== 'prospect' ? '⚫' : card.fit === 'strong' ? '🟢' : card.fit === 'maybe' ? '🟡' : '⚪'
  return { type: 'emoji', emoji }
}

export function notion(token: string) {
  let target: Promise<NotionTarget> | null = null

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Notion-Version': VERSION, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`Notion ${method} ${path} ${res.status}: ${await res.text()}`)
    return res.json() as Promise<T>
  }

  type SearchResult = {
    object: string
    id: string
    url?: string
    in_trash?: boolean
    archived?: boolean
    parent?: { type: string; database_id?: string }
    title?: { plain_text: string }[]
    properties?: Record<string, { type: string; title?: { plain_text: string }[] }>
  }

  async function search(value: 'page' | 'data_source', query?: string) {
    const body = { ...(query ? { query } : {}), filter: { property: 'object', value }, sort: { timestamp: 'last_edited_time', direction: 'descending' } }
    const { results } = await call<{ results: SearchResult[] }>('POST', '/search', body)
    return results.filter(r => !r.in_trash && !r.archived)
  }

  async function findOrCreate(): Promise<NotionTarget> {
    const existing = (await search('data_source', DB_TITLE)).find(r => r.title?.map(t => t.plain_text).join('') === DB_TITLE)
    if (existing?.parent?.database_id) {
      return { database_id: existing.parent.database_id, data_source_id: existing.id, url: existing.url ?? null }
    }
    // Pick the shared page to put the database under: a top-level one if any.
    const pages = (await search('page')).filter(p => p.parent?.type !== 'data_source_id' && p.parent?.type !== 'database_id')
    const parent = pages.find(p => p.parent?.type === 'workspace') ?? pages[0]
    if (!parent) throw new Error('No Notion page is shared with the integration. Open a page, ... menu, Connections, and add it.')
    const db = await call<{ id: string; url?: string; data_sources?: { id: string }[] }>('POST', '/databases', {
      parent: { type: 'page_id', page_id: parent.id },
      title: text(DB_TITLE),
      icon: { type: 'emoji', emoji: '🤝' },
      initial_data_source: { properties: SCHEMA },
    })
    let dataSource = db.data_sources?.[0]?.id
    if (!dataSource) dataSource = (await call<{ data_sources: { id: string }[] }>('GET', `/databases/${db.id}`)).data_sources[0]?.id
    if (!dataSource) throw new Error('Notion created the database but returned no data source')
    console.log(`notion: created "${DB_TITLE}" database`)
    return { database_id: db.id, data_source_id: dataSource, url: db.url ?? null }
  }

  // Cached after the first success; a failure is retried on the next save.
  function ensure() {
    target ??= findOrCreate().catch(err => {
      target = null
      throw err
    })
    return target
  }

  function properties(lead: Lead): Record<string, unknown> {
    const { card, verification: v } = lead
    const contact = v?.contact ? [v.contact.name, v.contact.title].filter(Boolean).join(', ') : null
    const website = v?.company?.domain ?? card.company_domain
    return {
      Name: { title: text(card.name ?? 'Unknown') },
      Company: { rich_text: text(v?.company?.name ?? card.company) },
      Role: { rich_text: text(card.role) },
      Verified: { rich_text: text(v?.person ? card.checked_title ?? v.person.title : null) },
      Fit: { select: { name: label(card) } },
      Score: { number: card.score },
      Buyer: { select: card.buyer ? { name: card.buyer.replace(/,/g, ' ') } : null },
      'Ask for': { rich_text: text(contact) },
      Why: { rich_text: text(card.why) },
      Website: { url: website ? `https://${website}` : null },
      Employees: { number: v?.company?.employees ?? null },
      Profile: { url: v?.person?.profile_url ?? null },
      Met: { date: { start: lead.savedAt } },
    }
  }

  const para = (s: string) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: text(s) } })
  const heading = (s: string) => ({ object: 'block', type: 'heading_3', heading_3: { rich_text: text(s) } })
  const quote = (s: string) => ({ object: 'block', type: 'quote', quote: { rich_text: text(s) } })
  const bullet = (s: string) => ({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: text(s) } })
  const email = (lead: Lead, title = 'Follow-up email (draft)') =>
    lead.followUp
      ? [heading(title), para(`Subject: ${lead.followUp.subject}`), ...lead.followUp.body.split(/\n{2,}/).map(para)]
      : []
  // Everyone found in a buyer role, so a wrong pick can be fixed later.
  const buyers = (lead: Lead) => {
    const all = lead.verification?.contacts ?? []
    return all.length > 1
      ? [heading('Buyers found there'), ...all.map(c => bullet([c.name, c.title].filter(Boolean).join(', ')))]
      : []
  }

  async function addLead(lead: Lead): Promise<{ id: string; url: string }> {
    const { data_source_id } = await ensure()
    const { card } = lead
    const children = [
      heading('Next line to say'),
      para(card.opener.replace(/^Ask:\s*/, '')),
      ...email(lead),
      ...buyers(lead),
      heading('What they said'),
      quote(lead.transcript),
    ]
    const page = await call<{ id: string; url: string }>('POST', '/pages', {
      parent: { type: 'data_source_id', data_source_id },
      icon: icon(card),
      properties: { ...properties(lead), Status: { select: { name: 'New' } } },
      children,
    })
    return { id: page.id, url: page.url }
  }

  // Met the same person again: refresh the row (keeping its Status) and add
  // the new conversation below the old one.
  async function updateLead(pageId: string, lead: Lead): Promise<void> {
    await call('PATCH', `/pages/${pageId}`, { icon: icon(lead.card), properties: properties(lead) })
    const when = new Date(lead.savedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
    await call('PATCH', `/blocks/${pageId}/children`, {
      children: [heading(`Met again, ${when}`), quote(lead.transcript), ...email(lead)],
    })
  }

  // The wearer picked a different person to ask for: new "Ask for" and a
  // new draft below the old one.
  async function switchContact(pageId: string, lead: Lead): Promise<void> {
    await call('PATCH', `/pages/${pageId}`, { properties: properties(lead) })
    const who = lead.verification?.contact?.name
    await call('PATCH', `/blocks/${pageId}/children`, { children: email(lead, who ? `Follow-up email (asking for ${who})` : 'Follow-up email (no intro)') })
  }

  return { ensure, addLead, updateLead, switchContact }
}

export type Notion = ReturnType<typeof notion>
