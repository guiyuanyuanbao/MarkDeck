// Shared E2E harness: server boot, auth, extension load, pairing, probing.
// Extracted from the ~50 identical bootstrap lines each suite copy-pasted
// (8 suites, 3 ports, 2 data dirs — the drift was a maintenance hazard).
'use strict'
import { execSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..', '..', '..')
const BIN = 'D:/Code/AiWorkSpace/ZCode/MarkDeck/.tools/markdeck-test/markdeck-final.exe'
const TEMP = 'C:/Users/admin/AppData/Local/Temp'

export const TEST_PASSWORD = process.env.MARKDECK_TEST_PASSWORD || 'markdeck-e2e-pass'

export async function bootServer({ port = 8999, dataDir = 'md-e2e' } = {}) {
  execSync('taskkill /F /IM markdeck-final.exe 2>nul', { shell: 'cmd.exe', stdio: 'ignore' })
  await new Promise((r) => setTimeout(r, 1500))
  const dir = path.join(TEMP, dataDir)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(dir + '-profile', { recursive: true, force: true })
  const proc = spawn(BIN, [], {
    env: { ...process.env, MARKDECK_ADDR: '127.0.0.1:' + port, MARKDECK_DATA: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stdout.on('data', (d) => process.env.MD_E2E_DEBUG && console.log('[srv]', String(d).trim()))
  proc.stderr.on('data', (d) => process.env.MD_E2E_DEBUG && console.error('[srv!]', String(d).trim()))
  const base = 'http://127.0.0.1:' + port
  let state = null
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(base + '/api/auth/state')
      if (r.ok) { state = await r.json(); break }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  if (!state) throw new Error('server did not come up on ' + base)
  return { proc, base, state, dataDir: dir }
}

export async function adminLogin(base) {
  const r = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: TEST_PASSWORD }),
  })
  if (!r.ok) throw new Error('login failed: ' + r.status)
  const cookie = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ')
  const { csrf } = await r.json()
  return { cookie, csrf }
}

export async function adminApi(base, { cookie, csrf }, method, path, body) {
  const r = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-CSRF': csrf, Cookie: cookie },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return { status: r.status, data: r.headers.get('content-type')?.includes('json') ? await r.json() : null }
}

// mint a pairing code + exchange it exactly like the extension does
export async function makePair(base, session, deviceName) {
  const { status, data } = await adminApi(base, session, 'POST', '/api/pair-code')
  if (status !== 200) throw new Error('pair-code failed: ' + status)
  const r = await fetch(base + '/api/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: data.code, name: deviceName }),
  })
  if (!r.ok) throw new Error('pair exchange failed: ' + r.status)
  return await r.json() // { deviceId, token }
}
