import 'dotenv/config';
import { db } from './db';

async function main() {
  // generate a random email so the test never fails on duplicates
  const randomId = Math.floor(Math.random() * 100000);
  const testEmail = `audit-${randomId}@test.com`;

  console.log(`1. Creating User (${testEmail})...`);
  const user = await db.orm.public.User.create({
    email: testEmail,
    username: `audit-master-${randomId}`,
    name: "Original Name",
  });

  console.log("2. Updating User inside a $transaction...");
  await db.transaction(async (tx) => {
    await tx.orm.public.User.where({ id: user.id }).update({
      name: "Updated In Transaction",
    });
  });

  // wait 1 second for the async setImmediate to flush the audit log
  await new Promise(r => setTimeout(r, 1000));
  console.log("Done! Check the AuditLog table.");
}

main()
  .catch(console.error)
  .finally(() => db.close());