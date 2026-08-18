# Spec 4 — Multitenancy and the key console

Status: **design**, not implemented.

Depends on spec 1 (resources, schedule, availability) and spec 2 (bookings), both implemented.
Formats, error shapes, the technology stack and the testing rules are not repeated here — they
live in [conventions.md](../../conventions.md).

---

## 1. Purpose

Until now the engine has been an internal service with no authentication, and
[app.ts](../../../src/app.ts) says so in the OpenAPI description: _authorization belongs to the
domain layer above it_. This spec makes the engine shareable: several unrelated owners keep
their resources and bookings in one deployment, each reaching only their own, authenticated by
an API key they issue themselves.

### Why now rather than later

For a single owner, tenancy isolates nothing — there is no one to isolate from. It is written
now because retrofitting `tenant_id` costs a migration of every table, every unique constraint
and every index **on live data**. Today those tables are empty or nearly so. The price never
gets lower than it is now.

### The driving case

One owner, two houses rented by the night. Each house is a resource: `slot_duration: P1D`,
`slot_anchor_time: 15:00`, `capacity: 1`, `concurrency_mode: exclusive`, a weekly schedule of
seven rules with null times, and exceptions for blocked dates. House one offers a sauna, house
two a hot tub.

**Neither add-on appears in this spec, and that is the point.** The owner runs their own
backend; the sauna is a row in their table keyed by `booking_id`, exactly as
[architecture.md](../../architecture.md) describes the domain layer. The engine gains no
`metadata`, no `name`, no add-on concept. Design principle #1 survives intact.

The same reasoning removes minimum stay, maximum stay, booking notice and booking horizon from
scope. They are policy, the owner's backend is the only caller, and it can refuse a one-night
booking before the request is made. **This rests on one constraint, recorded here because
breaking it silently re-opens the question: the API key never reaches a browser.** A widget on
the owner's site talks to the owner's backend, which talks to the engine. The day a key ships
to the frontend, every client-enforced policy becomes advisory and these fields have to move
into the engine.

### In scope

- `tenants` and `api_keys` tables
- `tenant_id` on `resources`, `schedule`, `schedule_exceptions`, `bookings`, with composite
  foreign keys making cross-tenant rows unrepresentable
- Key authentication as a `preHandler`, eight `<domain>.<action>` scopes, per-key rate limiting
- Tenant scoping as a required argument of every repository method
- `GET /resources`; `GET /bookings` without a mandatory `customer_id`
- A console — separate entrypoint, bound to loopback, unauthenticated — that creates tenants
  and issues, lists and revokes keys, with a server-rendered UI
- Playwright coverage of that UI

### Out of scope

| Left out                         | Why                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `metadata` / `name` on resources | The owner has a backend. Adding them would weaken principle #1 for no gain                                    |
| Min/max stay, notice, horizon    | Policy; the owner's backend is the only caller and enforces it                                                |
| Console authentication           | The console runs on loopback against a local process. Section 7.1 makes that structural rather than a promise |
| Postgres RLS                     | Section 5.3 records what it would take. `tenant_id` everywhere is what keeps the door open                    |
| Webhooks                         | The owner polls. Revisit at the third tenant                                                                  |
| Atomic multi-resource booking    | Needed only when an add-on gets its own schedule. Section 12 records the shape                                |
| Signup, billing, quotas          | One operator, one machine                                                                                     |
| `pool` concurrency mode          | Still spec 3                                                                                                  |

---

## 2. Data model

### 2.1 `tenants`

| Column     | Type                       | Notes                                  |
| ---------- | -------------------------- | -------------------------------------- |
| id         | uuid, PK                   | `gen_random_uuid()`                    |
| name       | text, NOT NULL             | Human label, shown in the console only |
| is_active  | boolean, default true      | A false tenant's keys are refused      |
| created_at | timestamptz, default now() |                                        |

Names are not unique. Two owners may both call a tenant "Houses", and the id is what matters.

### 2.2 `api_keys`

| Column       | Type                                  | Notes                            |
| ------------ | ------------------------------------- | -------------------------------- |
| id           | uuid, PK                              |                                  |
| tenant_id    | uuid, FK → tenants, ON DELETE CASCADE | Deleting a tenant takes its keys |
| name         | text, NOT NULL                        | "site backend", "staging"        |
| key_prefix   | text, NOT NULL, UNIQUE                | The lookup handle, 8 chars       |
| key_hash     | text, NOT NULL                        | SHA-256 of the secret, hex       |
| scopes       | text[], NOT NULL                      | A set — section 4.4              |
| created_at   | timestamptz, default now()            |                                  |
| last_used_at | timestamptz                           | Written lazily — section 4.6     |
| revoked_at   | timestamptz                           | Soft revoke; the row stays       |

