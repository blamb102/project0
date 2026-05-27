import { XMLParser } from 'fast-xml-parser'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PatentData {
  patentNumber: string
  appNumber: string
  title: string
  abstract: string
  description: string
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
  downloadUrl: string
}

export interface FamilyMember {
  country: string
  docNumber: string
  kind: string
  appNumber?: string
  filingDate?: string
  status?: string
}

export interface PatentFamily {
  members: FamilyMember[]
  usAppNumber?: string
}

// ── USPTO ODP API ─────────────────────────────────────────────────────────────

const ODP_BASE = 'https://api.uspto.gov/api/v1'

// ── XML parsing helpers ───────────────────────────────────────────────────────

const grantXmlParser = new XMLParser({
  preserveOrder:       true,
  processEntities:     true,
  htmlEntities:        true,
  ignoreAttributes:    false,
  attributeNamePrefix: '@_',
  textNodeName:        '#text',
})

// Find first occurrence of a tag anywhere in the tree (BFS-style).
function findNode(nodes: any[], tag: string): any | null {
  for (const node of nodes) {
    const key = Object.keys(node).find(k => k !== ':@')
    if (!key) continue
    if (key === tag) return node
    if (Array.isArray(node[key])) {
      const found = findNode(node[key], tag)
      if (found) return found
    }
  }
  return null
}

// Collect all occurrences of a tag at any depth (DFS).
function findAllNodes(nodes: any[], tag: string): any[] {
  const results: any[] = []
  for (const node of nodes) {
    const key = Object.keys(node).find(k => k !== ':@')
    if (!key) continue
    if (key === tag) results.push(node)
    if (Array.isArray(node[key])) results.push(...findAllNodes(node[key], tag))
  }
  return results
}

// Convert a preserveOrder node array to a plain-text string with ^{}/_{} notation.
// Handles MathML structurally and decodes all XML entities via the parser.
function nodesToText(nodes: any[]): string {
  return nodes.map(node => {
    const key = Object.keys(node).find(k => k !== ':@') ?? ''
    if (!key) return ''
    if (key === '#text') return String(node['#text'] ?? '')

    const children: any[] = node[key] ?? []
    // Element children only (exclude whitespace-only text nodes for structural decisions)
    const elems = children.filter(c => {
      const k = Object.keys(c).find(k => k !== ':@') ?? ''
      return k !== '#text' || String(c['#text']).trim() !== ''
    })

    switch (key) {
      case 'sup':    return '^{' + nodesToText(children) + '}'
      case 'sub':    return '_{' + nodesToText(children) + '}'
      case 'br':
      case 'mspace': return ' '
      case 'img':
      case 'annotation': return ''

      // MathML: msup — base^{exponent}
      case 'msup':
        return elems.length >= 2
          ? nodesToText([elems[0]]) + '^{' + nodesToText([elems[1]]) + '}'
          : nodesToText(children)

      // MathML: msub — base_{subscript}
      case 'msub':
        return elems.length >= 2
          ? nodesToText([elems[0]]) + '_{' + nodesToText([elems[1]]) + '}'
          : nodesToText(children)

      // MathML: msubsup — base_{sub}^{sup}
      case 'msubsup':
        return elems.length >= 3
          ? nodesToText([elems[0]]) + '_{' + nodesToText([elems[1]]) + '}^{' + nodesToText([elems[2]]) + '}'
          : nodesToText(children)

      // MathML: mfrac — (num)/(denom)
      case 'mfrac':
        return elems.length >= 2
          ? '(' + nodesToText([elems[0]]) + ')/(' + nodesToText([elems[1]]) + ')'
          : nodesToText(children)

      // MathML: msqrt / mroot
      case 'msqrt': return '√(' + nodesToText(children) + ')'
      case 'mroot':
        return elems.length >= 2
          ? nodesToText([elems[1]]) + '√(' + nodesToText([elems[0]]) + ')'
          : nodesToText(children)

      // MathML: mfenced — use open/close attributes (defaults "()")
      case 'mfenced': {
        const attrs = node[':@'] ?? {}
        const open  = attrs['@_open']  ?? '('
        const close = attrs['@_close'] ?? ')'
        return open + nodesToText(children) + close
      }

      // MathML: mo (operator) — surround with spaces unless punctuation
      case 'mo': {
        const t = nodesToText(children).trim()
        return /^[.,;:!?]$/.test(t) ? t : ' ' + t + ' '
      }

      // Inline patent elements: wrap claim-ref with spaces so surrounding text connects properly
      case 'claim-ref': {
        const t = nodesToText(children).trim()
        return t ? ' ' + t + ' ' : ''
      }

      // MathML: mrow, math, mtext, mi, mn — just recurse
      default: return nodesToText(children)
    }
  }).join('')
}

