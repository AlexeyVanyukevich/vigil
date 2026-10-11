import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { afterEach, describe, expect, inject, it } from 'vitest'
import { sql } from 'kysely'
import { getTestDb } from './helpers.js'

// The real entry point, in its own process: what is under test is that the process survives,
// which no in-process test can show, and that the failure reaches the app's logger, which only
// `server.ts` wires up.
const SERVER_DIR = resolve(import.meta.dirname, '../..')
const APPLICATION_NAME = 'vigil_pool_error_test'

let child: ChildProcess | undefined
let output = ''

afterEach(() => {
  child?.kill('SIGKILL')
  child = undefined
  output = ''
})

async function freePort(): Promise<number> {
  const server = createServer()
  server.listen(0)
  await once(server, 'listening')
  const address = server.address()
  server.close()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return address.port
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (!condition()) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`the server exited with ${child.exitCode} waiting for ${what}:\n${output}`)
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}:\n${output}`)
    await new Promise((done) => setTimeout(done, 50))
  }
}

async function startServer(): Promise<string> {
  const port = await freePort()
  // `application_name` lets the test find this process's connections, and only them.
  const databaseUrl = `${inject('databaseUrl')}?application_name=${APPLICATION_NAME}`
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: databaseUrl, PORT: String(port) }
  env.LOG_LEVEL = 'info'
  delete env.NODE_ENV
  child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: SERVER_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()))
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()))
  await waitFor(() => output.includes('Server listening'), 'the server to listen')
  return `http://127.0.0.1:${port}`
}

// A session lookup is a query, so it leaves a connection idle in the pool once it answers.
const askForSession = (base: string) =>
  fetch(`${base}/api/me`, { headers: { cookie: 'session=not-a-real-session' } })

interface LogLine {
  level: number
  msg: string
  err?: { code?: string }
}

const logLines = (): LogLine[] =>
  output
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as LogLine)

const terminateBackends = () =>
  sql<{ terminated: boolean }>`
    select pg_terminate_backend(pid) as terminated from pg_stat_activity
    where application_name = ${APPLICATION_NAME}
  `.execute(getTestDb())

/** Resolves once one of this process's backends is blocked waiting for a lock. */
async function waitForBlockedBackend(): Promise<void> {
  const deadline = Date.now() + 15_000
  for (;;) {
    const blocked = await sql`
      select 1 from pg_stat_activity
      where application_name = ${APPLICATION_NAME} and wait_event_type = 'Lock'
    `.execute(getTestDb())
    if (blocked.rows.length > 0) return
    if (Date.now() > deadline) throw new Error(`no backend ever blocked:\n${output}`)
    await new Promise((done) => setTimeout(done, 50))
  }
}

interface Case {
  name: string
  /** Leaves the server's connection in the state under test, then terminates its backend. */
  breakConnection: (base: string) => Promise<(() => Promise<number>) | undefined>
}

// The two states a pooled connection is in when Postgres goes away: the pool holds it, or a
// request does. pg-pool listens for errors on the first and nothing does on the second.
const cases: Case[] = [
  {
    name: 'idle in the pool',
    breakConnection: async (base) => {
      expect((await askForSession(base)).status).toBe(401)
      const terminated = await terminateBackends()
      expect(terminated.rows.length).toBeGreaterThan(0)
      // No request holds the connection, so there is no in-flight answer to check.
      return undefined
    },
  },
  {
    name: 'checked out, with a query in flight',
    breakConnection: async (base) => {
      // A real way to keep a request's query running: another session holds the lock its
      // session lookup needs. The lock is released once the backend is gone.
      let release!: () => void
      const held = new Promise<void>((done) => (release = done))
      let locked!: () => void
      const lockTaken = new Promise<void>((done) => (locked = done))
      const holder = getTestDb()
        .transaction()
        .execute(async (trx) => {
          await sql`lock table sessions in access exclusive mode`.execute(trx)
          locked()
          await held
        })
      await lockTaken
      const pending = askForSession(base).then((response) => response.status)
      await waitForBlockedBackend()
      const terminated = await terminateBackends()
      expect(terminated.rows.length).toBeGreaterThan(0)
      release()
      await holder
      return () => pending
    },
  },
]

describe.each(cases)('a connection that fails while $name', ({ breakConnection }) => {
  it('is logged, and the server keeps running and answering', async () => {
    const base = await startServer()
    const outcome = await breakConnection(base)

    await waitFor(
      () => logLines().some((line) => line.err?.code === '57P01'),
      'the failure to be logged',
    )
    const logged = logLines().find((line) => line.err?.code === '57P01')
    expect(logged?.level).toBe(50)

    // The request that held the connection answers rather than hangs, and with a server error:
    // nothing on its path may turn a database failure into "not signed in".
    if (outcome !== undefined) expect(await outcome()).toBe(500)

    // Still alive, and the pool opened a fresh connection for the next query.
    expect(child?.exitCode).toBeNull()
    expect((await askForSession(base)).status).toBe(401)
  })
})
