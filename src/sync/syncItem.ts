import Big from "big.js";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { TokenCipher } from "../crypto/tokenCipher.js";
import type { Db } from "../db/client.js";
import {
  account,
  balanceSnapshot,
  holding,
  item,
  liability,
  security,
  syncRun,
  transaction,
} from "../db/schema.js";
import {
  MUTATION_DURING_PAGINATION,
  type PlaidAccount,
  PlaidApiError,
  type PlaidGateway,
  type PlaidHolding,
  type PlaidTransaction,
  PRODUCT_ABSENT_ERROR_CODES,
  RELINK_ERROR_CODES,
  type TransactionsPage,
} from "../plaid/gateway.js";
import { loadAccessToken } from "./items.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface SyncResult {
  itemId: string;
  status: "succeeded" | "failed";
  added: number;
  modified: number;
  removed: number;
  error?: string;
}

const MAX_PAGINATION_RESTARTS = 3;

/**
 * Pull everything Plaid has for one Item into the Tidysum DB: accounts and balances,
 * transactions (via /transactions/sync), holdings and liabilities when the Item has them.
 */
export async function syncItem(
  db: Db,
  plaid: PlaidGateway,
  cipher: TokenCipher,
  itemId: string,
  now: () => Date = () => new Date(),
): Promise<SyncResult> {
  const [row] = await db.select().from(item).where(eq(item.id, itemId));
  if (!row) throw new Error(`unknown item ${itemId}`);
  const { userId } = row;
  const [run] = await db.insert(syncRun).values({ itemId, userId }).returning({ id: syncRun.id });
  if (!run) throw new Error("sync_run insert returned no row");

  try {
    const accessToken = await loadAccessToken(db, cipher, itemId);

    const accounts = await plaid.getAccounts(accessToken);
    const accountIds = await upsertAccounts(db, itemId, userId, accounts);
    await snapshotBalances(db, userId, accountIds, accounts, now());

    const pages = await collectTransactionPages(plaid, accessToken, row.transactionsCursor);
    const counts = await applyTransactionPages(db, itemId, userId, pages, now());

    await optionalProduct(() => syncHoldings(db, plaid, accessToken, userId, accountIds, now()));
    await optionalProduct(() => syncLiabilities(db, plaid, accessToken, userId, accountIds, now()));

    await db
      .update(item)
      .set({ status: "active", statusDetail: null, lastSyncedAt: now() })
      .where(eq(item.id, itemId));
    await db
      .update(syncRun)
      .set({ status: "succeeded", finishedAt: now(), ...counts })
      .where(eq(syncRun.id, run.id));
    return { itemId, status: "succeeded", ...counts };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof PlaidApiError) {
      const relink = RELINK_ERROR_CODES.has(err.errorCode);
      await db
        .update(item)
        .set({ status: relink ? "relink_required" : "error", statusDetail: err.errorCode })
        .where(eq(item.id, itemId));
    }
    await db
      .update(syncRun)
      .set({ status: "failed", finishedAt: now(), error: message })
      .where(eq(syncRun.id, run.id));
    return { itemId, status: "failed", added: 0, modified: 0, removed: 0, error: message };
  }
}

/**
 * Page through /transactions/sync from the stored cursor. Plaid requires restarting the
 * whole pagination from the original cursor if data changes mid-way, so nothing is written
 * until every page is in hand.
 */
async function collectTransactionPages(
  plaid: PlaidGateway,
  accessToken: string,
  startCursor: string | null,
): Promise<TransactionsPage[]> {
  for (let attempt = 0; ; attempt++) {
    const pages: TransactionsPage[] = [];
    let cursor = startCursor;
    try {
      do {
        const page = await plaid.syncTransactions(accessToken, cursor);
        pages.push(page);
        cursor = page.nextCursor;
      } while (pages.at(-1)?.hasMore);
      return pages;
    } catch (err) {
      const restart =
        err instanceof PlaidApiError &&
        err.errorCode === MUTATION_DURING_PAGINATION &&
        attempt < MAX_PAGINATION_RESTARTS;
      if (!restart) throw err;
    }
  }
}

