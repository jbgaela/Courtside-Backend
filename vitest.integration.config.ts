import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    environment: 'node',
    globals: false,
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 45_000,
    hookTimeout: 60_000,
    reporters: ['default'],
  },
});
