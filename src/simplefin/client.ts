import { createHash } from "node:crypto";

// SimpleFIN (simplefin.org): a small read-only protocol for bank data. Most people reach it
// through SimpleFIN Bridge (about $15 a year, paid by the person), which connects US banks, cards
// and brokerages and hands an app a "setup token". The app trades the token once for an access
// URL with credentials in it, and reads everything the person shared from that URL's /accounts.
// No developer account, keys or business is needed, which is why it suits self-hosting (decision
// 0013). Read-only: SimpleFIN has no way to move money.
//
// Bridge limits (developer guide, read 2026-11-20): about 24 requests a day per access URL, more
// gets the token disabled; date ranges over 90 days are capped, and 45 days is what it
// recommends. It refreshes from the banks about once a day, so asking more often gains nothing.

/** Where people make a setup token: SimpleFIN Bridge's "connect an app" page. */
export const SIMPLEFIN_CREATE_URL = "https://bridge.simplefin.org/simplefin/create";

export interface SfConnection {
  conn_id: string;
  name: string;
  org_id?: string | null;
  org_name?: string | null;
  org_url?: string | null;
}

export interface SfHolding {
  id?: string | null;
  symbol?: string | null;
  description?: string | null;
  shares?: string | null;
  market_value?: string | null;
  cost_basis?: string | null;
  purchase_price?: string | null;
  currency?: string | null;
}

export interface SfTransaction {
  id: string;
  posted: number;
  amount: string;
  description: string;
  payee?: string | null;
  memo?: string | null;
  transacted_at?: number | null;
  pending?: boolean | null;
  /** SimpleFIN Bridge's extension: the merchant category code card networks assign. */
  mcc?: string | null;
  extra?: Record<string, unknown> | null;
}

export interface SfAccount {
  id: string;
  name: string;
  /** Protocol 2. */
  conn_id?: string | null;
  /** Protocol 1 servers name the institution on each account instead. */
  org?: { id?: string | null; name?: string | null; domain?: string | null } | null;
  /** An ISO 4217 code, or the URL of a custom currency such as airline miles. */
  currency: string;
  balance: string;
  "available-balance"?: string | null;
  "balance-date": number;
  transactions?: SfTransaction[] | null;
  /** SimpleFIN Bridge's extension, on brokerage accounts. Only in requests with transactions. */
  holdings?: SfHolding[] | null;
}

export interface SfError {
  code: string;
  msg: string;
  conn_id?: string | null;
  account_id?: string | null;
}

export interface SfAccountSet {
  errlist: SfError[];
  connections: SfConnection[];
  accounts: SfAccount[];
}

/** A SimpleFIN failure. `kind` says what the owner has to do, if anything. */
export class SimpleFinError extends Error {
  constructor(
    readonly kind: "revoked" | "payment" | "claim_used" | "daily_limit" | "failed",
    message: string,
  ) {
    super(message);
    this.name = "SimpleFinError";
  }
}

/** At most this many requests per access URL in a day: under Bridge's 24, with room to spare. */
export const DAILY_REQUESTS = 20;
/** How long one answer is shared, so the banks of one access URL syncing together ask once. */
const SHARE_MS = 5 * 60_000;

const httpsUrl = (s: string, what: string) => {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new SimpleFinError("failed", `That doesn't look like a SimpleFIN ${what}.`);
  }
  // The protocol's checklist: only ever talk to SimpleFIN over https.
  if (u.protocol !== "https:") {
    throw new SimpleFinError("failed", `SimpleFIN ${what}s must be https.`);
  }
  return u;
};

