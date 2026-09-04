# vigil

Health monitoring for the applications on this machine — `cabins-admin`, `booking-engine`,
`AdPulse`, `UBP`, and whatever comes next.

It does two things:

- **Records failures.** Uncaught exceptions and handled errors from Node processes and from
  browsers, grouped so that ten thousand occurrences of one bug are one line in a list.
- **Probes liveness.** Checks each application from outside, over its public URL, and opens an
  incident when it stops answering.

When either produces something new, it notifies the owner through a configurable channel.

## Status

**Designed, not built.** Nothing here runs yet. The design is
[docs/superpowers/specs/2026-09-05-vigil-design.md](docs/superpowers/specs/2026-09-05-vigil-design.md),
which is the decision record for the whole system — read §15 for the build order.

## Relationship to the monitored applications

Vigil shares no code and no database with anything it watches. An application depends on it in
exactly one direction: it installs the `@vigil/client` package and holds an ingest key. Vigil
never reaches into an application, and an application can never read anything out of vigil.
