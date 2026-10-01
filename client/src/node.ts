import { inspect } from 'node:util'
import { toWireEvent } from './payload.js'
import { EventQueue } from './queue.js'
import { send, type Batch } from './transport.js'

export interface VigilOptions {
  /** Vigil's base URL, without a path. */
  url: string
  /** A server ingest key. It names the application; nothing in the payload does. */
  key: string
  /**
   * A local label, used only in this client's own log lines. Deliberately never sent: §4 reads
   * the application from the key, because an identifier the sender controls is one an attacker
   * controls.
   */
  app: string
  environment: string
  /** Values scrubbed out of messages, stacks and contexts before anything is queued. */
  secrets?: readonly string[]
  /** Distinct failures held between flushes; the oldest is dropped past it. Default 100. */
  maxQueue?: number
  /** Default 5,000. The timer never keeps the process alive on its own. */
  flushIntervalMs?: number
  /** The most one flush may take, however many requests it needs. Default 3,000. */
  timeoutMs?: number
  /** Milliseconds allowed to flush while the process is dying. Default 1,000. */
  fatalFlushMs?: number
  /**
   * Default true: when vigil's is the only `uncaughtException` listener, it flushes, prints the
   * error and exits with code 1 — what Node does when there is no listener at all. With another
   * listener present, Node would not have exited, so neither does vigil, whatever this says.
   *
   * False means vigil never ends the process. Set it only when the host ends the process itself
   * in a way vigil cannot see; with no handler at all, a crashed process then carries on.
   */
  exitOnUncaught?: boolean
  fetch?: typeof globalThis.fetch
  /** Where this client's own lines go. `console.warn` by default. */
  log?: (message: string, detail?: unknown) => void
}

export interface Vigil {
  captureError(error: unknown, context?: Record<string, unknown>): void
  flush(): Promise<void>
  close(): Promise<void>
}

const DEFAULTS = {
  maxQueue: 100,
  flushIntervalMs: 5_000,
  timeoutMs: 3_000,
  fatalFlushMs: 1_000,
} as const

/** The server refuses a batch whose environment is blank or longer than this (§6). */
const MAX_ENVIRONMENT_LENGTH = 64

/** The longest delay `setTimeout` takes as given. Past it, Node warns and fires in 1 ms. */
const MAX_TIMER_MS = 2_147_483_647

/** How long a dying process waits for its last stderr line to drain before exiting anyway. */
const PRINT_GRACE_MS = 100

type Log = (message: string, detail?: unknown) => void

/**
 * One client per process. A second set of process listeners would report every crash twice and
 * double the flush traffic, and two clients would each see the other's listener and defer to it,
 * so neither would exit.
 */
let active: Vigil | undefined

/** What a client that cannot report hands back: it keeps the host's code working, and no more. */
const INERT: Vigil = {
  captureError() {},
  flush: async () => {},
  close: async () => {},
}

/** Never throws, whatever `log` does. This runs inside somebody else's error handler. */
function safely(log: Log, message: string, detail?: unknown): void {
  try {
    if (detail === undefined) log(message)
    else log(message, detail)
  } catch {
    /* even the log is not allowed to be the thing that throws */
  }
}

const defaultLog: Log = (message, detail) => {
  if (detail === undefined) console.warn(`[vigil] ${message}`)
  else console.warn(`[vigil] ${message}`, detail)
}

const nonBlank = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== ''

