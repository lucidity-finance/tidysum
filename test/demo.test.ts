import Big from "big.js";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { TokenCipher } from "../src/crypto/tokenCipher.js";
import { connect } from "../src/db/client.js";
import { DemoPlaid } from "../src/demo/gateway.js";
import { demoHousehold } from "../src/demo/household.js";
import { resetDemoDatabase, seedDemo } from "../src/demo/seed.js";
import { type AgentDb, connectAgent } from "../src/mcp/agentDb.js";
import { listMisallocations } from "../src/misallocation/ledger.js";
import { PlaidWebhookVerifier } from "../src/plaid/webhookVerifier.js";
import { loadSecurityCatalogFile } from "../src/portfolio/securityCatalog.js";
import { loadCardCatalogFile } from "../src/products/cardCatalog.js";
import { loadCatalogFile } from "../src/products/catalog.js";
import { createApp } from "../src/server/app.js";
import { SyncScheduler } from "../src/sync/scheduler.js";
import { createUser } from "../src/users.js";

const TODAY = "2026-11-19";

function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error("missing");
  return v;
}
const url = inject("databaseUrl");
const h = connect(url);
const products = {
  loadCatalog: () => loadCatalogFile("catalog/deposit-products.json"),
  loadCardCatalog: () => loadCardCatalogFile("catalog/credit-cards.json"),
  loadSecurityCatalog: () => loadSecurityCatalogFile("catalog/securities.json"),
  today: () => TODAY,
};

describe("demo household", () => {
  it("is the same household every time for the same day", () => {
    expect(demoHousehold(TODAY)).toEqual(demoHousehold(TODAY));
  });

  it("has two years of exact, decimal-string money and a checking account never overdrawn", () => {
    const hh = demoHousehold(TODAY);
    const all = hh.institutions.flatMap((i) => i.transactions);
    expect(all.length).toBeGreaterThan(500);
    for (const t of all) {
      expect(t.amount).toMatch(/^-?\d+\.\d{2}$/);
      expect(t.date <= TODAY).toBe(true);
    }
    const dates = all.map((t) => t.date).sort();
    expect(dates[0] && dates[0] <= "2024-11-21").toBe(true);

    const chase = must(hh.institutions.find((i) => i.name === "Chase"));
    const checking = must(chase.accounts.find((a) => a.subtype === "checking"));
    // Walk back from today's balance: every day-end balance stays above zero.
    const flows = chase.transactions
      .filter((t) => t.accountId === checking.accountId)
      .sort((a, b) => b.date.localeCompare(a.date));
    let balance = new Big(must(checking.balances.current));
    for (const t of flows) {
      balance = balance.plus(t.amount);
      expect(balance.gt(0)).toBe(true);
    }
  });
});

describe("tidysum demo", () => {
  let agentDb: AgentDb;
  let userId: string;

  beforeAll(async () => {
    // The shared test database already has users; the demo household gets one of its own.
    userId = await createUser(h.db, "Demo test");
    const seeded = await seedDemo(
      h.db,
      demoHousehold(TODAY),
      products,
      (id) => connectAgent(url, id),
      {
        userId,
      },
    );
    agentDb = seeded.agentDb;
  });

  afterAll(async () => {
    await agentDb?.end();
    await h.close();
  });

  it("finds what the household was made to show, through the real pipeline", async () => {
    const report = await listMisallocations(agentDb, { state: "open", limit: 100 });
    const detectors = new Set(report.misallocations.map((m) => m.detector));
    for (const d of [
      "deposit_rate",
      "card_wallet",
      "card_usage",
      "foreign_fees",
      "fund_fee",
      "roth_ira",
      "retirement_rate",
    ]) {
      expect(detectors, d).toContain(d);
    }
    expect(new Big(must(report.totals).open_annual_cost).gt(1000)).toBe(true);
  });

  it("serves the page as a demo that can't link or remove real accounts", async () => {
    const plaid = new DemoPlaid(demoHousehold(TODAY));
    const cipher = new TokenCipher(Buffer.alloc(32, 1).toString("base64"));
    const app = createApp({
      db: h.db,
      plaid,
      cipher,
      scheduler: new SyncScheduler(h.db, plaid, cipher, () => {}),
      verifier: new PlaidWebhookVerifier(plaid),
      daysRequested: 730,
      userId,
      agentDb,
      products,
      demo: true,
    });
    const local = { headers: { host: "127.0.0.1:8090" } };
    const items = await app.request("/api/items", local);
    expect(await items.json()).toMatchObject({ demo: true });
    const post = (path: string) =>
      app.request(path, {
        method: "POST",
        headers: {
          host: "127.0.0.1:8090",
          origin: "http://127.0.0.1:8090",
          "content-type": "application/json",
        },
        body: "{}",
      });
    expect((await post("/api/link-token")).status).toBe(403);
    expect((await post("/api/items")).status).toBe(403);
    const listed = (await (await app.request("/api/items", local)).json()) as {
      items: { id: string }[];
    };
    const first = must(listed.items[0]);
    expect((await post(`/api/items/${first.id}/remove`)).status).toBe(403);
  });

  it("only resets a database named tidysum_demo, on a server holding nothing else", async () => {
    await expect(resetDemoDatabase(url)).rejects.toThrow(/tidysum_demo/);
    const demoUrl = new URL(url);
    demoUrl.pathname = "/tidysum_demo";
    // The test server keeps Tidysum's tables in its postgres database, like a real install could.
    await expect(resetDemoDatabase(demoUrl.toString())).rejects.toThrow(/refusing/);
  });
});
