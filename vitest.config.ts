import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    reporters: ['default'],
    projects: [
      {
        plugins: [react()],
        test: {
          name: 'shared',
          environment: 'node',
          include: ['shared/test/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'backend',
          environment: 'node',
          include: ['backend/test/**/*.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'frontend',
          environment: 'jsdom',
          globals: true,
          setupFiles: [r('./frontend/test/setup.ts')],
          include: ['frontend/test/**/*.test.tsx', 'frontend/test/**/*.test.ts'],
          css: false,
        },
      },
      {
        test: {
          name: 'e2e',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
