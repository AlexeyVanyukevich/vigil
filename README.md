# vigil

Health monitoring for the applications running on one host — the ones there today, and whatever
comes next.

It is designed to do two things:

- **Record failures.** Uncaught exceptions and handled errors from Node processes and from
  browsers, grouped so that ten thousand occurrences of one bug are one line in a list.
- **Probe liveness.** Check each application from outside, over its public URL, and open an
  incident when it stops answering.

When either produces something new, it is to notify the owner through a configurable channel.

## Status

**Slice 1 is built: errors are recorded end to end.** A Node application installs the client,
its uncaught and handled errors reach vigil, and the owner reads them, grouped, in the dashboard.
Alerting, uptime monitoring and browser errors are designed and not built.

Read, in this order:

1. [docs/architecture.md](docs/architecture.md) — what vigil does today, and where each part
   lives. It is authoritative.
2. [docs/superpowers/specs/2026-09-05-vigil-design.md](docs/superpowers/specs/2026-09-05-vigil-design.md)
   — the decision record for the whole system: why it has this shape, and what the later slices
   add. Read it for reasons, not for behaviour.
3. [docs/backlog.md](docs/backlog.md) — what is known to be wrong today and not yet fixed.

## Running it

You need Node 24 or newer and Docker, running. `./run` installs the dependencies and starts
Postgres itself; `./run` alone lists every scenario.

The first time:

```bash
./run owner:password          # prompts for a password of at least 12 characters
./run app:add reference The reference application
./run key:issue reference     # prints the application's ingest key once; copy it
./run start
```

Then open http://localhost:4100 and sign in with that password. `./run dev` runs the server and
the dashboard with hot reload instead, the dashboard on http://localhost:5174.

**Leave `NODE_ENV` unset for a local run.** With `NODE_ENV=production` the session cookie is set
`Secure`, and a browser will not store a `Secure` cookie over plain http: signing in appears to
work and the next request is signed out. `./run start` refuses to start with it set for that
reason. **A deployment served over https sets `NODE_ENV=production`**, so the cookie is never
sent unencrypted. Behind a reverse proxy it also needs the proxy to pass `Host` through unchanged
and `TRUST_PROXY` set to the proxy's address; [Deploying](docs/architecture.md#deploying) says
why, and what fails without each.

`./run check` is the gate before every commit: formatting, types, and the server, client and
dashboard suites. `./run test:ui` drives the built product in a browser; install the browser it
needs once with `npx playwright install chromium`.

## Installing the client in an application

The client is not published to a registry yet. Build it and pack it from this repository:

```bash
npm run --workspace client build
npm pack --workspace client       # writes vigil-client-0.1.0.tgz
```

and install that file in the application (`npm install /path/to/vigil-client-0.1.0.tgz`). Then,
once, at start-up:

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

`url` is vigil's base URL, and `key` the key `./run key:issue` printed; the key alone tells vigil
which application is reporting. `app` is a label for the client's own log lines and is never
sent. `secrets` are values to scrub from every message, stack and context before anything leaves
the process; authorization and cookie headers and keys named like passwords, tokens and secrets
are scrubbed without being listed. `install` never throws: with a missing `url`, `key` or
`environment` it logs one line and returns a client that does nothing.

**`install` changes how the application dies.** Node exits on an uncaught exception only while
no listener is registered for it, and `install` registers one. So when vigil's is the only
`uncaughtException` listener, vigil flushes what it has queued (for at most a second), prints the
error as Node would, and exits with code 1. An application with an `uncaughtException` handler of
its own keeps the decision: vigil reports the error and leaves the process running, as Node
would. `exitOnUncaught: false` stops vigil ever ending the process; set it only when the
application ends the process itself in a way vigil cannot see, because with no handler at all a
crashed process then carries on. This is the one way the package changes how an application
behaves.

## Relationship to the monitored applications

Vigil shares no code and no database with anything it watches. An application depends on it in
exactly one direction: it installs the `@vigil/client` package and holds an ingest key. Vigil
never reaches into an application, and an application can never read anything out of vigil.
