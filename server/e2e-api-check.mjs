// e2e-api-check.mjs — end-to-end API verification of the refactored server.
// Drives the full lifecycle: setup, login, CRUD, tags, trash/restore,
// purge, batch, search, snapshots, tools, favicon push, sync endpoints.
const BASE = 'http://127.0.0.1:8777'
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}

let csrf = ''
let cookie = ''
async function api(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' }
  if (csrf) headers['X-CSRF'] = csrf
  if (token) headers['Authorization'] = 'Bearer ' + token
  if (cookie) headers['Cookie'] = cookie
  const resp = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  })
  const setCookie = resp.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';')[0]
  let data = null
  const text = await resp.text()
  try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
  return { status: resp.status, data }
}

// 1. setup admin password (fresh DB; 400 = already set up, fine on re-runs)
const pw = 'E2eTest-Passw0rd!'
let r = await api('POST', '/api/auth/setup', { password: pw })
check('auth/setup', r.status === 200 || r.status === 400, `status=${r.status}`)

// 2. login sets session + issues the CSRF token
r = await api('POST', '/api/auth/login', { password: pw })
check('auth/login', r.status === 200 && !!cookie, `status=${r.status}`)
csrf = r.data?.csrf || csrf
r = await api('GET', '/api/auth/me')
check('auth/me (session cookie)', r.status === 200 && r.data?.admin === true, `status=${r.status}`)

// 3. CSRF enforcement: PUT without header must 403
r = await fetch(BASE + '/api/bookmarks/x', { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' })
check('CSRF rejected on session PUT without header', r.status === 403, `status=${r.status}`)

// 4. create folders + bookmarks
r = await api('POST', '/api/bookmarks', { type: 'folder', title: 'E2E父文件夹' })
check('create folder', r.status === 201 && r.data?.type === 'folder', `status=${r.status}`)
const folder = r.data
r = await api('POST', '/api/bookmarks', { type: 'url', parentId: folder.id, title: '示例站点', url: 'https://example.com/', note: 'e2e note' })
check('create bookmark in folder', r.status === 201 && r.data?.parentId === folder.id, `status=${r.status}`)
const bm1 = r.data
r = await api('POST', '/api/bookmarks', { type: 'url', title: '带标签', url: 'https://example.org/?utm_source=x', tags: ['测试', 'Go Lang'] })
const bm2 = r.data
check('create bookmark with tags', r.status === 201 && r.data?.tags?.length === 2, `tags=${JSON.stringify(r.data?.tags)}`)

// 5. read paths
r = await api('GET', '/api/bookmarks/tree')
check('tree returns rows', r.status === 200 && (r.data?.nodes?.length || 0) >= 3, `count=${r.data?.nodes?.length}`)
r = await api('GET', '/api/search?q=示例')
check('search finds bm1', r.status === 200 && (r.data?.results || []).some((b) => b.id === bm1.id), `n=${r.data?.results?.length}`)
r = await api('GET', '/api/tags')
check('tags listed+normalized', r.status === 200 && r.data?.tags?.some((t) => t.tag === 'go lang'), JSON.stringify(r.data?.tags))

// 6. update + LWW
r = await api('PUT', `/api/bookmarks/${bm1.id}`, { title: '示例站点-改名', favorite: true })
check('update bookmark', r.status === 200 && r.data?.title === '示例站点-改名' && r.data?.favorite === true, `status=${r.status}`)

// 7. move + reorder
r = await api('POST', `/api/bookmarks/${bm2.id}/move`, { parentId: folder.id, position: 0 })
check('move bookmark', r.status === 200 && r.data?.parentId === folder.id, `status=${r.status}`)
r = await api('POST', '/api/bookmarks/reorder', { parentId: folder.id, ids: [bm2.id, bm1.id] })
check('reorder', r.status === 200, `status=${r.status}`)

// 8. favicon push (device-style bearer is not set up here; session path accepted)
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
r = await fetch(BASE + '/api/favicon/example.com', { method: 'PUT', headers: { 'X-CSRF': csrf, Cookie: cookie, 'Content-Type': 'image/png' }, body: png })
check('favicon PUT (session+CSRF)', r.status === 200, `status=${r.status}`)
r = await fetch(BASE + '/api/favicon/example.com?probe=1', { headers: { Cookie: cookie } })
check('favicon GET probe', r.status === 200, `status=${r.status}`)
r = await fetch(BASE + '/api/favicon/bad<!host', { headers: { Cookie: cookie } })
check('favicon GET sanitizes host', r.status === 404 || r.status === 400, `status=${r.status}`)

// 9. trash -> restore -> purge lifecycle
r = await api('DELETE', `/api/bookmarks/${bm2.id}`)
check('soft delete', r.status === 200 && r.data?.deleted?.includes(bm2.id), JSON.stringify(r.data))
r = await api('GET', '/api/trash')
check('trash lists tombstone', r.status === 200 && (r.data?.nodes || []).some((b) => b.id === bm2.id), `n=${r.data?.nodes?.length}`)
r = await api('POST', `/api/bookmarks/${bm2.id}/restore`, {})
check('restore to original location', r.status === 200 && r.data?.parentId === folder.id && r.data?.deletedAt === undefined, `parent=${r.data?.parentId}`)
r = await api('DELETE', `/api/bookmarks/${bm2.id}`)
r = await api('POST', `/api/bookmarks/${bm2.id}/purge`, {})
check('purge tombstone', r.status === 200, `status=${r.status}`)

// 10. batch
r = await api('POST', '/api/bookmarks/batch', { ids: [bm1.id], action: 'favorite', value: false })
check('batch favorite', r.status === 200 && r.data?.affected === 1, JSON.stringify(r.data))

// 11. snapshots
r = await api('POST', '/api/snapshots')
check('create snapshot', r.status === 201 && !!r.data?.file, `status=${r.status}`)
const snap = r.data
r = await api('GET', '/api/snapshots')
check('list snapshots', r.status === 200 && (r.data?.snapshots || []).some((s) => s.id === snap.id), `n=${r.data?.snapshots?.length}`)

// 12. tools
r = await api('GET', '/api/tools/deadlinks')
check('deadlinks list', r.status === 200 && Array.isArray(r.data?.links), `status=${r.status}`)
r = await api('GET', '/api/tools/duplicates')
check('duplicates list', r.status === 200 && Array.isArray(r.data?.groups), `status=${r.status}`)
r = await api('GET', '/api/tools/folder-duplicates')
check('folder-duplicates list', r.status === 200 && (r.data?.groups === null || Array.isArray(r.data?.groups)), `status=${r.status}`)

// 13. sync protocol endpoints (extension flow: pair a device, use its token)
r = await api('POST', '/api/pair-code', { deviceName: 'E2E配对设备' })
check('pair-code issued', r.status === 200 && /^\d{6}$/.test(r.data?.code || ''), `status=${r.status}`)
const pairCode = r.data?.code
r = await fetch(BASE + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: pairCode, name: 'E2E配对设备' }) })
const pair = await r.json()
check('pair exchange returns token', r.status === 200 && !!pair?.token && !!pair?.deviceId, `status=${r.status}`)
const devToken = pair?.token

