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
characters. **The subject line is the whole message: no body, no footers, no `Co-Authored-By`
trailer** — the reference application's rule, settled on 2026-09-08 as the shared one across
every project. Reasoning that outlives a commit belongs in `docs/architecture.md` or a spec,
and a change that seems to need a paragraph is a change that wants splitting.

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

- [ ] **Step 1: Write the root files**

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

  it('fills the §6 caps with the spec defaults', () => {
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
git commit -m "build: scaffold the workspace and validated configuration"
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
git commit -m "feat(db): add the slice-1 schema, migration runner and test harness"
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
git commit -m "feat(fingerprint): group occurrences by type and normalized stack frames"
```

---

### Task 4: The application, the error handler, and single-owner auth

Copied from the reference application's auth module, with one deliberate change: the guard's
origin check and its session check are both scoped to `/api/`, because `/ingest/*` authenticates
with a bearer key and must never be asked for a cookie or an `Origin`.

**Files:**
- Create: `server/src/shared/errors.ts`, `server/src/shared/schemas.ts`
- Create: `server/src/modules/auth/password.ts`, `owner.repository.ts`,
  `session.repository.ts`, `auth.service.ts`, `guard.ts`, `auth.routes.ts`
- Create: `server/src/app.ts`, `server/src/server.ts`
- Modify: `server/tests/integration/helpers.ts` — add `buildTestApp`
- Create: `server/tests/integration/auth-helper.ts`
- Test: `server/tests/unit/password.test.ts`, `server/tests/integration/auth.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 1); `Database`, `createDb`, `getTestDb`, `resetDb` (Task 2).
- Produces:
  - `abstract class AppError` with `readonly statusCode: number`, `readonly code: string`,
    `readonly details?: Record<string, unknown>`; subclasses `ValidationError` (400,
    `validation_error`), `NotFoundError` (404, `not_found`), `ConflictError` (409, `conflict`),
    `PayloadTooLargeError` (413, `payload_too_large`); and `registerErrorHandler(app)`.
  - `NonBlankString({ maxLength })` from `shared/schemas.ts`.
  - `UnauthorizedError` (401, `unauthorized`) and `ForbiddenOriginError` (403,
    `forbidden_origin`) from `modules/auth/guard.ts`; `registerGuard(app, service)`.
  - `hashPassword(password)`, `verifyPassword(password, stored)`.
  - `AuthService` with `signIn(password)`, `resolve(token)`, `signOut(sessionId)`.
  - `registerAuth(instance): Promise<void>`.
  - `interface AppDeps { config: Config; db: Kysely<Database> }` and
    `buildApp(deps: AppDeps): Promise<FastifyInstance>` from `server/src/app.ts`.
  - `buildTestApp(overrides?: { config?: Partial<Config> }): Promise<FastifyInstance>` and
    `signIn(app): Promise<Record<string, string>>` from the test helpers.
  - `request.sessionId: string` and the route config flag `public?: true` on Fastify.

- [ ] **Step 1: Write the failing password test**

`server/tests/unit/password.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from '../../src/modules/auth/password.js'

describe('the owner password', () => {
  it('accepts the password it hashed', async () => {
    const stored = await hashPassword('correct horse battery staple')
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true)
  })

  it('rejects a different one', async () => {
    const stored = await hashPassword('correct horse battery staple')
    expect(await verifyPassword('incorrect horse', stored)).toBe(false)
  })

  it('refuses to hash a password too short to be worth stretching', async () => {
    await expect(hashPassword('short')).rejects.toThrow(/at least 12/)
  })

  // A malformed stored hash is a failed login, not a 500 the owner cannot act on.
  it('treats an unreadable stored hash as a failed login', async () => {
    expect(await verifyPassword('anything', 'not a hash')).toBe(false)
  })

  it('salts, so the same password hashes differently twice', async () => {
    const password = 'correct horse battery staple'
    expect(await hashPassword(password)).not.toBe(await hashPassword(password))
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npx vitest run tests/unit/password.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `shared/errors.ts`, `shared/schemas.ts` and the auth module**

`server/src/shared/errors.ts`:

```ts
import type { FastifyError, FastifyInstance } from 'fastify'

export abstract class AppError extends Error {
  abstract readonly statusCode: number
  abstract readonly code: string
  readonly details?: Record<string, unknown>

  constructor(message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = new.target.name
    if (details !== undefined) this.details = details
  }
}

export class ValidationError extends AppError {
  readonly statusCode = 400
  readonly code = 'validation_error'
}

export class NotFoundError extends AppError {
  readonly statusCode = 404
  readonly code = 'not_found'
}

export class ConflictError extends AppError {
  readonly statusCode = 409
  readonly code = 'conflict'
}

/**
 * §6: an oversize batch, stack or context is refused rather than truncated and kept. A stack
 * cut in half fingerprints differently from the same stack whole, which would split one issue
 * into two by payload size alone.
 */
export class PayloadTooLargeError extends AppError {
  readonly statusCode = 413
  readonly code = 'payload_too_large'
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      void reply.status(error.statusCode).send({
        error: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      })
      return
    }
    if (error.validation) {
      void reply.status(400).send({
        error: 'validation_error',
        message: error.message,
        details: { issues: error.validation },
      })
      return
    }
    if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      void reply.status(error.statusCode).send({ error: 'bad_request', message: error.message })
      return
    }
    request.log.error({ err: error }, 'unhandled error')
    void reply.status(500).send({ error: 'internal_error', message: 'Internal server error' })
  })

  // The not-found handler is set in app.ts instead: Fastify allows exactly one per instance,
  // and it has to answer JSON under /api and /ingest and the SPA's index.html everywhere else.
}
```

Task 8 adds one line to this handler for §13. Leave room for it; do not add it yet.

`server/src/shared/schemas.ts`:

```ts
import { Type } from 'typebox'

/**
 * `minLength: 1` accepts `"   "`, which then reaches the database and trips a check constraint
 * — a 500 for what is plainly a bad request. Requiring one non-space character keeps the
 * refusal at the boundary, where it can name the field.
 *
 * The return type is inferred rather than widened to `TSchema`: the type provider reads the
 * concrete schema to type `request.body`, and a widened one leaves every field `unknown`.
 */
export function NonBlankString(options: { maxLength: number }) {
  return Type.String({ minLength: 1, pattern: '\\S', maxLength: options.maxLength })
}
```

`server/src/modules/auth/password.ts`:

```ts
import { hash, verify } from '@node-rs/argon2'

const MIN_LENGTH = 12

/**
 * Argon2id, deliberately unlike the SHA-256 over ingest keys. There the secret carries 256 bits
 * from a CSPRNG and there is nothing to brute-force; here it is a phrase a person chose, and
 * making each guess expensive is the whole defence.
 */
export async function hashPassword(password: string): Promise<string> {
  if (password.trim().length < MIN_LENGTH) {
    throw new Error(`The password must be at least ${MIN_LENGTH} characters`)
  }
  return hash(password)
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    return await verify(stored, password)
  } catch {
    // A malformed stored hash is a failed login, not a 500.
    return false
  }
}
```

`server/src/modules/auth/owner.repository.ts`:

```ts
import type { Kysely, Selectable } from 'kysely'
import type { Database, OwnersTable } from '../../db/schema.js'

export type Owner = Selectable<OwnersTable>

/**
 * Login asks for a password and no identifier, which identifies a person only while there is
 * exactly one owner. Two rows is not a login failure — it is that assumption expiring, and it
 * belongs in the log as a defect rather than being silently resolved by trying each hash.
 */
export async function theOnlyOwner(db: Kysely<Database>): Promise<Owner | undefined> {
  const owners = await db.selectFrom('owners').selectAll().limit(2).execute()
  if (owners.length > 1) {
    throw new Error('More than one owner exists, and login has no way to tell them apart')
  }
  return owners[0]
}
```

`server/src/modules/auth/session.repository.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto'
import type { Kysely } from 'kysely'
import type { Database } from '../../db/schema.js'

export interface Session {
  id: string
  ownerId: string
  expiresAt: Date
  lastSeenAt: Date
}

/**
 * Only ever the hash reaches the database. A leaked backup then contains nothing that can be
 * presented as a live session — the same reason ingest keys are stored digested.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function mintToken(): string {
  return randomBytes(32).toString('base64url')
}

export async function insertSession(
  db: Kysely<Database>,
  ownerId: string,
  token: string,
  expiresAt: Date,
): Promise<void> {
  await db
    .insertInto('sessions')
    .values({ owner_id: ownerId, token_hash: hashToken(token), expires_at: expiresAt })
    .execute()
}

export async function findLiveSession(
  db: Kysely<Database>,
  token: string,
): Promise<Session | undefined> {
  const row = await db
    .selectFrom('sessions')
    .select(['id', 'owner_id', 'expires_at', 'last_seen_at'])
    .where('token_hash', '=', hashToken(token))
    .where('expires_at', '>', new Date())
    .executeTakeFirst()

  return row === undefined
    ? undefined
    : {
        id: row.id,
        ownerId: row.owner_id,
        expiresAt: row.expires_at,
        lastSeenAt: row.last_seen_at,
      }
}

export async function slideSession(
  db: Kysely<Database>,
  id: string,
  expiresAt: Date,
): Promise<void> {
  await db
    .updateTable('sessions')
    .set({ expires_at: expiresAt, last_seen_at: new Date() })
    .where('id', '=', id)
    .execute()
}

export async function deleteSession(db: Kysely<Database>, id: string): Promise<void> {
  await db.deleteFrom('sessions').where('id', '=', id).execute()
}
```

`server/src/modules/auth/auth.service.ts`:

```ts
import type { Kysely } from 'kysely'
import type { Database } from '../../db/schema.js'
import { hashPassword, verifyPassword } from './password.js'
import { theOnlyOwner } from './owner.repository.js'
import {
  deleteSession,
  findLiveSession,
  insertSession,
  mintToken,
  slideSession,
  type Session,
} from './session.repository.js'

/**
 * Verified against when no owner exists, so an unconfigured server does not answer a login
 * attempt noticeably faster than a configured one. Without it the absence of a password is
 * readable from the clock even though every response body says the same thing.
 *
 * Built on first use rather than at import, so hashing it does not delay startup.
 */
let dummyHash: Promise<string> | undefined
function theDummyHash(): Promise<string> {
  dummyHash ??= hashPassword('a password nobody has, of a believable length')
  return dummyHash
}

const HOUR_MS = 3_600_000

export class AuthService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly ttlDays: number,
  ) {}

  private expiryFromNow(): Date {
    return new Date(Date.now() + this.ttlDays * 24 * HOUR_MS)
  }

  /** The token, or undefined when the password does not match — including when none is set. */
  async signIn(password: string): Promise<string | undefined> {
    const owner = await theOnlyOwner(this.db)

    if (owner === undefined) {
      await verifyPassword(password, await theDummyHash())
      return undefined
    }
    if (!(await verifyPassword(password, owner.password_hash))) return undefined

    const token = mintToken()
    await insertSession(this.db, owner.id, token, this.expiryFromNow())
    return token
  }

  async resolve(token: string): Promise<Session | undefined> {
    const session = await findLiveSession(this.db, token)
    if (session === undefined) return undefined

    // Slid at most once an hour rather than on every request: a write on every read turns a
    // read-only screen into write traffic.
    if (Date.now() - session.lastSeenAt.getTime() > HOUR_MS) {
      await slideSession(this.db, session.id, this.expiryFromNow())
    }
    return session
  }

  async signOut(sessionId: string): Promise<void> {
    await deleteSession(this.db, sessionId)
  }
}
```

`server/src/modules/auth/guard.ts` — note both hooks return early for anything outside `/api/`:

```ts
import type { FastifyInstance } from 'fastify'
import { AppError } from '../../shared/errors.js'
import type { AuthService } from './auth.service.js'

export class UnauthorizedError extends AppError {
  readonly statusCode = 401
  readonly code = 'unauthorized'
}

export class ForbiddenOriginError extends AppError {
  readonly statusCode = 403
  readonly code = 'forbidden_origin'
}

declare module 'fastify' {
  interface FastifyRequest {
    sessionId: string
  }
  interface FastifyContextConfig {
    public?: true
  }
}

export function registerGuard(app: FastifyInstance, service: AuthService): void {
  app.decorateRequest('sessionId', '')

  // Compared against the host the request was addressed to rather than a configured origin, so
  // the check keeps working behind a proxy and on an ephemeral test port.
  //
  // Scoped to /api/ deliberately. `/ingest/*` carries a bearer key and no cookie, so it has no
  // CSRF exposure to defend; applying this here would reject a browser's report out of hand and
  // pre-empt the origin policy Slice 4 gives ingest of its own.
  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/api/')) return
    if (request.method === 'GET' || request.method === 'HEAD') return
    const origin = request.headers.origin
    if (origin === undefined) return
    const host = request.headers.host
    if (host === undefined || new URL(origin).host !== host) {
      throw new ForbiddenOriginError('This request did not come from the dashboard')
    }
  })

  app.addHook('onRequest', async (request) => {
    // Only the API is guarded. The SPA's own HTML and bundle must load without a session — the
    // page is what shows the login form — and `/ingest/*` authenticates with a key instead.
    if (!request.url.startsWith('/api/')) return
    if (request.routeOptions.config?.public === true) return

    const token = request.cookies.session
    if (token === undefined) throw new UnauthorizedError('Sign in first')

    const session = await service.resolve(token)
    if (session === undefined) throw new UnauthorizedError('Sign in first')

    request.sessionId = session.id
  })
}
```

`server/src/modules/auth/auth.routes.ts`:

```ts
import { Type } from 'typebox'
import type { FastifyInstance } from 'fastify'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { AuthService } from './auth.service.js'
import { registerGuard, UnauthorizedError } from './guard.js'

const LoginBody = Type.Object(
  { password: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
)

export async function registerAuth(instance: FastifyInstance): Promise<void> {
  // Re-applied here because the provider does not survive being passed as a plain
  // FastifyInstance, and without it a validated body arrives typed as `unknown`.
  const app = instance.withTypeProvider<TypeBoxTypeProvider>()
  const service = new AuthService(app.db, app.config.sessionTtlDays)

  await app.register(import('@fastify/cookie'))
  await app.register(import('@fastify/rate-limit'), { global: false })

  registerGuard(app, service)

  app.post(
    '/api/login',
    {
      schema: { body: LoginBody },
      config: {
        public: true,
        rateLimit: { max: app.config.loginAttemptsPerMinute, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const token = await service.signIn(request.body.password)
      // One answer whether the password was wrong or none has ever been set: which of the two
      // it is must not be readable from outside.
      if (token === undefined) throw new UnauthorizedError('Wrong password')

      void reply
        .setCookie('session', token, {
          httpOnly: true,
          sameSite: 'lax',
          // Off in tests and on http://localhost; a Secure cookie is simply not stored there.
          secure: process.env.NODE_ENV === 'production',
          path: '/',
          maxAge: app.config.sessionTtlDays * 24 * 60 * 60,
        })
        .status(204)
        .send()
    },
  )

  app.post('/api/logout', async (request, reply) => {
    await service.signOut(request.sessionId)
    void reply.clearCookie('session', { path: '/' }).status(204).send()
  })

  app.get('/api/me', async () => ({ signedIn: true }))
}
```

- [ ] **Step 4: Write `app.ts` and `server.ts`**

`server/src/app.ts` — Tasks 5, 6 and 7 each add one `register*` line here:

```ts
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import type { Kysely } from 'kysely'
import type { Config } from './config.js'
import type { Database } from './db/schema.js'
import { registerErrorHandler } from './shared/errors.js'
import { registerAuth } from './modules/auth/auth.routes.js'

export interface AppDeps {
  config: Config
  db: Kysely<Database>
}

declare module 'fastify' {
  interface FastifyInstance {
    db: Kysely<Database>
    config: Config
  }
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: deps.config.logLevel,
      // An ingest key travels in this header on every report; a logged request from a debugging
      // session would outlive the key it belongs to.
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    ajv: { customOptions: { removeAdditional: false } },
  }).withTypeProvider<TypeBoxTypeProvider>()

  app.decorate('db', deps.db)
  app.decorate('config', deps.config)
  registerErrorHandler(app)

  app.get('/api/health', { config: { public: true } }, async () => ({ status: 'ok' }))

  await registerAuth(app)

  await registerSpa(app)

  return app
}

/**
 * The dashboard is served by the same origin as the API: one deployable, no CORS, and the
 * session cookie needs no cross-site relaxation. Unknown paths fall through to index.html so a
 * client-side route survives a reload.
 */
async function registerSpa(app: FastifyInstance): Promise<void> {
  // `src/` under tsx, `dist/src/` once compiled. Both are checked rather than guessed at,
  // because guessing wrong shows an empty page in exactly one of the two environments.
  const root = [
    resolve(import.meta.dirname, '../public'),
    resolve(import.meta.dirname, '../../public'),
  ].find((candidate) => existsSync(join(candidate, 'index.html')))

  if (root !== undefined) {
    await app.register(fastifyStatic, { root, index: ['index.html'] })
  } else {
    // The API suites run without a build, and a missing bundle must not stop the server from
    // answering /api or /ingest.
    app.log.warn('no dashboard build to serve; run npm run --workspace web build')
  }

  app.setNotFoundHandler((request, reply) => {
    const isApi = request.url.startsWith('/api/') || request.url.startsWith('/ingest/')
    if (isApi || root === undefined) {
      return reply.status(404).send({ error: 'not_found', message: 'Route not found' })
    }
    return reply.sendFile('index.html')
  })
}
```

`server/src/server.ts`:

```ts
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { createDb } from './db/client.js'

const config = loadConfig(process.env)
const db = createDb(config.databaseUrl)
const app = await buildApp({ config, db })

app.addHook('onClose', async () => {
  await db.destroy()
})

try {
  await app.listen({ port: config.port, host: '0.0.0.0' })
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
```

- [ ] **Step 5: Extend the test helpers**

Append to `server/tests/integration/helpers.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.js'
import type { Config } from '../../src/config.js'

/** Built the way `server.ts` builds it, against the one Testcontainers database. */
export async function buildTestApp(
  overrides: { config?: Partial<Config> } = {},
): Promise<FastifyInstance> {
  const config: Config = {
    databaseUrl: inject('databaseUrl'),
    port: 0,
    sessionTtlDays: 30,
    // High enough that a suite signing in on nearly every case does not race the limit.
    // `auth.test.ts` builds its own app with a low one to prove the limit still bites.
    loginAttemptsPerMinute: 1_000,
    logLevel: 'silent',
    maxEventsPerBatch: 100,
    maxStackBytes: 16_384,
    maxContextBytes: 8_192,
    ...overrides.config,
  }

  const app = await buildApp({ config, db: getTestDb() })
  await app.ready()
  return app
}
```

`server/tests/integration/auth-helper.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import { getTestDb } from './helpers.js'
import { hashPassword } from '../../src/modules/auth/password.js'

export const PASSWORD = 'correct horse battery staple'

/**
 * Seeds the owner and signs in, so every suite that is not about authentication says `cookies`
 * and nothing more.
 */
export async function signIn(app: FastifyInstance): Promise<Record<string, string>> {
  await getTestDb()
    .insertInto('owners')
    .values({ label: 'The owner', password_hash: await hashPassword(PASSWORD) })
    .execute()

  const response = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { password: PASSWORD },
  })
  const cookie = response.cookies.find((c) => c.name === 'session')
  if (cookie === undefined) throw new Error(`Could not sign in: ${response.statusCode}`)
  return { session: cookie.value }
}
```

- [ ] **Step 6: Write the auth integration test**

`server/tests/integration/auth.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, getTestDb, resetDb } from './helpers.js'
import { PASSWORD } from './auth-helper.js'
import { hashPassword } from '../../src/modules/auth/password.js'

let app: FastifyInstance

beforeAll(async () => {
  app = await buildTestApp()
})
beforeEach(async () => {
  await resetDb()
  await getTestDb()
    .insertInto('owners')
    .values({ label: 'The owner', password_hash: await hashPassword(PASSWORD) })
    .execute()
})
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

const login = (password = PASSWORD) =>
  app.inject({ method: 'POST', url: '/api/login', payload: { password } })

const sessionCookie = async () => {
  const cookie = (await login()).cookies.find((c) => c.name === 'session')
  if (cookie === undefined) throw new Error('no session cookie')
  return { session: cookie.value }
}

describe('login', () => {
  it('sets an httpOnly session cookie', async () => {
    const response = await login()
    expect(response.statusCode).toBe(204)
    const cookie = response.cookies.find((c) => c.name === 'session')
    expect(cookie?.httpOnly).toBe(true)
    expect(cookie?.sameSite?.toLowerCase()).toBe('lax')
    expect(cookie?.path).toBe('/')
  })

  it('refuses the wrong password', async () => {
    const wrong = await login('nope')
    expect(wrong.statusCode).toBe(401)
    expect(wrong.json()).toEqual({ error: 'unauthorized', message: 'Wrong password' })
  })

  it('stores only a hash of the token, never the token', async () => {
    const response = await login()
    const token = response.cookies.find((c) => c.name === 'session')!.value
    const rows = await getTestDb().selectFrom('sessions').select('token_hash').execute()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.token_hash).not.toBe(token)
  })

  // Whether this server has been configured at all is not something an attacker should be able
  // to read off the login form.
  it('answers a server with no owner exactly as it answers a wrong password', async () => {
    await getTestDb().deleteFrom('owners').execute()
    const response = await login()
    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ error: 'unauthorized', message: 'Wrong password' })
  })

  // A password alone identifies nobody once there are two owners. The failure must be loud:
  // that error is the signal to add an identifier.
  it('refuses to guess when a second owner exists', async () => {
    await getTestDb()
      .insertInto('owners')
      .values({ label: 'A second owner', password_hash: await hashPassword('another password') })
      .execute()
    const response = await login()
    expect(response.statusCode).toBe(500)
    expect(await getTestDb().selectFrom('sessions').selectAll().execute()).toHaveLength(0)
  })

  it('rejects an unknown field rather than ignoring it', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { password: PASSWORD, admin: true },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('validation_error')
  })
})

describe('the login rate limit', () => {
  it('stops answering after too many attempts from one address', async () => {
    const limited = await buildTestApp({ config: { loginAttemptsPerMinute: 2 } })
    try {
      const attempt = () =>
        limited.inject({ method: 'POST', url: '/api/login', payload: { password: 'wrong' } })
      expect((await attempt()).statusCode).toBe(401)
      expect((await attempt()).statusCode).toBe(401)
      expect((await attempt()).statusCode).toBe(429)
    } finally {
      await limited.close()
    }
  })
})

