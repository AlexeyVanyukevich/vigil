# Backlog

What is known to be wrong today and not yet fixed. Newest first. Fixing an entry deletes it, in the
same commit as the fix. See `node_modules/dev-kit/rules/backlog.md`.

## A boxed string reaches the wire one character per key, past secret matching

- Where: `client/src/redact.ts`, `redact`, the object branch of `walk`
- Found: 2026-09-30, reviewing the client package's redaction
- Problem: a `String` object is walked like any object, so `Object.keys` yields one key per
  character. `redact({ k: new String('bk_live_secret') }, ['bk_live_secret'])` returns
  `{"k":{"0":"b","1":"k",…,"13":"t"}}`: no single value contains the secret, so none is redacted.
- Impact: a configured secret held in a `String` object crosses the wire, spelled out.

## Common credential keys and URL credentials are not recognised

- Where: `client/src/redact.ts`, `ALWAYS_REDACTED` and `scrubCredentials`
- Found: 2026-09-30, reviewing the client package's redaction
- Problem: `session`, `credentials`, `privateKey` and a bare `key` are not in the list, and a
  password inside a URL is not scrubbed. `redact({ session: 'abc', credentials: 'u:p', privateKey:
'pk', key: 'k1', url: 'https://user:pass@db.example/' })` returns every value unchanged.
- Impact: a session id, a private key or a database password in a connection string reaches vigil
  unless the owner has configured that exact value as a secret.

## A configured secret is missed once it is URL-encoded or JSON-escaped

- Where: `client/src/redact.ts`, `redact`'s `scrub`; `client/src/payload.ts`, `scrubString`
- Found: 2026-09-30, reviewing the client package's redaction
- Problem: secrets are matched verbatim. With `bk/live+secret` configured,
  `?k=bk%2Flive%2Bsecret` passes unchanged; with `bk"live` configured, the text
  `{"k":"bk\"live"}` passes unchanged.
