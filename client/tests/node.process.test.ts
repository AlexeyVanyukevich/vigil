import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// What `install` does to a process can only be shown on a process: calling its listener in this
// one cannot prove that a crashed process actually dies, with which code, or that an idle one is
// free to end. Each case spawns a small host application that installs the built client and then
// misbehaves, and reads its real exit code, output and timing.

const clientRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
let workDir: string
let entry: string

interface Received {
  type: string
  message: string
  count?: number
  context?: Record<string, unknown>
}
let received: Received[] = []

let accepting: Server
let hanging: Server
let urls: Record<Vigil, string>

type Vigil = 'accepting' | 'hanging' | 'unreachable'

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    })
  })
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = ''
    request.on('data', (chunk: Buffer) => (body += chunk.toString()))
    request.on('end', () => resolve(body))
  })
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'vigil-client-process-'))
  const dist = join(workDir, 'dist')
  // The package as it ships, run by plain `node`: no loader that could add listeners of its own.
  execFileSync('npx', ['tsc', '-p', join(clientRoot, 'tsconfig.json'), '--outDir', dist], {
    cwd: clientRoot,
  })
  writeFileSync(join(dist, 'package.json'), JSON.stringify({ type: 'module' }))
  entry = join(dist, 'node.js')

  accepting = createServer(async (request, response) => {
    const body = JSON.parse(await readBody(request)) as { events: Received[] }
    received.push(...body.events)
    response.writeHead(202).end()
  })
  // Takes the request and never answers it.
  hanging = createServer(() => {})

  const closed = createServer()
  const unreachable = await listen(closed)
  await new Promise((resolve) => closed.close(resolve))

  urls = { accepting: await listen(accepting), hanging: await listen(hanging), unreachable }
}, 60_000)

afterAll(async () => {
  for (const server of [accepting, hanging]) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
  rmSync(workDir, { recursive: true, force: true })
})

beforeEach(() => {
  received = []
})

interface Scenario {
  name: string
  vigil: Vigil
  /** JavaScript spread into `install`'s options. */
  options?: string
  /** Node flags, ahead of the script. */
  flags?: string[]
  /** What the host does before installing vigil. */
  before?: string
  /** What the host does after. */
  script: string
  code: number
  events: Array<Partial<Received>>
  stdout?: string[]
  stderr?: string[]
  stderrLacks?: string[]
  withinMs: number
  atLeastMs?: number
}

/** Keeps the event loop busy, as a server does. Without vigil's exit it would never end. */
const BUSY = 'setInterval(() => {}, 1_000)'
const CRASH = "setTimeout(() => { throw new Error('kaboom') }, 10)"

