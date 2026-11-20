/**
 * Every real-world fact the demo household uses, in one place, with where it came from. The
 * person is made up; their banks, accounts, cards, funds, prices and merchants are real, so a
 * visitor recognizes their own money in it. Tidysum isn't affiliated with any of them.
 *
 * To refresh (before a launch or a recording): open each `source`, change what moved, and set
 * CHECKED_ON to the day you looked. The products Tidysum recommends instead come from catalog/,
 * which has its own verified_on dates; refresh those at the same time.
 */
export const CHECKED_ON = "2026-11-20";

export const CHASE = {
  institution: "Chase",
  checking: {
    name: "Chase Total Checking",
    /** Total Checking doesn't earn interest. */
    apy: "0",
    /** $15 a month, $0 with $500+ in electronic deposits a statement period (a paycheck does it). */
    monthlyFee: "15.00",
    source: "https://www.chase.com/personal/checking/total-checking",
  },
  savings: {
    name: "Chase Savings",
    /** Every balance tier, standard rate (rate sheet in effect 2026-11-13). */
    apy: "0.01",
    /** $5 a month, $0 with a $300+ daily balance or $25+ in automatic transfers. */
    monthlyFee: "5.00",
    source: "https://www.chase.com/content/dam/chase-ux/ratesheets/pdfs/rdfl1.pdf",
  },
  card: {
    name: "Chase Freedom Unlimited",
    /** Percent of each purchase made abroad. */
    foreignFee: "0.03",
    source: "https://creditcards.chase.com/cash-back-credit-cards/freedom/unlimited",
  },
} as const;

export const CITI = {
  institution: "Citi",
  card: {
    name: "Citi Double Cash Card",
    source: "https://www.citi.com/credit-cards/citi-double-cash-credit-card",
  },
} as const;

/** Closing prices on 2026-11-19. */
export const PRICES = {
  VTI: "352.41",
  VXUS: "77.93",
  BND: "70.91",
  FDEEX: "19.12",
} as const;

export const VANGUARD = {
  institution: "Vanguard",
  account: "Brokerage Account",
  settlementFund: "Vanguard Federal Money Market Fund",
  source: "https://investor.vanguard.com/investment-products/etfs",
} as const;

/**
 * A 401(k) kept by Fidelity (NetBenefits) with an ordinary Fidelity lineup: the actively run
 * Freedom target-date fund every paycheck goes into by default, and the index funds beside it.
 * Expense ratios are each fund's gross ratio from its prospectus, as its fact sheet or quarterly
 * review for 2026-09-30 states it.
 */
export const FIDELITY = {
  institution: "Fidelity Investments",
  siteUrl: "https://nb.fidelity.com",
  targetDate: {
    name: "Fidelity Freedom 2055 Fund",
    ticker: "FDEEX",
    expenseRatio: "0.68",
    /**
     * Its quarterly review's top-level classes on 2026-09-30: U.S. equities 57.02%, non-U.S.
     * equities 43.18%, bonds 6.25%, and -6.45% short-term debt and net other assets (futures).
     * The long positions, rescaled to add up to 1.
     */
    mix: { us_stocks: "0.5357", intl_stocks: "0.4056", bonds: "0.0587" },
    mixAsOf: "2026-09-30",
    mixSource:
      "Fidelity Freedom 2055 Fund quarterly review (U.S. stocks 57.02%, non-U.S. 43.18%, bonds 6.25%, rescaled to 100% without its -6.45% short-term debt)",
    source:
      "https://www.fidelity.com/bin-public/060_www_fidelity_com/documents/SHDOCS/FNSDX/hosts/sh_comm_qfr.002331.RETAIL_pdf.pdf",
  },
  index: [
    { name: "Fidelity 500 Index Fund", expenseRatio: "0.015", mix: { "us_stocks.large": "1" } },
    { name: "Fidelity Total Market Index Fund", expenseRatio: "0.015", mix: { us_stocks: "1" } },
    {
      name: "Fidelity Total International Index Fund",
      expenseRatio: "0.06",
      mix: { intl_stocks: "1" },
    },
    { name: "Fidelity U.S. Bond Index Fund", expenseRatio: "0.025", mix: { bonds: "1" } },
  ],
  indexSource: "https://institutional.fidelity.com/app/proxy/content?literatureURL=%2F9870619.PDF",
} as const;

/** Streaming prices by the day they took effect, so two years of bills follow the real rises. */
export const SUBSCRIPTIONS: { merchant: string; day: number; prices: [string, number][] }[] = [
  // Standard plan: $17.99 from 2025-01-21, $19.99 from 2026-03-26.
  {
    merchant: "Netflix",
    day: 9,
    prices: [
      ["2000-01-01", 1549],
      ["2025-01-21", 1799],
      ["2026-03-26", 1999],
    ],
  },
  // Premium Individual: $11.99 from 2024-07, $12.99 from 2026-02.
  {
    merchant: "Spotify",
    day: 14,
    prices: [
      ["2000-01-01", 1199],
      ["2026-02-01", 1299],
    ],
  },
];
