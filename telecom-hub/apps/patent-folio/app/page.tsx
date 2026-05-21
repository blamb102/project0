'use client'

import { useState } from 'react'

interface JobStatus {
  status: 'pending' | 'running' | 'complete' | 'error'
  step?: string
  error?: string
  downloadUrl?: string
  patent?: {
    number: string
    title: string
    assignee: string
    claimCount: number
    historyCount: number
    familyCount: number
  }
}

export default function PatentFolioPage() {
  const [patentNumber, setPatentNumber] = useState('')
  const [jobId, setJobId] = useState<string | null>(null)
  const [status, setStatus] = useState<JobStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pollTimer, setPollTimer] = useState<ReturnType<typeof setInterval> | null>(null)

  async function startJob() {
    const clean = patentNumber.trim()
    if (!clean) return
    setError(null)
    setStatus(null)
    setJobId(null)
    setLoading(true)

    try {
      const res = await fetch('/api/patent', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ patentNumber: clean }),
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
    setPatentNumber('')
    setJobId(null)
    setStatus(null)
    setLoading(false)
    setError(null)
  }

  const isIdle    = !loading && !status
  const isPending = loading && status?.status !== 'complete' && status?.status !== 'error'

  return (
    <main style={{
      minHeight: '100vh',
      background: '#f8f9fa',
      fontFamily: "'Segoe UI', system-ui, sans-serif",
      padding: '2rem',
    }}>
      <div style={{ maxWidth: 680, margin: '0 auto' }}>
        {/* Header */}
        <div style={{ marginBottom: '2rem' }}>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 700, color: '#1a1a2e', margin: 0 }}>
            Patent Folio Generator
          </h1>
          <p style={{ color: '#555', marginTop: '0.4rem', fontSize: '0.95rem' }}>
            Enter a US patent or application number to generate a complete folio ZIP including
            the patent PDF, claims, claim chart template, substantive file history, AI prosecution
            summary, and patent family.
          </p>
        </div>

        {/* Input card */}
        <div style={{
          background: '#fff',
          borderRadius: 12,
          padding: '1.5rem',
          boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
          marginBottom: '1.5rem',
        }}>
          <label style={{ display: 'block', fontWeight: 600, marginBottom: '0.5rem', color: '#333' }}>
            Patent or Application Number
          </label>
          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <input
              type="text"
              value={patentNumber}
              onChange={e => setPatentNumber(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !loading && startJob()}
              placeholder="e.g. 11,234,567 or 17/123456"
              disabled={loading}
              style={{
                flex: 1,
                padding: '0.6rem 0.9rem',
                borderRadius: 8,
                border: '1px solid #ccc',
                fontSize: '1rem',
                outline: 'none',
                background: loading ? '#f5f5f5' : '#fff',
              }}
            />
            <button
              onClick={loading ? reset : startJob}
              disabled={!loading && !patentNumber.trim()}
              style={{
                padding: '0.6rem 1.25rem',
                borderRadius: 8,
                border: 'none',
                background: loading ? '#e74c3c' : '#2c3e50',
                color: '#fff',
                fontWeight: 600,
                fontSize: '0.95rem',
                cursor: (!loading && !patentNumber.trim()) ? 'not-allowed' : 'pointer',
                opacity: (!loading && !patentNumber.trim()) ? 0.5 : 1,
                transition: 'background 0.2s',
              }}
            >
              {loading ? 'Cancel' : 'Generate'}
            </button>
          </div>
          <p style={{ fontSize: '0.8rem', color: '#888', marginTop: '0.4rem' }}>
            Accepts formats: 11234567, 11,234,567, US11234567B2, 17/123456, 17123456
          </p>
        </div>

        {/* Error */}
        {error && (
          <div style={{
            background: '#ffeaea',
            border: '1px solid #f5c6c6',
            borderRadius: 8,
            padding: '1rem',
            color: '#c0392b',
            marginBottom: '1rem',
          }}>
            {error}
          </div>
        )}

        {/* Progress */}
        {isPending && (
          <div style={{
            background: '#fff',
            borderRadius: 12,
            padding: '1.5rem',
            boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
            marginBottom: '1.5rem',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
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
            <ProgressSteps currentStep={status?.step} />
          </div>
        )}

        {/* Complete */}
        {status?.status === 'complete' && (
          <div style={{
            background: '#fff',
            borderRadius: 12,
            padding: '1.5rem',
            boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
              <span style={{ fontSize: '1.3rem' }}>✓</span>
              <span style={{ fontWeight: 700, fontSize: '1.1rem', color: '#27ae60' }}>
                Folio Ready
              </span>
            </div>

            {status.patent && (
              <div style={{ marginBottom: '1.25rem' }}>
                <div style={{ fontWeight: 600, color: '#1a1a2e', fontSize: '1rem' }}>
                  {status.patent.title || status.patent.number}
                </div>
                {status.patent.assignee && (
                  <div style={{ color: '#555', fontSize: '0.9rem' }}>{status.patent.assignee}</div>
                )}
                <div style={{ display: 'flex', gap: '1.5rem', marginTop: '0.5rem', fontSize: '0.85rem', color: '#888' }}>
                  <span>{status.patent.claimCount} claims</span>
                  <span>{status.patent.historyCount} prosecution docs</span>
                  <span>{status.patent.familyCount} family members</span>
                </div>
              </div>
            )}

            <div style={{ marginBottom: '1rem', fontSize: '0.85rem', color: '#555' }}>
              <strong>ZIP contains:</strong> patent.docx · claims.docx · claim-chart.docx ·
              file-history-summary.docx · patent-family.docx · patent PDF · substantive file history PDFs
            </div>

            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <a
                href={status.downloadUrl}
                download
                style={{
                  padding: '0.65rem 1.5rem',
                  background: '#2980b9',
                  color: '#fff',
                  borderRadius: 8,
                  textDecoration: 'none',
                  fontWeight: 600,
                  fontSize: '0.95rem',
                }}
              >
                Download ZIP
              </a>
              <button
                onClick={reset}
                style={{
                  padding: '0.65rem 1rem',
                  background: 'transparent',
                  border: '1px solid #ccc',
                  borderRadius: 8,
                  cursor: 'pointer',
                  color: '#555',
                  fontSize: '0.95rem',
                }}
              >
                New Search
              </button>
            </div>
          </div>
        )}

        {/* Worker error */}
        {status?.status === 'error' && (
          <div style={{
            background: '#ffeaea',
            border: '1px solid #f5c6c6',
            borderRadius: 8,
            padding: '1rem',
            color: '#c0392b',
          }}>
            <strong>Generation failed:</strong> {status.error}
            <div style={{ marginTop: '0.75rem' }}>
              <button onClick={reset} style={{
                padding: '0.4rem 0.9rem', borderRadius: 6, border: '1px solid #c0392b',
                background: 'transparent', color: '#c0392b', cursor: 'pointer',
              }}>
                Try again
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  )
}

const STEPS = [
  'Fetching patent data',
  'Fetching file history',
  'Generating documents',
  'Building ZIP',
  'Uploading ZIP',
]

function ProgressSteps({ currentStep }: { currentStep?: string }) {
  const current = STEPS.findIndex(s => currentStep?.startsWith(s))
  return (
    <div style={{ marginTop: '1rem' }}>
      {STEPS.map((step, i) => {
        const done   = current > i
        const active = current === i
        return (
          <div key={step} style={{
            display: 'flex', alignItems: 'center', gap: '0.5rem',
            padding: '0.25rem 0', fontSize: '0.85rem',
            color: done ? '#27ae60' : active ? '#2c3e50' : '#bbb',
          }}>
            <span style={{ width: 16, textAlign: 'center' }}>
              {done ? '✓' : active ? '›' : '○'}
            </span>
            {step}
          </div>
        )
      })}
    </div>
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
