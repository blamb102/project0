import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow,
  TableCell, WidthType, BorderStyle, AlignmentType, PageBreak, ShadingType,
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
  return new Paragraph({ children: [new TextRun({ text, size: 22 })] })
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

async function toBuffer(doc: Document): Promise<Buffer> {
  return Buffer.from(await Packer.toBuffer(doc))
}

// ── Patent specification document ─────────────────────────────────────────────

export async function buildPatentDoc(patent: PatentData): Promise<Buffer> {
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
      ],
    }],
  })
  return toBuffer(doc)
}

// ── Claims document ───────────────────────────────────────────────────────────

export async function buildClaimsDoc(patent: PatentData, claims: string[]): Promise<Buffer> {
  const claimParas: Paragraph[] = []
  if (claims.length === 0) {
    claimParas.push(body('(Claims not available via PatentsView for this patent)'))
  } else {
    for (let i = 0; i < claims.length; i++) {
      claimParas.push(bold(`Claim ${i + 1}.`))
      claimParas.push(body(claims[i]))
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

export async function buildClaimChartDoc(patent: PatentData, claims: string[]): Promise<Buffer> {
  const chartClaims = claims.length > 0 ? claims.slice(0, 20) : ['Claim 1 — (enter claim text)']

  const headerRow = new TableRow({
    children: [
      borderCell('Claim Element', true),
      borderCell('Evidence / Mapping', true),
      borderCell('Source / Citation', true),
    ],
    tableHeader: true,
  })

  const rows: TableRow[] = [headerRow]
  for (let i = 0; i < chartClaims.length; i++) {
    const text = chartClaims[i]
    // Split claim into elements by semicolon/comma heuristic
    const elements = text.split(/;/).map(s => s.trim()).filter(Boolean)
    for (const el of elements) {
      rows.push(new TableRow({
        children: [
          borderCell(el),
          borderCell(''),
          borderCell(''),
        ],
      }))
    }
    // Add blank separator row between claims
    rows.push(new TableRow({
      children: [
        borderCell(`— End Claim ${i + 1} —`, true),
        borderCell('', true),
        borderCell('', true),
      ],
    }))
  }

  const table = new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: [3500, 4500, 2000],
  })

  const doc = new Document({
    sections: [{
      children: [
        heading1(`Claim Chart — ${patent.patentNumber}`),
        labelValue('Title', patent.title),
        spacer(),
        body('Instructions: Fill in the Evidence/Mapping column with the accused product/standard text, and the Source/Citation column with the document name and section.'),
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
