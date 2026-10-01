# Booking Engine

A domain-agnostic booking engine. It operates on three abstractions — resource, schedule,
booking — and knows nothing about what is being booked. Domain-specific data lives in a
separate layer above, in its own tables referencing `resource_id`.

This stage implements resources, weekly schedules, per-date exceptions, availability and
bookings — creation, the lifecycle, hold expiry, reschedule, listings, and all three
concurrency modes: `exclusive`, `shared`, and `pool`, a group of interchangeable resources
booked as one, where a caller asks for an interval and the engine claims a free member.

**Start here.** These two are authoritative for what the engine does today, and together they
are the whole onboarding path:

| Document                                     | What it holds                                                                                 |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md) | The system: data model, lifecycle, availability, and why contracts have their shape           |
| [docs/conventions.md](docs/conventions.md)   | The engine's own rules: formats, error and scope tables, stack, where layout and testing land |

Reference, consulted rather than read through:

| Document                                                           | What it holds                                                                        |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| [openapi.json](openapi.json)                                       | Every path, field and status code, generated from the schemas the routes validate    |
| [docs/test-cases.md](docs/test-cases.md)                           | Every promised behaviour as a runnable case, with its automated coverage             |
| [docs/backlog.md](docs/backlog.md)                                 | What is known to be wrong and not yet fixed — read before planning                   |
| [CONTRIBUTING.md](CONTRIBUTING.md)                                 | Commit scopes and what this repository adds to the shared conventions                |
| [docs/superpowers/specs/](docs/superpowers/specs/)                 | Decision records, one per slice — read for _why_, never for what                     |
| [docs/superpowers/plans/archive/](docs/superpowers/plans/archive/) | The task-by-task plans that built each slice. Spent scaffolding, kept for provenance |

## Requirements

- Docker — required for the test suite, which runs against a real Postgres via
  Testcontainers, and sufficient on its own to run the whole engine
- Node.js 24 and PostgreSQL 16+ — only if you want to run the service outside a container

Node 24 is the current active LTS, supported into 2028; Node 22 has moved to maintenance.
The version is declared in [.nvmrc](.nvmrc) and enforced by `engines` in `package.json`, and
the container image pins the minor rather than floating on a tag, so a rebuild a year from
now produces the same runtime.

Building the image needs GitHub as well as the npm registry: `tsconfig.json` extends `dev-kit`,
a dev dependency installed from its git host at a pinned tag. The build stage fetches it; the
runtime image installs production dependencies only and does not contain it.

### Dependency security

`npm audit --omit=dev` reports no vulnerabilities, and that is the number that matters for
what ships: the runtime image contains only production dependencies, and `.dockerignore`
keeps tests out of the build context entirely.

The dev tree needed one `overrides` entry. `testcontainers` pulls `archiver`, which reaches
a `brace-expansion` with a denial-of-service advisory through `readdir-glob` and `minimatch`.
No release of `testcontainers` resolves it, and npm reported no fix reachable through the
dependency ranges, so `brace-expansion` is forced to a patched major in `package.json`. The
full suite passes against it.

## Running

One command per scenario. `./run` on its own lists them.

| Command                | What it does                                         |
| ---------------------- | ---------------------------------------------------- |
| `./run dev`            | Database in Docker, engine locally with reload       |
| `./run debug`          | Same, plus a Node inspector on 9229                  |
| `./run stop`           | Stop whatever `--bg` started, keeping the database   |
| `./run up`             | Build and start the whole stack in Docker, detached  |
| `./run down`           | Stop the stack, keeping the data                     |
| `./run reset`          | Wipe the database and start fresh                    |
| `./run logs [svc]`     | Follow logs, `app` by default                        |
| `./run docs`           | Open the interactive API reference                   |
| `./run openapi`        | Rewrite the committed `openapi.json`                 |
| `./run psql`           | Open a psql shell on the development database        |
| `./run test`           | Run the full suite once                              |
| `./run test:watch`     | Re-run the suite on change                           |
| `./run test:ui`        | The console suite in a real browser                  |
| `./run check`          | Types, formatting and the full suite                 |
| `./run smoke [filter]` | Replay the test-case suites against a running engine |

