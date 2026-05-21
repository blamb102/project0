import minimist from 'minimist'
import { config, WG_PATHS } from './config.js'
import { discoverMeetings, fetchTDocs, extractDocText } from './ftp.js'
import { ensureIndex, indexBatch, healthCheck } from './meilisearch.js'
import { loadState, saveState, hasBeenCrawled, markCrawled } from './crawl-state.js'
import { upsertFulltext, closePool } from './db.js'
import { discoverPeriods, filterRecent, scrapePeriod, fetchEmailBody, RAN1_LISTS } from './etsi.js'
import { ensureEmailIndex, indexEmailBatch, emailHealthCheck } from './email-meili.js'

const argv    = minimist(process.argv.slice(2))
const command = argv._[0]

if (command === 'crawl') {
  await runCrawl()
} else if (command === 'emails') {
  await runEmails()
} else {
  console.error('Usage:')
  console.error('  tsx src/index.ts crawl  --wg <WG> [--limit <n>] [--incremental] [--full-text]')
  console.error('  tsx src/index.ts emails [--years <n>] [--lists <csv>]')
  process.exit(1)
}

// ── TDoc crawl ────────────────────────────────────────────────────────────────

async function runCrawl() {
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

  console.log(`\n3GPP Indexer — crawling ${wg} (${wgPath})`)
  console.log(`  limit=${limit ?? 'all'}  incremental=${incremental}  full-text=${fullText}`)
  console.log(`  Meilisearch: ${config.meilisearchUrl}`)
  if (fullText) console.log(`  Postgres:    ${config.databaseUrl || '(DATABASE_URL not set)'}`)
  console.log()

  if (!await healthCheck()) {
    console.error('Meilisearch is not reachable. Is Docker running? (docker-compose up -d)')
    process.exit(1)
  }
  await ensureIndex()

  const state = loadState()

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
      meetingId:  meeting.id,
      ftpPath:    meeting.ftpPath,
      crawledAt:  new Date().toISOString(),
      tdocCount:  tdocs.length,
    })
  }

  saveState(state)
  await closePool()
  console.log(`\nDone. ${totalTdocs} TDocs indexed. State saved to ${config.crawlStatePath}`)
}

async function extractFullText(tdocs: Array<{ id: string; ftpPath: string }>) {
  const CONCURRENCY = 10
  let indexed = 0, processed = 0
  for (let i = 0; i < tdocs.length; i += CONCURRENCY) {
    const batch = tdocs.slice(i, i + CONCURRENCY)
    await Promise.all(batch.map(async ({ id, ftpPath }) => {
      const text = await extractDocText(id, ftpPath)
      if (text) { await upsertFulltext(id, text); indexed++ }
      processed++
    }))
    process.stdout.write(`\r  Full text: ${processed}/${tdocs.length} downloaded, ${indexed} indexed`)
  }
  console.log()
}

// ── Email reflector crawl ─────────────────────────────────────────────────────

async function runEmails() {
  const years: number    = Number(argv.years ?? 2)
  const limitPeriods     = argv.limit ? Number(argv.limit) : undefined
  const fullText: boolean = Boolean(argv['full-text'] ?? argv.f)
  const listArg: string | undefined = argv.lists
  const lists: string[] = listArg
    ? listArg.split(',').map(s => s.trim()).filter(Boolean)
    : RAN1_LISTS

  console.log('\n3GPP Email Reflector Indexer')
  console.log(`  lists:     ${lists.join(', ')}`)
  console.log(`  years:     last ${years}`)
  console.log(`  full-text: ${fullText}`)
  if (limitPeriods) console.log(`  limit:     ${limitPeriods} period(s)`)
  console.log(`  Meilisearch: ${config.meilisearchUrl}\n`)

  if (!await emailHealthCheck()) {
    console.error('Meilisearch is not reachable.')
    process.exit(1)
  }
  await ensureEmailIndex()

  let totalEmails = 0

  for (const listName of lists) {
    console.log(`\n[list] ${listName}`)

    const allPeriods = await discoverPeriods(listName)
    const recent     = filterRecent(allPeriods, years)
    // Newest first so --limit covers the most recent data
    const periods    = recent.sort().reverse().slice(0, limitPeriods ?? recent.length)
    console.log(`  Found ${allPeriods.length} total periods, keeping ${recent.length} (last ${years}y)${limitPeriods ? `, limited to ${periods.length}` : ''}`)

    for (const period of periods) {
      process.stdout.write(`  [period] ${period} … `)
      const docs = await scrapePeriod(listName, period)
      process.stdout.write(`${docs.length} emails`)

      if (fullText && docs.length > 0) {
        let fetched = 0
        for (const doc of docs) {
          const body = await fetchEmailBody(doc)
          if (body) { doc.body = body; fetched++ }
        }
        process.stdout.write(`  (${fetched}/${docs.length} bodies fetched)`)
      }

      process.stdout.write('\n')
      if (docs.length > 0) {
        await indexEmailBatch(docs)
        totalEmails += docs.length
      }
    }
  }

  console.log(`\nDone. ${totalEmails} emails indexed.`)
}
