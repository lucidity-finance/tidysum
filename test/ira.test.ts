import { eq } from "drizzle-orm";
import { afterAll, describe, expect, inject, it } from "vitest";
import { carriedBy, draftActions, rothIraSteps, stepsFor } from "../src/actions/actions.js";
import { connect } from "../src/db/client.js";
import { appUser, auditEvent, misallocation, policyVersion, proposal } from "../src/db/schema.js";
import { connectAgent } from "../src/mcp/agentDb.js";
import { parsePolicy } from "../src/policy/policy.js";
import type { SnapshotAccount } from "../src/policy/snapshot.js";
import { activatePolicy } from "../src/policy/store.js";
import {
  magiFromPlans,
  openTaxYears,
  parseIraYear,
  type RothIraInputs,
  readIraYears,
  rothIraFindings,
  setIraYear,
} from "../src/retirement/ira.js";
import { parseWorkplaceFacts, type StoredPlan } from "../src/retirement/workplace.js";

const acct = (id: string, over: Partial<SnapshotAccount>): SnapshotAccount => ({
  id,
  name: id,
  official_name: null,
  institution_name: null,
  type: "investment",
  subtype: null,
  currency: "USD",
  current: "0",
  available: null,
  balance_as_of: null,
  ...over,
});

const ROTH = "11111111-1111-4111-8111-111111111111";
const TRAD = "22222222-2222-4222-8222-222222222222";
const PCRA = "33333333-3333-4333-8333-333333333333";
const CHECKING = "44444444-4444-4444-8444-444444444444";
const PLAN_ACCT = "55555555-5555-4555-8555-555555555555";

const accounts: SnapshotAccount[] = [
  acct(ROTH, {
    name: "Acme Roth IRA",
    institution_name: "Acme Invest",
    subtype: "roth",
    current: "4000",
  }),
  acct(TRAD, {
    name: "Acme traditional IRA",
    institution_name: "Acme Invest",
    subtype: "ira",
    current: "0",
  }),
  // A 401(k)'s brokerage window that Plaid calls an IRA: not one.
  acct(PCRA, {
    name: "PCRA Trust",
    institution_name: "Charles Schwab",
    subtype: "ira",
    current: "50000",
  }),
  acct(CHECKING, {
    name: "TOTAL CHECKING",
    institution_name: "Chase",
    type: "depository",
    subtype: "checking",
    current: "9000",
  }),
];

const plan = (salary: string, bonus?: string): StoredPlan => ({
  account_id: PLAN_ACCT,
  facts: parseWorkplaceFacts({
    plan_name: "Acme 401(k)",
    as_of: "2026-11-12",
    pay: { salary, paychecks_per_year: 24, ...(bonus ? { bonus } : {}) },
    contributions: { year: 2026, ytd_employee: "16000", base: { pretax: "12" } },
    match: { up_to_percent: "6" },
    marginal_tax_rate: "0.24",
  }),
});

const detect = (over: Partial<Parameters<typeof rothIraFindings>[0]> = {}) =>
  rothIraFindings({
    today: "2026-11-14",
    accounts,
    holdings: [],
    plans: [plan("180000", "24000")],
    years: new Map(),
    ...over,
  });

