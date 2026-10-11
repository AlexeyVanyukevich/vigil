// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import { IssueDetail } from '../src/routes/IssueDetail'
import { Issues } from '../src/routes/Issues'
import { ID, OPENING, occurrence, summary } from './fixtures'
import { mount, type Mounted } from './mount'

// "Last seen 2m ago" answers whether something is still happening. A screen left open must keep
// answering it: nothing else re-renders it while the data stays the same, so the times have to
// advance on their own.

const NOW = Date.parse('2026-09-07T12:00:00.000Z')
const SEEN = new Date(NOW - 90_000).toISOString()

interface TickCase {
  name: string
  path: string
  before: string
  /** A minute later, with nothing fetched and nothing clicked. */
  after: string
}

const ticks: TickCase[] = [
  { name: 'the issues list', path: '/', before: 'last seen 1m ago', after: 'last seen 2m ago' },
  {
    name: 'the issue detail',
    path: `/issues/${ID}`,
    before: 'last seen 1m ago',
    after: 'last seen 2m ago',
  },
]

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('relative times on an open screen', () => {
  it.each(ticks)('$name advances without a refetch', async ({ path, before, after }) => {
    vi.useFakeTimers({ now: NOW })
    // Whatever the seed leaves out stays loading; nothing here is about the server.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<never>(() => {})),
    )

    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    })
    const issue = summary({ first_seen_at: SEEN, last_seen_at: SEEN })
    client.setQueryData(['issues', OPENING], { issues: [issue] })
    client.setQueryData(['issue', ID], { issue, events: [occurrence()] })

    mounted = await mount(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/" element={<Issues />} />
            <Route path="/issues/:id" element={<IssueDetail />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(mounted.text()).toContain(before)

    act(() => {
      vi.advanceTimersByTime(60_000)
    })

    expect(mounted.text()).toContain(after)
  })
})
