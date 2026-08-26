# Test cases

Every behaviour the engine promises, as a case that can be executed start to finish by hand
against a running instance — and a note on which automated test already covers it.

- Rules referenced throughout: [conventions.md](conventions.md)
- What each endpoint promises: [architecture.md](architecture.md)

## How to read a case

Each case is self-contained: it states what must exist beforehand, the exact calls to make,
and what must come back. Cases never depend on each other's leftovers — where setup is
shared, it is repeated as a numbered step rather than assumed.

`ID` is stable. Reference it in bug reports and commit messages.

The **Covered by** column names the automated test that asserts the same thing. Cases marked
**gap** are not automated; they are the ones worth running by hand before a release.

Sections 1 to 7 are the engine's scheduling behaviour, from specs 1 and 2. Section 8 is spec
4 — authentication, scopes, tenant isolation and the console — and is the one section whose
cases need two tenants and several keys to run.

Where the column names a dataset — `resources.test.ts ← acceptedResources` — that dataset is
also replayed against a live engine by `./run smoke`. Adding a row there extends the test
suite and the smoke run at once; neither runner holds a copy of the case.

## Environment

```bash
./run up                              # engine on :3000, console on :3001, schema applied
BASE=http://localhost:3000
```

Every case below `/health` needs a key. Open the console at **http://127.0.0.1:3001**, create
a tenant, issue a key with the **Back office** preset — every scope, which is what a test pass
needs — and copy it; it is shown once.

```bash
KEY=bk_live_...
AUTH="authorization: Bearer $KEY"
```

Without that header the engine answers `401 unauthorized`, whatever the case was testing. A
case that expects some other status and gets a 401 has failed at the setup, not at the
behaviour.

For running a case by hand, the interactive reference at `http://localhost:3000/docs`
(`./run docs`) is usually faster than curl: every endpoint has a **Try it out** button with
the example values pre-filled. The curl forms below stay useful for scripting and for pasting
into a bug report.

A helper used throughout, so cases stay readable:

```bash
mk() { curl -s -X POST $BASE/resources -H "$AUTH" -H 'content-type: application/json' -d "$1" \
       | sed -E 's/.*"id":"([^"]+)".*/\1/'; }
```

Reset between cases with `docker compose down -v && docker compose up -d`, or simply create a
fresh resource per case — every case below does the latter, so a reset is rarely needed.

---

## 1. Health

| ID        | Case                      | Steps                                                                                                    | Expected                                                                                                                                                                                                                                                             | Covered by       |
| --------- | ------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| TC-HLT-01 | Liveness                  | `curl $BASE/health`                                                                                      | `200 {"status":"ok"}`                                                                                                                                                                                                                                                | `health.test.ts` |
| TC-HLT-02 | Repeatable, stateless     | Call `/health` three times                                                                               | `200` each time, identical body                                                                                                                                                                                                                                      | `health.test.ts` |
| TC-HLT-03 | JSON content type         | `curl -i $BASE/health`                                                                                   | `content-type: application/json`                                                                                                                                                                                                                                     | `health.test.ts` |
| TC-HLT-04 | Liveness is not readiness | 1. `docker compose stop db`<br>2. `curl $BASE/health`<br>3. `curl -H "$AUTH" $BASE/resources/<any uuid>` | Step 2 still returns `200 {"status":"ok"}` while step 3 returns `500` — the key lookup is itself a query, so it fails before the handler does. **Verified by hand.** The probe reports that the process is alive, not that the database is reachable — see TC-GAP-03 | **gap**          |

---

## 2. Resources — creation

Chain for every case in this section:

1. `POST /resources` with the body under test
2. Read the status and body
3. Where creation succeeded, `GET /resources/:id` and confirm the stored state matches

### Accepted

| ID         | Case                      | Body (differences from base)                                                         | Expected                                                                                                                          | Covered by                                |
| ---------- | ------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| TC-RES-C01 | Minimal intraday resource | `{"timezone":"Europe/Warsaw","slot_duration":"PT1H","concurrency_mode":"exclusive"}` | `201`; `capacity: 1`, `slot_anchor_time: "00:00"`, `is_active: true`                                                              | `resources.test.ts` ← `acceptedResources` |
| TC-RES-C02 | Day-based with anchor     | `slot_duration: "P1D"`, `slot_anchor_time: "14:00"`                                  | `201`, both echoed back                                                                                                           | same                                      |
| TC-RES-C03 | Day-based, default anchor | `slot_duration: "P1D"`                                                               | `201`, `slot_anchor_time: "00:00"`                                                                                                | same                                      |
| TC-RES-C04 | Weekly slot               | `slot_duration: "P7D"`, `slot_anchor_time: "16:00"`                                  | `201`                                                                                                                             | same                                      |
| TC-RES-C05 | Shared with capacity      | `concurrency_mode: "shared"`, `capacity: 12`                                         | `201`, `capacity: 12`                                                                                                             | same                                      |
| TC-RES-C06 | Shared with capacity 1    | `concurrency_mode: "shared"`, `capacity: 1`                                          | `201` — capacity 1 is legal for shared                                                                                            | same                                      |
| TC-RES-C07 | Half-hour-offset zone     | `timezone: "Asia/Kolkata"`                                                           | `201`                                                                                                                             | same                                      |
| TC-RES-C08 | UTC                       | `timezone: "UTC"`                                                                    | `201`                                                                                                                             | same                                      |
| TC-RES-C09 | Southern hemisphere       | `timezone: "Pacific/Auckland"`                                                       | `201`                                                                                                                             | same                                      |
| TC-RES-C10 | Legacy named zone         | `timezone: "CET"`                                                                    | `201` — named zones with DST rules are fine                                                                                       | same                                      |
| TC-RES-C11 | Shortest slot             | `slot_duration: "PT1M"`                                                              | `201`                                                                                                                             | same                                      |
| TC-RES-C12 | Longest intraday slot     | `slot_duration: "PT23H59M"`                                                          | `201`                                                                                                                             | same                                      |
| TC-RES-C13 | Anchor at end of day      | `slot_duration: "P1D"`, `slot_anchor_time: "23:59"`                                  | `201`                                                                                                                             | same                                      |
| TC-RES-C14 | Redundant zero component  | `slot_duration: "PT0H30M"`                                                           | `201`, **echoed back as `PT30M`** — durations are canonicalised                                                                   | same                                      |
| TC-RES-C15 | Ids are unique            | Create two identical resources                                                       | Two different `id` values, both valid UUIDs                                                                                       | `resources.test.ts`                       |
| TC-RES-C16 | No internal columns leak  | Create, inspect the response keys                                                    | Exactly `id, timezone, slot_duration, slot_anchor_time, capacity, concurrency_mode, is_active` — no `created_at`, no `updated_at` | `resources.test.ts`                       |

### Rejected

All return `400` with the uniform error body.

| ID         | Case                        | Body difference                                       | `error`                                                       | Covered by                                |
| ---------- | --------------------------- | ----------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------- |
| TC-RES-R01 | Unknown zone                | `timezone: "Mars/Olympus"`                            | `validation_error`                                            | `resources.test.ts` ← `rejectedResources` |
| TC-RES-R02 | Fixed offset as zone        | `timezone: "+02:00"`                                  | `validation_error` — an offset has no DST rules               | same                                      |
| TC-RES-R03 | Negative fixed offset       | `timezone: "-05:00"`                                  | `validation_error`                                            | same                                      |
| TC-RES-R04 | Compact fixed offset        | `timezone: "+0200"`                                   | `validation_error`                                            | same                                      |
| TC-RES-R05 | Empty zone                  | `timezone: ""`                                        | `validation_error`                                            | same                                      |
| TC-RES-R06 | 24 hours written as time    | `slot_duration: "PT24H"`                              | `validation_error` — a fixed 24 hours is not a calendar day   | same                                      |
| TC-RES-R07 | Months                      | `slot_duration: "P1M"`                                | `validation_error`                                            | same                                      |
| TC-RES-R08 | Days mixed with hours       | `slot_duration: "P1DT2H"`                             | `validation_error`                                            | same                                      |
| TC-RES-R09 | Zero-length slot            | `slot_duration: "PT0M"`                               | `validation_error`                                            | same                                      |
| TC-RES-R10 | Beyond the ceiling          | `slot_duration: "P367D"`                              | `validation_error`                                            | same                                      |
| TC-RES-R11 | Exclusive with capacity > 1 | `concurrency_mode: "exclusive"`, `capacity: 3`        | `validation_error`                                            | same                                      |
| TC-RES-R12 | Zero capacity               | `capacity: 0`                                         | `validation_error`                                            | same                                      |
| TC-RES-R13 | Negative capacity           | `capacity: -1`                                        | `validation_error`                                            | same                                      |
| TC-RES-R14 | Fractional capacity         | `capacity: 2.5`                                       | `validation_error`                                            | same                                      |
| TC-RES-R15 | Pool mode                   | `concurrency_mode: "pool"`                            | `unsupported_concurrency_mode` — deferred to spec 3           | same                                      |
| TC-RES-R16 | Unknown mode                | `concurrency_mode: "whatever"`                        | `validation_error`                                            | same                                      |
| TC-RES-R17 | Anchor on intraday resource | `slot_duration: "PT30M"`, `slot_anchor_time: "14:00"` | `validation_error` — the anchor would be silently ignored     | same                                      |
| TC-RES-R18 | Anchor with seconds         | `slot_anchor_time: "14:00:00"`                        | `validation_error`                                            | same                                      |
| TC-RES-R19 | Anchor past end of day      | `slot_anchor_time: "24:00"`                           | `validation_error`                                            | same                                      |
| TC-RES-R20 | Unknown field               | `colour: "blue"`                                      | `validation_error` — unknown fields are rejected, not ignored | same                                      |
| TC-RES-R21 | Missing `timezone`          | field omitted                                         | `validation_error`                                            | `resources.test.ts`                       |
| TC-RES-R22 | Missing `slot_duration`     | field omitted                                         | `validation_error`                                            | same                                      |
| TC-RES-R23 | Missing `concurrency_mode`  | field omitted                                         | `validation_error`                                            | same                                      |

