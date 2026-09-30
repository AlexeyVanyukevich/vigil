# Backlog

What is known to be wrong today and not yet fixed. Newest first. Fixing an entry deletes it, in the
same commit as the fix. See `node_modules/dev-kit/rules/backlog.md`.

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
