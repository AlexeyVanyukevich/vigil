import type { Kysely, Transaction, UpdateObject } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '../../db/schema.js'
import { fingerprintOf } from '../../shared/fingerprint.js'
import { guardBytes } from '../../shared/bytes.js'
import { replaceNul, stringifyWithoutNul } from '../../shared/nul.js'
import type { IngestBodyType } from './ingest.schemas.js'

export interface RecordedIssue {
  issueId: string
  /** Slice 2 turns these two flags into `issue.new` and `issue.regressed` outbox rows. */
  isNew: boolean
  regressed: boolean
}

/**
 * An event as it is stored: every string that reaches a column has lost its U+0000, and
 * `context` is already the JSON text written to its column.
 */
interface CleanEvent {
  type: string
  message: string
  stack: string | null
  occurredAt: Date
  count: number
  context: string | null
  fingerprint: string | undefined
}

export interface Caps {
  maxStackBytes: number
  maxContextBytes: number
}

/**
 * Takes a database and two numbers and nothing else — no Fastify, no request. §13 records
 * vigil's own failures through this same service, without an HTTP round trip.
 */
export class IngestService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly caps: Caps,
  ) {}

  /**
   * `appId` is the caller's to supply, and the route reads it from the key (§4). This method
   * has no way to learn it from `body`, which is the point.
   *
   * The whole batch is one transaction: a batch is one unit, and half-storing it would leave
   * the client with no way to tell what to resend.
   */
  async record(appId: string, received: IngestBodyType): Promise<RecordedIssue[]> {
    // Every string that reaches a column — `stack`, `message`, `type`, `fingerprint`,
    // `environment`, and `context`'s keys and values — loses its U+0000, which Postgres refuses
    // outright: one such event would otherwise fail the whole batch. Done before the byte guards
    // and the fingerprint below, so the caps measure what is stored and grouping sees it too.
    const environment = replaceNul(received.environment)
    const events = received.events.map((event): CleanEvent => ({
      type: replaceNul(event.type),
      message: replaceNul(event.message),
      stack: event.stack === undefined ? null : replaceNul(event.stack),
      occurredAt: new Date(event.occurred_at),
      count: event.count ?? 1,
      context: event.context === undefined ? null : stringifyWithoutNul(event.context),
      fingerprint: event.fingerprint === undefined ? undefined : replaceNul(event.fingerprint),
    }))

    // Guarded before the transaction opens, so an oversize payload never takes a lock.
    for (const event of events) {
      if (event.stack !== null) {
        guardBytes(event.stack, this.caps.maxStackBytes, 'stack')
      }
      if (event.context !== null) {
        guardBytes(event.context, this.caps.maxContextBytes, 'context')
      }
    }

    // Fingerprinted up front, and then processed in fingerprint order rather than the batch's
    // own order. `app_id` and `environment` are fixed for the whole batch, so fingerprint is the
    // only thing that decides which `issues` row an event locks — two processes racing the same
    // app with the same errors listed in different orders would otherwise lock those rows in
    // opposite orders, and Postgres would abort one of them with a 40P01 deadlock rather than
    // let it wait forever. A fixed, deterministic order removes the cycle entirely: every
    // transaction that touches both rows reaches for the alphabetically-first one first.
    const withFingerprint = events.map((event, index) => ({
      index,
      event,
      ...fingerprintOf({
        type: event.type,
        message: event.message,
        stack: event.stack ?? undefined,
        fingerprint: event.fingerprint,
      }),
    }))
    const inLockOrder = [...withFingerprint].sort((a, b) =>
      a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0,
    )

    return this.db.transaction().execute(async (trx) => {
      // Filled out of order (by lock order) but returned in the batch's own order: nothing about
      // the client-visible contract — one `RecordedIssue` per submitted event, same positions —
      // should depend on an internal choice made only to avoid a deadlock.
      const recorded: RecordedIssue[] = []
      for (const item of inLockOrder) {
        recorded[item.index] = await this.recordOne(
          trx,
          appId,
          { environment, runtime: received.runtime },
          item.event,
          item.fingerprint,
          item.culprit,
        )
      }
      return recorded
    })
  }

  private async recordOne(
    trx: Transaction<Database>,
    appId: string,
    body: Pick<IngestBodyType, 'environment' | 'runtime'>,
    event: CleanEvent,
    fingerprint: string,
    culprit: string | null,
  ): Promise<RecordedIssue> {
    const { occurredAt, count } = event
    const title = event.message === '' ? event.type : `${event.type}: ${event.message}`

    // Insert first, and let the unique constraint decide. Two processes reporting the same new
    // error in the same millisecond then produce one issue, not a duplicate-key 500.
    const created = await trx
      .insertInto('issues')
      .values({
        app_id: appId,
        environment: body.environment,
        fingerprint,
        title: title.slice(0, 500),
        culprit,
        runtime: body.runtime,
        occurrence_count: count,
        // When it happened, not when it arrived: the column default is the receive time.
        first_seen_at: occurredAt,
        last_seen_at: occurredAt,
      })
      .onConflict((oc) => oc.columns(['app_id', 'environment', 'fingerprint']).doNothing())
      .returning('id')
      .executeTakeFirst()

    let issueId: string
    let regressed = false

    if (created !== undefined) {
      issueId = created.id
    } else {
      // Locked before reading, so the status this decision is based on cannot change under it.
      const existing = await trx
        .selectFrom('issues')
        .select(['id', 'status'])
        .where('app_id', '=', appId)
        .where('environment', '=', body.environment)
        .where('fingerprint', '=', fingerprint)
        .forUpdate()
        .executeTakeFirstOrThrow()

      issueId = existing.id
      // Only `resolved` reopens. `ignored` is a decision the owner made, and a new occurrence
      // must not quietly undo it — otherwise `ignored` means nothing.
      regressed = existing.status === 'resolved'

      const update: UpdateObject<Database, 'issues'> = {
        occurrence_count: sql`occurrence_count + ${count}`,
        // An offline queue replaying an hour late must not drag this backwards and make a
        // live issue look stale.
        last_seen_at: sql`greatest(last_seen_at, ${occurredAt})`,
        // And a replayed older occurrence pulls the first sighting earlier, never later.
        first_seen_at: sql`least(first_seen_at, ${occurredAt})`,
      }
      if (regressed) {
        update.status = 'open'
        update.reopened_at = sql`now()`
      }
      // The stack that named the culprit may have been absent on the first report.
      if (culprit !== null) {
        update.culprit = culprit
      }

      await trx.updateTable('issues').set(update).where('id', '=', issueId).execute()
    }

    await trx
      .insertInto('events')
      .values({
        issue_id: issueId,
        occurred_at: occurredAt,
        message: event.message,
        stack: event.stack,
        context: event.context,
        count,
      })
      .execute()

    return { issueId, isNew: created !== undefined, regressed }
  }
}
