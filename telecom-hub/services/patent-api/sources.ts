import { XMLParser } from 'fast-xml-parser'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PatentData {
  patentNumber: string
  appNumber: string
  title: string
  abstract: string
  claims: string[]
  inventors: string[]
  assignee: string
  filingDate: string
  issueDate: string
  pdfUrl: string
}

export interface FileHistoryDoc {
  docCode: string
  description: string
  date: string
  pageCount: number
  docId: string
  appNumber: string
}

export interface FamilyMember {
  country: string
  docNumber: string
  kind: string
  status?: string
}

export interface PatentFamily {
  members: FamilyMember[]
}

// ── USPTO ODP API ─────────────────────────────────────────────────────────────

const ODP_BASE = 'https://api.openapi.uspto.gov/api/v1'

// Returns metadata + claims in one request so the worker makes a single call.
export async function fetchPatentWithClaims(
  patentNumber: string,
): Promise<{ patent: PatentData; claims: string[] }> {
  const cleanNum = patentNumber.replace(/[^0-9]/g, '')
  const apiKey   = process.env.USPTO_ODP_KEY ?? ''
  const fallback: PatentData = {
    patentNumber: cleanNum,
    appNumber:    '',
    title:        '',
    abstract:     '',
    claims:       [],
    inventors:    [],
    assignee:     '',
    filingDate:   '',
    issueDate:    '',
    pdfUrl:       `https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/${cleanNum}`,
  }

  try {
    const res = await fetch(`${ODP_BASE}/patent/${cleanNum}`, {
      headers: {
        'X-Api-Key': apiKey,
        Accept:      'application/json',
      },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return { patent: fallback, claims: [] }

    const d: any = await res.json()

    // Field names vary slightly across ODP API versions — try all known variants
    const title    = d.patentTitle        ?? d.patentTitleText    ?? d.inventionTitle ?? ''
    const abstract = d.abstractText       ?? d.patentAbstractText ?? d.abstract       ?? ''
    const appNum   = d.applicationNumber  ?? d.patentApplicationNumber               ?? ''
    const issued   = d.patentDate         ?? d.patentIssueDateText ?? d.issueDate     ?? ''
    const filed    = d.applicationDate    ?? d.filingDate ?? d.patentFilingDateText   ?? ''
    const assignee = (d.assignees ?? d.applicants ?? [])[0]?.assigneeName
                  ?? (d.assignees ?? d.applicants ?? [])[0]?.assigneeNameText
                  ?? (d.assignees ?? d.applicants ?? [])[0]?.name
                  ?? ''
    const inventors: string[] = (d.inventors ?? []).map((i: any) =>
      i.inventorName ?? i.inventorNameText
        ?? `${i.firstName ?? i.inventorFirstName ?? ''} ${i.lastName ?? i.inventorLastName ?? ''}`.trim()
    ).filter(Boolean)

    const patent: PatentData = {
      patentNumber: d.patentNumber ?? cleanNum,
      appNumber:    appNum,
      title,
      abstract,
      claims:       [],
      inventors,
      assignee,
      filingDate:   filed,
      issueDate:    issued,
      pdfUrl:       `https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/${cleanNum}`,
    }

    const rawClaims: any[] = d.claims ?? d.claimText ?? []
    const claims = (Array.isArray(rawClaims) ? rawClaims : [])
      .sort((a: any, b: any) => Number(a.claimNumber ?? a.number ?? 0) - Number(b.claimNumber ?? b.number ?? 0))
      .map((c: any) => c.claimText ?? c.text ?? c.claimStatement ?? '')
      .filter(Boolean)

    return { patent, claims }
  } catch {
    return { patent: fallback, claims: [] }
  }
}

// ── Patent PDF ────────────────────────────────────────────────────────────────

export async function fetchPatentPdf(patentNumber: string): Promise<Buffer | null> {
  const clean = patentNumber.replace(/[^0-9A-Za-z]/g, '')
  const url = `https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/${clean}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) return null
    return Buffer.from(await res.arrayBuffer())
  } catch {
    return null
  }
}

// ── USPTO Patent Center — file wrapper ───────────────────────────────────────

const SUBSTANTIVE_CODES = new Set([
  'CTNF', 'CTFR', 'MCTNF',      // non-final OA
  'CTAV', 'MCFR',                // final OA
  'CTNF.RCE', 'RCE',            // RCE
  'A..', 'AMEND', 'RESP',        // applicant responses
  'NOA', 'N417', 'ISSUE.NTC',   // notice of allowance
  'ABST.STMT',                   // abstract
  'WFEE', 'IFEE',               // issue fee payment
])

function isSubstantive(doc: any): boolean {
  const code: string = (doc.documentCode ?? doc.documentCodeDescription ?? '').toUpperCase()
  // Allow any code matching known substantive prefixes
  return SUBSTANTIVE_CODES.has(code) ||
    code.startsWith('CT') || code.startsWith('A.') ||
    code === 'NOA' || code === 'RCE' || code.includes('AMEND') ||
    code.includes('RESP') || code.includes('OFFICE') || code.includes('ALLOW')
}

export async function fetchFileHistory(appNumber: string): Promise<FileHistoryDoc[]> {
  const clean = appNumber.replace(/[^0-9]/g, '')
  const url = `https://patentcenter.uspto.gov/applications/${clean}/documents`
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return []
    const data: any = await res.json()
    const docs: any[] = data.patentDocumentMetaData ?? data.documents ?? []
    return docs
      .filter(isSubstantive)
      .map(d => ({
        docCode:     d.documentCode ?? '',
        description: d.documentCodeDescription ?? d.mailRoomDate ?? '',
        date:        d.mailRoomDate ?? d.officialDate ?? '',
        pageCount:   Number(d.pageCount ?? 0),
        docId:       d.documentIdentifier ?? d.documentId ?? '',
        appNumber:   clean,
      }))
      .sort((a, b) => a.date.localeCompare(b.date))
  } catch {
    return []
  }
}

export async function fetchFileHistoryDoc(appNumber: string, docId: string): Promise<Buffer | null> {
  const clean = appNumber.replace(/[^0-9]/g, '')
  const url = `https://patentcenter.uspto.gov/applications/${clean}/documents/${docId}/download`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) return null
    return Buffer.from(await res.arrayBuffer())
  } catch {
    return null
  }
}

