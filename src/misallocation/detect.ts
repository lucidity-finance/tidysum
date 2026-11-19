import { createHash } from "node:crypto";
import Big from "big.js";
import type { AgentDb } from "../mcp/agentDb.js";
import { evaluatePolicy, type KeyedFinding } from "../policy/engine.js";
import { canonical } from "../policy/policy.js";
import { readSnapshot } from "../policy/snapshot.js";
import { loadActivePolicy } from "../policy/store.js";
import type { SecurityCatalog } from "../portfolio/securityCatalog.js";
import type { CardCatalog } from "../products/cardCatalog.js";
import {
  compareCards,
  identifyCards,
  membershipsIn,
  readCardFees,
  readHeldCards,
  readPaidMemberships,
  readSpending,
  totalInterest,
} from "../products/cards.js";
import type { Catalog } from "../products/catalog.js";
import { compareProducts, productLabel, readCashAccounts } from "../products/compare.js";
import { DISCLOSURE } from "../products/disclosure.js";
import { readIraYears, rothIraFindings } from "../retirement/ira.js";
import { readWorkplacePlans, workplaceFindings } from "../retirement/workplace.js";

// Decision 0003: find money in the wrong place and price it per year. Each detector turns one
// comparison into misallocations of one shape, so everything a user could fix ranks on one list
// by what it costs them. Detectors only read; the ledger (ledger.ts) records what they find.

export const CATEGORIES = ["cash", "card", "debt", "securities"] as const;
export type Category = (typeof CATEGORIES)[number];

export const DETECTORS = [
  "deposit_rate",
  "card_wallet",
  "card_usage",
  "foreign_fees",
  "card_statement",
  "extra_payment",
  "retirement_rate",
  "fund_fee",
  "brokerage_window",
  "roth_ira",
] as const;
export type Detector = (typeof DETECTORS)[number];

/**
 * Bumped when card_usage's rules change, so a finding priced under old rules that no longer shows
 * is withdrawn rather than counted as acted on. 2: utilities, stopped payees and card networks.
 * 3: purchases on a rewards debit card (PayPal Debit) count as card spending, not bank spending.
 */
export const CARD_USAGE_METHOD = 3;

/** Below this a finding is noise, not something worth a user's time. */
const MIN_ANNUAL_COST = new Big(1);

/** A connection that hasn't synced in this many days may be missing what would have been found. */
const STALE_AFTER_DAYS = 7;

export interface Misallocation {
  /** Stable across runs, so the ledger can follow one finding over time. */
  key: string;
  category: Category;
  detector: Detector;
  summary: string;
  /** What fixing it would gain per year, from observed data and published terms. */
  annual_cost: string;
  currency: "USD";
  account_ids: string[];
  /** The catalog product or card that fixes it, when there is one. */
  product_id: string | null;
  /** What the user would do about it. */
  action: string;
  /** The numbers the cost came from, and the catalog version, so it can be checked later. */
  inputs: Record<string, unknown>;
}

export interface Detection {
  as_of: string;
  /** Detectors that ran. The ledger only closes findings whose detector ran. */
  ran: Detector[];
  /**
   * Detectors the policy turned off (a style that avoids credit cards): their open findings are
   * withdrawn, not counted as fixed.
   */
  suppressed?: Detector[];
  items: Misallocation[];
  /** What later runs need to tell "acted on" from "went away": what the user now holds. */
  holdings: {
    /** Catalog card ids the user's linked cards were identified as. */
    card_ids: string[];
    /** Lowercased institution names of linked cash accounts. */
    cash_institutions: string[];
    /** Each recorded workplace plan's contribution percent of pay, by account id. */
    workplace_percents?: Record<string, string>;
    /** What's recorded as put into IRAs, all kinds together, by tax year. */
    ira_recorded?: Record<string, string>;
    /**
     * Findings a detector couldn't decide this run because a fact it needs is missing (a fund's
     * published mix, say): they stay as they are rather than closing as acted on.
     */
    undecided_keys?: string[];
    /** The plan funds each workplace plan account holds, by their lineup names. */
    workplace_funds?: Record<string, string[]>;
    /** The tickers in each workplace plan's linked brokerage window, by plan account id. */
    workplace_window_tickers?: Record<string, string[]>;
  };
  /**
   * Accounts whose data may be out of date: the connection needs repair or hasn't synced
   * recently, or the account was imported from a file. A finding that went away on these may
   * only have gone quiet, so the ledger doesn't count it as acted on.
   */
  stale_account_ids: string[];
  warnings: string[];
}

