import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { cpSync, copyFileSync, existsSync } from 'node:fs'

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
      },
    },
  ],
})
