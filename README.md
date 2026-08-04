# Booking Engine

A domain-agnostic booking engine. It operates on three abstractions — resource, schedule,
booking — and knows nothing about what is being booked. Domain-specific data lives in a
separate layer above, in its own tables referencing `resource_id`.

This stage implements resources, weekly schedules, per-date exceptions and availability.
Bookings arrive in spec 2; the `pool` concurrency mode in spec 3.

| Document                                           | What it holds                                                               |
| -------------------------------------------------- | --------------------------------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md)       | The system: data model, lifecycle, full API surface across all three slices |
| [docs/conventions.md](docs/conventions.md)         | Rules that hold everywhere: formats, error shape, stack, layout, testing    |
| [docs/test-cases.md](docs/test-cases.md)           | Every promised behaviour as a runnable case, with its automated coverage    |
| [docs/superpowers/specs/](docs/superpowers/specs/) | One spec per slice — what it delivers and why it was decided that way       |
| [docs/superpowers/plans/](docs/superpowers/plans/) | The task-by-task plan that implemented each spec                            |
| [CONTRIBUTING.md](CONTRIBUTING.md)                 | Commit conventions and workflow                                             |

## Requirements

- Docker — required for the test suite, which runs against a real Postgres via
  Testcontainers, and sufficient on its own to run the whole engine
- Node.js 24 and PostgreSQL 16+ — only if you want to run the service outside a container

Node 24 is the current active LTS, supported into 2028; Node 22 has moved to maintenance.
The version is declared in [.nvmrc](.nvmrc) and enforced by `engines` in `package.json`, and
the container image pins the minor rather than floating on a tag, so a rebuild a year from
now produces the same runtime.

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
| `./run up`             | Build and start the whole stack in Docker, detached  |
| `./run down`           | Stop the stack, keeping the data                     |
| `./run reset`          | Wipe the database and start fresh                    |
| `./run logs [svc]`     | Follow logs, `app` by default                        |
| `./run docs`           | Open the interactive API reference                   |
| `./run psql`           | Open a psql shell on the development database        |
| `./run test`           | Run the full suite once                              |
| `./run check`          | Types, formatting and the full suite                 |
| `./run smoke [filter]` | Replay the test-case suites against a running engine |

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
./run smoke       # prove it works end to end
```

or, to work on the code:

```bash
./run dev         # reload on save, database in Docker
```

The compose database is published on host port **5433**, not 5432, so a Postgres you already
have installed locally keeps working alongside it. Override `PORT`, `LOG_LEVEL` or
`MAX_RANGE_DAYS` from your shell or `.env`.

## Debugging

```bash
./run debug
```

Same as `./run dev`, plus a Node inspector on `127.0.0.1:9229`. Attach from VS Code with the
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

## Scripts

Beyond the scenarios above, these do one thing each and are what `./run` calls internally:

| Command                 | Purpose                                                   |
| ----------------------- | --------------------------------------------------------- |
| `npm run build`         | Compile to `dist/`                                        |
| `npm start`             | Run the compiled build                                    |
| `npm run migrate`       | Apply migrations from the TypeScript sources              |
| `npm run migrate:built` | Apply migrations from `dist/`, used inside the container  |
| `npm run dev:server`    | Start the engine alone, assuming a database is already up |
| `npm run debug:server`  | The same with an inspector                                |
| `npm run format`        | Format with Prettier                                      |

The test suite starts its own throwaway Postgres container and ignores the compose service,
so tests need Docker running but no database prepared.

## API

**For manual testing, use the interactive reference at `/docs`** — `./run docs` opens it, and
the root path redirects there. Every endpoint has a **Try it out** button that sends a real request
with the example values pre-filled, so exploring the engine needs no curl.

The document is generated from the same TypeBox schemas the routes validate against, which
means it cannot drift from the behaviour: a field the engine rejects is a field the reference
shows as invalid. A test asserts that every route appears, carries a tag and a summary, and
that no documented route is missing from the code.

Also available as raw OpenAPI 3.1 at `/docs/json` and `/docs/yaml` — feed either to Postman,
Insomnia, or a client generator.

The endpoints at a glance:

| Method | Path                                    | Purpose                                                             |
| ------ | --------------------------------------- | ------------------------------------------------------------------- |
| GET    | `/health`                               | Liveness                                                            |
| POST   | `/resources`                            | Create a resource                                                   |
| GET    | `/resources/:id`                        | Read a resource                                                     |
| PATCH  | `/resources/:id`                        | Update `slot_duration`, `slot_anchor_time`, `capacity`, `is_active` |
| DELETE | `/resources/:id`                        | Delete a resource, its schedule and its exceptions                  |
| GET    | `/resources/:id/schedule`               | Read the weekly schedule                                            |
| PUT    | `/resources/:id/schedule`               | Replace the weekly schedule                                         |
| GET    | `/resources/:id/exceptions?from=&to=`   | List exceptions in a range                                          |
| PUT    | `/resources/:id/exceptions/:date`       | Create or overwrite an exception                                    |
| DELETE | `/resources/:id/exceptions/:date`       | Remove an exception                                                 |
| GET    | `/resources/:id/availability?from=&to=` | Compute available slots                                             |

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
ID=$(curl -s -X POST localhost:3000/resources -H 'content-type: application/json' -d '{
  "timezone": "Europe/Warsaw",
  "slot_duration": "P1D",
  "slot_anchor_time": "14:00",
  "concurrency_mode": "exclusive"
}' | sed -E 's/.*"id":"([^"]+)".*/\1/')

# Bookable every day of the week
curl -s -X PUT localhost:3000/resources/$ID/schedule -H 'content-type: application/json' -d '[
  {"day_of_week":0,"start_time":null,"end_time":null},
  {"day_of_week":1,"start_time":null,"end_time":null},
  {"day_of_week":2,"start_time":null,"end_time":null},
  {"day_of_week":3,"start_time":null,"end_time":null},
  {"day_of_week":4,"start_time":null,"end_time":null},
  {"day_of_week":5,"start_time":null,"end_time":null},
  {"day_of_week":6,"start_time":null,"end_time":null}
]'

curl -s "localhost:3000/resources/$ID/availability?from=2026-07-20&to=2026-07-23"
```

Three slots come back, each running 14:00 to 14:00 the next day. Asking across the spring
transition (`from=2026-03-28&to=2026-03-31`) still yields slots anchored at 14:00 local, and
the first of them is 23 real hours long.

## Known limitations

No windows crossing midnight, `pool` mode rejected until spec 3, no schedule history, no
authentication. Each is deliberate, and the reasoning and cost to lift are tabulated in
[docs/conventions.md](docs/conventions.md#deliberate-limitations).
