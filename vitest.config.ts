import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Lua/Redis integration tests are inherently sequential per key; give them room.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // A single Redis instance is shared, so run test files serially to avoid
    // cross-file key collisions. Within a file, tests use unique key prefixes.
    fileParallelism: false,
    include: ['test/**/*.test.ts'],
  },
});
