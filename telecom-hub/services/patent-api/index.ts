import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { randomUUID } from 'crypto'

const s3     = new S3Client({})
const lambda = new LambdaClient({})
const BUCKET      = process.env.PATENT_OUTPUT_BUCKET!
const WORKER_ARN  = process.env.PATENT_WORKER_ARN!

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Content-Type':                 'application/json',
}

function resp(statusCode: number, body: object) {
  return { statusCode, headers: CORS, body: JSON.stringify(body) }
}

export const handler = async (event: any) => {
  const method  = event.requestContext?.http?.method ?? 'GET'
  const rawPath = event.rawPath ?? ''

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' }
  }

  // POST /api/patent  → start job
  if (method === 'POST' && rawPath === '/api/patent') {
    const body     = JSON.parse(event.body ?? '{}')
    const nickname = (body.nickname ?? '').trim() || undefined
    const items: string[] | undefined = Array.isArray(body.items) ? body.items : undefined

    // Accept an array of patent numbers or a single one (backward compat)
    let patentNumbers: string[]
    if (Array.isArray(body.patentNumbers) && body.patentNumbers.length > 0) {
      patentNumbers = body.patentNumbers.map((p: any) => String(p).trim()).filter(Boolean)
    } else {
      const single = (body.patentNumber ?? '').trim()
      patentNumbers = single ? [single] : []
    }
    if (patentNumbers.length === 0) return resp(400, { error: 'patentNumber is required' })

    const jobId = randomUUID()
    await s3.send(s3PutCmd(BUCKET, `jobs/${jobId}/status.json`, { status: 'pending' }))

    await lambda.send(new InvokeCommand({
      FunctionName:   WORKER_ARN,
      InvocationType: 'Event',
      Payload:        Buffer.from(JSON.stringify({ jobId, patentNumbers, nickname, items })),
    }))

    return resp(202, { jobId })
  }

  // GET /api/patent/{jobId}  → check status / get download URL
  const jobMatch = rawPath.match(/^\/api\/patent\/([a-f0-9-]+)$/)
  if (method === 'GET' && jobMatch) {
    const jobId = jobMatch[1]
    let statusObj: any

    try {
      const obj = await s3.send(new GetObjectCommand({
        Bucket: BUCKET,
        Key:    `jobs/${jobId}/status.json`,
      }))
      statusObj = JSON.parse(await streamToString(obj.Body!))
    } catch {
      return resp(404, { error: 'Job not found' })
    }

    if (statusObj.status === 'complete') {
      const extra: Record<string, string> = {}
      if (statusObj.zipKey) {
        extra.downloadUrl = await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: BUCKET, Key: statusObj.zipKey }),
          { expiresIn: 3600 },
        )
      }
      if (statusObj.familyTreeKey) {
        extra.familyTreeUrl = await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: BUCKET, Key: statusObj.familyTreeKey }),
          { expiresIn: 3600 },
        )
      }
      return resp(200, { ...statusObj, ...extra })
    }

    return resp(200, statusObj)
  }

  return resp(404, { error: 'Not found' })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function streamToString(stream: any): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf-8')
}

function s3PutCmd(bucket: string, key: string, body: object) {
  return new PutObjectCommand({
    Bucket:      bucket,
    Key:         key,
    Body:        JSON.stringify(body),
    ContentType: 'application/json',
  })
}
