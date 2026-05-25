'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Label {
  id: string
  name: string
  color: string
  opacity: number
}

interface Region {
  id: string
  labelId: string
  pixels: Uint32Array  // flat pixel indices (y * width + x)
}

const MAX_UNDO = 20

// ── Color helpers ─────────────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

function colorDist(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number) {
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2)
}

// ── Flood fill — returns pixel indices, does NOT draw ─────────────────────────

function floodFillPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  sx: number,
  sy: number,
  tolerance: number,
): Uint32Array {
  const si = (sy * width + sx) * 4
  const tr = data[si], tg = data[si + 1], tb = data[si + 2]
  const visited = new Uint8Array(width * height)
  const queue = [sy * width + sx]
  visited[sy * width + sx] = 1
  const result: number[] = []

  while (queue.length) {
    const pos = queue.pop()!
    const x = pos % width
    const y = (pos - x) / width
    const i = pos * 4
    if (colorDist(data[i], data[i + 1], data[i + 2], tr, tg, tb) > tolerance) continue
    result.push(pos)
    if (x > 0         && !visited[pos - 1])      { visited[pos - 1] = 1;      queue.push(pos - 1) }
    if (x < width - 1 && !visited[pos + 1])      { visited[pos + 1] = 1;      queue.push(pos + 1) }
    if (y > 0         && !visited[pos - width])   { visited[pos - width] = 1;  queue.push(pos - width) }
    if (y < height - 1 && !visited[pos + width])  { visited[pos + width] = 1;  queue.push(pos + width) }
  }

  return new Uint32Array(result)
}

// ── Composite: base image + all regions ───────────────────────────────────────

function applyRegions(base: ImageData, regions: Region[], labelMap: Map<string, Label>): ImageData {
  const out = new ImageData(new Uint8ClampedArray(base.data), base.width, base.height)
  const d = out.data
  for (const region of regions) {
    const label = labelMap.get(region.labelId)
    if (!label) continue
    const [fr, fg, fb] = hexToRgb(label.color)
    const a = label.opacity
    for (const px of region.pixels) {
      const i = px * 4
      d[i]     = Math.round(fr * a + d[i]     * (1 - a))
      d[i + 1] = Math.round(fg * a + d[i + 1] * (1 - a))
      d[i + 2] = Math.round(fb * a + d[i + 2] * (1 - a))
      d[i + 3] = 255
    }
  }
  return out
}

// ── Label factory ─────────────────────────────────────────────────────────────

const LABEL_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#e91e63']

function mkLabel(name: string, color: string): Label {
  return { id: crypto.randomUUID(), name, color, opacity: 0.5 }
}

