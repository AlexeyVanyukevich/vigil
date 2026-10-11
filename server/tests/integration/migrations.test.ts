import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { closeTestDb, getTestDb, resetDb } from './helpers.js'

const db = () => getTestDb()

beforeEach(async () => {
  await resetDb()
})
afterAll(async () => {
  await closeTestDb()
})

async function seedApp(slug = 'reference'): Promise<string> {
  const row = await db()
    .insertInto('apps')
    .values({ slug, name: 'The reference application' })
    .returning('id')
    .executeTakeFirstOrThrow()
  return row.id
}

describe('001_initial', () => {
  it('creates every table this slice needs', async () => {
    const rows = await sql<{ table_name: string }>`
      select table_name from information_schema.tables where table_schema = 'public'
    `.execute(db())
    const names = rows.rows.map((r) => r.table_name)
    for (const table of ['owners', 'sessions', 'apps', 'ingest_keys', 'issues', 'events']) {
      expect(names).toContain(table)
    }
  })

  it('seeds the vigil application itself, so §13 has somewhere to write', async () => {
    const row = await db()
      .selectFrom('apps')
      .select(['slug', 'name'])
      .where('slug', '=', 'vigil')
      .executeTakeFirst()
    expect(row?.slug).toBe('vigil')
  })

  it('makes an application slug unique', async () => {
    await seedApp('duplicate')
    await expect(seedApp('duplicate')).rejects.toThrow()
  })

  // The issue key is what makes grouping work at all, and environment is in it so that a
  // developer's laptop cannot merge its noise into production's row.
  it('makes an issue unique on app, environment and fingerprint', async () => {
    const appId = await seedApp()
    const issue = {
      app_id: appId,
      environment: 'production',
      fingerprint: 'a'.repeat(64),
      title: 'TypeError: boom',
      culprit: 'handle (/app/src/x.js)',
      runtime: 'node' as const,
    }
    await db().insertInto('issues').values(issue).execute()
    await expect(db().insertInto('issues').values(issue).execute()).rejects.toThrow()

    // Same fingerprint, different environment: a separate issue, not a conflict.
    await db()
      .insertInto('issues')
      .values({ ...issue, environment: 'development' })
      .execute()
    expect(await db().selectFrom('issues').selectAll().execute()).toHaveLength(2)
  })

  it('defaults a new issue to open with a zero count', async () => {
    const appId = await seedApp()
    const row = await db()
      .insertInto('issues')
      .values({
        app_id: appId,
        environment: 'production',
        fingerprint: 'b'.repeat(64),
        title: 'Error: nope',
        culprit: null,
        runtime: 'node',
      })
      .returning(['status', 'occurrence_count', 'last_notified_at', 'reopened_at'])
      .executeTakeFirstOrThrow()
    expect(row.status).toBe('open')
    expect(row.occurrence_count).toBe(0)
    expect(row.last_notified_at).toBeNull()
    expect(row.reopened_at).toBeNull()
  })

  it('reads occurrence_count back as a number, not a string', async () => {
    const appId = await seedApp()
    await db()
      .insertInto('issues')
      .values({
        app_id: appId,
        environment: 'production',
        fingerprint: 'c'.repeat(64),
        title: 'Error: nope',
        culprit: null,
        runtime: 'node',
        occurrence_count: 3,
      })
      .execute()
    const row = await db().selectFrom('issues').select('occurrence_count').executeTakeFirstOrThrow()
    expect(row.occurrence_count).toBe(3)
    expect(typeof row.occurrence_count).toBe('number')
  })

  it('refuses an ingest key whose digest is already registered', async () => {
    const appId = await seedApp()
    const key = { app_id: appId, kind: 'server' as const, token_sha256: 'd'.repeat(64) }
    await db().insertInto('ingest_keys').values(key).execute()
    await expect(db().insertInto('ingest_keys').values(key).execute()).rejects.toThrow()
  })

  it('deletes an application key and its issues with the application', async () => {
    const appId = await seedApp('doomed')
    await db()
      .insertInto('ingest_keys')
      .values({ app_id: appId, kind: 'server', token_sha256: 'e'.repeat(64) })
      .execute()
    const issue = await db()
      .insertInto('issues')
      .values({
        app_id: appId,
        environment: 'production',
        fingerprint: 'f'.repeat(64),
        title: 'Error: nope',
        culprit: null,
        runtime: 'node',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db()
      .insertInto('events')
      .values({
        issue_id: issue.id,
        occurred_at: new Date(),
        message: 'nope',
        stack: null,
        context: null,
      })
      .execute()

    await db().deleteFrom('apps').where('id', '=', appId).execute()

    expect(await db().selectFrom('ingest_keys').selectAll().execute()).toHaveLength(0)
    expect(await db().selectFrom('issues').selectAll().execute()).toHaveLength(0)
    expect(await db().selectFrom('events').selectAll().execute()).toHaveLength(0)
  })

  it('rejects a status outside the three the spec names', async () => {
    const appId = await seedApp()
    await expect(
      sql`insert into issues (app_id, environment, fingerprint, title, runtime, status)
          values (${appId}, 'production', ${'0'.repeat(64)}, 'x', 'node', 'snoozed')`.execute(db()),
    ).rejects.toThrow()
  })

  it('keeps occurred_at and received_at as separate columns', async () => {
    const appId = await seedApp()
    const issue = await db()
      .insertInto('issues')
      .values({
        app_id: appId,
        environment: 'production',
        fingerprint: '1'.repeat(64),
        title: 'Error: late',
        culprit: null,
        runtime: 'node',
      })
      .returning('id')
      .executeTakeFirstOrThrow()

    // An event that happened during an outage and arrived an hour later.
    const happened = new Date(Date.now() - 3_600_000)
    const row = await db()
      .insertInto('events')
      .values({
        issue_id: issue.id,
        occurred_at: happened,
        message: 'late',
        stack: null,
        context: null,
      })
      .returning(['occurred_at', 'received_at'])
      .executeTakeFirstOrThrow()

    expect(row.occurred_at.getTime()).toBe(happened.getTime())
    expect(row.received_at.getTime()).toBeGreaterThan(row.occurred_at.getTime())
  })
})
