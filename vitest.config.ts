import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 20_000,
    env: {
      MFA_ENCRYPTION_KEY: 'N1e6jKiRDEV7XvbMd7pKfuDHwXF45AdS6sgKf4jqV0w=',
    },
    reporters: ['default'],
  },
});
