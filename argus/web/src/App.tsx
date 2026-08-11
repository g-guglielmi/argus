import { useEffect, useState } from 'react'

type Me = { email: string; name: string; surname: string; role: string }
type Health = { status: string; zabbix: { reachable: boolean; version?: string; error?: string } }

const card: React.CSSProperties = {
  border: '1px solid #333',
  borderRadius: 8,
  padding: '1rem 1.25rem',
  background: '#1b1b1b',
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/me')
      .then((r) => (r.ok ? r.json() : null))
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <Shell><p>Loading…</p></Shell>
  if (!me) return <Login onSuccess={setMe} />
  return <Dashboard me={me} onLogout={() => setMe(null)} />
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ maxWidth: 640, margin: '4rem auto', padding: '0 1rem' }}>
      <h1 style={{ marginBottom: '0.25rem' }}>Argus</h1>
      <p style={{ color: '#888', marginTop: 0 }}>Monitoring cockpit</p>
      {children}
    </main>
  )
}

function Login({ onSuccess }: { onSuccess: (m: Me) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      if (!res.ok) {
        setError('Invalid email or password')
        return
      }
      onSuccess(await res.json())
    } catch {
      setError('Could not reach the server')
    } finally {
      setBusy(false)
    }
  }

  const input: React.CSSProperties = {
    width: '100%',
    padding: '0.6rem 0.7rem',
    marginTop: 4,
    borderRadius: 6,
    border: '1px solid #333',
    background: '#111',
    color: '#e6e6e6',
    boxSizing: 'border-box',
  }

  return (
    <Shell>
      <section style={{ ...card, maxWidth: 380 }}>
        <h2 style={{ fontSize: '1rem', marginTop: 0 }}>Sign in</h2>
        <form onSubmit={submit}>
          <label style={{ display: 'block', marginBottom: '0.75rem' }}>
            Email
            <input style={input} type="email" value={email} autoComplete="username"
              onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label style={{ display: 'block', marginBottom: '1rem' }}>
            Password
            <input style={input} type="password" value={password} autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)} required />
          </label>
          {error && <p style={{ color: 'crimson', margin: '0 0 0.75rem' }}>{error}</p>}
          <button type="submit" disabled={busy}
            style={{ width: '100%', padding: '0.6rem', borderRadius: 6, border: 'none',
              background: '#2f6f4f', color: 'white', cursor: 'pointer', fontWeight: 600 }}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </section>
    </Shell>
  )
}

function Dashboard({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [health, setHealth] = useState<Health | null>(null)

  useEffect(() => {
    fetch('/api/health').then((r) => r.json()).then(setHealth).catch(() => setHealth(null))
  }, [])

  async function logout() {
    await fetch('/api/logout', { method: 'POST' }).catch(() => {})
    onLogout()
  }

  return (
    <Shell>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <span style={{ color: '#aaa' }}>
          {me.email} · <strong style={{ color: '#e6e6e6' }}>{me.role}</strong>
        </span>
        <button onClick={logout}
          style={{ padding: '0.4rem 0.8rem', borderRadius: 6, border: '1px solid #333',
            background: 'transparent', color: '#e6e6e6', cursor: 'pointer' }}>
          Log out
        </button>
      </div>

      <section style={card}>
        <h2 style={{ fontSize: '1rem', marginTop: 0 }}>System health</h2>
        {!health && <p>Checking…</p>}
        {health && (
          <ul style={{ lineHeight: 1.9, margin: 0, paddingLeft: '1.1rem' }}>
            <li>Backend: <strong style={{ color: 'seagreen' }}>{health.status}</strong></li>
            <li>
              Zabbix API:{' '}
              {health.zabbix.reachable
                ? <strong style={{ color: 'seagreen' }}>reachable (v{health.zabbix.version})</strong>
                : <strong style={{ color: 'crimson' }}>unreachable</strong>}
            </li>
            {health.zabbix.error && (
              <li style={{ color: '#c66', listStyle: 'none', marginLeft: '-1.1rem' }}>↳ {health.zabbix.error}</li>
            )}
          </ul>
        )}
      </section>
    </Shell>
  )
}
