import type { SqlMiddleware } from "@prisma/orm-postgres/family-runtime";

export interface AuditEvent {
  /**
   * Physical table name from the SQL statement.
   * `"unknown"` for raw statements — the table exists only in the SQL text.
   */
  table: string;
  /**
   * Statement kind. `upsert` is recorded as `"insert"` (INSERT … ON CONFLICT).
   * Raw SQL and query-builder statements are recorded as `"raw"` — they cannot
   * be classified further without parsing SQL, which the runtime does not do.
   */
  statement: "insert" | "update" | "delete" | "raw";

  sql: string;

  params: readonly unknown[];

  rows: Record<string, unknown>[];

  actorId: string | undefined;

  activityId: string;

  parentActivityId: string | undefined;

  outcome: "committed" | "unknown";
}

export interface AuditMiddlewareOptions {
  /** Called in beforeEncode. Throw to abort the write before it runs. */
  getActorId?: () => string | undefined;

  excludeTables?: readonly string[];

  onAudit: (entry: AuditEvent) => void | Promise<void>;

  onError?: (error: unknown) => void;
  /** Redact PII before the entry reaches onAudit. Return a new entry. */
  redact?: (entry: AuditEvent) => AuditEvent | Promise<AuditEvent>;
}

export interface AuditMiddlewareHandle {
  middleware: SqlMiddleware;
  flush: () => Promise<void>;
}

const AUDIT_KEY = Symbol("prisma-audit");

interface AuditState {
  myActivityId?: string;
  parentActivityId?: string;
  entry?: AuditEvent;
}

interface StatementAst {
  kind?: string;
  table?: { name?: string };
}

interface ParentContext {
  id?: string;
  activity?: { id?: string };
  state?: (key: symbol) => unknown;
}

interface MiddlewareCtx {
  parent?: ParentContext;
  log?: { error?: (payload: Record<string, unknown>) => void };
}

export function auditMiddleware(
  options: AuditMiddlewareOptions
): AuditMiddlewareHandle {
  const pending = new Set<Promise<void>>();

  const middleware: SqlMiddleware = {
    name: "audit",
    familyId: "sql",

    // Capture parent linkage at start
    // The parent's activityStarted runs first, so its state already carries
    // myActivityId. ctx.parent.id is not populated for statement activities
    // in rc.21, so the state-based lookup is the reliable path.
    async activityStarted(activity, ctx) {
      const state = ctx.state(AUDIT_KEY) as AuditState;
      state.myActivityId = activity.id;

      const parentCtx = (ctx as MiddlewareCtx).parent;
      if (!parentCtx) return;

      let parentId: string | undefined = parentCtx.id ?? parentCtx.activity?.id;

      if (!parentId && typeof parentCtx.state === "function") {
        try {
          const parentState = parentCtx.state(AUDIT_KEY) as
            AuditState | undefined;
          parentId = parentState?.myActivityId;
        } catch {
          /*parentId stays undefined */
        }
      }

      state.parentActivityId = parentId;
    },

    //Capture the statement before it is sent
    async beforeEncode(plan, ctx) {
      const ast = plan.ast as StatementAst | undefined;
      const kind = ast?.kind;
      const state = ctx.state(AUDIT_KEY) as AuditState;
      const excludeTables = options.excludeTables ?? ["AuditLog"];

      // ORM-built write with a structured AST
      if (kind === "insert" || kind === "update" || kind === "delete") {
        const table = ast?.table?.name;
        if (!table) return;
        if (excludeTables.includes(table)) return;

        state.entry = {
          table,
          statement: kind,
          sql: plan.sql,
          params: plan.params ?? [],
          rows: [],
          actorId: options.getActorId?.(),
          activityId: "",
          parentActivityId: state.parentActivityId,
          outcome: "unknown",
        };
        return;
      }

      // Raw statement — the framework treats the SQL as a black box
      // (ADR 012 / ADR 247). Record it as opaque rather than dropping it.
      if (kind === "raw-query") {
        state.entry = {
          table: "unknown",
          statement: "raw",
          sql: plan.sql,
          params: plan.params ?? [],
          rows: [],
          actorId: options.getActorId?.(),
          activityId: "",
          parentActivityId: state.parentActivityId,
          outcome: "unknown",
        };
      }
    },

    // Buffer RETURNING rows
    async onRow(row, _plan, ctx) {
      const state = ctx.state(AUDIT_KEY) as AuditState;
      state.entry?.rows.push(row as Record<string, unknown>);
    },

    // Emit after effects are final
    async activityFinalized(activity, result, ctx) {
      if (activity.kind !== "statement") return;
      if (result.outcome === "rolled-back") return;

      const state = ctx.state(AUDIT_KEY) as AuditState;
      const captured = state.entry;
      if (!captured) return;
      state.entry = undefined;

      const parentActivityId =
        captured.parentActivityId ??
        state.parentActivityId ??
        (ctx as MiddlewareCtx).parent?.id ??
        (ctx as MiddlewareCtx).parent?.activity?.id;

      const entry: AuditEvent = {
        ...captured,
        activityId: activity.id,
        parentActivityId,
        outcome: result.outcome === "committed" ? "committed" : "unknown",
      };

      const write: Promise<void> = (async () => {
        try {
          const redacted = options.redact ? await options.redact(entry) : entry;
          await options.onAudit(redacted);
        } catch (error) {
          (ctx as MiddlewareCtx).log?.error?.({
            event: "audit.write.failed",
            error,
          });
          options.onError?.(error);
        }
      })();

      pending.add(write);
      void write.finally(() => pending.delete(write));
    },
  };

  return {
    middleware,
    flush: async (): Promise<void> => {
      while (pending.size > 0) {
        await Promise.all([...pending]);
      }
    },
  };
}
