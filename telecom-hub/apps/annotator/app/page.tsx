'use client'

import { useState, useEffect, useRef, useCallback } from 'react'

const PALETTE = [
  '#e74c3c', // red
  '#e67e22', // orange
  '#f1c40f', // yellow
  '#2ecc71', // green
  '#3498db', // blue
  '#9b59b6', // purple
  '#1abc9c', // teal
  '#e91e63', // pink
  '#ff5722', // deep orange
  '#795548', // brown
]

const MAX_UNDO = 20

function hexToRgba(hex: string, alpha: number): [number, number, number, number] {
  const h = hex.replace('#', '')
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
    Math.round(alpha * 255),
  ]
}

function colorDistance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2)
}

function floodFill(
  ctx: CanvasRenderingContext2D,
  startX: number,
  startY: number,
  fillColor: [number, number, number, number],
  tolerance: number,
) {
  const { width, height } = ctx.canvas
  const imageData = ctx.getImageData(0, 0, width, height)
  const data = imageData.data

  const idx = (x: number, y: number) => (y * width + x) * 4
  const si = idx(startX, startY)
  const tr = data[si], tg = data[si + 1], tb = data[si + 2]

  // Don't fill if clicking the exact fill color (already filled)
  if (
    Math.abs(tr - fillColor[0]) < 2 &&
    Math.abs(tg - fillColor[1]) < 2 &&
    Math.abs(tb - fillColor[2]) < 2
  ) return

  const visited = new Uint8Array(width * height)
  const queue: number[] = [startX + startY * width]
  visited[startX + startY * width] = 1

  const [fr, fg, fb, fa] = fillColor
  const alphaRatio = fa / 255

  while (queue.length > 0) {
    const pos = queue.pop()!
    const x = pos % width
    const y = (pos - x) / width
    const i = pos * 4

    const r = data[i], g = data[i + 1], b = data[i + 2]
    if (colorDistance(r, g, b, tr, tg, tb) > tolerance) continue

    // Alpha-blend the fill color onto the existing pixel
    data[i]     = Math.round(fr * alphaRatio + r * (1 - alphaRatio))
    data[i + 1] = Math.round(fg * alphaRatio + g * (1 - alphaRatio))
    data[i + 2] = Math.round(fb * alphaRatio + b * (1 - alphaRatio))
    data[i + 3] = 255

    const neighbors = [
      x > 0         && pos - 1,
      x < width - 1 && pos + 1,
      y > 0         && pos - width,
      y < height - 1 && pos + width,
    ]
    for (const n of neighbors) {
      if (n !== false && !visited[n]) {
        visited[n] = 1
        queue.push(n)
      }
    }
  }

  ctx.putImageData(imageData, 0, 0)
}

