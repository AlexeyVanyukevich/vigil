import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router'
import { api, type IssueOccurrence, type IssueStatus, type IssueSummary } from '../api'
import { messageFor } from '../errors'
import { frameRuns, relativeTime } from '../format'
import { actionsFor, reportedLate } from '../issues'
import { useNow } from '../now'

interface Detail {
  issue: IssueSummary
  events: IssueOccurrence[]
}

// Everything below that came from a monitored application — title, culprit, stack, context —
// is rendered as a React text child, which React escapes. Never `dangerouslySetInnerHTML`: those
// strings are written by whoever can make the application throw.

export function IssueDetail() {
  const { id = '' } = useParams()
  const queryClient = useQueryClient()
  const now = useNow()
  // The router decodes the id; put back raw, `..%2Fapps` would ask for `/api/apps`.
  const path = `/api/issues/${encodeURIComponent(id)}`

  const detail = useQuery({
    queryKey: ['issue', id],
    queryFn: () => api.get<Detail>(path),
  })

  const setStatus = useMutation({
    mutationFn: (status: IssueStatus) => api.patch(path, { status }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['issue', id] })
      await queryClient.invalidateQueries({ queryKey: ['issues'] })
    },
  })

  if (detail.isPending) return <p className="waiting">Loading…</p>
  if (detail.error !== null) {
    return (
      <main className="screen">
        <p className="error" role="alert">
          {messageFor(detail.error, 'Could not load this issue')}
        </p>
        <Link className="button button--quiet" to="/">
          Back to issues
        </Link>
      </main>
    )
  }

  const { issue, events } = detail.data
  // The most recent occurrence is what the owner came to read; the rest is the shape of it.
  const latest = events[0]

  return (
    <main className="screen">
      <header className="screen__head">
        <div>
          <Link className="issue__meta" to="/">
            ← Issues
          </Link>
          <h1 className="screen__title">{issue.title}</h1>
          {issue.culprit !== null && <p className="issue__culprit">{issue.culprit}</p>}
          <p className="issue__meta">
            <span className="tag">{issue.app_name}</span>
            <span className="tag">{issue.environment}</span>
            <span className="tag">{issue.runtime}</span>
            {issue.occurrence_count.toLocaleString('en')} occurrences · first seen{' '}
            {relativeTime(issue.first_seen_at, now)} · last seen{' '}
            {relativeTime(issue.last_seen_at, now)}
          </p>
        </div>

        <div className="detail__actions">
          {actionsFor(issue.status).map((action) => (
            <button
              key={action.to}
              className={action.primary ? 'button' : 'button button--quiet'}
              type="button"
              disabled={setStatus.isPending}
              onClick={() => setStatus.mutate(action.to)}
            >
              {action.label}
            </button>
          ))}
        </div>
      </header>

      {setStatus.error !== null && (
        <p className="error" role="alert">
          {messageFor(setStatus.error, 'Could not change the status')}
        </p>
      )}

      {latest?.stack != null && (
        <section className="section">
          <h2 className="section__title">Stack</h2>
          <Stack stack={latest.stack} />
        </section>
      )}

      {latest?.context != null && (
        <section className="section">
          <h2 className="section__title">Context</h2>
          <pre className="context">{JSON.stringify(latest.context, null, 2)}</pre>
        </section>
      )}

      <section className="section">
        <h2 className="section__title">Recent occurrences</h2>
        <ul className="occurrences">
          {events.map((event) => (
            <li className="occurrence" key={event.id}>
              <span>
                {new Date(event.occurred_at).toLocaleString('en-GB')}
                {event.count > 1 && ` · ×${event.count.toLocaleString('en')}`}
              </span>
              {reportedLate(event) && (
                <span className="occurrence__late">
                  reported {relativeTime(event.received_at, now)}
                </span>
              )}
            </li>
          ))}
        </ul>
      </section>
    </main>
  )
}

/**
 * §11: dependency frames collapsed. Each run of them folds behind one line saying how many there
 * are, and opens in place — nothing is dropped, so the owner can still follow a call through a
 * framework when the bug is in how they used it.
 */
function Stack({ stack }: { stack: string }) {
  return (
    <div className="stack">
      {frameRuns(stack).map((run, index) =>
        run.vendor ? (
          <details key={index} className="stack__fold">
            <summary>{`${run.frames.length} ${run.frames.length === 1 ? 'frame' : 'frames'} in node_modules`}</summary>
            {run.frames.map((text, line) => (
              <div key={line} className="stack__frame--vendor">
                {text}
              </div>
            ))}
          </details>
        ) : (
          run.frames.map((text, line) => <div key={`${index}:${line}`}>{text}</div>)
        ),
      )}
    </div>
  )
}
