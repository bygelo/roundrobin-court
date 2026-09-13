import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const API_ORIGIN = process.env['COURT_API_ORIGIN'] ?? 'http://localhost:8787'
const SERVER_PREFIX = ['/api', '/public', '/output', '/scan', '/health', '/docs']

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../dist/web', import.meta.url)),
    emptyOutDir: true,
    assetsDir: 'asset',
  },
  server: {
    // Never a framework default: 8797 is claimed for this app's web dev server.
    port: 8797,
    strictPort: true,
    proxy: Object.fromEntries(SERVER_PREFIX.map((prefix) => [prefix, { target: API_ORIGIN, changeOrigin: true }])),
  },
})
