import { useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'

type Me = { email: string; name: string; surname: string; role: string }
type User = { id: number; email: string; name: string; surname: string; role: string }
type Health = { status: string; zabbix: { reachable: boolean; version?: string; error?: string } }

const ROLES = ['admin', 'helpdesk', 'viewer']

const card: CSSProperties = { border: '1px solid #333', borderRadius: 8, padding: '1rem 1.25rem', background: '#1b1b1b' }
const input: CSSProperties = { padding: '0.5rem 0.6rem', borderRadius: 6, border: '1px solid #333', background: '#111', color: '#e6e6e6', boxSizing: 'border-box' }
const btn: CSSProperties = { padding: '0.5rem 0.9rem', borderRadius: 6, border: 'none', background: '#2f6f4f', color: 'white', cursor: 'pointer', fontWeight: 600 }
const ghost: CSSProperties = { padding: '0.4rem 0.7rem', borderRadius: 6, border: '1px solid #333', background: 'transparent', color: '#e6e6e6', cursor: 'pointer' }

export default function App() {
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/me').then((r) => (r.ok ? r.json() : null)).then(setMe).catch(() => setMe(null)).finally(() => setLoading(false))
  }, [])

  if (loading) return <Frame><p>Loading…</p></Frame>
  if (!me) return <Login onSuccess={setMe} />
  return <AppShell me={me} onLogout={() => setMe(null)} />
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <main style={{ maxWidth: 820, margin: '3rem auto', padding: '0 1rem' }}>
      <h1 style={{ marginBottom: 0 }}>Argus</h1>
      <p style={{ color: '#888', marginTop: 4 }}>Monitoring cockpit</p>
      {children}
    </main>
  )
}

function Login({ onSuccess }: { onSuccess: (m: Me) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })
      if (!res.ok) { setError('Invalid email or password'); return }
      onSuccess(await res.json())
    } catch { setError('Could not reach the server') } finally { setBusy(false) }
  }

  return (
    <Frame>
      <section style={{ ...card, maxWidth: 380, marginTop: '1.5rem' }}>
        <h2 style={{ fontSize: '1rem', marginTop: 0 }}>Sign in</h2>
        <form onSubmit={submit}>
          <label style={{ display: 'block', marginBottom: '0.75rem' }}>Email
            <input style={{ ...input, width: '100%', marginTop: 4 }} type="email" value={email} autoComplete="username" onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label style={{ display: 'block', marginBottom: '1rem' }}>Password
            <input style={{ ...input, width: '100%', marginTop: 4 }} type="password" value={password} autoComplete="current-password" onChange={(e) => setPassword(e.target.value)} required />
          </label>
          {error && <p style={{ color: 'crimson', margin: '0 0 0.75rem' }}>{error}</p>}
          <button type="submit" disabled={busy} style={{ ...btn, width: '100%' }}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
      </section>
    </Frame>
  )
}

function AppShell({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [view, setView] = useState<'dashboard' | 'users' | 'account'>('dashboard')
  async function logout() { await fetch('/api/logout', { method: 'POST' }).catch(() => {}); onLogout() }
  const tab = (id: typeof view, label: string) => (
    <button onClick={() => setView(id)} style={{ ...ghost, borderColor: view === id ? '#2f6f4f' : '#333' }}>{label}</button>
  )
  return (
    <Frame>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '1rem 0 1.25rem', flexWrap: 'wrap', gap: '0.5rem' }}>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {tab('dashboard', 'Dashboard')}
          {me.role === 'admin' && tab('users', 'Users')}
          {tab('account', 'Account')}
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <span style={{ color: '#aaa' }}>{me.email} · <strong style={{ color: '#e6e6e6' }}>{me.role}</strong></span>
          <button onClick={logout} style={ghost}>Log out</button>
        </div>
      </div>
      {view === 'dashboard' && <DashboardView />}
      {view === 'users' && me.role === 'admin' && <UsersView />}
      {view === 'account' && <AccountView />}
    </Frame>
  )
}

function DashboardView() {
  const [health, setHealth] = useState<Health | null>(null)
  useEffect(() => { fetch('/api/health').then((r) => r.json()).then(setHealth).catch(() => setHealth(null)) }, [])
  return (
    <section style={card}>
      <h2 style={{ fontSize: '1rem', marginTop: 0 }}>System health</h2>
      {!health && <p>Checking…</p>}
      {health && (
        <ul style={{ lineHeight: 1.9, margin: 0, paddingLeft: '1.1rem' }}>
          <li>Backend: <strong style={{ color: 'seagreen' }}>{health.status}</strong></li>
          <li>Zabbix API:{' '}
            {health.zabbix.reachable
              ? <strong style={{ color: 'seagreen' }}>reachable (v{health.zabbix.version})</strong>
              : <strong style={{ color: 'crimson' }}>unreachable</strong>}
          </li>
          {health.zabbix.error && <li style={{ color: '#c66', listStyle: 'none', marginLeft: '-1.1rem' }}>↳ {health.zabbix.error}</li>}
        </ul>
      )}
    </section>
  )
}

