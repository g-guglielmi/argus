import { useEffect, useRef, useState, Fragment, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { registerPasskey, loginWithPasskey } from './webauthn'

type Me = { email: string; name: string; surname: string; role: string; mfa_enabled?: boolean }
type User = { id: number; email: string; name: string; surname: string; role: string; mfa_enabled?: boolean; passkeys?: number }
type Health = { status: string; zabbix: { reachable: boolean; version?: string; error?: string } }
type Passkey = { id: string; name: string; created: string; last_used: string | null }
type Host = { id: string; name: string; enabled: boolean; problems: number; severity: number; state: string; paused: boolean }
type SensorItem = { id: string; name: string; key: string; last_value: string; units: string; last_clock: number; supported: boolean; enabled: boolean; numeric: boolean; category?: string; label?: string }
type Problem = { event_id: string; name: string; severity: number; state: string; acknowledged: boolean; item_ids: string[] }
type SeriesPoint = { t: number; v?: number; min?: number; avg?: number; max?: number }
type Series = { name: string; units: string; kind: 'history' | 'trend'; points: SeriesPoint[] }

const RANGES = ['2h', '2d', '1M', '3M', '6M', '1Y']

const stateColor: Record<string, string> = { ok: 'seagreen', warning: '#d9a441', error: 'crimson' }
const stateRank: Record<string, number> = { ok: 0, warning: 1, error: 2 }

function relTime(unix: number): string {
  if (!unix) return 'never'
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unix)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

// roundNum rounds to 2 decimals for |v|>=1 and 4 for small values (so sub-second timings
// don't collapse to 0), stripping trailing zeros.
function roundNum(n: number): string {
  if (Number.isInteger(n)) return String(n)
  const decimals = Math.abs(n) >= 1 ? 2 : 4
  return String(parseFloat(n.toFixed(decimals)))
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
const BIT_UNITS = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps']

// scaleBy reduces n by `base` until it fits a unit, returning [value, unit].
function scaleBy(n: number, base: number, units: string[]): [string, string] {
  let v = n, i = 0
  while (Math.abs(v) >= base && i < units.length - 1) { v /= base; i++ }
  return [i === 0 ? String(Math.round(v)) : String(parseFloat(v.toFixed(2))), units[i]]
}

// fmtDuration renders a number of seconds as e.g. "1d 4h 14m".
function fmtDuration(sec: number): string {
  sec = Math.max(0, Math.floor(sec))
  const d = Math.floor(sec / 86400); sec %= 86400
  const h = Math.floor(sec / 3600); sec %= 3600
  const m = Math.floor(sec / 60)
  const parts: string[] = []
  if (d) parts.push(`${d}d`)
  if (h) parts.push(`${h}h`)
  if (m || parts.length === 0) parts.push(`${m}m`)
  return parts.join(' ')
}

// scaledUnit reports whether a unit gets special scaling/formatting (so the chart axis and
// legend format it, and the "(unit)" suffix is dropped since the value already carries it).
function scaledUnit(units: string): boolean {
  return units === 'B' || units === 'Bps' || units === 'bps' || units === 'uptime'
}

// fmtNumParts formats a numeric reading into [value, unit], scaling byte/bit units and
// rendering uptime as a duration.
function fmtNumParts(n: number, units: string): [string, string] {
  if (units === 'B') return scaleBy(n, 1024, BYTE_UNITS)
  if (units === 'Bps') { const [v, u] = scaleBy(n, 1024, BYTE_UNITS); return [v, u + 'ps'] }
  if (units === 'bps') return scaleBy(n, 1000, BIT_UNITS)
  if (units === 'uptime') return [fmtDuration(n), '']
  return [roundNum(n), units || '']
}

function fmtNum(n: number, units: string): string {
  const [v, u] = fmtNumParts(n, units)
  return u ? `${v} ${u}` : v
}

// readingParts formats a raw stored value into [display, unit]; non-numeric values (text,
// checksums) are returned untouched with no unit.
function readingParts(raw: string, units: string): [string, string] {
  const t = (raw ?? '').trim()
  if (t === '') return ['—', '']
  const n = Number(t)
  if (!isFinite(n)) return [raw, '']
  return fmtNumParts(n, units)
}

// lastVal returns the most recent non-null value of a uPlot data series.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lastVal(u: any, sidx: number): number | null {
  const arr = u.data[sidx]
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i]
  return null
}

const ROLES = ['admin', 'helpdesk', 'viewer']

