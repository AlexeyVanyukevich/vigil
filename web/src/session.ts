import type { QueryClient } from '@tanstack/react-query'
import { api, NotSignedIn } from './api'

/**
 * Calls `onSignedOut` whenever any query or mutation fails with a 401, whichever screen started
 * it. Without this, a session that expires while the owner is reading an issue leaves them on a
 * screen saying so, with no way back to the login screen but editing the address bar.
 *
 * Returns the unsubscribe, so it can be the body of an effect.
 */
export function watchForSignOut(client: QueryClient, onSignedOut: () => void): () => void {
  const stopQueries = client.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'error') return
    if (event.action.error instanceof NotSignedIn) onSignedOut()
  })
  const stopMutations = client.getMutationCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'error') return
    if (event.action.error instanceof NotSignedIn) onSignedOut()
  })
  return () => {
    stopQueries()
    stopMutations()
  }
}

/**
 * A page restored from the back-forward cache comes back with its memory as it was when the owner
 * left it: signed in, perhaps, in a session a later visit has since ended. That memory is then a
 * guess about the session, and the screen it shows is one the server never approved. Every answer
 * is dropped, and those on show asked for again, so `RequireSession` waits for the server.
 *
 * Signing out clears the cache, but only in the visit that signs out; this is the other visits.
 * Returns the unsubscribe, so it can be the body of an effect.
 */
export function recheckOnRestore(client: QueryClient, page: EventTarget = window): () => void {
  const onShow = (event: Event) => {
    if ((event as PageTransitionEvent).persisted) void client.resetQueries()
  }
  page.addEventListener('pageshow', onShow)
  return () => page.removeEventListener('pageshow', onShow)
}

type Navigate = (to: string, options: { replace: boolean }) => void | Promise<void>

/**
 * The cache is cleared before leaving, not after. `RequireSession` renders from it, so a cached
 * `{ signedIn: true }` left behind would show the dashboard on Back, or on `/`, without asking
 * the server — after the owner was told they had signed out.
 *
 * A 401 means the session was already over, which is the outcome asked for. Any other failure
 * leaves the session alive on the server, so it is thrown for the screen to show rather than
 * dressed up as a sign-out that did not happen.
 */
export async function signOut(client: QueryClient, navigate: Navigate): Promise<void> {
  try {
    await api.post('/api/logout')
  } catch (cause) {
    if (!(cause instanceof NotSignedIn)) throw cause
  }
  client.clear()
  await navigate('/login', { replace: true })
}
