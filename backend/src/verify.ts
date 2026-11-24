import type { Profile } from './profile.ts'
import type { Card } from './score.ts'
import type { Company, Person, Treg } from './treg.ts'

// Second pass after the first card: checks the person's work role at the
// company they named, and, if they aren't a buyer, finds who holds the buyer
// role there. Work information only, and only for someone who just
// introduced themselves to the wearer.

export interface Verification {
  company: { name: string | null; domain: string; employees: number | null; industry: string | null; matched_by: 'domain' | 'name' } | null
  person: { name: string; title: string | null; match: 'exact' | 'close'; profile_url: string | null } | null
  contact: { name: string; title: string | null; buyer: string } | null
}

const companyCache = new Map<string, Promise<Company | null>>()

function cached(key: string, load: () => Promise<Company | null>): Promise<Company | null> {
  let hit = companyCache.get(key)
  if (!hit) {
    hit = load().catch(err => (console.error(err), null))
    companyCache.set(key, hit)
    // Don't keep a failure around forever.
    void hit.then(c => c || setTimeout(() => companyCache.delete(key), 60_000))
  }
  return hit
}

// Prefer the domain the scorer is confident about. A bare name is ambiguous
// ("Linear" also matches Linear Technology, a chip maker), so a name lookup
// only counts when the names are the same apart from "Inc"-style suffixes.
async function lookupCompany(treg: Treg, card: Card): Promise<{ company: Company; by: 'domain' | 'name' } | null> {
  const domain = card.company_domain?.toLowerCase().replace(/^www\./, '')
  if (domain) {
    const byDomain = await cached(`d:${domain}`, () => treg.company({ domain }))
    if (byDomain?.domain) return { company: byDomain, by: 'domain' }
  }
  if (!card.company) return null
  const byName = await cached(`n:${normalize(card.company)}`, () => treg.company({ name: card.company! }))
  return byName?.domain && bareName(byName.name ?? '') === bareName(card.company) ? { company: byName, by: 'name' } : null
}

const SUFFIX = /\b(inc|incorporated|ltd|limited|llc|corp|corporation|co|gmbh|plc|pte|pty|sa|ag|bv|hq)\b/g
function bareName(s: string) {
  return normalize(s).replace(SUFFIX, '').replace(/\s+/g, ' ').trim()
}

export async function verify(card: Card, profile: Profile | null, treg: Treg): Promise<Verification> {
  const empty: Verification = { company: null, person: null, contact: null }
  if (!card.company && !card.company_domain) return empty
  if (card.relation && card.relation !== 'prospect') return empty // colleagues and competitors aren't checked

  // Who to ask for, when they aren't a buyer but their company could be.
  const buyer = profile?.buyers.find(b => b.kind === 'decision_maker') ?? profile?.buyers[0]
  const wantContact = !!buyer && !card.buyer && card.company_fit !== 'no'

  const searchAt = (domain: string) =>
    Promise.all([
      card.name && card.name.trim().includes(' ')
        ? treg.people({ company_domain: domain, full_name: card.name, limit: 3 }, { waterfall: false, timeoutMs: 2000 }).catch(() => [])
        : Promise.resolve([] as Person[]),
      card.role
        ? treg.people({ company_domain: domain, title: card.role, limit: 10 }, { maxCostUsd: '0.02', timeoutMs: 2500 }).catch(() => [])
        : Promise.resolve([] as Person[]),
      wantContact
        ? Promise.all(
            buyer!.titles.slice(0, 2).map(title =>
              treg
                .people({ company_domain: domain, title, limit: 3 }, { maxCostUsd: '0.02', timeoutMs: 3500 })
                .then(rows => rows.filter(r => titleMatches(r.title, title)))
                .catch(() => []),
            ),
          ).then(lists => lists.flat())
        : Promise.resolve([] as Person[]),
    ])

  // When the scorer already knows the domain, search people while the
  // company lookup runs instead of after it.
  const guess = card.company_domain?.toLowerCase().replace(/^www\./, '') || null
  const early = guess ? searchAt(guess) : null
  const found = await lookupCompany(treg, card)
  if (!found?.company.domain) return empty
  const { company, by } = found
  const domain = company.domain!
  const facts: Verification['company'] = { name: company.name, domain, employees: company.employees, industry: company.industry, matched_by: by }

  const [byName, byRole, contacts] = await (early && guess === domain ? early : searchAt(domain))

  const person = card.name ? bestNameMatch(card.name, [...byName, ...byRole], domain) : null
  const contactRow = contacts.find(r => r.name && (!person || normalize(r.name) !== normalize(person.name)))

  return {
    company: facts,
    person,
    contact: contactRow ? { name: contactRow.name, title: contactRow.title, buyer: buyer!.role } : null,
  }
}

