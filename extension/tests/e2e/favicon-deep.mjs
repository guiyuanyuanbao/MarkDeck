// Deep-dive: what EXACTLY does _favicon/ return for the problem hosts, and
// what does the server hold for them? Byte-level comparison.
// Diagnostic only (no assertions). Default target is a LOCAL server on
// :8999 — this script once defaulted to the user's PRODUCTION server
// (mikanani.icu:8990), which no test should ever touch by accident; pass
// MD_SERVER explicitly if you really mean to probe a remote deployment.
'use strict'
import { chromium } from 'playwright-core'
import fs from 'fs'

const BASE = process.env.MD_SERVER || 'http://127.0.0.1:8999'
if (!process.env.MD_SERVER) {
  console.log('[favicon-deep] MD_SERVER not set — defaulting to local http://127.0.0.1:8999')
}
const PW = process.env.MD_PW || ''
const DIST = 'D:/Code/AiWorkSpace/ZCode/MarkDeck/extension/dist'
const TMP = 'C:/Users/admin/AppData/Local/Temp/md-favicon-deep'

async function api(method, p, body, cookie, csrf) {
  const r = await fetch(BASE + p, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), 'X-CSRF': csrf || '', Cookie: cookie || '' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: r.status, data: await r.json().catch(() => null), cookies: r.headers.getSetCookie() }
}

;(async () => {
  fs.mkdirSync(TMP, { recursive: true })
  // login to get a session for server-side probes
  let cookie = '', csrf = ''
  if (PW) {
    let s = await api('POST', '/api/auth/login', { password: PW })
    cookie = s.cookies.map(c => c.split(';')[0]).join('; ')
    csrf = s.data.csrf
  }

  const context = await chromium.launchPersistentContext(TMP + '-profile', {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  })
  let sw = null
  for (let i = 0; i < 30; i++) {
    const sws = context.serviceWorkers().filter(w => w.url().includes('background.js'))
    if (sws.length) { sw = sws[0]; break }
    await new Promise(r => setTimeout(r, 500))
  }
  if (!sw) throw new Error('no SW')

  // probe _favicon/ for the problem hosts INSIDE the extension (real chrome
  // favicon DB of this profile)
  const hosts = ['translate.google.com', 'mail.google.com', 'accounts.google.com']
  const out = await sw.evaluate(async (hosts) => {
    const results = []
    for (const h of hosts) {
      const url = chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent('https://' + h + '/')}&size=32`)
      const r = await fetch(url)
      const buf = new Uint8Array(await r.arrayBuffer())
      let h1 = 0x811c9dc5, h2 = 0x01000193
      for (let i = 0; i < buf.length; i++) {
        h1 = ((h1 ^ buf[i]) * 16777619) >>> 0
        h2 = ((h2 + buf[buf.length - 1 - i]) * 16777619) >>> 0
      }
      results.push({
        host: h, status: r.status, size: buf.byteLength,
        hash: `${buf.length}:${h1.toString(16)}${h2.toString(16)}`,
        isPng: buf[0] === 0x89,
        dims: buf[0] === 0x89 ? `${buf[16] << 8 | buf[17]}x${buf[20] << 8 | buf[21]}` : 'n/a',
      })
    }
    return results
  }, hosts)
  console.log('extension _favicon/ view:', JSON.stringify(out, null, 1))

  // server's stored bytes for the same hosts (needs session)
  if (PW) {
    for (const h of hosts) {
      const r = await fetch(BASE + '/api/favicon/' + h + '?probe=1', { headers: { Cookie: cookie } })
      if (r.status === 404) { console.log(`server ${h}: NOTHING STORED (404)`); continue }
      const buf = new Uint8Array(await r.arrayBuffer())
      let h1 = 0x811c9dc5, h2 = 0x01000193
      for (let i = 0; i < buf.length; i++) {
        h1 = ((h1 ^ buf[i]) * 16777619) >>> 0
        h2 = ((h2 + buf[buf.length - 1 - i]) * 16777619) >>> 0
      }
      const dims = buf[0] === 0x89 ? `${(buf[16] << 8) | buf[17]}x${(buf[20] << 8) | buf[21]}` : 'n/a'
      console.log(`server ${h}: status=${r.status} size=${buf.byteLength} hash=${buf.length}:${h1.toString(16)}${h2.toString(16)} dims=${dims}`)
    }
  }
  await context.close()
  console.log('DONE')
})().catch(e => { console.error('ERR', e.message); process.exit(1) })
