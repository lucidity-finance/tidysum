import Big from "big.js";
import { classifyHoldings } from "../portfolio/allocation.js";
import {
  investableHoldings,
  sleevePosition,
  sleeveRoom,
  sleeveTickers,
  splitSleeve,
} from "../portfolio/investable.js";
import type { SecurityCatalog } from "../portfolio/securityCatalog.js";
import type { Policy } from "./policy.js";
import type { Snapshot, SnapshotAccount } from "./snapshot.js";

// Deterministic policy checks. The agent explains and drafts; this code does the arithmetic,
// in exact decimals, and every finding carries the numbers it came from.

const CASH_SUBTYPES = new Set(["checking", "savings", "money market", "cash management"]);
const LIABILITY_TYPES = new Set(["credit", "loan"]);

const money = (b: Big) => b.toFixed(2);
const big = (s: string | null | undefined) => new Big(s ?? 0);
const min = (a: Big, b: Big) => (a.lt(b) ? a : b);
const max = (a: Big, b: Big) => (a.gt(b) ? a : b);

export interface Finding {
  check: "cash_buffer" | "card_statement" | "extra_payment" | "allocation" | "research_sleeve";
  status: "ok" | "action" | "warning";
  summary: string;
  /** The amount to move, when the finding suggests one. */
  amount?: string;
  account_ids: string[];
  /**
   * What leaving this as it is costs per year, a decimal string, when it can be priced from the
   * data (decision 0003). Unpriced findings are warnings or to-dos, not misallocations.
   */
  annual_cost?: string;
  /** Inputs and intermediate results, so each number can be traced to the data. */
  numbers: Record<string, unknown>;
}

/** Yearly interest on `amount` at an APR given in percent. */
const yearlyInterest = (amount: Big, aprPercentage: string) => amount.times(aprPercentage).div(100);

export function cashAccounts(policy: Policy, snapshot: Snapshot): SnapshotAccount[] {
  const ids = policy.cash.account_ids;
  return snapshot.accounts.filter((a) =>
    ids ? ids.includes(a.id) : a.type === "depository" && CASH_SUBTYPES.has(a.subtype ?? ""),
  );
}

/**
 * Spendable cash: the lower of current and available. Available already nets out pending debits,
 * but some banks (Chase) fold an overdraft line or uncleared holds into it, which can push it
 * above the money actually in the account.
 */
function spendable(a: SnapshotAccount): Big {
  if (a.available === null) return big(a.current);
  if (a.current === null) return big(a.available);
  return min(big(a.available), big(a.current));
}

export interface CashPosition {
  accounts: { id: string; name: string; spendable: string; as_of: string | null }[];
  liquid: Big;
  /** null when months_of_spending is set but there is no spending history to average. */
  buffer: Big | null;
  bufferBasis: Record<string, unknown>;
}

export function cashPosition(policy: Policy, snapshot: Snapshot): CashPosition {
  const accounts = cashAccounts(policy, snapshot);
  const liquid = accounts.reduce((sum, a) => sum.plus(spendable(a)), new Big(0));
  const listed = accounts.map((a) => ({
    id: a.id,
    name: a.name,
    spendable: money(spendable(a)),
    as_of: a.balance_as_of,
  }));
  const rule = policy.cash.buffer;
  if ("amount" in rule) {
    return {
      accounts: listed,
      liquid,
      buffer: big(rule.amount),
      bufferBasis: { fixed: rule.amount },
    };
  }
  const months = snapshot.spending;
  if (months.length === 0) {
    return {
      accounts: listed,
      liquid,
      buffer: null,
      bufferBasis: { months_of_spending: rule.months_of_spending, spending: [] },
    };
  }
  const average = months.reduce((sum, m) => sum.plus(m.outflow), new Big(0)).div(months.length);
  return {
    accounts: listed,
    liquid,
    buffer: average.times(rule.months_of_spending),
    bufferBasis: {
      months_of_spending: rule.months_of_spending,
      spending: months,
      average_monthly_spending: money(average),
    },
  };
}

