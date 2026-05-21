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

// ── PatentsView ───────────────────────────────────────────────────────────────

export async function fetchPatentData(patentOrApp: string): Promise<PatentData> {
  const isApp = /^\d{8}$/.test(patentOrApp.replace(/[^0-9]/g, ''))
  const cleanNum = patentOrApp.replace(/[^0-9A-Za-z]/g, '')

  // Try PatentsView for issued patents
  const pvRes = await fetch('https://api.patentsview.org/patents/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      q: { patent_number: cleanNum },
      f: [
        'patent_number', 'app_number', 'patent_title', 'patent_abstract',
        'patent_date', 'app_date', 'inventor_first_name', 'inventor_last_name',
        'assignee_organization',
      ],
      o: { per_page: 1 },
    }),
  })

  if (pvRes.ok) {
    const pv: any = await pvRes.json()
    const p = pv.patents?.[0]
    if (p) {
      const inventors = (p.inventors ?? []).map(
        (i: any) => `${i.inventor_first_name ?? ''} ${i.inventor_last_name ?? ''}`.trim(),
      )
      return {
        patentNumber: p.patent_number ?? cleanNum,
        appNumber:    p.app_number ?? '',
        title:        p.patent_title ?? '',
        abstract:     p.patent_abstract ?? '',
        claims:       [],
        inventors,
        assignee:     p.assignees?.[0]?.assignee_organization ?? '',
        filingDate:   p.app_date ?? '',
        issueDate:    p.patent_date ?? '',
        pdfUrl:       `https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/${cleanNum}`,
      }
    }
  }

  // Fallback: return minimal struct so rest of pipeline can continue
  return {
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
}

// ── Patent claims via PatentsView ─────────────────────────────────────────────

export async function fetchClaims(patentNumber: string): Promise<string[]> {
  const res = await fetch('https://api.patentsview.org/patents/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      q: { patent_number: patentNumber.replace(/[^0-9A-Za-z]/g, '') },
      f: ['claim_text', 'claim_number', 'claim_dependent'],
      o: { per_page: 1 },
    }),
  })
  if (!res.ok) return []
  const data: any = await res.json()
  const claims: any[] = data.patents?.[0]?.claims ?? []
  return claims
    .sort((a: any, b: any) => Number(a.claim_number) - Number(b.claim_number))
    .map((c: any) => c.claim_text ?? '')
    .filter(Boolean)
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
