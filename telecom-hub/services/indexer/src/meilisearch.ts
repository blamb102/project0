import { MeiliSearch } from 'meilisearch'
import type { TDoc } from '@telecom-hub/types'
import { config } from './config.js'

const client = new MeiliSearch({
  host: config.meilisearchUrl,
  apiKey: config.meilisearchKey,
})

const TDOC_INDEX = 'tdocs'

export async function ensureIndex(): Promise<void> {
  const indexes = await client.getIndexes()
  const exists = indexes.results.some((i) => i.uid === TDOC_INDEX)
  if (!exists) {
    await client.createIndex(TDOC_INDEX, { primaryKey: 'id' })
    const index = client.index(TDOC_INDEX)
    await index.updateSearchableAttributes([
      'title', 'source', 'id', 'workingGroup', 'agenda', 'relatedSpec',
    ])
    await index.updateFilterableAttributes([
      'workingGroup', 'type', 'status', 'meetingId', 'relatedSpec',
    ])
    await index.updateSortableAttributes(['indexedAt'])
    console.log(`  Created Meilisearch index "${TDOC_INDEX}"`)
  }
}

export async function indexBatch(tdocs: TDoc[]): Promise<void> {
  if (tdocs.length === 0) return
  const index = client.index(TDOC_INDEX)
  for (let i = 0; i < tdocs.length; i += config.batchSize) {
    const batch = tdocs.slice(i, i + config.batchSize)
    const task = await index.addDocuments(batch)
    console.log(`  Indexed batch (task ${task.taskUid}): ${batch.length} docs`)
  }
}

export async function healthCheck(): Promise<boolean> {
  try {
    const health = await client.health()
    return health.status === 'available'
  } catch {
    return false
  }
}
