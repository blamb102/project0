import { Pool } from 'pg'

const MEILI_URL = process.env.MEILISEARCH_URL!
const MEILI_KEY = process.env.MEILISEARCH_MASTER_KEY!
const DB_URL    = process.env.DATABASE_URL

const pool = DB_URL ? new Pool({ connectionString: DB_URL, ssl: false, max: 2 }) : null

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Content-Type': 'application/json',
}

export const handler = async (event: any) => {
  if (event.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' }
  }

  const params = event.queryStringParameters ?? {}
  const start  = Date.now()

  try {
    if (params.collection === 'emails') {
      return await handleEmails(params, start)
    }
    return await handleTDocs(params, start)
  } catch (err: any) {
    return {
      statusCode: 502,
      headers: CORS,
      body: JSON.stringify({ error: 'Search backend unavailable', detail: err.message }),
    }
  }
}

// ── TDoc search ───────────────────────────────────────────────────────────────

async function handleTDocs(params: Record<string, string>, start: number) {
  const q       = normalizeQuery((params.q ?? '').trim())
  const limit   = Math.min(Number(params.limit ?? 20), 100)
  const offset  = Number(params.offset ?? 0)
  const statuses = csv(params.status)
  const meetings = csv(params.meeting)
  const types    = csv(params.type)
  const sortBy   = params.sort ?? ''

  const userFilter = buildTDocFilter(statuses, meetings, types)

  const [meiliData, pgIds] = await Promise.all([
    meiliSearch('tdocs', q, limit, offset, userFilter, sortBy,
      ['status', 'meetingId', 'type']),
    pgFullTextSearch(q, limit),
  ])

  const meiliHitIds = new Set<string>(meiliData.hits.map((h: any) => h.id))
  const meiliHits   = meiliData.hits.map((h: any) => ({
    ...h,
    matchSource: pgIds.includes(h.id) ? 'both' : 'metadata',
  }))

  const pgOnlyIds = pgIds.filter(id => !meiliHitIds.has(id))
  let pgOnlyHits: any[] = []
  if (pgOnlyIds.length > 0) {
    const idFilter = `id IN [${pgOnlyIds.map(id => `"${id}"`).join(',')}]`
    const pgFilter = userFilter ? `${userFilter} AND ${idFilter}` : idFilter
    const res = await meiliSearch('tdocs', '', pgOnlyIds.length, 0, pgFilter, '', [])
    pgOnlyHits = res.hits.map((h: any) => ({ ...h, matchSource: 'fulltext' }))
  }

  const hits = [...meiliHits, ...pgOnlyHits]
  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      hits,
      estimatedTotalHits:  (meiliData.estimatedTotalHits ?? 0) + pgOnlyIds.length,
      processingTimeMs:    Date.now() - start,
      query:               q,
      facetDistribution:   meiliData.facetDistribution ?? {},
    }),
  }
}

function buildTDocFilter(statuses: string[], meetings: string[], types: string[]) {
  const parts: string[] = []
  if (statuses.length) parts.push(`status IN [${statuses.map(s => `"${s}"`).join(',')}]`)
  if (meetings.length) parts.push(`meetingId IN [${meetings.map(m => `"${m}"`).join(',')}]`)
  if (types.length)    parts.push(`type IN [${types.map(t => `"${t}"`).join(',')}]`)
  return parts.length ? parts.join(' AND ') : undefined
}

// ── Email search ──────────────────────────────────────────────────────────────

async function handleEmails(params: Record<string, string>, start: number) {
  const q      = normalizeQuery((params.q ?? '').trim())
  const limit  = Math.min(Number(params.limit ?? 20), 100)
  const offset = Number(params.offset ?? 0)
  const lists  = csv(params.list)
  const years  = csv(params.year).map(Number).filter(n => n > 0)
  const sortBy = params.sort ?? 'dateTs:desc'

  const parts: string[] = []
  if (lists.length)  parts.push(`list IN [${lists.map(l => `"${l}"`).join(',')}]`)
  if (years.length)  parts.push(`year IN [${years.join(',')}]`)
  const filter = parts.length ? parts.join(' AND ') : undefined

  const data = await meiliSearch('emails', q, limit, offset, filter, sortBy,
    ['list', 'year'])

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      hits:               data.hits ?? [],
      estimatedTotalHits: data.estimatedTotalHits ?? 0,
      processingTimeMs:   Date.now() - start,
      query:              q,
      facetDistribution:  data.facetDistribution ?? {},
    }),
  }
}

// ── Shared helpers ────────────────────────────────────────────────────────────

// Normalize smart/curly quotes to ASCII so phrase search works regardless of OS quoting
function normalizeQuery(q: string): string {
  return q
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
}

function csv(val: string | undefined): string[] {
  return val ? val.split(',').map(s => s.trim()).filter(Boolean) : []
}

async function meiliSearch(
  index: string, q: string, limit: number, offset: number,
  filter?: string, sort?: string, facets?: string[],
) {
  const body: Record<string, unknown> = { q, limit, offset, matchingStrategy: 'all' }
  if (facets?.length) body.facets = facets
  if (filter)         body.filter = filter
  if (sort)           body.sort   = [sort]

  const res = await fetch(`${MEILI_URL}/indexes/${index}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MEILI_KEY}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Meilisearch HTTP ${res.status}: ${text}`)
  }
  return res.json() as Promise<any>
}

async function pgFullTextSearch(q: string, limit: number): Promise<string[]> {
  if (!pool || !q) return []
  // Phrase search: extract quoted phrase(s) and use phraseto_tsquery so PG
  // respects the same semantics Meilisearch enforces, instead of falling back
  // to a plain word-AND (plainto_tsquery) that would produce false positives.
  const phraseMatch = q.match(/^"([^"]+)"$/)
  const pgQuery = phraseMatch ? phraseMatch[1] : q
  const tsqFn   = phraseMatch ? 'phraseto_tsquery' : 'plainto_tsquery'
  try {
    const { rows } = await pool.query<{ tdoc_id: string }>(
      `SELECT f.tdoc_id
       FROM tdoc_fulltext f, ${tsqFn}('english', $1) tsq
       WHERE f.body_tsv @@ tsq
       ORDER BY ts_rank(f.body_tsv, tsq) DESC
       LIMIT $2`,
      [pgQuery, limit * 3],
    )
    return rows.map(r => r.tdoc_id)
  } catch (e) {
    console.warn('Postgres FTS error:', e)
    return []
  }
}