---

## 3. Resources — read, update, delete

### Read

| ID         | Case         | Steps                                                     | Expected                                | Covered by          |
| ---------- | ------------ | --------------------------------------------------------- | --------------------------------------- | ------------------- |
| TC-RES-G01 | Round-trip   | 1. Create a day-based resource<br>2. `GET /resources/:id` | Body identical to the creation response | `resources.test.ts` |
| TC-RES-G02 | Unknown id   | `GET /resources/<random uuid>`                            | `404 not_found`                         | same                |
| TC-RES-G03 | Malformed id | `GET /resources/not-a-uuid`                               | `400 validation_error`                  | same                |

### Update

Chain: create → patch → `GET` to confirm the change persisted.

| ID         | Case                             | Patch                                                                        | Expected                                                                 | Covered by                              |
| ---------- | -------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------- |
| TC-RES-U01 | Change duration                  | `{"slot_duration":"PT30M"}`                                                  | `200`, and the `GET` shows `PT30M`                                       | `resources.test.ts` ← `acceptedPatches` |
| TC-RES-U02 | Deactivate                       | `{"is_active":false}`                                                        | `200`, `is_active: false`                                                | same                                    |
| TC-RES-U03 | Reactivate                       | `{"is_active":true}`                                                         | `200`, `is_active: true`                                                 | same                                    |
| TC-RES-U04 | Raise shared capacity            | on a shared resource, `{"capacity":20}`                                      | `200`                                                                    | same                                    |
| TC-RES-U05 | Move the anchor                  | on a day-based resource, `{"slot_anchor_time":"15:00"}`                      | `200`                                                                    | same                                    |
| TC-RES-U06 | Intraday → day-based             | `{"slot_duration":"P1D","slot_anchor_time":"14:00"}`                         | `200`, both applied                                                      | same                                    |
| TC-RES-U07 | Empty patch                      | `{}`                                                                         | `200`, nothing changes                                                   | same                                    |
| TC-RES-U08 | Several fields at once           | `{"slot_duration":"PT15M","is_active":false}`                                | `200`, both applied                                                      | same                                    |
| TC-RES-U09 | Change timezone                  | `{"timezone":"Europe/Berlin"}`                                               | `400 validation_error` — immutable                                       | `resources.test.ts` ← `rejectedPatches` |
| TC-RES-U10 | Change concurrency mode          | `{"concurrency_mode":"shared"}`                                              | `400 validation_error` — immutable                                       | same                                    |
| TC-RES-U11 | Change id                        | `{"id":"anything"}`                                                          | `400 validation_error`                                                   | same                                    |
| TC-RES-U12 | Unknown field                    | `{"colour":"blue"}`                                                          | `400 validation_error`                                                   | same                                    |
| TC-RES-U13 | Duration invalidating the anchor | on a resource with `P1D`/`14:00`, `{"slot_duration":"PT1H"}`                 | `400 validation_error` — the resulting state is validated, not the patch | same                                    |
| TC-RES-U14 | Anchor on intraday               | `{"slot_anchor_time":"14:00"}`                                               | `400 validation_error`                                                   | same                                    |
| TC-RES-U15 | Capacity > 1 on exclusive        | `{"capacity":5}`                                                             | `400 validation_error`                                                   | same                                    |
| TC-RES-U16 | Rejected patch changes nothing   | 1. `GET` and record the body<br>2. Send any rejected patch<br>3. `GET` again | Bodies identical                                                         | `resources.test.ts`                     |
| TC-RES-U17 | Unknown id                       | patch a random uuid                                                          | `404 not_found`                                                          | same                                    |

### Delete

| ID         | Case          | Steps                                                                                                                   | Expected                                                       | Covered by          |
| ---------- | ------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------- |
| TC-RES-D01 | Delete        | 1. Create<br>2. `DELETE`<br>3. `GET`                                                                                    | `204`, then `404`                                              | `resources.test.ts` |
| TC-RES-D02 | Cascade       | 1. Create<br>2. Add a schedule and an exception<br>3. `DELETE` the resource<br>4. `GET` the schedule and the exceptions | `204`, then `404` for both — children are gone with the parent | same                |
| TC-RES-D03 | Isolation     | 1. Create two resources<br>2. Delete one<br>3. `GET` the other                                                          | `200` — untouched                                              | same                |
| TC-RES-D04 | Unknown id    | delete a random uuid                                                                                                    | `404`                                                          | same                |
| TC-RES-D05 | Double delete | delete the same id twice                                                                                                | `204`, then `404`                                              | same                |

---

## 4. Schedule

Chain: create a resource → `PUT` the schedule → `GET` to confirm.

### Accepted

| ID         | Case                          | Rules                                         | Expected                                  | Covered by                               |
| ---------- | ----------------------------- | --------------------------------------------- | ----------------------------------------- | ---------------------------------------- |
| TC-SCH-A01 | Empty schedule                | `[]`                                          | `200 []` — means "never available"        | `schedule.test.ts` ← `acceptedSchedules` |
| TC-SCH-A02 | One window                    | `[{day_of_week:0,start:"09:00",end:"17:00"}]` | `200`, one rule                           | same                                     |
| TC-SCH-A03 | Every weekday                 | the same window for days 0–6                  | `200`, seven rules                        | same                                     |
| TC-SCH-A04 | Two disjoint windows on a day | `09:00–12:00` and `13:00–17:00` on day 0      | `200`, two rules                          | same                                     |
| TC-SCH-A05 | Touching windows              | `09:00–12:00` and `12:00–17:00` on day 0      | `200` — touching is not overlapping       | same                                     |
| TC-SCH-A06 | Three windows on a day        | 08–10, 11–13, 14–16                           | `200`                                     | same                                     |
| TC-SCH-A07 | Out-of-order submission       | `14:00–17:00` before `09:00–12:00`            | `200`; `GET` returns them sorted by start | same                                     |
| TC-SCH-A08 | Same window, different days   | day 0 and day 1                               | `200`                                     | same                                     |
| TC-SCH-A09 | Almost the whole day          | `00:00–23:59`                                 | `200`                                     | same                                     |
| TC-SCH-A10 | One-minute window             | `09:00–09:01`                                 | `200`                                     | same                                     |
| TC-SCH-A11 | Day-based, one whole day      | `[{day_of_week:0,start:null,end:null}]`       | `200`                                     | same                                     |
| TC-SCH-A12 | Day-based, every day          | null-time rules for days 0–6                  | `200`                                     | same                                     |

### Rejected

