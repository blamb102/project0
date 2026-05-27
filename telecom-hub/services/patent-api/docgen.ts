import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow,
  TableCell, WidthType, BorderStyle, AlignmentType, PageBreak, ShadingType,
  PageOrientation, TableLayoutType,
} from 'docx'
import type { PatentData, FileHistoryDoc, FamilyMember, AssignmentRecord } from './sources'
import type { PdfParagraph } from './pdflines'

// ── PDF line-reference helpers ────────────────────────────────────────────────

function normForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
}

function wordOverlap(a: string, b: string): number {
  const wa = new Set(a.split(' ').filter(w => w.length > 3))
  const wb = new Set(b.split(' ').filter(w => w.length > 3))
  if (!wa.size || !wb.size) return 0
  let inter = 0
  for (const w of wa) if (wb.has(w)) inter++
  return inter / Math.max(wa.size, wb.size)
}

function lineRef(p: PdfParagraph): string {
  if (p.startCol === p.endCol) return `[${p.startCol}:${p.startLine}-${p.endLine}] `
  return `[${p.startCol}:${p.startLine}-${p.endCol}:${p.endLine}] `
}

// Greedy sequential matcher: for each XML paragraph, find the next best-matching
// PDF paragraph (searching forward only, within a small lookahead window).
function makeMatcher(paras: PdfParagraph[]) {
  let ptr = 0
  return (xmlText: string): string => {
    const norm = normForMatch(xmlText)
    if (!norm || !paras.length) return ''
    const end  = Math.min(ptr + 10, paras.length)
    let bestI  = -1, bestScore = 0
    for (let i = ptr; i < end; i++) {
      const score = wordOverlap(norm, paras[i].text)
      if (score > bestScore) { bestScore = score; bestI = i }
    }
    if (bestI >= 0 && bestScore >= 0.25) {
      ptr = bestI + 1
      return lineRef(paras[bestI])
    }
    return ''
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function heading1(text: string): Paragraph {
  return new Paragraph({ text, heading: HeadingLevel.HEADING_1, outlineLevel: 0 })
}

function heading2(text: string): Paragraph {
  return new Paragraph({ text, heading: HeadingLevel.HEADING_2, outlineLevel: 1 })
}

function heading3(text: string): Paragraph {
  return new Paragraph({ text, heading: HeadingLevel.HEADING_3, outlineLevel: 2 })
}

function body(text: string): Paragraph {
  return new Paragraph({ children: makeRuns(text, 22) })
}

function bold(text: string): Paragraph {
  return new Paragraph({ children: [new TextRun({ text, bold: true, size: 22 })] })
}

function spacer(): Paragraph {
  return new Paragraph({ text: '' })
}

function labelValue(label: string, value: string): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({ text: `${label}: `, bold: true, size: 22 }),
      new TextRun({ text: value, size: 22 }),
    ],
  })
}

function borderCell(content: string, shade?: boolean): TableCell {
  return new TableCell({
    children: [new Paragraph({ children: [new TextRun({ text: content, size: 20 })] })],
    shading: shade ? { type: ShadingType.CLEAR, color: 'E8E8E8', fill: 'E8E8E8' } : undefined,
    borders: {
      top:    { style: BorderStyle.SINGLE, size: 4 },
      bottom: { style: BorderStyle.SINGLE, size: 4 },
      left:   { style: BorderStyle.SINGLE, size: 4 },
      right:  { style: BorderStyle.SINGLE, size: 4 },
    },
  })
}

// Claim-chart cell: explicit DXA width so Word respects fixed layout column widths.
function chartCell(content: string, widthTwips: number, shade?: boolean): TableCell {
  return new TableCell({
    children: [new Paragraph({ children: makeRuns(content, 20) })],
    width: { size: widthTwips, type: WidthType.DXA },
    shading: shade ? { type: ShadingType.CLEAR, color: 'E8E8E8', fill: 'E8E8E8' } : undefined,
    borders: {
      top:    { style: BorderStyle.SINGLE, size: 4 },
      bottom: { style: BorderStyle.SINGLE, size: 4 },
      left:   { style: BorderStyle.SINGLE, size: 4 },
      right:  { style: BorderStyle.SINGLE, size: 4 },
    },
  })
}

async function toBuffer(doc: Document): Promise<Buffer> {
  return Buffer.from(await Packer.toBuffer(doc))
}

