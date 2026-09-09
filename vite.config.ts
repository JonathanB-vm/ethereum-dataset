import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    // The API tests query a real ClickHouse; under parallel workers the default 5s is
    // tight enough to produce occasional spurious timeouts.
    testTimeout: 15_000,
  },
})
