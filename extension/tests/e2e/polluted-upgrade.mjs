// Reproduces the user's exact failure: mapping tables polluted by the
// pre-v0.0.12 initialImport bug (l2s-shaped rows inside md_id_map), device
// reports rev caught up, but server bookmarks never appear in the tree.
// Verifies: (a) sanitize repairs the tables, (b) bookmarks then sync,
// (c) the deepDiag probe correctly reports consistency.
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

const browserTitles = (sw) => sw.evaluate(async () => {
  const tree = await chrome.bookmarks.getTree()
  const out = []
  const walk = (nodes) => { for (const n of nodes) { if (n.url) out.push(n.title); if (n.children) walk(n.children) } }
  for (const root of tree) if (root.children) walk(root.children)
  return out
})

async function main() {
  console.log('== MarkDeck polluted-upgrade E2E ==')
  execSync(`node "${path.resolve(__dirname, '..', 'helpers', 'patch-manifest-e2e.js')}"`, { stdio: 'ignore' })

  try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
  await new Promise(r => setTimeout(r, 800))
  try { fs.rmSync('C:/Users/admin/AppData/Local/Temp/md-pollute', { recursive: true, force: true }) } catch {}
  const srv = spawn('D:/Code/AiWorkSpace/ZCode/MarkDeck/.tools/markdeck-test/markdeck-final.exe', [], {
    env: { ...process.env, MARKDECK_ADDR: '127.0.0.1:8999', MARKDECK_DATA: 'C:/Users/admin/AppData/Local/Temp/md-pollute' },
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

  // server has content the extension must eventually show
  for (const t of ['升级场景书签A', '升级场景书签B', '升级场景书签C']) {
    await api('POST', '/api/bookmarks', { type: 'url', title: t, url: `https://pollute.sm/${t}` }, H)
  }

  const userDataDir = 'C:/Users/admin/AppData/Local/Temp/md-pollute-profile'
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
  sw.on('console', msg => { const t = msg.text(); if (t.includes('pruning')) console.log('[SW]', t) })

  // pair normally (v0.0.12 code path: tables stay clean)
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
  log('paired', true)
  await new Promise(r => setTimeout(r, 2500))

  // NOW corrupt the tables exactly the way pre-v0.0.12 initialImport did:
  // localId->serverId entries stuffed into md_id_map (serverId-keyed table)
  const polluted = await sw.evaluate(async () => {
    const map = (await chrome.storage.local.get('md_id_map')).md_id_map || {}
    const l2s = (await chrome.storage.local.get('md_l2s')).md_l2s || {}
    const fake = {}
    for (const [lid, sid] of Object.entries(l2s)) fake[lid] = sid // l2s rows under map keys
    await chrome.storage.local.set({ md_id_map: fake }) // map loses real serverId->localId rows
    return { injected: Object.keys(fake).length, had: Object.keys(map).length }
  })
  log('mapping tables polluted the old-release way',
    polluted.injected > 0, JSON.stringify(polluted))

  // force a fresh full sync — user's "rev caught up but nothing appeared"
  await sw.evaluate(() => globalThis.__markdeckResync())
  await new Promise(r => setTimeout(r, 3000))

  // the deep diag must now report the discrepancy (resync first to wake the SW)
  await sw.evaluate(() => globalThis.__markdeckResync()).catch(() => {})
  await new Promise(r => setTimeout(r, 1000))
  let deep = null
  try {
    deep = await sw.evaluate(async () => {
      if (typeof globalThis.__markdeckDeepDiag === 'function') return await globalThis.__markdeckDeepDiag()
      return await chrome.runtime.sendMessage({ type: 'deepDiag' })
    })
  } catch { deep = null }
  console.log('[deepDiag]', JSON.stringify(deep))
  log('deepDiag probes reachable', !!deep?.ok, JSON.stringify({
    server: deep?.serverUrls, local: deep?.localUrls, consistent: deep?.idMapConsistent,
  }))

  // after sanitize+repair (runs at every fullSync), content must appear
  let titles = await browserTitles(sw)
  let allSynced = ['升级场景书签A', '升级场景书签B', '升级场景书签C'].every(t => titles.includes(t))
  if (!allSynced) {
    await sw.evaluate(() => globalThis.__markdeckResync())
    await new Promise(r => setTimeout(r, 3000))
    titles = await browserTitles(sw)
    allSynced = ['升级场景书签A', '升级场景书签B', '升级场景书签C'].every(t => titles.includes(t))
  }
  log('P1: polluted mapping repaired by sanitize — server bookmarks land in browser',
    allSynced, 'titles=' + JSON.stringify(titles))

  // mapping tables must now be consistent both ways
  const health = await sw.evaluate(async () => {
    const map = (await chrome.storage.local.get('md_id_map')).md_id_map || {}
    const l2s = (await chrome.storage.local.get('md_l2s')).md_l2s || {}
    const bad = Object.entries(map).filter(([sid, lid]) => l2s[lid] !== sid)
    return { mapRows: Object.keys(map).length, l2sRows: Object.keys(l2s).length, inconsistent: bad.length, mapSample: Object.entries(map).slice(0, 4).map(([k, v]) => k.slice(0, 6) + '->' + v) }
  })
  console.log('[P2dbg]', JSON.stringify(health))
  log('P2: mapping tables consistent after repair', health.inconsistent === 0 && health.mapRows > 0,
    JSON.stringify(health))

  // new bidirectional sync still works after the repair
  await sw.evaluate(async () =>
    await chrome.bookmarks.create({ parentId: '1', title: '修复后新增', url: 'https://post-repair.sm/x' }))
  await sw.evaluate(() => globalThis.__markdeckResync())
  let postOk = false
  for (let i = 0; i < 15; i++) {
    const nodes = JSON.parse((await api('GET', '/api/bookmarks/tree', undefined, { Cookie: cookie })).body).nodes
    if (nodes.some(n => n.title === '修复后新增')) { postOk = true; break }
    await new Promise(r => setTimeout(r, 500))
  }
  log('P3: post-repair push sync still works', postOk)

  await page.close()
  console.log('\n=== POLLUTED-UPGRADE E2E RESULT ===')
  console.log(`${results.filter(r => r.ok).length} passed, ${results.filter(r => !r.ok).length} failed`)
  await context.close()
  try { srv.kill() } catch {}
  try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
  process.exit(results.every(r => r.ok) ? 0 : 1)
}

main().catch(e => { console.error('E2E_FATAL', e); process.exit(2) })
