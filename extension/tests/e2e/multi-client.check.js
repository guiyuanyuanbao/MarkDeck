// Multi-device sync test orchestrator (snapshot-reconciliation era).
// Spawns two isolated device workers (each running the REAL extension bundle
// against its own chrome.* sandbox) and verifies end-to-end synchronization
// through a real MarkDeck server over HTTP.
//
// 0.1.0: the offline-queue checks became touch-journal checks (no queue
// exists anymore); server-side mutations drive /api/sync/apply; deletions
// propagate through the live-tree absence signal.
'use strict'
const fs2 = require('fs')
fs2.copyFileSync(__dirname + '/../../dist/background.js', __dirname + '/../../dist/background.test.mjs')
const { spawn } = require('child_process')
const path = require('path')

const SERVER = process.env.MARKDECK_TEST_SERVER || 'http://127.0.0.1:8996'
const ADMIN_PW = process.env.MARKDECK_TEST_PASSWORD || 'qa-multi-client-2026'

const results = []
function log(name, ok, detail = '') {
  results.push({ name, ok })
  console.log((ok ? '✓' : '✗ FAIL'), name, detail || '')
}

async function api(p, body, headers = {}, method) {
  const r = await fetch(SERVER + p, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: r.status, body: await r.text(), cookies: r.headers.getSetCookie() }
}

class Device {
  constructor(name, port) {
    this.name = name
    this.port = port
    this.proc = null
    this.pending = new Map()
    this.nextId = 1
  }
  async start() {
    this.proc = spawn(process.execPath, [path.join(__dirname, 'helpers', 'device-worker.js'), this.name], {
      env: { ...process.env, MARKDECK_TEST_SERVER: SERVER },
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    this.proc.stdout.setEncoding('utf8')
    let buf = ''
    this.proc.stdout.on('data', (c) => {
      buf += c
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          if (msg.ready) this.ready = true
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const { resolve, reject } = this.pending.get(msg.id)
            this.pending.delete(msg.id)
            msg.error ? reject(new Error(msg.error)) : resolve(msg.result)
          }
        } catch { /* ignore */ }
      }
    })
    for (let i = 0; i < 40; i++) {
      if (this.ready) return
      await new Promise(r => setTimeout(r, 250))
    }
    throw new Error(this.name + ' worker did not start')
  }
  cmd(type, payload = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.proc.stdin.write(JSON.stringify({ id, type, payload }) + '\n')
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(this.name + ' cmd timeout: ' + type)) }
      }, 30000)
    })
  }
  stop() { this.proc?.kill() }
}

async function waitFor(fn, timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true
    await new Promise(r => setTimeout(r, 300))
  }
  return false
}