function isUrl(value: string): boolean {
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

interface Settings {
  url: string
  key: string
  label: string
  environment: string
  secrets: readonly string[]
  maxQueue: number
  flushIntervalMs: number
  timeoutMs: number
  fatalFlushMs: number
  exitOnUncaught: boolean
  fetch: typeof globalThis.fetch | undefined
  log: Log
}

/**
 * Reads every option once, here, so nothing later touches the caller's object. Options come from
 * environment variables, often unset outside production, and an untyped caller can pass anything.
 * Returns why it cannot report instead of throwing.
 */
function read(options: VigilOptions): { settings: Settings } | { unusable: string; log: Log } {
  const raw: Partial<Record<keyof VigilOptions, unknown>> =
    typeof options === 'object' && options !== null ? { ...options } : {}

  const log: Log = typeof raw.log === 'function' ? (raw.log as Log) : defaultLog
  const label = nonBlank(raw.app) ? raw.app : 'unnamed application'
  const say = (message: string) => safely(log, `${label}: ${message}`)

  if (!nonBlank(raw.url) || !isUrl(raw.url)) {
    return { unusable: 'url must be vigil’s base URL', log }
  }
  if (!nonBlank(raw.key)) return { unusable: 'key must be an ingest key', log }
  if (!nonBlank(raw.environment) || raw.environment.length > MAX_ENVIRONMENT_LENGTH) {
    // The server refuses every batch with such an environment, so nothing would ever arrive.
    return { unusable: `environment must be 1 to ${MAX_ENVIRONMENT_LENGTH} characters`, log }
  }

  function number(
    name: 'maxQueue' | 'flushIntervalMs' | 'timeoutMs' | 'fatalFlushMs',
    usable: (value: number) => boolean,
  ): number {
    const value = raw[name]
    if (value === undefined) return DEFAULTS[name]
    if (typeof value === 'number' && usable(value)) return Math.min(value, MAX_TIMER_MS)
    say(`ignoring ${name} ${String(value)}; using the default, ${DEFAULTS[name]}`)
    return DEFAULTS[name]
  }

  return {
    settings: {
      url: raw.url,
      key: raw.key,
      label,
      environment: raw.environment,
      secrets: Array.isArray(raw.secrets) ? (raw.secrets as readonly string[]) : [],
      maxQueue: number('maxQueue', (n) => Number.isInteger(n) && n >= 1),
      flushIntervalMs: number('flushIntervalMs', (n) => n >= 1),
      timeoutMs: number('timeoutMs', (n) => n >= 1),
      fatalFlushMs: number('fatalFlushMs', (n) => n >= 0),
      exitOnUncaught: raw.exitOnUncaught !== false,
      fetch: typeof raw.fetch === 'function' ? (raw.fetch as typeof globalThis.fetch) : undefined,
      log,
    },
  }
}

/**
 * Node's `--unhandled-rejections` mode, from `NODE_OPTIONS` and then the command line, which
 * wins. Node's default is `throw`.
 */
function rejectionMode(): string {
  let mode = 'throw'
  const scan = (args: readonly string[]) => {
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]!
      if (arg.startsWith('--unhandled-rejections=')) mode = arg.slice(arg.indexOf('=') + 1)
      else if (arg === '--unhandled-rejections' && args[i + 1] !== undefined) mode = args[++i]!
    }
  }
  try {
    scan((process.env.NODE_OPTIONS ?? '').split(/\s+/))
    scan(process.execArgv)
  } catch {
    /* Node's default, then */
  }
  return mode
}

/** Node's own test for whether a rejection reason is raised as it is or wrapped. */
function isErrorLike(value: unknown): boolean {
  return typeof value === 'object' && value !== null && Object.hasOwn(value, 'stack')
}

function describeValue(value: unknown): string {
  try {
    return typeof value === 'string' ? value : inspect(value)
  } catch {
    return '[a value that cannot be printed]'
  }
}

/** What Node raises for a rejection whose reason is not an error, with its message and code. */
function unhandledRejectionError(reason: unknown): Error {
  const error = new Error(
    'This error originated either by throwing inside of an async function without a catch ' +
      'block, or by rejecting a promise which was not handled with .catch(). The promise ' +
      `rejected with the reason "${describeValue(reason)}".`,
  )
  error.name = 'UnhandledPromiseRejection'
  return Object.assign(error, { code: 'ERR_UNHANDLED_REJECTION' })
}

/**
 * Node prints a fatal error to stderr before it exits, and a listener stops it doing so. Without
 * this, installing vigil would take the stack out of every crash log the host keeps. Waits for
 * the write, because stderr on a pipe is asynchronous on macOS and `process.exit` drops what is
 * still pending — but not for long, because the process is dying.
 */
