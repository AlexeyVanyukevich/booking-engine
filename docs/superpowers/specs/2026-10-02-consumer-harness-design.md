# Running the engine in a consumer's tests

**Status:** draft · **Date:** 2026-10-02

**This is a decision record, not current truth.** It states what was decided on the date above and is not revised as the system changes. For what the engine does today, read [architecture.md](../../architecture.md) and [conventions.md](../../conventions.md) — where they disagree with this document, they are right.

---

## 1. Purpose

Fixes the backlog entry _There is no supported way to run the engine in a consumer's
integration tests_.

**Roles.** The _consuming project_ is the admin application that books through the engine and
tests against a real one. _A consumer_ is any project in that position, of which it is the
first.

The consuming project's own design asked for "the engine itself: its image at a pinned tag".
What it has instead is a two-hundred-line harness that:

- builds the image from a checkout of this repository that must sit beside its own, unpinned;
- starts the engine's Postgres, a one-shot migrator, the API and the console as four
  containers on one network;
- copies a script into the console container and `exec`s it, because the console binds
  `127.0.0.1` inside its container and so cannot be reached through a published port;
- has that script drive the console's HTML forms and scrape `bk_live_…` secrets out of the
  pages;
- runs its test traffic under the production rate limit, not knowing `RATE_LIMIT_PER_MINUTE`
  exists.

The same loopback bind breaks this repository's own README: under `./run up` the console is
unreachable from the host, so the first-run instruction to "open the console at
http://127.0.0.1:3001" cannot be followed. Verified on 2026-10-01 with a throwaway container:
a server bound to `127.0.0.1` inside it answered nothing through its published port; the same
server bound to `0.0.0.0` answered `200`.

### Success

- A consumer starts a pinned engine, holding keys of the presets it names, with one call to an
  installed helper: no checkout of this repository, no `exec`, no HTML.
- The image and the helper are released together from one `vX.Y.Z` tag, and the helper starts
  exactly the image it was released with.
- An operator running `./run up` can get a key without the console.
- The consumer can set the rate limit its tests run under, and the README says how.

---

## 2. Decisions

| Question                                | Decided                                                      | Rejected, and why                                                                                                                                                                                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What the engine ships for tests         | A TypeScript helper on top of the image                      | A documented recipe: every consumer keeps its own copy, and it breaks when start-up changes. The image alone: the consumer keeps solving the rest                                                                                                                                              |
| Where the image comes from              | GitHub Container Registry, pushed on a version tag           | Docker Hub: an account and anonymous-pull rate limits for no gain. Building from a git tag: every cold run pays a full image build                                                                                                                                                             |
| How keys are issued without the console | A one-shot `issue-keys` command in the image                 | Seeding keys from an environment variable at start-up: every production API process would gain a path that mints credentials from its environment. A configurable console bind: it removes the console's only guard. An admin HTTP API: a new authentication surface for one test harness      |
| How the helper is delivered             | An npm package on GitHub Packages, published by the same tag | Public npmjs: needs an npm account and makes the helper public. A git-tag dependency on this repository: npm cannot install a subdirectory, so the consumer would install the whole engine and its dependencies, and a `prepare` build would install every dev dependency on each cold install |

---

## 3. `issue-keys`

A fourth entry point, `src/issue-keys.ts`, beside `server.ts`, `console.ts` and `worker.ts`:

```
node dist/src/issue-keys.js --tenant <name> --preset <preset> [--preset <preset>]...
```

It creates one tenant, issues one key per `--preset` through `TenantService`, and writes
exactly one line to stdout:

```json
{ "tenantId": "…", "keys": { "site_backend": "bk_live_…", "back_office": "bk_live_…" } }
```

- Presets are the ones in `src/shared/scopes.ts`, validated with `isPresetName` and expanded
  with `expandPreset`, so a key issued here holds exactly what the console's preset of the same
  name would give it. Each key is named after its preset.
- `keys` is an object keyed by preset, so a preset named twice is one key, not two. A consumer
  wanting two keys of one preset runs the command twice; nothing asks for more.
- An unknown preset, no `--preset`, a missing or blank `--tenant`, or a database failure exits
  non-zero with the reason on stderr and **nothing** on stdout. Validation happens before any
  write, so a refused invocation creates no tenant.
- Diagnostics go to stderr only. Stdout carries the result and nothing else, so a caller can
  parse it whole.
- The logic is a function, `issueKeys(argv, { service, out })`, and the module's `main` only
  wires configuration, the database and `process.stdout` to it. Tests call the function against
  a real database; nothing spawns a process to test it.

**Trust.** The command needs `DATABASE_URL`, which already means full control of the engine's
data. That is the trust `migrate.js` runs with, and nothing new is exposed on any network. The
console and its loopback bind are unchanged.

**For operators.** `./run key <tenant> <preset>...` runs
`docker compose run --rm app node dist/src/issue-keys.js …` against the compose stack and
prints the result. The README's first run uses it in place of the unreachable console.

---

## 4. Release

`.github/workflows/release.yml`, the repository's first workflow, runs when a tag matching
`v*.*.*` is pushed:

1. Fail unless the tag, without its `v`, equals the root `package.json` version.
2. `./run check` — types, formatting and the full suite, including the helper's test in §6.
3. Build the image for `linux/amd64` and `linux/arm64` and push it as
   `ghcr.io/alexeyvanyukevich/booking-engine:X.Y.Z`. Both platforms, because a consumer on
   Apple silicon would otherwise pull an emulated image.
4. Build `testing/`, stamp its `package.json` with version `X.Y.Z`, and publish
   `@alexeyvanyukevich/booking-engine-testing@X.Y.Z` to GitHub Packages.