`./run up` also starts a `worker` service alongside `db`, `migrate` and `app` — the same image,
sweeping expired holds on its own. See [Background sweep](#background-sweep) below.

`./run test:ui` needs a Playwright browser binary, which is why it stays out of `./run check`:
a missing download must not read as a broken build. The scenario checks for the binary and
prints the install command when it is absent.

**Which one to use while writing code: `./run dev`.** It reloads on every save, so nothing
needs rebuilding. `./run up` runs the compiled image in Docker, where a source change means
rebuilding — use it to verify the container itself, or to leave the engine running for
someone else.

Scenarios that talk to a running engine — `docs`, `smoke` — find its port from Docker, so a
stack started as `PORT=3100 ./run up` is still reachable from a fresh shell.

Each scenario does the whole chain, not one step of it. `./run dev` installs dependencies if
they are missing, creates `.env` if it is absent, starts Postgres, **waits until it actually
accepts connections**, applies migrations, and only then starts the engine. That wait is the
reason this script exists: `docker compose up -d db` returns before Postgres is listening, so
migrating immediately afterwards fails intermittently.

Prerequisites are checked up front and reported as instructions rather than symptoms — a
stopped Docker daemon says so, instead of surfacing a connection refused ten seconds later.

The npm scripts still work — `npm run dev`, `npm run up`, `npm test` — they delegate to the
same script, so both habits are fine.

### First run

```bash
./run up          # everything in Docker, http://localhost:3000
```

Every request needs an API key, so make one. Open the console at
**http://127.0.0.1:3001**, create a tenant, issue a key with the **Back office** preset, and
copy it — it is shown once:

```bash
export BOOKING_KEY=bk_live_...
./run smoke       # prove it works end to end
```

`./run smoke` creates its own throwaway tenant and key through the console, so it needs the
console running but not `BOOKING_KEY`.

or, to work on the code:

```bash
./run dev         # reload on save, database in Docker
```

The compose database is published on host port **5433**, not 5432, so a Postgres you already
have installed locally keeps working alongside it. Override `PORT`, `LOG_LEVEL` or
`MAX_RANGE_DAYS` from your shell or `.env`.

### The console

The console issues, lists and revokes API keys, and it **has no authentication of its own**. It
is therefore bound to `127.0.0.1` and published in compose as `127.0.0.1:3001:3001`. That bind
address is hard-coded, not configurable: reaching this port is reaching the ability to mint an
all-scopes key for any tenant in the database. Do not put it behind a public reverse proxy, and
do not change the mapping to `0.0.0.0`.

A key is shown exactly once, when it is issued. Losing it means issuing another and revoking
the first; revocation keeps the row, so the audit trail survives.

The presets answer the question "what is this key for":

| Preset          | For                                                                 |
| --------------- | ------------------------------------------------------------------- |
| Widget          | A calendar that only shows free slots                               |
| Site backend    | The owner's own backend: book, read, and list the calendar          |
| Partner channel | A reseller that may book but must **not** read the owner's calendar |
| Reporting       | Read-only across everything, including the calendar                 |
| Back office     | Everything                                                          |

Presets are expanded at issue time and the name is not stored, so editing a preset later
cannot change a key already in the field.

## Running both planes locally

`./run dev` starts the engine **and** the console together, each reloading on save, with their
output labelled `[api]` and `[console]` in one terminal. Ctrl-C stops the pair. They come as a
pair because the engine refuses every request without a key and the console is the only place
to issue one — starting either alone leaves you unable to use either.

```bash
./run dev            # both, in this terminal
./run dev --bg       # both, detached; logs in .run/, stop with ./run stop
./run stop           # stops what --bg started; the database keeps running
```

Detached mode writes `.run/api.log` and `.run/console.log` and records each PID beside them,
so `./run stop` can walk the process tree — `npm` and `tsx watch` each fork, and killing only
the launcher would orphan the process actually holding the port.

## Debugging

```bash
./run debug          # both, inspectors on 9229 (engine) and 9230 (console)
./run debug --bg     # the same, detached
```

Two inspector ports because two Node processes cannot share one. Attach from VS Code with the
**Attach to running server** configuration, or open `chrome://inspect` in a Chromium browser.

Four launch configurations are checked in at [.vscode/launch.json](.vscode/launch.json):

| Configuration            | What it does                                                   |
| ------------------------ | -------------------------------------------------------------- |
| Debug server             | Starts the server under the debugger. Needs `.env` to exist    |
| Attach to running server | Attaches to a `./run debug` already running on 9229            |
| Debug current test file  | Runs the file open in the editor, stopping at your breakpoints |
| Debug all tests          | Runs the whole suite under the debugger                        |

Breakpoints work directly in the TypeScript sources — `tsx` and Vitest both emit source maps,
so there is no build step to keep in sync.

Debugging tests requires Docker to be running: the suite starts its own Postgres container.
That container's startup is why `hookTimeout` in [vitest.config.ts](vitest.config.ts) is
generous — do not mistake a slow first run for a hung test.

To see what the engine is actually doing, raise the log level rather than adding
`console.log`:

```bash
LOG_LEVEL=debug ./run dev
```

## Background sweep

A `held` booking that outlives its `held_until` still blocks its slot until something moves it
out of `held`. That correctness step runs inline, inside every write transaction that touches
the resource — so a caller is never refused a slot that is in fact free — but it only touches
the one resource being written to. Something has to sweep the rest, so that listings stop
showing a `held` row on a dead hold and idle resources do not accumulate them forever. The same
image runs that sweep three ways, chosen with the command:

| Command                          | Behaviour                             | Suits                                                    |
| -------------------------------- | ------------------------------------- | -------------------------------------------------------- |
| `node dist/src/server.js`        | API, with the sweep on a timer inside | Development, a single-instance deployment                |
| `node dist/src/worker.js`        | Sweep only, looping                   | A separate service or deployment                         |
| `node dist/src/worker.js --once` | One sweep, then exit                  | A Kubernetes CronJob, a systemd timer, a cloud scheduler |

`./run up` and `docker compose up` start the looping worker alongside the API by default. All
three can run at once, safely: a Postgres advisory lock lets exactly one sweeper win each tick,
so any combination of API timers, a worker service and an external scheduler never sweeps
twice or races.

**`HOLD_SWEEP_ENABLED` defaults to `true`**, meaning the API process sweeps on its own timer
even when a separate `worker` service is also deployed. That is deliberate: a dead worker would
otherwise be an invisible failure — requests keep being served, nothing alerts, and stale holds
quietly accumulate. Leaving the API timers on means a failed worker is covered automatically,
and the separate service is an optimisation rather than a dependency. Set it to `false` only
when request-serving processes should do no background work at all.

## Scripts

Beyond the scenarios above, these do one thing each and are what `./run` calls internally:

| Command                  | Purpose                                                   |
| ------------------------ | --------------------------------------------------------- |
| `npm run build`          | Compile to `dist/`                                        |
| `npm start`              | Run the compiled engine                                   |
| `npm run console`        | Run the compiled console                                  |
| `npm run migrate`        | Apply migrations from the TypeScript sources              |
| `npm run migrate:built`  | Apply migrations from `dist/`, used inside the container  |
| `npm run dev:server`     | Start the engine alone, assuming a database is already up |
| `npm run dev:console`    | Start the console alone, same assumption                  |
| `npm run debug:console`  | The console with an inspector on 9230                     |
| `npm run debug:server`   | The same with an inspector                                |
| `npm run worker`         | Run the hold-sweep worker alone, looping                  |
| `npm run openapi`        | Rewrite `openapi.json` from the route schemas             |
| `npm run test:ui:headed` | The console browser suite with the browser visible        |
| `npm run format`         | Format with Prettier                                      |

The test suite starts its own throwaway Postgres container and ignores the compose service,
so tests need Docker running but no database prepared.

## API

Every request outside `/health`, `/` and `/docs` carries `Authorization: Bearer bk_live_...`.
A key belongs to one tenant and sees only that tenant's rows — another tenant's id answers
`404`, never `403`. Which routes each scope opens is in
[conventions.md](docs/conventions.md#authentication-and-scopes).

**For manual testing, use the interactive reference at `/docs`** — `./run docs` opens it, and
the root path redirects there. Every endpoint has a **Try it out** button that sends a real request
with the example values pre-filled, so exploring the engine needs no curl.

The document is generated from the same TypeBox schemas the routes validate against, which
means it cannot drift from the behaviour: a field the engine rejects is a field the reference
shows as invalid. A test asserts that every route appears, carries a tag and a summary, and
that no documented route is missing from the code.

Also available as raw OpenAPI 3.1 at `/docs/json` and `/docs/yaml` — feed either to Postman,
Insomnia, or a client generator.

The same document is committed as [openapi.json](openapi.json), so generating a client's types
needs no running engine — which matters most in a consumer's CI, where starting one is awkward.
It is written by `./run openapi` and never by hand, and a test fails when it and the route
schemas disagree, so a contract change is visible in the diff of a pull request here rather
than in a consumer's failing build later.

The endpoints at a glance:

| Method | Path                                    | Purpose                                                             |
| ------ | --------------------------------------- | ------------------------------------------------------------------- |
| GET    | `/health`                               | Liveness                                                            |
| POST   | `/resources`                            | Create a resource                                                   |
| GET    | `/resources`                            | List the tenant's resources                                         |
| GET    | `/resources/:id`                        | Read a resource                                                     |
| PATCH  | `/resources/:id`                        | Update `slot_duration`, `slot_anchor_time`, `capacity`, `is_active` |
| DELETE | `/resources/:id`                        | Delete a resource, its schedule and its exceptions                  |
| GET    | `/resources/:id/schedule`               | Read the weekly schedule                                            |
| PUT    | `/resources/:id/schedule`               | Replace the weekly schedule                                         |
| GET    | `/resources/:id/exceptions?from=&to=`   | List exceptions in a range                                          |
| PUT    | `/resources/:id/exceptions/:date`       | Create or overwrite an exception                                    |
| DELETE | `/resources/:id/exceptions/:date`       | Remove an exception                                                 |
| GET    | `/resources/:id/availability?from=&to=` | Compute available slots                                             |
| POST   | `/resources/:id/bookings`               | Book a run of slots                                                 |
| GET    | `/bookings/:id`                         | Read a booking                                                      |
| POST   | `/bookings/:id/confirm`                 | Confirm a held booking                                              |
| POST   | `/bookings/:id/cancel`                  | Cancel a booking                                                    |
| POST   | `/bookings/:id/reschedule`              | Move a booking to a different run of slots                          |
| POST   | `/bookings/:id/complete`                | Mark a booking as completed                                         |
| POST   | `/bookings/:id/no-show`                 | Mark a booking as a no-show                                         |
| GET    | `/resources/:id/bookings?from=&to=`     | List the bookings of one resource                                   |
| GET    | `/bookings?customer_id=&from=&to=`      | List one customer's bookings across resources                       |

### Conventions

Full reference: [docs/conventions.md](docs/conventions.md). The four that catch people out:

- **Date ranges are half-open** — `from` inclusive, `to` exclusive, at most `MAX_RANGE_DAYS`.
- **`P1D` is not `PT24H`.** The first runs anchor to anchor and is 23, 24 or 25 real hours
  depending on daylight saving; the second is rejected. The written form is what makes a
  resource day-based.
- **Timezones are named IANA zones only** — `+02:00` is refused, because an offset has no
  daylight-saving rules.
- **Weekdays are Monday = 0 … Sunday = 6**, which matches neither Postgres nor JavaScript.

## Example — a hotel room

```bash
# Nightly, and the day starts at 14:00 rather than midnight
AUTH="authorization: Bearer $BOOKING_KEY"

ID=$(curl -s -X POST localhost:3000/resources -H "$AUTH" -H 'content-type: application/json' -d '{
  "timezone": "Europe/Warsaw",
  "slot_duration": "P1D",
  "slot_anchor_time": "14:00",
  "concurrency_mode": "exclusive"
}' | sed -E 's/.*"id":"([^"]+)".*/\1/')

# Bookable every day of the week
curl -s -X PUT localhost:3000/resources/$ID/schedule -H "$AUTH" -H 'content-type: application/json' -d '[
  {"day_of_week":0,"start_time":null,"end_time":null},
  {"day_of_week":1,"start_time":null,"end_time":null},
  {"day_of_week":2,"start_time":null,"end_time":null},
  {"day_of_week":3,"start_time":null,"end_time":null},
  {"day_of_week":4,"start_time":null,"end_time":null},
  {"day_of_week":5,"start_time":null,"end_time":null},
  {"day_of_week":6,"start_time":null,"end_time":null}
]'

curl -s -H "$AUTH" "localhost:3000/resources/$ID/availability?from=2026-07-20&to=2026-07-23"
```

Three slots come back, each running 14:00 to 14:00 the next day. Asking across the spring
transition (`from=2026-03-28&to=2026-03-31`) still yields slots anchored at 14:00 local, and
the first of them is 23 real hours long.

## Known limitations

No windows crossing midnight, no schedule history, bookings in the past are accepted, a
schedule edit may orphan existing bookings, `shared` serializes writes per resource, no
pagination on listings, no automatic completion, a pool cannot report how many members are
free, a pool cannot mix slicing parameters across members, a pool member must be `exclusive`,
pool member selection order is not a contract, and pools cannot nest. Each is deliberate, and
the reasoning and cost to lift are tabulated in
[docs/conventions.md](docs/conventions.md#deliberate-limitations).
