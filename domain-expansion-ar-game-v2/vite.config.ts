import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/test/**'],
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 70,
        branches: 70
      }
    }
  },
  build: {
    rollupOptions: {
      input: {
        player: resolve(__dirname, 'index.html'),
        battle: resolve(__dirname, 'battle.html'),
        media: resolve(__dirname, 'player.html'),
        share: resolve(__dirname, 'share.html')
      }
    }
  }
});
