import Big from "big.js";
import type { AgentDb } from "../mcp/agentDb.js";
import { type Card, type CardCatalog, cashPercent, type Network } from "./cardCatalog.js";
import { DISCLOSURE } from "./disclosure.js";

// Which card to use for a purchase, and which new cards would pay for themselves given the last
// year of spending. Spending comes from synced transactions (cards and bank accounts alike, since
// bills paid from checking could go on a card); card terms come from the card catalog. A bank or
// wallet account that is a rewards debit card in the catalog (PayPal Debit) counts as a card, so
// what it earns isn't mistaken for bank spending. All of it works from whatever accounts a user
// has linked, with nothing specific to one person.

const WINDOW_DAYS = 365;
const OTHER = "other";
/** Rates for cards Tidysum can't identify: most basic cards pay 1% on everything. */
const UNKNOWN_CARD_RATE = "1";
/** The usual fee for cards whose page doesn't state one. */
const ASSUMED_FX_FEE = "3";
/**
 * A payee paid from the bank at least STOPPED_MIN_PAYMENTS times but not in the last
 * STOPPED_AFTER_DAYS has stopped (a cancelled gym, a store no longer visited), so it isn't a habit
 * to move to a card. A once-a-year bill has too few payments to look stopped.
 */
const STOPPED_MIN_PAYMENTS = 3;
const STOPPED_AFTER_DAYS = 90;

/** Money moving between the user's own accounts or paying debt, rather than buying something. */
const NOT_SPENDING = ["TRANSFER_IN", "TRANSFER_OUT", "LOAN_PAYMENTS", "INCOME", "BANK_FEES"];

export interface SpendRow {
  /**
   * credit: already on a credit card. debit: paid from a bank account, which counts as card
   * spending when that account is a rewards debit card.
   */
  source: "credit" | "debit";
  /** The account it was paid from. */
  account_id?: string | null;
  category_detailed: string | null;
  category_primary: string | null;
  merchant: string | null;
  /** Net of refunds over the window. */
  amount: string;
  /** The payee as the bank shows it. */
  payee?: string | null;
  /** Transactions over the window, refunds included. */
  payments?: number;
  /** Most recent transaction date (YYYY-MM-DD). */
  last_date?: string | null;
}

export interface HeldCardRow {
  account_id: string;
  /** credit for a credit card; depository for a bank or wallet account that may be a debit card. */
  type?: "credit" | "depository";
  name: string;
  official_name: string | null;
  institution_name: string | null;
  /** The catalog card the user said this account is, if they did. */
  assigned_card_id?: string | null;
}

export async function readSpending(db: AgentDb, today: string): Promise<SpendRow[]> {
  const { rows } = await db.query<SpendRow>(
    `select case when a.type = 'credit' then 'credit' else 'debit' end as source,
       a.id as account_id,
       t.category_detailed, t.category_primary,
       lower(coalesce(t.merchant_name, t.name)) as merchant,
       sum(t.amount)::text as amount,
       max(coalesce(t.merchant_name, t.name)) as payee,
       count(*)::int as payments,
       to_char(max(t.date), 'YYYY-MM-DD') as last_date
     from transaction t join account a on a.id = t.account_id
     where t.removed_at is null and not t.pending
       and a.type in ('credit', 'depository')
       and t.date > $1::date - ${WINDOW_DAYS} and t.date <= $1::date
       and coalesce(t.category_primary, '') <> all($2::text[])
     group by 1, 2, 3, 4, 5
     having sum(t.amount) > 0
     order by sum(t.amount) desc`,
    [today, NOT_SPENDING],
  );
  return rows;
}

export async function readHeldCards(db: AgentDb): Promise<HeldCardRow[]> {
  const { rows } = await db.query<HeldCardRow>(
    `select a.id as account_id, a.type, a.name, a.official_name, i.institution_name,
       ca.card_id as assigned_card_id
     from account a join item i on i.id = a.item_id
     left join card_assignment ca on ca.account_id = a.id
     where (a.type = 'credit' and coalesce(a.subtype, 'credit card') = 'credit card'
         or a.type = 'depository')
       and i.status <> 'disconnected'
     order by a.type, i.institution_name nulls last, a.name`,
  );
  return rows;
}

/** Fees on an account over the last year that a better card or habit would avoid. */
export interface CardFeeRow {
  account_id: string;
  account_name: string;
  institution_name: string | null;
  type: string;
  /** Interest charged on a credit account. */
  interest: string;
  /** Foreign transaction fees, on any account. */
  foreign_fees: string;
}

