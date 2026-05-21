import pg from 'pg'
import { config } from './config.js'

let pool: pg.Pool | null = null

function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: config.databaseUrl, ssl: false, max: 5 })
  }
  return pool
}

export async function upsertFulltext(tdocId: string, text: string): Promise<void> {
  await getPool().query(
    `INSERT INTO tdoc_fulltext (tdoc_id, body_tsv)
     VALUES ($1, to_tsvector('english', $2))
     ON CONFLICT (tdoc_id) DO UPDATE SET body_tsv = to_tsvector('english', $2)`,
    [tdocId, text],
  )
}

export async function closePool(): Promise<void> {
  await pool?.end()
  pool = null
}
