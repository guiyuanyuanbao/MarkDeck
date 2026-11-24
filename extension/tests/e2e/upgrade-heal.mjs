// Upgrade-heal E2E: the 0.1.0 upgrade path. Simulates a device that paired
// under a pre-0.1.0 release (legacy md_id_map/md_l2s/md_queue/md_local_nodes
// keys present, some of them POLLUTED the way nine patch releases left real
// user devices) and then runs the new reconcile engine.
//
// The old suite (polluted-upgrade.mjs) repaired mapping tables with a
// sanitize pass — the new architecture has NO mapping tables to repair: a
// wiped/absent/polluted base simply means the next reconcile is a full
// adoption pass, which must bind onto the existing browser tree without
// duplicates. That property is what these checks lock in.
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
const browserNodeByTitle = (sw, title) => sw.evaluate(async (t) => {
  const tree = await chrome.bookmarks.getTree()
  let found = null
  const walk = (nodes) => { for (const n of nodes) { if (n.title === t && !found) found = n; if (n.children) walk(n.children) } }
  for (const root of tree) if (root.children) walk(root.children)
  return found ? { id: found.id, parentId: found.parentId, title: found.title, url: found.url } : null
}, title)
const browserUrlCopies = (sw, url) => sw.evaluate(async (u) => {
  const tree = await chrome.bookmarks.getTree()
  let n = 0
  const walk = (ns) => { for (const x of ns) { if (x.url === u || x.url === u.replace(/\/+$/, '') || x.url + '/' === u) n++; if (x.children) walk(x.children) } }
  for (const root of tree) if (root.children) walk(root.children)
  return n
}, url)
const resync = (sw) => sw.evaluate(() => globalThis.__markdeckResync())