const card: CSSProperties = { border: '1px solid #333', borderRadius: 8, padding: '1rem 1.25rem', background: '#1b1b1b' }
const input: CSSProperties = { padding: '0.5rem 0.6rem', borderRadius: 6, border: '1px solid #333', background: '#111', color: '#e6e6e6', boxSizing: 'border-box' }
const btn: CSSProperties = { padding: '0.5rem 0.9rem', borderRadius: 6, border: 'none', background: '#2f6f4f', color: 'white', cursor: 'pointer', fontWeight: 600 }
const ghost: CSSProperties = { padding: '0.4rem 0.7rem', borderRadius: 6, border: '1px solid #333', background: 'transparent', color: '#e6e6e6', cursor: 'pointer' }

async function errText(res: Response, fallback: string) {
  const j = await res.json().catch(() => ({}))
  return (j && j.error) || fallback
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)
  const [passkeysAvailable, setPasskeysAvailable] = useState(false)

  useEffect(() => {
    fetch('/api/me').then((r) => (r.ok ? r.json() : null)).then(setMe).catch(() => setMe(null)).finally(() => setLoading(false))
    // Passkeys require the server to be configured for WebAuthn AND a secure context
    // (HTTPS or localhost) — over a private IP on plain HTTP they can't be used.
    fetch('/api/features').then((r) => r.json()).then((f) => setPasskeysAvailable(!!f.passkeys && window.isSecureContext)).catch(() => {})
  }, [])

  if (loading) return <Frame><p>Loading…</p></Frame>
  if (!me) return <Login onSuccess={setMe} passkeysAvailable={passkeysAvailable} />
  return <AppShell me={me} onLogout={() => setMe(null)} passkeysAvailable={passkeysAvailable} />
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <main style={{ maxWidth: 1200, margin: '2.5rem auto', padding: '0 1.25rem' }}>
      <h1 style={{ marginBottom: 0 }}>Argus</h1>
      <p style={{ color: '#888', marginTop: 4 }}>Monitoring cockpit</p>
      {children}
    </main>
  )
}

function Login({ onSuccess, passkeysAvailable }: { onSuccess: (m: Me) => void; passkeysAvailable: boolean }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function passkeyLogin() {
    setBusy(true); setError(null)
    try {
      onSuccess(await loginWithPasskey())
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Passkey login failed')
    } finally { setBusy(false) }
  }
  // When the account has MFA, the password step returns a short-lived token and we
  // switch to the code step instead of signing straight in.
  const [mfaToken, setMfaToken] = useState<string | null>(null)
  const [code, setCode] = useState('')

  async function submitPassword(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })
      if (!res.ok) { setError('Invalid email or password'); return }
      const data = await res.json()
      if (data.mfa_required) { setMfaToken(data.mfa_token); return }
      onSuccess(data)
    } catch { setError('Could not reach the server') } finally { setBusy(false) }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const res = await fetch('/api/login/totp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mfa_token: mfaToken, code }) })
      if (!res.ok) { setError(await errText(res, 'Invalid code')); return }
      onSuccess(await res.json())
    } catch { setError('Could not reach the server') } finally { setBusy(false) }
  }

  if (mfaToken) {
    return (
      <Frame>
        <section style={{ ...card, maxWidth: 380, marginTop: '1.5rem' }}>
          <h2 style={{ fontSize: '1rem', marginTop: 0 }}>Two-factor authentication</h2>
          <p style={{ color: '#aaa', marginTop: 0 }}>Enter the 6-digit code from your authenticator, or a recovery code.</p>
          <form onSubmit={submitCode}>
            {/* Hidden username so password managers (Bitwarden) treat this as a login
                form and offer to autofill the one-time-code field. */}
            <input
              type="text"
              name="username"
              autoComplete="username"
              value={email}
              readOnly
              tabIndex={-1}
              aria-hidden="true"
              style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
            />
            <input
              style={{ ...input, width: '100%', marginBottom: '1rem', letterSpacing: '0.15em' }}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="one-time-code"
              inputMode="numeric"
              name="otp"
              id="otp"
              placeholder="123456"
              autoFocus
              required
            />
            {error && <p style={{ color: 'crimson', margin: '0 0 0.75rem' }}>{error}</p>}
            <button type="submit" disabled={busy} style={{ ...btn, width: '100%' }}>{busy ? 'Verifying…' : 'Verify'}</button>
          </form>
          <button onClick={() => { setMfaToken(null); setCode(''); setError(null) }} style={{ ...ghost, width: '100%', marginTop: '0.6rem' }}>Back</button>
        </section>
      </Frame>
    )
  }

  return (
    <Frame>
      <section style={{ ...card, maxWidth: 380, marginTop: '1.5rem' }}>
        <h2 style={{ fontSize: '1rem', marginTop: 0 }}>Sign in</h2>
        <form onSubmit={submitPassword}>
          <label style={{ display: 'block', marginBottom: '0.75rem' }}>Email
            <input style={{ ...input, width: '100%', marginTop: 4 }} type="email" value={email} autoComplete="username" onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label style={{ display: 'block', marginBottom: '1rem' }}>Password
            <input style={{ ...input, width: '100%', marginTop: 4 }} type="password" value={password} autoComplete="current-password" onChange={(e) => setPassword(e.target.value)} required />
          </label>
          {error && <p style={{ color: 'crimson', margin: '0 0 0.75rem' }}>{error}</p>}
          <button type="submit" disabled={busy} style={{ ...btn, width: '100%' }}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
        {passkeysAvailable && (
          <>
            <div style={{ textAlign: 'center', color: '#666', margin: '0.9rem 0 0.6rem', fontSize: '0.85rem' }}>or</div>
            <button onClick={passkeyLogin} disabled={busy} style={{ ...ghost, width: '100%' }}>Sign in with a passkey</button>
          </>
        )}
      </section>
    </Frame>
  )
}

