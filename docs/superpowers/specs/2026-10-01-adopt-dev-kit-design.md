# Adopting the shared `dev-kit`

**Status:** designed · **Date:** 2026-10-01

**This is a decision record, not current truth.** It states what was decided on the date above and is not revised as the system changes. For what the engine does today, read [architecture.md](../../architecture.md) and [conventions.md](../../conventions.md) — where they disagree with this document, they are right.

---

## 1. Purpose

`dev-kit` is a package of shared conventions and tooling configuration: TypeScript bases, a
Prettier configuration, the `./run` script's shell library, `.gitignore` and `.prettierignore`
starting points, and nine convention rules imported by a project's `CLAUDE.md`. Its rules were
largely extracted from this repository's `docs/conventions.md` and `CONTRIBUTING.md`; two other
projects on the same machine already consume it.

This slice makes the engine a consumer of **every module and every rule**, so that a convention
is corrected once in the kit rather than once per repository. It changes no behaviour of the
engine: no endpoint, schema, migration or response moves.

### Success

- `./run check` passes with the kit's compiler settings, including `exactOptionalPropertyTypes`.
- `./run` works on a fresh clone with no `node_modules`, and `docker compose build` succeeds.
- No rule is stated both in the kit and here. What stays here is what only the engine knows.

---

## 2. Install

```json
"devDependencies": { "dev-kit": "github:AlexeyVanyukevich/dev-kit#v1.2.1" }
```

Over git at a pinned tag, with no `.npmrc`. The kit prefers a private registry, but none exists
for this machine yet; the git specifier installs the same tree and is the channel the other
consumer uses. Moving to `^1.x` from a registry later is a one-line change.

**The Docker build stage now needs GitHub as well as the npm registry**, because `tsconfig.json`
extends the kit and the kit is a dev dependency fetched during `npm ci`. The runtime stage runs
`npm ci --omit=dev` and does not contain it. The README states this in its deployment section.

---

## 3. Mechanical modules

### 3.1 TypeScript

`tsconfig.json` extends `dev-kit/tsconfig/node` and keeps only what describes this repository:

| Kept locally        | Why                                                               |
| ------------------- | ----------------------------------------------------------------- |
| `outDir`, `rootDir` | The kit never guesses a layout; `rootDir: "."` shapes `dist/src/` |
| `include`           | `src/`, `tests/`, `scripts/`                                      |
| `esModuleInterop`   | `import pg from 'pg'` in `src/db/client.ts` depends on it         |

`strict`, `noUncheckedIndexedAccess`, `skipLibCheck`, `module`, `moduleResolution` and `types`
come from the kit. Two settings change:

- `target` moves from `ES2022` to `ES2023`.
- **`exactOptionalPropertyTypes` is switched on.** It produces 15 errors today — 6 in `src/`
  (`booking.service.ts` ×2, `resource.service.ts`, `shared/auth.ts`, `shared/errors.ts`) and 9 in
  tests (`tests/fixtures/transport.ts`, `tests/integration/auth.test.ts`,
  `tests/integration/isolation.test.ts`). All are an `undefined` passed where a property is
  optional. They are fixed at the call site — omit the property when the value is absent, or
  widen a type to `| undefined` where absence and `undefined` genuinely mean the same thing — and
  the flag is not overridden off.

### 3.2 Prettier

`.prettierrc` is deleted; `package.json` gains `"prettier": "dev-kit/prettier"`. The kit's
configuration is identical, so no file is reformatted.

### 3.3 Ignore files

`.gitignore` and `.prettierignore` are rebuilt from the kit's copies, with the engine's own
entries appended after them:

- `.gitignore`: nothing needs appending — the kit's copy already carries `.run/`, the Playwright
  folders, `.superpowers/`, `.env*` and `*.log`.
- `.prettierignore`: `openapi.json`, with its existing comment about the generator.

### 3.4 `./run`

The script sources the kit's library after a bootstrap that tests for the file, not the
directory — a checkout installed before the kit was a dependency has `node_modules` without it:

```bash
[ -f node_modules/dev-kit/sh/lib.sh ] || npm install
source node_modules/dev-kit/sh/lib.sh
```

The local definitions the library replaces are deleted: the colour variables, `step`, `ok`,
`note`, `die`, `load_env_file`, `need_docker`, `need_node`, `need_deps`, `need_env`.

The engine's one addition to `need_env` — telling the reader that `DATABASE_URL` already points
at the compose database — moves into a local `need_local_env` that calls `need_env || note …`,
because under `set -e` a bare `need_env` ends the script on the run that creates `.env`. Every
caller of `need_env` calls `need_local_env` instead.

`need_node`'s hint becomes `Install Node 24 or newer — see .nvmrc.`, set through
`DEVKIT_NODE_HINT` so the pointer to `.nvmrc` survives. The scenarios are untouched.

---

## 4. Rules and documents

### 4.1 `CLAUDE.md`

New. A short orientation — what the engine is, that `./run check` gates every commit — then:

- **The two living documents are `docs/architecture.md` and `docs/conventions.md`.** The kit's
  `documentation.md` names only the first; here, `conventions.md` holds the engine's local rules
  and has the same standing. Specs remain decision records.
- `docs/backlog.md` is read before planning a slice.
- The nine rule imports, one per line: `typescript`, `http`, `layout`, `testing`, `commits`,
  `documentation`, `writing`, `review`, `backlog`.
- A shared rule is corrected in the kit, never restated or overridden here. Declining one means
  deleting its import line and saying why in `CONTRIBUTING.md`.

### 4.2 `docs/conventions.md` — trimmed, not moved

It keeps its path, its title and its standing. Its opening paragraph gains one sentence: rules
that hold across projects live in the kit and are imported by `CLAUDE.md`; this document holds
what only the engine knows.

| Section             | What leaves                                                                                                                  | What stays                                                                                                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API conventions     | Nothing is deleted; a link to `http.md` for the general shape                                                                | The full error table (asserted by `documented-tables.test.ts`), the `slot_unavailable`/`outside_schedule` distinction, the auth-failure and `forbidden_scope` reasoning, scopes, generated documentation |
| Technology stack    | Nothing                                                                                                                      | The whole table — these are the engine's choices, not shared rules                                                                                                                                       |
| Code layout         | The general four-file description, replaced by a link to `layout.md`                                                         | The engine's modules as examples, entry points, the `slot-generator.ts` no-`db/` rule, parent-before-member locking                                                                                      |
| Testing conventions | Tests-first, real Postgres, datasets-over-bodies and derived-facts as general statements, replaced by a link to `testing.md` | The dataset and fixture paths, the DST file, the two-transport run, "Extending the smoke run"                                                                                                            |
| Everything else     | Nothing                                                                                                                      | Vocabulary, time and date, configuration, concurrency, deliberate limitations                                                                                                                            |

The error table stays whole even where a code also appears in the kit's table, because the test
asserts it against the code and the admin consumer reads it as the engine's contract.

### 4.3 `CONTRIBUTING.md`

- **Commit messages** shrinks to a pointer at `commits.md` plus the engine's scopes: `api`, `db`,
  `docker`, `deps`, `console`, `worker`. The list today names `clients` and `web`, which are
  another project's areas and were carried over by mistake. The section that allowed a body and
  footers is deleted: the kit's rule is subject-only, which is also this repository's practice.
- **Splitting work into commits** is deleted; `commits.md` states it.
- **Specs and plans** shrinks to a pointer at `documentation.md` plus the one local difference:
  the last task of a slice also updates `conventions.md` where a rule changed.
- **Language** and **Before committing** stay.

**Merges become rebase merges from this slice on.** The history so far is squash-merged pull
requests; that is left as it is.

### 4.4 `docs/backlog.md`

New, with the header the other consumers use and one entry: **the pool booking path duplicates
`computeForPool`'s member scan.** `BookingService.createInPool` narrows members with one
`offeredSlots` call per member — two queries each, sequentially — where
`AvailabilityService.computeForPool` answers the same question in two batched queries, and
spec 3 §5.1 still claims the two share one code path. Found 2026-08-28 in the spec 3 final
review; the impact is N round trips on the write path and a false claim in a decision record.

This finding exists today only outside the repository, which is exactly what the backlog rule
forbids.

### 4.5 `docs/architecture.md` and `README.md`

`architecture.md` gains one sentence where it names the stack: the engine follows the shared
`dev-kit` conventions, `tsconfig.json` extends the kit's Node base and Prettier takes its
configuration. `README.md` gains the Docker build note from §2.

---

## 5. Delivery

On `build/adopt-dev-kit`, merged by rebase. Each commit passes `./run check`:

1. `docs: record the dev-kit adoption design` — this document
2. `chore: take the shared ignore files from dev-kit`
3. `build: adopt dev-kit for typescript, prettier and the run script` — the dependency,
   `tsconfig.json` with the 15 fixes, `.prettierrc`, `./run`, the README Docker note
4. `docs: import the dev-kit rules and trim what they now state` — `CLAUDE.md`,
   `conventions.md`, `CONTRIBUTING.md`, `architecture.md`
5. `docs: adopt the backlog rule and record the pool scan duplication`

Commit 3 bundles the fixes with the flag that demands them, because neither compiles without the
other.

### Verification beyond `./run check`

- `./run` from a clone with `node_modules` removed: the bootstrap installs, then the help prints.
- `./run` with `.env` absent: `.env` is created, the `DATABASE_URL` note prints, the scenario
  continues rather than exiting.
- `docker compose build`: the build stage fetches the kit and compiles; the runtime image has no
  `node_modules/dev-kit`.
- `openapi.json` regenerates byte-identical under `./run openapi`, since Prettier's configuration
  did not change.

---

## 6. Not in scope

- **Fixing the pool scan duplication.** It is recorded in the backlog, not fixed here.
- **A private registry.** §2 names the one-line change for when one exists.
- **Any change to the kit.** Where this repository differs — two living documents instead of
  one — the difference is stated in `CLAUDE.md`, not pushed upstream.