function UsersView() {
  const [users, setUsers] = useState<User[]>([])
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [nu, setNu] = useState({ email: '', name: '', surname: '', role: 'viewer', password: '' })

  function load() { fetch('/api/users').then((r) => r.json()).then(setUsers).catch(() => setError('Failed to load users')) }
  useEffect(() => { load() }, [])

  async function fail(res: Response) { const j = await res.json().catch(() => ({})); setError(j.error || 'Request failed') }

  async function create(e: FormEvent) {
    e.preventDefault(); setError(null); setMsg(null)
    const res = await fetch('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(nu) })
    if (!res.ok) return fail(res)
    setNu({ email: '', name: '', surname: '', role: 'viewer', password: '' }); setMsg('User created'); load()
  }
  async function changeRole(u: User, role: string) {
    setError(null); setMsg(null)
    const res = await fetch(`/api/users/${u.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: u.name, surname: u.surname, role }) })
    if (!res.ok) return fail(res)
    load()
  }
  async function resetPw(u: User) {
    setError(null); setMsg(null)
    const pw = window.prompt(`New password for ${u.email} (min 8 characters):`)
    if (!pw) return
    const res = await fetch(`/api/users/${u.id}/password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) })
    if (!res.ok) return fail(res)
    setMsg(`Password reset for ${u.email}`)
  }
  async function del(u: User) {
    setError(null); setMsg(null)
    if (!window.confirm(`Delete ${u.email}?`)) return
    const res = await fetch(`/api/users/${u.id}`, { method: 'DELETE' })
    if (!res.ok) return fail(res)
    load()
  }

  return (
    <section style={{ ...card }}>
      <h2 style={{ fontSize: '1rem', marginTop: 0 }}>Users</h2>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      {msg && <p style={{ color: 'seagreen' }}>{msg}</p>}

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.92rem' }}>
          <thead>
            <tr style={{ textAlign: 'left', color: '#aaa' }}>
              <th style={{ padding: '0.4rem 0.5rem' }}>Email</th>
              <th style={{ padding: '0.4rem 0.5rem' }}>Name</th>
              <th style={{ padding: '0.4rem 0.5rem' }}>Role</th>
              <th style={{ padding: '0.4rem 0.5rem' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} style={{ borderTop: '1px solid #2a2a2a' }}>
                <td style={{ padding: '0.4rem 0.5rem' }}>{u.email}</td>
                <td style={{ padding: '0.4rem 0.5rem' }}>{[u.name, u.surname].filter(Boolean).join(' ') || '—'}</td>
                <td style={{ padding: '0.4rem 0.5rem' }}>
                  <select value={u.role} onChange={(e) => changeRole(u, e.target.value)} style={input}>
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </td>
                <td style={{ padding: '0.4rem 0.5rem', display: 'flex', gap: '0.4rem' }}>
                  <button onClick={() => resetPw(u)} style={ghost}>Reset password</button>
                  <button onClick={() => del(u)} style={{ ...ghost, borderColor: '#5a2a2a', color: '#e59' }}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 style={{ fontSize: '0.95rem', marginBottom: '0.5rem' }}>Add user</h3>
      <form onSubmit={create} style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
        <input style={input} type="email" placeholder="email" value={nu.email} onChange={(e) => setNu({ ...nu, email: e.target.value })} required />
        <input style={input} placeholder="name" value={nu.name} onChange={(e) => setNu({ ...nu, name: e.target.value })} />
        <input style={input} placeholder="surname" value={nu.surname} onChange={(e) => setNu({ ...nu, surname: e.target.value })} />
        <select style={input} value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value })}>
          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <input style={input} type="password" placeholder="password (min 8)" value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} required />
        <button type="submit" style={btn}>Add</button>
      </form>
    </section>
  )
}

function AccountView() {
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault(); setError(null); setMsg(null)
    const res = await fetch('/api/me/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ current_password: cur, new_password: next }) })
    if (!res.ok) { const j = await res.json().catch(() => ({})); setError(j.error || 'Request failed'); return }
    setCur(''); setNext(''); setMsg('Password changed')
  }

  return (
    <section style={{ ...card, maxWidth: 420 }}>
      <h2 style={{ fontSize: '1rem', marginTop: 0 }}>Change my password</h2>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      {msg && <p style={{ color: 'seagreen' }}>{msg}</p>}
      <form onSubmit={submit}>
        <label style={{ display: 'block', marginBottom: '0.75rem' }}>Current password
          <input style={{ ...input, width: '100%', marginTop: 4 }} type="password" value={cur} onChange={(e) => setCur(e.target.value)} required />
        </label>
        <label style={{ display: 'block', marginBottom: '1rem' }}>New password (min 8)
          <input style={{ ...input, width: '100%', marginTop: 4 }} type="password" value={next} onChange={(e) => setNext(e.target.value)} required />
        </label>
        <button type="submit" style={btn}>Update password</button>
      </form>
    </section>
  )
}
