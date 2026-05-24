'use client'

import { useState } from 'react'

interface JobStatus {
  status: 'pending' | 'running' | 'complete' | 'error'
  step?: string
  error?: string
  familyTreeUrl?: string
}

export default function FamilyTreePage() {
  const [appNumber, setAppNumber] = useState('')
  const [jobId, setJobId]         = useState<string | null>(null)
  const [status, setStatus]       = useState<JobStatus | null>(null)
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState<string | null>(null)
  const [pollTimer, setPollTimer] = useState<ReturnType<typeof setInterval> | null>(null)

  async function startJob() {
    const clean = appNumber.trim()
    if (!clean) return
    setError(null)
    setStatus(null)
    setJobId(null)
    setLoading(true)

    try {
      const res  = await fetch('/api/patent', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ patentNumber: clean, items: ['familyTree'] }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      setJobId(data.jobId)
      startPolling(data.jobId)
    } catch (err: any) {
      setError(err.message)
      setLoading(false)
    }
  }

  function startPolling(id: string) {
    const timer = setInterval(async () => {
      try {
        const res  = await fetch(`/api/patent/${id}`)
        const data: JobStatus = await res.json()
        setStatus(data)
        if (data.status === 'complete' || data.status === 'error') {
          clearInterval(timer)
          setPollTimer(null)
          setLoading(false)
        }
      } catch {
        // ignore transient poll errors
      }
    }, 3000)
    setPollTimer(timer)
  }

  function reset() {
    if (pollTimer) clearInterval(pollTimer)
    setAppNumber('')
    setJobId(null)
    setStatus(null)
    setLoading(false)
    setError(null)
  }

  const isPending = loading && status?.status !== 'complete' && status?.status !== 'error'

  return (
    <main style={{
      minHeight: '100vh',
      background: '#f8f9fa',
      fontFamily: "'Segoe UI', system-ui, sans-serif",
      padding: '2rem',
    }}>
      <div style={{ maxWidth: 960, margin: '0 auto' }}>
        <div style={{ marginBottom: '1.5rem' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#1a1a2e', margin: 0 }}>
            Family Tree — Test Page
          </h1>
          <p style={{ color: '#777', marginTop: '0.3rem', fontSize: '0.9rem' }}>
            Enter a US patent or application number to generate and preview the continuity family tree SVG.
          </p>
        </div>

        {/* Input */}
        <div style={{
          background: '#fff', borderRadius: 10, padding: '1.25rem 1.5rem',
          boxShadow: '0 2px 8px rgba(0,0,0,0.08)', marginBottom: '1.5rem',
        }}>
          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <input
              type="text"
              value={appNumber}
              onChange={e => setAppNumber(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !loading && startJob()}
              placeholder="e.g. 11,234,567 or 17/123456"
              disabled={loading}
              style={{
                flex: 1, padding: '0.6rem 0.9rem', borderRadius: 8,
                border: '1px solid #ccc', fontSize: '1rem', outline: 'none',
                background: loading ? '#f5f5f5' : '#fff',
              }}
            />
            <button
              onClick={loading ? reset : startJob}
              disabled={!loading && !appNumber.trim()}
              style={{
                padding: '0.6rem 1.25rem', borderRadius: 8, border: 'none',
                background: loading ? '#e74c3c' : '#2c3e50',
                color: '#fff', fontWeight: 600, fontSize: '0.95rem',
                cursor: (!loading && !appNumber.trim()) ? 'not-allowed' : 'pointer',
                opacity: (!loading && !appNumber.trim()) ? 0.5 : 1,
              }}
            >
              {loading ? 'Cancel' : 'Generate'}
            </button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div style={{
            background: '#ffeaea', border: '1px solid #f5c6c6',
            borderRadius: 8, padding: '1rem', color: '#c0392b', marginBottom: '1rem',
          }}>
            {error}
          </div>
        )}

        {/* Progress */}
        {isPending && (
          <div style={{
            background: '#fff', borderRadius: 10, padding: '1.25rem 1.5rem',
            boxShadow: '0 2px 8px rgba(0,0,0,0.08)', marginBottom: '1.5rem',
            display: 'flex', alignItems: 'center', gap: '0.75rem',
          }}>
            <Spinner />
            <div>
              <div style={{ fontWeight: 600, color: '#2c3e50' }}>
                {status?.step ?? 'Starting…'}
              </div>
              {jobId && (
                <div style={{ fontSize: '0.78rem', color: '#aaa', marginTop: 2 }}>
                  Job {jobId.slice(0, 8)}…
                </div>
              )}
            </div>
          </div>
        )}

        {/* Worker error */}
        {status?.status === 'error' && (
          <div style={{
            background: '#ffeaea', border: '1px solid #f5c6c6',
            borderRadius: 8, padding: '1rem', color: '#c0392b', marginBottom: '1rem',
          }}>
            <strong>Generation failed:</strong> {status.error}
            <div style={{ marginTop: '0.75rem' }}>
              <button onClick={reset} style={{
                padding: '0.4rem 0.9rem', borderRadius: 6,
                border: '1px solid #c0392b', background: 'transparent',
                color: '#c0392b', cursor: 'pointer',
              }}>
                Try again
              </button>
            </div>
          </div>
        )}

        {/* SVG preview — use <img> to avoid cross-origin fetch restrictions on the presigned URL */}
        {status?.status === 'complete' && status.familyTreeUrl && (
          <div style={{
            background: '#fff', borderRadius: 10,
            boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
          }}>
            <div style={{
              padding: '0.75rem 1.5rem', borderBottom: '1px solid #eee',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <span style={{ fontWeight: 600, color: '#27ae60' }}>✓ Family Tree Ready</span>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <a
                  href={status.familyTreeUrl}
                  download="family-tree.svg"
                  style={{
                    padding: '0.4rem 0.9rem', background: '#2980b9',
                    color: '#fff', borderRadius: 6, textDecoration: 'none',
                    fontWeight: 600, fontSize: '0.85rem',
                  }}
                >
                  Download SVG
                </a>
                <button
                  onClick={reset}
                  style={{
                    padding: '0.4rem 0.9rem', background: 'transparent',
                    border: '1px solid #ccc', borderRadius: 6,
                    cursor: 'pointer', color: '#555', fontSize: '0.85rem',
                  }}
                >
                  New Search
                </button>
              </div>
            </div>
            <div style={{ padding: '1rem', overflowX: 'auto' }}>
              <img
                src={status.familyTreeUrl}
                alt="Patent family tree"
                style={{ display: 'block', maxWidth: 'none', height: 'auto' }}
              />
            </div>
          </div>
        )}
      </div>
    </main>
  )
}

function Spinner() {
  return (
    <div style={{
      width: 20, height: 20, flexShrink: 0,
      border: '3px solid #e0e0e0',
      borderTop: '3px solid #2c3e50',
      borderRadius: '50%',
      animation: 'spin 0.8s linear infinite',
    }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
