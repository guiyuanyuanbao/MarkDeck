// E2E: real extension in real Playwright chromium against a real server.
// Verifies: extension loads, pairs, syncs bookmarks from/to the browser.
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

const results = []
function log(name, ok, detail = '') {
  results.push({ name, ok })
  console.log((ok ? '✓' : '✗ FAIL'), name, detail || '')
}

async function api(method, p, body, headers = {}) {
  const r = await fetch(SERVER + p, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: r.status, body: await r.text(), cookies: r.headers.getSetCookie() }
}

async function main() {
  console.log('== MarkDeck extension E2E (real chromium) ==')

  // E2E needs granted host_permissions (Playwright can't drive the runtime
  // permission prompt); patches dist/manifest.json, test-only, never shipped
  execSync(`node "${path.resolve(__dirname, '..', 'helpers', 'patch-manifest-e2e.js')}"`, { stdio: 'ignore' })

  // ---- fresh server ----
  try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
  await new Promise(r => setTimeout(r, 800))
  try { fs.rmSync('C:/Users/admin/AppData/Local/Temp/md-e2e', { recursive: true, force: true }) } catch {}
  const srv = spawn('D:/Code/AiWorkSpace/ZCode/MarkDeck/.tools/markdeck-test/markdeck-final.exe', [], {
    env: { ...process.env, MARKDECK_ADDR: '127.0.0.1:8999', MARKDECK_DATA: 'C:/Users/admin/AppData/Local/Temp/md-e2e' },
    stdio: 'ignore',
  })
  for (let i = 0; i < 30; i++) {
    try { await fetch(SERVER + '/api/auth/state'); break } catch { await new Promise(r => setTimeout(r, 300)) }
  }
  log('server started fresh', true)

  const state = JSON.parse((await api('GET', '/api/auth/state')).body)
  let l
  if (state.setup) l = await api('POST', '/api/auth/setup', { password: ADMIN_PW })
  else l = await api('POST', '/api/auth/login', { password: ADMIN_PW })
  if (l.status !== 200) throw new Error('auth: ' + l.body)
  const cookie = l.cookies[0].split(';')[0]
  const csrf = JSON.parse(l.body).csrf
  log('admin auth ready', true)

  // ---- server has a bookmark BEFORE the extension pairs ----
  const mk = await api('POST', '/api/bookmarks',
    { type: 'url', title: '服务器预置书签', url: 'https://preset.test/page' },
    { Cookie: cookie, 'X-CSRF': csrf })
  log('server pre-bookmark created', mk.status === 201)

  // ---- launch chromium with extension ----
  const userDataDir = 'C:/Users/admin/AppData/Local/Temp/md-e2e-profile'
  try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch {}
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    viewport: { width: 1280, height: 800 },
  })
  log('chromium launched with extension', true)

  // find SW
  let sw = null
  for (let i = 0; i < 30; i++) {
    const sws = context.serviceWorkers().filter(w => w.url().includes('background.js'))
    if (sws.length) { sw = sws[0]; break }
    await new Promise(r => setTimeout(r, 500))
  }
  if (!sw) throw new Error('extension SW not found')
  sw.on('console', msg => console.log('[SW]', msg.text()))
  log('extension service worker running', true)

  // ---- pair: Node does pair API, SW writes config, then triggers sync via hook ----
  const code = JSON.parse((await api('POST', '/api/pair-code', {}, { Cookie: cookie, 'X-CSRF': csrf })).body).code
  const pair = JSON.parse((await api('POST', '/api/pair', { code, name: 'E2E-Chromium' })).body)
  if (!pair.token) throw new Error('pair failed')
  log('paired via API', true)

  const pairResult = await sw.evaluate(async (cfg) => {
    await chrome.storage.local.set({ md_config: cfg })
    // trigger the full sync via the exposed hook
    if (typeof globalThis.__markdeckResync === 'function') {
      await globalThis.__markdeckResync()
      return { ok: true, via: 'hook' }
    }
    return { ok: false, via: 'no hook' }
  }, { server: SERVER, token: pair.token, deviceId: pair.deviceId, rev: 0 })
  log('pair + initial sync executed', pairResult.ok === true, JSON.stringify(pairResult))

  await new Promise(r => setTimeout(r, 1000))

  // ---- T1: server pre-bookmark now exists in browser bookmarks ----
  const browserTitles = await sw.evaluate(async () => {
    const tree = await chrome.bookmarks.getTree()
    const out = []
    const walk = (nodes) => { for (const n of nodes) { if (n.url) out.push(n.title); if (n.children) walk(n.children) } }
    for (const root of tree) if (root.children) walk(root.children)
    return out
  })
  log('T1: server bookmark loaded into browser', browserTitles.includes('服务器预置书签'),
    'browser titles: ' + JSON.stringify(browserTitles))
  const rawTree = await sw.evaluate(async () => {
    const tree = await chrome.bookmarks.getTree()
    return tree[0]?.children?.map(c => ({ id: c.id, title: c.title, kids: c.children?.length || 0 }))
  })
  console.log('[E2E] bookmarks roots:', JSON.stringify(rawTree))

  // ---- T2: browser bookmark creation syncs to server ----
  const created = await sw.evaluate(async () => {
    return await chrome.bookmarks.create({ parentId: '1', title: '浏览器新建E2E', url: 'https://browser.test/x' })
  })
  log('T2: browser bookmark created', !!created.id)
  // trigger sync via hook
  await sw.evaluate(() => globalThis.__markdeckResync())
  await new Promise(r => setTimeout(r, 3000))
  const tree = JSON.parse((await api('GET', '/api/bookmarks/tree', undefined, { Cookie: cookie })).body)
  log('T2: browser bookmark synced to server',
    tree.nodes.some(n => n.title === '浏览器新建E2E'))

  // ---- T3: server delete propagates to browser ----
  const target = tree.nodes.find(n => n.title === '服务器预置书签')
  if (target) {
    const delResp = await api('DELETE', `/api/bookmarks/${target.id}`, undefined, { Cookie: cookie, 'X-CSRF': csrf })
    log('T3 setup: server delete API', delResp.status === 200, 'status=' + delResp.status)
    await sw.evaluate(() => globalThis.__markdeckResync())
    await new Promise(r => setTimeout(r, 3000))
    // double resync: make sure pull happened
    await sw.evaluate(() => globalThis.__markdeckResync())
    await new Promise(r => setTimeout(r, 3000))
    const after = await sw.evaluate(async () => {
      const tree = await chrome.bookmarks.getTree()
      const out = []
      const walk = (nodes) => { for (const n of nodes) { if (n.url) out.push(n.title); if (n.children) walk(n.children) } }
      for (const root of tree) if (root.children) walk(root.children)
      return out
    })
    log('T3: server delete removed browser bookmark', !after.includes('服务器预置书签'),
      'after titles: ' + JSON.stringify(after))
  }

  // ---- T4: offline queue replay ----
  // Simulate disconnection: point config at a dead port, make local edits,
  // restore the real server, then verify the queue drains to the server.
  const offlineEdits = await sw.evaluate(async () => {
    const cfg = (await chrome.storage.local.get('md_config')).md_config
    await chrome.storage.local.set({ md_config: { ...cfg, server: 'http://127.0.0.1:1' } })
    await chrome.bookmarks.create({ parentId: '1', title: '离线新增E2E', url: 'https://offline.test/a' })
    // let the debounced flush attempt fail against the dead port
    await new Promise(r => setTimeout(r, 2500))
    const q = (await chrome.storage.local.get('md_queue')).md_queue || []
    await chrome.storage.local.set({ md_config: cfg })
    return { queued: q.length }
  })
  log('T4 setup: offline edit queued while unreachable', offlineEdits.queued > 0,
    'queue depth: ' + offlineEdits.queued)
  await sw.evaluate(() => globalThis.__markdeckResync())
  await new Promise(r => setTimeout(r, 3000))
  const serverTree = JSON.parse((await api('GET', '/api/bookmarks/tree', undefined, { Cookie: cookie })).body)
  log('T4: offline edit replayed to server after reconnect',
    serverTree.nodes.some(n => n.title === '离线新增E2E'))
  const qAfter = await sw.evaluate(async () =>
    ((await chrome.storage.local.get('md_queue')).md_queue || []).length)
  log('T4: queue drained', qAfter === 0, 'remaining: ' + qAfter)

  // ---- T5: server-side device revocation -> extension must show unauthorized ----
  const devices = JSON.parse((await api('GET', '/api/devices', undefined, { Cookie: cookie })).body)
  const devList = Array.isArray(devices) ? devices : devices.devices || []
  const e2eDev = devList.find(d => d.name === 'E2E-Chromium')
  log('T5 setup: device listed', !!e2eDev, JSON.stringify(devList.map(d => d.name)))
  if (e2eDev) {
    const revResp = await api('DELETE', `/api/devices/${e2eDev.id}`, undefined, { Cookie: cookie, 'X-CSRF': csrf })
    log('T5 setup: device revoked via API', revResp.status === 200 || revResp.status === 204, 'status=' + revResp.status)
    await sw.evaluate(() => globalThis.__markdeckResync())
    await new Promise(r => setTimeout(r, 2000))
    const status = await sw.evaluate(async () =>
      (await chrome.storage.local.get('md_status')).md_status)
    log('T5: extension status shows unauthorized after revocation', status === 'unauthorized', 'status=' + status)
  }

  console.log('\n=== E2E RESULT ===')
  console.log(`${results.filter(r => r.ok).length} passed, ${results.filter(r => !r.ok).length} failed`)
  await context.close()
  try { srv.kill() } catch {}
  try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
  process.exit(results.every(r => r.ok) ? 0 : 1)
}

main().catch(e => { console.error('E2E_FATAL', e); process.exit(2) })