describe("Roth IRA room", () => {
  it("opens last year's room until April 15", () => {
    expect(openTaxYears("2027-03-01")).toEqual([2026, 2027]);
    expect(openTaxYears("2027-04-15")).toEqual([2026, 2027]);
    expect(openTaxYears("2027-04-16")).toEqual([2027]);
  });

  it("estimates income from the workplace plan, less its pre-tax contributions", () => {
    // 180,000 + 24,000 less 12% of both (24,480), under the 2026 limit of 24,500.
    expect(magiFromPlans([plan("180000", "24000")], 2026)?.toFixed()).toBe("179520");
    expect(magiFromPlans([], 2026)).toBeNull();
  });

  it("prices an unused year as a backdoor Roth above the income limit", () => {
    const found = detect();
    expect(found.warnings).toEqual([]);
    expect(found.items).toHaveLength(1);
    const [m] = found.items;
    // 7,500 x 7% growth x 15% capital gains tax.
    expect(m).toMatchObject({
      key: "roth_ira:2026",
      category: "securities",
      detector: "roth_ira",
      annual_cost: "78.75",
      account_ids: [ROTH, TRAD],
      action: "Do a $7,500 backdoor Roth IRA for 2026",
      inputs: {
        kind: "contribute",
        route: "backdoor",
        amount: "7500",
        deadline: "2027-04-15",
        year_end: "2026-12-31",
        magi: "179520",
        magi_basis: "workplace_plan",
        filing_status: "single",
        filing_status_assumed: true,
        recorded: false,
        pretax_ira_balance: "0.00",
        rollover_into: null,
        roth_account: { id: ROTH, name: "Acme Roth IRA" },
        traditional_account: { id: TRAD, name: "Acme traditional IRA" },
        from_account: { id: CHECKING, name: "TOTAL CHECKING" },
      },
    });
    expect(m?.summary).toMatch(/^Your 2026 Roth IRA room of \$7,500 is unused/);
    expect(stepsFor({ ...(m as object), accountIds: m?.account_ids } as never, () => null)).toEqual(
      [
        {
          text: "Check what's already been put in for 2026, and lower the amount to match",
          by: "agent",
          needs_you: "Sign-in",
        },
        {
          text: "Contribute $7,500 to Acme traditional IRA for 2026 from TOTAL CHECKING, keeping checking above your cash buffer",
          by: "agent",
          needs_you: "Two-factor code",
        },
        {
          text: "Once it settles, convert all of it to Acme Roth IRA",
          by: "agent",
          needs_you: "Two-factor code",
        },
        {
          text: "Check that no traditional, SEP or SIMPLE IRA will hold pre-tax money on December 31, 2026",
          by: "agent",
        },
        {
          text: "Report it on Form 8606 with your taxes (tax software asks about a backdoor Roth)",
          by: "you",
        },
      ],
    );
  });

  it("adds the net investment income tax above its threshold", () => {
    const [m] = detect({ plans: [plan("300000")] }).items;
    expect(m?.annual_cost).toBe("98.70");
  });

  it("goes straight into the Roth IRA below the income limit", () => {
    const [m] = detect({ plans: [plan("90000")] }).items;
    expect(m?.inputs).toMatchObject({ route: "direct", traditional_account: null });
    expect(m?.action).toBe("Put $7,500 in your Roth IRA for 2026");
    expect(m?.account_ids).toEqual([ROTH]);
    expect(rothIraSteps(m?.inputs as Partial<RothIraInputs>).map((s) => s.text)).toEqual([
      "Check what's already been put in for 2026, and lower the amount to match",
      "Contribute $7,500 to Acme Roth IRA for 2026 from TOTAL CHECKING, keeping checking above your cash buffer",
    ]);
  });

  it("uses the backdoor when income is unknown, and opens the accounts it needs", () => {
    const [m] = detect({ plans: [], accounts: [] }).items;
    expect(m?.inputs).toMatchObject({ route: "backdoor", magi: null, roth_account: null });
    expect(m?.summary).toMatch(/A backdoor Roth gets it in at any income\.$/);
    expect(rothIraSteps(m?.inputs as Partial<RothIraInputs>).map((s) => s.text)).toEqual([
      "Open a Roth IRA",
      "Open a traditional IRA",
      "Contribute $7,500 to the traditional IRA for 2026, keeping checking above your cash buffer",
      "Once it settles, convert all of it to the Roth IRA",
      "Check that no traditional, SEP or SIMPLE IRA will hold pre-tax money on December 31, 2026",
      "Report it on Form 8606 with your taxes (tax software asks about a backdoor Roth)",
    ]);
  });

  it("rolls pre-tax IRA money into the 401(k) first, or warns when there is none", () => {
    const rollover = acct("66666666-6666-4666-8666-666666666666", {
      name: "Rollover IRA",
      subtype: "ira",
      current: "20000",
    });
    const [m] = detect({ accounts: [...accounts, rollover] }).items;
    expect(m?.inputs).toMatchObject({
      pretax_ira_balance: "20000.00",
      rollover_into: "Acme 401(k)",
    });
    expect(rothIraSteps(m?.inputs as Partial<RothIraInputs>)[0]?.text).toBe(
      "Move the pre-tax money in Rollover IRA (about $20,000) into Acme 401(k) first, so the conversion isn't taxed",
    );
    const none = detect({ accounts: [...accounts, rollover], plans: [] });
    expect(none.items).toEqual([]);
    expect(none.warnings[0]).toMatch(/would be partly taxed/);
  });

  it("is quiet once the year is recorded, and asks to convert what's left", () => {
    const done = new Map([
      [
        2026,
        parseIraYear({
          tax_year: 2026,
          as_of: "2026-11-20",
          traditional_contributed: "7500",
          converted: "7500",
        }),
      ],
    ]);
    expect(detect({ years: done })).toEqual({
      items: [],
      warnings: [],
      recorded: { 2026: "15000" },
    });

    const half = new Map([
      [
        2026,
        parseIraYear({ tax_year: 2026, as_of: "2026-11-20", traditional_contributed: "7500" }),
      ],
    ]);
    const traditional = accounts.map((a) => (a.id === TRAD ? { ...a, current: "7500" } : a));
    const [m] = detect({ years: half, accounts: traditional }).items;
    expect(m).toMatchObject({
      key: "roth_ira:2026",
      action: "Convert the $7,500 in your traditional IRA to Roth",
      inputs: { kind: "convert", amount: "7500", pretax_ira_balance: "0.00" },
    });
    expect(rothIraSteps(m?.inputs as Partial<RothIraInputs>)[0]?.text).toBe(
      "Convert all $7,500 in Acme traditional IRA to Acme Roth IRA",
    );
  });

  it("is carried out by the owner's agent", () => {
    expect(
      carriedBy({
        category: "securities",
        actions: [],
        steps: [{ text: "Contribute", by: "agent" }],
        finding: { detector: "roth_ira" },
      }),
    ).toBe("agent");
  });
});

