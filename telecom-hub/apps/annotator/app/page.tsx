'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Label { id: string; name: string; color: string; opacity: number }
interface Region {
  id: string; labelId: string; pixels: Uint32Array
  seedX: number; seedY: number; seedTolerance: number
}
interface AnnotatedImage {
  id: string; name: string; baseImage: ImageData
  regions: Region[]; undoStack: Region[][]
}
interface ProjectMeta { id: string; name: string; updatedAt: number }
interface SerializedRegion { id: string; labelId: string; seedX: number; seedY: number; seedTolerance: number }
interface SerializedImage { id: string; name: string; dataUrl: string; regions: SerializedRegion[] }
interface SerializedProject {
  id: string; name: string; updatedAt: number
  labels: Label[]; activeLabelId: string; tolerance: number; activeImageId: string | null
  images: SerializedImage[]
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_UNDO = 20
const LABEL_COLORS = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#e91e63']
const PROJECTS_KEY = 'annotator_projects'
const PROJECT_KEY = (id: string) => `annotator_project_${id}`

// ── Pure helpers ──────────────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)]
}
function colorDist(r1:number,g1:number,b1:number,r2:number,g2:number,b2:number) {
  return Math.sqrt((r1-r2)**2+(g1-g2)**2+(b1-b2)**2)
}
function safeName(s: string) { return s.replace(/[^a-z0-9 ._\-]/gi,'_').trim()||'image' }
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((res,rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('toBlob failed')), 'image/png'))
}
function canvasToSvg(canvas: HTMLCanvasElement) {
  const d = canvas.toDataURL('image/png')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}">\n  <image href="${d}" width="${canvas.width}" height="${canvas.height}"/>\n</svg>`
}
function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })
}

// ── Flood fill ────────────────────────────────────────────────────────────────

function floodFillPixels(
  data: Uint8ClampedArray, width: number, height: number,
  sx: number, sy: number, tolerance: number,
): Uint32Array {
  const si = (sy*width+sx)*4
  const tr=data[si],tg=data[si+1],tb=data[si+2]
  const visited = new Uint8Array(width*height)
  const queue = [sy*width+sx]
  visited[sy*width+sx] = 1
  const result: number[] = []
  while (queue.length) {
    const pos = queue.pop()!
    const x = pos%width, y = (pos-x)/width, i = pos*4
    if (colorDist(data[i],data[i+1],data[i+2],tr,tg,tb) > tolerance) continue
    result.push(pos)
    if (x>0 && !visited[pos-1])             { visited[pos-1]=1;     queue.push(pos-1) }
    if (x<width-1 && !visited[pos+1])       { visited[pos+1]=1;     queue.push(pos+1) }
    if (y>0 && !visited[pos-width])         { visited[pos-width]=1; queue.push(pos-width) }
    if (y<height-1 && !visited[pos+width])  { visited[pos+width]=1; queue.push(pos+width) }
  }
  return new Uint32Array(result)
}

// ── Compositing ───────────────────────────────────────────────────────────────

function applyRegions(base: ImageData, regions: Region[], labelMap: Map<string,Label>): ImageData {
  const out = new ImageData(new Uint8ClampedArray(base.data), base.width, base.height)
  const d = out.data
  for (const region of regions) {
    const label = labelMap.get(region.labelId)
    if (!label) continue
    const [fr,fg,fb] = hexToRgb(label.color), a = label.opacity
    for (const px of region.pixels) {
      const i = px*4
      d[i]  = Math.round(fr*a+d[i]*(1-a)); d[i+1]=Math.round(fg*a+d[i+1]*(1-a))
      d[i+2]= Math.round(fb*a+d[i+2]*(1-a)); d[i+3]=255
    }
  }
  return out
}

function renderImageToCanvas(img: AnnotatedImage, labelMap: Map<string,Label>): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = img.baseImage.width; c.height = img.baseImage.height
  c.getContext('2d')!.putImageData(applyRegions(img.baseImage, img.regions, labelMap), 0, 0)
  return c
}

// ── Label factory ─────────────────────────────────────────────────────────────

function mkLabel(name:string, color:string): Label {
  return { id: crypto.randomUUID(), name, color, opacity: 0.5 }
}
const INITIAL_LABELS: Label[] = LABEL_COLORS.slice(0,3).map((c,i) => mkLabel(`Label ${i+1}`, c))

// ── Project persistence helpers ───────────────────────────────────────────────

function imageDataToDataUrl(imageData: ImageData): string {
  const c = document.createElement('canvas')
  c.width = imageData.width; c.height = imageData.height
  c.getContext('2d')!.putImageData(imageData, 0, 0)
  return c.toDataURL('image/png')
}

function dataUrlToImageData(dataUrl: string): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = img.naturalWidth; c.height = img.naturalHeight
      const ctx = c.getContext('2d')!
      ctx.fillStyle = '#fff'; ctx.fillRect(0,0,c.width,c.height)
      ctx.drawImage(img, 0, 0)
      resolve(ctx.getImageData(0,0,c.width,c.height))
    }
    img.onerror = () => reject(new Error('Image load failed'))
    img.src = dataUrl
  })
}