function cashBufferFinding(policy: Policy, cash: CashPosition): Finding {
  const ids = cash.accounts.map((a) => a.id);
  const numbers = {
    cash_accounts: cash.accounts,
    liquid: money(cash.liquid),
    buffer: cash.buffer ? money(cash.buffer) : null,
    tolerance: policy.cash.tolerance,
    ...cash.bufferBasis,
  };
  if (!cash.buffer) {
    return {
      check: "cash_buffer",
      status: "warning",
      summary: "No posted spending in the last three full months, so the buffer can't be computed.",
      account_ids: ids,
      numbers,
    };
  }
  const excess = cash.liquid.minus(cash.buffer);
  const tolerance = big(policy.cash.tolerance);
  if (excess.gt(tolerance)) {
    return {
      check: "cash_buffer",
      status: "action",
      summary: `Cash is ${money(excess)} above the ${money(cash.buffer)} buffer.`,
      amount: money(excess),
      account_ids: ids,
      numbers: { ...numbers, excess: money(excess) },
    };
  }
  if (excess.lt(tolerance.times(-1))) {
    return {
      check: "cash_buffer",
      status: "warning",
      summary: `Cash is ${money(excess.abs())} below the ${money(cash.buffer)} buffer.`,
      amount: money(excess.abs()),
      account_ids: ids,
      numbers: { ...numbers, shortfall: money(excess.abs()) },
    };
  }
  return {
    check: "cash_buffer",
    status: "ok",
    summary: `Cash is within ${policy.cash.tolerance} of the ${money(cash.buffer)} buffer.`,
    account_ids: ids,
    numbers: { ...numbers, excess: money(excess) },
  };
}

function cardFindings(policy: Policy, snapshot: Snapshot): Finding[] {
  if (!policy.cards.pay_statement_in_full) return [];
  return snapshot.liabilities
    .filter((l) => l.kind === "credit" && big(l.last_statement_balance).gt(0))
    .map((l) => {
      // If a payment already posted, the current balance is below the statement balance.
      const due = min(big(l.last_statement_balance), max(big(l.current_balance), new Big(0)));
      const numbers = {
        last_statement_balance: l.last_statement_balance,
        current_balance: l.current_balance,
        next_payment_due_date: l.next_payment_due_date,
        minimum_payment: l.minimum_payment,
        apr_percentage: l.apr_percentage,
        interest_charged_365d: l.interest_charged_365d,
      };
      if (due.lte(0)) {
        return {
          check: "card_statement",
          status: "ok",
          summary: `${l.name}: nothing owed on the last statement.`,
          account_ids: [l.account_id],
          numbers,
        } satisfies Finding;
      }
      // Carrying the statement costs its APR for as long as it is carried; a year of it is the
      // floor (new purchases also lose their grace period). Interest already charged over the
      // last year is the observed figure; the larger of the two is reported.
      const carried = l.apr_percentage ? yearlyInterest(due, l.apr_percentage) : new Big(0);
      const cost = max(carried, big(l.interest_charged_365d));
      return {
        check: "card_statement",
        status: "action",
        summary: `${l.name}: pay ${money(due)} by ${l.next_payment_due_date ?? "the due date"} to clear the statement.`,
        amount: money(due),
        account_ids: [l.account_id],
        ...(cost.gt(0) ? { annual_cost: money(cost) } : {}),
        numbers,
      } satisfies Finding;
    });
}

