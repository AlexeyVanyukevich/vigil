# Vigil — application health monitoring

Status: **designed**, 2026-09-05. Not built.

> **This is a decision record, not a description of the system.**
>
> It states what was decided on 2026-09-05, before any of it was built. It is not revised as
> the code moves on.
>
> Read it to learn **why** something has the shape it does. For **what** the system does today,
> read `docs/architecture.md` once it exists.

This is the founding design record of this repository, written before any code on 2026-09-05.
Vigil is standalone and **consumes nothing**: it shares no code and no database with any
application it monitors, and monitored applications depend only on its published client package.

Throughout, **the reference application** means the first application to be watched. Its
conventions are the ones vigil borrows, and it is the first consumer of the client package.

---

## 1. Purpose

Several applications run on one host, with more expected, and there is no way to learn that one
of them threw, crashed, or stopped answering short of opening it and looking. A silent data
error, a wedged process, an expired certificate: all of them are currently discovered by a
person noticing.

Vigil records application failures and uncaught exceptions from every connected app, probes
each app from outside to see whether it is answering at all, and notifies the owner when
something breaks.

### The driving case

An app throws at 3am. By morning the owner knows what threw, how many times, where in the
code, and whether it is still happening — without having read a log file.

### In scope

- Errors and uncaught exceptions from Node processes and from browsers
- Grouping occurrences into issues, so ten thousand failures are one line, not ten thousand
- Uptime probing of each app from outside the app
- A dashboard for the owner
- Notification channels, configurable at runtime

### Not in scope

Deploy and release tracking; business metrics; per-hour rollup buckets; source maps; latency
alerting; multi-region probing; TLS-expiry warnings; quiet hours; escalation; acknowledgement;
per-severity routing.

These were considered and deferred. None of them is precluded by anything below.

---

## 2. Why build rather than adopt

Sentry, GlitchTip and Highlight all solve error tracking, and self-host. They were rejected
because the intent is broader than error tracking — errors and uptime today, under one dashboard
the owner controls, with room for signals no error tracker collects — and because the operator
is one person watching a handful of small applications, a scale at which a small owned tool is
cheaper to run and to understand than a large adopted one.

The cost accepted: vigil will do considerably less than Sentry, and every capability it gains
is one somebody wrote.

---

## 3. Shape of the project

One repository, three deliverables:

| Directory | What it is |
| --------- | ---------- |
| `server/` | Fastify + TypeBox + Kysely + Postgres. Ingest, prober, outbox worker, dashboard API. |
| `web/`    | React dashboard. |
| `client/` | `@vigil/client`, the published package every monitored app depends on. |

Stack, module layout (`routes` / `service` / `repository` per module), error shape
`{ error, message, details? }`, `additionalProperties: false` on every body, and the
single-owner argon2 + sliding-session auth are all taken from the reference application, whose
conventions are documented in its `CONTRIBUTING.md`. Nothing new is introduced without a reason.

Client and server ship from one repository so that a change to the wire format is one commit
with one test suite, rather than a two-repository dance with a version bump in between. This
matters most early, when the payload shape is still moving. `client/` therefore imports nothing
from `server/`, so extracting it later is a history rewrite rather than a rewrite.

### Deployment

Vigil runs on the same host as the monitored applications, in its own container, against its
own database. It shares no code and no database with anything it watches.

Two consequences follow, and both are addressed rather than accepted:

- **Ingest must be reachable from the public internet**, because browsers report to it directly
  (§6). Vigil needs its own public hostname and TLS. It is not an internal-only service.
- **Silence is ambiguous.** A monitor sharing a host with what it monitors cannot report the
  host dying. §8 specifies an external dead-man's switch that converts that silence into an
  alert.

Running vigil on its own host removes the second problem entirely and is the better answer at
any larger scale. It was rejected for now on cost.

---

## 4. Trust boundaries

Two credentials exist, and they never meet.

| Path | Who | Credential | Capability |
| ---- | --- | ---------- | ---------- |
| `POST /ingest/events` | a monitored app's server | server ingest key, `Authorization: Bearer` | write events for its own app only |
| `POST /ingest/events` | a user's browser | browser ingest key, public | write events for its own app only, origin-checked and rate-limited |
| `/api/*`, dashboard | the owner | password login, HttpOnly session cookie | everything else |

**Applications never hold a session.** They authenticate per request with a key, statelessly.
**Only the owner holds a session**, and only in a browser.

