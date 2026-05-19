import fs from 'node:fs'
import type { CrawlState, MeetingCrawlRecord } from '@telecom-hub/types'
import { config } from './config.js'

export function loadState(): CrawlState {
  try {
    const raw = fs.readFileSync(config.crawlStatePath, 'utf8')
    return JSON.parse(raw) as CrawlState
  } catch {
    return { lastRun: '', meetings: {} }
  }
}

export function saveState(state: CrawlState): void {
  state.lastRun = new Date().toISOString()
  fs.writeFileSync(config.crawlStatePath, JSON.stringify(state, null, 2), 'utf8')
}

export function hasBeenCrawled(state: CrawlState, meetingId: string): boolean {
  return meetingId in state.meetings
}

export function markCrawled(
  state: CrawlState,
  record: MeetingCrawlRecord,
): void {
  state.meetings[record.meetingId] = record
}
