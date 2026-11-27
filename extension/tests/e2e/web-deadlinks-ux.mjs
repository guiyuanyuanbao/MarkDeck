// E2E: web-deadlinks-ux — 死链检测交互专项 (2026-11-27).
//   D1  scan produces records; UI lists only rows needing attention
//       (status 'ok' never appears in the list)
//   D2  each row's title and URL are real anchors opening a NEW TAB
//       (target=_blank, rel=noopener, correct href)
//   D3  清空记录 wipes the list (temporary surface, not an archive)
//   D4  after clearing, a fresh scan repopulates (temporary, not destructive)
//   D5  checkbox select + 移入回收站 still work from the new row markup
import { chromium } from 'playwright-core'
import { spawn, execSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVER = 'http://127.0.0.1:8996'
const ADMIN_PW = process.env.MARKDECK_TEST_PASSWORD || 'markdeck-demo-2026'
const TMP = 'C:/Users/admin/AppData/Local/Temp'

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
let COOKIE = '', CSRF = ''
const webCreate = async (title, url, parentId = '') =>
  JSON.parse((await api('POST', '/api/bookmarks', { type: 'url', title, url, parentId }, { Cookie: COOKIE, 'X-CSRF': CSRF })).body)

// a never-resolvable host: RFC 2606 .test TLD guarantees NXDOMAIN → dead
const DEAD1 = 'https://dead-one-invalid.test/x'
const DEAD2 = 'https://dead-two-invalid.test/y'
const OKURL = 'https://example.com/' // CI/local may be offline; ok status is asserted structurally, not by content

async function main() {
  try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
  await new Promise(r => setTimeout(r, 1000))
  try { fs.rmSync(`${TMP}/md-deadux`, { recursive: true, force: true }) } catch {}
  const srv = spawn('D:/Code/AiWorkSpace/ZCode/MarkDeck/.tools/markdeck-test/markdeck-final.exe', [], {
    env: { ...process.env, MARKDECK_ADDR: '127.0.0.1:8996', MARKDECK_DATA: `${TMP}/md-deadux` },
    stdio: 'ignore',
  })
  for (let i = 0; i < 30; i++) {
    try { await fetch(SERVER + '/api/auth/state'); break } catch { await new Promise(r => setTimeout(r, 300)) }
  }
  const l = await api('POST', '/api/auth/setup', { password: ADMIN_PW })
  COOKIE = l.cookies[0].split(';')[0]
  CSRF = JSON.parse(l.body).csrf

  await webCreate('死链甲', DEAD1)
  await webCreate('死链乙', DEAD2)
  await webCreate('正常站', OKURL)

  const browser = await chromium.launch({ headless: false })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  await page.goto(SERVER)
  await page.fill('input[type=password]', ADMIN_PW)
  await page.click('.el-button')
  await page.waitForTimeout(1200)
  await page.goto(SERVER + '/tools')
  await page.waitForTimeout(800)

  // run a scan
  await page.locator('button', { hasText: '开始扫描' }).click()
  await page.waitForTimeout(3000)
  // wait for the scan to finish (poll the API directly for determinism)
  let running = true
  for (let i = 0; i < 30 && running; i++) {
    const st = JSON.parse((await api('GET', '/api/tools/deadlinks/status', undefined, { Cookie: COOKIE })).body)
    running = st.running
    if (running) await new Promise(r => setTimeout(r, 1000))
  }
  await page.reload()
  await page.waitForTimeout(1200)

  const raw = JSON.parse((await api('GET', '/api/tools/deadlinks', undefined, { Cookie: COOKIE })).body)
  const rawLinks = raw.links || []
  log('D1a: scan recorded rows for all 3 urls', rawLinks.length === 3, 'rows=' + rawLinks.length)

  // ---- D1: UI shows only non-ok rows ----
  const rowCount = await page.locator('.data-row:not([style*="background"])').count()
  const rowTitles = await page.locator('.data-row .data-row-title').allTextContents()
  const hasOkRow = rowTitles.some(t => t.includes('正常站'))
  const deadRows = rowTitles.filter(t => t.includes('死链'))
  log('D1: list shows only the 2 dead rows, ok row filtered out',
    rowCount === 2 && deadRows.length === 2 && !hasOkRow,
    'rows=' + rowCount + ' titles=' + JSON.stringify(rowTitles))

  // ---- D2: rows are anchors opening a NEW TAB ----
  const anchors = await page.locator('.data-row a.dead-link').evaluateAll(els =>
    els.map(a => ({ href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel') })))
  const allNewTab = anchors.length >= 4 && anchors.every(a => a.target === '_blank' && (a.rel || '').includes('noopener'))
  const hrefsOk = anchors.every(a => a.href === DEAD1 || a.href === DEAD2)
  log('D2: title+URL are anchors with target=_blank + noopener', allNewTab && hrefsOk,
    'anchors=' + anchors.length + ' sample=' + JSON.stringify(anchors[0]))

  // real click opens a new tab pointing at the dead URL — the popup event
  // must be awaited AROUND the click (a bare sleep races the tab creation)
  const pagePromise = context.waitForEvent('page', { timeout: 8000 }).catch(() => null)
  await page.locator('.data-row a.dead-link').first().click()
  const popup = await pagePromise
  await page.waitForTimeout(1200)
  const popupUrl = popup ? popup.url() : ''
  log('D2b: clicking a result opens a NEW TAB (error page = correct for an unresolvable host)',
    !!popup && !popupUrl.includes(SERVER),
    'popupUrl=' + (popupUrl || 'NONE').slice(0, 44))
  if (popup) await popup.close()

  // ---- D5: select + 移入回收站 still work ----
  // NOTE: ToolsView has no batch-bar (that's BookmarksView); the delete
  // button lives in the toolbar row with v-if=dead.length. The checkbox's
  // native input is opacity-0/outside-viewport (el-checkbox pattern), so
  // click via the label's bounding box.
  await page.reload()
  await page.waitForTimeout(1000)
  const cb = page.locator('.data-row', { hasText: '死链乙' }).locator('.row-check')
  const cbBox = await cb.boundingBox()
  await page.mouse.click(cbBox.x + 10, cbBox.y + cbBox.height / 2)
  await page.waitForTimeout(400)
  const clsNow = await page.locator('.data-row', { hasText: '死链乙' }).evaluate(el => el.className)
  // the trash button must be enabled now (deadSel.size grew)
  const delBtn = page.locator('button', { hasText: '移入回收站（1）' })
  const btnEnabled = await delBtn.isEnabled()
  await delBtn.click()
  await page.waitForTimeout(600)
  await page.locator('.el-message-box button', { hasText: '确定' }).click()
  await page.waitForTimeout(1200)
  const trashBody = (await api('GET', '/api/trash', undefined, { Cookie: COOKIE })).body
  log('D5: select + move-to-trash works from the new markup',
    clsNow.includes('selected') && btnEnabled && trashBody.includes('dead-two-invalid.test'),
    'rowSelected=' + clsNow.includes('selected') + ' btnEnabled=' + btnEnabled + ' trash=' + trashBody.includes('dead-two-invalid.test'))

  // ---- D3: clear records ----
  await page.locator('button', { hasText: '清空记录' }).click()
  await page.waitForTimeout(500)
  await page.locator('.el-message-box button', { hasText: '确定' }).click()
  await page.waitForTimeout(1000)
  const afterClear = JSON.parse((await api('GET', '/api/tools/deadlinks', undefined, { Cookie: COOKIE })).body)
  const listAfterClear = await page.locator('.data-row .data-row-title').count()
  log('D3: 清空记录 wipes the table and the UI list',
    (afterClear.links || []).length === 0 && listAfterClear === 0,
    'apiRows=' + (afterClear.links || []).length)

  // ---- D4: a fresh scan repopulates (temporary surface, not destructive) ----
  await page.locator('button', { hasText: '开始扫描' }).click()
  await new Promise(r => setTimeout(r, 2500))
  for (let i = 0; i < 30; i++) {
    const st = JSON.parse((await api('GET', '/api/tools/deadlinks/status', undefined, { Cookie: COOKIE })).body)
    if (!st.running) break
    await new Promise(r => setTimeout(r, 1000))
  }
  await page.reload()
  await page.waitForTimeout(1200)
  const afterRescan = JSON.parse((await api('GET', '/api/tools/deadlinks', undefined, { Cookie: COOKIE })).body)
  // after D5 the trashed 乙 no longer participates; the surviving rows are
  // 甲 (dead) + 正常站 (ok) — a fresh scan re-records both
  const repopulated = (afterRescan.links || []).some(x => x.bookmark.url === DEAD1)
    && (afterRescan.links || []).some(x => x.bookmark.url === OKURL)
  log('D4: a fresh scan repopulates records', repopulated, 'rows=' + (afterRescan.links || []).length)

  console.log('\n=== WEB DEADLINKS UX RESULT ===')
  console.log(`${results.filter(r => r.ok).length} passed, ${results.filter(r => !r.ok).length} failed`)
  await browser.close()
  try { srv.kill() } catch {}
  try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
  process.exit(results.every(r => r.ok) ? 0 : 1)
}
main().catch(e => { console.error('E2E_FATAL', e); process.exit(2) })
