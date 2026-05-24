import { graphlib, layout as dagreLayout } from '@dagrejs/dagre'
import type { FamilyTreeData, FamilyTreeNode, FamilyTreeEdge } from './sources'

// ── Layout constants ──────────────────────────────────────────────────────────

const NODE_W   = 200
const NODE_H   = 110
const RANK_SEP = 200  // horizontal gap between columns  (dagre ranksep)
const NODE_SEP = 80   // minimum vertical gap between nodes in same rank (dagre nodesep)
const L_PAD    = 44   // left/right outer margin
const T_PAD    = 68   // top area reserved for title + column-year headers
const LEGEND_H = 76   // space for legend at bottom (2 rows)
const HEADER_H = 22   // coloured header band inside each node

// ── Visual styling ────────────────────────────────────────────────────────────

function nodeFill(applicationType: string): string {
  switch ((applicationType ?? '').toUpperCase()) {
    case 'PROVSNL':        return '#FFF7CC'
    case 'REGULAR':        return '#E3F2FD'
    case 'REISSUE':
    case 'REEXAM':         return '#CEFAD0'
    case 'DESIGN':         return '#FCE4EC'
    case 'PCT':            return '#E0F7FA'
    default:               return '#F5F5F5'
  }
}

function nodeBorder(status: string): string {
  const s = (status ?? '').toLowerCase()
  if ((s.includes('patent') || s.includes('grant')) && !s.includes('abandon')) return '#2E7D32'
  if (s.includes('abandon') || s.includes('expir'))  return '#C62828'
  if (s.includes('pending') || s.includes('docket')) return '#EF6C00'
  return '#9E9E9E'
}

function edgeStroke(rel: string): string {
  switch ((rel ?? '').toUpperCase()) {
    case 'CON': return '#424242'
    case 'CIP': return '#E65100'
    case 'DIV': return '#1565C0'
    case 'PRO': return '#2E7D32'
    case '371':
    case 'NST':
    case 'NAT': return '#6A1B9A'
    default:    return '#9E9E9E'
  }
}

function edgeDash(rel: string): string {
  switch ((rel ?? '').toUpperCase()) {
    case 'CIP': return '7,4'
    case 'PRO': return '4,4'
    case '371':
    case 'NST':
    case 'NAT': return '9,4'
    default:    return 'none'
  }
}

function edgeWidth(rel: string): number {
  return (rel ?? '').toUpperCase() === 'DIV' ? 2.5 : 1.5
}

function markerId(rel: string): string {
  switch ((rel ?? '').toUpperCase()) {
    case 'CON': return 'dark'
    case 'CIP': return 'orange'
    case 'DIV': return 'blue'
    case 'PRO': return 'green'
    case '371':
    case 'NST':
    case 'NAT': return 'purple'
    default:    return 'gray'
  }
}

// Normalise display label for relations
function edgeLabel(rel: string): string {
  switch ((rel ?? '').toUpperCase()) {
    case 'NST':
    case 'NAT': return '371'
    default:    return rel
  }
}

// ── SVG helpers ───────────────────────────────────────────────────────────────

