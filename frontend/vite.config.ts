import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@hf/shared': resolve(here, '..', 'shared', 'dist', 'index.js'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
      '/seo': 'http://localhost:8080',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 600,
  },
});
