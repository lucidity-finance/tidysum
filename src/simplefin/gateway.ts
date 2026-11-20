import { createHash } from "node:crypto";
import Big from "big.js";
import {
  type PlaidAccount,
  PlaidApiError,
  type PlaidHolding,
  type PlaidSecurity,
  type PlaidTransaction,
  type SyncGateway,
  type TransactionsPage,
} from "../plaid/gateway.js";
import { categorize } from "./categories.js";
import {
  type SfAccount,
  type SfAccountSet,
  type SfHolding,
  type SimpleFinClient,
  SimpleFinError,
} from "./client.js";

// SimpleFIN in the shapes the sync already knows (src/sync/syncItem.ts), so an account read
// through SimpleFIN Bridge lands in the same tables as a Plaid one (decision 0013):
// - One access URL covers every bank the person connected at the Bridge. Tidysum keeps one item
//   per bank ("connection"), like Plaid, so names, statuses and removal work per institution. The
//   stored token is the access URL with the connection id and the Tidysum item id.
// - The banks of one access URL share each answer (src/simplefin/client.ts), so syncing five
//   banks costs one request, not five.
// - SimpleFIN gives no account types and no categories: kinds come from the names and holdings,
//   categories from merchant codes and descriptions (./categories.ts).
// - There is no transactions cursor: each sync re-reads a week before the last one and upserts.
//   Pending transactions are left out; they come back posted.
// - Holdings come with transactions only, so every sync asks for the recent window with them.

/** What item_secret holds for a SimpleFIN item. */
export interface SfToken {
  /** The access URL, with its credentials. */
  sf: string;
  /** SimpleFIN's connection id: one bank sign-in at the Bridge. */
  c: string;
  /** Tidysum item id. */
  k: string;
}

export const sfToken = (accessUrl: string, connId: string, itemId: string) =>
  JSON.stringify({ sf: accessUrl, c: connId, k: itemId } satisfies SfToken);

/** Plaid access tokens are "access-..."; a SimpleFIN one is this JSON. */
export const isSfToken = (token: string) => token.startsWith('{"sf":');

export function parseSfToken(token: string): SfToken {
  const t = JSON.parse(token) as Partial<SfToken>;
  if (typeof t.sf !== "string" || typeof t.c !== "string" || typeof t.k !== "string") {
    throw new Error("not a SimpleFIN connection");
  }
  return { sf: t.sf, c: t.c, k: t.k };
}

/**
 * Plaid (or Plaid with Enable Banking) with SimpleFIN beside it: sync and removal calls for a
 * SimpleFIN item go to SimpleFIN, everything else where it went before.
 */
export function withSimpleFin<T extends SyncGateway>(inner: T, sf: SyncGateway): T {
  const route = (token: string): SyncGateway => (isSfToken(token) ? sf : inner);
  return Object.assign(Object.create(inner) as T, {
    getAccounts: (t: string) => route(t).getAccounts(t),
    syncTransactions: (t: string, c: string | null) => route(t).syncTransactions(t, c),
    getHoldings: (t: string) => route(t).getHoldings(t),
    getLiabilities: (t: string) => route(t).getLiabilities(t),
    removeItem: (t: string) => route(t).removeItem(t),
  });
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 40);

/**
 * The connection an account belongs to. Protocol 2 names it; protocol 1 servers only name the
 * institution, which then stands for the connection.
 */
export const connIdOf = (a: SfAccount) =>
  a.conn_id || `org:${a.org?.id || a.org?.domain || a.org?.name || "unknown"}`;

/** The institution's name for a connection, as people say it. */
export function connectionName(set: SfAccountSet, connId: string): string {
  const c = set.connections.find((x) => x.conn_id === connId);
  if (c) return c.org_name || c.name;
  const a = set.accounts.find((x) => connIdOf(x) === connId);
  return a?.org?.name || a?.org?.domain || "SimpleFIN";
}

/** Every connection in an answer, in the order SimpleFIN lists them. */
export function connectionsOf(
  set: SfAccountSet,
): { connId: string; orgId: string; name: string }[] {
  const ids = [
    ...new Set([...set.connections.map((c) => c.conn_id), ...set.accounts.map(connIdOf)]),
  ];
  return ids.map((connId) => {
    const c = set.connections.find((x) => x.conn_id === connId);
    const a = set.accounts.find((x) => connIdOf(x) === connId);
    return {
      connId,
      orgId: c?.org_id || a?.org?.id || a?.org?.domain || connId,
      name: connectionName(set, connId),
    };
  });
}