function AppShell({ me, onLogout, passkeysAvailable }: { me: Me; onLogout: () => void; passkeysAvailable: boolean }) {
  const [view, setView] = useState<'dashboard' | 'monitoring' | 'users' | 'account'>('dashboard')
  async function logout() { await fetch('/api/logout', { method: 'POST' }).catch(() => {}); onLogout() }
  const tab = (id: typeof view, label: string) => (
    <button onClick={() => setView(id)} style={{ ...ghost, borderColor: view === id ? '#2f6f4f' : '#333' }}>{label}</button>
  )
  return (
    <Frame>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '1rem 0 1.25rem', flexWrap: 'wrap', gap: '0.5rem' }}>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {tab('dashboard', 'Dashboard')}
          {tab('monitoring', 'Monitoring')}
          {me.role === 'admin' && tab('users', 'Users')}
          {tab('account', 'Account')}
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <span style={{ color: '#aaa' }}>{me.email} · <strong style={{ color: '#e6e6e6' }}>{me.role}</strong></span>
          <button onClick={logout} style={ghost}>Log out</button>
        </div>
      </div>
      {view === 'dashboard' && <DashboardView />}
      {view === 'monitoring' && <MonitoringView role={me.role} />}
      {view === 'users' && me.role === 'admin' && <UsersView />}
      {view === 'account' && <AccountView passkeysAvailable={passkeysAvailable} />}
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

function MonitoringView({ role }: { role: string }) {
  const [hosts, setHosts] = useState<Host[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [openId, setOpenId] = useState<string | null>(null)
  const canPause = role === 'admin' || role === 'helpdesk'

  function load(initial = false) {
    if (initial) setLoading(true)
    fetch('/api/hosts')
      .then(async (r) => { if (!r.ok) { setError(await errText(r, 'Failed to load hosts')); return } setHosts(await r.json()); setError(null) })
      .catch(() => setError('Failed to load hosts'))
      .finally(() => { if (initial) setLoading(false) })
  }
  useEffect(() => { load(true) }, [])

  async function togglePause(h: Host) {
    const method = h.paused ? 'DELETE' : 'POST'
    await fetch(`/api/hosts/${h.id}/pause`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? JSON.stringify({}) : undefined }).catch(() => {})
    load()
  }

  // A paused host is grey; otherwise its state colour, or grey when Zabbix-disabled.
  const dotColor = (h: Host) => (h.paused ? '#888' : h.enabled ? (stateColor[h.state] || '#777') : '#555')

  return (
    <section style={card}>
      <h2 style={{ fontSize: '1rem', marginTop: 0 }}>Hosts</h2>
      {loading && <p>Loading…</p>}
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      {!loading && !error && hosts.length === 0 && <p style={{ color: '#888' }}>No hosts found.</p>}
      <div style={{ display: 'grid', gap: '0.4rem' }}>
        {hosts.map((h) => (
          <div key={h.id}>
            <div
              role="button"
              tabIndex={0}
              onClick={() => setOpenId(openId === h.id ? null : h.id)}
              style={{ ...ghost, width: '100%', display: 'flex', alignItems: 'center', gap: '0.6rem', textAlign: 'left', cursor: 'pointer', boxSizing: 'border-box', opacity: h.paused ? 0.7 : 1, borderColor: openId === h.id ? '#2f6f4f' : '#333' }}
            >
              <span style={{ width: 10, height: 10, borderRadius: '50%', flexShrink: 0, background: dotColor(h) }} />
              <span style={{ fontWeight: 600 }}>{h.name}</span>
              {h.paused && <span style={{ color: '#999', fontSize: '0.8rem' }}>(paused)</span>}
              {!h.enabled && <span style={{ color: '#777', fontSize: '0.8rem' }}>(disabled)</span>}
              <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                {!h.paused && h.problems > 0 && (
                  <span style={{ color: stateColor[h.state] || '#aaa', fontSize: '0.85rem' }}>
                    {h.problems} problem{h.problems === 1 ? '' : 's'}
                  </span>
                )}
                {canPause && (
                  <button
                    onClick={(e) => { e.stopPropagation(); togglePause(h) }}
                    style={{ ...ghost, padding: '0.15rem 0.55rem', fontSize: '0.8rem' }}
                  >
                    {h.paused ? 'Resume' : 'Pause'}
                  </button>
                )}
              </span>
            </div>
            {openId === h.id && <HostItems hostId={h.id} />}
          </div>
        ))}
      </div>
    </section>
  )
}

