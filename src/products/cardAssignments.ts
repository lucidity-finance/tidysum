import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { account, cardAssignment } from "../db/schema.js";
import type { CardCatalog } from "./cardCatalog.js";

/**
 * Records which catalog card an account is, or clears it with null. Owner side only: the account
 * must be the user's own, and the card in the catalog and of the account's kind (a credit card
 * for a credit account, a debit card such as PayPal Debit for a bank or wallet account).
 */
export async function setCardAssignment(
  db: Db,
  catalog: CardCatalog,
  userId: string,
  accountId: string,
  cardId: string | null,
): Promise<void> {
  const [acct] = await db
    .select({ type: account.type })
    .from(account)
    .where(and(eq(account.id, accountId), eq(account.userId, userId)));
  if (acct?.type !== "credit" && acct?.type !== "depository") {
    throw new Error(`no card account ${accountId}`);
  }
  if (cardId === null) {
    await db.delete(cardAssignment).where(eq(cardAssignment.accountId, accountId));
    return;
  }
  const card = catalog.cards.find((c) => c.id === cardId);
  if (!card) throw new Error(`unknown card id ${cardId}; see catalog/credit-cards.json`);
  const kind = acct.type === "credit" ? "credit" : "debit";
  if (card.kind !== kind) {
    throw new Error(
      `${card.name} is a ${card.kind} card, but ${accountId} is a ${acct.type} account`,
    );
  }
  await db
    .insert(cardAssignment)
    .values({ accountId, userId, cardId })
    .onConflictDoUpdate({
      target: cardAssignment.accountId,
      set: { cardId, setAt: new Date() },
    });
}
