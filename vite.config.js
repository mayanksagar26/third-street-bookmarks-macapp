import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri drives this dev server; it needs a fixed port and must not silently
// fall back to another one, or the webview points at nothing.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    // Browser-only dev (`npm run dev`) still talks to a hand-started Express
    // on 3456. Inside Tauri the shim in src/api-base.js takes over instead.
    proxy: {
      '/api': 'http://127.0.0.1:3456',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'safari15',
  },
});
