import minimist from 'minimist'
import { config, WG_PATHS } from './config.js'
import { discoverMeetings, fetchTDocs } from './ftp.js'
import { ensureIndex, indexBatch, healthCheck } from './meilisearch.js'
import { loadState, saveState, hasBeenCrawled, markCrawled } from './crawl-state.js'

const argv = minimist(process.argv.slice(2))
const command = argv._[0]

if (command !== 'crawl') {
  console.error('Usage: tsx src/index.ts crawl --wg <WG> [--limit <n>] [--incremental]')
  process.exit(1)
}

const wg: string = argv.wg ?? argv.w
const limit: number | undefined = argv.limit ? Number(argv.limit) : undefined
const incremental: boolean = Boolean(argv.incremental ?? argv.i)

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
  console.log(`  limit=${limit ?? 'all'}  incremental=${incremental}`)
  console.log(`  Meilisearch: ${config.meilisearchUrl}\n`)

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

    markCrawled(state, {
      meetingId: meeting.id,
      ftpPath: meeting.ftpPath,
      crawledAt: new Date().toISOString(),
      tdocCount: tdocs.length,
    })
  }

  saveState(state)
  console.log(`\nDone. ${totalTdocs} TDocs indexed. State saved to ${config.crawlStatePath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
