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
    // Walk all <heading> and <p> elements inside <description>, in document order.
    const descNode = findNode(doc, 'description')
    let description = ''
    if (descNode) {
      const parts: string[] = []
      const descChildren: any[] = descNode['description'] ?? []
      for (const child of descChildren) {
        const key = Object.keys(child).find(k => k !== ':@') ?? ''
        if (key === 'heading') {
          const text = nodesToText(child[key]).replace(/\s+/g, ' ').trim()
          if (text) parts.push(`HEADING: ${text}`)
        } else if (key === 'p') {
          const text = nodesToText(child[key]).replace(/\s+/g, ' ').trim()
          if (!text) continue
          parts.push(text)
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
    const url = `https://ops.epo.org/3.2/rest-services/family/publication/docdb/US.${clean}.B2`

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

      // Capture US application number for the top-level usAppNumber field
      if (isUsGrant && !usAppNumber) {
        for (const ref of appDocIds) {
          const country = ref['country']?.['$'] ?? ref['country'] ?? ''
          const rawNum  = ref['doc-number']?.['$'] ?? ref['doc-number'] ?? ''
          if (country === 'US' && rawNum) {
            const digits = rawNum.replace(/[^0-9]/g, '')
            usAppNumber  = digits.length >= 12 ? digits.slice(4) : digits
            break
          }
        }
      }
    }

    // Fallback: if family gave no US app number, try published-data for this specific publication
    if (!usAppNumber) {
      const pdUrl = `https://ops.epo.org/3.2/rest-services/published-data/publication/docdb/US.${clean}.B2/biblio`
      const pdRes = await fetch(pdUrl, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      }).catch(() => null)
      if (pdRes?.ok) {
        const pdData: any = await pdRes.json()
        const doc    = pdData?.['ops:world-patent-data']?.['exchange-documents']?.['exchange-document']
        const docArr: any[] = Array.isArray(doc) ? doc : doc ? [doc] : []
        for (const d of docArr) {
          const appRef    = d?.['bibliographic-data']?.['application-reference']
          const appDocId  = appRef?.['document-id']
          const appDocIds: any[] = Array.isArray(appDocId) ? appDocId : appDocId ? [appDocId] : []
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
          if (usAppNumber) break
        }
      }
    }

    return { members, usAppNumber }
  } catch {
    return { members: [] }
  }
}
