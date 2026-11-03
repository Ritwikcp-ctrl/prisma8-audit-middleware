import "dotenv/config";
import postgres from "@prisma/orm-postgres/runtime";
import { contractFromJson } from "@prisma/orm-postgres/static";
import { auditMiddleware } from "prisma-orm-extension-audit";
import type { Contract } from "./contract.d";
import contractJson from "./contract.json" with { type: "json" };

const contract = contractFromJson<Contract>(contractJson);

const auditDb = postgres({
  contract,
  url: process.env.DATABASE_URL!,
});

export const audit = auditMiddleware({
  getActorId: () => "admin-user-99",
  excludeTables: ["AuditLog"],
  onAudit: async (entry) => {
    await auditDb.orm.public.AuditLog.create({
      table: entry.table,
      statement: entry.statement,
      sql: entry.sql,
      params: entry.params as any,
      rows: entry.rows as any,
      actorId: entry.actorId ?? null,
      activityId: entry.activityId,
      parentActivityId: entry.parentActivityId ?? null,
      outcome: entry.outcome,
      timestamp: new Date().toISOString(),
    });
  },
  onError: (err) => {
    console.error("[Audit] sink failed:", err);
  },
  redact: (entry) => {
    // Strip password-like fields before they reach the sink.
    const redacted = {
      ...entry,
      params: entry.params.map((p) => {
        if (typeof p === "object" && p !== null && "password" in p) {
          return { ...p, password: "[REDACTED]" };
        }
        return p;
      }),
    };
    return redacted;
  },
});

export const db = postgres({
  contract,
  url: process.env.DATABASE_URL!,
  middleware: [audit.middleware],
});

// Call this in your shutdown handler, before db.close():
export const closeDb = async () => {
  await audit.flush();
  await db.close();
  await auditDb.close();
};