import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { cardsPath } from "../src/config.js";
import { connect } from "../src/db/client.js";
import { account, item, transaction } from "../src/db/schema.js";
import { connectAgent } from "../src/mcp/agentDb.js";
import { createTidysumMcpServer } from "../src/mcp/server.js";
import { setCardAssignment } from "../src/products/cardAssignments.js";
import { loadCardCatalogFile, parseCardCatalog } from "../src/products/cardCatalog.js";
import {
  adviseOnPurchase,
  type CardReport,
  compareCards,
  type HeldCardRow,
  type PurchaseAdvice,
  readHeldCards,
  readSpending,
  type SpendRow,
} from "../src/products/cards.js";
import { createUser } from "../src/users.js";
import { ownerUserId } from "./users.js";

const TODAY = "2026-10-30";
const MYSTERY = "00000000-0000-4000-8000-0000000000c1";

const card = (over: Record<string, unknown>) => ({
  issuer: "Test Bank",
  annual_fee: "0",
  foreign_transaction_fee: "0",
  reward: { currency: "cash" },
  base_rate: "1",
  source_url: "https://bank.example/card",
  verified_on: "2026-10-29",
  ...over,
});

const catalog = parseCardCatalog({
  version: 1,
  categories: {
    dining: { label: "Restaurants", codes: { plaid: ["FOOD_AND_DRINK_RESTAURANT"] } },
    groceries: { label: "Groceries", codes: { plaid: ["FOOD_AND_DRINK_GROCERIES"] } },
    rent: { label: "Rent", codes: { plaid: ["RENT_AND_UTILITIES_RENT"] }, card_payable: false },
  },
  cards: [
    card({ id: "flat-2", name: "Flat Two", base_rate: "2", match: ["flat two"] }),
    card({
      id: "grocer-6",
      name: "Grocer Six",
      annual_fee: "95",
      rates: [
        {
          category: "groceries",
          label: "supermarkets",
          rate: "6",
          cap: { amount: "1000", period: "year" },
        },
      ],
    }),
    card({
      id: "diner-points",
      name: "Diner Points",
      reward: { currency: "points", program: "Test Points", cents_per_point: "0.8" },
      rates: [{ category: "dining", label: "dining", rate: "4" }],
    }),
    card({
      id: "amazon-5",
      name: "Amazon Five",
      rates: [{ merchants: ["Amazon"], label: "Amazon", rate: "5" }],
    }),
    card({
      id: "rent-card",
      name: "Rent Card",
      rates: [{ category: "rent", label: "rent", rate: "1" }],
    }),
  ],
});

const spend = (
  source: SpendRow["source"],
  detailed: string,
  merchant: string,
  amount: string,
): SpendRow => ({
  source,
  category_detailed: detailed,
  category_primary: detailed.split("_")[0] ?? null,
  merchant,
  amount,
});

const spending = [
  spend("credit", "FOOD_AND_DRINK_GROCERIES", "kroger", "2000"),
  spend("debit", "FOOD_AND_DRINK_RESTAURANT", "cafe", "1000"),
  spend("credit", "GENERAL_MERCHANDISE_SUPERSTORES", "costco", "3000"),
  spend("credit", "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES", "amazon.com", "500"),
  spend("debit", "RENT_AND_UTILITIES_RENT", "landlord", "12000"),
];
const held: HeldCardRow[] = [
  { account_id: MYSTERY, name: "Card", official_name: "Mystery Rewards", institution_name: "Bank" },
];