function extraPaymentFinding(
  policy: Policy,
  snapshot: Snapshot,
  cash: CashPosition,
  cardsDue: Big,
): Finding | undefined {
  if (policy.debt.extra_payments !== "highest_apr" || !cash.buffer) return undefined;
  const spare = cash.liquid.minus(cash.buffer).minus(cardsDue);
  if (spare.lte(policy.cash.tolerance)) return undefined;
  const target = snapshot.liabilities
    .filter((l) => big(l.current_balance).gt(0) && l.apr_percentage !== null)
    .sort((a, b) => big(b.apr_percentage).cmp(big(a.apr_percentage)))[0];
  if (!target) return undefined;
  const amount = min(spare, big(target.current_balance));
  return {
    check: "extra_payment",
    status: "action",
    summary: `${target.name} has the highest APR (${target.apr_percentage}%). ${money(amount)} of spare cash could go to it.`,
    amount: money(amount),
    account_ids: [target.account_id],
    annual_cost: money(yearlyInterest(amount, target.apr_percentage ?? "0")),
    numbers: {
      liquid: money(cash.liquid),
      buffer: money(cash.buffer),
      card_statements_due: money(cardsDue),
      spare: money(spare),
      apr_percentage: target.apr_percentage,
      current_balance: target.current_balance,
    },
  };
}

function allocationFindings(
  policy: Policy,
  snapshot: Snapshot,
  securities?: SecurityCatalog,
): Finding[] {
  const allocation = policy.allocation;
  if (!allocation) return [];
  const investable = investableHoldings(policy, snapshot);
  const accountIds = investable.accountIds;
  // Research-sleeve positions count toward the sleeve's cap, not toward any bucket.
  const holdings = splitSleeve(policy, investable.holdings).core;
  const buckets = Object.entries(allocation.buckets);
  const values = new Map(buckets.map(([name]) => [name, new Big(0)]));
  const unclassified: { ticker: string | null; name: string | null; value: string }[] = [];
  const year = Number(snapshot.today.slice(0, 4));
  for (const c of classifyHoldings(allocation, holdings, securities, year)) {
    const value = big(c.holding.institution_value);
    for (const p of c.parts) {
      values.set(p.bucket, (values.get(p.bucket) ?? new Big(0)).plus(value.times(p.fraction)));
    }
    if (c.unclassified.gt(0)) {
      unclassified.push({
        ticker: c.holding.ticker_symbol,
        name: c.holding.security_name,
        value: money(value.times(c.unclassified)),
      });
    }
  }
  // Weights are shares of what could be classified; the rest is reported separately.
  const total = [...values.values()].reduce((sum, v) => sum.plus(v), new Big(0));
  if (total.lte(0)) {
    return [
      {
        check: "allocation",
        status: "warning",
        summary: holdings.length
          ? "No holdings match a bucket, so drift can't be computed."
          : "No holdings in the allocation accounts, so drift can't be computed.",
        account_ids: [...accountIds],
        numbers: unclassified.length ? { unclassified } : {},
      },
    ];
  }

  const band = big(allocation.drift_band);
  const findings: Finding[] = buckets.map(([name, b]) => {
    const value = values.get(name) ?? new Big(0);
    const weight = value.div(total);
    const drift = weight.minus(b.target);
    const delta = drift.abs().times(total);
    const numbers = {
      bucket: name,
      value: money(value),
      total: money(total),
      weight: weight.toFixed(4),
      target: b.target,
      drift: drift.toFixed(4),
      drift_band: allocation.drift_band,
    };
    if (drift.abs().lte(band)) {
      return {
        check: "allocation",
        status: "ok",
        summary: `${name}: ${weight.times(100).toFixed(1)}% vs ${big(b.target).times(100).toFixed(1)}% target.`,
        account_ids: [...accountIds],
        numbers,
      } satisfies Finding;
    }
    const verb = drift.gt(0) ? "over" : "under";
    // Percentages only in the summary: the owner doesn't want to see dollar amounts.
    return {
      check: "allocation",
      status: "action",
      summary: `${name}: ${weight.times(100).toFixed(1)}% vs ${big(b.target).times(100).toFixed(1)}% target, ${drift.abs().times(100).toFixed(1)} points ${verb}.`,
      amount: money(delta),
      account_ids: [...accountIds],
      numbers,
    } satisfies Finding;
  });
  if (unclassified.length) {
    findings.push({
      check: "allocation",
      status: "warning",
      summary: `${unclassified.length} holding(s) match no bucket; add their tickers to the policy.`,
      account_ids: [...accountIds],
      numbers: { unclassified },
    });
  }
  return findings;
}