// Split text on ^{...} / _{...} markers and return TextRuns with proper super/subscript.
function makeRuns(text: string, size: number): TextRun[] {
  const re = /(\^{[^}]*}|_{[^}]*})/g
  const runs: TextRun[] = []
  let last = 0, m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) runs.push(new TextRun({ text: text.slice(last, m.index), size }))
    const sup   = m[1][0] === '^'
    const inner = m[1].slice(2, -1)
    runs.push(new TextRun({ text: inner, size, superScript: sup, subScript: !sup }))
    last = m.index + m[1].length
  }
  if (last < text.length) runs.push(new TextRun({ text: text.slice(last), size }))
  return runs.length ? runs : [new TextRun({ text, size })]
}

// Parse a TABLE:\n... block (pipe-delimited rows from sources.ts) into a DOCX Table.
// The first row is treated as a header row.
function buildDescTable(tableText: string): Table | null {
  const lines = tableText.split('\n').filter(l => l.trim().startsWith('|'))
  if (!lines.length) return null

  const rows = lines.map(line =>
    line.split('|').slice(1, -1).map(c => c.trim())
  ).filter(r => r.length > 0)
  if (!rows.length) return null

  const colCount = Math.max(...rows.map(r => r.length))
  const colW     = Math.floor(9360 / colCount)

  const tableRows = rows.map((cells, ri) =>
    new TableRow({
      tableHeader: ri === 0,
      children: Array.from({ length: colCount }, (_, ci) =>
        new TableCell({
          children: [new Paragraph({
            children: [new TextRun({ text: cells[ci] ?? '', size: 18, bold: ri === 0 })],
          })],
          width:   { size: colW, type: WidthType.DXA },
          shading: ri === 0
            ? { type: ShadingType.CLEAR, color: 'E8E8E8', fill: 'E8E8E8' }
            : undefined,
          borders: {
            top:    { style: BorderStyle.SINGLE, size: 4 },
            bottom: { style: BorderStyle.SINGLE, size: 4 },
            left:   { style: BorderStyle.SINGLE, size: 4 },
            right:  { style: BorderStyle.SINGLE, size: 4 },
          },
        })
      ),
    })
  )

  return new Table({
    rows: tableRows,
    width:        { size: 9360, type: WidthType.DXA },
    columnWidths: Array(colCount).fill(colW),
    layout:       TableLayoutType.FIXED,
  })
}

// ── Patent specification document ─────────────────────────────────────────────

export async function buildPatentDoc(patent: PatentData, pdfParas?: PdfParagraph[]): Promise<Buffer> {
  const match = pdfParas?.length ? makeMatcher(pdfParas) : null

  const descParas: (Paragraph | Table)[] = []
  if (patent.description) {
    for (const part of patent.description.split('\n\n').filter(Boolean)) {
      if (part.startsWith('HEADING: ')) {
        descParas.push(heading2(part.slice(9)))
      } else if (part.startsWith('TABLE:\n')) {
        const tbl = buildDescTable(part.slice(7))
        if (tbl) descParas.push(tbl)
      } else {
        const text = part.replace(/\s+/g, ' ')
        const ref  = match ? match(text) : ''
        descParas.push(body(ref + text))
      }
      descParas.push(spacer())
    }
  } else {
    descParas.push(body('(Description not available)'))
  }

  const claimParas: Paragraph[] = []
  if (patent.claims?.length > 0) {
    claimParas.push(heading1('Claims'))
    for (const claim of patent.claims) {
      claimParas.push(...claimParagraphs(claim))
      claimParas.push(spacer())
    }
  }

  const doc = new Document({
    sections: [{
      children: [
        heading1(patent.title || `Patent ${patent.patentNumber}`),
        spacer(),
        labelValue('Patent Number', patent.patentNumber),
        labelValue('Application Number', patent.appNumber),
        labelValue('Filing Date', patent.filingDate),
        labelValue('Issue Date', patent.issueDate),
        labelValue('Assignee', patent.assignee),
        labelValue('Inventors', patent.inventors.join(', ')),
        spacer(),
        heading1('Abstract'),
        body(patent.abstract || '(No abstract available)'),
        spacer(),
        heading1('Description'),
        ...descParas,
        ...claimParas,
      ],
    }],
  })
  return toBuffer(doc)
}

// ── Claims document ───────────────────────────────────────────────────────────

