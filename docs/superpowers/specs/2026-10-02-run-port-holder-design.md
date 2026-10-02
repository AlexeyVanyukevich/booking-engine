# `./run` explains a port held by something else

**Status:** draft · **Date:** 2026-10-02

**This is a decision record, not current truth.** It states what was decided on the date above and is not revised as the system changes. For what the engine does today, read [architecture.md](../../architecture.md) and [conventions.md](../../conventions.md) — where they disagree with this document, they are right.

---

## 1. Purpose

Fixes the backlog entry _`./run smoke` and `./run docs` exit silently when another server holds
the port_.

`assert_engine_answers` in `run` tells three cases apart before `./run smoke` or `./run docs`
talks to an engine: the engine answers; something else answers; nothing answers. The second is
the case the comment above `resolve_running_port` was written for — another project's
development server on the same port — and it is the one that prints nothing.

Reproduced on 2026-10-02: with `python3 -m http.server 3999` running, `PORT=3999 ./run smoke`
and `PORT=3999 ./run docs` each exit `1` with no output. With nothing on the port, the same
commands print "Nothing is answering on http://localhost:3999."

### Success

- A non-engine server on the port, in a container or not, gets "Port N is answering, but it is
  not this engine", naming the container when there is one, from both scenarios.
- A test holds each case, so the message cannot fall silent again unnoticed.

---

## 2. Cause

```bash
holder=$(docker ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null | grep ":${APP_PORT}->" | cut -f1 | head -1)
```

When no container publishes the port, `grep` matches nothing and exits `1`. The script runs
under `set -euo pipefail`, so the substitution's status is non-zero and the assignment ends the
script before the `die` on the next line. The same happens when Docker is not running at all.
`resolve_running_port`, ten lines above, guards the identical trap with `|| published=""` and a
comment saying why.

---

## 3. Design

The assignment gains the same guard:

```bash
holder=$(docker ps … | grep ":${APP_PORT}->" | cut -f1 | head -1) || holder=""
```

with a comment pointing at the reason, as in `resolve_running_port`. Not finding a container is
an ordinary answer: the message then omits its "— it is …" clause, as it was written to.

Nothing else in `assert_engine_answers` changes, nor anything about how the port is resolved.

---

## 4. Tests

Written first, and failing on `main` for the host-server rows.

`tests/integration/run-port.test.ts` runs `./run <scenario>` with `PORT` set, which makes
`resolve_running_port` use that port without asking Docker. Cases live in a dataset in
`tests/fixtures/datasets/`:

| Case                                    | Scenario | Expected                                                                        |
| --------------------------------------- | -------- | ------------------------------------------------------------------------------- |
| A non-engine HTTP server on the host    | `smoke`  | Exit `1`; "Port N is answering, but it is not this engine."; no container named |
| A non-engine HTTP server on the host    | `docs`   | The same                                                                        |
| A non-engine HTTP server in a container | `smoke`  | Exit `1`; the same message, naming the container                                |
| Nothing listening                       | `smoke`  | Exit `1`; "Nothing is answering on http://localhost:N."                         |

- The host server is a Node HTTP server the test starts on a free port.
- The container is `node:24.18-alpine` running a one-line HTTP server, started through
  Testcontainers with its port published. That image is the Dockerfile's base, so it is present
  wherever the suite has built the engine. This row passes on `main` already; it pins the path
  that works, so a change to the guard cannot break it unnoticed.
- The test lives under `integration/`, not `unit/`, because it starts processes and containers.

---

## 5. Documentation

The fix commit deletes the backlog entry. `README.md`, `docs/architecture.md` and
`docs/conventions.md` already describe the behaviour this restores, so none changes.
