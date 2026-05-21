'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

// ── Simple markdown renderer (bold, headers, bullets) ─────────────────────────

function SimpleMarkdown({ text }: { text: string }) {
  const lines = text.split('\n')
  const elements: React.ReactNode[] = []
  let key = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('## ')) {
      elements.push(<h3 key={key++} style={{ fontSize: 15, fontWeight: 700, margin: '14px 0 4px', color: '#111' }}>{inline(line.slice(3))}</h3>)
    } else if (line.startsWith('# ')) {
      elements.push(<h2 key={key++} style={{ fontSize: 17, fontWeight: 700, margin: '16px 0 6px', color: '#111' }}>{inline(line.slice(2))}</h2>)
    } else if (/^[\-\*] /.test(line)) {
      elements.push(<li key={key++} style={{ margin: '2px 0', paddingLeft: 4, fontSize: 14, color: '#374151', lineHeight: 1.6 }}>{inline(line.slice(2))}</li>)
    } else if (line.trim() === '') {
      elements.push(<div key={key++} style={{ height: 6 }} />)
    } else {
      elements.push(<p key={key++} style={{ margin: '4px 0', fontSize: 14, color: '#374151', lineHeight: 1.6 }}>{inline(line)}</p>)
    }
  }
  return <div style={{ listStyle: 'disc', paddingLeft: 16 }}>{elements}</div>
}

function inline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return parts.map((p, i) =>
    p.startsWith('**') && p.endsWith('**')
      ? <strong key={i}>{p.slice(2, -2)}</strong>
      : p
  )
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface TDoc {
  id: string
  meetingId: string
  workingGroup: string
  title: string
  source: string
  type: string
  status: string
  agenda?: string
  relatedSpec?: string
  ftpUrl?: string
  matchSource?: 'metadata' | 'fulltext' | 'both'
}

interface EmailHit {
  id: string
  list: string
  subject: string
  from: string
  snippet: string
  date: string
  dateTs: number
  year: number
  url: string
}

type FacetDistribution = Record<string, Record<string, number>>

interface SearchResponse {
  hits: any[]
  totalHits?: number
  estimatedTotalHits?: number
  processingTimeMs: number
  query: string
  facetDistribution?: FacetDistribution
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PAGE_SIZE = 20

const STATUS_COLORS: Record<string, string> = {
  agreed:        '#d1fae5:#065f46',
  approved:      '#d1fae5:#065f46',
  noted:         '#dbeafe:#1e40af',
  revised:       '#fef3c7:#92400e',
  rejected:      '#fee2e2:#991b1b',
  withdrawn:     '#f3f4f6:#374151',
  postponed:     '#fef3c7:#92400e',
  merged:        '#ede9fe:#5b21b6',
  'not treated': '#f3f4f6:#374151',
  unknown:       '#f3f4f6:#6b7280',
}

const TDOC_SORT_OPTIONS = [
  { value: '',               label: 'Relevance' },
  { value: 'meetingId:desc', label: 'Meeting: Newest First' },
  { value: 'meetingId:asc',  label: 'Meeting: Oldest First' },
]

const EMAIL_SORT_OPTIONS = [
  { value: 'dateTs:desc', label: 'Newest First' },
  { value: 'dateTs:asc',  label: 'Oldest First' },
  { value: '',            label: 'Relevance' },
]

const LIST_LABELS: Record<string, string> = {
  '3GPP_TSG_RAN_WG1':             'RAN WG1',
  '3GPP_TSG_RAN_WG1_NR':          'RAN WG1 NR',
  '3GPP_TSG_RAN_WG1_LTE':         'RAN WG1 LTE',
  '3GPP_TSG_RAN_WG1_CHANNELMODEL':'RAN WG1 Channel Model',
  '3GPP_TSG_RAN_WG1_HSPA':        'RAN WG1 HSPA',
}

// ── Small shared components ───────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const colors = STATUS_COLORS[status] ?? STATUS_COLORS.unknown
  const [bg, text] = colors.split(':')
  return (
    <span style={{
      background: bg, color: text, padding: '1px 8px', borderRadius: 9999,
      fontSize: 11, fontWeight: 600, textTransform: 'capitalize', whiteSpace: 'nowrap',
    }}>
      {status}
    </span>
  )
}

