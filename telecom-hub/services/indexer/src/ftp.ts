import { parse as parseHtml } from 'node-html-parser'
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
  // Meeting folders typically look like "RAN1_116_e" or "RAN_116"
  const folders = entries.filter((e) => /\d/.test(e))
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

// ── TDoc fetching via Docs/ subfolder ─────────────────────────────────────────
// Each meeting has a Docs/ subdirectory with files named <TDocId>.zip.
// We list those to get TDoc IDs and construct minimal records.

export async function fetchTDocs(meeting: Meeting): Promise<TDoc[]> {
  let docEntries: string[]
  try {
    docEntries = await listDirectory(`${meeting.ftpPath}/Docs`)
  } catch {
    console.warn(`  Docs/ not found for ${meeting.id}`)
    return []
  }

  const now = new Date().toISOString()
  const tdocs: TDoc[] = []

  for (const entry of docEntries) {
    // Entry is the last path segment, e.g. "R1-2401935.zip"
    const tdocId = entry.replace(/\.zip$/i, '').replace(/\.docx?$/i, '')
    if (!tdocId) continue

    tdocs.push({
      id: tdocId,
      meetingId: meeting.id,
      workingGroup: meeting.workingGroup,
      title: '(title not fetched — requires doc download)',
      source: '',
      type: 'TD',
      status: 'unknown',
      ftpUrl: `${config.ftpBase}/${meeting.ftpPath}/Docs/${entry}`,
      indexedAt: now,
    })
  }

  return tdocs
}

function normaliseStatus(raw: string): TDoc['status'] {
  const s = raw.toLowerCase().trim()
  if (s.includes('agree')) return 'agreed'
  if (s.includes('approv')) return 'approved'
  if (s.includes('note')) return 'noted'
  if (s.includes('revis')) return 'revised'
  if (s.includes('reject')) return 'rejected'
  if (s.includes('withdraw')) return 'withdrawn'
  if (s.includes('postpone')) return 'postponed'
  if (s.includes('merge')) return 'merged'
  if (s.includes('not treat')) return 'not treated'
  return 'unknown'
}
