# Prisma Audit Middleware

A production-ready, transaction-safe audit logging middleware for Prisma ORM 8. 

## Why this exists
Prisma 8 removed the old `$on('query')` event listeners. Standard audit loggers fail inside `$transaction`s because they read the uncommitted, dirty state of the database (causing the `before` state to equal the `after` state). 

This middleware solves that by using the new Prisma 8 `beforeEncode` and `activityEnded` lifecycle hooks. It pre-fetches the `before` state on a **separate connection**, ensuring perfect `before` and `after` diffs, even inside transactions.

## Key Features
- **Transaction-Safe:** Correctly captures the `before` state inside `$transaction` blocks.
- **Diff-Aware:** Captures exact `before` and `after` arrays for `CREATE`, `UPDATE`, and `DELETE`.
- **Fire-and-Forget:** Writes to the database asynchronously using `setImmediate`, so your business queries are never blocked.
- **Bulk-Aware:** Handles `updateMany` and `deleteMany` by pre-fetching all affected rows via the SQL AST.

## Usage

Because audit logs must read the committed state, you must pass a **separate, clean Prisma client** (without the middleware attached) to the `getDb` option. This prevents infinite recursion.

```typescript
import postgres from "@prisma/orm-postgres/runtime";
import { auditMiddleware } from "prisma-audit-middleware";

// Clean client for auditing
const auditDb = postgres({ contract, url: process.env.DATABASE_URL! });

// Main client with middleware
export const db = postgres({
  contract,
  url: process.env.DATABASE_URL!,
  middleware: [
    auditMiddleware({
      getDb: () => auditDb,
      getActorId: () => "user-123",
      onAudit: async (event) => {
        await auditDb.orm.public.AuditLog.create({
          action: event.action,
          model: event.model,
          actorId: event.actorId,
          before: event.before,
          after: event.after,
          timestamp: event.timestamp.toISOString(),
        });
      },
    }),
  ],
});

```

## Now, you can write standard Prisma queries, and the audit logs will be generated automatically:

```ts
// This triggers an automatic CREATE audit log
await db.orm.public.User.create({
  email: "tejas@example.com",
  username: "tejas"
});

// This triggers an automatic UPDATE audit log with perfect before/after diffs,
// even when wrapped inside a transaction!
await db.transaction(async (tx) => {
  await tx.orm.public.User.where({ id: userId }).update({
    name: "tejas rai"
  });
});

```

## Options

The auditMiddleware function accepts the following configuration object:

getDb (Required): A function that returns a clean Prisma client (without the middleware attached). Used to pre-fetch the before state and write the audit logs.

onAudit (Required): The callback function fired when an audit log is ready to be saved. Receives the AuditEvent object.

getActorId: A function returning the current user's ID (e.g., from your auth context). Defaults to undefined.

excludeModels: An array of model names to ignore. Defaults to ["AuditLog"] to prevent infinite loops.

## License
ISC