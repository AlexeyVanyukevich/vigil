// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import { IssueDetail } from '../src/routes/IssueDetail'
import { ID } from './fixtures'
import { mount, type Mounted } from './mount'

// The router hands the screen its id decoded. Put back into a path as it is, a link to
// `/issues/..%2Fapps` would fetch `/api/apps`, and the screen would render an answer that is not
// an issue at all.

interface IdCase {
  name: string
  /** The address the owner followed. */
  link: string
  /** What the screen must ask the server for. */
  fetched: string
}

const ids: IdCase[] = [
  { name: 'an ordinary id', link: `/issues/${ID}`, fetched: `/api/issues/${ID}` },
  {
    name: 'an id that climbs out of the issues path',
    link: '/issues/..%2Fapps',
    fetched: '/api/issues/..%2Fapps',
  },
  {
    name: 'an id carrying a query string',
    link: '/issues/x%3Fstatus%3Dopen',
    fetched: '/api/issues/x%3Fstatus%3Dopen',
  },
]

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  vi.unstubAllGlobals()
})

describe('the issue detail asks for its own issue', () => {
  it.each(ids)('$name', async ({ link, fetched }) => {
    const fetch = vi.fn((_path: string, _init?: RequestInit) => new Promise<never>(() => {}))
    vi.stubGlobal('fetch', fetch)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    mounted = await mount(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[link]}>
          <Routes>
            <Route path="/issues/:id" element={<IssueDetail />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([fetched])
  })
})
