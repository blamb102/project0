import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import JSZip from 'jszip'
import { PDFDocument, PDFName, PDFString, PDFNumber, PDFDict, PDFRef } from 'pdf-lib'
import { Workbook as ExcelWorkbook } from 'exceljs'
import {
  fetchPatentWithClaims, fetchPatentPdf,
  fetchFileHistory, fetchFileHistoryDoc, fetchPatentFamily,
  fetchFamilyTreeData, fetchAssignmentHistory,
  FileHistoryDoc, PatentData, FamilyMember, FamilyTreeData, AssignmentRecord,
} from './sources'
import {
  buildPatentDoc, buildClaimsDoc, buildClaimChartDoc,
  buildFileHistorySummaryDoc,
} from './docgen'
import { buildFamilyTreeSvg } from './familytree'

const s3 = new S3Client({})

// ── PDF merge helpers ─────────────────────────────────────────────────────────

// Concurrency-limited map — matches Python's MAX_WORKERS = 8
async function pooledMap<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency = 8,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return results
}

async function buildFileHistoryPdf(docs: FileHistoryDoc[]): Promise<Buffer | null> {
  if (docs.length === 0) return null

  const merged = await PDFDocument.create()
  const bookmarks: { title: string; pageIndex: number }[] = []

  // Download with max 8 concurrent requests — ODP rate-limits large parallel batches
  const buffers = await pooledMap(docs, fetchFileHistoryDoc, 8)

  for (let i = 0; i < docs.length; i++) {
    const buf = buffers[i]
    if (!buf) continue
    try {
      const pageStart = merged.getPageCount()
      const src = await PDFDocument.load(buf, { ignoreEncryption: true })
      const pages = await merged.copyPages(src, src.getPageIndices())
      pages.forEach(p => merged.addPage(p))
      const dateStr = (docs[i].date ?? '').slice(0, 10) || 'unknown'
      const desc    = (docs[i].description || docs[i].docCode).slice(0, 50)
      bookmarks.push({
        title:     `${dateStr} | ${docs[i].docCode} - ${desc}`,
        pageIndex: pageStart,
      })
    } catch {
      // skip corrupt PDFs silently
    }
  }

  if (merged.getPageCount() === 0) return null
  addPdfOutline(merged, bookmarks)
  return Buffer.from(await merged.save())
}

function addPdfOutline(doc: PDFDocument, items: { title: string; pageIndex: number }[]) {
  if (items.length === 0) return
  const { context } = doc
  const pages = doc.getPages()

  const itemRefs: PDFRef[] = []
  for (const { title, pageIndex } of items) {
    const page = pages[pageIndex]
    if (!page) continue
    const dest = context.obj([page.ref, PDFName.of('Fit')])
    const dict = context.obj({
      Title: PDFString.of(title),
      Dest:  dest,
      Count: PDFNumber.of(0),
    }) as PDFDict
    itemRefs.push(context.register(dict))
  }

  if (itemRefs.length === 0) return

  for (let i = 0; i < itemRefs.length; i++) {
    const d = context.lookup(itemRefs[i]) as PDFDict
    if (i > 0) d.set(PDFName.of('Prev'), itemRefs[i - 1])
    if (i < itemRefs.length - 1) d.set(PDFName.of('Next'), itemRefs[i + 1])
  }

  const outlineRef = context.register(context.obj({
    Type:  PDFName.of('Outlines'),
    Count: PDFNumber.of(itemRefs.length),
    First: itemRefs[0],
    Last:  itemRefs[itemRefs.length - 1],
  }))

  for (const ref of itemRefs) {
    ;(context.lookup(ref) as PDFDict).set(PDFName.of('Parent'), outlineRef)
  }

  doc.catalog.set(PDFName.of('Outlines'), outlineRef)
  doc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'))
}
async function buildFamilyExcel(patent: PatentData, members: FamilyMember[]): Promise<Buffer> {
  const wb = new ExcelWorkbook()
  wb.creator = 'Patent Folio Generator'
  const ws = wb.addWorksheet('Patent Family')

  ws.columns = [
    { header: 'Country',            key: 'country',    width: 12 },
    { header: 'Publication Number', key: 'docNumber',  width: 20 },
    { header: 'Kind',               key: 'kind',       width: 8  },
    { header: 'Full Reference',     key: 'fullRef',    width: 22 },
    { header: 'Application Number', key: 'appNumber',  width: 22 },
    { header: 'Filing Date',        key: 'filingDate', width: 14 },
  ]

  // Title rows above the table
  ws.insertRow(1, [`Patent Family — ${patent.patentNumber}`])
  ws.insertRow(2, [patent.title])
  ws.insertRow(3, [])
  ws.mergeCells('A1:F1')
  ws.mergeCells('A2:F2')
  const titleCell = ws.getCell('A1')
  titleCell.font = { bold: true, size: 14 }
  ws.getCell('A2').font = { italic: true, size: 11 }

  // Header row is now row 4
  const headerRow = ws.getRow(4)
  headerRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2C3E50' } }
    cell.alignment = { vertical: 'middle', horizontal: 'center' }
  })
  headerRow.height = 18

  const rows = members.length > 0 ? members : [
    { country: '', docNumber: '(Family data not available)', kind: '', appNumber: undefined, filingDate: undefined },
  ]

  for (const m of rows) {
    const row = ws.addRow({
      country:    m.country,
      docNumber:  m.docNumber,
      kind:       m.kind,
      fullRef:    m.country && m.docNumber ? `${m.country}${m.docNumber}${m.kind}` : '',
      appNumber:  m.appNumber ?? '',
      filingDate: m.filingDate ?? '',
    })
    row.eachCell({ includeEmpty: false }, cell => {
      cell.border = {
        top:    { style: 'thin' },
        left:   { style: 'thin' },
        bottom: { style: 'thin' },
        right:  { style: 'thin' },
      }
    })
  }

  ws.autoFilter = { from: 'A4', to: 'F4' }

  return Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer)
}

