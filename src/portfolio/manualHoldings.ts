import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { manualHolding } from "../db/schema.js";
import type { SecurityCatalog } from "./securityCatalog.js";

// Investments no data source can reach, such as Treasuries held at TreasuryDirect. The owner
// enters each one's value by hand, in one asset class, and updates it now and then. Owner side
// only; agents read them through row-level security.

const VALUE = /^\d{1,15}(\.\d{1,4})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function setManualHolding(
  db: Db,
  catalog: SecurityCatalog,
  userId: string,
  h: { name: string; assetClass: string; value: string; asOf: string },
): Promise<void> {
  const name = h.name.trim();
  if (!name || name.length > 100) throw new Error("name must be 1 to 100 characters");
  if (!(h.assetClass in catalog.classes)) {
    throw new Error(
      `unknown asset class ${h.assetClass}; one of ${Object.keys(catalog.classes).join(", ")}`,
    );
  }
  if (!VALUE.test(h.value)) throw new Error("value must be a decimal string like 30000.00");
  if (!DATE.test(h.asOf) || Number.isNaN(Date.parse(h.asOf))) {
    throw new Error("as-of must be a date like 2026-11-06");
  }
  await db
    .insert(manualHolding)
    .values({ userId, name, assetClass: h.assetClass, value: h.value, asOf: h.asOf })
    .onConflictDoUpdate({
      target: [manualHolding.userId, manualHolding.name],
      set: { assetClass: h.assetClass, value: h.value, asOf: h.asOf, updatedAt: new Date() },
    });
}

export async function removeManualHolding(db: Db, userId: string, name: string): Promise<boolean> {
  const gone = await db
    .delete(manualHolding)
    .where(and(eq(manualHolding.userId, userId), eq(manualHolding.name, name.trim())))
    .returning({ id: manualHolding.id });
  return gone.length > 0;
}

/** Names, classes and dates only: values stay out of listings. */
export async function listManualHoldings(db: Db, userId: string) {
  return db
    .select({
      name: manualHolding.name,
      assetClass: manualHolding.assetClass,
      asOf: manualHolding.asOf,
    })
    .from(manualHolding)
    .where(eq(manualHolding.userId, userId))
    .orderBy(manualHolding.name);
}
