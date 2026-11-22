// T4+T5+T6 in one short-lived orchestrator: conflict LWW, offline replay,
// device revocation. Each phase spawns fresh workers to avoid long-run drift.
'use strict'
const fs2 = require('fs')
fs2.copyFileSync(__dirname + '/../../dist/background.js', __dirname + '/../../dist/background.test.mjs')
const { spawn } = require('child_process')
const path = require('path')

const SERVER = process.env.MARKDECK_TEST_SERVER || 'http://127.0.0.1:8996'
const ADMIN_PW = process.env.MARKDECK_TEST_PASSWORD || 'qa-multi-client-2026'
const WORKER = path.join(__dirname, 'helpers', 'device-worker.js')

const results = []
function log(name, ok, detail = '') {
  results.push({ name, ok })
  console.log((ok ? '✓' : '✗ FAIL'), name, detail || '')
}

async function api(p, body, headers = {}) {
  const r = await fetch(SERVER + p, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: r.status, body: await r.text(), cookies: r.headers.getSetCookie() }
}

class Device {
  constructor(name) {
    this.name = name
    this.pending = new Map()
    this.nextId = 1
  }
  async start() {
    this.proc = spawn(process.execPath, [WORKER, this.name], {
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
          fs2.appendFileSync('C:/Users/admin/AppData/Local/Temp/worker-dbg.log', line + '\n')
          const msg = JSON.parse(line)
          if (msg.ready) { this.ready = true; continue }
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
      }, 15000)
    })
  }
  stop() { try { this.proc.kill() } catch { /* noop */ } }
}

async function waitFor(fn, timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true
    await new Promise(r => setTimeout(r, 300))
  }
  return false
}

;(async () => {
  let cookie, csrf
  const state = JSON.parse((await api('/api/auth/state')).body)
  if (state.setup) {
    const su = await api('/api/auth/setup', { password: ADMIN_PW })
    cookie = su.cookies[0].split(';')[0]
    csrf = JSON.parse(su.body).csrf
  } else {
    const l = await api('/api/auth/login', { password: ADMIN_PW })
    if (l.status !== 200) throw new Error('cannot login: ' + l.body)
    cookie = l.cookies[0].split(';')[0]
    csrf = JSON.parse(l.body).csrf
  }
  async function pairCode() {
    const r = await api('/api/pair-code', {}, { Cookie: cookie, 'X-CSRF': csrf })
    return JSON.parse(r.body).code
  }

  // ============ T4: conflict LWW ============
  {
    const A = new Device('t4-A'); const B = new Device('t4-B')
    await A.start(); await B.start()
    await A.cmd('pair', { code: await pairCode() })
    await B.cmd('pair', { code: await pairCode() })
    await A.cmd('create', {  title: '冲突基准', url: 'https://conflict.test/x' })
    await A.cmd('resync')
    const onB = await waitFor(async () => (await B.cmd('titles')).includes('冲突基准'))
    log('T4 setup: base on both sides', onB)
    const tree = await api('/api/bookmarks/tree', undefined, { Cookie: cookie })
    const base = JSON.parse(tree.body).nodes.find(n => n.title === '冲突基准')
    // A writes first, B writes later → B wins
    const aLocal = (await A.cmd('localIdOf', { serverId: base.id })) || base.id
    await A.cmd('update', { id: aLocal, patch: { title: 'A 的修改' } })
    await A.cmd('resync')
    // B learns via WS ping -> debounce pull; poll instead of a fixed sleep
    let bId = null
    for (let i = 0; i < 40 && !bId; i++) {
      await new Promise(r => setTimeout(r, 500))
      bId = await B.cmd('findIdByTitle', { title: 'A 的修改' }).catch(() => null)
    }
    if (!bId) throw new Error('T4: B lacks the node')
    await B.cmd('update', { id: bId, patch: { title: 'B 的修改（更晚）' } })
    await B.cmd('resync')
    const converged = await waitFor(async () => {
      await A.cmd('resync')
      const ta = await A.cmd('titles')
      return ta.includes('B 的修改（更晚）')
    })
    log('T4: conflict resolves to latest writer (LWW)', converged,
      converged ? '' : 'A titles: ' + JSON.stringify(await A.cmd('titles')))
    A.stop(); B.stop()
  }

  // ============ T5: offline queue replay ============
  {
    const B = new Device('t5-B')
    await B.start()
    await B.cmd('pair', { code: await pairCode() })
    // go "offline": server unreachable
    await B.cmd('setServer', { server: 'http://127.0.0.1:1' })
    await B.cmd('create', {  title: '离线书签1', url: 'https://offline.test/1' })
    await B.cmd('create', {  title: '离线书签2', url: 'https://offline.test/2' })
    try { await B.cmd('resync') } catch { /* expected to fail/timeout */ }
    const queued = await B.cmd('queueLength')
    log('T5 setup: offline edits queued', queued >= 2, 'queue=' + queued)
    // reconnect
    await B.cmd('setServer', { server: SERVER })
    await B.cmd('resync')
    const replayed = await waitFor(async () => {
      const t = await api('/api/bookmarks/tree', undefined, { Cookie: cookie })
      const list = JSON.parse(t.body).nodes.map(n => n.title)
      return list.includes('离线书签1') && list.includes('离线书签2')
    })
    log('T5: offline edits replay to server', replayed)
    B.stop()
  }

  // ============ T6: device revocation ============
  {
    const B = new Device('t6-B')
    await B.start()
    const pB = await B.cmd('pair', { code: await pairCode() })
    const cfgB = await B.cmd('config')
    // revoke
    const rv = await fetch(SERVER + '/api/devices/' + cfgB.deviceId, {
      method: 'DELETE', headers: { Cookie: cookie, 'X-CSRF': csrf },
    })
    log('T6 setup: B revoked', rv.status === 200)
    // B tries to sync — should get 401
    await B.cmd('create', {  title: '吊销后修改', url: 'https://revoked.test' })
    await B.cmd('resync')
    await new Promise(r => setTimeout(r, 1200))
    const st = await B.cmd('status')
    log('T6: B marked unauthorized after revoke', st.status === 'unauthorized', 'status=' + st.status)
    // server-side: B's token dead
    const probe = await fetch(SERVER + '/api/sync/device-pull?since=0', {
      headers: { Authorization: 'Bearer ' + cfgB.token },
    })
    log('T6: revoked token rejected server-side', probe.status === 401, 'status=' + probe.status)
    B.stop()
  }

  console.log('\n=== RESULT ===')
  console.log(`${results.filter(r => r.ok).length} passed, ${results.filter(r => !r.ok).length} failed`)
  process.exit(results.every(r => r.ok) ? 0 : 1)
})().catch((e) => { console.error('ORCHESTRATOR_FATAL', e); process.exit(2) })