function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px',
      borderRadius: 9999, background: '#eff6ff', color: '#1d4ed8',
      border: '1px solid #bfdbfe', fontSize: 12, fontWeight: 500,
    }}>
      {label}
      <button onClick={onRemove} style={{
        background: 'none', border: 'none', cursor: 'pointer',
        color: '#93c5fd', padding: 0, lineHeight: 1, fontSize: 15, fontWeight: 700,
      }}>×</button>
    </span>
  )
}

function FilterDropdown({
  label, options, selected, onChange,
}: {
  label: string
  options: Record<string, number>
  selected: string[]
  onChange: (v: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  const toggle = (v: string) =>
    onChange(selected.includes(v) ? selected.filter(x => x !== v) : [...selected, v])

  const count      = selected.length
  const hasOptions = Object.keys(options).length > 0

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        disabled={!hasOptions}
        style={{
          padding: '6px 12px', borderRadius: 6,
          border: `1.5px solid ${count > 0 ? '#2563eb' : '#d1d5db'}`,
          background: count > 0 ? '#eff6ff' : '#fff',
          color: count > 0 ? '#1d4ed8' : '#374151',
          fontSize: 13, cursor: hasOptions ? 'pointer' : 'default',
          fontWeight: count > 0 ? 600 : 400,
          display: 'flex', alignItems: 'center', gap: 4,
          opacity: hasOptions ? 1 : 0.5,
        }}
      >
        {label}{count > 0 ? ` (${count})` : ''} ▾
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 100,
          background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8,
          boxShadow: '0 4px 12px rgba(0,0,0,.12)', minWidth: 210, maxHeight: 320,
          overflowY: 'auto', padding: '6px 0',
        }}>
          {Object.entries(options)
            .sort(([, a], [, b]) => b - a)
            .map(([val, cnt]) => (
              <label key={val} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '5px 14px', cursor: 'pointer', fontSize: 13,
                background: selected.includes(val) ? '#eff6ff' : 'transparent',
              }}>
                <input type="checkbox" checked={selected.includes(val)}
                  onChange={() => toggle(val)}
                  style={{ margin: 0, accentColor: '#2563eb' }} />
                <span style={{ flex: 1, textTransform: 'capitalize' }}>
                  {LIST_LABELS[val] ?? val}
                </span>
                <span style={{ color: '#9ca3af', fontSize: 11 }}>{cnt.toLocaleString()}</span>
              </label>
            ))}
        </div>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function SearchPage() {
  const [tab, setTab] = useState<'tdocs' | 'emails' | 'analyst'>('tdocs')

  // Shared
  const [query, setQuery]     = useState('')
  const [offset, setOffset]   = useState(0)
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const [timing, setTiming]   = useState(0)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  // TDoc state
  const [tdocResults, setTdocResults]     = useState<TDoc[]>([])
  const [tdocTotal, setTdocTotal]         = useState(0)
  const [tdocFacets, setTdocFacets]       = useState<FacetDistribution>({})
  const [selStatuses, setSelStatuses]     = useState<string[]>([])
  const [selMeetings, setSelMeetings]     = useState<string[]>([])
  const [selTypes, setSelTypes]           = useState<string[]>([])
  const [tdocSortBy, setTdocSortBy]       = useState('')

  // Email state
  const [emailResults, setEmailResults]   = useState<EmailHit[]>([])
  const [emailTotal, setEmailTotal]       = useState(0)
  const [emailFacets, setEmailFacets]     = useState<FacetDistribution>({})
  const [selLists, setSelLists]           = useState<string[]>([])
  const [selYears, setSelYears]           = useState<string[]>([])
  const [emailSortBy, setEmailSortBy]     = useState('dateTs:desc')

  // Analyst state
  const [analystTopic,    setAnalystTopic]    = useState('')
  const [analystResult,   setAnalystResult]   = useState<{ analysis: string; tdocCount: number; emailCount: number } | null>(null)
  const [analystLoading,  setAnalystLoading]  = useState(false)
  const [analystError,    setAnalystError]    = useState('')

  const SEARCH_URL    = process.env.NEXT_PUBLIC_SEARCH_URL ?? '/api/search'
  const IS_MEILI_DIRECT = SEARCH_URL.includes('/indexes/')

  const search = useCallback(async (
    currentTab: 'tdocs' | 'emails' | 'analyst',
    q: string, off: number,
    statuses: string[], meetings: string[], types: string[], tdocSort: string,
    lists: string[], years: string[], emailSort: string,
  ) => {
    setLoading(true)
    try {
      let res: Response
      if (IS_MEILI_DIRECT) {
        // Local dev: direct Meilisearch call (TDocs only)
        res = await fetch(SEARCH_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.NEXT_PUBLIC_MEILI_KEY ?? 'masterKey'}`,
          },
          body: JSON.stringify({ q, limit: PAGE_SIZE, offset: off,
            facets: currentTab === 'tdocs' ? ['status', 'meetingId', 'type'] : ['list', 'year'] }),
        })
      } else {
        const p = new URLSearchParams()
        p.set('q', q)
        p.set('limit', String(PAGE_SIZE))
        p.set('offset', String(off))
        if (currentTab === 'emails') {
          p.set('collection', 'emails')
          if (lists.length)  p.set('list', lists.join(','))
          if (years.length)  p.set('year', years.join(','))
          if (emailSort)     p.set('sort', emailSort)
        } else {
          if (statuses.length) p.set('status', statuses.join(','))
          if (meetings.length) p.set('meeting', meetings.join(','))
          if (types.length)    p.set('type', types.join(','))
          if (tdocSort)        p.set('sort', tdocSort)
        }
        res = await fetch(`${SEARCH_URL}?${p}`)
      }

      const data: SearchResponse = await res.json()

      if (currentTab === 'tdocs') {
        setTdocResults(data.hits ?? [])
        setTdocTotal(data.totalHits ?? data.estimatedTotalHits ?? 0)
        setTdocFacets(prev => mergeFacets(prev, data.facetDistribution))
      } else {
        setEmailResults(data.hits ?? [])
        setEmailTotal(data.totalHits ?? data.estimatedTotalHits ?? 0)
        setEmailFacets(prev => mergeFacets(prev, data.facetDistribution))
      }
      setTiming(data.processingTimeMs ?? 0)
      setSearched(true)
    } finally {
      setLoading(false)
    }
  }, [IS_MEILI_DIRECT, SEARCH_URL])

  // Single debounced effect for all search params
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => {
      setOffset(0)
      search(tab, query, 0, selStatuses, selMeetings, selTypes, tdocSortBy,
             selLists, selYears, emailSortBy)
    }, 300)
    return () => { if (debounce.current) clearTimeout(debounce.current) }
  }, [tab, query, selStatuses, selMeetings, selTypes, tdocSortBy,
      selLists, selYears, emailSortBy, search])

  const goPage = (newOffset: number) => {
    setOffset(newOffset)
    search(tab, query, newOffset, selStatuses, selMeetings, selTypes, tdocSortBy,
           selLists, selYears, emailSortBy)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const switchTab = (t: 'tdocs' | 'emails' | 'analyst') => {
    setTab(t)
    setSearched(false)
    setOffset(0)
  }

  const runAnalysis = async () => {
    if (!analystTopic.trim() || analystLoading) return
    setAnalystLoading(true)
    setAnalystError('')
    setAnalystResult(null)
    try {
      const p = new URLSearchParams({ q: analystTopic.trim() })
      const res = await fetch(`/api/analyze?${p}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      setAnalystResult(data)
    } catch (e: any) {
      setAnalystError(e.message)
    } finally {
      setAnalystLoading(false)
    }
  }

  const total    = tab === 'tdocs' ? tdocTotal    : emailTotal
  const page     = Math.floor(offset / PAGE_SIZE) + 1
  const lastPage = Math.ceil(total / PAGE_SIZE)

  const tdocActiveCount  = selStatuses.length + selMeetings.length + selTypes.length
  const emailActiveCount = selLists.length + selYears.length

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 900, margin: '0 auto', padding: '2rem 1rem' }}>

      {/* Header */}
      <div style={{ marginBottom: '1.25rem' }}>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: '#111' }}>3GPP Standards Search</h1>
        <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: 14 }}>
          Search TDocs and email reflector archives from 3GPP
        </p>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, marginBottom: '1rem', borderBottom: '2px solid #e5e7eb' }}>
        {([['tdocs', 'TDocs'], ['emails', 'Email Reflector'], ['analyst', '✦ AI Analyst']] as const).map(([t, label]) => (
          <button key={t} onClick={() => switchTab(t)} style={{
            padding: '8px 20px', border: 'none', background: 'none', cursor: 'pointer',
            fontSize: 14, fontWeight: tab === t ? 600 : 400,
            color: tab === t ? '#7c3aed' : '#6b7280',
            borderBottom: `2px solid ${tab === t ? '#7c3aed' : 'transparent'}`,
            marginBottom: -2,
          }}>
            {label}
          </button>
        ))}
      </div>

      {/* Analyst panel */}
      {tab === 'analyst' && (
        <div style={{ marginBottom: '1.5rem' }}>
          <p style={{ margin: '0 0 0.75rem', fontSize: 14, color: '#6b7280' }}>
            Ask a question about 3GPP standardization activity. The analyst will search TDocs and email archives, then synthesize an answer using AI.
          </p>
          <div style={{ display: 'flex', gap: 8, marginBottom: '0.75rem' }}>
            <input
              autoFocus
              type="text"
              placeholder="e.g. What are the trends in uplink MIMO? Which companies are leading on NR-U?"
              value={analystTopic}
              onChange={e => setAnalystTopic(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && runAnalysis()}
              style={{
                flex: 1, padding: '10px 14px', fontSize: 15,
                border: '1.5px solid #d1d5db', borderRadius: 8, outline: 'none',
                boxShadow: '0 1px 3px rgba(0,0,0,.07)',
              }}
            />
            <button
              onClick={runAnalysis}
              disabled={analystLoading || !analystTopic.trim()}
              style={{
                padding: '10px 20px', borderRadius: 8, border: 'none',
                background: analystLoading || !analystTopic.trim() ? '#e5e7eb' : '#7c3aed',
                color: analystLoading || !analystTopic.trim() ? '#9ca3af' : '#fff',
                fontSize: 14, fontWeight: 600, cursor: analystLoading || !analystTopic.trim() ? 'not-allowed' : 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {analystLoading ? 'Analyzing…' : 'Analyze'}
            </button>
          </div>

          {analystLoading && (
            <div style={{ padding: '2rem', textAlign: 'center', color: '#7c3aed', fontSize: 14 }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>⏳</div>
              Searching documents and generating analysis…
            </div>
          )}

          {analystError && (
            <div style={{ padding: '1rem', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#dc2626', fontSize: 14 }}>
              Error: {analystError}
            </div>
          )}

          {analystResult && (
            <div style={{ border: '1px solid #ede9fe', borderRadius: 8, background: '#fff', overflow: 'hidden' }}>
              <div style={{ padding: '10px 16px', background: '#f5f3ff', borderBottom: '1px solid #ede9fe', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#7c3aed' }}>AI Analysis</span>
                <span style={{ fontSize: 12, color: '#8b5cf6' }}>
                  Based on {analystResult.tdocCount} TDocs + {analystResult.emailCount} emails
                </span>
              </div>
              <div style={{ padding: '16px 20px' }}>
                <SimpleMarkdown text={analystResult.analysis} />
              </div>
              <div style={{ padding: '8px 16px', borderTop: '1px solid #ede9fe', background: '#fafaf9', fontSize: 11, color: '#9ca3af' }}>
                Generated by Claude · Results based on indexed content only · Verify claims against source documents
              </div>
            </div>
          )}
        </div>
      )}

      {/* Search + filters + results (hidden on analyst tab) */}
      {tab !== 'analyst' && <>
      <div style={{ position: 'relative', marginBottom: '0.75rem' }}>
        <input
          autoFocus
          type="search"
          placeholder={tab === 'tdocs'
            ? 'Search by TDoc ID, title, source, spec…'
            : 'Search email subjects, senders, content…'}
          value={query}
          onChange={e => setQuery(e.target.value)}
          style={{
            width: '100%', boxSizing: 'border-box', padding: '10px 40px 10px 14px',
            fontSize: 16, border: '1.5px solid #d1d5db', borderRadius: 8, outline: 'none',
            boxShadow: '0 1px 3px rgba(0,0,0,.07)',
          }}
        />
        {loading && (
          <span style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 18 }}>
            ⏳
          </span>
        )}
      </div>

      {/* Filters + Sort */}
      {tab === 'tdocs' ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: '0.75rem' }}>
          <FilterDropdown label="Status"  options={tdocFacets.status   ?? {}} selected={selStatuses} onChange={setSelStatuses} />
          <FilterDropdown label="Meeting" options={tdocFacets.meetingId ?? {}} selected={selMeetings} onChange={setSelMeetings} />
          <FilterDropdown label="Type"    options={tdocFacets.type      ?? {}} selected={selTypes}    onChange={setSelTypes}    />
          <div style={{ flex: 1 }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 13, color: '#6b7280' }}>Sort:</span>
            <select value={tdocSortBy} onChange={e => setTdocSortBy(e.target.value)}
              style={{ padding: '6px 10px', borderRadius: 6, border: '1.5px solid #d1d5db', fontSize: 13, background: '#fff', color: '#374151' }}>
              {TDOC_SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: '0.75rem' }}>
          <FilterDropdown label="List" options={emailFacets.list ?? {}} selected={selLists} onChange={setSelLists} />
          <FilterDropdown label="Year" options={emailFacets.year ?? {}} selected={selYears} onChange={setSelYears} />
          <div style={{ flex: 1 }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 13, color: '#6b7280' }}>Sort:</span>
            <select value={emailSortBy} onChange={e => setEmailSortBy(e.target.value)}
              style={{ padding: '6px 10px', borderRadius: 6, border: '1.5px solid #d1d5db', fontSize: 13, background: '#fff', color: '#374151' }}>
              {EMAIL_SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        </div>
      )}

      {/* Active filter chips */}
      {tab === 'tdocs' && tdocActiveCount > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: '0.75rem', alignItems: 'center' }}>
          {selStatuses.map(s => <Chip key={`s:${s}`} label={`Status: ${s}`} onRemove={() => setSelStatuses(v => v.filter(x => x !== s))} />)}
          {selMeetings.map(m => <Chip key={`m:${m}`} label={`Meeting: ${m}`} onRemove={() => setSelMeetings(v => v.filter(x => x !== m))} />)}
          {selTypes.map(t   => <Chip key={`t:${t}`} label={`Type: ${t}`}    onRemove={() => setSelTypes(v => v.filter(x => x !== t))} />)}
          {tdocActiveCount > 1 && (
            <button onClick={() => { setSelStatuses([]); setSelMeetings([]); setSelTypes([]) }}
              style={{ padding: '2px 10px', borderRadius: 9999, border: '1px solid #fca5a5', background: '#fff', color: '#dc2626', fontSize: 12, cursor: 'pointer' }}>
              Clear all
            </button>
          )}
        </div>
      )}
      {tab === 'emails' && emailActiveCount > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: '0.75rem', alignItems: 'center' }}>
          {selLists.map(l => <Chip key={`l:${l}`} label={LIST_LABELS[l] ?? l} onRemove={() => setSelLists(v => v.filter(x => x !== l))} />)}
          {selYears.map(y => <Chip key={`y:${y}`} label={`Year: ${y}`}        onRemove={() => setSelYears(v => v.filter(x => x !== y))} />)}
          {emailActiveCount > 1 && (
            <button onClick={() => { setSelLists([]); setSelYears([]) }}
              style={{ padding: '2px 10px', borderRadius: 9999, border: '1px solid #fca5a5', background: '#fff', color: '#dc2626', fontSize: 12, cursor: 'pointer' }}>
              Clear all
            </button>
          )}
        </div>
      )}

      {/* Stats */}
      {searched && !loading && (
        <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 1rem' }}>
          {total.toLocaleString()} result{total !== 1 ? 's' : ''} in {timing}ms
          {(tab === 'tdocs' ? tdocActiveCount : emailActiveCount) > 0 && (
            <span style={{ marginLeft: 8, color: '#2563eb' }}>
              · {tab === 'tdocs' ? tdocActiveCount : emailActiveCount} filter{(tab === 'tdocs' ? tdocActiveCount : emailActiveCount) !== 1 ? 's' : ''} active
            </span>
          )}
        </p>
      )}

      {/* TDoc results */}
      {tab === 'tdocs' && tdocResults.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {tdocResults.map(doc => (
            <div key={doc.id} style={{
              border: '1px solid #e5e7eb', borderRadius: 8, padding: '12px 16px',
              background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,.04)',
            }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 700, fontSize: 14, color: '#111', fontFamily: 'monospace' }}>{doc.id}</span>
                  <span style={{ fontSize: 12, color: '#6b7280', background: '#f3f4f6', padding: '1px 6px', borderRadius: 4 }}>{doc.meetingId}</span>
                  <StatusBadge status={doc.status} />
                  {(doc.matchSource === 'fulltext' || doc.matchSource === 'both') && (
                    <span style={{ background: '#eff6ff', color: '#1d4ed8', padding: '1px 8px', borderRadius: 9999, fontSize: 11, fontWeight: 600 }}>
                      full text
                    </span>
                  )}
                </div>
                {doc.ftpUrl && (
                  <a href={doc.ftpUrl} target="_blank" rel="noreferrer"
                    style={{ fontSize: 12, color: '#2563eb', whiteSpace: 'nowrap' }}>
                    ↗ FTP
                  </a>
                )}
              </div>
              <p style={{ margin: '6px 0 4px', fontSize: 14, color: '#374151', lineHeight: 1.4 }}>{doc.title}</p>
              <div style={{ display: 'flex', gap: 12, fontSize: 12, color: '#6b7280', flexWrap: 'wrap' }}>
                {doc.source && <span>📤 {doc.source}</span>}
                {doc.type   && <span>🏷 {doc.type}</span>}
                {doc.relatedSpec && <span>📋 Spec {doc.relatedSpec}</span>}
                {doc.agenda && <span>📌 AI {doc.agenda}</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Email results */}
      {tab === 'emails' && emailResults.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {emailResults.map(email => (
            <div key={email.id} style={{
              border: '1px solid #e5e7eb', borderRadius: 8, padding: '12px 16px',
              background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,.04)',
            }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{
                    fontSize: 11, fontWeight: 600, padding: '1px 7px', borderRadius: 9999,
                    background: '#f0fdf4', color: '#166534', border: '1px solid #bbf7d0',
                    whiteSpace: 'nowrap',
                  }}>
                    {LIST_LABELS[email.list] ?? email.list}
                  </span>
                  <span style={{ fontSize: 12, color: '#6b7280' }}>{email.date}</span>
                </div>
                <a href={email.url} target="_blank" rel="noreferrer"
                  style={{ fontSize: 12, color: '#2563eb', whiteSpace: 'nowrap' }}>
                  ↗ Archive
                </a>
              </div>
              <p style={{ margin: '6px 0 3px', fontSize: 14, fontWeight: 600, color: '#111', lineHeight: 1.4 }}>
                {email.subject}
              </p>
              <p style={{ margin: '0 0 4px', fontSize: 13, color: '#6b7280' }}>
                From: {email.from}
              </p>
              {email.snippet && (
                <p style={{
                  margin: 0, fontSize: 13, color: '#374151', lineHeight: 1.5,
                  display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }}>
                  {email.snippet}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* No results */}
      {searched && !loading && total === 0 && (
        <div style={{ textAlign: 'center', padding: '3rem 0', color: '#6b7280' }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>🔍</div>
          <p>No {tab === 'tdocs' ? 'TDocs' : 'emails'} found{query ? ` for "${query}"` : ''}.</p>
          {tab === 'emails' && !searched && (
            <p style={{ fontSize: 13 }}>The email reflector index may still be building.</p>
          )}
        </div>
      )}

      {/* Empty state */}
      {!searched && !loading && (
        <div style={{ textAlign: 'center', padding: '3rem 0', color: '#9ca3af' }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>{tab === 'tdocs' ? '📡' : '📬'}</div>
          <p>Start typing to search {tab === 'tdocs' ? 'indexed TDocs' : 'the email reflector'}.</p>
        </div>
      )}
      </>} {/* end tab !== 'analyst' */}

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, marginTop: '1.5rem' }}>
          <button onClick={() => goPage(offset - PAGE_SIZE)} disabled={offset === 0}
            style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #d1d5db', cursor: offset === 0 ? 'not-allowed' : 'pointer', opacity: offset === 0 ? 0.4 : 1 }}>
            ← Prev
          </button>
          <span style={{ fontSize: 14, color: '#6b7280' }}>Page {page} of {lastPage}</span>
          <button onClick={() => goPage(offset + PAGE_SIZE)} disabled={page >= lastPage}
            style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #d1d5db', cursor: page >= lastPage ? 'not-allowed' : 'pointer', opacity: page >= lastPage ? 0.4 : 1 }}>
            Next →
          </button>
        </div>
      )}
    </div>
  )
}

function mergeFacets(prev: FacetDistribution, incoming?: FacetDistribution): FacetDistribution {
  if (!incoming) return prev
  const merged: FacetDistribution = { ...prev }
  for (const [dim, vals] of Object.entries(incoming)) {
    merged[dim] = { ...(prev[dim] ?? {}), ...vals }
  }
  return merged
}
