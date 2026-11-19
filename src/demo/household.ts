import Big from "big.js";
import type {
  PlaidAccount,
  PlaidHolding,
  PlaidLiability,
  PlaidSecurity,
  PlaidTransaction,
} from "../plaid/gateway.js";

/**
 * A made-up household for `tidysum demo`: two years of ordinary life, ending today, with the
 * kinds of money in the wrong place Tidysum looks for (cash earning nothing, a card that doesn't
 * fit the spending, foreign fees, a missed 401(k) match, an expensive target-date fund, unused
 * Roth IRA room, cash above the buffer). Every name and number here is invented. The same day
 * always gives the same household.
 */

export interface DemoInstitution {
  /** What the demo gateway hands out as the access token, and its public token. */
  token: string;
  itemId: string;
  institutionId: string;
  name: string;
  accounts: PlaidAccount[];
  transactions: PlaidTransaction[];
  holdings: PlaidHolding[];
  securities: PlaidSecurity[];
  liabilities: PlaidLiability[];
}

export interface DemoHousehold {
  today: string;
  institutions: DemoInstitution[];
  /** Account id (Plaid's) of the 401(k), and what its plan website would show. */
  workplace: { plaidAccountId: string; facts: unknown };
  ira: unknown;
  policy: unknown;
}

const DAY_MS = 86_400_000;
const HISTORY_DAYS = 730;

/** Small, fast and deterministic: the same seed gives the same household. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const addDays = (day: string, n: number) =>
  new Date(Date.parse(day) + n * DAY_MS).toISOString().slice(0, 10);

/** Whole cents to a decimal string: money never passes through a float. */
const cents = (c: number) => new Big(c).div(100).toFixed(2);

function day(year: number, month: number, d: number): string {
  // Clamp to the month's last day (the 31st of a 30-day month is its 30th).
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(d, last))).toISOString().slice(0, 10);
}

interface Spend {
  merchant: string;
  category: string;
  /** Range in whole cents. */
  min: number;
  max: number;
  /** Times a month, on average. */
  perMonth: number;
}

const CHASE_SPEND: Spend[] = [
  {
    merchant: "Bistro Verde",
    category: "FOOD_AND_DRINK_RESTAURANT",
    min: 2400,
    max: 7800,
    perMonth: 5,
  },
  {
    merchant: "Corner Coffee Co",
    category: "FOOD_AND_DRINK_COFFEE",
    min: 450,
    max: 900,
    perMonth: 6,
  },
  {
    merchant: "Noodle House",
    category: "FOOD_AND_DRINK_RESTAURANT",
    min: 1800,
    max: 4200,
    perMonth: 3,
  },
  {
    merchant: "Amazon",
    category: "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES",
    min: 1500,
    max: 9500,
    perMonth: 4,
  },
  {
    merchant: "Wellway Pharmacy",
    category: "MEDICAL_PHARMACIES_AND_SUPPLEMENTS",
    min: 900,
    max: 3200,
    perMonth: 1.5,
  },
  {
    merchant: "Threadline",
    category: "GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES",
    min: 3000,
    max: 12000,
    perMonth: 0.8,
  },
];

const CITI_SPEND: Spend[] = [
  {
    merchant: "FreshMart",
    category: "FOOD_AND_DRINK_GROCERIES",
    min: 6500,
    max: 16500,
    perMonth: 4.3,
  },
  {
    merchant: "Green Basket Market",
    category: "FOOD_AND_DRINK_GROCERIES",
    min: 1800,
    max: 5500,
    perMonth: 2,
  },
  { merchant: "Speedy Fuel", category: "TRANSPORTATION_GAS", min: 3500, max: 5800, perMonth: 3 },
  {
    merchant: "RideNow",
    category: "TRANSPORTATION_TAXIS_AND_RIDE_SHARES",
    min: 1200,
    max: 3400,
    perMonth: 2,
  },
  {
    merchant: "Cinema Ten",
    category: "ENTERTAINMENT_OTHER_ENTERTAINMENT",
    min: 1600,
    max: 4200,
    perMonth: 1,
  },
];

/** Monthly subscriptions on the Citi card: [merchant, cents, day]. */
const CITI_SUBSCRIPTIONS: [string, number, number][] = [
  ["StreamFlix", 1549, 9],
  ["TuneBox Music", 1199, 14],
];

/** Trips abroad, as days before today: the card used has a foreign transaction fee. */
const TRIPS = [
  { startsDaysAgo: 160, city: "Lisbon", nights: 5 },
  { startsDaysAgo: 520, city: "Mexico City", nights: 4 },
];