export interface Catalogs {
  deposits?: Catalog | undefined;
  cards?: CardCatalog | undefined;
  /** Asset classes of funds, for pricing workplace plan funds by what they hold. */
  securities?: SecurityCatalog | undefined;
}

/** Loads whichever catalogs are configured. */
export async function loadCatalogs(p: {
  loadCatalog: () => Promise<Catalog>;
  loadCardCatalog?: (() => Promise<CardCatalog>) | undefined;
  loadSecurityCatalog?: (() => Promise<SecurityCatalog>) | undefined;
}): Promise<Catalogs> {
  return {
    deposits: await p.loadCatalog(),
    cards: await p.loadCardCatalog?.(),
    securities: await p.loadSecurityCatalog?.(),
  };
}

/** sha256 of a catalog's canonical JSON, so a finding names the exact terms it was priced on. */
export function catalogVersion(catalog: unknown): string {
  return createHash("sha256").update(canonical(catalog)).digest("hex");
}

const money = (b: Big) => b.toFixed(2);

export async function detectMisallocations(
  db: AgentDb,
  catalogs: Catalogs,
  today: string,
): Promise<Detection> {
  const items: Misallocation[] = [];
  const ran: Detector[] = [];
  const suppressed: Detector[] = [];
  const warnings: string[] = [];
  const holdings: Detection["holdings"] = { card_ids: [], cash_institutions: [] };
  const stale = await staleAccounts(db, today, warnings);

  if (catalogs.deposits) {
    const facts = await readCashAccounts(db, today);
    holdings.cash_institutions = [
      ...new Set(
        facts.flatMap((f) => (f.institution_name ? [f.institution_name.toLowerCase()] : [])),
      ),
    ];
    items.push(
      ...depositFindings(compareProducts(catalogs.deposits, facts, today), catalogs.deposits),
    );
    ran.push("deposit_rate");
  }

  items.push(...(await policyFindings(db, today, ran, warnings)));
  items.push(
    ...(await retirementFindings(db, catalogs.securities, today, ran, warnings, holdings)),
  );

  const fees = await readCardFees(db, today);
  items.push(...foreignFeeFindings(fees));
  ran.push("foreign_fees");

  if (catalogs.cards) {
    const heldRows = await readHeldCards(db);
    const avoidCards = await avoidsCreditCards(db);
    holdings.card_ids = identifyCards(catalogs.cards, heldRows).held.flatMap((h) =>
      h.card_id ? [h.card_id] : [],
    );
    const report = compareCards(
      catalogs.cards,
      await readSpending(db, today),
      heldRows,
      today,
      {},
      totalInterest(fees),
      [...new Set([...membershipsIn(items), ...(await readPaidMemberships(db, today))])],
    );
    // A style that steers away from credit cards ("Debt-free first") gets no suggestion to open
    // a card or to move bills onto one.
    if (!avoidCards) {
      items.push(...cardFindings(report, catalogs.cards));
      ran.push("card_wallet", "card_usage");
    } else suppressed.push("card_wallet", "card_usage");
    warnings.push(...report.warnings);
  }

  return {
    as_of: today,
    ran,
    ...(suppressed.length ? { suppressed } : {}),
    items: items
      .filter((m) => new Big(m.annual_cost).gte(MIN_ANNUAL_COST))
      .sort((a, b) => new Big(b.annual_cost).cmp(a.annual_cost) || a.key.localeCompare(b.key)),
    holdings,
    stale_account_ids: stale,
    warnings,
  };
}

