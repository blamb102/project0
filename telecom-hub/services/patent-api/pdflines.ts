// Extract column and line-number references from USPTO patent PDFs.
//
// US patents use a two-column layout.  Each column has line numbers printed in
// its left margin in multiples of five (5, 10, 15 … 65).  Column numbers are
// sequential across the whole document: page 1 has col 1 (left) and col 2
// (right), page 2 has col 3 and col 4, etc.  Line numbers reset to 1 at the
// top of every column.
//
// Returns one PdfParagraph per text block, with enough normalised text for
// the caller to fuzzy-match it against XML-derived description paragraphs.

export interface PdfParagraph {
  startCol:  number
  startLine: number
  endCol:    number
  endLine:   number
  text:      string   // normalised (lowercase, no punct) for matching
}

// ── Internals ─────────────────────────────────────────────────────────────────

interface Item   { str: string; x: number; y: number; w: number }
interface Marker { n: number;   y: number }

const MARKED_LINES = new Set([5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65])

function normText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
}

// Find the x-coordinate of the gutter between the two text columns.
function findColSplit(items: Item[]): number {
  const PAGE_W = 612
  const BINS   = 60
  const binW   = PAGE_W / BINS
  const dens   = new Float32Array(BINS)
  for (const it of items) {
    if (it.str.trim().length < 3 || it.w < 12) continue
    const b = Math.min(Math.floor(it.x / binW), BINS - 1)
    dens[b] += it.str.length
  }
  // Minimum-density bin in the middle third of the page = gutter
  let minD = Infinity, splitBin = 30
  for (let b = 14; b < 44; b++) {
    if (dens[b] < minD) { minD = dens[b]; splitBin = b }
  }
  return (splitBin + 0.5) * binW
}

// Collect line-number markers (items whose text is exactly "5", "10", etc.)
// for the left and right columns.
function getMarkers(items: Item[], colSplit: number): { left: Marker[]; right: Marker[] } {
  const left: Marker[] = [], right: Marker[] = []
  for (const it of items) {
    const t = it.str.trim()
    const n = parseInt(t, 10)
    if (String(n) !== t || !MARKED_LINES.has(n)) continue
    if (it.w > 24) continue   // wider than a standalone margin number → skip

    if (it.x < colSplit - 35)                              left.push({ n, y: it.y })
    else if (it.x > colSplit + 5 && it.x < colSplit + 110) right.push({ n, y: it.y })
  }
  // Sort descending y (top of page first, since y=0 is bottom in PDF coords)
  const byY = (a: Marker, b: Marker) => b.y - a.y
  return { left: left.sort(byY), right: right.sort(byY) }
}

function pageHasMarkers(items: Item[]): boolean {
  return items.some(it => {
    const t = it.str.trim()
    const n = parseInt(t, 10)
    return String(n) === t && MARKED_LINES.has(n) && it.w <= 24
  })
}

// Average spacing between adjacent line markers (pt per line).
function lineHeight(markers: Marker[]): number {
  if (markers.length < 2) return 10
  const span  = markers[0].y - markers[markers.length - 1].y
  const lines = markers[markers.length - 1].n - markers[0].n
  return lines > 0 ? span / lines : 10
}

// Convert a y-coordinate to a line number using the marker grid.
function yToLine(y: number, markers: Marker[]): number {
  if (markers.length === 0) return 1
  if (markers.length === 1) return markers[0].n

  for (let i = 0; i < markers.length - 1; i++) {
    const hi = markers[i], lo = markers[i + 1]
    if (y <= hi.y && y >= lo.y) {
      const t = (hi.y - y) / (hi.y - lo.y)
      return Math.max(1, Math.round(hi.n + t * (lo.n - hi.n)))
    }
  }
  // Extrapolate beyond the markers
  const lh = lineHeight(markers)
  if (y > markers[0].y) {
    return Math.max(1, Math.round(markers[0].n - (y - markers[0].y) / lh))
  }
  return Math.min(65, Math.round(markers[markers.length - 1].n + (markers[markers.length - 1].y - y) / lh))
}

// Group column text items into paragraphs and push them into `out`.
function extractColParas(
  items:     Item[],
  rightSide: boolean,
  colSplit:  number,
  markers:   Marker[],
  colNum:    number,
  out:       PdfParagraph[],
): void {
  // Keep only items in this column; exclude bare line-number markers
  const col = items.filter(it => {
    if ((it.x > colSplit) !== rightSide) return false
    const t = it.str.trim()
    const n = parseInt(t, 10)
    if (String(n) === t && MARKED_LINES.has(n) && it.w <= 24) return false
    return true
  })
  if (col.length === 0) return

  col.sort((a, b) => b.y - a.y)  // top → bottom

  const lh = lineHeight(markers)
  const GAP = lh * 2.2  // vertical gap larger than this separates paragraphs

  // Accumulate text rows; flush into a paragraph on each large gap
  type Row = { y: number; strs: string[] }
  const flush = (rows: Row[]) => {
    const text = normText(rows.flatMap(r => r.strs).join(' ')).slice(0, 200)
    if (!text) return
    out.push({
      startCol:  colNum,
      startLine: yToLine(rows[0].y, markers),
      endCol:    colNum,
      endLine:   yToLine(rows[rows.length - 1].y, markers),
      text,
    })
  }

  let rows: Row[] = [{ y: col[0].y, strs: [col[0].str] }]
  for (let i = 1; i < col.length; i++) {
    const it = col[i]
    const last = rows[rows.length - 1]
    if (Math.abs(it.y - last.y) <= lh * 0.65) {
      last.strs.push(it.str)  // same row
    } else if (last.y - it.y > GAP) {
      flush(rows)
      rows = [{ y: it.y, strs: [it.str] }]
    } else {
      rows.push({ y: it.y, strs: [it.str] })
    }
  }
  if (rows.length) flush(rows)
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function extractParagraphLines(pdfBuf: Buffer): Promise<PdfParagraph[]> {
  let pdfjs: any
  try {
    pdfjs = await import('pdfjs-dist')
    pdfjs.GlobalWorkerOptions.workerSrc = ''
  } catch { return [] }

  let pdfdoc: any
  try {
    pdfdoc = await pdfjs.getDocument({
      data:            new Uint8Array(pdfBuf),
      useSystemFonts:  true,
      disableFontFace: true,
    }).promise
  } catch { return [] }

  // Collect text items from every page
  const pageItems: Item[][] = []
  for (let p = 1; p <= pdfdoc.numPages; p++) {
    try {
      const page = await pdfdoc.getPage(p)
      const tc   = await page.getTextContent()
      pageItems.push(
        tc.items
          .filter((it: any) => it.str?.trim())
          .map((it: any) => ({
            str: it.str as string,
            x:   it.transform[4] as number,
            y:   it.transform[5] as number,
            w:   it.width        as number,
          }))
      )
    } catch { pageItems.push([]) }
  }

  const colSplit  = findColSplit(pageItems.flat())
  const firstSpec = pageItems.findIndex(pageHasMarkers)
  if (firstSpec < 0) return []

  const result: PdfParagraph[] = []

  for (let i = firstSpec; i < pageItems.length; i++) {
    const items = pageItems[i]
    const { left, right } = getMarkers(items, colSplit)
    if (!left.length && !right.length) continue

    const col1 = (i - firstSpec) * 2 + 1
    extractColParas(items, false, colSplit, left,  col1,     result)
    extractColParas(items, true,  colSplit, right, col1 + 1, result)
  }

  return result
}
