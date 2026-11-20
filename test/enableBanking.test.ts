import { createVerify, generateKeyPairSync, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, inject, it } from "vitest";
import { TokenCipher } from "../src/crypto/tokenCipher.js";
import { connect } from "../src/db/client.js";
import { account, appUser, balanceSnapshot, item, transaction } from "../src/db/schema.js";
import { EnableBankingClient } from "../src/enableBanking/client.js";
import {
  EnableBankingGateway,
  mapAccount,
  mapTransactions,
  withEnableBanking,
} from "../src/enableBanking/gateway.js";
import { BankLinks } from "../src/enableBanking/link.js";
import { connectAgent } from "../src/mcp/agentDb.js";
import { PlaidWebhookVerifier } from "../src/plaid/webhookVerifier.js";
import { createApp } from "../src/server/app.js";
import { SyncScheduler } from "../src/sync/scheduler.js";
import { syncItem } from "../src/sync/syncItem.js";
import { createUser } from "../src/users.js";
import { FakePlaid } from "./fakePlaid.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const NOW = new Date("2026-11-20T12:00:00Z");

describe("Enable Banking shapes", () => {
  it("signs each request with a short RS256 JWT naming the application", () => {
    const client = new EnableBankingClient("app-123", privateKey, fetch, () => NOW);
    const [head, body, sig] = client.jwt().split(".") as [string, string, string];
    const json = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString());
    expect(json(head)).toEqual({ typ: "JWT", alg: "RS256", kid: "app-123" });
    const iat = NOW.getTime() / 1000;
    expect(json(body)).toEqual({
      iss: "enablebanking.com",
      aud: "api.enablebanking.com",
      iat,
      exp: iat + 3600,
    });
    const ok = createVerify("RSA-SHA256")
      .update(`${head}.${body}`)
      .verify(publicKey, Buffer.from(sig, "base64url"));
    expect(ok).toBe(true);
  });

  it("reads accounts as the sync knows them: booked balances, a card's debt above zero", () => {
    const current = mapAccount(
      "item-1",
      {
        uid: "u1",
        identification_hash: "h1",
        account_id: { iban: "GB33BUKB20201555555555" },
        cash_account_type: "CACC",
        currency: "GBP",
        name: "Current Account",
      },
      [
        { balance_type: "ITAV", balance_amount: { currency: "GBP", amount: "1200.50" } },
        { balance_type: "CLBD", balance_amount: { currency: "GBP", amount: "1250.00" } },
      ],
    );
    expect(current).toMatchObject({
      name: "Current Account",
      type: "depository",
      subtype: "checking",
      mask: "5555",
      currency: "GBP",
      balances: { current: "1250", available: "1200.50", limit: null },
    });
    // The account id doesn't change with a new consent, and differs per item.
    expect(current.accountId).toBe(
      mapAccount("item-1", { uid: "other", identification_hash: "h1" }, []).accountId,
    );
    expect(current.accountId).not.toBe(
      mapAccount("item-2", { uid: "u1", identification_hash: "h1" }, []).accountId,
    );
    const card = mapAccount(
      "item-1",
      { uid: "u2", identification_hash: "h2", cash_account_type: "CARD", product: "Visa" },
      [{ balance_type: "CLBD", balance_amount: { currency: "EUR", amount: "-310.20" } }],
    );
    expect(card).toMatchObject({
      name: "Visa",
      type: "credit",
      currency: "EUR",
      balances: { current: "310.2" },
    });
  });

  it("books money out as positive, skips pending, and keeps identical payments apart", () => {
    const t = (over: Record<string, unknown>) => ({
      transaction_amount: { currency: "GBP", amount: "4.50" },
      credit_debit_indicator: "DBIT" as const,
      status: "BOOK",
      booking_date: "2026-11-18",
      remittance_information: ["CARD PAYMENT TO PRET"],
      ...over,
    });
    const rows = mapTransactions("eb:acct", [
      t({ entry_reference: "r1", creditor: { name: "Pret A Manger" } }),
      t({
        credit_debit_indicator: "CRDT",
        transaction_amount: { currency: "GBP", amount: "2000" },
      }),
      t({ status: "PDNG", entry_reference: "r9" }),
      t({}),
      t({}),
    ]);
    expect(rows.map((r) => [r.amount, r.name, r.merchantName, r.pending])).toEqual([
      ["4.5", "CARD PAYMENT TO PRET", "Pret A Manger", false],
      ["-2000", "CARD PAYMENT TO PRET", null, false],
      ["4.5", "CARD PAYMENT TO PRET", null, false],
      ["4.5", "CARD PAYMENT TO PRET", null, false],
    ]);
    expect(new Set(rows.map((r) => r.transactionId)).size).toBe(4);
    // The same input gives the same ids, so a later sync updates rather than duplicates.
    expect(mapTransactions("eb:acct", [t({ entry_reference: "r1" })])[0]?.transactionId).toBe(
      rows[0]?.transactionId,
    );
  });
});

