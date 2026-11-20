import { createHash } from "node:crypto";
import Big from "big.js";
import {
  type PlaidAccount,
  PlaidApiError,
  type PlaidTransaction,
  type SyncGateway,
  type TransactionsPage,
} from "../plaid/gateway.js";
import {
  type EbAccount,
  type EbBalance,
  type EbTransaction,
  type EnableBankingClient,
  EnableBankingError,
} from "./client.js";

// Enable Banking in the shapes the sync already knows (src/sync/syncItem.ts), so a UK or EU bank
// account lands in the same tables as a Plaid one. Differences are kept here:
// - The stored "access token" is the session id with the Tidysum item id, so account ids can be
//   made unique per item (a joint account seen by two users stays two accounts).
// - Account uids change with every new consent; the identification hash doesn't, so it names the
//   account.
// - There is no transactions cursor: each sync re-reads the last two weeks and upserts, so a
//   booking that arrives late is still caught. Pending transactions are left out: they come back
//   booked under another reference.
// - There are no categories, holdings or liabilities: open banking doesn't give them.

/** What item_secret holds for an Enable Banking item. */
export interface EbToken {
  /** Enable Banking session id. */
  s: string;
  /** Tidysum item id. */
  k: string;
}

export const ebToken = (sessionId: string, itemId: string) =>
  JSON.stringify({ s: sessionId, k: itemId } satisfies EbToken);

/** Plaid access tokens are "access-..."; an Enable Banking one is this JSON. */
export const isEbToken = (token: string) => token.startsWith('{"s":');

/**
 * Plaid with Enable Banking beside it: sync and removal calls go to whichever source the stored
 * token belongs to, everything else to Plaid. Without Enable Banking set up, an Enable Banking
 * item fails its sync with a reason instead of reaching Plaid.
 */
export function withEnableBanking<T extends SyncGateway>(plaid: T, eb: SyncGateway | undefined): T {
  const route = (token: string): SyncGateway => {
    if (!isEbToken(token)) return plaid;
    if (eb) return eb;
    throw new PlaidApiError(
      "ENABLE_BANKING",
      "NOT_CONFIGURED",
      "Enable Banking isn't set up: set ENABLE_BANKING_APP_ID and ENABLE_BANKING_KEY_FILE",
    );
  };
  return Object.assign(Object.create(plaid) as T, {
    getAccounts: (t: string) => route(t).getAccounts(t),
    syncTransactions: (t: string, c: string | null) => route(t).syncTransactions(t, c),
    getHoldings: (t: string) => route(t).getHoldings(t),
    getLiabilities: (t: string) => route(t).getLiabilities(t),
    removeItem: (t: string) => route(t).removeItem(t),
  });
}

function parseToken(token: string): EbToken {
  const t = JSON.parse(token) as Partial<EbToken>;
  if (typeof t.s !== "string" || typeof t.k !== "string") {
    throw new Error("not an Enable Banking session");
  }
  return { s: t.s, k: t.k };
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 40);

/** Days of history the first sync asks for; banks give what they have, often a year or more. */
export const FIRST_SYNC_DAYS = 730;
/** Later syncs re-read this many days, for bookings that arrive late. */
const OVERLAP_DAYS = 14;

const day = (d: Date) => d.toISOString().slice(0, 10);
const daysBefore = (d: Date, n: number) => day(new Date(d.getTime() - n * 86_400_000));

/** ISO 20022 cash account types as the kinds the rest of Tidysum uses. */
const KINDS: Record<string, [type: string, subtype: string]> = {
  CACC: ["depository", "checking"],
  CASH: ["depository", "checking"],
  TRAN: ["depository", "checking"],
  SVGS: ["depository", "savings"],
  MOMA: ["depository", "money market"],
  CARD: ["credit", "credit card"],
  LOAN: ["loan", "loan"],
  MGLD: ["loan", "mortgage"],
};

function pick(balances: EbBalance[], order: string[]): EbBalance | undefined {
  for (const t of order) {
    const b = balances.find((x) => x.balance_type === t);
    if (b) return b;
  }
  return undefined;
}

/** One account and its balances in the sync's shape. */
export function mapAccount(itemKey: string, a: EbAccount, balances: EbBalance[]): PlaidAccount {
  const [type, subtype] = KINDS[a.cash_account_type ?? ""] ?? ["depository", "other"];
  // Booked first (what the statement says), then what is available.
  const current = pick(balances, ["CLBD", "ITBD", "XPCD", "ITAV", "CLAV", "OPBD"]) ?? balances[0];
  const available = pick(balances, ["ITAV", "CLAV", "XPCD", "OPAV"]);
  // A card's balance comes as money owed below zero; the sync counts a card's debt above zero.
  const owed = (s: string) =>
    type === "credit" || type === "loan" ? new Big(s).times(-1) : new Big(s);
  const iban = a.account_id?.iban ?? a.account_id?.other?.identification ?? null;
  return {
    accountId: `eb:${sha(`${itemKey}:${a.identification_hash}`)}`,
    name: a.name || a.product || a.details || (iban ? `Account ${iban.slice(-4)}` : "Account"),
    officialName: a.product ?? null,
    type,
    subtype,
    mask: iban ? iban.replace(/\s/g, "").slice(-4) : null,
    currency: a.currency ?? current?.balance_amount.currency ?? null,
    balances: {
      current: current ? owed(current.balance_amount.amount).toString() : null,
      available: available && type === "depository" ? available.balance_amount.amount : null,
      limit: null,
    },
  };
}

