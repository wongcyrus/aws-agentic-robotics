import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
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
