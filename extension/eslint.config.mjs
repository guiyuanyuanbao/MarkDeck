// ESLint flat config for the browser extension.
//
// Scope note: TS sources are linted ONLY by `tsc --noEmit` (strict). The
// extension intentionally uses TypeScript 7 (native compiler), which is
// outside typescript-eslint's supported peer range (<6.1) — installing it
// would force a downgrade. ESLint here covers the .mjs/.js E2E harness
// scripts that tsc never sees.
import js from '@eslint/js'

export default [
  js.configs.recommended,
  {
    files: ['tests/e2e/**/*.mjs', 'tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        FormData: 'readonly',
        Blob: 'readonly',
        WebSocket: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        AbortSignal: 'readonly',
        performance: 'readonly',
        Buffer: 'readonly',
        AbortController: 'readonly',
        TextEncoder: 'readonly',
        crypto: 'readonly',
        // injected into device-worker sandboxes / DOM-level test pages
        chrome: 'readonly',
        document: 'readonly',
        window: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        // CommonJS helpers under tests/helpers
        require: 'readonly',
        __dirname: 'readonly',
        module: 'writable',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
      // E2E helpers use `try { ... } catch { /* tolerate */ }` broadly
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['warn', 'smart'],
      'prefer-const': 'warn',
      'no-var': 'error',
      'no-throw-literal': 'error',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', '**/*.d.ts'],
  },
]