describe("card catalog", () => {
  it("the checked-in catalog is valid", async () => {
    const real = await loadCardCatalogFile(cardsPath({}));
    expect(real.cards.length).toBeGreaterThan(0);
    for (const c of real.cards) expect(c.source_url).toMatch(/^https:\/\//);
  });

  it("rejects rates for unknown categories and duplicate ids", () => {
    const parse = (cards: unknown[]) => () =>
      parseCardCatalog({ version: 1, categories: {}, cards });
    expect(
      parse([card({ id: "x", name: "X", rates: [{ category: "nope", label: "n", rate: "2" }] })]),
    ).toThrow(/unknown category nope/);
    expect(parse([card({ id: "x", name: "X" }), card({ id: "x", name: "Y" })])).toThrow(
      /duplicate card id/,
    );
  });
});

describe("compareCards", () => {
  const r = compareCards(catalog, spending, held, TODAY);

  it("assumes 1% for a card it can't identify, and says so", () => {
    expect(r.held_cards[0]).toMatchObject({ card_id: null, identified_by: "assumed" });
    expect(r.warnings).toEqual([expect.stringMatching(/Mystery Rewards.*assumed to earn 1%/)]);
  });

  it("totals spending, keeping rent apart as not card-payable", () => {
    expect(r.spending).toMatchObject({
      on_cards: "5500.00",
      from_bank_card_payable: "1000.00",
      not_card_payable: "12000.00",
    });
    expect(r.rewards).toEqual({
      current: "55.00", // 5500 on cards at 1%
      with_bank_spending_on_cards: "65.00", // plus the 1000 of dining
      with_recommended_cards: "265.00",
    });
  });

  it("ranks new cards by gain after fees, with caps, points value and merchant rates", () => {
    expect(r.recommendations.map((c) => [c.card_id, c.added_rewards, c.annual_gain])).toEqual([
      ["rent-card", "120.00", "120.00"], // 1% on 12000 of rent nobody else pays on
      ["flat-2", "65.00", "65.00"], // an extra 1% on 6500
      ["diner-points", "22.00", "22.00"], // 4 points at 0.8 cents = 3.2% on 1000, vs 1%
      ["amazon-5", "20.00", "20.00"], // 5% vs 1% on 500 at Amazon
      // grocer-6 adds 6% on the first 1000 of groceries (+50) but costs 95, so it's left out
    ]);
    expect(r.recommendations[1]?.earns_on).toEqual([
      { category: "Everything else", spend: "3500.00", percent: "2.00" },
      { category: "Groceries", spend: "2000.00", percent: "2.00" },
      { category: "Restaurants", spend: "1000.00", percent: "2.00" },
    ]);
  });

  it("builds a wallet one card at a time while each still pays for itself", () => {
    // After rent-card and flat-2, Amazon's 5% beats Diner's 3.2% over flat-2's 2%.
    expect(r.recommended_wallet).toEqual({
      card_ids: ["rent-card", "flat-2", "amazon-5"],
      // Each card's gain is on top of the ones before it, so they add up to the total.
      cards: [
        { card_id: "rent-card", name: "Rent Card", annual_gain: "120.00" },
        { card_id: "flat-2", name: "Flat Two", annual_gain: "65.00" },
        { card_id: "amazon-5", name: "Amazon Five", annual_gain: "15.00" },
      ],
      annual_gain: "200.00",
    });
    expect(r.disclosure).toMatch(/not paid by any bank/);
  });

  it("warns that interest outweighs rewards when cards charged any", () => {
    const w = compareCards(catalog, spending, held, TODAY, {}, "84.10");
    expect(w.warnings[0]).toMatch(/charged 84.10 in interest.*paying each statement in full/);
  });

  it("charges a card's membership unless the owner already pays for it", () => {
    const gold = parseCardCatalog({
      version: 1,
      categories: {},
      cards: [
        card({
          id: "gold-3",
          name: "Gold Three",
          base_rate: "3",
          membership: { name: "Robinhood Gold", annual_cost: "50" },
        }),
      ],
    });
    const rows = [spend("credit", "GENERAL_MERCHANDISE_SUPERSTORES", "target", "5000")];
    // 3% vs the held card's 1% on 5000 adds 100; the membership takes 50 of it.
    const charged = compareCards(gold, rows, held, TODAY);
    expect(charged.recommendations[0]).toMatchObject({
      added_rewards: "100.00",
      annual_gain: "50.00",
      membership: "Robinhood Gold, 50.00/yr",
      membership_already_paid: false,
    });
    const paid = compareCards(gold, rows, held, TODAY, {}, "0", ["robinhood gold"]);
    expect(paid.recommendations[0]).toMatchObject({
      annual_gain: "100.00",
      membership_already_paid: true,
    });
    expect(paid.recommended_wallet.annual_gain).toBe("100.00");
  });

  it("uses an override when the owner says which card it is", () => {
    const o = compareCards(catalog, spending, held, TODAY, { [MYSTERY]: "flat-2" });
    expect(o.held_cards[0]).toMatchObject({ card_id: "flat-2", identified_by: "override" });
    expect(o.rewards.current).toBe("110.00");
    expect(o.recommendations.map((c) => c.card_id)).not.toContain("flat-2");
    expect(() => compareCards(catalog, spending, held, TODAY, { [MYSTERY]: "nope" })).toThrow(
      /unknown card id/,
    );
  });

  it("identifies a card from its reported name", () => {
    const named = [{ ...held[0], official_name: "FLAT TWO Visa" } as HeldCardRow];
    expect(compareCards(catalog, spending, named, TODAY).held_cards[0]).toMatchObject({
      card_id: "flat-2",
      identified_by: "official_name",
    });
  });
});

describe("compareCards: which bank payments could go on a card", () => {
  const cat = parseCardCatalog({
    version: 1,
    categories: {
      groceries: { label: "Groceries", codes: { plaid: ["FOOD_AND_DRINK_GROCERIES"] } },
      utilities: {
        label: "Utilities",
        codes: { plaid: ["RENT_AND_UTILITIES_GAS_AND_ELECTRICITY"] },
        card_payable: false,
        card_note: "usually charges a card fee",
      },
    },
    acceptance: [
      {
        match: ["costco"],
        networks: ["visa"],
        note: "Costco warehouses take only Visa credit cards.",
        source_url: "https://costco.example/cards",
      },
    ],
    cards: [
      card({
        id: "master-2",
        name: "Master Two",
        network: "mastercard",
        base_rate: "2",
        match: ["master two"],
      }),
      card({ id: "visa-3", name: "Visa Three", network: "visa", base_rate: "3" }),
    ],
  });
  const row = (
    detailed: string,
    merchant: string,
    amount: string,
    payments: number,
    last_date: string,
    payee = merchant,
  ): SpendRow => ({
    source: "debit",
    category_detailed: detailed,
    category_primary: detailed.split("_")[0] ?? null,
    merchant,
    amount,
    payee,
    payments,
    last_date,
  });
  const bank = [
    row("GENERAL_MERCHANDISE_SUPERSTORES", "costco", "300", 4, "2026-10-01", "Costco"),
    row("TRANSPORTATION_GAS", "costco", "50", 2, "2026-10-01", "Costco"),
    row("RENT_AND_UTILITIES_GAS_AND_ELECTRICITY", "nes", "900", 9, "2026-10-20", "NES"),
    row(
      "PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS",
      "pf gym ppd id: g7",
      "100",
      4,
      "2026-02-17",
      "PF GYM PPD ID: G7",
    ),
    row("FOOD_AND_DRINK_GROCERIES", "corner market", "200", 5, "2026-10-25", "Corner Market"),
  ];
  const mine: HeldCardRow[] = [
    { account_id: MYSTERY, name: "Card", official_name: "Master Two", institution_name: "Bank" },
  ];
  const r = compareCards(cat, bank, mine, TODAY);

  it("lists each bank payee and whether a card you hold could take it", () => {
    expect(r.spending.bank_payees).toEqual([
      {
        payee: "Costco",
        categories: ["Everything else"],
        amount: "350.00",
        payments: 6,
        last_date: "2026-10-01",
        status: "card_not_accepted",
        note: "Costco warehouses take only Visa credit cards.",
      },
      {
        payee: "Corner Market",
        categories: ["Groceries"],
        amount: "200.00",
        payments: 5,
        last_date: "2026-10-25",
        status: "could_go_on_card",
        note: null,
      },
      {
        payee: "PF GYM",
        categories: ["Everything else"],
        amount: "100.00",
        payments: 4,
        last_date: "2026-02-17",
        status: "stopped",
        note: null,
      },
    ]);
  });

  it("counts only payees still paid that a held card can pay, and leaves utilities out", () => {
    expect(r.spending.from_bank_card_payable).toBe("200.00");
    expect(r.spending.not_card_payable).toBe("900.00");
    expect(r.rewards).toMatchObject({ current: "0.00", with_bank_spending_on_cards: "4.00" });
    expect(r.spending.by_category.find((c) => c.category === "utilities")).toMatchObject({
      card_payable: false,
      card_note: "usually charges a card fee",
    });
  });

  it("credits a Visa card with Costco, which only it can pay, but not the stopped gym", () => {
    const visa = r.recommendations.find((c) => c.card_id === "visa-3");
    // 3% on the 350 at Costco, plus 1% over Master Two on the 200 of groceries.
    expect(visa?.added_rewards).toBe("12.50");
  });
});

describe("compareCards: a rewards debit card", () => {
  const WALLET = "00000000-0000-4000-8000-0000000000d1";
  const CHECKING = "00000000-0000-4000-8000-0000000000d2";
  const cap = { amount: "1000", period: "month" };
  const cat = parseCardCatalog({
    version: 1,
    categories: {
      dining: { label: "Restaurants", codes: { plaid: ["FOOD_AND_DRINK_RESTAURANT"] } },
      groceries: { label: "Groceries", codes: { plaid: ["FOOD_AND_DRINK_GROCERIES"] } },
    },
    cards: [
      card({ id: "flat-2", name: "Flat Two", base_rate: "2", match: ["flat two"] }),
      card({
        id: "wallet-debit",
        name: "Wallet Debit",
        kind: "debit",
        base_rate: "0",
        choose_one: {
          label: "your monthly 5% category",
          rates: [
            { category: "groceries", label: "groceries", rate: "5", cap },
            { category: "dining", label: "restaurants", rate: "5", cap },
          ],
        },
        match: ["wallet"],
      }),
    ],
  });
  const row = (account_id: string, detailed: string, merchant: string, amount: string) => ({
    ...spend("debit", detailed, merchant, amount),
    account_id,
    payments: 10,
    last_date: "2026-10-25",
  });
  const mine: HeldCardRow[] = [
    { account_id: MYSTERY, name: "Card", official_name: "Flat Two", institution_name: "Bank" },
    {
      account_id: WALLET,
      type: "depository",
      name: "Wallet",
      official_name: null,
      institution_name: "Wallet Co",
    },
    {
      account_id: CHECKING,
      type: "depository",
      name: "CHECKING",
      official_name: null,
      institution_name: "Bank",
    },
  ];

  it("counts the wallet's purchases as card spending at its best monthly pick", () => {
    const r = compareCards(
      cat,
      [
        row(WALLET, "FOOD_AND_DRINK_GROCERIES", "kroger", "3000"),
        spend("credit", "FOOD_AND_DRINK_RESTAURANT", "cafe", "500"),
        row(CHECKING, "FOOD_AND_DRINK_GROCERIES", "corner market", "200"),
      ],
      mine,
      TODAY,
    );
    // A checking account that isn't a catalog debit card isn't a card at all.
    expect(r.held_cards).toEqual([
      expect.objectContaining({ card_id: "flat-2", kind: "credit" }),
      expect.objectContaining({
        account_id: WALLET,
        card_id: "wallet-debit",
        kind: "debit",
        identified_by: "official_name",
        pick: { label: "your monthly 5% category", choice: "Groceries" },
      }),
    ]);
    expect(r.spending).toMatchObject({ on_cards: "3500.00", from_bank_card_payable: "200.00" });
    expect(r.spending.bank_payees.map((p) => p.payee)).toEqual(["corner market"]);
    // 5% on 3,000 of groceries plus 2% on 500 at the cafe; then 5% on 200 more groceries.
    expect(r.rewards).toMatchObject({ current: "160.00", with_bank_spending_on_cards: "170.00" });
    expect(r.assumptions.join(" ")).toMatch(/one pick that earns you the most/);
  });

  it("picks whichever category earns more, within the monthly cap", () => {
    const r = compareCards(
      cat,
      [
        row(WALLET, "FOOD_AND_DRINK_GROCERIES", "kroger", "300"),
        spend("credit", "FOOD_AND_DRINK_RESTAURANT", "cafe", "15000"),
      ],
      mine,
      TODAY,
    );
    expect(r.held_cards[1]?.pick?.choice).toBe("Restaurants");
    // 5% on the first 12,000 a year of dining, 2% on the other 3,000 and on the 300 of groceries.
    expect(r.rewards.current).toBe("666.00");
  });

  it("doesn't count a payee as movable to a debit card that earns nothing there", () => {
    const r = compareCards(
      cat,
      [row(CHECKING, "GENERAL_MERCHANDISE_SUPERSTORES", "hardware", "400")],
      mine.slice(1),
      TODAY,
    );
    expect(r.spending.bank_payees).toEqual([
      expect.objectContaining({ payee: "hardware", status: "card_not_accepted" }),
    ]);
    expect(r.spending.from_bank_card_payable).toBe("0.00");
  });

  it("the checked-in catalog knows a PayPal account as PayPal Debit", async () => {
    const real = await loadCardCatalogFile(cardsPath({}));
    const r = compareCards(
      real,
      [row(WALLET, "FOOD_AND_DRINK_GROCERIES", "kroger", "1200")],
      [
        {
          account_id: WALLET,
          type: "depository",
          name: "PayPal",
          official_name: "PayPal",
          institution_name: "PayPal",
        },
      ],
      TODAY,
    );
    expect(r.held_cards).toEqual([
      expect.objectContaining({
        card_id: "paypal-debit",
        pick: { label: "your monthly 5% category", choice: "Groceries" },
      }),
    ]);
    expect(r.rewards.current).toBe("60.00");
  });
});

describe("adviseOnPurchase", () => {
  it("uses the merchant's past category and points to a better card", () => {
    const a = adviseOnPurchase(
      catalog,
      held,
      { merchant: "Amazon", amount: "80" },
      { category_detailed: "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES", category_primary: null },
    );
    expect(a.category_label).toBe("Everything else");
    expect(a.your_cards[0]).toMatchObject({ percent: "1.00", reward: "0.80" });
    expect(a.better_card_elsewhere).toMatchObject({ card_id: "amazon-5", percent: "5.00" });
  });

  it("takes foreign transaction fees off abroad, assuming 3% when unknown", () => {
    const a = adviseOnPurchase(catalog, held, { category: "dining", foreign: true }, null);
    expect(a.your_cards[0]).toMatchObject({ percent: "-2.00" });
    expect(a.your_cards[0]?.note).toMatch(/3.00% foreign transaction fee/);
    expect(a.better_card_elsewhere).toMatchObject({ card_id: "diner-points", percent: "3.20" });
  });

  it("doesn't put rent on a card without a rent rate", () => {
    const a = adviseOnPurchase(catalog, held, { category: "RENT_AND_UTILITIES_RENT" }, null);
    expect(a.category).toBe("rent");
    expect(a.your_cards[0]).toMatchObject({ percent: "0.00" });
    expect(a.better_card_elsewhere).toMatchObject({ card_id: "rent-card" });
  });
});

const owner = connect(inject("databaseUrl"));
const userId = await ownerUserId(owner.db);
const agentDb = connectAgent(inject("databaseUrl"), userId);
let client: Client;
const ids = { card: "", checking: "" };

async function seed() {
  const { db } = owner;
  await db.execute(sql`TRUNCATE item, security CASCADE`);
  const [it] = await db
    .insert(item)
    .values({ userId, source: "plaid", plaidItemId: "card-item", institutionName: "Chase" })
    .returning();
  if (!it) throw new Error("no item");
  const [cardAcct, checking] = await db
    .insert(account)
    .values([
      {
        userId,
        itemId: it.id,
        name: "CREDIT CARD",
        officialName: "Flat Two Rewards",
        type: "credit",
        subtype: "credit card",
      },
      { userId, itemId: it.id, name: "CHECKING", type: "depository", subtype: "checking" },
    ])
    .returning();
  if (!cardAcct || !checking) throw new Error("no accounts");
  Object.assign(ids, { card: cardAcct.id, checking: checking.id });
  let n = 0;
  const t = (
    accountId: string,
    date: string,
    amount: string,
    name: string,
    detailed: string,
    extra: Partial<typeof transaction.$inferInsert> = {},
  ) => ({
    userId,
    accountId,
    plaidTransactionId: `c${++n}`,
    date,
    amount,
    name,
    merchantName: name,
    categoryPrimary: detailed.split("_").slice(0, -1).join("_") || detailed,
    categoryDetailed: detailed,
    pending: false,
    ...extra,
  });
  await db.insert(transaction).values([
    t(cardAcct.id, "2026-03-01", "120.00", "Kroger", "FOOD_AND_DRINK_GROCERIES"),
    t(cardAcct.id, "2026-03-05", "-20.00", "Kroger", "FOOD_AND_DRINK_GROCERIES"), // refund
    t(cardAcct.id, "2026-04-01", "50.00", "Amazon", "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES"),
    t(cardAcct.id, "2026-10-29", "999.00", "Pending", "FOOD_AND_DRINK_GROCERIES", {
      pending: true,
    }),
    t(cardAcct.id, "2025-10-01", "999.00", "Too old", "FOOD_AND_DRINK_GROCERIES"),
    t(cardAcct.id, "2026-05-01", "-500.00", "Payment", "TRANSFER_IN_ACCOUNT_TRANSFER", {
      categoryPrimary: "TRANSFER_IN",
    }),
    t(checking.id, "2026-05-01", "500.00", "Chase card", "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT", {
      categoryPrimary: "LOAN_PAYMENTS",
    }),
    t(checking.id, "2026-05-02", "1000.00", "Landlord", "RENT_AND_UTILITIES_RENT", {
      categoryPrimary: "RENT_AND_UTILITIES",
    }),
    t(checking.id, "2026-05-03", "40.00", "Cafe", "FOOD_AND_DRINK_RESTAURANT"),
  ]);
}

beforeAll(async () => {
  await seed();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createTidysumMcpServer(agentDb, undefined, {
    loadCatalog: async () => {
      throw new Error("not used");
    },
    loadCardCatalog: async () => catalog,
    today: () => TODAY,
  }).connect(serverTransport);
  client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
  await agentDb.end();
  await owner.close();
});

async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await client.callTool({ name, arguments: args });
  const [first] = res.content as { text: string }[];
  if (res.isError) throw new Error(first?.text);
  return JSON.parse(first?.text ?? "null");
}