function claimParagraphs(claimText: string): Paragraph[] {
  // Lines are \t-prefixed to encode indent depth; first line is the preamble (no tabs)
  const lines = claimText.split('\n').filter(Boolean)
  return lines.map(line => {
    const depth = (line.match(/^\t*/)?.[0] ?? '').length
    const text  = line.replace(/^\t+/, '')
    return new Paragraph({
      children: makeRuns(text, 22),
      indent:   depth > 0 ? { left: 720 * depth } : undefined,
    })
  })
}

export async function buildClaimsDoc(patent: PatentData, claims: string[]): Promise<Buffer> {
  const claimParas: Paragraph[] = []
  if (claims.length === 0) {
    claimParas.push(body('(Claims not available for this patent)'))
  } else {
    for (const claim of claims) {
      claimParas.push(...claimParagraphs(claim))
      claimParas.push(spacer())
    }
  }

  const doc = new Document({
    sections: [{
      children: [
        heading1(`Claims — ${patent.patentNumber}`),
        labelValue('Title', patent.title),
        spacer(),
        ...claimParas,
      ],
    }],
  })
  return toBuffer(doc)
}

// ── Claim chart template ──────────────────────────────────────────────────────

function limitationLabel(index: number): string {
  const alpha = 'abcdefghijklmnopqrstuvwxyz'
  if (index < 26) return alpha[index]
  return alpha[Math.floor(index / 26) - 1] + alpha[index % 26]
}

// Landscape letter: 11" × 8.5" → usable width ≈ 12960 twips (1" margins each side)
const CHART_COL_CLAIM    = 5184  // 40%
const CHART_COL_EVIDENCE = 7776  // 60%

export async function buildClaimChartDoc(patent: PatentData, claims: string[]): Promise<Buffer> {
  const chartClaims = claims.length > 0 ? claims.slice(0, 20) : ['[enter claim text]']

  const headerRow = new TableRow({
    children: [
      chartCell('Claim Element', CHART_COL_CLAIM, true),
      chartCell('Evidence / Analysis', CHART_COL_EVIDENCE, true),
    ],
    tableHeader: true,
  })

  const rows: TableRow[] = [headerRow]

  for (let ci = 0; ci < chartClaims.length; ci++) {
    const claimNum = ci + 1
    const lines = chartClaims[ci].split('\n').filter(Boolean)

    // Claim header row
    rows.push(new TableRow({
      children: [
        chartCell(`Claim ${claimNum}`, CHART_COL_CLAIM, true),
        chartCell('', CHART_COL_EVIDENCE, true),
      ],
    }))

    const multiElement = lines.length > 1
    let limIndex = 0
    for (let li = 0; li < lines.length; li++) {
      const line  = lines[li]
      const depth = (line.match(/^\t*/)?.[0] ?? '').length
      let text    = line.replace(/^\t+/, '')

      // Strip leading "N." only for multi-element claims (single-element keeps it)
      if (li === 0 && multiElement) text = text.replace(/^\d+\.\s*/, '')

      let cellText: string
      if (!multiElement) {
        cellText = text
      } else if (depth === 0) {
        cellText = `[${claimNum}pre] ${text}`
      } else {
        cellText = `[${claimNum}${limitationLabel(limIndex++)}] ${text}`
      }

      rows.push(new TableRow({
        children: [
          chartCell(cellText, CHART_COL_CLAIM),
          chartCell('', CHART_COL_EVIDENCE),
        ],
      }))
    }
  }

  const table = new Table({
    rows,
    width: { size: CHART_COL_CLAIM + CHART_COL_EVIDENCE, type: WidthType.DXA },
    columnWidths: [CHART_COL_CLAIM, CHART_COL_EVIDENCE],
    layout: TableLayoutType.FIXED,
  })

  const doc = new Document({
    sections: [{
      properties: {
        page: {
          size: { orientation: PageOrientation.LANDSCAPE },
        },
      },
      children: [
        heading1(`Claim Chart — ${patent.patentNumber}`),
        labelValue('Title', patent.title),
        spacer(),
        table,
      ],
    }],
  })
  return toBuffer(doc)
}

// ── File history summary document ────────────────────────────────────────────

// ── Prosecution analysis helpers ──────────────────────────────────────────────

