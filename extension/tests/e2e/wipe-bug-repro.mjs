// Reproduction: empty server + empty extension base + browser WITH
// bookmarks imported locally. First reconcile must PUSH the browser
// content to the server — never DELETE browser rows.
// Bug report: in this exact scenario the browser's bookmarks got wiped.
'use strict'
import fs from 'fs'
import path from 'path'
import { spawn, execSync } from 'child_process'

const SERVER = 'http://127.0.0.1:8999'
const PW = process.env.MARKDECK_TEST_PASSWORD || '{{SECRET_aedmcuxf}}'
const DIST = 'D:/Code/AiWorkSpace/ZCode/MarkDeck/extension/dist'
const TMP = 'C:/Users/admin/AppData/Local/Temp/md-wipe-bug'

async function api(method, p, body, cookie, csrf) {
  const r = await fetch(SERVER + p, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), 'X-CSRF': csrf || '', Cookie: cookie || '' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: r.status, data: await r.json().catch(() => null), cookies: r.headers.getSetCookie() }
}

;(async () => {
  execSync(`node "${path.resolve('tests', 'helpers', 'patch-manifest-e2e.js')}"`, { stdio: 'ignore' })
  try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
  await new Promise(r => setTimeout(r, 1200))
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
  try { fs.rmSync(TMP + '-profile', { recursive: true, force: true }) } catch {}
  let srv = spawn('D:/Code/AiWorkSpace/ZCode/MarkDeck/.tools/markdeck-test/markdeck-final.exe', [], {
    env: { ...process.env, MARKDECK_ADDR: '127.0.0.1:8999', MARKDECK_DATA: TMP },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  srv.stdout.on('data', d => console.log('[srv]', String(d).trim()))
  srv.stderr.on('data', d => console.error('[srv!]', String(d).trim()))
  let up = false
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(SERVER + '/api/auth/state'); if (r.ok) { up = true; break } } catch { await new Promise(r => setTimeout(r, 300)) }
  }
  console.log('server up:', up)
  // second confirmation with retries (first fetch after 'up' once raced)
  for (let i = 0; i < 10 && !up; i++) {
    try { const r = await fetch(SERVER + '/api/auth/state'); if (r.ok) { up = true; break } } catch { await new Promise(r => setTimeout(r, 500)) }
  }
  let stRaw = ''
  for (let i = 0; i < 10; i++) {
    const r = await fetch(SERVER + '/api/auth/state')
    const txt = await r.text()
    console.log('auth-state try', i, 'status', r.status, 'body', txt.slice(0, 60))
    if (txt) { stRaw = txt; break }
    await new Promise(r2 => setTimeout(r2, 500))
  }
  const state = JSON.parse(stRaw)
  const setupResp = await fetch(SERVER + '/api/auth/setup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PW }),
  })
  console.log('setup status:', setupResp.status)
  const l = { status: setupResp.status, body: await setupResp.text(), cookies: setupResp.headers.getSetCookie() }
  console.log('setup body:', l.body.slice(0, 60), '| cookies:', l.cookies.length)
  const cookie = l.cookies[0].split(';')[0]
  const csrf = JSON.parse(l.body).csrf
  const H = { Cookie: cookie, 'X-CSRF': csrf }
  const rawApi = async (method, p, body) => {
    const r = await fetch(SERVER + p, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), 'X-CSRF': csrf, Cookie: cookie },
      body: body ? JSON.stringify(body) : undefined,
    })
    return JSON.parse(await r.text())
  }
  const serverBefore = (await rawApi('GET', '/api/bookmarks/tree')).nodes
  console.log('server nodes before pairing:', serverBefore.length)

  const { chromium } = await import('playwright-core')
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
  sw.on('console', m => { const t = m.text(); if (t.includes('favicon') || t.includes('sync')) console.log('[SW]', t) })

  // browser has pre-existing bookmarks (simulating user's import)
  const seeded = await sw.evaluate(async () => {
    const kids = (await chrome.bookmarks.getTree())[0].children
    const bar = kids.find(k => k.children && !k.url) || kids[0]
    const other = kids[1]
    await chrome.bookmarks.create({ parentId: bar.id, title: '本机书签A', url: 'https://local-a.test/' })
    await chrome.bookmarks.create({ parentId: bar.id, title: '本机书签B', url: 'https://local-b.test/' })
    await chrome.bookmarks.create({ parentId: other.id, title: '本机其他书签', url: 'https://local-other.test/' })
    return { barKids: bar.children.length, otherKids: other.children.length }
  })
  console.log('browser seeded:', JSON.stringify(seeded))

  // pair via real options UI
  const code = (await rawApi('POST', '/api/pair-code')).code
  const extId = new URL(sw.url()).host
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extId}/options.html`)
  await page.fill('#server', SERVER)
  await page.fill('#code', code)
  await page.click('#pairBtn')
  let pairMsg = ''
  for (let i = 0; i < 30; i++) {
    pairMsg = await page.textContent('#pairMsg')
    if (pairMsg.includes('配对成功') || pairMsg.includes('配对失败')) break
    await new Promise(r => setTimeout(r, 500))
  }
  console.log('pair:', pairMsg)
  await new Promise(r => setTimeout(r, 3000))

  // THE ASSERTION: browser bookmarks must survive
  const after = await sw.evaluate(async () => {
    const kids = (await chrome.bookmarks.getTree())[0].children
    const titles = []
    const walk = ns => { for (const n of ns) { if (n.url) titles.push(n.title); if (n.children) walk(n.children) } }
    for (const k of kids) if (k.children) walk(k.children)
    return { urlCount: titles.length, titles }
  })
  console.log('browser after first sync:', JSON.stringify(after))
  const survived = after.titles.includes('本机书签A') && after.titles.includes('本机书签B') && after.titles.includes('本机其他书签')
  console.log('ALL browser bookmarks survived:', survived, '| url count >= 3:', after.urlCount >= 3)

  // and the server must have received them
  const srvAfter = (await rawApi('GET', '/api/bookmarks/tree')).nodes
  const srvUrls = srvAfter.filter(n => n.type === 'url').map(n => n.title)
  console.log('server urls after sync:', JSON.stringify(srvUrls))
  const pushed = srvUrls.includes('本机书签A') && srvUrls.includes('本机其他书签')
  console.log('browser content pushed to server:', pushed)

  const stats = await sw.evaluate(() => globalThis.__markdeckReconcileStats ? globalThis.__markdeckReconcileStats() : null)
  console.log('reconcile stats:', JSON.stringify(stats))

  // ---- PHASE 2: THE WIPE BUG — stale base + emptied server + re-pair ----
  console.log('--- phase 2: wipe server, keep extension profile, re-pair ---')
  try { srv.kill() } catch {}
  try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
  await new Promise(r => setTimeout(r, 1500))
  // wipe server data (fresh empty server), keep the SAME extension profile
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
  srv = spawn('D:/Code/AiWorkSpace/ZCode/MarkDeck/.tools/markdeck-test/markdeck-final.exe', [], {
    env: { ...process.env, MARKDECK_ADDR: '127.0.0.1:8999', MARKDECK_DATA: TMP },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  srv.stdout.on('data', d => console.log('[srv]', String(d).trim()))
  await new Promise(r => setTimeout(r, 2500))
  // fresh admin session
  const l2raw = await fetch(SERVER + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PW }) })
  const cookie2 = l2raw.headers.getSetCookie()[0].split(';')[0]
  const csrf2 = JSON.parse(await l2raw.text()).csrf
  const rawApi2 = async (method, p, body) => {
    const r = await fetch(SERVER + p, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), 'X-CSRF': csrf2, Cookie: cookie2 },
      body: body ? JSON.stringify(body) : undefined,
    })
    return JSON.parse(await r.text())
  }
  console.log('server nodes after wipe:', (await rawApi2('GET', '/api/bookmarks/tree')).nodes.length)
  // re-pair through the UI with the SAME profile (stale md_base present)
  const code2 = (await rawApi2('POST', '/api/pair-code')).code
  await page.bringToFront()
  await page.goto(`chrome-extension://${extId}/options.html`)
  await page.fill('#server', SERVER)
  await page.fill('#code', code2)
  await page.click('#pairBtn')
  let pairMsg2 = ''
  for (let i = 0; i < 30; i++) {
    pairMsg2 = await page.textContent('#pairMsg')
    if (pairMsg2.includes('配对成功') || pairMsg2.includes('配对失败')) break
    await new Promise(r => setTimeout(r, 500))
  }
  console.log('re-pair:', pairMsg2)
  await new Promise(r => setTimeout(r, 3000))

  const after2 = await sw.evaluate(async () => {
    const kids = (await chrome.bookmarks.getTree())[0].children
    const titles = []
    const walk = ns => { for (const n of ns) { if (n.url) titles.push(n.title); if (n.children) walk(n.children) } }
    for (const k of kids) if (k.children) walk(k.children)
    return { urlCount: titles.length, titles }
  })
  console.log('browser after re-pair on wiped server:', JSON.stringify(after2))
  const survived2 = after2.titles.includes('本机书签A') && after2.titles.includes('本机书签B') && after2.titles.includes('本机其他书签')
  console.log('WIPE BUG: browser bookmarks survived re-pair on emptied server:', survived2)
  const srvAfter2 = (await rawApi2('GET', '/api/bookmarks/tree')).nodes.filter(n => n.type === 'url').map(n => n.title)
  console.log('server urls after re-pair (browser content re-pushed):', JSON.stringify(srvAfter2))
  const repushed = srvAfter2.includes('本机书签A') && srvAfter2.includes('本机其他书签')
  console.log('content re-pushed to fresh server:', repushed)

  await context.close()
  process.exit(survived2 && repushed ? 0 : 1)
  try { srv.kill() } catch {}
  try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
  process.exit(survived && pushed ? 0 : 1)
})().catch(e => { console.error('ERR', e.message); process.exit(2) })
