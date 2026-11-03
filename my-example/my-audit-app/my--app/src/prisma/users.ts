import { db } from "./db";
import { seed } from "./seed";

export { db };

export async function listUsers(limit = 10) {
  await seed();
  
  const users = await db.orm.public.User
    .select("id", "email", "username", "name")
    .limit(limit)
    .all();

  return users.map((user) => ({
    id: String(user.id),
    email: user.email,
    username: user.username,
    name: user.name ?? null,
  }));
}

export type StarterUser = Awaited<ReturnType<typeof listUsers>>[number];