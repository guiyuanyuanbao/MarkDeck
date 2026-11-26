// Real-data E2E: imports the user's actual Netscape export (100 bookmarks,
// 11 folders incl. file:// links and intranet IPs) into the server via the
// HTML import API, then verifies the extension pulls and applies EVERY one
// — no silent drops, folder structure intact.
'use strict'
import { chromium } from 'playwright-core'
import { spawn, execSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVER = process.env.MARKDECK_TEST_SERVER || 'http://127.0.0.1:8999'
const ADMIN_PW = process.env.MARKDECK_TEST_PASSWORD || 'markdeck-demo-2026'
const DIST = path.resolve(__dirname, '..', '..', 'dist')
const FIXTURE = path.join(__dirname, 'fixtures', 'user-bookmarks.html')

const results = []
function log(name, ok, detail = '') {
  results.push({ name, ok })
  console.log((ok ? '✓' : '✗ FAIL'), name, detail || '')
}

async function api(method, p, body, headers = {}, isForm = false) {
  const r = await fetch(SERVER + p, {
    method,
    headers: isForm ? headers : { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: isForm ? body : (body ? JSON.stringify(body) : undefined),
  })
  return { status: r.status, body: await r.text(), cookies: r.headers.getSetCookie() }
}

const browserNodeByTitle = (sw, title) => sw.evaluate(async (t) => {
  const tree = await chrome.bookmarks.getTree()
  let found = null
  const walk = (nodes) => { for (const n of nodes) { if (n.title === t && !found) found = n; if (n.children) walk(n.children) } }
  for (const root of tree) if (root.children) walk(root.children)
  return found ? { id: found.id, parentId: found.parentId, title: found.title, url: found.url } : null
}, title)

async function main() {
  console.log('== MarkDeck real-data import E2E (user export) ==')
  // the fixture is PERSONAL data, gitignored, local-only by design
  if (!fs.existsSync(FIXTURE)) {
    console.log('SKIP: fixtures/user-bookmarks.html not present (personal data, gitignored).')
    console.log('To run locally, place your Netscape export at:')
    console.log('  ' + FIXTURE)
    process.exit(0)
  }
  execSync(`node "${path.resolve(__dirname, '..', 'helpers', 'patch-manifest-e2e.js')}"`, { stdio: 'ignore' })

  try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
  await new Promise(r => setTimeout(r, 800))
  try { fs.rmSync('C:/Users/admin/AppData/Local/Temp/md-real', { recursive: true, force: true }) } catch {}
  const srv = spawn('D:/Code/AiWorkSpace/ZCode/MarkDeck/.tools/markdeck-test/markdeck-final.exe', [], {
    env: { ...process.env, MARKDECK_ADDR: '127.0.0.1:8999', MARKDECK_DATA: 'C:/Users/admin/AppData/Local/Temp/md-real' },
    stdio: 'ignore',
  })
  for (let i = 0; i < 30; i++) {
    try { await fetch(SERVER + '/api/auth/state'); break } catch { await new Promise(r => setTimeout(r, 300)) }
  }
  const state = JSON.parse((await api('GET', '/api/auth/state')).body)
  const l = state.setup
    ? await api('POST', '/api/auth/setup', { password: ADMIN_PW })
    : await api('POST', '/api/auth/login', { password: ADMIN_PW })
  const cookie = l.cookies[0].split(';')[0]
  const csrf = JSON.parse(l.body).csrf
  const H = { Cookie: cookie, 'X-CSRF': csrf }
  log('server + auth ready', true)

  // ---- import the real export through the HTML import API (merge mode) ----
  const form = new FormData()
  form.append('file', new Blob([fs.readFileSync(FIXTURE)], { type: 'text/html' }), 'bookmarks.html')
  const imp = await api('POST', '/api/import/html?mode=merge', form, { Cookie: cookie, 'X-CSRF': csrf }, true)
  const impRes = JSON.parse(imp.body || '{}')
  log('import HTML accepted', imp.status === 200, JSON.stringify(impRes).slice(0, 120))

  // parse the fixture for expected urls
  const html = fs.readFileSync(FIXTURE, 'utf8')
  const expectedUrls = [...html.matchAll(/HREF="([^"]+)"/g)].map(m => m[1])
  const expectedFolders = [...html.matchAll(/<H3[^>]*>([^<]+)<\/H3>/g)].map(m => m[1].trim())
  log('fixture parsed', expectedUrls.length === 100 && expectedFolders.length === 11,
    `urls=${expectedUrls.length} folders=${expectedFolders.length}`)

  const nodes = JSON.parse((await api('GET', '/api/bookmarks/tree', undefined, { Cookie: cookie })).body).nodes
  const srvUrls = new Set(nodes.filter(n => n.type === 'url').map(n => n.url))
  const missingOnServer = expectedUrls.filter(u => !srvUrls.has(u))
  log('R1: ALL 100 urls imported to server (incl. file://)', missingOnServer.length === 0,
    'missing=' + JSON.stringify(missingOnServer.slice(0, 3)))

  // ---- pair extension through real options UI ----
  const userDataDir = 'C:/Users/admin/AppData/Local/Temp/md-real-profile'
  try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch {}
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    viewport: { width: 1280, height: 800 },
  })
  let sw = null
  for (let i = 0; i < 30; i++) {
    const sws = context.serviceWorkers().filter(w => w.url().includes('background.js'))
    if (sws.length) { sw = sws[0]; break }
    await new Promise(r => setTimeout(r, 500))
  }
  if (!sw) throw new Error('extension SW not found')
  const code = JSON.parse((await api('POST', '/api/pair-code', {}, H)).body).code
  const extId = new URL(sw.url()).host
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extId}/options.html`)
  await page.fill('#server', SERVER)
  await page.fill('#code', code)
  await page.click('#pairBtn')
  for (let i = 0; i < 30; i++) {
    const m = await page.textContent('#pairMsg')
    if (m.includes('配对成功') || m.includes('配对失败')) break
    await new Promise(r => setTimeout(r, 500))
  }
  await page.close()
  log('extension paired', true)
  await new Promise(r => setTimeout(r, 4000)) // initial import + first pull

  // ---- R2: every server URL must exist in the browser ----
  const allBrowserUrls = new Set()
  const collect = await sw.evaluate(async () => {
    const tree = await chrome.bookmarks.getTree()
    const urls = []
    const walk = (ns) => { for (const x of ns) { if (x.url) urls.push(x.url); if (x.children) walk(x.children) } }
    for (const root of tree) if (root.children) walk(root.children)
    return urls
  })
  collect.forEach(u => allBrowserUrls.add(u))
  const missingInBrowser = [...srvUrls].filter(u => !allBrowserUrls.has(u))
  log('R2: ALL server urls present in browser',
    missingInBrowser.length === 0,
    'missing=' + missingInBrowser.length + ' ' + JSON.stringify(missingInBrowser.slice(0, 4)))
  const getSw = async () => {
    const sws = context.serviceWorkers().filter(w => w.url().includes('background.js'))
    if (sws.length) return sws[0]
    // SW idle-killed: opening any chrome-extension:// page forces the SW up
    const p = await context.newPage()
    await p.goto(`chrome-extension://${extId}/options.html`)
    for (let i = 0; i < 20; i++) {
      const s = context.serviceWorkers().filter(w => w.url().includes('background.js'))
      if (s.length) { await p.close(); return s[0] }
      await new Promise(r => setTimeout(r, 400))
    }
    await p.close()
    throw new Error('SW did not revive')
  }
  // applyStats must be requested from a page context (SW cannot message itself)
  const diagPage = await context.newPage()
  await diagPage.goto(`chrome-extension://${extId}/options.html`)
  await diagPage.waitForTimeout(600)
  const stats = await diagPage.evaluate(async () => {
    return chrome.runtime.sendMessage({ type: 'applyStats' }).catch(e => ({ error: String(e) }))
  })
  log('R2b: apply audit available', !!stats && !stats.error, JSON.stringify(stats).slice(0, 140))
  await diagPage.close()

  // ---- R3: folder structure preserved (a known nested folder) ----
  const folder = await browserNodeByTitle(sw, '北邮')
  const child = await browserNodeByTitle(sw, 'Your Projects - Overleaf, Online LaTeX Editor')
  log('R3: nested folder structure intact',
    !!folder && !folder.url && !!child && child.parentId === folder.id,
    `folder=${folder?.id} child.parent=${child?.parentId}`)

  // ---- R4: bidirectional spot check — web edit reaches browser ----
  const victim = nodes.find(n => n.title === 'Gmail')
  await api('PUT', `/api/bookmarks/${victim.id}`, { title: 'Gmail-改名验证' }, H)
  let renamed = false
  for (let i = 0; i < 20; i++) {
    const n = await browserNodeByTitle(sw, 'Gmail-改名验证')
    if (n) { renamed = true; break }
    await new Promise(r => setTimeout(r, 500))
  }
  log('R4: web rename reaches browser in realtime', renamed)

  // ---- R5: browser-side quick save with a weird URL (file://) round-trips ----
  // sendMessage must originate from a PAGE (options/popup), not the SW itself:
  // MV3 forbids SW->SW self-messaging ("Receiving end does not exist")
  const r5page = await context.newPage()
  await r5page.goto(`chrome-extension://${extId}/options.html`)
  await r5page.waitForTimeout(600)
  let saved
  try {
    saved = await r5page.evaluate(async () =>
      await chrome.runtime.sendMessage({
        type: 'saveCurrent', url: 'file:///C:/Users/admin/test-dir/file-e2e.txt', title: 'file协议E2E书签', tags: 'e2e',
      }))
  } catch (e) { saved = { ok: false, error: String(e) } }
  log('R5 setup: file:// quick-save accepted', saved?.ok === true, JSON.stringify(saved))
  let fileOnServer = false
  for (let i = 0; i < 20; i++) {
    const t = JSON.parse((await api('GET', '/api/bookmarks/tree', undefined, { Cookie: cookie })).body).nodes
    if (t.some(n => n.url === 'file:///C:/Users/admin/test-dir/file-e2e.txt')) { fileOnServer = true; break }
    await new Promise(r => setTimeout(r, 500))
  }
  log('R5: file:// bookmark round-trips browser→server', fileOnServer)
  await r5page.close()

  console.log('\n=== REAL-DATA E2E RESULT ===')
  console.log(`${results.filter(r => r.ok).length} passed, ${results.filter(r => !r.ok).length} failed`)
  await context.close()
  try { srv.kill() } catch {}
  try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
  process.exit(results.every(r => r.ok) ? 0 : 1)
}

main().catch(e => { console.error('E2E_FATAL', e); process.exit(2) })
