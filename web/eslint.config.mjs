// ESLint flat config for the Vue web app. Kept deliberately loose: the
// refactor program's goal is regression prevention, not a stylistic rewrite.
// TypeScript unused-var checking is already covered by vue-tsc noUnusedLocals.
import js from '@eslint/js'
import pluginVue from 'eslint-plugin-vue'
import tseslint from 'typescript-eslint'
import vueParser from 'vue-eslint-parser'

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended.map((c) => ({ ...c, files: ['src/**/*.ts', 'src/**/*.vue'] })),
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['src/**/*.{ts,vue}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      // .vue files: vue-eslint-parser walks the SFC and delegates <script> to
      // the TS parser; .ts files use the TS parser directly
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.vue'],
      },
      globals: {
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        history: 'readonly',
        fetch: 'readonly',
        FormData: 'readonly',
        Blob: 'readonly',
        File: 'readonly',
        AbortSignal: 'readonly',
        CustomEvent: 'readonly',
        WebSocket: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        HTMLElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        HTMLAnchorElement: 'readonly',
        Node: 'readonly',
        KeyboardEvent: 'readonly',
        MouseEvent: 'readonly',
        Event: 'readonly',
        ResizeObserver: 'readonly',
        requestAnimationFrame: 'readonly',
      },
    },
    rules: {
      // vue-tsc (noUnusedLocals) is the authority on unused symbols
      '@typescript-eslint/no-unused-vars': 'off',
      'no-unused-vars': 'off',
      // Phase 0 gate: warn while the catch(e: any) pattern (~41 sites) is
      // still being migrated to typed errors in the refactor program;
      // raise to 'error' once Phase 2 removes the pattern.
      '@typescript-eslint/no-explicit-any': 'warn',
      'vue/multi-word-component-names': 'off',
      // existing templates use both orders; don't mass-rewrite
      'vue/attributes-order': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/multiline-html-element-content-newline': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/html-self-closing': 'off',
      'vue/html-indent': 'off',
      'vue/html-closing-bracket-newline': 'off',
      'vue/html-closing-bracket-spacing': 'off',
      'vue/first-attribute-linebreak': 'off',
      'vue/component-definition-name-casing': 'off',
      'vue/no-v-html': 'off',
      'vue/require-default-prop': 'off',
      'vue/require-explicit-emits': 'off',
      eqeqeq: ['warn', 'smart'],
      'prefer-const': 'warn',
      'no-var': 'error',
      'no-throw-literal': 'error',
      'no-debugger': 'warn',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', '**/*.d.ts'],
  },
]