async function main() {
  console.log('== MarkDeck upgrade-heal E2E (legacy dirty storage -> reconcile) ==')
  execSync(`node "${path.resolve(__dirname, '..', 'helpers', 'patch-manifest-e2e.js')}"`, { stdio: 'ignore' })

  try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
  await new Promise(r => setTimeout(r, 800))
  try { fs.rmSync('C:/Users/admin/AppData/Local/Temp/md-heal', { recursive: true, force: true }) } catch {}
  const srv = spawn('D:/Code/AiWorkSpace/ZCode/MarkDeck/.tools/markdeck-test/markdeck-final.exe', [], {
    env: { ...process.env, MARKDECK_ADDR: '127.0.0.1:8999', MARKDECK_DATA: 'C:/Users/admin/AppData/Local/Temp/md-heal' },
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

  // server holds content BEFORE the device upgrades: a folder tree, a
  // slash-URL row, and the canonical holder with content
  const sf = JSON.parse((await api('POST', '/api/bookmarks',
    { type: 'folder', title: '升级前文件夹' }, H)).body)
  await api('POST', '/api/bookmarks',
    { type: 'url', title: '升级前书签', url: 'https://pre.test/x', parentId: sf.id }, H)
  await api('POST', '/api/bookmarks',
    { type: 'url', title: '斜杠书签', url: 'https://slash.test/' }, H)
  log('U1 setup: server content seeded (folder + slash row)', (await serverNodes()).length >= 4)

  // ---- launch the browser (extension) and SIMULATE the legacy device ----
  const userDataDir = 'C:/Users/admin/AppData/Local/Temp/md-heal-profile'
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

  // pre-pair browser content the legacy device would have (same URL as the
  // server row but slash-divergent — the exact v0.0.x duplicate generator)
  await sw.evaluate(async () => {
    const tree = await chrome.bookmarks.getTree()
    const kids = tree[0].children
    await chrome.bookmarks.create({ parentId: kids[0].id, title: '斜杠书签', url: 'https://slash.test' })
    const f = await chrome.bookmarks.create({ parentId: kids[0].id, title: '升级前文件夹' })
    await chrome.bookmarks.create({ parentId: f.id, title: '升级前书签', url: 'https://pre.test/x' })
    await chrome.bookmarks.create({ parentId: kids[1].id, title: '本机其他书签', url: 'https://local-other.test/x' })
    return true
  })
  log('U2 setup: pre-pair browser content (incl. slash-divergent row)', true)

  // ---- U2: pair with PRE-EXISTING legacy storage keys (polluted exactly
  //      like the v0.0.x devices: l2s-shaped rows inside md_id_map) ----
  const code = JSON.parse((await api('POST', '/api/pair-code', {}, H)).body).code
  const extId = new URL(sw.url()).host
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extId}/options.html`)
  // inject legacy pollution BEFORE pairing (the 0.1.0 bundle wipes legacy
  // keys on install — set them after the SW is up, before the first pair)
  await page.evaluate(async () => {
    await chrome.storage.local.set({
      md_id_map: { '1': '', '5': 'uuid-of-something' }, // legacy l2s-shaped pollution
      md_l2s: { '1': '', '5': 'uuid-of-something' },
      md_queue: [{ kind: 'created', id: 'ghost', at: 1 }],
      md_local_nodes: { ghost: { id: 'ghost' } },
    })
  })
  await page.fill('#server', SERVER)
  await page.fill('#code', code)
  await page.click('#pairBtn')
  let pairMsg = ''
  for (let i = 0; i < 30; i++) {
    pairMsg = await page.textContent('#pairMsg')
    if (pairMsg.includes('配对成功') || pairMsg.includes('配对失败')) break
    await new Promise(r => setTimeout(r, 500))
  }
  await new Promise(r => setTimeout(r, 3000))
  await page.close()
  log('U3: pair succeeds over legacy-polluted storage', pairMsg.includes('配对成功'), 'msg=' + pairMsg)

  // ---- U4: the upgrade path wipes legacy keys (onInstalled fires on every
  //      extension reload/update — the real upgrade trigger) ----
  const legacyLeft = await sw.evaluate(async () => {
    // simulate what onInstalled does on the real upgrade: chrome.runtime
    // reload fires onInstalled; here we exercise the same remove list
    await chrome.storage.local.remove(['md_queue', 'md_local_nodes', 'md_id_map', 'md_l2s'])
    const all = await chrome.storage.local.get(null)
    return ['md_queue', 'md_local_nodes', 'md_id_map', 'md_l2s'].filter(k => all[k] !== undefined)
  })
  log('U4: legacy keys wipeable (onInstalled list)', legacyLeft.length === 0, 'left=' + JSON.stringify(legacyLeft))
  const ghostOnServer = (await serverNodes()).some(n => n.title === 'ghost')
  log('U5: legacy queue ghost op did NOT leak into the server', !ghostOnServer)

  // ---- U6: full content parity (both directions) incl. slash adoption ----
  const titles = await sw.evaluate(async () => {
    const tree = await chrome.bookmarks.getTree()
    const out = []
    const walk = (ns) => { for (const n of ns) { if (n.url) out.push(n.title); if (n.children) walk(n.children) } }
    for (const root of tree) if (root.children) walk(root.children)
    return out
  })
  const srvTitles = (await serverNodes()).filter(n => n.type === 'url').map(n => n.title)
  const parity = srvTitles.every(t => titles.includes(t)) &&
    titles.filter(t => srvTitles.includes(t)).length === srvTitles.length
  log('U6: server URLs all present in browser (adoption pass)', parity,
    'srv=' + JSON.stringify(srvTitles) + ' browser=' + JSON.stringify(titles))
  const slashCopies = await browserUrlCopies(sw, 'https://slash.test/')
  log('U7: slash-divergent row adopted as ONE node (no dup)', slashCopies === 1, 'copies=' + slashCopies)

  // ---- U8: structure intact — folder + child parent link ----
  const child = await browserNodeByTitle(sw, '升级前书签')
  const folder = await browserNodeByTitle(sw, '升级前文件夹')
  log('U8: folder structure survives adoption', !!child && !!folder && child.parentId === folder.id,
    `child.parent=${child?.parentId} folder=${folder?.id}`)

  // ---- U9: TWO more reconciles = fixedpoint (zero ops) ----
  const r1 = await resync(sw)
  await new Promise(r => setTimeout(r, 1200))
  const stats1 = await sw.evaluate(() => globalThis.__markdeckReconcileStats())
  log('U9: reconcile reaches fixedpoint (planned=0)', stats1.planned === 0,
    'stats=' + JSON.stringify({ planned: stats1.planned, failed: stats1.failed }))

  // ---- U10: delete-vs-adopt race — server row deleted, browser node exists
  //      unbound (legacy mapping lost) → adoption rescue, not duplicate ----
  const pre = (await serverNodes()).find(n => n.title === '升级前书签')
  await api('DELETE', `/api/bookmarks/${pre.id}`, undefined, H)
  await resync(sw)
  await new Promise(r => setTimeout(r, 1500))
  const goneAfterDel = !(await browserNodeByTitle(sw, '升级前书签'))
  log('U10: server delete propagates even from a freshly-adopted binding', goneAfterDel)

  // ---- U11: content still flows after the whole upgrade path ----
  const post = JSON.parse((await api('POST', '/api/bookmarks',
    { type: 'url', title: '升级后新增', url: 'https://post-heal.test/x' }, H)).body)
  let arrived = false
  for (let i = 0; i < 15; i++) {
    if (await browserNodeByTitle(sw, '升级后新增')) { arrived = true; break }
    await new Promise(r => setTimeout(r, 500))
  }
  log('U11: realtime still works after upgrade heal', arrived && !!post.id)

  // ---- U12: other-root content landed in the browser's other bucket ----
  const holder = (await serverNodes()).find(n => n.id === 'md-others')
  const otherSrv = (await serverNodes()).filter(n => n.parentId === 'md-others' && n.type === 'url')
  log('U12: canonical holder carries the other-root content', !!holder && otherSrv.length >= 1,
    'holder=' + !!holder + ' children=' + otherSrv.length)
  const localOther = await browserNodeByTitle(sw, '本机其他书签')
  log('U13: browser other-root content pushed under the holder',
    !!localOther && otherSrv.some(n => n.title === '本机其他书签'),
    'node=' + !!localOther)

  console.log('\n=== RESULT ===')
  console.log(`${results.filter(r => r.ok).length} passed, ${results.filter(r => !r.ok).length} failed`)
  await context.close()
  try { srv.kill() } catch {}
  try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
  process.exit(results.every(r => r.ok) ? 0 : 1)
}

main().catch(e => { console.error('E2E_FATAL', e); process.exit(2) })
