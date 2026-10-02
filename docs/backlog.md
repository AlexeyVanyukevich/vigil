# Backlog

What is known to be wrong today and not yet fixed. Newest first. Fixing an entry deletes it, in the
same commit as the fix. See `node_modules/dev-kit/rules/backlog.md`.

## A rate-limited sign-in says "The server refused that request."

- Where: `web/src/routes/Login.tsx`, `submit`, and `web/src/errors.ts`, `COPY`; the server side is
  `server/src/shared/errors.ts`, which answers any 4xx that is not an `AppError` as `bad_request`
- Found: 2026-10-01, building the login screen
- Problem: after `LOGIN_ATTEMPTS_PER_MINUTE` failures (10 by default), `POST /api/login` answers
  429 with `{"error":"bad_request","message":"Rate limit exceeded, retry in 1 minute"}`. The 429
  carries no code of its own, so the screen looks up `bad_request` and shows "The server refused
  that request." Fail ten sign-ins in a minute, then try the right password.
- Impact: the owner who mistypes a few times is told the server refused them, with no hint that
  waiting a minute fixes it, and may well conclude the server is broken. The server needs a
  `rate_limited` code (from the rate limiter's `errorResponseBuilder`) and `COPY` a line for it.

## The dev proxy sends `/api` to port 4100 whatever `PORT` says

- Where: `web/vite.config.ts`, `server.proxy['/api'].target`
- Found: 2026-10-01, building the dashboard workspace
- Problem: `./run dev` starts the server on `$PORT`, which `.env` may set, but the proxy target is
  the literal `http://localhost:4100`. Set `PORT=4200` and run `./run dev`: the dashboard on
  `$WEB_PORT` loads, and every `/api` call fails because nothing listens on 4100. Vite's proxy
  answers each one with a `502` and a plain-text body, which the dashboard reads as the server
  being unreachable: "Cannot reach the server. Check your connection." (Before 502 was mapped to
  `offline`, the same mistake showed "Something went wrong. Try again.")
- Impact: only a developer who moves the API port, and the symptom says the server is down while
  it is running on the port it was told to use, which does not point at the proxy. Reading the
  target from the environment in the Vite config (Vite's `loadEnv` with an empty prefix) would keep
  the two in step.

## `./run dev` stops whatever started it, not only its own two processes

- Where: `run`, `scenario_dev`, `trap 'kill 0' EXIT INT TERM`
- Found: 2026-10-01, adding the dashboard to `./run dev`
- Problem: `kill 0` signals the whole process group. A terminal gives `./run dev` a group of its
  own, so there it stops just the server and Vite. Started by a non-interactive parent — a
  Makefile, an `npm run` script, an editor task — the script shares the parent's group, and the
  parent is killed too. Seen: a `bash -c` wrapper that started `./run dev` and then stopped it
  exited 143 before its next line ran.
- Impact: a wrapper around `./run dev` cannot do anything after the stack stops. Signalling the
  two recorded child PIDs (and their children) instead of the group would avoid it.

## What a script captures just before it ends normally is never sent

- Where: `client/src/node.ts`, `install`; the flush timer is unreferenced and nothing flushes on
  the way out
- Found: 2026-10-01, building the client's node entry point. A shortcut taken on purpose.
- Problem: the periodic flush must not keep a finished script alive, so it is `unref`'d. A script
  that calls `captureError` and then finishes, or a host that calls `process.exit(0)`, ends with the
  event still queued. Install, `captureError(new Error('x'))`, let the script end: nothing arrives.
  Only an uncaught exception flushes on the way out.
- Impact: short-lived jobs — cron scripts, migrations, CLI tools — report nothing they handled
  themselves. A `beforeExit` listener that flushes when the queue is not empty would cover the
  natural end without keeping an idle process alive; `process.exit` cannot wait for a request.

## The fatal path imitates Node's default rather than handing back to it

- Where: `client/src/node.ts`, `onUncaught`, `onRejection` and `printAsNodeWould`
- Found: 2026-10-01, building the client's node entry point
- Problem: once vigil's listener exists, Node's own fatal handling never runs, so vigil re-creates
  it, and four details differ. The printed error has no source-line arrow above it (Node's is
  internal). With `--abort-on-uncaught-exception`, Node aborts with a core dump; with vigil installed
  it exits 1. A rejection vigil raises again reaches the host's `uncaughtException` listeners with
  `origin` `'uncaughtException'`, where Node passes `'unhandledRejection'`. Under
  `--unhandled-rejections=warn-with-error-code`, vigil sets the exit code but does not print Node's
  `UnhandledPromiseRejectionWarning` line.
- Impact: small. A host that reads `origin`, relies on the core dump, or greps its logs for the
  warning line behaves differently once vigil is installed. Exit codes match Node's in every mode.

## A collapsed run stops counting at 1,000,000 until the next flush

- Where: `client/src/queue.ts`, `EventQueue.add`
- Found: 2026-09-30, building the client's queue. A shortcut taken on purpose.
- Problem: the server's schema refuses a `count` over 1,000,000, and with it the whole batch, so a
  run is held at the cap. Throw one error 1,200,000 times between two flushes and one event with
  `count: 1000000` is sent; the other 200,000 are not counted anywhere, not even in `dropped`.
- Impact: the dashboard undercounts only the hottest loops, and never says it did. Starting a
  second event for the same failure once the first is full would keep the count honest.

## A sensitive header line that already holds a `[redacted]` is skipped, and the rest is sent

- Where: `client/src/redact.ts`, `CREDENTIAL_LINE`, the lookahead `(?!["']?\[redacted\])`
- Found: 2026-09-30, re-reviewing the client package's redaction. A fix was written and deferred
  by the owner; it is described here so it can be restored.
- Problem: `toWireEvent` replaces configured secrets before the header rule runs. With `a`
  configured, the message `{"cookie":"a; csrf=tok_csrf_91x"}` becomes
  `{"cookie":"[redacted]; csrf=tok_csrf_91x"}`, the lookahead sees `"[redacted]` and skips the line,
  and the CSRF token is sent. With a space after the colon the line is cleared instead, so the rule
  is unreliable both ways.
- Impact: whatever follows a configured secret on a cookie or authorization line crosses the wire.
- Fix: delete the lookahead, so a sensitive line is always cleared to its end. Add that exact input
  as a `payload.test.ts` secret row with `absent: ['tok_csrf_91x']` (not `a`: `[redacted]` contains
  an `a`), and expect the thrown-object row to render `{"headers":{"authorization":[redacted]`.

## A folded header's continuation line is not scrubbed

- Where: `client/src/redact.ts`, `CREDENTIAL_LINE`
- Found: 2026-09-30, re-reviewing the client package's redaction
- Problem: the rule clears a sensitive header to the end of its line. Obsolete line folding (RFC 9112
  §5.2) continues a value on the next line after whitespace: `Cookie: a=1\r\n b=SECRET` becomes
  `Cookie: [redacted]\r\n b=SECRET`.
- Impact: the second half of a folded cookie or authorization header is sent. Node rejects folding
  on incoming requests, so it reaches a context mainly through raw text logged from elsewhere.

## A header list printed into a string, or JSON escaped twice, carries its credential out

- Where: `client/src/redact.ts`, `CREDENTIAL_LINE` and the array rule in `walk`
- Found: 2026-09-30, re-reviewing the client package's redaction
- Problem: the array rule works on arrays and the line rule needs a colon after the name. Neither
  sees `[ 'Cookie', 'SECRET' ]`, a `rawHeaders` array printed into a message, nor
  `{\"cookie\":\"SECRET\"}`, JSON serialised inside JSON. Both pass unchanged.
- Impact: an error message that embeds printed headers or doubly serialised JSON sends the cookie.

## A credential in an environment-style assignment is not recognised

- Where: `client/src/redact.ts`, `CREDENTIAL_LINE`
- Found: 2026-09-30, re-reviewing the client package's redaction
- Problem: the line rule requires a colon. `HTTP_COOKIE=SECRET`, the CGI form of the header, passes
  unchanged.
- Impact: an error that prints a CGI environment or a `.env`-style dump sends the cookie.

## A Bearer or Basic credential is scrubbed only up to its first unusual character

- Where: `client/src/redact.ts`, `CREDENTIAL_SCHEME`
- Found: 2026-09-30, re-reviewing the client package's redaction
- Problem: the credential is matched with the RFC 6750 token characters, so the match stops at the
  first character outside them. `Bearer abc:SECRET` becomes `Bearer [redacted]:SECRET`, and
  `Bearer abc%2FSECRET` becomes `Bearer [redacted]%2FSECRET`.
- Impact: a malformed or URL-encoded credential sends everything after its first unusual character.

## A sensitive name past the first 4,096 characters of a key is not seen

- Where: `client/src/redact.ts`, `walk`, `isSensitiveKey(head(key))`
- Found: 2026-09-30, re-reviewing the client package's redaction
- Problem: only the head of a key is checked, to bound the work on huge keys. A key of 5,000 `x`
  followed by `password` is not recognised, and its value is sent: `…":"SECRET"`.
- Impact: small, since such keys are contrived, but the value of one is sent in full.

## Configured secrets that overlap without one containing the other leave a tail

- Where: `client/src/payload.ts`, `scrubString`; `client/src/redact.ts`, `liveSecrets`
- Found: 2026-09-30, re-reviewing the client package's redaction
- Problem: longest-first order fixes a secret contained in another, not two that overlap. With
  `abcXYZ` and `XYZdef` configured, `abcXYZdef` becomes `[redacted]def`.
- Impact: part of the second secret is sent. Replacing the union of all match ranges would fix it.

## `./run` cannot start on a checkout whose `node_modules` predates the kit

- Where: `run`, the bootstrap above `source node_modules/dev-kit/sh/lib.sh`
- Found: 2026-09-30, adopting dev-kit in a sibling project
- Problem: the bootstrap tests `[ -d node_modules ]`, so a checkout that installed its
  dependencies before `dev-kit` became one skips `npm install` and then fails to source a file
  that is not there. dev-kit's README, from 1.2.1, tests for `node_modules/dev-kit/sh/lib.sh`.
- Impact: `./run` dies with "No such file or directory" instead of installing the missing kit,
  on any machine that pulls the adoption onto an existing install.

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

- Where: `client/src/payload.ts`, `LIMITS`, and `client/src/transport.ts`, which splits a batch at
  `LIMITS.eventsPerBatch`; against `server/src/config.ts`, `MAX_STACK_BYTES`, `MAX_CONTEXT_BYTES`
  and `MAX_EVENTS_PER_BATCH`
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
