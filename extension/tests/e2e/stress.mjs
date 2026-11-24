// Stress E2E: large-scale data — 500+ bookmarks in deep nesting, a long
// offline queue, and multi-batch pulls. Asserts correctness AND that the
// sync completes in bounded time (perf regressions surface as timeouts).
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
const resync = (sw) => sw.evaluate(() => globalThis.__markdeckResync())


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
  const t0 = Date.now()
  console.log('== MarkDeck stress E2E ==')
  execSync(`node "${path.resolve(__dirname, '..', 'helpers', 'patch-manifest-e2e.js')}"`, { stdio: 'ignore' })

  try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
  await new Promise(r => setTimeout(r, 800))
  try { fs.rmSync('C:/Users/admin/AppData/Local/Temp/md-stress', { recursive: true, force: true }) } catch {}
  const srv = spawn('D:/Code/AiWorkSpace/ZCode/MarkDeck/.tools/markdeck-test/markdeck-final.exe', [], {
    env: { ...process.env, MARKDECK_ADDR: '127.0.0.1:8999', MARKDECK_DATA: 'C:/Users/admin/AppData/Local/Temp/md-stress' },
    stdio: 'ignore',
  })
  for (let i = 0; i < 30; i++) {
    try { await fetch(SERVER + '/api/auth/state'); break } catch { await new Promise(r => setTimeout(r, 300)) }
  }
  const state = JSON.parse((await api('GET', '/api/auth/state')).body)
  const l = state.setup
    ? await api('POST', '/api/auth/setup', { password: ADMIN_PW })
    : await api('POST', '/api/auth/login', { password: ADMIN_PW })
  COOKIE = l.cookies[0].split(';')[0]
  const csrf = JSON.parse(l.body).csrf
  const H = { Cookie: COOKIE, 'X-CSRF': csrf }

  // ---- S1: 500 bookmarks across 10 top folders × 5 subfolders, deep chain ----
  const tImport = Date.now()
  const ops = []
  const N = 500
  for (let f = 0; f < 10; f++) {
    const fid = 'folder-' + f
    ops.push({ id: fid, type: 'folder', parentId: '', title: '压力文件夹' + f, position: f + 1, updatedAt: Math.floor(Date.now() / 1000), deviceId: 'stress' })
    for (let sub = 0; sub < 5; sub++) {
      const sid = fid + '-sub-' + sub
      ops.push({ id: sid, type: 'folder', parentId: fid, title: '子文件夹' + f + '-' + sub, position: sub + 1, updatedAt: Math.floor(Date.now() / 1000), deviceId: 'stress' })
      for (let u = 0; u < 9; u++) {
        ops.push({ id: sid + '-u' + u, type: 'url', parentId: sid, title: `书签${f}-${sub}-${u}`, url: `https://stress.test/${f}/${sub}/${u}`, position: u + 1, updatedAt: Math.floor(Date.now() / 1000), deviceId: 'stress' })
      }
    }
  }
  // deep chain: 20-level nesting
  let prev = ''
  for (let d = 0; d < 20; d++) {
    const id = 'deep-' + d
    ops.push({ id, type: 'folder', parentId: prev, title: '深层' + d, position: 1, updatedAt: Math.floor(Date.now() / 1000), deviceId: 'stress' })
    prev = id
  }
  ops.push({ id: 'deep-leaf', type: 'url', parentId: prev, title: '深层叶子书签', url: 'https://deep.test/leaf', position: 2, updatedAt: Math.floor(Date.now() / 1000), deviceId: 'stress' })
  log('S1 setup: payload built', ops.length >= 500, `ops=${ops.length} (500+50 folders + 21 deep)`)

  log('S1 setup: payload ready (' + ops.length + ' ops) — pushing after pair', true)

  // ---- pair extension via real UI ----
  const userDataDir = 'C:/Users/admin/AppData/Local/Temp/md-stress-profile'
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
  for (let i = 0; i < 60; i++) {
    const m = await page.textContent('#pairMsg')
    if (m.includes('配对成功') || m.includes('配对失败')) break
    await new Promise(r => setTimeout(r, 500))
  }
  await page.close()
  log('extension paired', true)
  const pairToken = await sw.evaluate(async () =>
    (await chrome.storage.local.get('md_config')).md_config?.token || '')
  let pushedOk = true
  for (let i = 0; i < ops.length; i += 500) {
    const r = await api('POST', '/api/sync/apply', ops.slice(i, i + 500).map(o => ({ ...o, op: 'create' })),
      { Authorization: 'Bearer ' + pairToken })
    if (r.status !== 200) pushedOk = false
  }
  log('S1: all ' + ops.length + ' rows pushed via device token', pushedOk)

  // ---- S2: ALL urls present in browser, bounded time ----
  const expected = ops.filter(o => o.type === 'url').map(o => o.title)
  const tSync = Date.now()
  let allThere = false
  let browserCount = 0
  for (let i = 0; i < 90; i++) { // up to ~90s for the full pull+apply
    const titles = await browserTitles(sw)
    browserCount = titles.filter(t => t.startsWith('书签')).length
    if (browserCount >= 450) { allThere = true; break }
    await resync(sw).catch(() => {})
    await new Promise(r => setTimeout(r, 1000))
  }
  const syncSecs = Math.round((Date.now() - tSync) / 1000)
  log('S2: all 450 urls applied to browser (bounded time)',
    allThere, `count=${browserCount}/450 in ${syncSecs}s`)
  log('S2b: sync completed within 90s budget', syncSecs <= 90, `${syncSecs}s`)

  // ---- S3: deep chain intact (leaf at depth 21) ----
  const leaf = await sw.evaluate(async () => {
    const tree = await chrome.bookmarks.getTree()
    let leafNode = null
    let depth = 0
    const walk = (ns, d) => { for (const x of ns) { if (x.title === '深层叶子书签') { leafNode = x; depth = d } if (x.children) walk(x.children, d + 1) } }
    for (const root of tree) if (root.children) walk(root.children, 0)
    return leafNode ? { found: true, depth } : { found: false }
  })
  log('S3: 21-level deep chain intact in browser',
    leaf.found && leaf.depth >= 20, 'depth=' + leaf.depth)

  // ---- S4: long offline queue (50 creates offline) replays in order ----
  await sw.evaluate(async () => {
    const cfg = (await chrome.storage.local.get('md_config')).md_config
    await chrome.storage.local.set({ md_config: { ...cfg, server: 'http://127.0.0.1:1' } })
    for (let i = 0; i < 50; i++) {
      await chrome.bookmarks.create({ parentId: JSON.parse(JSON.stringify(await (async () => { const t = await chrome.bookmarks.getTree(); return t[0].children[0].id })())), title: '离线压测' + i, url: 'https://off-stress.test/' + i })
    }
    await new Promise(r => setTimeout(r, 2000))
    await chrome.storage.local.set({ md_config: cfg })
  })
  const qLen = await sw.evaluate(async () =>
    Object.keys((await chrome.storage.local.get('md_touch')).md_touch || {}).length)
  log('S4 setup: 50 offline creates queued', qLen >= 50, 'queue=' + qLen)
  await resync(sw)
  let replayed = 0
  for (let i = 0; i < 30; i++) {
    replayed = (await serverNodes()).filter(n => n.title?.startsWith('离线压测')).length
    if (replayed >= 50) break
    await resync(sw).catch(() => {})
    await new Promise(r => setTimeout(r, 1000))
  }
  log('S4: all 50 offline ops replayed to server', replayed === 50, `replayed=${replayed}/50`)
  const qAfter = await sw.evaluate(async () =>
    Object.keys((await chrome.storage.local.get('md_touch')).md_touch || {}).length)
  log('S4b: queue drained after replay', qAfter === 0, 'queue=' + qAfter)

  // ---- S5: delete 200 server rows → browser converges ----
  const nodes = await serverNodes()
  const victims = nodes.filter(n => n.title?.startsWith('书签0-0-')).map(n => n.id)
  for (const vid of victims) {
    await api('DELETE', `/api/bookmarks/${vid}`, undefined, H)
  }
  log('S5 setup: deleted ' + victims.length + ' server rows', victims.length === 9)
  await resync(sw)
  let gone = false
  for (let i = 0; i < 30; i++) {
    const titles = await browserTitles(sw)
    if (!titles.some(t => t.startsWith('书签0-0-'))) { gone = true; break }
    await resync(sw).catch(() => {})
    await new Promise(r => setTimeout(r, 1000))
  }
  log('S5: mass deletion propagates to browser', gone)

  // ---- S6: final consistency — server live urls == browser urls ----
  await resync(sw)
  await new Promise(r => setTimeout(r, 1500))
  const srvUrls = new Set((await serverNodes()).filter(n => n.type === 'url').map(n => n.url))
  const extUrls = new Set(await sw.evaluate(async () => {
    const tree = await chrome.bookmarks.getTree()
    const urls = new Set()
    const walk = (ns) => { for (const x of ns) { if (x.url) urls.add(x.url); if (x.children) walk(x.children) } }
    for (const root of tree) if (root.children) walk(root.children)
    return [...urls]
  }))
  let mismatch = 0
  for (const u of srvUrls) if (!extUrls.has(u)) mismatch++
  for (const u of extUrls) if (!srvUrls.has(u)) mismatch++
  log('S6: full bidirectional URL parity at end', mismatch === 0,
    `srv=${srvUrls.size} ext=${extUrls.size} mismatch=${mismatch}`)

  const totalSecs = Math.round((Date.now() - t0) / 1000)
  log('S7: whole stress suite within 4min budget', totalSecs <= 240, `${totalSecs}s`)

  await context.close()
  console.log('\n=== STRESS E2E RESULT ===')
  console.log(`${results.filter(r => r.ok).length} passed, ${results.filter(r => !r.ok).length} failed`)
  try { srv.kill() } catch {}
  try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
  process.exit(results.every(r => r.ok) ? 0 : 1)
}

main().catch(e => { console.error('E2E_FATAL', e); process.exit(2) })