// Render a <table> node (HTML-style tr/td or CALS-style row/entry) as
// pipe-delimited text rows for later DOCX table construction.
function tableToText(tableChildren: any[]): string {
  const rows: string[] = []

  function processRow(rowChildren: any[]): void {
    const cells = rowChildren
      .filter(c => {
        const k = Object.keys(c).find(k => k !== ':@') ?? ''
        return ['td', 'th', 'entry'].includes(k)
      })
      .map(c => {
        const k = Object.keys(c).find(k => k !== ':@') ?? ''
        return nodesToText(c[k] ?? []).replace(/\s+/g, ' ').trim()
      })
    if (cells.length) rows.push('| ' + cells.join(' | ') + ' |')
  }

  function processNode(children: any[]): void {
    for (const child of children) {
      const key = Object.keys(child).find(k => k !== ':@') ?? ''
      if (key === 'tr' || key === 'row') {
        processRow(child[key] ?? [])
      } else if (['thead', 'tbody', 'tfoot', 'tgroup', 'table'].includes(key)) {
        processNode(child[key] ?? [])
      }
    }
  }

  processNode(tableChildren)
  return rows.join('\n')
}

// Convert the children of a <claim-text> node into indented lines.
// Inline content (text, claim-ref, sup, sub, math, etc.) forms the preamble at `depth`.
// Nested <claim-text> elements are recursed at depth+1.
function claimTextToLines(children: any[], depth: number): string {
  const inline: any[] = []
  const nested: any[] = []
  for (const child of children) {
    const key = Object.keys(child).find(k => k !== ':@') ?? ''
    if (key === 'claim-text') nested.push(child)
    else inline.push(child)
  }
  const preamble = nodesToText(inline).replace(/\s+/g, ' ').replace(/ ([,;])/g, '$1').trim()
  const lines: string[] = []
  if (preamble) lines.push('\t'.repeat(depth) + preamble)
  for (const n of nested) {
    const sub = claimTextToLines(n['claim-text'] ?? [], depth + 1)
    if (sub) lines.push(sub)
  }
  return lines.join('\n')
}