async function applyTransactionPages(
  db: Db,
  itemId: string,
  userId: string,
  pages: TransactionsPage[],
  at: Date,
): Promise<{ added: number; modified: number; removed: number }> {
  const counts = { added: 0, modified: 0, removed: 0 };
  const last = pages.at(-1);
  if (!last) return counts;

  await db.transaction(async (tx) => {
    // Transactions can reference accounts that /accounts/balance/get no longer returns.
    await upsertAccounts(
      tx,
      itemId,
      userId,
      pages.flatMap((p) => p.accounts),
    );
    const accountIds = await itemAccountIds(tx, itemId);
    for (const page of pages) {
      await upsertTransactions(tx, userId, accountIds, page.added);
      await upsertTransactions(tx, userId, accountIds, page.modified);
      const removedIds = page.removed.map((r) => r.transactionId);
      if (removedIds.length > 0) {
        await tx
          .update(transaction)
          .set({ removedAt: at, updatedAt: at })
          .where(inArray(transaction.plaidTransactionId, removedIds));
      }
      counts.added += page.added.length;
      counts.modified += page.modified.length;
      counts.removed += removedIds.length;
    }
    await tx.update(item).set({ transactionsCursor: last.nextCursor }).where(eq(item.id, itemId));
  });
  return counts;
}

/** Upsert accounts and return a map from Plaid account id to Tidysum account id. */
async function upsertAccounts(
  db: Db | Tx,
  itemId: string,
  userId: string,
  accounts: PlaidAccount[],
): Promise<Map<string, string>> {
  const unique = [...new Map(accounts.map((a) => [a.accountId, a])).values()];
  const ids = new Map<string, string>();
  for (const a of unique) {
    const values = {
      itemId,
      userId,
      plaidAccountId: a.accountId,
      name: a.name,
      officialName: a.officialName,
      type: a.type,
      subtype: a.subtype,
      mask: a.mask,
      currency: a.currency,
    };
    const [row] = await db
      .insert(account)
      .values(values)
      .onConflictDoUpdate({
        target: account.plaidAccountId,
        set: { ...values, updatedAt: sql`now()` },
      })
      .returning({ id: account.id });
    if (row) ids.set(a.accountId, row.id);
  }
  return ids;
}

async function itemAccountIds(db: Db | Tx, itemId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: account.id, plaidAccountId: account.plaidAccountId })
    .from(account)
    .where(eq(account.itemId, itemId));
  return new Map(rows.flatMap((r) => (r.plaidAccountId ? [[r.plaidAccountId, r.id]] : [])));
}

async function snapshotBalances(
  db: Db,
  userId: string,
  accountIds: Map<string, string>,
  accounts: PlaidAccount[],
  asOf: Date,
) {
  const rows = accounts.flatMap((a) => {
    const accountId = accountIds.get(a.accountId);
    if (!accountId) return [];
    return [
      {
        userId,
        accountId,
        current: a.balances.current,
        available: a.balances.available,
        creditLimit: a.balances.limit,
        currency: a.currency,
        asOf,
      },
    ];
  });
  if (rows.length > 0) await db.insert(balanceSnapshot).values(rows).onConflictDoNothing();
}

async function upsertTransactions(
  tx: Tx,
  userId: string,
  accountIds: Map<string, string>,
  txns: PlaidTransaction[],
) {
  for (const t of txns) {
    const accountId = accountIds.get(t.accountId);
    if (!accountId) throw new Error(`transaction ${t.transactionId} references unknown account`);
    const values = {
      userId,
      accountId,
      plaidTransactionId: t.transactionId,
      date: t.date,
      authorizedDate: t.authorizedDate,
      amount: t.amount,
      currency: t.currency,
      name: t.name,
      merchantName: t.merchantName,
      categoryPrimary: t.categoryPrimary,
      categoryDetailed: t.categoryDetailed,
      pending: t.pending,
      pendingTransactionId: t.pendingTransactionId,
      removedAt: null,
    };
    await tx
      .insert(transaction)
      .values(values)
      .onConflictDoUpdate({
        target: transaction.plaidTransactionId,
        set: { ...values, updatedAt: sql`now()` },
      });
  }
}

