# No `any` in hand-written test code

**Status:** implemented · **Date:** 2026-10-02

**This is a decision record, not current truth.** It states what was decided on the date above and is not revised as the system changes. For what the engine does today, read [architecture.md](../../architecture.md) and [conventions.md](../../conventions.md) — where they disagree with this document, they are right.

---

## 1. Purpose

Fixes the backlog entry _Three `any`s remain in hand-written test code_. The shared TypeScript
rule allows `any` in one place only, the `Kysely<any>` signature of a migration. Three others
remain:

- `tests/fixtures/transport.ts`, `TransportResponse.json: () => any`
- `tests/fixtures/suites/types.ts`, `Response.json: () => any`
- `tests/integration/migrations.test.ts`, `db.insertInto(table) as any`, under an
  `eslint-disable` comment

The first two let every test read a response field unchecked: a misspelt field compiles, and
fails at run time or passes against `undefined`. Typing them `unknown` was measured on
2026-10-02: 189 compile errors across 15 test files, which is why the entry was not fixed in
passing.

Nothing enforces the rule today, so a fourth `any` would arrive unnoticed.

### Success

- No `any` in a type position in hand-written source, outside the migration signatures.
- A test fails when one is added.
- A response field read in a test is checked against the type the server serialises with.

---

## 2. Decisions

| Question                         | Decided                                                      | Rejected, and why                                                                                                                                                                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| How a test reads a response body | `json<T = unknown>()`, each read naming its type from `src/` | Typed `Api` methods: a response is a success or an error, so every error-path test would narrow a union or move to a separate accessor, and `Api` would know response shapes, which its doc comment rejects. Runtime validation: Fastify already serialises through the same schemas |
| How the rule is enforced         | A unit test that scans source lines                          | A syntax-tree scan: TypeScript 7 is the native compiler and ships no JavaScript API to walk a tree with                                                                                                                                                                              |

---

## 3. Design

### 3.1 The scan

`tests/unit/no-any.test.ts` reads every `.ts` file under `src/`, `tests/`, `scripts/` and
`testing/src/` and reports each line that writes `any` in a type position — `: any`, `as any`,
`=> any`, `<any>`, `any[]` — or suppresses `@typescript-eslint/no-explicit-any`.

Comment lines (trimmed start `//`, `/*` or `*`) and trailing `//` comments are skipped before
matching, so prose such as "any number of processes" is not a finding. The suppression check
reads the raw line, comments included, because a suppression _is_ a comment.

The one permitted occurrence is a dataset row, not a special case in the runner: `Kysely<any>`
in a file under `src/db/migrations/`. The test asserts the findings equal that allowance — no
other line, and no file outside migrations using it.

This is a line scan, not a parse. A false positive — `any` in a type-like position inside a
string — fails the test loudly, which is the safe direction. A miss needs formatting nothing in
this repository uses, such as a type annotation split by a comment.

### 3.2 The migrations test

The `as any` exists because the test inserts into one of three tables chosen by name, and
Kysely cannot type `insertInto` over a union of table names with different columns. It becomes
a map of one typed insert per table:

```ts
const inserts: Record<OwnedChild, (tenantId: string, resourceId: string) => Promise<unknown>> = {
  schedule: (tenant_id, resource_id) =>
    db.insertInto('schedule').values({ tenant_id, resource_id, … }).execute(),
  …
}
```

Each insert is then checked by Kysely against its table, and the `eslint-disable` comment goes.

### 3.3 `json<T = unknown>()`

Both declarations become `json: <T = unknown>() => T`. Both transports already satisfy it:
Fastify's `inject` response and `JSON.parse` both return `any`, which is assignable to `T`.

Each of the 189 reads names its type from `src/` — `BookingResponse`, `BookingListResponse`,
the resource, schedule, exception and availability response types, or `ErrorResponse` on an
error path. A test that deliberately probes for something outside the contract, such as that a
field is absent, reads `json<Record<string, unknown>>()`, which says so.

The type argument is an assertion, not a check: nothing verifies at run time that the body has
that shape. What it buys is that every field a test reads is a field of the type the server
serialises with, so a misspelt or removed field fails to compile.

_As built:_ the reads were typed by the rule above where a status was asserted. A read with
no status asserted — fixture setup such as `(await api.createResource(x)).json()` — takes the
method's success type, because the test already relies on the call succeeding. Reads `any`
used to exempt from `noUncheckedIndexedAccess` use optional chaining (`slots[0]?.available`), so
a missing element fails its assertion. Of the response types, `src/` exports a type beside only
some schemas, so `tests/fixtures/bodies.ts` derives the rest with `Static`.

### 3.4 Not changed

- No production code.
- The direct `app.inject(...).json()` reads, about a hundred of them. That `any` belongs to the
  inject library's type; it is not written in this repository, and the scan does not report it.

---

## 4. Commits

1. The scan test, failing on the three sites — kept with the commit that makes it pass, since a
   commit must leave the suite green. So: the migrations map (§3.2), then the `json<T>()` change
   with its 189 reads and the scan test (§3.1, §3.3) in one commit, because flipping the
   declarations breaks every read until all are typed. That commit deletes the backlog entry.
2. Documents.

---

## 5. Documentation

- `docs/backlog.md`: the entry is deleted by the commit that removes the last `any`.
- `docs/conventions.md`: where it discusses the shared TypeScript rule, a sentence that
  `tests/unit/no-any.test.ts` enforces it.
