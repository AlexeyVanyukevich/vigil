# Vigil Slice 1 — Errors End to End: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A monitored Node application reports its uncaught exceptions to vigil, vigil groups
them into issues, and the owner reads them in a browser.

**Architecture:** Three npm workspaces in one repository. `server/` is Fastify 5 + TypeBox over
Kysely + Postgres, split into `modules/<area>/` with `*.repository.ts` / `*.service.ts` /
`*.routes.ts` / `*.schemas.ts`. `client/` is the published `@vigil/client` package, which imports
nothing from `server/`. `web/` is a React SPA built into `server/public` and served from the same
origin as the API. Two credentials never meet: applications authenticate per request with a
bearer ingest key on `/ingest/*`, the owner holds a session cookie on `/api/*`.

**Tech Stack:** Node 24+, TypeScript 7 (`strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`), Fastify 5, `typebox` (not `@sinclair/typebox`) with
`@fastify/type-provider-typebox`, Kysely + `pg`, Postgres 16, `@node-rs/argon2`, Vitest +
Testcontainers, Playwright, React 19 + Vite + React Router + TanStack Query, Prettier.

**Spec:** [docs/superpowers/specs/2026-09-05-vigil-design.md](../specs/2026-09-05-vigil-design.md)
— this plan implements §15's Slice 1. Read §4 (trust boundaries), §5 (data model), §6 (ingest),
§7 (grouping), §8 (client), §11 (dashboard), §13 (self-monitoring) before starting.

---

## Global Constraints

Every task's requirements implicitly include this section.

**Language.** Everything in this repository is written in English: code, identifiers, comments,
documentation, commit messages — **and the dashboard interface**. This differs from the
reference application, whose interface is Russian. Vigil's screens are full of English stack
traces, exception class names and module paths; Russian chrome around English payloads reads
worse than an English tool. Recorded here so it is a decision, not a drift.

**TypeScript.** `strict: true` plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`
in `tsconfig.base.json`. No `any` in hand-written code — the only permitted occurrences are the
`Kysely<any>` signatures Kysely's migration API requires.

**Modules.** `server/` and `client/` are `NodeNext`, so relative imports carry a `.js` extension
even in a `.ts` file: `import { fingerprintOf } from '../shared/fingerprint.js'`. `web/` is
bundler resolution and does not.

**HTTP.** Errors keep the shape `{ error, message, details? }`. Every request body is a TypeBox
schema with `additionalProperties: false` — unknown fields are rejected, never ignored.

**Table names are plural** — `apps`, `ingest_keys`, `issues`, `events`, `owners`, `sessions` —
following the reference application, though §5 of the spec names them in the singular. Column
names are exactly as §5 gives them.

**`app_id` comes from the key and never from the request body** (§4). No route may read an
application identifier out of an ingest payload.

**Ingest keys are 256-bit random tokens stored as a SHA-256 digest** (§5). Argon2 is for the
owner's password only. The plaintext key is shown once, at creation, and never recovered.

**Hard payload caps** (§6), exact values: **100 events per batch, 16 KB per stack, 8 KB per
context.** Oversize batches, stacks and contexts are **rejected, not truncated and kept**.

**Both timestamps are kept** (§5): `occurred_at` from the client, `received_at` from the server.
Never collapse them.

**`environment` is part of the issue key** (§5): unique on `(app_id, environment, fingerprint)`.

**Fingerprints drop line and column** (§7). SHA-256 over the error type plus the top few stack
frames normalized to function name and module path. `node_modules` frames are skipped. No usable
stack falls back to the message with numbers and UUIDs replaced by placeholders.

**The client must never damage its host** (§8), four rules: never throw into the host; never
keep a dying process alive; bounded queue with drop-oldest; collapse repeats locally before
sending.

**Redaction happens client-side, before anything is queued** (§8): `authorization`, `cookie`,
`set-cookie` and configured secret values never cross the wire — not even to vigil.

**Vigil never reports to itself over HTTP** (§13). Its own errors are written straight to its own
database under app slug `vigil`, and the write path refuses to create an issue while it is
handling an ingest failure.

**Out of scope for this slice** — do not build, and do not leave stubs for: browser ingest keys,
`app_origin`, CORS, rate limits and quotas, extension filtering, the `/browser` client entry
point (all Slice 4); notification channels and the outbox (Slice 2); monitors, probes and
incidents (Slice 3); retention pruning (Slice 4's neighbour, §14).

**Commits.** Conventional Commits, `type(scope): subject`, imperative mood, lowercase, ≤72
characters. The reference application's `CONTRIBUTING.md` forbids a body or a `Co-Authored-By`
trailer; this session's harness requires the trailer. This plan writes the trailer. **Ask the
owner which rule vigil's own `CONTRIBUTING.md` should state before Task 1 writes it** — it is a
one-line decision, and Task 1 is where it gets recorded.

**Before every commit:** `./run check` from the repository root.

**Ports, chosen so vigil and the reference application can run side by side:** server `4100`,
Vite `5174`, compose Postgres `5435`.

---

## File Structure

```
run                              one entry point for every way of running the project
package.json                     workspaces: server, client, web
tsconfig.base.json               strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
docker-compose.yml               postgres:16-alpine on 5435
.env.example                     DATABASE_URL, PORT, LOG_LEVEL, SESSION_TTL_DAYS, caps
.prettierrc .prettierignore .gitignore
CONTRIBUTING.md                  vigil's conventions
playwright.config.ts

server/
  src/config.ts                  env → Config, validated at startup
  src/app.ts                     buildApp: plugins, error handler, route registration, SPA
  src/server.ts                  the process entry point
  src/db/client.ts               Kysely + pg pool
  src/db/schema.ts               the Database interface
  src/db/migrate.ts              runMigrations + `npm run migrate`
  src/db/migrations/index.ts     explicit map, not disk discovery
  src/db/migrations/001_initial.ts
  src/shared/errors.ts           AppError hierarchy + registerErrorHandler
  src/shared/schemas.ts          NonBlankString
  src/shared/fingerprint.ts      §7, the crown jewel — pure, no I/O
  src/shared/bytes.ts            byte-length guards for the §6 caps
  src/modules/auth/              password, owner.repository, session.repository,
                                 auth.service, guard, auth.routes
  src/modules/ingest/            key.repository, ingest.schemas, ingest.service, ingest.routes
  src/modules/issues/            issue.repository, issue.schemas, issue.service, issue.routes
  src/modules/apps/              app.repository, app.routes
  src/self/record.ts             §13 — vigil's own errors, straight to the database
  scripts/set-password.ts scripts/add-app.ts scripts/issue-key.ts scripts/setup-state.ts
  tests/unit/                    config, fingerprint, bytes
  tests/integration/             global-setup, helpers, auth-helper, migrations, auth,
                                 ingest, issues, self-monitoring

client/
  src/redact.ts                  scrub before queueing
  src/payload.ts                 unknown thrown value → wire event
  src/queue.ts                   bounded, drop-oldest, collapse
  src/transport.ts               post, never throws, hard timeout
  src/node.ts                    install(), the /node entry point
  tests/                         standalone; no server, no database

web/
  src/main.tsx src/App.tsx src/api.ts src/errors.ts src/styles.css
  src/routes/Login.tsx src/routes/Issues.tsx src/routes/IssueDetail.tsx

