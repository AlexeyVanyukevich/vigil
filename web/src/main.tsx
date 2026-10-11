import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from './App'
import { recheckOnRestore } from './session'
import './styles.css'

const client = new QueryClient({
  defaultOptions: {
    queries: {
      // "Is it still happening" is the question this tool exists to answer, so a stale list is
      // worse than a slightly chatty one.
      staleTime: 10_000,
      refetchOnWindowFocus: true,
      retry: false,
    },
  },
})

// For the page's lifetime: a page comes back from the back-forward cache at any moment.
recheckOnRestore(client)

const root = document.getElementById('root')
if (root === null) throw new Error('No #root in the document')

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