| ID         | Case                             | Rules                                      | `error`                                                    | Covered by                               |
| ---------- | -------------------------------- | ------------------------------------------ | ---------------------------------------------------------- | ---------------------------------------- |
| TC-SCH-R01 | Overlap                          | `09:00–13:00` and `12:00–17:00` on one day | `schedule_overlap`                                         | `schedule.test.ts` ← `rejectedSchedules` |
| TC-SCH-R02 | Containment                      | `09:00–18:00` and `12:00–13:00`            | `schedule_overlap`                                         | same                                     |
| TC-SCH-R03 | Duplicate window                 | the same window twice on one day           | `schedule_overlap`                                         | same                                     |
| TC-SCH-R04 | Overlap hidden among valid days  | valid Monday, overlapping Friday           | `schedule_overlap` — every weekday is validated            | same                                     |
| TC-SCH-R05 | Null times on intraday resource  | `start:null,end:null`                      | `schedule_shape_mismatch`                                  | same                                     |
| TC-SCH-R06 | Set times on day-based resource  | `09:00–17:00`                              | `schedule_shape_mismatch`                                  | same                                     |
| TC-SCH-R07 | Two whole-day rules on one day   | two null-time rules, day 0                 | `schedule_shape_mismatch`                                  | same                                     |
| TC-SCH-R08 | End before start                 | `17:00–09:00`                              | `validation_error`                                         | same                                     |
| TC-SCH-R09 | Window crossing midnight         | `22:00–02:00`                              | `validation_error` — express as two rules on adjacent days | same                                     |
| TC-SCH-R10 | Zero-length window               | `09:00–09:00`                              | `validation_error`                                         | same                                     |
| TC-SCH-R11 | Only start set                   | `start:"09:00",end:null`                   | `validation_error`                                         | same                                     |
| TC-SCH-R12 | Only end set                     | `start:null,end:"17:00"`                   | `validation_error`                                         | same                                     |
| TC-SCH-R13 | Weekday below range              | `day_of_week: -1`                          | `validation_error`                                         | `malformedSchedules`                     |
| TC-SCH-R14 | Weekday above range              | `day_of_week: 7`                           | `validation_error`                                         | same                                     |
| TC-SCH-R15 | Fractional weekday               | `day_of_week: 1.5`                         | `validation_error`                                         | same                                     |
| TC-SCH-R16 | Weekday as a string              | `day_of_week: "monday"`                    | `validation_error`                                         | same                                     |
| TC-SCH-R17 | Missing weekday                  | field omitted                              | `validation_error`                                         | same                                     |
| TC-SCH-R18 | Time with seconds                | `"09:00:00"`                               | `validation_error`                                         | same                                     |
| TC-SCH-R19 | Hour past end of day             | `"24:00"`                                  | `validation_error`                                         | same                                     |
| TC-SCH-R20 | Minute past sixty                | `"09:60"`                                  | `validation_error`                                         | same                                     |
| TC-SCH-R21 | Unknown field on a rule          | extra `note`                               | `validation_error`                                         | same                                     |
| TC-SCH-R22 | Body is an object, not a list    | `{...}` as JSON                            | `validation_error`                                         | `nonArrayScheduleBodies`                 |
| TC-SCH-R23 | Body is a string / number / null | as JSON                                    | `validation_error`                                         | same                                     |
| TC-SCH-R24 | Wrong content type               | `text/plain` body                          | a 4xx in the uniform shape, never `internal_error`         | `schedule.test.ts`                       |

### Behaviour

| ID         | Case                        | Steps                                                                        | Expected                                                            | Covered by         |
| ---------- | --------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------ |
| TC-SCH-B01 | Replacement, not addition   | 1. `PUT` a Monday window<br>2. `PUT` a Thursday window<br>3. `GET`           | One rule, Thursday. The first is gone                               | `schedule.test.ts` |
| TC-SCH-B02 | Clearing                    | 1. `PUT` three windows<br>2. `PUT []`<br>3. `GET`                            | `[]`                                                                | same               |
| TC-SCH-B03 | Atomicity                   | 1. `PUT` a valid schedule<br>2. `PUT` an overlapping one → `400`<br>3. `GET` | The original schedule, intact. A rejected submission writes nothing | same               |
| TC-SCH-B04 | Fresh ids on replacement    | `PUT` the same rules twice, comparing `id`                                   | Different ids — rows are replaced, not updated                      | same               |
| TC-SCH-B05 | Isolation between resources | Set a schedule on A, read B                                                  | B still `[]`                                                        | same               |
| TC-SCH-B06 | Ordering                    | Submit Wed 14:00, Mon 14:00, Mon 09:00                                       | `GET` returns Mon 09:00, Mon 14:00, Wed 14:00                       | same               |
| TC-SCH-B07 | Time format                 | Store `09:00`, read back                                                     | `"09:00"`, not `"09:00:00"`                                         | same               |
| TC-SCH-B08 | Null times survive          | Day-based schedule, read back                                                | `start_time` and `end_time` both `null`                             | same               |
| TC-SCH-B09 | Unknown resource            | `PUT`/`GET` on a random uuid                                                 | `404`                                                               | same               |

---

## 5. Schedule exceptions

Chain: create a resource → `PUT` an exception for a date → `GET` the range → optionally `DELETE`.

| ID         | Case                                | Steps                                                                            | Expected                                                                   | Covered by                                  |
| ---------- | ----------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------- |
| TC-EXC-A01 | Altered hours                       | `PUT .../exceptions/2026-07-20` with `{"start_time":"10:00","end_time":"14:00"}` | `200`, echoed back with the date                                           | `exceptions.test.ts` ← `acceptedExceptions` |
| TC-EXC-A02 | Whole-day window                    | `00:00–23:59`                                                                    | `200`                                                                      | same                                        |
| TC-EXC-A03 | One-minute window                   | `09:00–09:01`                                                                    | `200`                                                                      | same                                        |
| TC-EXC-A04 | Day off, intraday resource          | `{"start_time":null,"end_time":null}`                                            | `200`                                                                      | same                                        |
| TC-EXC-A05 | Day off, day-based resource         | same body                                                                        | `200` — a day off is expressible for any resource                          | same                                        |
| TC-EXC-R01 | Altered hours on day-based resource | `10:00–14:00`                                                                    | `400 schedule_shape_mismatch` — no hours to alter                          | `rejectedExceptions`                        |
| TC-EXC-R02 | Only start set                      | `{"start_time":"10:00","end_time":null}`                                         | `400 validation_error`                                                     | same                                        |
| TC-EXC-R03 | Only end set                        | mirror of the above                                                              | `400 validation_error`                                                     | same                                        |
| TC-EXC-R04 | End before start                    | `17:00–10:00`                                                                    | `400 validation_error`                                                     | same                                        |
| TC-EXC-R05 | Crossing midnight                   | `22:00–02:00`                                                                    | `400 validation_error`                                                     | same                                        |
| TC-EXC-R06 | Zero-length                         | `10:00–10:00`                                                                    | `400 validation_error`                                                     | same                                        |
| TC-EXC-R07 | Time with seconds                   | `"10:00:00"`                                                                     | `400 validation_error`                                                     | same                                        |
| TC-EXC-R08 | Hour past end of day                | `"24:00"`                                                                        | `400 validation_error`                                                     | same                                        |
| TC-EXC-R09 | Missing end time                    | field omitted                                                                    | `400 validation_error`                                                     | same                                        |
| TC-EXC-R10 | Unknown field                       | extra `reason`                                                                   | `400 validation_error`                                                     | same                                        |
| TC-EXC-R11 | Malformed date in path              | `20-07-2026`, `2026-7-20`, `20260720`, `tomorrow`, `2026-07`                     | `400`                                                                      | `malformedExceptionDates`                   |
| TC-EXC-R12 | Impossible date                     | `2026-02-30`, `2026-13-01`, `2027-02-29`                                         | `4xx`                                                                      | `impossibleExceptionDates`                  |
| TC-EXC-R13 | Rejected write stores nothing       | Any rejected `PUT`, then list the range                                          | `[]`                                                                       | `exceptions.test.ts`                        |
| TC-EXC-B01 | Idempotent overwrite                | `PUT` `10:00–14:00`, then `11:00–15:00`, then list                               | Second body wins; exactly one row                                          | same                                        |
| TC-EXC-B02 | Hours ↔ day off                     | `PUT` hours → `PUT` day off → `PUT` hours again                                  | Each state replaces the last                                               | same                                        |
| TC-EXC-B03 | Isolation between resources         | Exception on A, list B                                                           | `[]`                                                                       | same                                        |
| TC-EXC-B04 | No timezone drift on the date       | On a `Pacific/Auckland` resource, `PUT .../2026-01-01`                           | Stored and returned as `2026-01-01` — a `Date`-based parser would shift it | same                                        |
| TC-EXC-B05 | Half-open listing                   | Exceptions on 18th–21st, list `from=19&to=21`                                    | 19th and 20th only                                                         | same                                        |
| TC-EXC-B06 | Ordering                            | Insert out of order, list                                                        | Ascending by date                                                          | same                                        |
| TC-EXC-B07 | Empty range                         | List a range with nothing in it                                                  | `[]`                                                                       | same                                        |
| TC-EXC-B08 | Inverted range                      | `from=21&to=19`                                                                  | `400 invalid_range`                                                        | same                                        |
| TC-EXC-B09 | Equal bounds                        | `from=20&to=20`                                                                  | `400 invalid_range`                                                        | same                                        |
| TC-EXC-B10 | Over-wide range                     | `from=2026-01-01&to=2028-01-01`                                                  | `400 invalid_range`                                                        | same                                        |
| TC-EXC-B11 | Missing bounds                      | omit `from`, `to`, or both                                                       | `400`                                                                      | same                                        |
| TC-EXC-D01 | Delete                              | `PUT`, then `DELETE`, then list                                                  | `204`, then `[]`                                                           | same                                        |
| TC-EXC-D02 | Idempotent delete                   | `DELETE` a date with no exception, twice                                         | `204` both times                                                           | same                                        |
| TC-EXC-D03 | Deletes only the named date         | Exceptions on 19th and 20th, delete the 20th                                     | Only the 19th remains                                                      | same                                        |
| TC-EXC-D04 | Unknown resource                    | Any exception call on a random uuid                                              | `404`                                                                      | same                                        |

