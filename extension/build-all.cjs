// build-all.cjs — run the three per-entry vite builds sequentially with the
// MD_ENTRY env var (npm on Windows mangles env-prefixed && chains in shell
// strings; this keeps the build script cross-platform).
const { spawnSync } = require('child_process')

const entries = ['background', 'popup', 'options']
for (const entry of entries) {
  console.log(`\n=== building ${entry} ===`)
  const r = spawnSync('npx', ['vite', 'build'], {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, MD_ENTRY: entry },
  })
  if (r.status !== 0) {
    console.error(`build failed for ${entry}`)
    process.exit(r.status || 1)
  }
}
console.log('\nALL ENTRIES BUILT')