function HostItems({ hostId }: { hostId: string }) {
  const [items, setItems] = useState<SensorItem[] | null>(null)
  const [problems, setProblems] = useState<Problem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [openItem, setOpenItem] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    setItems(null); setError(null)
    fetch(`/api/hosts/${hostId}/items${showAll ? '?all=1' : ''}`)
      .then(async (r) => { if (!r.ok) throw new Error('items'); return r.json() })
      .then((its: SensorItem[]) => setItems(its))
      .catch(() => setError('Failed to load sensors'))
  }, [hostId, showAll])

  function loadProblems() {
    fetch(`/api/hosts/${hostId}/problems`).then((r) => (r.ok ? r.json() : [])).then((p) => setProblems(p || [])).catch(() => {})
  }
  useEffect(() => { loadProblems() }, [hostId])

  async function ack(p: Problem) {
    await fetch(`/api/events/${p.event_id}/ack`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }).catch(() => {})
    loadProblems()
  }

  if (error) return <p style={{ color: 'crimson', margin: '0.4rem 0 0.8rem' }}>{error}</p>
  if (!items) return <p style={{ color: '#888', margin: '0.4rem 0 0.8rem' }}>Loading sensors…</p>

  // Map each problem-referenced item to its worst state, so we can highlight those rows.
  const itemState: Record<string, string> = {}
  for (const p of problems) {
    for (const id of p.item_ids) {
      if (!itemState[id] || stateRank[p.state] > stateRank[itemState[id]]) itemState[id] = p.state
    }
  }

  return (
    <div style={{ margin: '0.3rem 0 0.8rem' }}>
      {problems.length > 0 && (
        <div style={{ border: '1px solid #4a2a2a', background: '#1e1414', borderRadius: 6, padding: '0.5rem 0.75rem', marginBottom: '0.5rem' }}>
          <div style={{ color: '#c88', fontSize: '0.8rem', marginBottom: '0.25rem' }}>Active problems</div>
          {problems.map((p, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.2rem 0' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: stateColor[p.state] || '#aaa' }} />
              <span style={{ opacity: p.acknowledged ? 0.7 : 1 }}>{p.name}</span>
              <span style={{ marginLeft: 'auto' }}>
                {p.acknowledged
                  ? <span style={{ color: '#7fb894', fontSize: '0.8rem' }}>✓ acknowledged</span>
                  : <button onClick={() => ack(p)} style={{ ...ghost, padding: '0.15rem 0.55rem', fontSize: '0.8rem' }}>Acknowledge</button>}
              </span>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: '0.3rem', marginBottom: '0.4rem' }}>
        <button onClick={() => setShowAll(false)} style={{ ...ghost, padding: '0.2rem 0.6rem', fontSize: '0.82rem', borderColor: !showAll ? '#2f6f4f' : '#333' }}>Key sensors</button>
        <button onClick={() => setShowAll(true)} style={{ ...ghost, padding: '0.2rem 0.6rem', fontSize: '0.82rem', borderColor: showAll ? '#2f6f4f' : '#333' }}>All sensors</button>
      </div>
      {items.length === 0
        ? <p style={{ color: '#888', margin: '0.2rem 0 0.4rem' }}>{showAll ? 'No sensors.' : 'No recognized sensors — try “All sensors”.'}</p>
        : (
          <div style={{ border: '1px solid #262626', borderRadius: 6, overflow: 'hidden' }}>
            <table style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
              <colgroup>
                <col style={{ width: '32%' }} />
                <col />
                <col style={{ width: '110px' }} />
              </colgroup>
              <thead>
                <tr style={{ textAlign: 'left', color: '#aaa' }}>
                  <th style={{ padding: '0.4rem 0.6rem' }}>Sensor</th>
                  <th style={{ padding: '0.4rem 0.6rem' }}>Value</th>
                  <th style={{ padding: '0.4rem 0.6rem', whiteSpace: 'nowrap' }}>Last check</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, idx) => {
                  const st = itemState[it.id]
                  const open = openItem === it.id
                  const clickable = it.numeric && it.supported
                  const label = it.label || it.name
                  const newGroup = !showAll && it.category && it.category !== items[idx - 1]?.category
                  return (
                    <Fragment key={it.id}>
                      {newGroup && (
                        <tr>
                          <td colSpan={3} style={{ padding: '0.5rem 0.6rem 0.25rem', color: '#7fb894', fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.04em', borderTop: idx === 0 ? 'none' : '1px solid #262626' }}>{it.category}</td>
                        </tr>
                      )}
                      <tr
                        onClick={clickable ? () => setOpenItem(open ? null : it.id) : undefined}
                        style={{
                          borderTop: '1px solid #262626',
                          opacity: it.supported ? 1 : 0.55,
                          cursor: clickable ? 'pointer' : 'default',
                          background: open ? 'rgba(47,111,79,0.14)' : (st ? (st === 'error' ? 'rgba(180,40,40,0.16)' : 'rgba(217,164,65,0.14)') : undefined),
                        }}
                      >
                        <td style={{ padding: '0.4rem 0.6rem', wordBreak: 'break-word', borderLeft: `3px solid ${st ? stateColor[st] : 'transparent'}` }}>
                          {clickable && <span style={{ color: '#6a6', marginRight: '0.4rem', display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none' }}>›</span>}
                          {label}
                        </td>
                        <td style={{ padding: '0.4rem 0.6rem', wordBreak: 'break-word' }}>
                          {it.supported
                            ? (() => { const [dv, du] = readingParts(it.last_value, it.units); return <span><strong>{dv}</strong>{du ? ` ${du}` : ''}</span> })()
                            : <span style={{ color: '#c66' }}>not supported</span>}
                        </td>
                        <td style={{ padding: '0.4rem 0.6rem', color: '#999', whiteSpace: 'nowrap' }}>{relTime(it.last_clock)}</td>
                      </tr>
                      {open && clickable && (
                        <tr>
                          <td colSpan={3} style={{ padding: '0.4rem 0.6rem 0.8rem', background: '#141414', borderTop: '1px solid #262626' }}>
                            <SensorChart itemId={it.id} units={it.units} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
    </div>
  )
}

const GREEN = '#4fa06f'

function buildPlot(data: Series, units: string, width: number): [uPlot.Options, uPlot.AlignedData] {
  const xs = data.points.map((p) => p.t)
  const axisStroke = '#8a8a8a'
  const grid = { stroke: 'rgba(255,255,255,0.06)', width: 1 }
  const ticks = { stroke: 'rgba(255,255,255,0.06)', width: 1 }
  const scaled = scaledUnit(units)
  // Scaled y-axis ticks (bytes/bits/uptime); otherwise default numeric.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const yValues = scaled ? ((_u: any, splits: number[]) => splits.map((v) => fmtNum(v, units))) : undefined
  const yAxis: uPlot.Axis = { stroke: axisStroke, grid, ticks, size: 64, values: yValues as unknown as uPlot.Axis['values'] }
  const xAxis: uPlot.Axis = { stroke: axisStroke, grid, ticks }
  // Legend cells: show the hovered point, or fall back to the latest value when idle (so the
  // legend is never blank). unitLabel is dropped for scaled units since the value carries it.
  const unitLabel = scaled ? '' : units ? ` (${units})` : ''
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const xVal = (u: any, v: number | null) => { const t = v ?? lastVal(u, 0); return t == null ? '--' : new Date(t * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const yVal = (sidx: number) => (u: any, v: number | null) => { const n = v ?? lastVal(u, sidx); return n == null ? '--' : fmtNum(n, units) }
  const base: Partial<uPlot.Options> = { width, height: 260, scales: { x: { time: true } }, axes: [xAxis, yAxis], legend: { show: true } }

  if (data.kind === 'trend') {
    const avg = data.points.map((p) => (p.avg ?? null))
    const min = data.points.map((p) => (p.min ?? null))
    const max = data.points.map((p) => (p.max ?? null))
    const opts: uPlot.Options = {
      ...base,
      series: [
        { value: xVal },
        { label: `avg${unitLabel}`, stroke: GREEN, width: 1.5, value: yVal(1) },
        { label: 'min', stroke: 'rgba(79,160,111,0.4)', width: 1, value: yVal(2) },
        { label: 'max', stroke: 'rgba(79,160,111,0.4)', width: 1, value: yVal(3) },
      ],
      bands: [{ series: [3, 2], fill: 'rgba(79,160,111,0.12)' }],
    } as uPlot.Options
    return [opts, [xs, avg, min, max] as uPlot.AlignedData]
  }

  const vs = data.points.map((p) => (p.v ?? null))
  const opts: uPlot.Options = {
    ...base,
    series: [{ value: xVal }, { label: `value${unitLabel}`, stroke: GREEN, width: 1.5, fill: 'rgba(79,160,111,0.10)', value: yVal(1) }],
  } as uPlot.Options
  return [opts, [xs, vs] as uPlot.AlignedData]
}

function SensorChart({ itemId, units }: { itemId: string; units: string }) {
  const [range, setRange] = useState('2h')
  const [data, setData] = useState<Series | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const host = useRef<HTMLDivElement>(null)
  const plot = useRef<uPlot | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null)
    fetch(`/api/items/${itemId}/history?range=${range}`)
      .then(async (r) => { if (!r.ok) throw new Error(await errText(r, 'Failed to load history')); return r.json() })
      .then((d: Series) => { if (!cancelled) setData(d) })
      .catch((e) => { if (!cancelled) { setError(e.message || 'Failed to load history'); setData(null) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [itemId, range])

  useEffect(() => {
    if (plot.current) { plot.current.destroy(); plot.current = null }
    if (!host.current || !data || data.points.length === 0) return
    const width = host.current.clientWidth || 600
    const [opts, aligned] = buildPlot(data, units, width)
    plot.current = new uPlot(opts, aligned, host.current)
    return () => { if (plot.current) { plot.current.destroy(); plot.current = null } }
  }, [data, units])

  useEffect(() => {
    function onResize() { if (plot.current && host.current) plot.current.setSize({ width: host.current.clientWidth, height: 260 }) }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  return (
    <div>
      <div style={{ display: 'flex', gap: '0.3rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
        {RANGES.map((rk) => (
          <button key={rk} onClick={() => setRange(rk)} style={{ ...ghost, padding: '0.2rem 0.55rem', fontSize: '0.85rem', borderColor: range === rk ? '#2f6f4f' : '#333' }}>{rk}</button>
        ))}
      </div>
      {loading && <p style={{ color: '#888', margin: '0.3rem 0' }}>Loading…</p>}
      {error && <p style={{ color: 'crimson', margin: '0.3rem 0' }}>{error}</p>}
      {!loading && !error && data && data.points.length === 0 && <p style={{ color: '#888', margin: '0.3rem 0' }}>No data in this range.</p>}
      <div ref={host} style={{ width: '100%' }} />
    </div>
  )
}

function UsersView() {
  const [users, setUsers] = useState<User[]>([])
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [nu, setNu] = useState({ email: '', name: '', surname: '', role: 'viewer', password: '' })

  function load() { fetch('/api/users').then((r) => r.json()).then(setUsers).catch(() => setError('Failed to load users')) }
  useEffect(() => { load() }, [])

  async function fail(res: Response) { setError(await errText(res, 'Request failed')) }

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
  async function resetMfa(u: User) {
    setError(null); setMsg(null)
    if (!window.confirm(`Reset two-factor for ${u.email}? They'll sign in with just their password until they set it up again.`)) return
    const res = await fetch(`/api/users/${u.id}/mfa/reset`, { method: 'POST' })
    if (!res.ok) return fail(res)
    setMsg(`Two-factor reset for ${u.email}`); load()
  }
  async function resetPasskeys(u: User) {
    setError(null); setMsg(null)
    if (!window.confirm(`Remove all passkeys for ${u.email}?`)) return
    const res = await fetch(`/api/users/${u.id}/passkeys/reset`, { method: 'POST' })
    if (!res.ok) return fail(res)
    setMsg(`Passkeys removed for ${u.email}`); load()
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
              <th style={{ padding: '0.4rem 0.5rem' }}>2FA</th>
              <th style={{ padding: '0.4rem 0.5rem' }}>Passkeys</th>
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
                <td style={{ padding: '0.4rem 0.5rem' }}>
                  {u.mfa_enabled
                    ? <span style={{ color: 'seagreen', fontWeight: 600 }}>on</span>
                    : <span style={{ color: '#777' }}>off</span>}
                </td>
                <td style={{ padding: '0.4rem 0.5rem' }}>
                  {u.passkeys ? <span style={{ color: 'seagreen', fontWeight: 600 }}>{u.passkeys}</span> : <span style={{ color: '#777' }}>0</span>}
                </td>
                <td style={{ padding: '0.4rem 0.5rem', display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                  <button onClick={() => resetPw(u)} style={ghost}>Reset password</button>
                  {u.mfa_enabled && <button onClick={() => resetMfa(u)} style={ghost}>Reset 2FA</button>}
                  {!!u.passkeys && <button onClick={() => resetPasskeys(u)} style={ghost}>Reset passkeys</button>}
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

function AccountView({ passkeysAvailable }: { passkeysAvailable: boolean }) {
  return (
    <div style={{ display: 'grid', gap: '1.25rem' }}>
      <PasswordCard />
      <MfaCard />
      {passkeysAvailable && <PasskeyCard />}
    </div>
  )
}

function PasswordCard() {
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault(); setError(null); setMsg(null)
    const res = await fetch('/api/me/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ current_password: cur, new_password: next }) })
    if (!res.ok) { setError(await errText(res, 'Request failed')); return }
    setCur(''); setNext(''); setMsg('Password changed')
  }

  return (
    <section style={{ ...card, maxWidth: 480 }}>
      <h2 style={{ fontSize: '1rem', marginTop: 0 }}>Change my password</h2>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      {msg && <p style={{ color: 'seagreen' }}>{msg}</p>}
      <form onSubmit={submit}>
        <label style={{ display: 'block', marginBottom: '0.75rem' }}>Current password
          <input style={{ ...input, width: '100%', marginTop: 4 }} type="password" value={cur} autoComplete="current-password" onChange={(e) => setCur(e.target.value)} required />
        </label>
        <label style={{ display: 'block', marginBottom: '1rem' }}>New password (min 8)
          <input style={{ ...input, width: '100%', marginTop: 4 }} type="password" value={next} autoComplete="new-password" onChange={(e) => setNext(e.target.value)} required />
        </label>
        <button type="submit" style={btn}>Update password</button>
      </form>
    </section>
  )
}

type Enrollment = { secret: string; otpauth_url: string; qr_data_uri: string }

function MfaCard() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [remaining, setRemaining] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null)
  const [code, setCode] = useState('')
  const [codes, setCodes] = useState<string[] | null>(null)

  function loadStatus() {
    fetch('/api/me/mfa').then((r) => r.json()).then((d) => { setEnabled(d.enabled); setRemaining(d.recovery_codes_remaining || 0) }).catch(() => setError('Failed to load 2FA status'))
  }
  useEffect(() => { loadStatus() }, [])

  async function startSetup() {
    setError(null); setMsg(null); setCodes(null)
    const res = await fetch('/api/me/mfa/setup', { method: 'POST' })
    if (!res.ok) { setError(await errText(res, 'Could not start setup')); return }
    setEnrollment(await res.json())
  }
  async function confirmEnable(e: FormEvent) {
    e.preventDefault(); setError(null); setMsg(null)
    const res = await fetch('/api/me/mfa/enable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })
    if (!res.ok) { setError(await errText(res, 'Could not enable 2FA')); return }
    const d = await res.json()
    setEnrollment(null); setCode(''); setCodes(d.recovery_codes); setMsg('Two-factor is now on. Save your recovery codes.'); loadStatus()
  }
  async function disable() {
    setError(null); setMsg(null); setCodes(null)
    const pw = window.prompt('Confirm your password to turn off two-factor:')
    if (!pw) return
    const res = await fetch('/api/me/mfa/disable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) })
    if (!res.ok) { setError(await errText(res, 'Could not disable 2FA')); return }
    setMsg('Two-factor has been turned off.'); loadStatus()
  }
  async function regen() {
    setError(null); setMsg(null); setCodes(null)
    const pw = window.prompt('Confirm your password to generate new recovery codes:')
    if (!pw) return
    const res = await fetch('/api/me/mfa/recovery-codes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) })
    if (!res.ok) { setError(await errText(res, 'Could not regenerate codes')); return }
    const d = await res.json()
    setCodes(d.recovery_codes); setMsg('New recovery codes generated. The old ones no longer work.'); loadStatus()
  }

  return (
    <section style={{ ...card, maxWidth: 480 }}>
      <h2 style={{ fontSize: '1rem', marginTop: 0 }}>Two-factor authentication</h2>
      <p style={{ color: '#aaa', marginTop: 0 }}>Use an authenticator app or a password manager such as Bitwarden. Argus uses standard TOTP, so both scanning the QR and pasting the setup key work.</p>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      {msg && <p style={{ color: 'seagreen' }}>{msg}</p>}

      {enabled === null && <p>Checking…</p>}

      {codes && <RecoveryCodes codes={codes} />}

      {enabled === false && !enrollment && !codes && (
        <button onClick={startSetup} style={btn}>Enable two-factor</button>
      )}

      {enabled === false && enrollment && (
        <div>
          <p style={{ marginBottom: '0.5rem' }}>1. Scan this QR, or paste the setup key into Bitwarden:</p>
          <img src={enrollment.qr_data_uri} alt="TOTP QR code" style={{ borderRadius: 8, background: 'white', padding: 8 }} width={200} height={200} />
          <p style={{ margin: '0.75rem 0 0.25rem', color: '#aaa' }}>Setup key</p>
          <code style={{ display: 'block', wordBreak: 'break-all', background: '#111', border: '1px solid #333', borderRadius: 6, padding: '0.5rem', fontSize: '0.9rem' }}>{enrollment.secret}</code>
          <form onSubmit={confirmEnable} style={{ marginTop: '1rem' }}>
            <p style={{ marginBottom: '0.4rem' }}>2. Enter the current 6-digit code to confirm:</p>
            <input style={{ ...input, width: '100%', marginBottom: '0.75rem', letterSpacing: '0.15em' }} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" inputMode="numeric" name="otp" placeholder="123456" required />
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button type="submit" style={btn}>Confirm & enable</button>
              <button type="button" onClick={() => { setEnrollment(null); setCode(''); setError(null) }} style={ghost}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      {enabled === true && (
        <div>
          <p><strong style={{ color: 'seagreen' }}>On.</strong> <span style={{ color: '#aaa' }}>{remaining} recovery code{remaining === 1 ? '' : 's'} remaining.</span></p>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button onClick={regen} style={ghost}>Regenerate recovery codes</button>
            <button onClick={disable} style={{ ...ghost, borderColor: '#5a2a2a', color: '#e59' }}>Turn off</button>
          </div>
        </div>
      )}
    </section>
  )
}

function RecoveryCodes({ codes }: { codes: string[] }) {
  const text = codes.join('\n')
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      // navigator.clipboard only exists in a secure context (HTTPS/localhost); fall
      // back to execCommand so Copy still works over plain HTTP on a private IP.
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text)
      } else {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'; ta.style.opacity = '0'
        document.body.appendChild(ta); ta.focus(); ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      setCopied(true); setTimeout(() => setCopied(false), 2000)
    } catch { /* ignore */ }
  }
  function download() {
    const blob = new Blob([text + '\n'], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'argus-recovery-codes.txt'; a.click()
    URL.revokeObjectURL(url)
  }
  return (
    <div style={{ border: '1px solid #4a4a2a', background: '#1e1e14', borderRadius: 8, padding: '0.75rem 1rem', marginBottom: '1rem' }}>
      <p style={{ marginTop: 0, color: '#d9d97a' }}>Save these recovery codes now — each works once and they won't be shown again.</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.25rem 1rem', fontFamily: 'monospace', fontSize: '0.95rem' }}>
        {codes.map((c) => <span key={c}>{c}</span>)}
      </div>
      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
        <button onClick={copy} style={ghost}>{copied ? 'Copied!' : 'Copy'}</button>
        <button onClick={download} style={ghost}>Download</button>
      </div>
    </div>
  )
}

function PasskeyCard() {
  const [keys, setKeys] = useState<Passkey[]>([])
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function load() { fetch('/api/me/passkeys').then((r) => r.json()).then(setKeys).catch(() => setError('Failed to load passkeys')) }
  useEffect(() => { load() }, [])

  async function add() {
    setError(null); setMsg(null)
    const name = window.prompt('Name this passkey (e.g. "Bitwarden", "Phone", "YubiKey"):', 'Bitwarden')
    if (name === null) return
    setBusy(true)
    try {
      await registerPasskey(name || 'Passkey')
      setMsg('Passkey added'); load()
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not add passkey')
    } finally { setBusy(false) }
  }
  async function remove(k: Passkey) {
    setError(null); setMsg(null)
    if (!window.confirm(`Remove passkey "${k.name}"?`)) return
    const res = await fetch(`/api/me/passkeys/${k.id}`, { method: 'DELETE' })
    if (!res.ok) { setError(await errText(res, 'Could not remove passkey')); return }
    setMsg('Passkey removed'); load()
  }

  return (
    <section style={{ ...card, maxWidth: 560 }}>
      <h2 style={{ fontSize: '1rem', marginTop: 0 }}>Passkeys</h2>
      <p style={{ color: '#aaa', marginTop: 0 }}>Sign in without a password using a passkey stored in Bitwarden, your phone, or a security key. Passkeys work when you reach Argus through its HTTPS address.</p>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      {msg && <p style={{ color: 'seagreen' }}>{msg}</p>}

      {keys.length === 0 && <p style={{ color: '#888' }}>No passkeys registered yet.</p>}
      {keys.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 1rem' }}>
          {keys.map((k) => (
            <li key={k.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid #2a2a2a', padding: '0.5rem 0' }}>
              <span>
                <strong>{k.name}</strong>
                <span style={{ color: '#777', marginLeft: '0.5rem', fontSize: '0.85rem' }}>
                  added {new Date(k.created).toLocaleDateString()}
                  {k.last_used ? ` · last used ${new Date(k.last_used).toLocaleDateString()}` : ' · never used'}
                </span>
              </span>
              <button onClick={() => remove(k)} style={{ ...ghost, borderColor: '#5a2a2a', color: '#e59' }}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <button onClick={add} disabled={busy} style={btn}>{busy ? 'Waiting for authenticator…' : 'Add a passkey'}</button>
    </section>
  )
}