describe('the guard', () => {
  it('refuses a protected route without a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401)
  })

  it('admits one with a session', async () => {
    const cookies = await sessionCookie()
    expect((await app.inject({ method: 'GET', url: '/api/me', cookies })).statusCode).toBe(200)
  })

  it('refuses a session that has been deleted — sign out everywhere works', async () => {
    const cookies = await sessionCookie()
    await getTestDb().deleteFrom('sessions').execute()
    expect((await app.inject({ method: 'GET', url: '/api/me', cookies })).statusCode).toBe(401)
  })

  it('refuses an expired session', async () => {
    const cookies = await sessionCookie()
    await getTestDb()
      .updateTable('sessions')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .execute()
    expect((await app.inject({ method: 'GET', url: '/api/me', cookies })).statusCode).toBe(401)
  })

  it('leaves health public', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200)
  })

  // The whole point of the two-credential split: an application must never be asked for a
  // cookie, and the guard must not be what stands between it and the ingest endpoint.
  it('does not ask /ingest for a session — it answers on its own terms', async () => {
    const response = await app.inject({ method: 'POST', url: '/ingest/events', payload: {} })
    expect(response.statusCode).not.toBe(401)
    expect(response.statusCode).toBe(404)
  })

  it('answers an unknown /api route with JSON rather than a page', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/nothing' })
    expect(response.json().error).toBe('not_found')
  })
})

describe('the origin check', () => {
  it('refuses a write from a foreign origin', async () => {
    const cookies = await sessionCookie()
    const response = await app.inject({
      method: 'POST',
      url: '/api/logout',
      cookies,
      headers: { origin: 'https://evil.example', host: 'vigil.example' },
    })
    expect(response.statusCode).toBe(403)
  })

  it('allows one whose origin matches the host it was addressed to', async () => {
    const cookies = await sessionCookie()
    const response = await app.inject({
      method: 'POST',
      url: '/api/logout',
      cookies,
      headers: { origin: 'https://vigil.example', host: 'vigil.example' },
    })
    expect(response.statusCode).toBe(204)
  })

  // A server reporting from another host sends no Origin and must not be judged on one.
  it('does not apply to /ingest', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/ingest/events',
      headers: { origin: 'https://an-app.example', host: 'vigil.example' },
      payload: {},
    })
    expect(response.statusCode).not.toBe(403)
  })
})
```

The two `/ingest/events` expectations assert 404 until Task 6 registers the route; they are
written as `not.toBe(401)` / `not.toBe(403)` so they keep meaning the same thing afterwards.
The one literal `toBe(404)` must be changed to `toBe(401)` in Task 6, when the route exists and
starts refusing a missing key. That edit is listed in Task 6's steps.

- [ ] **Step 7: Run both tests to verify they pass**

Run: `cd server && npx vitest run tests/unit/password.test.ts tests/integration/auth.test.ts`
Expected: PASS, 5 + 17 tests.

- [ ] **Step 8: Commit**

```bash
./run check
git add -A
git commit -m "feat(auth): add single-owner login and scope the guard to /api"
```

---

### Task 5: Ingest keys, byte guards, and the command-line setup scripts

Nothing can report until an application exists and holds a key. Slice 1 issues both from the
command line — the Settings screen that does it in a browser is §11's, and Slice 2's plan builds
it. The four `./run` scenarios written in Task 1 get their scripts here.

**Files:**
- Create: `server/src/shared/bytes.ts`
- Create: `server/src/modules/ingest/key.repository.ts`
- Create: `server/src/modules/apps/app.repository.ts`
- Create: `server/scripts/set-password.ts`, `add-app.ts`, `issue-key.ts`, `setup-state.ts`
- Test: `server/tests/unit/bytes.test.ts`, `server/tests/integration/ingest-keys.test.ts`

**Interfaces:**
- Consumes: `Database`, `getTestDb`, `resetDb` (Task 2); `hashPassword` (Task 4);
  `PayloadTooLargeError` (Task 4).
- Produces:
  - `byteLength(value: string): number` and
    `guardBytes(value: string, limit: number, what: string): void` from `shared/bytes.ts`.
    `guardBytes` throws `PayloadTooLargeError` naming `what`.
  - From `modules/ingest/key.repository.ts`:
    - `mintIngestKey(): string` — `vgl_` + 32 random bytes, base64url.
    - `hashIngestKey(token: string): string` — SHA-256 hex.
    - `interface LiveKey { id: string; appId: string; appSlug: string; kind: 'server' | 'browser' }`
    - `findLiveKey(db, token): Promise<LiveKey | undefined>`
    - `touchKey(db, id): Promise<void>`
    - `insertKey(db, appId, kind, token): Promise<string>` — returns the new key's id.
  - From `modules/apps/app.repository.ts`:
    - `interface AppRow { id: string; slug: string; name: string }`
    - `listApps(db): Promise<AppRow[]>`
    - `findAppBySlug(db, slug): Promise<AppRow | undefined>`
    - `insertApp(db, slug, name): Promise<AppRow>`

- [ ] **Step 1: Write the failing byte test**

`server/tests/unit/bytes.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { byteLength, guardBytes } from '../../src/shared/bytes.js'
import { PayloadTooLargeError } from '../../src/shared/errors.js'

describe('byteLength', () => {
  // The caps in §6 are byte caps. A stack full of non-ASCII identifiers is longer in bytes than
  // in characters, and measuring characters would let it through.
  it('counts bytes, not characters', () => {
    expect(byteLength('abc')).toBe(3)
    expect(byteLength('дом')).toBe(6)
    expect(byteLength('🙂')).toBe(4)
  })
})

describe('guardBytes', () => {
  it('passes a value at exactly the limit', () => {
    expect(() => guardBytes('abcd', 4, 'stack')).not.toThrow()
  })

  it('refuses one byte over, and names what was too big', () => {
    expect(() => guardBytes('abcde', 4, 'stack')).toThrow(PayloadTooLargeError)
    expect(() => guardBytes('abcde', 4, 'stack')).toThrow(/stack/)
  })

  // §6: rejected, not truncated and kept. A stack cut in half fingerprints differently from
  // the same stack whole, which would split one issue into two by payload size alone.
  it('answers 413 rather than trimming', () => {
    try {
      guardBytes('abcde', 4, 'stack')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as PayloadTooLargeError).statusCode).toBe(413)
      expect((error as PayloadTooLargeError).code).toBe('payload_too_large')
    }
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npx vitest run tests/unit/bytes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `server/src/shared/bytes.ts`**

```ts
import { PayloadTooLargeError } from './errors.js'

/**
 * The §6 caps are byte caps, and a JavaScript string's `length` is neither bytes nor
 * characters. A stack full of non-ASCII identifiers measures shorter by `length` than it costs
 * to store, and measuring that way would let it through.
 */
export function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

export function guardBytes(value: string, limit: number, what: string): void {
  const size = byteLength(value)
  if (size > limit) {
    throw new PayloadTooLargeError(`This ${what} is ${size} bytes; the limit is ${limit}`, {
      what,
      size,
      limit,
    })
  }
}
```

- [ ] **Step 4: Write the failing ingest-key test**

`server/tests/integration/ingest-keys.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { closeTestDb, getTestDb, resetDb } from './helpers.js'
import {
  findLiveKey,
  hashIngestKey,
  insertKey,
  mintIngestKey,
  touchKey,
} from '../../src/modules/ingest/key.repository.js'
import { insertApp, findAppBySlug, listApps } from '../../src/modules/apps/app.repository.js'

const db = () => getTestDb()

beforeEach(async () => {
  await resetDb()
})
afterAll(async () => {
  await closeTestDb()
})

describe('minting', () => {
  it('produces a prefixed token nobody will mistake for something else', () => {
    expect(mintIngestKey()).toMatch(/^vgl_[A-Za-z0-9_-]{43}$/)
  })

  it('never produces the same token twice', () => {
    const seen = new Set(Array.from({ length: 500 }, () => mintIngestKey()))
    expect(seen.size).toBe(500)
  })

  it('digests to sha256 hex', () => {
    expect(hashIngestKey('vgl_whatever')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('storage', () => {
  it('stores only the digest, so a lost key is reissued and never recovered', async () => {
    const app = await insertApp(db(), 'reference', 'The reference application')
    const token = mintIngestKey()
    await insertKey(db(), app.id, 'server', token)

    const rows = await db().selectFrom('ingest_keys').select('token_sha256').execute()
    expect(rows[0]!.token_sha256).toBe(hashIngestKey(token))
    expect(rows[0]!.token_sha256).not.toContain(token)
  })

  // The property the whole trust boundary rests on: the key says which application this is.
  it('resolves a token to its own application and nobody else', async () => {
    const mine = await insertApp(db(), 'mine', 'Mine')
    await insertApp(db(), 'yours', 'Yours')
    const token = mintIngestKey()
    await insertKey(db(), mine.id, 'server', token)

    const resolved = await findLiveKey(db(), token)
    expect(resolved).toMatchObject({ appId: mine.id, appSlug: 'mine', kind: 'server' })
  })

  it('does not resolve an unknown token', async () => {
    expect(await findLiveKey(db(), mintIngestKey())).toBeUndefined()
  })

  it('does not resolve a revoked one', async () => {
    const app = await insertApp(db(), 'reference', 'The reference application')
    const token = mintIngestKey()
    const id = await insertKey(db(), app.id, 'server', token)
    await db().updateTable('ingest_keys').set({ revoked_at: new Date() }).where('id', '=', id).execute()

    expect(await findLiveKey(db(), token)).toBeUndefined()
  })

  // Rotation without downtime: issue the new key, deploy, revoke the old one. Two live keys for
  // an afternoon is the reason keys are a table and not a column.
  it('resolves two live keys for one application at the same time', async () => {
    const app = await insertApp(db(), 'reference', 'The reference application')
    const older = mintIngestKey()
    const newer = mintIngestKey()
    await insertKey(db(), app.id, 'server', older)
    await insertKey(db(), app.id, 'server', newer)

    expect((await findLiveKey(db(), older))?.appId).toBe(app.id)
    expect((await findLiveKey(db(), newer))?.appId).toBe(app.id)
  })
})

describe('last_used_at', () => {
  it('is stamped on first use', async () => {
    const app = await insertApp(db(), 'reference', 'The reference application')
    const token = mintIngestKey()
    const id = await insertKey(db(), app.id, 'server', token)
    expect((await db().selectFrom('ingest_keys').select('last_used_at').executeTakeFirstOrThrow()).last_used_at).toBeNull()

    await touchKey(db(), id)
    const row = await db().selectFrom('ingest_keys').select('last_used_at').executeTakeFirstOrThrow()
    expect(row.last_used_at).not.toBeNull()
  })

  // A write on every report would turn the busiest path in the system into write traffic for a
  // column nobody reads more than once a day.
  it('is not rewritten on every use', async () => {
    const app = await insertApp(db(), 'reference', 'The reference application')
    const id = await insertKey(db(), app.id, 'server', mintIngestKey())
    await touchKey(db(), id)
    const first = (await db().selectFrom('ingest_keys').select('last_used_at').executeTakeFirstOrThrow()).last_used_at

    await touchKey(db(), id)
    const second = (await db().selectFrom('ingest_keys').select('last_used_at').executeTakeFirstOrThrow()).last_used_at
    expect(second).toEqual(first)
  })

  it('is rewritten once the hour has passed', async () => {
    const app = await insertApp(db(), 'reference', 'The reference application')
    const id = await insertKey(db(), app.id, 'server', mintIngestKey())
    await touchKey(db(), id)
    await sql`update ingest_keys set last_used_at = now() - interval '2 hours'`.execute(db())

    await touchKey(db(), id)
    const row = await db().selectFrom('ingest_keys').select('last_used_at').executeTakeFirstOrThrow()
    expect(row.last_used_at!.getTime()).toBeGreaterThan(Date.now() - 60_000)
  })
})

describe('applications', () => {
  it('finds one by slug', async () => {
    const created = await insertApp(db(), 'reference', 'The reference application')
    expect(await findAppBySlug(db(), 'reference')).toEqual(created)
    expect(await findAppBySlug(db(), 'absent')).toBeUndefined()
  })

  it('lists them by slug, with vigil itself among them', async () => {
    await insertApp(db(), 'zeta', 'Zeta')
    await insertApp(db(), 'alpha', 'Alpha')
    expect((await listApps(db())).map((a) => a.slug)).toEqual(['alpha', 'vigil', 'zeta'])
  })
})
```

- [ ] **Step 5: Run it to verify it fails**

Run: `cd server && npx vitest run tests/integration/ingest-keys.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 6: Write the two repositories**

`server/src/modules/apps/app.repository.ts`:

```ts
import type { Kysely } from 'kysely'
import type { Database } from '../../db/schema.js'

export interface AppRow {
  id: string
  slug: string
  name: string
}

export async function listApps(db: Kysely<Database>): Promise<AppRow[]> {
  return db.selectFrom('apps').select(['id', 'slug', 'name']).orderBy('slug').execute()
}

export async function findAppBySlug(
  db: Kysely<Database>,
  slug: string,
): Promise<AppRow | undefined> {
  return db
    .selectFrom('apps')
    .select(['id', 'slug', 'name'])
    .where('slug', '=', slug)
    .executeTakeFirst()
}

export async function insertApp(
  db: Kysely<Database>,
  slug: string,
  name: string,
): Promise<AppRow> {
  return db
    .insertInto('apps')
    .values({ slug, name })
    .returning(['id', 'slug', 'name'])
    .executeTakeFirstOrThrow()
}
```

`server/src/modules/ingest/key.repository.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import type { Database } from '../../db/schema.js'

/**
 * A prefix so a key found in a log or a config file is recognisable as vigil's, and 256 bits
 * from a CSPRNG because that is the whole of its strength. There is no entropy problem to
 * stretch here, which is why the digest below is SHA-256 and not argon2.
 */
export function mintIngestKey(): string {
  return `vgl_${randomBytes(32).toString('base64url')}`
}

export function hashIngestKey(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export interface LiveKey {
  id: string
  appId: string
  /** Carried so a log line can name the application without a second query. */
  appSlug: string
  kind: 'server' | 'browser'
}

export async function findLiveKey(
  db: Kysely<Database>,
  token: string,
): Promise<LiveKey | undefined> {
  // Looked up by digest, which is why the digest is directly indexable. A revoked key is
  // resolved to nothing rather than deleted, so the row remains as a record it existed.
  const row = await db
    .selectFrom('ingest_keys')
    .innerJoin('apps', 'apps.id', 'ingest_keys.app_id')
    .select(['ingest_keys.id as id', 'ingest_keys.app_id as app_id', 'ingest_keys.kind as kind', 'apps.slug as slug'])
    .where('ingest_keys.token_sha256', '=', hashIngestKey(token))
    .where('ingest_keys.revoked_at', 'is', null)
    .executeTakeFirst()

  return row === undefined
    ? undefined
    : { id: row.id, appId: row.app_id, appSlug: row.slug, kind: row.kind }
}

/**
 * Lazily, at most once an hour, in one statement with no read first. Ingest is the busiest path
 * in the system; a write on every report would make a column nobody reads more than once a day
 * the most-written thing in the database.
 */
export async function touchKey(db: Kysely<Database>, id: string): Promise<void> {
  await sql`
    update ingest_keys
       set last_used_at = now()
     where id = ${id}
       and (last_used_at is null or last_used_at < now() - interval '1 hour')
  `.execute(db)
}

export async function insertKey(
  db: Kysely<Database>,
  appId: string,
  kind: 'server' | 'browser',
  token: string,
): Promise<string> {
  const row = await db
    .insertInto('ingest_keys')
    .values({ app_id: appId, kind, token_sha256: hashIngestKey(token) })
    .returning('id')
    .executeTakeFirstOrThrow()
  return row.id
}
```

- [ ] **Step 7: Run both tests to verify they pass**

Run: `cd server && npx vitest run tests/unit/bytes.test.ts tests/integration/ingest-keys.test.ts`
Expected: PASS, 3 + 12 tests.

- [ ] **Step 8: Write the four scripts**

`server/scripts/setup-state.ts` — read by `./run start`, prints one line:

```ts
import { createDb } from '../src/db/client.js'

const databaseUrl = process.env.DATABASE_URL?.trim()
if (databaseUrl === undefined || databaseUrl === '') throw new Error('DATABASE_URL is required')

const db = createDb(databaseUrl)
try {
  const owners = await db.selectFrom('owners').select('id').limit(1).execute()
  // The seeded `vigil` row is not an application anyone has connected, so it does not count.
  const apps = await db.selectFrom('apps').select('id').where('slug', '!=', 'vigil').limit(1).execute()
  console.log(
    `owner=${owners.length > 0 ? 'present' : 'missing'} apps=${apps.length > 0 ? 'present' : 'missing'}`,
  )
} finally {
  await db.destroy()
}
```

`server/scripts/set-password.ts` — reads from a pipe or a TTY:

```ts
import { createInterface } from 'node:readline/promises'
import { createDb } from '../src/db/client.js'
import { hashPassword } from '../src/modules/auth/password.js'

const databaseUrl = process.env.DATABASE_URL?.trim()
if (databaseUrl === undefined || databaseUrl === '') throw new Error('DATABASE_URL is required')

async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks).toString('utf8').trim()
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question('New owner password (at least 12 characters): ')).trim()
  } finally {
    rl.close()
  }
}

const password = await readPassword()
const db = createDb(databaseUrl)
try {
  const hash = await hashPassword(password)
  const owner = await db.selectFrom('owners').select('id').executeTakeFirst()

  if (owner === undefined) {
    await db.insertInto('owners').values({ label: 'The owner', password_hash: hash }).execute()
  } else {
    await db
      .updateTable('owners')
      .set({ password_hash: hash, updated_at: new Date() })
      .where('id', '=', owner.id)
      .execute()
  }

  // Changing the password signs every device out: a password change that leaves live sessions
  // behind does not do the one thing it is usually reached for.
  await db.deleteFrom('sessions').execute()
  console.log('Password set. Every device has been signed out.')
} finally {
  await db.destroy()
}
```

`server/scripts/add-app.ts`:

```ts
import { createDb } from '../src/db/client.js'
import { findAppBySlug, insertApp } from '../src/modules/apps/app.repository.js'

const databaseUrl = process.env.DATABASE_URL?.trim()
if (databaseUrl === undefined || databaseUrl === '') throw new Error('DATABASE_URL is required')

const [slug, ...rest] = process.argv.slice(2)
const name = rest.join(' ').trim()

if (slug === undefined || name === '') {
  console.error('Usage: ./run app:add <slug> <name>')
  console.error('Example: ./run app:add reference The reference application')
  process.exit(1)
}

const db = createDb(databaseUrl)
try {
  if ((await findAppBySlug(db, slug)) !== undefined) {
    console.error(`An application with the slug "${slug}" already exists.`)
    process.exit(1)
  }
  const app = await insertApp(db, slug, name)
  console.log(`Added ${app.slug} (${app.name}).`)
  console.log(`Issue it a key next:  ./run key:issue ${app.slug}`)
} finally {
  await db.destroy()
}
```

`server/scripts/issue-key.ts`:

```ts
import { createDb } from '../src/db/client.js'
import { findAppBySlug } from '../src/modules/apps/app.repository.js'
import { insertKey, mintIngestKey } from '../src/modules/ingest/key.repository.js'

const databaseUrl = process.env.DATABASE_URL?.trim()
if (databaseUrl === undefined || databaseUrl === '') throw new Error('DATABASE_URL is required')

const slug = process.argv[2]
if (slug === undefined) {
  console.error('Usage: ./run key:issue <slug>')
  process.exit(1)
}

const db = createDb(databaseUrl)
try {
  const app = await findAppBySlug(db, slug)
  if (app === undefined) {
    console.error(`No application with the slug "${slug}". Add it first:  ./run app:add ${slug} <name>`)
    process.exit(1)
  }

  const token = mintIngestKey()
  await insertKey(db, app.id, 'server', token)

  // Said plainly at the moment of creation, because only the digest is stored and there is no
  // second chance to read it.
  console.log('')
  console.log(`Server ingest key for ${app.slug}:`)
  console.log('')
  console.log(`  ${token}`)
  console.log('')
  console.log('This is shown once and cannot be recovered. Copy it now.')
  console.log('A lost key is reissued, never retrieved; revoke the old one when you do.')
} finally {
  await db.destroy()
}
```

- [ ] **Step 9: Exercise the scripts against the compose database**

```bash
./run migrate
echo 'correct horse battery staple' | ./run owner:password
./run app:add reference The reference application
./run key:issue reference
```

Expected: the password script reports every device signed out; `app:add` reports the slug;
`key:issue` prints one `vgl_…` token with the "shown once" warning. Running `key:issue reference`
again prints a second, different token, and both remain live — that is rotation.

- [ ] **Step 10: Commit**

```bash
./run check
git add -A
git commit -m "feat(ingest): add ingest keys, byte guards and the setup scripts"
```

---

### Task 6: The ingest endpoint

§6, server keys only. The browser policy — origin allowlist, rate limits, quotas, extension
filtering — is Slice 4 and must not be anticipated here.

**Files:**
- Create: `server/src/modules/ingest/ingest.schemas.ts`, `ingest.service.ts`, `ingest.routes.ts`
- Modify: `server/src/app.ts` — one `registerIngest(app)` line
- Modify: `server/tests/integration/auth.test.ts:` the `toBe(404)` expectation becomes `toBe(401)`
- Test: `server/tests/integration/ingest.test.ts`

**Interfaces:**
- Consumes: `fingerprintOf` (Task 3); `PayloadTooLargeError`, `UnauthorizedError`,
  `NonBlankString` (Task 4); `findLiveKey`, `touchKey`, `guardBytes` (Task 5).
- Produces:
  - From `ingest.schemas.ts`: `IngestBody` (a TypeBox schema) and the inferred
    `type IngestBodyType`.
  - From `ingest.service.ts`:
    - `interface RecordedIssue { issueId: string; isNew: boolean; regressed: boolean }`
    - `class IngestService` with
      `constructor(db: Kysely<Database>, caps: { maxStackBytes: number; maxContextBytes: number })`
      and `record(appId: string, body: IngestBodyType): Promise<RecordedIssue[]>`.
      Task 8 reuses `IngestService` for vigil's own errors, so it must take no Fastify types.
  - From `ingest.routes.ts`: `registerIngest(instance: FastifyInstance): void`.

- [ ] **Step 1: Write the failing test**

`server/tests/integration/ingest.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, getTestDb, resetDb } from './helpers.js'
import { insertApp } from '../../src/modules/apps/app.repository.js'
import { insertKey, mintIngestKey } from '../../src/modules/ingest/key.repository.js'

