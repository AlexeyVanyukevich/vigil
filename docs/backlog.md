# Backlog

What is known to be wrong today and not yet fixed. Newest first. Fixing an entry deletes it, in the
same commit as the fix. See `node_modules/dev-kit/rules/backlog.md`.

## Two installed crash reporters that each exit only when alone keep a crashed process alive

- Where: `client/src/node.ts`, `onUncaught`, `othersOn('uncaughtException', onUncaught)`
- Found: 2026-10-10, in the final review of slice 1
- Problem: vigil ends the process after an uncaught exception only when its listener is the sole
  `uncaughtException` listener, because that is when Node would have exited. Another crash
  reporter that follows the same rule (one widely used error-tracking SDK is said to; not
  checked) defers to vigil while vigil defers to it, and neither exits. Reproduced with a stand-in
  for the other reporter: `install()` vigil, add
  `process.on('uncaughtException', () => { if (process.listenerCount('uncaughtException') === 1) process.exit(1) })`,
  then `setTimeout(() => { throw new Error('x') })`. Node alone exits 1. With both, a script exits
  0, and with an interval holding the event loop open, as a server's does, the process was still
  running three seconds after the crash.
- Impact: an application running vigil beside another such reporter carries on after a crash, so
  its supervisor never restarts it, and a script's crash reads as success. The design record
  chose vigil instead of a hosted error tracker for these applications, so co-installation is
  outside the design, which is why the rule was kept. Telling another reporter's listener from the
  host's own would need that reporter's internals.

## The list and the detail never refresh while the tab keeps focus

- Where: `web/src/main.tsx`, the `QueryClient`'s `defaultOptions.queries`
- Found: 2026-10-10, in the final review of slice 1
- Problem: queries set `staleTime` and `refetchOnWindowFocus` but no `refetchInterval`. Open the
  issues list on a screen and leave it focused: new issues and new counts never appear, while
  `useNow` keeps advancing the "ago" labels beside the stale counts.
- Impact: a dashboard left open answers "is it still happening" with a frozen snapshot that looks
  live. A `refetchInterval` of about 30 seconds on the list and the detail would fix it.

## A client clock set in the future pins `last_seen_at` there

- Where: `server/src/modules/ingest/ingest.service.ts`, where `occurred_at` becomes `occurredAt` and
  feeds `greatest(last_seen_at, …)`; `web/src/format.ts`, `relativeTime`, where a negative age
  reads "just now"
- Found: 2026-10-10, in the final review of slice 1
- Problem: `occurred_at` is taken from the client unclamped. Send one event dated a year ahead:
  `greatest()` keeps that time as `last_seen_at` from then on, and the dashboard shows the issue as
  "last seen just now" until the date passes, however long ago it actually stopped.
- Impact: low while every key is a server key on one host, whose clocks agree; certain once
  browser keys arrive in Slice 4, since browser clocks are often wrong. Clamp to `received_at`
  plus a small skew for the issue's timestamps, keeping the raw value on the event. Take it into
  Slice 4.

## The session's sliding expiry never reaches the browser

- Where: `server/src/modules/auth/auth.routes.ts`, the login handler, the only place that sets the
  cookie; `server/src/modules/auth/auth.service.ts`, `resolve`, which slides `expires_at`
- Found: 2026-10-10, in the final review of slice 1
- Problem: the cookie's `Max-Age` is set once, at sign-in. `resolve` moves the session's expiry
  forward on the server at most hourly, but never re-issues the cookie. So the browser drops the
  cookie `SESSION_TTL_DAYS` after sign-in, however active the owner has been, and the slide has no
  visible effect.
- Impact: the owner is signed out every 30 days regardless of use, where the design record asks
  for a sliding session. Setting the cookie again whenever the slide happens would fix it.

## A failed migration loses its cause, and `./run` prints npm's raw error

- Where: `server/src/db/migrate.ts`, `runMigrations`; `run`, `run_migrations`
- Found: 2026-10-10, in the final review of slice 1
- Problem: `runMigrations` throws `Migration "x" failed` on the first errored result, before it
  reaches `if (error) throw error`, so the SQL or connection error that made it fail is thrown
  away. `run_migrations` then has no `die` wrapper, unlike `start_db` and `need_setup`, so the owner
  sees npm's stack trace with neither the cause nor an instruction.
- Impact: a migration that fails on a real database says only which migration, never why.
  Throwing with `{ cause: error }` (or throwing `error` first) and wrapping `run_migrations` in a
  `die` would cover both.

## A framework 4xx with a code of its own answers `bad_request`

- Where: `server/src/shared/errors.ts`, `registerErrorHandler`, the branch that answers any other
  4xx as `bad_request`; `web/src/routes/Login.tsx`, `submit`, and `web/src/errors.ts`, `COPY`
