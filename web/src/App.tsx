import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { api, NotSignedIn } from './api'
import { messageFor } from './errors'
import { Login } from './routes/Login'

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
      <Routes>
        <Route path="/login" element={<Login />} />
        {/* Task 13 replaces this with the Issues and IssueDetail routes. */}
        <Route
          path="/"
          element={
            <RequireSession>
              <p>Signed in.</p>
            </RequireSession>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
