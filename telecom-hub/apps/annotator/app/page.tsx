'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Label { id: string; name: string; color: string; opacity: number }
interface Region {
  id: string; labelId: string; pixels: Uint32Array
  seedX: number; seedY: number; seedTolerance: number
}
interface Snapshot { regions: Region[]; penPixels: number[] }
interface AnnotatedImage {
  id: string; name: string; baseImage?: ImageData
  regions: Region[]; penPixels: number[]; undoStack: Snapshot[]
}
interface ProjectMeta { id: string; name: string; updatedAt: number }
interface SerializedRegion { id: string; labelId: string; seedX: number; seedY: number; seedTolerance: number }
interface SerializedImage { id: string; name: string; dataUrl: string; regions: SerializedRegion[]; penPixels: number[] }
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
  const h = hex.replace('#','')
  return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)]
}
function colorDist(r1:number,g1:number,b1:number,r2:number,g2:number,b2:number) {
  return Math.sqrt((r1-r2)**2+(g1-g2)**2+(b1-b2)**2)
}
function safeName(s: string) { return s.replace(/[^a-z0-9 ._\-]/gi,'_').trim()||'image' }
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href=url; a.download=filename; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((res,rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('toBlob')), 'image/png'))
}
function canvasToSvg(canvas: HTMLCanvasElement) {
  const d = canvas.toDataURL('image/png')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}">\n  <image href="${d}" width="${canvas.width}" height="${canvas.height}"/>\n</svg>`
}
function formatDate(ts: number) {
  return new Date(ts).toLocaleDateString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})
}
function getCanvasPos(canvas: HTMLCanvasElement, clientX: number, clientY: number) {
  const r = canvas.getBoundingClientRect()
  return {
    x: Math.max(0, Math.min(canvas.width-1,  Math.floor((clientX-r.left)*(canvas.width/r.width)))),
    y: Math.max(0, Math.min(canvas.height-1, Math.floor((clientY-r.top )*(canvas.height/r.height)))),
  }
}

// ── Flood fill ────────────────────────────────────────────────────────────────

function floodFillPixels(data: Uint8ClampedArray, width: number, height: number,
  sx: number, sy: number, tolerance: number): Uint32Array {
  const si=(sy*width+sx)*4, tr=data[si], tg=data[si+1], tb=data[si+2]
  const visited=new Uint8Array(width*height), queue=[sy*width+sx], result:number[]=[]
  visited[sy*width+sx]=1
  while (queue.length) {
    const pos=queue.pop()!, x=pos%width, y=(pos-x)/width, i=pos*4
    if (colorDist(data[i],data[i+1],data[i+2],tr,tg,tb)>tolerance) continue
    result.push(pos)
    if (x>0         && !visited[pos-1])     { visited[pos-1]=1;     queue.push(pos-1) }
    if (x<width-1   && !visited[pos+1])     { visited[pos+1]=1;     queue.push(pos+1) }
    if (y>0         && !visited[pos-width]) { visited[pos-width]=1; queue.push(pos-width) }
    if (y<height-1  && !visited[pos+width]) { visited[pos+width]=1; queue.push(pos+width) }
  }
  return new Uint32Array(result)
}

// ── Pen drawing helpers ───────────────────────────────────────────────────────

function dotsAt(cx: number, cy: number, w: number, h: number, r: number): number[] {
  const out: number[] = []
  const ri = Math.ceil(r)
  for (let y=cy-ri; y<=cy+ri; y++) for (let x=cx-ri; x<=cx+ri; x++) {
    if (x>=0 && x<w && y>=0 && y<h && (x-cx)**2+(y-cy)**2 <= r*r+0.5)
      out.push(y*w+x)
  }
  return out
}

function bresenhamLine(x0:number,y0:number,x1:number,y1:number,w:number,h:number,r:number): number[] {
  const out: number[] = []
  let dx=Math.abs(x1-x0), sx=x0<x1?1:-1
  let dy=-Math.abs(y1-y0), sy=y0<y1?1:-1
  let err=dx+dy, cx=x0, cy=y0
  for(;;) {
    out.push(...dotsAt(cx,cy,w,h,r))
    if (cx===x1&&cy===y1) break
    const e2=2*err
    if (e2>=dy) { err+=dy; cx+=sx }
    if (e2<=dx) { err+=dx; cy+=sy }
  }
  return out
}

// ── Compositing ───────────────────────────────────────────────────────────────

function applyCanvas(base: ImageData, regions: Region[], labelMap: Map<string,Label>, penPixels: number[]): ImageData {
  const out=new ImageData(new Uint8ClampedArray(base.data), base.width, base.height), d=out.data
  for (const region of regions) {
    const label=labelMap.get(region.labelId); if (!label) continue
    const [fr,fg,fb]=hexToRgb(label.color), a=label.opacity
    for (const px of region.pixels) {
      const i=px*4
      d[i]=Math.round(fr*a+d[i]*(1-a)); d[i+1]=Math.round(fg*a+d[i+1]*(1-a))
      d[i+2]=Math.round(fb*a+d[i+2]*(1-a)); d[i+3]=255
    }
  }
  for (const px of penPixels) { const i=px*4; d[i]=0; d[i+1]=0; d[i+2]=0; d[i+3]=255 }
  return out
}

function renderImageToCanvas(img: AnnotatedImage, labelMap: Map<string,Label>): HTMLCanvasElement {
  const c=document.createElement('canvas')
  if (!img.baseImage) return c
  c.width=img.baseImage.width; c.height=img.baseImage.height
  c.getContext('2d')!.putImageData(applyCanvas(img.baseImage,img.regions,labelMap,img.penPixels),0,0)
  return c
}

// ── Label factory ─────────────────────────────────────────────────────────────

function mkLabel(name:string,color:string): Label { return {id:crypto.randomUUID(),name,color,opacity:0.5} }
const INITIAL_LABELS: Label[] = LABEL_COLORS.slice(0,3).map((c,i)=>mkLabel(`Label ${i+1}`,c))

// ── Project persistence ────────────────────────────────────────────────────────