// Facts for the scorer's second pass, with the first card so the verdict
// only moves when the facts give a reason.
export function factsText(v: Verification, card: Card): string | null {
  const lines: string[] = []
  if (v.person) {
    lines.push(
      `- The database lists "${v.person.name}"${v.person.title ? ` with the title "${v.person.title}"` : ''}${v.company?.name ? ` at ${v.company.name}` : ''}. Same name as heard${v.person.match === 'exact' ? '' : ' (close spelling)'}; check the title against what they said before trusting it.`,
    )
  }
  if (v.company) {
    const size = v.company.employees ? `${v.company.employees.toLocaleString('en-US')} employees` : null
    lines.push(
      `- ${v.company.name ?? card.company} (${v.company.domain}): ${[size, v.company.industry].filter(Boolean).join('; ') || 'no size data'}.` +
        (v.company.matched_by === 'name'
          ? ' Found by name only: if this conflicts with what they said their company does, it is a different company with the same name, so ignore it.'
          : ''),
    )
  }
  if (v.contact) {
    lines.push(
      `- At this company, ${v.contact.name}${v.contact.title ? ` (${v.contact.title})` : ''} holds the buyer role "${v.contact.buyer}". If this person is not a buyer, the opener asks them for an intro to ${firstName(v.contact.name)} by name, e.g. "Ask: Could you intro me to ${firstName(v.contact.name)}?".`,
    )
  }
  if (!lines.length) return null
  return [
    `Checked facts from a business database (trust these over the transcript for spelling and company size):\n${lines.join('\n')}`,
    `Your first card, made before these facts:\n${JSON.stringify(card)}\nKeep its fit, score and buyer unless the facts give a clear reason to change them, and say that reason in "why".`,
  ].join('\n\n')
}

function firstName(name: string) {
  return name.split(/\s+/)[0]
}

// --- name matching ---------------------------------------------------------

function bestNameMatch(heard: string, rows: Person[], domain: string): Verification['person'] {
  const h = normalize(heard)
  const [hFirst, ...hRest] = h.split(' ')
  const hLast = hRest.join(' ')
  const matches: { row: Person; score: number }[] = []
  for (const row of rows) {
    if (!row.name || (row.company_domain && row.company_domain !== domain)) continue
    const n = normalize(stripSuffix(row.name))
    const [nFirst, ...nRest] = n.split(' ')
    const nLast = nRest.join(' ')
    let score: number
    if (!hLast) {
      score = 0 // first name only: too ambiguous to claim a match
    } else {
      // First names must be close; last names may be misheard ("Chan" for "Chen").
      score = similarity(hFirst, nFirst) >= 0.85 ? 0.4 * similarity(hFirst, nFirst) + 0.6 * similarity(hLast, nLast) : 0
    }
    if (score >= 0.85) matches.push({ row, score })
  }
  if (!matches.length) return null
  // Two different people match ("John Smith" at a big company): don't guess.
  // The same person often comes back from several providers with different
  // title wording, so only distinct profile links count as different people.
  const slug = (url: string) => url.toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop()
  const people = new Set(matches.flatMap(m => (m.row.profile_url ? [slug(m.row.profile_url)] : [])))
  if (people.size > 1) {
    console.log(`name match ambiguous for "${heard}": ${matches.map(m => `${m.row.name} (${m.row.title})`).join('; ')}`)
    return null
  }
  const best = matches.reduce((a, b) => (b.score > a.score ? b : a))
  return {
    name: stripSuffix(best.row.name),
    title: best.row.title,
    match: normalize(stripSuffix(best.row.name)) === h ? 'exact' : 'close',
    profile_url: best.row.profile_url,
  }
}

// Some providers put "Name - Title at Company" in the name field.
function stripSuffix(name: string) {
  return name.split(/\s+[-–|,]\s+/)[0].trim()
}

export function normalize(s: string) {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const STOP = new Set(['of', 'the', 'and', 'head', 'senior', 'sr', 'lead', 'manager', 'director', 'vp', 'vice', 'president', 'chief', 'officer', 'global', 'at'])

// "VP of Engineering" vs "Vice President, Engineering": share a meaningful word.
function titleMatches(rowTitle: string | null, wanted: string): boolean {
  if (!rowTitle) return false
  const words = (s: string) => new Set(normalize(s).split(' ').filter(w => w.length > 2 && !STOP.has(w)))
  const want = words(wanted)
  if (want.size === 0) return normalize(rowTitle).includes(normalize(wanted))
  return [...words(rowTitle)].some(w => want.has(w))
}

// Jaro-Winkler similarity of two strings, 0..1, after normalizing.
export function similarity(a: string, b: string): number {
  a = normalize(a)
  b = normalize(b)
  if (!a || !b) return 0
  if (a === b) return 1
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1)
  const aHit = new Array(a.length).fill(false)
  const bHit = new Array(b.length).fill(false)
  let matches = 0
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (bHit[j] || a[i] !== b[j]) continue
      aHit[i] = bHit[j] = true
      matches++
      break
    }
  }
  if (!matches) return 0
  let t = 0
  for (let i = 0, j = 0; i < a.length; i++) {
    if (!aHit[i]) continue
    while (!bHit[j]) j++
    if (a[i] !== b[j]) t++
    j++
  }
  const jaro = (matches / a.length + matches / b.length + (matches - t / 2) / matches) / 3
  let prefix = 0
  while (prefix < 4 && a[prefix] === b[prefix]) prefix++
  return jaro + prefix * 0.1 * (1 - jaro)
}
