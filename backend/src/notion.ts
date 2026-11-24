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

  async function addLead(lead: Lead): Promise<{ id: string; url: string }> {
    const { data_source_id } = await ensure()
    const { card, verification: v } = lead
    const contact = v?.contact ? [v.contact.name, v.contact.title].filter(Boolean).join(', ') : null
    const website = v?.company?.domain ?? card.company_domain
    const properties: Record<string, unknown> = {
      Name: { title: text(card.name ?? 'Unknown') },
      Company: { rich_text: text(v?.company?.name ?? card.company) },
      Role: { rich_text: text(card.role) },
      Verified: { rich_text: text(v?.person ? card.checked_title ?? v.person.title : null) },
      Fit: { select: { name: card.fit[0].toUpperCase() + card.fit.slice(1) } },
      Score: { number: card.score },
      Buyer: { select: card.buyer ? { name: card.buyer.replace(/,/g, ' ') } : null },
      'Ask for': { rich_text: text(contact) },
      Why: { rich_text: text(card.why) },
      Website: { url: website ? `https://${website}` : null },
      Employees: { number: v?.company?.employees ?? null },
      Profile: { url: v?.person?.profile_url ?? null },
      Met: { date: { start: lead.savedAt } },
      Status: { select: { name: 'New' } },
    }
    const para = (s: string) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: text(s) } })
    const heading = (s: string) => ({ object: 'block', type: 'heading_3', heading_3: { rich_text: text(s) } })
    const children = [
      heading('Next line to say'),
      para(card.opener.replace(/^Ask:\s*/, '')),
      ...(lead.followUp
        ? [heading('Follow-up email (draft)'), para(`Subject: ${lead.followUp.subject}`), ...lead.followUp.body.split(/\n{2,}/).map(para)]
        : []),
      heading('What they said'),
      { object: 'block', type: 'quote', quote: { rich_text: text(lead.transcript) } },
    ]
    const page = await call<{ id: string; url: string }>('POST', '/pages', {
      parent: { type: 'data_source_id', data_source_id },
      icon: { type: 'emoji', emoji: card.fit === 'strong' ? '🟢' : card.fit === 'maybe' ? '🟡' : '⚪' },
      properties,
      children,
    })
    return { id: page.id, url: page.url }
  }

  return { ensure, addLead }
}

export type Notion = ReturnType<typeof notion>
