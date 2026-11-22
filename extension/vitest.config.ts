import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // e2e 多设备脚本（tests/e2e/*.check.mjs）需要真实服务器，不在 vitest 里跑
  },
})