Three properties this arrangement buys:

- **A key names its app.** `app_id` is read from the key and never from the request body.
  Otherwise a key leaked from the least important app becomes a way to forge alerts for the
  most important one.
- **Ingest is write-only.** A stolen key submits junk. It cannot read a stored event, enumerate
  apps, or reach a notification channel. That asymmetry is what makes a public browser key
  tolerable at all.
- **Keys rotate without downtime.** Issue the new key, deploy, revoke the old one. Two live keys
  for an afternoon — which is why keys are a table and not a column.

### Server keys and browser keys are one route, two policies

A browser key ships in a bundle and is readable by anyone with devtools. It is accepted only
with a matching `Origin` and under a rate limit. A server sends no `Origin` at all, so it cannot
be subject to the same check. One key kind cannot serve both: origin-checking a server blocks
it, and not origin-checking a browser gives up the only cheap defence available.

They remain **one endpoint with one wire format**. The kind selects the policy applied, not the
route taken.

### The alternative that was rejected

Browsers could report through their own backend — the SPA POSTs to its own app, which forwards
using the secret key — eliminating the public key, CORS, and the anonymous surface entirely.
Every monitored app is behind a login today, so this would have covered every case.

It was rejected in favour of direct browser ingest: fewer moving parts in each application, one
ingest path, no relay endpoint to add per app, and no loss of browser errors while an app's own
backend is down. The cost accepted is a forgeable public credential, contained by §6.

An application with **no backend at all** — a static frontend — is covered by the browser key
without further work. This was the decisive argument.

---

## 5. Data model

Postgres, Kysely, migrations in the reference application's style. Money and currency do not
appear.

### Identity

- **`app`** — `id`, `slug` (unique), `name`, `created_at`. One row per monitored application.
- **`ingest_key`** — `id`, `app_id`, `kind` (`server` | `browser`), `token_sha256` (unique),
  `created_at`, `last_used_at`, `revoked_at`.
- **`app_origin`** — `app_id`, `origin`. The allowlist a browser key is checked against.

Keys are 256-bit random tokens, so **SHA-256 is correct here where argon2 is correct for the
owner's password**: the token has no entropy problem to stretch, and the digest must be
directly indexable for lookup. This deliberate inconsistency with the reference application's
password handling is the point, not an oversight.

The plaintext key is shown **once**, at creation. Only the digest is stored, so a lost key is
reissued and never recovered.

### Errors

- **`issue`** — the group. Unique on `(app_id, environment, fingerprint)`. Carries `title`,
  `culprit`, `runtime` (`node` | `browser`), `status` (`open` | `resolved` | `ignored`),
  `first_seen_at`, `last_seen_at`, `occurrence_count`, `last_notified_at`, `auto_muted_at`.
- **`event`** — one occurrence: `issue_id`, `occurred_at`, `received_at`, `message`, `stack`,
  `context` (jsonb), `count` (client-side collapse, §7).

`environment` is part of the issue key so that local development noise never shares a row — or
an alert — with production.

Both timestamps are kept because **client clocks lie and offline queues replay late**. An event
that happened during an outage and arrived an hour later must sort by when it happened and be
diagnosable by when it landed.

`event` is age-pruned. `issue.occurrence_count` is authoritative and never pruned, so history
survives retention as counts even once the samples are gone.

### Uptime

- **`monitor`** — `app_id`, `name`, `url`, `method`, `expected_status`,
  `expect_body_contains` (nullable), `timeout_ms`, `interval_seconds`, `failure_threshold`,
  `enabled`, plus the persisted state `current_status` (`up` | `down` | `unknown`),
  `consecutive_failures`, `next_check_at`, `last_checked_at`, `last_status_change_at`.
- **`probe_result`** — `monitor_id`, `checked_at`, `ok`, `status_code`, `duration_ms`, `error`.
- **`incident`** — `monitor_id`, `started_at`, `ended_at` (nullable), `cause`.

`probe_result` is age-pruned. `incident` is kept forever: it is small, and it is the only thing
that can answer "how often was this down last year" once probe results have aged out.

### Notification

- **`notification_channel`** — `id`, `name`, `type`, `config` (jsonb, encrypted at rest),
  `app_id` (nullable — null means all apps), `events` (array of the four types in §10),
  `enabled`.
- **`notification`** — the outbox: `channel_id`, `event_type`, `dedup_key`, `payload`,
  `status` (`pending` | `sent` | `failed`), `attempts`, `last_error`, `created_at`, `sent_at`.

