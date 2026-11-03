import "dotenv/config";
import postgres from "@prisma/orm-postgres/runtime";
import { contractFromJson } from "@prisma/orm-postgres/static";
import { auditMiddleware, type AuditEvent } from "prisma-orm-extension-audit";
import type { Contract } from "./contract.d";
import contractJson from "./contract.json" with { type: "json" };

const contract = contractFromJson<Contract>(contractJson);

async function main() {
  const id = Date.now();

  async function settle(
    audit: ReturnType<typeof auditMiddleware>
  ): Promise<void> {
    await new Promise<void>((r) => setImmediate(r));
    await audit.flush();
  }

  function expect(cond: unknown, msg: string): void {
    if (!cond) throw new Error(msg);
  }

  // Reusable sink — Array.push returns number, but onAudit accepts
  // void | Promise<void>, so a block-bodied arrow keeps the type happy.
  const collect =
    (arr: AuditEvent[]) =>
    (entry: AuditEvent): void => {
      arr.push(entry);
    };

  // 1: INSERT
  console.log("Testing INSERT...");
  {
    const auditLogs: AuditEvent[] = [];
    const audit = auditMiddleware({
      getActorId: () => "admin-123",
      excludeTables: ["AuditLog"],
      onAudit: collect(auditLogs),
    });
    const db = postgres({
      contract,
      url: process.env.DATABASE_URL!,
      middleware: [audit.middleware],
    });

    try {
      const user = await db.orm.public.User.create({
        email: `a-${id}@test.com`,
        username: `a-${id}`,
      });
      await settle(audit);

      expect(
        auditLogs.length === 1,
        `INSERT expected 1 event, got ${auditLogs.length}`
      );
      const ins = auditLogs[0];
      expect(ins.statement === "insert", `not insert (got ${ins.statement})`);
      expect(ins.table === "User", `wrong table: ${ins.table}`);
      expect(ins.rows.length > 0, "no RETURNING rows captured");
      expect(ins.outcome === "committed", `not committed (got ${ins.outcome})`);
      expect(!!ins.activityId, "activityId missing");
      expect(typeof ins.sql === "string" && ins.sql.length > 0, "sql missing");
      expect(
        ins.actorId === "admin-123",
        `actorId not propagated: ${ins.actorId}`
      );
      expect(!!user.id, "write did not return a row");
      console.log("INSERT", {
        rows: ins.rows.length,
        sql: ins.sql.slice(0, 40) + "…",
      });
    } finally {
      await audit.flush();
      await db.close();
    }
  }

  // 2: UPDATE
  console.log("Testing UPDATE...");
  {
    const auditLogs: AuditEvent[] = [];
    const audit = auditMiddleware({
      getActorId: () => "admin-123",
      excludeTables: ["AuditLog"],
      onAudit: collect(auditLogs),
    });
    const db = postgres({
      contract,
      url: process.env.DATABASE_URL!,
      middleware: [audit.middleware],
    });

    try {
      const user = await db.orm.public.User.create({
        email: `u-${id}@test.com`,
        username: `u-${id}`,
      });
      await settle(audit);
      auditLogs.length = 0;

      await db.orm.public.User.where({ id: user.id }).update({
        name: "Updated",
      });
      await settle(audit);

      expect(
        auditLogs.length === 1,
        `UPDATE expected 1 event, got ${auditLogs.length}`
      );
      const upd = auditLogs[0];
      expect(upd.statement === "update", `not update (got ${upd.statement})`);
      expect(upd.table === "User", `wrong table: ${upd.table}`);
      expect(upd.outcome === "committed", `not committed (got ${upd.outcome})`);
      console.log("UPDATE");
    } finally {
      await audit.flush();
      await db.close();
    }
  }

  // 3: DELETE
  console.log("Testing DELETE...");
  {
    const auditLogs: AuditEvent[] = [];
    const audit = auditMiddleware({
      getActorId: () => "admin-123",
      excludeTables: ["AuditLog"],
      onAudit: collect(auditLogs),
    });
    const db = postgres({
      contract,
      url: process.env.DATABASE_URL!,
      middleware: [audit.middleware],
    });

    try {
      const user = await db.orm.public.User.create({
        email: `d-${id}@test.com`,
        username: `d-${id}`,
      });
      await settle(audit);
      auditLogs.length = 0;

      await db.orm.public.User.where({ id: user.id }).delete();
      await settle(audit);

      expect(
        auditLogs.length === 1,
        `DELETE expected 1 event, got ${auditLogs.length}`
      );
      const del = auditLogs[0];
      expect(del.statement === "delete", `not delete (got ${del.statement})`);
      expect(del.table === "User", `wrong table: ${del.table}`);
      expect(del.outcome === "committed", `not committed (got ${del.outcome})`);
      console.log("DELETE");
    } finally {
      await audit.flush();
      await db.close();
    }
  }

  // 4: ROLLBACK — must NOT emit
  console.log("Testing ROLLBACK (must NOT emit)...");
  {
    const auditLogs: AuditEvent[] = [];
    const audit = auditMiddleware({
      getActorId: () => "admin-123",
      excludeTables: ["AuditLog"],
      onAudit: collect(auditLogs),
    });
    const db = postgres({
      contract,
      url: process.env.DATABASE_URL!,
      middleware: [audit.middleware],
    });

    try {
      try {
        await db.transaction(async (tx) => {
          await tx.orm.public.User.create({
            email: `r-${id}@test.com`,
            username: `r-${id}`,
          });
          throw new Error("intentional rollback");
        });
      } catch {
        /* expected */
      }
      await settle(audit);

      expect(
        auditLogs.length === 0,
        `ROLLBACK leaked ${auditLogs.length} event(s)`
      );
      console.log(" ROLLBACK suppressed");
    } finally {
      await audit.flush();
      await db.close();
    }
  }

  // Test 5: CONCURRENT WRITER
  console.log("Testing CONCURRENT WRITER (5 parallel creates)...");
  {
    const auditLogs: AuditEvent[] = [];
    const errors: unknown[] = [];
    const audit = auditMiddleware({
      getActorId: () => "admin-123",
      excludeTables: ["AuditLog"],
      onAudit: collect(auditLogs),
      onError: (e) => {
        errors.push(e);
      },
    });
    const db = postgres({
      contract,
      url: process.env.DATABASE_URL!,
      middleware: [audit.middleware],
    });

    try {
      await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          db.orm.public.User.create({
            email: `c-${i}-${id}@test.com`,
            username: `c-${i}-${id}`,
          })
        )
      );
      await settle(audit);

      expect(errors.length === 0, `concurrent errors: ${errors.length}`);
      expect(
        auditLogs.length === 5,
        `CONCURRENT expected 5 events, got ${auditLogs.length}`
      );
      const ids = new Set(auditLogs.map((e) => e.activityId));
      expect(
        ids.size === 5,
        `expected 5 distinct activityIds, got ${ids.size}`
      );
      console.log("CONCURRENT WRITER (5 events, 5 distinct activityIds)");
    } finally {
      await audit.flush();
      await db.close();
    }
  }

  // Test 6: NESTED WRITE
  console.log("Testing NESTED WRITE (parent + 2 children in a tx)...");
  {
    const auditLogs: AuditEvent[] = [];
    const errors: unknown[] = [];
    const audit = auditMiddleware({
      getActorId: () => "admin-123",
      excludeTables: ["AuditLog"],
      onAudit: collect(auditLogs),
      onError: (e) => {
        errors.push(e);
      },
    });
    const db = postgres({
      contract,
      url: process.env.DATABASE_URL!,
      middleware: [audit.middleware],
    });

    try {
      await db.transaction(async (tx) => {
        const u = await tx.orm.public.User.create({
          email: `n-${id}@test.com`,
          username: `n-${id}`,
        });
        await tx.orm.public.Post.create({ title: "Nested P1", authorId: u.id });
        await tx.orm.public.Post.create({ title: "Nested P2", authorId: u.id });
      });
      await settle(audit);

      expect(errors.length === 0, `nested errors: ${errors.length}`);
      expect(
        auditLogs.length === 3,
        `NESTED expected 3 events, got ${auditLogs.length}`
      );

      const withParent = auditLogs.filter(
        (e) => e.parentActivityId !== undefined
      );
      expect(
        withParent.length === 3,
        `NESTED expected all 3 statements to have parents, got ${withParent.length}`
      );

      const statementIds = new Set(auditLogs.map((e) => e.activityId));
      for (const e of auditLogs) {
        if (e.parentActivityId !== undefined) {
          expect(
            !statementIds.has(e.parentActivityId),
            "NESTED parent must be transaction/ORM call, not a statement"
          );
        }
      }

      const tables = new Set(auditLogs.map((e) => e.table));
      expect(tables.has("User"), "nested User insert not captured");
      expect(tables.has("Post"), "nested Post insert not captured");

      const uniqueParents = new Set(
        auditLogs
          .map((e) => e.parentActivityId)
          .filter((p): p is string => p !== undefined)
      );
      console.log(
        `NESTED WRITE (3 events, ${uniqueParents.size} unique parent(s), tables: ${[...tables].join(", ")})`
      );
    } finally {
      await audit.flush();
      await db.close();
    }
  }

  // 7: REDACT — PII must not reach onAudit
  console.log("Testing REDACT (PII scrubbing)...");
  {
    const auditLogs: AuditEvent[] = [];
    const audit = auditMiddleware({
      getActorId: () => "admin-123",
      excludeTables: ["AuditLog"],
      onAudit: collect(auditLogs),
      redact: (e) => ({
        ...e,
        // params are primitives in column order — match by value.
        params: e.params.map((p) =>
          typeof p === "string" && p.includes("redact-") ? "[REDACTED]" : p
        ),
        // rows are objects — redact by key.
        rows: e.rows.map((row) => ({
          ...row,
          email: "[REDACTED]",
          username: "[REDACTED]",
        })),
      }),
    });
    const db = postgres({
      contract,
      url: process.env.DATABASE_URL!,
      middleware: [audit.middleware],
    });

    try {
      await db.orm.public.User.create({
        email: `redact-${id}@test.com`,
        username: `redact-${id}`,
      });
      await settle(audit);

      expect(auditLogs.length === 1, "REDACT expected 1 event");
      const paramsRaw = JSON.stringify(auditLogs[0].params);
      const rowsRaw = JSON.stringify(auditLogs[0].rows);

      expect(
        !paramsRaw.includes(`redact-${id}@test.com`),
        "REDACT: email leaked in params"
      );
      expect(
        !rowsRaw.includes(`redact-${id}@test.com`),
        "REDACT: email leaked in rows"
      );
      expect(paramsRaw.includes("[REDACTED]"), "REDACT: no marker in params");
      expect(rowsRaw.includes("[REDACTED]"), "REDACT: no marker in rows");
      console.log("REDACT (params and rows both scrubbed)");
    } finally {
      await audit.flush();
      await db.close();
    }
  }

  // 8: onError fires when onAudit throws
  console.log("Testing ON_ERROR (sink failure)...");
  {
    const capturedErrors: unknown[] = [];
    const audit = auditMiddleware({
      onAudit: () => {
        throw new Error("sink down");
      },
      onError: (e) => {
        capturedErrors.push(e);
      },
    });
    const db = postgres({
      contract,
      url: process.env.DATABASE_URL!,
      middleware: [audit.middleware],
    });

    try {
      const user = await db.orm.public.User.create({
        email: `err-${id}@test.com`,
        username: `err-${id}`,
      });
      await settle(audit);

      expect(
        capturedErrors.length === 1,
        `onError expected 1, got ${capturedErrors.length}`
      );
      expect(!!user.id, "write failed despite audit error");
      console.log("ON_ERROR (onError fired, write still succeeded)");
    } finally {
      await audit.flush();
      await db.close();
    }
  }

  // Test 9: excludeTables — AuditLog self-write emits nothing ──
  console.log("Testing EXCLUDE_TABLES (AuditLog self-write)...");
  {
    const auditLogs: AuditEvent[] = [];
    const audit = auditMiddleware({
      getActorId: () => "admin-123",
      excludeTables: ["AuditLog"],
      onAudit: collect(auditLogs),
    });
    const db = postgres({
      contract,
      url: process.env.DATABASE_URL!,
      middleware: [audit.middleware],
    });

    try {
      await db.orm.public.AuditLog.create({
        table: "User",
        statement: "insert",
        sql: "manual",
        params: [],
        rows: [],
        activityId: "manual",
        outcome: "committed",
        timestamp: new Date().toISOString(),
      });
      await settle(audit);

      expect(
        auditLogs.length === 0,
        `EXCLUDE_TABLES leaked ${auditLogs.length} event(s)`
      );
      console.log("EXCLUDE_TABLES (no recursion)");
    } finally {
      await audit.flush();
      await db.close();
    }
  }

  // 10: UPSERT recorded as "insert"
  console.log("Testing UPSERT (must map to insert)...");
  {
    const auditLogs: AuditEvent[] = [];
    const audit = auditMiddleware({
      getActorId: () => "admin-123",
      excludeTables: ["AuditLog"],
      onAudit: collect(auditLogs),
    });
    const db = postgres({
      contract,
      url: process.env.DATABASE_URL!,
      middleware: [audit.middleware],
    });

    try {
      await db.orm.public.User.where({ email: `upsert-${id}@test.com` }).upsert(
        {
          create: { email: `upsert-${id}@test.com`, username: `upsert-${id}` },
          update: { username: `upsert-${id}-updated` },
        }
      );
      await settle(audit);

      expect(
        auditLogs.length === 1,
        `UPSERT expected 1 event, got ${auditLogs.length}`
      );
      expect(
        auditLogs[0].statement === "insert",
        `UPSERT must map to "insert", got "${auditLogs[0].statement}"`
      );
      console.log("UPSERT recorded as insert");
    } finally {
      await audit.flush();
      await db.close();
    }
  }

  // 11: FLUSH awaits a slow in-flight write
  console.log("Testing FLUSH with slow sink...");
  {
    const state = { settled: false };
    const audit = auditMiddleware({
      onAudit: async () => {
        await new Promise((r) => setTimeout(r, 200));
        state.settled = true;
      },
    });
    const db = postgres({
      contract,
      url: process.env.DATABASE_URL!,
      middleware: [audit.middleware],
    });

    try {
      await db.orm.public.User.create({
        email: `flush-${id}@test.com`,
        username: `flush-${id}`,
      });

      await audit.flush();
      expect(state.settled === true, "flush did not await the in-flight write");
      console.log("FLUSH awaited slow sink");
    } finally {
      await audit.flush();
      await db.close();
    }
  }

  // 12: getActorId throws → write is stopped
  console.log("Testing GET_ACTOR_ID failure...");
  {
    const auditLogs: AuditEvent[] = [];
    const audit = auditMiddleware({
      getActorId: () => {
        throw new Error("no actor");
      },
      excludeTables: ["AuditLog"],
      onAudit: collect(auditLogs),
    });
    const db = postgres({
      contract,
      url: process.env.DATABASE_URL!,
      middleware: [audit.middleware],
    });

    try {
      let writeFailed = false;
      try {
        await db.orm.public.User.create({
          email: `actor-${id}@test.com`,
          username: `actor-${id}`,
        });
      } catch {
        writeFailed = true;
      }
      await audit.flush().catch(() => {});

      expect(
        writeFailed === true,
        "write should have been stopped by getActorId error"
      );
      expect(auditLogs.length === 0, "no audit event should be emitted");
      console.log("GET_ACTOR_ID failure stopped the write");
    } finally {
      await audit.flush().catch(() => {});
      await db.close();
    }
  }

  // 13: RAW SQL recorded as opaque
  // The framework treats raw SQL as a black box (kind: "raw-query",
  // no ast.table.name, no SQL parsing). We record it as:
  //   statement: "raw", table: "unknown", sql + params captured.
  // If this test fails with "got 0 events", the framework may not be
  // firing beforeEncode for raw ASTs — that would be a real finding.
  console.log("Testing RAW SQL (recorded as opaque)...");
  {
    const auditLogs: AuditEvent[] = [];
    const errors: unknown[] = [];
    const audit = auditMiddleware({
      getActorId: () => "admin-123",
      excludeTables: ["AuditLog"],
      onAudit: collect(auditLogs),
      onError: (e) => {
        errors.push(e);
      },
    });
    const db = postgres({
      contract,
      url: process.env.DATABASE_URL!,
      middleware: [audit.middleware],
    });

    try {
      // @onCreate(uuid()) is an ORM-level default, not a DB DEFAULT.
      // Raw SQL bypasses it, so `id` must be supplied explicitly.
      const rawId = crypto.randomUUID();
      const rawEmail = `raw-${id}@test.com`;
      const rawUsername = `raw-${id}`;

      await db.runtime().execute(
        db.raw.sql`
          INSERT INTO "public"."User" ("id", "email", "username")
          VALUES (${rawId}, ${rawEmail}, ${rawUsername})
        `
          .affectedCount()
          .build()
      );
      await settle(audit);

      if (errors.length > 0) {
        throw new Error(
          `RAW: sink reported ${errors.length} error(s): ${String(errors[0])}`
        );
      }

      expect(
        auditLogs.length === 1,
        `RAW expected 1 event, got ${auditLogs.length}`
      );
      const raw = auditLogs[0];
      expect(
        raw.statement === "raw",
        `RAW not classified as raw (got ${raw.statement})`
      );
      expect(
        raw.table === "unknown",
        `RAW table should be "unknown" (got ${raw.table})`
      );
      expect(raw.sql.includes("INSERT INTO"), "RAW sql text missing");
      expect(
        raw.params.length === 3,
        `RAW expected 3 params, got ${raw.params.length}`
      );
      expect(
        raw.outcome === "committed",
        `RAW not committed (got ${raw.outcome})`
      );
      expect(
        raw.actorId === "admin-123",
        `RAW actorId missing: ${raw.actorId}`
      );
      console.log("RAW recorded as opaque", {
        table: raw.table,
        statement: raw.statement,
        params: raw.params.length,
      });
    } finally {
      await audit.flush();
      await db.close();
    }
  }

  // 13b: raw SELECT — should it be audited?
  console.log("Testing RAW SELECT (noise check)...");
  {
    const auditLogs: AuditEvent[] = [];
    const audit = auditMiddleware({
      excludeTables: ["AuditLog"],
      onAudit: collect(auditLogs),
    });
    const db = postgres({
      contract,
      url: process.env.DATABASE_URL!,
      middleware: [audit.middleware],
    });

    try {
      await db.runtime().execute(db.raw.sql`SELECT 1`.affectedCount().build());
      await settle(audit);

      console.log(
        `  ${auditLogs.length === 0 ? "clean" : "Noise"} RAW SELECT emitted ${auditLogs.length} event(s)`
      );
      if (auditLogs.length > 0) {
        console.log(
          `statement=${auditLogs[0].statement}, table=${auditLogs[0].table}`
        );
        console.log("every raw read will pollute the audit trail");
      }
    } finally {
      await audit.flush();
      await db.close();
    }
  }

  console.log("\n ALL TESTS PASSED (13/13)");
}

main().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
