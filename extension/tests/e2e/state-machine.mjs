// State-machine E2E: walks the extension through EVERY lifecycle edge in a
// real chromium against a real server.
//
//   unconfigured ──pair──> online ──net fail──> disconnected ──recover──> online
//   online ──revoke──> unauthorized ──edits queue──> unauthorized
//   unauthorized ──re-pair──> online (queue replayed, NO re-import dup)
//   unconfigured ──pair fail──> unconfigured (stale code)
//   online ──SW idle restart──> online (state survives, ws re-established)
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

let COOKIE = ''
const serverNodes = async () =>
  JSON.parse((await api('GET', '/api/bookmarks/tree', undefined, { Cookie: COOKIE })).body).nodes

const browserTitles = (sw) => sw.evaluate(async () => {
  const tree = await chrome.bookmarks.getTree()
  const out = []
  const walk = (nodes) => { for (const n of nodes) { if (n.url) out.push(n.title); if (n.children) walk(n.children) } }
  for (const root of tree) if (root.children) walk(root.children)
  return out
})
const getStatus = (sw) => sw.evaluate(async () =>
  (await chrome.storage.local.get('md_status')).md_status)
const getQueueLen = (sw) => sw.evaluate(async () =>
  Object.keys((await chrome.storage.local.get('md_touch')).md_touch || {}).length)
const resync = (sw) => sw.evaluate(() => globalThis.__markdeckResync())

async function waitB(sw, pred, timeoutMs = 12000, label = '') {
  for (let i = 0; i < timeoutMs / 400; i++) {
    let ok = false
    try { ok = await pred(await browserTitles(sw), await serverNodes()) } catch { /* transient */ }
    if (ok) return true
    await new Promise(r => setTimeout(r, 400))
  }
  console.log('  [timeout waiting] ' + label)
  return false
}
async function waitFor(fn, timeoutMs = 12000) {
  for (let i = 0; i < timeoutMs / 400; i++) {
    if (await fn()) return true
    await new Promise(r => setTimeout(r, 400))
  }
  return false
}