let app: FastifyInstance
let appId: string
let otherAppId: string
let key: string
let otherKey: string

const db = () => getTestDb()

const STACK = `TypeError: Cannot read properties of undefined (reading 'id')
    at handleBooking (/app/src/modules/bookings/booking.service.js:42:17)
    at process (/app/node_modules/fastify/lib/handle.js:118:9)`

function batch(overrides: Record<string, unknown> = {}) {
  return {
    environment: 'production',
    runtime: 'node',
    events: [
      {
        type: 'TypeError',
        message: "Cannot read properties of undefined (reading 'id')",
        stack: STACK,
        occurred_at: new Date().toISOString(),
      },
    ],
    ...overrides,
  }
}

const post = (payload: unknown, token: string | undefined = key) =>
  app.inject({
    method: 'POST',
    url: '/ingest/events',
    ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
    payload,
  })

beforeAll(async () => {
  app = await buildTestApp()
})
beforeEach(async () => {
  await resetDb()
  appId = (await insertApp(db(), 'reference', 'The reference application')).id
  otherAppId = (await insertApp(db(), 'other', 'Another application')).id
  key = mintIngestKey()
  otherKey = mintIngestKey()
  await insertKey(db(), appId, 'server', key)
  await insertKey(db(), otherAppId, 'server', otherKey)
})
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

describe('the key', () => {
  it('is required', async () => {
    expect((await post(batch(), undefined)).statusCode).toBe(401)
  })

  it('must be one that exists', async () => {
    expect((await post(batch(), mintIngestKey())).statusCode).toBe(401)
  })

  it('must not be revoked', async () => {
    await db().updateTable('ingest_keys').set({ revoked_at: new Date() }).execute()
    expect((await post(batch())).statusCode).toBe(401)
  })

  it('is not read from a query string or a body field', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/ingest/events?key=${key}`,
      payload: batch(),
    })
    expect(response.statusCode).toBe(401)
  })

  // The property the trust boundary rests on: a key leaked from the least important
  // application must not become a way to forge events for the most important one.
  it('decides which application the events belong to, whatever the body claims', async () => {
    const response = await post({ ...batch(), app_id: otherAppId })
    // `additionalProperties: false` refuses the field outright rather than ignoring it.
    expect(response.statusCode).toBe(400)

    await post(batch())
    const issues = await db().selectFrom('issues').select('app_id').execute()
    expect(issues).toHaveLength(1)
    expect(issues[0]!.app_id).toBe(appId)
  })

  it('stamps last_used_at on the key that was presented', async () => {
    await post(batch())
    const rows = await db()
      .selectFrom('ingest_keys')
      .select(['app_id', 'last_used_at'])
      .execute()
    const mine = rows.find((r) => r.app_id === appId)
    const theirs = rows.find((r) => r.app_id === otherAppId)
    expect(mine?.last_used_at).not.toBeNull()
    expect(theirs?.last_used_at).toBeNull()
  })
})

describe('storing a batch', () => {
  it('answers 202 as soon as it is stored', async () => {
    const response = await post(batch())
    expect(response.statusCode).toBe(202)
    expect(response.json()).toEqual({ accepted: 1 })
  })

  it('creates the issue and its first event', async () => {
    await post(batch())
    const issue = await db().selectFrom('issues').selectAll().executeTakeFirstOrThrow()
    expect(issue.title).toBe("TypeError: Cannot read properties of undefined (reading 'id')")
    expect(issue.culprit).toBe('handleBooking (/app/src/modules/bookings/booking.service.js)')
    expect(issue.runtime).toBe('node')
    expect(issue.environment).toBe('production')
    expect(issue.status).toBe('open')
    expect(issue.occurrence_count).toBe(1)

    const event = await db().selectFrom('events').selectAll().executeTakeFirstOrThrow()
    expect(event.issue_id).toBe(issue.id)
    expect(event.stack).toBe(STACK)
    expect(event.count).toBe(1)
  })

  // Ten thousand failures are one line, not ten thousand. Everything else rests on this.
  it('groups repeats into one issue and counts them', async () => {
    await post(batch())
    await post(batch())
    await post(batch())

    expect(await db().selectFrom('issues').selectAll().execute()).toHaveLength(1)
    const issue = await db().selectFrom('issues').selectAll().executeTakeFirstOrThrow()
    expect(issue.occurrence_count).toBe(3)
    expect(await db().selectFrom('events').selectAll().execute()).toHaveLength(3)
  })

  it('adds a client-side collapse to the count as a whole', async () => {
    const collapsed = batch()
    collapsed.events[0]!.count = 50_000
    await post(collapsed)

    const issue = await db().selectFrom('issues').selectAll().executeTakeFirstOrThrow()
    expect(issue.occurrence_count).toBe(50_000)
    // One row standing for fifty thousand throws, which is the point of §8's local collapse.
    expect(await db().selectFrom('events').selectAll().execute()).toHaveLength(1)
  })

  it('keeps a developer machine and production apart', async () => {
    await post(batch())
    await post(batch({ environment: 'development' }))
    const issues = await db().selectFrom('issues').select('environment').orderBy('environment').execute()
    expect(issues.map((i) => i.environment)).toEqual(['development', 'production'])
  })

  it('keeps two applications apart even for an identical error', async () => {
    await post(batch())
    await post(batch(), otherKey)
    expect(await db().selectFrom('issues').selectAll().execute()).toHaveLength(2)
  })

  it('stores every event in a batch and reports how many it took', async () => {
    const many = batch()
    many.events = Array.from({ length: 5 }, (_, i) => ({
      type: 'Error',
      message: `failure ${i}`,
      stack: STACK.replace('handleBooking', `handler${i}`),
      occurred_at: new Date().toISOString(),
    }))
    const response = await post(many)
    expect(response.json()).toEqual({ accepted: 5 })
    expect(await db().selectFrom('issues').selectAll().execute()).toHaveLength(5)
  })

  it('keeps when it happened apart from when it landed', async () => {
    const late = batch()
    const happened = new Date(Date.now() - 3_600_000)
    late.events[0]!.occurred_at = happened.toISOString()
    await post(late)

    const event = await db().selectFrom('events').selectAll().executeTakeFirstOrThrow()
    expect(event.occurred_at.getTime()).toBe(happened.getTime())
    expect(event.received_at.getTime()).toBeGreaterThan(event.occurred_at.getTime())
  })

  // An offline queue replaying an hour late must not drag `last_seen_at` backwards and make a
  // live issue look stale.
  it('never moves last_seen_at backwards', async () => {
    await post(batch())
    const before = (await db().selectFrom('issues').select('last_seen_at').executeTakeFirstOrThrow()).last_seen_at

    const late = batch()
    late.events[0]!.occurred_at = new Date(Date.now() - 86_400_000).toISOString()
    await post(late)

    const after = (await db().selectFrom('issues').select('last_seen_at').executeTakeFirstOrThrow()).last_seen_at
    expect(after.getTime()).toBe(before.getTime())
  })

  it('stores a context as json', async () => {
    const withContext = batch()
    withContext.events[0]!.context = { route: '/api/bookings', method: 'POST' }
    await post(withContext)
    const event = await db().selectFrom('events').select('context').executeTakeFirstOrThrow()
    expect(event.context).toEqual({ route: '/api/bookings', method: 'POST' })
  })

  it('accepts an error with no stack at all', async () => {
    const stackless = batch()
    delete (stackless.events[0] as Record<string, unknown>).stack
    const response = await post(stackless)
    expect(response.statusCode).toBe(202)
    const issue = await db().selectFrom('issues').selectAll().executeTakeFirstOrThrow()
    expect(issue.culprit).toBeNull()
  })
})

describe('regression', () => {
  it('reopens a resolved issue and stamps when', async () => {
    await post(batch())
    await db().updateTable('issues').set({ status: 'resolved' }).execute()

    await post(batch())

    const issue = await db().selectFrom('issues').selectAll().executeTakeFirstOrThrow()
    expect(issue.status).toBe('open')
    expect(issue.reopened_at).not.toBeNull()
    expect(issue.occurrence_count).toBe(2)
  })

  // An ignored issue is one the owner has decided not to hear about. A new occurrence must not
  // undo that decision — otherwise `ignored` means nothing.
  it('leaves an ignored issue ignored', async () => {
    await post(batch())
    await db().updateTable('issues').set({ status: 'ignored' }).execute()

    await post(batch())

    const issue = await db().selectFrom('issues').selectAll().executeTakeFirstOrThrow()
    expect(issue.status).toBe('ignored')
    expect(issue.reopened_at).toBeNull()
    // Still counted, so the dashboard can show that a muted issue is still happening.
    expect(issue.occurrence_count).toBe(2)
  })

  it('does not stamp reopened_at on an issue that was never resolved', async () => {
    await post(batch())
    await post(batch())
    const issue = await db().selectFrom('issues').select('reopened_at').executeTakeFirstOrThrow()
    expect(issue.reopened_at).toBeNull()
  })
})

describe('the hard caps', () => {
  it('refuses a batch over the event limit', async () => {
    const capped = await buildTestApp({ config: { maxEventsPerBatch: 2 } })
    try {
      const many = batch()
      many.events = Array.from({ length: 3 }, () => ({
        type: 'Error',
        message: 'too many',
        occurred_at: new Date().toISOString(),
      }))
      const response = await capped.inject({
        method: 'POST',
        url: '/ingest/events',
        headers: { authorization: `Bearer ${key}` },
        payload: many,
      })
      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe('validation_error')
    } finally {
      await capped.close()
    }
  })

  it('refuses an empty batch', async () => {
    expect((await post(batch({ events: [] }))).statusCode).toBe(400)
  })

  // Rejected, not truncated and kept: a stack cut in half fingerprints differently from the
  // same stack whole, which would split one issue into two by payload size alone.
  it('refuses an oversize stack rather than trimming it', async () => {
    const capped = await buildTestApp({ config: { maxStackBytes: 64 } })
    try {
      const big = batch()
      big.events[0]!.stack = 'at x (/a.js:1:1)\n'.repeat(50)
      const response = await capped.inject({
        method: 'POST',
        url: '/ingest/events',
        headers: { authorization: `Bearer ${key}` },
        payload: big,
      })
      expect(response.statusCode).toBe(413)
      expect(response.json().error).toBe('payload_too_large')
      expect(await db().selectFrom('events').selectAll().execute()).toHaveLength(0)
    } finally {
      await capped.close()
    }
  })

  it('refuses an oversize context', async () => {
    const capped = await buildTestApp({ config: { maxContextBytes: 64 } })
    try {
      const big = batch()
      big.events[0]!.context = { blob: 'x'.repeat(500) }
      const response = await capped.inject({
        method: 'POST',
        url: '/ingest/events',
        headers: { authorization: `Bearer ${key}` },
        payload: big,
      })
      expect(response.statusCode).toBe(413)
    } finally {
      await capped.close()
    }
  })

  // A batch is one unit. Half-storing it would leave the client unable to tell what to resend.
  it('stores nothing at all when one event in a batch is refused', async () => {
    const capped = await buildTestApp({ config: { maxStackBytes: 64 } })
    try {
      const mixed = batch()
      mixed.events = [
        { type: 'Error', message: 'fine', occurred_at: new Date().toISOString() },
        {
          type: 'Error',
          message: 'too big',
          stack: 'at x (/a.js:1:1)\n'.repeat(50),
          occurred_at: new Date().toISOString(),
        },
      ]
      const response = await capped.inject({
        method: 'POST',
        url: '/ingest/events',
        headers: { authorization: `Bearer ${key}` },
        payload: mixed,
      })
      expect(response.statusCode).toBe(413)
      expect(await db().selectFrom('issues').selectAll().execute()).toHaveLength(0)
      expect(await db().selectFrom('events').selectAll().execute()).toHaveLength(0)
    } finally {
      await capped.close()
    }
  })
})

describe('the wire format', () => {
  it('rejects an unknown field rather than ignoring it', async () => {
    const response = await post({ ...batch(), severity: 'critical' })
    expect(response.statusCode).toBe(400)
  })

  it('rejects an unknown field inside an event', async () => {
    const odd = batch()
    ;(odd.events[0] as Record<string, unknown>).release = 'v2'
    expect((await post(odd)).statusCode).toBe(400)
  })

  it('requires an environment', async () => {
    const response = await post(batch({ environment: '   ' }))
    expect(response.statusCode).toBe(400)
  })

  it('requires a runtime it knows', async () => {
    expect((await post(batch({ runtime: 'deno' }))).statusCode).toBe(400)
  })

  it('requires occurred_at to be a timestamp', async () => {
    const bad = batch()
    bad.events[0]!.occurred_at = 'yesterday'
    expect((await post(bad)).statusCode).toBe(400)
  })

  it('honours an explicit fingerprint', async () => {
    const a = batch()
    a.events[0]!.fingerprint = 'checkout'
    const b = batch({ events: [{ type: 'RangeError', message: 'different', occurred_at: new Date().toISOString(), fingerprint: 'checkout' }] })
    await post(a)
    await post(b)
    expect(await db().selectFrom('issues').selectAll().execute()).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npx vitest run tests/integration/ingest.test.ts`
Expected: FAIL — every case answers 404, the route does not exist.

- [ ] **Step 3: Write `ingest.schemas.ts`**

```ts
import { Type, type Static } from 'typebox'
import { NonBlankString } from '../../shared/schemas.js'

/**
 * One wire format for both key kinds (§4). Slice 4 adds the browser policy around this schema;
 * it does not add a second shape.
 *
 * `maxItems` is applied at registration from `config.maxEventsPerBatch`, so the batch cap is
 * refused by the schema — a 400 naming the field — rather than counted in the service.
 */
export function IngestBody(maxEventsPerBatch: number) {
  return Type.Object(
    {
      environment: NonBlankString({ maxLength: 64 }),
      runtime: Type.Union([Type.Literal('node'), Type.Literal('browser')]),
      events: Type.Array(
        Type.Object(
          {
            /** The error's constructor name. */
            type: NonBlankString({ maxLength: 200 }),
            message: Type.String({ maxLength: 4_000 }),
            stack: Type.Optional(Type.String()),
            occurred_at: Type.String({ format: 'date-time' }),
            context: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
            /** §8's local collapse: one event standing for many identical throws. */
            count: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
            /** §7's escape hatch. */
            fingerprint: Type.Optional(Type.String({ maxLength: 200 })),
          },
          { additionalProperties: false },
        ),
        { minItems: 1, maxItems: maxEventsPerBatch },
      ),
    },
    { additionalProperties: false },
  )
}

export type IngestBodyType = Static<ReturnType<typeof IngestBody>>
```

`format: 'date-time'` needs Ajv's format vocabulary. If the suite shows `occurred_at: 'yesterday'`
being accepted, add `ajv-formats` to `server/package.json` and register it in `app.ts` via
Fastify's `ajv.plugins` option; otherwise replace the constraint with a `pattern` for ISO-8601.
Decide by running the test — do not add the dependency speculatively.

- [ ] **Step 4: Write `ingest.service.ts`**

```ts
import type { Kysely, Transaction } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '../../db/schema.js'
import { fingerprintOf } from '../../shared/fingerprint.js'
import { guardBytes } from '../../shared/bytes.js'
import type { IngestBodyType } from './ingest.schemas.js'

export interface RecordedIssue {
  issueId: string
  /** Slice 2 turns these two flags into `issue.new` and `issue.regressed` outbox rows. */
  isNew: boolean
  regressed: boolean
}

export interface Caps {
  maxStackBytes: number
  maxContextBytes: number
}

/**
 * Takes a database and two numbers and nothing else — no Fastify, no request. §13 records
 * vigil's own failures through this same service, without an HTTP round trip.
 */
export class IngestService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly caps: Caps,
  ) {}

  /**
   * `appId` is the caller's to supply, and the route reads it from the key (§4). This method
   * has no way to learn it from `body`, which is the point.
   *
   * The whole batch is one transaction: a batch is one unit, and half-storing it would leave
   * the client with no way to tell what to resend.
   */
  async record(appId: string, body: IngestBodyType): Promise<RecordedIssue[]> {
    // Guarded before the transaction opens, so an oversize payload never takes a lock.
    for (const event of body.events) {
      if (event.stack !== undefined) {
        guardBytes(event.stack, this.caps.maxStackBytes, 'stack')
      }
      if (event.context !== undefined) {
        guardBytes(JSON.stringify(event.context), this.caps.maxContextBytes, 'context')
      }
    }

    return this.db.transaction().execute(async (trx) => {
      const recorded: RecordedIssue[] = []
      for (const event of body.events) {
        recorded.push(await this.recordOne(trx, appId, body, event))
      }
      return recorded
    })
  }

  private async recordOne(
    trx: Transaction<Database>,
    appId: string,
    body: IngestBodyType,
    event: IngestBodyType['events'][number],
  ): Promise<RecordedIssue> {
    const { fingerprint, culprit } = fingerprintOf({
      type: event.type,
      message: event.message,
      stack: event.stack,
      fingerprint: event.fingerprint,
    })

    const occurredAt = new Date(event.occurred_at)
    const count = event.count ?? 1
    const title = event.message === '' ? event.type : `${event.type}: ${event.message}`

    // Insert first, and let the unique constraint decide. Two processes reporting the same new
    // error in the same millisecond then produce one issue, not a duplicate-key 500.
    const created = await trx
      .insertInto('issues')
      .values({
        app_id: appId,
        environment: body.environment,
        fingerprint,
        title: title.slice(0, 500),
        culprit,
        runtime: body.runtime,
        occurrence_count: count,
        last_seen_at: occurredAt,
      })
      .onConflict((oc) => oc.columns(['app_id', 'environment', 'fingerprint']).doNothing())
      .returning('id')
      .executeTakeFirst()

    let issueId: string
    let regressed = false

    if (created !== undefined) {
      issueId = created.id
    } else {
      // Locked before reading, so the status this decision is based on cannot change under it.
      const existing = await trx
        .selectFrom('issues')
        .select(['id', 'status'])
        .where('app_id', '=', appId)
        .where('environment', '=', body.environment)
        .where('fingerprint', '=', fingerprint)
        .forUpdate()
        .executeTakeFirstOrThrow()

      issueId = existing.id
      // Only `resolved` reopens. `ignored` is a decision the owner made, and a new occurrence
      // must not quietly undo it — otherwise `ignored` means nothing.
      regressed = existing.status === 'resolved'

      await trx
        .updateTable('issues')
        .set({
          occurrence_count: sql`occurrence_count + ${count}`,
          // An offline queue replaying an hour late must not drag this backwards and make a
          // live issue look stale.
          last_seen_at: sql`greatest(last_seen_at, ${occurredAt})`,
          ...(regressed ? { status: 'open' as const, reopened_at: sql`now()` } : {}),
          // The stack that named the culprit may have been absent on the first report.
          ...(culprit !== null ? { culprit } : {}),
        })
        .where('id', '=', issueId)
        .execute()
    }

    await trx
      .insertInto('events')
      .values({
        issue_id: issueId,
        occurred_at: occurredAt,
        message: event.message,
        stack: event.stack ?? null,
        context: event.context === undefined ? null : JSON.stringify(event.context),
        count,
      })
      .execute()

    return { issueId, isNew: created !== undefined, regressed }
  }
}
```

The `set({ ... sql\`...\` })` calls need Kysely's raw-expression typing; if `exactOptionalPropertyTypes`
objects to the spread of a conditional object, build the update object as a
`UpdateObject<Database, 'issues'>` local variable and assign the conditional keys with `if`
statements instead of spreads. Keep the behaviour identical.

- [ ] **Step 5: Write `ingest.routes.ts` and register it**

```ts
import type { FastifyInstance } from 'fastify'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { UnauthorizedError } from '../auth/guard.js'
import { findLiveKey, touchKey } from './key.repository.js'
import { IngestBody } from './ingest.schemas.js'
import { IngestService } from './ingest.service.js'

/**
 * Not under `/api`, and deliberately so: the guard in `modules/auth/guard.ts` protects `/api`
 * with a cookie, and an application must never be asked for one. This route authenticates on
 * its own terms, with a bearer key, per request, holding no session.
 */
export function registerIngest(instance: FastifyInstance): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>()
  const service = new IngestService(app.db, {
    maxStackBytes: app.config.maxStackBytes,
    maxContextBytes: app.config.maxContextBytes,
  })

  app.post(
    '/ingest/events',
    { schema: { body: IngestBody(app.config.maxEventsPerBatch) } },
    async (request, reply) => {
      // Only from the header. Never a query string, never a body field: an application
      // identifier the sender controls is an application identifier an attacker controls.
      const header = request.headers.authorization
      const token = header?.startsWith('Bearer ') === true ? header.slice(7).trim() : undefined
      if (token === undefined || token === '') throw new UnauthorizedError('An ingest key is required')

      const key = await findLiveKey(app.db, token)
      if (key === undefined) throw new UnauthorizedError('This ingest key is not valid')

      // Slice 4 puts the browser policy — origin allowlist, rate limit, quota, extension
      // filtering — behind `key.kind === 'browser'` here. Slice 1 issues only server keys.

      const recorded = await service.record(key.appId, request.body)

      // Best effort and never in the way of the answer: a failed timestamp write must not turn
      // a stored batch into an error the client will retry.
      void touchKey(app.db, key.id).catch(() => {})

      // Answered as soon as it is stored (§6). Slice 2 queues outbox rows from `recorded`
      // before this line; nothing is ever delivered inline.
      void reply.status(202).send({ accepted: recorded.length })
    },
  )
}
```

In `server/src/app.ts`, import `registerIngest` and call it after `registerAuth(app)` and before
`registerSpa(app)`.

- [ ] **Step 6: Fix the one placeholder expectation in the auth suite**

In `server/tests/integration/auth.test.ts`, the case
`'does not ask /ingest for a session — it answers on its own terms'` asserts `toBe(404)`. The
route now exists and refuses a missing key, so change that line to `expect(response.statusCode).toBe(401)`.
The `not.toBe(401)` above it must become `not.toBe(403)` — the point of the case is that the
refusal comes from the key check and not from the cookie guard, and a 401 is now the right
answer. Rewrite the case as:

```ts
  it('does not ask /ingest for a session — it answers on its own terms', async () => {
    const response = await app.inject({ method: 'POST', url: '/ingest/events', payload: {} })
    // 401 from the key check, not from the cookie guard; the body says which.
    expect(response.statusCode).toBe(401)
    expect(response.json().message).toMatch(/ingest key/)
  })
```

- [ ] **Step 7: Run the suites to verify they pass**

Run: `cd server && npx vitest run tests/integration/ingest.test.ts tests/integration/auth.test.ts`
Expected: PASS, 28 + 17 tests.

- [ ] **Step 8: Commit**

```bash
./run check
git add -A
git commit -m "feat(ingest): accept batches on a server key and group them into issues"
```

---

### Task 7: The issues read API

What the dashboard reads. §11's issues list and issue detail, and the resolve / ignore actions.

**Files:**
- Create: `server/src/modules/issues/issue.repository.ts`, `issue.schemas.ts`, `issue.routes.ts`
- Create: `server/src/modules/apps/app.routes.ts`
- Modify: `server/src/app.ts` — `registerIssues(app)` and `registerApps(app)`
- Test: `server/tests/integration/issues.test.ts`

**Interfaces:**
- Consumes: `Database` (Task 2); `NotFoundError` (Task 4); `listApps`, `AppRow` (Task 5);
  the ingest route for seeding (Task 6).
- Produces:
  - From `issue.repository.ts`:
    - `interface IssueSummary { id, app_slug, app_name, environment, title, culprit, runtime, status, first_seen_at, last_seen_at, occurrence_count }` — dates as `Date`.
    - `interface IssueOccurrence { id, occurred_at, received_at, message, stack, context, count }`
    - `interface IssueFilter { appSlug?: string; environment?: string; status?: 'open' | 'resolved' | 'ignored'; sort: 'last_seen' | 'count'; limit: number }`
    - `listIssues(db, filter): Promise<IssueSummary[]>`
    - `findIssue(db, id): Promise<IssueSummary | undefined>`
    - `recentOccurrences(db, issueId, limit): Promise<IssueOccurrence[]>`
    - `setIssueStatus(db, id, status): Promise<boolean>` — false when no such issue.
  - From `issue.routes.ts`: `registerIssues(instance: FastifyInstance): void`, serving
    `GET /api/issues`, `GET /api/issues/:id`, `PATCH /api/issues/:id`.
  - From `app.routes.ts`: `registerApps(instance: FastifyInstance): void`, serving
    `GET /api/apps`.

- [ ] **Step 1: Write the failing test**

`server/tests/integration/issues.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, getTestDb, resetDb } from './helpers.js'
import { signIn } from './auth-helper.js'
import { insertApp } from '../../src/modules/apps/app.repository.js'
import { insertKey, mintIngestKey } from '../../src/modules/ingest/key.repository.js'

let app: FastifyInstance
let cookies: Record<string, string>
let key: string
let otherKey: string

const db = () => getTestDb()

const STACK = `TypeError: boom
    at handleBooking (/app/src/bookings.js:42:17)
    at deeper (/app/node_modules/fastify/lib/handle.js:1:1)`

async function report(
  token: string,
  overrides: { message?: string; environment?: string; occurredAt?: Date; count?: number } = {},
) {
  const response = await app.inject({
    method: 'POST',
    url: '/ingest/events',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      environment: overrides.environment ?? 'production',
      runtime: 'node',
      events: [
        {
          type: 'TypeError',
          message: overrides.message ?? 'boom',
          stack: STACK,
          occurred_at: (overrides.occurredAt ?? new Date()).toISOString(),
          ...(overrides.count === undefined ? {} : { count: overrides.count }),
          context: { route: '/api/bookings' },
        },
      ],
    },
  })
  if (response.statusCode !== 202) throw new Error(`report failed: ${response.body}`)
}

const list = (query = '') =>
  app.inject({ method: 'GET', url: `/api/issues${query}`, cookies })

beforeAll(async () => {
  app = await buildTestApp()
})
beforeEach(async () => {
  await resetDb()
  cookies = await signIn(app)
  const reference = await insertApp(db(), 'reference', 'The reference application')
  const other = await insertApp(db(), 'other', 'Another application')
  key = mintIngestKey()
  otherKey = mintIngestKey()
  await insertKey(db(), reference.id, 'server', key)
  await insertKey(db(), other.id, 'server', otherKey)
})
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

describe('the issues list', () => {
  it('needs a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/issues' })).statusCode).toBe(401)
  })

  it('names the application each issue belongs to', async () => {
    await report(key)
    const issues = list().then((r) => r.json().issues)
    expect((await issues)[0]).toMatchObject({
      app_slug: 'reference',
      app_name: 'The reference application',
      environment: 'production',
      title: 'TypeError: boom',
      culprit: 'handleBooking (/app/src/bookings.js)',
      status: 'open',
      occurrence_count: 1,
    })
  })

  it('shows one line for many occurrences', async () => {
    await report(key)
    await report(key)
    await report(key)
    const issues = (await list()).json().issues
    expect(issues).toHaveLength(1)
    expect(issues[0].occurrence_count).toBe(3)
  })

  it('sorts by last seen, newest first, by default', async () => {
    await report(key, { message: 'older', occurredAt: new Date(Date.now() - 60_000) })
    await report(key, { message: 'newer' })
    const titles = (await list()).json().issues.map((i: { title: string }) => i.title)
    expect(titles).toEqual(['TypeError: newer', 'TypeError: older'])
  })

  it('sorts by count when asked', async () => {
    await report(key, { message: 'rare' })
    await report(key, { message: 'common', count: 500 })
    const titles = (await list('?sort=count')).json().issues.map((i: { title: string }) => i.title)
    expect(titles).toEqual(['TypeError: common', 'TypeError: rare'])
  })

  it('filters by application', async () => {
    await report(key)
    await report(otherKey)
    const issues = (await list('?app=other')).json().issues
    expect(issues).toHaveLength(1)
    expect(issues[0].app_slug).toBe('other')
  })

  it('filters by environment', async () => {
    await report(key, { environment: 'production' })
    await report(key, { environment: 'development' })
    const issues = (await list('?environment=development')).json().issues
    expect(issues).toHaveLength(1)
    expect(issues[0].environment).toBe('development')
  })

  it('filters by status', async () => {
    await report(key, { message: 'left open' })
    await report(key, { message: 'resolved' })
    await db().updateTable('issues').set({ status: 'resolved' }).where('title', '=', 'TypeError: resolved').execute()

    expect((await list('?status=open')).json().issues).toHaveLength(1)
    expect((await list('?status=resolved')).json().issues).toHaveLength(1)
    expect((await list()).json().issues).toHaveLength(2)
  })

  it('refuses a status it does not know rather than ignoring it', async () => {
    expect((await list('?status=snoozed')).statusCode).toBe(400)
  })

  it('serialises timestamps as ISO strings and the count as a number', async () => {
    await report(key)
    const issue = (await list()).json().issues[0]
    expect(issue.last_seen_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(typeof issue.occurrence_count).toBe('number')
  })
})

describe('issue detail', () => {
  const idOfFirst = async () => (await list()).json().issues[0].id as string

  it('returns the issue with its recent occurrences, newest first', async () => {
    await report(key, { occurredAt: new Date(Date.now() - 60_000) })
    await report(key)
    const response = await app.inject({ method: 'GET', url: `/api/issues/${await idOfFirst()}`, cookies })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.issue.title).toBe('TypeError: boom')
    expect(body.events).toHaveLength(2)
    expect(new Date(body.events[0].occurred_at).getTime()).toBeGreaterThan(
      new Date(body.events[1].occurred_at).getTime(),
    )
    expect(body.events[0].stack).toBe(STACK)
    expect(body.events[0].context).toEqual({ route: '/api/bookings' })
  })

  it('answers 404 for an id that is not there', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/issues/3f6a1c2e-9d4b-4f8a-8c1d-2b7e5a9f0c31',
      cookies,
    })
    expect(response.statusCode).toBe(404)
    expect(response.json().error).toBe('not_found')
  })

  it('answers 400 for an id that is not a uuid', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/issues/nonsense', cookies })).statusCode).toBe(400)
  })

  it('needs a session', async () => {
    await report(key)
    const id = await idOfFirst()
    expect((await app.inject({ method: 'GET', url: `/api/issues/${id}` })).statusCode).toBe(401)
  })
})

describe('resolving and ignoring', () => {
  const idOfFirst = async () => (await list()).json().issues[0].id as string

  it('resolves an issue', async () => {
    await report(key)
    const id = await idOfFirst()
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/issues/${id}`,
      cookies,
      payload: { status: 'resolved' },
    })
    expect(response.statusCode).toBe(204)
    const issue = await db().selectFrom('issues').select('status').executeTakeFirstOrThrow()
    expect(issue.status).toBe('resolved')
  })

  it('ignores one, and unmutes it again', async () => {
    await report(key)
    const id = await idOfFirst()
    const patch = (status: string) =>
      app.inject({ method: 'PATCH', url: `/api/issues/${id}`, cookies, payload: { status } })

    expect((await patch('ignored')).statusCode).toBe(204)
    expect((await db().selectFrom('issues').select('status').executeTakeFirstOrThrow()).status).toBe('ignored')
    expect((await patch('open')).statusCode).toBe(204)
    expect((await db().selectFrom('issues').select('status').executeTakeFirstOrThrow()).status).toBe('open')
  })

  it('refuses a status outside the three', async () => {
    await report(key)
    const id = await idOfFirst()
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/issues/${id}`,
      cookies,
      payload: { status: 'snoozed' },
    })
    expect(response.statusCode).toBe(400)
  })

  it('answers 404 for an issue that is not there', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/issues/3f6a1c2e-9d4b-4f8a-8c1d-2b7e5a9f0c31',
      cookies,
      payload: { status: 'resolved' },
    })
    expect(response.statusCode).toBe(404)
  })

  it('needs a session', async () => {
    await report(key)
    const id = await idOfFirst()
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/issues/${id}`,
      payload: { status: 'resolved' },
    })
    expect(response.statusCode).toBe(401)
  })
})

