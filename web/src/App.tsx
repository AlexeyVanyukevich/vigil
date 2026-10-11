import { useEffect, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router'
import { api, NotSignedIn } from './api'
import { messageFor } from './errors'
import { IssueDetail } from './routes/IssueDetail'
import { Issues } from './routes/Issues'
import { Login } from './routes/Login'
import { watchForSignOut } from './session'

/**
 * The session is checked by asking the server, never by reading a cookie: the cookie is
 * httpOnly, and a client-side guess about whether it is still valid would eventually disagree
 * with the server that decides.
 */
export function RequireSession({ children }: { children: ReactNode }) {
  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => api.get<{ signedIn: true }>('/api/me'),
    retry: false,
  })

  if (session.isPending) return <Waiting />
  if (session.error instanceof NotSignedIn) return <Navigate to="/login" replace />
  if (session.error) return <Trouble message={messageFor(session.error)} />
  return <>{children}</>
}

/**
 * A 401 from any query or mutation, on any screen, goes to the login screen.
 *
 * The cache is not cleared here. The router's navigation lands in a transition, and clearing the
 * cache while the screen that failed is still mounted makes it rebuild its queries and fetch
 * again — each fetch another 401 — until the transition commits. The login screen clears it
 * instead, once nothing is rendering from it.
 */
function SignInAgain() {
  const client = useQueryClient()
  const navigate = useNavigate()
  useEffect(
    () => watchForSignOut(client, () => void navigate('/login', { replace: true })),
    [client, navigate],
  )
  return null
}

function Waiting() {
  return (
    <div className="waiting" role="status" aria-live="polite">
      Loading…
    </div>
  )
}

function Trouble({ message }: { message: string }) {
  return (
    <div className="trouble" role="alert">
      <p>{message}</p>
      <button type="button" onClick={() => window.location.reload()}>
        Try again
      </button>
    </div>
  )
}

export function App() {
  return (
    <BrowserRouter>
      <SignInAgain />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/"
          element={
            <RequireSession>
              <Issues />
            </RequireSession>
          }
        />
        <Route
          path="/issues/:id"
          element={
            <RequireSession>
              <IssueDetail />
            </RequireSession>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