const scenarios: Scenario[] = [
  {
    name: 'an uncaught exception is reported and printed, then the process exits 1',
    vigil: 'accepting',
    script: `${BUSY}; ${CRASH}`,
    code: 1,
    events: [{ type: 'Error', message: 'kaboom', count: 1, context: { fatal: true } }],
    stderr: ['Error: kaboom', '    at ', 'Node.js v'],
    withinMs: 3_000,
  },
  {
    name: 'it exits 1 promptly when vigil is unreachable',
    vigil: 'unreachable',
    script: `${BUSY}; ${CRASH}`,
    code: 1,
    events: [],
    stderr: ['Error: kaboom'],
    withinMs: 3_000,
  },
  {
    name: 'it exits 1 at the fatal deadline when vigil hangs',
    vigil: 'hanging',
    options: '{ fatalFlushMs: 300, timeoutMs: 60_000 }',
    script: `${BUSY}; ${CRASH}`,
    code: 1,
    events: [],
    stderr: ['Error: kaboom'],
    withinMs: 3_000,
    atLeastMs: 300,
  },
  {
    // A request that holds no socket and never settles, with the transport's own clock far off.
    // Nothing but the fatal deadline decides when this process ends.
    name: 'it exits 1 at the fatal deadline when the request never settles',
    vigil: 'accepting',
    options: '{ fatalFlushMs: 300, timeoutMs: 60_000, fetch: () => new Promise(() => {}) }',
    script: CRASH,
    code: 1,
    events: [],
    stderr: ['Error: kaboom'],
    withinMs: 3_000,
    atLeastMs: 300,
  },
  {
    name: 'a host handler added after it decides how the process ends',
    vigil: 'accepting',
    script: `${BUSY}
      process.on('uncaughtException', (e) => {
        console.log('host saw ' + e.message)
        setTimeout(() => process.exit(7), 300)
      })
      ${CRASH}`,
    code: 7,
    events: [{ message: 'kaboom', context: { fatal: true } }],
    stdout: ['host saw kaboom'],
    stderrLacks: ['Error: kaboom'],
    withinMs: 3_000,
  },
  {
    name: 'a host handler added before it decides how the process ends',
    vigil: 'accepting',
    before: `process.on('uncaughtException', (e) => {
        console.log('host saw ' + e.message)
        setTimeout(() => process.exit(7), 300)
      })`,
    script: `${BUSY}; ${CRASH}`,
    code: 7,
    events: [{ message: 'kaboom' }],
    stdout: ['host saw kaboom'],
    withinMs: 3_000,
  },
  {
    name: 'a host handler that carries on is left to carry on',
    vigil: 'accepting',
    script: `process.on('uncaughtException', () => console.log('host carries on'))
      ${CRASH}
      setTimeout(() => console.log('still serving'), 400)`,
    code: 0,
    events: [{ message: 'kaboom' }],
    stdout: ['host carries on', 'still serving'],
    withinMs: 3_000,
  },
  {
    // Node's default crashes on this; vigil's `unhandledRejection` listener alone would stop it.
    name: 'an unhandled rejection ends the process as Node would, reported once',
    vigil: 'accepting',
    script: `${BUSY}; setTimeout(() => { Promise.reject(new Error('nobody awaited')) }, 10)`,
    code: 1,
    events: [
      {
        message: 'nobody awaited',
        count: 1,
        context: { fatal: true, unhandledRejection: true },
      },
    ],
    stderr: ['Error: nobody awaited'],
    withinMs: 3_000,
  },
  {
    name: 'a rejection with a value that is not an error ends it too, wrapped as Node wraps it',
    vigil: 'accepting',
    script: `${BUSY}; setTimeout(() => { Promise.reject('plain words') }, 10)`,
    code: 1,
    events: [
      {
        type: 'UnhandledPromiseRejection',
        message: expect.stringContaining('plain words') as unknown as string,
        count: 1,
      },
    ],
    stderr: ['plain words'],
    withinMs: 3_000,
  },
  {
    name: 'a host that handles rejections itself carries on',
    vigil: 'accepting',
    script: `process.on('unhandledRejection', () => console.log('host handled it'))
      Promise.reject(new Error('nobody awaited'))
      setTimeout(() => console.log('still serving'), 400)`,
    code: 0,
    events: [{ message: 'nobody awaited', context: { unhandledRejection: true } }],
    stdout: ['host handled it', 'still serving'],
    withinMs: 3_000,
  },
  {
    name: 'with --unhandled-rejections=warn the process carries on, as Node lets it',
    vigil: 'accepting',
    flags: ['--unhandled-rejections=warn'],
    script: `Promise.reject(new Error('nobody awaited'))
      setTimeout(() => console.log('still serving'), 400)`,
    code: 0,
    events: [{ message: 'nobody awaited', context: { unhandledRejection: true } }],
    stdout: ['still serving'],
    withinMs: 3_000,
  },
  {
    name: 'with --unhandled-rejections=warn-with-error-code it ends with code 1 on its own',
    vigil: 'accepting',
    flags: ['--unhandled-rejections=warn-with-error-code'],
    script: `Promise.reject(new Error('nobody awaited'))`,
    code: 1,
    events: [{ message: 'nobody awaited', count: 1 }],
    withinMs: 3_000,
  },
  {
    name: 'with --unhandled-rejections=strict it exits 1, reported once',
    vigil: 'accepting',
    flags: ['--unhandled-rejections=strict'],
    script: `${BUSY}; setTimeout(() => { Promise.reject(new Error('nobody awaited')) }, 10)`,
    code: 1,
    events: [
      {
        message: 'nobody awaited',
        count: 1,
        context: { fatal: true, unhandledRejection: true },
      },
    ],
    withinMs: 3_000,
  },
  {
    // The flush timer repeats every five seconds. Referenced, this process would never end.
    name: 'a script that has finished exits at once, without waiting for the flush timer',
    vigil: 'accepting',
    script: `console.log('done')`,
    code: 0,
    events: [],
    stdout: ['done'],
    withinMs: 2_000,
  },
  {
    name: 'after close, a crash is Node’s alone again',
    vigil: 'accepting',
    script: `await vigil.close()
      ${BUSY}; ${CRASH}`,
    code: 1,
    events: [],
    stderr: ["throw new Error('kaboom')", 'Error: kaboom'],
    withinMs: 3_000,
  },
  {
    name: 'installed twice, a crash is reported once and exits once',
    vigil: 'accepting',
    script: `install({ url: process.env.VIGIL_URL, key: 'vgl_child', app: 'child', environment: 'test', log: () => {} })
      ${BUSY}; ${CRASH}`,
    code: 1,
    events: [{ message: 'kaboom', count: 1 }],
    withinMs: 3_000,
  },
]