/** Said wherever miner research reaches the owner or an agent (decision 0002, principle 4). */
export const RESEARCH_NOTE =
  "investment-miner scores are research evidence, not target weights or instructions to trade.";

/** Older than this, the newest research run is flagged as out of date. */
export const RESEARCH_STALE_DAYS = 14;

const DAY_MS = 86_400_000;

/** Whole days from an ISO timestamp to the end of `today`. */
export function ageInDays(asOf: string, today: string): number {
  return Math.max(0, Math.floor((Date.parse(`${today}T23:59:59Z`) - Date.parse(asOf)) / DAY_MS));
}

/**
 * The research sleeve against its cap, and whether there is current research for it. Not a
 * misallocation: a miner score doesn't price anything, so these are status and warnings only.
 */
function researchFindings(policy: Policy, snapshot: Snapshot): Finding[] {
  const position = sleevePosition(policy, snapshot);
  if (!position) return [];
  const ids = [...investableHoldings(policy, snapshot).accountIds];
  const p100 = (b: Big) => b.times(100).toFixed(1);
  const numbers = {
    kind: "cap",
    cap: position.cap.toFixed(4),
    share: position.share.toFixed(4),
    sleeve_value: money(position.value),
    investable: money(position.investable),
    new_money_room: money(sleeveRoom(position)),
    tickers: [...sleeveTickers(policy)],
  };
  const over = position.share.gt(position.cap);
  const findings: Finding[] = [
    {
      check: "research_sleeve",
      status: over ? "warning" : "ok",
      summary: over
        ? `Research sleeve is ${p100(position.share)}% of investable assets, over its ${p100(position.cap)}% cap. New money skips it until it's back under; nothing needs selling. ${RESEARCH_NOTE}`
        : `Research sleeve is ${p100(position.share)}% of investable assets, under its ${p100(position.cap)}% cap. Only new money may go in, up to the cap. ${RESEARCH_NOTE}`,
      account_ids: ids,
      numbers,
    },
  ];
  const runs = snapshot.research?.runs ?? [];
  const newest = runs
    .map((r) => r.as_of)
    .sort()
    .at(-1);
  const age = newest ? ageInDays(newest, snapshot.today) : null;
  if (age === null || age > RESEARCH_STALE_DAYS) {
    findings.push({
      check: "research_sleeve",
      status: "warning",
      summary:
        age === null
          ? "There is no current investment-miner run yet, so the research sleeve has no candidates."
          : `The newest investment-miner run is ${age} days old, so its candidates may be out of date.`,
      account_ids: ids,
      numbers: { kind: "freshness", newest_as_of: newest ?? null, age_days: age, runs },
    });
  }
  return findings;
}

/**
 * A finding with a stable key, which a proposal cites (finding_key) to say what it fixes, and
 * its category (decision 0002, principle 8).
 */
export type KeyedFinding = Finding & { key: string; category: ProposalCategory };

const CATEGORY: Record<Finding["check"], ProposalCategory> = {
  cash_buffer: "cash",
  card_statement: "card",
  extra_payment: "debt",
  allocation: "securities",
  research_sleeve: "securities",
};

function keyOf(f: Finding): string {
  if (f.check === "card_statement") return `card_statement:${f.account_ids[0] ?? ""}`;
  if (f.check === "allocation" && typeof f.numbers.bucket === "string") {
    return `allocation:${f.numbers.bucket}`;
  }
  if (f.check === "research_sleeve" && f.numbers.kind === "freshness") {
    return "research_sleeve:freshness";
  }
  return f.check;
}