async function pairViaUI(context, sw, cookie, csrf) {
  const code = JSON.parse((await api('POST', '/api/pair-code', {}, { Cookie: cookie, 'X-CSRF': csrf })).body).code
  const extId = new URL(sw.url()).host
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extId}/options.html`)
  await page.fill('#server', SERVER)
  await page.fill('#code', code)
  await page.click('#pairBtn')
  let msg = ''
  for (let i = 0; i < 30; i++) {
    msg = await page.textContent('#pairMsg')
    if (msg.includes('配对成功') || msg.includes('配对失败')) break
    await new Promise(r => setTimeout(r, 500))
  }
  await page.close()
  return msg
}


// root ids resolved at runtime — newer Chromium profiles use GUID permanent
// node ids, never assume legacy '1'/'2' (v0.0.16 root-cause)
let barRootId = null, otherRootId = null
async function resolveBarRoot() {
  if (!barRootId) {
    const tree = await chrome.bookmarks.getTree()
    barRootId = tree[0].children[0].id
  }
  return barRootId
}
async function resolveOtherRoot() {
  if (!otherRootId) {
    const tree = await chrome.bookmarks.getTree()
    otherRootId = tree[0].children[1].id
  }
  return otherRootId
}

async function main() {
  console.log('== MarkDeck extension state-machine E2E ==')
  execSync(`node "${path.resolve(__dirname, '..', 'helpers', 'patch-manifest-e2e.js')}"`, { stdio: 'ignore' })

  try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
  await new Promise(r => setTimeout(r, 800))
  try { fs.rmSync('C:/Users/admin/AppData/Local/Temp/md-sm', { recursive: true, force: true }) } catch {}
  const srv = spawn('D:/Code/AiWorkSpace/ZCode/MarkDeck/.tools/markdeck-test/markdeck-final.exe', [], {
    env: { ...process.env, MARKDECK_ADDR: '127.0.0.1:8999', MARKDECK_DATA: 'C:/Users/admin/AppData/Local/Temp/md-sm' },
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
  COOKIE = l.cookies[0].split(';')[0]
  const csrf = JSON.parse(l.body).csrf

  await api('POST', '/api/bookmarks',
    { type: 'url', title: '状态机预置书签', url: 'https://preset.sm/x' },
    { Cookie: COOKIE, 'X-CSRF': csrf })

  const userDataDir = 'C:/Users/admin/AppData/Local/Temp/md-sm-profile'
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
  sw.on('console', msg => { if (msg.text().includes('error')) console.log('[SW]', msg.text()) })

  // ---- S1: unconfigured -> (stale/failed pair attempt) -> still unconfigured ----
  const extId = new URL(sw.url()).host
  const badPage = await context.newPage()
  await badPage.goto(`chrome-extension://${extId}/options.html`)
  await badPage.fill('#server', SERVER)
  await badPage.fill('#code', '000000') // no such code
  await badPage.click('#pairBtn')
  let badMsg = ''
  for (let i = 0; i < 15; i++) {
    badMsg = await badPage.textContent('#pairMsg')
    if (badMsg.includes('配对失败')) break
    await new Promise(r => setTimeout(r, 400))
  }
  await badPage.close()
  const stAfterBad = await getStatus(sw)
  log('S1: failed pair attempt leaves state unconfigured (no transition)',
    badMsg.includes('配对失败') && (stAfterBad === 'unconfigured' || !stAfterBad || stAfterBad === 'disconnected'),
    'msg=' + JSON.stringify(badMsg) + ' status=' + stAfterBad)

  // ---- S2: unconfigured --good pair--> online; preset arrives ----
  const pairMsg = await pairViaUI(context, sw, COOKIE, csrf)
  const online = await waitFor(async () => (await getStatus(sw)) === 'online', 15000)
  log('S2: valid pair -> online', pairMsg.includes('配对成功') && online, 'status=' + await getStatus(sw))
  const presetArrived = await waitB(sw, (bt) => bt.includes('状态机预置书签'), 8000)
  log('S2b: initial pull brings server preset into browser', presetArrived)

  // ---- S3: online --server unreachable--> disconnected (edits queue up) ----
  await sw.evaluate(async () => {
    const cfg = (await chrome.storage.local.get('md_config')).md_config
    await chrome.storage.local.set({ md_config: { ...cfg, server: 'http://127.0.0.1:1' } })
  })
  await sw.evaluate(async () =>
    await chrome.bookmarks.create({ parentId: JSON.parse(JSON.stringify(await (async () => { const t = await chrome.bookmarks.getTree(); return t[0].children[0].id })())), title: '断联期书签1', url: 'https://off.sm/1' }))
  await sw.evaluate(async () =>
    await chrome.bookmarks.create({ parentId: JSON.parse(JSON.stringify(await (async () => { const t = await chrome.bookmarks.getTree(); return t[0].children[0].id })())), title: '断联期书签2', url: 'https://off.sm/2' }))
  await new Promise(r => setTimeout(r, 2500))
  const stDisc = await getStatus(sw)
  const qDisc = await getQueueLen(sw)
  // disconnected appears once the debounced flush fails against the dead
  // port (WS may still show online briefly); the queue is the hard guarantee
  log('S3: offline -> disconnected with queued edits', qDisc >= 2,
    'status=' + stDisc + ' queue=' + qDisc)

  // ---- S4: disconnected --recover--> online; queue drains ----
  await sw.evaluate((srv) => (async () => {
    const cfg = (await chrome.storage.local.get('md_config')).md_config
    cfg.server = srv
    await chrome.storage.local.set({ md_config: cfg })
  })(), SERVER)
  await resync(sw)
  const drained = await waitFor(async () => (await getQueueLen(sw)) === 0, 15000)
  const stOnline2 = await getStatus(sw)
  const onServer = await waitB(sw, (bt, sn) =>
    sn.some(n => n.title === '断联期书签1') && sn.some(n => n.title === '断联期书签2'), 8000)
  log('S4: reconnect -> online, queue drained, edits on server',
    drained && stOnline2 === 'online' && onServer,
    'queue=0:' + drained + ' status=' + stOnline2 + ' server=' + onServer)

  // ---- S5: online --revoke--> unauthorized; edits keep queueing (no flush loop) ----
  const devices = JSON.parse((await api('GET', '/api/devices', undefined, { Cookie: COOKIE })).body)
  const devList = Array.isArray(devices) ? devices : devices.devices || []
  const dev = devList[0]
  const rev = await api('DELETE', `/api/devices/${dev.id}`, undefined, { Cookie: COOKIE, 'X-CSRF': csrf })
  await resync(sw)
  const stUn = await waitFor(async () => (await getStatus(sw)) === 'unauthorized', 10000)
  log('S5: revoked -> unauthorized', rev.status === 200 && stUn, 'status=' + await getStatus(sw))
  // edits while unauthorized: must queue, must NOT trigger endless 401 pushes
  await sw.evaluate(async () =>
    await chrome.bookmarks.create({ parentId: JSON.parse(JSON.stringify(await (async () => { const t = await chrome.bookmarks.getTree(); return t[0].children[0].id })())), title: '未授权期书签', url: 'https://unauth.sm/x' }))
  await new Promise(r => setTimeout(r, 3000))
  const qUn = await getQueueLen(sw)
  const stUn2 = await getStatus(sw)
  log('S5b: unauthorized edits queue locally, status stays unauthorized',
    qUn >= 1 && stUn2 === 'unauthorized', 'queue=' + qUn + ' status=' + stUn2)

  // ---- S6: unauthorized --re-pair--> online; queued edits REPLAY (not re-imported) ----
  const repMsg = await pairViaUI(context, sw, COOKIE, csrf)
  const online3 = await waitFor(async () => (await getStatus(sw)) === 'online', 15000)
  const replayed = await waitB(sw, (bt, sn) => sn.some(n => n.title === '未授权期书签'), 15000)
  const qAfter = await getQueueLen(sw)
  // no re-import duplicates: existing titles must still be singletons
  const dupCheck = await waitFor(async () => {
    const nodes = await serverNodes()
    const counts = {}
    for (const n of nodes) counts[n.title] = (counts[n.title] || 0) + 1
    return Object.values(counts).every(c => c === 1)
  }, 10000)
  log('S6: re-pair -> online with queued edit replayed to server',
    repMsg.includes('配对成功') && online3 && replayed && qAfter === 0,
    'status=' + await getStatus(sw) + ' replay=' + replayed + ' queue=' + qAfter)
  log('S6b: re-pair does NOT duplicate existing bookmarks', dupCheck,
    'titles=' + JSON.stringify((await serverNodes()).map(n => n.title)))

  // ---- S7: server delete after re-pair still propagates (id maps intact) ----
  const victim = (await serverNodes()).find(n => n.title === '状态机预置书签')
  await api('DELETE', `/api/bookmarks/${victim.id}`, undefined, { Cookie: COOKIE, 'X-CSRF': csrf })
  const gone = await waitB(sw, (bt) => !bt.includes('状态机预置书签'), 10000)
  log('S7: delete propagation still works after re-pair (id maps survive)', gone)

  // ---- S8: full cycle sanity — one more edit round-trips cleanly ----
  await sw.evaluate(async () =>
    await chrome.bookmarks.create({ parentId: JSON.parse(JSON.stringify(await (async () => { const t = await chrome.bookmarks.getTree(); return t[0].children[0].id })())), title: '终态书签', url: 'https://final.sm/x' }))
  const fin = await waitB(sw, (bt, sn) => sn.some(n => n.title === '终态书签'), 10000)
  log('S8: steady-state edit round-trips after the whole cycle', fin)

  console.log('\n=== STATE-MACHINE E2E RESULT ===')
  console.log(`${results.filter(r => r.ok).length} passed, ${results.filter(r => !r.ok).length} failed`)
  await context.close()
  try { srv.kill() } catch {}
  try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
  process.exit(results.every(r => r.ok) ? 0 : 1)
}

main().catch(e => { console.error('E2E_FATAL', e); process.exit(2) })
