// ── Meeting ──────────────────────────────────────────────────────────────────

export interface Meeting {
  id: string           // e.g. "RAN1#116"
  workingGroup: string // e.g. "RAN1"
  meetingNumber: string
  startDate?: string   // ISO date
  endDate?: string
  location?: string
  ftpPath: string      // relative path on 3GPP FTP
  tdocCount?: number
}

// ── TDoc ─────────────────────────────────────────────────────────────────────

export type TDocType =
  | 'TD'   // Technical Document
  | 'CR'   // Change Request
  | 'LS'   // Liaison Statement
  | 'pCR'  // pseudo-CR
  | 'other'

export type TDocStatus =
  | 'agreed'
  | 'approved'
  | 'noted'
  | 'revised'
  | 'rejected'
  | 'withdrawn'
  | 'postponed'
  | 'merged'
  | 'not treated'
  | 'unknown'

export interface TDoc {
  id: string           // e.g. "R1-2401234"
  meetingId: string
  workingGroup: string
  title: string
  source: string       // company / person submitting
  type: TDocType
  status: TDocStatus
  agenda?: string
  relatedSpec?: string
  relatedCr?: string
  revisionOf?: string
  revisedTo?: string
  abstract?: string
  ftpUrl?: string
  indexedAt: string    // ISO datetime
}

// ── Patent ───────────────────────────────────────────────────────────────────

export type PatentStatus = 'granted' | 'pending' | 'abandoned' | 'expired'

export interface Patent {
  id: string
  publicationNumber: string
  title: string
  abstract?: string
  applicant: string
  inventors: string[]
  filingDate?: string
  publicationDate?: string
  grantDate?: string
  status: PatentStatus
  classifications: string[]  // IPC / CPC codes
  relatedTdocs: string[]     // TDoc IDs
  relatedSpecs: string[]     // 3GPP spec numbers
  jurisdiction: string       // e.g. "US", "EP"
}

// ── Patent Folio ─────────────────────────────────────────────────────────────

export interface PatentFolio {
  id: string
  name: string
  description?: string
  patents: Patent[]
  tdocs: TDoc[]
  createdAt: string
  updatedAt: string
}

// ── Search ───────────────────────────────────────────────────────────────────

export interface SearchQuery {
  q: string
  workingGroup?: string
  type?: TDocType
  status?: TDocStatus
  dateFrom?: string
  dateTo?: string
  page?: number
  hitsPerPage?: number
}

export interface SearchResult<T> {
  hits: T[]
  query: string
  processingTimeMs: number
  totalHits: number
  page: number
  hitsPerPage: number
}

// ── Crawl state ───────────────────────────────────────────────────────────────

export interface MeetingCrawlRecord {
  meetingId: string
  ftpPath: string
  crawledAt: string
  tdocCount: number
  checksum?: string
}

export interface CrawlState {
  lastRun: string
  meetings: Record<string, MeetingCrawlRecord>
}
