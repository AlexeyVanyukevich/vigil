// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from '../src/App'
import { OPENING, summary } from './fixtures'
import { mount, type Mounted } from './mount'

// The whole app, router and all, against a stubbed `fetch`: what happens to a signed-in tab when
// the server says the session is over. `session.test.ts` covers the functions; this covers that
// the app actually wires them in. The full journeys — sign out then Back, a session expiring
// mid-use — belong to the browser suite in `tests/ui/`.

const ISSUE = summary({ title: 'TypeError: a protected screen, rendered from memory' })

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

/** A tab that was signed in a moment ago: the session and the list are in the cache. */
function signedInCache(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  })
  client.setQueryData(['session'], { signedIn: true })
  client.setQueryData(['issues', OPENING], { issues: [ISSUE] })
  return client
}

function app(client: QueryClient) {
  return mount(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  )
}

const unauthorized = () =>
  Promise.resolve(
    new Response(JSON.stringify({ error: 'unauthorized', message: 'Not signed in' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }),
  )

describe('a 401 on a screen that is already showing', () => {
  it('sends the owner to the login screen', async () => {
    // The session and the list are cached; the applications are not, so the list asks for them,
    // and the server — the session having expired meanwhile — answers 401.
    vi.stubGlobal('fetch', vi.fn(unauthorized))
    window.history.replaceState(null, '', '/')

    mounted = await app(signedInCache())

    await vi.waitFor(() => {
      expect(window.location.pathname).toBe('/login')
      expect(mounted?.text()).toContain('Password')
    })
  })
})

describe('the login screen', () => {
  it('leaves nothing behind for Back to render from memory', async () => {
    // The server is slow to answer, so anything shown before it does came from the cache.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<never>(() => {})),
    )
    window.history.replaceState(null, '', '/')
    window.history.pushState(null, '', '/login')
    const client = signedInCache()

    mounted = await app(client)
    expect(mounted.text()).toContain('Password')
    expect(client.getQueryData(['session'])).toBeUndefined()

    window.history.back()

    await vi.waitFor(() => {
      expect(window.location.pathname).toBe('/')
      expect(mounted?.text()).toContain('Loading…')
    })
    expect(mounted.text()).not.toContain(ISSUE.title)
  })
})
