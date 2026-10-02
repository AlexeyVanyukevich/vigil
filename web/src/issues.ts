import type { IssueOccurrence, IssueStatus, IssueSummary } from './api'

/** `''` is "any": no filter at all, which is not the same request as a blank one. */
export interface IssueFilters {
  app: string
  environment: string
  status: IssueStatus | ''
  sort: 'last_seen' | 'count'
}

/**
 * An empty filter is left out rather than sent blank. The API reads `?app=` as "the application
 * whose slug is empty" and answers with nothing, where the owner meant every application.
 */
export function issuesPath(filters: IssueFilters, limit?: number): string {
  const query = new URLSearchParams()
  if (filters.app !== '') query.set('app', filters.app)
  if (filters.environment !== '') query.set('environment', filters.environment)
  if (filters.status !== '') query.set('status', filters.status)
  query.set('sort', filters.sort)
  if (limit !== undefined) query.set('limit', String(limit))
  return `/api/issues?${query.toString()}`
}

/**
 * The environments worth offering, from the issues the server returned. There is no endpoint
 * listing environments; this is what the owner's applications have actually reported from.
 * The selected one is always kept, so the control never holds a value it has no option for.
 */
export function environmentsOf(issues: IssueSummary[], selected: string): string[] {
  const seen = new Set(issues.map((issue) => issue.environment))
  if (selected !== '') seen.add(selected)
  return [...seen].sort()
}

export interface StatusAction {
  label: string
  to: IssueStatus
  /** The one action the owner most likely came to take, drawn as the primary button. */
  primary: boolean
}

/**
 * §11's resolve / ignore / unmute, plus reopen for a resolved issue that turns out not to be
 * fixed. Never the status the issue already has.
 */
export function actionsFor(status: IssueStatus): StatusAction[] {
  switch (status) {
    case 'open':
      return [
        { label: 'Resolve', to: 'resolved', primary: true },
        { label: 'Ignore', to: 'ignored', primary: false },
      ]
    case 'resolved':
      return [
        { label: 'Reopen', to: 'open', primary: false },
        { label: 'Ignore', to: 'ignored', primary: false },
      ]
    case 'ignored':
      return [
        { label: 'Resolve', to: 'resolved', primary: true },
        { label: 'Unmute', to: 'open', primary: false },
      ]
  }
}

const LATE_AFTER = 60_000

/**
 * Both timestamps exist because an offline queue replays late; saying so is the only way the
 * owner can tell a late report from a live one. A minute absorbs ordinary transit and batching.
 */
export function reportedLate(event: Pick<IssueOccurrence, 'occurred_at' | 'received_at'>): boolean {
  return Date.parse(event.received_at) - Date.parse(event.occurred_at) > LATE_AFTER
}
