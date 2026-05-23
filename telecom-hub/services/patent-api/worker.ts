import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import JSZip from 'jszip'
import { PDFDocument, PDFName, PDFString, PDFNumber, PDFDict, PDFRef } from 'pdf-lib'
import { Workbook as ExcelWorkbook } from 'exceljs'
import {
  fetchPatentWithClaims, fetchPatentPdf,
  fetchFileHistory, fetchFileHistoryDoc, fetchPatentFamily,
  FileHistoryDoc, PatentData, FamilyMember,
} from './sources'
import {
  buildPatentDoc, buildClaimsDoc, buildClaimChartDoc,
  buildFileHistorySummaryDoc,
} from './docgen'

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
  'fileHistorySummary', 'patentFamily', 'fileHistoryPdf',
] as const

interface WorkerPayload {
  jobId: string
  patentNumber: string
  nickname?: string
  items?: string[]
}

async function setStatus(jobId: string, status: object) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key:    `jobs/${jobId}/status.json`,
    Body:   JSON.stringify(status),
    ContentType: 'application/json',
  }))
}

export const handler = async (event: WorkerPayload) => {
  const { jobId, patentNumber, nickname, items } = event
  const cleanDigits = patentNumber.replace(/[^0-9]/g, '')
  const defaultNick = cleanDigits.slice(-3) ? `${cleanDigits.slice(-3)} patent` : cleanDigits
  const nick    = (nickname ?? '').trim() || defaultNick
  const include = new Set(items ?? ALL_ITEMS)
  const needs   = (...keys: string[]) => keys.some(k => include.has(k))

  await setStatus(jobId, { status: 'running', step: 'Fetching patent data' })

  try {
    // Step 1: fetch patent family to get the US application number (needed for file history)
    const family = await fetchPatentFamily(patentNumber)
    const appNumHint = family.usAppNumber

    // Step 2: fetch patent metadata + claims; optionally fetch file history metadata
    await setStatus(jobId, { status: 'running', step: 'Fetching patent data & file history' })

    const needsHistory = needs('fileHistorySummary', 'fileHistoryPdf')
    const [{ patent, claims }, history] = await Promise.all([
      fetchPatentWithClaims(patentNumber, appNumHint),
      needsHistory
        ? fetchFileHistory(appNumHint ?? cleanDigits)
        : Promise.resolve([] as import('./sources').FileHistoryDoc[]),
    ])

    patent.claims = claims

    // Step 3: patent PDF (skip download if not requested)
    const pdfBuffer = needs('patentPdf') ? await fetchPatentPdf(patentNumber) : null

    await setStatus(jobId, { status: 'running', step: 'Generating documents' })

    // Step 4: generate only requested documents in parallel
    const [patentDocx, claimsDocx, chartDocx, summaryDocx, familyXlsx] = await Promise.all([
      needs('patentText')         ? buildPatentDoc(patent)                        : null,
      needs('claims')             ? buildClaimsDoc(patent, claims)                : null,
      needs('claimChart')         ? buildClaimChartDoc(patent, claims)            : null,
      needs('fileHistorySummary') ? buildFileHistorySummaryDoc(patent, history, '') : null,
      needs('patentFamily')       ? buildFamilyExcel(patent, family.members)      : null,
    ])

    await setStatus(jobId, { status: 'running', step: 'Building ZIP' })

    // Step 5: assemble ZIP with only requested items
    const zip = new JSZip()
    const folder = zip.folder(nick)!

    if (patentDocx)  folder.file(`${nick} - patent-text.docx`,          patentDocx)
    if (claimsDocx)  folder.file(`${nick} - claims.docx`,               claimsDocx)
    if (chartDocx)   folder.file(`${nick} - claim-chart-template.docx`, chartDocx)
    if (summaryDocx) folder.file(`${nick} - file-history-summary.docx`, summaryDocx)
    if (familyXlsx)  folder.file(`${nick} - patent-family.xlsx`,        familyXlsx)
    if (pdfBuffer)   folder.file(`${nick}.pdf`,                         pdfBuffer)

    // Download and merge file history PDFs only if requested
    if (needs('fileHistoryPdf')) {
      const mergedFhPdf = await buildFileHistoryPdf(history)
      if (mergedFhPdf) folder.file(`${nick} - file-history.pdf`, mergedFhPdf)
    }

    const zipBuffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    })

    await setStatus(jobId, { status: 'running', step: 'Uploading ZIP' })

    // Step 6: upload ZIP to S3
    const zipKey = `jobs/${jobId}/${nick}-folio.zip`
    await s3.send(new PutObjectCommand({
      Bucket:      BUCKET,
      Key:         zipKey,
      Body:        zipBuffer,
      ContentType: 'application/zip',
    }))

    // Step 7: write final status with s3 key for presigned URL generation
    await setStatus(jobId, {
      status:  'complete',
      zipKey,
      patent:  {
        number:    patent.patentNumber,
        title:     patent.title,
        assignee:  patent.assignee,
        claimCount: claims.length,
        historyCount: history.length,
        familyCount:  family.members.length,
      },
    })
  } catch (err: any) {
    await setStatus(jobId, {
      status: 'error',
      error:  err.message ?? String(err),
    })
  }
}