const BUCKET = process.env.PATENT_OUTPUT_BUCKET!

const ALL_ITEMS = [
  'patentPdf', 'patentText', 'claims', 'claimChart',
  'fileHistorySummary', 'patentFamily', 'fileHistoryPdf', 'familyTree',
] as const

interface WorkerPayload {
  jobId: string
  patentNumbers?: string[]
  patentNumber?: string   // legacy single-patent
  nickname?: string
  items?: string[]
}

interface PatentResult {
  nick:          string
  patent:        PatentData
  pdfBuffer:     Buffer | null
  patentDocx:    Buffer | null
  claimsDocx:    Buffer | null
  chartDocx:     Buffer | null
  summaryDocx:   Buffer | null
  familyXlsx:    Buffer | null
  familyTreeSvg: Buffer | null
  familyTreeKey: string | undefined
  fhPdfBuffer:   Buffer | null
  historyCount:  number
  familyCount:   number
  assignments:   AssignmentRecord[]
}

// File naming per item type
const ITEM_SUFFIX: Record<string, string> = {
  patentText:         ' - patent-text.docx',
  claims:             ' - claims.docx',
  claimChart:         ' - claim-chart-template.docx',
  fileHistorySummary: ' - file-history-summary.docx',
  patentFamily:       ' - patent-family.xlsx',
  fileHistoryPdf:     ' - file-history.pdf',
  familyTree:         ' - family-tree.svg',
}
const ITEM_CONTENT_TYPE: Record<string, string> = {
  patentPdf:          'application/pdf',
  patentText:         'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  claims:             'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  claimChart:         'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  fileHistorySummary: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  patentFamily:       'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  fileHistoryPdf:     'application/pdf',
  familyTree:         'image/svg+xml',
}

function itemFilename(item: string, nick: string): string {
  return item === 'patentPdf' ? `${nick}.pdf` : `${nick}${ITEM_SUFFIX[item] ?? `.${item}`}`
}

function itemBuffer(item: string, r: PatentResult): Buffer | null {
  switch (item) {
    case 'patentPdf':          return r.pdfBuffer
    case 'patentText':         return r.patentDocx
    case 'claims':             return r.claimsDocx
    case 'claimChart':         return r.chartDocx
    case 'fileHistorySummary': return r.summaryDocx
    case 'patentFamily':       return r.familyXlsx
    case 'fileHistoryPdf':     return r.fhPdfBuffer
    case 'familyTree':         return r.familyTreeSvg
    default:                   return null
  }
}

