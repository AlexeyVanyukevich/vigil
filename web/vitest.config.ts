import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Node, not a DOM: what is tested here is pure functions, the API client against a stubbed
// `fetch`, and screens rendered to markup by `react-dom/server`. A suite that needs a browser
// belongs with the journeys in `tests/ui/`.
export default defineConfig({
  plugins: [react()],
  test: { include: ['tests/**/*.test.{ts,tsx}'], environment: 'node' },
})
