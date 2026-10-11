import type { ColumnType, Generated } from 'kysely'

/**
 * One row today. An ordinary primary key rather than a secret pinned to `id = 1`, because a row
 * nothing can be joined to has to be rewritten the day a second owner appears.
 */
export interface OwnersTable {
  id: Generated<string>
  /** For display only. There is no username: login asks for the password alone. */
  label: string
  password_hash: string
  created_at: Generated<Date>
  updated_at: ColumnType<Date, Date | undefined, Date>
}

export interface SessionsTable {
  id: Generated<string>
  owner_id: string
  token_hash: string
  expires_at: ColumnType<Date, Date | string, Date | string>
  created_at: Generated<Date>
  last_seen_at: ColumnType<Date, Date | string | undefined, Date | string>
}

/** One row per monitored application. */
export interface AppsTable {
  id: Generated<string>
  slug: string
  name: string
  created_at: Generated<Date>
}

/**
 * A key names its app: `app_id` is read from here and never from a request body, so a key
 * leaked from the least important application cannot forge events for the most important one.
 *
 * `kind` already carries `browser` although Slice 1 issues only `server` keys. The column is
 * cheap now and a migration on a live table later.
 */
export interface IngestKeysTable {
  id: Generated<string>
  app_id: string
  kind: 'server' | 'browser'
  /** SHA-256 hex. The token has 256 bits of CSPRNG entropy and nothing to stretch. */
  token_sha256: string
  created_at: Generated<Date>
  last_used_at: ColumnType<Date | null, never, Date>
  revoked_at: ColumnType<Date | null, never, Date>
}

/**
 * The group. `environment` is part of the key so local development noise never shares a row —
 * or, from Slice 2, an alert — with production.
 */
export interface IssuesTable {
  id: Generated<string>
  app_id: string
  environment: string
  /** SHA-256 hex from `shared/fingerprint.ts`. */
  fingerprint: string
  title: string
  culprit: string | null
  runtime: 'node' | 'browser'
  status: Generated<'open' | 'resolved' | 'ignored'>
  first_seen_at: Generated<Date>
  last_seen_at: ColumnType<Date, Date | undefined, Date>
  /** Authoritative and never pruned: history survives retention as counts. */
  occurrence_count: Generated<number>
  /** Slice 2 owns these two. Present from the first migration so neither needs a backfill. */
  last_notified_at: ColumnType<Date | null, never, Date>
  auto_muted_at: ColumnType<Date | null, never, Date>
  /** Stamped when a resolved issue reopens. Slice 2's regression dedup key reads it. */
  reopened_at: ColumnType<Date | null, never, Date>
}

/** One occurrence. Age-pruned from §14; the issue's count outlives it. */
export interface EventsTable {
  id: Generated<string>
  issue_id: string
  /** When the application says it happened. Client clocks lie and offline queues replay late. */
  occurred_at: Date
  /** When vigil stored it. The pair is what makes a late arrival diagnosable. */
  received_at: Generated<Date>
  message: string
  stack: string | null
  context: ColumnType<Record<string, unknown> | null, string | null, string | null>
  /** Client-side collapse (§8): one row can stand for fifty thousand throws. */
  count: Generated<number>
}

export interface Database {
  owners: OwnersTable
  sessions: SessionsTable
  apps: AppsTable
  ingest_keys: IngestKeysTable
  issues: IssuesTable
  events: EventsTable
}
