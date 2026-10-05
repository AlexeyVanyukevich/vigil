import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { buildHost } from './host.js'
import { RUNTIME_FILE, type Runtime } from './runtime.js'

const ROOT = resolve(import.meta.dirname, '../..')
const PASSWORD = 'correct horse battery staple'

function run(command: string, args: string[], env: NodeJS.ProcessEnv = {}, input?: string): string {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    ...(input === undefined ? {} : { input }),
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}

/** A port nothing holds right now. Never a fixed one: `./run dev` may hold any fixed port. */
function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => resolvePort(port))
    })
  })
}

async function waitForHealth(baseURL: string, server: ChildProcess): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`the server exited with ${server.exitCode}`)
    try {
      const response = await fetch(`${baseURL}/api/health`)
      if (response.ok) return
    } catch {
      /* not up yet */
    }
    if (attempt > 60) throw new Error('the server did not start')
    await new Promise((r) => setTimeout(r, 500))
  }
}

function stop(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null) return Promise.resolve()
  return new Promise((done) => {
    server.once('exit', () => done())
    server.kill('SIGTERM')
  })
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  let container: StartedPostgreSqlContainer | undefined
  let server: ChildProcess | undefined
  const hostDir = mkdtempSync(join(tmpdir(), 'vigil-ui-host-'))

  const teardown = async () => {
    if (server !== undefined) await stop(server)
    await container?.stop()
    rmSync(hostDir, { recursive: true, force: true })
    rmSync(RUNTIME_FILE, { force: true })
  }

  try {
    // A database of its own, started for this run and gone after it — never the developer's
    // compose database. The journeys assert on counts, and yesterday's issues would make them
    // pass or fail for reasons that are not the code's.
    container = await new PostgreSqlContainer('postgres:16-alpine').start()
    const DATABASE_URL = container.getConnectionUri()

    // The product as it ships: the compiled server serving the built dashboard on one origin.
    run('npm', ['run', 'build'])
    run('npm', ['run', '--workspace', 'server', 'migrate'], { DATABASE_URL })

    // The setup scripts an owner runs, through the same entry points `./run` uses.
    run('npx', ['tsx', 'server/scripts/set-password.ts'], { DATABASE_URL }, PASSWORD)
    run('npx', ['tsx', 'server/scripts/add-app.ts', 'reference', 'The reference application'], {
      DATABASE_URL,
    })
    const issued = run('npx', ['tsx', 'server/scripts/issue-key.ts', 'reference'], {
      DATABASE_URL,
    })
    const ingestKey = issued.match(/vgl_[A-Za-z0-9_-]+/)?.[0]
    if (ingestKey === undefined) throw new Error(`Could not read the key out of:\n${issued}`)

    buildHost(ROOT, hostDir)

    const port = await freePort()
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL,
      PORT: String(port),
      LOG_LEVEL: 'warn',
      // Every journey signs in; the default of ten a minute would turn the suite into the
      // rate limiter's test.
      LOGIN_ATTEMPTS_PER_MINUTE: '1000',
    }
    // A Secure cookie is not stored over plain http, and every sign-in would silently fail.
    delete env.NODE_ENV
    server = spawn(process.execPath, ['dist/src/server.js'], {
      cwd: resolve(ROOT, 'server'),
      env,
      stdio: 'inherit',
    })

    const baseURL = `http://localhost:${port}`
    await waitForHealth(baseURL, server)

    const runtime: Runtime = {
      baseURL,
      ingestKey,
      password: PASSWORD,
      databaseUrl: DATABASE_URL,
      hostDir,
    }
    writeFileSync(RUNTIME_FILE, JSON.stringify(runtime, null, 2))
  } catch (failure) {
    await teardown()
    throw failure
  }

  return teardown
}