/** Text from SimpleFIN goes to the page; keep it short and printable. */
const tidy = (s: unknown) =>
  String(s ?? "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 300);

export class SimpleFinClient {
  private readonly shared = new Map<string, { at: number; answer: Promise<SfAccountSet> }>();
  private readonly spent = new Map<string, number[]>();

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Trades a setup token (a base64 URL, used once) for the access URL. A token that was already
   * claimed may have been claimed by someone else, so the message says to disable it.
   */
  async claim(setupToken: string): Promise<string> {
    const decoded = Buffer.from(setupToken.replace(/\s+/g, ""), "base64").toString("utf8");
    const claimUrl = httpsUrl(decoded, "setup token");
    const res = await this.fetcher(claimUrl, {
      method: "POST",
      headers: { "Content-Length": "0" },
      signal: AbortSignal.timeout(60_000),
    });
    const text = (await res.text()).trim();
    if (res.status === 403) {
      throw new SimpleFinError(
        "claim_used",
        "SimpleFIN says this setup token was already used. If you didn't use it, someone else " +
          "may have: disable it at SimpleFIN Bridge, then make a new one for Tidysum.",
      );
    }
    if (!res.ok) {
      throw new SimpleFinError("failed", `SimpleFIN didn't take the setup token (${res.status}).`);
    }
    const access = httpsUrl(text, "access URL");
    if (!access.username || !access.password) {
      throw new SimpleFinError("failed", "SimpleFIN sent back an access URL without credentials.");
    }
    return access.toString();
  }

  /**
   * GET /accounts. Answers are shared for a few minutes per access URL and query (unless
   * `fresh`, for the owner asking just now), and real requests are counted so Tidysum never gets
   * near the Bridge's daily limit.
   */
  accounts(
    accessUrl: string,
    q: { start?: number; end?: number; balancesOnly?: boolean; fresh?: boolean } = {},
  ): Promise<SfAccountSet> {
    const params = new URLSearchParams({ version: "2" });
    if (q.start !== undefined) params.set("start-date", String(q.start));
    if (q.end !== undefined) params.set("end-date", String(q.end));
    if (q.balancesOnly) params.set("balances-only", "1");
    const at = this.now().getTime();
    for (const [k, v] of this.shared) if (at - v.at > SHARE_MS) this.shared.delete(k);
    const key = `${createHash("sha256").update(accessUrl).digest("hex")}?${params}`;
    const hit = q.fresh ? undefined : this.shared.get(key);
    if (hit) return hit.answer;
    const answer = this.fetchAccounts(accessUrl, params, at);
    this.shared.set(key, { at, answer });
    // A failed answer isn't shared: the next sync may try again, within the budget.
    answer.catch(() => this.shared.delete(key));
    return answer;
  }

  private async fetchAccounts(
    accessUrl: string,
    params: URLSearchParams,
    at: number,
  ): Promise<SfAccountSet> {
    const u = httpsUrl(accessUrl, "access URL");
    const budgetKey = createHash("sha256").update(accessUrl).digest("hex");
    const recent = (this.spent.get(budgetKey) ?? []).filter((t) => at - t < 86_400_000);
    if (recent.length >= DAILY_REQUESTS) {
      this.spent.set(budgetKey, recent);
      throw new SimpleFinError(
        "daily_limit",
        `Tidysum already asked SimpleFIN ${DAILY_REQUESTS} times today; it tries again later.`,
      );
    }
    recent.push(at);
    this.spent.set(budgetKey, recent);

    const auth = Buffer.from(
      `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`,
    ).toString("base64");
    u.username = "";
    u.password = "";
    const url = `${u.toString().replace(/\/$/, "")}/accounts?${params}`;
    const res = await this.fetcher(url, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(120_000),
    });
    if (res.status === 403) {
      throw new SimpleFinError(
        "revoked",
        "SimpleFIN refused Tidysum's access: it was turned off at SimpleFIN Bridge.",
      );
    }
    if (res.status === 402) {
      throw new SimpleFinError("payment", "SimpleFIN Bridge needs its subscription renewed.");
    }
    if (!res.ok) throw new SimpleFinError("failed", `SimpleFIN answered ${res.status}.`);
    const body = (await res.json()) as Partial<SfAccountSet> & { errors?: unknown[] };
    // Protocol 1 servers send plain strings in `errors`.
    const errlist = Array.isArray(body.errlist)
      ? body.errlist.map((e) => ({ ...e, code: tidy(e.code), msg: tidy(e.msg) }))
      : (body.errors ?? []).map((e) => ({ code: "gen.", msg: tidy(e) }));
    return {
      errlist,
      connections: Array.isArray(body.connections) ? body.connections : [],
      accounts: Array.isArray(body.accounts) ? body.accounts : [],
    };
  }
}
