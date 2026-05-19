'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

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
}

interface SearchResponse {
  hits: TDoc[]
  totalHits: number
  processingTimeMs: number
  query: string
}

const PAGE_SIZE = 20

const STATUS_COLORS: Record<string, string> = {
  agreed:       '#d1fae5:#065f46',
  approved:     '#d1fae5:#065f46',
  noted:        '#dbeafe:#1e40af',
  revised:      '#fef3c7:#92400e',
  rejected:     '#fee2e2:#991b1b',
  withdrawn:    '#f3f4f6:#374151',
  postponed:    '#fef3c7:#92400e',
  merged:       '#ede9fe:#5b21b6',
  'not treated':'#f3f4f6:#374151',
  unknown:      '#f3f4f6:#6b7280',
}

function StatusBadge({ status }: { status: string }) {
  const colors = STATUS_COLORS[status] ?? STATUS_COLORS.unknown
  const [bg, text] = colors.split(':')
  return (
    <span style={{
      background: bg, color: text,
      padding: '1px 8px', borderRadius: 9999, fontSize: 11, fontWeight: 600,
      textTransform: 'capitalize', whiteSpace: 'nowrap',
    }}>
      {status}
    </span>
  )
}

export default function SearchPage() {
  const [query, setQuery]       = useState('')
  const [results, setResults]   = useState<TDoc[]>([])
  const [total, setTotal]       = useState(0)
  const [offset, setOffset]     = useState(0)
  const [loading, setLoading]   = useState(false)
  const [searched, setSearched] = useState(false)
  const [timing, setTiming]     = useState(0)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  // In production (CloudFront) relative /api/search works.
  // For local dev, set NEXT_PUBLIC_SEARCH_URL=http://localhost:7700/indexes/tdocs/search
  const SEARCH_URL = process.env.NEXT_PUBLIC_SEARCH_URL ?? '/api/search'
  const IS_MEILI_DIRECT = SEARCH_URL.includes('/indexes/')

  const search = useCallback(async (q: string, off: number) => {
    setLoading(true)
    try {
      let res: Response
      if (IS_MEILI_DIRECT) {
        // Direct Meilisearch call (local dev)
        res = await fetch(SEARCH_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.NEXT_PUBLIC_MEILI_KEY ?? 'masterKey'}`,
          },
          body: JSON.stringify({ q, limit: PAGE_SIZE, offset: off }),
        })
      } else {
        // Lambda proxy (AWS)
        res = await fetch(`${SEARCH_URL}?q=${encodeURIComponent(q)}&limit=${PAGE_SIZE}&offset=${off}`)
      }
      const data: SearchResponse = await res.json()
      setResults(data.hits ?? [])
      setTotal(data.totalHits ?? 0)
      setTiming(data.processingTimeMs ?? 0)
      setSearched(true)
    } finally {
      setLoading(false)
    }
  }, [IS_MEILI_DIRECT, SEARCH_URL])

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => {
      setOffset(0)
      search(query, 0)
    }, 300)
  }, [query, search])

  const goPage = (newOffset: number) => {
    setOffset(newOffset)
    search(query, newOffset)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const page     = Math.floor(offset / PAGE_SIZE) + 1
  const lastPage = Math.ceil(total / PAGE_SIZE)

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 860, margin: '0 auto', padding: '2rem 1rem' }}>
      {/* Header */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: '#111' }}>3GPP Standards Search</h1>
        <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: 14 }}>
          Search TDocs indexed from the 3GPP FTP server
        </p>
      </div>

      {/* Search box */}
      <div style={{ position: 'relative', marginBottom: '1rem' }}>
        <input
          autoFocus
          type="search"
          placeholder="Search by TDoc ID, title, source, spec…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{
            width: '100%', boxSizing: 'border-box',
            padding: '10px 40px 10px 14px',
            fontSize: 16, border: '1.5px solid #d1d5db',
            borderRadius: 8, outline: 'none',
            boxShadow: '0 1px 3px rgba(0,0,0,.07)',
          }}
        />
        {loading && (
          <span style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 18 }}>
            ⏳
          </span>
        )}
      </div>

      {/* Stats */}
      {searched && !loading && (
        <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 1rem' }}>
          {total.toLocaleString()} result{total !== 1 ? 's' : ''} in {timing}ms
        </p>
      )}

      {/* Results */}
      {results.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {results.map((doc) => (
            <div key={doc.id} style={{
              border: '1px solid #e5e7eb', borderRadius: 8,
              padding: '12px 16px', background: '#fff',
              boxShadow: '0 1px 2px rgba(0,0,0,.04)',
            }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 700, fontSize: 14, color: '#111', fontFamily: 'monospace' }}>
                    {doc.id}
                  </span>
                  <span style={{ fontSize: 12, color: '#6b7280', background: '#f3f4f6', padding: '1px 6px', borderRadius: 4 }}>
                    {doc.meetingId}
                  </span>
                  <StatusBadge status={doc.status} />
                </div>
                {doc.ftpUrl && (
                  <a href={doc.ftpUrl} target="_blank" rel="noreferrer"
                    style={{ fontSize: 12, color: '#2563eb', whiteSpace: 'nowrap' }}>
                    ↗ FTP
                  </a>
                )}
              </div>
              <p style={{ margin: '6px 0 4px', fontSize: 14, color: '#374151', lineHeight: 1.4 }}>
                {doc.title}
              </p>
              <div style={{ display: 'flex', gap: 12, fontSize: 12, color: '#6b7280', flexWrap: 'wrap' }}>
                {doc.source && <span>📤 {doc.source}</span>}
                {doc.relatedSpec && <span>📋 Spec {doc.relatedSpec}</span>}
                {doc.agenda && <span>📌 AI {doc.agenda}</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* No results */}
      {searched && !loading && results.length === 0 && (
        <div style={{ textAlign: 'center', padding: '3rem 0', color: '#6b7280' }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>🔍</div>
          <p>No TDocs found{query ? ` for "${query}"` : ''}.</p>
        </div>
      )}

      {/* Empty state */}
      {!searched && !loading && (
        <div style={{ textAlign: 'center', padding: '3rem 0', color: '#9ca3af' }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>📡</div>
          <p>Start typing to search indexed TDocs.</p>
        </div>
      )}

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