export async function readCardFees(db: AgentDb, today: string): Promise<CardFeeRow[]> {
  const { rows } = await db.query<CardFeeRow>(
    `select a.id as account_id, a.name as account_name, i.institution_name, a.type,
       coalesce(sum(t.amount) filter (
         where a.type = 'credit' and t.category_detailed = 'BANK_FEES_INTEREST_CHARGE'), 0)::text
         as interest,
       coalesce(sum(t.amount) filter (
         where t.category_detailed = 'BANK_FEES_FOREIGN_TRANSACTION_FEES'), 0)::text
         as foreign_fees
     from transaction t
     join account a on a.id = t.account_id
     join item i on i.id = a.item_id
     where t.removed_at is null and not t.pending
       and t.date > $1::date - ${WINDOW_DAYS} and t.date <= $1::date
       and t.category_detailed in ('BANK_FEES_INTEREST_CHARGE', 'BANK_FEES_FOREIGN_TRANSACTION_FEES')
     group by a.id, a.name, i.institution_name, a.type
     order by a.name`,
    [today],
  );
  return rows;
}

/** Card interest across all accounts, for compareCards' warning. */
export const totalInterest = (fees: CardFeeRow[]) =>
  fees.reduce((s, f) => s.plus(f.interest), new Big(0)).toFixed(2);

const money = (b: Big) => b.toFixed(2);

/** The catalog category for a transaction: detailed codes win over whole primaries. */
export function categoryOf(
  catalog: CardCatalog,
  detailed: string | null,
  primary: string | null,
): string {
  const entries = Object.entries(catalog.categories);
  if (detailed) {
    for (const [k, c] of entries) if (c.codes.plaid.includes(detailed)) return k;
  }
  if (primary) {
    for (const [k, c] of entries) if (c.codes.plaid.includes(primary)) return k;
  }
  return OTHER;
}

const isPayable = (catalog: CardCatalog, category: string) =>
  category === OTHER || (catalog.categories[category]?.card_payable ?? true);

interface Option {
  card: Card;
  /** Cash-equivalent percent. */
  percent: Big;
  label: string;
  /** Earned only in a period the cardholder picks this rate (choose_one). */
  chosen?: boolean;
  /** Shared cap across all spending matching this rate, per year. */
  capKey?: string;
  capAmount?: Big;
}

const PERIODS = { month: 12, quarter: 4, year: 1 } as const;

/**
 * Every way a card can earn on spending in this category at this merchant, best first. Rates the
 * cardholder picks between (choose_one) are included, marked chosen; bestRewards instead tries
 * each pick as its own card (withPick), so they never add up.
 */
function optionsFor(catalog: CardCatalog, card: Card, category: string, merchant: string | null) {
  const out: Option[] = [];
  const add = (r: Card["rates"][number], i: number, chosen: boolean) => {
    const hit = r.merchants
      ? !!merchant && r.merchants.some((m) => merchant.includes(m.toLowerCase()))
      : r.category === category;
    if (!hit) return;
    out.push({
      card,
      percent: cashPercent(card, r.rate),
      label: r.label,
      ...(chosen ? { chosen } : {}),
      ...(r.cap
        ? {
            capKey: `${card.id}#${i}`,
            capAmount: new Big(r.cap.amount).times(PERIODS[r.cap.period]),
          }
        : {}),
    });
  };
  for (const [i, r] of card.rates.entries()) add(r, i, false);
  for (const [i, r] of (card.choose_one?.rates ?? []).entries()) {
    add(r, card.rates.length + i, true);
  }
  if (isPayable(catalog, category)) {
    out.push({ card, percent: cashPercent(card, card.base_rate), label: "everything else" });
  }
  return out.sort((a, b) => b.percent.cmp(a.percent));
}

export interface RewardRow {
  category: string;
  merchant: string | null;
  amount: Big;
  /** Only cards on these networks can pay it; unset means any card. */
  networks?: Network[] | undefined;
}

/** A card on an unknown network doesn't count where only some networks are taken. */
const accepts = (networks: Network[] | undefined, card: Card) =>
  !networks || (!!card.network && networks.includes(card.network));

/** The networks a merchant takes, when it limits them. */
export function acceptanceAt(catalog: CardCatalog, merchant: string | null) {
  if (!merchant) return undefined;
  return catalog.acceptance.find((a) => a.match.some((m) => merchant.includes(m)));
}