describe('the applications list', () => {
  it('lists them for the filter', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/apps', cookies })
    expect(response.statusCode).toBe(200)
    expect(response.json().apps.map((a: { slug: string }) => a.slug)).toEqual([
      'other',
      'reference',
      'vigil',
    ])
  })

  it('needs a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/apps' })).statusCode).toBe(401)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npx vitest run tests/integration/issues.test.ts`
Expected: FAIL — the routes answer 404.

- [ ] **Step 3: Write `issue.repository.ts`**

```ts
import type { Kysely } from 'kysely'
import type { Database } from '../../db/schema.js'

export interface IssueSummary {
  id: string
  app_slug: string
  app_name: string
  environment: string
  title: string
  culprit: string | null
  runtime: 'node' | 'browser'
  status: 'open' | 'resolved' | 'ignored'
  first_seen_at: Date
  last_seen_at: Date
  occurrence_count: number
}

export interface IssueOccurrence {
  id: string
  occurred_at: Date
  received_at: Date
  message: string
  stack: string | null
  context: Record<string, unknown> | null
  count: number
}

export interface IssueFilter {
  appSlug?: string | undefined
  environment?: string | undefined
  status?: 'open' | 'resolved' | 'ignored' | undefined
  sort: 'last_seen' | 'count'
  limit: number
}

const SUMMARY = [
  'issues.id as id',
  'apps.slug as app_slug',
  'apps.name as app_name',
  'issues.environment as environment',
  'issues.title as title',
  'issues.culprit as culprit',
  'issues.runtime as runtime',
  'issues.status as status',
  'issues.first_seen_at as first_seen_at',
  'issues.last_seen_at as last_seen_at',
  'issues.occurrence_count as occurrence_count',
] as const

export async function listIssues(
  db: Kysely<Database>,
  filter: IssueFilter,
): Promise<IssueSummary[]> {
  let query = db.selectFrom('issues').innerJoin('apps', 'apps.id', 'issues.app_id').select(SUMMARY)

  if (filter.appSlug !== undefined) query = query.where('apps.slug', '=', filter.appSlug)
  if (filter.environment !== undefined) {
    query = query.where('issues.environment', '=', filter.environment)
  }
  if (filter.status !== undefined) query = query.where('issues.status', '=', filter.status)

  query =
    filter.sort === 'count'
      ? query.orderBy('issues.occurrence_count', 'desc')
      : query.orderBy('issues.last_seen_at', 'desc')

  // A stable tiebreak, so two issues last seen in the same millisecond do not swap places
  // between page loads and make the list look like it is moving on its own.
  return query.orderBy('issues.id').limit(filter.limit).execute()
}

export async function findIssue(
  db: Kysely<Database>,
  id: string,
): Promise<IssueSummary | undefined> {
  return db
    .selectFrom('issues')
    .innerJoin('apps', 'apps.id', 'issues.app_id')
    .select(SUMMARY)
    .where('issues.id', '=', id)
    .executeTakeFirst()
}

export async function recentOccurrences(
  db: Kysely<Database>,
  issueId: string,
  limit: number,
): Promise<IssueOccurrence[]> {
  return db
    .selectFrom('events')
    .select(['id', 'occurred_at', 'received_at', 'message', 'stack', 'context', 'count'])
    .where('issue_id', '=', issueId)
    // By when it happened, not when it landed: an event replayed from an offline queue belongs
    // where it occurred in the story, not at the top because it arrived last.
    .orderBy('occurred_at', 'desc')
    .limit(limit)
    .execute()
}

/** False when there is no such issue, so the route can answer 404 without a second query. */
export async function setIssueStatus(
  db: Kysely<Database>,
  id: string,
  status: 'open' | 'resolved' | 'ignored',
): Promise<boolean> {
  const result = await db
    .updateTable('issues')
    .set({ status })
    .where('id', '=', id)
    .executeTakeFirst()
  return Number(result.numUpdatedRows) > 0
}
```

- [ ] **Step 4: Write `issue.schemas.ts`, `issue.routes.ts` and `app.routes.ts`**

`issue.schemas.ts`:

```ts
import { Type, type Static } from 'typebox'

const Status = Type.Union([
  Type.Literal('open'),
  Type.Literal('resolved'),
  Type.Literal('ignored'),
])

export const IssueListQuery = Type.Object(
  {
    app: Type.Optional(Type.String({ maxLength: 64 })),
    environment: Type.Optional(Type.String({ maxLength: 64 })),
    status: Type.Optional(Status),
    sort: Type.Optional(Type.Union([Type.Literal('last_seen'), Type.Literal('count')])),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  },
  { additionalProperties: false },
)

export const IssueParams = Type.Object(
  { id: Type.String({ format: 'uuid' }) },
  { additionalProperties: false },
)

export const IssueStatusBody = Type.Object({ status: Status }, { additionalProperties: false })

export type IssueListQueryType = Static<typeof IssueListQuery>
```

If `format: 'uuid'` is not enforced by the Ajv build in use, replace it with
`Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' })`. The
`'answers 400 for an id that is not a uuid'` case is what tells you which you have. Without it a
malformed id reaches Postgres and returns a 500 where a 400 belongs.

`issue.routes.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { NotFoundError } from '../../shared/errors.js'
import {
  findIssue,
  listIssues,
  recentOccurrences,
  setIssueStatus,
} from './issue.repository.js'
import { IssueListQuery, IssueParams, IssueStatusBody } from './issue.schemas.js'

/** Enough to see whether the shape of a failure changes, few enough to render at once. */
const OCCURRENCES_ON_DETAIL = 25
const DEFAULT_LIST_LIMIT = 100

export function registerIssues(instance: FastifyInstance): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>()

  app.get('/api/issues', { schema: { querystring: IssueListQuery } }, async (request) => {
    const query = request.query
    const issues = await listIssues(app.db, {
      appSlug: query.app,
      environment: query.environment,
      status: query.status,
      sort: query.sort ?? 'last_seen',
      limit: query.limit ?? DEFAULT_LIST_LIMIT,
    })
    return { issues }
  })

  app.get('/api/issues/:id', { schema: { params: IssueParams } }, async (request) => {
    const issue = await findIssue(app.db, request.params.id)
    if (issue === undefined) throw new NotFoundError('No such issue')

    const events = await recentOccurrences(app.db, issue.id, OCCURRENCES_ON_DETAIL)
    return { issue, events }
  })

  app.patch(
    '/api/issues/:id',
    { schema: { params: IssueParams, body: IssueStatusBody } },
    async (request, reply) => {
      const changed = await setIssueStatus(app.db, request.params.id, request.body.status)
      if (!changed) throw new NotFoundError('No such issue')
      void reply.status(204).send()
    },
  )
}
```

`app.routes.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import { listApps } from './app.repository.js'

export function registerApps(app: FastifyInstance): void {
  // Read by the issues screen to fill its filter. Behind the session guard like everything
  // under /api: an ingest key must never be able to enumerate the applications vigil watches.
  app.get('/api/apps', async () => ({ apps: await listApps(app.db) }))
}
```

Register both in `server/src/app.ts`, after `registerIngest(app)`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd server && npx vitest run tests/integration/issues.test.ts`
Expected: PASS, 20 tests.

- [ ] **Step 6: Commit**

```bash
./run check
git add -A
git commit -m "feat(issues): serve the issues list, detail and status changes"
```

---

### Task 8: Vigil records its own failures, but never over HTTP

§13. Reporting to itself through its own ingest endpoint means a failure in the ingest path
generates an error about the ingest path failing, forever. The write path also refuses to create
an issue while it is handling an ingest failure, closing the same loop from the other side.

**Files:**
- Create: `server/src/self/record.ts`
- Modify: `server/src/shared/errors.ts` — `registerErrorHandler` gains one call
- Modify: `server/src/app.ts` — wire the recorder into the error handler
- Test: `server/tests/integration/self-monitoring.test.ts`

**Interfaces:**
- Consumes: `IngestService` (Task 6); `findAppBySlug` (Task 5); `AppError` (Task 4).
- Produces:
  - `const VIGIL_SLUG = 'vigil'`
  - `interface SelfRecorder { record(error: unknown, context: Record<string, unknown>): void }`
  - `createSelfRecorder(deps: { db: Kysely<Database>; ingest: IngestService; environment: string; log: { warn(o: object, m: string): void } }): SelfRecorder`
  - `registerErrorHandler(app: FastifyInstance, self?: SelfRecorder): void` — the second
    parameter is new; existing callers keep working.

- [ ] **Step 1: Write the failing test**

`server/tests/integration/self-monitoring.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, getTestDb, resetDb } from './helpers.js'
import { signIn } from './auth-helper.js'

let app: FastifyInstance
let cookies: Record<string, string>

const db = () => getTestDb()

/**
 * A route that throws, registered only in this suite: making a production route fail on demand
 * would mean shipping a way to make it fail.
 */
beforeAll(async () => {
  app = await buildTestApp()
  app.get('/api/boom', async () => {
    throw new Error('the database went away')
  })
  await app.ready()
})
beforeEach(async () => {
  await resetDb()
  cookies = await signIn(app)
})
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

const issues = () =>
  db()
    .selectFrom('issues')
    .innerJoin('apps', 'apps.id', 'issues.app_id')
    .select(['issues.title as title', 'apps.slug as slug', 'issues.occurrence_count as count'])
    .execute()

// Vitest runs the recorder's write after the response is sent; poll rather than sleep a fixed
// amount, so the case is neither flaky nor slower than it has to be.
async function eventually<T>(read: () => Promise<T[]>, count: number): Promise<T[]> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const rows = await read()
    if (rows.length >= count) return rows
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return read()
}

describe('vigil recording its own failures', () => {
  it('files an unhandled error under the vigil application', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/boom', cookies })
    expect(response.statusCode).toBe(500)
    // The owner is told nothing about the internals; the issue carries the detail.
    expect(response.json()).toEqual({ error: 'internal_error', message: 'Internal server error' })

    const [issue] = await eventually(issues, 1)
    expect(issue?.slug).toBe('vigil')
    expect(issue?.title).toBe('Error: the database went away')
  })

  it('groups its own repeats like anything else', async () => {
    await app.inject({ method: 'GET', url: '/api/boom', cookies })
    await app.inject({ method: 'GET', url: '/api/boom', cookies })
    const rows = await eventually(issues, 1)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.count).toBe(2)
  })

  it('records the route that failed as context', async () => {
    await app.inject({ method: 'GET', url: '/api/boom', cookies })
    await eventually(issues, 1)
    const event = await db().selectFrom('events').select('context').executeTakeFirstOrThrow()
    expect(event.context).toMatchObject({ method: 'GET', url: '/api/boom' })
  })

  // An expected refusal is not a defect. Filing every 401 as an issue would bury the one thing
  // this table exists to surface.
  it('does not record an error the owner caused', async () => {
    await app.inject({ method: 'GET', url: '/api/issues' }) // 401, no session
    await app.inject({ method: 'GET', url: '/api/issues/nonsense', cookies }) // 400
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await issues()).toHaveLength(0)
  })

  // The loop §13 exists to close: a failure in the ingest path must not generate an error about
  // the ingest path failing, forever.
  it('does not file an issue about a failure in the ingest path itself', async () => {
    app.get('/ingest/boom', async () => {
      throw new Error('ingest itself is broken')
    })
    await app.ready()

    const response = await app.inject({ method: 'GET', url: '/ingest/boom' })
    expect(response.statusCode).toBe(500)

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await issues()).toHaveLength(0)
  })

  // If recording an error can throw, the error handler becomes the next thing to fail — while
  // it is already handling a failure.
  it('never lets its own write failure reach the response', async () => {
    await db().deleteFrom('apps').where('slug', '=', 'vigil').execute()
    const response = await app.inject({ method: 'GET', url: '/api/boom', cookies })
    expect(response.statusCode).toBe(500)
    expect(response.json().error).toBe('internal_error')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npx vitest run tests/integration/self-monitoring.test.ts`
Expected: FAIL — no issues are recorded.

- [ ] **Step 3: Write `server/src/self/record.ts`**

```ts
import type { Kysely } from 'kysely'
import type { Database } from '../db/schema.js'
import { findAppBySlug } from '../modules/apps/app.repository.js'
import type { IngestService } from '../modules/ingest/ingest.service.js'

export const VIGIL_SLUG = 'vigil'

export interface SelfRecorder {
  /** Returns nothing and never rejects. The caller is already handling a failure. */
  record(error: unknown, context: Record<string, unknown>): void
}

export interface SelfRecorderDeps {
  db: Kysely<Database>
  ingest: IngestService
  environment: string
  log: { warn(details: object, message: string): void }
}

export function createSelfRecorder(deps: SelfRecorderDeps): SelfRecorder {
  // Resolved once and cached: the row is seeded by the migration and never changes.
  let appId: Promise<string | undefined> | undefined

  // The other half of §13's loop. Reporting over HTTP would make an ingest failure produce an
  // error about the ingest path, which produces another. This flag closes the same loop from
  // the write side: while we are recording, we do not record.
  let recording = false

  return {
    record(error: unknown, context: Record<string, unknown>): void {
      if (recording) return
      recording = true

      void (async () => {
        try {
          appId ??= findAppBySlug(deps.db, VIGIL_SLUG).then((app) => app?.id)
          const id = await appId
          if (id === undefined) {
            // The seeded row is gone. Say so once and carry on: an unrecordable error is
            // still better handled than a handler that throws.
            deps.log.warn({}, 'no vigil application row; own errors are not being recorded')
            return
          }

          const thrown = error instanceof Error ? error : new Error(String(error))

          await deps.ingest.record(id, {
            environment: deps.environment,
            runtime: 'node',
            events: [
              {
                type: thrown.name,
                message: thrown.message,
                ...(thrown.stack === undefined ? {} : { stack: thrown.stack }),
                occurred_at: new Date().toISOString(),
                context,
              },
            ],
          })
        } catch (failure) {
          // Swallowed on purpose. This runs while the process is already answering a 500;
          // throwing here would replace one failure with two.
          deps.log.warn({ err: failure }, 'could not record our own error')
        } finally {
          recording = false
        }
      })()
    },
  }
}
```

- [ ] **Step 4: Wire it into the error handler**

In `server/src/shared/errors.ts`, take an optional recorder and call it on the one branch that
means "this was our fault":

```ts
import type { SelfRecorder } from '../self/record.js'

export function registerErrorHandler(app: FastifyInstance, self?: SelfRecorder): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    // ... AppError, error.validation and the 4xx branches are unchanged ...

    request.log.error({ err: error }, 'unhandled error')
    // Only here. An AppError, a schema rejection or any other 4xx is the caller's doing, not a
    // defect, and filing those would bury the one thing this table exists to surface.
    //
    // A failure under /ingest is skipped as well: recording it would be vigil reporting on the
    // path that records reports.
    if (self !== undefined && !request.url.startsWith('/ingest/')) {
      self.record(error, { method: request.method, url: request.url })
    }
    void reply.status(500).send({ error: 'internal_error', message: 'Internal server error' })
  })
}
```

In `server/src/app.ts`, build the recorder before registering the handler. It needs the same
`IngestService` the route builds, so lift that construction into `buildApp` and pass it to
`registerIngest(app, ingest)`:

```ts
import { IngestService } from './modules/ingest/ingest.service.js'
import { createSelfRecorder } from './self/record.js'