/** A small Enable Banking: one bank, one session, two accounts. */
function fakeEnableBanking() {
  const calls: { method: string; path: string; body: unknown }[] = [];
  let sessionState = "AUTHORIZED";
  const json = (v: unknown, status = 200) =>
    new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname + url.search, body });
    if (!String((init?.headers as Record<string, string>)?.Authorization).startsWith("Bearer ")) {
      return json({ error: "UNAUTHORIZED" }, 401);
    }
    const p = url.pathname;
    if (p === "/aspsps") {
      return json({
        aspsps: [
          {
            name: "Monzo",
            country: "GB",
            maximum_consent_validity: 7776000,
            psu_types: ["personal"],
          },
        ],
      });
    }
    if (p === "/auth" && method === "POST") {
      return json({ url: "https://bank.example/consent", authorization_id: "a1" });
    }
    if (p === "/sessions" && method === "POST") {
      return json({
        session_id: "sess-1",
        accounts: [{ uid: "u1", identification_hash: "h1" }],
        aspsp: { name: "Monzo", country: "GB" },
        access: { valid_until: "2027-02-18T00:00:00Z" },
      });
    }
    if (p === "/sessions/sess-1" && method === "GET") {
      if (sessionState !== "AUTHORIZED") return json({ error: "EXPIRED_SESSION" }, 401);
      return json({
        status: "AUTHORIZED",
        access: { valid_until: "2027-02-18T00:00:00Z" },
        accounts_data: [
          { uid: "u1", identification_hash: "h1" },
          { uid: "u2", identification_hash: "h2" },
        ],
      });
    }
    if (p === "/accounts/u1/details") {
      return json({ name: "Current", cash_account_type: "CACC", currency: "GBP" });
    }
    if (p === "/accounts/u2/details") {
      return json({ name: "Savings Pot", cash_account_type: "SVGS", currency: "GBP" });
    }
    if (p === "/accounts/u1/balances") {
      return json({
        balances: [
          { balance_type: "CLBD", balance_amount: { currency: "GBP", amount: "2500.00" } },
        ],
      });
    }
    if (p === "/accounts/u2/balances") {
      return json({
        balances: [
          { balance_type: "CLBD", balance_amount: { currency: "GBP", amount: "8000.00" } },
        ],
      });
    }
    if (p === "/accounts/u1/transactions") {
      if (!url.searchParams.get("continuation_key")) {
        return json({
          transactions: [
            {
              entry_reference: "e1",
              transaction_amount: { currency: "GBP", amount: "12.00" },
              credit_debit_indicator: "DBIT",
              status: "BOOK",
              booking_date: "2026-11-10",
              remittance_information: ["TESCO STORES"],
            },
          ],
          continuation_key: "next",
        });
      }
      return json({
        transactions: [
          {
            entry_reference: "e2",
            transaction_amount: { currency: "GBP", amount: "3000.00" },
            credit_debit_indicator: "CRDT",
            status: "BOOK",
            booking_date: "2026-11-01",
            debtor: { name: "Employer Ltd" },
          },
        ],
        continuation_key: null,
      });
    }
    if (p === "/accounts/u2/transactions")
      return json({ transactions: [], continuation_key: null });
    if (p === "/sessions/sess-1" && method === "DELETE") return json({ message: "OK" });
    return json({ error: "NOT_FOUND" }, 404);
  }) as typeof fetch;
  return {
    fetcher,
    calls,
    expire: () => {
      sessionState = "EXPIRED";
    },
  };
}