/** "NES ELECTRIC BILLPAY PPD ID: 0000000160" -> "NES ELECTRIC BILLPAY": drops ACH trailers. */
export function payeeName(raw: string | null | undefined): string {
  return (raw ?? "")
    .replace(/\s+(PPD|WEB|CCD|TEL|ARC|POS)\s+ID:.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface Allocation {
  card_id: string;
  amount: Big;
  percent: Big;
  label: string;
}

/** The card as if its holder picked this choose_one rate, with the pick folded into its rates. */
function withPick(card: Card, pick: Card["rates"][number]): Card {
  const { choose_one: _, ...rest } = card;
  return { ...rest, rates: [...card.rates, pick] };
}

/** Each card's possible picks, or the card alone when it has none to make. */
const picksOf = (card: Card) =>
  card.choose_one
    ? card.choose_one.rates.map((r) => ({ card: withPick(card, r), pick: r }))
    : [{ card, pick: null }];

/** Past this many pick combinations, cards beyond the first pick-based ones keep their first. */
const MAX_PICK_COMBOS = 64;

/**
 * Splits each spending row across the cards to earn the most, highest rate first, respecting
 * caps. Greedy, so with overlapping caps it can fall a little short of the true optimum. A card
 * whose holder picks a bonus category (choose_one) is tried with each pick, keeping the best;
 * `picks` says which, by card id.
 */
export function bestRewards(catalog: CardCatalog, cards: Card[], rows: RewardRow[]) {
  let combos: { card: Card; pick: Card["rates"][number] | null }[][] = [[]];
  for (const card of cards) {
    const options = picksOf(card);
    const usable =
      combos.length * options.length <= MAX_PICK_COMBOS ? options : options.slice(0, 1);
    combos = combos.flatMap((c) => usable.map((o) => [...c, o]));
  }
  type Picks = Map<string, Card["rates"][number]>;
  let best: (ReturnType<typeof allocate> & { picks: Picks }) | undefined;
  for (const combo of combos) {
    const result = allocate(
      catalog,
      combo.map((o) => o.card),
      rows,
    );
    if (!best || result.total.gt(best.total)) {
      const picks: Picks = new Map();
      for (const o of combo) if (o.pick) picks.set(o.card.id, o.pick);
      best = { ...result, picks };
    }
  }
  return best ?? { ...allocate(catalog, [], rows), picks: new Map() as Picks };
}

function allocate(catalog: CardCatalog, cards: Card[], rows: RewardRow[]) {
  const segments: { row: number; option: Option }[] = [];
  rows.forEach((r, row) => {
    for (const card of cards) {
      if (!accepts(r.networks, card)) continue;
      for (const option of optionsFor(catalog, card, r.category, r.merchant)) {
        segments.push({ row, option });
      }
    }
  });
  segments.sort((a, b) => b.option.percent.cmp(a.option.percent));
  const left = rows.map((r) => r.amount);
  const capLeft = new Map<string, Big>();
  const allocations: Allocation[][] = rows.map(() => []);
  let total = new Big(0);
  for (const { row, option } of segments) {
    let take = left[row] ?? new Big(0);
    if (take.lte(0)) continue;
    if (option.capKey && option.capAmount) {
      const cap = capLeft.get(option.capKey) ?? option.capAmount;
      if (cap.lte(0)) continue;
      if (cap.lt(take)) take = cap;
      capLeft.set(option.capKey, cap.minus(take));
    }
    left[row] = (left[row] ?? new Big(0)).minus(take);
    total = total.plus(take.times(option.percent).div(100));
    allocations[row]?.push({
      card_id: option.card.id,
      amount: take,
      percent: option.percent,
      label: option.label,
    });
  }
  return { total, allocations };
}

export const annualCost = (card: Card) =>
  new Big(card.annual_fee).plus(card.membership?.annual_cost ?? 0);

export interface HeldCard {
  account_id: string;
  account_name: string;
  institution_name: string | null;
  /** The catalog card, or null when Tidysum couldn't tell which card this is. */
  card_id: string | null;
  card_name: string;
  identified_by: "override" | "assigned" | "official_name" | "assumed";
  /** debit: a bank or wallet account that is a rewards debit card in the catalog. */
  kind: "credit" | "debit";
  /**
   * For a card whose holder picks a bonus category (PayPal Debit's monthly 5%), the pick that
   * earns the most on this user's spending: label names the pick, choice the category to pick.
   * Set by compareCards.
   */
  pick?: { label: string; choice: string } | null;
}

/**
 * Matches linked cards to the catalog: an explicit override first, then the card the user
 * assigned, then the account's reported name. A credit card that can't be identified is treated
 * as paying 1% on everything. A bank or wallet account only counts when it is a catalog debit
 * card (PayPal Debit on a PayPal account); any other is left out, since it earns nothing. An
 * assignment naming a card no longer in the catalog, or of the wrong kind, is ignored.
 */
export function identifyCards(
  catalog: CardCatalog,
  rows: HeldCardRow[],
  overrides: Record<string, string> = {},
): { held: HeldCard[]; cards: Card[] } {
  const byId = new Map(catalog.cards.map((c) => [c.id, c]));
  const cards: Card[] = [];
  const held: HeldCard[] = [];
  for (const r of rows) {
    const kind = r.type === "depository" ? "debit" : "credit";
    const fits = (c: Card | undefined) => (c?.kind === kind ? c : undefined);
    const base = {
      account_id: r.account_id,
      account_name: r.name,
      institution_name: r.institution_name,
      kind,
    } as const;
    const found = (card: Card, identified_by: HeldCard["identified_by"]) => {
      cards.push(card);
      held.push({ ...base, card_id: card.id, card_name: card.name, identified_by });
    };
    const forced = overrides[r.account_id];
    if (forced) {
      const card = byId.get(forced);
      if (!card) throw new Error(`unknown card id ${forced}`);
      found(card, "override");
      continue;
    }
    const assigned = fits(r.assigned_card_id ? byId.get(r.assigned_card_id) : undefined);
    if (assigned) {
      found(assigned, "assigned");
      continue;
    }
    const name = `${r.official_name ?? ""} ${r.name}`.toLowerCase();
    const match = catalog.cards.find(
      (c) => c.kind === kind && c.match.some((m) => name.includes(m)),
    );
    if (match) {
      found(match, "official_name");
      continue;
    }
    if (kind === "debit") continue;
    cards.push(unknownCard(r));
    held.push({
      ...base,
      card_id: null,
      card_name: `${r.official_name ?? r.name} (unidentified, assumed 1% on everything)`,
      identified_by: "assumed",
    });
  }
  return { held, cards };
}

function unknownCard(r: HeldCardRow): Card {
  return {
    id: `account-${r.account_id}`,
    issuer: r.institution_name ?? "unknown",
    name: r.official_name ?? r.name,
    kind: "credit",
    annual_fee: "0",
    foreign_transaction_fee: null,
    reward: { currency: "cash" },
    base_rate: UNKNOWN_CARD_RATE,
    rates: [],
    match: [],
    source_url: "https://example.invalid/",
    verified_on: "1970-01-01",
  };
}

export interface CardRecommendation {
  card_id: string;
  name: string;
  issuer: string;
  annual_fee: string;
  membership: string | null;
  /** Extra rewards per year from adding this card, before its fees. */
  added_rewards: string;
  /** added_rewards minus annual fee and membership: what the user actually gains. */
  annual_gain: string;
  /** Where the extra rewards come from, by category. */
  earns_on: { category: string; spend: string; percent: string }[];
  requires: string | null;
  welcome_offer: string | null;
  notes: string | null;
  source_url: string;
  verified_on: string;
}

export interface BankPayee {
  payee: string;
  /** Category labels, biggest first. */
  categories: string[];
  amount: string;
  payments: number;
  last_date: string | null;
  status: "could_go_on_card" | "stopped" | "card_not_accepted";
  /** Why it can't, for card_not_accepted. */
  note: string | null;
}

export interface CardReport {
  as_of: string;
  window: { from: string; to: string };
  held_cards: HeldCard[];
  spending: {
    by_category: {
      category: string;
      label: string;
      on_cards: string;
      from_bank: string;
      card_payable: boolean;
      /** Why it isn't card-payable, when it isn't. */
      card_note: string | null;
    }[];
    on_cards: string;
    /** Bank spending one of your cards could take from now on: the could_go_on_card payees. */
    from_bank_card_payable: string;
    not_card_payable: string;
    /**
     * Each payee paid from a bank account in a category cards take, biggest first, and whether it
     * could go on a card: stopped means no payment lately, card_not_accepted means none of your
     * cards is on a network the merchant takes.
     */
    bank_payees: BankPayee[];
  };
  rewards: {
    /** Card spending on the cards you have, each purchase on the best one; bank spending earns 0. */
    current: string;
    /** Also putting card-payable bank spending on your best existing card. */
    with_bank_spending_on_cards: string;
    /** With recommended_wallet added, net of its fees. */
    with_recommended_cards: string;
  };
  /** Each catalog card you don't have, added on its own, best gain first. Only positive gains. */
  recommendations: CardRecommendation[];
  /**
   * The best set of cards to add, picked one at a time while each still pays for itself. Each
   * card's annual_gain is what it adds on top of the cards picked before it, so they sum to the
   * total.
   */
  recommended_wallet: {
    card_ids: string[];
    cards: { card_id: string; name: string; annual_gain: string }[];
    annual_gain: string;
  };
  warnings: string[];
  assumptions: string[];
  disclosure: string;
}

const ASSUMPTIONS = [
  "Spending is the last 365 days of purchases from linked cards and bank accounts, net of refunds. " +
    "Transfers, loan and card payments, income and bank fees are left out, so purchases on cards " +
    "that aren't linked, or paid through Venmo or Zelle, are missing.",
  "Each purchase is assumed to go on whichever card earns the most for it, up to any caps.",
  "Points are valued at what they're worth as cash or statement credit, not travel transfers.",
  "Rent, utilities, taxes and donations only count for cards with an explicit rate for them, " +
    "since paying them by card usually costs a fee or isn't accepted.",
  `Bank payments to a payee paid ${STOPPED_MIN_PAYMENTS} or more times but not in the last ` +
    `${STOPPED_AFTER_DAYS} days are treated as stopped, so they don't count toward moving bills to a card.`,
  "Merchants that take only some card networks (Costco takes only Visa) count only for cards on them.",
  "Welcome bonuses, first-year fee waivers and rotating quarterly categories are left out.",
  "A card where you pick the bonus category (PayPal Debit's monthly 5%) is counted with the one " +
    "pick that earns you the most, as if you picked it every month.",
  "A bank or wallet account Tidysum knows as a rewards debit card (a PayPal account as PayPal " +
    "Debit) counts as that card, so its purchases count as card spending.",
];

const DAY_MS = 86_400_000;
const STALE_AFTER_DAYS = 30;

export function compareCards(
  catalog: CardCatalog,
  spending: SpendRow[],
  heldRows: HeldCardRow[],
  today: string,
  overrides: Record<string, string> = {},
  /** Card interest charged over the same year (readCardFees), for the honesty warning. */
  interestCharged = "0",
): CardReport {
  const warnings: string[] = [];
  if (new Big(interestCharged).gt(0)) {
    warnings.push(
      `Your cards charged ${money(new Big(interestCharged))} in interest in the last year. ` +
        "Interest on a carried balance costs far more than any card's rewards earn, so paying " +
        "each statement in full matters more than which card you use. The rewards below assume " +
        "balances are paid in full.",
    );
  }
  for (const c of catalog.cards) {
    const age = Math.round((Date.parse(today) - Date.parse(c.verified_on)) / DAY_MS);
    if (age > STALE_AFTER_DAYS) {
      warnings.push(
        `${c.name} terms were last verified ${age} days ago; re-check ${c.source_url}.`,
      );
    }
  }
  const { held, cards: heldCards } = identifyCards(catalog, heldRows, overrides);
  for (const h of held) {
    if (h.identified_by === "assumed") {
      warnings.push(
        `${h.account_name}: the bank reports it as "${h.card_name.replace(/ \(unidentified.*$/, "")}", ` +
          "which doesn't say which card it is, so it's assumed to earn 1% on everything. " +
          "Say which card it is on the admin page or with `tidysum card-set`.",
      );
    }
  }

  const stoppedBefore = new Date(Date.parse(today) - STOPPED_AFTER_DAYS * DAY_MS)
    .toISOString()
    .slice(0, 10);
  // Purchases from a bank or wallet account that is a rewards debit card were made with a card,
  // except rent, taxes and the like, which go by bank transfer.
  const debitCards = new Set(held.filter((h) => h.kind === "debit").map((h) => h.account_id));
  const rows = spending.map((s) => {
    const category = categoryOf(catalog, s.category_detailed, s.category_primary);
    const byDebitCard =
      !!s.account_id && debitCards.has(s.account_id) && isPayable(catalog, category);
    const source: SpendRow["source"] = s.source === "debit" && !byDebitCard ? "debit" : "credit";
    const debit = source === "debit";
    const rule = debit ? acceptanceAt(catalog, s.merchant) : undefined;
    return {
      ...s,
      source,
      category,
      value: new Big(s.amount),
      // Only bank spending is limited: a card purchase shows a card the merchant took.
      networks: rule?.networks,
      acceptanceNote: rule?.note ?? null,
      stopped:
        debit &&
        (s.payments ?? 0) >= STOPPED_MIN_PAYMENTS &&
        !!s.last_date &&
        s.last_date < stoppedBefore,
    };
  });
  const label = (k: string) =>
    k === OTHER ? "Everything else" : (catalog.categories[k]?.label ?? k);

  const byCategory = new Map<string, { onCards: Big; fromBank: Big }>();
  for (const r of rows) {
    const e = byCategory.get(r.category) ?? { onCards: new Big(0), fromBank: new Big(0) };
    if (r.source === "credit") e.onCards = e.onCards.plus(r.value);
    else e.fromBank = e.fromBank.plus(r.value);
    byCategory.set(r.category, e);
  }
  const sum = (xs: Big[]) => xs.reduce((a, b) => a.plus(b), new Big(0));
  const onCards = sum(rows.filter((r) => r.source === "credit").map((r) => r.value));
  const notPayable = sum(rows.filter((r) => !isPayable(catalog, r.category)).map((r) => r.value));

  // Bank payees in categories cards take, merged across categories (Costco and Costco Gas). A
  // debit card that earns nothing on a payment is no reason to move it.
  const canTake = (c: Card, r: (typeof rows)[number]) =>
    accepts(r.networks, c) &&
    (c.kind === "credit" || !!optionsFor(catalog, c, r.category, r.merchant)[0]?.percent.gt(0));
  const statusOf = (r: (typeof rows)[number]): BankPayee["status"] =>
    r.stopped
      ? "stopped"
      : heldCards.some((c) => canTake(c, r))
        ? "could_go_on_card"
        : "card_not_accepted";
  const payees = new Map<
    string,
    {
      payee: string;
      amount: Big;
      payments: number;
      last: string | null;
      byCategory: Map<string, Big>;
      status: BankPayee["status"];
      note: string | null;
    }
  >();
  for (const r of rows) {
    if (r.source !== "debit" || !isPayable(catalog, r.category)) continue;
    const key = r.merchant ?? "";
    const status = statusOf(r);
    const p = payees.get(key) ?? {
      payee: payeeName(r.payee ?? r.merchant) || "Unnamed payee",
      amount: new Big(0),
      payments: 0,
      last: null,
      byCategory: new Map<string, Big>(),
      status,
      note: null,
    };
    p.amount = p.amount.plus(r.value);
    p.payments += r.payments ?? 0;
    if (r.last_date && (!p.last || r.last_date > p.last)) p.last = r.last_date;
    p.byCategory.set(r.category, (p.byCategory.get(r.category) ?? new Big(0)).plus(r.value));
    // One movable row makes the payee movable; otherwise the first reason stands.
    if (status === "could_go_on_card") p.status = status;
    if (status === "card_not_accepted") p.note = r.acceptanceNote;
    payees.set(key, p);
  }
  const bankPayees: BankPayee[] = [...payees.values()]
    .sort((a, b) => b.amount.cmp(a.amount))
    .map((p) => ({
      payee: p.payee,
      categories: [...p.byCategory.entries()]
        .sort(([, a], [, b]) => b.cmp(a))
        .map(([k]) => label(k)),
      amount: money(p.amount),
      payments: p.payments,
      last_date: p.last,
      status: p.status,
      note: p.status === "card_not_accepted" ? p.note : null,
    }));

  // Bank spending a held card could take from now on.
  const movable = rows.filter(
    (r) =>
      r.source === "debit" && isPayable(catalog, r.category) && statusOf(r) === "could_go_on_card",
  );
  const payableBank = sum(movable.map((r) => r.value));

  const asRows = (rs: typeof rows): RewardRow[] =>
    rs.map((r) => ({
      category: r.category,
      merchant: r.merchant,
      amount: r.value,
      networks: r.networks,
    }));
  const cardRows = asRows(rows.filter((r) => r.source === "credit"));
  // Spending from here on: card purchases plus bank payments that haven't stopped. A card
  // that can't be used somewhere earns nothing there.
  const allRows = asRows(rows.filter((r) => !r.stopped));
  const current = bestRewards(catalog, heldCards, cardRows).total;
  const withBank = bestRewards(catalog, heldCards, [...cardRows, ...asRows(movable)]).total;
  // What the cards you hold earn on allRows, so a new card is credited only for what it adds.
  const base = bestRewards(catalog, heldCards, allRows);
  const baseline = base.total;
  // The bonus category to pick on each held card that has one, for the spending from here on.
  for (const [i, h] of held.entries()) {
    const card = heldCards[i];
    const rate = card?.choose_one && base.picks.get(card.id);
    if (card?.choose_one && rate) {
      h.pick = {
        label: card.choose_one.label,
        choice: rate.category ? label(rate.category) : rate.label,
      };
    }
  }

  const heldIds = new Set(heldCards.map((c) => c.id));
  const candidates = catalog.cards.filter((c) => !heldIds.has(c.id));
  const recommend = (wallet: Card[], baseline: Big) =>
    candidates
      .filter((c) => !wallet.includes(c))
      .map((card) => {
        const { total, allocations } = bestRewards(catalog, [...wallet, card], allRows);
        const added = total.minus(baseline);
        const earnsOn = new Map<string, { spend: Big; percent: Big }>();
        allocations.forEach((as, i) => {
          for (const a of as) {
            if (a.card_id !== card.id) continue;
            const k = allRows[i]?.category ?? OTHER;
            const e = earnsOn.get(k) ?? { spend: new Big(0), percent: a.percent };
            e.spend = e.spend.plus(a.amount);
            earnsOn.set(k, e);
          }
        });
        return { card, added, gain: added.minus(annualCost(card)), earnsOn };
      })
      .sort((a, b) => b.gain.cmp(a.gain));

  const singles = recommend(heldCards, baseline);
  const recommendations = singles
    .filter((s) => s.gain.gt(0))
    .map(
      (s): CardRecommendation => ({
        card_id: s.card.id,
        name: s.card.name,
        issuer: s.card.issuer,
        annual_fee: money(new Big(s.card.annual_fee)),
        membership: s.card.membership
          ? `${s.card.membership.name}, ${money(new Big(s.card.membership.annual_cost))}/yr`
          : null,
        added_rewards: money(s.added),
        annual_gain: money(s.gain),
        earns_on: [...s.earnsOn.entries()]
          .sort(([, a], [, b]) => b.spend.cmp(a.spend))
          .map(([k, e]) => ({
            category: label(k),
            spend: money(e.spend),
            percent: e.percent.toFixed(2),
          })),
        requires: s.card.requires ?? null,
        welcome_offer: s.card.welcome_offer ?? null,
        notes: s.card.notes ?? null,
        source_url: s.card.source_url,
        verified_on: s.card.verified_on,
      }),
    );

  // Add cards one at a time while the next one still pays for itself.
  const wallet = [...heldCards];
  let walletRewards = baseline;
  let walletFees = new Big(0);
  const picked: { card_id: string; name: string; annual_gain: string }[] = [];
  for (let i = 0; i < 3; i++) {
    const [next] = recommend(wallet, walletRewards);
    if (!next || next.gain.lte(0)) break;
    wallet.push(next.card);
    picked.push({ card_id: next.card.id, name: next.card.name, annual_gain: money(next.gain) });
    walletRewards = walletRewards.plus(next.added);
    walletFees = walletFees.plus(annualCost(next.card));
  }
  const withRecommended = walletRewards.minus(walletFees);

  return {
    as_of: today,
    window: {
      from: new Date(Date.parse(today) - (WINDOW_DAYS - 1) * DAY_MS).toISOString().slice(0, 10),
      to: today,
    },
    held_cards: held,
    spending: {
      by_category: [...byCategory.entries()]
        .sort(([, a], [, b]) => b.onCards.plus(b.fromBank).cmp(a.onCards.plus(a.fromBank)))
        .map(([k, e]) => ({
          category: k,
          label: label(k),
          on_cards: money(e.onCards),
          from_bank: money(e.fromBank),
          card_payable: isPayable(catalog, k),
          card_note: isPayable(catalog, k) ? null : (catalog.categories[k]?.card_note ?? null),
        })),
      on_cards: money(onCards),
      from_bank_card_payable: money(payableBank),
      not_card_payable: money(notPayable),
      bank_payees: bankPayees,
    },
    rewards: {
      current: money(current),
      with_bank_spending_on_cards: money(withBank),
      with_recommended_cards: money(withRecommended),
    },
    recommendations,
    recommended_wallet: {
      card_ids: picked.map((p) => p.card_id),
      cards: picked,
      annual_gain: money(withRecommended.minus(baseline)),
    },
    warnings,
    assumptions: ASSUMPTIONS,
    disclosure: DISCLOSURE,
  };
}

export interface PurchaseQuery {
  amount?: string | undefined;
  /** A catalog category key or a Plaid category code. */
  category?: string | undefined;
  merchant?: string | undefined;
  foreign?: boolean | undefined;
}

export interface PurchaseAdvice {
  category: string;
  category_label: string;
  /** How the category was decided. */
  category_basis: string;
  /** Your cards, best first. */
  your_cards: {
    account_id: string;
    card_name: string;
    percent: string;
    rate_label: string;
    reward: string | null;
    note: string | null;
  }[];
  /** The best catalog card you don't have, if it beats all of yours. */
  better_card_elsewhere: {
    card_id: string;
    name: string;
    percent: string;
    source_url: string;
  } | null;
  disclosure: string;
}

/** Looks up what category the user's past purchases at this merchant fell into. */
export async function merchantCategory(db: AgentDb, merchant: string) {
  const escaped = merchant.replace(/[\\%_]/g, (c) => `\\${c}`);
  const { rows } = await db.query<{
    category_detailed: string | null;
    category_primary: string | null;
  }>(
    `select t.category_detailed, t.category_primary
     from transaction t
     where t.removed_at is null and t.amount > 0
       and (t.merchant_name ilike $1 or t.name ilike $1)
     group by 1, 2 order by count(*) desc, sum(t.amount) desc limit 1`,
    [`%${escaped}%`],
  );
  return rows[0] ?? null;
}

export function adviseOnPurchase(
  catalog: CardCatalog,
  heldRows: HeldCardRow[],
  q: PurchaseQuery,
  history: { category_detailed: string | null; category_primary: string | null } | null,
  overrides: Record<string, string> = {},
): PurchaseAdvice {
  let category = OTHER;
  let basis = "no category or merchant given";
  if (q.category && catalog.categories[q.category]) {
    category = q.category;
    basis = "given";
  } else if (q.category) {
    category = categoryOf(catalog, q.category, q.category);
    basis = `Plaid category ${q.category}`;
  } else if (history) {
    category = categoryOf(catalog, history.category_detailed, history.category_primary);
    basis = `your past purchases at this merchant (${history.category_detailed ?? history.category_primary})`;
  } else if (q.merchant) {
    basis = "no past purchases at this merchant, so treated as a general purchase";
  }
  const merchant = q.merchant?.toLowerCase() ?? null;

  const effective = (card: Card) => {
    const [best] = optionsFor(catalog, card, category, merchant);
    if (!best) return null;
    const fx = q.foreign ? new Big(card.foreign_transaction_fee ?? ASSUMED_FX_FEE) : new Big(0);
    return { percent: best.percent.minus(fx), option: best, fx };
  };

  const { held, cards } = identifyCards(catalog, heldRows, overrides);
  const yours = held
    .map((h, i) => {
      const card = cards[i];
      const e = card ? effective(card) : null;
      const notes = [
        e?.option.chosen ? "only in a month you pick it as your bonus category" : null,
        e?.option.capKey ? "capped rate; past the cap it earns the base rate" : null,
        e?.fx.gt(0) ? `includes a ${e.fx.toFixed(2)}% foreign transaction fee` : null,
        h.identified_by === "assumed" ? "card not identified, assumed 1%" : null,
        e ? null : "doesn't normally take this kind of payment",
      ].filter(Boolean);
      return {
        account_id: h.account_id,
        card_name: h.card_name,
        percent: e ? e.percent.toFixed(2) : "0.00",
        rate_label: e?.option.label ?? "none",
        reward: e && q.amount ? money(new Big(q.amount).times(e.percent).div(100)) : null,
        note: notes.length ? notes.join("; ") : null,
      };
    })
    .sort((a, b) => new Big(b.percent).cmp(a.percent));

  const bestYours = new Big(yours[0]?.percent ?? 0);
  const heldIds = new Set(cards.map((c) => c.id));
  const elsewhere = catalog.cards
    .filter((c) => !heldIds.has(c.id))
    .map((c) => ({ c, e: effective(c) }))
    .filter((x) => x.e?.percent.gt(bestYours))
    .sort((a, b) => (b.e?.percent ?? new Big(0)).cmp(a.e?.percent ?? 0))[0];

  return {
    category,
    category_label:
      category === OTHER ? "Everything else" : (catalog.categories[category]?.label ?? category),
    category_basis: basis,
    your_cards: yours,
    better_card_elsewhere: elsewhere?.e
      ? {
          card_id: elsewhere.c.id,
          name: elsewhere.c.name,
          percent: elsewhere.e.percent.toFixed(2),
          source_url: elsewhere.c.source_url,
        }
      : null,
    disclosure: DISCLOSURE,
  };
}