- Found: 2026-10-01, building the login screen (the 429); 2026-10-10, in the final review of
  slice 1 (the 413)
- Problem: two framework errors have a code in `rules/http.md` and get `bad_request` instead.
  After `LOGIN_ATTEMPTS_PER_MINUTE` failures (10 by default), `POST /api/login` answers 429 with
  `{"error":"bad_request","message":"Rate limit exceeded, retry in 1 minute"}`, and the login
  screen shows "The server refused that request." A body over the route's limit
  (`FST_ERR_CTP_BODY_TOO_LARGE`) answers 413 with `bad_request` where the rule names
  `payload_too_large`. Fail ten sign-ins in a minute, then try the right password; or post an
  ingest batch over the body limit.
- Impact: the owner who mistypes a few times is told the server refused them, with no hint that
  waiting a minute fixes it. A client reading `error` cannot tell an oversize body from any other
  refusal. A small status-to-code map in the handler (413 to `payload_too_large`, 429 to a new
  `rate_limited`) and a `COPY` line for `rate_limited` would close both. The malformed
  percent-escape entry below is the third framework 4xx in the wrong shape, fixed elsewhere
  (Fastify's `frameworkErrors`).

## Two unit test files keep their cases in test bodies, not datasets

- Where: `server/tests/unit/config.test.ts`, every case but the `TRUST_PROXY` table;
  `server/tests/unit/bytes.test.ts`, `byteLength` and `guardBytes`
- Found: 2026-10-10, in the final review of slice 1
- Problem: `rules/testing.md` puts cases in typed tables read by a parameterised runner. Here the
  bad positive integers are inlined two to an `it`, and `byteLength` packs three inputs into one
  `it` with inline assertions.
- Impact: small. Adding a case means copying an assertion rather than adding a row, and a failure
  in a packed `it` hides the cases after it.

## npm warns that five packages' install scripts are not covered by `allowScripts`

- Where: `package.json`, which has no `allowScripts`; seen on `npm install` in a fresh clone
- Found: 2026-10-10, in the final review of slice 1
- Problem: every fresh install warns that the install scripts of `esbuild`, `fsevents`,
  `cpu-features`, `protobufjs` and `ssh2` are "not yet covered by allowScripts". Nothing fails
  today.
- Impact: like the advisory below, a warning on every install trains a reader to ignore the next
  one, and an npm that enforces the setting could stop `esbuild`, and with it Vite, from
  installing. Listing the five, or deciding which to refuse, would end it.

## `./run test:ui` empties the dashboard of a running `./run start`

- Where: `tests/ui/global-setup.ts`, `run('npm', ['run', 'build'])`; `web/vite.config.ts`,
  `emptyOutDir: true` into `server/public`
- Found: 2026-10-10, in the final review of slice 1
- Problem: the journeys build the product into the same `server/public/` that `./run start` serves
  from, and Vite empties that directory before writing. Start `./run start`, run `./run test:ui`
  beside it: while the build runs, the running server's files are gone from under it, and if the
  build fails they stay gone. Reasoned from the build configuration; not reproduced.
- Impact: a developer who keeps the product running while running the journeys sees it break, for
  a reason that has nothing to do with their change. Building the journeys into a directory of
  their own would separate them.

## A crash is printed only after vigil's flush

- Where: `client/src/node.ts`, `onUncaught`, `await flushWithin(...)` before
  `await printAsNodeWould(error)`
- Found: 2026-10-10, in the final review of slice 1
- Problem: when vigil ends the process, it flushes first (for up to `fatalFlushMs`, default 1,000)
  and prints the error afterwards. A supervisor that kills the process within that window, or a
  hang in the flush the timeout does not cover, leaves no stack in the host's own logs.
- Impact: the one copy of the crash an operator reads without vigil — stderr — can be lost exactly
  when vigil is unreachable. Printing first and then flushing costs nothing.

## A long message changes how many frames vigil keeps of its own stack, splitting its issues

- Where: `server/src/self/record.ts`, `fitStack`
- Found: 2026-10-10, in the final review of slice 1
- Problem: the stack is cut at the last whole line that fits, and a stack begins with its message.
  A long message uses up the budget the frames need, so one throw site keeps five frames, one to
  four, or none, depending on the length of that occurrence's message. The fingerprint reads the
  top five frames, so each length band becomes a separate issue, and with no frames left the
  culprit is lost too.
- Impact: one of vigil's own failures with a variable message shows as several issues under
  `vigil`. The client already cuts the header first and keeps frames (`fitStack` in
  `client/src/payload.ts`); porting that here would fix it.

## The culprit follows the latest event under an explicit fingerprint

- Where: `server/src/modules/ingest/ingest.service.ts`, `recordOne`, `update.culprit = culprit`
- Found: 2026-10-10, in the final review of slice 1
- Problem: every event with a stack overwrites the issue's `culprit`. Under a computed fingerprint
  that is harmless, since one issue means one set of frames. Under an explicit fingerprint,
  different stacks share an issue, and "where in the code" flips to whichever arrived last.
- Impact: the issue detail names a different place in the code from one refresh to the next, for
  exactly the issues the owner grouped on purpose. Keeping the first culprit, or the most frequent,
  would make it stable.

## Six check constraints are never shown to refuse anything

- Where: `server/src/db/migrations/001_initial.ts`; `server/tests/integration/migrations.test.ts`
- Found: 2026-10-10, in the final review of slice 1
- Problem: `apps_slug_is_a_slug`, `apps_name_not_blank`, `issues_environment_not_blank`,
  `issues_runtime_known`, `events_count_positive` and `ingest_keys_digest_is_sha256` have no test
  that inserts a violating row. Only `issues_status_known` has one.
- Impact: a later migration could loosen a regex or drop a constraint and every suite would stay
  green. One dataset of violating rows, each expecting a `23514` refusal, would pin all six.

## An uncaught exception in vigil itself is not recorded, and ends the process

- Where: `server/src/server.ts`, which adds no `uncaughtException` or `unhandledRejection`
  listener; `server/src/self/record.ts`, called only from the error handler in
  `server/src/shared/errors.ts`
- Found: 2026-10-10, in the final review of slice 1
- Problem: the self-recorder hears only of failures a request's error handler catches. A throw
  from a timer or an event listener, or a rejected promise nobody awaits, outside any request,
  reaches Node's default handling: the stack is printed to stderr and the process exits with
  code 1. Nothing is written under the `vigil` application. Add
  `setTimeout(() => { throw new Error('boom') }, 1000)` to `server.ts` and run `./run start`: the
  process exits, and once vigil is started again the dashboard shows no such issue. Reasoned from Node's
  default behaviour; not reproduced.
- Impact: the monitor goes down without a trace in its own dashboard, and `./run start` has no
  supervisor to bring it back, so every monitored application's batches fail until someone
  notices. A listener that records the failure under a short deadline before exiting, and a
  supervisor in the deployment, would cover it.

## `npm install` reports a high-severity advisory in a build-time dependency

- Where: `package-lock.json`, `source-map-js@1.2.1`, pulled in by `web/`'s `vite` (through
  `postcss`) and `jsdom` (through `css-tree`)
