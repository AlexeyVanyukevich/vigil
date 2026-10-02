import type { IssueOccurrence, IssueSummary } from '../src/api'
import type { IssueFilters } from '../src/issues'

export const ID = '6f1c2a4e-8b0d-4c3e-9a71-2d5e8f0b1c34'

/** The Issues screen opens on open issues, most recently seen first. */
export const OPENING: IssueFilters = { app: '', environment: '', status: 'open', sort: 'last_seen' }

/** An issue as `GET /api/issues` lists it. */
export function summary(overrides: Partial<IssueSummary> = {}): IssueSummary {
  return {
    id: ID,
    app_slug: 'booking',
    app_name: 'The reference application',
    environment: 'production',
    title: "TypeError: Cannot read properties of undefined (reading 'id')",
    culprit: 'handleBooking (src/bookings.js)',
    runtime: 'node',
    status: 'open',
    first_seen_at: '2026-09-07T09:00:00.000Z',
    last_seen_at: '2026-09-07T09:00:00.000Z',
    occurrence_count: 1,
    ...overrides,
  }
}

/** One of the occurrences `GET /api/issues/:id` returns beside the issue. */
export function occurrence(overrides: Partial<IssueOccurrence> = {}): IssueOccurrence {
  return {
    id: '9a0e7c55-1f2b-4d6a-8c3e-4b5a6d7e8f90',
    occurred_at: '2026-09-07T09:00:00.000Z',
    received_at: '2026-09-07T09:00:00.120Z',
    message: "Cannot read properties of undefined (reading 'id')",
    stack: 'TypeError: boom\n    at handleBooking (/app/src/bookings.js:42:17)',
    context: { route: '/api/bookings' },
    count: 1,
    ...overrides,
  }
}
