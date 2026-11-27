// trash-scope-seed.mjs — seed a trash matching the user's regression scenario:
// folder 数据 (2 urls inside) + top-level url + folder Imported (5 urls).
// Deletes everything so the trash has: 2 folders + 4 urls (2 nested).
import { check, summary, api, bootstrap } from './lib.mjs'

await bootstrap()

// folder 数据 with 2 urls inside (this is the regression case: with the old
// type filter active, entering 数据 hid its url children)
const folder = (await api('POST', '/api/bookmarks', { type: 'folder', title: '数据' })).data
await api('POST', '/api/bookmarks', { type: 'url', parentId: folder.id, title: '北邮校园网指南', url: 'https://wiki.buptnet.icu/' })
await api('POST', '/api/bookmarks', { type: 'url', parentId: folder.id, title: '校园网自助服务', url: 'https://self.buptnet.icu/' })
// top-level url
await api('POST', '/api/bookmarks', { type: 'url', title: '顶层书签', url: 'https://top.test/x' })
// folder Imported with 5 urls
const imp = (await api('POST', '/api/bookmarks', { type: 'folder', title: 'Imported' })).data
for (let i = 1; i <= 5; i++) {
  await api('POST', '/api/bookmarks', { type: 'url', parentId: imp.id, title: '导入书签' + i, url: 'https://imported.test/' + i })
}
// delete everything at top level (children become tombstones transitively)
const tree = (await api('GET', '/api/bookmarks/tree')).data.nodes || []
for (const n of tree.filter((x) => x.parentId === '')) {
  await api('DELETE', `/api/bookmarks/${n.id}`)
}
const trash = (await api('GET', '/api/trash')).data.nodes || []
// 2 folders + 4 user urls + 5 imported urls + the md-others holder folder
// (the canonical "Other bookmarks" row is deleted with the rest of the top level)
check('trash seeded (11 rows: 数据+Imported+9 urls incl. md-others)', trash.length === 11,
  `${trash.length} rows: ${trash.map((b) => (b.type === 'folder' ? '📁' : '🔗') + b.title).join(' | ')}`)
summary()
