import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // API mode (VITE_API_URL=/api): the local /v1 API on the same origin as the explorer,
    // so the session cookie needs no CORS. Inert in the static build, which never calls /api.
    proxy: {
      '/api': {
        target: process.env.API_PROXY_TARGET ?? 'http://localhost:3001',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    // The integration tests query a real ClickHouse, all of them sharing one server under
    // parallel workers. The heaviest walk all 74,889 rows or run a request end to end
    // (several averaged estimate runs plus the computation), and 15 s produced spurious
    // timeouts under that contention. Unit tests are unaffected: they finish in milliseconds.
    testTimeout: 60_000,
  },
})