const iso = (code: string) => /^[A-Z]{3}$/.test(code);
const day = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);

/**
 * The account's kind, from what SimpleFIN gives: holdings mean a brokerage, then the name, then a
 * balance below zero (SimpleFIN shows card debt that way). What can't be told stays "other".
 */
export function kindOf(a: SfAccount): [type: string, subtype: string] {
  const n = `${a.name} ${a.org?.name ?? ""}`.toLowerCase();
  const retirement = /401\s?\(?k\)?|403\s?\(?b\)?|\bira\b|roth|\bhsa\b|457|\btsp\b/.exec(n);
  const sub = () => {
    if (!retirement) return "brokerage";
    const r = retirement[0].replace(/[\s()]/g, "");
    if (r === "roth") return "roth";
    return r === "tsp" ? "thrift savings plan" : r;
  };
  if ((a.holdings?.length ?? 0) > 0 || retirement) return ["investment", sub()];
  if (/mortgage|heloc|home equity/.test(n)) return ["loan", "mortgage"];
  if (/\bloan\b|\bauto\b|student/.test(n)) return ["loan", /student/.test(n) ? "student" : "loan"];
  if (
    /credit|\bcard\b|visa|mastercard|\bamex\b|american express|discover it|sapphire|freedom|venture|quicksilver|savor/.test(
      n,
    )
  ) {
    return ["credit", "credit card"];
  }
  if (/money market/.test(n)) return ["depository", "money market"];
  if (/\bcd\b|certificate/.test(n)) return ["depository", "cd"];
  if (/saving/.test(n)) return ["depository", "savings"];
  if (/checking|\bspend/.test(n)) return ["depository", "checking"];
  if (/brokerage|invest|individual|joint|trading|retirement/.test(n)) {
    return ["investment", "brokerage"];
  }
  if (new Big(a.balance || "0").lt(0)) return ["credit", "credit card"];
  return ["depository", "other"];
}

/** One account and its balance in the sync's shape. */
export function mapAccount(itemKey: string, a: SfAccount): PlaidAccount {
  const [type, subtype] = kindOf(a);
  // SimpleFIN shows debt below zero; the sync counts a card's or loan's debt above zero.
  const owed = (s: string) =>
    type === "credit" || type === "loan" ? new Big(s).times(-1).toString() : new Big(s).toString();
  const available = a["available-balance"];
  return {
    accountId: `sf:${sha(`${itemKey}:${a.id}`)}`,
    name: a.name || "Account",
    officialName: null,
    type,
    subtype,
    // "Sapphire Preferred (1234)" or "Checking ...1234": the last four digits, when shown.
    mask: /(\d{4})\)?\s*$/.exec(a.name ?? "")?.[1] ?? null,
    currency: a.currency,
    balances: {
      current: owed(a.balance),
      available: available && type === "depository" ? new Big(available).toString() : null,
      limit: null,
    },
  };
}

/** Posted transactions in the sync's shape: money out is positive, as with Plaid. */
export function mapTransactions(
  plaidAccountId: string,
  a: SfAccount,
  accountType: string,
): PlaidTransaction[] {
  return (a.transactions ?? []).flatMap((t): PlaidTransaction[] => {
    if (t.pending || !t.posted) return [];
    const amount = new Big(t.amount).times(-1);
    const text = [t.description, t.payee, t.memo].filter(Boolean).join(" ");
    const category = categorize({
      mcc: t.mcc ?? (typeof t.extra?.mcc === "string" ? t.extra.mcc : null),
      text,
      out: amount.gt(0),
      accountType,
    });
    return [
      {
        transactionId: `sf:${sha(`${plaidAccountId}:${t.id}`)}`,
        accountId: plaidAccountId,
        date: day(t.posted),
        authorizedDate: t.transacted_at ? day(t.transacted_at) : null,
        amount: amount.toString(),
        currency: a.currency,
        name: t.description || t.payee || null,
        merchantName: t.payee || null,
        categoryPrimary: category?.primary ?? null,
        categoryDetailed: category?.detailed ?? null,
        pending: false,
        pendingTransactionId: null,
      },
    ];
  });
}