async function fetchGrantXmlContent(
  xmlUrl: string,
  apiKey: string,
): Promise<{ abstract: string; description: string; claims: string[] }> {
  try {
    const res = await fetch(xmlUrl, {
      headers: { 'x-api-key': apiKey },
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null)
    if (!res?.ok) return { abstract: '', description: '', claims: [] }

    const xml = await res.text()
    const doc  = grantXmlParser.parse(xml) as any[]

    // ── Abstract ──────────────────────────────────────────────────────────────
    const abstractNode = findNode(doc, 'abstract')
    const abstract = abstractNode
      ? nodesToText(abstractNode['abstract']).replace(/\s+/g, ' ').trim()
      : ''

    // ── Description ───────────────────────────────────────────────────────────
    // Walk direct children of <description> in document order.
    // <heading> → HEADING: prefix; <table> → TABLE: prefix with pipe rows;
    // <p> and anything else with text content → plain paragraph.
    const descNode = findNode(doc, 'description')
    let description = ''
    if (descNode) {
      const parts: string[] = []
      const descChildren: any[] = descNode['description'] ?? []
      for (const child of descChildren) {
        const key = Object.keys(child).find(k => k !== ':@') ?? ''
        if (!key) continue
        if (key === 'heading') {
          const text = nodesToText(child[key]).replace(/\s+/g, ' ').trim()
          if (text) parts.push(`HEADING: ${text}`)
        } else if (key === 'table') {
          const text = tableToText(child[key] ?? [])
          if (text.trim()) parts.push('TABLE:\n' + text)
        } else {
          // <p>, <ul>, <ol>, <pre>, <figure>, and any other element —
          // extract all text content; tables nested inside paragraphs are
          // also handled because nodesToText recurses into all children.
          const text = nodesToText(child[key] ?? []).replace(/\s+/g, ' ').trim()
          if (text) parts.push(text)
        }
      }
      description = parts.join('\n\n')
    }

    // ── Claims ────────────────────────────────────────────────────────────────
    const claimsNode = findNode(doc, 'claims')
    const claims: string[] = []
    if (claimsNode) {
      const claimNodes = findAllNodes(claimsNode['claims'] ?? [], 'claim')
      for (const claimNode of claimNodes) {
        const claimChildren: any[] = claimNode['claim'] ?? []
        // Find the top-level <claim-text> child
        const topClaimText = claimChildren.find(c => {
          const k = Object.keys(c).find(k => k !== ':@') ?? ''
          return k === 'claim-text'
        })
        if (!topClaimText) continue
        const text = claimTextToLines(topClaimText['claim-text'] ?? [], 0)
        if (text) claims.push(text)
      }
    }

    return { abstract, description, claims }
  } catch {
    return { abstract: '', description: '', claims: [] }
  }
}

// Returns metadata + claims in one request so the worker makes a single call.
export async function fetchPatentWithClaims(
  patentNumber: string,
  appNumber?: string,
): Promise<{ patent: PatentData; claims: string[] }> {
  const cleanNum = patentNumber.replace(/[^0-9]/g, '')
  const apiKey   = process.env.USPTO_ODP_KEY ?? ''
  const fallback: PatentData = {
    patentNumber: cleanNum,
    appNumber:    '',
    title:        '',
    abstract:     '',
    description:  '',
    claims:       [],
    inventors:    [],
    assignee:     '',
    filingDate:   '',
    issueDate:    '',
    pdfUrl:       `https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/${cleanNum}`,
  }

  try {
    const res = await fetch(`${ODP_BASE}/patent/${cleanNum}`, {
      headers: { 'x-api-key': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null)
    if (!res?.ok) {
      // Try ODP application metadata endpoint as fallback
      if (appNumber) {
        const appRes = await fetch(`${ODP_BASE}/patent/applications/${appNumber}`, {
          headers: { 'x-api-key': apiKey, Accept: 'application/json' },
          signal: AbortSignal.timeout(20_000),
        }).catch(() => null)
        if (appRes?.ok) {
          const d: any = await appRes.json()
          const wrapper  = (d.patentFileWrapperDataBag ?? [])[0] ?? {}
          const meta     = wrapper.applicationMetaData ?? {}
          const title    = meta.inventionTitle ?? ''
          const appNum   = wrapper.applicationNumberText ?? appNumber
          const filed    = meta.filingDate ?? ''
          const issued   = meta.grantDate  ?? ''
          const patNum   = meta.patentNumber ?? cleanNum
          const inventors: string[] = (meta.inventorBag ?? []).map((i: any) =>
            i.inventorName ?? `${i.firstName ?? ''} ${i.lastName ?? ''}`.trim()
          ).filter(Boolean)
          const assignee = (meta.applicantBag ?? [])[0]?.applicantName
                        ?? (meta.applicantBag ?? [])[0]?.name ?? ''

          // Fetch full-text grant XML for abstract + description + claims
          const xmlUrl = wrapper.grantDocumentMetaData?.fileLocationURI ?? ''
          const { abstract, description, claims } = xmlUrl
            ? await fetchGrantXmlContent(xmlUrl, apiKey)
            : { abstract: '', description: '', claims: [] }

          return {
            patent: {
              ...fallback,
              patentNumber: patNum,
              appNumber:    appNum,
              title,
              abstract,
              description,
              inventors,
              assignee,
              filingDate: filed,
              issueDate:  issued,
            },
            claims,
          }
        }
      }
      return { patent: fallback, claims: [] }
    }

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
      description:  '',
      claims:       [],
      inventors,
      assignee,
      filingDate:   filed,
      issueDate:    issued,
      pdfUrl:       `https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/${cleanNum}`,
    }

    const rawClaims: any[] = d.claims ?? d.claimText ?? []
    let claims = (Array.isArray(rawClaims) ? rawClaims : [])
      .sort((a: any, b: any) => Number(a.claimNumber ?? a.number ?? 0) - Number(b.claimNumber ?? b.number ?? 0))
      .map((c: any) => c.claimText ?? c.text ?? c.claimStatement ?? '')
      .filter(Boolean)

    // Older patents don't include claims in the JSON — fetch the grant XML instead
    if (claims.length === 0) {
      const xmlAppNum = patent.appNumber || appNumber
      if (xmlAppNum) {
        try {
          const appRes = await fetch(`${ODP_BASE}/patent/applications/${xmlAppNum}`, {
            headers: { 'x-api-key': apiKey, Accept: 'application/json' },
            signal: AbortSignal.timeout(20_000),
          }).catch(() => null)
          if (appRes?.ok) {
            const appData: any = await appRes.json()
            const wrapper = (appData.patentFileWrapperDataBag ?? [])[0] ?? {}
            const xmlUrl  = wrapper.grantDocumentMetaData?.fileLocationURI ?? ''
            if (xmlUrl) {
              const { abstract: xa, description: xd, claims: xc } =
                await fetchGrantXmlContent(xmlUrl, apiKey)
              if (xc.length > 0) {
                if (!patent.abstract)     patent.abstract     = xa
                if (!patent.description)  patent.description  = xd
                claims = xc
              }
            }
          }
        } catch { /* silent */ }
      }
    }

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

// Skip foreign references and NPL — everything else is included in the file wrapper
const SKIP_PREFIXES = ['FOR', 'NPL', 'REF.OTHER']

function shouldSkipDoc(doc: any): boolean {
  const code = (doc.documentCode ?? '').toUpperCase()
  return SKIP_PREFIXES.some(p => code.startsWith(p))
}

export async function fetchFileHistory(appNumber: string): Promise<FileHistoryDoc[]> {
  const clean = appNumber.replace(/[^0-9]/g, '')
  const apiKey = process.env.USPTO_ODP_KEY ?? ''
  const url = `${ODP_BASE}/patent/applications/${clean}/documents`
  try {
    const res = await fetch(url, {
      headers: { 'x-api-key': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return []
    const data: any = await res.json()
    const docs: any[] = data.documentBag ?? []
    return docs
      .filter(d => !shouldSkipDoc(d))
      .map(d => {
        const dl = (d.downloadOptionBag ?? [])[0] ?? {}
        return {
          docCode:     d.documentCode ?? '',
          description: d.documentCodeDescriptionText ?? '',
          date:        d.officialDate ?? '',
          pageCount:   Number(dl.pageTotalQuantity ?? 0),
          docId:       d.documentIdentifier ?? '',
          appNumber:   clean,
          downloadUrl: dl.downloadUrl ?? '',
        }
      })
      .sort((a, b) => a.date.localeCompare(b.date))
  } catch {
    return []
  }
}

export async function fetchFileHistoryDoc(doc: FileHistoryDoc): Promise<Buffer | null> {
  const apiKey = process.env.USPTO_ODP_KEY ?? ''
  const url = doc.downloadUrl
  if (!url) return null
  try {
    const res = await fetch(url, {
      headers: { 'x-api-key': apiKey },
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) return null
    return Buffer.from(await res.arrayBuffer())
  } catch {
    return null
  }
}

// ── USPTO ODP — Assignment history ───────────────────────────────────────────

export interface AssignmentRecord {
  recordedDate: string
  conveyance:   string
  reelFrame:    string
  assignors:    string[]
  assignees:    Array<{ name: string; city: string; country: string }>
}

export async function fetchAssignmentHistory(appNumber: string): Promise<AssignmentRecord[]> {
  const clean  = appNumber.replace(/[^0-9]/g, '')
  const apiKey = process.env.USPTO_ODP_KEY ?? ''
  try {
    const res = await fetch(`${ODP_BASE}/patent/applications/${clean}/assignment`, {
      headers: { 'x-api-key': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return []
    const data: any = await res.json()
    const bag: any[] = (data.patentFileWrapperDataBag ?? [])[0]?.assignmentBag ?? []
    return bag
      .map((a: any): AssignmentRecord => ({
        recordedDate: a.assignmentRecordedDate ?? '',
        conveyance:   a.conveyanceText ?? '',
        reelFrame:    a.reelAndFrameNumber ?? '',
        assignors:    (a.assignorBag ?? []).map((x: any) => x.assignorName ?? '').filter(Boolean),
        assignees:    (a.assigneeBag ?? []).map((x: any) => ({
          name:    x.assigneeNameText ?? '',
          city:    x.assigneeAddress?.cityName ?? '',
          country: x.assigneeAddress?.countryName ?? '',
        })),
      }))
      .sort((a, b) => a.recordedDate.localeCompare(b.recordedDate))
  } catch {
    return []
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
    // /biblio causes 413 for large families (hundreds of members) — use plain family endpoint
    const epoBase = 'https://ops.epo.org/3.2/rest-services/family/publication/docdb'
    const epoHeaders = { Authorization: `Bearer ${token}`, Accept: 'application/json' }

    let res = await fetch(`${epoBase}/US.${clean}.B2`, {
      headers: epoHeaders,
      signal: AbortSignal.timeout(15_000),
    })
    // Older US patents use B1 kind code (issued before ~2001) — try as fallback
    if (!res.ok) {
      res = await fetch(`${epoBase}/US.${clean}.B1`, {
        headers: epoHeaders,
        signal: AbortSignal.timeout(15_000),
      })
    }
    if (!res.ok) return { members: [] }

    const data: any = await res.json()
    const members: FamilyMember[] = []
    let usAppNumber: string | undefined

    const familyMembers =
      data?.['ops:world-patent-data']?.['ops:patent-family']?.['ops:family-member'] ?? []
    const list = Array.isArray(familyMembers) ? familyMembers : [familyMembers]

    function normaliseAppNum(country: string, raw: string): string {
      const digits = raw.replace(/[^0-9]/g, '')
      return (country === 'US' && digits.length >= 12) ? digits.slice(4) : digits || raw
    }

    for (const m of list) {
      const pubRefs = m['publication-reference']?.['document-id']
      const refs = Array.isArray(pubRefs) ? pubRefs : pubRefs ? [pubRefs] : []

      // Extract application-reference data once per family member
      const appDocId  = m['application-reference']?.['document-id']
      const appDocIds: any[] = Array.isArray(appDocId) ? appDocId : appDocId ? [appDocId] : []
      // Take the first app-ref entry (plain family endpoint returns one per member)
      const appRef    = appDocIds[0]
      const appRawNum = appRef?.['doc-number']?.['$'] ?? appRef?.['doc-number'] ?? ''
      const appRawDate = appRef?.['date']?.['$'] ?? appRef?.['date'] ?? ''
      const appCountry = appRef?.['country']?.['$'] ?? appRef?.['country'] ?? ''

      const memberAppNum     = appRawNum ? normaliseAppNum(appCountry, appRawNum) : undefined
      const memberFilingDate = appRawDate || undefined

      let isUsGrant = false
      for (const ref of refs) {
        // EPO OPS JSON uses @document-id-type (not @doc-id-type)
        if (ref['@document-id-type'] === 'docdb' || ref['@doc-id-type'] === 'docdb') {
          // Fields come back as {"$": "value"} text nodes — check $ first
          const country   = ref['country']?.['$']    ?? ref['country']    ?? ''
          const docNumber = ref['doc-number']?.['$'] ?? ref['doc-number'] ?? ''
          const kind      = ref['kind']?.['$']       ?? ref['kind']       ?? ''
          members.push({ country, docNumber, kind, appNumber: memberAppNum, filingDate: memberFilingDate })
          if (country === 'US' && kind.startsWith('B')) isUsGrant = true
        }
      }

    }

    // The family endpoint's DOCDB application reference uses EPO's internal numbering for older
    // patents — not the USPTO application number. Always fetch the biblio endpoint instead, which
    // includes an 'original' doc-type that carries the exact USPTO app number (e.g. "11399827").
    // Try B2 first (post-2001 US grants), fall back to B1 (older grants).
    const biBase = 'https://ops.epo.org/3.2/rest-services/published-data/publication/docdb'
    let pdRes: Response | null = await fetch(`${biBase}/US.${clean}.B2/biblio`, {
      headers: epoHeaders, signal: AbortSignal.timeout(15_000),
    }).catch(() => null)
    if (!pdRes?.ok) {
      pdRes = await fetch(`${biBase}/US.${clean}.B1/biblio`, {
        headers: epoHeaders, signal: AbortSignal.timeout(15_000),
      }).catch(() => null)
    }
    if (pdRes?.ok) {
      try {
        const pdData: any = await pdRes.json()
        const doc    = pdData?.['ops:world-patent-data']?.['exchange-documents']?.['exchange-document']
        const docArr: any[] = Array.isArray(doc) ? doc : doc ? [doc] : []
        for (const d of docArr) {
          const appRef    = d?.['bibliographic-data']?.['application-reference']
          const appDocId  = appRef?.['document-id']
          const appDocIds: any[] = Array.isArray(appDocId) ? appDocId : appDocId ? [appDocId] : []
          // Prefer 'original' type — gives the exact USPTO app number without transformation
          for (const ref of appDocIds) {
            if ((ref['@document-id-type'] ?? ref['@doc-id-type']) === 'original') {
              const rawNum = ref['doc-number']?.['$'] ?? ref['doc-number'] ?? ''
              if (rawNum) { usAppNumber = rawNum.replace(/[^0-9]/g, ''); break }
            }
          }
          // Fall back to 'docdb' (works for newer patents where DOCDB = USPTO app number)
          if (!usAppNumber) {
            for (const ref of appDocIds) {
              if (ref['@document-id-type'] !== 'docdb' && ref['@doc-id-type'] !== 'docdb') continue
              const country = ref['country']?.['$'] ?? ref['country'] ?? ''
              const rawNum  = ref['doc-number']?.['$'] ?? ref['doc-number'] ?? ''
              if (country === 'US' && rawNum) {
                const digits = rawNum.replace(/[^0-9]/g, '')
                usAppNumber  = digits.length >= 12 ? digits.slice(4) : digits
                break
              }
            }
          }
          if (usAppNumber) break
        }
      } catch { /* silent */ }
    }

    return { members, usAppNumber }
  } catch {
    return { members: [] }
  }
}

// ── USPTO ODP — US prosecution continuity family tree ─────────────────────────

export interface FamilyTreeNode {
  appNumber: string
  filingDate: string
  effectiveFilingDate: string
  grantDate: string
  patentNumber: string
  publicationNumber: string
  status: string
  applicationType: string  // PROVSNL | REGULAR | REEXAM | DESIGN | …
  firstInventor: string
  isPriority: boolean
  priorityCountry?: string
}

export interface FamilyTreeEdge {
  source: string
  target: string
  relation: string  // CON | CIP | DIV | PRO | …
}

export interface FamilyTreeData {
  nodes: FamilyTreeNode[]
  edges: FamilyTreeEdge[]
  rootApp: string
}

const TREE_FIELDS: Record<string, string[]> = {
  appNumber:           ['applicationnumbertext'],
  filingDate:          ['filingdate'],
  effectiveFilingDate: ['effectivefilingdate'],
  grantDate:           ['grantdate'],
  patentNumber:        ['patentnumber'],
  publicationNumber:   ['publicationsequencenumber', 'publicationnumber'],
  status:              ['applicationstatusdescriptiontext', 'applicationstatus'],
  applicationType:     ['applicationtypecategory'],
  firstInventor:       ['firstinventorname'],
}

function treeVal(obj: any, keys: string[]): string {
  if (!obj || typeof obj !== 'object') return ''
  if (Array.isArray(obj)) {
    for (const item of obj) { const r = treeVal(item, keys); if (r) return r }
    return ''
  }
  for (const [k, v] of Object.entries(obj)) {
    if (keys.includes(k.toLowerCase())) return String(v ?? '')
    const r = treeVal(v, keys); if (r) return r
  }
  return ''
}

function extractTreeMeta(json: any): Omit<FamilyTreeNode, 'isPriority'> {
  const get = (f: string) => treeVal(json, TREE_FIELDS[f] ?? [])
  return {
    appNumber:           get('appNumber'),
    filingDate:          get('filingDate'),
    effectiveFilingDate: get('effectiveFilingDate'),
    grantDate:           get('grantDate'),
    patentNumber:        get('patentNumber'),
    publicationNumber:   get('publicationNumber'),
    status:              get('status'),
    applicationType:     get('applicationType'),
    firstInventor:       get('firstInventor'),
  }
}

// USPTO ODP returns PCT numbers as "PCTUS2008072352" (no slashes) in JSON bodies,
// but also accepts the slash form "PCT/US2008/072352" in URL paths.
// Canonical internal form: "PCT/CCYYYY/NNNNNN" (six-digit zero-padded sequence).
function normalizePct(cc: string, yr: string, seq: string): string {
  return `PCT/${cc.toUpperCase()}${yr}/${seq.padStart(6, '0')}`
}

function normalizeAppNum(raw: string): string {
  const str = String(raw ?? '').trim()
  // With slashes: PCT/US2008/072352 or PCT/US/2008/072352
  const s = str.match(/^PCT\/([A-Z]{2})\/?(\d{4})\/(\d+)$/i)
  if (s) return normalizePct(s[1], s[2], s[3])
  // Without slashes: PCTUS2008072352
  const n = str.match(/^PCT([A-Z]{2})(\d{4})(\d{4,7})$/i)
  if (n) return normalizePct(n[1], n[2], n[3])
  return str.replace(/\D/g, '')
}

function isPctApp(num: string): boolean {
  return num.startsWith('PCT/')
}

function parseContinuity(
  appNo: string,
  json: any,
): {
  parentEdges:  FamilyTreeEdge[]
  childEntries: Array<{ appNum: string; rel: string }>
  pctDates:     Map<string, string>
} {
  const parentEdges:  FamilyTreeEdge[] = []
  const childEntries: Array<{ appNum: string; rel: string }> = []
  const pctDates = new Map<string, string>()

  const bags: any[] = Array.isArray(json?.patentFileWrapperDataBag)
    ? json.patentFileWrapperDataBag
    : json?.patentFileWrapperDataBag ? [json.patentFileWrapperDataBag] : []

  for (const bag of bags) {
    if (!bag || typeof bag !== 'object') continue

    const asList = (x: any): any[] => Array.isArray(x) ? x : x ? [x] : []

    for (const rec of asList(bag.parentContinuityBag)) {
      const parent = normalizeAppNum(rec?.parentApplicationNumberText ?? '')
      const child  = normalizeAppNum(rec?.childApplicationNumberText  ?? '')
      const rel    = String(rec?.claimParentageTypeCode ?? 'UNKNOWN').trim().toUpperCase()
      if (parent && child === appNo) {
        parentEdges.push({ source: parent, target: child, relation: rel })
        if (isPctApp(parent)) {
          const fd = String(rec?.parentFilingDate ?? rec?.parentPatentApplicationFilingDate ?? '')
          if (fd) pctDates.set(parent, fd)
        }
      }
    }

    for (const rec of asList(bag.childContinuityBag)) {
      const parent = normalizeAppNum(rec?.parentApplicationNumberText ?? '')
      const child  = normalizeAppNum(rec?.childApplicationNumberText  ?? '')
      const rel    = String(rec?.claimParentageTypeCode ?? 'UNKNOWN').trim().toUpperCase()
      if (child && parent === appNo) {
        childEntries.push({ appNum: child, rel })
        if (isPctApp(child)) {
          const fd = String(rec?.childFilingDate ?? rec?.childPatentApplicationFilingDate ?? '')
          if (fd) pctDates.set(child, fd)
        }
      }
    }
  }

  return { parentEdges, childEntries, pctDates }
}

function blankNode(appNumber: string, applicationType = ''): FamilyTreeNode {
  return {
    appNumber, filingDate: '', effectiveFilingDate: '', grantDate: '',
    patentNumber: '', publicationNumber: '', status: 'Unknown',
    applicationType, firstInventor: '', isPriority: false,
  }
}

function pctStubNode(pctNum: string, filingDate: string): FamilyTreeNode {
  return { ...blankNode(pctNum, 'PCT'), filingDate, status: 'Filed' }
}

export async function fetchFamilyTreeData(rootAppNumber: string): Promise<FamilyTreeData> {
  const apiKey  = process.env.USPTO_ODP_KEY ?? ''
  const APP_BASE = `${ODP_BASE}/patent/applications`
  const MAX_NODES = 1000

  const nodeMap = new Map<string, FamilyTreeNode>()
  const edgeSet = new Set<string>()  // "source|target|relation"
  const queue   = [rootAppNumber.replace(/\D/g, '')]
  const seen    = new Set<string>()

  while (queue.length > 0 && nodeMap.size < MAX_NODES) {
    const app = queue.shift()!
    if (!app || seen.has(app)) continue
    seen.add(app)

    // Fetch meta-data and continuity in parallel
    const [metaRes, contRes] = await Promise.all([
      fetch(`${APP_BASE}/${app}/meta-data`, {
        headers: { 'x-api-key': apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      }).catch(() => null),
      fetch(`${APP_BASE}/${app}/continuity`, {
        headers: { 'x-api-key': apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      }).catch(() => null),
    ])

    // Hydrate node
    if (metaRes?.ok) {
      try {
        const meta     = extractTreeMeta(await metaRes.json())
        const canonical = (meta.appNumber || app).replace(/\D/g, '') || app
        nodeMap.set(canonical, { ...meta, appNumber: canonical, isPriority: false })
      } catch { nodeMap.set(app, blankNode(app)) }
    } else { nodeMap.set(app, blankNode(app)) }

    // Walk continuity edges
    if (contRes?.ok) {
      try {
        const { parentEdges, childEntries, pctDates } = parseContinuity(app, await contRes.json())

        for (const e of parentEdges) {
          edgeSet.add(`${e.source}|${e.target}|${e.relation}`)
          if (!seen.has(e.source)) {
            if (isPctApp(e.source)) {
              // Create a stub node; don't queue — no USPTO metadata endpoint for PCT apps
              if (!nodeMap.has(e.source)) {
                nodeMap.set(e.source, pctStubNode(e.source, pctDates.get(e.source) ?? ''))
              }
              seen.add(e.source)
            } else {
              queue.push(e.source)
            }
          }
        }

        for (const { appNum, rel } of childEntries) {
          if (isPctApp(appNum)) {
            edgeSet.add(`${app}|${appNum}|${rel}`)
            if (!nodeMap.has(appNum)) {
              nodeMap.set(appNum, pctStubNode(appNum, pctDates.get(appNum) ?? ''))
            }
            seen.add(appNum)
          } else if (!seen.has(appNum)) {
            queue.push(appNum)
          }
        }
      } catch { /* skip */ }
    }

    // 150 ms between nodes — matches the Python rate-limit delay
    await new Promise(r => setTimeout(r, 150))
  }

  return {
    nodes:   [...nodeMap.values()],
    edges:   [...edgeSet].map(s => { const [source, target, relation] = s.split('|'); return { source, target, relation } }),
    rootApp: rootAppNumber,
  }
}
