// Treg (treg.to) proxies business-data providers behind one token.
// Used only for work information: what a company does, and who holds a role
// there. Never personal contact details.

const BASE = 'https://treg.to/call'

export interface Company {
  name: string | null
  domain: string | null
  description: string | null
  industry: string | null
  employees: number | null
  linkedin_url: string | null
}

export interface Person {
  name: string
  title: string | null
  company: string | null
  company_domain: string | null
  location: string | null
  profile_url: string | null
}

export interface Treg {
  company(q: { domain?: string; name?: string }): Promise<Company | null>
  people(q: { company_domain: string; title?: string; full_name?: string; limit?: number }): Promise<Person[]>
}

export function treg(token: string, maxCostUsd = '0.05'): Treg {
  async function call<T>(endpoint: string, body: unknown): Promise<T | null> {
    const t0 = performance.now()
    const res = await fetch(`${BASE}/${endpoint}`, {
      method: 'POST',
      headers: {
        'X-Treg-Token': token,
        'Content-Type': 'application/json',
        'X-Treg-Route-Max-Cost': maxCostUsd,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    })
    const ms = Math.round(performance.now() - t0)
    const outcome = res.headers.get('x-treg-route-outcome')
    console.log(`treg ${endpoint} ${res.status} ${outcome ?? ''} ${ms} ms via ${res.headers.get('x-treg-served-by') ?? '-'}`)
    if (!res.ok) throw new Error(`Treg ${endpoint} ${res.status}: ${(await res.text()).slice(0, 300)}`)
    if (outcome && outcome !== 'hit') return null
    const json = (await res.json()) as { output?: T }
    return json.output ?? null
  }

  return {
    async company(q) {
      const out = await call<Company>('treg.companies.enrich', q)
      return out?.name || out?.domain ? out : null
    },
    async people(q) {
      const out = await call<{ people: Person[] }>('treg.people.search', { limit: 5, ...q })
      return out?.people ?? []
    },
  }
}
