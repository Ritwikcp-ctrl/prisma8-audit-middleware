# prisma-orm-extension-audit

Statement-level audit logging middleware for **Prisma ORM 8**.

Records **what statement was sent, to which table, with what parameters, and whether it committed** — not a before/after row diff.

> **Why not before/after?** A Prisma 8 middleware runs outside the user's transaction on a separate connection. It cannot observe uncommitted writes, so any "before state" it reads is either stale or wrong. Prisma's own architecture (ADR 271) supports statement-level observation, not model-level lifecycle diffs. This package works with that design, not against it.

---

## What this package does

For every committed `INSERT`, `UPDATE`, `DELETE`, or raw statement sent through the runtime, it emits one `AuditEvent`:

| Field | Description |
|---|---|
| `table` | Physical table name from the SQL statement (`ast.table.name`). Respects `@@map`. `"unknown"` for raw statements. |
| `statement` | `"insert" \| "update" \| "delete" \| "raw"`. **Upsert is recorded as `"insert"`** — the statement is `INSERT … ON CONFLICT DO UPDATE`, and **the SQL statement alone cannot tell whether the row was actually inserted or updated**. If you need to distinguish, check the returned `rows` against a prior state, or use a database trigger. |
| `sql` | The rendered SQL text sent to the driver. |
| `params` | Bound parameter values, in column order. **Primitives, not objects.** |
| `rows` | Rows returned by `RETURNING` (via `onRow`). For `create`/`update`/`delete` this is the actual written row, including database defaults. Raw statements built with `.affectedCount()` return `[]`. |
| `actorId` | Whatever `getActorId()` returned in `beforeEncode`, or `undefined`. |
| `activityId` | The statement's activity ID. Unique per statement. |
| `parentActivityId` | The activity **directly above** the statement — see [Parent linkage](#parent-linkage). |
| `outcome` | `"committed"` or `"unknown"`. **Rolled-back statements emit no event.** |

## What this package does **not** do

- **No "before state".** A correct before/after requires database triggers, which run inside the user's transaction. A middleware cannot do this safely.
- **No model-level names.** You get physical table and column names, not ORM identifiers.
- **No PII scanning by default.** You must supply a `redact` callback — see [Redaction](#redaction).
- **No classification of raw SQL.** Raw statements are recorded as `statement: "raw"` with `table: "unknown"`. Whether they are writes or reads cannot be determined without parsing SQL, which the runtime deliberately does not do.
- **No `SELECT` auditing via the ORM.** ORM `SELECT`s are never captured. Raw `SELECT`s *are* captured (because the middleware cannot tell them apart from raw writes) — see [Raw SQL](#raw-sql-and-query-builder-writes).
- **No guarantee against `SIGKILL`.** `flush()` handles `SIGTERM`, `SIGINT`, and normal shutdown. `SIGKILL` cannot be caught.

---

## Install

```bash
npm install prisma-orm-extension-audit 

```
Prisma 8 is in release candidate. The peerDependencies are pinned to an exact ORM version:

```json
"peerDependencies": {
  "@prisma/orm-postgres": "8.0.0-rc.21"
}
```
This is deliberate. Prisma 8 refuses to load two versions of @prisma/orm-* at runtime, so a range like ^8.0.0-rc.21 would silently break for users whose tree resolves to rc.22. Install a matching version explicitly:

```bash
npm install @prisma/orm-postgres@8.0.0-rc.21
```
If @prisma/composer-prisma-cloud is also in your tree (it pins an older ORM), you will need:
```bash
npm install --legacy-peer-deps
```
This is a temporary workaround for Composer's release lag, not a requirement of this package.

Tested against rc.21 on PostgreSQL only.

## Quick start
```ts
import postgres from "@prisma/orm-postgres/runtime";
import { contractFromJson } from "@prisma/orm-postgres/static";
import { auditMiddleware } from "prisma-orm-extension-audit";
import contractJson from "./prisma/contract.json" with { type: "json" };

const contract = contractFromJson(contractJson);

const audit = auditMiddleware({
  getActorId: () => currentUser(), // called in beforeEncode, before the write
  excludeTables: ["AuditLog"],     // default; prevents self-audit recursion
  onAudit: async (entry) => {
    await db.orm.public.AuditLog.create({ /* … */ });
  },
  onError: (err) => {
    console.error("audit sink failed:", err);
  },
});

const db = postgres({
  contract,
  url: process.env.DATABASE_URL!,
  middleware: [audit.middleware], // register .middleware, NOT the wrapper
});

process.on("SIGTERM", async () => {
  await audit.flush(); // wait for in-flight audit writes
  await db.close();
  process.exit(0);
});
```

## Options

```ts
interface AuditMiddlewareOptions {
  /** Called in beforeEncode. Throw to abort the write before it runs. */
  getActorId?: () => string | undefined;

  /**
   * Physical table names to skip. Defaults to ["AuditLog"].
   * Does NOT filter raw statements — raw entries have no table name.
   */
  excludeTables?: readonly string[];

  /** The sink. Called once per committed write statement. Sync or async. */
  onAudit: (entry: AuditEvent) => void | Promise<void>;

  /** Called when onAudit throws. The error is also sent to ctx.log.error. */
  onError?: (error: unknown) => void;

  /** Redact PII before the entry reaches onAudit. Return a new entry. */
  redact?: (entry: AuditEvent) => AuditEvent | Promise<AuditEvent>;
}
```
getActorId is called inside beforeEncode, before the SQL is sent. An exception there stops the write entirely — the statement never reaches the database. This is the correct place to fail closed on an authentication error.

onAudit must not throw to be useful in production; if it does, onError and ctx.log.error are called and the caller's write is unaffected. Audit failures never fail the write.


## Physical names and @@map / @map

This middleware records physical table and column names, because that is what the SQL statement contains.

entry.table is the physical table name ("users" if the model has @@map("users"), otherwise "User").

entry.rows[*] keys are physical column names ("user_email" if the field has @map("user_email"), otherwise "email").

excludeTables also matches physical names literally:

```ts
excludeTables: ["audit_logs"] // not ["AuditLog"] if the model has @@map
```

If your models use @@map or @map, make sure your redact callback and excludeTables list use the physical names.

## Redaction
Two surfaces carry PII, and they have different shapes. Both must be handled.

params is a flat array of primitives, in column order — not [{ email, username }], but ["a@test.com", "alice", "uuid", "2026-…"]. Match by value:
```ts
redact: (entry) => ({
  ...entry,
  params: entry.params.map((p) =>
    typeof p === "string" && p.includes("@") ? "[EMAIL]" : p
  ),
  rows: entry.rows.map((row) => ({
    ...row,
    email: "[EMAIL]",
    username: "[USERNAME]",
    password_hash: undefined,
  })),
})
```
rows is an array of objects, keyed by physical column name. Match by key.

Redacting only one surface leaves the other leaking. The redact callback runs once, before onAudit, with both surfaces present.

## Graceful shutdown

onAudit is async. Between the statement committing and your sink finishing its work, the event is in flight — held in a pending Set inside the middleware. If the process exits during that window, the event is lost.

The fix is flush():
```ts
process.on("SIGTERM", async () => {
  await audit.flush(); // drains pending, in a loop, until empty
  await db.close();
  process.exit(0);
});
```
flush() waits for every in-flight onAudit call to settle, including writes that were enqueued while a previous flush was running. Call it before db.close() — closing the pool first will make in-flight sink writes fail.

Wire it in both SIGTERM and SIGINT, in your test teardown, and in your serverless function's beforeExit if applicable.


## Outcome values

Value                    Meaning

"committed"              The statement 
                          ran and its transaction committed.

"unknown"                 The outcome 
                          could not be definitively determined     (e.g. a failure before the statement fully executed outside a transaction).

 (absent)	                Rolled-back
                          statements emit no event.

When outcome is "unknown", treat it as "verify against the database before assuming the write happened."


## Parent linkage

parentActivityId is the ID of the activity directly above the statement in Prisma's activity tree (ADR 271). It is not the ID of a previous audit event. Transactions and ORM calls are not audited by this middleware (only activity.kind === "statement" emits), so parentActivityId will usually point to an activity that produced no AuditEvent.

For a transaction containing N statements:

```text
transaction                           ← not audited
├── orm-call (User.create)            ← not audited
│   └── statement (INSERT User)       ← audited; parentActivityId = orm-call
├── orm-call (Post.create)            ← not audited
│   └── statement (INSERT Post)       ← audited; parentActivityId = orm-call
└── orm-call (Post.create)            ← not audited
    └── statement (INSERT Post)       ← audited; parentActivityId = orm-call

```

Each statement has its own parent. If Prisma collapses single-child ORM calls into their transaction in a future release, the parent will be the transaction instead. Do not assume parentActivityId values are equal for a batch — collect them and check.

The middleware captures the parent in activityStarted via ctx.parent.state(AUDIT_KEY).myActivityId, because direct ctx.parent.id is not populated for statement activities in rc.21.

## Raw SQL and query-builder writes
db.raw.sql and query-builder writes produce a RawQueryAst (kind: "raw-query"). The framework treats these as opaque — there is no structured ast.table.name, and the runtime deliberately does not parse SQL (ADR 012 / ADR 247).

This middleware records every raw statement, with honest classification:

1. statement: "raw" — cannot be further classified without parsing SQL

2. table: "unknown" — the table exists only in the SQL text

3. sql — the full SQL text, for manual inspection

4. params — bound parameters, in order

Nothing is silently dropped. A raw entry says "an opaque statement ran, here is what it was, here are the parameters" — the most a middleware can say without re-implementing a SQL parser.

## Raw statements include reads
Because the framework does not distinguish raw writes from raw reads, raw SELECT statements are also recorded — labelled statement: "raw" just like raw INSERT/UPDATE/DELETE. For an audit trail of changes, that is noise.

This is a deliberate trade-off: recording every raw statement (including reads) is safer than silently dropping raw writes. If you want a changes-only trail, filter raw reads in onAudit using a SQL prefix check:

```ts
onAudit: (entry) => {
  
  if (entry.statement === "raw" && /^\s*(select|with)\b/i.test(entry.sql)) {
    return;
  }
  auditSink.write(entry);
}

```

The heuristic is user-side, not middleware-side — because any SQL parser inside the middleware would violate ADR 012 and would misclassify on CTEs, comments, and quoted identifiers.

### excludeTables does not filter raw statements
excludeTables matches physical table names on ORM-built statements only. Raw statements have no table name and cannot be excluded by this option. To exclude a raw-written table from the audit, use a trigger or filter the entry inside onAudit.

### If you need table/row-level info for raw SQL
Use a database trigger. A trigger attached to the table sees the real NEW / OLD rows in the same transaction as the write, regardless of whether the statement came from the ORM or from db.raw.sql. That is the only layer that can distinguish a raw write from a raw read reliably.

## Lifecycle
1. activityStarted — capture activity.id, then look up ctx.parent.state(AUDIT_KEY).myActivityId for the parent ID.

2. beforeEncode — inspect plan.ast; if it is a write to a non-excluded table, or a raw statement, call getActorId(), and store a partial entry in ctx.state(AUDIT_KEY).entry.

3. onRow — for each RETURNING row, push it onto entry.rows.

4. activityFinalized — if result.outcome !== "rolled-back", complete the entry and invoke redact → onAudit (tracked in pending for flush()).

Rolled-back statements are discarded silently. If beforeEncode or getActorId throws, the write is aborted before the SQL is sent; no event is emitted.

## Prisma 8 API note

If you're coming from Prisma 7, several method names changed:
```
Prisma 7                      Prisma 8

$transaction	                db.transaction

updateMany	                  updateAll

deleteMany	                  deleteAll

createMany	                  createAll/createAndCount

update({ where, data })	      User.where({…}).update({…})
delete({ where })            	User.where({…}).delete()
```

Writes must be filtered first. db.orm.public.User.update({ where, data }) fails with ts(2684) because Prisma 8 enforces HasWhere at the type level — the collection must be .where(...)-filtered before a terminal write is called.

The package is named prisma-orm-extension-audit (not prisma-audit-middleware). Import:

```ts
import { auditMiddleware } from "prisma-orm-extension-audit";
```


## License
ISC