// inside buildApp, after app.decorate('config', deps.config):
const ingest = new IngestService(deps.db, {
  maxStackBytes: deps.config.maxStackBytes,
  maxContextBytes: deps.config.maxContextBytes,
})
const self = createSelfRecorder({
  db: deps.db,
  ingest,
  environment: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  log: app.log,
})
registerErrorHandler(app, self)
```

Change `registerIngest(instance: FastifyInstance)` to
`registerIngest(instance: FastifyInstance, ingest: IngestService)` and drop the `new IngestService`
line from inside it, so there is one instance and one set of caps.

- [ ] **Step 5: Run the whole server suite**

Run: `cd server && npx vitest run`
Expected: PASS — every suite, including the ones from Tasks 2 through 7 that now build an app
carrying a recorder.

If `issues.test.ts` or `ingest.test.ts` starts seeing an unexpected extra issue, something under
test is throwing where it used to return cleanly; that is a real finding, not test noise. Read
the recorded issue before changing any expectation.

- [ ] **Step 6: Commit**

```bash
./run check
git add -A
git commit -m "feat(self): record vigil's own failures without going through ingest"
```

---

### Task 9: The client package — scaffolding, redaction, and the payload builder

`client/` imports nothing from `server/`, so extracting it later is a move rather than a rewrite.
Its tests run with no server and no database.

**Files:**
- Create: `client/package.json`, `client/tsconfig.json`, `client/vitest.config.ts`
- Create: `client/src/redact.ts`, `client/src/payload.ts`
- Test: `client/tests/redact.test.ts`, `client/tests/payload.test.ts`

**Interfaces:**
- Consumes: nothing. **Do not import from `server/`** — not the schemas, not the fingerprinter.
- Produces:
  - From `client/src/redact.ts`:
    - `const ALWAYS_REDACTED: readonly string[]` — `authorization`, `cookie`, `set-cookie`,
      `proxy-authorization`, `x-api-key`, `password`, `token`, `secret`.
    - `redact(value: unknown, secrets?: readonly string[]): unknown`
  - From `client/src/payload.ts`:
    - `interface WireEvent { type: string; message: string; stack?: string; occurred_at: string; context?: Record<string, unknown>; count?: number; fingerprint?: string }`
    - `toWireEvent(error: unknown, context: Record<string, unknown> | undefined, secrets: readonly string[]): WireEvent`
    - `collapseKey(event: WireEvent): string`

- [ ] **Step 1: Write the workspace files**

`client/package.json`:

```json
{
  "name": "@vigil/client",
  "version": "0.1.0",
  "type": "module",
  "files": ["dist"],
  "exports": {
    "./node": { "types": "./dist/node.d.ts", "default": "./dist/node.js" }
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "devDependencies": {
    "@types/node": "^26.1.2",
    "typescript": "^7.0.2",
    "vitest": "^4.1.10"
  }
}
```

No `dependencies`. A monitoring client that drags a dependency tree into every application it
watches is a liability the applications did not ask for; `fetch` and `node:` builtins are enough.

`client/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

`tests/` is outside `rootDir` so it stays out of `dist`. Type-check it by running vitest; the
`./run check` step for this workspace is `npx tsc --noEmit` over `src`.

`client/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

// No global setup, no container, no database. If this suite ever needs one, the package has
// grown a dependency on the server it is not allowed to have.
export default defineConfig({
  test: { include: ['tests/**/*.test.ts'] },
})
```

- [ ] **Step 2: Write the failing redaction test**

`client/tests/redact.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { redact } from '../src/redact.js'

describe('redact', () => {
  it('removes the headers a stack trace most often carries', () => {
    const scrubbed = redact({
      authorization: 'Bearer sk_live_abc',
      cookie: 'session=xyz',
      'set-cookie': 'session=xyz',
      route: '/api/bookings',
    }) as Record<string, unknown>

    expect(scrubbed.authorization).toBe('[redacted]')
    expect(scrubbed.cookie).toBe('[redacted]')
    expect(scrubbed['set-cookie']).toBe('[redacted]')
    expect(scrubbed.route).toBe('/api/bookings')
  })

  it('matches a key however it is cased or spelled', () => {
    const scrubbed = redact({
      Authorization: 'a',
      AUTHORIZATION: 'b',
      apiKey: 'c',
      api_key: 'd',
      accessToken: 'e',
    }) as Record<string, string>
    expect(Object.values(scrubbed)).toEqual(Array(5).fill('[redacted]'))
  })

  it('reaches into nested objects and arrays', () => {
    const scrubbed = redact({
      request: { headers: { cookie: 'session=xyz' } },
      attempts: [{ authorization: 'Bearer x' }],
    }) as { request: { headers: Record<string, string> }; attempts: Array<Record<string, string>> }

    expect(scrubbed.request.headers.cookie).toBe('[redacted]')
    expect(scrubbed.attempts[0]!.authorization).toBe('[redacted]')
  })

  // The governing invariant of the reference application: its third-party API key never leaves
  // its server. A stack trace or a captured context is a plausible way for it to escape, and
  // scrubbing happens here so the secret never crosses the wire — not even to vigil.
  it('removes a configured secret wherever its value appears', () => {
    const scrubbed = redact(
      { url: 'https://engine.example/?key=bk_live_secret', note: 'fine' },
      ['bk_live_secret'],
    ) as Record<string, string>

    expect(scrubbed.url).toBe('[redacted]')
    expect(scrubbed.note).toBe('fine')
  })

  it('ignores a blank configured secret rather than redacting everything', () => {
    const scrubbed = redact({ note: 'fine' }, ['', '   ']) as Record<string, string>
    expect(scrubbed.note).toBe('fine')
  })

  it('leaves primitives alone', () => {
    expect(redact('plain')).toBe('plain')
    expect(redact(42)).toBe(42)
    expect(redact(null)).toBeNull()
    expect(redact(undefined)).toBeUndefined()
  })

  // Rule one of §8: never throw into the host. A cyclic context is ordinary — a request object
  // referring to its own response — and must not become an exception raised by the monitor.
  it('survives a cycle', () => {
    const cyclic: Record<string, unknown> = { name: 'root' }
    cyclic.self = cyclic
    expect(() => redact(cyclic)).not.toThrow()
    expect((redact(cyclic) as Record<string, unknown>).self).toBe('[circular]')
  })

  it('stops at a sane depth rather than walking a huge graph', () => {
    let deep: Record<string, unknown> = { end: true }
    for (let i = 0; i < 50; i += 1) deep = { nested: deep }
    expect(() => redact(deep)).not.toThrow()
  })

  it('does not mutate what it was given', () => {
    const original = { authorization: 'Bearer x' }
    redact(original)
    expect(original.authorization).toBe('Bearer x')
  })

  it('renders a value it cannot serialise rather than failing on it', () => {
    const scrubbed = redact({ when: new Date(0), how: () => 1, big: 10n }) as Record<string, unknown>
    expect(scrubbed.when).toBe('1970-01-01T00:00:00.000Z')
    expect(scrubbed.how).toBe('[function]')
    expect(scrubbed.big).toBe('10')
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd client && npx vitest run tests/redact.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write `client/src/redact.ts`**

```ts
/**
 * Matched as substrings of a key, lowercased with separators removed, so `Authorization`,
 * `api_key`, `apiKey` and `X-API-KEY` are all caught by one entry.
 */
export const ALWAYS_REDACTED: readonly string[] = [
  'authorization',
  'cookie',
  'setcookie',
  'proxyauthorization',
  'apikey',
  'password',
  'token',
  'secret',
]

const PLACEHOLDER = '[redacted]'
const MAX_DEPTH = 12

function isSensitiveKey(key: string): boolean {
  const flat = key.toLowerCase().replace(/[-_\s]/g, '')
  return ALWAYS_REDACTED.some((needle) => flat.includes(needle))
}

/**
 * Scrubs before anything is queued, so a secret never crosses the wire — not even to vigil.
 * Never throws: rule one of §8 is that the monitor must not damage its host, and a context it
 * cannot walk is not a reason to raise an exception inside somebody else's error handler.
 */
export function redact(value: unknown, secrets: readonly string[] = []): unknown {
  const live = secrets.map((s) => s.trim()).filter((s) => s !== '')
  const seen = new WeakSet<object>()

  function walk(node: unknown, depth: number): unknown {
    if (node === null || node === undefined) return node

    if (typeof node === 'string') {
      return live.some((secret) => node.includes(secret)) ? PLACEHOLDER : node
    }
    if (typeof node === 'number' || typeof node === 'boolean') return node
    if (typeof node === 'bigint') return node.toString()
    if (typeof node === 'function') return '[function]'
    if (typeof node === 'symbol') return node.toString()

    if (node instanceof Date) return node.toISOString()
    if (node instanceof Error) return `${node.name}: ${node.message}`

    if (depth >= MAX_DEPTH) return '[deep]'
    if (seen.has(node as object)) return '[circular]'
    seen.add(node as object)

    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1))

    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? PLACEHOLDER : walk(item, depth + 1)
    }
    return out
  }

  try {
    return walk(value, 0)
  } catch {
    // A getter that throws, an exotic proxy: whatever it was, the host does not hear about it.
    return '[unredactable]'
  }
}
```

- [ ] **Step 5: Write the failing payload test**

`client/tests/payload.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { collapseKey, toWireEvent } from '../src/payload.js'

describe('toWireEvent', () => {
  it('carries the error type, message and stack', () => {
    const event = toWireEvent(new TypeError('boom'), undefined, [])
    expect(event.type).toBe('TypeError')
    expect(event.message).toBe('boom')
    expect(event.stack).toContain('TypeError: boom')
    expect(event.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('keeps a custom error class name, which is what the owner recognises', () => {
    class EngineUnreachableError extends Error {
      constructor(message: string) {
        super(message)
        this.name = 'EngineUnreachableError'
      }
    }
    expect(toWireEvent(new EngineUnreachableError('no answer'), undefined, []).type).toBe(
      'EngineUnreachableError',
    )
  })

  // A codebase that throws strings still needs its failures recorded, and the alternative to
  // handling it here is the monitor throwing while reporting somebody else's throw.
  it('accepts something that is not an Error at all', () => {
    expect(toWireEvent('just a string', undefined, [])).toMatchObject({
      type: 'Error',
      message: 'just a string',
    })
    expect(toWireEvent(undefined, undefined, [])).toMatchObject({ type: 'Error' })
    expect(toWireEvent({ code: 'ECONNRESET' }, undefined, []).message).toContain('ECONNRESET')
  })

  it('scrubs the context before it is ever queued', () => {
    const event = toWireEvent(new Error('x'), { headers: { cookie: 'session=xyz' } }, [])
    expect(event.context).toEqual({ headers: { cookie: '[redacted]' } })
  })

  it('scrubs a configured secret out of the message and the stack', () => {
    const error = new Error('calling engine with key bk_live_secret')
    const event = toWireEvent(error, undefined, ['bk_live_secret'])
    expect(event.message).not.toContain('bk_live_secret')
    expect(event.stack ?? '').not.toContain('bk_live_secret')
  })

  it('omits the context entirely when there is none', () => {
    expect(toWireEvent(new Error('x'), undefined, []).context).toBeUndefined()
  })

  it('passes an explicit fingerprint through', () => {
    const event = toWireEvent(new Error('x'), { vigilFingerprint: 'checkout' }, [])
    expect(event.fingerprint).toBe('checkout')
    // Consumed, not also sent as context: it is an instruction, not data about the failure.
    expect(event.context).toBeUndefined()
  })
})

describe('collapseKey', () => {
  const event = (over: Partial<ReturnType<typeof toWireEvent>> = {}) => ({
    ...toWireEvent(new Error('boom'), undefined, []),
    ...over,
  })

  it('is the same for two throws of the same error at the same place', () => {
    const a = event({ stack: 'Error: boom\n    at f (/a.js:1:1)' })
    const b = event({ stack: 'Error: boom\n    at f (/a.js:1:1)' })
    expect(collapseKey(a)).toBe(collapseKey(b))
  })

  it('differs when the message differs', () => {
    expect(collapseKey(event({ message: 'one' }))).not.toBe(collapseKey(event({ message: 'two' })))
  })

  it('differs when the throw site differs', () => {
    const a = event({ stack: 'Error: boom\n    at f (/a.js:1:1)' })
    const b = event({ stack: 'Error: boom\n    at g (/b.js:1:1)' })
    expect(collapseKey(a)).not.toBe(collapseKey(b))
  })

  it('works with no stack at all', () => {
    expect(() => collapseKey(event({ stack: undefined }))).not.toThrow()
  })

  it('ignores the timestamp, which is what makes collapsing possible', () => {
    const a = event({ occurred_at: '2026-09-07T10:00:00.000Z' })
    const b = event({ occurred_at: '2026-09-07T11:00:00.000Z' })
    expect(collapseKey(a)).toBe(collapseKey(b))
  })

  it('never collapses two explicitly fingerprinted events into one another', () => {
    expect(collapseKey(event({ fingerprint: 'a' }))).not.toBe(collapseKey(event({ fingerprint: 'b' })))
  })
})
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd client && npx vitest run tests/payload.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Write `client/src/payload.ts`**

```ts
import { redact } from './redact.js'

/**
 * Exactly what `POST /ingest/events` accepts for one event. Kept in step with the server's
 * TypeBox schema by the integration test in Task 11, which posts this shape at a real server —
 * there is no shared type, by design (§3).
 */
export interface WireEvent {
  type: string
  message: string
  stack?: string
  occurred_at: string
  context?: Record<string, unknown>
  count?: number
  fingerprint?: string
}

/** Recognised in a context and lifted out as §7's escape hatch rather than sent as data. */
const FINGERPRINT_KEY = 'vigilFingerprint'

function describe(error: unknown): { type: string; message: string; stack?: string } {
  if (error instanceof Error) {
    // `name` and not `constructor.name`: a custom class that sets `name` is telling us what the
    // owner calls it, and that is the word they will recognise in the dashboard.
    return {
      type: error.name === '' ? 'Error' : error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    }
  }
  if (typeof error === 'string') return { type: 'Error', message: error }

  // A thrown object, a thrown number, a thrown undefined. All real, all still worth recording.
  let message: string
  try {
    message = error === undefined ? 'undefined' : JSON.stringify(error) ?? String(error)
  } catch {
    message = String(error)
  }
  return { type: 'Error', message }
}

function scrubString(value: string, secrets: readonly string[]): string {
  let out = value
  for (const secret of secrets) {
    if (secret !== '') out = out.split(secret).join('[redacted]')
  }
  return out
}

export function toWireEvent(
  error: unknown,
  context: Record<string, unknown> | undefined,
  secrets: readonly string[],
): WireEvent {
  const live = secrets.map((s) => s.trim()).filter((s) => s !== '')
  const described = describe(error)

  const fingerprint = context?.[FINGERPRINT_KEY]
  const rest = { ...context }
  delete rest[FINGERPRINT_KEY]

  const scrubbed = Object.keys(rest).length === 0 ? undefined : redact(rest, live)

  return {
    type: described.type,
    // A secret in a message or a stack is the likeliest way one escapes: `connect ECONNREFUSED`
    // is harmless, `Bearer sk_live_…` in a fetch error is not.
    message: scrubString(described.message, live),
    ...(described.stack === undefined ? {} : { stack: scrubString(described.stack, live) }),
    occurred_at: new Date().toISOString(),
    ...(scrubbed === undefined ? {} : { context: scrubbed as Record<string, unknown> }),
    ...(typeof fingerprint === 'string' && fingerprint.trim() !== ''
      ? { fingerprint: fingerprint.trim() }
      : {}),
  }
}

/**
 * §8: a hot loop throwing the same error fifty thousand times sends one event with
 * `count: 50000`. This is the key those fifty thousand share.
 *
 * It is not the server's fingerprint and does not try to be — that lives in `server/` and this
 * package imports nothing from there. It only has to be conservative: two events with the same
 * key are certainly the same failure, and a key that splits too finely costs a few extra rows,
 * never a wrong grouping.
 */
export function collapseKey(event: WireEvent): string {
  if (event.fingerprint !== undefined) return `explicit:${event.fingerprint}`

  const firstFrame =
    event.stack
      ?.split('\n')
      .find((line) => line.trimStart().startsWith('at '))
      ?.trim() ?? ''

  return `${event.type}\n${event.message}\n${firstFrame}`
}
```

- [ ] **Step 8: Run both tests to verify they pass**

Run: `cd client && npx vitest run`
Expected: PASS, 10 + 13 tests.

- [ ] **Step 9: Commit**

```bash
./run check
git add -A
git commit -m "feat(client): add redaction and the wire payload builder"
```

---

### Task 10: The client queue and transport

The two pieces that make §8's four rules true. Both are pure enough to test without a network.

**Files:**
- Create: `client/src/queue.ts`, `client/src/transport.ts`
- Test: `client/tests/queue.test.ts`, `client/tests/transport.test.ts`

**Interfaces:**
- Consumes: `WireEvent`, `collapseKey` (Task 9).
- Produces:
  - From `client/src/queue.ts`:
    - `class EventQueue` with `constructor(maxEvents: number)`,
      `add(event: WireEvent): void`, `drain(): WireEvent[]`, `size(): number`,
      `readonly dropped: number`.
  - From `client/src/transport.ts`:
    - `interface Batch { environment: string; runtime: 'node'; events: WireEvent[] }`
    - `interface TransportOptions { url: string; key: string; timeoutMs: number; fetch?: typeof globalThis.fetch }`
    - `send(options: TransportOptions, batch: Batch): Promise<boolean>` — resolves `true` when
      accepted, `false` on any failure, and **never rejects**.

- [ ] **Step 1: Write the failing queue test**

`client/tests/queue.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { EventQueue } from '../src/queue.js'
import { toWireEvent } from '../src/payload.js'

const event = (message: string, stack = 'Error: x\n    at f (/a.js:1:1)') => ({
  ...toWireEvent(new Error(message), undefined, []),
  stack,
})

describe('EventQueue', () => {
  it('hands back what it was given, oldest first', () => {
    const queue = new EventQueue(10)
    queue.add(event('one'))
    queue.add(event('two'))
    expect(queue.drain().map((e) => e.message)).toEqual(['one', 'two'])
  })

  it('is empty after draining', () => {
    const queue = new EventQueue(10)
    queue.add(event('one'))
    queue.drain()
    expect(queue.size()).toBe(0)
    expect(queue.drain()).toEqual([])
  })

  // §8: a hot loop throwing the same error fifty thousand times sends one event with
  // count: 50000. Without this the first real incident takes the monitor down.
  it('collapses repeats of the same failure into one counted event', () => {
    const queue = new EventQueue(10)
    for (let i = 0; i < 50_000; i += 1) queue.add(event('boom'))

    const drained = queue.drain()
    expect(drained).toHaveLength(1)
    expect(drained[0]!.count).toBe(50_000)
  })

  it('keeps different failures apart while collapsing', () => {
    const queue = new EventQueue(10)
    queue.add(event('boom'))
    queue.add(event('other'))
    queue.add(event('boom'))

    const drained = queue.drain()
    expect(drained).toHaveLength(2)
    expect(drained.map((e) => [e.message, e.count])).toEqual([
      ['boom', 2],
      ['other', 1],
    ])
  })

  it('keeps the first timestamp of a collapsed run, which is when it started', () => {
    const queue = new EventQueue(10)
    const first = { ...event('boom'), occurred_at: '2026-09-07T10:00:00.000Z' }
    const later = { ...event('boom'), occurred_at: '2026-09-07T10:05:00.000Z' }
    queue.add(first)
    queue.add(later)
    expect(queue.drain()[0]!.occurred_at).toBe('2026-09-07T10:00:00.000Z')
  })

  it('adds an already-counted event to the run rather than replacing it', () => {
    const queue = new EventQueue(10)
    queue.add({ ...event('boom'), count: 3 })
    queue.add({ ...event('boom'), count: 4 })
    expect(queue.drain()[0]!.count).toBe(7)
  })

  // §8: a vigil outage must never grow the host application's heap. Dropping the oldest keeps
  // what is happening now, which is what the owner will be asked about.
  it('is bounded, and drops the oldest when it is full', () => {
    const queue = new EventQueue(3)
    for (let i = 0; i < 10; i += 1) queue.add(event(`failure ${i}`))

    const drained = queue.drain()
    expect(drained).toHaveLength(3)
    expect(drained.map((e) => e.message)).toEqual(['failure 7', 'failure 8', 'failure 9'])
  })

  it('counts what it dropped, so the client can say so once', () => {
    const queue = new EventQueue(2)
    for (let i = 0; i < 5; i += 1) queue.add(event(`failure ${i}`))
    expect(queue.dropped).toBe(3)
  })

  // The bound is on distinct failures. Collapsing must not be what pushes the queue over it.
  it('does not count a collapsed repeat against the bound', () => {
    const queue = new EventQueue(2)
    queue.add(event('a'))
    queue.add(event('b'))
    for (let i = 0; i < 100; i += 1) queue.add(event('a'))

    expect(queue.dropped).toBe(0)
    expect(queue.drain().map((e) => [e.message, e.count])).toEqual([
      ['a', 101],
      ['b', 1],
    ])
  })

  it('accepts a queue of one', () => {
    const queue = new EventQueue(1)
    queue.add(event('a'))
    queue.add(event('b'))
    expect(queue.drain().map((e) => e.message)).toEqual(['b'])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd client && npx vitest run tests/queue.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `client/src/queue.ts`**

```ts
import { collapseKey, type WireEvent } from './payload.js'

/**
 * Bounded and collapsing, because a monitoring client's characteristic failure is that it
 * damages the application it watches (§8).
 *
 * The bound counts *distinct* failures. A loop throwing one error a hundred thousand times
 * occupies one slot, which is what stops the first real incident from being the thing that
 * exhausts the host's heap.
 */
export class EventQueue {
  /** Insertion-ordered by construction, which is what makes drop-oldest a `keys()` read. */
  private readonly events = new Map<string, WireEvent>()
  private droppedCount = 0

  constructor(private readonly maxEvents: number) {
    if (!Number.isInteger(maxEvents) || maxEvents < 1) {
      throw new Error('maxEvents must be a positive integer')
    }
  }

  get dropped(): number {
    return this.droppedCount
  }

  add(event: WireEvent): void {
    const key = collapseKey(event)
    const existing = this.events.get(key)

    if (existing !== undefined) {
      // The first timestamp is kept: it is when the run started, and a run that has been going
      // for five minutes should not look like it started a moment ago.
      existing.count = (existing.count ?? 1) + (event.count ?? 1)
      return
    }

    if (this.events.size >= this.maxEvents) {
      // Oldest first. What is happening now is what the owner will be asked about.
      const oldest = this.events.keys().next()
      if (!oldest.done) {
        this.events.delete(oldest.value)
        this.droppedCount += 1
      }
    }

    this.events.set(key, { ...event, count: event.count ?? 1 })
  }

  size(): number {
    return this.events.size
  }

  drain(): WireEvent[] {
    const drained = [...this.events.values()]
    this.events.clear()
    return drained
  }
}
```

- [ ] **Step 4: Write the failing transport test**

`client/tests/transport.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { send } from '../src/transport.js'
import { toWireEvent } from '../src/payload.js'

const batch = {
  environment: 'production' as const,
  runtime: 'node' as const,
  events: [toWireEvent(new Error('boom'), undefined, [])],
}

const options = (fetchImpl: typeof globalThis.fetch) => ({
  url: 'https://vigil.example',
  key: 'vgl_abc',
  timeoutMs: 1_000,
  fetch: fetchImpl,
})

describe('send', () => {
  it('posts the batch to the ingest endpoint with the key as a bearer token', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }))
    expect(await send(options(fetchImpl as unknown as typeof fetch), batch)).toBe(true)

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://vigil.example/ingest/events')
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer vgl_abc')
    expect(new Headers(init.headers).get('content-type')).toBe('application/json')
    expect(JSON.parse(init.body as string)).toEqual(batch)
  })

  it('tolerates a base url with a trailing slash', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }))
    await send({ ...options(fetchImpl as unknown as typeof fetch), url: 'https://vigil.example/' }, batch)
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://vigil.example/ingest/events')
  })

  // Rule one of §8. Every one of these is a real thing vigil will do to a client one day, and
  // none of them may surface inside somebody else's error handler.
  it('never rejects, whatever the server does', async () => {
    const refused = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    const rejected = vi.fn(async () => new Response('nope', { status: 401 }))
    const broken = vi.fn(async () => new Response('boom', { status: 500 }))
    const oversize = vi.fn(async () => new Response('too big', { status: 413 }))

    for (const impl of [refused, rejected, broken, oversize]) {
      await expect(send(options(impl as unknown as typeof fetch), batch)).resolves.toBe(false)
    }
  })

  it('reports success for any 2xx', async () => {
    const accepted = vi.fn(async () => new Response(null, { status: 202 }))
    const ok = vi.fn(async () => new Response('{}', { status: 200 }))
    for (const impl of [accepted, ok]) {
      expect(await send(options(impl as unknown as typeof fetch), batch)).toBe(true)
    }
  })

  // A hung vigil must not hold a request — or a dying process — open indefinitely.
  it('gives up after the timeout', async () => {
    const hanging = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )
    const started = Date.now()
    const result = await send(
      { ...options(hanging as unknown as typeof fetch), timeoutMs: 50 },
      batch,
    )
    expect(result).toBe(false)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('sends nothing when the batch is empty', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }))
    expect(await send(options(fetchImpl as unknown as typeof fetch), { ...batch, events: [] })).toBe(true)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 5: Run it to verify it fails**

