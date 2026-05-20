import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    passWithNoTests: true,
    setupFiles: ['./test/setup.ts'],
    exclude: ['**/node_modules/**', 'node_modules/**', 'dist/**', 'external/**', '**/.{tmp,temp}/**', '**/.tmp/**']
  }
})