---

## 6. Availability

Full chain for every case: create the resource → `PUT` the schedule → optionally `PUT`
exceptions → optionally deactivate → `GET /resources/:id/availability?from=&to=`.

`2026-07-20` is a Monday, so it is `day_of_week: 0`.

### Intraday slicing

| ID         | Case                       | Setup                         | Query       | Expected                                             | Covered by                                       |
| ---------- | -------------------------- | ----------------------------- | ----------- | ---------------------------------------------------- | ------------------------------------------------ |
| TC-AVL-I01 | Whole slots                | `PT1H`, Mon 09:00–12:00       | 20th → 21st | 3 slots: 09–10, 10–11, 11–12, all `+02:00`           | `availability.test.ts` ← `availabilityScenarios` |
| TC-AVL-I02 | Remainder dropped          | `PT1H30M`, Mon 09:00–13:00    | 20th → 21st | 2 slots; the last 60 minutes are unusable and vanish | same                                             |
| TC-AVL-I03 | Window shorter than a slot | `PT1H`, Mon 09:00–09:30       | 20th → 21st | `[]`                                                 | same                                             |
| TC-AVL-I04 | Window exactly one slot    | `PT1H`, Mon 09:00–10:00       | 20th → 21st | 1 slot                                               | same                                             |
| TC-AVL-I05 | Two windows, two grids     | `PT1H`, Mon 09–11 and 14–16   | 20th → 21st | 4 slots; each window starts its own grid             | same                                             |
| TC-AVL-I06 | Grid offset from the hour  | `PT30M`, Mon 09:15–10:15      | 20th → 21st | 09:15–09:45, 09:45–10:15                             | same                                             |
| TC-AVL-I07 | Full week                  | `PT1H`, every day 09:00–10:00 | 20th → 27th | 7 slots, one per day                                 | same                                             |
| TC-AVL-I08 | Empty schedule             | `PT1H`, `[]`                  | 20th → 27th | `[]`                                                 | same                                             |

### Weekday mapping

| ID         | Case        | Setup                                      | Expected                                       | Covered by             |
| ---------- | ----------- | ------------------------------------------ | ---------------------------------------------- | ---------------------- |
| TC-AVL-W01 | Monday is 0 | window on `day_of_week: 0`, query the week | The slot lands on **2026-07-20**               | `availability.test.ts` |
| TC-AVL-W02 | Sunday is 6 | window on `day_of_week: 6`, query the week | The slot lands on **2026-07-26**, not the 19th | same                   |

### Day-based resources

| ID         | Case          | Setup                              | Query       | Expected                             | Covered by             |
| ---------- | ------------- | ---------------------------------- | ----------- | ------------------------------------ | ---------------------- |
| TC-AVL-D01 | Hotel night   | `P1D`, anchor `14:00`, every day   | 20th → 23rd | 3 slots, each 14:00 → 14:00 next day | `availability.test.ts` |
| TC-AVL-D02 | Calendar days | `P1D`, default anchor              | 20th → 22nd | 2 slots, midnight to midnight        | same                   |
| TC-AVL-D03 | Weekly slot   | `P7D`, anchor `16:00`, Monday only | 20th → 21st | 1 slot, 20th 16:00 → 27th 16:00      | same                   |
| TC-AVL-D04 | Weekend-only  | `P1D`, days 5 and 6                | 20th → 27th | 2 slots, Saturday and Sunday         | same                   |

### Exceptions

| ID         | Case                                | Setup                                               | Expected                                                     | Covered by             |
| ---------- | ----------------------------------- | --------------------------------------------------- | ------------------------------------------------------------ | ---------------------- |
| TC-AVL-E01 | Exception replaces the schedule     | Mon 09:00–12:00, exception 20th `15:00–17:00`       | 2 slots at 15:00 and 16:00. The 09–12 window does not appear | `availability.test.ts` |
| TC-AVL-E02 | Never merges                        | Two Monday windows, exception with one window       | Only the exception's window produces slots                   | same                   |
| TC-AVL-E03 | Day off                             | Mon 09:00–12:00, day off on the 20th                | `[]`                                                         | same                   |
| TC-AVL-E04 | Day off is local to its date        | Windows Mon and Tue, day off Monday                 | Only Tuesday's slot                                          | same                   |
| TC-AVL-E05 | Exception where no schedule exists  | Empty schedule, exception `09:00–11:00` on the 20th | 2 slots — an exception can add availability                  | same                   |
| TC-AVL-E06 | Exception outside the range ignored | Day off on the 27th, query 20th → 22nd              | Both days' slots present                                     | same                   |
| TC-AVL-E07 | Day off on a day-based resource     | `P1D` anchor 14:00, day off on the 21st             | Slots for the 20th and 22nd, none for the 21st               | same                   |

### Daylight saving

Transition dates come from the tz database, not from memory — see
`tests/fixtures/data/dst-transitions.json`.

| ID         | Case                             | Setup                            | Query              | Expected                                                                                               | Covered by                                       |
| ---------- | -------------------------------- | -------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| TC-AVL-T01 | Spring forward, day-based        | Warsaw, `P1D`, every day         | 2026-03-28 → 03-31 | 3 slots. The 29th runs `00:00+01:00 → 00:00+02:00` — 23 real hours                                     | `availability.test.ts`, `slot-generator.test.ts` |
| TC-AVL-T02 | Fall back, day-based             | Warsaw, `P1D`, every day         | 2026-10-24 → 10-27 | The 25th spans 25 real hours                                                                           | same                                             |
| TC-AVL-T03 | Anchor holds across a transition | Warsaw, `P1D`, anchor `14:00`    | 03-28 → 03-31      | Every slot starts at 14:00 **local**, and consecutive slots stay contiguous despite one being 23 hours | same                                             |
| TC-AVL-T04 | Intraday grid does not drift     | Warsaw, `PT1H`, 09:00–12:00      | 2026-03-29         | 09:00, 10:00, 11:00 local — no shift                                                                   | same                                             |
| TC-AVL-T05 | Different transition date        | New York, `PT1H`, 09:00–11:00    | 2026-03-08         | Slots at `-04:00`; the US transitions three weeks before Europe                                        | same                                             |
| TC-AVL-T06 | Southern hemisphere              | Auckland, `P1D`                  | 2026-04-04 → 04-07 | Falls back in **April**; the 5th spans 25 hours                                                        | same                                             |
| TC-AVL-T07 | Half-hour offsets                | Adelaide, `P1D`                  | 2026-10-03 → 10-06 | Offsets move `+09:30` → `+10:30`                                                                       | same                                             |
| TC-AVL-T08 | Zone without DST                 | Kolkata, `PT1H`, Mon 09:00–11:00 | 20th → 21st        | `+05:30` all year                                                                                      | same                                             |
| TC-AVL-T09 | UTC rendering                    | UTC resource                     | 20th → 21st        | Timestamps end in `Z`, not `+00:00`                                                                    | same                                             |

### Range and state