function esc(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function metaRow(x: number, y: number, label: string, value: string): string {
  return `<text x="${x + 7}" y="${y}" font-size="9" fill="#333"><tspan font-weight="bold">${esc(label)}</tspan> ${esc(value)}</text>`
}

function wrapText(text: string, maxChars: number): string[] {
  const words = text.split(' ')
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (!current) {
      current = word
    } else if (current.length + 1 + word.length <= maxChars) {
      current += ' ' + word
    } else {
      lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  return lines.length ? lines : ['']
}

// ── GraphViz-style spline through dagre waypoints ────────────────────────────
//
// Catmull-Rom carried a component from the incoming diagonal into subsequent
// straight segments, creating visible bumps.  Quadratic bezier avoids this:
// each segment stays strictly within the convex hull of its three points, so
// overshoot is geometrically impossible.
//
// For 3 waypoints (the common case of one intermediate routing point): one
// quadratic arc, control point = the middle waypoint.
// For more waypoints: smooth-polyline technique — quadratic arcs through each
// interior point, joining at segment midpoints for C1-continuity everywhere.

function pathThrough(pts: Array<{ x: number; y: number }>): string {
  if (pts.length === 0) return ''
  const f = (n: number) => parseFloat(n.toFixed(1))

  if (pts.length === 1) return `M ${f(pts[0].x)} ${f(pts[0].y)}`
  if (pts.length === 2) {
    return `M ${f(pts[0].x)} ${f(pts[0].y)} L ${f(pts[1].x)} ${f(pts[1].y)}`
  }
  if (pts.length === 3) {
    // Single quadratic: control = middle waypoint
    return `M ${f(pts[0].x)} ${f(pts[0].y)} Q ${f(pts[1].x)} ${f(pts[1].y)} ${f(pts[2].x)} ${f(pts[2].y)}`
  }

  // Smooth polyline: arc through each interior waypoint, joined at midpoints
  const mid = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

  let d = `M ${f(pts[0].x)} ${f(pts[0].y)}`
  // First arc: from pts[0] toward pts[1], ending at midpoint(pts[1], pts[2])
  const m1 = mid(pts[1], pts[2])
  d += ` Q ${f(pts[1].x)} ${f(pts[1].y)} ${f(m1.x)} ${f(m1.y)}`
  // Interior arcs
  for (let i = 2; i < pts.length - 2; i++) {
    const m = mid(pts[i], pts[i + 1])
    d += ` Q ${f(pts[i].x)} ${f(pts[i].y)} ${f(m.x)} ${f(m.y)}`
  }
  // Last arc: from midpoint(pts[n-3], pts[n-2]) through pts[n-2] to pts[n-1]
  d += ` Q ${f(pts[pts.length - 2].x)} ${f(pts[pts.length - 2].y)} ${f(pts[pts.length - 1].x)} ${f(pts[pts.length - 1].y)}`
  return d
}

// ── Edge deduplication ────────────────────────────────────────────────────────

function relPriority(rel: string): number {
  switch ((rel ?? '').toUpperCase()) {
    case 'DIV': return 5
    case 'CIP': return 4
    case 'CON': return 3
    case '371':
    case 'NST':
    case 'NAT': return 2
    case 'PRO': return 2
    default:    return 1
  }
}

function deduplicateEdges(edges: FamilyTreeEdge[]): FamilyTreeEdge[] {
  const best = new Map<string, FamilyTreeEdge>()
  for (const e of edges) {
    const key = `${e.source}|${e.target}`
    const existing = best.get(key)
    if (!existing || relPriority(e.relation) > relPriority(existing.relation)) {
      best.set(key, e)
    }
  }
  return [...best.values()]
}

// ── Main export ───────────────────────────────────────────────────────────────

export function buildFamilyTreeSvg(data: FamilyTreeData): Buffer {
  const { nodes, edges: rawEdges } = data

  if (nodes.length === 0) {
    return Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="60">' +
      '<text x="10" y="36" font-family="Helvetica,Arial,sans-serif" font-size="13" fill="#555">' +
      '(No family tree data available)</text></svg>'
    )
  }

  const edges   = deduplicateEdges(rawEdges)
  const nodeSet = new Set(nodes.map(n => n.appNumber))

  // ── dagre layout (full Sugiyama: network-simplex ranks, barycenter crossing
  //    minimization with virtual nodes, Brandes & Köpf coordinate assignment) ──
  const g = new graphlib.Graph()
  g.setGraph({
    rankdir:   'LR',
    ranksep:   RANK_SEP,
    nodesep:   NODE_SEP,
    marginx:   L_PAD,
    marginy:   20,
    acyclicer: 'greedy',
    ranker:    'network-simplex',
  })
  g.setDefaultEdgeLabel(() => ({}))

  for (const n of nodes) {
    g.setNode(n.appNumber, { width: NODE_W, height: NODE_H })
  }
  for (const e of edges) {
    if (nodeSet.has(e.source) && nodeSet.has(e.target)) {
      const rel    = (e.relation ?? '').toUpperCase()
      // Higher weight → dagre keeps edge shorter & straighter during crossing minimization.
      // minlen: PRO→child gets rank gap ≥ 2 to visually separate it from the filing chain.
      const weight = (rel === 'CON' || rel === 'CIP' || rel === 'DIV') ? 3 : 1
      const minlen = rel === 'PRO' ? 2 : 1
      g.setEdge(e.source, e.target, { weight, minlen })
    }
  }

  dagreLayout(g)

  // dagre gives centre coords; convert to top-left and shift down by T_PAD
  const pos = new Map<string, { x: number; y: number }>()
  for (const n of nodes) {
    const { x, y } = g.node(n.appNumber) as { x: number; y: number }
    pos.set(n.appNumber, { x: x - NODE_W / 2, y: y - NODE_H / 2 + T_PAD })
  }

  const gi   = g.graph() as any
  const svgW = Math.ceil(gi.width  ?? 800)
  const svgH = Math.ceil(gi.height ?? 600) + T_PAD + LEGEND_H

  // Group nodes by their dagre rank-x (same rank → same centre-x) for column headers
  const byX = new Map<number, FamilyTreeNode[]>()
  for (const n of nodes) {
    const { x } = g.node(n.appNumber) as { x: number }
    const key = Math.round(x)
    if (!byX.has(key)) byX.set(key, [])
    byX.get(key)!.push(n)
  }
  const columns = [...byX.entries()].sort((a, b) => a[0] - b[0])

  // ── SVG output ────────────────────────────────────────────────────────────
  const out: string[] = []
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}" font-family="Helvetica,Arial,sans-serif">`)
  out.push(`<rect width="${svgW}" height="${svgH}" fill="#F8F9FA"/>`)

  // Arrowhead markers
  const markerDefs: Record<string, string> = {
    dark: '#424242', orange: '#E65100', blue: '#1565C0', green: '#2E7D32', purple: '#6A1B9A', gray: '#9E9E9E',
  }
  out.push('<defs>')
  for (const [id, color] of Object.entries(markerDefs)) {
    out.push(`<marker id="a-${id}" markerWidth="9" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0,9 3,0 6" fill="${color}"/></marker>`)
  }
  out.push('</defs>')

  // Title
  out.push(`<text x="${svgW / 2}" y="20" text-anchor="middle" font-size="15" font-weight="bold" fill="#1A1A2E">Patent Continuity Family Tree</text>`)
  out.push(`<text x="${svgW / 2}" y="38" text-anchor="middle" font-size="11" fill="#666">Root application: ${esc(data.rootApp)}</text>`)

  // Column year headers (above each dagre rank column)
  for (const [cx, colNodes] of columns) {
    const years = colNodes
      .map(n => { const d = n.filingDate; return d?.length >= 4 ? d.slice(0, 4) : '' })
      .filter(Boolean).sort()
    if (!years.length) continue
    const label = years[0] === years[years.length - 1]
      ? years[0]
      : `${years[0]}–${years[years.length - 1]}`
    out.push(`<text x="${cx}" y="58" text-anchor="middle" font-size="11" font-weight="bold" fill="#555">${esc(label)}</text>`)
  }

  // ── Edges (drawn under nodes) ─────────────────────────────────────────────
  // Use dagre's computed waypoints: they route through column gaps so edges
  // never cross node boxes.  Fall back to a direct line only if dagre gave
  // no waypoints (shouldn't happen for a valid graph).
  for (const e of edges) {
    const s = pos.get(e.source)
    const t = pos.get(e.target)
    if (!s || !t) continue

    const edgeObj = g.edge(e.source, e.target) as any
    const raw: Array<{ x: number; y: number }> = edgeObj?.points ?? []

    const pts = raw.length >= 2
      ? raw.map(p => ({ x: p.x, y: p.y + T_PAD }))
      : [
          { x: s.x + NODE_W, y: s.y + NODE_H / 2 },
          { x: t.x,          y: t.y + NODE_H / 2 },
        ]

    const rel      = e.relation?.toUpperCase() ?? ''
    const color    = edgeStroke(rel)
    const dash     = edgeDash(rel)
    const width    = edgeWidth(rel)
    const mid      = markerId(rel)
    const dashAttr = dash === 'none' ? '' : `stroke-dasharray="${dash}"`

    out.push(`<path d="${pathThrough(pts)}" fill="none" stroke="${color}" stroke-width="${width}" ${dashAttr} marker-end="url(#a-${mid})"/>`)

    if (rel && rel !== 'UNKNOWN' && pts.length >= 2) {
      const lx  = Math.round((pts[0].x + pts[1].x) / 2)
      const ly  = Math.round((pts[0].y + pts[1].y) / 2) - 7
      out.push(`<text x="${lx}" y="${ly}" text-anchor="middle" font-size="9" fill="${color}">${esc(edgeLabel(rel))}</text>`)
    }
  }

  // ── Nodes ─────────────────────────────────────────────────────────────────
  for (const n of nodes) {
    const p = pos.get(n.appNumber)
    if (!p) continue
    const { x, y } = p
    const fill   = n.isPriority ? '#EDE7F6' : nodeFill(n.applicationType)
    const border = n.isPriority ? '#673AB7' : nodeBorder(n.status)

    out.push(`<rect x="${x}" y="${y}" width="${NODE_W}" height="${NODE_H}" rx="5" fill="${fill}" stroke="${border}" stroke-width="2"/>`)
    out.push(`<rect x="${x + 1}" y="${y + 1}" width="${NODE_W - 2}" height="${HEADER_H}" rx="4" fill="${border}" opacity="0.18"/>`)

    const headerLabel = n.isPriority && n.priorityCountry
      ? `${n.priorityCountry} ${n.appNumber}`
      : n.appNumber
    out.push(`<text x="${x + NODE_W / 2}" y="${y + 15}" text-anchor="middle" font-size="10" font-weight="bold" fill="#1A1A2E">${esc(headerLabel)}</text>`)

    let ty = y + HEADER_H + 11
    const LH     = 13
    const bottom = y + NODE_H - 4

    if (n.filingDate && ty + LH <= bottom) {
      out.push(metaRow(x, ty, 'Filed:', n.filingDate.slice(0, 10)))
      ty += LH
    }
    if (n.grantDate && ty + LH <= bottom) {
      out.push(metaRow(x, ty, 'Granted:', n.grantDate.slice(0, 10)))
      ty += LH
    }
    if (n.patentNumber && ty + LH <= bottom) {
      out.push(metaRow(x, ty, 'Patent:', n.patentNumber))
      ty += LH
    } else if (n.publicationNumber && ty + LH <= bottom) {
      out.push(metaRow(x, ty, 'Pub:', n.publicationNumber))
      ty += LH
    }
    if (n.status && ty + LH <= bottom) {
      const lines = wrapText(n.status, 26)
      for (let i = 0; i < lines.length; i++) {
        if (ty + LH > bottom) break
        if (i === 0) {
          out.push(`<text x="${x + 7}" y="${ty}" font-size="9" fill="#333"><tspan font-weight="bold">Status:</tspan> ${esc(lines[i])}</text>`)
        } else {
          out.push(`<text x="${x + 14}" y="${ty}" font-size="9" fill="#333">${esc(lines[i])}</text>`)
        }
        ty += LH
      }
    }
  }

  // ── Legend ────────────────────────────────────────────────────────────────
  const lx = L_PAD
  const ly = svgH - LEGEND_H + 8
  const legendEdges = [
    { rel: 'CON', label: 'Continuation' },
    { rel: 'CIP', label: 'Cont-in-Part' },
    { rel: 'DIV', label: 'Divisional' },
    { rel: 'PRO', label: 'Provisional' },
    { rel: '371', label: 'Natl. Stage' },
  ]
  const legendNodes = [
    { fill: '#FFF7CC', label: 'Provisional' },
    { fill: '#E3F2FD', label: 'Utility' },
    { fill: '#CEFAD0', label: 'Reexam/Reissue' },
    { fill: '#E0F7FA', label: 'PCT' },
  ]

  // Row 1: edge types
  out.push(`<text x="${lx}" y="${ly}" font-size="9" fill="#777" font-weight="bold">Edges:</text>`)
  legendEdges.forEach(({ rel, label }, i) => {
    const ex    = lx + 40 + i * 120
    const ey    = ly + 1
    const color = edgeStroke(rel)
    const dash  = edgeDash(rel)
    const dashAttr = dash === 'none' ? '' : `stroke-dasharray="${dash}"`
    out.push(`<line x1="${ex}" y1="${ey}" x2="${ex + 22}" y2="${ey}" stroke="${color}" stroke-width="2" ${dashAttr}/>`)
    out.push(`<text x="${ex + 26}" y="${ey + 4}" font-size="9" fill="#555">${edgeLabel(rel)} — ${label}</text>`)
  })

  // Row 2: node types
  const row2y = ly + 22
  out.push(`<text x="${lx}" y="${row2y}" font-size="9" fill="#777" font-weight="bold">Nodes:</text>`)
  legendNodes.forEach(({ fill, label }, i) => {
    const bx = lx + 40 + i * 120
    const by = row2y - 7
    out.push(`<rect x="${bx}" y="${by}" width="14" height="10" rx="2" fill="${fill}" stroke="#9E9E9E" stroke-width="1"/>`)
    out.push(`<text x="${bx + 18}" y="${by + 9}" font-size="9" fill="#555">${label}</text>`)
  })

  out.push('</svg>')
  return Buffer.from(out.join('\n'))
}
