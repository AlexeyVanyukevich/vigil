import { describe, expect, it } from 'vitest'
import type { IssueStatus, IssueSummary } from '../src/api'
import {
  actionsFor,
  environmentsOf,
  issuesPath,
  reportedLate,
  type IssueFilters,
} from '../src/issues'

const everything: IssueFilters = { app: '', environment: '', status: '', sort: 'last_seen' }

interface PathCase {
  name: string
  filters: IssueFilters
  limit?: number
  /** The query string, parsed, so the order the parameters are written in does not matter. */
  expected: Record<string, string>
}

const paths: PathCase[] = [
  // An empty filter is left out, never sent blank: the API reads `?app=` as "the application
  // whose slug is empty" and answers with an empty list, not with every application.
  { name: 'no filters sends only the sort', filters: everything, expected: { sort: 'last_seen' } },
  {
    name: 'every filter set',
    filters: { app: 'booking', environment: 'production', status: 'open', sort: 'count' },
    expected: { app: 'booking', environment: 'production', status: 'open', sort: 'count' },
  },
  {
    name: 'an application alone',
    filters: { ...everything, app: 'booking' },
    expected: { app: 'booking', sort: 'last_seen' },
  },
  {
    name: 'an environment alone',
    filters: { ...everything, environment: 'staging' },
    expected: { environment: 'staging', sort: 'last_seen' },
  },
  {
    name: 'a status alone',
    filters: { ...everything, status: 'ignored' },
    expected: { status: 'ignored', sort: 'last_seen' },
  },
  {
    name: 'a value that needs escaping arrives as typed',
    filters: { ...everything, environment: 'qa & staging' },
    expected: { environment: 'qa & staging', sort: 'last_seen' },
  },
  {
    name: 'a limit, when asked for',
    filters: everything,
    limit: 200,
    expected: { sort: 'last_seen', limit: '200' },
  },
]

describe('issuesPath', () => {
  it.each(paths)('$name', ({ filters, limit, expected }) => {
    const path = issuesPath(filters, limit)
    const [route, query = ''] = path.split('?')

    expect(route).toBe('/api/issues')
    expect(Object.fromEntries(new URLSearchParams(query))).toEqual(expected)
  })
})

function issue(environment: string): IssueSummary {
  return {
    id: crypto.randomUUID(),
    app_slug: 'booking',
    app_name: 'Booking',
    environment,
    title: 'x',
    culprit: null,
    runtime: 'node',
    status: 'open',
    first_seen_at: '2026-09-07T09:00:00.000Z',
    last_seen_at: '2026-09-07T09:00:00.000Z',
    occurrence_count: 1,
  }
}

interface EnvironmentCase {
  name: string
  seen: string[]
  selected: string
  expected: string[]
}

const environments: EnvironmentCase[] = [
  { name: 'none seen yet', seen: [], selected: '', expected: [] },
  {
    name: 'each once, sorted',
    seen: ['staging', 'production', 'staging', 'development'],
    selected: '',
    expected: ['development', 'production', 'staging'],
  },
  // The owner chose it; it must not vanish from the control because nothing in the latest
  // listing happens to carry it, or the select would show a value it has no option for.
  {
    name: 'the selected one is kept when no issue carries it',
    seen: ['production'],
    selected: 'staging',
    expected: ['production', 'staging'],
  },
  {
    name: 'the selected one is not listed twice',
    seen: ['production'],
    selected: 'production',
    expected: ['production'],
  },
]

describe('environmentsOf', () => {
  it.each(environments)('$name', ({ seen, selected, expected }) => {
    expect(environmentsOf(seen.map(issue), selected)).toEqual(expected)
  })
})

interface ActionCase {
  status: IssueStatus
  expected: Array<{ label: string; to: IssueStatus }>
}

const actions: ActionCase[] = [
  {
    status: 'open',
    expected: [
      { label: 'Resolve', to: 'resolved' },
      { label: 'Ignore', to: 'ignored' },
    ],
  },
  {
    status: 'resolved',
    expected: [
      { label: 'Reopen', to: 'open' },
      { label: 'Ignore', to: 'ignored' },
    ],
  },
  {
    status: 'ignored',
    expected: [
      { label: 'Resolve', to: 'resolved' },
      { label: 'Unmute', to: 'open' },
    ],
  },
]

describe('actionsFor', () => {
  it.each(actions)('$status', ({ status, expected }) => {
    expect(actionsFor(status).map(({ label, to }) => ({ label, to }))).toEqual(expected)
  })

  it.each(actions)('never offers $status to an issue already $status', ({ status }) => {
    expect(actionsFor(status).every((action) => action.to !== status)).toBe(true)
  })
})

interface LateCase {
  name: string
  occurred: string
  received: string
  late: boolean
}

const late: LateCase[] = [
  {
    name: 'stored the moment it happened',
    occurred: '2026-09-07T09:00:00.000Z',
    received: '2026-09-07T09:00:00.250Z',
    late: false,
  },
  {
    name: 'exactly a minute in transit is still live',
    occurred: '2026-09-07T09:00:00.000Z',
    received: '2026-09-07T09:01:00.000Z',
    late: false,
  },
  {
    name: 'replayed from an offline queue an hour later',
    occurred: '2026-09-07T09:00:00.000Z',
    received: '2026-09-07T10:00:00.000Z',
    late: true,
  },
  // A client clock running fast files the event after it arrived. That is skew, not lateness.
  {
    name: 'from a clock running ahead of the server',
    occurred: '2026-09-07T09:05:00.000Z',
    received: '2026-09-07T09:00:00.000Z',
    late: false,
  },
]

describe('reportedLate', () => {
  it.each(late)('$name', ({ occurred, received, late: expected }) => {
    expect(reportedLate({ occurred_at: occurred, received_at: received })).toBe(expected)
  })
})
