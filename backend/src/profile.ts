import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { chatJSON } from './openai.ts'
import type { Company, Treg } from './treg.ts'

// The wearer's company profile: what they sell, which companies should buy
// it, and which roles inside those companies to look for. Built once from a
// company name or website, then used to judge every introduction.

export interface Buyer {
  role: string // short label shown on the glasses, e.g. "Payments lead"
  kind: 'decision_maker' | 'champion' | 'user'
  titles: string[] // real job titles, used to find this person at a company
  why: string
  pain: string
}

export interface Profile {
  company: string
  domain: string | null
  one_liner: string
  problem: string
  solution: string
  icp: { industries: string[]; company_size: string; stage: string; regions: string[]; signals: string[] }
  buyers: Buyer[]
  not_a_fit: string[]
  competitors?: string[] // missing in profiles built before it existed
  you?: string | null // the wearer's name, so the scorer can ignore their voice
  note: string | null
  sources: { website: boolean; treg: boolean }
  created_at: string
}

const DATA_DIR = new URL('../data/', import.meta.url)
const PROFILE_FILE = new URL('profile.json', DATA_DIR)
const FALLBACK_ICP = new URL('../icp.md', import.meta.url)

const strings = { type: 'array', items: { type: 'string' } }

const PROFILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['company', 'one_liner', 'problem', 'solution', 'icp', 'buyers', 'not_a_fit', 'competitors'],
  properties: {
    company: { type: 'string', description: 'Company name as it brands itself' },
    one_liner: { type: 'string', description: 'What it sells and to whom, at most 90 characters' },
    problem: { type: 'string', description: 'The customer problem it solves, one sentence' },
    solution: { type: 'string', description: 'How it solves it, one sentence' },
    icp: {
      type: 'object',
      additionalProperties: false,
      required: ['industries', 'company_size', 'stage', 'regions', 'signals'],
      properties: {
        industries: { ...strings, description: '2-5 industries or company types that buy this' },
        company_size: { type: 'string', description: 'Employee range, e.g. "50-1,000 employees"' },
        stage: { type: 'string', description: 'Company stage, e.g. "Series A to late stage"' },
        regions: { ...strings, description: 'Where buyers are; ["Global"] if not clear' },
        signals: { ...strings, description: '2-4 observable signs a company needs this now' },
      },
    },
    buyers: {
      type: 'array',
      description: 'Exactly 3 roles inside a customer company, most important first',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['role', 'kind', 'titles', 'why', 'pain'],
        properties: {
          role: { type: 'string', description: 'Short label, at most 22 characters, e.g. "Payments lead"' },
          kind: { type: 'string', enum: ['decision_maker', 'champion', 'user'] },
          titles: { ...strings, description: '3-6 real job titles people in this role have on LinkedIn' },
          why: { type: 'string', description: 'Why this role cares, one short sentence' },
          pain: { type: 'string', description: 'The pain they would mention in conversation, a few words' },
        },
      },
    },
    not_a_fit: { ...strings, description: '2-4 kinds of people or companies that look close but will not buy' },
    competitors: { ...strings, description: '3-6 direct competitors: company names only, best known first' },
  },
}

const SYSTEM = `You are a B2B go-to-market strategist. From what a company says about itself, work out its ideal customer profile and the roles inside customer companies that buy, champion, or use the product. Be concrete and realistic: use job titles that really exist, and keep labels short because they are shown on smart glasses. Base everything on the material given; where it is thin, make the most likely reasonable assumption for this kind of company rather than inventing specifics like customer names or numbers.`

// "https://www.Acme.com/about" -> "acme.com"; "Acme Inc" -> null
export function toDomain(input: string): string | null {
  const s = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0]
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : null
}