Run: `cd client && npx vitest run tests/transport.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 6: Write `client/src/transport.ts`**

```ts
import type { WireEvent } from './payload.js'

export interface Batch {
  environment: string
  runtime: 'node'
  events: WireEvent[]
}

export interface TransportOptions {
  /** Vigil's base URL. The path is this module's business, not the caller's. */
  url: string
  key: string
  timeoutMs: number
  /** Injected in tests; the global otherwise. */
  fetch?: typeof globalThis.fetch
}

/**
 * True when vigil accepted the batch, false for every other outcome. **Never rejects** — rule
 * one of §8. This runs inside somebody else's error handler, and a transport failure that
 * propagates would mean the monitor is the thing that broke the request.
 */
export async function send(options: TransportOptions, batch: Batch): Promise<boolean> {
  if (batch.events.length === 0) return true

  const post = options.fetch ?? globalThis.fetch
  const endpoint = `${options.url.replace(/\/+$/, '')}/ingest/events`

  // Constructed here rather than with AbortSignal.timeout so the timer can be cleared: a
  // pending timer would keep an otherwise-idle process alive for its duration.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)

  try {
    const response = await post(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(batch),
      signal: controller.signal,
    })
    return response.ok
  } catch {
    // A refused connection, a DNS failure, an abort, a serialisation error. The caller is told
    // false and decides; nothing reaches the host.
    return false
  } finally {
    clearTimeout(timer)
  }
}
```

- [ ] **Step 7: Run both tests to verify they pass**

Run: `cd client && npx vitest run`
Expected: PASS — the two new files add 10 + 6 tests to Task 9's 23.

- [ ] **Step 8: Commit**

```bash
./run check
git add -A
git commit -m "feat(client): add the bounded collapsing queue and the transport"
```

---

### Task 11: `@vigil/client/node` — install, capture, and dying honestly

The entry point a monitored application calls. This is where §8's second rule lives, and it is
the sharpest edge in the package: adding an `uncaughtException` listener stops Node from
exiting, so the client must put that behaviour back deliberately.

**Files:**
- Create: `client/src/node.ts`
- Test: `client/tests/node.test.ts`
- Test: `server/tests/integration/client-wire.test.ts` — the client's payload against the real
  endpoint, which is what keeps the two shapes in step without a shared type

**Interfaces:**
- Consumes: `toWireEvent`, `WireEvent` (Task 9); `EventQueue`, `send`, `Batch` (Task 10). On the
  server side: `buildTestApp`, `insertApp`, `insertKey`, `mintIngestKey` (Tasks 4–6).
- Produces, from `client/src/node.ts`:
  ```ts
  interface VigilOptions {
    url: string
    key: string
    /** A local label, used in this client's own log lines. Never sent: §4 reads the
        application from the key, and a body field the sender controls is one an attacker
        controls. */
    app: string
    environment: string
    secrets?: readonly string[]
    maxQueue?: number          // 100
    flushIntervalMs?: number   // 5_000
    timeoutMs?: number         // 3_000
    /** Milliseconds allowed to flush while the process is dying. */
    fatalFlushMs?: number      // 1_000
    /** See Step 3. Default true; false only when the host installs its own handler. */
    exitOnUncaught?: boolean
    fetch?: typeof globalThis.fetch
    log?: (message: string, detail?: unknown) => void
  }
  interface Vigil {
    captureError(error: unknown, context?: Record<string, unknown>): void
    flush(): Promise<void>
    close(): Promise<void>
  }
  function install(options: VigilOptions): Vigil
  ```

- [ ] **Step 1: Write the failing test**

`client/tests/node.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { install, type Vigil, type VigilOptions } from '../src/node.js'

let installed: Vigil | undefined

afterEach(async () => {
  await installed?.close()
  installed = undefined
  vi.restoreAllMocks()
})

interface Sent {
  environment: string
  runtime: string
  events: Array<{ type: string; message: string; count?: number; context?: Record<string, unknown> }>
}

function setup(overrides: Partial<VigilOptions> = {}) {
  const batches: Sent[] = []
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    batches.push(JSON.parse(init?.body as string) as Sent)
    return new Response(null, { status: 202 })
  })

  installed = install({
    url: 'https://vigil.example',
    key: 'vgl_abc',
    app: 'reference',
    environment: 'production',
    // Long enough that nothing flushes on its own; every test calls flush() when it means to.
    flushIntervalMs: 1_000_000,
    exitOnUncaught: false,
    fetch: fetchImpl as unknown as typeof fetch,
    ...overrides,
  })

  return { vigil: installed, batches, fetchImpl }
}

describe('captureError', () => {
  it('sends what was captured, with the environment and runtime', async () => {
    const { vigil, batches } = setup()
    vigil.captureError(new TypeError('boom'))
    await vigil.flush()

    expect(batches).toHaveLength(1)
    expect(batches[0]).toMatchObject({ environment: 'production', runtime: 'node' })
    expect(batches[0]!.events[0]).toMatchObject({ type: 'TypeError', message: 'boom' })
  })

  it('sends one batch for everything queued, not one request each', async () => {
    const { vigil, batches, fetchImpl } = setup()
    vigil.captureError(new Error('one'))
    vigil.captureError(new Error('two'))
    await vigil.flush()

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(batches[0]!.events).toHaveLength(2)
  })

  it('collapses a hot loop into one counted event', async () => {
    const { vigil, batches } = setup()
    for (let i = 0; i < 50_000; i += 1) vigil.captureError(new Error('boom'))
    await vigil.flush()

    expect(batches[0]!.events).toHaveLength(1)
    expect(batches[0]!.events[0]!.count).toBe(50_000)
  })

  it('scrubs the context before it leaves the process', async () => {
    const { vigil, batches } = setup({ secrets: ['bk_live_secret'] })
    vigil.captureError(new Error('failed calling engine'), {
      headers: { authorization: 'Bearer bk_live_secret' },
      url: 'https://engine.example/?key=bk_live_secret',
    })
    await vigil.flush()

    expect(JSON.stringify(batches[0])).not.toContain('bk_live_secret')
  })

  it('never sends the application name — the key decides which app this is', async () => {
    const { vigil, batches } = setup()
    vigil.captureError(new Error('boom'))
    await vigil.flush()
    expect(JSON.stringify(batches[0])).not.toContain('"app"')
  })

  it('sends nothing when there is nothing queued', async () => {
    const { vigil, fetchImpl } = setup()
    await vigil.flush()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  // Rule one of §8. If any of these throws, the monitor has broken the thing it watches.
  it('never throws into the host, whatever it is handed', async () => {
    const { vigil } = setup()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic

    expect(() => vigil.captureError(new Error('fine'))).not.toThrow()
    expect(() => vigil.captureError('a string')).not.toThrow()
    expect(() => vigil.captureError(undefined)).not.toThrow()
    expect(() => vigil.captureError(new Error('x'), cyclic)).not.toThrow()
    expect(() => vigil.captureError({ toString() { throw new Error('nope') } })).not.toThrow()
  })

  it('never throws when the transport fails', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    const { vigil } = setup({ fetch: failing as unknown as typeof fetch })
    vigil.captureError(new Error('boom'))
    await expect(vigil.flush()).resolves.toBeUndefined()
  })

  // A vigil outage must never grow the host's heap.
  it('is bounded, and keeps the newest', async () => {
    const { vigil, batches } = setup({ maxQueue: 3 })
    for (let i = 0; i < 100; i += 1) vigil.captureError(new Error(`failure ${i}`))
    await vigil.flush()

    expect(batches[0]!.events).toHaveLength(3)
    expect(batches[0]!.events.map((e) => e.message)).toEqual([
      'failure 97',
      'failure 98',
      'failure 99',
    ])
  })

  it('logs once when it drops, and does not repeat it every event', async () => {
    const log = vi.fn()
    const { vigil } = setup({ maxQueue: 2, log })
    for (let i = 0; i < 50; i += 1) vigil.captureError(new Error(`failure ${i}`))
    expect(log.mock.calls.filter(([m]) => String(m).includes('dropped')).length).toBe(1)
  })

  it('logs a transport failure once, not once per attempt', async () => {
    const log = vi.fn()
    const failing = vi.fn(async () => new Response('nope', { status: 500 }))
    const { vigil } = setup({ log, fetch: failing as unknown as typeof fetch })

    vigil.captureError(new Error('one'))
    await vigil.flush()
    vigil.captureError(new Error('two'))
    await vigil.flush()

    expect(log.mock.calls.filter(([m]) => String(m).includes('could not report')).length).toBe(1)
  })
})

describe('the periodic flush', () => {
  it('sends on its own without anyone calling flush', async () => {
    vi.useFakeTimers()
    try {
      const { vigil, fetchImpl } = setup({ flushIntervalMs: 100 })
      vigil.captureError(new Error('boom'))
      await vi.advanceTimersByTimeAsync(150)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  // A five-second timer that keeps a finished script running is the monitor changing how the
  // host behaves, which is exactly what §8 forbids.
  it('does not keep an otherwise-idle process alive', () => {
    const { vigil } = setup({ flushIntervalMs: 100 })
    // `unref` returns the timer; asserting it was called is the only observable proof.
    expect((vigil as unknown as { timerIsUnrefd: boolean }).timerIsUnrefd).toBe(true)
  })
})

describe('the process hooks', () => {
  const listeners = (event: 'uncaughtException' | 'unhandledRejection') =>
    process.listeners(event).length

  it('hooks both, and removes both on close', async () => {
    const before = { u: listeners('uncaughtException'), r: listeners('unhandledRejection') }
    const { vigil } = setup()
    expect(listeners('uncaughtException')).toBe(before.u + 1)
    expect(listeners('unhandledRejection')).toBe(before.r + 1)

    await vigil.close()
    installed = undefined
    expect(listeners('uncaughtException')).toBe(before.u)
    expect(listeners('unhandledRejection')).toBe(before.r)
  })

  it('reports an uncaught exception', async () => {
    const { batches } = setup()
    const handler = process.listeners('uncaughtException').at(-1) as (e: Error) => Promise<void>
    await handler(new Error('nobody caught this'))

    expect(batches[0]!.events[0]).toMatchObject({ message: 'nobody caught this' })
  })

  it('reports an unhandled rejection', async () => {
    const { batches } = setup()
    const handler = process.listeners('unhandledRejection').at(-1) as (
      reason: unknown,
    ) => Promise<void>
    await handler(new Error('nobody awaited this'))

    expect(batches[0]!.events[0]).toMatchObject({ message: 'nobody awaited this' })
  })

  // §8: never keep a dying process alive. A monitor that nurses a corrupted process along is
  // worse than the crash it hid — so after flushing, Node does what it would have done.
  it('exits after flushing an uncaught exception when it owns that decision', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const { batches } = setup({ exitOnUncaught: true })

    const handler = process.listeners('uncaughtException').at(-1) as (e: Error) => Promise<void>
    await handler(new Error('fatal'))

    expect(batches).toHaveLength(1)
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('leaves the decision alone when the host said it would handle it', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    setup({ exitOnUncaught: false })

    const handler = process.listeners('uncaughtException').at(-1) as (e: Error) => Promise<void>
    await handler(new Error('fatal'))

    expect(exit).not.toHaveBeenCalled()
  })

  // A hung vigil must not stop a crashed process from exiting.
  it('exits anyway when the flush hangs past the fatal timeout', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const hanging = vi.fn(() => new Promise<Response>(() => {}))
    setup({ exitOnUncaught: true, fatalFlushMs: 50, fetch: hanging as unknown as typeof fetch })

    const handler = process.listeners('uncaughtException').at(-1) as (e: Error) => Promise<void>
    const started = Date.now()
    await handler(new Error('fatal'))

    expect(exit).toHaveBeenCalledWith(1)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('exits even if reporting the exception throws outright', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const exploding = vi.fn(() => {
      throw new Error('transport is broken')
    })
    setup({ exitOnUncaught: true, fetch: exploding as unknown as typeof fetch })

    const handler = process.listeners('uncaughtException').at(-1) as (e: Error) => Promise<void>
    await expect(handler(new Error('fatal'))).resolves.toBeUndefined()
    expect(exit).toHaveBeenCalledWith(1)
  })
})

describe('close', () => {
  it('flushes what is queued', async () => {
    const { vigil, batches } = setup()
    vigil.captureError(new Error('last words'))
    await vigil.close()
    installed = undefined
    expect(batches[0]!.events[0]!.message).toBe('last words')
  })

  it('is safe to call twice', async () => {
    const { vigil } = setup()
    await vigil.close()
    await expect(vigil.close()).resolves.toBeUndefined()
    installed = undefined
  })

  it('accepts a capture after closing without throwing or sending', async () => {
    const { vigil, fetchImpl } = setup()
    await vigil.close()
    installed = undefined
    expect(() => vigil.captureError(new Error('too late'))).not.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd client && npx vitest run tests/node.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `client/src/node.ts`**

The `exitOnUncaught` default deserves its comment in the code, because it is the one place this
package changes how the host behaves:

```ts
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
  maxQueue?: number
  flushIntervalMs?: number
  timeoutMs?: number
  fatalFlushMs?: number
  exitOnUncaught?: boolean
  fetch?: typeof globalThis.fetch
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

export function install(options: VigilOptions): Vigil {
  const maxQueue = options.maxQueue ?? DEFAULTS.maxQueue
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULTS.flushIntervalMs
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs
  const fatalFlushMs = options.fatalFlushMs ?? DEFAULTS.fatalFlushMs
  const secrets = options.secrets ?? []
  const log = options.log ?? ((message: string) => console.warn(`[vigil] ${message}`))

  const queue = new EventQueue(maxQueue)
  let closed = false
  // Logged once each, not once per occurrence: a monitor that floods the host's log during an
  // outage has become the incident.
  let saidDropped = false
  let saidTransportFailed = false
  let lastDropped = 0

  function report(error: unknown, context?: Record<string, unknown>): void {
    if (closed) return
    try {
      queue.add(toWireEvent(error, context, secrets))
      if (queue.dropped > lastDropped && !saidDropped) {
        saidDropped = true
        log(`queue full; dropped ${queue.dropped} of the oldest events for ${options.app}`)
      }
      lastDropped = queue.dropped
    } catch (failure) {
      // Rule one: never throw into the host. This runs inside somebody else's error handler.
      try {
        log('could not queue an error', failure)
      } catch {
        /* even the log is not allowed to be the thing that throws */
      }
    }
  }

  async function flushOnce(): Promise<void> {
    const events = queue.drain()
    if (events.length === 0) return

    const batch: Batch = { environment: options.environment, runtime: 'node', events }
    let ok = false
    try {
      ok = await send(
        {
          url: options.url,
          key: options.key,
          timeoutMs,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        },
        batch,
      )
    } catch {
      ok = false
    }

    if (!ok && !saidTransportFailed) {
      saidTransportFailed = true
      log(`could not report ${events.length} events to ${options.url}`)
    }
    // Deliberately not requeued. A vigil outage would otherwise turn the queue into a growing
    // retry buffer in the host's heap, which is the one thing §8 forbids it to become.
  }

  const timer = setInterval(() => {
    void flushOnce()
  }, flushIntervalMs)
  // A five-second timer that keeps a finished script running is the monitor changing how the
  // host behaves. `unref` is what keeps `node script.js` exiting when the script is done.
  timer.unref()

  const onUncaught = async (error: unknown): Promise<void> => {
    report(error, { fatal: true })
    try {
      // A hung vigil must not stop a crashed process from exiting, so the flush races a clock.
      await Promise.race([
        flushOnce(),
        new Promise<void>((resolve) => setTimeout(resolve, fatalFlushMs).unref()),
      ])
    } catch {
      /* a failure here must not replace the crash the host is already having */
    }

    // Adding an `uncaughtException` listener stops Node from exiting. Left there, vigil would
    // turn every crash into a wedged process — a monitor nursing a corrupted process along is
    // worse than the crash it hid. So the default behaviour is put back deliberately.
    //
    // Set `exitOnUncaught: false` only when the host installs its own handler and owns the
    // decision itself.
    if (options.exitOnUncaught !== false) {
      process.exit(1)
    }
  }

  const onRejection = async (reason: unknown): Promise<void> => {
    report(reason, { unhandledRejection: true })
    await flushOnce()
  }

  process.on('uncaughtException', onUncaught)
  process.on('unhandledRejection', onRejection)

  return {
    captureError: report,
    flush: flushOnce,
    async close(): Promise<void> {
      if (closed) return
      closed = true
      clearInterval(timer)
      process.off('uncaughtException', onUncaught)
      process.off('unhandledRejection', onRejection)
      await flushOnce()
    },
  }
}
```

The test `'does not keep an otherwise-idle process alive'` reads a `timerIsUnrefd` property that
the code above does not expose. Either expose it — `Object.assign(api, { timerIsUnrefd: true })`
on the returned object, marked clearly as a test seam — or replace that case with one that spies
on `Timeout.prototype.unref`. Prefer the spy; a test seam on a published package is a worse
trade than a slightly awkward assertion.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && npx vitest run tests/node.test.ts`
Expected: PASS, 24 tests.

`process.exit` is mocked in the fatal cases. If a run ever exits mid-suite, the mock is not in
place before the handler is invoked — check the `beforeEach` ordering rather than weakening the
assertion.

- [ ] **Step 5: Write the wire-compatibility test on the server side**

`client/` and `server/` share no types by design (§3), so one test posts the client's real
payload at the real endpoint. This is what would catch a field renamed on one side only.

`server/tests/integration/client-wire.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, getTestDb, resetDb } from './helpers.js'
import { insertApp } from '../../src/modules/apps/app.repository.js'
import { insertKey, mintIngestKey } from '../../src/modules/ingest/key.repository.js'
import { install } from '../../../client/src/node.js'

let app: FastifyInstance
let key: string

const db = () => getTestDb()

beforeAll(async () => {
  app = await buildTestApp()
  // A real port: the client posts with fetch, not with app.inject.
  await app.listen({ port: 0, host: '127.0.0.1' })
})
beforeEach(async () => {
  await resetDb()
  const reference = await insertApp(db(), 'reference', 'The reference application')
  key = mintIngestKey()
  await insertKey(db(), reference.id, 'server', key)
})
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

const vigilUrl = () => {
  const address = app.server.address()
  if (address === null || typeof address === 'string') throw new Error('not listening on a port')
  return `http://127.0.0.1:${address.port}`
}

describe('the published client against the real endpoint', () => {
  it('reports an error the server accepts, groups and can serve back', async () => {
    const vigil = install({
      url: vigilUrl(),
      key,
      app: 'reference',
      environment: 'production',
      flushIntervalMs: 1_000_000,
      exitOnUncaught: false,
    })

    try {
      vigil.captureError(new TypeError('the client and the server agree'), { route: '/x' })
      await vigil.flush()
    } finally {
      await vigil.close()
    }

    const issue = await db().selectFrom('issues').selectAll().executeTakeFirstOrThrow()
    expect(issue.title).toBe('TypeError: the client and the server agree')
    expect(issue.runtime).toBe('node')
    expect(issue.environment).toBe('production')
    expect(issue.culprit).not.toBeNull()

    const event = await db().selectFrom('events').selectAll().executeTakeFirstOrThrow()
    expect(event.context).toMatchObject({ route: '/x' })
  })

  it('sends a collapsed run the server counts as a run', async () => {
    const vigil = install({
      url: vigilUrl(),
      key,
      app: 'reference',
      environment: 'production',
      flushIntervalMs: 1_000_000,
      exitOnUncaught: false,
    })

    try {
      for (let i = 0; i < 1_000; i += 1) vigil.captureError(new Error('hot loop'))
      await vigil.flush()
    } finally {
      await vigil.close()
    }

    const issue = await db().selectFrom('issues').selectAll().executeTakeFirstOrThrow()
    expect(issue.occurrence_count).toBe(1_000)
    expect(await db().selectFrom('events').selectAll().execute()).toHaveLength(1)
  })

  // The redaction promise is only worth anything if it survives the round trip.
  it('never lets a configured secret reach the database', async () => {
    const vigil = install({
      url: vigilUrl(),
      key,
      app: 'reference',
      environment: 'production',
      secrets: ['bk_live_secret'],
      flushIntervalMs: 1_000_000,
      exitOnUncaught: false,
    })

    try {
      vigil.captureError(new Error('calling engine with bk_live_secret'), {
        headers: { authorization: 'Bearer bk_live_secret' },
      })
      await vigil.flush()
    } finally {
      await vigil.close()
    }

    const rows = await db().selectFrom('events').selectAll().execute()
    expect(JSON.stringify(rows)).not.toContain('bk_live_secret')
  })

  it('is refused by the server when its key is revoked, and does not throw', async () => {
    await db().updateTable('ingest_keys').set({ revoked_at: new Date() }).execute()
    const vigil = install({
      url: vigilUrl(),
      key,
      app: 'reference',
      environment: 'production',
      flushIntervalMs: 1_000_000,
      exitOnUncaught: false,
      log: () => {},
    })

    try {
      vigil.captureError(new Error('into the void'))
      await expect(vigil.flush()).resolves.toBeUndefined()
    } finally {
      await vigil.close()
    }

    expect(await db().selectFrom('events').selectAll().execute()).toHaveLength(0)
  })
})
```

This is the one file in `server/` that reaches into `client/`, and only in a test. Add
`"../client/src"` to `server/tsconfig.json`'s `include` array so `tsc --noEmit` type-checks it;
if that proves awkward, import from `@vigil/client/node` instead and add
`"@vigil/client": "*"` to `server/package.json`'s `devDependencies` — npm workspaces will link
it. Either way, **`server/src` must never import from `client/`**.

- [ ] **Step 6: Run both suites**

Run: `cd client && npx vitest run && cd ../server && npx vitest run`
Expected: PASS everywhere.

- [ ] **Step 7: Commit**

```bash
./run check
git add -A
git commit -m "feat(client): add the node entry point and prove it against the endpoint"
```

---

### Task 12: The dashboard — workspace, API client, and login

§11, the minimum that lets the owner in. Two of the five screens land here and in Task 13; the
Overview, Monitors and Settings screens belong to Slices 2 and 3.

**Files:**
- Create: `web/package.json`, `web/tsconfig.json`, `web/vite.config.ts`, `web/index.html`
- Create: `web/src/main.tsx`, `web/src/App.tsx`, `web/src/api.ts`, `web/src/errors.ts`,
  `web/src/styles.css`, `web/src/routes/Login.tsx`
- Modify: root `package.json` — nothing; the workspace was declared in Task 1

**Interfaces:**
- Consumes: `POST /api/login`, `POST /api/logout`, `GET /api/me` (Task 4).
- Produces:
  - From `web/src/api.ts`: `class ApiError` (`code`, `status`, `message`, `details?`),
    `class NotSignedIn extends ApiError`, `api.get<T>(path)`, `api.post<T>(path, payload?)`,
    `api.patch<T>(path, payload)`, and the response types
    `interface IssueSummary`, `interface IssueOccurrence`, `interface AppSummary` used by
    Task 13.
  - From `web/src/errors.ts`: `messageFor(cause: unknown, fallback?: string): string`.
  - From `web/src/App.tsx`: `App`, and `RequireSession` for Task 13's routes.

- [ ] **Step 1: Write the workspace files**

`web/package.json`:

```json
{
  "name": "@vigil/web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@tanstack/react-query": "^5.90.2",
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    "react-router": "^7.9.3"
  },
  "devDependencies": {
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0",
    "@vitejs/plugin-react": "^5.0.4",
    "vite": "^8.2.2"
  }
}
```

`web/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "noEmit": true,
    "types": ["vite/client"],
    "verbatimModuleSyntax": true
  },
  "include": ["src", "vite.config.ts"]
}
```

`web/vite.config.ts`:

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // One origin in development too, so the session cookie needs no cross-site relaxation and
  // there is no CORS to configure differently from production.
  //
  // `changeOrigin: false` is load-bearing, not tidiness. The server refuses any write whose
  // `Origin` disagrees with the `Host` it was addressed to. Left to its default the proxy
  // rewrites `Host` to the target while the browser's `Origin` stays the dev server's, and
  // every write in development is refused. The shorthand string form takes that default
  // silently.
  server: { proxy: { '/api': { target: 'http://localhost:4100', changeOrigin: false } } },
  build: { outDir: '../server/public', emptyOutDir: true },
})
```

`web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>vigil</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Write `web/src/api.ts`**

```ts
/**
 * Every call goes to vigil's own server, on the same origin. There is no second backend: an
 * ingest key never reaches a browser in this slice, and the dashboard authenticates with a
 * session cookie it cannot read.
 */

export interface ApiErrorBody {
  error: string
  message: string
  details?: unknown
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** Raised on a 401 so the router can show the login screen instead of a broken page. */
export class NotSignedIn extends ApiError {}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      // The session cookie is httpOnly; the browser attaches it, nothing here reads it.
      credentials: 'same-origin',
      headers: {
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
      },
    })
  } catch {
    throw new ApiError('offline', 0, 'Cannot reach the server.')
  }

  if (response.status === 204) return undefined as T

  const body = (await response.json().catch(() => ({}))) as Partial<ApiErrorBody>

  if (!response.ok) {
    const message = body.message ?? `Error ${response.status}`
    if (response.status === 401) {
      throw new NotSignedIn(body.error ?? 'unauthorized', 401, message)
    }
    throw new ApiError(body.error ?? 'unknown', response.status, message, body.details)
  }

  return body as T
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, payload?: unknown) =>
    request<T>(path, {
      method: 'POST',
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    }),
  patch: <T>(path: string, payload: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(payload) }),
}

