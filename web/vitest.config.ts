import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Node, not a DOM: what is tested here is pure functions, the API client against a stubbed
// `fetch`, and screens rendered to markup by `react-dom/server`. A file whose subject only exists
// once effects run — a timer, a navigation, a cache cleared on mount — opts into jsdom with a
// `@vitest-environment jsdom` docblock. A suite that needs a real browser belongs with the
// journeys in `tests/ui/`.
export default defineConfig({
  plugins: [react()],
  test: { include: ['tests/**/*.test.{ts,tsx}'], environment: 'node' },
})
