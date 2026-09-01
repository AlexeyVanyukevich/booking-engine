# Contributing

## Language

Everything in this repository is written in English: code, identifiers, comments,
documentation, commit messages and API error messages.

## Commit messages

We follow [Conventional Commits](https://www.conventionalcommits.org/).

```
type(scope): subject

optional body

optional footer
```

### Types

| Type       | Use for                                                                  |
| ---------- | ------------------------------------------------------------------------ |
| `feat`     | New functionality exposed to API consumers                               |
| `fix`      | Bug fix                                                                  |
| `docs`     | Documentation only — README, specs, plans, this file                     |
| `test`     | Adding or reworking tests without touching production code               |
| `refactor` | Code change that neither adds behaviour nor fixes a bug                  |
| `perf`     | Performance improvement                                                  |
| `build`    | Build system and dependencies — `package.json`, `tsconfig`, `Dockerfile` |
| `ci`       | CI/CD configuration                                                      |
| `chore`    | Maintenance that fits nothing else — `.gitignore`, editor config         |
| `revert`   | Reverting a previous commit                                              |
| `style`    | Formatting with no effect on meaning                                     |

Pick the type by the _intent_ of the change, not by the file extension. A test added
as part of a new endpoint belongs to that endpoint's `feat` commit; `test` is for
commits whose whole point is test coverage.

### Scope

Optional, lowercase, names the affected area: `api`, `clients`, `db`, `docker`,
`deps`, later `web`. Omit it when the change is repository-wide.

### Subject

- Imperative mood — `add`, not `added` or `adds`
- Lowercase first letter, no trailing period
- 72 characters or fewer
- Describe the change, not the file you edited

```
feat(clients): add pagination to the list endpoint
fix(clients): reject negative monthlyBudget on update
docs: add commit conventions
build(deps): upgrade prisma to 6.19
chore: add gitignore
```

Avoid:

```
Added gitignore                   # past tense, capitalized, no type
fix: bug                          # says nothing
feat: update client.service.ts    # names the file, not the change
```

### Body and footer

Separate the body from the subject with a blank line and wrap it at 72 characters.
Explain _why_ the change was made — the diff already shows _what_ changed.

Footers:

```
BREAKING CHANGE: monthlyBudget is now returned as a string
Refs: #12
```

A breaking change may also be marked with `!` after the type: `feat(api)!: ...`.

## Splitting work into commits

Each commit should leave the repository in a compiling state and tell one story.
Practical guidance for this project:

- Move bottom-up through the dependency graph — schema, then service, then the HTTP
  layer — so no commit references a module that does not exist yet.
- Keep a module's tests in the same commit as the module they cover.
- Keep unrelated changes apart: a dependency bump and a bug fix are two commits.

## Before committing

From the repository root:

```bash
./run check
```

That type-checks, verifies formatting and runs the full suite. It needs Docker running —
the integration tests start their own Postgres — but no database prepared.

Tests must be green. Tests are written before the implementation for each slice —
see the executed plans in [docs/superpowers/plans/archive/](docs/superpowers/plans/archive/).

## Specs and plans

Every phase gets its own design document in
[docs/superpowers/specs/](docs/superpowers/specs/) and an implementation plan in
[docs/superpowers/plans/](docs/superpowers/plans/), named `YYYY-MM-DD-<topic>.md`.
Write and approve the spec before touching code.

Both are dated artifacts, and neither is revised once the slice ships:

- A **spec** becomes a decision record — read afterwards for _why_ a decision went the way it
  did, never for what the system does.
- A **plan** is moved to [plans/archive/](docs/superpowers/plans/archive/) once executed. It is
  spent scaffolding, kept for provenance.

The last task of every slice updates [docs/architecture.md](docs/architecture.md) and, where a
rule changed, [docs/conventions.md](docs/conventions.md). Those two are authoritative for
current behaviour, and they are the whole onboarding path — keeping them true is what stops it
from growing by one document per slice.