function docMatches(d: FileHistoryDoc, codes: string[], frags: string[]): boolean {
  const c = d.docCode.toUpperCase()
  const t = d.description.toLowerCase()
  return codes.some(k => c === k || c.startsWith(k + '.') || c.startsWith(k + '_') || c === k)
      || frags.some(f => t.includes(f))
}

function isNonfinalOA(d: FileHistoryDoc): boolean {
  return docMatches(d, ['CTNF'], ['non-final rejection', 'nonfinal rejection'])
}
function isFinalOA(d: FileHistoryDoc): boolean {
  return docMatches(d, ['CTFR'], ['final rejection'])
}
function isAllowanceDoc(d: FileHistoryDoc): boolean {
  return docMatches(d, ['NOA'], ['notice of allowance'])
}
function isAmendmentDoc(d: FileHistoryDoc): boolean {
  const c = d.docCode.toUpperCase()
  const t = d.description.toLowerCase()
  return c.startsWith('AMEND') || c.startsWith('REM') ||
    t.includes('amendment/req') || t.includes('amendment after') ||
    t.includes('response after') || t.includes('after non-final') ||
    t.includes('after final') || t.includes('claims amendment')
}
function isTerminalDisclaimer(d: FileHistoryDoc): boolean {
  return docMatches(d, ['DISCLM', 'TDIS'], ['terminal disclaimer'])
}
function isRestrictionDoc(d: FileHistoryDoc): boolean {
  return docMatches(d, ['WRES', 'RESTRICTION'],
    ['restriction requirement', 'election requirement', 'restriction/election'])
}
function isAppealDoc(d: FileHistoryDoc): boolean {
  return docMatches(d, ['APPEAL', 'NOTF.APPEAL', 'BSTATUS', 'BOARD'],
    ['notice of appeal', 'board of appeal', 'board of patent', 'appeal brief'])
}
function isPostGrantDoc(d: FileHistoryDoc): boolean {
  const c = d.docCode.toUpperCase()
  const t = d.description.toLowerCase()
  return ['IPR', 'PGR', 'CBM', 'REEX', 'EXPARTE', 'EX.PARTE'].some(p => c.startsWith(p)) ||
    /\b(inter partes review|post.grant review|reexamination|ex parte reexam)\b/.test(t)
}

function daysBetween(a: string, b: string): number | null {
  const da = new Date(a); const db = new Date(b)
  if (isNaN(da.getTime()) || isNaN(db.getTime())) return null
  return Math.round((db.getTime() - da.getTime()) / 86_400_000)
}

// Strip any time portion from date strings (e.g. "2006-04-07T00:00:00" → "2006-04-07")
function fmtDate(s: string): string {
  if (!s || s === '—') return s
  return s.slice(0, 10)
}

function yesNo(v: boolean): string { return v ? 'Yes' : 'No' }

// ── Summary table helpers ─────────────────────────────────────────────────────

// Portrait letter (8.5") with 1" margins → 6.5" = 9360 twips
const SUM_LABEL_W = 2900
const SUM_VALUE_W = 6460

const SUM_BORDER = { style: BorderStyle.SINGLE, size: 4 }
const SUM_BORDERS = { top: SUM_BORDER, bottom: SUM_BORDER, left: SUM_BORDER, right: SUM_BORDER }

function sumLabelCell(text: string, headerRow = false): TableCell {
  return new TableCell({
    children: [new Paragraph({
      children: [new TextRun({
        text, bold: true, size: 20,
        color: headerRow ? 'FFFFFF' : '000000',
      })],
    })],
    width: { size: SUM_LABEL_W, type: WidthType.DXA },
    shading: {
      type: ShadingType.CLEAR,
      color: headerRow ? '2C3E50' : 'E8E8E8',
      fill:  headerRow ? '2C3E50' : 'E8E8E8',
    },
    borders: SUM_BORDERS,
  })
}

function sumValueCell(children: Paragraph[], headerRow = false): TableCell {
  return new TableCell({
    children,
    width: { size: SUM_VALUE_W, type: WidthType.DXA },
    shading: headerRow
      ? { type: ShadingType.CLEAR, color: '2C3E50', fill: '2C3E50' }
      : undefined,
    borders: SUM_BORDERS,
  })
}

function sumPara(text: string, opts: { bold?: boolean; color?: string; tight?: boolean } = {}): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text, bold: opts.bold ?? false, size: 20, color: opts.color })],
    spacing: opts.tight ? { before: 0, after: 0 } : undefined,
  })
}

