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

// Extension build: plain ESM outputs copied next to manifest.json.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/background.ts'),
        popup: resolve(__dirname, 'src/popup.ts'),
        options: resolve(__dirname, 'src/options.ts'),
      },
      output: {
        // flat names matching manifest.json (background.js, popup.js, options.js)
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: 'assets/[name]',
      },
    },
  },
  plugins: [
    {
      name: 'copy-static',
      closeBundle() {
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