/** Money market and sweep funds hold cash; the allocation counts them as cash. */
const CASH_TICKERS = new Set([
  "SPAXX",
  "FDRXX",
  "FZFXX",
  "SPRXX",
  "VMFXX",
  "VMRXX",
  "SWVXX",
  "SNVXX",
  "SNSXX",
  "CORE",
]);

/** A holding and its security. Securities are shared by everyone, so the id is the ticker's. */
export function mapHolding(
  plaidAccountId: string,
  h: SfHolding,
  asOf: string,
  fallbackCurrency: string,
): { holding: PlaidHolding; security: PlaidSecurity } | null {
  if (!h.shares || !h.market_value) return null;
  const quantity = new Big(h.shares);
  const value = new Big(h.market_value);
  const ticker = h.symbol?.trim().toUpperCase() || null;
  const name = h.description?.trim() || ticker;
  const currency = h.currency && iso(h.currency) ? h.currency : fallbackCurrency;
  const price = quantity.eq(0) ? "0" : value.div(quantity).round(10).toFixed();
  const cash =
    (ticker !== null && CASH_TICKERS.has(ticker)) ||
    /money market|cash sweep|\bsweep\b|^cash$/i.test(name ?? "");
  const securityId = ticker ? `sf:${ticker}` : `sf:x:${sha(name ?? h.id ?? "")}`;
  return {
    holding: {
      accountId: plaidAccountId,
      securityId,
      quantity: quantity.toFixed(),
      institutionPrice: price,
      institutionValue: value.toFixed(),
      costBasis: h.cost_basis ? new Big(h.cost_basis).toFixed() : null,
      currency,
    },
    security: {
      securityId,
      name,
      tickerSymbol: ticker,
      type: cash ? "cash" : null,
      isCashEquivalent: cash,
      closePrice: price,
      closePriceAsOf: asOf,
      currency,
    },
  };
}

/** Days per request: under the 45 SimpleFIN Bridge asks for. */
export const WINDOW_DAYS = 44;
/** The first sync reads back about a year, a window at a time, until a window is empty. */
const FIRST_SYNC_WINDOWS = 9;
/** Later syncs re-read this many days before the last one, for postings that arrive late. */
const OVERLAP_DAYS = 7;

const DAY_S = 86_400;
const midnight = (d: Date) =>
  Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);

/** SimpleFIN errors as the Plaid codes the sync acts on (src/plaid/gateway.ts RELINK_ERROR_CODES). */
function asSyncError(err: unknown): unknown {
  if (!(err instanceof SimpleFinError)) return err;
  const code = {
    revoked: "SIMPLEFIN_ACCESS_REVOKED",
    payment: "SIMPLEFIN_PAYMENT_REQUIRED",
    claim_used: "SIMPLEFIN_ACCESS_REVOKED",
    daily_limit: "SIMPLEFIN_DAILY_LIMIT",
    failed: "SIMPLEFIN_ERROR",
  }[err.kind];
  return new PlaidApiError("SIMPLEFIN", code, err.message);
}

