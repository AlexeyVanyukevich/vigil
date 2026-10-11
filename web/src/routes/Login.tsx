import { useEffect, useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { api, ApiError } from '../api'
import { messageFor } from '../errors'

export function Login() {
  const navigate = useNavigate()
  const client = useQueryClient()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)

  // Whatever the dashboard cached belongs to a session that is over — signed out, expired, or
  // never begun — and `RequireSession` would render it on Back without asking the server. By the
  // time this screen mounts nothing is rendering from it, so clearing it cannot set off a refetch.
  useEffect(() => {
    client.clear()
  }, [client])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      await api.post('/api/login', { password })
      await navigate('/', { replace: true })
    } catch (cause) {
      // The server answers the same way for a wrong password and for one never set, and this
      // says the same thing back: which of the two it is must not be readable from here.
      setError(
        cause instanceof ApiError && cause.status === 401
          ? 'Wrong password'
          : messageFor(cause, 'Could not sign in'),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="login">
      <form className="card login__card" onSubmit={submit}>
        <h1 className="login__title">vigil</h1>
        <p className="login__subtitle">What broke, and whether it is still breaking</p>

        <label className="label" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          className="input"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />

        {error !== undefined && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <button className="button" type="submit" disabled={busy || password.length === 0}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  )
}
