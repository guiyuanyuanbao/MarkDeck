// pair-shot.mjs — pair the real extension against the live server through
// the REAL options UI, then screenshot the options page in both states:
// unpaired (before) and paired (after), verifying the pairing chip/steps
// UX. Screenshots land in $TEMP for the ZCode agent to read.
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVER = 'http://127.0.0.1:8777'
const ADMIN_PW = 'markdeck-demo-2026'
const DIST = path.resolve(__dirname, '..', '..', 'dist')
const SHOT_DIR = process.env.TEMP || 'C:/Users/admin/AppData/Local/Temp'

async function api(method, p, body, headers = {}) {
  const r = await fetch(SERVER + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const setCookie = r.headers.get('set-cookie')
  return { status: r.status, body: await r.text(), setCookie }
}

// setup + login
{
  const r = await api('POST', '/api/auth/setup', { password: ADMIN_PW })
  if (r.status !== 200 && r.status !== 400) throw new Error('setup: ' + r.status)
}
const l = await api('POST', '/api/auth/login', { password: ADMIN_PW })
if (l.status !== 200) throw new Error('login: ' + l.status)
const COOKIE = l.setCookie.split(';')[0]
const csrf = JSON.parse(l.body).csrf
console.log('server ready')

const userDataDir = 'C:/Users/admin/AppData/Local/Temp/md-pairshot-profile'
try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch {}
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  viewport: { width: 1280, height: 860 },
})
let sw = null
for (let i = 0; i < 30; i++) {
  const sws = context.serviceWorkers().filter((w) => w.url().includes('background.js'))
  if (sws.length) { sw = sws[0]; break }
  await new Promise((r) => setTimeout(r, 500))
}
if (!sw) throw new Error('SW not found')
const extId = new URL(sw.url()).host
console.log('SW running, extId=' + extId)

const page = await context.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
page.on('console', (m) => { if (m.type() === 'error') console.log('[page-console]', m.text()) })
await page.goto(`chrome-extension://${extId}/options.html`)
await page.waitForTimeout(800)

// ---- state 1: unpaired ----
const chipBefore = await page.textContent('#pairChipText')
const stepsVisibleBefore = await page.isVisible('#pairSteps')
const connBefore = await page.textContent('#connTitle')
await page.screenshot({ path: path.join(SHOT_DIR, 'options-unpaired.png'), fullPage: true })
console.log('UNPAIRED  chip=' + JSON.stringify(chipBefore) + ' connTitle=' + JSON.stringify(connBefore) + ' stepsVisible=' + stepsVisibleBefore)

// ---- pair through the real UI ----
const code = JSON.parse((await api('POST', '/api/pair-code', {}, { Cookie: COOKIE, 'X-CSRF': csrf })).body).code
await page.fill('#server', SERVER)
await page.fill('#code', code)
await page.click('#pairBtn')
let pairMsg = ''
for (let i = 0; i < 30; i++) {
  pairMsg = await page.textContent('#pairMsg')
  if (pairMsg.includes('配对成功') || pairMsg.includes('配对失败')) break
  await new Promise((r) => setTimeout(r, 500))
}
console.log("pair msg: " + JSON.stringify(pairMsg))
// wait for the chip to flip (immediate-refresh loop, max ~4s)
for (let i = 0; i < 12; i++) {
  const chip = await page.textContent('#pairChipText')
  if (chip !== '未配对') break
  await new Promise((r) => setTimeout(r, 500))
}
await page.waitForTimeout(1500) // let first reconcile settle + diag rerun
const chipFinal = await page.textContent('#pairChipText')
const connFinal = await page.textContent('#connTitle')
const stepsVisibleAfter = await page.isVisible('#pairSteps')
const diagSummary = await page.textContent('#diagSummary')
await page.screenshot({ path: path.join(SHOT_DIR, 'options-paired.png'), fullPage: true })
console.log('PAIRED    chip=' + JSON.stringify(chipFinal) + ' connTitle=' + JSON.stringify(connFinal) +
  ' stepsVisible=' + stepsVisibleAfter + ' diag=' + JSON.stringify(diagSummary))

// assertions
const ok =
  chipBefore === '未配对' && stepsVisibleBefore === true &&
  chipFinal === '已配对' && connFinal.includes('已配对') &&
  stepsVisibleAfter === false
console.log(ok ? 'ALL-CHECKS-PASS' : 'CHECKS-FAILED')
await context.close()
process.exit(ok ? 0 : 1)
