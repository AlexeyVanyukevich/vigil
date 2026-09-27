import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { closeTestDb, getTestDb, resetDb } from './helpers.js'
import {
  findLiveKey,
  hashIngestKey,
  insertKey,
  mintIngestKey,
  touchKey,
} from '../../src/modules/ingest/key.repository.js'
import { insertApp, findAppBySlug, listApps } from '../../src/modules/apps/app.repository.js'

const db = () => getTestDb()

beforeEach(async () => {
  await resetDb()
})
afterAll(async () => {
  await closeTestDb()
})

describe('minting', () => {
  it('produces a prefixed token nobody will mistake for something else', () => {
    expect(mintIngestKey()).toMatch(/^vgl_[A-Za-z0-9_-]{43}$/)
  })

  it('never produces the same token twice', () => {
    const seen = new Set(Array.from({ length: 500 }, () => mintIngestKey()))
    expect(seen.size).toBe(500)
  })

  it('digests to sha256 hex', () => {
    expect(hashIngestKey('vgl_whatever')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('storage', () => {
  it('stores only the digest, so a lost key is reissued and never recovered', async () => {
    const app = await insertApp(db(), 'reference', 'The reference application')
    const token = mintIngestKey()
    await insertKey(db(), app.id, 'server', token)

    const rows = await db().selectFrom('ingest_keys').select('token_sha256').execute()
    expect(rows[0]!.token_sha256).toBe(hashIngestKey(token))
    expect(rows[0]!.token_sha256).not.toContain(token)
  })

  // The property the whole trust boundary rests on: the key says which application this is.
  it('resolves a token to its own application and nobody else', async () => {
    const mine = await insertApp(db(), 'mine', 'Mine')
    await insertApp(db(), 'yours', 'Yours')
    const token = mintIngestKey()
    await insertKey(db(), mine.id, 'server', token)

    const resolved = await findLiveKey(db(), token)
    expect(resolved).toMatchObject({ appId: mine.id, appSlug: 'mine', kind: 'server' })
  })

  it('does not resolve an unknown token', async () => {
    expect(await findLiveKey(db(), mintIngestKey())).toBeUndefined()
  })

  it('does not resolve a revoked one', async () => {
    const app = await insertApp(db(), 'reference', 'The reference application')
    const token = mintIngestKey()
    const id = await insertKey(db(), app.id, 'server', token)
    await db()
      .updateTable('ingest_keys')
      .set({ revoked_at: new Date() })
      .where('id', '=', id)
      .execute()

    expect(await findLiveKey(db(), token)).toBeUndefined()
  })

  // Rotation without downtime: issue the new key, deploy, revoke the old one. Two live keys for
  // an afternoon is the reason keys are a table and not a column.
  it('resolves two live keys for one application at the same time', async () => {
    const app = await insertApp(db(), 'reference', 'The reference application')
    const older = mintIngestKey()
    const newer = mintIngestKey()
    await insertKey(db(), app.id, 'server', older)
    await insertKey(db(), app.id, 'server', newer)

    expect((await findLiveKey(db(), older))?.appId).toBe(app.id)
    expect((await findLiveKey(db(), newer))?.appId).toBe(app.id)
  })
})

describe('last_used_at', () => {
  it('is stamped on first use', async () => {
    const app = await insertApp(db(), 'reference', 'The reference application')
    const token = mintIngestKey()
    const id = await insertKey(db(), app.id, 'server', token)
    expect(
      (await db().selectFrom('ingest_keys').select('last_used_at').executeTakeFirstOrThrow())
        .last_used_at,
    ).toBeNull()

    await touchKey(db(), id)
    const row = await db()
      .selectFrom('ingest_keys')
      .select('last_used_at')
      .executeTakeFirstOrThrow()
    expect(row.last_used_at).not.toBeNull()
  })

  // A write on every report would turn the busiest path in the system into write traffic for a
  // column nobody reads more than once a day.
  it('is not rewritten on every use', async () => {
    const app = await insertApp(db(), 'reference', 'The reference application')
    const id = await insertKey(db(), app.id, 'server', mintIngestKey())
    await touchKey(db(), id)
    const first = (
      await db().selectFrom('ingest_keys').select('last_used_at').executeTakeFirstOrThrow()
    ).last_used_at

    await touchKey(db(), id)
    const second = (
      await db().selectFrom('ingest_keys').select('last_used_at').executeTakeFirstOrThrow()
    ).last_used_at
    expect(second).toEqual(first)
  })

  it('is rewritten once the hour has passed', async () => {
    const app = await insertApp(db(), 'reference', 'The reference application')
    const id = await insertKey(db(), app.id, 'server', mintIngestKey())
    await touchKey(db(), id)
    await sql`update ingest_keys set last_used_at = now() - interval '2 hours'`.execute(db())

    await touchKey(db(), id)
    const row = await db()
      .selectFrom('ingest_keys')
      .select('last_used_at')
      .executeTakeFirstOrThrow()
    expect(row.last_used_at!.getTime()).toBeGreaterThan(Date.now() - 60_000)
  })
})

describe('applications', () => {
  it('finds one by slug', async () => {
    const created = await insertApp(db(), 'reference', 'The reference application')
    expect(await findAppBySlug(db(), 'reference')).toEqual(created)
    expect(await findAppBySlug(db(), 'absent')).toBeUndefined()
  })

  it('lists them by slug, with vigil itself among them', async () => {
    await insertApp(db(), 'zeta', 'Zeta')
    await insertApp(db(), 'alpha', 'Alpha')
    expect((await listApps(db())).map((a) => a.slug)).toEqual(['alpha', 'vigil', 'zeta'])
  })
})