async function syncHoldings(
  db: Db,
  plaid: PlaidGateway,
  accessToken: string,
  userId: string,
  accountIds: Map<string, string>,
  asOf: Date,
) {
  const { holdings, securities } = await plaid.getHoldings(accessToken);
  await db.transaction(async (tx) => {
    for (const s of securities) {
      const values = {
        id: s.securityId,
        name: s.name,
        tickerSymbol: s.tickerSymbol,
        type: s.type,
        isCashEquivalent: s.isCashEquivalent,
        closePrice: s.closePrice,
        closePriceAsOf: s.closePriceAsOf,
        currency: s.currency,
      };
      await tx
        .insert(security)
        .values(values)
        .onConflictDoUpdate({ target: security.id, set: { ...values, updatedAt: sql`now()` } });
    }
    const itemAccounts = [...accountIds.values()];
    if (itemAccounts.length === 0) return;
    // Holdings are a full snapshot per Item: anything not returned has been sold.
    await tx.delete(holding).where(inArray(holding.accountId, itemAccounts));
    const rows = mergeLots(holdings).flatMap((h) => {
      const accountId = accountIds.get(h.accountId);
      if (!accountId) return [];
      return [{ ...h, userId, accountId, asOf }];
    });
    if (rows.length > 0) await tx.insert(holding).values(rows);
  });
}

/**
 * One row per account and security. Stock plans report the same stock as several lots (vested
 * and unvested shares, separate grants), so those are summed into one position. Cost basis is
 * only known when every lot reports it.
 */
export function mergeLots(holdings: PlaidHolding[]): PlaidHolding[] {
  const merged = new Map<string, PlaidHolding>();
  for (const h of holdings) {
    const key = `${h.accountId}\u0000${h.securityId}`;
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, { ...h });
      continue;
    }
    const quantity = new Big(prev.quantity).plus(h.quantity);
    const value = new Big(prev.institutionValue).plus(h.institutionValue);
    merged.set(key, {
      ...prev,
      quantity: quantity.toFixed(),
      institutionValue: value.toFixed(),
      institutionPrice: quantity.eq(0) ? prev.institutionPrice : value.div(quantity).toFixed(),
      costBasis:
        prev.costBasis !== null && h.costBasis !== null
          ? new Big(prev.costBasis).plus(h.costBasis).toFixed()
          : null,
    });
  }
  return [...merged.values()];
}

async function syncLiabilities(
  db: Db,
  plaid: PlaidGateway,
  accessToken: string,
  userId: string,
  accountIds: Map<string, string>,
  asOf: Date,
) {
  const liabilities = await plaid.getLiabilities(accessToken);
  await db.transaction(async (tx) => {
    const keep: string[] = [];
    for (const l of liabilities) {
      const accountId = accountIds.get(l.accountId);
      if (!accountId) continue;
      keep.push(accountId);
      const { accountId: _plaidId, ...fields } = l;
      const values = { ...fields, userId, accountId, asOf };
      await tx
        .insert(liability)
        .values(values)
        .onConflictDoUpdate({ target: liability.accountId, set: values });
    }
    const itemAccounts = [...accountIds.values()];
    if (itemAccounts.length === 0) return;
    const stale = keep.length
      ? and(inArray(liability.accountId, itemAccounts), notInArray(liability.accountId, keep))
      : inArray(liability.accountId, itemAccounts);
    await tx.delete(liability).where(stale);
  });
}

/** Run a product sync that an Item may simply not support (no investment or loan accounts). */
async function optionalProduct(fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof PlaidApiError && PRODUCT_ABSENT_ERROR_CODES.has(err.errorCode)) return;
    throw err;
  }
}
