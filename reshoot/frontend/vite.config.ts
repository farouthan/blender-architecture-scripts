import { defineConfig } from 'vite';

// The API lives on the Python server.  In dev the Vite server proxies to it so
// the browser sees a single origin and nothing needs CORS or absolute URLs.
const API_TARGET = process.env.RESHOOT_API ?? 'http://127.0.0.1:8000';

export default defineConfig({
  server: {
    host: true, // reachable from a phone on the same network
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
