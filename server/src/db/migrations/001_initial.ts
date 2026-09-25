import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  // ── the owner ──────────────────────────────────────────────────────────────
  //
  // One row today, and no `id = 1` check: a second owner would only have to undo it.
  await db.schema
    .createTable('owners')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('label', 'text', (col) => col.notNull())
    .addColumn('password_hash', 'text', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  // `owner_id` is here from the first migration on purpose. Reshaping `owners` later is cheap;
  // adding a not-null foreign key to a live sessions table means a backfill or signing
  // everybody out to get one.
  await db.schema
    .createTable('sessions')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('owner_id', 'uuid', (col) =>
      col.notNull().references('owners.id').onDelete('cascade'),
    )
    .addColumn('token_hash', 'text', (col) => col.notNull().unique())
    .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('last_seen_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  // ── identity ───────────────────────────────────────────────────────────────
  await db.schema
    .createTable('apps')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('slug', 'text', (col) => col.notNull().unique())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('apps_slug_is_a_slug', sql`slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'`)
    .addCheckConstraint('apps_name_not_blank', sql`length(btrim(name)) > 0`)
    .execute()

  // Keys are a table and not a column so rotation needs no downtime: issue the new key,
  // deploy, revoke the old one. Two live keys for an afternoon is the whole point.
  await db.schema
    .createTable('ingest_keys')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('app_id', 'uuid', (col) => col.notNull().references('apps.id').onDelete('cascade'))
    .addColumn('kind', 'text', (col) => col.notNull())
    .addColumn('token_sha256', 'text', (col) => col.notNull().unique())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('last_used_at', 'timestamptz')
    .addColumn('revoked_at', 'timestamptz')
    .addCheckConstraint('ingest_keys_kind_known', sql`kind in ('server', 'browser')`)
    .addCheckConstraint('ingest_keys_digest_is_sha256', sql`token_sha256 ~ '^[0-9a-f]{64}$'`)
    .execute()

  await db.schema.createIndex('ingest_keys_app_idx').on('ingest_keys').column('app_id').execute()

  // ── errors ─────────────────────────────────────────────────────────────────
  await db.schema
    .createTable('issues')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('app_id', 'uuid', (col) => col.notNull().references('apps.id').onDelete('cascade'))
    .addColumn('environment', 'text', (col) => col.notNull())
    .addColumn('fingerprint', 'text', (col) => col.notNull())
    .addColumn('title', 'text', (col) => col.notNull())
    .addColumn('culprit', 'text')
    .addColumn('runtime', 'text', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('open'))
    .addColumn('first_seen_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('last_seen_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    // bigint: a hot loop reporting `count: 50000` a few thousand times clears int4 in a day.
    .addColumn('occurrence_count', 'bigint', (col) => col.notNull().defaultTo(0))
    .addColumn('last_notified_at', 'timestamptz')
    .addColumn('auto_muted_at', 'timestamptz')
    .addColumn('reopened_at', 'timestamptz')
    .addUniqueConstraint('issues_group_unique', ['app_id', 'environment', 'fingerprint'])
    .addCheckConstraint('issues_status_known', sql`status in ('open', 'resolved', 'ignored')`)
    .addCheckConstraint('issues_runtime_known', sql`runtime in ('node', 'browser')`)
    .addCheckConstraint('issues_count_not_negative', sql`occurrence_count >= 0`)
    .addCheckConstraint('issues_environment_not_blank', sql`length(btrim(environment)) > 0`)
    .execute()

  // The issues screen sorts by last seen within an app, filtered by status. This is that query.
  await db.schema
    .createIndex('issues_app_last_seen_idx')
    .on('issues')
    .columns(['app_id', 'status', 'last_seen_at desc'])
    .execute()

  await db.schema
    .createTable('events')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('issue_id', 'uuid', (col) =>
      col.notNull().references('issues.id').onDelete('cascade'),
    )
    .addColumn('occurred_at', 'timestamptz', (col) => col.notNull())
    .addColumn('received_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('message', 'text', (col) => col.notNull())
    .addColumn('stack', 'text')
    .addColumn('context', 'jsonb')
    .addColumn('count', 'integer', (col) => col.notNull().defaultTo(1))
    .addCheckConstraint('events_count_positive', sql`count > 0`)
    .execute()

  // Issue detail reads the most recent occurrences; §14's prune sweeps by received_at.
  await db.schema
    .createIndex('events_issue_occurred_idx')
    .on('events')
    .columns(['issue_id', 'occurred_at desc'])
    .execute()

  await db.schema.createIndex('events_received_idx').on('events').column('received_at').execute()

  // §13: vigil records its own failures under this slug, written straight to the database and
  // never through its own ingest endpoint. Seeded here so the write path can assume it exists.
  await db
    .insertInto('apps')
    .values({ slug: 'vigil', name: 'Vigil itself' })
    .onConflict((oc: any) => oc.column('slug').doNothing())
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('events').ifExists().execute()
  await db.schema.dropTable('issues').ifExists().execute()
  await db.schema.dropTable('ingest_keys').ifExists().execute()
  await db.schema.dropTable('apps').ifExists().execute()
  await db.schema.dropTable('sessions').ifExists().execute()
  await db.schema.dropTable('owners').ifExists().execute()
}
