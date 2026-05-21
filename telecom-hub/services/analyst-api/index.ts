import Anthropic from '@anthropic-ai/sdk'

const MEILI_URL  = process.env.MEILISEARCH_URL!
const MEILI_KEY  = process.env.MEILISEARCH_MASTER_KEY!
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY!

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Content-Type': 'application/json',
}

export const handler = async (event: any) => {
  if (event.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' }
  }

  const params = event.queryStringParameters ?? {}
  const topic  = (params.q ?? '').trim()

  if (!topic) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'q is required' }) }
  }

  if (!ANTHROPIC_KEY) {
    return { statusCode: 503, headers: CORS, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }) }
  }

  try {
    const [tdocs, emails] = await Promise.all([
      meiliSearch('tdocs',  topic, 30),
      meiliSearch('emails', topic, 30),
    ])

    const context = buildContext(tdocs, emails)
    const analysis = await callClaude(topic, context)

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        analysis,
        tdocCount:  tdocs.length,
        emailCount: emails.length,
      }),
    }
  } catch (err: any) {
    return {
      statusCode: 502,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    }
  }
}

async function meiliSearch(index: string, q: string, limit: number): Promise<any[]> {
  const res = await fetch(`${MEILI_URL}/indexes/${index}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MEILI_KEY}` },
    body: JSON.stringify({ q, limit, matchingStrategy: 'all' }),
  })
  if (!res.ok) return []
  const data: any = await res.json()
  return data.hits ?? []
}

function buildContext(tdocs: any[], emails: any[]): string {
  const parts: string[] = []

  if (tdocs.length > 0) {
    parts.push('## TDoc Contributions\n')
    for (const t of tdocs) {
      const line = [
        `- **${t.id}**`,
        t.meetingId  ? `[${t.meetingId}]`  : '',
        t.source     ? `— ${t.source}`     : '',
        t.status     ? `(${t.status})`     : '',
        t.title      ? `: ${t.title}`      : '',
      ].filter(Boolean).join(' ')
      parts.push(line)
    }
  }

  if (emails.length > 0) {
    parts.push('\n## Email Reflector Discussions\n')
    for (const e of emails) {
      parts.push(`- **${e.date}** [${e.from}] ${e.subject}`)
      const body = e.body ?? e.snippet
      if (body) parts.push(`  > ${body.slice(0, 400).replace(/\n/g, ' ')}`)
    }
  }

  return parts.join('\n')
}

async function callClaude(topic: string, context: string): Promise<string> {
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY })

  const systemPrompt = `You are a 3GPP standards analyst with deep expertise in \
telecommunications standardization. You analyze TDoc contributions and email reflector \
discussions to provide concise, technically precise insights. When citing documents, \
use their IDs. When noting company positions, be specific about what they propose. \
Structure your response with clear sections.`

  const userPrompt = `Analyze the following 3GPP standardization activity on the topic: \
**"${topic}"**

${context}

Provide a structured analysis with these sections:
1. **Key Technical Themes** — What are the main technical issues or proposals?
2. **Company Activity** — Which organizations are most active and what are they advocating?
3. **Trends & Direction** — How is the discussion evolving? Where is consensus forming?
4. **Current Status** — What has been agreed, what is still under debate?
5. **Notable Items** — Any significant proposals, decisions, or open questions worth highlighting?

Be concise and specific. If the retrieved documents don't contain enough relevant content \
for a section, say so briefly rather than speculating.`

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  })

  const block = message.content[0]
  return block.type === 'text' ? block.text : ''
}