const { execSync } = require('child_process')
;(async () => {
  // ---- reset server to a clean state (kill, wipe data, restart) ----
  // The old sequence had a startup race: taskkill + 0.8s sleep does not
  // guarantee the previous server released the SQLite file locks, so the
  // rmdir silently kept failing and the new server booted on a STALE
  // database — T3 then "deleted" a leftover duplicate row and deletion
  // propagation looked broken (2026-11-25 failure). Now: kill, wait until
  // the dir is REALLY gone (rmdir retried until it succeeds), boot, and
  // verify the database is actually fresh (auth must report setup mode).
  try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
  const dataDir = 'C:/Users/admin/AppData/Local/Temp/md-sync-test'
  let wiped = false
  for (let i = 0; i < 20 && !wiped; i++) {
    try { fs2.rmSync(dataDir, { recursive: true, force: true }); wiped = !fs2.existsSync(dataDir) } catch { /* locked: retry */ }
    if (!wiped) await new Promise(r => setTimeout(r, 500))
  }
  if (!wiped) throw new Error('cannot wipe ' + dataDir + ' — a markdeck-final.exe is still holding it')
  const serverBin = 'D:/Code/AiWorkSpace/ZCode/MarkDeck/.tools/markdeck-test/markdeck-final.exe'
  spawn(serverBin, [], {
    env: { ...process.env, MARKDECK_ADDR: '127.0.0.1:8996', MARKDECK_DATA: dataDir },
    stdio: 'ignore', detached: true,
  }).unref()
  for (let i = 0; i < 30; i++) {
    try { await fetch(SERVER + '/api/auth/state'); break } catch { await new Promise(r => setTimeout(r, 300)) }
  }
  // ---- server auth ----
  const state = JSON.parse((await api('/api/auth/state')).body)
  if (!state.setup) throw new Error('server db is NOT fresh after wipe (auth.setup=false) — stale data dir')
  let cookie, csrf
  if (state.setup) {
    const s = await api('/api/auth/setup', { password: ADMIN_PW })
    cookie = s.cookies[0].split(';')[0]
    csrf = JSON.parse(s.body).csrf
  } else {
    const l = await api('/api/auth/login', { password: ADMIN_PW })
    if (l.status !== 200) throw new Error('cannot login: ' + l.body)
    cookie = l.cookies[0].split(';')[0]
    csrf = JSON.parse(l.body).csrf
  }
  log('server auth ready', true)

  async function pairCode() {
    const r = await api('/api/pair-code', {}, { Cookie: cookie, 'X-CSRF': csrf })
    if (r.status !== 200) throw new Error('pair-code HTTP ' + r.status + ': ' + r.body.slice(0, 120))
    return JSON.parse(r.body).code
  }

  // ---- spawn two device workers ----
  const A = new Device('Edge-A')
  const B = new Device('Edge-B')
  await A.start()
  await B.start()
  log('two device workers running real extension bundle', true)

  // ---- pair serially (server allows one active code at a time) ----
  const codeA = await pairCode()
  await A.cmd('pair', { code: codeA })
  const cfgA = await A.cmd('config')
  log('A paired as device', !!cfgA?.deviceId, String(cfgA?.deviceId || '').slice(0, 8))
  const codeB = await pairCode()
  await B.cmd('pair', { code: codeB })
  const cfgB = await B.cmd('config')
  log('B paired as device', !!cfgB?.deviceId, String(cfgB?.deviceId || '').slice(0, 8))
  log('device ids distinct', cfgA.deviceId !== cfgB.deviceId)

  // ---- T1: create on A → appears on B ----
  await A.cmd('create', { title: 'A 创建的书签', url: 'https://a-device.test/one' })
  await A.cmd('resync')
  const pendA = await A.cmd('pendingCount')
  const srvAfterT1 = await api('/api/bookmarks/tree', undefined, { Cookie: cookie })
  const srvTitles1 = JSON.parse(srvAfterT1.body).nodes.map(n => n.title)
  const gotByB = await waitFor(async () => {
    await B.cmd('resync')
    return (await B.cmd('titles')).includes('A 创建的书签')
  })
  log('T1: B receives bookmark created on A', gotByB,
    'pendingA=' + pendA + ' srv=' + JSON.stringify(srvTitles1) + ' B=' + JSON.stringify(await B.cmd('titles')))

  // ---- T2: create on B → appears on A ----
  await B.cmd('create', { title: 'B 创建的书签', url: 'https://b-device.test/two' })
  await B.cmd('resync')
  const gotByA = await waitFor(async () => {
    await A.cmd('resync')
    return (await A.cmd('titles')).includes('B 创建的书签')
  })
  log('T2: A receives bookmark created on B', gotByA, gotByA ? '' : 'A titles: ' + JSON.stringify(await A.cmd('titles')))

  // ---- T3: delete on the server → both devices learn it ----
  const tree = await api('/api/bookmarks/tree', undefined, { Cookie: cookie })
  const nodes = JSON.parse(tree.body).nodes
  const target = nodes.find(n => n.title === 'A 创建的书签')
  if (!target) throw new Error('T3: server lost the bookmark')
  const cfgAT3 = await A.cmd('config')
  const delResp = await fetch(SERVER + '/api/sync/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfgAT3.token },
    body: JSON.stringify([{ id: target.id, op: 'delete', updatedAt: Math.floor(Date.now() / 1000), deviceId: 'admin-test' }]),
  })
  log('T3 setup: server delete applied', delResp.status === 200)
  const goneInA = await waitFor(async () => {
    await A.cmd('resync')
    return !(await A.cmd('titles')).includes('A 创建的书签')
  }, 25000)
  const goneInB = await waitFor(async () => {
    await B.cmd('resync')
    return !(await B.cmd('titles')).includes('A 创建的书签')
  }, 25000)
  if (!goneInA) {
    const stPost = await A.cmd('applyStats').catch(e => ({ err: String(e) }))
    const stPost2 = await A.cmd('storageDump').catch(e => ({ err: String(e) }))
    console.log('  [T3post] stats:', JSON.stringify(stPost), 'storage:', JSON.stringify(stPost2).slice(0, 300))
  }
  log('T3: deletion propagates to A', goneInA)
  log('T3: deletion propagates to B', goneInB)

  // ---- T4: conflict — both write to same bookmark; later timestamp wins ----
  await A.cmd('create', { title: '冲突基准', url: 'https://conflict.test/x' })
  await A.cmd('resync')
  const bGot = await waitFor(async () => {
    await B.cmd('resync')
    return (await B.cmd('titles')).includes('冲突基准')
  })
  log('T4 setup: base bookmark on both sides', bGot)
  await new Promise(r => setTimeout(r, 1500)) // let debounce timers drain
  const tree2 = await api('/api/bookmarks/tree', undefined, { Cookie: cookie })
  const base = JSON.parse(tree2.body).nodes.find(n => n.title === '冲突基准')
  // A writes first — resolve the server id to A's local id via base bindings
  const aLocal = (await A.cmd('localIdOf', { serverId: base.id })) || base.id
  await A.cmd('update', { id: aLocal, patch: { title: 'A 的修改' } })
  await A.cmd('resync')
  await new Promise(r => setTimeout(r, 1200))
  // B writes later — must win
  const bId = await B.cmd('findIdByTitle', { title: 'A 的修改' })
  if (!bId) throw new Error('T4: B does not have the base bookmark locally')
  await B.cmd('update', { id: bId, patch: { title: 'B 的修改（更晚）' } })
  await B.cmd('resync')
  const converged = await waitFor(async () => {
    await A.cmd('resync')
    const ta = await A.cmd('titles')
    const tb = await B.cmd('titles')
    return ta.includes('B 的修改（更晚）') && tb.includes('B 的修改（更晚）')
  }, 25000)
  log('T4: conflict resolves to latest writer (LWW)', converged,
    converged ? '' : 'A: ' + JSON.stringify(await A.cmd('titles')) + ' B: ' + JSON.stringify(await B.cmd('titles')))

  // ---- T5: offline edits — B "goes offline" (unreachable server), makes
  // local edits (touch journal holds them), reconnects, reconcile replays ----
  const cfgB2 = await B.cmd('config')
  await B.cmd('setServer', { server: 'http://127.0.0.1:1' }) // unreachable port
  await B.cmd('create', { title: '离线期间创建', url: 'https://offline.test/1' })
  await B.cmd('create', { title: '离线期间创建2', url: 'https://offline.test/2' })
  await B.cmd('resync') // fails, touch journal keeps the edits
  const pending = await B.cmd('pendingCount')
  log('T5 setup: offline edits journalled locally', pending >= 2, 'pending=' + pending)
  await B.cmd('setServer', { server: SERVER })
  await B.cmd('resync')
  const replayedOnServer = await waitFor(async () => {
    const t = await api('/api/bookmarks/tree', undefined, { Cookie: cookie })
    const list = JSON.parse(t.body).nodes.map(n => n.title)
    return list.includes('离线期间创建') && list.includes('离线期间创建2')
  }, 20000)
  log('T5: offline edits replay to server after reconnect', replayedOnServer)
  const aSeesOffline = await waitFor(async () => {
    await A.cmd('resync')
    const ta = await A.cmd('titles')
    return ta.includes('离线期间创建') && ta.includes('离线期间创建2')
  }, 20000)
  log('T5: A receives offline-created bookmarks', aSeesOffline)

  // ---- T6: revoke device B → its sync fails with unauthorized ----
  const devs = JSON.parse((await api('/api/devices', undefined, { Cookie: cookie })).body).devices
  const devBRow = devs.find(d => d.id === cfgB2.deviceId)
  if (!devBRow) throw new Error('T6: B device row missing')
  const rvDel = await fetch(SERVER + '/api/devices/' + devBRow.id, {
    method: 'DELETE', headers: { Cookie: cookie, 'X-CSRF': csrf },
  })
  log('T6 setup: B revoked', rvDel.status === 200)
  await B.cmd('create', { title: '吊销后的修改', url: 'https://revoked.test' })
  await B.cmd('resync')
  await new Promise(r => setTimeout(r, 1500))
  const bStatus = await B.cmd('status')
  log('T6: B sync rejected after revoke', bStatus.status === 'unauthorized', 'status=' + bStatus.status)

  // ---- T7: legacy storage keys are gone from the new bundle ----
  const dumpA = await A.cmd('storageDump')
  log('T7: no legacy keys in persisted state', (dumpA.legacyLeftover || []).length === 0,
    'leftover=' + JSON.stringify(dumpA.legacyLeftover))

  console.log('\n=== RESULT ===')
  console.log(`${results.filter(r => r.ok).length} passed, ${results.filter(r => !r.ok).length} failed`)
  A.stop(); B.stop()
  process.exit(results.every(r => r.ok) ? 0 : 1)
})().catch((e) => { console.error('ORCHESTRATOR_FATAL', e); process.exit(2) })