`dedup_key` carries a unique constraint with `channel_id`, so concurrent detectors cannot queue
the same alert twice. It identifies the **occurrence**, not the subject, since the same issue
may legitimately alert again after being resolved and regressing:

| Event | `dedup_key` |
| ----- | ----------- |
| `issue.new` | `issue:<issue_id>:new` |
| `issue.regressed` | `issue:<issue_id>:reopened-at:<reopened_at>` |
| `monitor.down` | `incident:<incident_id>:down` |
| `monitor.up` | `incident:<incident_id>:up` |

No subscription join table. At a handful of applications and one owner, a nullable `app_id` and an
`events` array on the channel is the whole requirement.

### Owner

`owner` and `session`, copied from the reference application's auth module: argon2 password
hash, random session token, expiry slid at most once an hour.

---

## 6. Ingest endpoint

`POST /ingest/events`. Bearer key. TypeBox body with `additionalProperties: false`, a batch of
events with hard size caps. Oversize batches, stacks and contexts are **rejected, not truncated
and kept**. Answers `202` as soon as the batch is stored.

Processing, in order:

1. Resolve the key by SHA-256 digest; reject revoked keys. `app_id` comes from the key.
2. If the key is of kind `browser`, check `Origin` against `app_origin` and apply rate limits.
3. Drop frames and events originating from browser extensions.
4. Fingerprint (§7).
5. Upsert the issue: increment `occurrence_count`, slide `last_seen_at`; if `status` was
   `resolved`, reopen it and record a regression.
6. Insert the event.
7. If the issue is new, or regressed, queue an outbox row.

### Containment of browser noise

A public key can be copied out of a bundle and used to submit junk. The following contain it,
in order of how much each actually helps:

- **Extension and bot filtering.** In practice the overwhelming majority of browser ingest noise
  is not attackers — it is `chrome-extension://` and `moz-extension://` frames from the user's
  own add-ons, plus crawlers. These are dropped before fingerprinting.
- **Origin allowlist.** A browser key is accepted only from an origin registered on its app.
  `curl` can forge an `Origin`, so this is not a security boundary; it is what stops a copied
  key working when pasted into another page.
- **Per-key rate limit and daily quota.** Default 120 events per minute and 20,000 per day for a
  browser key. Over the limit, vigil answers `429` and stores a single counter row rather than
  the events, so abuse is visible in the dashboard instead of drowning it.
- **Auto-mute.** An issue exceeding 1,000 occurrences in an hour flips to `ignored`
  automatically, stamps `auto_muted_at`, and notifies once. This protects the notification
  channel, which is what actually degrades during an incident.
- **Hard payload caps.** Default 100 events per batch, 16 KB per stack, 8 KB per context.
- **Rotation**, per §4.

Junk can still reach the dashboard. It cannot exhaust disk, drown real issues, or spam the
owner's phone.

---

## 7. Grouping

The fingerprint is SHA-256 of the error type plus the top few stack frames, each normalized to
**function name and module path, with line and column deliberately dropped**. Editing a file
above a throw site must not split one issue into two.

Frames within `node_modules` are skipped, so the recorded `culprit` is the owner's code rather
than a library's.

With no usable stack, the fingerprint hashes the message with numbers and UUIDs replaced by
placeholders, so `user 123 not found` and `user 456 not found` are one issue.

A client may pass an explicit `fingerprint` as an escape hatch, which overrides all of the
above.

**Grouping is the feature everything else rests on.** Alerting is survivable only because ten
thousand occurrences are one issue; the dashboard is readable for the same reason. It gets the
most thorough unit tests in the project (§12).

---

## 8. Client package

`@vigil/client` publishes two thin adapters over one queue and one payload builder.

- **`/node`** — `install({ url, key, app, environment })` hooks `uncaughtException` and
  `unhandledRejection`; `captureError(err, context)` is called from a framework error handler.
  In the reference application that is one line inside the existing `registerErrorHandler`.
- **`/browser`** — hooks `window.onerror` and `unhandledrejection`, posts directly to vigil with
  the public key, and **queues and flushes when offline**, in the same shape as
  the reference application's existing offline intent queue. Errors then arrive late with
  `occurred_at` preserved, which is what §5's two timestamps exist for.

Four rules the transport must obey, because the characteristic failure of a monitoring client is
that it damages the application it watches:

- **Never throw into the host.** Every transport failure is swallowed and logged once, never
  twice.
- **Never keep a dying process alive.** On `uncaughtException` it flushes with a hard timeout,
  then lets Node do exactly what it would have done — exit. A monitor that nurses a corrupted
  process along is worse than the crash it hid.
- **Bounded queue, drop-oldest.** A vigil outage must never grow the host application's heap.
- **Collapse locally before sending.** A hot loop throwing the same error fifty thousand times
  sends one event with `count: 50000`. Without this, the first real incident takes down the
  monitor.

### Redaction is a hard requirement

The reference application's governing invariant is that a third-party API key never leaves its
server, and a stack trace or captured request context is a plausible way for it to escape. The
client scrubs
`authorization`, `cookie`, `set-cookie` and configured secret values **before anything is
queued**, mirroring the redaction already configured in that project's pino logger.

Scrubbing is client-side by design, so a secret never crosses the wire — not even to vigil.

---

## 9. Prober

**Scheduling is data-driven, not timer-driven.** A tick every ten seconds selects monitors whose
`next_check_at` has passed, runs them through a bounded concurrency pool, and writes back the
next due time. Intervals live in the database rather than in `setInterval` handles, so a restart
resumes where it left off and long intervals do not drift.

The due-monitor select takes `FOR UPDATE SKIP LOCKED`. Vigil runs as one container, but during a
deploy the old one is still draining while the new one starts — precisely when duplicate probes
and a duplicate alert would occur.

**Monitors point at public URLs, not container addresses.** Probing `http://app:3000/api/health`
over the Docker network proves the process answers and says nothing about DNS, TLS expiry, or
the reverse proxy — a large share of how a site becomes unreachable while the application itself
is perfectly healthy. `redirect: 'manual'`, so a 302 to a login page is compared against
`expected_status` rather than silently followed into a 200.

**Failure is consecutive; recovery is immediate.** A monitor goes `down` only after
`failure_threshold` failures in a row, which is what stops a single blip waking the owner. It
goes `up` on the first success, because an all-clear should not wait for a quorum.
`current_status` is persisted, so a vigil restart during an outage resumes "already down" and
does not re-alert for an incident already reported.

**Transitions write incidents and outbox rows.** `up → down` opens an `incident` and queues
`monitor.down`; `down → up` closes it with `ended_at` and queues `monitor.up` carrying the
duration.

### The dead-man's switch

On each tick vigil pings an external heartbeat service. If vigil itself, its host, or its
network dies, that service notices the missing ping and emails the owner. One outbound GET, and
it is what makes §3's "same host" deployment honest: ambiguous silence becomes an alert.

### A note outside this project

The reference application's `/api/health` returns `{ status: 'ok' }` unconditionally and will
therefore report healthy with a dead database. A health endpoint that touches its own critical
dependencies and answers 503 when they are gone is the difference between monitoring a process
and monitoring a service. That is a change to each application, not to vigil, and is recorded
here only so it is not forgotten.

---

## 10. Alerting

**Nothing sends inline.** The detector — the ingest upsert, or the prober's transition — writes
a `notification` row and returns. A worker loop drains it with `FOR UPDATE SKIP LOCKED`,
delivers, and marks `sent` or `failed` with exponential backoff over a few attempts.

Three properties follow: a slow channel API can never slow ingest or skew the prober's clock; a
delivery that fails at 3am retries rather than vanishing; and "did it actually send?" is a query
rather than a guess.

**Four event types, and only four:** `issue.new`, `issue.regressed`, `monitor.down`,
`monitor.up`. Nothing fires per occurrence.

### Channels are modules, not branches

A channel type exports its `type`, a TypeBox schema for its config, a `redact`, and a `send`.
The registry is keyed by type, so adding email later is one new file and one registry line, with
no change to the outbox, the throttles, or the dashboard.

Detectors never build channel-specific text. They produce a neutral
`{ title, body, deepLink, severity }`, and each channel formats it.

**v1 ships one channel: generic webhook.** It POSTs the neutral message as JSON to a configured
URL, which works directly with anything accepting arbitrary JSON. Because Slack, Discord and the
Telegram bot API each demand their own body shape, the channel config takes an **optional
payload template** with `{{title}}`, `{{body}}`, `{{deepLink}}` and `{{severity}}` placeholders
— a handful of lines that let the owner reach a phone today without a second channel
implementation.

Outbound hygiene: redirects not followed, a hard timeout, and an optional HMAC signature header
so the receiver can verify the call came from vigil.