describe("a brokerage's IRA match", () => {
  const at = (institution: string) =>
    accounts.map((a) =>
      a.id === ROTH || a.id === TRAD ? { ...a, institution_name: institution } : a,
    );

  it("takes the paid membership when its match beats its cost, and converts the match too", () => {
    const [m] = detect({ accounts: at("Robinhood") }).items;
    // 3% of 7,500 = 225, less 24% tax on converting it (54) and a year of Gold (60): 111.
    expect(m?.inputs).toMatchObject({
      conversion_tax_rate: "0.24",
      conversion_tax_rate_assumed: false,
      match: {
        offer: "robinhood",
        membership: "Robinhood Gold",
        rate: "0.03",
        amount: "225.00",
        conversion_tax: "54.00",
        membership_fee: "60.00",
        net: "111.00",
        hold_years: 5,
      },
    });
    // The growth's tax (78.75) plus the match.
    expect(m?.annual_cost).toBe("189.75");
    expect(m?.summary).toMatch(
      /Robinhood adds a 3% match with Robinhood Gold if the money stays there 5 years\.$/,
    );
    expect(rothIraSteps(m?.inputs as Partial<RothIraInputs>).map((s) => s.text)).toEqual([
      "Turn on Robinhood Gold ($5 a month) if it isn't on, and keep it at least 12 months, so the contribution earns the 3% match",
      "Check what's already been put in for 2026, and lower the amount to match",
      "Contribute $7,500 to Acme traditional IRA for 2026 from TOTAL CHECKING, keeping checking above your cash buffer",
      "Once Robinhood's 3% match (about $225) arrives, usually within 7 days, convert everything in Acme traditional IRA to Acme Roth IRA",
      "Check that no traditional, SEP or SIMPLE IRA will hold pre-tax money on December 31, 2026",
      "Report it on Form 8606 with your taxes; the converted match counts as taxable income (tax software asks about a backdoor Roth)",
    ]);
  });

  it("keeps the free match when the membership wouldn't pay for itself", () => {
    // 3% of 1,500 = 45, less 10.80 tax and 60 for Gold, loses to 1% = 15 less 3.60 tax.
    const half = new Map([
      [
        2026,
        parseIraYear({
          tax_year: 2026,
          as_of: "2026-11-01",
          traditional_contributed: "6000",
          converted: "6000",
        }),
      ],
    ]);
    const [m] = detect({ accounts: at("Robinhood"), years: half }).items;
    expect(m?.inputs).toMatchObject({
      amount: "1500",
      match: { membership: null, rate: "0.01", amount: "15.00", net: "11.40" },
    });
    expect(rothIraSteps(m?.inputs as Partial<RothIraInputs>)[0]?.text).toMatch(
      /^Contribute \$1,500/,
    );
  });

  it("isn't taxed on a straight Roth contribution", () => {
    const [m] = detect({ accounts: at("Robinhood"), plans: [plan("90000")] }).items;
    expect(m?.inputs).toMatchObject({
      route: "direct",
      conversion_tax_rate: "0",
      match: { membership: "Robinhood Gold", conversion_tax: "0.00", net: "165.00" },
    });
  });

  it("finds no match at a brokerage without one", () => {
    expect(detect().items[0]?.inputs).toMatchObject({ match: null });
  });
});