// Homepage text: title, meta description and visible copy, trimmed.
async function readSite(domain: string): Promise<string | null> {
  try {
    const res = await fetch(`https://${domain}`, {
      redirect: 'follow',
      signal: AbortSignal.timeout(6000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HandshakeSetup/0.1)', Accept: 'text/html' },
    })
    if (!res.ok) return null
    const html = await res.text()
    const meta = (name: string) =>
      new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)`, 'i').exec(html)?.[1] ?? ''
    const title = /<title[^>]*>([^<]*)/i.exec(html)?.[1] ?? ''
    const body = html
      .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&#39;|&rsquo;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim()
    const text = [title, meta('description'), meta('og:description'), body].filter(Boolean).join('\n').slice(0, 6000)
    return text.length > 80 ? text : null
  } catch {
    return null
  }
}

// Progress for the setup screen, in the order the steps happen.
export type SetupStep =
  | { step: 'company'; found: boolean; detail: string | null }
  | { step: 'site'; found: boolean; detail: string | null }
  | { step: 'profile' }

export async function buildProfile(
  input: string,
  note: string | null,
  deps: { openaiKey: string; treg: Treg | null },
  onStep: (s: SetupStep) => void = () => {},
): Promise<Profile> {
  let domain = toDomain(input)
  const t0 = performance.now()

  // Company facts and the website in parallel when we already have a domain.
  const companyP: Promise<Company | null> = deps.treg
    ? deps.treg.company(domain ? { domain } : { name: input.trim() }).catch(err => (console.error(err), null))
    : Promise.resolve(null)
  let siteP = domain ? readSite(domain) : null
  const company = await companyP
  onStep({
    step: 'company',
    found: !!company,
    detail: company ? [company.name, company.industry, company.employees && `${company.employees.toLocaleString()} people`].filter(Boolean).join(' · ') : null,
  })
  if (!domain && company?.domain) {
    domain = company.domain
    siteP = readSite(domain)
  }
  const site = siteP ? await siteP : null
  onStep({ step: 'site', found: !!site, detail: domain })
  console.log(`profile sources for "${input}": domain=${domain} treg=${!!company} site=${site?.length ?? 0} chars, ${Math.round(performance.now() - t0)} ms`)

  if (!company && !site && !domain) {
    throw new Error(`Couldn't find "${input}". Try its website, like yourcompany.com.`)
  }

  const material = [
    `Company the user typed: ${input.trim()}`,
    domain && `Website: ${domain}`,
    company &&
      `Business database: ${[company.name, company.industry, company.employees && `${company.employees} employees`, company.description]
        .filter(Boolean)
        .join(' · ')}`,
    site && `Homepage text:\n${site}`,
    note && `The user adds: ${note}`,
  ]
    .filter(Boolean)
    .join('\n\n')

  onStep({ step: 'profile' })
  const out = await chatJSON<Omit<Profile, 'domain' | 'note' | 'sources' | 'created_at'>>(deps.openaiKey, {
    system: SYSTEM,
    user: material,
    schemaName: 'company_profile',
    schema: PROFILE_SCHEMA,
    reasoningEffort: 'low', // setup can take a few seconds; quality matters more here
  })
  console.log(`profile built in ${Math.round(performance.now() - t0)} ms`)

  return {
    ...out,
    domain,
    note,
    sources: { website: !!site, treg: !!company },
    created_at: new Date().toISOString(),
  }
}

export function loadProfile(): Profile | null {
  if (!existsSync(PROFILE_FILE)) return null
  try {
    return JSON.parse(readFileSync(PROFILE_FILE, 'utf8')) as Profile
  } catch {
    return null
  }
}

export function saveProfile(p: Profile) {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(PROFILE_FILE, JSON.stringify(p, null, 2))
}

// The profile as prompt text for the scorer; falls back to icp.md.
export function profileText(p: Profile | null): string {
  if (!p) return `Ideal customer profile:\n${readFileSync(FALLBACK_ICP, 'utf8')}`
  const kind = { decision_maker: 'decision maker', champion: 'champion', user: 'user' }
  return [
    `Wearer's company: ${p.company}${p.domain ? ` (${p.domain})` : ''}: ${p.one_liner}`,
    `Problem it solves: ${p.problem}`,
    `Solution: ${p.solution}`,
    `Ideal customer companies: ${p.icp.industries.join(', ')}; ${p.icp.company_size}; ${p.icp.stage}; regions: ${p.icp.regions.join(', ')}`,
    `Buying signals: ${p.icp.signals.join('; ')}`,
    'Buyer roles (labels to use for "buyer"):',
    ...p.buyers.map(b => `- "${b.role}" (${kind[b.kind]}): titles like ${b.titles.join(', ')}. Cares because ${b.why} Pain: ${b.pain}.`),
    `Not a fit: ${p.not_a_fit.join('; ')}`,
    p.competitors?.length ? `Competitors: ${p.competitors.join(', ')}` : null,
    p.you ? `The wearer is ${p.you} from ${p.company}.` : null,
  ]
    .filter(Boolean)
    .join('\n')
}