tests/ui/                        Playwright journey over the whole product
docs/architecture.md             written by the last task
```

---

### Task 1: Repository skeleton and validated configuration

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `.prettierrc`, `.prettierignore`, `.gitignore`,
  `.env.example`, `docker-compose.yml`, `run`, `CONTRIBUTING.md`
- Create: `server/package.json`, `server/tsconfig.json`, `server/vitest.config.ts`
- Create: `server/src/config.ts`
- Test: `server/tests/unit/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Config` and `loadConfig(env: NodeJS.ProcessEnv): Config` from
  `server/src/config.ts`. Fields: `databaseUrl: string`, `port: number`,
  `sessionTtlDays: number`, `loginAttemptsPerMinute: number`, `logLevel: string`,
  `maxEventsPerBatch: number`, `maxStackBytes: number`, `maxContextBytes: number`.
  Every later task builds its test app from this shape.

- [ ] **Step 1: Ask the owner the commit-message question, then write the root files**

Global Constraints names one open decision: whether vigil's `CONTRIBUTING.md` forbids a commit
body and `Co-Authored-By` trailer (the reference application's rule) or requires the trailer.
Ask, then write the answer into `CONTRIBUTING.md` below. Everything else here is settled.

`package.json`:

```json
{
  "name": "vigil",
  "private": true,
  "type": "module",
  "workspaces": ["server", "client", "web"],
  "engines": { "node": ">=24.0.0" },
  "scripts": {
    "test": "npm run --workspace server test && npm run --workspace client test",
    "test:ui": "playwright test",
    "build": "npm run --workspace server build && npm run --workspace web build",
    "check": "./run check"
  },
  "devDependencies": {
    "@playwright/test": "^1.62.1",
    "prettier": "^3.9.6",
    "typescript": "^7.0.2"
  }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "target": "ES2023",
    "skipLibCheck": true
  }
}
```

`.prettierrc`:

```json
{ "semi": false, "singleQuote": true, "printWidth": 100 }
```

`.prettierignore`:

```
node_modules
dist
package-lock.json
server/public
test-results
playwright-report
.run
```

`.gitignore`:

```
node_modules/
dist/
build/
.env
.run/
test-results/
playwright-report/
*.log
.DS_Store

# Written by the Playwright global setup so the specs can find the running stack.
tests/ui/.runtime.json
server/public/

# Scratch for plan execution: ledgers, briefs, review packages. Git history is the record.
.superpowers/
```

`.env.example`:

```
# Read by `./run` and by docker compose. Plain KEY=value, no quoting.
DATABASE_URL=postgres://postgres:postgres@localhost:5435/vigil
PORT=4100
LOG_LEVEL=info
SESSION_TTL_DAYS=30
# The §6 caps. Configurable only so the test suite can exercise them without 100-event bodies.
MAX_EVENTS_PER_BATCH=100
MAX_STACK_BYTES=16384
MAX_CONTEXT_BYTES=8192
```

`docker-compose.yml`:

```yaml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: vigil
    ports:
      - '5435:5432'
    volumes:
      - db-data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U postgres -d vigil']
      interval: 5s
      timeout: 5s
      retries: 10

volumes:
  db-data:
```

- [ ] **Step 2: Write `run` and make it executable**

```bash
#!/usr/bin/env bash
#
# One entry point for every way of running this project.
# `./run` with no arguments lists the scenarios.
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# `.env` read line by line rather than sourced, so the conventional precedence holds: command
# line, then the file, then the defaults below. `. ./.env` assigns unconditionally and would let
# the file override an explicit `PORT=4200 ./run dev`.
load_env_file() {
  [ -f .env ] || return 0
  local line key
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '' | \#*) continue ;; esac
    key=${line%%=*}
    [ -n "${!key:-}" ] && continue
    export "$key=${line#*=}"
  done < .env
}

load_env_file

APP_PORT="${PORT:-4100}"
WEB_PORT="${WEB_PORT:-5174}"
DB_HOST_PORT=5435
RUN_STATE=".run"
COMPOSE_DB_URL="postgres://postgres:postgres@localhost:${DB_HOST_PORT}/vigil"

if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; OFF=$'\033[0m'
else
  BOLD=''; DIM=''; RED=''; GREEN=''; YELLOW=''; OFF=''
fi

step() { printf '%s→ %s%s\n' "$BOLD" "$1" "$OFF"; }
ok()   { printf '%s✓ %s%s\n' "$GREEN" "$1" "$OFF"; }
note() { printf '%s  %s%s\n' "$DIM" "$1" "$OFF"; }

# Fail with an instruction, not just a symptom.
die() {
  printf '%s✗ %s%s\n' "$RED" "$1" "$OFF" >&2
  [ $# -gt 1 ] && printf '%s  %s%s\n' "$YELLOW" "$2" "$OFF" >&2
  exit 1
}

need_docker() {
  command -v docker >/dev/null 2>&1 ||
    die "Docker is not installed." "Install Docker Desktop, then run this again."
  docker info >/dev/null 2>&1 ||
    die "Docker is installed but not running." "Start Docker Desktop and wait for it to report ready."
}

need_node() {
  command -v node >/dev/null 2>&1 || die "Node is not installed." "Install Node 24 or newer."
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$major" -lt 24 ]; then
    printf '%s! Node %s is older than the required 24.%s\n' "$YELLOW" "$(node -v)" "$OFF" >&2
    note "nvm use   (or install Node 24) — continuing anyway"
  fi
}

need_deps() { [ -d node_modules ] || { step "Installing dependencies"; npm install; }; }

need_env() {
  if [ ! -f .env ]; then
    step "Creating .env from .env.example"
    cp .env.example .env
    note "DATABASE_URL already points at the compose database on port ${DB_HOST_PORT}"
  fi
}

# A Secure cookie is not stored by a browser that received it over plain http, and the failure
# is silent: the owner signs in, appears to succeed, and is signed out on the next request.
need_plain_http_cookie() {
  [ "${NODE_ENV:-}" != "production" ] ||
    die "NODE_ENV is production, so the session cookie is set Secure." \
      "A browser will not store it over plain http. Unset NODE_ENV for a local run."
}

# Migrations create the tables and stop there. Without a password there is no way in, and the
# symptom — every password rejected — reads as a broken build rather than a step not yet taken.
need_setup() {
  local state
  state=$( cd server && DATABASE_URL="${DATABASE_URL:-$COMPOSE_DB_URL}" npx tsx scripts/setup-state.ts </dev/null ) ||
    die "Could not read the setup state from the database." "Check:  docker compose logs db"

  case "$state" in
    *owner=missing*)
      die "No owner password is set, so nobody can sign in." \
        "Set one first:  ./run owner:password"
      ;;
  esac

  case "$state" in
    *apps=missing*)
      note "No applications yet. Nothing can report until one exists:  ./run app:add"
      ;;
  esac
}

start_db() {
  need_docker
  step "Starting Postgres on port ${DB_HOST_PORT}"
  docker compose up -d db </dev/null >/dev/null

  local waited=0
  # stdin from /dev/null on purpose: `docker compose exec` attaches it even with -T, and would
  # swallow input meant for a scenario — `owner:password` reads a password from a pipe.
  until docker compose exec -T db pg_isready -U postgres -d vigil </dev/null >/dev/null 2>&1; do
    sleep 1
    waited=$((waited + 1))
    [ "$waited" -gt 60 ] && die "Postgres did not become ready within a minute." \
      "Check:  docker compose logs db"
  done
  ok "Postgres ready"
}

run_migrations() {
  step "Applying migrations"
  DATABASE_URL="${DATABASE_URL:-$COMPOSE_DB_URL}" npm run --silent --workspace server migrate
}