r = await api('GET', '/api/sync/tree', undefined, devToken)
check('sync/tree head+othersId+nodes', r.status === 200 && typeof r.data?.head === 'number' && r.data?.othersId === 'md-others' && Array.isArray(r.data?.nodes), `head=${r.data?.head}`)
r = await api('POST', '/api/sync/apply', [{
  id: 'e2e-sync-op-1', op: 'create', type: 'url', parentId: folder.id,
  title: '对账推送', url: 'https://sync.example.net/', position: 99,
  updatedAt: Math.floor(Date.now() / 1000), deviceId: 'e2e-device',
}], devToken)
check('sync/apply create op', r.status === 200 && r.data?.results?.[0]?.win === true && typeof r.data?.head === 'number', `win=${r.data?.results?.[0]?.win} head=${r.data?.head}`)
r = await api('POST', '/api/sync/apply', [{
  id: 'e2e-sync-op-1', op: 'update', title: '对账推送-改',
  updatedAt: Math.floor(Date.now() / 1000) + 2, deviceId: 'e2e-device',
}], devToken)
check('sync/apply update op (LWW win)', r.status === 200 && r.data?.results?.[0]?.win === true, JSON.stringify(r.data?.results?.[0]))
r = await api('POST', '/api/sync/apply', [], devToken)
check('sync/apply empty batch', r.status === 200 && Array.isArray(r.data?.results), `status=${r.status}`)
// session (no device token) must be rejected on device-only routes
r = await api('GET', '/api/sync/tree')
check('sync/tree rejects session-only', r.status === 401, `status=${r.status}`)

// 14. device list + stats + export
r = await api('GET', '/api/devices')
check('devices list', r.status === 200 && Array.isArray(r.data?.devices), `status=${r.status}`)
r = await api('GET', '/api/stats')
check('stats', r.status === 200 && typeof r.data?.bookmarks === 'number', JSON.stringify(r.data))
r = await fetch(BASE + '/api/export/json', { headers: { Cookie: cookie } })
check('export json', r.status === 200, `status=${r.status}`)
r = await fetch(BASE + '/api/export/html', { headers: { Cookie: cookie } })
check('export netscape html', r.status === 200 && (await r.text()).includes('NETSCAPE-Bookmark-file'), `status=${r.status}`)

// 15. import round-trip (netscape)
const netscape = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE><H1>Bookmarks</H1><DL><p>
<DT><H3>导入测试夹</H3><DL><p>
<DT><A HREF="https://imported.example.io/">导入的书签</A>
</DL><p></DL><p>`
const fd = new FormData()
fd.append('file', new Blob([netscape], { type: 'text/html' }), 'bookmarks.html')
fd.append('mode', 'merge')
r = await fetch(BASE + '/api/import/html', { method: 'POST', headers: { 'X-CSRF': csrf, Cookie: cookie }, body: fd })
check('import netscape merge', r.status === 200, `status=${r.status}`)

// 16. logout
r = await api('POST', '/api/auth/logout', {})
check('logout', r.status === 200, `status=${r.status}`)

const failed = results.filter((x) => !x.ok)
console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`)
if (failed.length) process.exit(1)
