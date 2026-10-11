# Architecture

What vigil does today. This document is authoritative for that: where it and the design record
disagree, this one is right. The design record,
[`docs/superpowers/specs/2026-09-05-vigil-design.md`](superpowers/specs/2026-09-05-vigil-design.md),
says **why** the system has the shape it does and what the later slices will add; read it for
reasons, never for behaviour. Known defects that were found and not yet fixed are listed in
[`docs/backlog.md`](backlog.md), not here.

Two roles recur below:

- **The owner** — the one person who signs in to the dashboard.
- **A monitored application** — any application on the host that reports to vigil through the
  client package. **The reference application** is the first of them.

Slice 1 of the design's build order is built: errors are recorded end to end, from a Node
application to the dashboard. Alerting, uptime monitoring and browser errors are not built; see
[What is not built yet](#what-is-not-built-yet).

## What runs

One repository, three npm workspaces:

| Directory | What it is                                                                                  |
| --------- | ------------------------------------------------------------------------------------------- |
| `server/` | Fastify, TypeBox, Kysely and Postgres. The dashboard API, the ingest endpoint, and the SPA. |
| `client/` | `@vigil/client`, the package a monitored application installs. One entry point, `/node`.    |
| `web/`    | The React dashboard. Built into `server/public/` and served by the server.                  |

Browser journeys that drive the whole product live in `tests/ui/`, outside the workspaces.

At run time there is **one Node process and one Postgres**. `server/src/server.ts` loads the
configuration, opens the database pool and calls `buildApp` in `server/src/app.ts`, which serves
everything on one port (`PORT`, default 4100):

| Path                    | Credential     | What it does                                                             |
| ----------------------- | -------------- | ------------------------------------------------------------------------ |
| `GET /api/health`       | none           | `{ "status": "ok" }`                                                     |
| `POST /api/login`       | none           | password in, session cookie out; rate-limited                            |
| `POST /api/logout`      | session cookie | ends the session                                                         |
| `GET /api/me`           | session cookie | answers 200 while the session is live                                    |
| `GET /api/apps`         | session cookie | the applications, for the dashboard's filter                             |
| `GET /api/issues`       | session cookie | the issues list; filters `app`, `environment`, `status`; `sort`, `limit` |
| `GET /api/issues/:id`   | session cookie | one issue and its 25 most recent occurrences                             |
| `PATCH /api/issues/:id` | session cookie | sets `status` to `open`, `resolved` or `ignored`                         |
| `POST /ingest/events`   | ingest key     | a batch of up to 100 events from a monitored application                 |
| anything else           | none           | the dashboard's `index.html`, so a client-side route survives a reload   |

The dashboard is served from the same origin as the API, so there is no CORS and the session
cookie needs no cross-site relaxation. In development (`./run dev`) Vite serves the dashboard on
its own port and proxies `/api` to the server (`web/vite.config.ts`), which keeps the browser on
one origin there too.

Postgres 16 runs from `docker-compose.yml` as the service `db`, published on host port 5435. Its
data lives in the compose volume `db-data`. Nothing else runs: there is no worker, no prober and
no scheduled job.

Every error response has the shape `{ "error": "<code>", "message": "…", "details": {} }`. Two
places build them: the error handler in `server/src/shared/errors.ts`, for whatever a route, a
hook or a schema throws, and the not-found handler in `server/src/app.ts`, for the JSON 404 under
`/api` and `/ingest`. One answer escapes both: a path with a malformed percent-escape is refused by
Fastify before routing, in Fastify's own shape (`FST_ERR_BAD_URL`; see `docs/backlog.md`). Code
lives in `server/src/modules/<entity>/`, split into routes, schemas, service and repository files
where a module needs them.

## The two credentials

Two credentials exist, and neither is accepted where the other belongs.

| Path             | Who                     | Credential                                  | Capability                         |
| ---------------- | ----------------------- | ------------------------------------------- | ---------------------------------- |
| `/ingest/events` | a monitored application | server ingest key, `Authorization: Bearer`  | write events for its own app, only |
| `/api/*`         | the owner, in a browser | password, then an HttpOnly `session` cookie | everything else                    |

**Ingest keys.** `./run key:issue <slug>` mints a key (`vgl_` followed by 32 random bytes,
base64url), prints it once, and stores only its SHA-256 digest in `ingest_keys`. The ingest route
checks the key in its own `onRequest` hook (`server/src/modules/ingest/ingest.routes.ts`), before
the body is read, so a caller without a key never costs a body parse. The key is looked up by
digest (`findLiveKey` in `server/src/modules/ingest/key.repository.ts`), and a revoked key
resolves to nothing. A missing, malformed, unknown or revoked key all answer `401 unauthorized`
with the same message, so the answer does not say which keys exist. **The key names the
application:** `app_id` comes from the key row and never from the request, so a key leaked from
one application cannot write events for another. A key cannot read anything. Its `last_used_at`
is stamped at most once an hour.

**The owner's session.** `./run owner:password` stores an argon2id hash of a password of at
least 12 characters (`server/src/modules/auth/password.ts`) and deletes every session, signing
every device out. `POST /api/login` checks the password and sets the cookie
(`server/src/modules/auth/auth.routes.ts`): `HttpOnly`, `SameSite=Lax`, `Path=/`, a lifetime of
`SESSION_TTL_DAYS` (default 30), and `Secure` **only when `NODE_ENV=production`**. A browser does
not store a `Secure` cookie received over plain http, so a local run must leave `NODE_ENV` unset,
and a deployment behind https must set it. The session token is stored as a SHA-256 digest, and
its expiry slides forward at most once an hour (`server/src/modules/auth/auth.service.ts`). A
wrong password and no password ever set answer the same 401, and the second case verifies
against a dummy hash so the two take the same time. Login is limited to
`LOGIN_ATTEMPTS_PER_MINUTE` attempts per minute per client address (default 10). The client
address is the connection's, or, when the connection comes from a proxy that `TRUST_PROXY` names,
the address that proxy appended to `X-Forwarded-For` (`server/src/config.ts`, passed to Fastify's
`trustProxy` in `server/src/app.ts`). Behind a proxy that `TRUST_PROXY` does not name, every
client has the proxy's address and shares one budget; see [Deploying](#deploying).

**The guard** is two `onRequest` hooks in `server/src/modules/auth/guard.ts`, and both are scoped
to `/api` only, so an application posting to `/ingest/events` is never asked for a cookie:

- A write (anything but `GET` and `HEAD`) that carries an `Origin` whose host differs from the
  request's `Host` is refused with `403 forbidden_origin`. Behind a reverse proxy this holds only
  while the proxy passes `Host` through unchanged; see [Deploying](#deploying).
- Any `/api` route not marked public needs a live session, or answers `401 unauthorized`.

Both hooks decide on `request.routeOptions.url`, the route pattern the request matched, never on
the raw `request.url`. The router percent-decodes a path before matching it, so `/%61pi/me`
matches the `/api/me` route while its raw URL does not start with `/api/`; a guard reading the
raw URL let such a request through without a session. A request that matched no route has no
pattern to read, so the not-found handler in `server/src/app.ts` decodes the path itself
(`isApiOrIngestPath`) and answers `404 not_found` as JSON under `/api` and `/ingest`, and with
`index.html` everywhere else.

**The dashboard never shows a page the server has not approved.** It asks `GET /api/me` rather
than reading the cookie, which it cannot (`RequireSession` in `web/src/App.tsx`). Any 401, on any
screen, sends it to the login screen (`watchForSignOut` in `web/src/session.ts`). Every API call
is made with `cache: 'no-store'` (`web/src/api.ts`). `index.html` is served with
`Cache-Control: no-store`, at `/` and through the fallback (`registerSpa` in `server/src/app.ts`),
so a page signed out of is never restored from the browser's back-forward cache with the old
session's issues painted on it. As a second layer, `recheckOnRestore` in `web/src/session.ts`
drops every cached answer when a page does come back from that cache. Signing out clears the
query cache before leaving, and the login screen clears it again when it mounts.

## The path an error takes

1. **A monitored application throws.** If nothing catches it, the `uncaughtException` and
   `unhandledRejection` listeners that `install()` added see it (`client/src/node.ts`). If the
   application catches it, its own error handler calls `vigil.captureError(error, context)`.
2. **The client describes and redacts it**, before anything is queued (`toWireEvent` in
   `client/src/payload.ts`, using `client/src/redact.ts`). Configured `secrets` are replaced
   wherever they appear. A context key whose name contains `authorization`, `cookie`, `apikey`,
   `password`, `token` or `secret`, ignoring case, dashes and underscores, loses its value. In
   messages and stacks, an `authorization`, `cookie`, `set-cookie`, `proxy-authorization` or
   `x-api-key` header line is cleared to its end, and a `Bearer` or `Basic` credential is
   replaced. The message, stack and context are then cut to the server's default caps, and a
   `vigilFingerprint` key in the context is lifted out to become the event's explicit
   `fingerprint`.
3. **The client queues it** (`EventQueue` in `client/src/queue.ts`). The queue holds at most
   `maxQueue` distinct failures (default 100) and drops the oldest past that. A repeat of a
   queued failure increments that event's `count` instead of taking a slot.
4. **A batch is posted** (`send` in `client/src/transport.ts`) to `POST /ingest/events` with the
   key as a bearer token, whenever the queue is flushed (`client/src/node.ts`):
   - every `flushIntervalMs` (default 5,000), on a timer that never keeps the process alive;
   - when the application calls `flush()` or `close()`;
   - at once after an unhandled rejection that does not end the process;
   - at once after an uncaught exception the application keeps alive, because it has an
     `uncaughtException` handler of its own or set `exitOnUncaught: false`;
   - when vigil ends the process after an uncaught exception, for at most `fatalFlushMs`
     (default 1,000).

   Nothing else flushes: what a script queues just before it ends normally is never sent (see
   `docs/backlog.md`). A batch that fails is not retried.

5. **The key names the application** (`onRequest` in `server/src/modules/ingest/ingest.routes.ts`).
   The body is then validated against `IngestBody` (`server/src/modules/ingest/ingest.schemas.ts`),
   which refuses unknown fields and more than `MAX_EVENTS_PER_BATCH` events, under a body limit
   derived from the caps (`server/src/modules/ingest/ingest.body-limit.ts`).
6. **The batch is recorded** by `IngestService.record` (`server/src/modules/ingest/ingest.service.ts`).
   NUL characters are replaced with U+FFFD, since Postgres refuses them, and so is an unpaired
   surrogate in the context, which `jsonb` refuses too (`server/src/shared/nul.ts`); either would
   otherwise fail the whole batch. A stack over `MAX_STACK_BYTES` or a
   context over `MAX_CONTEXT_BYTES` refuses the whole batch with `413 payload_too_large`: oversize
   events are rejected, not truncated and kept. Each event is grouped by `fingerprintOf`
   (`server/src/shared/fingerprint.ts`).
7. **The issue is upserted and the event stored**, the whole batch in one transaction, events
   taken in fingerprint order so two concurrent batches lock issue rows in the same order. A new
   fingerprint inserts an issue whose `first_seen_at` and `last_seen_at` are the event's
   `occurred_at`. An existing one is locked; `occurrence_count` grows by the event's `count`,
   `last_seen_at` only moves forward and `first_seen_at` only moves back. A `resolved` issue
   reopens as `open` and has `reopened_at` stamped; an `ignored` one stays ignored. The event row
   is inserted, and the route answers `202 { "accepted": n }`.
8. **The dashboard reads it.** The issues list (`web/src/routes/Issues.tsx`) reads
   `GET /api/issues`; the issue detail (`web/src/routes/IssueDetail.tsx`) reads
   `GET /api/issues/:id`, with occurrences newest first by `occurred_at`, and changes the status
   through `PATCH /api/issues/:id`. Both are served by `server/src/modules/issues/issue.routes.ts`
   and `issue.repository.ts`. The detail screen folds runs of `node_modules` frames in a stack
   (`frameRuns` in `web/src/format.ts`) and marks an occurrence received more than a minute after
   it happened (`reportedLate` in `web/src/issues.ts`).

## Grouping

`fingerprintOf` in `server/src/shared/fingerprint.ts` hashes, with SHA-256, the error's type
together with its top five stack frames, each reduced to its function name and module path:
line, column, a `file://` prefix and a query string are dropped, so editing a file above a throw
site does not split one issue in two. Frames under `node_modules` are skipped, so a dependency
upgrade does not split issues either; when every frame is a dependency's, those frames are used
rather than nothing. With no frame to parse, the message is hashed instead, with UUIDs, hex runs
of 16 or more characters and digit runs replaced by placeholders, so `user 123 not found` and
`user 456 not found` are one issue. An explicit fingerprint — `vigilFingerprint` in the context
passed to `captureError`, sent as `fingerprint` on the wire — overrides all of this, and the type
too. Explicit and computed fingerprints are hashed from differently tagged inputs and can never
collide. The issue's `culprit`, shown as "where in the code", is the first frame not under
`node_modules` (or the first frame of all), as `function (module)`.

## The tables

One migration, `server/src/db/migrations/001_initial.ts`, creates six tables. The names are
plural, where the design record names them in the singular.

| Table         | What a row is                                                                   |
| ------------- | ------------------------------------------------------------------------------- |
| `owners`      | the owner: a label and an argon2id password hash. One row.                      |
| `sessions`    | a signed-in browser: the token's digest, expiry and last sliding.               |
| `apps`        | a monitored application: a unique `slug` and a `name`.                          |
| `ingest_keys` | a key: its app, `kind`, SHA-256 digest, `last_used_at`, `revoked_at`.           |
| `issues`      | a group of occurrences, unique on `(app_id, environment, fingerprint)`.         |
| `events`      | one occurrence: `occurred_at`, `received_at`, message, stack, context, `count`. |

The migration also seeds the application `vigil` ("Vigil itself"), which vigil's own errors are
recorded under.

**`occurrence_count` outlives `events`.** The count on the issue is authoritative, and events are
samples. Once retention pruning exists, old event rows will be deleted and the count will still
say how often the failure happened. An event's `count` is the client's local collapse: one row can
stand for many identical throws.

**Both timestamps exist** because client clocks are wrong and queues deliver late. `occurred_at`
is when the application says it happened, and the issue's `first_seen_at` and `last_seen_at`
follow it; `received_at` is when vigil stored the row. An event that arrives an hour late sorts
where it happened and still shows when it landed.

**`environment` is in the issue key** so that a failure in local development and the same
failure in production are two issues, never one row — and, once alerting exists, never one alert.

## Self-monitoring

Vigil records its own failures under the application `vigil`, through `server/src/self/record.ts`.
Only unexpected failures are recorded: the error handler in `server/src/shared/errors.ts` calls
the recorder after it has answered a `500 internal_error`, and never for an `AppError`, a schema
rejection or any other 4xx. The recorder writes **straight to the database**, through the same
`IngestService` instance the ingest route uses, in-process. It never posts to its own ingest
endpoint, where a failure in the ingest path would report itself forever.

Two guards close that loop from the other side. A failure on an `/ingest` route is not recorded
at all, judged by the matched route pattern as the guard is. And a call to the recorder made from
inside one of its own writes is dropped: the recorder marks the async context of each write
(`AsyncLocalStorage`), so whatever reports a failure from within that write cannot start another.
The mark covers only that write, not the process, so unrelated failures arriving at the same time
are still recorded. A stack over the cap is cut to fit rather than refused, since this is the only
producer of `vigil` events and refusing would lose the failure. Closing the server waits for
writes still in flight. The recorded environment is `production` when `NODE_ENV=production` and
`development` otherwise.

A database connection that fails, whether idle in the pool or checked out by a request, as every
one does when Postgres restarts, is logged through the server's logger (the listener
`server/src/server.ts` passes to `createDb` in `server/src/db/client.ts`, attached to the pool and
to each client as it connects) and is not recorded. A query in flight on it rejects to its
caller, so that request answers an error. The pool opens a fresh connection for the next query,
and the process keeps running. A failure that kills the process — an
uncaught exception in vigil itself — is not recorded; see "An uncaught exception in vigil itself
is not recorded, and ends the process" in `docs/backlog.md`.

## What is not built yet

- **Notifications and the outbox** — Slice 2. Nothing notifies anyone; the owner learns of an
  issue by opening the dashboard. `IngestService.record` returns `isNew` and `regressed` for each
  event so the outbox can be fed from them; nothing reads them yet.
- **Uptime monitors and the prober** — Slice 3. Nothing probes any application.
- **Browser ingest and the origin allowlist** — Slice 4. Only server keys are issued, there is no
  `app_origin` table, no CORS, no rate limit or quota on ingest, no extension filtering, and the
  client has no `/browser` entry point.
- **Retention pruning** — design record §14. `events` grows without limit today.
- **A settings screen.** Applications and keys are created from the command line
  (`./run app:add`, `./run key:issue`). There is no command to revoke a key: `findLiveKey` honours
  `ingest_keys.revoked_at`, but setting it means an `update` in SQL.

Some columns exist ahead of the code that will use them, so a reader should not go looking for
what fills them:

| Column                     | Today                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------- |
| `issues.last_notified_at`  | never written. Slice 2's throttles.                                                     |
| `issues.auto_muted_at`     | never written. Slice 2's auto-mute.                                                     |
| `issues.reopened_at`       | stamped when a resolved issue reopens; read by nothing yet. Slice 2's regression alert. |
| `ingest_keys.kind`         | always `server`. Read into the resolved key, but no policy depends on it until Slice 4. |
| `ingest_keys.last_used_at` | stamped at most hourly; shown nowhere yet.                                              |

## Running it

Prerequisites: Node 24 or newer, and Docker running. `./run` installs the npm dependencies on
first use and starts Postgres itself.

| Scenario                       | What it does                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------- |
| `./run`                        | lists the scenarios                                                                                |
| `./run dev [--bg]`             | Postgres, migrations, the server and the dashboard with hot reload: dashboard on 5174, API on 4100 |
| `./run start [--bg]`           | builds, then serves the built server and dashboard on one port, 4100                               |
| `./run stop`                   | stops whatever `dev --bg` or `start --bg` left running                                             |
| `./run migrate`                | starts Postgres and applies migrations                                                             |
| `./run owner:password`         | sets the owner's password, from a prompt or from stdin; signs every device out                     |
| `./run app:add <slug> <name…>` | registers an application                                                                           |
| `./run key:issue <slug>`       | issues a server ingest key for it, shown once                                                      |
| `./run build`                  | compiles the server into `server/dist/` and builds the dashboard into `server/public/`             |
| `./run test`                   | the server, client and dashboard suites                                                            |
| `./run check`                  | formatting, types, and the same three suites: the gate before every commit                         |
| `./run test:ui`                | the browser journeys against the built product; not part of `check`                                |

The first run, from a fresh clone:

```bash
./run owner:password          # prompts for a password of at least 12 characters
./run app:add reference The reference application
./run key:issue reference     # copy the key now; only its digest is kept
./run start
```

The first three each start Postgres and apply migrations, so no separate `./run migrate` is
needed. `./run start` refuses to run until an owner password exists, and refuses to run with
`NODE_ENV=production`, because the session cookie would then be `Secure` and a browser on plain
http would silently drop it. Then open `http://localhost:4100` and sign in.

Configuration is read from the environment, and `./run` loads `.env`, creating it from
`.env.example` on first use. `server/src/config.ts` validates it: `DATABASE_URL` is required, and
`PORT`, `SESSION_TTL_DAYS`, `LOGIN_ATTEMPTS_PER_MINUTE`, `LOG_LEVEL`, `MAX_EVENTS_PER_BATCH`,
`MAX_STACK_BYTES` and `MAX_CONTEXT_BYTES` have the defaults shown in `.env.example`.
`TRUST_PROXY` is empty by default, trusting no proxy; see [Deploying](#deploying).

The server and browser suites start their own Postgres with Testcontainers; neither touches the
compose database. `./run test:ui` builds the product, starts it against a throwaway database and
drives it in Chromium through Playwright; the browser builds must be installed once with
`npx playwright install chromium`.

The shared conventions — TypeScript settings, error shape, layout, tests, commits, documentation —
come from the `dev-kit` package, installed from its Git repository at tag `v1.2.1` (root
`package.json`) and imported by `CLAUDE.md`.

## Deploying

There is no deployment artefact yet: no container image, no service definition, and `./run start`
refuses `NODE_ENV=production`, so a deployment builds with `./run build` and starts the built
server itself, with the configuration above in its environment. A fresh database has no tables
and no owner, so the order is: build, apply the migrations, set the owner's password, then start.

    ./run build
    npm run --workspace server migrate
    printf '%s' "$OWNER_PASSWORD" | (cd server && npx tsx scripts/set-password.ts)
    npm run --workspace server start

The migrate script and `set-password.ts` read `DATABASE_URL` and need the workspace's
dependencies installed, since `tsx` is a development dependency. The password is read from
standard input when it is not a terminal, must be at least 12 characters, and signs every device
out; run again, it changes the password. `./run migrate` and `./run owner:password` do the same
for the compose database but also start it, so a deployment does not use them. The design record requires a public hostname over TLS, which puts a reverse proxy in
front of vigil. Four things must then be right, and each fails without an error at start-up:

- **The proxy terminates TLS** on the public hostname and forwards to vigil's port. Without it,
  the owner's password, the session cookie and every application's ingest key cross the network
  in clear text.
- **The proxy passes `Host` through unchanged** (in nginx, `proxy_set_header Host $host;`, since
  nginx's default rewrites it to the upstream's address). The guard compares `Origin` with `Host`,
  so without it every write under `/api` — signing in, signing out, changing a status — is refused
  with `403 forbidden_origin`, and the login screen says only "Could not sign in".
- **`NODE_ENV=production`.** Without it the session cookie is set without `Secure`, so a browser
  will send it over plain http too, and vigil's own errors are recorded under the environment
  `development`.
- **`TRUST_PROXY` names the proxy's address, and nothing else** (`loopback` when the proxy runs
  on this host). Unset, every client has the proxy's address and shares one login budget, so
  anyone can keep the owner locked out with ten wrong passwords a minute. Naming a range that
  clients connect from lets them choose their own address, and with it their own budget.

None of this has been exercised against a real proxy; the suite covers `TRUST_PROXY` with
`X-Forwarded-For` headers injected into the app, and the `Host` comparison with requests made
directly.
