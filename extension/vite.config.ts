import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { cpSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

// Stamp the extension version from the repo's VERSION file so every release
// zip carries the real version (was hardcoded 1.0.0 forever). Chrome uses
// this to decide update availability against the update manifest.
function repoVersion(): string {
  try {
    return readFileSync(resolve(__dirname, '../VERSION'), 'utf8').trim()
  } catch {
    return '0.0.0'
  }
}

const entry = process.env.MD_ENTRY || 'background' // background | popup | options

// Extension build: one self-contained ESM file per entry, copied next to
// manifest.json. Entries are built SEPARATELY (npm run build loops
// MD_ENTRY=x vite build) with codeSplitting:false — each output is fully
// self-contained with no chunks/. MV3 service workers are loaded as one
// file, and the E2E device-worker sandbox copies background.js alone: a
// shared chunks/constants.js broke that harness the moment constants.ts
// started being imported by two entries (rolldown emitted the shared chunk
// automatically on the old single multi-input build).
export default defineConfig({
  publicDir: false, // public/ copied by copy-static on the background pass only
  build: {
    outDir: 'dist',
    emptyOutDir: entry === 'background', // first entry wipes, others append
    rollupOptions: {
      input: resolve(__dirname, `src/${entry}.ts`),
      output: {
        entryFileNames: `${entry}.js`,
        codeSplitting: false,
      },
    },
  },
  plugins: [
    {
      name: 'copy-static',
      closeBundle() {
        if (entry !== 'background') return // last-writer copies public assets
        cpSync('public', 'dist', { recursive: true })
        // simple icon fallback if none provided
        if (!existsSync('dist/icon.png')) {
          copyFileSync('public/icon.png', 'dist/icon.png')
        }
        // stamp the real version into the built manifest
        const mf = resolve(__dirname, 'dist/manifest.json')
        try {
          const json = JSON.parse(readFileSync(mf, 'utf8'))
          json.version = repoVersion()
          writeFileSync(mf, JSON.stringify(json, null, 2) + String.fromCharCode(10))
        } catch (e) {
          console.warn('manifest version stamp failed:', e)
        }
      },
    },
  ],
})
