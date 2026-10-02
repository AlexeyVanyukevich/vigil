import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

// Tells React its updates are driven from `act`, so each is flushed before an assertion reads
// the page. Only meaningful in a file running under jsdom.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

export interface Mounted {
  /** What the owner would read on the page. */
  text: () => string
  unmount: () => void
}

/** A live render, effects and all — what `react-dom/server` cannot show. */
export async function mount(element: ReactNode): Promise<Mounted> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(element)
  })
  return {
    text: () => container.textContent,
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
}
