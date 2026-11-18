import { and, arrayOverlaps, eq, inArray, or } from "drizzle-orm";
import type { TokenCipher } from "./crypto/tokenCipher.js";
import type { Db } from "./db/client.js";
import {
  account,
  appUser,
  auditEvent,
  item,
  itemSecret,
  misallocation,
  proposal,
  proposalAction,
} from "./db/schema.js";
import { SPENDING_WIDE } from "./misallocation/ledger.js";
import { PlaidApiError, type PlaidGateway } from "./plaid/gateway.js";
import { loadAccessToken } from "./sync/items.js";

// Decision 0002, principle 9: leaving is one step. Removing a connection revokes Tidysum's access
// at the aggregator and deletes everything synced from it; deleting a user does that for every
// connection and then deletes all of the user's data. audit_event is kept, evidence included, for
// at least 7 years (owner, 2026-10-30): it has no foreign keys, so it outlives what it logs.

/** Plaid answers these when the Item is already gone, which is what removing it wants. */
const ALREADY_REMOVED = new Set(["ITEM_NOT_FOUND", "INVALID_ACCESS_TOKEN"]);

async function revokeAtPlaid(db: Db, plaid: PlaidGateway, cipher: TokenCipher, itemId: string) {
  const [secret] = await db
    .select({ itemId: itemSecret.itemId })
    .from(itemSecret)
    .where(eq(itemSecret.itemId, itemId));
  if (!secret) return;
  try {
    await plaid.removeItem(await loadAccessToken(db, cipher, itemId));
  } catch (err) {
    if (!(err instanceof PlaidApiError && ALREADY_REMOVED.has(err.errorCode))) throw err;
  }
}

export interface RemovedItem {
  institution_name: string | null;
  accounts: number;
  /** Proposals that named one of its accounts. They can't execute any more. */
  proposals_deleted: number;
  /** Findings closed because the data behind them is gone, not because anything was fixed. */
  findings_withdrawn: number;
}

/**
 * Disconnects one Item: revokes it at Plaid (a CSV import has nothing to revoke), then deletes
 * it with its accounts, transactions, balances, holdings and liabilities. Findings that relied
 * on its data are withdrawn first, so the ledger never counts the missing data as money saved.
 */
export async function removeItem(
  db: Db,
  plaid: PlaidGateway,
  cipher: TokenCipher,
  userId: string,
  itemId: string,
  actor: string,
  now = new Date(),
): Promise<RemovedItem> {
  const [row] = await db
    .select()
    .from(item)
    .where(and(eq(item.id, itemId), eq(item.userId, userId)));
  if (!row) throw new Error(`no item ${itemId}`);
  if (row.source === "plaid") await revokeAtPlaid(db, plaid, cipher, row.id);

  return db.transaction(async (tx) => {
    const ids = (
      await tx.select({ id: account.id }).from(account).where(eq(account.itemId, row.id))
    ).map((a) => a.id);
    const audit = (event: string, data: object, proposalId?: string) =>
      tx
        .insert(auditEvent)
        .values({ userId, at: now, actor, event, data, ...(proposalId ? { proposalId } : {}) });

    const findings = await tx
      .select({ id: misallocation.id, key: misallocation.key, state: misallocation.state })
      .from(misallocation)
      .where(
        and(
          eq(misallocation.userId, userId),
          inArray(misallocation.state, ["open", "dismissed"]),
          or(
            ids.length ? arrayOverlaps(misallocation.accountIds, ids) : undefined,
            inArray(misallocation.detector, [...SPENDING_WIDE]),
          ),
        ),
      );
    for (const f of findings) {
      await tx
        .update(misallocation)
        .set({ state: "withdrawn", decidedAt: now })
        .where(eq(misallocation.id, f.id));
      await audit("misallocation.withdrawn", {
        misallocation_id: f.id,
        key: f.key,
        was: f.state,
        reason: "connection removed",
      });
    }

    const named = ids.length
      ? await tx
          .selectDistinct({ id: proposalAction.proposalId })
          .from(proposalAction)
          .where(
            and(
              eq(proposalAction.userId, userId),
              or(
                inArray(proposalAction.fromAccountId, ids),
                inArray(proposalAction.toAccountId, ids),
              ),
            ),
          )
      : [];
    for (const p of named) {
      await audit("proposal.deleted", { reason: "connection removed" }, p.id);
    }
    if (named.length) {
      await tx.delete(proposal).where(
        inArray(
          proposal.id,
          named.map((p) => p.id),
        ),
      );
    }

    await tx.delete(item).where(eq(item.id, row.id));
    await audit("item.removed", {
      item_id: row.id,
      source: row.source,
      institution_name: row.institutionName,
      accounts: ids.length,
    });
    return {
      institution_name: row.institutionName,
      accounts: ids.length,
      proposals_deleted: named.length,
      findings_withdrawn: findings.length,
    };
  });
}

/**
 * Deletes a user and everything Tidysum holds for them, after revoking each of their Plaid Items.
 * Only the audit log stays. If Plaid fails, nothing local is deleted, so it can be run again.
 */
export async function deleteUser(
  db: Db,
  plaid: PlaidGateway,
  cipher: TokenCipher,
  userId: string,
  actor: string,
  now = new Date(),
): Promise<{ items: number }> {
  const [user] = await db.select().from(appUser).where(eq(appUser.id, userId));
  if (!user) throw new Error(`no user ${userId}`);
  const items = await db
    .select({ id: item.id, source: item.source })
    .from(item)
    .where(eq(item.userId, userId));
  for (const it of items) {
    if (it.source === "plaid") await revokeAtPlaid(db, plaid, cipher, it.id);
  }
  await db.transaction(async (tx) => {
    await tx
      .insert(auditEvent)
      .values({ userId, at: now, actor, event: "user.deleted", data: { items: items.length } });
    // Every user-data table cascades from app_user; audit_event has no foreign key to it.
    await tx.delete(appUser).where(eq(appUser.id, userId));
  });
  return { items: items.length };
}
