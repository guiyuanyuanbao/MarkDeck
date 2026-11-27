// Shared E2E harness helpers: server base, session bootstrap (setup/login +
// CSRF/cookie tracking) and the PASS/FAIL check accumulator. Previously each
// .mjs script carried its own ~15-line copy of this bootstrap.
export const BASE = 'http://127.0.0.1:8777'
// E2E-only password; the scripts run against a throwaway data dir
export const PW = 'E2eTest-Passw0rd!'

const results = []
export function check(name, ok, detail = '') {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}
export function summary() {
  const failed = results.filter((r) => !r).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  if (failed) process.exitCode = 1
}

let cookie = '', csrf = ''
// accessors for scripts that build raw fetch calls (multipart, favicon PUT,
// exports) outside api()
export const session = {
  get cookie() { return cookie },
  get csrf() { return csrf },
}
export async function api(method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' }
  if (csrf) headers['X-CSRF'] = csrf
  if (token) headers['Authorization'] = 'Bearer ' + token
  if (cookie) headers['Cookie'] = cookie
  const r = await fetch(BASE + p, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  })
  const sc = r.headers.get('set-cookie')
  if (sc) cookie = sc.split(';')[0]
  const t = await r.text()
  let d = null
  try { d = t ? JSON.parse(t) : null } catch { d = { raw: t } }
  return { status: r.status, data: d }
}

// fresh-DB bootstrap: setup (400 on re-runs = already set up) + login, which
// issues the session cookie and the CSRF token
export async function bootstrap() {
  const r = await api('POST', '/api/auth/setup', { password: PW })
  if (r.status !== 200 && r.status !== 400) {
    throw new Error(`setup failed: HTTP ${r.status} — is the server running on :8777 with a fresh data dir?`)
  }
  const l = await api('POST', '/api/auth/login', { password: PW })
  if (l.status !== 200) throw new Error(`login failed: HTTP ${l.status}`)
  csrf = l.data?.csrf || csrf
}
