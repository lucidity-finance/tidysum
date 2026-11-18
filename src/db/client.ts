import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  close(): Promise<void>;
}

export function connect(databaseUrl: string): DbHandle {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
  return { db: drizzle(pool, { schema }), close: () => pool.end() };
}

const migrationsFolder = new URL("../../drizzle", import.meta.url).pathname;

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder });
}
