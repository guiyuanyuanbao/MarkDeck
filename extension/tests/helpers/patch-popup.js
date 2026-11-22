const fs = require('fs')
const file = 'D:/Code/AiWorkSpace/ZCode/MarkDeck/extension/src/popup.ts'
let s = fs.readFileSync(file, 'utf8')
const anchor = [
  "    if (resp.queued > 0) $('queueInfo').textContent = `待同步 ${resp.queued}`",
  "    else $('queueInfo').textContent = ''",
  "  } catch {",
  "    $('statusText').textContent = '状态获取失败'",
  "  }",
  "}",
].join('\n')
const replacement = [
  "    if (resp.queued > 0) $('queueInfo').textContent = `待同步 ${resp.queued}`",
  "    else $('queueInfo').textContent = ''",
  "    updateOfflineBanner(resp.status, resp.queued)",
  "  } catch {",
  "    $('statusText').textContent = '状态获取失败'",
  "  }",
  "}",
  "",
  "function updateOfflineBanner(status: string, queued: number) {",
  "  const banner = $('offlineBanner') as HTMLElement",
  "  const title = $('offlineTitle') as HTMLElement",
  "  const queue = $('offlineQueue') as HTMLElement",
  "  if (status === 'disconnected' || status === 'unauthorized') {",
  "    banner.style.display = 'block'",
  "    banner.className = 'offline-banner' + (status === 'unauthorized' ? ' revoked' : '')",
  "    title.textContent = status === 'unauthorized' ? '⚠️ 设备令牌已失效' : '⚠️ 与服务器断联'",
  "    queue.textContent = queued > 0 ? `本地已保存 ${queued} 条改动，恢复连接后自动同步` : ''",
  "  } else {",
  "    banner.style.display = 'none'",
  "  }",
  "}",
].join('\n')
if (!s.includes(anchor)) { console.log('ANCHOR NOT FOUND'); process.exit(1) }
s = s.replace(anchor, replacement)
fs.writeFileSync(file, s)
console.log('PATCHED')
