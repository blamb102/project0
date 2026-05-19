import { useEffect, useState } from 'react'

export default function App() {
  const [message, setMessage] = useState('')

  useEffect(() => {
    fetch('/api/hello')
      .then((r) => r.json())
      .then((d) => setMessage(d.message))
      .catch(() => setMessage('Could not reach API'))
  }, [])

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="text-center space-y-4">
        <h1 className="text-5xl font-bold text-gray-900">Hello, World!</h1>
        <p className="text-lg text-gray-500">
          API says:{' '}
          <span className="font-medium text-indigo-600">{message || '…'}</span>
        </p>
      </div>
    </div>
  )
}
