// snapshot-upload-e2e.mjs — verify the snapshot upload/restore round trip:
// create bookmarks -> take snapshot -> download it -> wipe tree (via
// restore of an empty older snapshot + verifying content) -> upload the
// downloaded file back -> content returns. Also asserts the bad-file path.
const BASE = 'http://127.0.0.1:8777'
const pw = 'E2eTest-Passw0rd!'
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`) }

let cookie = '', csrf = ''
async function api(method, p, body) {
  const headers = { 'Content-Type': 'application/json' }
  if (csrf) headers['X-CSRF'] = csrf
  if (cookie) headers['Cookie'] = cookie
  const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]
  const t = await r.text(); let d = null; try { d = t ? JSON.parse(t) : null } catch { d = { raw: t } }
  return { status: r.status, data: d }
}

// fresh DB: setup + seed bookmarks
await api('POST', '/api/auth/setup', { password: pw })
const l = await api('POST', '/api/auth/login', { password: pw })
csrf = l.data?.csrf || ''
for (let i = 1; i <= 3; i++) {
  await api('POST', '/api/bookmarks', { type: 'url', title: '上传测试' + i, url: 'https://upload.test/' + i })
}

// snapshot + download
const snap = await api('POST', '/api/snapshots')
check('snapshot created', snap.status === 201 && snap.data?.id)
const dl = await fetch(BASE + `/api/snapshots/${snap.data.id}/download`, { headers: { Cookie: cookie } })
const gz = Buffer.from(await dl.arrayBuffer())
check('snapshot downloaded', dl.status === 200 && gz.length > 0, `${gz.length} bytes`)

// make a post-snapshot change (a 4th bookmark) that the snapshot must NOT contain
await api('POST', '/api/bookmarks', { type: 'url', title: '快照后新增', url: 'https://upload.test/4' })
let tree = await api('GET', '/api/bookmarks/tree')
check('4 live url rows before restore', tree.data?.nodes?.filter(n=>n.type==='url').length === 4, `n=${tree.data?.nodes?.length}`)

// UPLOAD the downloaded snapshot back -> restores the 3-row state
const fd = new FormData()
fd.append('file', new Blob([gz]), 'snapshot-upload.json.gz')
const up = await fetch(BASE + '/api/snapshots/upload', { method: 'POST', headers: { 'X-CSRF': csrf, Cookie: cookie }, body: fd })
const upData = await up.json()
check('snapshot upload+restore', up.status === 200 && upData?.id, `status=${up.status}`)

tree = await api('GET', '/api/bookmarks/tree')
const titles = tree.data?.nodes?.map((n) => n.title) || []
const urls = tree.data?.nodes?.filter(n=>n.type==='url') || [];
check('tree restored to snapshot content (3 urls, no 新增)', urls.length === 3 && !titles.includes('快照后新增'), JSON.stringify(urls.map(n=>n.title)))
check('imported snapshot appears in list with cause=imported',
  (await api('GET', '/api/snapshots')).data?.snapshots?.some((s) => s.cause === 'imported'),
  JSON.stringify((await api('GET', '/api/snapshots')).data?.snapshots?.map((s) => s.cause)))

// bad-file path: garbage upload must 4xx, not restore garbage
const fd2 = new FormData()
fd2.append('file', new Blob([Buffer.from('not a gzip file')]), 'bogus.json.gz')
const bad = await fetch(BASE + '/api/snapshots/upload', { method: 'POST', headers: { 'X-CSRF': csrf, Cookie: cookie }, body: fd2 })
check('garbage upload rejected 4xx', bad.status >= 400 && bad.status < 500, `status=${bad.status}`)

// session without CSRF rejected
const noCsrf = await fetch(BASE + '/api/snapshots/upload', { method: 'POST', headers: { Cookie: cookie }, body: new FormData() })
check('upload without CSRF rejected', noCsrf.status === 403, `status=${noCsrf.status}`)

const failed = results.filter((x) => !x).length
console.log(`\n=== ${results.length - failed}/${results.length} checks passed ===`)
process.exit(failed ? 1 : 0)