### Three throttles above the channel

The failure that will actually be hit is thirty alerts from one bad deploy.

- A **per-issue cooldown** via `last_notified_at`: one notification per issue per window, however
  it regresses.
- A **per-channel hourly ceiling**: past it, one "14 further alerts suppressed" summary rather
  than fourteen messages.
- **Auto-muted issues** notify exactly once, then never again.

### Channel secrets

A webhook URL with an embedded token, or a bot token, is a real reversible secret — unlike the
key digests elsewhere in this schema. `notification_channel.config` is therefore encrypted at
rest with a key from vigil's environment, and the read path returns a redacted projection.
Editing a channel sends a sentinel meaning "secret unchanged", so it is never retyped and never
round-trips through the browser.

The dashboard offers **Send test**, so configuration is verified when saved rather than during
the first real outage.

---

## 11. Dashboard

Password login, HttpOnly session cookie, single owner. Five screens:

- **Overview** — the landing page, answering one question: is anything on fire. Every app's
  monitor lights and open-issue count.
- **Issues** — filtered by app, environment and status; sorted by last seen or by count.
- **Issue detail** — the stack with `node_modules` frames collapsed, latest context, recent
  occurrences, and the resolve / ignore / unmute actions.
- **Monitors** — uptime percentage, latency and incident history per check; create and edit.
- **Settings** — apps, origins, ingest keys, notification channels, retention.

Notification deep links land directly on issue or monitor detail, so an alert is one tap from
the evidence.

Key creation states plainly, at the moment of creation, that the key is shown once and cannot be
recovered.

---

## 12. Testing

vitest with a testcontainers Postgres, and Playwright for the dashboard — the setup the
reference application already uses.

- **Pure functions get unit tests.** Fingerprint normalization above all, per §7, plus redaction
  and the throttles.
- **Integration tests cover ingest**: key resolution, origin rejection, grouping, regression,
  quota rejection, extension filtering.
- **The prober and the outbox worker take an injected clock** and a stub HTTP target. This is a
  constraint on the design, not a testing detail: no bare `Date.now()` inside those loops, or
  every threshold, cooldown and backoff test has to sleep in real time.
- **The client package is tested standalone**: queue bounds, drop-oldest, never-throws,
  flush-on-exit, and that a transport failure cannot propagate into the host.

---

## 13. Vigil monitors itself, but never over HTTP

Vigil's own errors are written straight to its own database under app slug `vigil`. Reporting to
itself through its own ingest endpoint means a failure in the ingest path generates an error
about the ingest path failing, forever.

The write path also refuses to create an issue while it is handling an ingest failure, closing
the same loop from the other side.

---

## 14. Retention

- `event` — pruned after 30 days; `issue.occurrence_count` survives.
- `probe_result` — pruned after 30 days; `incident` survives forever.
- `notification` — pruned after 30 days once `sent`; `failed` rows are kept until dismissed.

Windows are configurable in Settings. The defaults hold roughly a month of history in a small
database, and the prune runs on the same tick loop as the prober.

---

## 15. Build order

The design is larger than one implementation plan. It decomposes into four slices, each of which
is independently useful and independently testable. Each gets its own plan.

**Slice 1 — errors end to end.** Migrations for `app`, `ingest_key`, `issue`, `event`; the
ingest endpoint with server keys only; fingerprinting; the client package's `/node` entry point;
a minimal dashboard with login, an issues list and an issue detail. At the end of this slice,
the reference application reports its exceptions and the owner can read them. **This is the
slice that delivers the driving case in §1**, and nothing below it should start first.

**Slice 2 — alerting.** `notification_channel` and the outbox, the worker loop, the webhook
channel with its payload template, the three throttles, Send test, and channel settings. At the
end of this slice, a new issue reaches the owner's phone.

**Slice 3 — uptime.** `monitor`, `probe_result`, `incident`; the tick loop and probe; the
transition state machine; the dead-man's switch; the monitors screen. Reuses slice 2's outbox
untouched, which is the test of whether that seam was drawn correctly.

**Slice 4 — browser errors.** Browser ingest keys, `app_origin`, CORS, origin checking, rate
limits and quotas, extension filtering, and the client package's `/browser` entry point with its
offline queue.

Slice 4 is deliberately last. It is the only slice that exposes a public credential, and it is
worth building against a system whose grouping, throttling and containment are already proven
against trusted traffic.