scenario_dev() {
  need_node; need_deps; need_env
  start_db
  run_migrations

  export DATABASE_URL="${DATABASE_URL:-$COMPOSE_DB_URL}"
  export PORT="$APP_PORT"

  if [ "${1:-}" = "--bg" ]; then
    mkdir -p "$RUN_STATE"
    npm run --workspace server dev >"$RUN_STATE/server.log" 2>&1 & echo $! >"$RUN_STATE/server.pid"
    npm run --workspace web dev -- --port "$WEB_PORT" >"$RUN_STATE/web.log" 2>&1 & echo $! >"$RUN_STATE/web.pid"
    ok "Running in the background"
    note "http://localhost:${WEB_PORT}   logs: ${RUN_STATE}/*.log   stop: ./run stop"
    return
  fi

  ok "Server on :${APP_PORT}, dashboard on http://localhost:${WEB_PORT}"
  note "Ctrl-C stops both"

  # Either one dying takes the pair down — a half-running stack looks like a bug in the app
  # rather than a stopped process.
  trap 'kill 0' EXIT INT TERM
  npm run --workspace server dev 2>&1 | sed "s/^/${DIM}[server]${OFF} /" &
  npm run --workspace web dev -- --port "$WEB_PORT" 2>&1 | sed "s/^/${DIM}[web]   ${OFF} /" &
  wait
}

scenario_start() {
  need_node; need_deps; need_env
  need_plain_http_cookie
  start_db
  run_migrations
  need_setup
  scenario_build

  export DATABASE_URL="${DATABASE_URL:-$COMPOSE_DB_URL}"
  export PORT="$APP_PORT"

  if [ "${1:-}" = "--bg" ]; then
    mkdir -p "$RUN_STATE"
    npm run --workspace server start >"$RUN_STATE/app.log" 2>&1 & echo $! >"$RUN_STATE/app.pid"
    ok "Running in the background"
    note "http://localhost:${APP_PORT}   logs: ${RUN_STATE}/app.log   stop: ./run stop"
    return 0
  fi

  ok "http://localhost:${APP_PORT}"
  note "Ctrl-C stops it"
  npm run --workspace server start
}

scenario_stop() {
  local stopped=0
  for pidfile in "$RUN_STATE"/*.pid; do
    [ -f "$pidfile" ] || continue
    local pid; pid=$(cat "$pidfile")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      stopped=1
    fi
    rm -f "$pidfile"
  done
  [ "$stopped" = 1 ] && ok "Stopped" || note "Nothing was running in the background"
}

scenario_test() {
  need_node; need_deps; need_docker
  step "Server suite (Testcontainers starts its own Postgres)"
  npm run --workspace server test
  step "Client package suite (no server, no database)"
  npm run --workspace client test
}

scenario_test_ui() {
  need_node; need_deps; need_docker
  step "Browser journeys against the whole product"
  npx playwright test
}

scenario_migrate() {
  need_node; need_deps; need_env
  start_db
  run_migrations
  ok "Migrations applied"
}

scenario_password() {
  need_node; need_deps; need_env
  start_db
  run_migrations
  # Invoked directly rather than through `npm run`: this reads a password from stdin, and npm's
  # workspace indirection does not hand a piped one through.
  ( cd server && DATABASE_URL="${DATABASE_URL:-$COMPOSE_DB_URL}" npx tsx scripts/set-password.ts )
}

scenario_app_add() {
  need_node; need_deps; need_env
  start_db
  run_migrations
  ( cd server && DATABASE_URL="${DATABASE_URL:-$COMPOSE_DB_URL}" npx tsx scripts/add-app.ts "$@" )
}

scenario_key_issue() {
  need_node; need_deps; need_env
  start_db
  run_migrations
  ( cd server && DATABASE_URL="${DATABASE_URL:-$COMPOSE_DB_URL}" npx tsx scripts/issue-key.ts "$@" )
}

scenario_check() {
  need_node; need_deps
  step "Types"
  ( cd server && npx tsc --noEmit )
  ( cd client && npx tsc --noEmit )
  ( cd web && npx tsc --noEmit )
  step "Formatting"
  npx prettier --check .
  step "Tests"
  scenario_test
  ok "Everything is clean"
}

scenario_build() {
  need_node; need_deps
  step "Building the server, the client package and the dashboard"
  npm run build
  ok "server/dist and server/public are ready"
}

usage() {
  cat <<TEXT
${BOLD}./run <scenario>${OFF}

  ${BOLD}dev${OFF} [--bg]     Postgres, migrations, the server and Vite together
  ${BOLD}start${OFF} [--bg]   the built dashboard and API on one port
  ${BOLD}stop${OFF}           stop whatever ${BOLD}dev --bg${OFF} or ${BOLD}start --bg${OFF} left running
  ${BOLD}test${OFF}           the server and client suites
  ${BOLD}test:ui${OFF}        browser journeys against the whole product
  ${BOLD}check${OFF}          types, formatting, and both suites
  ${BOLD}build${OFF}          compile the server and build the dashboard
  ${BOLD}migrate${OFF}        apply migrations to the local database
  ${BOLD}owner:password${OFF} set the owner's password (also signs every device out)
  ${BOLD}app:add${OFF}        register an application to be watched
  ${BOLD}key:issue${OFF}      issue a server ingest key for an application (shown once)

Before the first ${BOLD}start${OFF}: ${BOLD}owner:password${OFF}, then ${BOLD}app:add${OFF} and ${BOLD}key:issue${OFF}.
TEXT
}

SCENARIO="${1:-}"
[ $# -gt 0 ] && shift || true

case "$SCENARIO" in
  dev)            scenario_dev "$@" ;;
  start)          scenario_start "$@" ;;
  stop)           scenario_stop ;;
  test)           scenario_test ;;
  test:ui)        scenario_test_ui ;;
  check)          scenario_check ;;
  build)          scenario_build ;;
  migrate)        scenario_migrate ;;
  owner:password) scenario_password ;;
  app:add)        scenario_app_add "$@" ;;
  key:issue)      scenario_key_issue "$@" ;;
  ''|-h|--help)   usage ;;
  *)              die "Unknown scenario: ${SCENARIO}" "Run ./run with no arguments to see the list." ;;
esac
```

Then: `chmod +x run`

- [ ] **Step 3: Write the server workspace files**

`server/package.json`:

```json
{
  "name": "@vigil/server",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/src/server.js",
    "dev": "tsx watch src/server.ts",
    "migrate": "tsx src/db/migrate.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "@fastify/cookie": "^11.1.2",
    "@fastify/rate-limit": "^11.2.0",
    "@fastify/static": "^10.1.3",
    "@fastify/type-provider-typebox": "^6.1.0",
    "@node-rs/argon2": "^2.1.0",
    "fastify": "^5.10.0",
    "kysely": "^0.29.4",
    "pg": "^8.22.0",
    "typebox": "^1.3.8"
  },
  "devDependencies": {
    "@testcontainers/postgresql": "^12.0.4",
    "@types/node": "^26.1.2",
    "@types/pg": "^8.20.0",
    "testcontainers": "^12.0.4",
    "tsx": "^4.23.1",
    "vitest": "^4.1.10"
  }
}
```

`server/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": ".",
    "types": ["node"]
  },
  "include": ["src", "tests", "scripts"]
}
```

`server/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['./tests/integration/global-setup.ts'],
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    pool: 'forks',
    // One database, truncated between cases.
    fileParallelism: false,
  },
})
```

- [ ] **Step 4: Write the failing config test**

`server/tests/unit/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.js'

const MINIMAL = { DATABASE_URL: 'postgres://localhost/vigil' }

describe('loadConfig', () => {
  it('refuses to start without a database', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL is required/)
  })

  it('fills the §6 caps with the spec's defaults', () => {
    const config = loadConfig({ ...MINIMAL })
    expect(config.maxEventsPerBatch).toBe(100)
    expect(config.maxStackBytes).toBe(16_384)
    expect(config.maxContextBytes).toBe(8_192)
  })

  it('applies the remaining defaults', () => {
    const config = loadConfig({ ...MINIMAL })
    expect(config.port).toBe(4100)
    expect(config.sessionTtlDays).toBe(30)
    expect(config.loginAttemptsPerMinute).toBe(10)
    expect(config.logLevel).toBe('info')
  })

  it('reads overrides from the environment', () => {
    const config = loadConfig({ ...MINIMAL, PORT: '4200', MAX_EVENTS_PER_BATCH: '5' })
    expect(config.port).toBe(4200)
    expect(config.maxEventsPerBatch).toBe(5)
  })

  // A typo in deployment should stop the process at start, not surface as a rejected batch
  // the first time an application reports.
  it('refuses a cap that is not a positive integer', () => {
    expect(() => loadConfig({ ...MINIMAL, MAX_STACK_BYTES: '0' })).toThrow(/positive integer/)
    expect(() => loadConfig({ ...MINIMAL, MAX_STACK_BYTES: 'lots' })).toThrow(/positive integer/)
  })

  it('treats a blank value as absent rather than as an empty string', () => {
    expect(() => loadConfig({ DATABASE_URL: '   ' })).toThrow(/DATABASE_URL is required/)
  })
})
```

Note the apostrophe in the second test name must be escaped or the string reworded — write it as
`"fills the §6 caps with the spec defaults"`.

- [ ] **Step 5: Run the test to verify it fails**

Run: `cd server && npx vitest run tests/unit/config.test.ts`
Expected: FAIL — `Cannot find module '../../src/config.js'`

- [ ] **Step 6: Write `server/src/config.ts`**

```ts
export interface Config {
  databaseUrl: string
  port: number
  sessionTtlDays: number
  /**
   * Login attempts allowed per minute per IP. Configurable because it is the only way to
   * exercise the limit in a test without making every other test race it.
   */
  loginAttemptsPerMinute: number
  logLevel: string
  /** §6 hard caps. Configurable so the suite can exercise them without 100-event bodies. */
  maxEventsPerBatch: number
  maxStackBytes: number
  maxContextBytes: number
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]
  if (value === undefined || value.trim() === '') {
    throw new Error(`Invalid configuration: ${key} is required`)
  }
  return value.trim()
}

function positiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim()
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid configuration: ${key} must be a positive integer, got "${raw}"`)
  }
  return value
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return {
    databaseUrl: required(env, 'DATABASE_URL'),
    port: positiveInt(env, 'PORT', 4_100),
    sessionTtlDays: positiveInt(env, 'SESSION_TTL_DAYS', 30),
    loginAttemptsPerMinute: positiveInt(env, 'LOGIN_ATTEMPTS_PER_MINUTE', 10),
    logLevel: env.LOG_LEVEL?.trim() || 'info',
    maxEventsPerBatch: positiveInt(env, 'MAX_EVENTS_PER_BATCH', 100),
    maxStackBytes: positiveInt(env, 'MAX_STACK_BYTES', 16_384),
    maxContextBytes: positiveInt(env, 'MAX_CONTEXT_BYTES', 8_192),
  }
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd server && npx vitest run tests/unit/config.test.ts`
Expected: PASS, 6 tests.

The `vitest.config.ts` names a global setup that does not exist yet, so run the file directly
here. Task 2 creates it and `./run check` starts working end to end.

- [ ] **Step 8: Write `CONTRIBUTING.md`**

Record vigil's conventions, taking the commit-message rule from the owner's answer in Step 1.
It must state, at minimum: English everywhere including the interface; the TypeScript settings;
`NodeNext` on `server/` and `client/` and bundler resolution on `web/`; the stack; the
`{ error, message, details? }` error shape and `additionalProperties: false`; the
`modules/<area>/*.{repository,service,routes,schemas}.ts` layout; that `client/` imports nothing
from `server/`; Conventional Commits; `./run check` before committing; tests before
implementation; and that every slice gets a dated spec and plan, that neither is revised once
the slice ships, and that the last task of every slice updates `docs/architecture.md`.

- [ ] **Step 9: Format and commit**

```bash
npx prettier --write .
git add -A
git commit -m "$(cat <<'EOF'
build: scaffold the workspace and validated configuration

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Database — schema, client, migrations, and the test harness

**Files:**
- Create: `server/src/db/schema.ts`, `server/src/db/client.ts`, `server/src/db/migrate.ts`,
  `server/src/db/migrations/index.ts`, `server/src/db/migrations/001_initial.ts`
- Create: `server/tests/integration/global-setup.ts`, `server/tests/integration/helpers.ts`
- Test: `server/tests/integration/migrations.test.ts`

**Interfaces:**
- Consumes: `Config`, `loadConfig` (Task 1).
- Produces:
  - `Database` interface from `server/src/db/schema.ts` with keys `owners`, `sessions`, `apps`,
    `ingest_keys`, `issues`, `events`, and the row types `OwnersTable`, `SessionsTable`,
    `AppsTable`, `IngestKeysTable`, `IssuesTable`, `EventsTable`.
  - `createDb(connectionString: string): Kysely<Database>` from `server/src/db/client.ts`.
  - `runMigrations(db: Kysely<Database>): Promise<void>` from `server/src/db/migrate.ts`.
  - `getTestDb(): Kysely<Database>`, `closeTestDb(): Promise<void>`, `resetDb(): Promise<void>`
    and `buildTestApp(overrides?): Promise<FastifyInstance>` from
    `server/tests/integration/helpers.ts`. **`buildTestApp` is added in Task 4**, once `app.ts`
    exists; this task creates the file with the first three only.

- [ ] **Step 1: Write `server/src/db/schema.ts`**

```ts
import type { ColumnType, Generated } from 'kysely'

/**
 * One row today. An ordinary primary key rather than a secret pinned to `id = 1`, because a row
 * nothing can be joined to has to be rewritten the day a second owner appears.
 */
export interface OwnersTable {
  id: Generated<string>
  /** For display only. There is no username: login asks for the password alone. */
  label: string
  password_hash: string
  created_at: Generated<Date>
  updated_at: ColumnType<Date, Date | undefined, Date>
}

export interface SessionsTable {
  id: Generated<string>
  owner_id: string
  token_hash: string
  expires_at: ColumnType<Date, Date | string, Date | string>
  created_at: Generated<Date>
  last_seen_at: ColumnType<Date, Date | string | undefined, Date | string>
}

/** One row per monitored application. */
export interface AppsTable {
  id: Generated<string>
  slug: string
  name: string
  created_at: Generated<Date>
}

/**
 * A key names its app: `app_id` is read from here and never from a request body, so a key
 * leaked from the least important application cannot forge events for the most important one.
 *
 * `kind` already carries `browser` although Slice 1 issues only `server` keys. The column is
 * cheap now and a migration on a live table later.
 */
export interface IngestKeysTable {
  id: Generated<string>
  app_id: string
  kind: 'server' | 'browser'
  /** SHA-256 hex. The token has 256 bits of CSPRNG entropy and nothing to stretch. */
  token_sha256: string
  created_at: Generated<Date>
  last_used_at: ColumnType<Date | null, never, Date>
  revoked_at: ColumnType<Date | null, never, Date>
}

/**
 * The group. `environment` is part of the key so local development noise never shares a row —
 * or, from Slice 2, an alert — with production.
 */
