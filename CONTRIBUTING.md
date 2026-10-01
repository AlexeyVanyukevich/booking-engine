# Contributing

The shared conventions — commit messages, merging, specs and plans, tests, layout — are the
`dev-kit` rules imported by [CLAUDE.md](CLAUDE.md). This file holds what is particular to this
repository.

## Language

Everything in this repository is written in English: code, identifiers, comments,
documentation, commit messages and API error messages.

## Commit scopes

The shared `commits.md` rule sets the format. The scopes used here:

| Scope     | Area                                               |
| --------- | -------------------------------------------------- |
| `api`     | Routes, schemas and services behind the engine API |
| `db`      | Migrations, the Kysely schema, repositories        |
| `console` | The loopback key console                           |
| `worker`  | The background hold sweep                          |
| `docker`  | `Dockerfile`, `docker-compose.yml`                 |
| `deps`    | Dependency bumps                                   |

Omit the scope when a change is repository-wide.

## Before committing

From the repository root:

```bash
./run check
```

That type-checks, verifies formatting and runs the full suite. It needs Docker running —
the integration tests start their own Postgres — but no database prepared.

## Specs and plans

The shared `documentation.md` rule applies, with one addition: the last task of a slice
updates [docs/conventions.md](docs/conventions.md) as well as
[docs/architecture.md](docs/architecture.md) wherever a rule changed. Executed plans are in
[docs/superpowers/plans/archive/](docs/superpowers/plans/archive/).