export function evaluatePolicy(
  policy: Policy,
  snapshot: Snapshot,
  securities?: SecurityCatalog,
): KeyedFinding[] {
  const cash = cashPosition(policy, snapshot);
  const cards = cardFindings(policy, snapshot);
  const cardsDue = cards
    .filter((f) => f.status === "action")
    .reduce((sum, f) => sum.plus(f.amount ?? 0), new Big(0));
  const extra = extraPaymentFinding(policy, snapshot, cash, cardsDue);
  const findings = [
    cashBufferFinding(policy, cash),
    ...cards,
    ...(extra ? [extra] : []),
    ...(snapshot.investing_enabled ? allocationFindings(policy, snapshot, securities) : []),
    ...(snapshot.investing_enabled ? researchFindings(policy, snapshot) : []),
  ];
  return findings.map((f) => ({ key: keyOf(f), category: CATEGORY[f.check], ...f }));
}

export type ProposalCategory = "cash" | "card" | "debt" | "securities";

/** What a proposal is about, from its actions. Any trade makes it investment advice. */
export function proposalCategory(snapshot: Snapshot, actions: ProposedAction[]): ProposalCategory {
  if (actions.some((a) => a.kind === "trade")) return "securities";
  const type = (id: string | undefined) => snapshot.accounts.find((a) => a.id === id)?.type;
  const payments = actions.filter((a) => a.kind === "payment");
  if (payments.some((a) => type(a.to_account_id) === "loan")) return "debt";
  if (payments.length > 0) return "card";
  return "cash";
}

export interface ProposedAction {
  kind: "transfer" | "payment" | "trade";
  from_account_id: string;
  to_account_id?: string | undefined;
  side?: "buy" | "sell" | undefined;
  symbol?: string | undefined;
  amount: string;
}

export interface Validation {
  violations: string[];
  warnings: string[];
  numbers: Record<string, unknown>;
}

/**
 * Hard limits for a proposal. Any violation stores the proposal as blocked. This runs again at
 * approval time in Phase 4, against the data then, before anything executes.
 */