// Add all generated files for one patent into a JSZip target (root or folder)
function addToZip(target: JSZip, r: PatentResult): void {
  const n = r.nick
  if (r.patentDocx)    target.file(itemFilename('patentText', n),         r.patentDocx)
  if (r.claimsDocx)    target.file(itemFilename('claims', n),             r.claimsDocx)
  if (r.chartDocx)     target.file(itemFilename('claimChart', n),         r.chartDocx)
  if (r.summaryDocx)   target.file(itemFilename('fileHistorySummary', n), r.summaryDocx)
  if (r.familyXlsx)    target.file(itemFilename('patentFamily', n),       r.familyXlsx)
  if (r.familyTreeSvg) target.file(itemFilename('familyTree', n),         r.familyTreeSvg)
  if (r.pdfBuffer)     target.file(itemFilename('patentPdf', n),          r.pdfBuffer)
  if (r.fhPdfBuffer)   target.file(itemFilename('fileHistoryPdf', n),     r.fhPdfBuffer)
}

async function setStatus(jobId: string, status: object) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key:    `jobs/${jobId}/status.json`,
    Body:   JSON.stringify(status),
    ContentType: 'application/json',
  }))
}

async function processOnePatent(
  jobId:       string,
  patNum:      string,
  nick:        string,
  include:     Set<string>,
  stepSuffix:  string,
): Promise<PatentResult> {
  const cleanDigits = patNum.replace(/[^0-9]/g, '')
  const needs = (...keys: string[]) => keys.some(k => include.has(k))

  await setStatus(jobId, { status: 'running', step: `Fetching patent data${stepSuffix}` })

  // EPO family must resolve first — its usAppNumber (from the biblio 'original' doc-type)
  // is the only reliable source of the USPTO application number for both old and new patents.
  // The ODP grant endpoint (/patent/{number}) returns 403 with this key, so fetchPatentWithClaims
  // always falls through to the applications-endpoint fallback which needs the app number.
  const family = await fetchPatentFamily(patNum)
  const appNum = family.usAppNumber || cleanDigits

  const needsHistory     = needs('fileHistorySummary', 'fileHistoryPdf')
  const needsAssignments = needs('fileHistorySummary')
  const [{ patent, claims }, history, assignments] = await Promise.all([
    fetchPatentWithClaims(patNum, appNum),
    needsHistory     ? fetchFileHistory(appNum)        : Promise.resolve([] as import('./sources').FileHistoryDoc[]),
    needsAssignments ? fetchAssignmentHistory(appNum)  : Promise.resolve([] as import('./sources').AssignmentRecord[]),
  ])
  patent.claims = claims

  const pdfBuffer = needs('patentPdf') ? await fetchPatentPdf(patNum) : null

  let familyTreeSvg: Buffer | null = null
  let familyTreeKey: string | undefined
  if (needs('familyTree')) {
    await setStatus(jobId, { status: 'running', step: `Building family tree${stepSuffix}` })
    const treeData = await fetchFamilyTreeData(appNum)
    familyTreeSvg  = buildFamilyTreeSvg(treeData)
    // Upload SVG separately so the test/preview page can display it
    familyTreeKey  = `jobs/${jobId}/family-tree.svg`
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET, Key: familyTreeKey, Body: familyTreeSvg, ContentType: 'image/svg+xml',
    }))
  }

  await setStatus(jobId, { status: 'running', step: `Generating documents${stepSuffix}` })

  const [patentDocx, claimsDocx, chartDocx, summaryDocx, familyXlsx] = await Promise.all([
    needs('patentText')         ? buildPatentDoc(patent)                          : null,
    needs('claims')             ? buildClaimsDoc(patent, claims)                  : null,
    needs('claimChart')         ? buildClaimChartDoc(patent, claims)              : null,
    needs('fileHistorySummary') ? buildFileHistorySummaryDoc(patent, history, '', nick, assignments) : null,
    needs('patentFamily')       ? buildFamilyExcel(patent, family.members)        : null,
  ])

  const fhPdfBuffer = needs('fileHistoryPdf') ? await buildFileHistoryPdf(history) : null

  return {
    nick, patent,
    pdfBuffer, patentDocx, claimsDocx, chartDocx, summaryDocx,
    familyXlsx, familyTreeSvg, familyTreeKey, fhPdfBuffer,
    historyCount: history.length,
    familyCount:  family.members.length,
    assignments,
  }
}