function summaryRow(label: string, valueParagraphs: Paragraph[], headerRow = false): TableRow {
  return new TableRow({
    children: [sumLabelCell(label, headerRow), sumValueCell(valueParagraphs, headerRow)],
    tableHeader: headerRow,
  })
}

export async function buildFileHistorySummaryDoc(
  patent: PatentData,
  history: FileHistoryDoc[],
  aiSummary: string,
  nickname = '',
  assignments: AssignmentRecord[] = [],
): Promise<Buffer> {
  // Analyze prosecution events
  // Count only by exact doc code — description matching over-counts
  const nonfinals = history.filter(d => d.docCode.toUpperCase() === 'CTNF')
  const finals    = history.filter(d => d.docCode.toUpperCase() === 'CTFR')
  const firstOA   = history.find(d => isNonfinalOA(d) || isFinalOA(d))
  const firstNOA  = history.find(isAllowanceDoc)

  const filingDate    = fmtDate(patent.filingDate || '—')
  const firstOADate   = fmtDate(firstOA?.date  || '—')
  const allowanceDate = fmtDate(firstNOA?.date || '—')
  const daysFromFiling = (patent.filingDate && firstNOA)
    ? daysBetween(patent.filingDate, firstNOA.date) : null
  const daysFromOA = (firstOA && firstNOA)
    ? daysBetween(firstOA.date, firstNOA.date) : null

  const nickLabel = nickname || `US ${patent.patentNumber}`

  const summaryTable = new Table({
    rows: [
      summaryRow('', [sumPara(nickLabel, { bold: true, color: 'FFFFFF' })], true),
      summaryRow('Filing Date',                    [sumPara(filingDate)]),
      summaryRow('First Office Action',            [sumPara(firstOADate)]),
      summaryRow('Allowance Date',                 [sumPara(allowanceDate)]),
      summaryRow('Time to Allowance (from filing)',
        [sumPara(daysFromFiling != null ? `${daysFromFiling} days` : '—')]),
      summaryRow('Time to Allowance (from first OA)',
        [sumPara(daysFromOA != null ? `${daysFromOA} days` : '—')]),
      summaryRow('Office Actions', [
        sumPara(`Nonfinal: ${nonfinals.length}`, { tight: true }),
        sumPara(`Final: ${finals.length}`,       { tight: true }),
        sumPara(`Total: ${nonfinals.length + finals.length}`, { tight: true }),
      ]),
      summaryRow('Claim Amendments?',    [sumPara(yesNo(history.some(isAmendmentDoc)))]),
      summaryRow('Terminal Disclaimer?', [sumPara(yesNo(history.some(isTerminalDisclaimer)))]),
      summaryRow('Restriction Req.?',    [sumPara(yesNo(history.some(isRestrictionDoc)))]),
      summaryRow('Appeal?',              [sumPara(yesNo(history.some(isAppealDoc)))]),
      summaryRow('Post-Grant?',          [sumPara(yesNo(history.some(isPostGrantDoc)))]),
    ],
    width: { size: SUM_LABEL_W + SUM_VALUE_W, type: WidthType.DXA },
    columnWidths: [SUM_LABEL_W, SUM_VALUE_W],
    layout: TableLayoutType.FIXED,
  })

  const historyRows: Paragraph[] = []
  for (const doc of history) {
    historyRows.push(new Paragraph({
      children: [
        new TextRun({ text: `${fmtDate(doc.date)}  `, bold: true, size: 20 }),
        new TextRun({ text: `[${doc.docCode}]  `, color: '4A4A4A', size: 20 }),
        new TextRun({ text: doc.description, size: 20 }),
        doc.pageCount > 0
          ? new TextRun({ text: `  (${doc.pageCount}pp)`, italics: true, size: 18 })
          : new TextRun({ text: '' }),
      ],
    }))
  }

  const doc = new Document({
    sections: [{
      children: [
        heading1(`File History — ${patent.patentNumber}`),
        labelValue('Application', patent.appNumber),
        labelValue('Title', patent.title),
        spacer(),
        summaryTable,
        spacer(),
        heading2('Prosecution Timeline'),
        ...historyRows,
        spacer(),
        heading2('AI-Generated Summary'),
        body(aiSummary || '(Summary not available)'),
        spacer(),
        heading2('Assignment History'),
        ...buildAssignmentSection(assignments),
      ],
    }],
  })
  return toBuffer(doc)
}

