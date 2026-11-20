import { eq } from "drizzle-orm";
import { afterAll, describe, expect, inject, it } from "vitest";
import { connect } from "../src/db/client.js";
import {
  account,
  appUser,
  balanceSnapshot,
  item,
  marketReading,
  transaction,
} from "../src/db/schema.js";
import { forUserRegion } from "../src/facts/catalogs.js";
import { readTreasuryBenchmark } from "../src/facts/read.js";
import { CANADA_TBILL_SERIES } from "../src/facts/refresh.js";
import { connectAgent } from "../src/mcp/agentDb.js";
import { detectMisallocations } from "../src/misallocation/detect.js";
import { parsePolicy } from "../src/policy/policy.js";
import { readSnapshot } from "../src/policy/snapshot.js";
import { applyStyle, styleStatus } from "../src/policy/styles.js";
import { loadSecurityCatalogFile } from "../src/portfolio/securityCatalog.js";
import { parseCardCatalog } from "../src/products/cardCatalog.js";
import { parseCatalog } from "../src/products/catalog.js";
import { formatMoney, plaidCountries, regionOf } from "../src/region.js";
import { createUser, parseCountry, readAgentRegion, setCountry } from "../src/users.js";

const TODAY = "2026-11-20";

describe("regions", () => {
  it("knows each country's currency and refuses ones it doesn't know", () => {
    expect(regionOf("CA")).toEqual({ country: "CA", currency: "CAD" });
    expect(regionOf("gb")).toEqual({ country: "GB", currency: "GBP" });
    expect(regionOf("DE")).toEqual({ country: "DE", currency: "EUR" });
    expect(regionOf("PL")).toEqual({ country: "PL", currency: "PLN" });
    expect(regionOf(null)).toEqual({ country: "US", currency: "USD" });
    expect(() => regionOf("XX")).toThrow(/unknown country/);
    expect(parseCountry(" ca ")).toBe("CA");
    expect(() => parseCountry("Narnia")).toThrow(/not a country Tidysum knows/);
  });

  it("writes money in the user's own currency, and names any other", () => {
    expect(formatMoney("1234.5", "USD")).toBe("$1,235");
    expect(formatMoney("1234.4", "CAD")).toBe("$1,234");
    expect(formatMoney("-20", "GBP")).toBe("-£20");
    expect(formatMoney("1000000", "EUR")).toBe("€1,000,000");
    expect(formatMoney("50", "USD", "CAD")).toBe("US$50");
    expect(formatMoney("50", "CAD", "USD")).toBe("CA$50");
    expect(formatMoney("50", "PLN")).toBe("PLN 50");
  });

  it("offers Plaid's free-plan countries, and Europe only with Plaid's European access", () => {
    expect(plaidCountries(regionOf("US"), false)).toEqual({ codes: ["US"] });
    expect(plaidCountries(regionOf("CA"), false)).toEqual({ codes: ["CA", "US"] });
    expect(plaidCountries(regionOf("FR"), false)).toMatchObject({
      unavailable: expect.stringMatching(/France.*import-csv/),
    });
    expect(plaidCountries(regionOf("FR"), true)).toEqual({ codes: ["FR"] });
    // Plaid doesn't cover every EU country.
    expect(plaidCountries(regionOf("GR"), true)).toHaveProperty("unavailable");
  });
});

const deposits = parseCatalog({
  version: 1,
  products: [
    {
      id: "us-savings",
      provider: "US Bank",
      institutions: ["us bank"],
      name: "US Savings",
      kind: "savings",
      insurance: "FDIC",
      apy: [{ from: "0", apy: "4.00" }],
      monthly_fee: "0.00",
      overdraft_fees: false,
      source_url: "https://us.example/rates",
      rates_as_of: "2026-11-01",
      verified_on: "2026-11-19",
    },
    {
      id: "ca-savings",
      country: "CA",
      provider: "Canada Bank",
      institutions: ["canada bank"],
      name: "Canada Savings",
      kind: "savings",
      insurance: "CDIC",
      apy: [{ from: "0", apy: "3.00" }],
      monthly_fee: "0.00",
      overdraft_fees: false,
      source_url: "https://ca.example/rates",
      rates_as_of: "2026-11-01",
      verified_on: "2026-11-19",
    },
  ],
});

const cards = parseCardCatalog({
  version: 1,
  categories: { groceries: { label: "Groceries", codes: { plaid: ["FOOD_AND_DRINK_GROCERIES"] } } },
  cards: [
    {
      id: "us-card",
      issuer: "US Bank",
      name: "US Card",
      annual_fee: "0",
      foreign_transaction_fee: "0",
      reward: { currency: "cash" },
      base_rate: "2",
      source_url: "https://us.example/card",
      verified_on: "2026-11-19",
    },
  ],
});