function serializeProject(
  id: string, name: string,
  images: AnnotatedImage[], labels: Label[],
  activeLabelId: string, tolerance: number, activeImageId: string | null,
): SerializedProject {
  return {
    id, name, updatedAt: Date.now(),
    labels, activeLabelId, tolerance, activeImageId,
    images: images.map(img => ({
      id: img.id, name: img.name,
      dataUrl: imageDataToDataUrl(img.baseImage),
      regions: img.regions.map(r => ({
        id: r.id, labelId: r.labelId,
        seedX: r.seedX, seedY: r.seedY, seedTolerance: r.seedTolerance,
      })),
    })),
  }
}

function persistProject(serialized: SerializedProject): ProjectMeta[] {
  localStorage.setItem(PROJECT_KEY(serialized.id), JSON.stringify(serialized))
  const index: ProjectMeta[] = JSON.parse(localStorage.getItem(PROJECTS_KEY) ?? '[]')
  const i = index.findIndex(p => p.id === serialized.id)
  const meta: ProjectMeta = { id: serialized.id, name: serialized.name, updatedAt: serialized.updatedAt }
  if (i >= 0) index[i] = meta; else index.push(meta)
  index.sort((a, b) => b.updatedAt - a.updatedAt)
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(index))
  return index
}

async function loadProjectData(id: string): Promise<{
  images: AnnotatedImage[]; labels: Label[]; name: string
  activeLabelId: string; tolerance: number; activeImageId: string | null
} | null> {
  const raw = localStorage.getItem(PROJECT_KEY(id))
  if (!raw) return null
  const data: SerializedProject = JSON.parse(raw)
  const images: AnnotatedImage[] = []
  for (const si of data.images) {
    try {
      const baseImage = await dataUrlToImageData(si.dataUrl)
      const regions: Region[] = si.regions.map(sr => ({
        id: sr.id, labelId: sr.labelId,
        pixels: floodFillPixels(baseImage.data, baseImage.width, baseImage.height, sr.seedX, sr.seedY, sr.seedTolerance),
        seedX: sr.seedX, seedY: sr.seedY, seedTolerance: sr.seedTolerance,
      }))
      images.push({ id: si.id, name: si.name, baseImage, regions, undoStack: [] })
    } catch(e) { /* skip corrupted image */ }
  }
  return {
    images, labels: data.labels, name: data.name,
    activeLabelId: data.activeLabelId, tolerance: data.tolerance,
    activeImageId: data.activeImageId,
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function AnnotatorPage() {
  const canvasRef     = useRef<HTMLCanvasElement>(null)
  const fileInputRef  = useRef<HTMLInputElement>(null)
  const pixelOwnerRef = useRef<Int32Array|null>(null)
  const activeIdRef   = useRef<string|null>(null)
  const stateRef      = useRef({ images:[] as AnnotatedImage[], labels:INITIAL_LABELS, projectName:'My Project', tolerance:32, activeLabelId:INITIAL_LABELS[0].id, activeImageId:null as string|null, currentProjectId:null as string|null })

  // Project management state
  const [projectsIndex, setProjectsIndex]   = useState<ProjectMeta[]>([])
  const [currentProjectId, setCurrentProjectId] = useState<string|null>(null)
  const [saveStatus, setSaveStatus]         = useState<'saved'|'saving'|'unsaved'>('saved')
  const [showProjects, setShowProjects]     = useState(false)
  const [loading, setLoading]               = useState(true)

  // Per-project state
  const [projectName, setProjectName]       = useState('My Project')
  const [editingProject, setEditingProject] = useState(false)
  const [images, setImages]                 = useState<AnnotatedImage[]>([])
  const [activeImageId, setActiveImageId]   = useState<string|null>(null)
  const [labels, setLabels]                 = useState<Label[]>(INITIAL_LABELS)
  const [activeLabelId, setActiveLabelId]   = useState(INITIAL_LABELS[0].id)
  const [tolerance, setTolerance]           = useState(32)
  const [dragging, setDragging]             = useState(false)
  const [showDownload, setShowDownload]     = useState(false)

  // Sync refs on every render
  useEffect(() => { activeIdRef.current = activeImageId }, [activeImageId])
  useEffect(() => {
    stateRef.current = { images, labels, projectName, tolerance, activeLabelId, activeImageId, currentProjectId }
  })

  // ── Initialization: load most recent project or create new ─────────────────
  useEffect(() => {
    async function init() {
      try {
        const index: ProjectMeta[] = JSON.parse(localStorage.getItem(PROJECTS_KEY) ?? '[]')
        if (index.length > 0) {
          setProjectsIndex(index)
          const data = await loadProjectData(index[0].id)
          if (data) {
            setCurrentProjectId(index[0].id)
            setProjectName(data.name)
            setImages(data.images)
            setLabels(data.labels)
            setActiveLabelId(data.activeLabelId || data.labels[0]?.id || '')
            setTolerance(data.tolerance)
            setActiveImageId(data.activeImageId)
            setLoading(false)
            return
          }
        }
      } catch(e) {}
      setCurrentProjectId(crypto.randomUUID())
      setLoading(false)
    }
    init()
  }, [])

  // ── Auto-save (debounced 800ms) ────────────────────────────────────────────
  useEffect(() => {
    if (!currentProjectId) return
    setSaveStatus('unsaved')
    const timer = setTimeout(() => {
      setSaveStatus('saving')
      try {
        const s = stateRef.current
        const serialized = serializeProject(s.currentProjectId!, s.projectName, s.images, s.labels, s.activeLabelId, s.tolerance, s.activeImageId)
        setProjectsIndex(persistProject(serialized))
        setSaveStatus('saved')
      } catch(e) {
        setSaveStatus('saved')
      }
    }, 800)
    return () => clearTimeout(timer)
  }, [images, labels, projectName, tolerance, activeLabelId, activeImageId, currentProjectId])

  // ── Canvas: re-render + rebuild pixel-owner map ────────────────────────────
  const labelMap   = useMemo(() => new Map(labels.map(l=>[l.id,l])), [labels])
  const activeImage = useMemo(() => images.find(i=>i.id===activeImageId)??null, [images, activeImageId])
  const canUndo    = (activeImage?.undoStack.length??0) > 0

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !activeImage) return
    canvas.width  = activeImage.baseImage.width
    canvas.height = activeImage.baseImage.height
    canvas.getContext('2d')!.putImageData(
      applyRegions(activeImage.baseImage, activeImage.regions, labelMap), 0, 0
    )
    const map = new Int32Array(canvas.width*canvas.height).fill(-1)
    activeImage.regions.forEach((r,i) => { for (const px of r.pixels) map[px]=i })
    pixelOwnerRef.current = map
  }, [activeImage, labelMap])

  // ── Load image from File ───────────────────────────────────────────────────
  function imageFromFile(file: File): Promise<AnnotatedImage> {
    return new Promise(resolve => {
      const url = URL.createObjectURL(file)
      const el = new Image()
      el.onload = () => {
        const c = document.createElement('canvas')
        c.width = el.naturalWidth; c.height = el.naturalHeight
        const ctx = c.getContext('2d')!
        ctx.fillStyle = '#fff'; ctx.fillRect(0,0,c.width,c.height); ctx.drawImage(el,0,0)
        URL.revokeObjectURL(url)
        resolve({
          id: crypto.randomUUID(),
          name: file.name.replace(/\.[^.]+$/,'') || 'Image',
          baseImage: ctx.getImageData(0,0,c.width,c.height),
          regions: [], undoStack: [],
        })
      }
      el.src = url
    })
  }

  const addFiles = useCallback(async (files: FileList|File[]) => {
    const toAdd: AnnotatedImage[] = []
    for (const f of Array.from(files)) {
      if (f.type.startsWith('image/')) toAdd.push(await imageFromFile(f))
    }
    if (!toAdd.length) return
    setImages(prev => [...prev, ...toAdd])
    setActiveImageId(toAdd[toAdd.length-1].id)
  }, [])

  // Clipboard paste
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files: File[] = []
      for (const item of Array.from(e.clipboardData?.items??[])) {
        if (item.type.startsWith('image/')) { const f=item.getAsFile(); if (f) files.push(f) }
      }
      if (files.length) addFiles(files)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [addFiles])

  function handleDragOver(e: React.DragEvent) { e.preventDefault(); setDragging(true) }
  function handleDragLeave() { setDragging(false) }
  function handleDrop(e: React.DragEvent) {
    e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files)
  }

  // ── Canvas click: fill new region or reassign existing ─────────────────────
  function handleCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current
    if (!canvas || !activeImage) return
    const rect = canvas.getBoundingClientRect()
    const x = Math.max(0,Math.min(canvas.width-1, Math.floor((e.clientX-rect.left)*(canvas.width/rect.width))))
    const y = Math.max(0,Math.min(canvas.height-1, Math.floor((e.clientY-rect.top)*(canvas.height/rect.height))))
    const ownerIdx = pixelOwnerRef.current?.[y*canvas.width+x]??-1

    if (ownerIdx >= 0) {
      const newRegions = activeImage.regions.map((r,i)=>i===ownerIdx?{...r,labelId:activeLabelId}:r)
      pushUndo(activeImageId!, activeImage.regions)
      setImages(imgs=>imgs.map(img=>img.id===activeImageId?{...img,regions:newRegions}:img))
    } else {
      const pixels = floodFillPixels(activeImage.baseImage.data, canvas.width, canvas.height, x, y, tolerance)
      if (!pixels.length) return
      pushUndo(activeImageId!, activeImage.regions)
      setImages(imgs=>imgs.map(img=>img.id===activeImageId
        ? {...img, regions:[...img.regions,{id:crypto.randomUUID(),labelId:activeLabelId,pixels,seedX:x,seedY:y,seedTolerance:tolerance}]}
        : img
      ))
    }
  }

  // ── Undo ──────────────────────────────────────────────────────────────────
  function pushUndo(id: string, currentRegions: Region[]) {
    setImages(imgs=>imgs.map(img=>img.id===id
      ? {...img, undoStack:[...img.undoStack.slice(-MAX_UNDO+1), currentRegions]}
      : img
    ))
  }

  const undo = useCallback(() => {
    const id = activeIdRef.current
    setImages(imgs=>imgs.map(img=> {
      if (img.id!==id || !img.undoStack.length) return img
      return {...img, regions:img.undoStack[img.undoStack.length-1], undoStack:img.undoStack.slice(0,-1)}
    }))
  }, [])

  useEffect(() => {
    const h = (e:KeyboardEvent) => {
      if ((e.ctrlKey||e.metaKey)&&e.key==='z') { e.preventDefault(); undo() }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [undo])

  // ── Image management ──────────────────────────────────────────────────────
  function removeImage(id: string) {
    setImages(imgs => {
      const next = imgs.filter(i=>i.id!==id)
      if (activeImageId===id) setActiveImageId(next[0]?.id??null)
      return next
    })
  }

  function duplicateImage(id: string) {
    setImages(imgs => {
      const idx = imgs.findIndex(i=>i.id===id)
      if (idx<0) return imgs
      const src = imgs[idx]
      const copy: AnnotatedImage = {
        id: crypto.randomUUID(), name: src.name+' copy',
        baseImage: src.baseImage, regions: [...src.regions], undoStack: [],
      }
      const next = [...imgs]; next.splice(idx+1,0,copy)
      setActiveImageId(copy.id)
      return next
    })
  }

  function moveImage(id: string, dir: -1|1) {
    setImages(imgs => {
      const idx = imgs.findIndex(i=>i.id===id), ni = idx+dir
      if (ni<0||ni>=imgs.length) return imgs
      const next = [...imgs];[next[idx],next[ni]]=[next[ni],next[idx]]
      return next
    })
  }

  function renameImage(id: string, name: string) {
    setImages(imgs=>imgs.map(img=>img.id===id?{...img,name}:img))
  }

  // ── Label management ──────────────────────────────────────────────────────
  function addLabel() {
    const label = mkLabel(`Label ${labels.length+1}`, LABEL_COLORS[labels.length%LABEL_COLORS.length])
    setLabels(prev=>[...prev,label]); setActiveLabelId(label.id)
  }
  function updateLabel(id:string, patch:Partial<Label>) {
    setLabels(prev=>prev.map(l=>l.id===id?{...l,...patch}:l))
  }
  function deleteLabel(id:string) {
    if (labels.length<=1) return
    const next = labels.filter(l=>l.id!==id)
    setLabels(next)
    setImages(imgs=>imgs.map(img=>({...img,regions:img.regions.filter(r=>r.labelId!==id)})))
    if (activeLabelId===id) setActiveLabelId(next[0].id)
  }

  // ── Project management ─────────────────────────────────────────────────────
  function saveCurrentImmediate() {
    const s = stateRef.current
    if (!s.currentProjectId) return
    try {
      const serialized = serializeProject(s.currentProjectId, s.projectName, s.images, s.labels, s.activeLabelId, s.tolerance, s.activeImageId)
      setProjectsIndex(persistProject(serialized))
      setSaveStatus('saved')
    } catch(e) {}
  }

  async function handleSwitchProject(id: string) {
    saveCurrentImmediate()
    setShowProjects(false)
    setLoading(true)
    try {
      const data = await loadProjectData(id)
      if (!data) return
      setCurrentProjectId(id)
      setProjectName(data.name)
      setImages(data.images)
      setLabels(data.labels)
      setActiveLabelId(data.activeLabelId || data.labels[0]?.id || '')
      setTolerance(data.tolerance)
      setActiveImageId(data.activeImageId)
    } catch(e) {}
    setLoading(false)
  }

  function handleNewProject() {
    saveCurrentImmediate()
    setShowProjects(false)
    const newLabels = LABEL_COLORS.slice(0,3).map((c,i) => mkLabel(`Label ${i+1}`, c))
    setCurrentProjectId(crypto.randomUUID())
    setProjectName('New Project')
    setImages([])
    setActiveImageId(null)
    setLabels(newLabels)
    setActiveLabelId(newLabels[0].id)
    setTolerance(32)
    setSaveStatus('unsaved')
  }

  function handleDeleteProject(id: string, e: React.MouseEvent) {
    e.stopPropagation()
    try {
      localStorage.removeItem(PROJECT_KEY(id))
      const newIndex = projectsIndex.filter(p=>p.id!==id)
      localStorage.setItem(PROJECTS_KEY, JSON.stringify(newIndex))
      setProjectsIndex(newIndex)
      if (id === currentProjectId) {
        if (newIndex.length > 0) handleSwitchProject(newIndex[0].id)
        else handleNewProject()
      }
    } catch(e) {}
  }

  // ── Export ────────────────────────────────────────────────────────────────
  async function exportCurrentPng() {
    if (!activeImage) return
    downloadBlob(await canvasToBlob(renderImageToCanvas(activeImage, labelMap)), `${safeName(activeImage.name)}.png`)
  }

  async function exportCurrentSvg() {
    if (!activeImage) return
    const c = renderImageToCanvas(activeImage, labelMap)
    downloadBlob(new Blob([canvasToSvg(c)],{type:'image/svg+xml'}), `${safeName(activeImage.name)}.svg`)
  }

  async function exportCurrentPptx() {
    if (!activeImage) return
    const c = renderImageToCanvas(activeImage, labelMap)
    const b64 = c.toDataURL('image/png').replace(/^data:image\/png;base64,/,'')
    try {
      const prs = new ((await import('pptxgenjs')).default as any)()
      prs.layout = 'LAYOUT_WIDE'
      const SW=13.33,SH=7.5,r=c.width/c.height
      let w=SW,h=SW/r; if(h>SH){h=SH;w=SH*r}
      prs.addSlide().addImage({data:`image/png;base64,${b64}`,x:(SW-w)/2,y:(SH-h)/2,w,h})
      await prs.writeFile({fileName:`${safeName(activeImage.name)}.pptx`})
    } catch(err:any) { alert(`PPTX failed: ${err?.message??err}`) }
  }

  async function exportAllPng() {
    try {
      const JSZip = (await import('jszip')).default
      const zip = new (JSZip as any)()
      for (const img of images) zip.file(`${safeName(img.name)}.png`, await canvasToBlob(renderImageToCanvas(img, labelMap)))
      downloadBlob(await zip.generateAsync({type:'blob'}), `${safeName(projectName)}.zip`)
    } catch(err:any) { alert(`Export failed: ${err?.message??err}`) }
  }

  async function exportAllSvg() {
    try {
      const JSZip = (await import('jszip')).default
      const zip = new (JSZip as any)()
      for (const img of images) zip.file(`${safeName(img.name)}.svg`, canvasToSvg(renderImageToCanvas(img, labelMap)))
      downloadBlob(await zip.generateAsync({type:'blob'}), `${safeName(projectName)}.zip`)
    } catch(err:any) { alert(`Export failed: ${err?.message??err}`) }
  }

  async function exportAllPptx() {
    try {
      const prs = new ((await import('pptxgenjs')).default as any)()
      prs.layout = 'LAYOUT_WIDE'
      const SW=13.33, SH=7.5, TITLE=0.55
      for (const img of images) {
        const c = renderImageToCanvas(img, labelMap)
        const b64 = c.toDataURL('image/png').replace(/^data:image\/png;base64,/,'')
        const imgH = SH-TITLE-0.15, r = c.width/c.height
        let w=SW, h=SW/r; if(h>imgH){h=imgH;w=imgH*r}; if(w>SW){w=SW;h=SW/r}
        const slide = prs.addSlide()
        slide.addText(img.name, {x:0.15,y:0.1,w:SW-0.3,h:TITLE,fontSize:20,bold:true,color:'1a1a2e'})
        slide.addImage({data:`image/png;base64,${b64}`,x:(SW-w)/2,y:TITLE+0.05,w,h})
      }
      await prs.writeFile({fileName:`${safeName(projectName)}.pptx`})
    } catch(err:any) { alert(`PPTX failed: ${err?.message??err}`) }
  }

  // ── Save status display ────────────────────────────────────────────────────
  const saveIndicator = saveStatus === 'saved'
    ? { text:'✓ saved', color:'#2ecc71' }
    : saveStatus === 'saving'
    ? { text:'saving…', color:'#f39c12' }
    : { text:'● unsaved', color:'#aaa' }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <main style={{
      minHeight:'100vh', background:'#f0f2f5',
      fontFamily:"'Segoe UI',system-ui,sans-serif",
      display:'flex', flexDirection:'column',
    }}>

      {/* ── Top bar ── */}
      <div style={{
        background:'#1a1a2e', color:'#fff',
        padding:'0.55rem 1.1rem',
        display:'flex', alignItems:'center', gap:'0.7rem', flexWrap:'wrap',
        position:'relative', zIndex:10,
      }}>

        {/* Projects dropdown */}
        <div style={{position:'relative'}}>
          <button
            onClick={()=>setShowProjects(s=>!s)}
            style={topBtn('#2c3e50')}
          >
            ≡ Projects
          </button>

          {showProjects && (
            <>
              <div style={{position:'fixed',inset:0,zIndex:200}} onClick={()=>setShowProjects(false)}/>
              <div style={{
                position:'absolute', left:0, top:'calc(100% + 6px)', zIndex:201,
                background:'#fff', borderRadius:10, boxShadow:'0 8px 32px rgba(0,0,0,0.22)',
                border:'1px solid #e8e8e8', minWidth:280, overflow:'hidden',
              }}>
                <div style={{padding:'0.55rem 0.85rem 0.3rem',fontSize:'0.72rem',fontWeight:700,color:'#aaa',textTransform:'uppercase',letterSpacing:'0.05em'}}>
                  Saved Projects
                </div>
                <div style={{maxHeight:280,overflowY:'auto'}}>
                  {projectsIndex.length === 0 && (
                    <div style={{padding:'0.5rem 0.85rem',color:'#bbb',fontSize:'0.82rem'}}>No saved projects</div>
                  )}
                  {projectsIndex.map(p => {
                    const isCurrent = p.id === currentProjectId
                    return (
                      <div
                        key={p.id}
                        onClick={()=>!isCurrent&&handleSwitchProject(p.id)}
                        style={{
                          display:'flex', alignItems:'center', gap:'0.4rem',
                          padding:'0.5rem 0.85rem', cursor:isCurrent?'default':'pointer',
                          background:isCurrent?'#eef5ff':'transparent',
                          borderLeft:`3px solid ${isCurrent?'#3498db':'transparent'}`,
                        }}
                        onMouseEnter={e=>{if(!isCurrent)(e.currentTarget as HTMLDivElement).style.background='#f5f5f5'}}
                        onMouseLeave={e=>{if(!isCurrent)(e.currentTarget as HTMLDivElement).style.background='transparent'}}
                      >
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{fontSize:'0.88rem',fontWeight:isCurrent?700:400,color:'#222',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{p.name}</div>
                          <div style={{fontSize:'0.72rem',color:'#aaa',marginTop:1}}>{formatDate(p.updatedAt)}</div>
                        </div>
                        <button
                          onClick={e=>handleDeleteProject(p.id,e)}
                          title="Delete project"
                          style={{background:'none',border:'none',color:'#ccc',cursor:'pointer',fontSize:'1.1rem',padding:'0 2px',lineHeight:1,flexShrink:0}}
                          onMouseEnter={e=>(e.currentTarget.style.color='#e74c3c')}
                          onMouseLeave={e=>(e.currentTarget.style.color='#ccc')}
                        >×</button>
                      </div>
                    )
                  })}
                </div>
                <div style={{height:1,background:'#f0f0f0'}}/>
                <button
                  onClick={handleNewProject}
                  style={{display:'block',width:'100%',textAlign:'left',padding:'0.5rem 0.85rem',border:'none',background:'none',fontSize:'0.88rem',color:'#3498db',cursor:'pointer',fontWeight:600}}
                  onMouseEnter={e=>(e.currentTarget.style.background='#f0f7ff')}
                  onMouseLeave={e=>(e.currentTarget.style.background='none')}
                >
                  + New Project
                </button>
              </div>
            </>
          )}
        </div>

        <div style={{width:1,height:18,background:'rgba(255,255,255,0.2)'}}/>

        {/* Project name (editable) */}
        {editingProject ? (
          <input
            autoFocus
            value={projectName}
            onChange={e=>setProjectName(e.target.value)}
            onBlur={()=>setEditingProject(false)}
            onKeyDown={e=>e.key==='Enter'&&setEditingProject(false)}
            style={{
              background:'rgba(255,255,255,0.15)', border:'1px solid rgba(255,255,255,0.35)',
              color:'#fff', borderRadius:5, padding:'0.25rem 0.5rem',
              fontSize:'0.95rem', fontWeight:700, outline:'none', width:180,
            }}
          />
        ) : (
          <span
            onClick={()=>setEditingProject(true)}
            title="Click to rename"
            style={{fontWeight:700,fontSize:'0.95rem',cursor:'pointer',borderBottom:'1px dashed rgba(255,255,255,0.35)',paddingBottom:1}}
          >
            {projectName}
          </span>
        )}

        {/* Save status */}
        <span style={{fontSize:'0.75rem',color:saveIndicator.color,minWidth:70}}>
          {saveIndicator.text}
        </span>

        <div style={{width:1,height:18,background:'rgba(255,255,255,0.2)'}}/>

        <button onClick={()=>fileInputRef.current?.click()} style={topBtn('#2c3e50')}>Add Image</button>
        <input
          ref={fileInputRef} type="file" accept="image/*" multiple style={{display:'none'}}
          onChange={e=>{if(e.target.files?.length)addFiles(e.target.files);e.target.value=''}}
        />
        <span style={{color:'#666',fontSize:'0.78rem'}}>or paste / drag&amp;drop</span>

        <div style={{flex:1}}/>

        <button onClick={undo} disabled={!canUndo} style={topBtn('#34495e',!canUndo)} title="Ctrl+Z">Undo</button>

        {/* Download dropdown */}
        <div style={{position:'relative'}}>
          <button
            onClick={()=>setShowDownload(s=>!s)}
            disabled={images.length===0}
            style={topBtn('#27ae60', images.length===0)}
          >
            Download ▾
          </button>

          {showDownload && (
            <>
              <div style={{position:'fixed',inset:0,zIndex:200}} onClick={()=>setShowDownload(false)}/>
              <div style={{
                position:'absolute', right:0, top:'calc(100% + 6px)', zIndex:201,
                background:'#fff', borderRadius:10, boxShadow:'0 8px 32px rgba(0,0,0,0.18)',
                border:'1px solid #e8e8e8', minWidth:200, overflow:'hidden',
              }}>
                <div style={menuSection}>Current image</div>
                {(['PNG','SVG','PPTX'] as const).map(fmt => (
                  <button key={fmt} disabled={!activeImage} style={menuItem(!activeImage)} onClick={()=>{
                    setShowDownload(false)
                    if(fmt==='PNG') exportCurrentPng()
                    if(fmt==='SVG') exportCurrentSvg()
                    if(fmt==='PPTX') exportCurrentPptx()
                  }}>{fmt}</button>
                ))}
                <div style={{height:1,background:'#f0f0f0',margin:'0.25rem 0'}}/>
                <div style={menuSection}>All images ({images.length})</div>
                {[['PNG','zip'],['SVG','zip'],['PPTX','deck']].map(([fmt,suf]) => (
                  <button key={fmt} disabled={images.length===0} style={menuItem(images.length===0)} onClick={()=>{
                    setShowDownload(false)
                    if(fmt==='PNG') exportAllPng()
                    if(fmt==='SVG') exportAllSvg()
                    if(fmt==='PPTX') exportAllPptx()
                  }}>{fmt} <span style={{color:'#aaa',fontSize:'0.78rem'}}>({suf})</span></button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Body ── */}
      <div style={{display:'flex',flex:1,overflow:'hidden',position:'relative'}}>

        {/* Loading overlay */}
        {loading && (
          <div style={{
            position:'absolute',inset:0,background:'rgba(240,242,245,0.85)',
            display:'flex',alignItems:'center',justifyContent:'center',zIndex:50,
          }}>
            <div style={{color:'#555',fontSize:'1rem',fontWeight:600}}>Loading project…</div>
          </div>
        )}

        {/* ── Left panel ── */}
        <div style={{
          width:264, background:'#fff', borderRight:'1px solid #e0e0e0',
          display:'flex', flexDirection:'column', overflow:'hidden', flexShrink:0,
        }}>

          {/* Images section */}
          <div style={{
            display:'flex', flexDirection:'column',
            borderBottom:'1px solid #eee',
            maxHeight:'44%', minHeight:100, overflow:'hidden', flexShrink:0,
          }}>
            <div style={{padding:'0.65rem 0.85rem 0.4rem',display:'flex',alignItems:'center',justifyContent:'space-between',flexShrink:0}}>
              <span style={sectionHeader}>Images</span>
            </div>
            <div style={{overflowY:'auto',flex:1,padding:'0 0.5rem 0.5rem'}}>
              {images.length===0 && (
                <div style={{color:'#c0c0c0',fontSize:'0.8rem',padding:'0.3rem 0.4rem'}}>
                  Add images to begin.
                </div>
              )}
              {images.map((img,idx) => {
                const active = img.id===activeImageId
                return (
                  <div
                    key={img.id}
                    onClick={()=>setActiveImageId(img.id)}
                    style={{
                      display:'flex', alignItems:'center', gap:'0.3rem',
                      padding:'0.4rem 0.5rem', marginBottom:'0.25rem', borderRadius:7,
                      cursor:'pointer',
                      background:active?'#eef5ff':'#fafafa',
                      border:`1.5px solid ${active?'#3498db':'#eee'}`,
                    }}
                  >
                    <span style={{
                      width:20, height:20, borderRadius:4, background:'#e8e8e8', flexShrink:0,
                      display:'flex', alignItems:'center', justifyContent:'center',
                      fontSize:'0.68rem', color:'#888', fontWeight:600,
                    }}>{idx+1}</span>
                    <input
                      type="text"
                      value={img.name}
                      onChange={e=>renameImage(img.id,e.target.value)}
                      onClick={e=>e.stopPropagation()}
                      style={{
                        flex:1, border:'none', background:'transparent', minWidth:0,
                        fontSize:'0.82rem', fontWeight:active?600:400, color:'#222', outline:'none',
                      }}
                    />
                    <div style={{display:'flex',gap:1,flexShrink:0}} onClick={e=>e.stopPropagation()}>
                      <button onClick={()=>moveImage(img.id,-1)} disabled={idx===0} style={iconBtn(idx===0)} title="Move up">↑</button>
                      <button onClick={()=>moveImage(img.id,1)} disabled={idx===images.length-1} style={iconBtn(idx===images.length-1)} title="Move down">↓</button>
                      <button onClick={()=>duplicateImage(img.id)} style={iconBtn(false)} title="Duplicate">⧉</button>
                      <button onClick={()=>removeImage(img.id)} style={{...iconBtn(false),color:'#e74c3c'}} title="Remove">×</button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Labels section */}
          <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden'}}>
            <div style={{padding:'0.65rem 0.85rem 0.4rem',display:'flex',alignItems:'center',justifyContent:'space-between',flexShrink:0}}>
              <span style={sectionHeader}>Labels</span>
              <button onClick={addLabel} style={{
                fontSize:'0.75rem', padding:'0.2rem 0.55rem', borderRadius:4,
                border:'1px solid #ccc', background:'#f5f5f5', cursor:'pointer', color:'#333',
              }}>+ Add</button>
            </div>
            <div style={{flex:1,overflowY:'auto',padding:'0 0.5rem'}}>
              {labels.map(label => {
                const active = label.id===activeLabelId
                return (
                  <div key={label.id} onClick={()=>setActiveLabelId(label.id)} style={{
                    borderRadius:8, padding:'0.55rem 0.65rem', marginBottom:'0.35rem',
                    cursor:'pointer',
                    background:active?'#eef5ff':'#fafafa',
                    border:`1.5px solid ${active?'#3498db':'#eee'}`,
                    transition:'border-color 0.1s, background 0.1s',
                  }}>
                    <div style={{display:'flex',alignItems:'center',gap:'0.4rem'}}>
                      <label style={{position:'relative',flexShrink:0,cursor:'pointer'}} onClick={e=>e.stopPropagation()}>
                        <div style={{width:22,height:22,borderRadius:'50%',background:label.color,border:'2px solid rgba(0,0,0,0.18)'}}/>
                        <input type="color" value={label.color} onChange={e=>updateLabel(label.id,{color:e.target.value})}
                          style={{position:'absolute',inset:0,opacity:0,cursor:'pointer',width:'100%',height:'100%',padding:0,border:'none'}}/>
                      </label>
                      <input type="text" value={label.name} onChange={e=>updateLabel(label.id,{name:e.target.value})}
                        onClick={e=>e.stopPropagation()}
                        style={{flex:1,border:'none',background:'transparent',fontSize:'0.85rem',fontWeight:active?600:400,color:'#222',outline:'none',minWidth:0}}/>
                      <button onClick={e=>{e.stopPropagation();deleteLabel(label.id)}} disabled={labels.length<=1}
                        style={{background:'none',border:'none',color:'#ccc',cursor:labels.length<=1?'default':'pointer',
                          fontSize:'1.1rem',lineHeight:1,padding:'0 1px',opacity:labels.length<=1?0.3:1,flexShrink:0}}>×</button>
                    </div>
                    <div style={{marginTop:'0.4rem'}} onClick={e=>e.stopPropagation()}>
                      <div style={{display:'flex',justifyContent:'space-between',marginBottom:2}}>
                        <span style={{fontSize:'0.68rem',color:'#999'}}>Opacity</span>
                        <span style={{fontSize:'0.68rem',color:'#999'}}>{Math.round(label.opacity*100)}%</span>
                      </div>
                      <input type="range" min={5} max={100} step={5} value={Math.round(label.opacity*100)}
                        onChange={e=>updateLabel(label.id,{opacity:Number(e.target.value)/100})}
                        style={{width:'100%',accentColor:label.color}}/>
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Tolerance */}
            <div style={{padding:'0.65rem 0.85rem',borderTop:'1px solid #eee',flexShrink:0}}>
              <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}>
                <span style={{fontSize:'0.78rem',fontWeight:600,color:'#555'}}>Tolerance</span>
                <span style={{fontSize:'0.78rem',color:'#999'}}>{tolerance}</span>
              </div>
              <input type="range" min={0} max={128} step={4} value={tolerance}
                onChange={e=>setTolerance(Number(e.target.value))} style={{width:'100%'}}/>
              <div style={{fontSize:'0.68rem',color:'#bbb',marginTop:2}}>Higher = fill wider color range</div>
            </div>
          </div>
        </div>

        {/* ── Canvas area ── */}
        <div
          style={{
            flex:1, display:'flex', alignItems:'center', justifyContent:'center',
            overflow:'auto', padding:'1rem', boxSizing:'border-box',
            background:dragging?'#e8f4fd':'#f0f2f5',
            outline:dragging?'3px dashed #3498db':'3px dashed transparent',
            transition:'background 0.15s, outline 0.15s',
          }}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {!activeImage && !loading && (
            <div style={{textAlign:'center',color:'#c0c0c0',pointerEvents:'none',userSelect:'none'}}>
              <div style={{fontSize:'3rem',marginBottom:'0.5rem'}}>🖼</div>
              <div style={{fontSize:'1rem',fontWeight:600}}>Add images to get started</div>
              <div style={{fontSize:'0.85rem',marginTop:'0.3rem'}}>
                Click <strong style={{color:'#aaa'}}>Add Image</strong>, drop files here, or paste from clipboard
              </div>
            </div>
          )}
          <canvas
            ref={canvasRef}
            onClick={handleCanvasClick}
            style={{
              display:activeImage?'block':'none',
              maxWidth:'100%', maxHeight:'100%',
              boxShadow:'0 4px 20px rgba(0,0,0,0.18)',
              cursor:'crosshair',
            }}
          />
        </div>
      </div>
    </main>
  )
}

// ── Style helpers ─────────────────────────────────────────────────────────────

const sectionHeader: React.CSSProperties = { fontWeight: 700, fontSize: '0.85rem', color: '#333' }

function topBtn(bg: string, disabled = false): React.CSSProperties {
  return {
    padding:'0.38rem 0.85rem', borderRadius:6, border:'none',
    background:disabled?'#444':bg, color:'#fff', fontWeight:600,
    fontSize:'0.82rem', cursor:disabled?'not-allowed':'pointer',
    opacity:disabled?0.5:1, transition:'opacity 0.15s', flexShrink:0,
  }
}

function iconBtn(disabled: boolean): React.CSSProperties {
  return {
    background:'none', border:'none', padding:'1px 3px',
    fontSize:'0.85rem', cursor:disabled?'default':'pointer',
    color:disabled?'#ddd':'#888', borderRadius:3, lineHeight:1,
  }
}

const menuSection: React.CSSProperties = {
  padding:'0.4rem 0.85rem 0.2rem', fontSize:'0.72rem',
  fontWeight:700, color:'#aaa', textTransform:'uppercase', letterSpacing:'0.05em',
}

function menuItem(disabled: boolean): React.CSSProperties {
  return {
    display:'block', width:'100%', textAlign:'left',
    padding:'0.45rem 0.85rem', border:'none', background:'none',
    fontSize:'0.88rem', color:disabled?'#ccc':'#333',
    cursor:disabled?'default':'pointer',
  }
}
