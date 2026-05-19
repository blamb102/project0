exports.handler = async (event) => {
  const path = event.rawPath || ''

  if (path === '/api/hello') {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello from Lambda!' }),
    }
  }

  return { statusCode: 404, body: JSON.stringify({ error: 'Not found' }) }
}
