// Visual verification of the redesigned popup + options pages: load the
// extension in Playwright chromium, screenshot both surfaces, exercise the
// popup search + options pairing UI.
'use strict'
import { chromium } from 'playwright-core'
import { spawn, execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVER = 'http://127.0.0.1:8999'
const PW = process.env.MARKDECK_TEST_PASSWORD || 'markdeck-demo-2026'
const DIST = path.resolve(__dirname, '..', '..', 'dist')
const TMP = 'C:/Users/admin/AppData/Local/Temp/md-ext-ui'

async function api(method, p, body, cookie, csrf) {
  const r = await fetch(SERVER + p, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), 'X-CSRF': csrf || '', Cookie: cookie || '' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: r.status, data: await r.json().catch(() => null), cookies: r.headers.getSetCookie() }
}

;(async () => {
  execSync(`node "${path.resolve(__dirname, '..', 'helpers', 'patch-manifest-e2e.js')}"`, { stdio: 'ignore' })
  try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
  await new Promise((r) => setTimeout(r, 1200))
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
  try { fs.rmSync(TMP + '-profile', { recursive: true, force: true }) } catch {}
  spawn('D:/Code/AiWorkSpace/ZCode/MarkDeck/.tools/markdeck-test/markdeck-final.exe', [], {
    env: { ...process.env, MARKDECK_ADDR: '127.0.0.1:8999', MARKDECK_DATA: TMP },
    stdio: 'ignore', detached: true,
  }).unref()
  for (let i = 0; i < 30; i++) {
    try { await fetch(SERVER + '/api/auth/state'); break } catch { await new Promise((r) => setTimeout(r, 300)) }
  }
  const st = await api('POST', '/api/auth/setup', { password: PW })
  const cookie = st.cookies.map((c) => c.split(';')[0]).join('; ')
  const csrf = st.data.csrf

  const context = await chromium.launchPersistentContext(TMP + '-profile', {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  })
  let sw = null
  for (let i = 0; i < 30; i++) {
    const sws = context.serviceWorkers().filter((w) => w.url().includes('background.js'))
    if (sws.length) { sw = sws[0]; break }
    await new Promise((r) => setTimeout(r, 500))
  }
  if (!sw) throw new Error('no SW')

  // ---- options page (unpaired state) ----
  const optPage = await context.newPage()
  await optPage.goto('chrome-extension://' + new URL(sw.url()).host + '/options.html')
  await optPage.waitForTimeout(1200)
  fs.mkdirSync('C:/Users/admin/AppData/Local/Temp/md-ext-ui-shots', { recursive: true })
  await optPage.screenshot({ path: 'C:/Users/admin/AppData/Local/Temp/md-ext-ui-shots/options-unpaired.png', fullPage: true })
  console.log('✓ options screenshot (unpaired)')

  // version badge populated?
  const badge = await optPage.textContent('#versionBadge')
  console.log('✓ version badge:', badge)

  // ---- pair through the real UI (exercises the redesigned form) ----
  const pc = await api('POST', '/api/pair-code', { deviceName: 'UI 验证' }, cookie, csrf)
  await optPage.fill('#server', SERVER)
  await optPage.fill('#code', pc.data.code)
  await optPage.click('#pairBtn')
  await optPage.waitForTimeout(2500)
  const pairMsg = await optPage.textContent('#pairMsg')
  console.log('✓ pair via new UI:', pairMsg.trim().slice(0, 40))
  await optPage.waitForTimeout(1500)
  await optPage.screenshot({ path: 'C:/Users/admin/AppData/Local/Temp/md-ext-ui-shots/options-paired.png', fullPage: true })
  console.log('✓ options screenshot (paired)')

  // diagnostics card should render rows now
  await optPage.click('#diagRefresh')
  await optPage.waitForTimeout(2000)
  await optPage.screenshot({ path: 'C:/Users/admin/AppData/Local/Temp/md-ext-ui-shots/options-diag.png', fullPage: true })
  const diagRowCount = await optPage.evaluate(() => document.querySelectorAll('.diag-row').length)
  console.log('✓ diag rows rendered:', diagRowCount)

  // ---- popup ----
  const popupPage = await context.newPage()
  await popupPage.goto('chrome-extension://' + new URL(sw.url()).host + '/popup.html')
  await popupPage.waitForTimeout(1200)
  await popupPage.screenshot({ path: 'C:/Users/admin/AppData/Local/Temp/md-ext-ui-shots/popup-online.png' })
  const status = await popupPage.textContent('#statusText')
  console.log('✓ popup status:', status)

  // local search in popup
  await popupPage.fill('#localSearch', '灵感')
  await popupPage.waitForTimeout(500)
  const results = await popupPage.evaluate(() => [...document.querySelectorAll('#searchResults a')].map((a) => a.textContent.trim()))
  console.log('✓ popup search results:', results.length, results.slice(0, 2))
  await popupPage.screenshot({ path: 'C:/Users/admin/AppData/Local/Temp/md-ext-ui-shots/popup-search.png' })

  // quick save via popup
  await popupPage.fill('#title', 'UI 验证书签')
  await popupPage.fill('#tags', '视觉')
  await popupPage.click('#saveBtn')
  await popupPage.waitForTimeout(900)
  const saved = await popupPage.textContent('#savedMsg')
  console.log('✓ quick save:', saved)
  await popupPage.screenshot({ path: 'C:/Users/admin/AppData/Local/Temp/md-ext-ui-shots/popup-saved.png' })

  // ---- dark theme options (web theme tokens mirror into extension vars) ----
  // the extension pages are always light; verify nothing overflows at 320px
  await popupPage.setViewportSize({ width: 320, height: 600 })
  await popupPage.waitForTimeout(400)
  const overflow = await popupPage.evaluate(() => document.body.scrollWidth > document.body.clientWidth)
  console.log(overflow ? '✗ popup overflows at 320px' : '✓ popup fits at 320px')

  await context.close()
  console.log('\n=== EXT UI RESULT ===')
  console.log('ALL VISUAL CHECKS DONE')
  process.exit(0)
})().catch((e) => { console.error('FATAL', e); process.exit(1) })