function printAsNodeWould(error: unknown): Promise<void> {
  return new Promise<void>((resolve) => {
    let guard: ReturnType<typeof setTimeout> | undefined
    const done = () => {
      clearTimeout(guard)
      resolve()
    }
    try {
      guard = setTimeout(done, PRINT_GRACE_MS)
      process.stderr.write(`${describeValue(error)}\n\nNode.js ${process.version}\n`, done)
    } catch {
      done()
    }
  })
}

export function install(options: VigilOptions): Vigil {
  let outcome: ReturnType<typeof read>
  try {
    outcome = read(options)
  } catch (failure) {
    // A getter on the options that throws. There is nothing to report with.
    safely(defaultLog, 'not reporting: the options could not be read', failure)
    return INERT
  }
  if ('unusable' in outcome) {
    safely(outcome.log, `not reporting: ${outcome.unusable}`)
    return INERT
  }

  const settings = outcome.settings
  if (active !== undefined) {
    safely(
      settings.log,
      `${settings.label}: already installed; this returns the client installed first, and ` +
        'ignores these options',
    )
    return active
  }

  try {
    return start(settings)
  } catch (failure) {
    safely(settings.log, `${settings.label}: not reporting: could not install`, failure)
    return INERT
  }
}

function start(settings: Settings): Vigil {
  const { label, log } = settings
  const say = (message: string) => safely(log, `${label}: ${message}`)
  const rejections = rejectionMode()

  const queue = new EventQueue(settings.maxQueue)
  let closed = false
  // Logged once each until a batch is delivered, not once per occurrence: a monitor that floods
  // the host's log during an outage has become the incident.
  let saidDropped = false
  let saidFailing = false
  let droppedSeen = 0
  // Set by the first uncaught exception that vigil will end the process for.
  let dying = false
  // The error vigil raised again for an unhandled rejection, so the hook it lands in knows.
  let reraised: unknown

  function report(error: unknown, context?: Record<string, unknown>): void {
    if (closed) return
    try {
      queue.add(toWireEvent(error, context, settings.secrets))
      if (queue.dropped > droppedSeen) {
        droppedSeen = queue.dropped
        if (!saidDropped) {
          saidDropped = true
          say(
            `more than ${settings.maxQueue} distinct failures between flushes; the oldest are ` +
              'being dropped. Not logged again until a batch is delivered.',
          )
        }
      }
    } catch (failure) {
      // Rule one: never throw into the host. This runs inside somebody else's error handler.
      safely(log, `${label}: could not queue an error`, failure)
    }
  }

  /** Never rejects. */
  async function flushOnce(): Promise<void> {
    try {
      const events = queue.drain()
      if (events.length === 0) return

      const batch: Batch = { environment: settings.environment, runtime: 'node', events }
      const delivered = await send(
        {
          url: settings.url,
          key: settings.key,
          timeoutMs: settings.timeoutMs,
          ...(settings.fetch === undefined ? {} : { fetch: settings.fetch }),
        },
        batch,
      )

      if (delivered) {
        saidFailing = false
        saidDropped = false
      } else if (!saidFailing) {
        saidFailing = true
        // `send` answers false when only some of a batch's requests were accepted, so this
        // cannot say how many were lost — only that not all of them arrived.
        say(
          `could not report every event to ${settings.url}: a batch of ${events.length} was not ` +
            'fully accepted. Not logged again until a batch is delivered.',
        )
      }
      // Deliberately not requeued. A vigil outage would otherwise turn the queue into a growing
      // retry buffer in the host's heap, which is the one thing §8 forbids it to become.
    } catch (failure) {
      safely(log, `${label}: could not flush`, failure)
    }
  }

  // One flush at a time. A burst of unhandled rejections each asking for a flush becomes one
  // request in flight and one waiting, which drains everything queued by the time it starts.
  let tail: Promise<void> = Promise.resolve()
  let waiting: Promise<void> | undefined
  function flush(): Promise<void> {
    if (waiting !== undefined) return waiting
    const run = tail.then(() => {
      waiting = undefined
      return flushOnce()
    })
    waiting = run
    tail = run
    return run
  }

  /**
   * Flushes until the queue is empty or `ms` has passed. The clock is left referenced: it is what
   * guarantees the exit, so it must not depend on something else holding the event loop open.
   * Today the transport's own timeout does, while a request is pending; unreferenced, this clock
   * would fail the day that changed, and a crashed process with nothing else pending would fall
   * off the end of its event loop and exit 0.
   */
  async function flushWithin(ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let expired = false
    const deadline = new Promise<void>((resolve) => {
      try {
        timer = setTimeout(resolve, ms)
      } catch {
        resolve()
      }
    }).then(() => {
      expired = true
    })
    try {
      do {
        await Promise.race([flushOnce(), deadline])
      } while (!expired && queue.size() > 0)
    } finally {
      clearTimeout(timer)
    }
  }

  const othersOn = (event: 'uncaughtException' | 'unhandledRejection', ours: unknown) =>
    process.listeners(event).some((listener) => listener !== ours)

  async function onUncaught(error: unknown, origin?: unknown): Promise<void> {
    try {
      const fromRejection = error === reraised || origin === 'unhandledRejection'
      report(error, fromRejection ? { fatal: true, unhandledRejection: true } : { fatal: true })
      // The first exception is already flushing everything queued, this one included.
      if (dying) return

      // Adding an `uncaughtException` listener stops Node from exiting. Left there, vigil would
      // turn every crash into a wedged process — a monitor nursing a corrupted process along is
      // worse than the crash it hid. So when Node would have exited, vigil exits for it. When
      // the host has a handler of its own, Node would not have, and the decision stays the
      // host's.
      if (!settings.exitOnUncaught || othersOn('uncaughtException', onUncaught)) {
        await flush()
        return
      }

      dying = true
      // A hung vigil must not stop a crashed process from exiting, so the flush races a clock.
      await flushWithin(settings.fatalFlushMs)
      await printAsNodeWould(error)
    } catch {
      /* a failure here must not replace the crash the host is already having */
    }

    if (dying) {
      try {
        process.exit(1)
      } catch {
        /* a host that has replaced process.exit with something that throws */
      }
    }
  }

  // Synchronous on purpose: raising a rejection again has to happen inside the listener.
  function onRejection(reason: unknown): Promise<void> | undefined {
    // `strict` raises the rejection as an uncaught exception before emitting this; vigil has
    // already reported it from there.
    if (rejections === 'strict') return undefined

    const hostHandles = othersOn('unhandledRejection', onRejection)
    if (rejections === 'throw' && !hostHandles) {
      // Node's default crashes on an unhandled rejection unless an `unhandledRejection` listener
      // exists, and vigil's is one. So vigil raises it as Node would have; it reaches the
      // uncaught-exception hook — the host's and vigil's — and is reported once, from there.
      reraised = isErrorLike(reason) ? reason : unhandledRejectionError(reason)
      throw reraised
    }

    report(reason, { unhandledRejection: true })
    if (rejections === 'warn-with-error-code' && !hostHandles) {
      // What Node does for an unhandled rejection in this mode, which vigil's listener stopped.
      process.exitCode = 1
    }
    return flush()
  }

  let timer: ReturnType<typeof setInterval> | undefined
  try {
    timer = setInterval(() => {
      try {
        void flush()
      } catch {
        /* a timer callback that throws is an uncaught exception in the host */
      }
    }, settings.flushIntervalMs)
    // A five-second timer that keeps a finished script running is the monitor changing how the
    // host behaves. `unref` is what keeps `node script.js` exiting when the script is done.
    timer.unref()

    process.on('uncaughtException', onUncaught)
    process.on('unhandledRejection', onRejection)
  } catch (failure) {
    clearInterval(timer)
    process.off('uncaughtException', onUncaught)
    process.off('unhandledRejection', onRejection)
    throw failure
  }

  const vigil: Vigil = {
    captureError: report,
    flush,
    async close(): Promise<void> {
      if (closed) return
      closed = true
      if (active === vigil) active = undefined
      clearInterval(timer)
      process.off('uncaughtException', onUncaught)
      process.off('unhandledRejection', onRejection)
      await flush()
    },
  }
  active = vigil
  return vigil
}
