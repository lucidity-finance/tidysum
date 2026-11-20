import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

// Enable Banking (enablebanking.com): open banking for UK and EU banks, where Plaid's free plan
// doesn't reach (decision 0011). Its free "restricted production" lets a person link their own
// accounts: they register an application in Enable Banking's Control Panel, link their accounts
// there once, and give Tidysum the application id and its private key. Requests are signed with a
// short-lived JWT; the bank consent is a session that lasts until the bank's limit, often 180 days.
//
// Read-only: Tidysum only uses account information, never payments.

export const ENABLE_BANKING_API = "https://api.enablebanking.com";

/** A bank as Enable Banking names it: there is no id, only the name and country together. */
export interface Bank {
  name: string;
  country: string;
}

export interface BankListing extends Bank {
  logo: string | null;
  /** Longest consent the bank gives, in seconds. */
  maximum_consent_validity: number | null;
  psu_types: string[];
}

export interface EbAccount {
  uid: string;
  identification_hash: string;
  account_id?: { iban?: string | null; other?: { identification?: string } | null } | null;
  name?: string | null;
  details?: string | null;
  product?: string | null;
  cash_account_type?: string | null;
  currency?: string | null;
}

export interface EbBalance {
  name?: string | null;
  balance_amount: { currency: string; amount: string };
  balance_type: string;
  reference_date?: string | null;
}

export interface EbTransaction {
  entry_reference?: string | null;
  transaction_id?: string | null;
  transaction_amount: { currency: string; amount: string };
  credit_debit_indicator: "CRDT" | "DBIT";
  status?: string | null;
  booking_date?: string | null;
  value_date?: string | null;
  transaction_date?: string | null;
  remittance_information?: string[] | null;
  creditor?: { name?: string | null } | null;
  debtor?: { name?: string | null } | null;
}

export interface EbSession {
  session_id: string;
  accounts: EbAccount[];
  aspsp: Bank;
  access: { valid_until: string };
}

/** An Enable Banking error, by its own code ("EXPIRED_SESSION", "ASPSP_RATE_LIMIT_EXCEEDED"...). */
export class EnableBankingError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EnableBankingError";
  }
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export class EnableBankingClient {
  constructor(
    private readonly appId: string,
    private readonly key: KeyObject,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The client for an application id and the private key file Enable Banking gave for it. */
  static fromFile(appId: string, keyFile: string): EnableBankingClient {
    return new EnableBankingClient(appId, createPrivateKey(readFileSync(keyFile)));
  }

  /** A JWT for one request, signed with the application's key (RS256, one hour). */
  jwt(): string {
    const iat = Math.floor(this.now().getTime() / 1000);
    const head = b64url(JSON.stringify({ typ: "JWT", alg: "RS256", kid: this.appId }));
    const body = b64url(
      JSON.stringify({
        iss: "enablebanking.com",
        aud: "api.enablebanking.com",
        iat,
        exp: iat + 3600,
      }),
    );
    const signature = createSign("RSA-SHA256").update(`${head}.${body}`).sign(this.key);
    return `${head}.${body}.${b64url(signature)}`;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetcher(`${ENABLE_BANKING_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.jwt()}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      const code = typeof json.error === "string" ? json.error : `HTTP_${res.status}`;
      const detail = typeof json.message === "string" ? json.message : text.slice(0, 200);
      throw new EnableBankingError(res.status, code, `Enable Banking ${path}: ${code} ${detail}`);
    }
    return json as T;
  }

  /** The banks Enable Banking reaches in a country, for people (not businesses). */
  async listBanks(country: string): Promise<BankListing[]> {
    const r = await this.call<{ aspsps: BankListing[] }>(
      "GET",
      `/aspsps?country=${encodeURIComponent(country)}&psu_type=personal`,
    );
    return r.aspsps.map((a) => ({
      name: a.name,
      country: a.country,
      logo: a.logo ?? null,
      maximum_consent_validity: a.maximum_consent_validity ?? null,
      psu_types: a.psu_types ?? [],
    }));
  }

  /** Starts the bank's consent: the person signs in at the returned URL. */
  async startAuth(p: {
    bank: Bank;
    state: string;
    redirectUrl: string;
    validUntil: Date;
  }): Promise<string> {
    const r = await this.call<{ url: string }>("POST", "/auth", {
      access: { valid_until: p.validUntil.toISOString() },
      aspsp: { name: p.bank.name, country: p.bank.country },
      state: p.state,
      redirect_url: p.redirectUrl,
      psu_type: "personal",
    });
    return r.url;
  }

  /** Turns the code the bank sent back into a session with its accounts. */
  createSession(code: string): Promise<EbSession> {
    return this.call<EbSession>("POST", "/sessions", { code });
  }

  /** The session's accounts (uids change with each new consent; the hashes don't). */
  getSession(sessionId: string) {
    return this.call<{
      status: string;
      access: { valid_until: string };
      accounts_data: { uid: string; identification_hash: string }[];
    }>("GET", `/sessions/${encodeURIComponent(sessionId)}`);
  }

  getDetails(uid: string): Promise<EbAccount> {
    return this.call<EbAccount>("GET", `/accounts/${encodeURIComponent(uid)}/details`);
  }

  async getBalances(uid: string): Promise<EbBalance[]> {
    const r = await this.call<{ balances: EbBalance[] }>(
      "GET",
      `/accounts/${encodeURIComponent(uid)}/balances`,
    );
    return r.balances;
  }

  /**
   * Every transaction from `dateFrom`, following continuation keys. "longest" asks the bank for
   * as much history as it gives, for the first sync, when banks allow the most.
   */
  async getTransactions(
    uid: string,
    dateFrom: string,
    strategy: "default" | "longest" = "default",
  ): Promise<EbTransaction[]> {
    const out: EbTransaction[] = [];
    let key: string | null = null;
    for (let page = 0; page < 500; page++) {
      const q = new URLSearchParams({ date_from: dateFrom });
      if (strategy === "longest") q.set("strategy", "longest");
      if (key) q.set("continuation_key", key);
      const r: { transactions: EbTransaction[]; continuation_key?: string | null } =
        await this.call("GET", `/accounts/${encodeURIComponent(uid)}/transactions?${q}`);
      out.push(...r.transactions);
      key = r.continuation_key ?? null;
      if (!key) return out;
    }
    throw new Error(`Enable Banking: too many transaction pages for account ${uid}`);
  }

  /** Ends the session and, where the bank allows, its consent. */
  async deleteSession(sessionId: string): Promise<void> {
    await this.call("DELETE", `/sessions/${encodeURIComponent(sessionId)}`);
  }
}
