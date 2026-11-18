import { asc } from "drizzle-orm";
import type { Db } from "../src/db/client.js";
import { appUser } from "../src/db/schema.js";

/** The user the migration creates on a fresh database; tests seed their data as this user. */
export async function ownerUserId(db: Db): Promise<string> {
  const [row] = await db
    .select({ id: appUser.id })
    .from(appUser)
    .orderBy(asc(appUser.createdAt))
    .limit(1);
  if (!row) throw new Error("migrations created no user");
  return row.id;
}