export const handler = async (event: WorkerPayload) => {
  const { jobId, nickname, items } = event
  const patNums = (event.patentNumbers ?? (event.patentNumber ? [event.patentNumber] : []))
    .map(s => String(s).trim()).filter(Boolean)

  if (patNums.length === 0) {
    await setStatus(jobId, { status: 'error', error: 'No patent number provided' })
    return
  }

  const include  = new Set<string>(items ?? ALL_ITEMS)
  const isMulti  = patNums.length > 1
  const isSingle = include.size === 1
  const onlyItem = [...include][0]

  await setStatus(jobId, { status: 'running', step: 'Fetching patent data' })

  try {
    // Process each patent sequentially to respect API rate limits
    const results: PatentResult[] = []
    for (let i = 0; i < patNums.length; i++) {
      const num    = patNums[i]
      const digits = num.replace(/[^0-9]/g, '')
      const nick   = !isMulti && (nickname ?? '').trim()
        ? nickname!.trim()
        : digits.slice(-3) ? `${digits.slice(-3)} patent` : digits
      const suffix = isMulti ? ` (patent ${i + 1} of ${patNums.length})` : ''
      results.push(await processOnePatent(jobId, num, nick, include, suffix))
    }

    const first = results[0]

    // ── Single patent + single item → standalone file (no ZIP) ────────────────
    if (!isMulti && isSingle) {
      const buf   = itemBuffer(onlyItem, first)
      const ctype = ITEM_CONTENT_TYPE[onlyItem] ?? 'application/octet-stream'
      // familyTree SVG was already uploaded by processOnePatent; reuse that key
      const fileKey = onlyItem === 'familyTree' && first.familyTreeKey
        ? first.familyTreeKey
        : `jobs/${jobId}/${itemFilename(onlyItem, first.nick)}`

      if (onlyItem !== 'familyTree' && buf) {
        await s3.send(new PutObjectCommand({
          Bucket: BUCKET, Key: fileKey, Body: buf, ContentType: ctype,
        }))
      }

      await setStatus(jobId, {
        status: 'complete',
        zipKey: fileKey,
        standalone: true,
        ...(first.familyTreeKey ? { familyTreeKey: first.familyTreeKey } : {}),
        patent: {
          number:       first.patent.patentNumber,
          title:        first.patent.title,
          assignee:     first.patent.assignee,
          claimCount:   first.patent.claims.length,
          historyCount: first.historyCount,
          familyCount:  first.familyCount,
        },
      })
      return
    }

    // ── ZIP ───────────────────────────────────────────────────────────────────
    await setStatus(jobId, { status: 'running', step: 'Building ZIP' })

    const zip = new JSZip()

    if (isMulti && !isSingle) {
      // Multi-patent, multi-item: one folder per patent
      for (const r of results) addToZip(zip.folder(r.nick)!, r)
    } else if (!isMulti) {
      // Single patent, multi-item: one folder (existing behaviour)
      addToZip(zip.folder(first.nick)!, first)
    } else {
      // Multi-patent, single-item: flat (no folders)
      for (const r of results) addToZip(zip, r)
    }

    const zipBuffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    })

    await setStatus(jobId, { status: 'running', step: 'Uploading ZIP' })

    const zipNick = isMulti ? 'patent-folio' : first.nick
    const zipKey  = `jobs/${jobId}/${zipNick}-folio.zip`
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET, Key: zipKey, Body: zipBuffer, ContentType: 'application/zip',
    }))

    await setStatus(jobId, {
      status: 'complete',
      zipKey,
      // Only expose familyTreeKey for single-patent jobs (used by the test page)
      ...(!isMulti && first.familyTreeKey ? { familyTreeKey: first.familyTreeKey } : {}),
      patent: isMulti ? {
        number:       `${results.length} patents`,
        title:        '',
        assignee:     '',
        claimCount:   results.reduce((s, r) => s + r.patent.claims.length, 0),
        historyCount: results.reduce((s, r) => s + r.historyCount, 0),
        familyCount:  results.reduce((s, r) => s + r.familyCount, 0),
      } : {
        number:       first.patent.patentNumber,
        title:        first.patent.title,
        assignee:     first.patent.assignee,
        claimCount:   first.patent.claims.length,
        historyCount: first.historyCount,
        familyCount:  first.familyCount,
      },
    })
  } catch (err: any) {
    await setStatus(jobId, { status: 'error', error: err.message ?? String(err) })
  }
}
