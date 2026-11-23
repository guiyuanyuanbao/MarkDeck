const fs = require('fs')
const s = fs.readFileSync('src/background.ts', 'utf8')
const applyStart = s.indexOf('async function applyRemote')
const applyEnd = s.indexOf('async function forceResync')
const body = s.slice(applyStart, applyEnd)
console.log('applyRemote body size:', body.length)
const pats = ['mapToLocalIdStrict', 'localCache()', 'idMap()', 'getQueue()', 'mapToServerId', 'chrome.bookmarks.get(', 'sw_findNodeByTitle', 'recordIdMapping']
for (const pat of pats) {
  const count = body.split(pat).length - 1
  console.log(pat + ':', count)
}