function imageDataToDataUrl(d: ImageData): string {
  const c=document.createElement('canvas'); c.width=d.width; c.height=d.height
  c.getContext('2d')!.putImageData(d,0,0); return c.toDataURL('image/png')
}
function dataUrlToImageData(url: string): Promise<ImageData> {
  return new Promise((res,rej)=>{
    const img=new Image()
    img.onload=()=>{
      const c=document.createElement('canvas'); c.width=img.naturalWidth; c.height=img.naturalHeight
      const ctx=c.getContext('2d')!; ctx.fillStyle='#fff'; ctx.fillRect(0,0,c.width,c.height); ctx.drawImage(img,0,0)
      res(ctx.getImageData(0,0,c.width,c.height))
    }
    img.onerror=()=>rej(new Error('load')); img.src=url
  })
}
function serializeProject(id:string,name:string,images:AnnotatedImage[],labels:Label[],activeLabelId:string,tolerance:number,activeImageId:string|null): SerializedProject {
  return {id,name,updatedAt:Date.now(),labels,activeLabelId,tolerance,activeImageId,
    images:images.filter(img=>img.baseImage).map(img=>({id:img.id,name:img.name,dataUrl:imageDataToDataUrl(img.baseImage!),penPixels:img.penPixels,
      regions:img.regions.map(r=>({id:r.id,labelId:r.labelId,seedX:r.seedX,seedY:r.seedY,seedTolerance:r.seedTolerance}))}))}
}
function persistProject(s: SerializedProject): ProjectMeta[] {
  localStorage.setItem(PROJECT_KEY(s.id),JSON.stringify(s))
  const idx: ProjectMeta[]=JSON.parse(localStorage.getItem(PROJECTS_KEY)||'[]')
  const i=idx.findIndex(p=>p.id===s.id)
  const meta={id:s.id,name:s.name,updatedAt:s.updatedAt}
  if (i>=0) idx[i]=meta; else idx.push(meta)
  idx.sort((a,b)=>b.updatedAt-a.updatedAt)
  localStorage.setItem(PROJECTS_KEY,JSON.stringify(idx)); return idx
}
async function loadProjectData(id: string) {
  const raw=localStorage.getItem(PROJECT_KEY(id)); if (!raw) return null
  const data: SerializedProject=JSON.parse(raw)
  const images: AnnotatedImage[]=[]
  for (const si of data.images) {
    try {
      const baseImage=await dataUrlToImageData(si.dataUrl)
      const regions=si.regions.map(sr=>({id:sr.id,labelId:sr.labelId,
        pixels:floodFillPixels(baseImage.data,baseImage.width,baseImage.height,sr.seedX,sr.seedY,sr.seedTolerance),
        seedX:sr.seedX,seedY:sr.seedY,seedTolerance:sr.seedTolerance}))
      images.push({id:si.id,name:si.name,baseImage,regions,penPixels:si.penPixels??[],undoStack:[]})
    } catch(e) {}
  }
  return {images,labels:data.labels,name:data.name,activeLabelId:data.activeLabelId,tolerance:data.tolerance,activeImageId:data.activeImageId}
}

