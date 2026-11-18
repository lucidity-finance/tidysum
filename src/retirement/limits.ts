import Big from "big.js";

// IRS limits on what an employee may put into a 401(k), 403(b) or TSP from their own pay
// (pre-tax and Roth together, the 402(g) elective deferral limit), under age 50. Catch-up
// contributions for 50 and over aren't modeled yet. Update each fall when the IRS publishes the
// next year's numbers.

interface Limit {
  amount: string;
  /** False while the number is a projection rather than the IRS's announcement. */
  official: boolean;
  source_url: string;
}

const ELECTIVE_DEFERRAL: Record<number, Limit> = {
  2025: {
    amount: "23500",
    official: true,
    source_url:
      "https://www.irs.gov/newsroom/401k-limit-increases-to-23500-for-2025-ira-limit-remains-7000",
  },
  2026: {
    amount: "24500",
    official: true,
    source_url:
      "https://401kspecialistmag.com/irs-announces-2026-401k-contribution-limit-increases-to-24500-ira-limit-up-to-7500/",
  },
  2027: {
    amount: "25500",
    official: false,
    source_url:
      "https://401kspecialistmag.com/2027-401k-contribution-limits-all-but-official-25500-expected/",
  },
};

/** The employee contribution limit for a year, or null when it isn't known yet. */
export function electiveDeferralLimit(year: number): (Limit & { value: Big }) | null {
  const l = ELECTIVE_DEFERRAL[year];
  return l ? { ...l, value: new Big(l.amount) } : null;
}

// IRA limits: what one person may put into traditional and Roth IRAs together for a tax year,
// under age 50 (the catch-up isn't modeled yet), and the modified AGI range over which a direct
// Roth IRA contribution phases out. Above the range, Roth money goes in as a backdoor Roth.

export type FilingStatus = "single" | "head_of_household" | "married_joint" | "married_separate";

interface IraLimit extends Limit {
  /** Where the Roth IRA phase-out starts and ends, by filing status. */
  roth_phase_out: Record<FilingStatus, { from: string; to: string }>;
}

const IRA: Record<number, IraLimit> = {
  2025: {
    amount: "7000",
    official: true,
    source_url:
      "https://www.irs.gov/newsroom/401k-limit-increases-to-23500-for-2025-ira-limit-remains-7000",
    roth_phase_out: {
      single: { from: "150000", to: "165000" },
      head_of_household: { from: "150000", to: "165000" },
      married_joint: { from: "236000", to: "246000" },
      married_separate: { from: "0", to: "10000" },
    },
  },
  2026: {
    amount: "7500",
    official: true,
    source_url:
      "https://401kspecialistmag.com/irs-announces-2026-401k-contribution-limit-increases-to-24500-ira-limit-up-to-7500/",
    roth_phase_out: {
      single: { from: "153000", to: "168000" },
      head_of_household: { from: "153000", to: "168000" },
      married_joint: { from: "242000", to: "252000" },
      married_separate: { from: "0", to: "10000" },
    },
  },
  2027: {
    amount: "7500",
    official: false,
    source_url: "https://ustax.tools/retirement-contribution-limits-2027/",
    roth_phase_out: {
      single: { from: "153000", to: "168000" },
      head_of_household: { from: "153000", to: "168000" },
      married_joint: { from: "242000", to: "252000" },
      married_separate: { from: "0", to: "10000" },
    },
  },
};

/** The IRA contribution limit and Roth phase-out for a tax year, or null when not known yet. */
export function iraLimit(year: number): (IraLimit & { value: Big }) | null {
  const l = IRA[year];
  return l ? { ...l, value: new Big(l.amount) } : null;
}
