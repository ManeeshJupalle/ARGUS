import { defineConfig } from 'vitest/config';

// A config file here also stops vitest from walking up past the workspace
// looking for one (a stray vite.config.ts outside the repo would break runs).
export default defineConfig({
  test: {
    environment: 'node',
  },
});
