import type { SqlMiddleware } from "@prisma/orm-postgres/family-runtime";

export interface AuditEvent {
  action: "CREATE" | "UPDATE" | "DELETE";
  model: string;
  actorId?: string;
  before: unknown[];
  after: unknown[];
  timestamp: Date;
}

export interface AuditMiddlewareOptions {
  getActorId?: () => string | undefined;
  getDb: () => any;
  onAudit: (event: AuditEvent) => Promise<void> | void;
  excludeModels?: string[];
}

function extractWhere(expr: any): any {
  if (!expr) return undefined;
  if (expr.kind === "binary") {
    const col = expr.left?.column;
    const val = expr.right?.value;
    if (col && val !== undefined) {
      if (expr.op === "eq") return { [col]: val };
    }
  }
  return undefined;
}

export function auditMiddleware(
  options: AuditMiddlewareOptions
): SqlMiddleware {
  const {
    getActorId = () => undefined,
    getDb,
    onAudit,
    excludeModels = ["AuditLog"],
  } = options;

  // use WeakMap to link object references (ctx) across hooks
  const pendingAudits = new WeakMap<
    object,
    { action: string; model: string; before: unknown[] }
  >();

  return {
    name: "audit-middleware",
    familyId: "sql",

    async beforeEncode(plan, ctx) {
      const ast = (plan as any).ast;
      if (!ast) return;

      let model = "Unknown";
      let action = "UNKNOWN";

      if (ast.kind === "insert") {
        model = ast.table?.name;
        action = "CREATE";
      } else if (ast.kind === "update") {
        model = ast.table?.name;
        action = "UPDATE";
      } else if (ast.kind === "delete") {
        model = ast.table?.name;
        action = "DELETE";
      } else {
        return; // Ignore
      }

      if (excludeModels.includes(model)) return;

      let before: unknown[] = [];
      if (action === "UPDATE" || action === "DELETE") {
        const where = extractWhere(ast.where);
        if (where) {
          try {
            const db = getDb();
            before = await db.orm.public[model].where(where).all();
          } catch (err) {
            console.error(
              `[Audit] Failed to pre-fetch state for ${model}`,
              err
            );
          }
        }
      }

      const auditData = { action, model, before };

      // walk up the context tree and attach the data to ALL parent contexts
      let curr: any = ctx;
      while (curr) {
        pendingAudits.set(curr, auditData);
        curr = curr.parent;
      }
    },

    async activityEnded(activity, result, ctx) {
      // listen to "orm-call" to get the final ORM result objects
      if (activity.kind !== "orm-call") return;

      //retrieve the data from the WeakMap using the context object
      const auditData = pendingAudits.get(ctx as object);
      if (!auditData) return;

      if (result.outcome !== "succeeded") return;

      let after: unknown[] = [];
      if (auditData.action !== "DELETE") {
        const res = (result as any).result;
        if (res) after = Array.isArray(res) ? res : [res];
      }

      const event: AuditEvent = {
        action: auditData.action as any,
        model: auditData.model,
        actorId: getActorId(),
        before: auditData.before,
        after: after,
        timestamp: new Date(),
      };

      setImmediate(() => {
        Promise.resolve(onAudit(event)).catch((err) => {
          console.error("[Audit] Failed to flush audit log:", err);
        });
      });
    },
  };
}
