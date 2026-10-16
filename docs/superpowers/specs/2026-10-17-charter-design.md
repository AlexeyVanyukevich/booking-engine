# The shared rules come from charter 3.3.0

**Status:** approved · **Date:** 2026-10-17

**This is a decision record, not current truth.** It states what was decided on the date above and is not revised as the system changes. For what the engine does today, read [architecture.md](../../architecture.md) and [conventions.md](../../conventions.md) — where they disagree with this document, they are right.

---

## 1. Purpose

Fixes two backlog entries:

- _The shared rules are pinned at dev-kit 1.2.1_
- _`CLAUDE.md` counts the convention departures, and nothing keeps the count true_ — taken in
  because this slice rewrites the paragraph it names

The shared kit was renamed `charter` at 3.0.0 and is at 3.3.0, released 2026-10-14. The engine
is two majors behind: no rule correction made since 1.2.1 reaches a session here, and every
path the engine writes into the kit — the rule imports, the tsconfig base, the Prettier key,
`./run`'s `source` line — has moved twice.

3.x also changes how rules load. 1.x was one `CLAUDE.md` import per rule, all loaded always.
3.x imports `core` once and delivers every other rule by path: a `charter.json` names the
project's modules, a SessionStart hook runs `charter sync`, and `sync` mirrors each module's
rules into `.claude/rules/charter/`, where a rule loads once a session reads a file matching its
`paths:`.

### Success

- `node_modules/dev-kit` is gone; `node_modules/charter` is 3.3.0, installed over git at the
  `v3.3.0` tag.
- `./run check` passes, the tsconfig and Prettier settings are the kit's, and nothing is
  reformatted.
- A session started at the root reads `core` from `CLAUDE.md`, and its SessionStart hook writes
  the mirror for `backend`, `typescript`, `node` and `vitest`.
- A commit whose message breaks the commit rule is refused by the kit's `commit-msg` hook.
- No document names `dev-kit`, except dated specs and archived plans, which are not revised.

### Out of scope, recorded in the backlog

- **oxlint.** Each stack ships a lint config, and the kit asks a consumer to install the linter
  itself. Adopting it means triaging a few dozen findings — the kit's README measured 36–78 in
  three projects — which is a slice of its own.
- **The key console under the `frontend` domain.** The console is a web interface, and
  `frontend` plus `playwright` would hold it to WCAG 2.2 AA and to journeys with an axe-core scan
  of every state and a keyboard-only run per flow. `tests/ui/` does neither today, and
  `@axe-core/playwright` is not installed. Taking the modules without the work would make every
  session read rules the code visibly breaks — and `accessibility.md`'s `src/**` would load it
  for every backend file.

## 2. Modules

```json
{ "workspaces": { ".": ["backend", "typescript", "node", "vitest"] } }
```

The kit's prescription for a Node service. Against 1.2.1 it adds no obligation: the same
http, layout, PostgreSQL-testing and TypeScript rules, split across modules and loaded by path.

`testing/` — the consumer test helper — is **not** recorded as a workspace. It has no HTTP
surface for `backend`, and the `typescript` and `node` rules match `**/*.ts` from the root
already.

### Rule text that changed, and the engine already follows

Read on 2026-10-17 against the tree:

| Rule               | Change since 1.2.1                                                 | The engine                                                                                              |
| ------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `layout.md`        | module directory plural, files singular                            | `bookings/booking.*.ts`, `resources/resource.*.ts`; `availability`, `schedule`, `health` are mass nouns |
| `documentation.md` | spec named `…-design.md`; a bounded change gets no spec            | every spec already ends `-design.md`                                                                    |
| `commits.md`       | local merge is rebase then `merge --ff-only`; release commit       | the user merges by rebase already                                                                       |
| `testing.md`       | a dataset holds one behaviour's cases; a scenario stays a scenario | unchanged practice                                                                                      |
| `http.md`          | `additionalProperties: false` moved to the `node` stack's rule     | same eight codes; `conflict` remains the one departure                                                  |

## 3. Changes

### Dependency and configuration

