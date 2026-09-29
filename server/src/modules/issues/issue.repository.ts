import type { Kysely } from 'kysely'
import type { Database } from '../../db/schema.js'

export interface IssueSummary {
  id: string
  app_slug: string
  app_name: string
  environment: string
  title: string
  culprit: string | null
  runtime: 'node' | 'browser'
  status: 'open' | 'resolved' | 'ignored'
  first_seen_at: Date
  last_seen_at: Date
  occurrence_count: number
}

export interface IssueOccurrence {
  id: string
  occurred_at: Date
  received_at: Date
  message: string
  stack: string | null
  context: Record<string, unknown> | null
  count: number
}

export interface IssueFilter {
  appSlug?: string | undefined
  environment?: string | undefined
  status?: 'open' | 'resolved' | 'ignored' | undefined
  sort: 'last_seen' | 'count'
  limit: number
}

const SUMMARY = [
  'issues.id as id',
  'apps.slug as app_slug',
  'apps.name as app_name',
  'issues.environment as environment',
  'issues.title as title',
  'issues.culprit as culprit',
  'issues.runtime as runtime',
  'issues.status as status',
  'issues.first_seen_at as first_seen_at',
  'issues.last_seen_at as last_seen_at',
  'issues.occurrence_count as occurrence_count',
] as const

export async function listIssues(
  db: Kysely<Database>,
  filter: IssueFilter,
): Promise<IssueSummary[]> {
  let query = db.selectFrom('issues').innerJoin('apps', 'apps.id', 'issues.app_id').select(SUMMARY)

  if (filter.appSlug !== undefined) query = query.where('apps.slug', '=', filter.appSlug)
  if (filter.environment !== undefined) {
    query = query.where('issues.environment', '=', filter.environment)
  }
  if (filter.status !== undefined) query = query.where('issues.status', '=', filter.status)

  query =
    filter.sort === 'count'
      ? query.orderBy('issues.occurrence_count', 'desc')
      : query.orderBy('issues.last_seen_at', 'desc')

  // A stable tiebreak, so two issues last seen in the same millisecond do not swap places
  // between page loads and make the list look like it is moving on its own.
  return query.orderBy('issues.id').limit(filter.limit).execute()
}

export async function findIssue(
  db: Kysely<Database>,
  id: string,
): Promise<IssueSummary | undefined> {
  return db
    .selectFrom('issues')
    .innerJoin('apps', 'apps.id', 'issues.app_id')
    .select(SUMMARY)
    .where('issues.id', '=', id)
    .executeTakeFirst()
}

export async function recentOccurrences(
  db: Kysely<Database>,
  issueId: string,
  limit: number,
): Promise<IssueOccurrence[]> {
  return (
    db
      .selectFrom('events')
      .select(['id', 'occurred_at', 'received_at', 'message', 'stack', 'context', 'count'])
      .where('issue_id', '=', issueId)
      // By when it happened, not when it landed: an event replayed from an offline queue belongs
      // where it occurred in the story, not at the top because it arrived last.
      .orderBy('occurred_at', 'desc')
      .limit(limit)
      .execute()
  )
}

/** False when there is no such issue, so the route can answer 404 without a second query. */
export async function setIssueStatus(
  db: Kysely<Database>,
  id: string,
  status: 'open' | 'resolved' | 'ignored',
): Promise<boolean> {
  const result = await db
    .updateTable('issues')
    .set({ status })
    .where('id', '=', id)
    .executeTakeFirst()
  return Number(result.numUpdatedRows) > 0
}
