// snapshot-upload.mjs — verify the snapshot upload/restore round trip:
// create bookmarks -> take snapshot -> download it -> wipe tree (via
// restore of an empty older snapshot + verifying content) -> upload the
// downloaded file back -> content returns. Also asserts the bad-file path.
import { BASE, check, summary, api, session, bootstrap } from './lib.mjs'

await bootstrap()

// seed bookmarks
for (let i = 1; i <= 3; i++) {
  await api('POST', '/api/bookmarks', { type: 'url', title: '上传测试' + i, url: 'https://upload.test/' + i })
}

// snapshot + download (raw fetch: binary body — session cookie passed explicitly)
const snap = await api('POST', '/api/snapshots')
check('snapshot created', snap.status === 201 && snap.data?.id)
const dl = await fetch(BASE + `/api/snapshots/${snap.data.id}/download`, { headers: { Cookie: session.cookie } })
const gz = Buffer.from(await dl.arrayBuffer())
check('snapshot downloaded', dl.status === 200 && gz.length > 0, `${gz.length} bytes`)

// make a post-snapshot change (a 4th bookmark) that the snapshot must NOT contain
await api('POST', '/api/bookmarks', { type: 'url', title: '快照后新增', url: 'https://upload.test/4' })
let tree = await api('GET', '/api/bookmarks/tree')
check('4 live url rows before restore', tree.data?.nodes?.filter(n=>n.type==='url').length === 4, `n=${tree.data?.nodes?.length}`)

// UPLOAD the downloaded snapshot back -> restores the 3-row state
const fd = new FormData()
fd.append('file', new Blob([gz]), 'snapshot-upload.json.gz')
const up = await fetch(BASE + '/api/snapshots/upload', {
  method: 'POST', headers: { 'X-CSRF': session.csrf, Cookie: session.cookie }, body: fd,
})
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
const bad = await fetch(BASE + '/api/snapshots/upload', {
  method: 'POST', headers: { 'X-CSRF': session.csrf, Cookie: session.cookie }, body: fd2,
})
check('garbage upload rejected 4xx', bad.status >= 400 && bad.status < 500, `status=${bad.status}`)

// session without CSRF rejected
const noCsrf = await fetch(BASE + '/api/snapshots/upload', {
  method: 'POST', headers: { Cookie: session.cookie }, body: new FormData(),
})
check('upload without CSRF rejected', noCsrf.status === 403, `status=${noCsrf.status}`)

summary()