- Found: 2026-10-10, running `./run` in a fresh clone for the slice's documentation task
- Problem: every fresh install ends "1 high severity vulnerability". `npm audit` names
  GHSA-68fv-2mgg-jv7q: `source-map-js` 1.0.0–1.2.1 can be made to spin the event loop by a
  crafted source map's section offsets. `npm audit fix` is offered and has not been tried.
- Impact: small. The package runs only while building or testing the dashboard, on source maps the
  project produces itself, and none of it reaches `server/public/` or the client package. The cost
  today is a warning on every install that trains a reader to ignore the next one.

## An ingest key cannot be revoked except in SQL

- Where: `server/scripts/issue-key.ts`, which ends "revoke the old one when you do"; `run`, which
  has `key:issue` and nothing to revoke; `server/src/modules/ingest/key.repository.ts`,
  `findLiveKey`, which honours `revoked_at`
- Found: 2026-10-09, writing `docs/architecture.md`
- Problem: nothing in the code ever sets `ingest_keys.revoked_at`. Issue a second key for an
  application and try to retire the first: the only way is
  `update ingest_keys set revoked_at = now() where …` in `psql`, picking the row by `created_at`,
  since only the digest is stored. The rotation the key table exists for has no tool.
- Impact: a leaked key stays live until the owner writes SQL against the production database, and
  the command that issues keys tells them to do something no command does. A `./run key:revoke`
  (listing keys by app, `created_at` and `last_used_at`, revoking one by id) would close it.

## The culprit names Node's internals when a dependency throws from a timer

- Where: `server/src/shared/fingerprint.ts`, `fingerprintOf`, `own = frames.filter(!vendor)`
- Found: 2026-10-06, writing the browser journeys
- Problem: only `node_modules` frames count as vendor, so `node:internal/...` frames count as the
  owner's own. An error thrown wholly inside a dependency called from a timer — frames
  `/app/node_modules/x/index.js`, then `listOnTimeout (node:internal/timers:588:17)` — gets the
  culprit `listOnTimeout (node:internal/timers)` rather than the dependency's frame the comment
  promises. The same frames are part of the fingerprint, so one throw site reached from a timer
  and from a promise job becomes two issues.
- Impact: the issues list shows a Node internal as "where in the code" for exactly the errors the
  owner most needs pointing at a dependency. Treating `node:` frames as vendor (or skipping them)
  would fix both; the fingerprint change would split existing issues once.

## `./run test:ui` assumes Playwright's browsers are installed

