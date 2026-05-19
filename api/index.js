const express = require('express')
const cors = require('cors')

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors())

app.get('/api/hello', (_req, res) => {
  res.json({ message: 'Hello from Express!' })
})

app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`)
})