interface Outcome {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  ms: number
}

/** Hard cap on one child. A process still running here is one vigil kept alive. */
const KILL_AFTER_MS = 8_000

function run(scenario: Scenario, index: number): Promise<Outcome> {
  const file = join(workDir, `host-${index}.mjs`)
  writeFileSync(
    file,
    `${scenario.before ?? ''}
import { install } from ${JSON.stringify(entry)}
const vigil = install({
  url: process.env.VIGIL_URL,
  key: 'vgl_child',
  app: 'child',
  environment: 'test',
  ...(${scenario.options ?? '{}'}),
})
${scenario.script}
`,
  )

  return new Promise((resolve) => {
    const started = performance.now()
    const child = spawn(process.execPath, [...(scenario.flags ?? []), file], {
      // Nothing inherited that could load code into the host: no NODE_OPTIONS.
      env: { PATH: process.env.PATH ?? '', VIGIL_URL: urls[scenario.vigil] },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    const killer = setTimeout(() => child.kill('SIGKILL'), KILL_AFTER_MS)
    child.on('close', (code, signal) => {
      clearTimeout(killer)
      resolve({ code, signal, stdout, stderr, ms: Math.round(performance.now() - started) })
    })
  })
}

describe('a host process with the client installed', () => {
  // A loop rather than `it.each`, which cuts a long `$name` to forty characters.
  scenarios.forEach((scenario, index) => {
    it(
      scenario.name,
      async () => {
        const outcome = await run(scenario, index)
        const shown = `exit ${outcome.code} (${outcome.signal}) in ${outcome.ms} ms\n${outcome.stderr}`

        expect(outcome.signal, shown).toBeNull()
        expect(outcome.code, shown).toBe(scenario.code)
        expect(outcome.ms, shown).toBeLessThan(scenario.withinMs)
        if (scenario.atLeastMs !== undefined) {
          expect(outcome.ms, shown).toBeGreaterThanOrEqual(scenario.atLeastMs)
        }
        for (const text of scenario.stdout ?? []) expect(outcome.stdout, shown).toContain(text)
        for (const text of scenario.stderr ?? []) expect(outcome.stderr, shown).toContain(text)
        for (const text of scenario.stderrLacks ?? []) {
          expect(outcome.stderr, shown).not.toContain(text)
        }
        expect(received, shown).toEqual(scenario.events.map((e) => expect.objectContaining(e)))
      },
      KILL_AFTER_MS + 5_000,
    )
  })
})
