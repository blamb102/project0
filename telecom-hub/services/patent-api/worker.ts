import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import JSZip from 'jszip'
import {
  fetchPatentData, fetchClaims, fetchPatentPdf,
  fetchFileHistory, fetchFileHistoryDoc, fetchPatentFamily,
} from './sources'
import {
  buildPatentDoc, buildClaimsDoc, buildClaimChartDoc,
  buildFileHistorySummaryDoc, buildFamilyDoc,
} from './docgen'

const s3 = new S3Client({})
const BUCKET = process.env.PATENT_OUTPUT_BUCKET!

interface WorkerPayload {
  jobId: string
  patentNumber: string
}

async function setStatus(jobId: string, status: object) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key:    `jobs/${jobId}/status.json`,
    Body:   JSON.stringify(status),
    ContentType: 'application/json',
  }))
}

export const handler = async (event: WorkerPayload) => {
  const { jobId, patentNumber } = event

  await setStatus(jobId, { status: 'running', step: 'Fetching patent data' })

  try {
    // Step 1: fetch patent metadata + claims in parallel
    const [patent, claims, family] = await Promise.all([
      fetchPatentData(patentNumber),
      fetchClaims(patentNumber),
      fetchPatentFamily(patentNumber),
    ])

    patent.claims = claims

    await setStatus(jobId, { status: 'running', step: 'Fetching file history' })

    // Step 2: file history (needs appNumber from patent data)
    const appNum = patent.appNumber || patentNumber
    const history = await fetchFileHistory(appNum)

    // Step 3: patent PDF
    const pdfBuffer = await fetchPatentPdf(patentNumber)

    await setStatus(jobId, { status: 'running', step: 'Generating documents' })

    // Step 4: generate DOCX files in parallel
    const [patentDocx, claimsDocx, chartDocx, summaryDocx, familyDocx] = await Promise.all([
      buildPatentDoc(patent),
      buildClaimsDoc(patent, claims),
      buildClaimChartDoc(patent, claims),
      buildFileHistorySummaryDoc(patent, history, ''),
      buildFamilyDoc(patent, family.members),
    ])

    await setStatus(jobId, { status: 'running', step: 'Building ZIP' })

    // Step 5: assemble ZIP
    const zip = new JSZip()
    const folder = zip.folder(patentNumber)!

    folder.file('patent.docx',       patentDocx)
    folder.file('claims.docx',       claimsDocx)
    folder.file('claim-chart.docx',  chartDocx)
    folder.file('file-history-summary.docx', summaryDocx)
    folder.file('patent-family.docx', familyDocx)

    if (pdfBuffer) folder.file(`${patentNumber}.pdf`, pdfBuffer)

    // Fetch and add substantive file history docs (up to 30)
    const docsToFetch = history.slice(0, 30)
    const fhFolder = folder.folder('file-history')!
    await Promise.all(docsToFetch.map(async (doc, i) => {
      const buf = await fetchFileHistoryDoc(appNum, doc.docId)
      if (buf) {
        const safeName = `${String(i + 1).padStart(3, '0')}_${doc.date}_${doc.docCode}.pdf`
        fhFolder.file(safeName, buf)
      }
    }))

    const zipBuffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    })

    await setStatus(jobId, { status: 'running', step: 'Uploading ZIP' })

    // Step 6: upload ZIP to S3
    const zipKey = `jobs/${jobId}/${patentNumber}-folio.zip`
    await s3.send(new PutObjectCommand({
      Bucket:      BUCKET,
      Key:         zipKey,
      Body:        zipBuffer,
      ContentType: 'application/zip',
    }))

    // Step 7: write final status with s3 key for presigned URL generation
    await setStatus(jobId, {
      status:  'complete',
      zipKey,
      patent:  {
        number:    patent.patentNumber,
        title:     patent.title,
        assignee:  patent.assignee,
        claimCount: claims.length,
        historyCount: history.length,
        familyCount:  family.members.length,
      },
    })
  } catch (err: any) {
    await setStatus(jobId, {
      status: 'error',
      error:  err.message ?? String(err),
    })
  }
}
