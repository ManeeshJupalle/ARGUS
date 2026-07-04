import { defineConfig } from 'vitest/config';

// Parser/history tests are pure logic — no DOM environment needed.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});