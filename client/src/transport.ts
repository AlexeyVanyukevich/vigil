import { LIMITS, type WireEvent } from './payload.js'

export interface Batch {
  environment: string
  runtime: 'node'
  events: WireEvent[]
}

export interface TransportOptions {
  /** Vigil's base URL. The path is this module's business, not the caller's. */
  url: string
  key: string
  /** The most the whole `send` may take, however many requests the batch needs. */
  timeoutMs: number
  /** Injected in tests; the global otherwise. */
  fetch?: typeof globalThis.fetch
}

/** The longest delay `setTimeout` takes as given. Past it, Node warns and fires in 1 ms. */
const MAX_TIMER_MS = 2_147_483_647

/**
 * `timeoutMs` as a delay Node will neither shorten nor warn about. Node prints a warning on the
 * host's stderr for a NaN, negative or oversized delay. Written so that whatever an untyped
 * caller passes — `undefined`, a string — which is not a number of at least 1 becomes 1.
 */
function delay(timeoutMs: number): number {
  if (!(timeoutMs >= 1)) return 1
  return Math.min(timeoutMs, MAX_TIMER_MS)
}

/**
 * Only the fields the server's schema names, at both levels. The schema sets
 * `additionalProperties: false` on the batch and on each event, so one stray field — passed
 * through a variable, where TypeScript does not look for extras — loses the whole batch.
 */
function envelope(environment: string, events: readonly WireEvent[]): Batch {
  return {
    environment,
    runtime: 'node',
    events: events.map((event) => ({
      type: event.type,
      message: event.message,
      ...(event.stack === undefined ? {} : { stack: event.stack }),
      occurred_at: event.occurred_at,
      ...(event.context === undefined ? {} : { context: event.context }),
      ...(event.count === undefined ? {} : { count: event.count }),
      ...(event.fingerprint === undefined ? {} : { fingerprint: event.fingerprint }),
    })),
  }
}

/**
 * Whether the answer was a 2xx. Read by shape rather than `instanceof Response`, so a fetch
 * from another realm or package still counts; anything without an integer status is a failure.
 * The body is discarded unread — the status is the whole answer — so the connection is released.
 * Total: a response that throws when read is a failure, not an exception.
 */
function accepted(response: unknown): boolean {
  try {
    if (typeof response !== 'object' || response === null) return false
    const { status, body } = response as { status?: unknown; body?: unknown }
    if (typeof body === 'object' && body !== null && 'cancel' in body) {
      const cancel = (body as { cancel: unknown }).cancel
      if (typeof cancel === 'function') {
        Promise.resolve(cancel.call(body)).catch(() => {})
      }
    }
    return typeof status === 'number' && Number.isInteger(status) && status >= 200 && status < 300
  } catch {
    return false
  }
}

/**
 * One request, as a promise that settles `true` or `false` and never rejects — so the one that
 * loses the race with the timeout leaves no unhandled rejection behind, which Node's default
 * treats as fatal.
 */
function post(
  fetchImpl: typeof globalThis.fetch,
  endpoint: string,
  key: string,
  body: Batch,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  return new Promise<Response>((resolve) => {
    // Inside the executor, so a fetch that throws rather than returning a promise, or a body that
    // will not serialise, becomes a rejection like any other.
    resolve(
      fetchImpl(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      }),
    )
  }).then(accepted, () => false)
}

async function deliver(options: TransportOptions, batch: Batch): Promise<boolean> {
  const events = batch.events
  if (events.length === 0) return true

  const fetchImpl = options.fetch ?? globalThis.fetch
  const endpoint = `${options.url.replace(/\/+$/, '')}/ingest/events`

  // Some runtimes an application runs on have no AbortController. The timeout below is a race,
  // so it holds without one; the abort only lets a real fetch close its socket early.
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined

  // One clock for the whole send, not one per request: a hung vigil costs `timeoutMs` once, not
  // once per batch. Cleared on the way out, because a pending timer keeps an idle process alive.
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      resolve('timeout')
      // A timer callback that throws is an uncaught exception in the host. An `abort()` can throw,
      // itself or through a listener a polyfill calls synchronously.
      try {
        controller?.abort()
      } catch {
        /* the send is already over; nothing is owed to anyone */
      }
    }, delay(options.timeoutMs))
  })
  // Handled from the start: if `setTimeout` throws, this rejects, and something below may throw
  // before anything races it.
  timedOut.catch(() => {})

  try {
    let allAccepted = true
    // The server refuses a batch over its cap outright, and every event in it with it.
    for (let start = 0; start < events.length; start += LIMITS.eventsPerBatch) {
      const chunk = envelope(batch.environment, events.slice(start, start + LIMITS.eventsPerBatch))
      const outcome = await Promise.race([
        post(fetchImpl, endpoint, options.key, chunk, controller?.signal),
        timedOut,
      ])
      if (outcome === 'timeout') return false
      // A refused batch does not stop the rest: each is judged by the server on its own.
      allAccepted &&= outcome
    }
    return allAccepted
  } finally {
    clearTimeout(timer)
  }
}

/**
 * True when vigil accepted every event, false for every other outcome. **Never rejects** — rule
 * one of §8. This runs inside somebody else's error handler, and a transport failure that
 * propagates would mean the monitor is the thing that broke the request.
 */
export async function send(options: TransportOptions, batch: Batch): Promise<boolean> {
  try {
    return await deliver(options, batch)
  } catch {
    // Nothing in `deliver` should reach here — hostile options, say. The host still hears nothing.
    return false
  }
}
