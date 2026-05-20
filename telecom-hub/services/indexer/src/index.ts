import minimist from 'minimist'
import { config, WG_PATHS } from './config.js'
import { discoverMeetings, fetchTDocs, extractDocText } from './ftp.js'
import { ensureIndex, indexBatch, healthCheck } from './meilisearch.js'
import { loadState, saveState, hasBeenCrawled, markCrawled } from './crawl-state.js'
import { upsertFulltext, closePool } from './db.js'

const argv = minimist(process.argv.slice(2))
const command = argv._[0]

if (command !== 'crawl') {
  console.error('Usage: tsx src/index.ts crawl --wg <WG> [--limit <n>] [--incremental]')
  process.exit(1)
}

const wg: string = argv.wg ?? argv.w
const limit: number | undefined = argv.limit ? Number(argv.limit) : undefined
const incremental: boolean = Boolean(argv.incremental ?? argv.i)
const fullText: boolean = Boolean(argv['full-text'] ?? argv.f)

if (!wg) {
  console.error('Error: --wg is required (e.g. --wg RAN1)')
  process.exit(1)
}

const wgPath = WG_PATHS[wg.toUpperCase()]
if (!wgPath) {
  console.error(`Unknown WG "${wg}". Known WGs: ${Object.keys(WG_PATHS).join(', ')}`)
  process.exit(1)
}

async function main() {
  console.log(`\n3GPP Indexer — crawling ${wg} (${wgPath})`)
  console.log(`  limit=${limit ?? 'all'}  incremental=${incremental}  full-text=${fullText}`)
  console.log(`  Meilisearch: ${config.meilisearchUrl}`)
  if (fullText) console.log(`  Postgres:    ${config.databaseUrl || '(DATABASE_URL not set)'}`)
  console.log()

  // Meilisearch health check
  const healthy = await healthCheck()
  if (!healthy) {
    console.error('Meilisearch is not reachable. Is Docker running? (docker-compose up -d)')
    process.exit(1)
  }
  await ensureIndex()

  const state = loadState()

  // Discover meetings
  console.log(`Discovering meetings for ${wg}…`)
  const meetings = await discoverMeetings(wg.toUpperCase(), wgPath, limit)
  console.log(`Found ${meetings.length} meeting(s)\n`)

  let totalTdocs = 0

  for (const meeting of meetings) {
    if (incremental && hasBeenCrawled(state, meeting.id)) {
      console.log(`[skip] ${meeting.id} — already crawled`)
      continue
    }

    console.log(`[crawl] ${meeting.id} (${meeting.ftpPath})`)
    const tdocs = await fetchTDocs(meeting)
    console.log(`  Found ${tdocs.length} TDoc(s)`)

    await indexBatch(tdocs)
    totalTdocs += tdocs.length

    if (fullText) {
      if (!config.databaseUrl) {
        console.warn('  DATABASE_URL not set — skipping full-text extraction')
      } else {
        await extractFullText(tdocs.map(t => ({ id: t.id, ftpPath: meeting.ftpPath })))
      }
    }

    markCrawled(state, {
      meetingId: meeting.id,
      ftpPath: meeting.ftpPath,
      crawledAt: new Date().toISOString(),
      tdocCount: tdocs.length,
    })
  }

  saveState(state)
  await closePool()
  console.log(`\nDone. ${totalTdocs} TDocs indexed. State saved to ${config.crawlStatePath}`)
}

async function extractFullText(tdocs: Array<{ id: string; ftpPath: string }>) {
  const CONCURRENCY = 10
  let indexed = 0
  let processed = 0
  for (let i = 0; i < tdocs.length; i += CONCURRENCY) {
    const batch = tdocs.slice(i, i + CONCURRENCY)
    await Promise.all(batch.map(async ({ id, ftpPath }) => {
      const text = await extractDocText(id, ftpPath)
      if (text) {
        await upsertFulltext(id, text)
        indexed++
      }
      processed++
    }))
    process.stdout.write(`\r  Full text: ${processed}/${tdocs.length} downloaded, ${indexed} indexed`)
  }
  console.log()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