describe("card MCP tools", () => {
  it("compare_cards reads a year of purchases, net of refunds, without transfers or payments", async () => {
    const r = await call<CardReport>("compare_cards");
    expect(r.held_cards).toEqual([
      expect.objectContaining({ card_id: "flat-2", identified_by: "official_name" }),
    ]);
    expect(r.spending).toMatchObject({
      on_cards: "150.00", // 120 - 20 at Kroger, 50 at Amazon
      from_bank_card_payable: "40.00",
      not_card_payable: "1000.00",
    });
    expect(r.rewards.current).toBe("3.00");
    expect(r.rewards.with_bank_spending_on_cards).toBe("3.80");
  });

  it("best_card_for_purchase looks up the merchant's category from past purchases", async () => {
    const a = await call<PurchaseAdvice>("best_card_for_purchase", {
      merchant: "kroger",
      amount: "100",
    });
    expect(a.category).toBe("groceries");
    expect(a.category_basis).toMatch(/past purchases/);
    expect(a.your_cards[0]).toMatchObject({
      card_name: "Flat Two",
      percent: "2.00",
      reward: "2.00",
    });
    expect(a.better_card_elsewhere).toMatchObject({ card_id: "grocer-6", percent: "6.00" });
  });
});

describe("card assignments", () => {
  it("the card the user names wins over the bank's name for it", async () => {
    await setCardAssignment(owner.db, catalog, userId, ids.card, "grocer-6");
    const r = await call<CardReport>("compare_cards");
    expect(r.held_cards[0]).toMatchObject({ card_id: "grocer-6", identified_by: "assigned" });
    await setCardAssignment(owner.db, catalog, userId, ids.card, null);
    const cleared = await call<CardReport>("compare_cards");
    expect(cleared.held_cards[0]).toMatchObject({
      card_id: "flat-2",
      identified_by: "official_name",
    });
  });

  it("only takes catalog cards, for the user's own credit card accounts", async () => {
    await expect(setCardAssignment(owner.db, catalog, userId, ids.card, "nope")).rejects.toThrow(
      /unknown card id/,
    );
    await expect(
      setCardAssignment(owner.db, catalog, userId, ids.checking, "flat-2"),
    ).rejects.toThrow(/Flat Two is a credit card, but .* is a depository account/);
    const other = await createUser(owner.db, "Someone else");
    await expect(setCardAssignment(owner.db, catalog, other, ids.card, "flat-2")).rejects.toThrow(
      /no card account/,
    );
  });

  it("a bank or wallet account can be named as a debit card, and then counts as a card", async () => {
    const withDebit = parseCardCatalog({
      ...catalog,
      cards: [
        ...catalog.cards,
        card({ id: "debit-3", name: "Debit Three", kind: "debit", base_rate: "3" }),
      ],
    });
    await expect(
      setCardAssignment(owner.db, withDebit, userId, ids.card, "debit-3"),
    ).rejects.toThrow(/Debit Three is a debit card, but .* is a credit account/);
    await setCardAssignment(owner.db, withDebit, userId, ids.checking, "debit-3");
    try {
      const r = compareCards(
        withDebit,
        await readSpending(agentDb, TODAY),
        await readHeldCards(agentDb),
        TODAY,
      );
      expect(r.held_cards).toEqual([
        expect.objectContaining({ card_id: "flat-2", kind: "credit" }),
        expect.objectContaining({
          account_id: ids.checking,
          card_id: "debit-3",
          kind: "debit",
          identified_by: "assigned",
        }),
      ]);
      // The 40 at the cafe was paid with the debit card, so it is card spending now.
      expect(r.spending).toMatchObject({ on_cards: "190.00", from_bank_card_payable: "0.00" });
      expect(r.rewards.current).toBe("5.70"); // 3% on 190: Debit Three beats Flat Two everywhere
    } finally {
      await setCardAssignment(owner.db, withDebit, userId, ids.checking, null);
    }
  });

  it("agents can read their own user's assignments but never write them", async () => {
    await setCardAssignment(owner.db, catalog, userId, ids.card, "flat-2");
    const mine = await agentDb.query("select card_id from card_assignment");
    expect(mine.rows).toEqual([{ card_id: "flat-2" }]);
    const other = await createUser(owner.db, "Another user");
    const theirs = connectAgent(inject("databaseUrl"), other);
    try {
      expect((await theirs.query("select * from card_assignment")).rows).toEqual([]);
    } finally {
      await theirs.end();
    }
    await expect(
      agentDb.query("delete from card_assignment where account_id = $1", [ids.card]),
    ).rejects.toThrow(/read-only transaction|permission denied/);
    await setCardAssignment(owner.db, catalog, userId, ids.card, null);
  });
});