export interface IssuesTable {
  id: Generated<string>
  app_id: string
  environment: string
  /** SHA-256 hex from `shared/fingerprint.ts`. */
  fingerprint: string
  title: string
  culprit: string | null
  runtime: 'node' | 'browser'
  status: Generated<'open' | 'resolved' | 'ignored'>
  first_seen_at: Generated<Date>
  last_seen_at: ColumnType<Date, Date | undefined, Date>
  /** Authoritative and never pruned: history survives retention as counts. */
  occurrence_count: Generated<number>
  /** Slice 2 owns these two. Present from the first migration so neither needs a backfill. */
  last_notified_at: ColumnType<Date | null, never, Date>
  auto_muted_at: ColumnType<Date | null, never, Date>
  /** Stamped when a resolved issue reopens. Slice 2's regression dedup key reads it. */
  reopened_at: ColumnType<Date | null, never, Date>
}

/** One occurrence. Age-pruned from §14; the issue's count outlives it. */
export interface EventsTable {
  id: Generated<string>
  issue_id: string
  /** When the application says it happened. Client clocks lie and offline queues replay late. */
  occurred_at: Date
  /** When vigil stored it. The pair is what makes a late arrival diagnosable. */
  received_at: Generated<Date>
  message: string
  stack: string | null
  context: ColumnType<Record<string, unknown> | null, string | null, string | null>
  /** Client-side collapse (§8): one row can stand for fifty thousand throws. */
  count: Generated<number>
}

export interface Database {
  owners: OwnersTable
  sessions: SessionsTable
  apps: AppsTable
  ingest_keys: IngestKeysTable
  issues: IssuesTable
  events: EventsTable
}
```

- [ ] **Step 2: Write `server/src/db/client.ts` and `server/src/db/migrate.ts`**

`client.ts`:

```ts
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Database } from './schema.js'

// Postgres returns int8 as a string to avoid losing precision. `occurrence_count` is a bigint
// and is read into arithmetic and into JSON; a string count is a bug waiting to be concatenated.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value))

export function createDb(connectionString: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }),
  })
}
```

`migrate.ts`:

```ts
import { fileURLToPath } from 'node:url'
import type { Kysely } from 'kysely'
import { Migrator } from 'kysely/migration'
import { createDb } from './client.js'
import { migrations } from './migrations/index.js'
import type { Database } from './schema.js'

export async function runMigrations(db: Kysely<Database>): Promise<void> {
  const migrator = new Migrator({ db, provider: { getMigrations: async () => migrations } })

  const { error, results } = await migrator.migrateToLatest()

  for (const result of results ?? []) {
    if (result.status === 'Error') {
      throw new Error(`Migration "${result.migrationName}" failed`)
    }
  }

  if (error) throw error
}

// Executed only when run directly: `npm run migrate`.
//
// DATABASE_URL alone, deliberately not the whole validated config: creating tables is the first
// step of a fresh install, and it must not be blocked on settings that are not needed yet.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL is required to run migrations')
  }

  const db = createDb(databaseUrl)
  try {
    await runMigrations(db)
    console.log('migrations applied')
  } finally {
    await db.destroy()
  }
}
```

`migrations/index.ts`:

```ts
import type { Migration } from 'kysely/migration'
import * as initial from './001_initial.js'

/**
 * Migrations are listed explicitly instead of being discovered from disk: Kysely's
 * FileMigrationProvider imports files at runtime, which fails wherever the runtime cannot load
 * TypeScript directly — Vitest's global setup, plain `node` on the sources — and forces a build
 * step before migrating. A static map works everywhere and makes the order visible in review.
 *
 * Keys are the names Kysely records in `kysely_migration`; they are applied in lexicographic
 * order, so keep the numeric prefix.
 */
export const migrations: Record<string, Migration> = {
  '001_initial': initial,
}
```

- [ ] **Step 3: Write the failing migrations test**

`server/tests/integration/migrations.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { closeTestDb, getTestDb, resetDb } from './helpers.js'

const db = () => getTestDb()

beforeEach(async () => {
  await resetDb()
})
afterAll(async () => {
  await closeTestDb()
})

async function seedApp(slug = 'reference'): Promise<string> {
  const row = await db()
    .insertInto('apps')
    .values({ slug, name: 'The reference application' })
    .returning('id')
    .executeTakeFirstOrThrow()
  return row.id
}

describe('001_initial', () => {
  it('creates every table this slice needs', async () => {
    const rows = await sql<{ table_name: string }>`
      select table_name from information_schema.tables where table_schema = 'public'
    `.execute(db())
    const names = rows.rows.map((r) => r.table_name)
    for (const table of ['owners', 'sessions', 'apps', 'ingest_keys', 'issues', 'events']) {
      expect(names).toContain(table)
    }
  })

  it('seeds the vigil application itself, so §13 has somewhere to write', async () => {
    const row = await db()
      .selectFrom('apps')
      .select(['slug', 'name'])
      .where('slug', '=', 'vigil')
      .executeTakeFirst()
    expect(row?.slug).toBe('vigil')
  })

  it('makes an application slug unique', async () => {
    await seedApp('duplicate')
    await expect(seedApp('duplicate')).rejects.toThrow()
  })

  // The issue key is what makes grouping work at all, and environment is in it so that a
  // developer's laptop cannot merge its noise into production's row.
  it('makes an issue unique on app, environment and fingerprint', async () => {
    const appId = await seedApp()
    const issue = {
      app_id: appId,
      environment: 'production',
      fingerprint: 'a'.repeat(64),
      title: 'TypeError: boom',
      culprit: 'handle (/app/src/x.js)',
      runtime: 'node' as const,
    }
    await db().insertInto('issues').values(issue).execute()
    await expect(db().insertInto('issues').values(issue).execute()).rejects.toThrow()

    // Same fingerprint, different environment: a separate issue, not a conflict.
    await db()
      .insertInto('issues')
      .values({ ...issue, environment: 'development' })
      .execute()
    expect(await db().selectFrom('issues').selectAll().execute()).toHaveLength(2)
  })

  it('defaults a new issue to open with a zero count', async () => {
    const appId = await seedApp()
    const row = await db()
      .insertInto('issues')
      .values({
        app_id: appId,
        environment: 'production',
        fingerprint: 'b'.repeat(64),
        title: 'Error: nope',
        culprit: null,
        runtime: 'node',
      })
      .returning(['status', 'occurrence_count', 'last_notified_at', 'reopened_at'])
      .executeTakeFirstOrThrow()
    expect(row.status).toBe('open')
    expect(row.occurrence_count).toBe(0)
    expect(row.last_notified_at).toBeNull()
    expect(row.reopened_at).toBeNull()
  })

  it('reads occurrence_count back as a number, not a string', async () => {
    const appId = await seedApp()
    await db()
      .insertInto('issues')
      .values({
        app_id: appId,
        environment: 'production',
        fingerprint: 'c'.repeat(64),
        title: 'Error: nope',
        culprit: null,
        runtime: 'node',
        occurrence_count: 3,
      })
      .execute()
    const row = await db()
      .selectFrom('issues')
      .select('occurrence_count')
      .executeTakeFirstOrThrow()
    expect(row.occurrence_count).toBe(3)
    expect(typeof row.occurrence_count).toBe('number')
  })

  it('refuses an ingest key whose digest is already registered', async () => {
    const appId = await seedApp()
    const key = { app_id: appId, kind: 'server' as const, token_sha256: 'd'.repeat(64) }
    await db().insertInto('ingest_keys').values(key).execute()
    await expect(db().insertInto('ingest_keys').values(key).execute()).rejects.toThrow()
  })

  it('deletes an application key and its issues with the application', async () => {
    const appId = await seedApp('doomed')
    await db()
      .insertInto('ingest_keys')
      .values({ app_id: appId, kind: 'server', token_sha256: 'e'.repeat(64) })
      .execute()
    const issue = await db()
      .insertInto('issues')
      .values({
        app_id: appId,
        environment: 'production',
        fingerprint: 'f'.repeat(64),
        title: 'Error: nope',
        culprit: null,
        runtime: 'node',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db()
      .insertInto('events')
      .values({ issue_id: issue.id, occurred_at: new Date(), message: 'nope', stack: null, context: null })
      .execute()

    await db().deleteFrom('apps').where('id', '=', appId).execute()

    expect(await db().selectFrom('ingest_keys').selectAll().execute()).toHaveLength(0)
    expect(await db().selectFrom('issues').selectAll().execute()).toHaveLength(0)
    expect(await db().selectFrom('events').selectAll().execute()).toHaveLength(0)
  })

  it('rejects a status outside the three the spec names', async () => {
    const appId = await seedApp()
    await expect(
      sql`insert into issues (app_id, environment, fingerprint, title, runtime, status)
          values (${appId}, 'production', ${'0'.repeat(64)}, 'x', 'node', 'snoozed')`.execute(db()),
    ).rejects.toThrow()
  })

  it('keeps occurred_at and received_at as separate columns', async () => {
    const appId = await seedApp()
    const issue = await db()
      .insertInto('issues')
      .values({
        app_id: appId,
        environment: 'production',
        fingerprint: '1'.repeat(64),
        title: 'Error: late',
        culprit: null,
        runtime: 'node',
      })
      .returning('id')
      .executeTakeFirstOrThrow()

    // An event that happened during an outage and arrived an hour later.
    const happened = new Date(Date.now() - 3_600_000)
    const row = await db()
      .insertInto('events')
      .values({ issue_id: issue.id, occurred_at: happened, message: 'late', stack: null, context: null })
      .returning(['occurred_at', 'received_at'])
      .executeTakeFirstOrThrow()

    expect(row.occurred_at.getTime()).toBe(happened.getTime())
    expect(row.received_at.getTime()).toBeGreaterThan(row.occurred_at.getTime())
  })
})
```

- [ ] **Step 4: Write the test harness**

`server/tests/integration/global-setup.ts`:

```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { createDb } from '../../src/db/client.js'
import { runMigrations } from '../../src/db/migrate.js'

let container: StartedPostgreSqlContainer

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string
  }
}