const INITIAL_LABELS: Label[] = [
  mkLabel('Label 1', LABEL_COLORS[0]),
  mkLabel('Label 2', LABEL_COLORS[1]),
  mkLabel('Label 3', LABEL_COLORS[2]),
]

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AnnotatorPage() {
  const canvasRef     = useRef<HTMLCanvasElement>(null)
  const fileInputRef  = useRef<HTMLInputElement>(null)
  const baseImageRef  = useRef<ImageData | null>(null)
  const pixelOwnerRef = useRef<Int32Array | null>(null)  // region index per pixel, -1 = none

  const [hasImage, setHasImage]           = useState(false)
  const [labels, setLabels]               = useState<Label[]>(INITIAL_LABELS)
  const [activeLabelId, setActiveLabelId] = useState(INITIAL_LABELS[0].id)
  const [regions, setRegions]             = useState<Region[]>([])
  const [tolerance, setTolerance]         = useState(32)
  const [undoStack, setUndoStack]         = useState<Region[][]>([])
  const [dragging, setDragging]           = useState(false)

  const labelMap = useMemo(() => new Map(labels.map(l => [l.id, l])), [labels])

  // Re-render canvas whenever regions or labels change
  useEffect(() => {
    const canvas = canvasRef.current
    const base   = baseImageRef.current
    if (!canvas || !base) return
    canvas.getContext('2d')!.putImageData(applyRegions(base, regions, labelMap), 0, 0)
  }, [regions, labelMap])

  // Rebuild pixel-owner map whenever regions change
  useEffect(() => {
    const canvas = canvasRef.current
    const base   = baseImageRef.current
    if (!canvas || !base) return
    const map = new Int32Array(canvas.width * canvas.height).fill(-1)
    regions.forEach((r, i) => { for (const px of r.pixels) map[px] = i })
    pixelOwnerRef.current = map
  }, [regions])

  // Image loading
  const loadImage = useCallback((img: HTMLImageElement) => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width  = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0)
    baseImageRef.current  = ctx.getImageData(0, 0, canvas.width, canvas.height)
    pixelOwnerRef.current = new Int32Array(canvas.width * canvas.height).fill(-1)
    setHasImage(true)
    setRegions([])
    setUndoStack([])
  }, [])

  const loadFile = useCallback((file: File) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => { loadImage(img); URL.revokeObjectURL(url) }
    img.src = url
  }, [loadImage])

  // Clipboard paste
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      for (const item of Array.from(e.clipboardData?.items ?? [])) {
        if (item.type.startsWith('image/')) {
          const f = item.getAsFile()
          if (f) { loadFile(f); break }
        }
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [loadFile])

  // Drag & drop
  function handleDragOver(e: React.DragEvent) { e.preventDefault(); setDragging(true) }
  function handleDragLeave() { setDragging(false) }
  function handleDrop(e: React.DragEvent) {
    e.preventDefault(); setDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (file?.type.startsWith('image/')) loadFile(file)
  }

  // Canvas click: reassign existing region or flood-fill new one
  function handleCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current
    const base   = baseImageRef.current
    if (!canvas || !base || !hasImage) return

    const rect = canvas.getBoundingClientRect()
    const x  = Math.max(0, Math.min(canvas.width  - 1, Math.floor((e.clientX - rect.left) * (canvas.width  / rect.width))))
    const y  = Math.max(0, Math.min(canvas.height - 1, Math.floor((e.clientY - rect.top)  * (canvas.height / rect.height))))
    const px = y * canvas.width + x

    const ownerIdx = pixelOwnerRef.current?.[px] ?? -1

    if (ownerIdx >= 0) {
      // Pixel belongs to an existing region — reassign it to the active label
      saveUndo(regions)
      setRegions(rs => rs.map((r, i) => i === ownerIdx ? { ...r, labelId: activeLabelId } : r))
    } else {
      // Empty pixel — flood fill and create a new region
      const pixels = floodFillPixels(base.data, canvas.width, canvas.height, x, y, tolerance)
      if (!pixels.length) return
      saveUndo(regions)
      setRegions(rs => [...rs, { id: crypto.randomUUID(), labelId: activeLabelId, pixels }])
    }
  }

  // Undo
  function saveUndo(rs: Region[]) {
    setUndoStack(prev => [...prev.slice(-MAX_UNDO + 1), rs])
  }

  function undo() {
    if (!undoStack.length) return
    setRegions(undoStack[undoStack.length - 1])
    setUndoStack(prev => prev.slice(0, -1))
  }

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo() }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [undoStack])

  // Label CRUD
  function addLabel() {
    const label = mkLabel(`Label ${labels.length + 1}`, LABEL_COLORS[labels.length % LABEL_COLORS.length])
    setLabels(prev => [...prev, label])
    setActiveLabelId(label.id)
  }

  function updateLabel(id: string, patch: Partial<Label>) {
    setLabels(prev => prev.map(l => l.id === id ? { ...l, ...patch } : l))
  }

  function deleteLabel(id: string) {
    if (labels.length <= 1) return
    const next = labels.filter(l => l.id !== id)
    setLabels(next)
    setRegions(rs => rs.filter(r => r.labelId !== id))
    if (activeLabelId === id) setActiveLabelId(next[0].id)
  }

  // Export helpers
  function canvasDataUrl() { return canvasRef.current!.toDataURL('image/png') }

  function exportPng() {
    const a = document.createElement('a')
    a.href = canvasDataUrl(); a.download = 'annotated-figure.png'; a.click()
  }

  function exportSvg() {
    const canvas  = canvasRef.current!
    const dataUrl = canvasDataUrl()
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}">\n  <image href="${dataUrl}" width="${canvas.width}" height="${canvas.height}"/>\n</svg>`
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
    a.download = 'annotated-figure.svg'; a.click()
  }

  async function exportPptx() {
    const canvas = canvasRef.current!
    const b64    = canvasDataUrl().replace(/^data:image\/png;base64,/, '')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const prs    = new (require('pptxgenjs') as any)()
    prs.layout   = 'LAYOUT_WIDE'
    const SW = 13.33, SH = 7.5, r = canvas.width / canvas.height
    let w = SW, h = SW / r
    if (h > SH) { h = SH; w = SH * r }
    const slide = prs.addSlide()
    slide.addImage({ data: `image/png;base64,${b64}`, x: (SW - w) / 2, y: (SH - h) / 2, w, h })
    await prs.writeFile({ fileName: 'annotated-figure.pptx' })
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <main style={{
      minHeight: '100vh',
      background: '#f0f2f5',
      fontFamily: "'Segoe UI', system-ui, sans-serif",
      display: 'flex',
      flexDirection: 'column',
    }}>

      {/* ── Top bar ── */}
      <div style={{
        background: '#1a1a2e', color: '#fff',
        padding: '0.6rem 1.25rem',
        display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap',
      }}>
        <span style={{ fontWeight: 700, fontSize: '1rem', marginRight: 4 }}>Figure Annotator</span>
        <button onClick={() => fileInputRef.current?.click()} style={topBtn('#2c3e50')}>Upload</button>
        <input
          ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }}
          onChange={e => { const f = e.target.files?.[0]; if (f) loadFile(f); e.target.value = '' }}
        />
        <span style={{ color: '#666', fontSize: '0.8rem' }}>or paste / drag&amp;drop</span>
        <div style={{ flex: 1 }} />
        <button onClick={undo} disabled={!undoStack.length} style={topBtn('#34495e', !undoStack.length)} title="Ctrl+Z">
          Undo
        </button>
        <button onClick={exportPng}  disabled={!hasImage} style={topBtn('#27ae60', !hasImage)}>PNG</button>
        <button onClick={exportSvg}  disabled={!hasImage} style={topBtn('#27ae60', !hasImage)}>SVG</button>
        <button onClick={exportPptx} disabled={!hasImage} style={topBtn('#27ae60', !hasImage)}>PPTX</button>
      </div>

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* ── Left panel ── */}
        <div style={{
          width: 240, background: '#fff', borderRight: '1px solid #e0e0e0',
          display: 'flex', flexDirection: 'column', overflow: 'hidden', flexShrink: 0,
        }}>

          {/* Labels header */}
          <div style={{
            padding: '0.7rem 0.85rem',
            borderBottom: '1px solid #eee',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <span style={{ fontWeight: 700, fontSize: '0.85rem', color: '#333' }}>Labels</span>
            <button onClick={addLabel} style={{
              fontSize: '0.75rem', padding: '0.2rem 0.55rem', borderRadius: 4,
              border: '1px solid #ccc', background: '#f5f5f5', cursor: 'pointer', color: '#333',
            }}>
              + Add
            </button>
          </div>

          {/* Label list */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '0.5rem' }}>
            {labels.map(label => {
              const active = label.id === activeLabelId
              return (
                <div
                  key={label.id}
                  onClick={() => setActiveLabelId(label.id)}
                  style={{
                    borderRadius: 8, padding: '0.6rem 0.65rem', marginBottom: '0.4rem',
                    cursor: 'pointer',
                    background: active ? '#eef5ff' : '#fafafa',
                    border: `1.5px solid ${active ? '#3498db' : '#eee'}`,
                    transition: 'border-color 0.12s, background 0.12s',
                  }}
                >
                  {/* Color swatch + name + delete */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                    {/* Color swatch — clicking opens native color picker */}
                    <label
                      style={{ position: 'relative', flexShrink: 0, cursor: 'pointer' }}
                      onClick={e => e.stopPropagation()}
                      title="Change color"
                    >
                      <div style={{
                        width: 22, height: 22, borderRadius: '50%',
                        background: label.color,
                        border: '2px solid rgba(0,0,0,0.18)',
                      }} />
                      <input
                        type="color"
                        value={label.color}
                        onChange={e => updateLabel(label.id, { color: e.target.value })}
                        style={{
                          position: 'absolute', inset: 0,
                          opacity: 0, cursor: 'pointer', width: '100%', height: '100%',
                          padding: 0, border: 'none',
                        }}
                      />
                    </label>

                    {/* Editable name */}
                    <input
                      type="text"
                      value={label.name}
                      onChange={e => updateLabel(label.id, { name: e.target.value })}
                      onClick={e => e.stopPropagation()}
                      style={{
                        flex: 1, border: 'none', background: 'transparent',
                        fontSize: '0.85rem', fontWeight: active ? 600 : 400,
                        color: '#222', outline: 'none', minWidth: 0,
                      }}
                    />

                    {/* Delete */}
                    <button
                      onClick={e => { e.stopPropagation(); deleteLabel(label.id) }}
                      disabled={labels.length <= 1}
                      title="Remove label and its regions"
                      style={{
                        background: 'none', border: 'none', color: '#ccc',
                        cursor: labels.length <= 1 ? 'default' : 'pointer',
                        fontSize: '1.1rem', lineHeight: 1, padding: '0 1px',
                        opacity: labels.length <= 1 ? 0.3 : 1, flexShrink: 0,
                      }}
                    >
                      ×
                    </button>
                  </div>

                  {/* Opacity slider */}
                  <div style={{ marginTop: '0.45rem' }} onClick={e => e.stopPropagation()}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                      <span style={{ fontSize: '0.68rem', color: '#999' }}>Opacity</span>
                      <span style={{ fontSize: '0.68rem', color: '#999' }}>{Math.round(label.opacity * 100)}%</span>
                    </div>
                    <input
                      type="range" min={5} max={100} step={5}
                      value={Math.round(label.opacity * 100)}
                      onChange={e => updateLabel(label.id, { opacity: Number(e.target.value) / 100 })}
                      style={{ width: '100%', accentColor: label.color }}
                    />
                  </div>
                </div>
              )
            })}
          </div>

          {/* Tolerance */}
          <div style={{ padding: '0.75rem 0.85rem', borderTop: '1px solid #eee' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontSize: '0.78rem', fontWeight: 600, color: '#555' }}>Tolerance</span>
              <span style={{ fontSize: '0.78rem', color: '#999' }}>{tolerance}</span>
            </div>
            <input
              type="range" min={0} max={128} step={4}
              value={tolerance}
              onChange={e => setTolerance(Number(e.target.value))}
              style={{ width: '100%' }}
            />
            <div style={{ fontSize: '0.68rem', color: '#bbb', marginTop: 2 }}>Higher = fill wider color range</div>
          </div>
        </div>

        {/* ── Canvas area ── */}
        <div
          style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            overflow: 'auto', padding: '1rem', boxSizing: 'border-box',
            background: dragging ? '#e8f4fd' : '#f0f2f5',
            outline: dragging ? '3px dashed #3498db' : '3px dashed transparent',
            transition: 'background 0.15s, outline 0.15s',
          }}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {!hasImage && (
            <div style={{ textAlign: 'center', color: '#bbb', pointerEvents: 'none', userSelect: 'none' }}>
              <div style={{ fontSize: '3rem', marginBottom: '0.5rem' }}>🖼</div>
              <div style={{ fontSize: '1rem', fontWeight: 600 }}>Drop an image here</div>
              <div style={{ fontSize: '0.85rem', marginTop: '0.3rem' }}>
                or click <strong style={{ color: '#888' }}>Upload</strong>, or paste from clipboard
              </div>
            </div>
          )}
          <canvas
            ref={canvasRef}
            onClick={handleCanvasClick}
            style={{
              display: hasImage ? 'block' : 'none',
              maxWidth: '100%', maxHeight: '100%',
              boxShadow: '0 4px 20px rgba(0,0,0,0.18)',
              cursor: 'crosshair',
            }}
          />
        </div>
      </div>
    </main>
  )
}

function topBtn(bg: string, disabled = false): React.CSSProperties {
  return {
    padding: '0.38rem 0.85rem', borderRadius: 6, border: 'none',
    background: disabled ? '#444' : bg, color: '#fff',
    fontWeight: 600, fontSize: '0.82rem',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1, transition: 'opacity 0.15s',
  }
}