/** Accounts on connections that need repair or haven't synced in STALE_AFTER_DAYS. */
async function staleAccounts(db: AgentDb, today: string, warnings: string[]): Promise<string[]> {
  const { rows } = await db.query<{
    institution_name: string | null;
    status: string;
    last_synced_on: string | null;
    account_ids: string[];
  }>(
    `select i.institution_name, i.status,
       to_char(i.last_synced_at at time zone 'UTC', 'YYYY-MM-DD') as last_synced_on,
       array_agg(a.id) as account_ids
     from item i
     join account a on a.item_id = i.id
     where i.status <> 'active' or i.last_synced_at is null
       or i.last_synced_at < $1::date - ${STALE_AFTER_DAYS}
     group by i.id, i.institution_name, i.status, i.last_synced_at
     order by i.institution_name`,
    [today],
  );
  for (const r of rows) {
    const since = r.last_synced_on ?? "never";
    const why =
      r.status === "active" ? `last synced ${since}` : `${r.status}, last synced ${since}`;
    warnings.push(
      `${r.institution_name ?? "A connection"} is out of date (${why}): what it would show ` +
        "now may be missing, and findings on its accounts won't be counted as acted on until it syncs.",
    );
  }
  return rows.flatMap((r) => r.account_ids);
}

/**
 * Retirement accounts, priced: what the owner's agent recorded about their workplace plans
 * (contributions off the year's limit, plan funds dearer than the plan's index funds) and Roth
 * IRA room left unused. Investment advice, so only for users with investing enabled.
 */
async function retirementFindings(
  db: AgentDb,
  securities: SecurityCatalog | undefined,
  today: string,
  ran: Detector[],
  warnings: string[],
  holdings: Detection["holdings"],
): Promise<Misallocation[]> {
  const snapshot = await readSnapshot(db, today);
  if (!snapshot.investing_enabled) return [];
  const plans = await readWorkplacePlans(db, warnings);
  const items: Misallocation[] = [];
  if (plans.length > 0) {
    const found = workplaceFindings(plans, snapshot.holdings, securities, today, snapshot.accounts);
    warnings.push(...found.warnings);
    holdings.workplace_percents = found.percents;
    holdings.undecided_keys = found.undecided;
    holdings.workplace_funds = found.funds;
    holdings.workplace_window_tickers = found.window_tickers;
    if (found.rates_current) ran.push("retirement_rate");
    ran.push("fund_fee", "brokerage_window");
    items.push(...found.items);
  }
  const ira = rothIraFindings({
    today,
    accounts: snapshot.accounts,
    holdings: snapshot.holdings,
    plans,
    years: await readIraYears(db, warnings),
  });
  warnings.push(...ira.warnings);
  holdings.ira_recorded = ira.recorded;
  ran.push("roth_ira");
  items.push(...ira.items);
  return items;
}

const POLICY_ACTIONS: Partial<Record<KeyedFinding["check"], string>> = {
  card_statement: "Pay the statement in full by its due date, and every one after it.",
  extra_payment: "Put the spare cash toward the highest-APR debt.",
};

/**
 * The policy checks that put a yearly cost on what they find. A card statement only counts once
 * the card has actually charged interest: a statement that is simply due isn't money lost yet.
 */
/** Whether the active policy asks Tidysum to steer away from credit cards. */
async function avoidsCreditCards(db: AgentDb): Promise<boolean> {
  const { rows } = await db.query("select 1 from policy_version limit 1");
  if (rows.length === 0) return false;
  return (await loadActivePolicy(db)).policy.cards.avoid_credit_cards === true;
}

async function policyFindings(
  db: AgentDb,
  today: string,
  ran: Detector[],
  warnings: string[],
): Promise<Misallocation[]> {
  const { rows } = await db.query("select 1 from policy_version limit 1");
  if (rows.length === 0) {
    warnings.push("No policy is set, so card statements and debt payments aren't checked.");
    return [];
  }
  const loaded = await loadActivePolicy(db);
  ran.push("card_statement", "extra_payment");
  return evaluatePolicy(loaded.policy, await readSnapshot(db, today)).flatMap(
    (f): Misallocation[] => {
      const action = POLICY_ACTIONS[f.check];
      if (f.status !== "action" || !f.annual_cost || !action) return [];
      if (
        f.check === "card_statement" &&
        !new Big(String(f.numbers.interest_charged_365d ?? 0)).gt(0)
      ) {
        return [];
      }
      return [
        {
          key: f.key,
          category: f.category,
          detector: f.check as Detector,
          summary: f.summary,
          annual_cost: f.annual_cost,
          currency: "USD",
          account_ids: f.account_ids,
          product_id: null,
          action,
          inputs: { policy_version: loaded.versionId, numbers: f.numbers },
        },
      ];
    },
  );
}