interface GlobalSetupContext {
  provide: <K extends keyof import('vitest').ProvidedContext>(key: K, value: string) => void
}

export async function setup({ provide }: GlobalSetupContext): Promise<void> {
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  const databaseUrl = container.getConnectionUri()

  const db = createDb(databaseUrl)
  try {
    await runMigrations(db)
  } finally {
    await db.destroy()
  }

  provide('databaseUrl', databaseUrl)
}

export async function teardown(): Promise<void> {
  await container?.stop()
}
```

`server/tests/integration/helpers.ts` — the `buildTestApp` half arrives in Task 4:

```ts
import { inject } from 'vitest'
import { sql, type Kysely } from 'kysely'
import { createDb } from '../../src/db/client.js'
import type { Database } from '../../src/db/schema.js'

let cached: Kysely<Database> | undefined

export function getTestDb(): Kysely<Database> {
  cached ??= createDb(inject('databaseUrl'))
  return cached
}

export async function closeTestDb(): Promise<void> {
  await cached?.destroy()
  cached = undefined
}

/**
 * `apps` cascades to keys, issues and events, so truncating it clears most of the schema. The
 * `vigil` row is seeded by the migration and put back here: it is the app §13 writes to, a
 * state production can never be without, and one tests should not have to handle.
 */
export async function resetDb(): Promise<void> {
  await sql`truncate table events, issues, ingest_keys, apps, sessions, owners restart identity cascade`.execute(
    getTestDb(),
  )
  await getTestDb()
    .insertInto('apps')
    .values({ slug: 'vigil', name: 'Vigil itself' })
    .onConflict((oc) => oc.column('slug').doNothing())
    .execute()
}
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `cd server && npx vitest run tests/integration/migrations.test.ts`
Expected: FAIL — `Cannot find module './001_initial.js'`. Docker must be running; the first run
pulls `postgres:16-alpine`.

- [ ] **Step 6: Write `server/src/db/migrations/001_initial.ts`**