- `package.json`: `dev-kit` removed; `"charter": "github:AlexeyVanyukevich/charter#v3.3.0"`
  added as a dev dependency — the git form the sibling projects on 3.3.0 use. The repository is
  public, so the release workflow's `npm ci` and the image's build stage need no token, as for
  dev-kit.
- `"prettier": "charter/stacks/typescript/prettier"` — `semi: false`, `singleQuote: true`,
  `printWidth: 100`, the same three values.
- `tsconfig.json` and `testing/tsconfig.json` extend `charter/stacks/node/tsconfig`, which
  resolves to the same five compiler options and NodeNext resolution as `dev-kit/tsconfig/node`.

### `./run`

- The bootstrap tests for and sources `node_modules/charter/core/lib.sh`, and its message names
  charter. Its behaviour does not change: without npm it says what to install and how to run on
  Docker alone; otherwise it installs.
- `DEVKIT_NODE_HINT` becomes `CHARTER_NODE_HINT`. `need_node` and `need_env` are otherwise
  unchanged in 3.3.0.
- Every scenario that runs `need_node; need_deps` — seven call sites — also runs `need_plugins`
  and `need_hooks`, in that order, through one local helper so the four stay together. Without
  Claude Code, as in CI, `need_plugins` notes the skip and returns zero.

### Rule loading

`npx --no charter init backend typescript node vitest`, at the root, writes:

- `charter.json`, as above;
- in `.claude/settings.json`, the SessionStart hook that runs `charter sync`, or fails asking
  for `npm install`;
- `.claude/rules/charter/` in `.gitignore`;
- the `commit-msg` wrapper in `.git/hooks`.

`.claude/settings.json` is untracked today, holding only `enabledPlugins` with `superpowers`.
**It is committed with that entry.** The hook only works committed, and `need_plugins` will
then install superpowers on any clone that runs `./run`.

### `CLAUDE.md`

The nine `@node_modules/dev-kit/rules/…` imports become `@node_modules/charter/core/rules.md`.
The Conventions paragraph says:

- the shared rules come from charter's modules, as `charter.json` names them — `core` through
  the import below, the rest by path through the session's sync hook;
- a shared rule is corrected in the kit, never restated here;
- where the published contract cannot follow one, `docs/conventions.md` lists the departure
  with its reason, and a test keeps that list exact — **with no count**;
- declining a shared rule means dropping its module from `charter.json`, with the reason in
  `CONTRIBUTING.md`. A single rule inside a module can no longer be declined; one that must be
  is a departure.

### The departure test

`tests/unit/documented-tables.test.ts` reads the shared code table from
`node_modules/charter/domains/backend/rules/http.md`. That file now opens with a `paths:`
frontmatter; `tableWithHeader` finds a table by its header row, so the frontmatter must not
matter — the test passing is the proof.

### Documents

`CONTRIBUTING.md`, `README.md` (the Node prerequisite and the image-build note),
`docs/architecture.md` and `docs/conventions.md` each name the kit once or twice; each sentence
is rewritten for charter and for loading by module. The README states that a session's rules
need `npm install` to have run once, since the sync hook reads the kit from `node_modules`.

### Backlog

Both entries this slice fixes are in the working tree but were never committed. They are
committed first, unchanged, as their own `docs(backlog)` commit, so that each fixing commit can
delete its entry as the backlog rule requires. The slice adds the two out-of-scope entries
above.

## 4. Verification

- `./run check` on the finished tree.
- `charter sync` run by hand writes `.claude/rules/charter/@root/` with `backend/http.md`,
  `backend/layout.md`, `backend/database-tests.md`, `typescript/typescript.md` and
  `node/typescript.md`, with their `paths:` unprefixed for the root workspace.
- The installed `commit-msg` hook refuses `git commit --allow-empty -m "Bad subject."`, and
  this slice's own commits pass it.
- `./run help` in a copy of the checkout without `node_modules/charter` installs and continues;
  `run-bootstrap.test.ts` covers the no-npm path.

### Unproven by this slice

- That a fresh Claude Code session loads a path rule on reading a matching file. It is the
  kit's contract and its own check; this slice verifies the mirror, not the session.
- The release workflow and the multi-arch image build. Both run only on a tag, and neither is
  run here; the build stage's `npm ci` resolves charter from the same public git host as
  dev-kit.