export function demoHousehold(today: string): DemoHousehold {
  const rand = prng(Number(today.replaceAll("-", "")) % 100_000);
  const between = (min: number, max: number) => Math.round(min + rand() * (max - min));
  const start = addDays(today, -(HISTORY_DAYS - 1));
  let seq = 0;
  const txn = (
    accountId: string,
    date: string,
    amountCents: number,
    name: string,
    category: string,
    merchant: string | null = name,
  ): PlaidTransaction => ({
    transactionId: `demo-txn-${++seq}`,
    accountId,
    date,
    authorizedDate: date,
    amount: cents(amountCents),
    currency: "USD",
    name,
    merchantName: merchant,
    categoryPrimary: null,
    categoryDetailed: category,
    pending: false,
    pendingTransactionId: null,
  });
  // Plaid's primary category is the detailed one's leading words; the detectors read detailed.
  const primary = (detailed: string) =>
    [
      "FOOD_AND_DRINK",
      "GENERAL_MERCHANDISE",
      "MEDICAL",
      "TRANSPORTATION",
      "ENTERTAINMENT",
      "TRAVEL",
      "RENT_AND_UTILITIES",
      "INCOME",
      "LOAN_PAYMENTS",
      "TRANSFER_OUT",
      "TRANSFER_IN",
      "BANK_FEES",
      "PERSONAL_CARE",
      "GENERAL_SERVICES",
    ].find((p) => detailed.startsWith(p)) ?? null;
  const fix = (t: PlaidTransaction): PlaidTransaction => ({
    ...t,
    categoryPrimary: t.categoryDetailed ? primary(t.categoryDetailed) : null,
  });

  const checking: PlaidTransaction[] = [];
  const savings: PlaidTransaction[] = [];
  const chase: PlaidTransaction[] = [];
  const citi: PlaidTransaction[] = [];

  // Months from the first full month in the window through the current one.
  const months: { year: number; month: number }[] = [];
  for (
    let d = new Date(`${start.slice(0, 7)}-01T00:00:00Z`);
    d.toISOString().slice(0, 10) <= today;
  ) {
    months.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() });
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  }
  const inWindow = (date: string) => date >= start && date <= today;

  // Card spending, month by month, so each month's bill can be paid the next month.
  const chaseByMonth = new Map<string, number>();
  const citiByMonth = new Map<string, number>();
  const spendOn = (
    list: PlaidTransaction[],
    totals: Map<string, number>,
    accountId: string,
    date: string,
    amount: number,
    name: string,
    category: string,
  ) => {
    if (!inWindow(date)) return;
    list.push(txn(accountId, date, amount, name, category));
    const key = date.slice(0, 7);
    totals.set(key, (totals.get(key) ?? 0) + amount);
  };

  for (const { year, month } of months) {
    const pick = (
      spends: Spend[],
      list: PlaidTransaction[],
      totals: Map<string, number>,
      id: string,
    ) => {
      for (const s of spends) {
        // perMonth on average: the whole part every month, the rest by chance.
        const n = Math.floor(s.perMonth) + (rand() < s.perMonth % 1 ? 1 : 0);
        for (let i = 0; i < n; i++) {
          spendOn(
            list,
            totals,
            id,
            day(year, month, between(1, 28)),
            between(s.min, s.max),
            s.merchant,
            s.category,
          );
        }
      }
    };
    pick(CHASE_SPEND, chase, chaseByMonth, "demo-chase");
    pick(CITI_SPEND, citi, citiByMonth, "demo-citi");
    for (const [merchant, amount, d] of CITI_SUBSCRIPTIONS) {
      spendOn(
        citi,
        citiByMonth,
        "demo-citi",
        day(year, month, d),
        amount,
        merchant,
        "ENTERTAINMENT_TV_AND_MOVIES",
      );
    }

    // The bank account: pay, rent and bills.
    const bank = (d: number, amount: number, name: string, category: string) => {
      const date = day(year, month, d);
      if (inWindow(date)) checking.push(txn("demo-checking", date, amount, name, category));
    };
    bank(1, -355000, "Northwind Labs payroll", "INCOME_WAGES");
    bank(15, -355000, "Northwind Labs payroll", "INCOME_WAGES");
    bank(1, 265000, "Oakview Apartments", "RENT_AND_UTILITIES_RENT");
    bank(3, 4900, "Ironworks Gym", "PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS");
    bank(5, between(7800, 15200), "City Power & Light", "RENT_AND_UTILITIES_GAS_AND_ELECTRICITY");
    bank(8, 7500, "Bluewave Internet", "RENT_AND_UTILITIES_INTERNET_AND_CABLE");
    bank(12, 6500, "Pinecone Mobile", "RENT_AND_UTILITIES_TELEPHONE");
    bank(20, 12800, "Steady Auto Insurance", "GENERAL_SERVICES_INSURANCE");
    bank(
      16,
      150000,
      "Transfer to Harbor Brokerage",
      "TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS",
    );
    bank(17, 20000, "Transfer to Rainy Day Savings", "TRANSFER_OUT_SAVINGS");
    const toSavings = day(year, month, 17);
    if (inWindow(toSavings)) {
      savings.push(
        txn(
          "demo-savings",
          toSavings,
          -20000,
          "Transfer from Everyday Checking",
          "TRANSFER_IN_SAVINGS",
        ),
      );
    }
  }

  // Trips abroad on the Chase card, which charges 3% on foreign purchases.
  for (const trip of TRIPS) {
    const first = addDays(today, -trip.startsDaysAgo);
    spendOn(
      chase,
      chaseByMonth,
      "demo-chase",
      addDays(first, -30),
      between(52000, 78000),
      "SkyBridge Airlines",
      "TRAVEL_FLIGHTS",
    );
    const abroad = (date: string, amount: number, name: string, category: string) => {
      spendOn(chase, chaseByMonth, "demo-chase", date, amount, name, category);
      const fee = Math.round(amount * 0.03);
      spendOn(
        chase,
        chaseByMonth,
        "demo-chase",
        date,
        fee,
        "Foreign transaction fee",
        "BANK_FEES_FOREIGN_TRANSACTION_FEES",
      );
    };
    abroad(first, between(62000, 84000), `Hotel ${trip.city}`, "TRAVEL_LODGING");
    for (let n = 0; n < trip.nights; n++) {
      abroad(
        addDays(first, n),
        between(2200, 6800),
        `Restaurant ${trip.city}`,
        "FOOD_AND_DRINK_RESTAURANT",
      );
      abroad(
        addDays(first, n),
        between(800, 2600),
        `Taxi ${trip.city}`,
        "TRANSPORTATION_TAXIS_AND_RIDE_SHARES",
      );
    }
  }

  // Each card's month is paid in full from checking on the 25th of the next month.
  const payCards = (
    totals: Map<string, number>,
    accountId: string,
    list: PlaidTransaction[],
    payee: string,
  ) => {
    for (const [ym, amount] of totals) {
      const [y, m] = ym.split("-").map(Number) as [number, number];
      const date = day(y, m, 25); // month index m is the next month
      if (!inWindow(date)) continue;
      checking.push(
        txn("demo-checking", date, amount, `${payee} autopay`, "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT"),
      );
      list.push(
        txn(
          accountId,
          date,
          -amount,
          "Payment, thank you",
          "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
          null,
        ),
      );
    }
  };
  payCards(chaseByMonth, "demo-chase", chase, "Chase card");
  payCards(citiByMonth, "demo-citi", citi, "Citi card");

  // Interest at the end of each month: next to nothing on checking, a little on savings.
  const startChecking = new Big("6400.00");
  const startSavings = new Big("7600.00");
  const balanceOn = (list: PlaidTransaction[], opening: Big, through: string) =>
    list.filter((t) => t.date <= through).reduce((b, t) => b.minus(t.amount), opening);
  for (const { year, month } of months) {
    const date = day(year, month, 31);
    if (!inWindow(date)) continue;
    // Monthly interest at an APY, on the month-end balance, rounded to the cent.
    const interest = (
      list: PlaidTransaction[],
      opening: Big,
      apy: string,
      name: string,
      id: string,
    ) => {
      const b = balanceOn(list, opening, date);
      const c = Number(
        b.times(apy).div(100).div(12).times(100).round(0, Big.roundHalfUp).toFixed(0),
      );
      if (c > 0) list.push(txn(id, date, -c, name, "INCOME_INTEREST_EARNED", null));
    };
    interest(checking, startChecking, "0.01", "Interest paid", "demo-checking");
    interest(savings, startSavings, "0.05", "Interest paid", "demo-savings");
  }

  const closing = (list: PlaidTransaction[], opening: Big) => balanceOn(list, opening, today);
  const chaseOwed = closing(chase, new Big(0)).times(-1);
  const citiOwed = closing(citi, new Big(0)).times(-1);
  // A card's statement is the last full month, due on the coming 25th.
  const lastMonth = addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
  const [ty, tm] = today.split("-").map(Number) as [number, number];
  const due = today.slice(8) < "25" ? day(ty, tm - 1, 25) : day(ty, tm, 25);

  const depository = (
    accountId: string,
    name: string,
    subtype: string,
    mask: string,
    balance: Big,
  ): PlaidAccount => ({
    accountId,
    name,
    officialName: null,
    type: "depository",
    subtype,
    mask,
    currency: "USD",
    balances: { current: balance.toFixed(2), available: balance.toFixed(2), limit: null },
  });
  const credit = (
    accountId: string,
    name: string,
    mask: string,
    owed: Big,
    limit: string,
  ): PlaidAccount => ({
    accountId,
    name,
    officialName: name,
    type: "credit",
    subtype: "credit card",
    mask,
    currency: "USD",
    balances: { current: owed.toFixed(2), available: new Big(limit).minus(owed).toFixed(2), limit },
  });
  const statement = (
    accountId: string,
    totals: Map<string, number>,
    apr: string,
  ): PlaidLiability => {
    const balance = cents(totals.get(lastMonth) ?? 0);
    return {
      accountId,
      kind: "credit",
      aprPercentage: apr,
      lastStatementBalance: balance,
      minimumPayment: new Big(balance).gt(40) ? "40.00" : balance,
      nextPaymentDueDate: due,
      isOverdue: false,
    };
  };

  // Investments: index funds at a brokerage, and a 401(k) all in an expensive target-date fund.
  const security = (
    securityId: string,
    name: string,
    ticker: string | null,
    type: string,
    price: string,
  ): PlaidSecurity => ({
    securityId,
    name,
    tickerSymbol: ticker,
    type,
    isCashEquivalent: type === "cash",
    closePrice: price,
    closePriceAsOf: today,
    currency: "USD",
  });
  const holding = (
    accountId: string,
    s: PlaidSecurity,
    quantity: string,
    basis: string,
  ): PlaidHolding => {
    const value = new Big(quantity).times(s.closePrice ?? "0").toFixed(2);
    return {
      accountId,
      securityId: s.securityId,
      quantity,
      institutionPrice: s.closePrice ?? "0",
      institutionValue: value,
      costBasis: basis,
      currency: "USD",
    };
  };
  const vti = security("demo-sec-vti", "Vanguard Total Stock Market ETF", "VTI", "etf", "301.40");
  const vxus = security(
    "demo-sec-vxus",
    "Vanguard Total International Stock ETF",
    "VXUS",
    "etf",
    "68.90",
  );
  const bnd = security("demo-sec-bnd", "Vanguard Total Bond Market ETF", "BND", "etf", "72.60");
  const mmf = security("demo-sec-mmf", "Harbor Cash Sweep", null, "cash", "1.00");
  const tdf = security(
    "demo-sec-tdf",
    "Northwind 2055 Target Date Fund",
    null,
    "mutual fund",
    "41.20",
  );
  const brokerageHoldings = [
    holding("demo-brokerage", vti, "52", "12480.00"),
    holding("demo-brokerage", vxus, "61", "3910.00"),
    holding("demo-brokerage", bnd, "18", "1330.00"),
    holding("demo-brokerage", mmf, "1240.55", "1240.55"),
  ];
  const k401Holdings = [holding("demo-401k", tdf, "1388.274", "48200.00")];
  const total = (hs: PlaidHolding[]) => hs.reduce((s, h) => s.plus(h.institutionValue), new Big(0));
  const investment = (
    accountId: string,
    name: string,
    subtype: string,
    mask: string,
    hs: PlaidHolding[],
  ): PlaidAccount => ({
    accountId,
    name,
    officialName: null,
    type: "investment",
    subtype,
    mask,
    currency: "USD",
    balances: { current: total(hs).toFixed(2), available: null, limit: null },
  });

  const institutions: DemoInstitution[] = [
    {
      token: "demo-maple",
      itemId: "demo-item-maple",
      institutionId: "ins_demo_maple",
      name: "Maple Street Bank",
      accounts: [
        depository(
          "demo-checking",
          "Everyday Checking",
          "checking",
          "4410",
          closing(checking, startChecking),
        ),
        depository(
          "demo-savings",
          "Rainy Day Savings",
          "savings",
          "4428",
          closing(savings, startSavings),
        ),
      ],
      transactions: [...checking, ...savings].map(fix),
      holdings: [],
      securities: [],
      liabilities: [],
    },
    {
      token: "demo-chase",
      itemId: "demo-item-chase",
      institutionId: "ins_demo_chase",
      name: "Chase",
      accounts: [credit("demo-chase", "Chase Freedom Unlimited", "1882", chaseOwed, "12000.00")],
      transactions: chase.map(fix),
      holdings: [],
      securities: [],
      liabilities: [statement("demo-chase", chaseByMonth, "24.99")],
    },
    {
      token: "demo-citi",
      itemId: "demo-item-citi",
      institutionId: "ins_demo_citi",
      name: "Citi",
      accounts: [credit("demo-citi", "Citi Double Cash", "7731", citiOwed, "9000.00")],
      transactions: citi.map(fix),
      holdings: [],
      securities: [],
      liabilities: [statement("demo-citi", citiByMonth, "26.24")],
    },
    {
      token: "demo-harbor",
      itemId: "demo-item-harbor",
      institutionId: "ins_demo_harbor",
      name: "Harbor Brokerage",
      accounts: [
        investment(
          "demo-brokerage",
          "Individual Brokerage",
          "brokerage",
          "3307",
          brokerageHoldings,
        ),
      ],
      transactions: [],
      holdings: brokerageHoldings,
      securities: [vti, vxus, bnd, mmf],
      liabilities: [],
    },
    {
      token: "demo-summit",
      itemId: "demo-item-summit",
      institutionId: "ins_demo_summit",
      name: "Summit Retirement",
      accounts: [investment("demo-401k", "Northwind Labs 401(k)", "401k", "0915", k401Holdings)],
      transactions: [],
      holdings: k401Holdings,
      securities: [tdf],
      liabilities: [],
    },
  ];

  const year = Number(today.slice(0, 4));
  const paychecksSoFar = Math.max(
    1,
    Math.floor(((Date.parse(today) - Date.parse(`${year}-01-01`)) / DAY_MS / 365) * 24),
  );
  return {
    today,
    institutions,
    workplace: {
      plaidAccountId: "demo-401k",
      facts: {
        plan_name: "Northwind Labs 401(k)",
        site_url: "https://example.com/retirement",
        as_of: today,
        pay: { salary: "140000", paychecks_per_year: 24 },
        contributions: {
          year,
          ytd_employee: new Big("140000").times("0.16").div(24).times(paychecksSoFar).toFixed(2),
          base: { pretax: "16", roth: "0", after_tax: "0" },
          max_percent: "75",
        },
        match: { up_to_percent: "6", rate: "1", true_up: false },
        prefer: "pretax",
        marginal_tax_rate: "0.22",
        paycheck_investments: [{ fund: "Northwind 2055 Target Date Fund", percent: "100" }],
        lineup: [
          {
            name: "Northwind 2055 Target Date Fund",
            expense_ratio: "0.52",
            kind: "target_date",
            mix: {
              "us_stocks.large": "0.46",
              "us_stocks.small_mid": "0.12",
              intl_stocks: "0.31",
              bonds: "0.11",
            },
            mix_source: "Northwind 2055 Target Date Fund fact sheet (made up for the demo)",
            mix_as_of: today,
          },
          {
            name: "Summit US Large Cap Index Fund",
            expense_ratio: "0.02",
            kind: "index",
            mix: { "us_stocks.large": "1" },
          },
          {
            name: "Summit US Small/Mid Cap Index Fund",
            expense_ratio: "0.03",
            kind: "index",
            mix: { "us_stocks.small_mid": "1" },
          },
          {
            name: "Summit International Index Fund",
            expense_ratio: "0.05",
            kind: "index",
            mix: { intl_stocks: "1" },
          },
          {
            name: "Summit Bond Index Fund",
            expense_ratio: "0.03",
            kind: "index",
            mix: { bonds: "1" },
          },
        ],
      },
    },
    ira: {
      tax_year: year,
      as_of: today,
      filing_status: "single",
      roth_contributed: "0",
      traditional_contributed: "0",
      converted: "0",
    },
    policy: {
      version: 1,
      cash: { buffer: { amount: "10000.00" }, tolerance: "500.00" },
      cards: { pay_statement_in_full: true },
      debt: { extra_payments: "none" },
      allocation: {
        drift_band: "0.05",
        buckets: {
          us_stocks: {
            target: "0.60",
            tickers: ["VTI", "VOO", "ITOT", "SCHB", "FSKAX", "FXAIX", "SPY", "IVV"],
            security_types: ["equity"],
          },
          intl_stocks: { target: "0.30", tickers: ["VXUS", "IXUS", "FTIHX", "VEA", "VWO", "SCHF"] },
          bonds_and_cash: {
            target: "0.10",
            tickers: ["BND", "AGG", "FXNAX", "SCHZ", "BNDX"],
            cash_equivalents: true,
          },
        },
      },
      limits: { order_types: ["limit"] },
    },
  };
}
