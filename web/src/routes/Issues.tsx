import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router'
import { api, type AppSummary, type IssueStatus, type IssueSummary } from '../api'
import { messageFor } from '../errors'
import { relativeTime } from '../format'
import { environmentsOf, issuesPath, type IssueFilters } from '../issues'
import { useNow } from '../now'
import { signOut } from '../session'

/** Where the screen opens: what is broken now, the most recent first. */
const OPENING: IssueFilters = { app: '', environment: '', status: 'open', sort: 'last_seen' }

/**
 * How many issues the environment control looks through for environment names. The API's
 * maximum; an environment seen only in older issues than these is not offered.
 */
const ENVIRONMENT_SAMPLE = 200

export function Issues() {
  const [filters, setFilters] = useState<IssueFilters>(OPENING)
  const set = (change: Partial<IssueFilters>) =>
    setFilters((current) => ({ ...current, ...change }))
  const now = useNow()

  const apps = useQuery({
    queryKey: ['apps'],
    queryFn: () => api.get<{ apps: AppSummary[] }>('/api/apps'),
  })

  // Under `issues` so a status change, which invalidates that prefix, refreshes it too. Not
  // narrowed by environment or status, or choosing one would hide every other from the control.
  const seen = useQuery({
    queryKey: ['issues', 'environments', filters.app],
    queryFn: () =>
      api.get<{ issues: IssueSummary[] }>(
        issuesPath({ ...OPENING, app: filters.app, status: '' }, ENVIRONMENT_SAMPLE),
      ),
  })

  const issues = useQuery({
    queryKey: ['issues', filters],
    queryFn: () => api.get<{ issues: IssueSummary[] }>(issuesPath(filters)),
  })

  return (
    <main className="screen">
      <header className="screen__head">
        <h1 className="screen__title">Issues</h1>
        <SignOut />
      </header>

      <div className="filters">
        <select
          className="select"
          aria-label="Application"
          value={filters.app}
          onChange={(event) => set({ app: event.target.value })}
        >
          <option value="">All applications</option>
          {(apps.data?.apps ?? []).map((app) => (
            <option key={app.id} value={app.slug}>
              {app.name}
            </option>
          ))}
        </select>

        <select
          className="select"
          aria-label="Environment"
          value={filters.environment}
          onChange={(event) => set({ environment: event.target.value })}
        >
          <option value="">All environments</option>
          {environmentsOf(seen.data?.issues ?? [], filters.environment).map((environment) => (
            <option key={environment} value={environment}>
              {environment}
            </option>
          ))}
        </select>

        <select
          className="select"
          aria-label="Status"
          value={filters.status}
          onChange={(event) => set({ status: event.target.value as IssueStatus | '' })}
        >
          <option value="open">Open</option>
          <option value="resolved">Resolved</option>
          <option value="ignored">Ignored</option>
          <option value="">Any status</option>
        </select>

        <select
          className="select"
          aria-label="Sort"
          value={filters.sort}
          onChange={(event) => set({ sort: event.target.value as IssueFilters['sort'] })}
        >
          <option value="last_seen">Last seen</option>
          <option value="count">Occurrences</option>
        </select>
      </div>

      {issues.isPending && <p className="waiting">Loading…</p>}
      {issues.error !== null && (
        <p className="error" role="alert">
          {messageFor(issues.error, 'Could not load the issues')}
        </p>
      )}

      {issues.data !== undefined &&
        (issues.data.issues.length === 0 ? (
          <p className="empty">Nothing here. That is the good outcome.</p>
        ) : (
          <ul className="issues">
            {issues.data.issues.map((issue) => (
              <li key={issue.id}>
                <Link className="issue" to={`/issues/${issue.id}`}>
                  <span className={`issue__bar issue__bar--${issue.status}`} aria-hidden="true" />
                  <div>
                    <p className="issue__title">{issue.title}</p>
                    {issue.culprit !== null && <p className="issue__culprit">{issue.culprit}</p>}
                    <p className="issue__meta">
                      <span className="tag">{issue.app_name}</span>
                      <span className="tag">{issue.environment}</span>
                      last seen {relativeTime(issue.last_seen_at, now)}
                    </p>
                  </div>
                  <span className="issue__count">
                    {issue.occurrence_count.toLocaleString('en')}
                    <small>{issue.occurrence_count === 1 ? 'time' : 'times'}</small>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ))}
    </main>
  )
}

function SignOut() {
  const client = useQueryClient()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()

  async function leave() {
    setBusy(true)
    setError(undefined)
    try {
      await signOut(client, navigate)
    } catch (cause) {
      // The session is still alive on the server; saying so beats a login screen that lies.
      setError(messageFor(cause, 'Could not sign out'))
      setBusy(false)
    }
  }

  return (
    <div className="signout">
      {error !== undefined && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button className="button button--quiet" type="button" disabled={busy} onClick={leave}>
        Sign out
      </button>
    </div>
  )
}