describe("a user in Canada", () => {
  const url = inject("databaseUrl");
  const owner = connect(url);
  let userId = "";
  let agentDb: ReturnType<typeof connectAgent> | undefined;

  afterAll(async () => {
    await agentDb?.end();
    if (userId) await owner.db.delete(appUser).where(eq(appUser.id, userId));
    await owner.close();
  });

  it("counts only Canadian dollars, is offered only Canadian products, and gets no US tax advice", async () => {
    const { db } = owner;
    userId = await createUser(db, "Canada test", true, "US");
    expect(await setCountry(db, userId, "ca")).toEqual({ country: "CA", currency: "CAD" });
    agentDb = connectAgent(url, userId);
    expect(await readAgentRegion(agentDb)).toEqual({ country: "CA", currency: "CAD" });

    const [it] = await db
      .insert(item)
      .values({
        userId,
        source: "plaid",
        plaidItemId: "canada-item",
        institutionName: "Big Canadian Bank",
        lastSyncedAt: new Date(`${TODAY}T08:00:00Z`),
      })
      .returning();
    if (!it) throw new Error("no item");
    const base = { userId, itemId: it.id, type: "depository" };
    const [chequing, usd, card] = await db
      .insert(account)
      .values([
        { ...base, name: "Chequing", subtype: "checking", currency: "CAD" },
        { ...base, name: "US Dollar Savings", subtype: "savings", currency: "USD" },
        {
          userId,
          itemId: it.id,
          name: "Visa",
          type: "credit",
          subtype: "credit card",
          currency: "CAD",
        },
      ])
      .returning();
    if (!chequing || !usd || !card) throw new Error("no accounts");
    const asOf = new Date(`${TODAY}T08:00:00Z`);
    await db.insert(balanceSnapshot).values([
      { userId, accountId: chequing.id, current: "10000.00", asOf },
      { userId, accountId: usd.id, current: "5000.00", asOf },
    ]);
    await db.insert(transaction).values({
      userId,
      accountId: card.id,
      plaidTransactionId: "ca-fx-fee",
      date: "2026-10-01",
      amount: "25.00",
      name: "Foreign transaction fee",
      categoryPrimary: "BANK_FEES",
      categoryDetailed: "BANK_FEES_FOREIGN_TRANSACTION_FEES",
      pending: false,
    });

    const snapshot = await readSnapshot(agentDb, TODAY);
    expect(snapshot.currency).toBe("CAD");
    expect(snapshot.accounts.map((a) => a.name).sort()).toEqual(["Chequing", "Visa"]);
    expect(snapshot.other_currency_accounts).toEqual([
      { id: usd.id, name: "US Dollar Savings", currency: "USD" },
    ]);

    const tools = forUserRegion(
      { loadCatalog: async () => deposits, loadCardCatalog: async () => cards },
      agentDb,
    );
    const catalogs = { deposits: await tools.loadCatalog(), cards: await tools.loadCardCatalog() };
    expect(catalogs.deposits.products.map((p) => p.id)).toEqual(["ca-savings"]);
    expect(catalogs.cards.cards).toEqual([]);

    const found = await detectMisallocations(agentDb, catalogs, TODAY);
    expect(found.ran).not.toContain("roth_ira");
    expect(found.ran).not.toContain("retirement_rate");
    expect(found.items.map((m) => [m.detector, m.product_id, m.annual_cost, m.currency])).toEqual([
      // 10,000 CAD earning nothing; 3% at a Canadian bank. The US dollar account isn't offered
      // a US bank it couldn't open.
      ["deposit_rate", "ca-savings", "300.00", "CAD"],
      ["foreign_fees", null, "25.00", "CAD"],
    ]);

    // Cash is measured against Canada's own treasury bills.
    await db
      .insert(marketReading)
      .values({ series: CANADA_TBILL_SERIES, day: "2026-11-17", value: "2.66" })
      .onConflictDoNothing();
    expect(await readTreasuryBenchmark(agentDb)).toMatchObject({
      name: "3-month Government of Canada treasury bill yield",
      source_url: expect.stringContaining("bankofcanada.ca"),
    });
  });
});

describe("money styles outside the US", () => {
  it("fill a Canadian's buckets with Canadian-listed funds first, and still count US ones", async () => {
    const p = parsePolicy(applyStyle(null, "adviser_standard", { age: 40, country: "CA" })).policy;
    expect(p.style).toEqual({ id: "adviser_standard", age: 40, country: "CA" });
    const buckets = p.allocation?.buckets ?? {};
    expect(buckets.us_stocks?.tickers.slice(0, 2)).toEqual(["XUU", "VUN"]);
    expect(buckets.us_stocks?.tickers).toContain("VTI");
    expect(buckets.intl_stocks?.tickers[0]).toBe("XEF");
    expect(buckets.bonds_and_cash?.tickers[0]).toBe("ZAG");
    // The style is recognised as itself, with nothing changed.
    expect(styleStatus(p)?.tweaks).toEqual([]);
    // A US owner's policy is as before.
    expect(applyStyle(null, "adviser_standard", { age: 40, country: "US" }).style).toEqual({
      id: "adviser_standard",
      age: 40,
    });

    // Every Canadian fund a style buys is in the catalog, with what it holds.
    const catalog = await loadSecurityCatalogFile("catalog/securities.json");
    const known = new Set(catalog.securities.map((s) => s.ticker));
    for (const b of Object.values(buckets)) {
      for (const t of b.tickers.slice(0, 3)) expect(known, t).toContain(t);
    }
    expect(catalog.default_buy_by_country.CA?.us_stocks).toBe("XUU");
  });
});
