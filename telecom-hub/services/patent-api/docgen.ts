import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow,
  TableCell, WidthType, BorderStyle, AlignmentType, PageBreak, ShadingType,
  PageOrientation, TableLayoutType,
} from 'docx'
import type { PatentData, FileHistoryDoc, FamilyMember } from './sources'

// ── Helpers ───────────────────────────────────────────────────────────────────

function heading1(text: string): Paragraph {
  return new Paragraph({ text, heading: HeadingLevel.HEADING_1 })
}

function heading2(text: string): Paragraph {
  return new Paragraph({ text, heading: HeadingLevel.HEADING_2 })
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

// ── Patent specification document ─────────────────────────────────────────────

export async function buildPatentDoc(patent: PatentData): Promise<Buffer> {
  const descParas: Paragraph[] = []
  if (patent.description) {
    for (const part of patent.description.split('\n\n').filter(Boolean)) {
      if (part.startsWith('HEADING: ')) {
        descParas.push(heading2(part.slice(9)))
      } else {
        descParas.push(body(part.replace(/\s+/g, ' ')))
      }
      descParas.push(spacer())
    }
  } else {
    descParas.push(body('(Description not available)'))
  }

  const claimParas: Paragraph[] = []
  if (patent.claims?.length > 0) {
    claimParas.push(heading2('Claims'))
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
        heading2('Abstract'),
        body(patent.abstract || '(No abstract available)'),
        spacer(),
        heading2('Description'),
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

export async function buildFileHistorySummaryDoc(
  patent: PatentData,
  history: FileHistoryDoc[],
  aiSummary: string,
): Promise<Buffer> {
  const historyRows: Paragraph[] = []
  for (const doc of history) {
    historyRows.push(new Paragraph({
      children: [
        new TextRun({ text: `${doc.date}  `, bold: true, size: 20 }),
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
        heading2('Prosecution Timeline'),
        ...historyRows,
        spacer(),
        heading2('AI-Generated Summary'),
        body(aiSummary || '(Summary not available)'),
      ],
    }],
  })
  return toBuffer(doc)
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