describe("recording IRA years", () => {
  const owner = connect(inject("databaseUrl"));
  afterAll(async () => owner.close());

  it("records a finished IRA action for its tax year, readable only by its own user", async () => {
    // A user of its own: audit events can't be deleted, and other files count the owner's.
    const [user] = await owner.db
      .insert(appUser)
      .values({ displayName: "IRA test" })
      .returning({ id: appUser.id });
    if (!user) throw new Error("no user");
    const userId = user.id;
    const agentDb = connectAgent(inject("databaseUrl"), userId);
    try {
      await activatePolicy(
        owner.db,
        userId,
        parsePolicy({ version: 1, cash: { buffer: { amount: "500" }, tolerance: "100" } }),
      );
      const [policy] = await owner.db
        .select({ id: policyVersion.id })
        .from(policyVersion)
        .where(eq(policyVersion.userId, userId));
      const [m] = detect().items;
      if (!m || !policy) throw new Error("setup");
      await owner.db.insert(misallocation).values({
        userId,
        key: m.key,
        detector: m.detector,
        category: m.category,
        summary: m.summary,
        action: m.action,
        annualCost: m.annual_cost,
        accountIds: [],
        inputs: m.inputs,
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      });
      const id = crypto.randomUUID();
      await owner.db.insert(proposal).values({
        id,
        userId,
        policyVersionId: policy.id,
        source: "tidysum",
        title: m.action,
        rationale: m.summary,
        state: "approved",
        category: "securities",
        findingKey: m.key,
        validation: { violations: [], warnings: [], numbers: {} },
        steps: rothIraSteps(m.inputs as Partial<RothIraInputs>),
      });
      await owner.db.insert(auditEvent).values([
        { userId, actor: "mcp:claude-code", event: "action.started", proposalId: id, data: {} },
        {
          userId,
          actor: "mcp:claude-code",
          event: "action.finished",
          proposalId: id,
          data: { note: "Contributed and converted" },
        },
      ]);

      await draftActions(owner.db, userId, new Date("2026-11-20T12:00:00Z"));
      const years = await readIraYears(agentDb);
      expect(years.get(2026)).toEqual({
        tax_year: 2026,
        as_of: "2026-11-20",
        roth_contributed: "0",
        traditional_contributed: "7500",
        converted: "7500",
      });
      expect(detect({ years }).items).toEqual([]);
      const events = await owner.db
        .select({ event: auditEvent.event, data: auditEvent.data })
        .from(auditEvent)
        .where(eq(auditEvent.proposalId, id))
        .orderBy(auditEvent.id);
      expect(events.map((e) => e.event)).toEqual([
        "action.started",
        "action.finished",
        "proposal.done",
        "ira.recorded",
      ]);

      // The owner can correct it by hand; agents can only read.
      await setIraYear(owner.db, userId, {
        tax_year: 2025,
        as_of: "2026-04-14",
        filing_status: "single",
        traditional_contributed: "7000",
        converted: "7000",
      });
      expect([...(await readIraYears(agentDb)).keys()]).toEqual([2025, 2026]);
      await expect(agentDb.query("delete from ira_year")).rejects.toThrow(
        /read-only|permission denied/,
      );
    } finally {
      await agentDb.end();
    }
  });
});