// ── Assignment history table ──────────────────────────────────────────────────

// Column widths for portrait letter page (9360 twips usable)
const ASGN_DATE_W  = 1200
const ASGN_CONV_W  = 2400
const ASGN_FROM_W  = 2520
const ASGN_TO_W    = 3240

function asgnCell(paragraphs: Paragraph[], shade = false): TableCell {
  return new TableCell({
    children: paragraphs,
    shading: shade ? { type: ShadingType.CLEAR, color: 'E8E8E8', fill: 'E8E8E8' } : undefined,
    borders: {
      top:    { style: BorderStyle.SINGLE, size: 4 },
      bottom: { style: BorderStyle.SINGLE, size: 4 },
      left:   { style: BorderStyle.SINGLE, size: 4 },
      right:  { style: BorderStyle.SINGLE, size: 4 },
    },
  })
}

function asgnText(text: string, opts: { bold?: boolean; tight?: boolean } = {}): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text, bold: opts.bold ?? false, size: 20 })],
    spacing: opts.tight ? { before: 0, after: 0 } : undefined,
  })
}

function buildAssignmentSection(assignments: AssignmentRecord[]): (Paragraph | Table)[] {
  if (assignments.length === 0) {
    return [body('(No assignment records found)')]
  }

  const headerRow = new TableRow({
    tableHeader: true,
    children: [
      asgnCell([asgnText('Recorded', { bold: true })], true),
      asgnCell([asgnText('Conveyance', { bold: true })], true),
      asgnCell([asgnText('Assignor(s)', { bold: true })], true),
      asgnCell([asgnText('Assignee(s)', { bold: true })], true),
    ],
  })

  const dataRows = assignments.map(a => {
    const assignorParas = a.assignors.length > 0
      ? a.assignors.map((n, i) => asgnText(n, { tight: i < a.assignors.length - 1 }))
      : [asgnText('—')]

    const assigneeParas = a.assignees.length > 0
      ? a.assignees.flatMap((e, i) => {
          const loc = [e.city, e.country].filter(Boolean).join(', ')
          const last = i === a.assignees.length - 1
          return loc
            ? [asgnText(e.name, { tight: true }), asgnText(loc, { tight: !last })]
            : [asgnText(e.name, { tight: !last })]
        })
      : [asgnText('—')]

    return new TableRow({
      children: [
        asgnCell([asgnText(fmtDate(a.recordedDate) || '—')]),
        asgnCell([asgnText(a.conveyance)]),
        asgnCell(assignorParas),
        asgnCell(assigneeParas),
      ],
    })
  })

  const table = new Table({
    rows: [headerRow, ...dataRows],
    width: { size: ASGN_DATE_W + ASGN_CONV_W + ASGN_FROM_W + ASGN_TO_W, type: WidthType.DXA },
    columnWidths: [ASGN_DATE_W, ASGN_CONV_W, ASGN_FROM_W, ASGN_TO_W],
    layout: TableLayoutType.FIXED,
  })

  return [table]
}

// ── Patent family document ────────────────────────────────────────────────────

export async function buildFamilyDoc(
  patent: PatentData,
  members: FamilyMember[],
): Promise<Buffer> {
  const headerRow = new TableRow({
    children: [
      borderCell('Country', true),
      borderCell('Document Number', true),
      borderCell('Kind', true),
      borderCell('Status', true),
    ],
    tableHeader: true,
  })

  const dataRows = members.length > 0
    ? members.map(m => new TableRow({
        children: [
          borderCell(m.country),
          borderCell(m.docNumber),
          borderCell(m.kind),
          borderCell(m.status ?? ''),
        ],
      }))
    : [new TableRow({
        children: [
          borderCell('(Family data not available)'),
          borderCell(''),
          borderCell(''),
          borderCell(''),
        ],
      })]

  const table = new Table({
    rows: [headerRow, ...dataRows],
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: [1500, 4000, 1500, 3000],
  })

  const doc = new Document({
    sections: [{
      children: [
        heading1(`Patent Family — ${patent.patentNumber}`),
        labelValue('Title', patent.title),
        labelValue('US Patent', patent.patentNumber),
        spacer(),
        table,
      ],
    }],
  })
  return toBuffer(doc)
}
