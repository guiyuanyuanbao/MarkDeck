const fs = require('fs')

// 1) options.html: insert connection card before conflict card
const htmlFile = 'D:/Code/AiWorkSpace/ZCode/MarkDeck/extension/public/options.html'
let html = fs.readFileSync(htmlFile, 'utf8')
const anchor = `    <div class="card conflict-card" id="conflictCard" style="display:none">`
const addition = `    <div class="card conn-card" id="connCard" style="display:none">
      <div style="display:flex; align-items:center; gap:10px">
        <span class="dot" id="connDot"></span>
        <b id="connTitle" style="font-size:14px">检查连接…</b>
      </div>
      <p class="hint" id="connDesc" style="margin-top:6px"></p>
    </div>

    <div class="card conflict-card" id="conflictCard" style="display:none">`
if (!html.includes(anchor)) { console.log('HTML ANCHOR NOT FOUND'); process.exit(1) }
html = html.replace(anchor, addition)
const cssAnchor = `    .conflict-card { border-color: #f5d98d; background: #fffdf5; }`
const cssAdd = `    .conn-card .dot { width: 10px; height: 10px; border-radius: 50%; }
    .conn-card .dot.online { background: var(--success); box-shadow: 0 0 0 3px rgba(35,168,119,.18); }
    .conn-card .dot.off { background: var(--warning); box-shadow: 0 0 0 3px rgba(245,166,35,.18); }
    .conn-card .dot.err { background: var(--danger); box-shadow: 0 0 0 3px rgba(229,72,77,.15); }
    .conn-card .dot.none { background: var(--text3); }
    .conflict-card { border-color: #f5d98d; background: #fffdf5; }`
if (!html.includes(cssAnchor)) { console.log('CSS ANCHOR NOT FOUND'); process.exit(1) }
html = html.replace(cssAnchor, cssAdd)
fs.writeFileSync(htmlFile, html)
console.log('HTML PATCHED')

// 2) options.ts: refresh connection status card
const tsFile = 'D:/Code/AiWorkSpace/ZCode/MarkDeck/extension/src/options.ts'
let ts = fs.readFileSync(tsFile, 'utf8')
const tsAnchor = `// conflict detection: duplicated bookmarks hint at double-sync`
const tsAdd = `// live connection status card (always visible)
async function refreshConnStatus() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'status' })
    const card = document.getElementById('connCard')!
    const dot = document.getElementById('connDot')!
    const title = document.getElementById('connTitle')!
    const desc = document.getElementById('connDesc')!
    card.style.display = 'block'
    const q = resp.queued > 0 ? \`，本地已保存 \${resp.queued} 条待同步\` : ''
    switch (resp.status) {
      case 'online':
        dot.className = 'dot online'
        title.textContent = '✓ 已连接服务器'
        desc.textContent = '书签双向实时同步中' + q
        break
      case 'disconnected':
        dot.className = 'dot off'
        title.textContent = '⚠ 与服务器断联'
        desc.textContent = '改动已保存在本地（' + (resp.queued || 0) + ' 条待同步），恢复连接后自动同步；书签查看与搜索不受影响。'
        break
      case 'unauthorized':
        dot.className = 'dot err'
        title.textContent = '设备令牌已失效'
        desc.textContent = '请在下方重新配对以恢复同步。'
        break
      default:
        dot.className = 'dot none'
        title.textContent = '尚未配对'
        desc.textContent = '填写上方服务器地址与配对码完成连接。'
    }
  } catch { /* ignore */ }
}
refreshConnStatus()
setInterval(refreshConnStatus, 10000)

// conflict detection: duplicated bookmarks hint at double-sync`
if (!ts.includes(tsAnchor)) { console.log('TS ANCHOR NOT FOUND'); process.exit(1) }
ts = ts.replace(tsAnchor, tsAdd)
fs.writeFileSync(tsFile, ts)
console.log('TS PATCHED')
