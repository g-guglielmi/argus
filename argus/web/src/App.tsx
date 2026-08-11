import { useEffect, useState } from 'react'

type Health = {
  status: string
  zabbix: { reachable: boolean; version?: string; error?: string }
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then(setHealth)
      .catch((e) => setErr(String(e)))
  }, [])

  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        maxWidth: 640,
        margin: '4rem auto',
        padding: '0 1rem',
        color: '#e6e6e6',
      }}
    >
      <h1 style={{ marginBottom: '0.25rem' }}>Argus</h1>
      <p style={{ color: '#888', marginTop: 0 }}>Monitoring cockpit — walking skeleton</p>

      <section
        style={{
          border: '1px solid #333',
          borderRadius: 8,
          padding: '1rem 1.25rem',
          marginTop: '1.5rem',
          background: '#1b1b1b',
        }}
      >
        <h2 style={{ fontSize: '1rem', marginTop: 0 }}>System health</h2>
        {err && <p style={{ color: 'crimson' }}>Failed to reach backend: {err}</p>}
        {!health && !err && <p>Checking…</p>}
        {health && (
          <ul style={{ lineHeight: 1.9, margin: 0, paddingLeft: '1.1rem' }}>
            <li>
              Backend: <strong style={{ color: 'seagreen' }}>{health.status}</strong>
            </li>
            <li>
              Zabbix API:{' '}
              {health.zabbix.reachable ? (
                <strong style={{ color: 'seagreen' }}>reachable (v{health.zabbix.version})</strong>
              ) : (
                <strong style={{ color: 'crimson' }}>unreachable</strong>
              )}
            </li>
            {health.zabbix.error && (
              <li style={{ color: '#c66', listStyle: 'none', marginLeft: '-1.1rem' }}>
                ↳ {health.zabbix.error}
              </li>
            )}
          </ul>
        )}
      </section>
    </main>
  )
}
