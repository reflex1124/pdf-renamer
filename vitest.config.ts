import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['out/**', 'release/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['out/**', 'dist/**', 'release/**', 'node_modules/**', 'src-tauri/**'],
    },
  },
});