function depositFindings(
  comparison: ReturnType<typeof compareProducts>,
  catalog: Catalog,
): Misallocation[] {
  const version = catalogVersion(catalog);
  return comparison.accounts.flatMap((a): Misallocation[] => {
    const best = a.alternatives[0];
    if (!best) return [];
    // The owner picked somewhere that doesn't pay more than today: nothing to fix here.
    if (a.chosen_product_id && best.product_id !== a.chosen_product_id) return [];
    const label = productLabel(best.provider, best.name);
    const where = a.institution_name ? ` at ${a.institution_name}` : "";
    const cond = best.requires ? ` (needs ${best.requires})` : "";
    return [
      {
        key: `deposit_rate:${a.account_id}`,
        category: "cash",
        detector: "deposit_rate",
        summary:
          `${a.account_name}${where} earns ${a.current.effective_apy}% on about ${a.balance}; ` +
          `${label} pays ${best.apy}%${cond}.`,
        annual_cost: best.annual_gain,
        currency: "USD",
        account_ids: [a.account_id],
        product_id: best.product_id,
        action: `Move the balance to ${label}.`,
        inputs: {
          catalog: { name: "deposit-products", version },
          balance: a.balance,
          balance_basis: a.balance_basis,
          current: a.current,
          alternative: {
            product_id: best.product_id,
            provider: best.provider,
            name: best.name,
            institutions: best.institutions,
            apy: best.apy,
            requires: best.requires,
            annual_gain_without_conditions: best.annual_gain_without_conditions,
            source_url: best.source_url,
            rates_as_of: best.rates_as_of,
            verified_on: best.verified_on,
            stale: best.stale,
          },
          chosen_by_owner: a.chosen_product_id === best.product_id,
        },
      },
    ];
  });
}

function cardFindings(
  report: ReturnType<typeof compareCards>,
  catalog: CardCatalog,
): Misallocation[] {
  const version = catalogVersion(catalog);
  const held = report.held_cards.map((h) => ({ account_id: h.account_id, card_id: h.card_id }));
  const out: Misallocation[] = [];

  // Card-payable spending paid from a bank account earns nothing; on the best card already held
  // it would earn that card's rate. Only payees still being paid and that a held card can pay.
  const movable = report.spending.bank_payees.filter((p) => p.status === "could_go_on_card");
  const usage = new Big(report.rewards.with_bank_spending_on_cards).minus(report.rewards.current);
  if (usage.gt(0)) {
    out.push({
      key: "card_usage",
      category: "card",
      detector: "card_usage",
      summary:
        `${report.spending.from_bank_card_payable} a year paid from a bank account to ` +
        `${movable.length === 1 ? "a payee" : `${movable.length} payees`} that take your cards, ` +
        "earning no rewards.",
      annual_cost: money(usage),
      currency: "USD",
      account_ids: report.held_cards.map((h) => h.account_id),
      product_id: null,
      action: "Pay these bills and purchases with your best card, then pay the card in full.",
      inputs: {
        catalog: { name: "credit-cards", version },
        window: report.window,
        method: CARD_USAGE_METHOD,
        from_bank_card_payable: report.spending.from_bank_card_payable,
        payees: movable.map((p) => ({
          payee: p.payee,
          categories: p.categories,
          amount: p.amount,
          payments: p.payments,
          last_date: p.last_date,
        })),
        rewards: report.rewards,
        held_cards: held,
      },
    });
  }

  for (const pick of report.recommended_wallet.cards) {
    const rec = report.recommendations.find((r) => r.card_id === pick.card_id);
    out.push({
      key: `card_wallet:${pick.card_id}`,
      category: "card",
      detector: "card_wallet",
      summary:
        `Adding ${pick.name} would earn ${pick.annual_gain} a year more on your spending, after its fees` +
        (rec?.membership_already_paid
          ? `. It needs ${rec.membership?.replace(/,.*$/, "")}, which you already pay for to get its IRA match.`
          : "."),
      annual_cost: pick.annual_gain,
      currency: "USD",
      account_ids: [],
      product_id: pick.card_id,
      action: `Get the ${pick.name} and use it where it earns the most.`,
      inputs: {
        catalog: { name: "credit-cards", version },
        card_name: pick.name,
        window: report.window,
        wallet_order: report.recommended_wallet.card_ids,
        held_cards: held,
        annual_fee: rec?.annual_fee ?? null,
        membership: rec?.membership ?? null,
        membership_already_paid: rec?.membership_already_paid ?? false,
        earns_on: rec?.earns_on ?? [],
        requires: rec?.requires ?? null,
        source_url: rec?.source_url ?? null,
        verified_on: rec?.verified_on ?? null,
      },
    });
  }
  return out;
}

