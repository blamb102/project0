import { MeiliSearch } from 'meilisearch'
import { config } from './config.js'
import type { EmailDoc } from './etsi.js'

const client = new MeiliSearch({
  host: config.meilisearchUrl,
  apiKey: config.meilisearchKey,
})

const EMAIL_INDEX = 'emails'

export async function ensureEmailIndex(): Promise<void> {
  const indexes = await client.getIndexes()
  const exists = indexes.results.some(i => i.uid === EMAIL_INDEX)
  if (!exists) {
    await client.createIndex(EMAIL_INDEX, { primaryKey: 'id' })
  }
  const index = client.index(EMAIL_INDEX)
  await Promise.all([
    index.updateSearchableAttributes(['subject', 'from', 'snippet', 'body']),
    index.updateFilterableAttributes(['list', 'year']),
    index.updateSortableAttributes(['dateTs']),
  ])
  console.log(`  Ensured Meilisearch index "${EMAIL_INDEX}"`)
}

export async function indexEmailBatch(docs: EmailDoc[]): Promise<void> {
  if (docs.length === 0) return
  const index = client.index(EMAIL_INDEX)
  for (let i = 0; i < docs.length; i += config.batchSize) {
    const batch = docs.slice(i, i + config.batchSize)
    const task = await index.addDocuments(batch)
    console.log(`  Indexed ${batch.length} emails (task ${task.taskUid})`)
  }
}

export async function emailHealthCheck(): Promise<boolean> {
  try {
    return (await client.health()).status === 'available'
  } catch {
    return false
  }
}
