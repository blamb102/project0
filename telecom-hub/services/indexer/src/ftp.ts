import { parse as parseHtml } from 'node-html-parser'
import { parseStringPromise } from 'xml2js'
import AdmZip from 'adm-zip'
import type { Meeting, TDoc } from '@telecom-hub/types'
import { config } from './config.js'

// ── Directory listing ─────────────────────────────────────────────────────────
// 3GPP FTP returns absolute URLs like https://www.3gpp.org/ftp/TSG_RAN/WG1_RL1/TSGR1_116
// We return only the last path segment of each child entry.

export async function listDirectory(ftpPath: string): Promise<string[]> {
  const url = `${config.ftpBase}/${ftpPath}/`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} listing ${url}`)
  const html = await res.text()
  const root = parseHtml(html)
  const base = url.replace(/\/$/, '')
  return root
    .querySelectorAll('a[href]')
    .map((a) => a.getAttribute('href') ?? '')
    .filter((h) => h.startsWith(base + '/'))
    .map((h) => h.slice(base.length + 1).replace(/\/$/, ''))
    .filter((h) => h.length > 0)
}

// ── Meetings discovery ────────────────────────────────────────────────────────

export async function discoverMeetings(
  wg: string,
  wgPath: string,
  limit?: number,
): Promise<Meeting[]> {
  const entries = await listDirectory(wgPath)
  // Only keep folders whose name ends with _<number><optional-letters>, e.g. TSGR1_99, TSGR1_116b
  const folders = entries.filter((e) => /_\d+[a-zA-Z]*$/.test(e))
  const selected = limit ? folders.slice(-limit) : folders

  return selected.map((folder) => {
    // Folder names look like TSGR1_116b — meeting number is after the last _
    const meetingNumber = folder.match(/_(\d+[a-zA-Z]?)$/)?.[1] ?? folder
    return {
      id: `${wg}#${meetingNumber}`,
      workingGroup: wg,
      meetingNumber,
      ftpPath: `${wgPath}/${folder}`,
    } satisfies Meeting
  })
}

// ── Per-meeting TDoc list (xlsx) ──────────────────────────────────────────────
// Each meeting folder has a Docs/TDoc_List_Meeting_{WG}#{num}.xlsx file with
// all TDoc metadata for that meeting.
// Columns (0-based): 0=TDoc, 1=Title, 2=Source, 5=Type, 10=AgendaItem,
//                    13=Status, 16=IsRevisionOf, 17=RevisedTo, 19=Spec, 22=CR

const meetingIndexCache = new Map<string, Map<string, TDocMeta>>()

interface TDocMeta {
  title: string
  source: string
  type: string
  status: string
  agenda?: string
  relatedSpec?: string
  relatedCr?: string
  revisionOf?: string
  revisedTo?: string
}

async function loadMeetingIndex(meeting: Meeting): Promise<Map<string, TDocMeta>> {
  if (meetingIndexCache.has(meeting.id)) return meetingIndexCache.get(meeting.id)!

  // The # in the filename must be percent-encoded for the HTTP request
  const fileName = `TDoc_List_Meeting_${meeting.workingGroup}%23${meeting.meetingNumber}.xlsx`
  const url = `${config.ftpBase}/${meeting.ftpPath}/Docs/${fileName}`

  console.log(`  Fetching meeting TDoc list: TDoc_List_Meeting_${meeting.workingGroup}#${meeting.meetingNumber}.xlsx`)
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const map = await parseXlsx(buf)
    meetingIndexCache.set(meeting.id, map)
    return map
  } catch (e) {
    console.warn(`  Could not fetch meeting TDoc list for ${meeting.id}: ${e}`)
    meetingIndexCache.set(meeting.id, new Map())
    return new Map()
  }
}

