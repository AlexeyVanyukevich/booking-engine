# booking-engine

A domain-agnostic booking engine: resources, schedules and bookings, with no domain fields of
its own. Other applications consume it over HTTP by API key; the admin consumer reads this
repository's documents as the engine's contract.

`./run` is the entry point for everything, and `./run check` — types, formatting and the full
suite — passes before every commit. It needs Docker running.

## The documentation

**Two documents are authoritative for what the engine does today:**

- `docs/architecture.md` — the data model, the lifecycle, availability, and why contracts have
  their shape
- `docs/conventions.md` — the engine's own rules: vocabulary, time and date, the error and
  scope tables, configuration, concurrency, where the shared layout and testing rules land here

The shared documentation rule below names only the first. Here `conventions.md` has the same
standing, and the last task of a slice updates it wherever a rule changed.

`docs/backlog.md` lists what is known to be wrong and not yet fixed. Read it before planning.

## Conventions

The shared ones come from the `dev-kit` package, one import per rule. A shared rule is corrected
in the kit, never restated or overridden here; declining one means deleting its line and saying
why in `CONTRIBUTING.md`.

@node_modules/dev-kit/rules/typescript.md
@node_modules/dev-kit/rules/http.md
@node_modules/dev-kit/rules/layout.md
@node_modules/dev-kit/rules/testing.md
@node_modules/dev-kit/rules/commits.md
@node_modules/dev-kit/rules/documentation.md
@node_modules/dev-kit/rules/writing.md
@node_modules/dev-kit/rules/review.md
@node_modules/dev-kit/rules/backlog.md
