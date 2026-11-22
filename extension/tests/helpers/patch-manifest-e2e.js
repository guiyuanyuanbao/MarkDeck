// E2E-only manifest patch: Playwright chromium cannot drive the runtime
// permission prompt, so granted host_permissions must be baked into the
// manifest when loading the unpacked extension in tests. Never ship this.
const fs = require('fs')
const path = require('path')
const file = path.resolve(__dirname, '..', '..', 'dist', 'manifest.json')
const m = JSON.parse(fs.readFileSync(file, 'utf8'))
if (!m.host_permissions || !m.host_permissions.length) {
  m.host_permissions = ['http://*/*', 'https://*/*']
  fs.writeFileSync(file, JSON.stringify(m, null, 2) + '\n')
  console.log('manifest patched: +host_permissions')
} else {
  console.log('manifest already patched')
}