async function parseXlsx(buf: Buffer): Promise<Map<string, TDocMeta>> {
  // An xlsx file is a ZIP of XML files.
  const inner = new AdmZip(buf)

  // Shared strings table
  const ssEntry = inner.getEntry('xl/sharedStrings.xml')
  const strings: string[] = []
  if (ssEntry) {
    const xml = await parseStringPromise(ssEntry.getData().toString('utf8'))
    for (const si of xml?.sst?.si ?? []) {
      const parts: string[] = []
      for (const t of si.t ?? []) parts.push(typeof t === 'string' ? t : t._ ?? t?.$?.xml_space === 'preserve' ? ' ' : '')
      for (const r of si.r ?? []) for (const t of r.t ?? []) parts.push(typeof t === 'string' ? t : t._ ?? '')
      strings.push(parts.join(''))
    }
  }

  // Sheet1
  const sheetEntry = inner.getEntry('xl/worksheets/sheet1.xml')
  if (!sheetEntry) return new Map()

  const sheetXml = await parseStringPromise(sheetEntry.getData().toString('utf8'))
  const rows: any[] = sheetXml?.worksheet?.sheetData?.[0]?.row ?? []

  const map = new Map<string, TDocMeta>()
  let headers: string[] = []

  for (const row of rows) {
    const cells: string[] = []
    for (const c of row.c ?? []) {
      const col = colIndex(c.$.r)
      const t = c.$.t
      const v = c.v?.[0]
      let val = ''
      if (v !== undefined) {
        val = t === 's' ? (strings[parseInt(v)] ?? '') : String(v)
      }
      cells[col] = val
    }

    if (headers.length === 0) {
      headers = cells
      continue
    }

    const tdocId = (cells[0] ?? '').trim()
    if (!tdocId) continue

    map.set(tdocId, {
      title:      (cells[1] ?? '').trim() || '(no title)',
      source:     (cells[2] ?? '').trim(),
      type:       (cells[5] ?? '').trim(),
      status:     normaliseStatus(cells[13] ?? ''),
      agenda:     (cells[10] ?? '').trim() || undefined,
      relatedSpec:(cells[19] ?? '').trim() || undefined,
      relatedCr:  (cells[22] ?? '').trim() || undefined,
      revisionOf: (cells[16] ?? '').trim() || undefined,
      revisedTo:  (cells[17] ?? '').trim() || undefined,
    })
  }

  return map
}

// Convert a cell reference like "A1", "B3", "AA5" to a 0-based column index
function colIndex(ref: string): number {
  const col = ref.replace(/\d+$/, '')
  let n = 0
  for (const ch of col) n = n * 26 + ch.charCodeAt(0) - 64
  return n - 1
}

// ── TDoc fetching ─────────────────────────────────────────────────────────────

export async function fetchTDocs(meeting: Meeting): Promise<TDoc[]> {
  const metaMap = await loadMeetingIndex(meeting)

  // If the meeting index loaded successfully with data, use it directly —
  // no need to list Docs/ separately since the xlsx has the canonical TDoc list.
  if (metaMap.size > 0) {
    const now = new Date().toISOString()
    return Array.from(metaMap.entries()).map(([tdocId, meta]) => ({
      id: tdocId,
      meetingId: meeting.id,
      workingGroup: meeting.workingGroup,
      title:      meta.title,
      source:     meta.source,
      type:       (meta.type || 'TD') as TDoc['type'],
      status:     meta.status as TDoc['status'],
      agenda:     meta.agenda,
      relatedSpec:meta.relatedSpec,
      relatedCr:  meta.relatedCr,
      revisionOf: meta.revisionOf,
      revisedTo:  meta.revisedTo,
      ftpUrl:     `${config.ftpBase}/${meeting.ftpPath}/Docs/${encodeURIComponent(tdocId)}.zip`,
      indexedAt:  now,
    }))
  }

  // Fallback: list Docs/ directory for TDoc IDs (no metadata available)
  let docEntries: string[]
  try {
    docEntries = await listDirectory(`${meeting.ftpPath}/Docs`)
  } catch {
    console.warn(`  Docs/ not found for ${meeting.id}`)
    return []
  }

  const now = new Date().toISOString()
  return docEntries.map((entry) => {
    const tdocId = entry.replace(/\.zip$/i, '').replace(/\.docx?$/i, '').trim()
    return {
      id: tdocId,
      meetingId: meeting.id,
      workingGroup: meeting.workingGroup,
      title:      '(no title)',
      source:     '',
      type:       'TD',
      status:     'unknown' as TDoc['status'],
      ftpUrl:     `${config.ftpBase}/${meeting.ftpPath}/Docs/${entry}`,
      indexedAt:  now,
    }
  })
}

function normaliseStatus(raw: string): TDoc['status'] {
  const s = raw.toLowerCase().trim()
  if (s.includes('agree'))      return 'agreed'
  if (s.includes('approv'))     return 'approved'
  if (s.includes('note'))       return 'noted'
  if (s.includes('revis'))      return 'revised'
  if (s.includes('reject'))     return 'rejected'
  if (s.includes('withdraw'))   return 'withdrawn'
  if (s.includes('postpone'))   return 'postponed'
  if (s.includes('merge'))      return 'merged'
  if (s.includes('not treat'))  return 'not treated'
  return 'unknown'
}