Check constraints: `array_length(scopes, 1) >= 1`, and every element known —
`scopes <@ array['resources.read', 'resources.write', 'schedule.read', 'schedule.write',
'availability.read', 'bookings.read', 'bookings.write', 'bookings.list']::text[]`.

Partial index for the hot path: `create index api_keys_active_prefix_idx on api_keys
(key_prefix) where revoked_at is null`.

### 2.3 `tenant_id` on the four existing tables

`resources`, `schedule`, `schedule_exceptions` and `bookings` each gain
`tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT`.

Denormalised onto children rather than reached through a join to `resources`, for two reasons.
Every scoped query filters on a local column, so the query shapes stay flat and the indexes lead
with the tenant. And a forgotten join is the classic multi-tenant leak — there is no join to
forget.

The usual objection to denormalisation is drift. It is removed at the database level with
composite foreign keys:

```sql
alter table resources add constraint resources_tenant_id_unique unique (tenant_id, id);

alter table schedule            drop constraint schedule_resource_id_fkey;
alter table schedule            add constraint schedule_resource_fk
  foreign key (tenant_id, resource_id) references resources (tenant_id, id) on delete cascade;
-- schedule_exceptions and bookings likewise; bookings keeps ON DELETE RESTRICT,
-- which is what already stops a resource with history from being deleted.
```

A child row whose `tenant_id` disagrees with its resource's has no referent and cannot be
inserted. Drift is not unlikely — it is unrepresentable.

### 2.4 Indexes

`bookings_resource_start_idx` and `bookings_customer_start_idx` gain `tenant_id` as their
leading column. The listing queries in section 6 all filter on the tenant first, so an index
that does not lead with it is only usable after a filter step.

`bookings_customer_start_idx` additionally becomes partial, `where customer_id is not null`.
Section 2.5 makes the column optional, and a tenant that never fills it should not carry an
index entry per booking for a column it does not use.

`bookings_held_until_idx` stays as it is: the sweeper works across all tenants deliberately, and
prefixing it with `tenant_id` would turn one scan into N.

### 2.5 `bookings.customer_id` becomes nullable

The column stays but drops `NOT NULL`, and `customer_id` becomes optional in the create body.