- Impact: a secret containing `/`, `+`, `=`, `"` or `\` escapes whenever it appears in a query
  string or in serialised JSON — both ordinary places for a key to be found in an error.

## A `toJSON` result can carry `constructor.prototype`, and the server refuses the batch

- Where: `client/src/redact.ts`, `walk`, where it follows `toJSON`
- Found: 2026-09-30, reviewing the client package's redaction
- Problem: the result of `toJSON` is walked with the constructor flag cleared, so a `prototype`
  key in it is kept even when the object sat under a `constructor` key.
  `redact({ body: { constructor: { toJSON: () => ({ prototype: { admin: true } }) } } })` returns
  `{"body":{"constructor":{"prototype":{"admin":true}}}}`, which Fastify refuses with a 400.
- Impact: one such value in one event loses the whole batch, up to 99 other events with it.

## A value referenced twice comes out as `'[circular]'` the second time

- Where: `client/src/redact.ts`, `walk`, the `seen` set
- Found: 2026-09-30, reviewing the client package's redaction
- Problem: `seen` records every object visited, not only the ancestors of the current one.
  `const shared = { a: 1 }; redact({ p: shared, q: shared })` returns `{"p":{"a":1},"q":"[circular]"}`.
- Impact: the dashboard shows a cycle where there is none, and the second copy of the data is lost.
  Tracking ancestors instead needs the object budget to bound the extra work.

## An explicit fingerprint past a context's hundredth key is lost

- Where: `client/src/payload.ts`, `splitContext`; `client/src/redact.ts`, `MAX_ENTRIES`
- Found: 2026-09-30, reviewing the client package's redaction
- Problem: the fingerprint is read from the redacted context, and redaction keeps only the first
  100 keys. A context of 100 keys and then `vigilFingerprint: 'checkout'` produces an event with no
  fingerprint.
- Impact: the event is grouped by its stack instead of the owner's explicit fingerprint, silently.
  Reading `vigilFingerprint` before redacting, with the same guards, would fix it.

## A very short configured secret redacts ordinary text

- Where: `client/src/payload.ts`, `scrubString`; `client/src/redact.ts`, `redact`'s `scrub`
- Found: 2026-09-30, reviewing the client package's redaction
- Problem: a secret is matched as a substring however short it is. With `1` configured, a stack
  frame's `/srv/app/src/pay.js:14:30` becomes `/srv/app/src/pay.js:[redacted]4:30`, and every context
  string containing a `1` becomes `[redacted]`.
- Impact: a mistyped or placeholder secret wrecks every stack and context the application sends,
  and the frames that grouping reads change with it, splitting issues.

## The session slide stamps `last_seen_at` from the wall clock, and its test flakes on clock skew

- Where: `server/src/modules/auth/session.repository.ts`, `slideSession`; its test in
  `server/tests/integration/auth.test.ts`, "the session slide > moves both after the hour"
- Found: 2026-09-30, running `./run check` at the end of the client package task
- Problem: `slideSession` writes `last_seen_at: new Date()`, Node's clock, not the clock injected
  into `AuthService`. The test seeds `last_seen_at` from the column default, Postgres's `now()`,
  which reads the Docker VM's clock. When that clock runs a few milliseconds ahead of the host, the
  slide writes an earlier time than the seed and the `toBeGreaterThan` fails:
  `expected 1790780303725 to be greater than 1790780303731`. It failed once in `./run check` and once
  in `./run test` in a row, then passed on five straight reruns.
- Impact: an intermittent red gate that has nothing to do with the change being checked. The
  injected clock also does not govern `last_seen_at`, so no test can pin the value the slide writes.

## The client cuts to the server's default caps, not to the caps the server runs with

- Where: `client/src/payload.ts`, `LIMITS`; against `server/src/config.ts`, `MAX_STACK_BYTES`,
  `MAX_CONTEXT_BYTES` and `MAX_EVENTS_PER_BATCH`
- Found: 2026-09-30, building the client's payload builder
- Problem: the client restates the server's defaults (16,384-byte stack, 8,192-byte context, 100
  events per batch) because it may not import from `server/`. The server reads all three from its
  environment. Start the server with `MAX_STACK_BYTES=4096` and report an error whose stack is 8 KB:
  the client sends it as within the cap, and the server refuses it with a 413.
- Impact: an operator who lowers a cap makes every client that sends near the old one lose whole
  batches — each refused event takes up to 99 others with it — and nothing on the client side says
  why. The server's caps would have to reach the client, as configuration or in a response.

## The ingest body limit is safe only while every key is a server key

- Where: `server/src/modules/ingest/ingest.body-limit.ts`, and the rate limit planned for Slice 4
- Found: 2026-09-29, reviewing slice 1's ingest endpoint
- Problem: the limit is derived from the batch caps and comes to about 20 MB. That is fine for server
  keys, held by the monitored applications themselves, because the key is checked before the body
  is read. Slice 4's browser keys are effectively public, and its planned rate limit sits in the
  handler, after the body has been parsed.
- Impact: once browser keys exist, anyone holding a public key can make the server buffer 20 MB per
  request. Slice 4 needs a limit per key kind, or the rate limit moved to `onRequest`.

## A thrown value with a throwing `message` getter, or a thrown `null`, breaks the error handler

- Where: `server/src/shared/errors.ts`, `registerErrorHandler`
- Found: 2026-09-30, reviewing slice 1's self-monitoring
- Problem: the handler passes the error to pino, whose serialiser reads `err.message`, before it sends
  a response. A getter that throws throws there. A thrown `null` makes `error.validation` throw.
- Impact: an unusual thrown value turns into a failure inside the error handler itself, with no
  documented response to the client.

## A malformed percent-escape answers in Fastify's error shape, not the project's

- Where: `server/src/app.ts`, `buildApp`
- Found: 2026-09-29, reviewing slice 1's issues API
- Problem: `GET /api/issues/%E0%A4%A` answers `400 {"error":"Bad Request","code":"FST_ERR_BAD_URL",…}`.
  `rules/http.md` requires framework-level 4xx to be translated into `{ error, message, details? }`.
  Fastify's `frameworkErrors` option is the place to do it.
- Impact: every route answers one class of bad request in a shape clients do not expect.

## Vigil never runs its shutdown hooks in production

- Where: `server/src/server.ts`
- Found: 2026-09-30, reviewing slice 1's self-monitoring
- Problem: there is no SIGTERM or SIGINT handler, so `app.close()` is never called outside tests.
  Every `onClose` hook — including the drain of vigil's own error recordings — is skipped.
- Impact: on every deploy or restart, recordings in flight are lost and connections are dropped
  rather than closed.

## The database pool has no error listener, so a Postgres restart crashes vigil

- Where: `server/src/db/client.ts`, `createDb`
- Found: 2026-09-30, reviewing slice 1's self-monitoring
- Problem: `new pg.Pool(...)` has no `pool.on('error', …)`. When an idle connection fails — as it does
  when Postgres restarts — pg emits `'error'` with no listener, which Node treats as an unhandled
  error and exits.
- Impact: a monitoring service that dies whenever its own database blinks. The failure never reaches
  the self-recorder, because the process is gone.
