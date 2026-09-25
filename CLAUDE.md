# vigil

Health monitoring for the applications running on one host. It records failures and probes
liveness, and it shares no code and no database with anything it watches.

## The documentation

**Designed, not built.** `docs/superpowers/specs/2026-09-05-vigil-design.md` is the decision
record for the whole system, and §15 is the build order. Read it before writing anything.

There is no `docs/architecture.md` yet. The first slice creates it, and from that point it is
authoritative for what the project does today — not the spec.

## Conventions

The rules below are where the conventions live. Correct one in the shared kit rather than
restating it here.

@node_modules/dev-kit/rules/typescript.md
@node_modules/dev-kit/rules/http.md
@node_modules/dev-kit/rules/layout.md
@node_modules/dev-kit/rules/testing.md
@node_modules/dev-kit/rules/commits.md
@node_modules/dev-kit/rules/documentation.md
@node_modules/dev-kit/rules/writing.md
@node_modules/dev-kit/rules/review.md
