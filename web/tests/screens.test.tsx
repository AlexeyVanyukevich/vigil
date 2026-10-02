import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import type { IssueOccurrence, IssueStatus, IssueSummary } from '../src/api'
import type { IssueFilters } from '../src/issues'
import { IssueDetail } from '../src/routes/IssueDetail'
import { Issues } from '../src/routes/Issues'

// The screens rendered to markup, in Node, from a cache seeded with what the server would have
// answered. Nothing is fetched: the query client never mounts, so nothing here needs a server.

const ID = '6f1c2a4e-8b0d-4c3e-9a71-2d5e8f0b1c34'
/** The Issues screen opens on open issues, most recently seen first. */
const OPENING: IssueFilters = { app: '', environment: '', status: 'open', sort: 'last_seen' }

function summary(overrides: Partial<IssueSummary> = {}): IssueSummary {
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

function occurrence(overrides: Partial<IssueOccurrence> = {}): IssueOccurrence {
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

interface Seed {
  issues?: IssueSummary[]
  detail?: { issue: IssueSummary; events: IssueOccurrence[] }
}

function render(path: string, seed: Seed): string {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  })
  if (seed.issues !== undefined) client.setQueryData(['issues', OPENING], { issues: seed.issues })
  if (seed.detail !== undefined) client.setQueryData(['issue', ID], seed.detail)

  return renderToString(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/" element={<Issues />} />
          <Route path="/issues/:id" element={<IssueDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const list = (issues: IssueSummary[]) => render('/', { issues })
const detail = (issue: Partial<IssueSummary>, events: Array<Partial<IssueOccurrence>>) =>
  render(`/issues/${ID}`, { detail: { issue: summary(issue), events: events.map(occurrence) } })

/** What React writes for a text node; the same five characters it escapes. */
function asText(raw: string): string {
  return raw
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#x27;')
}

interface HostileCase {
  name: string
  html: () => string
  /** Markup as the monitored application sent it, which must reach the page as text. */
  raw: string
}

// Stacks, contexts, titles and environments come from monitored applications, and through them
// from whoever can make those applications throw. None of it is ever markup.
const hostile: HostileCase[] = [
  {
    name: 'a stack containing a script element',
    raw: '<script>alert(1)</script>',
    html: () =>
      detail({}, [{ stack: 'Error: <script>alert(1)</script>\n    at x (/app/a.js:1:1)' }]),
  },
  {
    name: 'a dependency frame containing markup, inside the fold',
    raw: '<img src=x onerror=alert(2)>',
    html: () =>
      detail({}, [
        { stack: 'Error: x\n    at <img src=x onerror=alert(2)> (/app/node_modules/y.js:1:1)' },
      ]),
  },
  {
    name: 'a context value containing markup',
    raw: '<img src=x onerror=alert(3)>',
    html: () => detail({}, [{ context: { note: '<img src=x onerror=alert(3)>' } }]),
  },
  {
    name: 'a context key containing markup',
    raw: '<svg onload=alert(4)>',
    html: () => detail({}, [{ context: { '<svg onload=alert(4)>': 1 } }]),
  },
  {
    name: 'an issue title containing markup, on the detail screen',
    raw: '<b onmouseover=alert(5)>bold</b>',
    html: () => detail({ title: '<b onmouseover=alert(5)>bold</b>' }, [{}]),
  },
  {
    name: 'a culprit containing markup',
    raw: '<a href=javascript:alert(6)>x</a>',
    html: () => detail({ culprit: '<a href=javascript:alert(6)>x</a>' }, [{}]),
  },
  {
    name: 'an issue title containing markup, in the list',
    raw: '<iframe src=//evil.example>',
    html: () => list([summary({ title: '<iframe src=//evil.example>' })]),
  },
  {
    name: 'an environment containing markup, in the list',
    raw: '<style>body{display:none}</style>',
    html: () => list([summary({ environment: '<style>body{display:none}</style>' })]),
  },
]

describe('attacker-influenced text', () => {
  it.each(hostile)('$name is shown literally', ({ html, raw }) => {
    const markup = html()
    expect(markup).not.toContain(raw)
    expect(markup).toContain(asText(raw))
  })
})

describe('the issues list', () => {
  it('shows what failed, where, and how often, on one row', () => {
    const markup = list([summary({ occurrence_count: 1234 })])

    expect(markup).toContain(
      asText("TypeError: Cannot read properties of undefined (reading 'id')"),
    )
    expect(markup).toContain('handleBooking (src/bookings.js)')
    expect(markup).toContain('The reference application')
    expect(markup).toContain('production')
    expect(markup).toContain('1,234')
    expect(markup).toContain(`href="/issues/${ID}"`)
  })

  it('says so when there is nothing to show', () => {
    expect(list([])).toContain('Nothing here.')
  })

  it('offers every filter the spec names, and both sorts', () => {
    const markup = list([])
    for (const label of ['Application', 'Environment', 'Status', 'Sort']) {
      expect(markup).toContain(`aria-label="${label}"`)
    }
    expect(markup).toContain('Last seen')
    expect(markup).toContain('Occurrences')
  })
})

interface ActionRenderCase {
  status: IssueStatus
  buttons: string[]
}

const buttons: ActionRenderCase[] = [
  { status: 'open', buttons: ['Resolve', 'Ignore'] },
  { status: 'resolved', buttons: ['Reopen', 'Ignore'] },
  { status: 'ignored', buttons: ['Resolve', 'Unmute'] },
]

describe('the issue detail', () => {
  it.each(buttons)('an issue that is $status offers $buttons', ({ status, buttons: expected }) => {
    const markup = detail({ status }, [{}])
    const offered = [...markup.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1])
    expect(offered).toEqual(expected)
  })

  it('folds a run of dependency frames behind one line, without dropping them', () => {
    const markup = detail({}, [
      {
        stack: [
          'TypeError: boom',
          '    at handleBooking (/app/src/bookings.js:42:17)',
          '    at run (/app/node_modules/fastify/lib/handle.js:118:9)',
          '    at next (/app/node_modules/fastify/lib/hooks.js:20:3)',
        ].join('\n'),
      },
    ])

    expect(markup.match(/<details/g)).toHaveLength(1)
    expect(markup).toContain('2 frames in node_modules')
    expect(markup.match(/stack__frame--vendor/g)).toHaveLength(2)
    expect(markup).toContain('fastify/lib/handle.js')
    // The owner's own frame stays outside the fold, where the eye lands first.
    expect(markup.indexOf('handleBooking')).toBeLessThan(markup.indexOf('<details'))
  })

  it('folds nothing when every frame is the owner’s', () => {
    expect(detail({}, [{}])).not.toContain('<details')
  })

  it('shows the latest occurrence’s context, not an older one', () => {
    const markup = detail({}, [
      { context: { route: '/latest' } },
      { id: 'b1d2e3f4-0000-4000-8000-000000000000', context: { route: '/older' } },
    ])
    expect(markup).toContain('/latest')
    expect(markup).not.toContain('/older')
  })

  it('lists every recent occurrence, and says which were reported late', () => {
    const markup = detail({}, [
      { id: '00000000-0000-4000-8000-000000000001', count: 3 },
      {
        id: '00000000-0000-4000-8000-000000000002',
        occurred_at: '2026-09-07T08:00:00.000Z',
        received_at: '2026-09-07T08:30:00.000Z',
      },
    ])
    expect(markup.match(/class="occurrence"/g)).toHaveLength(2)
    expect(markup).toContain('×3')
    expect(markup.match(/occurrence__late/g)).toHaveLength(1)
  })
})