- Where: `run`, `scenario_test_ui`; `tests/ui/session.spec.ts`, which launches the full
  `chromium` channel for the Back journey
- Found: 2026-10-06, first run of the browser journeys
- Problem: nothing installs the browser builds the pinned `@playwright/test` needs. On a machine
  that has another version's, every journey fails with "Executable doesn't exist at
  …/chromium_headless_shell-1243/…" until `npx playwright install chromium` is run. The README
  says so since 2026-10-09; `./run test:ui` itself still does not.
- Impact: a fresh checkout, or any Playwright upgrade, gets a red `test:ui` that reads as a broken
  suite unless its reader has the README open. A `need_playwright` check in `run` would say what
  to do at the moment it matters.

## The journeys' Postgres container sometimes fails to start

- Where: `tests/ui/global-setup.ts`, `new PostgreSqlContainer(...).start()`; the same harness as
  `server/tests/integration/global-setup.ts`
- Found: 2026-10-06, running the browser journeys repeatedly
- Problem: once in about fifteen runs started back to back, Testcontainers' reaper failed with
  "Timed out after 10000ms while waiting for container ports to be bound to the host" and the
  run ended before any journey. The next run passed. Not reproduced on demand.
- Impact: an occasional red `./run test:ui` that says nothing about the code. If it recurs, raise
  Testcontainers' startup timeout or reuse the reaper (`TESTCONTAINERS_RYUK_DISABLED` is the
  blunt alternative and leaves containers behind on a crash).

## Signing out clears the cache while the list is still mounted

- Where: `web/src/session.ts`, `signOut`, called from `web/src/routes/Issues.tsx`, `SignOut`
- Found: 2026-10-02, reviewing the issues list
- Problem: `signOut` calls `client.clear()` and then navigates. Between the two, the Issues screen
  is still mounted; its queries lose their data and may refetch. The server has just ended the
  session, so each refetch answers 401, and `SignInAgain` navigates to `/login` again on top of the
  navigation already under way. `App.tsx` avoids exactly this on the 401 path by leaving the clear
  to the login screen, but explicit sign-out does not.
- Impact: believed harmless — every path ends on `/login` with an empty cache — but unverified in
  a browser: possible extra 401s in the network log and a redundant navigation. Clearing in `Login`
  alone (which already happens on mount) would make the clear in `signOut` unnecessary, though
  `tests/session.test.ts` asserts the cache is empty at the moment of navigating.

## Occurrence times are unlabelled and in the browser's time zone

- Where: `web/src/routes/IssueDetail.tsx`, "Recent occurrences", `toLocaleString('en-GB')`
- Found: 2026-10-02, reviewing the issue detail screen
- Problem: each occurrence shows a bare `07/09/2026, 12:00:00` in whatever zone the browser is set
  to, with no zone named. Open the same issue from a laptop on another zone, or compare with a
  server log in UTC: the times differ, and nothing on the screen says which zone either is.
- Impact: matching an occurrence to a log line means guessing the offset. Showing the zone (or
  UTC, with a tooltip) would remove the guess.

## A link to an issue loses its destination at the sign-in screen

- Where: `web/src/App.tsx`, `RequireSession` (`<Navigate to="/login" replace />`), and
  `web/src/routes/Login.tsx`, `submit` (`navigate('/')`)
- Found: 2026-10-02, reviewing the issue detail screen
- Problem: open `/issues/<id>` without a session: the dashboard goes to `/login`, and after signing
  in lands on `/`, not on the issue. Nothing carries the original address through sign-in. Spec §11
  wants notification deep links to land on the issue or monitor detail, "one tap from the evidence".
- Impact: none yet — there are no notifications until the alerting slice. That slice must add a
  return-to (a `from` in the navigation state or a query parameter, accepted only as a same-origin
  path) or every alert link opens the issues list instead of the issue.

## The environment filter only offers environments seen in the latest 200 issues

- Where: `web/src/routes/Issues.tsx`, the `seen` query and `ENVIRONMENT_SAMPLE`; `web/src/issues.ts`,
  `environmentsOf`
- Found: 2026-10-02, reviewing the issues list
- Problem: there is no endpoint listing environments, so the control's options come from a second
  `GET /api/issues?limit=200` (the API's maximum) across every status. An environment whose issues
  are all older than the 200 most recently seen is not offered. Report one error from `staging`,
  then 200 distinct errors from `production`: `staging` is no longer in the control.
- Impact: small at one host's scale, but the filter silently hides an environment rather than
  saying it cannot list them all, and the sample costs a 200-row request on every change of
  application. A `GET /api/environments` (distinct over `issues`) would answer it exactly.

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
  warning line behaves differently once vigil is installed. Exit codes match Node's in every mode
  except under `--abort-on-uncaught-exception`, where Node aborts and vigil exits 1.

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