Nothing is pushed unless step 2 passes. The tag is the single source of the version: the
helper's version is written from it at publish time, never edited by hand. Both pushes use the
workflow's own `GITHUB_TOKEN` with `packages: write`.

A release is still a tag on `main`, as the shared commit rule says; this adds what a tag does,
not a new way to make one.

---

## 5. The helper

`testing/` holds a small package of its own: `package.json`, `tsconfig.json`, `src/index.ts`.
It is not an npm workspace, so installing this repository is unchanged. `testcontainers` is a
peer dependency, which the consuming project already has. It imports nothing from `src/`: it
talks to the engine only through the image, the way a consumer does.

```ts
export type PresetName = 'widget' | 'site_backend' | 'partner_channel' | 'reporting' | 'back_office'

export interface EngineOptions {
  /** Presets to issue one key each for, on one tenant. Default `['back_office']`. */
  keys?: PresetName[]
  /** The tenant's name. Default `'tests'`. */
  tenant?: string
  /** Passed to the API as `RATE_LIMIT_PER_MINUTE`. Default: the engine's own default. */
  rateLimitPerMinute?: number
  /** Default `ghcr.io/alexeyvanyukevich/booking-engine:<this package's version>`. */
  image?: string
}

export interface StartedEngine {
  url: string
  tenantId: string
  keys: Partial<Record<PresetName, string>>
  stop(): Promise<void>
}

export function startEngine(options?: EngineOptions): Promise<StartedEngine>
```

`startEngine` starts, in order: a network; `postgres:16-alpine` on it; the image running
`migrate.js` to completion; the image running `issue-keys.js` to completion, whose stdout it
parses; and the image running the API with `DATABASE_URL`, `LOG_LEVEL=warn` and, when given,
`RATE_LIMIT_PER_MINUTE`, waited for on `/health`. A one-shot step that exits non-zero fails
`startEngine` with that step's output in the error, after stopping whatever had started.
`stop()` stops the API, Postgres and the network.

- **The default image is the helper's own version**, read from its `package.json`, so a
  consumer pins one version and gets the matching engine. `image` exists so this repository's
  tests, and its release workflow, can run the helper against an image built from the
  checkout.
- **`rateLimitPerMinute` defaults to the engine's production value**, not to a high test value.
  A harness that silently lifts the limit hides the behaviour a consumer meets in production;
  the README's example sets it explicitly.
- **`PresetName` is restated in the helper** rather than imported from `src/`, because the
  helper ships without the engine's source. A unit test asserts it equals the keys of
  `PRESETS`, so the two cannot drift.
- **Seeding resources stays with the consumer.** What a resource looks like is the consumer's
  domain; the helper returns keys, and a `back_office` key can create anything.

---

## 6. Tests

**`issue-keys`** — `tests/integration/issue-keys.test.ts`, driven by a dataset in
`tests/fixtures/datasets/`:

| Case                          | Expectation                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------- |
| One preset                    | One tenant, one key; the key authenticates and holds exactly the preset's scopes |
| Several presets               | One tenant, one key per preset, each holding exactly its own preset's scopes     |
| A preset named twice          | One key for it                                                                   |
| An unknown preset             | Non-zero, a message naming it on stderr, nothing on stdout, no tenant created    |
| No `--preset`                 | Non-zero, nothing on stdout, no tenant created                                   |
| No `--tenant`, or a blank one | Non-zero, nothing on stdout, no tenant created                                   |

"Holds exactly the preset's scopes" is read back from the stored key row against
`expandPreset`, and "authenticates" goes through `TenantService.authenticate`, not a mock.

**The helper** — `tests/integration/helper.test.ts` builds the image from this checkout with
Testcontainers and calls `startEngine({ image })`:

- each requested key authenticates, and the scopes it holds are visible in behaviour: a
  `back_office` key creates a resource, a `site_backend` key is refused `403 forbidden_scope`
  doing the same;
- `rateLimitPerMinute: 2` answers the third request `429 rate_limited`;
- after `stop()`, none of the containers it started is still running;
- a one-shot failure — an unknown preset — rejects with that step's output, and leaves nothing
  running.

**`PresetName`** — a unit test asserts the helper's union equals `Object.keys(PRESETS)`.

The helper's test runs in `./run check`. The first run builds the image; later runs reuse the
layer cache. That is the cost the consuming project already pays on every cold run, moved to
the one repository that can keep it working.

---

## 7. Documentation

- `README.md`: the first run uses `./run key` instead of the console; a new section, _Testing
  against the engine_, gives the `.npmrc` line for GitHub Packages, the `read:packages` token
  it needs locally and in CI, and a `startEngine` example that sets `rateLimitPerMinute`;
  `./run key` joins the scenario table.
- `docs/architecture.md`: `issue-keys` as a control-plane entry point beside the console, and
  the release flow.
- `docs/conventions.md`: updated wherever a rule changed.
- `docs/backlog.md`: the harness entry is deleted by the slice's last commit. A new entry
  records that nothing runs on a pull request or a push to `main` — only a tag runs the check
  in CI — so a broken `main` is found by the next release, not by the commit that broke it.

The harness entry also said the rate limit "has no setting". That was wrong:
`RATE_LIMIT_PER_MINUTE` existed and was documented. It is corrected by the README section, which
documents the option the consumer needs, and leaves with the entry.

---

## 8. Not in this slice

- Changing the consuming project's harness to use the helper. That is its own change, in its
  own repository, after the first release exists.
- CI on pull requests and pushes to `main` (recorded in the backlog, §7).
- The first release itself. Pushing a tag publishes to registries; the slice ends with the
  workflow ready, and the first tag is pushed as a separate, deliberate step.