```ts
import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  // ── the owner ──────────────────────────────────────────────────────────────
  //
  // One row today, and no `id = 1` check: a second owner would only have to undo it.
  await db.schema
    .createTable('owners')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('label', 'text', (col) => col.notNull())
    .addColumn('password_hash', 'text', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  // `owner_id` is here from the first migration on purpose. Reshaping `owners` later is cheap;
  // adding a not-null foreign key to a live sessions table means a backfill or signing
  // everybody out to get one.
  await db.schema
    .createTable('sessions')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('owner_id', 'uuid', (col) =>
      col.notNull().references('owners.id').onDelete('cascade'),
    )
    .addColumn('token_hash', 'text', (col) => col.notNull().unique())
    .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('last_seen_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  // ── identity ───────────────────────────────────────────────────────────────
  await db.schema
    .createTable('apps')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('slug', 'text', (col) => col.notNull().unique())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('apps_slug_is_a_slug', sql`slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'`)
    .addCheckConstraint('apps_name_not_blank', sql`length(btrim(name)) > 0`)
    .execute()

  // Keys are a table and not a column so rotation needs no downtime: issue the new key,
  // deploy, revoke the old one. Two live keys for an afternoon is the whole point.
  await db.schema
    .createTable('ingest_keys')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('app_id', 'uuid', (col) => col.notNull().references('apps.id').onDelete('cascade'))
    .addColumn('kind', 'text', (col) => col.notNull())
    .addColumn('token_sha256', 'text', (col) => col.notNull().unique())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('last_used_at', 'timestamptz')
    .addColumn('revoked_at', 'timestamptz')
    .addCheckConstraint('ingest_keys_kind_known', sql`kind in ('server', 'browser')`)
    .addCheckConstraint('ingest_keys_digest_is_sha256', sql`token_sha256 ~ '^[0-9a-f]{64}$'`)
    .execute()

  await db.schema.createIndex('ingest_keys_app_idx').on('ingest_keys').column('app_id').execute()

  // ── errors ─────────────────────────────────────────────────────────────────
  await db.schema
    .createTable('issues')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('app_id', 'uuid', (col) => col.notNull().references('apps.id').onDelete('cascade'))
    .addColumn('environment', 'text', (col) => col.notNull())
    .addColumn('fingerprint', 'text', (col) => col.notNull())
    .addColumn('title', 'text', (col) => col.notNull())
    .addColumn('culprit', 'text')
    .addColumn('runtime', 'text', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('open'))
    .addColumn('first_seen_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('last_seen_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    // bigint: a hot loop reporting `count: 50000` a few thousand times clears int4 in a day.
    .addColumn('occurrence_count', 'bigint', (col) => col.notNull().defaultTo(0))
    .addColumn('last_notified_at', 'timestamptz')
    .addColumn('auto_muted_at', 'timestamptz')
    .addColumn('reopened_at', 'timestamptz')
    .addUniqueConstraint('issues_group_unique', ['app_id', 'environment', 'fingerprint'])
    .addCheckConstraint('issues_status_known', sql`status in ('open', 'resolved', 'ignored')`)
    .addCheckConstraint('issues_runtime_known', sql`runtime in ('node', 'browser')`)
    .addCheckConstraint('issues_count_not_negative', sql`occurrence_count >= 0`)
    .addCheckConstraint('issues_environment_not_blank', sql`length(btrim(environment)) > 0`)
    .execute()

  // The issues screen sorts by last seen within an app, filtered by status. This is that query.
  await db.schema
    .createIndex('issues_app_last_seen_idx')
    .on('issues')
    .columns(['app_id', 'status', 'last_seen_at desc'])
    .execute()

  await db.schema
    .createTable('events')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('issue_id', 'uuid', (col) =>
      col.notNull().references('issues.id').onDelete('cascade'),
    )
    .addColumn('occurred_at', 'timestamptz', (col) => col.notNull())
    .addColumn('received_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('message', 'text', (col) => col.notNull())
    .addColumn('stack', 'text')
    .addColumn('context', 'jsonb')
    .addColumn('count', 'integer', (col) => col.notNull().defaultTo(1))
    .addCheckConstraint('events_count_positive', sql`count > 0`)
    .execute()

  // Issue detail reads the most recent occurrences; §14's prune sweeps by received_at.
  await db.schema
    .createIndex('events_issue_occurred_idx')
    .on('events')
    .columns(['issue_id', 'occurred_at desc'])
    .execute()

  await db.schema.createIndex('events_received_idx').on('events').column('received_at').execute()

  // §13: vigil records its own failures under this slug, written straight to the database and
  // never through its own ingest endpoint. Seeded here so the write path can assume it exists.
  await db
    .insertInto('apps')
    .values({ slug: 'vigil', name: 'Vigil itself' })
    .onConflict((oc: any) => oc.column('slug').doNothing())
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('events').ifExists().execute()
  await db.schema.dropTable('issues').ifExists().execute()
  await db.schema.dropTable('ingest_keys').ifExists().execute()
  await db.schema.dropTable('apps').ifExists().execute()
  await db.schema.dropTable('sessions').ifExists().execute()
  await db.schema.dropTable('owners').ifExists().execute()
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd server && npx vitest run tests/integration/migrations.test.ts`
Expected: PASS, 10 tests.

If `occurrence_count` comes back as a string, the `setTypeParser` call in `client.ts` is missing
or the pool was created before it ran — it must be at module scope, above `createDb`.

- [ ] **Step 8: Commit**

```bash
./run check
git add -A
git commit -m "$(cat <<'EOF'
feat(db): add the slice-1 schema, migration runner and test harness

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Fingerprinting

§7 is the feature everything else rests on: alerting is survivable and the dashboard is readable
only because ten thousand occurrences are one issue. It is pure, it does no I/O, and it gets the
most thorough tests in the project.

**Files:**
- Create: `server/src/shared/fingerprint.ts`
- Test: `server/tests/unit/fingerprint.test.ts`

**Interfaces:**
- Consumes: nothing — no database, no config.
- Produces, from `server/src/shared/fingerprint.ts`:
  - `interface Frame { fn: string; module: string; vendor: boolean }`
  - `parseFrames(stack: string): Frame[]`
  - `normalizeMessage(message: string): string`
  - `interface FingerprintInput { type: string; message: string; stack?: string | undefined; fingerprint?: string | undefined }`
  - `interface Fingerprinted { fingerprint: string; culprit: string | null }`
  - `fingerprintOf(input: FingerprintInput): Fingerprinted`

- [ ] **Step 1: Write the failing test**

`server/tests/unit/fingerprint.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { fingerprintOf, normalizeMessage, parseFrames } from '../../src/shared/fingerprint.js'

const STACK = `TypeError: Cannot read properties of undefined (reading 'id')
    at handleBooking (/app/src/modules/bookings/booking.service.js:42:17)
    at process (/app/node_modules/fastify/lib/handle.js:118:9)
    at async run (/app/src/app.js:12:3)`

describe('parseFrames', () => {
  it('reads the function and the module, and drops line and column', () => {
    const [first] = parseFrames(STACK)
    expect(first).toEqual({
      fn: 'handleBooking',
      module: '/app/src/modules/bookings/booking.service.js',
      vendor: false,
    })
  })

  it('marks a node_modules frame as vendor', () => {
    expect(parseFrames(STACK)[1]?.vendor).toBe(true)
  })

  it('strips the async and new decorations, which do not change which function it is', () => {
    expect(parseFrames(STACK)[2]?.fn).toBe('run')
    const [constructed] = parseFrames('    at new Repository (/app/src/repo.js:1:1)')
    expect(constructed?.fn).toBe('Repository')
  })

  it('reads a frame with no function name', () => {
    const [frame] = parseFrames('    at /app/src/boot.js:9:1')
    expect(frame).toEqual({ fn: '<anonymous>', module: '/app/src/boot.js', vendor: false })
  })

  // The first line is the error, not a frame, and `at Object.<anonymous>` with no location is
  // not one either. Neither may become a module path.
  it('ignores the message line and any frame carrying no location', () => {
    expect(parseFrames('Error: boom\n    at Object.<anonymous>')).toEqual([])
  })

  it('reads a browser frame served over http', () => {
    const [frame] = parseFrames('    at t.render (https://app.example/assets/index-a1b2.js:5:914)')
    expect(frame?.fn).toBe('t.render')
    expect(frame?.module).toBe('https://app.example/assets/index-a1b2.js')
  })

  it('survives a stack it cannot parse at all', () => {
    expect(parseFrames('something went wrong')).toEqual([])
    expect(parseFrames('')).toEqual([])
  })
})

describe('normalizeMessage', () => {
  it('makes two messages differing only by an id into one', () => {
    expect(normalizeMessage('user 123 not found')).toBe(normalizeMessage('user 456 not found'))
  })

  it('replaces a uuid whole rather than digit by digit', () => {
    expect(normalizeMessage('booking 3f6a1c2e-9d4b-4f8a-8c1d-2b7e5a9f0c31 is gone')).toBe(
      'booking <uuid> is gone',
    )
  })

  it('replaces a long hex run', () => {
    expect(normalizeMessage('token deadbeefdeadbeefcafe expired')).toBe('token <hex> expired')
  })

  it('leaves a message with nothing variable in it alone', () => {
    expect(normalizeMessage('the engine did not answer')).toBe('the engine did not answer')
  })
})

describe('fingerprintOf', () => {
  const base = { type: 'TypeError', message: "Cannot read properties of undefined", stack: STACK }

  it('is a sha256 hex digest', () => {
    expect(fingerprintOf(base).fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  // The rule the whole design rests on: editing a file above a throw site must not split one
  // issue into two.
  it('does not change when a line above the throw site moves', () => {
    const moved = STACK.replace(':42:17', ':71:9').replace(':12:3', ':30:3')
    expect(fingerprintOf({ ...base, stack: moved }).fingerprint).toBe(fingerprintOf(base).fingerprint)
  })

  it('does not change when the message carries a different id', () => {
    const a = fingerprintOf({ ...base, message: 'user 1 missing' })
    const b = fingerprintOf({ ...base, message: 'user 2 missing' })
    expect(a.fingerprint).toBe(b.fingerprint)
  })

  it('changes when the error type changes', () => {
    expect(fingerprintOf({ ...base, type: 'RangeError' }).fingerprint).not.toBe(
      fingerprintOf(base).fingerprint,
    )
  })

  it('changes when the throw moves to a different function', () => {
    const elsewhere = STACK.replace('handleBooking', 'cancelBooking')
    expect(fingerprintOf({ ...base, stack: elsewhere }).fingerprint).not.toBe(
      fingerprintOf(base).fingerprint,
    )
  })

  it('names the owner code as the culprit, not the library below it', () => {
    expect(fingerprintOf(base).culprit).toBe(
      'handleBooking (/app/src/modules/bookings/booking.service.js)',
    )
  })

  // A dependency upgrade reshuffles the frames inside it. If those frames were in the hash,
  // every issue in the project would split on `npm update`.
  it('ignores a change confined to node_modules', () => {
    const upgraded = STACK.replace('fastify/lib/handle.js:118:9', 'fastify/lib/route.js:9:1')
    expect(fingerprintOf({ ...base, stack: upgraded }).fingerprint).toBe(
      fingerprintOf(base).fingerprint,
    )
  })

  // An error thrown entirely inside a dependency has no owner frame to fall back on. Dropping
  // every frame would hash nothing but the type, merging unrelated library failures into one.
  it('uses vendor frames when there is no owner frame at all', () => {
    const vendorOnly = `Error: socket hang up
    at Socket.end (/app/node_modules/undici/lib/core.js:9:1)`
    const other = `Error: socket hang up
    at Pool.dispatch (/app/node_modules/undici/lib/pool.js:4:2)`
    const a = fingerprintOf({ type: 'Error', message: 'socket hang up', stack: vendorOnly })
    const b = fingerprintOf({ type: 'Error', message: 'socket hang up', stack: other })
    expect(a.fingerprint).not.toBe(b.fingerprint)
    expect(a.culprit).toBe('Socket.end (/app/node_modules/undici/lib/core.js)')
  })

  it('falls back to the normalized message with no usable stack', () => {
    const a = fingerprintOf({ type: 'Error', message: 'user 1 not found' })
    const b = fingerprintOf({ type: 'Error', message: 'user 2 not found' })
    const c = fingerprintOf({ type: 'Error', message: 'house 1 not found' })
    expect(a.fingerprint).toBe(b.fingerprint)
    expect(a.fingerprint).not.toBe(c.fingerprint)
    expect(a.culprit).toBeNull()
  })

  it('lets an explicit fingerprint override everything', () => {
    const a = fingerprintOf({ ...base, fingerprint: 'checkout-flow' })
    const b = fingerprintOf({ type: 'RangeError', message: 'other', fingerprint: 'checkout-flow' })
    expect(a.fingerprint).toBe(b.fingerprint)
    expect(a.fingerprint).not.toBe(fingerprintOf(base).fingerprint)
    // Still reported, so the dashboard can show where a hand-grouped issue came from.
    expect(a.culprit).toBe('handleBooking (/app/src/modules/bookings/booking.service.js)')
  })

  it('treats a blank explicit fingerprint as absent', () => {
    expect(fingerprintOf({ ...base, fingerprint: '   ' }).fingerprint).toBe(
      fingerprintOf(base).fingerprint,
    )
  })

  // An explicit fingerprint is caller-chosen text. It must not be able to collide with a
  // computed one by being crafted to look like the hashed body.
  it('cannot be made to collide with a computed fingerprint', () => {
    const crafted = fingerprintOf({ type: 'Error', message: 'x', fingerprint: 'Error\nx' })
    const computed = fingerprintOf({ type: 'Error', message: 'x' })
    expect(crafted.fingerprint).not.toBe(computed.fingerprint)
  })

  it('is stable across calls', () => {
    expect(fingerprintOf(base).fingerprint).toBe(fingerprintOf(base).fingerprint)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run tests/unit/fingerprint.test.ts`
Expected: FAIL — `Cannot find module '../../src/shared/fingerprint.js'`

- [ ] **Step 3: Write `server/src/shared/fingerprint.ts`**

```ts
import { createHash } from 'node:crypto'

export interface Frame {
  /** The function or method, `<anonymous>` when the stack gave none. */
  fn: string
  /** The file or URL, with line and column removed. */
  module: string
  /** A dependency's frame: kept, but never preferred as the culprit. */
  vendor: boolean
}

/**
 * Enough frames to tell two call paths apart, few enough that a deeper stack reaching the same
 * throw site through one more wrapper stays one issue.
 */
const FRAMES_IN_FINGERPRINT = 5

// `    at fn (/path/file.js:10:15)` — the common V8 shape.
const FRAME_WITH_FN = /^\s*at\s+(.+?)\s+\((.+?)\)\s*$/
// `    at /path/file.js:10:15` — a top-level frame with no function.
const FRAME_BARE = /^\s*at\s+(.+?)\s*$/
// A trailing `:line:column`, or `:line` alone.
const POSITION = /:\d+(?::\d+)?$/
const DECORATION = /^(?:async|new)\s+/
const VENDOR = /[/\\]node_modules[/\\]/

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const HEX = /\b[0-9a-f]{16,}\b/gi
const DIGITS = /\b\d+\b/g

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function toFrame(fn: string, location: string): Frame {
  const name = fn.replace(DECORATION, '').trim()
  // `file://` and a query string are transport, not identity: the same module reached two ways
  // must not become two issues.
  const module = location
    .replace(POSITION, '')
    .replace(/^file:\/\//, '')
    .replace(/[?#].*$/, '')
  return {
    fn: name === '' ? '<anonymous>' : name,
    module,
    vendor: VENDOR.test(module),
  }
}

export function parseFrames(stack: string): Frame[] {
  const frames: Frame[] = []

  for (const line of stack.split('\n')) {
    const withFn = FRAME_WITH_FN.exec(line)
    if (withFn?.[1] !== undefined && withFn[2] !== undefined) {
      frames.push(toFrame(withFn[1], withFn[2]))
      continue
    }

    const bare = FRAME_BARE.exec(line)
    const location = bare?.[1]
    // A location has a path separator. `at Object.<anonymous>` has only a dot, and treating it
    // as a module would put a function name where a file belongs.
    if (location !== undefined && (location.includes('/') || location.includes('\\'))) {
      frames.push(toFrame('<anonymous>', location))
    }
  }

  return frames
}

/**
 * Order matters. A UUID contains digit runs and a hex run, so replacing digits first would
 * shred it into placeholders that no longer match another UUID's.
 */
export function normalizeMessage(message: string): string {
  return message.replace(UUID, '<uuid>').replace(HEX, '<hex>').replace(DIGITS, '<n>').trim()
}

export interface FingerprintInput {
  /** The error's constructor name — `TypeError`, `Error`, or whatever the thrower called it. */
  type: string
  message: string
  stack?: string | undefined
  /** The client's escape hatch (§7). Overrides everything else. */
  fingerprint?: string | undefined
}

export interface Fingerprinted {
  fingerprint: string
  culprit: string | null
}

function describe(frame: Frame | undefined): string | null {
  return frame === undefined ? null : `${frame.fn} (${frame.module})`
}

export function fingerprintOf(input: FingerprintInput): Fingerprinted {
  const frames = input.stack === undefined ? [] : parseFrames(input.stack)
  const own = frames.filter((frame) => !frame.vendor)

  // The owner's code names the issue. With none — an error thrown wholly inside a dependency —
  // the top frame is all there is, and it is better than nothing.
  const culprit = describe(own[0] ?? frames[0])

  const explicit = input.fingerprint?.trim()
  if (explicit !== undefined && explicit !== '') {
    // Domain-separated, so caller-chosen text cannot be crafted to equal a computed body.
    return { fingerprint: sha256(`explicit\n${explicit}`), culprit }
  }

  // Vendor frames are skipped so a dependency upgrade does not split every issue in the
  // project. When they are all there is, they are used rather than hashing the type alone.
  const chosen = (own.length > 0 ? own : frames).slice(0, FRAMES_IN_FINGERPRINT)

  const body =
    chosen.length > 0
      ? chosen.map((frame) => `${frame.fn}@${frame.module}`).join('\n')
      : normalizeMessage(input.message)

  return { fingerprint: sha256(`${input.type}\n${body}`), culprit }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run tests/unit/fingerprint.test.ts`
Expected: PASS, 24 tests.

- [ ] **Step 5: Commit**

```bash
./run check
git add -A
git commit -m "$(cat <<'EOF'
feat(fingerprint): group occurrences by type and normalized stack frames

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---