export type IssueStatus = 'open' | 'resolved' | 'ignored'

export interface IssueSummary {
  id: string
  app_slug: string
  app_name: string
  environment: string
  title: string
  culprit: string | null
  runtime: 'node' | 'browser'
  status: IssueStatus
  first_seen_at: string
  last_seen_at: string
  occurrence_count: number
}

export interface IssueOccurrence {
  id: string
  /** When the application says it happened. */
  occurred_at: string
  /** When vigil stored it. The two differ when an offline queue replayed late. */
  received_at: string
  message: string
  stack: string | null
  context: Record<string, unknown> | null
  count: number
}

export interface AppSummary {
  id: string
  slug: string
  name: string
}
```

- [ ] **Step 3: Write `web/src/errors.ts`**

```ts
import { ApiError } from './api'

/**
 * Only a code is ever looked up here. A server message is never shown: those are written for
 * whoever maintains vigil and for the test suite, and the vocabulary they share with the
 * interface is the code, not the sentence.
 */
const COPY: Record<string, string> = {
  offline: 'Cannot reach the server. Check your connection.',
  unauthorized: 'Your session expired. Sign in again.',
  validation_error: 'The server refused that request.',
  not_found: 'That is not here any more.',
  conflict: 'Something changed while you were looking. Reload and try again.',
  payload_too_large: 'That report was too large to store.',
  bad_request: 'The server refused that request.',
  internal_error: 'Something went wrong on the server. Try again.',
}

const GENERIC = 'Something went wrong. Try again.'

/**
 * `fallback` says what failed, for a code with no copy of its own — "could not resolve the
 * issue" reads better than the generic line when the screen knows what was being attempted.
 */
export function messageFor(cause: unknown, fallback: string = GENERIC): string {
  if (cause instanceof ApiError) return COPY[cause.code] ?? fallback
  return fallback
}
```

- [ ] **Step 4: Write `main.tsx`, `App.tsx` and `Login.tsx`**

`web/src/main.tsx`:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from './App'
import './styles.css'

const client = new QueryClient({
  defaultOptions: {
    queries: {
      // "Is it still happening" is the question this tool exists to answer, so a stale list is
      // worse than a slightly chatty one.
      staleTime: 10_000,
      refetchOnWindowFocus: true,
      retry: false,
    },
  },
})

const root = document.getElementById('root')
if (root === null) throw new Error('No #root in the document')

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
```

`web/src/App.tsx` — Task 13 fills in the two issue routes:

```tsx
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { api, NotSignedIn } from './api'
import { messageFor } from './errors'
import { Login } from './routes/Login'

/**
 * The session is checked by asking the server, never by reading a cookie: the cookie is
 * httpOnly, and a client-side guess about whether it is still valid would eventually disagree
 * with the server that decides.
 */
export function RequireSession({ children }: { children: ReactNode }) {
  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => api.get<{ signedIn: true }>('/api/me'),
    retry: false,
  })

  if (session.isPending) return <Waiting />
  if (session.error instanceof NotSignedIn) return <Navigate to="/login" replace />
  if (session.error) return <Trouble message={messageFor(session.error)} />
  return <>{children}</>
}

function Waiting() {
  return (
    <div className="waiting" role="status" aria-live="polite">
      Loading…
    </div>
  )
}

function Trouble({ message }: { message: string }) {
  return (
    <div className="trouble" role="alert">
      <p>{message}</p>
      <button type="button" onClick={() => window.location.reload()}>
        Try again
      </button>
    </div>
  )
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        {/* Task 13 replaces this with the Issues and IssueDetail routes. */}
        <Route
          path="/"
          element={
            <RequireSession>
              <p>Signed in.</p>
            </RequireSession>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
```

`web/src/routes/Login.tsx`:

```tsx
import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { api, ApiError } from '../api'
import { messageFor } from '../errors'

export function Login() {
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      await api.post('/api/login', { password })
      await navigate('/', { replace: true })
    } catch (cause) {
      // The server answers the same way for a wrong password and for one never set, and this
      // says the same thing back: which of the two it is must not be readable from here.
      setError(
        cause instanceof ApiError && cause.status === 401
          ? 'Wrong password'
          : messageFor(cause, 'Could not sign in'),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="login">
      <form className="card login__card" onSubmit={submit}>
        <h1 className="login__title">vigil</h1>
        <p className="login__subtitle">What broke, and whether it is still breaking</p>

        <label className="label" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          className="input"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />

        {error !== undefined && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <button className="button" type="submit" disabled={busy || password.length === 0}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  )
}
```

- [ ] **Step 5: Write `web/src/styles.css`**

One stylesheet for the whole dashboard. It is an operator's tool read at 3am, so: a dark ground,
generous line height on the monospace that carries stacks, and status colours that survive being
the only signal on the screen.

```css
:root {
  --bg: #14161a;
  --surface: #1c1f25;
  --surface-raised: #23272e;
  --line: #2f343d;
  --text: #e6e8ec;
  --muted: #9aa3b0;
  --accent: #6ea8fe;
  --open: #f07171;
  --resolved: #6fcf97;
  --ignored: #8a8f98;
  --mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
  color-scheme: dark;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 15px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif;
}

a {
  color: inherit;
  text-decoration: none;
}

.card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 20px;
}

.label {
  display: block;
  margin-bottom: 6px;
  color: var(--muted);
  font-size: 13px;
}

.input,
.select {
  width: 100%;
  padding: 10px 12px;
  background: var(--surface-raised);
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--text);
  font: inherit;
}

.button {
  padding: 10px 16px;
  background: var(--accent);
  border: none;
  border-radius: 8px;
  color: #10141b;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.button:disabled {
  opacity: 0.5;
  cursor: default;
}

.button--quiet {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--text);
  font-weight: 400;
}

.error {
  color: var(--open);
  margin: 12px 0 0;
}

.waiting,
.trouble {
  padding: 40px;
  color: var(--muted);
  text-align: center;
}

/* login */
.login {
  display: grid;
  place-items: center;
  min-height: 100vh;
  padding: 20px;
}

.login__card {
  width: 100%;
  max-width: 340px;
}

.login__title {
  margin: 0;
  font-size: 28px;
  letter-spacing: -0.02em;
}

.login__subtitle {
  margin: 4px 0 24px;
  color: var(--muted);
  font-size: 14px;
}

.login__card .button {
  width: 100%;
  margin-top: 16px;
}

/* screen chrome */
.screen {
  max-width: 1100px;
  margin: 0 auto;
  padding: 24px 20px 64px;
}

.screen__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}

.screen__title {
  margin: 0;
  font-size: 22px;
  letter-spacing: -0.01em;
}

.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 16px;
}

.filters .select {
  width: auto;
  min-width: 150px;
}

/* the issue list */
.issues {
  display: flex;
  flex-direction: column;
  gap: 8px;
  list-style: none;
  margin: 0;
  padding: 0;
}

.issue {
  display: grid;
  grid-template-columns: 4px 1fr auto;
  gap: 14px;
  align-items: center;
  padding: 14px 16px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 10px;
}

.issue:hover {
  border-color: var(--accent);
}

.issue__bar {
  align-self: stretch;
  border-radius: 2px;
  background: var(--ignored);
}

.issue__bar--open {
  background: var(--open);
}

.issue__bar--resolved {
  background: var(--resolved);
}

.issue__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.issue__culprit {
  margin: 4px 0 0;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 12.5px;
  overflow-wrap: anywhere;
}

.issue__meta {
  margin: 6px 0 0;
  color: var(--muted);
  font-size: 12.5px;
}

.issue__count {
  font-variant-numeric: tabular-nums;
  font-size: 20px;
  font-weight: 600;
  text-align: right;
}

.issue__count small {
  display: block;
  color: var(--muted);
  font-size: 11px;
  font-weight: 400;
}

.tag {
  display: inline-block;
  padding: 1px 7px;
  margin-right: 6px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--muted);
  font-size: 11px;
}

.empty {
  padding: 48px 20px;
  color: var(--muted);
  text-align: center;
}

/* issue detail */
.detail__actions {
  display: flex;
  gap: 8px;
}

.stack {
  margin: 0;
  padding: 16px;
  background: var(--surface-raised);
  border: 1px solid var(--line);
  border-radius: 10px;
  color: var(--text);
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.7;
  overflow-x: auto;
  white-space: pre;
}

.stack__frame--vendor {
  color: var(--muted);
}

.section {
  margin-top: 28px;
}

.section__title {
  margin: 0 0 10px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted);
}

.occurrences {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 10px;
  overflow: hidden;
}

.occurrence {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  background: var(--surface);
  border-bottom: 1px solid var(--line);
  font-size: 13px;
}

.occurrence:last-child {
  border-bottom: none;
}

.occurrence__late {
  color: var(--muted);
  font-size: 12px;
}
```

- [ ] **Step 6: Run it and sign in**

```bash
./run dev --bg
```

Open `http://localhost:5174`. Expected: the login form; the owner password set in Task 5 gets in
and the page says "Signed in."; a wrong one says "Wrong password". Then `./run stop`.

- [ ] **Step 7: Commit**

```bash
./run check
git add -A
git commit -m "feat(web): add the dashboard workspace, api client and login screen"
```

---

### Task 13: The issues list and issue detail

**Files:**
- Create: `web/src/routes/Issues.tsx`, `web/src/routes/IssueDetail.tsx`, `web/src/format.ts`
- Modify: `web/src/App.tsx` — the two real routes

**Interfaces:**
- Consumes: `api`, `IssueSummary`, `IssueOccurrence`, `AppSummary`, `IssueStatus` (Task 12);
  `GET /api/issues`, `GET /api/issues/:id`, `PATCH /api/issues/:id`, `GET /api/apps` (Task 7).
- Produces:
  - From `web/src/format.ts`: `relativeTime(iso: string): string`,
    `splitFrames(stack: string): Array<{ text: string; vendor: boolean }>`.
  - `Issues` and `IssueDetail` components.

- [ ] **Step 1: Write `web/src/format.ts`**

```ts
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * "2h ago" rather than a timestamp, because the only question the list answers is whether
 * something is still happening. The exact time is on the detail screen, where it matters.
 */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return 'unknown'

  const elapsed = Date.now() - then
  if (elapsed < 0) return 'just now'
  if (elapsed < MINUTE) return 'just now'
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`
  if (elapsed < 30 * DAY) return `${Math.floor(elapsed / DAY)}d ago`
  return new Date(then).toISOString().slice(0, 10)
}

/**
 * §11: node_modules frames are collapsed. They are still shown — a stack with holes in it is
 * worse than a long one — but dimmed, so the eye lands on the owner's own code.
 */
export function splitFrames(stack: string): Array<{ text: string; vendor: boolean }> {
  return stack.split('\n').map((text) => ({
    text,
    vendor: /[/\\]node_modules[/\\]/.test(text),
  }))
}
```

- [ ] **Step 2: Write `web/src/routes/Issues.tsx`**

```tsx
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { api, type AppSummary, type IssueStatus, type IssueSummary } from '../api'
import { messageFor } from '../errors'
import { relativeTime } from '../format'

type Sort = 'last_seen' | 'count'