async function exportProjectAsAnno(sp: SerializedProject) {
  const JSZip=(await import('jszip')).default
  const zip=new (JSZip as any)()
  zip.file('project.json', JSON.stringify(sp))
  const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:6}})
  downloadBlob(blob, `${safeName(sp.name)}.anno`)
}
async function importAnnoFile(file: File): Promise<SerializedProject> {
  const JSZip=(await import('jszip')).default
  const zip=await (JSZip as any).loadAsync(file)
  const json=await zip.file('project.json').async('string')
  return JSON.parse(json)
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function AnnotatorPage() {
  // Refs
  const canvasRef      = useRef<HTMLCanvasElement>(null)
  const fileInputRef   = useRef<HTMLInputElement>(null)
  const pixelOwnerRef  = useRef<Int32Array|null>(null)
  const activeIdRef    = useRef<string|null>(null)
  const stateRef       = useRef({images:[] as AnnotatedImage[],labels:INITIAL_LABELS,projectName:'My Project',tolerance:32,activeLabelId:INITIAL_LABELS[0].id,activeImageId:null as string|null,currentProjectId:null as string|null})
  // Line drawing refs
  const isDrawingRef      = useRef(false)
  const lineStartRef      = useRef<{x:number,y:number}|null>(null)
  const canvasSnapshotRef = useRef<ImageData|null>(null)
  const penRadiusRef      = useRef(1)

  // Project state
  const [projectsIndex, setProjectsIndex]     = useState<ProjectMeta[]>([])
  const [currentProjectId, setCurrentPid]     = useState<string|null>(null)
  const [saveStatus, setSaveStatus]           = useState<'saved'|'saving'|'unsaved'>('saved')
  const [showProjects, setShowProjects]       = useState(false)
  const [loading, setLoading]                 = useState(true)

  // Per-project state
  const [projectName, setProjectName]         = useState('My Project')
  const [editingProject, setEditingProject]   = useState(false)
  const [images, setImages]                   = useState<AnnotatedImage[]>([])
  const [activeImageId, setActiveImageId]     = useState<string|null>(null)
  const [labels, setLabels]                   = useState<Label[]>(INITIAL_LABELS)
  const [activeLabelId, setActiveLabelId]     = useState(INITIAL_LABELS[0].id)
  const [tolerance, setTolerance]             = useState(32)

  // Tool state
  const [mode, setMode]           = useState<'fill'|'pen'>('fill')
  const [penRadius, setPenRadius] = useState(1)
  const [zoom, setZoom]           = useState(1)
  const [dragging, setDragging]   = useState(false)
  const [showDownload, setShowDownload] = useState(false)

  // Panel resize state
  const [panelWidth, setPanelWidth]         = useState(400)
  const [imagesColWidth, setImagesColWidth] = useState(190)
  const resizeDragRef = useRef<{type:'col'|'panel', startX:number, startWidth:number}|null>(null)

  // Sync refs
  useEffect(() => { activeIdRef.current = activeImageId }, [activeImageId])
  useEffect(() => { penRadiusRef.current = penRadius }, [penRadius])
  useEffect(() => {
    stateRef.current = {images,labels,projectName,tolerance,activeLabelId,activeImageId,currentProjectId}
  })

  const labelMap    = useMemo(() => new Map(labels.map(l=>[l.id,l])), [labels])
  const activeImage = useMemo(() => images.find(i=>i.id===activeImageId)??null, [images,activeImageId])
  const canUndo     = (activeImage?.undoStack.length??0) > 0

  // ── Initialization ────────────────────────────────────────────────────────
  useEffect(() => {
    async function init() {
      try {
        const idx: ProjectMeta[]=JSON.parse(localStorage.getItem(PROJECTS_KEY)||'[]')
        if (idx.length>0) {
          setProjectsIndex(idx)
          const data=await loadProjectData(idx[0].id)
          if (data) {
            setCurrentPid(idx[0].id); setProjectName(data.name); setImages(data.images)
            setLabels(data.labels); setActiveLabelId(data.activeLabelId||data.labels[0]?.id||'')
            setTolerance(data.tolerance); setActiveImageId(data.activeImageId)
            setLoading(false); return
          }
        }
      } catch(e) {}
      setCurrentPid(crypto.randomUUID()); setLoading(false)
    }
    init()
  }, [])

  // ── Auto-save ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!currentProjectId) return
    setSaveStatus('unsaved')
    const t=setTimeout(() => {
      setSaveStatus('saving')
      try {
        const s=stateRef.current
        setProjectsIndex(persistProject(serializeProject(s.currentProjectId!,s.projectName,s.images,s.labels,s.activeLabelId,s.tolerance,s.activeImageId)))
        setSaveStatus('saved')
      } catch(e) { setSaveStatus('saved') }
    }, 800)
    return () => clearTimeout(t)
  }, [images,labels,projectName,tolerance,activeLabelId,activeImageId,currentProjectId])

  // ── Canvas render ──────────────────────────────────────────────────────
  useEffect(() => {
    if (isDrawingRef.current) return
    const canvas=canvasRef.current; if (!canvas||!activeImage?.baseImage) return
    canvas.width=activeImage.baseImage.width; canvas.height=activeImage.baseImage.height
    canvas.getContext('2d')!.putImageData(applyCanvas(activeImage.baseImage,activeImage.regions,labelMap,activeImage.penPixels),0,0)
    const map=new Int32Array(canvas.width*canvas.height).fill(-1)
    activeImage.regions.forEach((r,i)=>{ for (const px of r.pixels) map[px]=i })
    pixelOwnerRef.current=map
  }, [activeImage,labelMap])

  // ── Line tool window-level handlers ──────────────────────────────────
  useEffect(() => {
    if (mode!=='pen') return
    function onMove(e: MouseEvent) {
      if (!isDrawingRef.current||!lineStartRef.current||!canvasSnapshotRef.current||!canvasRef.current) return
      const canvas=canvasRef.current
      const {x,y}=getCanvasPos(canvas,e.clientX,e.clientY)
      const ctx=canvas.getContext('2d')!
      // Restore snapshot to clear previous preview
      ctx.putImageData(canvasSnapshotRef.current,0,0)
      // Draw preview line
      const r=penRadiusRef.current
      ctx.strokeStyle='#000'; ctx.lineWidth=Math.max(1,r*2+1); ctx.lineCap='round'
      ctx.beginPath(); ctx.moveTo(lineStartRef.current.x,lineStartRef.current.y); ctx.lineTo(x,y); ctx.stroke()
    }
    function onUp(e: MouseEvent) {
      if (!isDrawingRef.current||!lineStartRef.current||!canvasRef.current) return
      isDrawingRef.current=false
      const canvas=canvasRef.current
      const {x,y}=getCanvasPos(canvas,e.clientX,e.clientY)
      const start=lineStartRef.current; lineStartRef.current=null; canvasSnapshotRef.current=null
      const id=activeIdRef.current; if (!id) return
      const pixels=bresenhamLine(start.x,start.y,x,y,canvas.width,canvas.height,penRadiusRef.current)
      if (!pixels.length) return
      setImages(imgs=>imgs.map(img=>{
        if (img.id!==id) return img
        const snap:Snapshot={regions:img.regions,penPixels:img.penPixels}
        return {...img,penPixels:[...img.penPixels,...pixels],undoStack:[...img.undoStack.slice(-MAX_UNDO+1),snap]}
      }))
    }
    window.addEventListener('mousemove',onMove)
    window.addEventListener('mouseup',onUp)
    return () => { window.removeEventListener('mousemove',onMove); window.removeEventListener('mouseup',onUp) }
  }, [mode])

  // ── Keyboard ─────────────────────────────────────────────────────────
  const undo = useCallback(() => {
    const id=activeIdRef.current
    setImages(imgs=>imgs.map(img=>{
      if (img.id!==id||!img.undoStack.length) return img
      const prev=img.undoStack[img.undoStack.length-1]
      return {...img,regions:prev.regions,penPixels:prev.penPixels,undoStack:img.undoStack.slice(0,-1)}
    }))
  }, [])

  useEffect(() => {
    const h=(e:KeyboardEvent)=>{
      if ((e.ctrlKey||e.metaKey)&&e.key==='z') { e.preventDefault(); undo() }
    }
    window.addEventListener('keydown',h); return () => window.removeEventListener('keydown',h)
  }, [undo])

  // ── Clipboard paste ───────────────────────────────────────────────────
  const addFiles = useCallback(async (files: FileList|File[]) => {
    const toLoad=Array.from(files).filter(f=>f.type.startsWith('image/'))
    if (!toLoad.length) return
    const loaded:AnnotatedImage[]=[]
    for (const f of toLoad) {
      loaded.push(await new Promise(resolve=>{
        const url=URL.createObjectURL(f), el=new Image()
        el.onload=()=>{
          const c=document.createElement('canvas'); c.width=el.naturalWidth; c.height=el.naturalHeight
          const ctx=c.getContext('2d')!; ctx.fillStyle='#fff'; ctx.fillRect(0,0,c.width,c.height); ctx.drawImage(el,0,0)
          URL.revokeObjectURL(url)
          resolve({id:crypto.randomUUID(),name:f.name.replace(/\.[^.]+$/,'')||'Image',
            baseImage:ctx.getImageData(0,0,c.width,c.height),regions:[],penPixels:[],undoStack:[]})
        }
        el.src=url
      }))
    }
    // If the active slot is empty, fill it rather than appending
    const activeId=activeIdRef.current
    const activeSlot=stateRef.current.images.find(i=>i.id===activeId)
    if (activeSlot&&!activeSlot.baseImage) {
      const filled={...activeSlot,name:loaded[0].name,baseImage:loaded[0].baseImage}
      const extras=loaded.slice(1)
      const newActiveId=extras.length>0?extras[extras.length-1].id:filled.id
      setImages(imgs=>{
        const idx=imgs.findIndex(i=>i.id===activeId); if (idx<0) return [...imgs,...loaded]
        const next=[...imgs]; next[idx]=filled; next.splice(idx+1,0,...extras); return next
      })
      setActiveImageId(newActiveId)
    } else {
      setImages(prev=>[...prev,...loaded]); setActiveImageId(loaded[loaded.length-1].id)
    }
  }, [])

  useEffect(() => {
    const onPaste=(e:ClipboardEvent)=>{
      const files:File[]=[]
      for (const item of Array.from(e.clipboardData?.items??[])) {
        if (item.type.startsWith('image/')) { const f=item.getAsFile(); if (f) files.push(f) }
      }
      if (files.length) addFiles(files)
    }
    window.addEventListener('paste',onPaste); return ()=>window.removeEventListener('paste',onPaste)
  }, [addFiles])

  // ── Drag & drop ───────────────────────────────────────────────────────
  function handleDragOver(e: React.DragEvent) { e.preventDefault(); setDragging(true) }
  function handleDragLeave() { setDragging(false) }
  function handleDrop(e: React.DragEvent) { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files) }

  // ── Canvas interaction ────────────────────────────────────────────────
  function handleCanvasMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    if (e.button!==0||!activeImage?.baseImage) return
    const canvas=canvasRef.current; if (!canvas) return
    const {x,y}=getCanvasPos(canvas,e.clientX,e.clientY)

    if (mode==='fill') {
      const ownerIdx=pixelOwnerRef.current?.[y*canvas.width+x]??-1
      if (ownerIdx>=0) {
        const newRegions=activeImage.regions.map((r,i)=>i===ownerIdx?{...r,labelId:activeLabelId}:r)
        pushUndo(activeImageId!,activeImage.regions,activeImage.penPixels)
        setImages(imgs=>imgs.map(img=>img.id===activeImageId?{...img,regions:newRegions}:img))
      } else {
        const pixels=floodFillPixels(activeImage.baseImage.data,canvas.width,canvas.height,x,y,tolerance)
        if (!pixels.length) return
        pushUndo(activeImageId!,activeImage.regions,activeImage.penPixels)
        setImages(imgs=>imgs.map(img=>img.id===activeImageId
          ?{...img,regions:[...img.regions,{id:crypto.randomUUID(),labelId:activeLabelId,pixels,seedX:x,seedY:y,seedTolerance:tolerance}]}:img))
      }
    } else {
      // Straight line: capture snapshot and record start point
      isDrawingRef.current=true
      lineStartRef.current={x,y}
      canvasSnapshotRef.current=canvas.getContext('2d')!.getImageData(0,0,canvas.width,canvas.height)
      // Draw start dot for visual feedback
      const ctx=canvas.getContext('2d')!
      ctx.fillStyle='#000'; ctx.beginPath(); ctx.arc(x,y,Math.max(penRadiusRef.current,0.5),0,Math.PI*2); ctx.fill()
    }
  }

  function handleContextMenu(e: React.MouseEvent<HTMLCanvasElement>) {
    e.preventDefault()
    if (!activeImage) return
    const canvas=canvasRef.current; if (!canvas) return
    const {x,y}=getCanvasPos(canvas,e.clientX,e.clientY)
    const ownerIdx=pixelOwnerRef.current?.[y*canvas.width+x]??-1
    if (ownerIdx>=0) {
      pushUndo(activeImageId!,activeImage.regions,activeImage.penPixels)
      setImages(imgs=>imgs.map(img=>img.id===activeImageId
        ?{...img,regions:img.regions.filter((_,i)=>i!==ownerIdx)}:img))
    }
  }

  // ── Wheel zoom ────────────────────────────────────────────────────────
  const canvasWrapRef  = useRef<HTMLDivElement>(null)
  const annoInputRef   = useRef<HTMLInputElement>(null)
  useEffect(()=>{
    const el=canvasWrapRef.current; if (!el) return
    const handler=(e:WheelEvent)=>{
      if (!e.ctrlKey&&!e.metaKey) return
      e.preventDefault()
      setZoom(z=>Math.max(0.1,Math.min(10,z*(e.deltaY<0?1.15:1/1.15))))
    }
    el.addEventListener('wheel',handler,{passive:false})
    return ()=>el.removeEventListener('wheel',handler)
  }, [])

  // ── Panel resize ──────────────────────────────────────────────────────
  useEffect(() => {
    function onMove(e: MouseEvent) {
      const d=resizeDragRef.current; if (!d) return
      const delta=e.clientX-d.startX
      if (d.type==='col') setImagesColWidth(Math.max(100,Math.min(350,d.startWidth+delta)))
      else setPanelWidth(Math.max(260,Math.min(720,d.startWidth+delta)))
    }
    function onUp() {
      resizeDragRef.current=null
      document.body.style.cursor=''
      document.body.style.userSelect=''
    }
    window.addEventListener('mousemove',onMove)
    window.addEventListener('mouseup',onUp)
    return ()=>{ window.removeEventListener('mousemove',onMove); window.removeEventListener('mouseup',onUp) }
  }, [])

  // ── Undo ──────────────────────────────────────────────────────────────
  function pushUndo(id:string,currentRegions:Region[],currentPenPixels:number[]) {
    setImages(imgs=>imgs.map(img=>img.id===id
      ?{...img,undoStack:[...img.undoStack.slice(-MAX_UNDO+1),{regions:currentRegions,penPixels:currentPenPixels}]}:img))
  }

  // ── Image management ──────────────────────────────────────────────────
  function removeImage(id:string) {
    setImages(imgs=>{
      const next=imgs.filter(i=>i.id!==id)
      if (activeImageId===id) setActiveImageId(next[0]?.id??null)
      return next
    })
  }
  function duplicateImage(id:string) {
    setImages(imgs=>{
      const idx=imgs.findIndex(i=>i.id===id); if (idx<0) return imgs
      const src=imgs[idx]
      const copy:AnnotatedImage={id:crypto.randomUUID(),name:src.name+' copy',baseImage:src.baseImage,regions:[...src.regions],penPixels:[...src.penPixels],undoStack:[]}
      const next=[...imgs]; next.splice(idx+1,0,copy); setActiveImageId(copy.id); return next
    })
  }
  function moveImage(id:string,dir:-1|1) {
    setImages(imgs=>{
      const idx=imgs.findIndex(i=>i.id===id),ni=idx+dir
      if (ni<0||ni>=imgs.length) return imgs
      const next=[...imgs];[next[idx],next[ni]]=[next[ni],next[idx]]; return next
    })
  }
  function renameImage(id:string,name:string) { setImages(imgs=>imgs.map(img=>img.id===id?{...img,name}:img)) }

  function addBlankImage() {
    const newImg:AnnotatedImage={id:crypto.randomUUID(),name:'New Image',regions:[],penPixels:[],undoStack:[]}
    setImages(imgs=>{
      const idx=imgs.findIndex(i=>i.id===activeImageId)
      if (idx<0) return [...imgs,newImg]
      const next=[...imgs]; next.splice(idx+1,0,newImg); return next
    })
    setActiveImageId(newImg.id)
  }

  // ── Label management ──────────────────────────────────────────────────
  function addLabel() {
    const label=mkLabel(`Label ${labels.length+1}`,LABEL_COLORS[labels.length%LABEL_COLORS.length])
    setLabels(prev=>[...prev,label]); setActiveLabelId(label.id)
  }
  function updateLabel(id:string,patch:Partial<Label>) { setLabels(prev=>prev.map(l=>l.id===id?{...l,...patch}:l)) }
  function deleteLabel(id:string) {
    if (labels.length<=1) return
    const next=labels.filter(l=>l.id!==id)
    setLabels(next); setImages(imgs=>imgs.map(img=>({...img,regions:img.regions.filter(r=>r.labelId!==id)})))
    if (activeLabelId===id) setActiveLabelId(next[0].id)
  }

  // ── Project management ────────────────────────────────────────────────
  function saveCurrentImmediate() {
    const s=stateRef.current; if (!s.currentProjectId) return
    try { setProjectsIndex(persistProject(serializeProject(s.currentProjectId,s.projectName,s.images,s.labels,s.activeLabelId,s.tolerance,s.activeImageId))); setSaveStatus('saved') } catch(e) {}
  }
  async function handleSwitchProject(id:string) {
    saveCurrentImmediate(); setShowProjects(false); setLoading(true)
    try {
      const data=await loadProjectData(id); if (!data) { setLoading(false); return }
      setCurrentPid(id); setProjectName(data.name); setImages(data.images)
      setLabels(data.labels); setActiveLabelId(data.activeLabelId||data.labels[0]?.id||'')
      setTolerance(data.tolerance); setActiveImageId(data.activeImageId)
    } catch(e) {}
    setLoading(false)
  }
  function handleNewProject() {
    saveCurrentImmediate(); setShowProjects(false)
    const nl=LABEL_COLORS.slice(0,3).map((c,i)=>mkLabel(`Label ${i+1}`,c))
    setCurrentPid(crypto.randomUUID()); setProjectName('New Project')
    setImages([]); setActiveImageId(null); setLabels(nl); setActiveLabelId(nl[0].id); setTolerance(32); setSaveStatus('unsaved')
  }
  function handleDeleteProject(id:string,e:React.MouseEvent) {
    e.stopPropagation()
    try {
      localStorage.removeItem(PROJECT_KEY(id))
      const ni=projectsIndex.filter(p=>p.id!==id)
      localStorage.setItem(PROJECTS_KEY,JSON.stringify(ni)); setProjectsIndex(ni)
      if (id===currentProjectId) { if (ni.length>0) handleSwitchProject(ni[0].id); else handleNewProject() }
    } catch(e) {}
  }

  // ── .anno import / export / archive ──────────────────────────────────
  function getSerializedById(id: string): SerializedProject | null {
    if (id === currentProjectId) {
      const s = stateRef.current
      return serializeProject(s.currentProjectId!, s.projectName, s.images, s.labels, s.activeLabelId, s.tolerance, s.activeImageId)
    }
    const raw = localStorage.getItem(PROJECT_KEY(id))
    return raw ? JSON.parse(raw) : null
  }
  async function handleExportAnno(id: string, e: React.MouseEvent) {
    e.stopPropagation()
    try {
      const sp = getSerializedById(id); if (!sp) return
      await exportProjectAsAnno(sp)
    } catch(err:any) { alert(`Export failed: ${err?.message??err}`) }
  }
  async function handleArchiveProject(id: string, e: React.MouseEvent) {
    e.stopPropagation()
    try {
      const sp = getSerializedById(id); if (!sp) return
      await exportProjectAsAnno(sp)
      localStorage.removeItem(PROJECT_KEY(id))
      const ni = projectsIndex.filter(p=>p.id!==id)
      localStorage.setItem(PROJECTS_KEY, JSON.stringify(ni)); setProjectsIndex(ni)
      if (id===currentProjectId) { if (ni.length>0) handleSwitchProject(ni[0].id); else handleNewProject() }
    } catch(err:any) { alert(`Archive failed: ${err?.message??err}`) }
  }
  async function handleOpenAnno(file: File) {
    setShowProjects(false); setLoading(true)
    try {
      const sp = await importAnnoFile(file)
      const imgs: AnnotatedImage[] = []
      for (const si of sp.images) {
        try {
          const baseImage = await dataUrlToImageData(si.dataUrl)
          const regions = si.regions.map(sr=>({id:sr.id,labelId:sr.labelId,
            pixels:floodFillPixels(baseImage.data,baseImage.width,baseImage.height,sr.seedX,sr.seedY,sr.seedTolerance),
            seedX:sr.seedX,seedY:sr.seedY,seedTolerance:sr.seedTolerance}))
          imgs.push({id:si.id,name:si.name,baseImage,regions,penPixels:si.penPixels??[],undoStack:[]})
        } catch(e) {}
      }
      setProjectsIndex(persistProject(sp))
      setCurrentPid(sp.id); setProjectName(sp.name); setImages(imgs)
      setLabels(sp.labels); setActiveLabelId(sp.activeLabelId||sp.labels[0]?.id||'')
      setTolerance(sp.tolerance); setActiveImageId(sp.activeImageId)
    } catch(err:any) { alert(`Could not open .anno file: ${err?.message??err}`) }
    setLoading(false)
  }

  // ── Export ────────────────────────────────────────────────────────────
  async function exportCurrentPng() {
    if (!activeImage) return
    downloadBlob(await canvasToBlob(renderImageToCanvas(activeImage,labelMap)),`${safeName(activeImage.name)}.png`)
  }
  async function exportCurrentSvg() {
    if (!activeImage) return
    downloadBlob(new Blob([canvasToSvg(renderImageToCanvas(activeImage,labelMap))],{type:'image/svg+xml'}),`${safeName(activeImage.name)}.svg`)
  }
  async function exportCurrentPptx() {
    if (!activeImage) return
    const c=renderImageToCanvas(activeImage,labelMap), b64=c.toDataURL('image/png').replace(/^data:image\/png;base64,/,'')
    try {
      const prs=new ((await import('pptxgenjs')).default as any)(); prs.layout='LAYOUT_WIDE'
      const SW=13.33,SH=7.5,r=c.width/c.height; let w=SW,h=SW/r; if(h>SH){h=SH;w=SH*r}
      prs.addSlide().addImage({data:`image/png;base64,${b64}`,x:(SW-w)/2,y:(SH-h)/2,w,h})
      await prs.writeFile({fileName:`${safeName(activeImage.name)}.pptx`})
    } catch(err:any) { alert(`PPTX failed: ${err?.message??err}`) }
  }
  async function exportAllPng() {
    try {
      const JSZip=(await import('jszip')).default, zip=new (JSZip as any)()
      for (const img of images) zip.file(`${safeName(img.name)}.png`,await canvasToBlob(renderImageToCanvas(img,labelMap)))
      downloadBlob(await zip.generateAsync({type:'blob'}),`${safeName(projectName)}.zip`)
    } catch(err:any) { alert(`Export failed: ${err?.message??err}`) }
  }
  async function exportAllSvg() {
    try {
      const JSZip=(await import('jszip')).default, zip=new (JSZip as any)()
      for (const img of images) zip.file(`${safeName(img.name)}.svg`,canvasToSvg(renderImageToCanvas(img,labelMap)))
      downloadBlob(await zip.generateAsync({type:'blob'}),`${safeName(projectName)}.zip`)
    } catch(err:any) { alert(`Export failed: ${err?.message??err}`) }
  }
  async function exportAllPptx() {
    try {
      const prs=new ((await import('pptxgenjs')).default as any)(); prs.layout='LAYOUT_WIDE'
      const SW=13.33,SH=7.5,TITLE=0.55
      for (const img of images) {
        const c=renderImageToCanvas(img,labelMap), b64=c.toDataURL('image/png').replace(/^data:image\/png;base64,/,'')
        const imgH=SH-TITLE-0.15,r=c.width/c.height; let w=SW,h=SW/r; if(h>imgH){h=imgH;w=imgH*r}; if(w>SW){w=SW;h=SW/r}
        const slide=prs.addSlide()
        slide.addText(img.name,{x:0.15,y:0.1,w:SW-0.3,h:TITLE,fontSize:20,bold:true,color:'1a1a2e'})
        slide.addImage({data:`image/png;base64,${b64}`,x:(SW-w)/2,y:TITLE+0.05,w,h})
      }
      await prs.writeFile({fileName:`${safeName(projectName)}.pptx`})
    } catch(err:any) { alert(`PPTX failed: ${err?.message??err}`) }
  }

  const saveInd = saveStatus==='saved'?{t:'✓ saved',c:'#2ecc71'}:saveStatus==='saving'?{t:'saving…',c:'#f39c12'}:{t:'● unsaved',c:'#999'}

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <main style={{minHeight:'100vh',background:'#f0f2f5',fontFamily:"'Segoe UI',system-ui,sans-serif",display:'flex',flexDirection:'column'}}>

      {/* ── Top bar ── */}
      <div style={{background:'#1a1a2e',color:'#fff',padding:'0.5rem 1rem',display:'flex',alignItems:'center',gap:'0.6rem',flexWrap:'wrap',position:'relative',zIndex:10}}>

        {/* Projects dropdown */}
        <div style={{position:'relative'}}>
          <button onClick={()=>setShowProjects(s=>!s)} style={topBtn('#2c3e50')}>≡ Projects</button>
          {showProjects && (<>
            <div style={{position:'fixed',inset:0,zIndex:200}} onClick={()=>setShowProjects(false)}/>
            <div style={{position:'absolute',left:0,top:'calc(100% + 6px)',zIndex:201,background:'#fff',borderRadius:10,boxShadow:'0 8px 32px rgba(0,0,0,0.22)',border:'1px solid #e8e8e8',minWidth:280,overflow:'hidden'}}>
              <div style={{padding:'0.5rem 0.8rem 0.2rem',fontSize:'0.72rem',fontWeight:700,color:'#aaa',textTransform:'uppercase',letterSpacing:'0.05em'}}>Saved Projects</div>
              <div style={{maxHeight:280,overflowY:'auto'}}>
                {projectsIndex.length===0&&<div style={{padding:'0.5rem 0.8rem',color:'#bbb',fontSize:'0.82rem'}}>No saved projects</div>}
                {projectsIndex.map(p=>{
                  const cur=p.id===currentProjectId
                  return (
                    <div key={p.id} onClick={()=>!cur&&handleSwitchProject(p.id)} style={{display:'flex',alignItems:'center',gap:'0.4rem',padding:'0.5rem 0.8rem',cursor:cur?'default':'pointer',background:cur?'#eef5ff':'transparent',borderLeft:`3px solid ${cur?'#3498db':'transparent'}`}}
                      onMouseEnter={e=>{if(!cur)(e.currentTarget as HTMLDivElement).style.background='#f5f5f5'}}
                      onMouseLeave={e=>{if(!cur)(e.currentTarget as HTMLDivElement).style.background='transparent'}}>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:'0.88rem',fontWeight:cur?700:400,color:'#222',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{p.name}</div>
                        <div style={{fontSize:'0.72rem',color:'#aaa',marginTop:1}}>{formatDate(p.updatedAt)}</div>
                      </div>
                      <div style={{display:'flex',gap:1,flexShrink:0}} onClick={e=>e.stopPropagation()}>
                        <button onClick={e=>handleExportAnno(p.id,e)} title="Save .anno file" style={{background:'none',border:'none',color:'#bbb',cursor:'pointer',fontSize:'0.9rem',padding:'0 3px',lineHeight:1}}
                          onMouseEnter={e=>(e.currentTarget.style.color='#3498db')} onMouseLeave={e=>(e.currentTarget.style.color='#bbb')}>↓</button>
                        <button onClick={e=>handleArchiveProject(p.id,e)} title="Archive: save .anno + remove from list" style={{background:'none',border:'none',color:'#bbb',cursor:'pointer',fontSize:'0.85rem',padding:'0 3px',lineHeight:1}}
                          onMouseEnter={e=>(e.currentTarget.style.color='#f39c12')} onMouseLeave={e=>(e.currentTarget.style.color='#bbb')}>⊡</button>
                        <button onClick={e=>handleDeleteProject(p.id,e)} title="Delete permanently" style={{background:'none',border:'none',color:'#ccc',cursor:'pointer',fontSize:'1.1rem',padding:'0 2px',lineHeight:1}}
                          onMouseEnter={e=>(e.currentTarget.style.color='#e74c3c')} onMouseLeave={e=>(e.currentTarget.style.color='#ccc')}>×</button>
                      </div>
                    </div>
                  )
                })}
              </div>
              <div style={{height:1,background:'#f0f0f0'}}/>
              <div style={{display:'flex'}}>
                <button onClick={handleNewProject} style={{flex:1,textAlign:'left',padding:'0.5rem 0.8rem',border:'none',background:'none',fontSize:'0.88rem',color:'#3498db',cursor:'pointer',fontWeight:600}}
                  onMouseEnter={e=>(e.currentTarget.style.background='#f0f7ff')} onMouseLeave={e=>(e.currentTarget.style.background='none')}>
                  + New Project
                </button>
                <button onClick={()=>annoInputRef.current?.click()} style={{textAlign:'left',padding:'0.5rem 0.8rem',border:'none',borderLeft:'1px solid #f0f0f0',background:'none',fontSize:'0.88rem',color:'#888',cursor:'pointer',fontWeight:600,whiteSpace:'nowrap' as const}}
                  onMouseEnter={e=>(e.currentTarget.style.background='#f5f5f5')} onMouseLeave={e=>(e.currentTarget.style.background='none')}>
                  📂 Open .anno
                </button>
              </div>
            </div>
          </>)}
        </div>

        <div style={vDivider}/>

        {/* Project name */}
        {editingProject
          ? <input autoFocus value={projectName} onChange={e=>setProjectName(e.target.value)}
              onBlur={()=>setEditingProject(false)} onKeyDown={e=>e.key==='Enter'&&setEditingProject(false)}
              style={{background:'rgba(255,255,255,0.15)',border:'1px solid rgba(255,255,255,0.35)',color:'#fff',borderRadius:5,padding:'0.22rem 0.45rem',fontSize:'0.9rem',fontWeight:700,outline:'none',width:170}}/>
          : <span onClick={()=>setEditingProject(true)} title="Click to rename"
              style={{fontWeight:700,fontSize:'0.9rem',cursor:'pointer',borderBottom:'1px dashed rgba(255,255,255,0.35)',paddingBottom:1}}>
              {projectName}
            </span>
        }
        <span style={{fontSize:'0.72rem',color:saveInd.c,minWidth:65}}>{saveInd.t}</span>

        <div style={vDivider}/>

        <button onClick={()=>fileInputRef.current?.click()} style={topBtn('#2c3e50')}>Add Image</button>
        <input ref={fileInputRef} type="file" accept="image/*" multiple style={{display:'none'}}
          onChange={e=>{if(e.target.files?.length)addFiles(e.target.files);e.target.value=''}}/>
        <input ref={annoInputRef} type="file" accept=".anno" style={{display:'none'}}
          onChange={e=>{if(e.target.files?.[0])handleOpenAnno(e.target.files[0]);e.target.value=''}}/>
        <span style={{color:'#666',fontSize:'0.75rem'}}>or paste / drop</span>

        <div style={{flex:1}}/>

        {/* Mode toggle */}
        <div style={{display:'flex',gap:2,background:'rgba(255,255,255,0.08)',borderRadius:6,padding:2}}>
          {(['fill','pen'] as const).map(m=>(
            <button key={m} onClick={()=>setMode(m)} style={{
              padding:'0.3rem 0.7rem',borderRadius:4,border:'none',
              background:mode===m?'#3498db':'transparent',
              color:'#fff',fontWeight:600,fontSize:'0.8rem',cursor:'pointer',
            }}>{m==='fill'?'⬛ Fill':'╱ Line'}</button>
          ))}
        </div>

        {/* Pen size (shown in pen mode) */}
        {mode==='pen' && (
          <div style={{display:'flex',gap:2,background:'rgba(255,255,255,0.08)',borderRadius:6,padding:2}}>
            {[{r:0.5,l:'S'},{r:1.5,l:'M'},{r:3,l:'L'}].map(({r,l})=>(
              <button key={l} onClick={()=>setPenRadius(r)} style={{
                padding:'0.25rem 0.5rem',borderRadius:4,border:'none',
                background:penRadius===r?'rgba(255,255,255,0.25)':'transparent',
                color:'#fff',fontWeight:600,fontSize:'0.78rem',cursor:'pointer',
              }}>{l}</button>
            ))}
          </div>
        )}

        <div style={vDivider}/>

        {/* Zoom */}
        <div style={{display:'flex',alignItems:'center',gap:2}}>
          <button onClick={()=>setZoom(z=>Math.max(0.1,+(z/1.25).toFixed(2)))} style={topBtn('#2c3e50')}>−</button>
          <button onClick={()=>setZoom(1)} style={{...topBtn('#2c3e50'),minWidth:52,textAlign:'center' as const}}>{Math.round(zoom*100)}%</button>
          <button onClick={()=>setZoom(z=>Math.min(10,+(z*1.25).toFixed(2)))} style={topBtn('#2c3e50')}>+</button>
        </div>

        <div style={vDivider}/>

        <button onClick={undo} disabled={!canUndo} style={topBtn('#34495e',!canUndo)} title="Ctrl+Z">Undo</button>

        {/* Download */}
        <div style={{position:'relative'}}>
          <button onClick={()=>setShowDownload(s=>!s)} disabled={images.length===0} style={topBtn('#27ae60',images.length===0)}>Download ▾</button>
          {showDownload && (<>
            <div style={{position:'fixed',inset:0,zIndex:200}} onClick={()=>setShowDownload(false)}/>
            <div style={{position:'absolute',right:0,top:'calc(100% + 6px)',zIndex:201,background:'#fff',borderRadius:10,boxShadow:'0 8px 32px rgba(0,0,0,0.18)',border:'1px solid #e8e8e8',minWidth:200,overflow:'hidden'}}>
              <div style={menuSection}>Current image</div>
              {(['PNG','SVG','PPTX'] as const).map(fmt=>(
                <button key={fmt} disabled={!activeImage} style={menuItem(!activeImage)} onClick={()=>{setShowDownload(false);if(fmt==='PNG')exportCurrentPng();if(fmt==='SVG')exportCurrentSvg();if(fmt==='PPTX')exportCurrentPptx()}}>{fmt}</button>
              ))}
              <div style={{height:1,background:'#f0f0f0',margin:'0.25rem 0'}}/>
              <div style={menuSection}>All images ({images.length})</div>
              {[['PNG','zip'],['SVG','zip'],['PPTX','deck']].map(([fmt,suf])=>(
                <button key={fmt} disabled={images.length===0} style={menuItem(images.length===0)} onClick={()=>{setShowDownload(false);if(fmt==='PNG')exportAllPng();if(fmt==='SVG')exportAllSvg();if(fmt==='PPTX')exportAllPptx()}}>
                  {fmt} <span style={{color:'#aaa',fontSize:'0.78rem'}}>({suf})</span>
                </button>
              ))}
            </div>
          </>)}
        </div>
      </div>

      {/* ── Body ── */}
      <div style={{display:'flex',flex:1,overflow:'hidden',position:'relative'}}>

        {loading && (
          <div style={{position:'absolute',inset:0,background:'rgba(240,242,245,0.85)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:50}}>
            <span style={{color:'#555',fontSize:'1rem',fontWeight:600}}>Loading project…</span>
          </div>
        )}

        {/* ── Left panel — two columns ── */}
        <div style={{width:panelWidth,background:'#fff',display:'flex',flexDirection:'row',overflow:'hidden',flexShrink:0}}>

          {/* Images column */}
          <div style={{width:imagesColWidth,flexShrink:0,display:'flex',flexDirection:'column',overflow:'hidden'}}>
            <div style={{padding:'0.6rem 0.7rem 0.4rem',display:'flex',alignItems:'center',justifyContent:'space-between',borderBottom:'1px solid #eee',flexShrink:0}}>
              <span style={{fontWeight:700,fontSize:'0.82rem',color:'#333'}}>Images</span>
              <button onClick={addBlankImage} style={{fontSize:'0.72rem',padding:'0.18rem 0.45rem',borderRadius:4,border:'1px solid #ccc',background:'#f5f5f5',cursor:'pointer',color:'#333'}}>+ Add</button>
            </div>
            <div style={{overflowY:'auto',flex:1,padding:'0.35rem 0.35rem'}}>
              {images.length===0&&<div style={{color:'#c0c0c0',fontSize:'0.75rem',padding:'0.3rem 0.2rem'}}>Add images to begin.</div>}
              {images.map((img,idx)=>{
                const active=img.id===activeImageId
                return (
                  <div key={img.id} onClick={()=>setActiveImageId(img.id)} style={{display:'flex',alignItems:'center',gap:'0.25rem',padding:'0.35rem 0.4rem',marginBottom:'0.2rem',borderRadius:6,cursor:'pointer',background:active?'#eef5ff':'#fafafa',border:`1.5px solid ${active?'#3498db':'#eee'}`}}>
                    <span style={{width:18,height:18,borderRadius:3,background:'#e8e8e8',flexShrink:0,display:'flex',alignItems:'center',justifyContent:'center',fontSize:'0.65rem',color:'#888',fontWeight:600}}>{idx+1}</span>
                    <input type="text" value={img.name} onChange={e=>renameImage(img.id,e.target.value)} onClick={e=>e.stopPropagation()}
                      style={{flex:1,border:'none',background:'transparent',minWidth:0,fontSize:'0.78rem',fontWeight:active?600:400,color:'#222',outline:'none'}}/>
                    <div style={{display:'flex',gap:1,flexShrink:0}} onClick={e=>e.stopPropagation()}>
                      <button onClick={()=>moveImage(img.id,-1)} disabled={idx===0} style={iconBtn(idx===0)} title="Up">↑</button>
                      <button onClick={()=>moveImage(img.id,1)} disabled={idx===images.length-1} style={iconBtn(idx===images.length-1)} title="Down">↓</button>
                      <button onClick={()=>duplicateImage(img.id)} style={iconBtn(false)} title="Duplicate">⧉</button>
                      <button onClick={()=>removeImage(img.id)} style={{...iconBtn(false),color:'#e74c3c'}} title="Remove">×</button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Inner resize handle */}
          <div
            onMouseDown={e=>{e.preventDefault();resizeDragRef.current={type:'col',startX:e.clientX,startWidth:imagesColWidth};document.body.style.cursor='col-resize';document.body.style.userSelect='none'}}
            style={{width:4,flexShrink:0,cursor:'col-resize',background:'#eee',transition:'background 0.15s'}}
            onMouseEnter={e=>(e.currentTarget.style.background='#bbb')}
            onMouseLeave={e=>(e.currentTarget.style.background='#eee')}
          />

          {/* Labels column */}
          <div style={{flex:1,minWidth:0,display:'flex',flexDirection:'column',overflow:'hidden'}}>
            <div style={{padding:'0.6rem 0.7rem 0.4rem',display:'flex',alignItems:'center',justifyContent:'space-between',borderBottom:'1px solid #eee',flexShrink:0}}>
              <span style={{fontWeight:700,fontSize:'0.82rem',color:'#333'}}>Labels</span>
              <button onClick={addLabel} style={{fontSize:'0.72rem',padding:'0.18rem 0.45rem',borderRadius:4,border:'1px solid #ccc',background:'#f5f5f5',cursor:'pointer',color:'#333'}}>+ Add</button>
            </div>
            {/* Tolerance */}
            <div style={{padding:'0.45rem 0.7rem 0.5rem',borderBottom:'1px solid #eee',flexShrink:0}}>
              <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                <span style={{fontSize:'0.75rem',fontWeight:600,color:'#555'}}>Fill tolerance</span>
                <span style={{fontSize:'0.75rem',color:'#999'}}>{tolerance}</span>
              </div>
              <input type="range" min={0} max={128} step={4} value={tolerance} onChange={e=>setTolerance(Number(e.target.value))} style={{width:'100%'}}/>
            </div>
            <div style={{flex:1,overflowY:'auto',padding:'0.35rem 0.4rem'}}>
              {labels.map(label=>{
                const active=label.id===activeLabelId
                return (
                  <div key={label.id} onClick={()=>setActiveLabelId(label.id)} style={{borderRadius:7,padding:'0.45rem 0.5rem',marginBottom:'0.3rem',cursor:'pointer',background:active?'#eef5ff':'#fafafa',border:`1.5px solid ${active?'#3498db':'#eee'}`,transition:'border-color 0.1s,background 0.1s'}}>
                    <div style={{display:'flex',alignItems:'center',gap:'0.35rem'}}>
                      <label style={{position:'relative',flexShrink:0,cursor:'pointer'}} onClick={e=>e.stopPropagation()}>
                        <div style={{width:20,height:20,borderRadius:'50%',background:label.color,border:'2px solid rgba(0,0,0,0.18)'}}/>
                        <input type="color" value={label.color} onChange={e=>updateLabel(label.id,{color:e.target.value})}
                          style={{position:'absolute',inset:0,opacity:0,cursor:'pointer',width:'100%',height:'100%',padding:0,border:'none'}}/>
                      </label>
                      <input type="text" value={label.name} onChange={e=>updateLabel(label.id,{name:e.target.value})} onClick={e=>e.stopPropagation()}
                        style={{flex:1,border:'none',background:'transparent',fontSize:'0.8rem',fontWeight:active?600:400,color:'#222',outline:'none',minWidth:0}}/>
                      <button onClick={e=>{e.stopPropagation();deleteLabel(label.id)}} disabled={labels.length<=1}
                        style={{background:'none',border:'none',color:'#ccc',cursor:labels.length<=1?'default':'pointer',fontSize:'1rem',lineHeight:1,padding:'0 1px',opacity:labels.length<=1?0.3:1,flexShrink:0}}>×</button>
                    </div>
                    <div style={{marginTop:'0.35rem'}} onClick={e=>e.stopPropagation()}>
                      <div style={{display:'flex',justifyContent:'space-between',marginBottom:2}}>
                        <span style={{fontSize:'0.65rem',color:'#999'}}>Opacity</span>
                        <span style={{fontSize:'0.65rem',color:'#999'}}>{Math.round(label.opacity*100)}%</span>
                      </div>
                      <input type="range" min={5} max={100} step={5} value={Math.round(label.opacity*100)}
                        onChange={e=>updateLabel(label.id,{opacity:Number(e.target.value)/100})} style={{width:'100%',accentColor:label.color}}/>
                    </div>
                  </div>
                )
              })}
            </div>

          </div>
        </div>

        {/* Outer panel resize handle */}
        <div
          onMouseDown={e=>{e.preventDefault();resizeDragRef.current={type:'panel',startX:e.clientX,startWidth:panelWidth};document.body.style.cursor='col-resize';document.body.style.userSelect='none'}}
          style={{width:4,flexShrink:0,cursor:'col-resize',background:'#e0e0e0',transition:'background 0.15s',zIndex:1}}
          onMouseEnter={e=>(e.currentTarget.style.background='#bbb')}
          onMouseLeave={e=>(e.currentTarget.style.background='#e0e0e0')}
        />

        {/* ── Canvas area ── */}
        <div
          ref={canvasWrapRef}
          style={{flex:1,overflow:'auto',position:'relative',background:dragging?'#e8f4fd':'#f0f2f5',outline:dragging?'3px dashed #3498db':'3px dashed transparent',transition:'background 0.15s,outline 0.15s'}}
          onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}
        >
          <div style={{minWidth:'100%',minHeight:'100%',display:'flex',alignItems:'center',justifyContent:'center',padding:'1rem',boxSizing:'border-box'}}>
            {(!activeImage||!activeImage.baseImage)&&!loading&&(
              <div style={{textAlign:'center',color:'#c0c0c0',pointerEvents:'none',userSelect:'none'}}>
                <div style={{fontSize:'3rem',marginBottom:'0.5rem'}}>🖼</div>
                <div style={{fontSize:'1rem',fontWeight:600}}>{activeImage?'Drop or paste an image here':'Add images to get started'}</div>
                <div style={{fontSize:'0.85rem',marginTop:'0.3rem'}}>
                  Click <strong style={{color:'#aaa'}}>Add Image</strong>, drop files, or paste
                </div>
              </div>
            )}
            <canvas
              ref={canvasRef}
              onMouseDown={handleCanvasMouseDown}
              onContextMenu={handleContextMenu}
              style={{
                display:activeImage?.baseImage?'block':'none', flexShrink:0,
                width:activeImage?.baseImage?Math.round(activeImage.baseImage.width*zoom):undefined,
                height:activeImage?.baseImage?Math.round(activeImage.baseImage.height*zoom):undefined,
                boxShadow:'0 4px 20px rgba(0,0,0,0.18)',
                cursor:'crosshair',
                imageRendering:zoom>2?'pixelated':'auto',
              }}
            />
          </div>
          {/* Zoom hint */}
          {activeImage&&<div style={{position:'absolute',bottom:8,right:12,fontSize:'0.7rem',color:'rgba(0,0,0,0.3)',pointerEvents:'none'}}>Ctrl+scroll to zoom</div>}
        </div>
      </div>

      {/* Right-click hint */}
      {activeImage?.baseImage&&(
        <div style={{background:'#1a1a2e',color:'rgba(255,255,255,0.45)',fontSize:'0.72rem',padding:'0.25rem 1rem',textAlign:'right'}}>
          {mode==='fill'?'Left-click to fill/reassign · Right-click to remove region':'Click and drag to draw a straight line'}
        </div>
      )}
    </main>
  )
}

// ── Style helpers ─────────────────────────────────────────────────────────────

const vDivider: React.CSSProperties = {width:1,height:18,background:'rgba(255,255,255,0.2)',margin:'0 0.1rem'}
const menuSection: React.CSSProperties = {padding:'0.4rem 0.85rem 0.2rem',fontSize:'0.72rem',fontWeight:700,color:'#aaa',textTransform:'uppercase',letterSpacing:'0.05em'}

function topBtn(bg:string,disabled=false): React.CSSProperties {
  return {padding:'0.33rem 0.75rem',borderRadius:6,border:'none',background:disabled?'#444':bg,color:'#fff',fontWeight:600,fontSize:'0.8rem',cursor:disabled?'not-allowed':'pointer',opacity:disabled?0.5:1,flexShrink:0}
}
function iconBtn(disabled:boolean): React.CSSProperties {
  return {background:'none',border:'none',padding:'1px 2px',fontSize:'0.82rem',cursor:disabled?'default':'pointer',color:disabled?'#ddd':'#888',borderRadius:3,lineHeight:1}
}
function menuItem(disabled:boolean): React.CSSProperties {
  return {display:'block',width:'100%',textAlign:'left',padding:'0.42rem 0.85rem',border:'none',background:'none',fontSize:'0.88rem',color:disabled?'#ccc':'#333',cursor:disabled?'default':'pointer'}
}
