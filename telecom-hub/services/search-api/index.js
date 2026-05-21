const MEILI_URL = process.env.MEILISEARCH_URL
const MEILI_KEY = process.env.MEILISEARCH_MASTER_KEY

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Content-Type': 'application/json',
}

exports.handler = async (event) => {
  if (event.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' }
  }

  const params = event.queryStringParameters ?? {}
  const q      = params.q ?? ''
  const limit  = Math.min(Number(params.limit ?? 20), 100)
  const offset = Number(params.offset ?? 0)

  try {
    const res = await fetch(`${MEILI_URL}/indexes/tdocs/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${MEILI_KEY}`,
      },
      body: JSON.stringify({ q, limit, offset }),
    })

    const data = await res.json()
    return { statusCode: res.status, headers: CORS, body: JSON.stringify(data) }
  } catch (err) {
    return {
      statusCode: 502,
      headers: CORS,
      body: JSON.stringify({ error: 'Search backend unavailable', detail: err.message }),
    }
  }
}