export function Issues() {
  const [appSlug, setAppSlug] = useState('')
  const [status, setStatus] = useState<IssueStatus | ''>('open')
  const [sort, setSort] = useState<Sort>('last_seen')

  const apps = useQuery({
    queryKey: ['apps'],
    queryFn: () => api.get<{ apps: AppSummary[] }>('/api/apps'),
  })

  const query = new URLSearchParams()
  if (appSlug !== '') query.set('app', appSlug)
  if (status !== '') query.set('status', status)
  query.set('sort', sort)

  const issues = useQuery({
    queryKey: ['issues', appSlug, status, sort],
    queryFn: () => api.get<{ issues: IssueSummary[] }>(`/api/issues?${query.toString()}`),
  })

  return (
    <main className="screen">
      <header className="screen__head">
        <h1 className="screen__title">Issues</h1>
        <LogOut />
      </header>

      <div className="filters">
        <select
          className="select"
          aria-label="Application"
          value={appSlug}
          onChange={(event) => setAppSlug(event.target.value)}
        >
          <option value="">All applications</option>
          {(apps.data?.apps ?? []).map((app) => (
            <option key={app.id} value={app.slug}>
              {app.name}
            </option>
          ))}
        </select>

        <select
          className="select"
          aria-label="Status"
          value={status}
          onChange={(event) => setStatus(event.target.value as IssueStatus | '')}
        >
          <option value="open">Open</option>
          <option value="resolved">Resolved</option>
          <option value="ignored">Ignored</option>
          <option value="">Any status</option>
        </select>

        <select
          className="select"
          aria-label="Sort"
          value={sort}
          onChange={(event) => setSort(event.target.value as Sort)}
        >
          <option value="last_seen">Last seen</option>
          <option value="count">Occurrences</option>
        </select>
      </div>

      {issues.isPending && <p className="waiting">Loading…</p>}
      {issues.error !== null && (
        <p className="error" role="alert">
          {messageFor(issues.error, 'Could not load the issues')}
        </p>
      )}

      {issues.data !== undefined &&
        (issues.data.issues.length === 0 ? (
          <p className="empty">Nothing here. That is the good outcome.</p>
        ) : (
          <ul className="issues">
            {issues.data.issues.map((issue) => (
              <li key={issue.id}>
                <Link className="issue" to={`/issues/${issue.id}`}>
                  <span className={`issue__bar issue__bar--${issue.status}`} aria-hidden="true" />
                  <span>
                    <p className="issue__title">{issue.title}</p>
                    {issue.culprit !== null && <p className="issue__culprit">{issue.culprit}</p>}
                    <p className="issue__meta">
                      <span className="tag">{issue.app_name}</span>
                      <span className="tag">{issue.environment}</span>
                      last seen {relativeTime(issue.last_seen_at)}
                    </p>
                  </span>
                  <span className="issue__count">
                    {issue.occurrence_count.toLocaleString('en')}
                    <small>{issue.occurrence_count === 1 ? 'time' : 'times'}</small>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ))}
    </main>
  )
}

function LogOut() {
  return (
    <button
      className="button button--quiet"
      type="button"
      onClick={async () => {
        await api.post('/api/logout').catch(() => undefined)
        window.location.assign('/login')
      }}
    >
      Sign out
    </button>
  )
}
```

- [ ] **Step 3: Write `web/src/routes/IssueDetail.tsx`**

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router'
import { api, type IssueOccurrence, type IssueStatus, type IssueSummary } from '../api'
import { messageFor } from '../errors'
import { relativeTime, splitFrames } from '../format'

interface Detail {
  issue: IssueSummary
  events: IssueOccurrence[]
}

export function IssueDetail() {
  const { id = '' } = useParams()
  const queryClient = useQueryClient()

  const detail = useQuery({
    queryKey: ['issue', id],
    queryFn: () => api.get<Detail>(`/api/issues/${id}`),
  })

  const setStatus = useMutation({
    mutationFn: (status: IssueStatus) => api.patch(`/api/issues/${id}`, { status }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['issue', id] })
      await queryClient.invalidateQueries({ queryKey: ['issues'] })
    },
  })

  if (detail.isPending) return <p className="waiting">Loading…</p>
  if (detail.error !== null) {
    return (
      <main className="screen">
        <p className="error" role="alert">
          {messageFor(detail.error, 'Could not load this issue')}
        </p>
        <Link className="button button--quiet" to="/">
          Back to issues
        </Link>
      </main>
    )
  }

  const { issue, events } = detail.data
  // The most recent occurrence is what the owner came to read; the rest is the shape of it.
  const latest = events[0]

  return (
    <main className="screen">
      <header className="screen__head">
        <div>
          <Link className="issue__meta" to="/">
            ← Issues
          </Link>
          <h1 className="screen__title">{issue.title}</h1>
          {issue.culprit !== null && <p className="issue__culprit">{issue.culprit}</p>}
          <p className="issue__meta">
            <span className="tag">{issue.app_name}</span>
            <span className="tag">{issue.environment}</span>
            <span className="tag">{issue.runtime}</span>
            {issue.occurrence_count.toLocaleString('en')} occurrences · first seen{' '}
            {relativeTime(issue.first_seen_at)} · last seen {relativeTime(issue.last_seen_at)}
          </p>
        </div>

        <div className="detail__actions">
          {issue.status !== 'resolved' && (
            <button
              className="button"
              type="button"
              disabled={setStatus.isPending}
              onClick={() => setStatus.mutate('resolved')}
            >
              Resolve
            </button>
          )}
          {issue.status !== 'ignored' ? (
            <button
              className="button button--quiet"
              type="button"
              disabled={setStatus.isPending}
              onClick={() => setStatus.mutate('ignored')}
            >
              Ignore
            </button>
          ) : (
            <button
              className="button button--quiet"
              type="button"
              disabled={setStatus.isPending}
              onClick={() => setStatus.mutate('open')}
            >
              Unmute
            </button>
          )}
        </div>
      </header>

      {setStatus.error !== null && (
        <p className="error" role="alert">
          {messageFor(setStatus.error, 'Could not change the status')}
        </p>
      )}

      {latest?.stack != null && (
        <section className="section">
          <h2 className="section__title">Stack</h2>
          <pre className="stack">
            {splitFrames(latest.stack).map((frame, index) => (
              <div
                key={index}
                className={frame.vendor ? 'stack__frame--vendor' : undefined}
              >
                {frame.text}
              </div>
            ))}
          </pre>
        </section>
      )}

      {latest?.context != null && (
        <section className="section">
          <h2 className="section__title">Context</h2>
          <pre className="stack">{JSON.stringify(latest.context, null, 2)}</pre>
        </section>
      )}

      <section className="section">
        <h2 className="section__title">Recent occurrences</h2>
        <ul className="occurrences">
          {events.map((event) => (
            <li className="occurrence" key={event.id}>
              <span>
                {new Date(event.occurred_at).toLocaleString('en-GB')}
                {event.count > 1 && ` · ×${event.count.toLocaleString('en')}`}
              </span>
              {/* Both timestamps exist because an offline queue replays late; saying so is the
                  only way the owner can tell a late report from a live one. */}
              {new Date(event.received_at).getTime() - new Date(event.occurred_at).getTime() >
                60_000 && (
                <span className="occurrence__late">
                  reported {relativeTime(event.received_at)}
                </span>
              )}
            </li>
          ))}
        </ul>
      </section>
    </main>
  )
}
```

- [ ] **Step 4: Wire the routes**

In `web/src/App.tsx`, replace the placeholder `/` route and add the detail route:

```tsx
        <Route
          path="/"
          element={
            <RequireSession>
              <Issues />
            </RequireSession>
          }
        />
        <Route
          path="/issues/:id"
          element={
            <RequireSession>
              <IssueDetail />
            </RequireSession>
          }
        />
```

with `import { Issues } from './routes/Issues'` and
`import { IssueDetail } from './routes/IssueDetail'`.

- [ ] **Step 5: Look at it with real data**

```bash
./run dev --bg
```

Then report a few errors through the endpoint, using the key from Task 5:

```bash
curl -sS -X POST http://localhost:4100/ingest/events \
  -H "authorization: Bearer $VIGIL_KEY" \
  -H 'content-type: application/json' \
  -d '{"environment":"production","runtime":"node","events":[{"type":"TypeError","message":"Cannot read properties of undefined (reading '"'"'id'"'"')","stack":"TypeError: boom\n    at handleBooking (/app/src/bookings.js:42:17)\n    at run (/app/node_modules/fastify/lib/handle.js:118:9)","occurred_at":"2026-09-07T09:00:00.000Z","context":{"route":"/api/bookings"}}]}'
```

Expected on `http://localhost:5174`: the issue in the list with its culprit and a count; sending
the same payload again makes it 2, not two rows; the detail screen shows the stack with the
`node_modules` frame dimmed; Resolve moves it out of the Open filter, and reporting it once more
brings it back as open. Then `./run stop`.

- [ ] **Step 6: Commit**

```bash
./run check
git add -A
git commit -m "feat(web): add the issues list and issue detail screens"
```

---

### Task 14: The browser journey

One Playwright spec over the whole product, driving the path §1 describes: something threw, and
by morning the owner knows what, how many times, and where.

**Files:**
- Create: `playwright.config.ts`
- Create: `tests/ui/global-setup.ts`, `tests/ui/helpers.ts`, `tests/ui/issues.spec.ts`

**Interfaces:**
- Consumes: the built product — `./run build`, the compose database, and the setup scripts from
  Task 5.
- Produces: `tests/ui/.runtime.json` (git-ignored, written by the global setup) carrying
  `{ baseURL, ingestKey, password }` for the specs.

- [ ] **Step 1: Write `playwright.config.ts`**

```ts
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/ui',
  testMatch: '**/*.spec.ts',
  globalSetup: './tests/ui/global-setup.ts',
  // One database and one server: the specs share them and must not race each other.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 30_000,
  reporter: [['list']],
  use: { trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
```

- [ ] **Step 2: Write the global setup**

`tests/ui/global-setup.ts`:

```ts
import { spawn, spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '../..')
const PORT = 4199
const PASSWORD = 'correct horse battery staple'
const DATABASE_URL = 'postgres://postgres:postgres@localhost:5435/vigil_ui'

function run(command: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  // A database of its own, dropped and recreated each run: the journey asserts on counts, and
  // yesterday's issues would make it pass or fail for reasons that are not the code's.
  run('docker', ['compose', 'up', '-d', 'db'])
  const psql = ['compose', 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-c']
  // Retried, because compose reports the container up slightly before Postgres accepts.
  for (let attempt = 0; ; attempt += 1) {
    const ready = spawnSync('docker', [...psql, 'select 1'], { cwd: ROOT })
    if (ready.status === 0) break
    if (attempt > 60) throw new Error('Postgres did not become ready')
    await new Promise((r) => setTimeout(r, 1_000))
  }
  run('docker', [...psql, 'drop database if exists vigil_ui'])
  run('docker', [...psql, 'create database vigil_ui'])

  run('npm', ['run', 'build'])
  run('npm', ['run', '--workspace', 'server', 'migrate'], { DATABASE_URL })

  spawnSync('npx', ['tsx', 'scripts/set-password.ts'], {
    cwd: resolve(ROOT, 'server'),
    env: { ...process.env, DATABASE_URL },
    input: PASSWORD,
    encoding: 'utf8',
  })
  run('npx', ['tsx', 'server/scripts/add-app.ts', 'reference', 'The reference application'], {
    DATABASE_URL,
  })
  const issued = run('npx', ['tsx', 'server/scripts/issue-key.ts', 'reference'], { DATABASE_URL })
  const ingestKey = issued.match(/vgl_[A-Za-z0-9_-]+/)?.[0]
  if (ingestKey === undefined) throw new Error(`Could not read the key out of:\n${issued}`)

  const server = spawn('node', ['dist/src/server.js'], {
    cwd: resolve(ROOT, 'server'),
    env: { ...process.env, DATABASE_URL, PORT: String(PORT), LOG_LEVEL: 'warn' },
    stdio: 'inherit',
  })

  const baseURL = `http://localhost:${PORT}`
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${baseURL}/api/health`)
      if (response.ok) break
    } catch {
      /* not up yet */
    }
    if (attempt > 60) throw new Error('the server did not start')
    await new Promise((r) => setTimeout(r, 500))
  }

  writeFileSync(
    resolve(ROOT, 'tests/ui/.runtime.json'),
    JSON.stringify({ baseURL, ingestKey, password: PASSWORD }, null, 2),
  )

  return async () => {
    server.kill()
  }
}
```

- [ ] **Step 3: Write `tests/ui/helpers.ts`**

```ts
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Page } from '@playwright/test'

interface Runtime {
  baseURL: string
  ingestKey: string
  password: string
}

export const runtime: Runtime = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '.runtime.json'), 'utf8'),
) as Runtime

export async function signIn(page: Page): Promise<void> {
  await page.goto(`${runtime.baseURL}/login`)
  await page.getByLabel('Password').fill(runtime.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(`${runtime.baseURL}/`)
}

/** Reports through the real endpoint with the real key, exactly as an application would. */
export async function report(options: {
  message: string
  stack?: string
  count?: number
  environment?: string
}): Promise<void> {
  const response = await fetch(`${runtime.baseURL}/ingest/events`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${runtime.ingestKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      environment: options.environment ?? 'production',
      runtime: 'node',
      events: [
        {
          type: 'TypeError',
          message: options.message,
          stack:
            options.stack ??
            `TypeError: ${options.message}\n    at handleBooking (/app/src/bookings.js:42:17)\n    at run (/app/node_modules/fastify/lib/handle.js:118:9)`,
          occurred_at: new Date().toISOString(),
          ...(options.count === undefined ? {} : { count: options.count }),
          context: { route: '/api/bookings' },
        },
      ],
    }),
  })
  if (response.status !== 202) {
    throw new Error(`ingest refused the report: ${response.status} ${await response.text()}`)
  }
}
```

- [ ] **Step 4: Write the journey**

`tests/ui/issues.spec.ts`:

```ts
import { expect, test } from '@playwright/test'
import { report, runtime, signIn } from './helpers'

test('the owner is turned away without a password', async ({ page }) => {
  await page.goto(`${runtime.baseURL}/`)
  await expect(page).toHaveURL(/\/login$/)

  await page.getByLabel('Password').fill('not the password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('alert')).toHaveText('Wrong password')
})

// §1's driving case, end to end: something threw overnight, and the owner learns what it was,
// how often, and where, without having read a log file.
test('an application throws, and the owner reads it in the morning', async ({ page }) => {
  const message = `the night shift broke ${Date.now()}`
  await report({ message })
  await report({ message })
  await report({ message, count: 98 })

  await signIn(page)

  const row = page.getByRole('listitem').filter({ hasText: message })
  // Ten thousand failures are one line. Three reports of one failure are one line too.
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('100')
  await expect(row).toContainText('The reference application')
  await expect(row).toContainText('production')

  await row.getByRole('link').click()

  await expect(page.getByRole('heading', { level: 1 })).toContainText(message)
  await expect(page.locator('.stack')).toContainText('handleBooking')
  await expect(page.locator('.stack')).toContainText('/api/bookings')
  // node_modules frames are shown but dimmed, so the eye lands on the owner's own code.
  await expect(page.locator('.stack__frame--vendor')).toContainText('node_modules')
})

test('resolving an issue takes it out of the open list, and a regression brings it back', async ({
  page,
}) => {
  const message = `fixed then broken again ${Date.now()}`
  await report({ message })

  await signIn(page)
  await page.getByRole('listitem').filter({ hasText: message }).getByRole('link').click()
  await page.getByRole('button', { name: 'Resolve' }).click()

  await page.getByRole('link', { name: '← Issues' }).click()
  await expect(page.getByRole('listitem').filter({ hasText: message })).toHaveCount(0)

  await page.getByLabel('Status').selectOption('resolved')
  await expect(page.getByRole('listitem').filter({ hasText: message })).toHaveCount(1)

  // It happens again. A resolved issue that regresses reopens — this is the transition Slice 2
  // turns into a notification.
  await report({ message })
  await page.getByLabel('Status').selectOption('open')
  await expect(page.getByRole('listitem').filter({ hasText: message })).toHaveCount(1)
})

test('the filters narrow the list', async ({ page }) => {
  const stamp = Date.now()
  await report({ message: `in production ${stamp}`, environment: 'production' })
  await report({ message: `on a laptop ${stamp}`, environment: 'development' })

  await signIn(page)
  await expect(page.getByRole('listitem').filter({ hasText: `on a laptop ${stamp}` })).toHaveCount(1)

  // A developer's laptop must never share a row — or, from Slice 2, an alert — with production.
  await page.getByLabel('Application').selectOption({ label: 'The reference application' })
  await expect(page.getByRole('listitem').filter({ hasText: `in production ${stamp}` })).toHaveCount(1)
  await expect(page.getByRole('listitem').filter({ hasText: `on a laptop ${stamp}` })).toHaveCount(1)
})

test('signing out ends the session', async ({ page }) => {
  await signIn(page)
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/login$/)

  await page.goto(`${runtime.baseURL}/`)
  await expect(page).toHaveURL(/\/login$/)
})
```

- [ ] **Step 5: Run the journey**

Run: `./run test:ui`
Expected: PASS, 5 specs. Docker must be running.

The environment filter is asserted only through the application filter above, because the
issues screen exposes no environment control in this slice — the API supports it (Task 7) and
the screen will grow one when there is more than one environment worth choosing between. If a
reviewer wants it now, it is a `<select>` beside the other two; say so rather than leaving the
test asserting something the interface cannot do.

- [ ] **Step 6: Commit**

```bash
./run check
git add -A
git commit -m "test(ui): drive the driving case through a browser"
```

---

### Task 15: Documentation, and archiving this plan

The reference application's rule, adopted in Task 1's `CONTRIBUTING.md`: the last task of every
slice updates `docs/architecture.md` and, where running or deploying changed, `README.md`, then
archives the plan. Not a follow-up — a task with the same standing as the code.

**Files:**
- Create: `docs/architecture.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-09-05-vigil-design.md` — the status line only
- Move: this plan to `docs/superpowers/plans/archive/`

**Interfaces:**
- Consumes: everything built in Tasks 1–14.
- Produces: no code.

- [ ] **Step 1: Write `docs/architecture.md`**

This is authoritative for what vigil does *today*, and with the README it is the whole
onboarding path. It is not a summary of the spec: the spec says why, this says what. Cover:

- **What runs.** Three workspaces, one process serving `/api`, `/ingest` and the built SPA on
  one port; Postgres beside it.
- **The two credentials**, as the §4 table but describing what exists: a server ingest key on
  `POST /ingest/events`, a session cookie on `/api/*`, and the fact that the guard is scoped to
  `/api/` so ingest is never asked for a cookie.
- **The path an error takes**, in order: the host application throws → `@vigil/client/node`
  redacts and queues it → a batch is posted → the key names the application → `fingerprintOf`
  groups it → the issue is upserted and the event stored → the dashboard reads it. Name the
  file each step lives in.
- **Grouping**, in a paragraph: type plus top non-`node_modules` frames, function and module,
  line and column dropped; message fallback with numbers and UUIDs replaced; the explicit
  escape hatch.
- **The tables**, with a sentence each on why `occurrence_count` outlives `events`, why both
  timestamps exist, and why `environment` is in the issue key.
- **Self-monitoring**: vigil's own errors go to the database directly, never through ingest, and
  the recorder refuses to run while it is already running.
- **What is not built yet**, naming the slice each belongs to: notifications and the outbox
  (Slice 2), uptime monitors and the prober (Slice 3), browser ingest and the origin allowlist
  (Slice 4), retention pruning (§14). Say plainly that the `kind`, `last_notified_at`,
  `auto_muted_at` and `reopened_at` columns exist for those slices and are unused today, so a
  reader does not go hunting for the code that fills them.
- **Running it**: `./run` and its scenarios, and the three-step first-run sequence.

- [ ] **Step 2: Update `README.md`**

The status line changes from "Designed, not built." Replace it with what is true: Slice 1 ships
error recording end to end; alerting, uptime and browser errors are designed and not built.
Point the reading path at `docs/architecture.md` first and the spec second, and add the first-run
sequence (`./run owner:password`, `./run app:add`, `./run key:issue`, `./run start`) plus how an
application installs the client:

```ts
import { install } from '@vigil/client/node'

const vigil = install({
  url: 'https://vigil.example',
  key: process.env.VIGIL_INGEST_KEY!,
  app: 'reference',
  environment: process.env.NODE_ENV ?? 'development',
  secrets: [process.env.SOME_API_KEY ?? ''],
})

// In the framework's error handler:
vigil.captureError(error, { method: request.method, url: request.url })
```

Say plainly that `install` replaces Node's default `uncaughtException` behaviour by flushing and
then exiting, and that `exitOnUncaught: false` is for hosts with their own handler. That is the
one way this package changes how an application behaves, and it belongs where somebody installing
it will read it.

- [ ] **Step 3: Update the spec's status line**

In `docs/superpowers/specs/2026-09-05-vigil-design.md`, change
`Status: **designed**, 2026-09-05. Not built.` to record that Slice 1 shipped, and point at
`docs/architecture.md` for what the system does. **Change nothing else in that file** — it is a
decision record, and the banner at the top says it is not revised as the code moves on.

- [ ] **Step 4: Archive the plan**

```bash
mkdir -p docs/superpowers/plans/archive
git mv docs/superpowers/plans/2026-09-07-vigil-slice-1-errors-end-to-end.md \
       docs/superpowers/plans/archive/
```

- [ ] **Step 5: Verify the whole thing from nothing**

The claim this task is making is that somebody can clone the repository and get to a working
dashboard. Test it, rather than asserting it:

```bash
git stash list                      # confirm nothing uncommitted is holding it up
./run stop || true
docker compose down -v              # discard the database entirely
./run check                         # types, formatting, both suites
./run migrate
echo 'correct horse battery staple' | ./run owner:password
./run app:add reference The reference application
./run key:issue reference
./run start --bg
./run test:ui
./run stop
```

Expected: every step succeeds, and the README's sequence is the sequence that was just run. If
any command in the README differs from what actually worked, the README is what gets corrected.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: describe what slice 1 built and archive its plan"
```

---

## Self-Review

Run after the plan is written, before execution. Checked against the spec on 2026-09-07.

**Spec coverage.** Every Slice 1 item in §15 maps to a task: migrations for `app`, `ingest_key`,
`issue`, `event` → Task 2; the ingest endpoint with server keys only → Task 6; fingerprinting →
Task 3; the client's `/node` entry point → Tasks 9–11; a minimal dashboard with login, an issues
list and an issue detail → Tasks 12–13. §4's trust boundaries are enforced in Tasks 4–6 and
tested in both. §13 is Task 8, which §15 does not list under any slice — it is included here
because it constrains the write path, and building it later would mean revisiting the error
handler. §5's `notification_channel` and `notification`, §9's `monitor`, `probe_result` and
`incident`, and §14's pruning are deliberately absent; they belong to Slices 2–4 and are named
in Global Constraints so no task drifts into them.

**Three decisions this plan makes that the spec left open**, each recorded where it is made:

1. **The dashboard is in English**, unlike the reference application's Russian interface. Global
   Constraints, with the reasoning.
2. **Tables are plural** where §5 names them singular, following the reference application's
   convention. Global Constraints.
3. **Application and key creation are command-line scripts in this slice**, not the Settings
   screen §11 describes. Task 5's preamble. §15 scopes Slice 1's dashboard to login, list and
   detail, so Settings belongs with the channels that need it in Slice 2.

**One question this plan originally left open** — whether vigil's `CONTRIBUTING.md` forbids a
commit body and `Co-Authored-By` trailer — was settled on 2026-09-08 while designing
`dev-kit`: it does, and that is now the shared rule across every project. Global Constraints
states it, and Task 1 Step 8 writes it into `CONTRIBUTING.md`.

**Placeholder scan.** No `TBD` or `TODO`. Four places name a decision the implementer makes from
what they observe rather than from a guess, each with the observation that settles it: Ajv's
`format: 'date-time'` and `format: 'uuid'` support (Tasks 6 and 7 — the failing test tells you);
the `timerIsUnrefd` test seam (Task 11 — prefer the spy, and the reason is given); and how
`client-wire.test.ts` reaches the client package (Task 11 — either of two ways, with the
invariant that matters stated). These are judgement calls with stated criteria, not gaps.

**Type consistency.** `Config` is the same eight fields in Tasks 1, 4 and 6. `Database` keys are
plural in the schema, the migration, the truncate in `resetDb` and every repository.
`fingerprintOf` returns `{ fingerprint, culprit }` in Task 3 and is destructured that way in
Task 6. `IssueSummary` has the same eleven fields in `issue.repository.ts` (Task 7) and
`web/src/api.ts` (Task 12). `WireEvent` is built in Task 9, bounded in Task 10, sent in Task 11
and validated by `IngestBody` in Task 6 — the one seam with no shared type, which is why
`client-wire.test.ts` exists. `IngestService.record(appId, body)` has the same signature in the
route (Task 6) and the self-recorder (Task 8). `registerErrorHandler` gains an optional second
parameter in Task 8; Task 4's single-argument callers keep compiling.

**Scope.** Fifteen tasks, each ending in something that runs and is tested. The heaviest are 6
and 11; neither splits cleanly, because the ingest endpoint is meaningless without its key check
and the client's four rules are one object's behaviour. Tasks 2–8 are server, 9–11 client, 12–14
dashboard and journey, 15 documentation. Nothing later than Task 8 changes a file Tasks 2–8
wrote, except `app.ts`, which each of Tasks 6, 7 and 8 adds one line to.

---

## Execution Handoff

Plan complete and saved to
`docs/superpowers/plans/2026-09-07-vigil-slice-1-errors-end-to-end.md`. Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, reviewed between tasks, fast
iteration.

**2. Inline Execution** — tasks executed in this session using executing-plans, batched with
checkpoints for review.
