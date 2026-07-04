import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // Explicit empty PostCSS config: without it Vite searches parent dirs and
  // can pick up stray configs outside the repo (observed: D:\postcss.config.js
  // demanding tailwindcss, which this project deliberately does not use).
  css: { postcss: {} },
  server: {
    proxy: {
      // Everything under /api is served by the Hono server (§3: the browser
      // never talks to external APIs, only the internal one).
      '/api': 'http://127.0.0.1:3001',
    },
  },
});