function foreignFeeFindings(fees: Awaited<ReturnType<typeof readCardFees>>): Misallocation[] {
  return fees
    .filter((f) => new Big(f.foreign_fees).gt(0))
    .map((f) => ({
      key: `foreign_fees:${f.account_id}`,
      category: "card" as const,
      detector: "foreign_fees" as const,
      summary: `${f.account_name} charged ${money(new Big(f.foreign_fees))} in foreign transaction fees in the last year.`,
      annual_cost: money(new Big(f.foreign_fees)),
      currency: "USD" as const,
      account_ids: [f.account_id],
      product_id: null,
      action:
        "Use a card with no foreign transaction fee for purchases abroad or in other currencies.",
      inputs: { account_type: f.type, foreign_fees: f.foreign_fees, window_days: 365 },
    }));
}

export interface MisallocationReport {
  as_of: string;
  /** Sum of the open findings, leaving out ones the user dismissed. */
  annual_cost: string;
  monthly_cost: string;
  by_category: Record<Category, string>;
  items: (Misallocation & {
    /** new: not recorded yet. Otherwise the ledger state. */
    state: "new" | "open" | "dismissed";
    id: string | null;
    first_seen_at: string | null;
  })[];
  /** What no detector looks at yet, so a small total isn't read as "nothing to fix". */
  not_covered: string[];
  warnings: string[];
  disclosure: string;
}

const NOT_COVERED = [
  "securities: fees are priced only for funds in a recorded workplace plan and its brokerage window (fund_fee, brokerage_window); other brokerage fund fees, idle brokerage cash and allocation are not priced yet.",
  "securities: IRA contributions are known only as recorded (roth_ira); Plaid doesn't say which tax year a contribution counts for.",
  "debt: loan refinancing is not priced yet.",
  "cash above the buffer is priced by deposit_rate, at the account it sits in, not separately.",
  "Cards and accounts that aren't linked are invisible, so spending on them is missing.",
];

/** The live detection, joined with what the ledger already knows about each finding. */
export async function misallocationReport(
  db: AgentDb,
  catalogs: Catalogs,
  today: string,
): Promise<MisallocationReport> {
  const detection = await detectMisallocations(db, catalogs, today);
  const { rows } = await db.query<{
    id: string;
    key: string;
    state: string;
    first_seen_at: string;
  }>("select id, key, state, first_seen_at from misallocation where key = any($1::text[])", [
    detection.items.map((m) => m.key),
  ]);
  const known = new Map(rows.map((r) => [r.key, r]));
  const items = detection.items.map((m) => {
    const row = known.get(m.key);
    const state: "new" | "open" | "dismissed" =
      row?.state === "dismissed" ? "dismissed" : row?.state === "open" ? "open" : "new";
    return { ...m, state, id: row?.id ?? null, first_seen_at: row?.first_seen_at ?? null };
  });
  const counted = items.filter((m) => m.state !== "dismissed");
  const total = counted.reduce((s, m) => s.plus(m.annual_cost), new Big(0));
  const byCategory = Object.fromEntries(
    CATEGORIES.map((c) => [
      c,
      money(
        counted.filter((m) => m.category === c).reduce((s, m) => s.plus(m.annual_cost), new Big(0)),
      ),
    ]),
  ) as Record<Category, string>;
  return {
    as_of: today,
    annual_cost: money(total),
    monthly_cost: money(total.div(12)),
    by_category: byCategory,
    items,
    not_covered: NOT_COVERED,
    warnings: detection.warnings,
    disclosure: DISCLOSURE,
  };
}