export default function AnnotatorPage() {
  const canvasRef      = useRef<HTMLCanvasElement>(null)
  const fileInputRef   = useRef<HTMLInputElement>(null)
  const [hasImage, setHasImage]     = useState(false)
  const [color, setColor]           = useState(PALETTE[2])
  const [opacity, setOpacity]       = useState(0.5)
  const [tolerance, setTolerance]   = useState(32)
  const [undoStack, setUndoStack]   = useState<ImageData[]>([])
  const [dragging, setDragging]     = useState(false)

  // Load image onto canvas, fitting within canvas display size
  const loadImageFile = useCallback((file: File) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const canvas = canvasRef.current
      if (!canvas) return
      canvas.width  = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0)
      URL.revokeObjectURL(url)
      setHasImage(true)
      setUndoStack([])
    }
    img.src = url
  }, [])

  const loadImageData = useCallback((dataUrl: string) => {
    const img = new Image()
    img.onload = () => {
      const canvas = canvasRef.current
      if (!canvas) return
      canvas.width  = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0)
      setHasImage(true)
      setUndoStack([])
    }
    img.src = dataUrl
  }, [])

  // Clipboard paste
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return
      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (file) { loadImageFile(file); break }
        }
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [loadImageFile])

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) loadImageFile(file)
    e.target.value = ''
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    setDragging(true)
  }

  function handleDragLeave() { setDragging(false) }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (file && file.type.startsWith('image/')) loadImageFile(file)
  }

  function saveUndo() {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const snap = ctx.getImageData(0, 0, canvas.width, canvas.height)
    setUndoStack(prev => [...prev.slice(-MAX_UNDO + 1), snap])
  }

  function undo() {
    if (undoStack.length === 0) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const snap = undoStack[undoStack.length - 1]
    ctx.putImageData(snap, 0, 0)
    setUndoStack(prev => prev.slice(0, -1))
  }

  function handleCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!hasImage) return
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width  / rect.width
    const scaleY = canvas.height / rect.height
    const x = Math.floor((e.clientX - rect.left) * scaleX)
    const y = Math.floor((e.clientY - rect.top)  * scaleY)
    const ctx = canvas.getContext('2d')!

    saveUndo()
    floodFill(ctx, x, y, hexToRgba(color, opacity), tolerance)
  }

  // Keyboard undo
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault()
        undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undoStack])

  function exportPng() {
    const canvas = canvasRef.current
    if (!canvas) return
    const a = document.createElement('a')
    a.href = canvas.toDataURL('image/png')
    a.download = 'annotated-figure.png'
    a.click()
  }

  function exportSvg() {
    const canvas = canvasRef.current
    if (!canvas) return
    const dataUrl = canvas.toDataURL('image/png')
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}">
  <image href="${dataUrl}" width="${canvas.width}" height="${canvas.height}"/>
