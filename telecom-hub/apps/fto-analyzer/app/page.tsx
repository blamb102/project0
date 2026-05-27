'use client'

import { useState, useEffect, useRef, useMemo } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, PieChart, Pie, Cell, LineChart, Line,
} from 'recharts'

// ── Types ──────────────────────────────────────────────────────────────────────

interface ParsedFile {
  id: string
  name: string
  headers: string[]
  rows: Record<string, any>[]
}

interface ColumnMapping {
  appNumber: string
  assignee?: string
  filingDate?: string
  expiryDate?: string
  pubDate?: string
  country?: string
  status?: string
  title?: string
}

interface PatentRecord {
  _key: string
  _sources: string[]
  [k: string]: any
}

interface CustomChart {
  id: string
  title: string
  groupBy: string
  chartType: 'bar' | 'hbar' | 'pie'
  topN: number
}

type Tab = 'data' | 'timeline' | 'portfolio' | 'custom'

// ── Constants ──────────────────────────────────────────────────────────────────

const PALETTE = [
  '#3498db','#e74c3c','#2ecc71','#f39c12','#9b59b6',
  '#1abc9c','#e67e22','#e91e63','#34495e','#16a085','#c0392b','#8e44ad',
]

const SEMANTIC_FIELDS: (keyof ColumnMapping)[] = [
  'appNumber','assignee','filingDate','expiryDate','pubDate','country','status','title',
]

const FIELD_LABEL: Record<keyof ColumnMapping, string> = {
  appNumber: 'Application Number *',
  assignee:  'Assignee / Owner',
  filingDate:'Filing Date',
  expiryDate:'Expiry Date',
  pubDate:   'Publication Date',
  country:   'Country',
  status:    'Status',
  title:     'Title',
}

const DETECT: Record<keyof ColumnMapping, RegExp> = {
  appNumber: /applic|app[\s._-]*no|app[\s._-]*num|\bAN\b/i,
  assignee:  /assign|owner|applicant|proprietor/i,
  filingDate:/fil(ing)?[\s._-]*date|date[\s._-]*fil|app[\s._-]*date/i,
  expiryDate:/expir|lapse|dead/i,
  pubDate:   /pub[\s._-]*date|date[\s._-]*pub/i,
  country:   /country|jurisdict|\bCC\b|\bPC\b/i,
  status:    /status|legal/i,
  title:     /title|invention/i,
}

const ANALYSIS_KEY = 'fto_analysis'
const PAGE_SIZE     = 50

// ── Pure helpers ───────────────────────────────────────────────────────────────

function parseDate(val: any): Date | null {
  if (!val) return null
  if (val instanceof Date && !isNaN(val.getTime())) return val
  // Excel serial date (days since 1899-12-30)
  if (typeof val === 'number') {
    const d = new Date((val - 25569) * 86400000)
    return isNaN(d.getTime()) ? null : d
  }
  if (typeof val === 'string') {
    const d = new Date(val.trim())
    return isNaN(d.getTime()) ? null : d
  }
  return null
}

function getYear(d: Date | null) {
  if (!d) return null
  const y = d.getFullYear()
  return y > 1900 && y < 2100 ? y : null
}

function safeName(s: string) { return s.replace(/[^a-z0-9 ._-]/gi, '_').trim() || 'export' }

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function autoDetect(headers: string[]): ColumnMapping {
  const m: Partial<ColumnMapping> = {}
  for (const field of SEMANTIC_FIELDS) {
    const h = headers.find(h => DETECT[field].test(h))
    if (h) (m as any)[field] = h
  }
  if (!m.appNumber) m.appNumber = headers[0] ?? ''
  return m as ColumnMapping
}

async function parseFile(file: File): Promise<ParsedFile> {
  const XLSX = await import('xlsx')
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array', cellDates: true })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json<Record<string, any>>(ws, { defval: null })
  const headers = rows.length > 0 ? Object.keys(rows[0]) : []
  return { id: crypto.randomUUID(), name: file.name, headers, rows }
}