// ── EPO OPS — patent family ───────────────────────────────────────────────────

let epoToken: string | null = null
let epoTokenExpiry = 0

async function getEpoToken(): Promise<string> {
  if (epoToken && Date.now() < epoTokenExpiry) return epoToken

  const key    = process.env.EPO_OPS_KEY!
  const secret = process.env.EPO_OPS_SECRET!
  const creds  = Buffer.from(`${key}:${secret}`).toString('base64')

  const res = await fetch('https://ops.epo.org/3.2/auth/accesstoken', {
    method: 'POST',
    headers: {
      Authorization:  `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  })
  if (!res.ok) throw new Error(`EPO auth failed: ${res.status}`)
  const data: any = await res.json()
  epoToken       = data.access_token
  epoTokenExpiry = Date.now() + (Number(data.expires_in ?? 1200) - 60) * 1000
  return epoToken!
}

export async function fetchPatentFamily(patentNumber: string): Promise<PatentFamily> {
  try {
    const token  = await getEpoToken()
    const clean  = patentNumber.replace(/[^0-9A-Za-z]/g, '')
    const url    = `https://ops.epo.org/3.2/rest-services/family/publication/docdb/US.${clean}.B2/biblio`

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept:        'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return { members: [] }

    const data: any = await res.json()
    const members: FamilyMember[] = []

    const familyMembers =
      data?.['ops:world-patent-data']?.['ops:patent-family']?.['ops:family-member'] ?? []
    const list = Array.isArray(familyMembers) ? familyMembers : [familyMembers]

    for (const m of list) {
      const pubRefs = m['publication-reference']?.['document-id']
      const refs = Array.isArray(pubRefs) ? pubRefs : pubRefs ? [pubRefs] : []
      for (const ref of refs) {
        if (ref['@doc-id-type'] === 'docdb' || ref['doc-id-type'] === 'docdb') {
          members.push({
            country:   ref['country'] ?? ref['country']['$'] ?? '',
            docNumber: ref['doc-number'] ?? ref['doc-number']['$'] ?? '',
            kind:      ref['kind'] ?? ref['kind']['$'] ?? '',
          })
        }
      }
    }

    return { members }
  } catch {
    return { members: [] }
  }
}