describe("linking and syncing a UK bank", () => {
  const url = inject("databaseUrl");
  const owner = connect(url);
  const cipher = new TokenCipher(randomBytes(32).toString("base64"));
  let userId = "";
  const agents: ReturnType<typeof connectAgent>[] = [];

  afterAll(async () => {
    await Promise.all(agents.map((a) => a.end()));
    if (userId) await owner.db.delete(appUser).where(eq(appUser.id, userId));
    await owner.close();
  });

  it("links through the bank's sign-in, syncs in pounds, and asks to reconnect when consent ends", async () => {
    const { db } = owner;
    userId = await createUser(db, "UK test", false, "GB");
    const agentDb = connectAgent(url, userId);
    agents.push(agentDb);
    const eb = fakeEnableBanking();
    const client = new EnableBankingClient("app-123", privateKey, eb.fetcher, () => NOW);
    const plaid = withEnableBanking(new FakePlaid(), new EnableBankingGateway(client, () => NOW));
    const scheduler = new SyncScheduler(db, plaid, cipher);
    const app = createApp({
      db,
      plaid,
      cipher,
      scheduler,
      verifier: new PlaidWebhookVerifier(plaid),
      daysRequested: 730,
      userId,
      agentDb,
      bankLinks: new BankLinks(client, undefined, () => NOW),
    });
    const local = "http://127.0.0.1:8080";
    const json = { "Content-Type": "application/json", Origin: local };

    const items = (await (await app.request(`${local}/api/items`)).json()) as {
      country: string;
      currency: string;
      bankLinks: boolean;
    };
    expect(items).toMatchObject({ country: "GB", currency: "GBP", bankLinks: true });
    // Plaid's free plan can't reach UK banks; the page points to the bank link instead.
    const plaidLink = await app.request(`${local}/api/link-token`, {
      method: "POST",
      headers: json,
      body: "{}",
    });
    expect(((await plaidLink.json()) as { error: string }).error).toMatch(/Link a bank/);

    const banks = await (await app.request(`${local}/api/banks`)).json();
    expect(banks).toEqual({ country: "GB", banks: [{ name: "Monzo", logo: null }] });

    const started = await app.request(`${local}/api/bank-link`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ name: "Monzo", country: "GB" }),
    });
    expect(await started.json()).toEqual({ url: "https://bank.example/consent" });
    const auth = eb.calls.find((c) => c.path === "/auth")?.body as {
      access: { valid_until: string };
      redirect_url: string;
      state: string;
      psu_type: string;
    };
    expect(auth.redirect_url).toBe(`${local}/enable-banking/callback`);
    expect(auth.psu_type).toBe("personal");
    // 90 days, the bank's limit, less a minute.
    expect(auth.access.valid_until).toBe("2027-02-18T11:59:00.000Z");
    // The state carries this Tidysum's address for the https forwarding page.
    expect(Buffer.from(auth.state.split(".")[1] ?? "", "base64url").toString()).toBe(local);

    const forged = await app.request(`${local}/enable-banking/callback?state=nope.x&code=c`);
    expect(forged.status).toBe(400);
    expect(await forged.text()).toMatch(/wasn&#39;t started here|wasn't started here/);

    const back = await app.request(
      `${local}/enable-banking/callback?state=${encodeURIComponent(auth.state)}&code=good`,
    );
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe("/#connections");
    await scheduler.idle();

    const [linked] = await db
      .select()
      .from(item)
      .where(and(eq(item.userId, userId), eq(item.source, "enable_banking")));
    expect(linked).toMatchObject({
      institutionName: "Monzo",
      institutionId: "eb:GB:Monzo",
      status: "active",
    });
    const accounts = await db.select().from(account).where(eq(account.userId, userId));
    expect(accounts.map((a) => [a.name, a.subtype, a.currency]).sort()).toEqual([
      ["Current", "checking", "GBP"],
      ["Savings Pot", "savings", "GBP"],
    ]);
    const balances = await db
      .select()
      .from(balanceSnapshot)
      .where(eq(balanceSnapshot.userId, userId));
    expect(balances.map((b) => b.current).sort()).toEqual(["2500.0000", "8000.0000"]);
    const txns = await db.select().from(transaction).where(eq(transaction.userId, userId));
    expect(txns.map((t) => [t.date, t.amount, t.name]).sort()).toEqual([
      ["2026-11-01", "-3000.0000", "Employer Ltd"],
      ["2026-11-10", "12.0000", "TESCO STORES"],
    ]);
    // The first sync asked for all the history the bank gives.
    expect(eb.calls.some((c) => c.path.includes("strategy=longest"))).toBe(true);

    // A later sync re-reads two weeks before the last one, and adds nothing twice.
    eb.calls.length = 0;
    const again = await syncItem(db, plaid, cipher, linked?.id ?? "", () => NOW);
    expect(again.status).toBe("succeeded");
    expect(eb.calls.find((c) => c.path.startsWith("/accounts/u1/transactions"))?.path).toContain(
      "date_from=2026-11-06",
    );
    expect(await db.select().from(transaction).where(eq(transaction.userId, userId))).toHaveLength(
      2,
    );

    // When the bank's consent runs out, the connection asks to be reconnected.
    eb.expire();
    const expired = await syncItem(db, plaid, cipher, linked?.id ?? "", () => NOW);
    expect(expired.status).toBe("failed");
    const [after] = await db
      .select()
      .from(item)
      .where(eq(item.id, linked?.id ?? ""));
    expect(after?.status).toBe("relink_required");
  });
});
