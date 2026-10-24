import 'dotenv/config';
import postgres from '@prisma/orm-postgres/runtime';
import { contractFromJson } from '@prisma/orm-postgres/static';
import { auditMiddleware ,type AuditEvent} from '../../../../../src/index';
import type { Contract } from './contract.d';
import contractJson from './contract.json' with { type: 'json' };

const contract = contractFromJson<Contract>(contractJson);

// The Clean Client (No middleware - used for auditing and pre-fetching)
const baseDb = postgres({ contract, url: process.env.DATABASE_URL! });

// The Main Client (With middleware - used for business logic)
export const db = postgres({
  contract,
  url: process.env.DATABASE_URL!,
  middleware: [
    auditMiddleware({
      getDb: () => baseDb,
      getActorId: () => "admin-user-99",
      onAudit: async (event:AuditEvent) => {
          console.log("INSERTING AUDIT LOG:", event);
        await baseDb.orm.public.AuditLog.create({
          action: event.action,
          model: event.model,
          actorId: event.actorId ?? null,
          before: event.before as any,
          after: event.after as any,
          timestamp: event.timestamp.toISOString(),
        });
        console.log(`[Audit] Logged ${event.action} on ${event.model}`);
      },
    }),
  ],
});