/**
 * Booked transactions in the sync's shape: money out is positive, as with Plaid. An entry
 * reference makes a stable id; without one, the id is the transaction's own content, counted so
 * two identical payments on one day stay two.
 */
export function mapTransactions(plaidAccountId: string, txns: EbTransaction[]): PlaidTransaction[] {
  const seen = new Map<string, number>();
  return txns.flatMap((t): PlaidTransaction[] => {
    if (t.status === "PDNG") return [];
    const date = t.booking_date ?? t.value_date ?? t.transaction_date;
    if (!date) return [];
    const abs = new Big(t.transaction_amount.amount).abs();
    const out = t.credit_debit_indicator === "DBIT";
    const amount = (out ? abs : abs.times(-1)).toString();
    const remittance = (t.remittance_information ?? []).join(" ").trim();
    const party = (out ? t.creditor?.name : t.debtor?.name) ?? null;
    let key: string;
    if (t.entry_reference) key = `ref:${t.entry_reference}`;
    else {
      const content = `${date}|${amount}|${remittance}|${party ?? ""}`;
      const n = (seen.get(content) ?? 0) + 1;
      seen.set(content, n);
      key = `content:${content}#${n}`;
    }
    return [
      {
        transactionId: `eb:${sha(`${plaidAccountId}:${key}`)}`,
        accountId: plaidAccountId,
        date,
        authorizedDate: t.transaction_date ?? null,
        amount,
        currency: t.transaction_amount.currency,
        name: remittance || party,
        merchantName: party,
        categoryPrimary: null,
        categoryDetailed: null,
        pending: false,
        pendingTransactionId: null,
      },
    ];
  });
}

/** Enable Banking errors as the Plaid codes the sync acts on. */
function asSyncError(err: unknown): unknown {
  if (!(err instanceof EnableBankingError)) return err;
  const relink =
    err.code === "EXPIRED_SESSION" ||
    err.code === "REVOKED_SESSION" ||
    err.code === "CLOSED_SESSION" ||
    err.status === 401;
  return new PlaidApiError(
    "ENABLE_BANKING",
    relink ? "ITEM_LOGIN_REQUIRED" : err.code,
    err.message,
  );
}

export class EnableBankingGateway implements SyncGateway {
  /** The last session read per token, so one sync reads each account once. */
  private readonly sessions = new Map<
    string,
    { accounts: PlaidAccount[]; uids: Map<string, string> }
  >();

  constructor(
    private readonly client: EnableBankingClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async read(token: string) {
    const { s, k } = parseToken(token);
    try {
      const session = await this.client.getSession(s);
      if (session.status && session.status !== "AUTHORIZED") {
        throw new EnableBankingError(401, "EXPIRED_SESSION", `session is ${session.status}`);
      }
      const accounts: PlaidAccount[] = [];
      const uids = new Map<string, string>();
      for (const { uid, identification_hash } of session.accounts_data) {
        const details = await this.client.getDetails(uid);
        const mapped = mapAccount(
          k,
          { ...details, uid, identification_hash },
          await this.client.getBalances(uid),
        );
        accounts.push(mapped);
        uids.set(mapped.accountId, uid);
      }
      const read = { accounts, uids };
      this.sessions.set(token, read);
      return read;
    } catch (err) {
      throw asSyncError(err);
    }
  }

  async getAccounts(token: string): Promise<PlaidAccount[]> {
    return (await this.read(token)).accounts;
  }

  /**
   * One "page" holding every account's booked transactions since the cursor (a day), less an
   * overlap; the first sync asks for as much history as the bank gives.
   */
  async syncTransactions(token: string, cursor: string | null): Promise<TransactionsPage> {
    const session = this.sessions.get(token) ?? (await this.read(token));
    this.sessions.delete(token);
    const now = this.now();
    const since = cursor ? (JSON.parse(cursor) as { since?: string }).since : undefined;
    const from = since
      ? daysBefore(new Date(`${since}T00:00:00Z`), OVERLAP_DAYS)
      : daysBefore(now, FIRST_SYNC_DAYS);
    const added: PlaidTransaction[] = [];
    try {
      for (const a of session.accounts) {
        const uid = session.uids.get(a.accountId);
        if (!uid) continue;
        const txns = await this.client.getTransactions(uid, from, since ? "default" : "longest");
        added.push(...mapTransactions(a.accountId, txns));
      }
    } catch (err) {
      throw asSyncError(err);
    }
    return {
      accounts: session.accounts,
      added,
      modified: [],
      removed: [],
      nextCursor: JSON.stringify({ since: day(now) }),
      hasMore: false,
    };
  }

  async getHoldings(): Promise<never> {
    throw new PlaidApiError(
      "ENABLE_BANKING",
      "PRODUCTS_NOT_SUPPORTED",
      "no holdings over open banking",
    );
  }

  async getLiabilities(): Promise<never> {
    throw new PlaidApiError(
      "ENABLE_BANKING",
      "PRODUCTS_NOT_SUPPORTED",
      "no liabilities over open banking",
    );
  }

  async removeItem(token: string): Promise<void> {
    try {
      await this.client.deleteSession(parseToken(token).s);
    } catch (err) {
      // An expired or already closed session has nothing left to revoke.
      if (!(err instanceof EnableBankingError && (err.status === 401 || err.status === 404))) {
        throw err;
      }
    }
  }
}