</svg>`
    const blob = new Blob([svg], { type: 'image/svg+xml' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'annotated-figure.svg'
    a.click()
  }

  async function exportPptx() {
    const canvas = canvasRef.current
    if (!canvas) return
    const dataUrl = canvas.toDataURL('image/png')
    // Remove data URL prefix for pptxgenjs
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '')

    // pptxgenjs ships as a CommonJS module; use require for reliable construction
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const PptxGenJS = require('pptxgenjs') as typeof import('pptxgenjs')
    const prs = new (PptxGenJS as any)()
    prs.layout = 'LAYOUT_WIDE'

    const slideW = 13.33
    const slideH = 7.5
    const imgRatio = canvas.width / canvas.height
    const slideRatio = slideW / slideH

    let w: number, h: number
    if (imgRatio > slideRatio) {
      w = slideW
      h = slideW / imgRatio
    } else {
      h = slideH
      w = slideH * imgRatio
    }
    const x = (slideW - w) / 2
    const y = (slideH - h) / 2

    const slide = prs.addSlide()
    slide.addImage({ data: `image/png;base64,${base64}`, x, y, w, h })
    await prs.writeFile({ fileName: 'annotated-figure.pptx' })
  }

  const canExport = hasImage

  return (
    <main style={{
      minHeight: '100vh',
      background: '#f0f2f5',
      fontFamily: "'Segoe UI', system-ui, sans-serif",
      display: 'flex',
      flexDirection: 'column',
    }}>
      {/* Top bar */}
      <div style={{
        background: '#1a1a2e',
        color: '#fff',
        padding: '0.75rem 1.5rem',
        display: 'flex',
        alignItems: 'center',
        gap: '1rem',
        flexWrap: 'wrap',
      }}>
        <span style={{ fontWeight: 700, fontSize: '1.05rem', marginRight: '0.5rem' }}>
          Figure Annotator
        </span>

        {/* Upload button */}
        <button
          onClick={() => fileInputRef.current?.click()}
          style={btnStyle('#2c3e50')}
        >
          Upload Image
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />

        <span style={{ color: '#888', fontSize: '0.8rem' }}>or paste / drag&amp;drop</span>

        <div style={{ flex: 1 }} />

        {/* Undo */}
        <button
          onClick={undo}
          disabled={undoStack.length === 0}
          style={btnStyle('#34495e', undoStack.length === 0)}
          title="Ctrl+Z"
        >
          Undo
        </button>

        {/* Export buttons */}
        <button onClick={exportPng}  disabled={!canExport} style={btnStyle('#27ae60', !canExport)}>PNG</button>
        <button onClick={exportSvg}  disabled={!canExport} style={btnStyle('#27ae60', !canExport)}>SVG</button>
        <button onClick={exportPptx} disabled={!canExport} style={btnStyle('#27ae60', !canExport)}>PPTX</button>
      </div>

      {/* Tool panel + canvas row */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* Left panel */}
        <div style={{
          width: 200,
          background: '#fff',
          borderRight: '1px solid #e0e0e0',
          padding: '1rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '1.25rem',
          overflowY: 'auto',
          flexShrink: 0,
        }}>

          {/* Color palette */}
          <div>
            <div style={labelStyle}>Color</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
              {PALETTE.map(c => (
                <div
                  key={c}
                  onClick={() => setColor(c)}
                  style={{
                    width: 28, height: 28, borderRadius: '50%',
                    background: c,
                    cursor: 'pointer',
                    border: color === c ? '3px solid #1a1a2e' : '2px solid transparent',
                    boxSizing: 'border-box',
                  }}
                />
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ fontSize: '0.78rem', color: '#555' }}>Custom:</label>
              <input
                type="color"
                value={color}
                onChange={e => setColor(e.target.value)}
                style={{ width: 36, height: 28, border: 'none', padding: 0, cursor: 'pointer', borderRadius: 4 }}
              />
            </div>
          </div>

          {/* Opacity */}
          <div>
            <div style={labelStyle}>Opacity: {Math.round(opacity * 100)}%</div>
            <input
              type="range" min={5} max={100} step={5}
              value={Math.round(opacity * 100)}
              onChange={e => setOpacity(Number(e.target.value) / 100)}
              style={{ width: '100%' }}
            />
          </div>

          {/* Tolerance */}
          <div>
            <div style={labelStyle}>Tolerance: {tolerance}</div>
            <input
              type="range" min={0} max={128} step={4}
              value={tolerance}
              onChange={e => setTolerance(Number(e.target.value))}
              style={{ width: '100%' }}
            />
            <div style={{ fontSize: '0.72rem', color: '#aaa', marginTop: 4 }}>
              Higher = fill wider color range
            </div>
          </div>

          {/* Color preview */}
          <div>
            <div style={labelStyle}>Preview</div>
            <div style={{
              width: '100%', height: 40, borderRadius: 6,
              background: color,
              opacity,
              border: '1px solid #ddd',
            }} />
          </div>
        </div>

        {/* Canvas area */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'auto',
            padding: '1rem',
            background: dragging ? '#e8f4fd' : '#f0f2f5',
            border: dragging ? '2px dashed #3498db' : '2px dashed transparent',
            transition: 'background 0.15s',
            cursor: hasImage ? 'crosshair' : 'default',
            boxSizing: 'border-box',
          }}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {!hasImage && (
            <div style={{
              textAlign: 'center', color: '#aaa', pointerEvents: 'none', userSelect: 'none',
            }}>
              <div style={{ fontSize: '3rem', marginBottom: '0.5rem' }}>🖼</div>
              <div style={{ fontSize: '1rem', fontWeight: 600 }}>Drop an image here</div>
              <div style={{ fontSize: '0.85rem', marginTop: '0.25rem' }}>
                or click <strong>Upload Image</strong>, or paste from clipboard
              </div>
            </div>
          )}
          <canvas
            ref={canvasRef}
            onClick={handleCanvasClick}
            style={{
              display: hasImage ? 'block' : 'none',
              maxWidth: '100%',
              maxHeight: '100%',
              boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
              cursor: 'crosshair',
            }}
          />
        </div>
      </div>
    </main>
  )
}

const labelStyle: React.CSSProperties = {
  fontSize: '0.8rem',
  fontWeight: 600,
  color: '#333',
  marginBottom: 6,
}

function btnStyle(bg: string, disabled = false): React.CSSProperties {
  return {
    padding: '0.4rem 0.9rem',
    borderRadius: 6,
    border: 'none',
    background: disabled ? '#555' : bg,
    color: '#fff',
    fontWeight: 600,
    fontSize: '0.85rem',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    transition: 'opacity 0.15s',
  }
}
