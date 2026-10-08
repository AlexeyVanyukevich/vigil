import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Page } from '@playwright/test'
import pg from 'pg'
import { HOST_ENTRY } from './host.js'
import { RUNTIME_FILE, type Runtime } from './runtime.js'

export const runtime = JSON.parse(readFileSync(RUNTIME_FILE, 'utf8')) as Runtime

export async function signIn(page: Page, baseURL: string = runtime.baseURL): Promise<void> {
  await page.goto(`${baseURL}/login`)
  await page.getByLabel('Password').fill(runtime.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(`${baseURL}/`)
}

export interface Failure {
  message: string
  environment: string
  /**
   * `crash` throws it uncaught, and the client reports it as the process dies. `handled` catches
   * it `times` times and hands each to `captureError`, which collapses the run into one event.
   */
  mode: 'crash' | 'handled'
  times?: number
}

/** Hard cap on one host process. One still running here is one the client kept alive. */
const HOST_DEADLINE_MS = 10_000

/**
 * Runs the owner's application with the real client installed and the issued key, and makes it
 * fail. Resolves once the process has ended, by which time the client has had its answer.
 */
export function reportFrom(failure: Failure): Promise<void> {
  const args = [HOST_ENTRY, failure.mode, failure.message, String(failure.times ?? 1)]
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: runtime.hostDir,
      // Nothing inherited that could load code into the host: no NODE_OPTIONS.
      env: {
        PATH: process.env.PATH ?? '',
        VIGIL_URL: runtime.baseURL,
        VIGIL_KEY: runtime.ingestKey,
        VIGIL_ENVIRONMENT: failure.environment,
      },
    })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
    const killer = setTimeout(() => child.kill('SIGKILL'), HOST_DEADLINE_MS)
    child.on('close', (code, signal) => {
      clearTimeout(killer)
      // A crash must have been a real one — uncaught, printed, exit 1 — or the journey would be
      // proving the handled path twice. A handled run ends cleanly and says nothing.
      const expected =
        failure.mode === 'crash'
          ? code === 1 && output.includes(`TypeError: ${failure.message}`)
          : code === 0 && output === ''
      if (expected) resolve()
      else reject(new Error(`the host ${failure.mode} ended ${code} (${signal}):\n${output}`))
    })
  })
}

/**
 * Lets every session run out, as thirty days without a visit would. The rows stay, so it is the
 * server's expiry check that turns them away, not a lookup that finds nothing.
 */
export async function expireSessions(): Promise<void> {
  const client = new pg.Client({ connectionString: runtime.databaseUrl })
  await client.connect()
  try {
    await client.query("update sessions set expires_at = now() - interval '1 minute'")
  } finally {
    await client.end()
  }
}

export interface Proxy {
  url: string
  /** From now on the upstream refuses connections, and the proxy answers 502 as nginx would. */
  cutOff(): void
  /**
   * Holds every API request unanswered until `release`. With the answers held, the only screens
   * the dashboard can show are ones it rendered from memory. Done here rather than with
   * `page.route`, which does not see the requests of a page restored from the back-forward cache.
   */
  hold(): { asked: () => string[]; release: () => void }
  close(): Promise<void>
}

/**
 * A reverse proxy in front of the server, as production has one. `Host` is passed through
 * unchanged, because the server refuses a write whose `Origin` disagrees with it.
 */
export async function startProxy(upstream: string): Promise<Proxy> {
  const target = new URL(upstream)
  // A port that was free a moment ago and is closed now: connecting to it is refused.
  const dead = createServer()
  await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r))
  const deadPort = (dead.address() as AddressInfo).port
  await new Promise((r) => dead.close(r))

  let port = target.port
  let held: Array<{ path: string; forward: () => void }> | undefined

  const proxy: Server = createServer((incoming, outgoing) => {
    const forward = () => {
      const upstreamRequest = request(
        {
          host: target.hostname,
          port,
          method: incoming.method,
          path: incoming.url,
          headers: incoming.headers,
        },
        (answer) => {
          outgoing.writeHead(answer.statusCode ?? 502, answer.headers)
          answer.pipe(outgoing)
        },
      )
      upstreamRequest.on('error', () => {
        outgoing.writeHead(502, { 'content-type': 'text/html' }).end('<h1>502 Bad Gateway</h1>')
      })
      incoming.pipe(upstreamRequest)
    }
    const path = incoming.url ?? ''
    if (held !== undefined && path.startsWith('/api/')) held.push({ path, forward })
    else forward()
  })
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r))

  return {
    url: `http://localhost:${(proxy.address() as AddressInfo).port}`,
    cutOff: () => {
      port = String(deadPort)
    },
    hold: () => {
      const these: Array<{ path: string; forward: () => void }> = []
      held = these
      return {
        asked: () => these.map((request) => request.path.split('?')[0] ?? request.path),
        release: () => {
          held = undefined
          for (const request of these) request.forward()
        },
      }
    },
    close: () => {
      proxy.closeAllConnections()
      return new Promise((r) => proxy.close(() => r()))
    },
  }
}
