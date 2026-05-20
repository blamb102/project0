import { Pool } from 'pg'

const MEILI_URL = process.env.MEILISEARCH_URL!
const MEILI_KEY = process.env.MEILISEARCH_MASTER_KEY!
const DB_URL    = process.env.DATABASE_URL

// Pool lives outside the handler so it persists across warm Lambda invocations.
const pool = DB_URL ? new Pool({ connectionString: DB_URL, ssl: false, max: 2 }) : null

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Content-Type': 'application/json',
}

export const handler = async (event: any) => {
  if (event.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' }
  }

  const params = event.queryStringParameters ?? {}
  const q      = (params.q ?? '').trim()
  const limit  = Math.min(Number(params.limit ?? 20), 100)
  const offset = Number(params.offset ?? 0)

  const start = Date.now()

  try {
    // Run metadata search and full-text search in parallel.
    const [meiliData, pgIds] = await Promise.all([
      meiliSearch(q, limit, offset),
      pgFullTextSearch(q, limit),
    ])

    const meiliHitIds = new Set<string>(meiliData.hits.map((h: any) => h.id))

    // Promote hits that appear in both sources.
    const meiliHits = meiliData.hits.map((h: any) => ({
      ...h,
      matchSource: pgIds.includes(h.id) ? 'both' : 'metadata',
    }))

    // Postgres-only hits need their metadata fetched from Meilisearch by ID filter.
    const pgOnlyIds = pgIds.filter(id => !meiliHitIds.has(id))
    let pgOnlyHits: any[] = []
    if (pgOnlyIds.length > 0) {
      const filter = `id IN [${pgOnlyIds.map(id => `"${id}"`).join(',')}]`
      const res = await meiliSearch('', pgOnlyIds.length, 0, filter)
      pgOnlyHits = res.hits.map((h: any) => ({ ...h, matchSource: 'fulltext' }))
    }

    const hits = [...meiliHits, ...pgOnlyHits]
    const estimatedTotalHits = (meiliData.estimatedTotalHits ?? 0) + pgOnlyIds.length

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        hits,
        estimatedTotalHits,
        processingTimeMs: Date.now() - start,
        query: q,
      }),
    }
  } catch (err: any) {
    return {
      statusCode: 502,
      headers: CORS,
      body: JSON.stringify({ error: 'Search backend unavailable', detail: err.message }),
    }
  }
}

async function meiliSearch(q: string, limit: number, offset: number, filter?: string) {
  const body: Record<string, unknown> = { q, limit, offset }
  if (filter) body.filter = filter
  const res = await fetch(`${MEILI_URL}/indexes/tdocs/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MEILI_KEY}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Meilisearch HTTP ${res.status}`)
  return res.json() as Promise<any>
}

async function pgFullTextSearch(q: string, limit: number): Promise<string[]> {
  if (!pool || !q) return []
  try {
    const { rows } = await pool.query<{ tdoc_id: string }>(
      `SELECT f.tdoc_id
       FROM tdoc_fulltext f, plainto_tsquery('english', $1) tsq
       WHERE f.body_tsv @@ tsq
       ORDER BY ts_rank(f.body_tsv, tsq) DESC
       LIMIT $2`,
      [q, limit * 3],
    )
    return rows.map(r => r.tdoc_id)
  } catch (e) {
    // Postgres unavailable or FTS table not yet populated — degrade gracefully.
    console.warn('Postgres FTS error:', e)
    return []
  }
}