| ID         | Case                            | Steps                                                            | Expected                                                                                               | Covered by             |
| ---------- | ------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------- |
| TC-AVL-S01 | Half-open range                 | Windows Mon and Tue, query 20th → 21st                           | Only Monday's slot; nothing lands on the `to` date                                                     | `availability.test.ts` |
| TC-AVL-S02 | Inactive resource               | 1. Schedule a resource<br>2. `PATCH is_active:false`<br>3. Query | `200 {"slots":[]}` — not a 404: it exists but is not bookable                                          | same                   |
| TC-AVL-S03 | Reactivation                    | Continue TC-AVL-S02 with `is_active:true`                        | Slots return                                                                                           | same                   |
| TC-AVL-S04 | Schedule change is immediate    | Query, change the schedule, query again                          | Second result reflects the new schedule; no caching                                                    | same                   |
| TC-AVL-S05 | Idempotent                      | Query the same range twice                                       | Identical bodies                                                                                       | same                   |
| TC-AVL-S06 | Resources are independent       | Schedule A, query B                                              | `[]`                                                                                                   | same                   |
| TC-AVL-S07 | Maximum width range             | `P1D` every day, query a full year                               | `200`, 365 slots                                                                                       | same                   |
| TC-AVL-S08 | Inverted range                  | `from=21&to=20`                                                  | `400 invalid_range`                                                                                    | same                   |
| TC-AVL-S09 | Equal bounds                    | `from=20&to=20`                                                  | `400 invalid_range`                                                                                    | same                   |
| TC-AVL-S10 | Over-wide range                 | two years                                                        | `400 invalid_range`                                                                                    | same                   |
| TC-AVL-S11 | Malformed date                  | `20-07-2026`, `tomorrow`, `2026-07`                              | `400`                                                                                                  | same                   |
| TC-AVL-S12 | Unknown resource                | random uuid                                                      | `404 not_found`                                                                                        | same                   |
| TC-AVL-S13 | `available` with nothing booked | Any successful query on a resource with no bookings              | Every slot has `available: true`. What makes it false is in [§7.9](#79-availability-reflects-bookings) | same                   |
| TC-AVL-S14 | Ordering and well-formedness    | Any successful query                                             | Slots ascending by `start`; every `end` strictly after its `start`                                     | same                   |

---

## 7. Bookings

Base setup for most cases: an hourly `exclusive` Warsaw resource, open Monday 09:00–12:00
(`2026-07-20` is that Monday). Cases that need `shared` or a day-based resource say so.

### 7.1 Creation — accepted

| ID        | Case                            | Steps                                      | Expected                                            | Covered by         |
| --------- | ------------------------------- | ------------------------------------------ | --------------------------------------------------- | ------------------ |
| TC-BK-C01 | Confirmed on a slot boundary    | `POST .../bookings` 09:00–10:00, no `hold` | `201`, `status: "confirmed"`, `held_until: null`    | `bookings.test.ts` |
| TC-BK-C02 | Contiguous run of slots         | `POST .../bookings` 09:00–12:00            | `201`                                               | same               |
| TC-BK-C03 | Hold with an expiry             | `hold: true, hold_minutes: 15`             | `201`, `status: "held"`, `held_until` in the future | same               |
| TC-BK-C04 | Touching bookings both accepted | Book 09:00–10:00, then 10:00–11:00         | Both `201` — touching is not overlapping            | same               |
| TC-BK-C05 | Z-suffixed timestamp accepted   | `start_time`/`end_time` end in `Z`         | `201`, rendered back in the resource's own offset   | same               |

### 7.2 Creation — rejected

Grid rejections are a dataset (`tests/fixtures/datasets/booking-validation.ts` ←
`rejectedBookings`), also replayed by `./run smoke`.

| ID        | Case                              | Body difference                 | `error`                 | Covered by                              |
| --------- | --------------------------------- | ------------------------------- | ----------------------- | --------------------------------------- |
| TC-BK-R01 | Start half an hour off the grid   | `09:30–10:30`                   | `invalid_slot_boundary` | `bookings.test.ts` ← `rejectedBookings` |
| TC-BK-R02 | End landing inside a slot         | `09:00–09:30`                   | `invalid_slot_boundary` | same                                    |
| TC-BK-R03 | Run extending past the window     | `11:00–13:00`                   | `outside_schedule`      | same                                    |
| TC-BK-R04 | Start before the window opens     | `08:00–09:00`                   | `invalid_slot_boundary` | same                                    |
| TC-BK-R05 | Inverted interval                 | `10:00–09:00`                   | `invalid_interval`      | same                                    |
| TC-BK-R06 | Zero-length interval              | `09:00–09:00`                   | `invalid_interval`      | same                                    |
| TC-BK-R07 | A date the resource does not work | Tuesday, `09:00–10:00`          | `invalid_slot_boundary` | same                                    |
| TC-BK-R08 | `hold_minutes` without `hold`     | `hold_minutes: 15`, no `hold`   | `400 validation_error`  | `bookings.test.ts`                      |
| TC-BK-R09 | Hold past the configured maximum  | `hold: true, hold_minutes: 600` | `400`                   | same                                    |
| TC-BK-R10 | Unknown field in the body         | extra field                     | `400 validation_error`  | same                                    |
| TC-BK-R11 | Unknown resource                  | random uuid                     | `404 not_found`         | same                                    |
| TC-BK-R12 | `start_time` with no offset       | naive timestamp                 | `400`                   | same                                    |
| TC-BK-R13 | `end_time` with no offset         | naive timestamp                 | `400`                   | same                                    |
| TC-BK-R14 | Inactive resource                 | `is_active: false`              | `409 resource_inactive` | same                                    |

### 7.3 Overlap and capacity

| ID        | Case                                                | Steps                                                                             | Expected                                                    | Covered by         |
| --------- | --------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------ |
| TC-BK-O01 | Exclusive: overlap refused                          | Book 09:00–10:00, book it again                                                   | Second is `409 slot_unavailable`                            | `bookings.test.ts` |
| TC-BK-O02 | An expired hold frees the slot immediately          | Expire a hold via SQL, no sweeper running, book the same slot                     | `201` — no wait for a background worker                     | same               |
| TC-BK-O03 | A live hold still blocks                            | Hold not yet expired, book the same slot                                          | `409`                                                       | same               |
| TC-BK-O04 | Shared: accepts up to capacity                      | Capacity N, N bookings on one slot                                                | All `201`                                                   | same               |
| TC-BK-O05 | Shared: refuses past capacity                       | The (N+1)th booking on that slot                                                  | `409 slot_unavailable`                                      | same               |
| TC-BK-O06 | Occupancy is counted per slot, not per booking      | Two bookings touching opposite ends of a multi-slot run, then a run spanning both | The run is accepted — the middle slot is not double-counted | same               |
| TC-BK-O07 | Any full slot in the run refuses the whole request  | One slot in a multi-slot run is already at capacity                               | `409`                                                       | same               |
| TC-BK-O08 | Cancelled bookings do not count against capacity    | Cancel a booking, rebook the same slot                                            | `201`                                                       | same               |
| TC-BK-O09 | Two genuinely concurrent requests for the last unit | Both promises started before either is awaited, on a capacity-1 shared resource   | Exactly one `201` and one `409`                             | same               |

### 7.4 Read

| ID        | Case                          | Steps                            | Expected                                 | Covered by         |
| --------- | ----------------------------- | -------------------------------- | ---------------------------------------- | ------------------ |
| TC-BK-G01 | Round-trip                    | `POST`, then `GET /bookings/:id` | `200`, body matches                      | `bookings.test.ts` |
| TC-BK-G02 | Unknown booking               | `GET` a random uuid              | `404 not_found`                          | same               |
| TC-BK-G03 | `idempotency_key` never leaks | Create with a key, `GET`         | The key is absent from the response body | same               |

### 7.5 Idempotency

| ID        | Case                                                | Steps                                                       | Expected                        | Covered by         |
| --------- | --------------------------------------------------- | ----------------------------------------------------------- | ------------------------------- | ------------------ |
| TC-BK-I01 | Creates once, replays with `200`                    | The same key twice                                          | `201` then `200`, same `id`     | `bookings.test.ts` |
| TC-BK-I02 | Same key, different booking                         | Same key, different `end_time`                              | `409 idempotency_key_reused`    | same               |
| TC-BK-I03 | Same key, different customer                        | Same key, different `customer_id`                           | `409`                           | same               |
| TC-BK-I04 | `hold`/`hold_minutes` ignored when comparing        | Replay with different `hold_minutes`                        | `200`, same `id`                | same               |
| TC-BK-I05 | Keys are separated per resource                     | Same key on two different resources                         | Both `201`                      | same               |
| TC-BK-I06 | Keyless bookings never collide                      | Two keyless bookings on a shared resource                   | Both `201`                      | same               |
| TC-BK-I07 | Replay wins on a full shared resource               | Capacity 1, replay of the booking that filled it            | `200`, not a capacity `409`     | same               |
| TC-BK-I08 | A different key on that full resource still refused | New key on the same full resource                           | `409 slot_unavailable`          | same               |
| TC-BK-I09 | Two identical requests race to one booking          | Concurrent identical create requests, both awaited together | One `200`, one `201`, same `id` | same               |

### 7.6 Lifecycle

The transition matrix — every (starting status, action) pair — is a dataset
(`tests/fixtures/datasets/booking-transitions.ts` ← `bookingTransitions`, 28 cases: 7 states ×
4 actions). `./run smoke` replays 20 of the 28: `held_expired` and `expired` cannot be
fabricated over HTTP within the smoke run's timeout, so those 8 rows are exercised by the
integration suite only.

| ID        | Case                                             | Steps                                                    | Expected                                                       | Covered by                                |
| --------- | ------------------------------------------------ | -------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------- |
| TC-BK-L01 | Full transition matrix                           | Each (from, action) pair                                 | Status or error code per the matrix, including no-op successes | `bookings.test.ts` ← `bookingTransitions` |
| TC-BK-L02 | `held_until` cleared on confirm                  | Confirm a held booking                                   | `held_until` becomes `null`                                    | `bookings.test.ts`                        |
| TC-BK-L03 | `held_until` cleared on cancel                   | Cancel a held booking                                    | `held_until` becomes `null`                                    | same                                      |
| TC-BK-L04 | Cancelling frees the slot                        | Cancel, then rebook the same slot                        | `201`                                                          | same                                      |
| TC-BK-L05 | A refused transition reports the current status  | e.g. confirm a cancelled booking                         | `409`, `details.status` is the current status                  | same                                      |
| TC-BK-L06 | Unknown booking                                  | Any action on a random uuid                              | `404`                                                          | same                                      |
| TC-BK-L07 | Two conflicting actions on one booking, one wins | `cancel` and `complete` raced on one `confirmed` booking | Exactly one succeeds, the other is refused — never both        | same                                      |

### 7.7 Reschedule

| ID         | Case                                         | Steps                                                | Expected                                 | Covered by         |
| ---------- | -------------------------------------------- | ---------------------------------------------------- | ---------------------------------------- | ------------------ |
| TC-BK-RS01 | Moves a confirmed booking                    | Reschedule to a new run of slots                     | `200`, same `id` and `status`, new times | `bookings.test.ts` |
| TC-BK-RS02 | Keeps a hold a hold                          | Reschedule a held booking                            | `status` stays `held`                    | same               |
| TC-BK-RS03 | Does not block itself (exclusive)            | Reschedule onto its own current interval             | `200`, not `409`                         | same               |
| TC-BK-RS04 | Does not block itself (shared)               | Same, on a shared resource                           | `200`                                    | same               |
| TC-BK-RS05 | Refuses a move onto a taken slot             | Target slot already booked by another booking        | `409 slot_unavailable`                   | same               |
| TC-BK-RS06 | A refused move leaves the original untouched | As above, then `GET`                                 | Original times unchanged                 | same               |
| TC-BK-RS07 | Refuses a target off the grid                | New interval not on the grid                         | `400 invalid_slot_boundary`              | same               |
| TC-BK-RS08 | Refused from a terminal state                | Reschedule a cancelled, completed or no-show booking | `409 invalid_state_transition`           | same               |
| TC-BK-RS09 | Unknown booking                              | Reschedule a random uuid                             | `404`                                    | same               |

### 7.8 Listings

| ID         | Case                                                            | Steps                                                     | Expected                                  | Covered by         |
| ---------- | --------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------- | ------------------ |
| TC-BK-LS01 | Lists a resource's bookings, ascending                          | Three bookings, `GET .../bookings`                        | Ordered by `start_time`                   | `bookings.test.ts` |
| TC-BK-LS02 | Excludes bookings outside the window                            | A booking outside `from`/`to`                             | Not present                               | same               |
| TC-BK-LS03 | Includes a booking starting before the window, reaching into it | Overlap at the start, on a day-based resource             | Included                                  | same               |
| TC-BK-LS04 | Includes a booking starting inside, reaching past the window    | Overlap at the end, on a day-based resource               | Included                                  | same               |
| TC-BK-LS05 | Filters by status                                               | `?status=cancelled` vs `?status=confirmed`                | Only the matching statuses returned       | same               |
| TC-BK-LS06 | Customer listing spans resources                                | Bookings on two resources, same customer                  | Both returned                             | same               |
| TC-BK-LS07 | `customer_id` required on the customer listing                  | `GET /bookings` without it                                | `400`                                     | same               |
| TC-BK-LS08 | Both bounds required, and range validated                       | Missing `from`/`to`; inverted; over-wide                  | `400`, `invalid_range` for the last two   | same               |
| TC-BK-LS09 | Unknown resource                                                | `GET .../bookings` on a random uuid                       | `404`                                     | same               |
| TC-BK-LS10 | Each timestamp rendered in its own resource timezone            | Customer listing across a Warsaw and an Auckland resource | Offsets differ per booking's own resource | same               |

### 7.9 Availability reflects bookings

| ID         | Case                                             | Steps                                                   | Expected                                        | Covered by             |
| ---------- | ------------------------------------------------ | ------------------------------------------------------- | ----------------------------------------------- | ---------------------- |
| TC-BK-AV01 | A booked slot becomes unavailable                | Book one slot, query availability                       | That slot `available: false`, the others `true` | `availability.test.ts` |
| TC-BK-AV02 | A multi-slot booking marks every slot it covers  | Book a run, query                                       | Every covered slot `false`                      | same                   |
| TC-BK-AV03 | Shared stays available until capacity is reached | Book up to capacity − 1, query, then book the last unit | Available until the last booking, then `false`  | same                   |
| TC-BK-AV04 | Cancelled bookings are ignored                   | Cancel a booking, query again                           | The slot is available again                     | same                   |

### 7.10 Hold expiry

| ID        | Case                                                            | Steps                                                         | Expected                                                         | Covered by             |
| --------- | --------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------- |
| TC-BK-H01 | The in-transaction sweep frees a slot within the same request   | Expire a hold via SQL, no sweeper running, book the same slot | `201` — see TC-BK-O02                                            | `bookings.test.ts`     |
| TC-BK-H02 | The sweeper expires exactly the stale holds                     | One expired hold, one live hold                               | The expired one becomes `expired`; the live one stays `held`     | `hold-sweeper.test.ts` |
| TC-BK-H03 | `held_until` survives the sweep                                 | Sweep an expired hold, then read it back                      | Still not `null` — it is the only record of when the hold lapsed | same                   |
| TC-BK-H04 | The sweep is idempotent                                         | Run it twice                                                  | The second run expires nothing                                   | same                   |
| TC-BK-H05 | A concurrent sweeper takes no lock and does no work             | One sweep holds the advisory lock while another runs          | The second does nothing rather than duplicating the work         | same                   |
| TC-BK-H06 | Sweeps across resources in one pass                             | Two resources, one stale hold each                            | Both expired by one call                                         | same                   |
| TC-BK-H07 | `HOLD_SWEEP_ENABLED` parses like the other configuration values | Unset, `"true"`, `"false"`, and an invalid value              | Defaults `true`; `"true"`/`"false"` parse; anything else throws  | `config.test.ts`       |

### 7.11 Delete guard

| ID        | Case                                          | Steps                                     | Expected                                                      | Covered by          |
| --------- | --------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------- | ------------------- |
| TC-BK-D01 | Refuses to delete a resource with any booking | Create a booking, `DELETE` the resource   | `409 resource_has_bookings`; the resource is still `GET`-able | `resources.test.ts` |
| TC-BK-D02 | Refuses even when every booking is terminal   | Cancel the booking, `DELETE` the resource | `409` — history is not discarded as a side effect of a delete | same                |

### 7.12 Background sweep topologies

Not automated. `src/worker.ts` has no test file: the three topologies of the running engine
were exercised by hand against the built image during implementation, not by a suite that runs
on every commit.

| ID        | Case                                     | Steps                                                             | Expected                                                                                                      | Covered by                 |
| --------- | ---------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------- |
| TC-BK-W01 | `server.js` sweeps on its own timer      | Boot the built image, wait past `HOLD_SWEEP_INTERVAL_SECONDS`     | A stale hold expires with no separate worker running                                                          | **gap** — verified by hand |
| TC-BK-W02 | `worker.js` loops and sweeps             | Boot `worker.js` standalone                                       | Same effect; the process keeps running                                                                        | **gap** — verified by hand |
| TC-BK-W03 | `worker.js --once` sweeps once and exits | Boot `worker.js --once`                                           | One sweep, then exit code `0`                                                                                 | **gap** — verified by hand |
| TC-BK-W04 | Two sweepers never duplicate work        | `server.js` and `worker.js` running together against one database | The advisory lock lets exactly one of them sweep per tick — see TC-BK-H05 for the mechanism at the unit level | **gap** — verified by hand |

---

## 8. Authentication, tenancy and the console

_Spec 4._ Two planes: the engine on `:3000`, which every case above needs a key for, and the
console on `127.0.0.1:3001`, which issues them and has no key of its own.

Cases here need two tenants and several keys, so they set up through the console rather than
with `mk()`. `CONSOLE=http://127.0.0.1:3001`.

### 8.1 Authentication

| ID         | Case                           | Steps                                                                                                                                           | Expected                                                                         | Covered by        |
| ---------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------- |
| TC-AUTH-01 | No key at all                  | `curl -i $BASE/resources/<any uuid>`                                                                                                            | `401 unauthorized`, and a `WWW-Authenticate: Bearer` header                      | `auth.test.ts`    |
| TC-AUTH-02 | Malformed credential           | `Bearer garbage`; `Basic abcdef`; a key with no `Bearer` prefix; `Bearer` with nothing after it                                                 | `401` for each                                                                   | same              |
| TC-AUTH-03 | Failures are indistinguishable | Compare the body of a missing key against that of a well-formed unknown one                                                                     | Byte-identical. "No such key" cannot be told from "wrong secret"                 | same              |
| TC-AUTH-04 | The three public routes        | `GET /health`, `GET /`, `GET /docs/json` with no key                                                                                            | `200`, `302`, `200` — nothing else is reachable unauthenticated                  | same              |
| TC-AUTH-05 | Real prefix, wrong secret      | Alter one character of a live key's secret half                                                                                                 | `401` — the comparison is constant-time over the hashes                          | `tenants.test.ts` |
| TC-AUTH-06 | Revoked key                    | Revoke a key, then call with it                                                                                                                 | `401`; the row survives, so the audit trail does                                 | `auth.test.ts`    |
| TC-AUTH-07 | Key of a disabled tenant       | Set `tenants.is_active = false`, then call                                                                                                      | `401` — one disabled tenant retires every key it owns                            | same              |
| TC-AUTH-08 | `last_used_at`                 | Call twice in quick succession, reading the key row between                                                                                     | Stamped on the first call, unchanged on the second — it is a signal, not a count | same              |
| TC-AUTH-09 | Only the hash is stored        | Issue a key, then read the `api_keys` row                                                                                                       | `key_hash` and `key_prefix` are there; the secret half is nowhere                | `tenants.test.ts` |
| TC-AUTH-10 | Key shape                      | `bk_live_` + 8-character prefix + 43-character secret. Reject: empty, marker only, `bk_test_`, wrong length, non-alphanumeric, trailing newline | Parsed only in the exact shape; a trailing newline never parses                  | `api-key.test.ts` |

### 8.2 Scopes

| ID        | Case                                    | Steps                                                                             | Expected                                                                                                                                    | Covered by                             |
| --------- | --------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| TC-SCP-01 | Exactly the route's scope admits        | Key holding only `resources.read`, `GET /resources/<absent uuid>`                 | `404` — past authentication and authorisation; the resource simply is not there                                                             | `auth.test.ts`                         |
| TC-SCP-02 | Every scope but the route's refuses     | Key holding the other seven, same call                                            | `403 forbidden_scope`, `details: { "required": "resources.read" }`                                                                          | same                                   |
| TC-SCP-03 | Every route requires exactly one scope  | For each route: call without its scope, then with only that scope                 | `403` naming the scope, then anything but `401`/`403`. The dataset covers 19 of the 20 scoped routes — `GET /resources` is the one it omits | same                                   |
| TC-SCP-04 | A partner channel books but cannot list | Key with `availability.read`, `resources.read`, `bookings.read`, `bookings.write` | `GET /bookings` is `403` requiring `bookings.list`. This is why the model is a set                                                          | same                                   |
| TC-SCP-05 | An empty scope set is refused           | Issue a key with `[]`                                                             | Refused — at the service and again by `api_keys_scopes_not_empty`                                                                           | `tenants.test.ts`                      |
| TC-SCP-06 | An unknown scope is refused and named   | Issue with `bookings.everything`                                                  | Refused, naming the offending value                                                                                                         | same                                   |
| TC-SCP-07 | A repeated scope is deduplicated        | Issue with the same scope twice                                                   | Stored once                                                                                                                                 | same                                   |
| TC-SCP-08 | The vocabulary is one list              | The eight scopes in `scopes.ts` against the CHECK in `003_tenancy.ts`             | Identical sets; every scope is reachable through at least one preset                                                                        | `scopes.test.ts`, `migrations.test.ts` |

### 8.3 Tenant isolation

Two tenants, A and B, each with an all-scopes key. Every case asks whether B can see or touch
something of A's.

| ID        | Case                                          | Steps                                                                                            | Expected                                                                                                   | Covered by          |
| --------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------- |
| TC-ISO-01 | A foreign id answers 404, never 403           | With B's key, `GET` A's resource, schedule, exceptions, availability and bookings                | `404` on all five, and the body is identical to that of a genuinely absent id once the echoed id is masked | `isolation.test.ts` |
| TC-ISO-02 | A foreign resource cannot be modified         | With B's key: `PATCH`, `DELETE`, `PUT` the schedule, `PUT` and `DELETE` an exception             | `404` on all five, and A's resource is unchanged afterwards                                                | same                |
| TC-ISO-03 | A foreign resource cannot be booked           | With B's key, `POST` a booking on A's resource                                                   | `404`                                                                                                      | same                |
| TC-ISO-04 | A foreign booking cannot be read or moved     | With B's key: `GET`, `cancel`, `complete`, `no-show`, `reschedule` A's booking                   | `404` on all five; A's booking is still `confirmed`                                                        | same                |
| TC-ISO-05 | Listings show only the caller's rows          | A books for `guest-1`; both tenants list `?customer_id=guest-1`                                  | One row for A, `[]` for B — the same customer id means nothing across the boundary                         | same                |
| TC-ISO-06 | Neither capacity nor overlap leaks across     | A resource per tenant with identical times; both book the same night                             | Both `201`. Neither the exclusion constraint nor the capacity count reaches over                           | same                |
| TC-ISO-07 | Every written row carries the caller's tenant | Create a resource, a schedule, an exception and a booking as A; read `tenant_id` from each table | All four match A, so the denormalised column cannot drift from the composite foreign key                   | same                |

### 8.4 The console

`GET` is a page, every write is a form post answered with `303`, and the whole thing works
with JavaScript switched off.

| ID        | Case                                    | Steps                                                                                                                                       | Expected                                                                                                                                                                                                                 | Covered by                        |
| --------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| TC-CON-01 | Needs no key, unlike the data plane     | `curl $CONSOLE/tenants` with no `Authorization`                                                                                             | `200` and a page. It is loopback that protects this, not a credential                                                                                                                                                    | `console.test.ts`                 |
| TC-CON-02 | Root redirects to the tenant list       | `curl -i $CONSOLE/`                                                                                                                         | `303` to `/tenants`                                                                                                                                                                                                      | same                              |
| TC-CON-03 | An empty list is explained              | Fresh database, open `/tenants`                                                                                                             | A sentence saying there are none, not an empty table                                                                                                                                                                     | same                              |
| TC-CON-04 | Creating redirects rather than renders  | `POST /tenants` with a name                                                                                                                 | `303` to `/tenants`, so a reload re-reads the list instead of re-posting                                                                                                                                                 | same                              |
| TC-CON-05 | Names the server refuses                | `"  "`, `""`, and a name past the length limit                                                                                              | Refused, and nothing is created                                                                                                                                                                                          | same                              |
| TC-CON-06 | Names it accepts                        | A name with surrounding spaces; emoji; Cyrillic                                                                                             | Trimmed and stored; non-Latin text round-trips intact                                                                                                                                                                    | same, `tenants.spec.ts`           |
| TC-CON-07 | A hostile name is rendered as text      | Create a tenant named `<script>alert(1)</script>`                                                                                           | Shown literally, escaped; no script runs                                                                                                                                                                                 | `console.test.ts`, `html.test.ts` |
| TC-CON-08 | Two tenants of one name stay apart      | Create the same name twice                                                                                                                  | Both listed, distinguished by id                                                                                                                                                                                         | `console.test.ts`                 |
| TC-CON-09 | A key is revealed exactly once          | Issue a key from the keys page                                                                                                              | `303` to `?revealed=<token>`, and that page shows the secret                                                                                                                                                             | same                              |
| TC-CON-10 | Reloading loses it and issues no second | Reload the reveal URL, then revisit it                                                                                                      | The plain list, one key still. The flash is one-shot, so both follow from one mechanism                                                                                                                                  | same, `flash.test.ts`             |
| TC-CON-11 | The list never holds the secret         | Search the keys page markup                                                                                                                 | Only `key_prefix` appears anywhere                                                                                                                                                                                       | `console.test.ts`                 |
| TC-CON-12 | A preset stores its expansion           | Issue with **Partner channel**, then read the row                                                                                           | Its four scopes, and the preset name nowhere on the key — so editing the preset later changes no key already issued                                                                                                      | same, `scopes.test.ts`            |
| TC-CON-13 | A custom subset works                   | Choose **Custom** with one checkbox, then with several                                                                                      | Exactly the ticked scopes. Custom with none ticked is refused                                                                                                                                                            | `console.test.ts`                 |
| TC-CON-14 | Revocation                              | Revoke a key from the list                                                                                                                  | Marked revoked, the row kept, the revoke control gone                                                                                                                                                                    | same                              |
| TC-CON-15 | Revoking what is not there              | Revoke an unknown id, and revoke the same key twice                                                                                         | `404` both times                                                                                                                                                                                                         | same                              |
| TC-CON-16 | Origin guard                            | `POST` with a foreign `Origin`; with none at all; with one matching the `Host` it was addressed to; with a different port on that same host | `403` and nothing created; accepted, because a browser always sends one so its absence is curl; accepted; `403`. The expectation is derived from `Host`, not from `CONSOLE_PORT`, so it still holds on an ephemeral port | same                              |
| TC-CON-17 | Reads ignore the origin                 | `GET` any page with a foreign `Origin`                                                                                                      | Unaffected — the guard is for writes                                                                                                                                                                                     | same                              |
| TC-CON-18 | Errors are pages, not JSON              | A malformed uuid; a well-formed unknown tenant; an unknown path                                                                             | `400`, `404`, `404`, each an HTML page rather than a stack trace or a JSON body                                                                                                                                          | same                              |

### 8.5 The console in a real browser

Playwright, run by `./run test:ui`. It needs a browser binary, which is why it is not part of
`./run check` — see the README. These are the promises a request-level test cannot check.

| ID       | Case                                         | Expected                                                                                                                                   | Covered by          |
| -------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| TC-UI-01 | Works with JavaScript disabled               | Every form still submits under `javaScriptEnabled: false`, presets included — they are radio buttons and checkboxes, not a scripted widget | `a11y.spec.ts`      |
| TC-UI-02 | Every input has a label                      | On every page                                                                                                                              | same                |
| TC-UI-03 | One `h1` and a titled document per page      | On every page                                                                                                                              | same                |
| TC-UI-04 | No horizontal scroll at 390 px               | The document fits a phone viewport                                                                                                         | same                |
| TC-UI-05 | Keyboard alone is enough                     | Enter in a text field submits; every control on the keys page is reachable by tabbing                                                      | same                |
| TC-UI-06 | Copying the secret                           | The copy button puts the whole secret on the clipboard, and the secret stays selectable when the button cannot work                        | `clipboard.spec.ts` |
| TC-UI-07 | A key issued here works against the engine   | Issue in the console, call `:3000` with it, and see only its own tenant's rows                                                             | `keys.spec.ts`      |
| TC-UI-08 | The presets mean what the README says        | A **Partner channel** key books and is refused the calendar; a **Widget** key cannot create a resource                                     | same                |
| TC-UI-09 | Revoking takes effect at the engine          | Revoke in the console, and the next call with that key is refused                                                                          | same                |
| TC-UI-10 | The console never answers a data-plane route | A path the engine owns is not served by the console                                                                                        | `hardening.spec.ts` |

---

## 9. Error contract

| ID        | Case                                 | Steps                                                      | Expected                                                                                  | Covered by              |
| --------- | ------------------------------------ | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------- |
| TC-ERR-01 | Unknown path                         | `GET /nope`                                                | `404 {"error":"not_found","message":"Route not found"}`                                   | `error-handler.test.ts` |
| TC-ERR-02 | Unknown nested path                  | `GET /resources/x/y/z`                                     | Same shape                                                                                | same                    |
| TC-ERR-03 | Method not served                    | `DELETE /health`                                           | `404` in the uniform shape                                                                | same                    |
| TC-ERR-04 | Uniform body everywhere              | Trigger a 404, a validation error and a business rejection | All three have `error` and `message`, optional `details`, and nothing else                | same                    |
| TC-ERR-05 | No structure leakage                 | Trigger a validation error, search the response            | No `resources`, `kysely`, `postgres`, `pg_`, `select`, `insert into` anywhere in the body | same                    |
| TC-ERR-06 | Malformed JSON                       | `POST /resources` with `{ this is not json`                | `4xx`, `content-type: application/json`, never `internal_error`                           | same                    |
| TC-ERR-07 | Client error is never a server error | Wrong content type on any write endpoint                   | `4xx`, and `error` is not `internal_error`                                                | `schedule.test.ts`      |

---

## 10. Persistence

Verified against the database directly rather than through HTTP.

| ID       | Case                           | Expected                                                                                                                                                                        | Covered by           |
| -------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| TC-DB-01 | Tables exist                   | `resources`, `schedule`, `schedule_exceptions`, `bookings`, `tenants`, `api_keys`                                                                                               | `migrations.test.ts` |
| TC-DB-02 | Column types                   | `slot_duration` is `interval`; `slot_anchor_time` and schedule times are `time without time zone`; `date` is `date`; `created_at` is `timestamptz`; `day_of_week` is `smallint` | same                 |
| TC-DB-03 | Duration round-trip            | Every accepted duration reads back in canonical form                                                                                                                            | same                 |
| TC-DB-04 | `P1D` ≠ `PT23H59M`             | Stored distinctly                                                                                                                                                               | same                 |
| TC-DB-05 | Dates as strings               | `2026-01-01`, `2026-06-15`, `2026-12-31`, `2028-02-29` read back verbatim on an Auckland resource                                                                               | same                 |
| TC-DB-06 | Times as `HH:MM:SS`            | Stored `09:00` reads back `09:00:00`                                                                                                                                            | same                 |
| TC-DB-07 | Capacity constraint            | 0 and −5 rejected by `resources_capacity_positive`                                                                                                                              | same                 |
| TC-DB-08 | Concurrency mode constraint    | Unknown value rejected by `resources_concurrency_mode_valid`                                                                                                                    | same                 |
| TC-DB-09 | Paired-times constraint        | One time set, one null → rejected                                                                                                                                               | same                 |
| TC-DB-10 | Ordered-times constraint       | End before start → rejected                                                                                                                                                     | same                 |
| TC-DB-11 | Weekday range constraint       | −1 and 7 rejected                                                                                                                                                               | same                 |
| TC-DB-12 | Unique exception per date      | Second row for the same `(resource_id, date)` rejected                                                                                                                          | same                 |
| TC-DB-13 | Same date, different resources | Allowed                                                                                                                                                                         | same                 |
| TC-DB-14 | Foreign keys                   | Schedule or exception row with no resource → rejected                                                                                                                           | same                 |
| TC-DB-15 | Cascade                        | Deleting a resource removes its schedule and exceptions                                                                                                                         | same                 |
| TC-DB-16 | Defaults                       | `is_active` true, `capacity` 1, anchor `00:00:00`, uuid generated, both timestamps set                                                                                          | same                 |
| TC-DB-17 | Unique ids                     | Three inserts produce three distinct ids                                                                                                                                        | same                 |

---

## 11. End-to-end journeys

Full chains, run in order, as an acceptance pass before a release.

### TC-E2E-01 — Hotel room

1. `POST /resources` — `Europe/Warsaw`, `P1D`, anchor `14:00`, `exclusive`
2. `PUT .../schedule` — whole-day rules for all seven weekdays
3. `GET .../availability?from=2026-07-20&to=2026-07-23` → **3** slots, each 14:00 → 14:00
4. `PUT .../exceptions/2026-07-21` — day off (maintenance)
5. Repeat step 3 → **2** slots; the 21st is gone
6. `GET .../availability?from=2026-03-28&to=2026-03-31` → 3 slots, all starting 14:00 local. The first runs `2026-03-28T14:00:00+01:00 → 2026-03-29T14:00:00+02:00`, which is 23 real hours
7. `PATCH` `is_active: false` → availability is `{"slots":[]}`
8. `DELETE` the resource → the schedule endpoint returns `404`

**Covered by:** steps individually across `availability.test.ts` and `resources.test.ts`; **the chain as one scenario is a gap.** The counts above were executed against a running instance, not derived on paper.

### TC-E2E-02 — Doctor's surgery

1. `POST /resources` — `Europe/Warsaw`, `PT30M`, `exclusive`
2. `PUT .../schedule` — Mon–Fri `09:00–13:00` and `14:00–17:00`, ten rules in all
3. `GET .../availability?from=2026-07-20&to=2026-07-27` → **70** slots: 8 in the morning and 6 in the afternoon on each of five weekdays. Querying the weekend alone returns **0**
4. `PUT .../exceptions/2026-07-22` — `10:00–12:00` (short day)
5. Query Wednesday alone → **4** slots instead of 14
6. `PUT .../exceptions/2026-07-23` — day off
7. Query Thursday alone → **0**
8. `DELETE .../exceptions/2026-07-23`, query Thursday again → back to **14**

**Covered by:** individually; **not as a chain.** The counts above were executed against a running instance.

### TC-E2E-03 — Cold start

1. `docker compose down -v`
2. `docker compose up -d --build`
3. `docker compose ps` → `db` healthy, `migrate` exited 0, `app` healthy
4. `curl $BASE/health` → `200`
5. Run TC-E2E-01

**Covered by:** **gap** — verified by hand.

---

## 12. Known gaps

Not covered by any automated test. Run these by hand, or automate them when the cost of a
regression justifies it.

| ID        | Gap                                                      | Why it matters                                                                                                                                                                                                                                             |
| --------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-GAP-01 | No `down` migration is ever executed                     | All three migrations define `down`, and nothing runs any of them. `003_tenancy.ts` even refuses its own reversal when a booking has a null `customer_id` — a branch no test reaches. A rollback would be discovered to be broken exactly when it is needed |
| TC-GAP-02 | Migrations are never run twice against the same database | `migrateToLatest` should be a no-op on an up-to-date schema. The suite applies them once, in `globalSetup`                                                                                                                                                 |
| TC-GAP-03 | `/health` does not check the database                    | It is a liveness probe, not readiness. An orchestrator using it to decide whether to route traffic would send requests to an instance that cannot reach Postgres                                                                                           |
| TC-GAP-04 | No named end-to-end journeys                             | TC-E2E-01 to 03 pass step by step but are not asserted as a chain, so an interaction bug between steps could survive                                                                                                                                       |
| TC-GAP-05 | The container image is not exercised by tests            | The suite runs the TypeScript sources; the compiled `dist/` in the image is verified only by starting it manually                                                                                                                                          |
| TC-GAP-06 | No load testing                                          | Contention is covered case by case — TC-BK-O09, TC-BK-I09, TC-BK-L07 — but nothing measures throughput. The availability endpoint's 366-day ceiling has never been timed under load                                                                        |
| TC-GAP-07 | `GET /resources` is missing from the scope dataset       | TC-SCP-03 walks 19 of the 20 scoped routes and omits the resource listing. The route does declare `resources.read`, and the startup guard would catch it declaring nothing, but no test asserts that a key without that scope is refused there             |