export function validateProposal(
  policy: Policy,
  snapshot: Snapshot,
  actions: ProposedAction[],
  /** An action Tidysum drafted from a finding is steps for a person, with no money moves yet. */
  opts: { guided?: boolean } = {},
): Validation {
  const violations: string[] = [];
  const warnings: string[] = [];
  const byId = new Map(snapshot.accounts.map((a) => [a.id, a]));
  const cash = cashPosition(policy, snapshot);
  const cashIds = new Set(cash.accounts.map((a) => a.id));
  const maxAction = policy.limits.max_action_amount;
  let total = new Big(0);
  let cashOut = new Big(0);

  if (actions.length === 0 && !opts.guided) violations.push("a proposal needs at least one action");
  actions.forEach((a, i) => {
    const n = `action ${i + 1}`;
    const amount = new Big(a.amount);
    total = total.plus(amount);
    if (amount.lte(0)) violations.push(`${n}: amount must be positive`);
    if (maxAction && amount.gt(maxAction)) {
      violations.push(`${n}: ${money(amount)} is over the per-action limit of ${maxAction}`);
    }
    const from = byId.get(a.from_account_id);
    const to = a.to_account_id ? byId.get(a.to_account_id) : undefined;
    if (!from) violations.push(`${n}: unknown account ${a.from_account_id}`);
    if (a.to_account_id && !to) violations.push(`${n}: unknown account ${a.to_account_id}`);
    if (!from || (a.to_account_id && !to)) return;

    if (a.kind === "trade") {
      if (!snapshot.investing_enabled) {
        violations.push(
          `${n}: trade proposals are investment advice, which this account doesn't have enabled`,
        );
      }
      if (from.type !== "investment") violations.push(`${n}: trades need an investment account`);
      warnings.push(`${n}: in Phase 4, trades can only execute in the Robinhood agentic account`);
      return;
    }
    if (!to) {
      violations.push(`${n}: ${a.kind} needs a destination account`);
      return;
    }
    if (from.type !== "depository") violations.push(`${n}: money can only leave a bank account`);
    if (a.kind === "payment") {
      if (!LIABILITY_TYPES.has(to.type)) violations.push(`${n}: payments go to a card or loan`);
      else if (amount.gt(big(to.current))) {
        violations.push(`${n}: ${money(amount)} is more than the ${money(big(to.current))} owed`);
      }
    } else if (LIABILITY_TYPES.has(to.type)) {
      warnings.push(`${n}: transfer to a card or loan; use a payment instead`);
    }
    if (cashIds.has(from.id) && !cashIds.has(to.id)) cashOut = cashOut.plus(amount);
    if (!cashIds.has(from.id) && cashIds.has(to.id)) cashOut = cashOut.minus(amount);
    if (amount.gt(spendable(from))) {
      violations.push(
        `${n}: ${money(amount)} is more than ${from.name}'s ${money(spendable(from))} available`,
      );
    }
  });

  researchSleeveRules(policy, snapshot, actions, violations, warnings);

  const maxTotal = policy.limits.max_proposal_total;
  if (maxTotal && total.gt(maxTotal)) {
    violations.push(`total ${money(total)} is over the per-proposal limit of ${maxTotal}`);
  }
  const numbers: Record<string, unknown> = {
    total: money(total),
    cash_out: money(cashOut),
    liquid: money(cash.liquid),
    buffer: cash.buffer ? money(cash.buffer) : null,
  };
  if (cashOut.gt(0)) {
    if (!cash.buffer) {
      violations.push("can't check the cash buffer: no spending history to compute it from");
    } else if (cash.liquid.minus(cashOut).lt(cash.buffer)) {
      violations.push(
        `moving ${money(cashOut)} out of cash leaves ${money(cash.liquid.minus(cashOut))}, below the ${money(cash.buffer)} buffer`,
      );
    }
  }
  return { violations, warnings, numbers };
}

/**
 * A buy is a research-sleeve buy when the symbol is a sleeve position, or a ticker the miner
 * ranks that no bucket lists. Sleeve buys only come from new money (the proposal sells nothing)
 * and only up to the cap, counting the buy itself. Without a research_sleeve in the policy there
 * is no sleeve, and these rules don't apply.
 */
function researchSleeveRules(
  policy: Policy,
  snapshot: Snapshot,
  actions: ProposedAction[],
  violations: string[],
  warnings: string[],
) {
  const position = sleevePosition(policy, snapshot);
  if (!position) return;
  const sleeve = sleeveTickers(policy);
  const listed = new Set(
    Object.values(policy.allocation?.buckets ?? {}).flatMap((b) =>
      b.tickers.map((t) => t.toUpperCase()),
    ),
  );
  const ranked = new Set(snapshot.research?.tickers ?? []);
  const buys = actions.filter((a) => {
    const t = a.symbol?.toUpperCase();
    return (
      a.kind === "trade" &&
      a.side === "buy" &&
      !!t &&
      (sleeve.has(t) || (ranked.has(t) && !listed.has(t)))
    );
  });
  if (buys.length === 0) return;
  warnings.push(`Research sleeve buy: ${RESEARCH_NOTE}`);
  if (actions.some((a) => a.kind === "trade" && a.side === "sell")) {
    violations.push("research sleeve buys come from new money only, not from selling");
  }
  const total = buys.reduce((s, a) => s.plus(a.amount), new Big(0));
  const room = sleeveRoom(position);
  if (total.gt(room)) {
    const after = position.investable.plus(total);
    const share = after.gt(0) ? position.value.plus(total).div(after) : new Big(0);
    violations.push(
      `buying ${money(total)} into the research sleeve takes it to ${share.times(100).toFixed(1)}% of investable assets, over its ${position.cap.times(100).toFixed(1)}% cap`,
    );
  }
}
