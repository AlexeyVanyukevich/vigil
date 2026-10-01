import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // One origin in development too, so the session cookie needs no cross-site relaxation and
  // there is no CORS to configure differently from production.
  //
  // `changeOrigin: false` is load-bearing, not tidiness. The server refuses any write whose
  // `Origin` disagrees with the `Host` it was addressed to. Left to its default the proxy
  // rewrites `Host` to the target while the browser's `Origin` stays the dev server's, and
  // every write in development is refused. The shorthand string form takes that default
  // silently.
  server: { proxy: { '/api': { target: 'http://localhost:4100', changeOrigin: false } } },
  build: { outDir: '../server/public', emptyOutDir: true },
})
