import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { account, depositChoice } from "../db/schema.js";
import type { Catalog } from "./catalog.js";
import { CANDIDATES } from "./compare.js";

/**
 * Records where the owner wants a cash account's spare money to go (a deposit product from the
 * catalog), or clears the pick with null so Tidysum suggests the best-paying one again. Owner side
 * only: the account must be the user's own cash account, and the product one that could take its
 * money.
 */
export async function setDepositChoice(
  db: Db,
  catalog: Catalog,
  userId: string,
  accountId: string,
  productId: string | null,
): Promise<void> {
  const [acct] = await db
    .select({ type: account.type, subtype: account.subtype })
    .from(account)
    .where(and(eq(account.id, accountId), eq(account.userId, userId)));
  if (acct?.type !== "depository") throw new Error(`no cash account ${accountId}`);
  if (productId === null) {
    await db
      .delete(depositChoice)
      .where(and(eq(depositChoice.accountId, accountId), eq(depositChoice.userId, userId)));
    return;
  }
  const product = catalog.products.find((p) => p.id === productId);
  if (!product)
    throw new Error(`unknown product id ${productId}; see catalog/deposit-products.json`);
  const kinds = CANDIDATES[acct.subtype ?? ""] ?? [];
  if (!kinds.includes(product.kind)) {
    throw new Error(`${product.name} can't take the money in a ${acct.subtype ?? "cash"} account`);
  }
  await db
    .insert(depositChoice)
    .values({ accountId, userId, productId })
    .onConflictDoUpdate({
      target: depositChoice.accountId,
      set: { productId, setAt: new Date() },
    });
}
