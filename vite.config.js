import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Browser-only dev has no Rust layer to mint an auth token and inject it into
// the page, so the proxy attaches it instead. The standalone server writes the
// token to its data directory (owner-read-only) precisely so this can find it.
//
// Read per request rather than at startup: the file may not exist until the
// server first boots, and a stale value would fail every call with a 401 that
// looks like a bug in the app rather than in the dev setup.
function devAuthHeader(proxyReq) {
  try {
    const token = fs.readFileSync(path.resolve('auth-token'), 'utf8').trim();
    if (token) proxyReq.setHeader('Authorization', `Bearer ${token}`);
  } catch {
    // No token yet — the request will 401 and the next one will succeed.
  }
}

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3456',
        changeOrigin: false,
        configure: proxy => {
          proxy.on('proxyReq', devAuthHeader);
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'safari15',
  },
});
