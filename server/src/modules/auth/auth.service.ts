import type { Kysely } from 'kysely'
import type { Database } from '../../db/schema.js'
import { hashPassword, verifyPassword } from './password.js'
import { theOnlyOwner } from './owner.repository.js'
import {
  deleteSession,
  findLiveSession,
  insertSession,
  mintToken,
  slideSession,
  type Session,
} from './session.repository.js'

/**
 * Verified against when no owner exists, so an unconfigured server does not answer a login
 * attempt noticeably faster than a configured one. Without it the absence of a password is
 * readable from the clock even though every response body says the same thing.
 *
 * Built on first use rather than at import, so hashing it does not delay startup.
 */
let dummyHash: Promise<string> | undefined
function theDummyHash(): Promise<string> {
  dummyHash ??= hashPassword('a password nobody has, of a believable length')
  return dummyHash
}

const HOUR_MS = 3_600_000

export class AuthService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly ttlDays: number,
    // Injected so the once-an-hour slide below can be tested at the boundary without sleeping
    // an hour of real time. Defaults to the real clock, so the one production caller needs no
    // change.
    private readonly now: () => number = Date.now,
  ) {}

  private expiryFromNow(): Date {
    return new Date(this.now() + this.ttlDays * 24 * HOUR_MS)
  }

  /** The token, or undefined when the password does not match — including when none is set. */
  async signIn(password: string): Promise<string | undefined> {
    const owner = await theOnlyOwner(this.db)

    if (owner === undefined) {
      await verifyPassword(password, await theDummyHash())
      return undefined
    }
    if (!(await verifyPassword(password, owner.password_hash))) return undefined

    const token = mintToken()
    await insertSession(this.db, owner.id, token, this.expiryFromNow())
    return token
  }

  async resolve(token: string): Promise<Session | undefined> {
    const session = await findLiveSession(this.db, token)
    if (session === undefined) return undefined

    // Slid at most once an hour rather than on every request: a write on every read turns a
    // read-only screen into write traffic.
    if (this.now() - session.lastSeenAt.getTime() > HOUR_MS) {
      await slideSession(this.db, session.id, this.expiryFromNow())
    }
    return session
  }

  async signOut(sessionId: string): Promise<void> {
    await deleteSession(this.db, sessionId)
  }
}