export class SimpleFinGateway implements SyncGateway {
  constructor(
    private readonly client: SimpleFinClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The newest window: the last WINDOW_DAYS days through today, the same for every bank. */
  private recentWindow() {
    const end = midnight(this.now()) + DAY_S;
    return { start: end - WINDOW_DAYS * DAY_S, end };
  }

  /** One window's answer, with this connection's own failures raised. */
  private async read(token: SfToken, window: { start: number; end: number }) {
    let set: SfAccountSet;
    try {
      set = await this.client.accounts(token.sf, window);
    } catch (err) {
      throw asSyncError(err);
    }
    for (const e of set.errlist) {
      const mine = !e.conn_id || e.conn_id === token.c;
      if (e.code === "gen.auth") {
        throw new PlaidApiError("SIMPLEFIN", "SIMPLEFIN_ACCESS_REVOKED", e.msg);
      }
      if (mine && e.code.startsWith("con.auth")) {
        throw new PlaidApiError("SIMPLEFIN", "SIMPLEFIN_REAUTH", e.msg);
      }
    }
    const accounts = set.accounts.filter((a) => connIdOf(a) === token.c);
    if (accounts.length === 0 && !set.connections.some((c) => c.conn_id === token.c)) {
      throw new PlaidApiError(
        "SIMPLEFIN",
        "SIMPLEFIN_CONNECTION_GONE",
        "SimpleFIN no longer shares this bank with Tidysum",
      );
    }
    // Points and miles come as a custom currency (a URL): they aren't money Tidysum can count.
    return { set, accounts: accounts.filter((a) => iso(a.currency)) };
  }

  async getAccounts(token: string): Promise<PlaidAccount[]> {
    const t = parseSfToken(token);
    const { accounts } = await this.read(t, this.recentWindow());
    return accounts.map((a) => mapAccount(t.k, a));
  }

  /**
   * One "page" holding every account's posted transactions since the cursor (a day), less an
   * overlap. The first sync reads back about a year, stopping at the first empty window.
   */
  async syncTransactions(token: string, cursor: string | null): Promise<TransactionsPage> {
    const t = parseSfToken(token);
    const recent = this.recentWindow();
    const since = cursor ? (JSON.parse(cursor) as { since?: string }).since : undefined;
    const from = since
      ? Math.floor(Date.parse(`${since}T00:00:00Z`) / 1000) - OVERLAP_DAYS * DAY_S
      : undefined;

    // The newest window first (it also brings balances and holdings), then older ones back to
    // the last sync, or about a year on the first.
    const windows = [recent];
    const oldest = Math.max(
      from ?? Number.NEGATIVE_INFINITY,
      recent.start - (FIRST_SYNC_WINDOWS - 1) * WINDOW_DAYS * DAY_S,
    );
    for (let end = recent.start; end > oldest; ) {
      const start = Math.max(oldest, end - WINDOW_DAYS * DAY_S);
      windows.push({ start, end });
      end = start;
    }

    const byId = new Map<string, PlaidAccount>();
    const added: PlaidTransaction[] = [];
    for (const [i, w] of windows.entries()) {
      const { set, accounts } = await this.read(t, w);
      for (const a of accounts) {
        const mapped = mapAccount(t.k, a);
        if (i === 0) byId.set(mapped.accountId, mapped);
        added.push(...mapTransactions(mapped.accountId, a, mapped.type));
      }
      // History ends where a whole window is empty for every bank at this access URL, so the
      // banks sharing it stop at the same place and keep sharing answers.
      const empty = set.accounts.every((a) => (a.transactions?.length ?? 0) === 0);
      if (from === undefined && i > 0 && empty) break;
    }
    return {
      accounts: [...byId.values()],
      added: [...new Map(added.map((x) => [x.transactionId, x])).values()],
      modified: [],
      removed: [],
      nextCursor: JSON.stringify({ since: day(recent.end - DAY_S) }),
      hasMore: false,
    };
  }

  async getHoldings(
    token: string,
  ): Promise<{ holdings: PlaidHolding[]; securities: PlaidSecurity[] }> {
    const t = parseSfToken(token);
    const { accounts } = await this.read(t, this.recentWindow());
    const holdings: PlaidHolding[] = [];
    const securities = new Map<string, PlaidSecurity>();
    for (const a of accounts) {
      const mapped = mapAccount(t.k, a);
      if (mapped.type !== "investment") continue;
      for (const h of a.holdings ?? []) {
        const m = mapHolding(mapped.accountId, h, day(a["balance-date"]), a.currency);
        if (!m) continue;
        holdings.push(m.holding);
        securities.set(m.security.securityId, m.security);
      }
    }
    if (holdings.length === 0 && !accounts.some((a) => kindOf(a)[0] === "investment")) {
      throw new PlaidApiError("SIMPLEFIN", "PRODUCTS_NOT_SUPPORTED", "no investment accounts");
    }
    return { holdings, securities: [...securities.values()] };
  }

  async getLiabilities(): Promise<never> {
    throw new PlaidApiError(
      "SIMPLEFIN",
      "PRODUCTS_NOT_SUPPORTED",
      "SimpleFIN doesn't give card or loan terms",
    );
  }

  /**
   * SimpleFIN has no way for an app to give its access back: the person turns it off at the
   * Bridge (the Connections page says so). Removing the item here forgets the access URL.
   */
  async removeItem(): Promise<void> {}
}
