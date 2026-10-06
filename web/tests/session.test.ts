import { afterEach, describe, expect, it, vi } from 'vitest'
import { MutationObserver, QueryClient, QueryObserver } from '@tanstack/react-query'
import { ApiError, NotSignedIn } from '../src/api'
import { recheckOnRestore, signOut, watchForSignOut } from '../src/session'

afterEach(() => {
  vi.unstubAllGlobals()
})

function client(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

interface WatchCase {
  name: string
  via: 'query' | 'mutation'
  /** What the call fails with, or `undefined` when it succeeds. */
  failure: Error | undefined
  signsOut: boolean
}

const gone = () => new NotSignedIn('unauthorized', 401, 'x')

const watched: WatchCase[] = [
  { name: 'a query answered 401', via: 'query', failure: gone(), signsOut: true },
  { name: 'a mutation answered 401', via: 'mutation', failure: gone(), signsOut: true },
  {
    name: 'a query that cannot reach the server',
    via: 'query',
    failure: new ApiError('offline', 0, 'x'),
    signsOut: false,
  },
  {
    name: 'a mutation refused for another reason',
    via: 'mutation',
    failure: new ApiError('not_found', 404, 'x'),
    signsOut: false,
  },
  {
    name: 'a failure that is not from the api at all',
    via: 'query',
    failure: new TypeError('x'),
    signsOut: false,
  },
  { name: 'a query that succeeds', via: 'query', failure: undefined, signsOut: false },
  { name: 'a mutation that succeeds', via: 'mutation', failure: undefined, signsOut: false },
]

async function run(queryClient: QueryClient, via: 'query' | 'mutation', failure?: Error) {
  const work = () => (failure === undefined ? Promise.resolve('ok') : Promise.reject(failure))
  if (via === 'query') {
    await queryClient.fetchQuery({ queryKey: ['anything'], queryFn: work }).catch(() => undefined)
  } else {
    await new MutationObserver(queryClient, { mutationFn: work }).mutate().catch(() => undefined)
  }
}

describe('watchForSignOut', () => {
  it.each(watched)('$name', async ({ via, failure, signsOut }) => {
    const queryClient = client()
    const onSignedOut = vi.fn()
    watchForSignOut(queryClient, onSignedOut)

    await run(queryClient, via, failure)

    expect(onSignedOut).toHaveBeenCalledTimes(signsOut ? 1 : 0)
  })

  it('stops watching once unsubscribed', async () => {
    const queryClient = client()
    const onSignedOut = vi.fn()
    const stop = watchForSignOut(queryClient, onSignedOut)

    stop()
    await run(queryClient, 'query', gone())
    await run(queryClient, 'mutation', gone())

    expect(onSignedOut).not.toHaveBeenCalled()
  })
})

interface SignOutCase {
  name: string
  /** What `POST /api/logout` answers; `undefined` is a refused connection. */
  status: number | undefined
  signedOut: boolean
}

const signOuts: SignOutCase[] = [
  { name: 'the server ends the session', status: 204, signedOut: true },
  // Already over — expired, or ended on another device. The tab is signed out either way.
  { name: 'the session had already ended', status: 401, signedOut: true },
  // The cookie is still good on the server. Showing the login screen now would tell the owner
  // they had signed out when the next visit to `/` lets anyone straight back in.
  { name: 'the server cannot be reached', status: undefined, signedOut: false },
  { name: 'a proxy says the server is down', status: 502, signedOut: false },
]

describe('signOut', () => {
  it.each(signOuts)('$name', async ({ status, signedOut }) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        status === undefined
          ? Promise.reject(new TypeError('Failed to fetch'))
          : Promise.resolve(new Response(null, { status })),
      ),
    )
    const queryClient = client()
    queryClient.setQueryData(['session'], { signedIn: true })
    queryClient.setQueryData(['issues', {}], { issues: [] })

    // What the cache held at the moment of leaving: anything left in it renders the dashboard
    // from memory when the owner presses Back or goes to `/`, without asking the server.
    let cachedWhenLeaving: number | undefined
    const navigate = vi.fn((_to: string, _options: { replace: boolean }) => {
      cachedWhenLeaving = queryClient.getQueryCache().getAll().length
    })

    const outcome = await signOut(queryClient, navigate).then(
      () => 'done',
      (cause: unknown) => cause,
    )

    if (signedOut) {
      expect(outcome).toBe('done')
      expect(navigate).toHaveBeenCalledWith('/login', { replace: true })
      expect(cachedWhenLeaving).toBe(0)
    } else {
      expect(outcome).toBeInstanceOf(ApiError)
      expect(outcome).toMatchObject({ code: 'offline' })
      expect(navigate).not.toHaveBeenCalled()
      expect(queryClient.getQueryData(['session'])).toEqual({ signedIn: true })
    }
  })
})

interface RestoreCase {
  name: string
  /** `PageTransitionEvent.persisted`: true when the page came back from the back-forward cache. */
  persisted: boolean
  rechecks: boolean
}

const restores: RestoreCase[] = [
  // Its memory is from whenever the owner left it, signed in perhaps, in a session that a later
  // visit has since ended. Nothing in it can be trusted to say who may see the screen.
  { name: 'a page restored from the back-forward cache', persisted: true, rechecks: true },
  // A fresh load has asked the server already; asking again is a wasted round trip.
  { name: 'a page loaded afresh', persisted: false, rechecks: false },
]

const pageshow = (persisted: boolean) => Object.assign(new Event('pageshow'), { persisted })

describe('recheckOnRestore', () => {
  it.each(restores)('$name', async ({ persisted, rechecks }) => {
    const page = new EventTarget()
    const queryClient = client()
    const asked = vi.fn(() => Promise.resolve({ signedIn: true }))
    // The screen on show: `RequireSession` is observing the session.
    const observer = new QueryObserver(queryClient, { queryKey: ['session'], queryFn: asked })
    const stopObserving = observer.subscribe(() => {})
    await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual({ signedIn: true }))
    // A screen no longer on show, whose answer would render on Back.
    queryClient.setQueryData(['issues', {}], { issues: [] })

    recheckOnRestore(queryClient, page)
    page.dispatchEvent(pageshow(persisted))

    if (rechecks) {
      expect(queryClient.getQueryData(['issues', {}])).toBeUndefined()
      // Pending again, so `RequireSession` shows nothing until the server has answered.
      expect(observer.getCurrentResult().isPending).toBe(true)
      await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(2))
    } else {
      expect(queryClient.getQueryData(['issues', {}])).toEqual({ issues: [] })
      expect(queryClient.getQueryData(['session'])).toEqual({ signedIn: true })
      expect(asked).toHaveBeenCalledTimes(1)
    }
    stopObserving()
  })

  it('stops listening once unsubscribed', () => {
    const page = new EventTarget()
    const queryClient = client()
    queryClient.setQueryData(['session'], { signedIn: true })

    recheckOnRestore(queryClient, page)()
    page.dispatchEvent(pageshow(true))

    expect(queryClient.getQueryData(['session'])).toEqual({ signedIn: true })
  })
})