The engine never decides anything by it, but it is not inert either: it is one of the three
fields that define what an idempotency key stands for
([booking.service.ts:269-272](../../../src/modules/bookings/booking.service.ts#L269-L272)), and
it backs `GET /bookings?customer_id=`. That is what separates it from the `metadata` this spec
refused in section 1 — the engine **queries** by this column, indexes it and compares it,
whereas `metadata` could only be stored. Holding a queryable grouping key is engine work;
holding arbitrary payload is not.

For the driving case it earns nothing today: the owner's backend already maps guests to
bookings, and the owner's calendar is a tenant-wide window query with no customer filter at all.
So it is made optional rather than kept mandatory — and optional rather than dropped, because
`NOT NULL` → `NULL` is reversible and `DROP COLUMN` is not. The day the engine serves a caller
with no database of its own, the column is still there.

Consequences, both intended: the idempotency comparison holds — two replays that both omit the
field match, and a replay that supplies one where the original had none is a mismatch and raises
`IdempotencyKeyReusedError`, which is correct, because those are two different bookings. And
`GET /bookings?customer_id=X` simply never returns rows that left it null.

### 2.6 What does not change

`bookings_no_overlap` and `bookings_idempotency_key_unique` are both keyed on `resource_id`,
which is globally unique and — through the composite FK — provably owned by one tenant. Adding
`tenant_id` to either would widen the index for no additional guarantee.

### 2.7 Kysely types

`src/db/schema.ts` gains `TenantsTable` and `ApiKeysTable`, adds `tenant_id: string` to the
four existing interfaces, widens `BookingsTable.customer_id` to `string | null`, and registers
both new tables on `Database`. `scopes` is typed as
`Scope[]` over a union of the eight literals, following the `ConcurrencyMode` precedent: the
same union types each route's `config.scope`, so a scope that does not exist cannot be demanded
by a route or written to a key, and adding one to the union surfaces every place that must
handle it.

---

## 3. Migration `003_tenancy.ts`

Ordered so it is safe against a database that already holds rows:

1. Create `tenants` and `api_keys` with their constraints and indexes.
2. Add `tenant_id` as **nullable** to the four tables.
3. If any of the four holds a row, insert a tenant named `default` and set every null
   `tenant_id` to its id. On an empty database this is a no-op and no tenant is created.
4. `SET NOT NULL` on all four.
5. Add `resources_tenant_id_unique`, drop the three single-column FKs, add the composite ones.
6. Drop and recreate `bookings_resource_start_idx` with `tenant_id` leading, and
   `bookings_customer_start_idx` with `tenant_id` leading and `where customer_id is not null`.
7. `alter table bookings alter column customer_id drop not null`.

`down` reverses in the opposite order, ending with `drop table api_keys, tenants`. Step 7 is the
one whose reversal can legitimately fail: restoring `NOT NULL` is impossible once a booking has
been written without a customer. `down` counts those rows first and raises a message naming the
count and the column rather than inventing a placeholder value to satisfy the constraint —
design principle #8, _reject rather than silently accept_, applies to migrations too. Invented
customer ids would be indistinguishable from real ones forever after.

---

## 4. Authentication

### 4.1 Key format

```
bk_live_<8 chars><43 chars>
        └ prefix ┘└ secret ┘
```

Both parts are drawn from a CSPRNG over `[A-Za-z0-9]`. 43 base62 characters carry roughly 256
bits. The prefix is stored in the clear as the lookup handle; the secret is never stored.

Generation retries on a `key_prefix` unique violation. With 62⁸ ≈ 2.2 × 10¹⁴ prefixes a
collision is vanishingly rare, but "vanishingly rare" is not "impossible" and the retry is three
lines.

### 4.2 Why SHA-256 and not argon2

Password hashes are deliberately slow because human passwords have little entropy and must
survive an offline attack. This secret has 256 bits from a CSPRNG: there is no search to slow
down. A per-request argon2id would add roughly 100 ms to **every** call to the engine to defend
against an attack that cannot succeed either way. A single SHA-256 with a constant-time compare
is the right primitive, and it is what Stripe and GitHub use for the same reason.

Comparison uses `crypto.timingSafeEqual` on the hex digests, never `===`.

### 4.3 The `preHandler`

Registered once in `buildApp`, at the place [app.ts:92](../../../src/app.ts#L92) already
anticipates: _"a future authentication preHandler attaches here without touching any handler"_.
No handler changes.

```
1. read Authorization: Bearer bk_live_…      → missing/malformed → 401 unauthorized
2. split prefix and secret                    → malformed        → 401 unauthorized
3. look up by key_prefix where revoked_at is null
4. timingSafeEqual(sha256(secret), key_hash)  → mismatch         → 401 unauthorized
5. tenant is_active                           → false            → 401 unauthorized
6. key.scopes includes route.scope             → absent           → 403 forbidden_scope
7. request.tenantId = key.tenant_id
```

Every failure before step 6 answers the same `401 unauthorized` with the same body. A caller
learns that the key did not work, never which step rejected it — otherwise the response
distinguishes "no such key" from "wrong secret" and turns prefix enumeration into a probe.

`WWW-Authenticate: Bearer` accompanies every 401.

### 4.4 Scopes are a set of `<domain>.<action>` pairs

| Scope               | Routes                                                     |
| ------------------- | ---------------------------------------------------------- |
| `resources.read`    | `GET /resources`, `GET /resources/:id`                     |
| `resources.write`   | `POST` / `PATCH` / `DELETE /resources`                     |
| `schedule.read`     | `GET …/schedule`, `GET …/exceptions`                       |
| `schedule.write`    | `PUT …/schedule`, `PUT` / `DELETE …/exceptions/:date`      |
| `availability.read` | `GET …/availability`                                       |
| `bookings.read`     | `GET /bookings/:id`                                        |
| `bookings.write`    | `POST /resources/:id/bookings`, all `POST /bookings/:id/*` |
| `bookings.list`     | `GET /resources/:id/bookings`, `GET /bookings`             |

Each route requires exactly one, and the check is membership. No ranking, no implication:
`bookings.write` does not confer `bookings.read`, and no scope confers any other.

**Why a set rather than three nested tiers** (`read` < `booking` < `admin`, which an earlier
draft of this spec argued for). Nested tiers cannot express the case that matters most once the
engine is shared: a partner channel that may create bookings but must not see the owner's
calendar. Under tiers, whatever level permits `POST …/bookings` also permits `GET /bookings`,
because the tier that grants the second is the one that grants the first. The owner's entire
occupancy leaks to anyone allowed to book.

The objection that killed the array in the earlier draft — that a set can express combinations
meaning the same thing, and every check would have to normalise them first — applied to those
tiers, not to sets. These eight are not nested. Each names one capability, `{a}` and `{a, b}`
are different authorities, and there is nothing to normalise.

**Why `bookings.read` and `bookings.list` are separate.** Reading a booking by id requires
already holding its uuid, which only its creator does; that is managing what you created.
Listing returns everything in a window across the tenant; that is the calendar. It is the one
cut in this table that is a judgement call, and it is the cut the partner-channel case is
entirely about.

Actions not split, deliberately: `bookings.write` covers create, confirm, cancel, reschedule,
complete and no-show. `complete` and `no_show` are back-office gestures and a case could be
made for their own scope, but nothing today needs a caller who may cancel and may not mark a
no-show. Splitting later adds a scope without changing any existing one.

**No wildcards.** `bookings.*` would have to be expanded at check time, so the authority of a
stored key would change on the day a new scope is added. Sets are expanded at issue time and
mean the same thing forever.

Adding a domain later — `pool.*` in spec 3 — is a new literal and one migration widening the
check constraint. Existing keys are untouched: they simply do not hold it. Under tiers, a new
endpoint forces a decision about which tier silently gains power over it.

**Why the vocabulary is not a table.** The obvious normalisation is a `scopes` reference table
with an `api_key_scopes` join, so that adding a scope is an `INSERT` rather than a widened
constraint. It is rejected.

A scope exists because a route declares it. A row in a `scopes` table that no route demands is
inert, and a route demanding a scope absent from the table is a startup failure — so the table
would not be the source of truth, the route declarations would be, and the table would be a
second copy kept in step by migrations. That is the same work as widening the constraint, plus a
join on the hottest path in the system: authentication runs on every request, and with `text[]`
it is one index probe returning the scopes inline.

Descriptions for the console's checkboxes are the one thing a table would hold naturally. They
live in code instead, as a `Record<Scope, string>`, where a missing one is a compile error
rather than a null.

A Postgres enum was the third candidate. `ALTER TYPE … ADD VALUE` is instant and the type
enforces validity without a constraint, but a value can never be removed, and the repository
contains no enums: `concurrency_mode` and `status` are both `text` with a check constraint
([002_bookings.ts](../../../src/db/migrations/002_bookings.ts)). A third answer to a question
this codebase has already answered twice is not an improvement.

**What the normalisation instinct is right about.** The eight literals now exist in three
places: the TypeScript union, the check constraint in migration `003`, and the route
declarations. That is a real drift risk, and it is closed by a test rather than by a table —
section 11.2.

The migration hardcodes its list rather than importing the union. A migration is a historical
record of what ran; importing a live constant would make an already-applied migration describe
something different tomorrow.

### 4.5 Which routes are public, and how the scope is declared

**Default deny.** The hook runs on every route, and a route opts out by declaring
`config: { public: true }`. Only three do: `GET /health`, `GET /` (the redirect) and the
`/docs` tree.

The alternative — a list of protected prefixes — fails open: a route added later is unprotected
until someone remembers to list it. Default deny fails closed, matching design principle #8,
_reject rather than silently accept_.

The required scope is declared the same way, `config: { scope: 'bookings.write' }`, typed
against the union of the eight so an unknown one is a compile error, and read in the hook from
`request.routeOptions.config`. A route that declares neither `public` nor `scope` is a startup
error, not a route that quietly admits any key.

`403 forbidden_scope` names the scope it wanted in `details`. That leaks nothing — the caller
already knows which route it called — and turns a misconfigured key from a guessing game into a
one-line fix.

This is why scopes survive even though key issuance itself is unauthenticated: they protect the
data plane, which is exposed, not the console, which is not.

### 4.6 `last_used_at`

Written by the same hook, but guarded:

```sql
update api_keys set last_used_at = now()
where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')
```

At most one write per key per minute, so a read-heavy caller does not turn every `GET` into an
`UPDATE`. The statement is awaited — it is one indexed update against a predicate that usually
matches nothing, and a fire-and-forget promise would be a lost error and a stray query at
shutdown.

### 4.7 Logging and rate limiting

The Fastify logger gains a `redact` list covering `req.headers.authorization`. Without it the
first request logs a live credential in plain text.

`@fastify/rate-limit` is registered with `keyGenerator` returning the api key id, falling back
to the source IP for unauthenticated requests, at `RATE_LIMIT_PER_MINUTE` (default 600). A
tenant cannot exhaust the engine for the others by accident.

---

## 5. Tenant scoping

### 5.1 The rule that carries the guarantee

**Every repository method takes `tenantId` as its first parameter, and it is required.**

Not read from a request-scoped context, not defaulted, not optional. Then "I forgot to scope
this query" is a TypeScript compile error rather than a leak discovered in production. Services
take it the same way and thread it through from `request.tenantId`.

This is the layer that actually does the work. The composite FKs make bad _writes_
unrepresentable; nothing at the database level stops a _read_ that omits the filter, so the type
system is where that is caught.

### 5.2 404, never 403

A resource belonging to another tenant answers `404 not_found`, identical to one that never
existed. Since the tenant filter lives in the `WHERE` clause, the row simply is not found and
this falls out rather than being implemented. A 403 would confirm that the id exists and belongs
to someone else.

### 5.3 What Postgres RLS would add, and why not now

RLS would defend against hand-written SQL that omits the filter — a class the type system cannot
see. It needs `SET LOCAL app.current_tenant` inside a transaction for every statement, a
database role without `BYPASSRLS`, and a policy per table. The obstacle is the pool: reads
currently run outside transactions, so every one of them would have to be wrapped, or the
setting pinned per checked-out connection.

Not now. `tenant_id` on all four tables is precisely the precondition, so turning it on later is
a migration of policies and a change to `src/db/client.ts`, not a redesign.

---

## 6. Data plane API changes

Two additions. Everything else keeps its path, body and response, and gains only the fact that
it now sees one tenant's rows.

```
GET /resources?is_active=
  → 200 [ { id, timezone, slot_duration, slot_anchor_time,
            capacity, concurrency_mode, is_active }, ... ]
```

The owner's backend already knows its resource ids, so this is not how it finds them. It exists
for the console's tenant page and for reconciliation when the caller's records and the engine's
disagree. A bare array, ordered by `created_at`, no pagination: every other listing in the
engine returns a bare array
([booking.schemas.ts](../../../src/modules/bookings/booking.schemas.ts), `BookingListResponse`),
and a tenant's resource count is bounded by how many things it owns in the world. Pagination
arrives when someone has enough resources to want it.

```
GET /bookings?customer_id=&from=&to=&status=
```

`customer_id` becomes optional here as well as in the create body (section 2.5). Today it is
required on this query, and its own description says why —
_"without it the query is bounded only by the date window"_
([booking.schemas.ts:141](../../../src/modules/bookings/booking.schemas.ts#L141)). That
reasoning was sound when any caller could ask for any customer; under a tenant filter the query
is bounded by the tenant **and** the window, which is the same bound every other listing has.
What the requirement cost was the owner's calendar — "everything booked across my houses next
month" is exactly this query and there is currently no way to express it. `from` and `to` stay
required and stay bounded by `MAX_RANGE_DAYS`.

---

## 7. The console

### 7.1 A third entrypoint, bound to loopback

`src/console.ts` joins [server.ts](../../../src/server.ts) and
[worker.ts](../../../src/worker.ts).

|        | `server.ts`         | `console.ts`                    |
| ------ | ------------------- | ------------------------------- |
| Port   | `PORT`, 3000        | `CONSOLE_PORT`, 3001            |
| Host   | `0.0.0.0`           | **`127.0.0.1`, hard-coded**     |
| Auth   | API key             | none                            |
| Serves | resources, bookings | tenants, keys, three HTML pages |

Key issuance is unauthenticated by decision: this is a local operator tool pointed at the
working database. That decision is only safe while the port is unreachable from outside, so the
host is **not configurable**. There is no env var to set wrong. `buildConsoleApp` builds its own
Fastify instance with its own routes; the two share the database, the config loader and the
repositories, and nothing else.

The rejected alternative was `/console/*` routes inside the main app behind a flag. Equal work,
but one mis-set flag exposes key minting to the internet, and the failure is silent.

### 7.2 The one thing loopback does not cover

A page the operator has open in a browser can POST to `127.0.0.1:3001`; the network boundary
does not help, because the request originates inside it.

A `preHandler` on every `POST` and `DELETE` rejects a request whose `Origin` header is present
and is neither `http://127.0.0.1:<CONSOLE_PORT>` nor `http://localhost:<CONSOLE_PORT>` with
`403 forbidden_origin`. A request with **no** `Origin` is allowed: browsers always send it on
form posts, so its absence means a non-browser client such as `curl`, which is a legitimate
caller here.

Ten lines, no `@fastify/csrf-protection`, no token in every form.

### 7.3 Routes

```
GET    /tenants                       list
POST   /tenants          { name }     → 303 → /tenants
GET    /tenants/:id/api-keys          list: name, prefix, scopes, created, last used, revoked
POST   /tenants/:id/api-keys { name, preset | scopes[] }
                                      → 303 → /tenants/:id/api-keys?revealed=<flash>
POST   /api-keys/:id/revoke           → 303 → back to the tenant's keys
```

Revocation is a `POST`, not a `DELETE`: these are HTML forms, and a form cannot issue `DELETE`
without JavaScript. Section 7.7 explains why that matters.

### 7.4 Showing the secret exactly once

Two requirements turn out to be the same requirement:

- The full key is displayed once and never retrievable again.
- Reloading the page after creating a key must not create a second one.

Rendering the secret in the `POST` response satisfies the first and breaks the second — `F5`
re-submits the form. So: **POST, redirect, GET**, with the secret held in a one-shot flash.

`POST` creates the key, puts the secret in an in-process `Map` under a 16-byte random id with a
60-second expiry, and redirects. The `GET` reads the flash **and deletes it**, then renders. A
reload therefore finds nothing and shows the ordinary list, which is not a special case bolted
on to satisfy the rule — it is the rule falling out of the mechanism. Expired entries are swept
on access; no timer.

In-memory is correct here because the console is one process on one machine. If it ever becomes
two, this moves to a table with a TTL — recorded so the reason is not rediscovered.

### 7.5 Pages

Three, server-rendered: **tenants** (list plus a create form), **keys** (list plus an issue
form, with the revealed secret above it when a flash is present), and an **error** page for 404
and 400.

No template engine. Three pages are typed functions returning HTML strings, which is how
[swagger-theme.ts](../../../src/shared/swagger-theme.ts) already handles its CSS, and it keeps
the dependency count at one addition (`@fastify/formbody`, to parse form bodies). All
interpolation goes through a single `escapeHtml` — a tenant named `<script>alert(1)</script>` is
text, and section 11.3 tests exactly that.

Styling follows the existing Swagger UI theme so the console and the documentation do not look
like two products.

### 7.6 Presets, because eight checkboxes are a worse question than four names

Granular scopes buy precision at the cost of asking the operator a question they cannot answer
well. The issue form therefore offers named presets, with a **Custom** option exposing the eight
checkboxes for the case none of them fits:

| Preset          | Expands to                                                              |
| --------------- | ----------------------------------------------------------------------- |
| Widget          | `availability.read`, `resources.read`                                   |
| Site backend    | Widget, plus `bookings.read`, `bookings.write`, `bookings.list`         |
| Partner channel | Widget, plus `bookings.read`, `bookings.write` — **no** `bookings.list` |
| Reporting       | every `.read`, plus `bookings.list`, no writes                          |
| Back office     | all eight                                                               |

**The preset name is never stored.** It is expanded to a set at issue time and only the set is
written. Storing the name would mean that editing a preset later silently changes the authority
of keys already in the field — the same trap as a wildcard, arriving through the UI instead of
through the checker.

Partner channel is the preset that justifies the whole model; it is unrepresentable under nested
tiers.

### 7.7 No client-side JavaScript

The pages are plain forms and links. Not an accessibility gesture — it means the console has no
build step, no bundle, no framework, and no way for a broken script to hide a working server.
The Playwright suite runs a `javaScriptEnabled: false` project to hold that property in place;
if someone later adds a script the console depends on, that project fails.

The single exception is a copy-to-clipboard button on the revealed secret, which degrades to a
selectable `<input readonly>` when scripting is off.

---

## 8. Configuration

| Variable                | Default | Meaning                                                  |
| ----------------------- | ------- | -------------------------------------------------------- |
| `CONSOLE_PORT`          | 3001    | Console port. The host is not configurable — section 7.1 |
| `RATE_LIMIT_PER_MINUTE` | 600     | Requests per key per minute on the data plane            |

Both go through the existing validators in [config.ts](../../../src/config.ts) and into
`.env.example`.

---

## 9. Error codes

| Code               | Status | When                                                      |
| ------------------ | ------ | --------------------------------------------------------- |
| `unauthorized`     | 401    | Missing, malformed, unknown, revoked key; inactive tenant |
| `forbidden_scope`  | 403    | Valid key, insufficient scope                             |
| `forbidden_origin` | 403    | Console write with a foreign `Origin`                     |
| `rate_limited`     | 429    | Per-key limit exceeded                                    |

They join the existing table in [conventions.md](../../conventions.md) and keep the shape
`{ error, message, details? }`.

---

## 10. Code structure

```
src/console.ts                          entrypoint, 127.0.0.1
src/console-app.ts                      buildConsoleApp
src/modules/tenants/
  tenant.repository.ts                  tenants + api_keys
  tenant.service.ts                     create tenant, issue / list / revoke keys
  api-key.ts                            generate, hash, parse, constant-time verify
src/modules/console/
  console.routes.ts                     the five routes
  console.pages.ts                      three pages as functions
  flash.ts                              one-shot secret store
  html.ts                               escapeHtml and layout
src/shared/scopes.ts                    the eight literals, the union, preset expansion
src/shared/auth.ts                      the preHandler, membership check, public-route config
```

Existing modules change in two mechanical ways: every repository method gains a leading
`tenantId`, and every route gains a `config` block naming its scope.

---

## 11. Testing strategy

Three layers, following [conventions.md](../../conventions.md#testing-conventions): unit for
pure logic, integration against a real Postgres, and — new to this spec — browser tests for the
console.

### 11.1 Unit — no database

`api-key.ts`: generated keys match the format; the prefix is 8 characters; two generations
differ; `verify` accepts the real secret and rejects a secret differing in the last character;
`parse` rejects a missing prefix, a wrong `bk_live_` marker, empty halves and a key with extra
separators.

`scopes.ts`: every preset expands to a set drawn entirely from the eight literals; Partner
channel expands **without** `bookings.list` and Site backend **with** it, asserted directly
because that difference is the reason the model exists; every one of the eight is reachable
through at least one preset, so no scope is defined and unissuable.

`escapeHtml` over `<`, `>`, `&`, `"`, `'` and a string containing all of them.

`flash.ts`: put-then-get returns the secret; a second get returns nothing; an entry past its TTL
returns nothing; an unknown id returns nothing.

### 11.2 Integration — real Postgres

The existing suites gain a tenant and a key, which is mostly mechanical. The cases that are new:

- Migration `003` on a database holding rows from spec 1 and spec 2: rows survive, all get the
  `default` tenant, `NOT NULL` holds.
- A booking insert whose `tenant_id` disagrees with its resource's is rejected by the composite
  FK — this is the guarantee of section 2.3 and it must be proven, not assumed.
- Every route: no key → 401; malformed key → 401; revoked key → 401; key of an inactive
  tenant → 401; a key holding every scope **except** the route's → 403 naming the missing one;
  a key holding exactly the route's scope and nothing else → success. Generated over the route
  table, so a route added later without a scope declaration fails the suite.
- `bookings.write` alone reaches `POST …/bookings` and is refused by `GET /bookings` with 403 —
  the partner-channel guarantee of section 4.4, proven rather than asserted.
- **The three copies of the vocabulary agree.** Iterating the TypeScript union, every literal
  inserts successfully into `api_keys.scopes`, and a literal outside it is rejected by the check
  constraint — so a scope added to the code without widening migration `003`, or removed from
  the code and left in the constraint, fails here. Separately, every scope declared by a route
  is a member of the union, which the type system already guarantees, and every member of the
  union is demanded by at least one route — the check that catches a scope defined, permitted
  and enforced by nothing.
- Tenant A's key reading tenant B's resource, schedule, exceptions, availability, booking →
  404 on each, with a body identical to a genuinely absent id.
- `GET /resources` returns only the caller's, ordered by `created_at`, filters by `is_active`.
- `GET /bookings` without `customer_id` returns the tenant's bookings across resources, and
  still rejects a window wider than `MAX_RANGE_DAYS`.
- `POST …/bookings` without `customer_id` succeeds and stores null; the response carries
  `customer_id: null` rather than omitting the field.
- `GET /bookings?customer_id=X` returns rows holding `X` and never rows holding null.
- Idempotency across the nullable column: replaying a key where both the original and the replay
  omit `customer_id`, with the same times, returns the original with 200; replaying a key whose
  original omitted it while the replay supplies one raises `IdempotencyKeyReusedError`, and the
  reverse likewise. This is the comparison at
  [booking.service.ts:269-272](../../../src/modules/bookings/booking.service.ts#L269-L272)
  meeting a value it could not previously hold.
- Migration `003` down against a database holding a booking with a null `customer_id` raises,
  naming the row count, rather than restoring `NOT NULL` with an invented value.
- `last_used_at` is set on first use and not rewritten on an immediately following request.
- The public routes answer without a key; a route declaring neither `public` nor `scope` fails
  at startup.
- The `Authorization` header does not appear in captured log output.

### 11.3 UI — Playwright

`@playwright/test` as its own runner: `playwright.config.ts`, specs in `tests/ui/*.spec.ts`.
Vitest collects `tests/**/*.test.ts`
([vitest.config.ts](../../../vitest.config.ts)), so the `.spec.ts` extension keeps the two
runners apart with no configuration change.

`tests/ui/global-setup.ts` mirrors the vitest one: start a `PostgreSqlContainer`, run
`runMigrations`, then start **both** apps on ephemeral ports — the console under test, and the
data plane, because the most valuable test crosses from one to the other. `workers: 1` and a
truncate of `api_keys, tenants` between tests, for the same reason
[vitest.config.ts](../../../vitest.config.ts) sets `fileParallelism: false`: one database,
shared state.

Projects: `chromium`, and `chromium-nojs` with `javaScriptEnabled: false` running the same specs
minus the clipboard case. Firefox and WebKit are not run — this is a local admin tool for one
operator, and three engines would triple the time for no product risk. `trace: 'on-first-retry'`.

**Tenants**

1. No tenants → the page explains that, rather than rendering an empty list
2. Create → appears in the list, with its id visible
3. Empty name → rejected, form re-rendered with the value and a message
4. Whitespace-only name → rejected
5. Name past the length limit → rejected
6. `<script>alert(1)</script>` as a name → rendered as text, no dialog fires, no script executes
7. Emoji and Cyrillic in a name → round-trip unchanged
8. Two tenants with the same name → both created, distinguishable by id
9. Link into a tenant's keys page works
10. Unknown but well-formed tenant uuid in the URL → 404 page
11. Malformed uuid in the URL → 400 page, not a stack trace
12. Reload after creating → no second tenant (the redirect held)

**Issuing keys**

13. Tenant with no keys → the page says so
14. Issue → the full secret is shown once, starts with `bk_live_`, and its prefix matches the
    list entry
15. **Reload the reveal page → the secret is gone, the list renders normally**
16. Browser Back to the reveal URL → still gone, no resurrection from cache
17. Reload → no second key was created
18. The list never contains the secret — assert on the page's HTML, not just what is visible
19. Each of the five presets can be selected, and the key's stored scopes are exactly its
    expansion — Partner channel without `bookings.list`, Site backend with it
20. Custom exposes all eight checkboxes; an arbitrary subset is stored verbatim
21. Custom with nothing ticked → rejected, no key created
22. A forged POST with `scopes: ['bookings.destroy']` → 400, no key created
23. A forged POST with `scopes: []` → 400, no key created
24. The key list shows a key's scopes, not the preset it was issued from — the name is not
    stored, per section 7.6
25. Empty key name → rejected
26. Two keys in a row → both listed, different prefixes
27. Copy button puts the full secret on the clipboard (chromium project only)
28. **End to end: issue a Site backend key in the UI, then use it against the data plane on its
    own port — a resource created for that tenant is visible, and one belonging to another
    tenant is 404.** This is the test the whole spec exists for
29. **End to end: issue a Partner channel key, book with it successfully, then call
    `GET /bookings` with it and get 403.** The preset's whole purpose, verified through the UI
    that issues it
30. A Widget key issued in the UI is refused by `POST /resources` with 403

**Revocation**

31. Revoke → the row stays, marked revoked, with its `revoked_at`
32. A revoked key against the data plane → 401
33. A revoked key's row offers no second revoke control
34. Revoking an unknown key id → 404 page

**Console hardening**

35. `POST /tenants` with `Origin: https://evil.example` → 403, nothing created
36. `POST /tenants` with no `Origin` → accepted
37. `POST /tenants` with the console's own origin → accepted
38. A `GET` with a foreign `Origin` → unaffected

**Form behaviour and accessibility**

39. Every page renders with `javaScriptEnabled: false` and every form still submits, presets
    included — they are radio buttons and checkboxes, not a scripted widget
40. Every input has an associated `<label>`
41. A form submits by pressing Enter in a text field
42. Tab order reaches every control in visual order
43. Each page has exactly one `h1` and a `<title>` naming the page
44. At 390 px width the document does not scroll horizontally

**Errors**

45. Stopping the database mid-session → the page shows an error, not an unhandled rejection
46. An unknown console path → 404 page

Playwright needs a browser binary, so it stays out of `./run check`, whose failure would
otherwise be a missing download rather than a broken build. It gets `npm run test:ui` and a
`./run test:ui` scenario that checks for the binary and prints the install command when it is
missing — the pattern every other scenario in [run](../../../run) already follows.

---

## 12. Recorded for later

- **Atomic multi-resource booking.** The moment an add-on gets its own schedule — a sauna
  heated 16:00–22:00, booked in two-hour slots — it becomes a resource, and "house plus sauna"
  becomes two bookings that must both succeed or both fail. That needs a `booking_group_id`, an
  endpoint taking an array of positions, and one transaction acquiring resource locks in a
  deterministic order, for the reason
  [booking.repository.ts](../../../src/modules/bookings/booking.repository.ts) already gives
  about lock ordering. Not now, and nothing in this spec blocks it.
- **The key must never reach a browser.** Section 1 explains what breaks if it does. If a
  tenant ever needs a browser-side key, minimum stay, notice and horizon have to move into the
  engine before that key is issued.
- **The console assumes one process.** The flash store in section 7.4 is the only piece of
  state that would need moving.
- **RLS is one migration away**, and section 5.3 says what is in it.
