// E2E: web-selection-ux — 选中交互专项 (2026-11-27).
//   U1  left-click on empty space clears the selection (grid + list)
//   U2  clicks on rows/cards still select (blankClick doesn't eat them)
//   U3  batch-move dialog: no stale highlight without a real selection
//   U4  batch-move dialog: clicking a folder highlights AND selects (confirm works)
//   U5  shift/ctrl selection survives blank clicks only when clicking blank
import { chromium } from 'playwright-core'
import { spawn, execSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVER = 'http://127.0.0.1:8995'
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
const serverNodes = async () => JSON.parse((await api('GET', '/api/bookmarks/tree', undefined, { Cookie: COOKIE })).body).nodes
const webCreate = async (title, url, parentId = '') =>
  JSON.parse((await api('POST', '/api/bookmarks', { type: 'url', title, url, parentId }, { Cookie: COOKIE, 'X-CSRF': CSRF })).body)
const webCreateFolder = async (title, parentId = '') =>
  JSON.parse((await api('POST', '/api/bookmarks', { type: 'folder', title, parentId }, { Cookie: COOKIE, 'X-CSRF': CSRF })).body)

async function main() {
  try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
  await new Promise(r => setTimeout(r, 1000))
  try { fs.rmSync(`${TMP}/md-selux`, { recursive: true, force: true }) } catch {}
  const srv = spawn('D:/Code/AiWorkSpace/ZCode/MarkDeck/.tools/markdeck-test/markdeck-final.exe', [], {
    env: { ...process.env, MARKDECK_ADDR: '127.0.0.1:8995', MARKDECK_DATA: `${TMP}/md-selux` },
    stdio: 'ignore',
  })
  for (let i = 0; i < 30; i++) {
    try { await fetch(SERVER + '/api/auth/state'); break } catch { await new Promise(r => setTimeout(r, 300)) }
  }
  const l = await api('POST', '/api/auth/setup', { password: ADMIN_PW })
  COOKIE = l.cookies[0].split(';')[0]
  CSRF = JSON.parse(l.body).csrf

  for (let i = 0; i < 3; i++) await webCreate(`选中${i}`, `https://sel/${i}`)
  const f1 = await webCreateFolder('移动目标甲')
  const f2 = await webCreateFolder('移动目标乙')

  const browser = await chromium.launch({ headless: false })
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage()
  await page.goto(SERVER)
  await page.fill('input[type=password]', ADMIN_PW)
  await page.click('.el-button')
  await page.waitForTimeout(1500)

  const batchBarVisible = () => page.locator('.batch-bar').isVisible().catch(() => false)

  // ---- U2/U1 grid: click a card selects; click empty space clears ----
  await page.click('button[aria-label="图标视图"]')
  await page.waitForTimeout(600)
  await page.locator('.bm-card', { hasText: '选中1' }).first().click()
  await page.waitForTimeout(300)
  log('U2a: grid card click selects (batch bar appears)', await batchBarVisible())
  await page.mouse.click(640, 820) // below the card grid = empty space
  await page.waitForTimeout(300)
  log('U1a: grid empty-space click clears the selection', !(await batchBarVisible()))

  // ---- U1 list: same behavior ----
  await page.click('button[aria-label="列表视图"]')
  await page.waitForTimeout(600)
  await page.locator('.bm-row', { hasText: '选中1' }).first().click()
  await page.waitForTimeout(300)
  log('U2b: list row click selects', await batchBarVisible())
  await page.mouse.click(640, 820)
  await page.waitForTimeout(300)
  log('U1b: list empty-space click clears the selection', !(await batchBarVisible()))

  // ---- U3/U4: batch-move dialog highlight/selection sync ----
  await page.locator('.bm-row', { hasText: '选中1' }).first().click()
  await page.waitForTimeout(200)
  await page.locator('.batch-bar button', { hasText: '移动' }).click()
  await page.waitForTimeout(800) // dialog opens, tree loads
  const dlgVisible = await page.locator('.el-dialog').isVisible()
  // with NO prior move in this session, no node should be highlighted:
  // count highlighted tree rows (el-tree current row carries .is-current)
  const highlighted0 = await page.locator('.el-dialog .el-tree-node.is-current, .el-dialog .is-current').count()
  log('U3: fresh dialog has NO stale highlight (highlight==selection state)',
    dlgVisible && highlighted0 === 0, 'highlighted=' + highlighted0)
  // confirm must refuse without a selection
  await page.locator('.el-dialog button', { hasText: '移动到此处' }).click()
  await page.waitForTimeout(400)
  const warnShown = await page.locator('.el-message').count()
  log('U3b: confirm without selection warns (highlight==selection promise)', warnShown > 0)
  // click 乙: it highlights AND selects — confirm now moves there
  await page.locator('.el-dialog .folder-node', { hasText: '移动目标乙' }).first().click()
  await page.waitForTimeout(300)
  const highlighted1 = await page.locator('.el-dialog .is-current').count()
  await page.locator('.el-dialog button', { hasText: '移动到此处' }).click()
  await page.waitForTimeout(1200)
  const moved = (await serverNodes()).find(n => n.title === '选中1')
  log('U4: folder click highlights + confirm moves there (no gap)',
    highlighted1 > 0 && moved && moved.parentId === f2.id,
    'highlighted=' + highlighted1 + ' parentId=' + (moved && moved.parentId === f2.id ? f2.id.slice(0, 8) : (moved && moved.parentId.slice(0, 8))))

  // ---- U3 (stale-highlight regression): reopen the dialog AFTER a move —
  // 乙 was the last target; the tree must NOT pre-highlight it while target=''
  await page.locator('.bm-row', { hasText: '选中2' }).first().click()
  await page.waitForTimeout(200)
  await page.locator('.batch-bar button', { hasText: '移动' }).click()
  await page.waitForTimeout(800)
  const highlighted2 = await page.locator('.el-dialog .is-current').count()
  log('U3c: reopened dialog (after a past move) has NO stale highlight',
    highlighted2 === 0, 'highlighted=' + highlighted2)
  // and the highlighted behavior still works on the second open
  await page.locator('.el-dialog .folder-node', { hasText: '移动目标甲' }).first().click()
  await page.waitForTimeout(300)
  await page.locator('.el-dialog button', { hasText: '移动到此处' }).click()
  await page.waitForTimeout(1200)
  const moved2 = (await serverNodes()).find(n => n.title === '选中2')
  log('U4b: second dialog open still moves to the clicked folder',
    moved2 && moved2.parentId === f1.id)

  console.log('\n=== WEB SELECTION UX RESULT ===')
  console.log(`${results.filter(r => r.ok).length} passed, ${results.filter(r => !r.ok).length} failed`)
  await browser.close()
  try { srv.kill() } catch {}
  try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
  process.exit(results.every(r => r.ok) ? 0 : 1)
}
main().catch(e => { console.error('E2E_FATAL', e); process.exit(2) })
