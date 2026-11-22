// WS live test: connect, authenticate via cookie, trigger a change, expect rev ping.
const http = require('http')

function req(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const r = http.request({ host: '127.0.0.1', port: 8992, method, path, headers: {
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers,
    }}, (res) => {
      let buf = ''
      res.on('data', (c) => (buf += c))
      res.on('end', () => resolve({ status: res.statusCode, body: buf, headers: res.headers }))
    })
    r.on('error', reject)
    if (data) r.write(data)
    r.end()
  })
}

;(async () => {
  // setup + login
  const setup = await req('POST', '/api/auth/setup', { password: 'ws-test-123' })
  const cookie = setup.headers['set-cookie'][0].split(';')[0]
  const login = JSON.parse(setup.body)
  const csrf = login.csrf
  console.log('logged in, csrf len', csrf.length)

  // open WS with the session cookie
  const crypto = require('crypto')
  const key = crypto.randomBytes(16).toString('base64')
  const wsReq = http.request({
    host: '127.0.0.1', port: 8992, path: '/api/ws', headers: {
      Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': 13, Cookie: cookie,
    },
  })
  let wsRes = null
  wsReq.on('upgrade', (res, socket) => { wsRes = res; global.__sock = socket })
  wsReq.on('response', (res) => { console.error('WS rejected:', res.statusCode); process.exit(1) })
  wsReq.end()

  // wait for upgrade
  for (let i = 0; i < 20 && !wsRes; i++) await new Promise((r) => setTimeout(r, 100))
  if (!wsRes) { console.error('no upgrade'); process.exit(1) }
  console.log('WS upgraded:', wsRes.statusCode)

  const sock = global.__sock
  const frames = []
  sock.on('data', (d) => frames.push(d))

  // trigger a change -> expect {"t":"rev"...}
  await req('POST', '/api/bookmarks', { type: 'folder', title: 'WS Test' }, { Cookie: cookie, 'X-CSRF': csrf })
  await new Promise((r) => setTimeout(r, 800))

  // parse the first frame text
  if (frames.length === 0) { console.error('NO FRAMES'); process.exit(1) }
  const f = frames[0]
  const payload = f.slice(2, 2 + (f[1] & 0x7f)).toString()
  console.log('WS frame:', payload)
  const ok = /"t":"rev"/.test(payload) && /"rev":\d+/.test(payload)
  console.log(ok ? 'WS_LIVE_OK' : 'WS_LIVE_FAIL')
  process.exit(ok ? 0 : 1)
})()