function mergeAll(files: ParsedFile[], mapping: ColumnMapping): PatentRecord[] {
  const map = new Map<string, PatentRecord>()
  let fallback = 0
  for (const f of files) {
    for (const row of f.rows) {
      const k = mapping.appNumber
        ? String(row[mapping.appNumber] ?? '').trim() || `__${fallback++}`
        : `__${fallback++}`
      if (map.has(k)) {
        const e = map.get(k)!
        for (const col of f.headers) {
          if ((e[col] === null || e[col] === undefined || e[col] === '') && row[col] != null)
            e[col] = row[col]
        }
        if (!e._sources.includes(f.id)) e._sources.push(f.id)
      } else {
        map.set(k, { _key: k, _sources: [f.id], ...row })
      }
    }
  }
  return Array.from(map.values())
}

function groupByCol(data: PatentRecord[], col: string, topN = 15): { name: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const r of data) {
    const v = String(r[col] ?? '').trim() || '(blank)'
    counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topN)
}

function groupByYear(data: PatentRecord[], col: string): { year: number; count: number }[] {
  const counts = new Map<number, number>()
  for (const r of data) {
    const y = getYear(parseDate(r[col]))
    if (y) counts.set(y, (counts.get(y) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .map(([year, count]) => ({ year, count }))
    .sort((a, b) => a.year - b.year)
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function FtoPage() {
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [files,        setFiles]        = useState<ParsedFile[]>([])
  const [mapping,      setMapping]      = useState<ColumnMapping>({ appNumber: '' })
  const [merged,       setMerged]       = useState<PatentRecord[]>([])
  const [activeTab,    setActiveTab]    = useState<Tab>('data')
  const [customCharts, setCustomCharts] = useState<CustomChart[]>([])
  const [analysisName, setAnalysisName] = useState('FTO Analysis')
  const [editingName,  setEditingName]  = useState(false)
  const [dataPage,     setDataPage]     = useState(0)
  const [dragging,     setDragging]     = useState(false)
  const [sortCol,      setSortCol]      = useState<string | null>(null)
  const [sortDir,      setSortDir]      = useState<'asc' | 'desc'>('asc')
  const [mounted,      setMounted]      = useState(false)
  const [loading,      setLoading]      = useState(false)
  const [newChart,     setNewChart]     = useState<Partial<CustomChart>>({ chartType: 'bar', topN: 10 })

  // Restore saved analysis config on mount
  useEffect(() => {
    setMounted(true)
    try {
      const saved = localStorage.getItem(ANALYSIS_KEY)
      if (saved) {
        const { name, mapping: m, charts } = JSON.parse(saved)
        if (name) setAnalysisName(name)
        if (m)    setMapping(m)
        if (charts) setCustomCharts(charts)
      }
    } catch {}
  }, [])

  // Persist analysis config whenever it changes
  useEffect(() => {
    if (!mounted) return
    try {
      localStorage.setItem(ANALYSIS_KEY, JSON.stringify({ name: analysisName, mapping, charts: customCharts }))
    } catch {}
  }, [analysisName, mapping, customCharts, mounted])

  // Re-merge whenever files or mapping changes
  useEffect(() => {
    if (files.length === 0) { setMerged([]); return }
    setMerged(mergeAll(files, mapping))
    setDataPage(0)
  }, [files, mapping])

  const allCols = useMemo(() => {
    if (!merged.length) return []
    return Object.keys(merged[0]).filter(k => !k.startsWith('_'))
  }, [merged])

  const dedupedHeaders = useMemo(
    () => [...new Set(files.flatMap(f => f.headers))],
    [files]
  )

  // ── File handling ────────────────────────────────────────────────────────────

  async function handleFiles(fileList: FileList | File[]) {
    const list = Array.from(fileList).filter(f => /\.(xlsx?|csv)$/i.test(f.name))
    if (!list.length) return
    setLoading(true)
    const parsed: ParsedFile[] = []
    for (const f of list) {
      try { parsed.push(await parseFile(f)) }
      catch (e: any) { alert(`Failed to parse ${f.name}: ${e.message}`) }
    }
    setFiles(prev => {
      const next = [...prev, ...parsed]
      if (prev.length === 0 && parsed.length > 0) setMapping(autoDetect(parsed[0].headers))
      return next
    })
    setLoading(false)
  }

  // ── Sorting & pagination ─────────────────────────────────────────────────────

  const sortedData = useMemo(() => {
    if (!sortCol) return merged
    return [...merged].sort((a, b) => {
      const cmp = String(a[sortCol] ?? '').localeCompare(String(b[sortCol] ?? ''), undefined, { numeric: true })
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [merged, sortCol, sortDir])

  const pageData  = sortedData.slice(dataPage * PAGE_SIZE, (dataPage + 1) * PAGE_SIZE)
  const pageCount = Math.ceil(sortedData.length / PAGE_SIZE)

  // ── Export ───────────────────────────────────────────────────────────────────

  async function exportXlsx() {
    const XLSX = await import('xlsx')
    const rows = merged.map(r => {
      const out: Record<string, any> = {}
      for (const [k, v] of Object.entries(r)) if (!k.startsWith('_')) out[k] = v
      return out
    })
    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Patents')
    XLSX.writeFile(wb, `${safeName(analysisName)}.xlsx`)
  }

  function downloadChartSvg(containerId: string, filename: string) {
    const svg = document.getElementById(containerId)?.querySelector('svg')
    if (!svg) { alert('Chart not ready'); return }
    const clone = svg.cloneNode(true) as SVGElement
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    downloadBlob(new Blob([clone.outerHTML], { type: 'image/svg+xml' }), filename)
  }

  // ── Chart data ───────────────────────────────────────────────────────────────

  const filingData   = useMemo(() => mapping.filingDate ? groupByYear(merged, mapping.filingDate) : [], [merged, mapping.filingDate])
  const expiryData   = useMemo(() => mapping.expiryDate ? groupByYear(merged, mapping.expiryDate) : [], [merged, mapping.expiryDate])
  const assigneeData = useMemo(() => mapping.assignee   ? groupByCol(merged, mapping.assignee)    : [], [merged, mapping.assignee])
  const countryData  = useMemo(() => mapping.country    ? groupByCol(merged, mapping.country)     : [], [merged, mapping.country])
  const statusData   = useMemo(() => mapping.status     ? groupByCol(merged, mapping.status)      : [], [merged, mapping.status])

  const timelineData = useMemo(() => {
    const years = new Set([...filingData.map(d => d.year), ...expiryData.map(d => d.year)])
    if (!years.size) return []
    const min = Math.min(...years), max = Math.max(...years)
    const out: { year: number; Filings?: number; Expirations?: number }[] = []
    for (let y = min; y <= max; y++) out.push({
      year: y,
      Filings:     filingData.find(d => d.year === y)?.count,
      Expirations: expiryData.find(d => d.year === y)?.count,
    })
    return out
  }, [filingData, expiryData])

  const hasData = merged.length > 0

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <main style={{ minHeight: '100vh', background: '#f0f2f5', fontFamily: "'Segoe UI',system-ui,sans-serif", display: 'flex', flexDirection: 'column' }}>

      {/* Top bar */}
      <div style={{ background: '#1a1a2e', color: '#fff', padding: '0.5rem 1rem', display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap', zIndex: 10, flexShrink: 0 }}>
        <span style={{ fontWeight: 800, fontSize: '0.95rem', color: '#7fb3f5', flexShrink: 0, letterSpacing: '0.02em' }}>FTO Analyzer</span>
        <div style={vDiv} />

        {editingName
          ? <input autoFocus value={analysisName} onChange={e => setAnalysisName(e.target.value)}
              onBlur={() => setEditingName(false)} onKeyDown={e => e.key === 'Enter' && setEditingName(false)}
              style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.3)', color: '#fff', borderRadius: 5, padding: '0.2rem 0.45rem', fontSize: '0.88rem', fontWeight: 700, outline: 'none', width: 200 }} />
          : <span onClick={() => setEditingName(true)} title="Click to rename"
              style={{ fontWeight: 700, fontSize: '0.88rem', cursor: 'pointer', borderBottom: '1px dashed rgba(255,255,255,0.35)', paddingBottom: 1 }}>
              {analysisName}
            </span>
        }

        <div style={vDiv} />
        <button onClick={() => fileInputRef.current?.click()} style={topBtn('#2c3e50')}>+ Add Files</button>
        <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" multiple style={{ display: 'none' }}
          onChange={e => { if (e.target.files?.length) handleFiles(e.target.files); e.target.value = '' }} />

        {hasData && (
          <span style={{ fontSize: '0.78rem', color: '#aaa' }}>
            {files.length} file{files.length !== 1 ? 's' : ''} · {merged.length.toLocaleString()} patents
          </span>
        )}

        <div style={{ flex: 1 }} />

        {hasData && (
          <button onClick={exportXlsx} style={topBtn('#27ae60')}>Export XLSX</button>
        )}
      </div>

      {/* Body */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* Left panel */}
        <div style={{ width: 260, background: '#fff', borderRight: '1px solid #e8e8e8', display: 'flex', flexDirection: 'column', flexShrink: 0, overflow: 'hidden' }}>

          {/* Files */}
          <div style={{ padding: '0.7rem', borderBottom: '1px solid #eee', flexShrink: 0 }}>
            <span style={{ fontWeight: 700, fontSize: '0.8rem', color: '#333' }}>Files ({files.length})</span>
            <div style={{ marginTop: '0.4rem' }}>
              {files.length === 0 && <div style={{ fontSize: '0.73rem', color: '#bbb' }}>No files loaded</div>}
              {files.map(f => (
                <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.25rem 0.3rem', borderRadius: 4, background: '#fafafa', border: '1px solid #eee', marginBottom: '0.2rem' }}>
                  <span style={{ fontSize: '0.73rem', color: '#555', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.name}>{f.name}</span>
                  <span style={{ fontSize: '0.65rem', color: '#aaa', flexShrink: 0 }}>{f.rows.length.toLocaleString()}</span>
                  <button onClick={() => setFiles(fs => fs.filter(x => x.id !== f.id))}
                    style={{ background: 'none', border: 'none', color: '#ccc', cursor: 'pointer', fontSize: '0.9rem', padding: 0, lineHeight: 1 }}
                    onMouseEnter={e => (e.currentTarget.style.color = '#e74c3c')}
                    onMouseLeave={e => (e.currentTarget.style.color = '#ccc')}>×</button>
                </div>
              ))}
            </div>
          </div>

          {/* Column mapping */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '0.7rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
              <span style={{ fontWeight: 700, fontSize: '0.8rem', color: '#333' }}>Column Mapping</span>
              {files.length > 0 && (
                <button onClick={() => setMapping(autoDetect(dedupedHeaders))}
                  style={{ fontSize: '0.65rem', padding: '0.1rem 0.35rem', border: '1px solid #ccc', borderRadius: 3, background: '#f5f5f5', cursor: 'pointer', color: '#555' }}>
                  Auto-detect
                </button>
              )}
            </div>
            {files.length === 0 && <div style={{ fontSize: '0.73rem', color: '#bbb' }}>Load files to configure columns.</div>}
            {files.length > 0 && SEMANTIC_FIELDS.map(field => (
              <div key={field} style={{ marginBottom: '0.55rem' }}>
                <div style={{ fontSize: '0.68rem', color: '#888', marginBottom: 2 }}>{FIELD_LABEL[field]}</div>
                <select
                  value={(mapping as any)[field] ?? ''}
                  onChange={e => setMapping(m => ({ ...m, [field]: e.target.value || undefined }))}
                  style={{ width: '100%', fontSize: '0.73rem', border: '1px solid #ddd', borderRadius: 4, padding: '0.18rem 0.3rem', background: '#fff', color: '#333' }}>
                  <option value="">— not mapped —</option>
                  {dedupedHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
            ))}
          </div>
        </div>

        {/* Main area */}
        <div
          style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', position: 'relative', background: dragging ? '#e8f4fd' : '#f0f2f5', outline: dragging ? '3px dashed #3498db' : 'none', transition: 'background 0.1s' }}
          onDragOver={e => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files) }}
        >
          {loading && (
            <div style={{ position: 'absolute', inset: 0, zIndex: 50, background: 'rgba(240,242,245,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ fontWeight: 600, color: '#555', fontSize: '1rem' }}>Parsing files…</span>
            </div>
          )}

          {/* Empty state */}
          {!hasData && !loading && (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', color: '#c0c0c0', userSelect: 'none', gap: '0.5rem', padding: '2rem' }}>
              <div style={{ fontSize: '3.5rem' }}>📊</div>
              <div style={{ fontSize: '1.1rem', fontWeight: 700 }}>Drop Excel / CSV files here</div>
              <div style={{ fontSize: '0.85rem' }}>or click <strong style={{ color: '#aaa' }}>+ Add Files</strong> in the toolbar</div>
              <div style={{ fontSize: '0.75rem', marginTop: '0.2rem' }}>.xlsx · .xls · .csv</div>
            </div>
          )}

          {/* Tabs */}
          {hasData && (
            <>
              <div style={{ background: '#fff', borderBottom: '1px solid #e8e8e8', padding: '0 1rem', display: 'flex', alignItems: 'stretch', flexShrink: 0 }}>
                {(['data', 'timeline', 'portfolio', 'custom'] as Tab[]).map(t => (
                  <button key={t} onClick={() => setActiveTab(t)} style={{
                    padding: '0.6rem 1.1rem', border: 'none', background: 'none', cursor: 'pointer',
                    borderBottom: `2.5px solid ${activeTab === t ? '#3498db' : 'transparent'}`,
                    color: activeTab === t ? '#3498db' : '#666',
                    fontWeight: activeTab === t ? 700 : 400, fontSize: '0.85rem',
                  }}>
                    {t === 'data' ? 'Data' : t === 'timeline' ? 'Timeline' : t === 'portfolio' ? 'Portfolio' : 'Custom Charts'}
                  </button>
                ))}
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: '0.73rem', color: '#aaa', alignSelf: 'center' }}>
                  {merged.length.toLocaleString()} records from {files.length} file{files.length !== 1 ? 's' : ''}
                </span>
              </div>

              <div style={{ flex: 1, overflow: 'auto', padding: '1.25rem' }}>
                {activeTab === 'data'      && renderDataTab()}
                {activeTab === 'timeline'  && renderTimelineTab()}
                {activeTab === 'portfolio' && renderPortfolioTab()}
                {activeTab === 'custom'    && renderCustomTab()}
              </div>
            </>
          )}
        </div>
      </div>
    </main>
  )

  // ── Tab renderers ────────────────────────────────────────────────────────────

  function renderDataTab() {
    const cols = allCols.slice(0, 14)
    return (
      <div>
        <div style={{ overflowX: 'auto', borderRadius: 8, boxShadow: '0 1px 6px rgba(0,0,0,0.08)', background: '#fff' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.77rem' }}>
            <thead>
              <tr style={{ background: '#f8f9fa', borderBottom: '2px solid #e8e8e8' }}>
                {cols.map(col => (
                  <th key={col} onClick={() => { setSortDir(sortCol === col && sortDir === 'asc' ? 'desc' : 'asc'); setSortCol(col) }}
                    style={{ padding: '0.5rem 0.65rem', textAlign: 'left', fontWeight: 700, color: '#444', cursor: 'pointer', whiteSpace: 'nowrap', userSelect: 'none' }}>
                    {col}{sortCol === col ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageData.map((row, i) => (
                <tr key={row._key} style={{ background: i % 2 ? '#fafafa' : '#fff', borderBottom: '1px solid #f0f0f0' }}>
                  {cols.map(col => (
                    <td key={col} title={String(row[col] ?? '')}
                      style={{ padding: '0.38rem 0.65rem', color: '#555', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {String(row[col] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {pageCount > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem', marginTop: '0.75rem' }}>
            <button onClick={() => setDataPage(0)}                           disabled={dataPage === 0}            style={pageBtn(dataPage === 0)}>«</button>
            <button onClick={() => setDataPage(p => p - 1)}                  disabled={dataPage === 0}            style={pageBtn(dataPage === 0)}>‹</button>
            <span style={{ fontSize: '0.78rem', color: '#666', padding: '0 0.5rem' }}>
              Page {dataPage + 1} / {pageCount} &nbsp;·&nbsp; {merged.length.toLocaleString()} records
            </span>
            <button onClick={() => setDataPage(p => p + 1)}                  disabled={dataPage === pageCount - 1} style={pageBtn(dataPage === pageCount - 1)}>›</button>
            <button onClick={() => setDataPage(pageCount - 1)}               disabled={dataPage === pageCount - 1} style={pageBtn(dataPage === pageCount - 1)}>»</button>
          </div>
        )}
      </div>
    )
  }

  function renderTimelineTab() {
    if (!mounted) return null
    if (!mapping.filingDate && !mapping.expiryDate)
      return <NoMapping msg="Map Filing Date and/or Expiry Date on the left to see the timeline." />
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        {mapping.filingDate && filingData.length > 0 && (
          <ChartCard id="ch-filings" title="Patent Filings by Year" onSvg={() => downloadChartSvg('ch-filings', 'filings_by_year.svg')}>
            <VBarChart data={filingData} xKey="year" yKey="count" color="#3498db" />
          </ChartCard>
        )}
        {mapping.expiryDate && expiryData.length > 0 && (
          <ChartCard id="ch-expiry" title="Patent Expirations by Year" onSvg={() => downloadChartSvg('ch-expiry', 'expirations_by_year.svg')}>
            <VBarChart data={expiryData} xKey="year" yKey="count" color="#e74c3c" />
          </ChartCard>
        )}
        {mapping.filingDate && mapping.expiryDate && timelineData.length > 0 && (
          <ChartCard id="ch-combined" title="Filings vs. Expirations Over Time" onSvg={() => downloadChartSvg('ch-combined', 'timeline_combined.svg')}>
            <CombinedLine data={timelineData} />
          </ChartCard>
        )}
      </div>
    )
  }

  function renderPortfolioTab() {
    if (!mounted) return null
    if (!mapping.assignee && !mapping.country && !mapping.status)
      return <NoMapping msg="Map Assignee, Country, and/or Status on the left to see portfolio charts." />
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(500px,1fr))', gap: '1.5rem' }}>
        {mapping.assignee && assigneeData.length > 0 && (
          <ChartCard id="ch-assignee" title="Top Assignees" onSvg={() => downloadChartSvg('ch-assignee', 'top_assignees.svg')}>
            <HBarChart data={assigneeData} />
          </ChartCard>
        )}
        {mapping.country && countryData.length > 0 && (
          <ChartCard id="ch-country" title="Patents by Country" onSvg={() => downloadChartSvg('ch-country', 'by_country.svg')}>
            <HBarChart data={countryData} />
          </ChartCard>
        )}
        {mapping.status && statusData.length > 0 && (
          <ChartCard id="ch-status" title="Patents by Status" onSvg={() => downloadChartSvg('ch-status', 'by_status.svg')}>
            <PieChartComp data={statusData} />
          </ChartCard>
        )}
      </div>
    )
  }

  function renderCustomTab() {
    if (!mounted) return null
    return (
      <div>
        {/* Add chart form */}
        <div style={{ background: '#fff', borderRadius: 8, padding: '1rem 1.25rem', marginBottom: '1.5rem', boxShadow: '0 1px 6px rgba(0,0,0,0.08)' }}>
          <div style={{ fontWeight: 700, fontSize: '0.85rem', color: '#333', marginBottom: '0.8rem' }}>Add Custom Chart</div>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <Field label="Title">
              <input value={newChart.title ?? ''} onChange={e => setNewChart(c => ({ ...c, title: e.target.value }))}
                placeholder="Chart title" style={inputSm({ width: 160 })} />
            </Field>
            <Field label="Group by column">
              <select value={newChart.groupBy ?? ''} onChange={e => setNewChart(c => ({ ...c, groupBy: e.target.value }))} style={inputSm({ minWidth: 170 })}>
                <option value="">— select —</option>
                {allCols.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="Chart type">
              <select value={newChart.chartType ?? 'bar'} onChange={e => setNewChart(c => ({ ...c, chartType: e.target.value as any }))} style={inputSm({})}>
                <option value="bar">Bar (vertical)</option>
                <option value="hbar">Bar (horizontal)</option>
                <option value="pie">Pie</option>
              </select>
            </Field>
            <Field label="Top N">
              <input type="number" min={1} max={50} value={newChart.topN ?? 10}
                onChange={e => setNewChart(c => ({ ...c, topN: Number(e.target.value) }))} style={inputSm({ width: 70 })} />
            </Field>
            <button
              disabled={!newChart.groupBy}
              onClick={() => {
                if (!newChart.groupBy) return
                setCustomCharts(c => [...c, {
                  id: crypto.randomUUID(),
                  title: newChart.title?.trim() || `By ${newChart.groupBy}`,
                  groupBy: newChart.groupBy!,
                  chartType: newChart.chartType ?? 'bar',
                  topN: newChart.topN ?? 10,
                }])
                setNewChart({ chartType: 'bar', topN: 10 })
              }}
              style={topBtn('#3498db', !newChart.groupBy)}>
              Add Chart
            </button>
          </div>
        </div>

        {customCharts.length === 0 && (
          <div style={{ color: '#bbb', textAlign: 'center', padding: '3rem', fontSize: '0.9rem' }}>
            No custom charts yet — use the form above to add one.
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(500px,1fr))', gap: '1.5rem' }}>
          {customCharts.map(chart => {
            const data = groupByCol(merged, chart.groupBy, chart.topN)
            const cid  = `ch-custom-${chart.id}`
            return (
              <ChartCard key={chart.id} id={cid} title={chart.title}
                onSvg={() => downloadChartSvg(cid, `${safeName(chart.title)}.svg`)}
                onDelete={() => setCustomCharts(c => c.filter(x => x.id !== chart.id))}>
                {chart.chartType === 'pie'  && <PieChartComp data={data} />}
                {chart.chartType === 'hbar' && <HBarChart data={data} />}
                {chart.chartType === 'bar'  && <VBarChart data={data} xKey="name" yKey="count" color="#3498db" />}
              </ChartCard>
            )
          })}
        </div>
      </div>
    )
  }
}

// ── Style helpers ──────────────────────────────────────────────────────────────

const vDiv: React.CSSProperties = { width: 1, height: 18, background: 'rgba(255,255,255,0.2)', flexShrink: 0 }

function topBtn(bg: string, disabled = false): React.CSSProperties {
  return { padding: '0.33rem 0.75rem', borderRadius: 6, border: 'none', background: disabled ? '#555' : bg, color: '#fff', fontWeight: 600, fontSize: '0.8rem', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1, flexShrink: 0 }
}
function pageBtn(disabled: boolean): React.CSSProperties {
  return { padding: '0.2rem 0.5rem', border: '1px solid #ddd', borderRadius: 4, background: disabled ? '#f5f5f5' : '#fff', color: disabled ? '#ccc' : '#555', cursor: disabled ? 'default' : 'pointer', fontSize: '0.85rem' }
}
function inputSm(extra: React.CSSProperties): React.CSSProperties {
  return { fontSize: '0.8rem', border: '1px solid #ddd', borderRadius: 4, padding: '0.28rem 0.45rem', ...extra }
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function NoMapping({ msg }: { msg: string }) {
  return <div style={{ color: '#aaa', textAlign: 'center', padding: '3rem 1rem', fontSize: '0.9rem' }}>{msg}</div>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: '0.68rem', color: '#888', marginBottom: 3 }}>{label}</div>
      {children}
    </div>
  )
}

function ChartCard({ id, title, children, onSvg, onDelete }: {
  id: string; title: string; children: React.ReactNode
  onSvg: () => void; onDelete?: () => void
}) {
  return (
    <div style={{ background: '#fff', borderRadius: 8, boxShadow: '0 1px 6px rgba(0,0,0,0.08)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.7rem 1rem', borderBottom: '1px solid #f0f0f0' }}>
        <span style={{ fontWeight: 700, fontSize: '0.85rem', color: '#333' }}>{title}</span>
        <div style={{ display: 'flex', gap: '0.35rem' }}>
          <button onClick={onSvg} title="Download SVG"
            style={{ fontSize: '0.72rem', padding: '0.15rem 0.45rem', border: '1px solid #ddd', borderRadius: 4, background: '#fafafa', cursor: 'pointer', color: '#555' }}>↓ SVG</button>
          {onDelete && (
            <button onClick={onDelete} title="Remove chart"
              style={{ fontSize: '0.72rem', padding: '0.15rem 0.4rem', border: '1px solid #fcc', borderRadius: 4, background: '#fff5f5', cursor: 'pointer', color: '#e74c3c' }}>×</button>
          )}
        </div>
      </div>
      <div id={id} style={{ padding: '1rem 0.5rem 0.5rem' }}>{children}</div>
    </div>
  )
}

function VBarChart({ data, xKey, yKey, color }: { data: any[]; xKey: string; yKey: string; color: string }) {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={data} margin={{ top: 5, right: 15, left: 5, bottom: 50 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis dataKey={xKey} tick={{ fontSize: 11 }} angle={-40} textAnchor="end" interval="preserveStartEnd" />
        <YAxis tick={{ fontSize: 11 }} />
        <Tooltip />
        <Bar dataKey={yKey} fill={color} radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}

function HBarChart({ data }: { data: { name: string; count: number }[] }) {
  const h = Math.max(220, data.length * 30)
  return (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={data} layout="vertical" margin={{ top: 5, right: 40, left: 10, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
        <XAxis type="number" tick={{ fontSize: 11 }} />
        <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={150} />
        <Tooltip />
        <Bar dataKey="count" radius={[0, 3, 3, 0]}>
          {data.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

function PieChartComp({ data }: { data: { name: string; count: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={320}>
      <PieChart>
        <Pie data={data} dataKey="count" nameKey="name" cx="50%" cy="50%" outerRadius={110}
          label={({ name, percent }) => `${String(name).slice(0, 18)} ${(percent * 100).toFixed(0)}%`}>
          {data.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
        </Pie>
        <Tooltip formatter={(v: any, n: any) => [v, n]} />
        <Legend />
      </PieChart>
    </ResponsiveContainer>
  )
}

function CombinedLine({ data }: { data: { year: number; Filings?: number; Expirations?: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={data} margin={{ top: 5, right: 20, left: 5, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis dataKey="year" tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 11 }} />
        <Tooltip />
        <Legend />
        <Line type="monotone" dataKey="Filings"     stroke="#3498db" strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="Expirations" stroke="#e74c3c" strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  )
}
