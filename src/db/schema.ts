import {
  bigserial,
  boolean,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

// Money is Postgres numeric and travels through the app as a decimal string. Never a JS float.
const money = (name: string) => numeric(name, { precision: 19, scale: 4 });
const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });
const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/**
 * One person whose money Tidysum manages. Every table of personal data carries `user_id`, and the
 * agent roles see only rows whose user_id matches their session's `tidysum.user_id` (row-level
 * security). Child tables reference their parent by (id, user_id), so a row can't point at
 * another user's data.
 */
export const appUser = pgTable("app_user", {
  id: uuid("id").primaryKey().defaultRandom(),
  displayName: text("display_name").notNull(),
  /**
   * Allocation checks and securities proposals. Only for someone managing their own money:
   * giving investment advice to anyone else needs SEC internet adviser registration first
   * (docs/decisions/0002-product-principles.md, principle 8).
   */
  investingEnabled: boolean("investing_enabled").notNull().default(false),
  /**
   * Plaid's id for this person (/user/create). Lets one Link session add several institutions,
   * so the phone code is entered once per session instead of once per bank.
   */
  plaidUserId: text("plaid_user_id").unique(),
  /**
   * E.164 phone number Plaid Link pre-fills, so a returning user only types the code Plaid
   * texts. Not readable by tidysum_agent (drizzle/0016).
   */
  phoneNumber: text("phone_number"),
  /**
   * Where this person lives, as an ISO 3166-1 alpha-2 code (src/region.ts): their home currency,
   * which banks Plaid offers, and whether US-only advice (401(k), IRA, US catalogs) applies.
   */
  country: text("country").notNull().default("US"),
  /**
   * Whether the Investments page (and the agent's allocation report) shows money amounts. Off by
   * default: Tidysum is calm by design and shows only shares of the mix, for people who'd rather
   * not watch their balance move. Some people want the numbers, so they can turn them on.
   */
  showInvestmentAmounts: boolean("show_investment_amounts").notNull().default(false),
  createdAt: tstz("created_at").notNull().defaultNow(),
});

const userId = () =>
  uuid("user_id")
    .notNull()
    .references(() => appUser.id, { onDelete: "cascade" });

export const itemSource = ["plaid", "csv", "enable_banking", "simplefin"] as const;
export const itemStatus = ["active", "relink_required", "error", "disconnected"] as const;

/** One login at one institution. Plaid's Trial plan allows 10 of these. */
export const item = pgTable(
  "item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userId(),
    source: text("source", { enum: itemSource }).notNull(),
    plaidItemId: text("plaid_item_id").unique(),
    institutionId: text("institution_id"),
    institutionName: text("institution_name"),
    status: text("status", { enum: itemStatus }).notNull().default("active"),
    statusDetail: text("status_detail"),
    transactionsCursor: text("transactions_cursor"),
    lastSyncedAt: tstz("last_synced_at"),
    createdAt: tstz("created_at").notNull().defaultNow(),
  },
  (t) => [unique("item_id_user_unique").on(t.id, t.userId)],
);

/**
 * Plaid access tokens, AES-256-GCM encrypted. Kept apart from `item` so the agent role
 * can read items without ever being granted this table.
 */
export const itemSecret = pgTable("item_secret", {
  itemId: uuid("item_id")
    .primaryKey()
    .references(() => item.id, { onDelete: "cascade" }),
  accessTokenCiphertext: bytea("access_token_ciphertext").notNull(),
  keyVersion: integer("key_version").notNull(),
});

export const account = pgTable(
  "account",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userId(),
    itemId: uuid("item_id").notNull(),
    plaidAccountId: text("plaid_account_id").unique(),
    name: text("name").notNull(),
    officialName: text("official_name"),
    type: text("type").notNull(),
    subtype: text("subtype"),
    mask: text("mask"),
    currency: text("currency"),
    createdAt: tstz("created_at").notNull().defaultNow(),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("account_id_user_unique").on(t.id, t.userId),
    foreignKey({
      name: "account_item_fk",
      columns: [t.itemId, t.userId],
      foreignColumns: [item.id, item.userId],
    }).onDelete("cascade"),
  ],
);

export const balanceSnapshot = pgTable(
  "balance_snapshot",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: userId(),
    accountId: uuid("account_id").notNull(),
    current: money("current"),
    available: money("available"),
    creditLimit: money("credit_limit"),
    currency: text("currency"),
    asOf: tstz("as_of").notNull(),
  },
  (t) => [
    unique().on(t.accountId, t.asOf),
    foreignKey({
      name: "balance_snapshot_account_fk",
      columns: [t.accountId, t.userId],
      foreignColumns: [account.id, account.userId],
    }).onDelete("cascade"),
  ],
);

/**
 * Amount follows Plaid's sign convention: positive = money out of the account,
 * negative = money in. `removed_at` is set when Plaid reports the transaction removed
 * (usually a pending transaction replaced by its posted version); rows are never deleted.
 * name and merchant_name are untrusted text from the institution.
 */
export const transaction = pgTable(
  "transaction",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userId(),
    accountId: uuid("account_id").notNull(),
    plaidTransactionId: text("plaid_transaction_id").unique(),
    /** CSV imports only: stable hash of the row, so re-importing an overlapping export is a no-op. */
    csvFingerprint: text("csv_fingerprint").unique(),
    date: date("date", { mode: "string" }).notNull(),
    authorizedDate: date("authorized_date", { mode: "string" }),
    amount: money("amount").notNull(),
    currency: text("currency"),
    name: text("name"),
    merchantName: text("merchant_name"),
    categoryPrimary: text("category_primary"),
    categoryDetailed: text("category_detailed"),
    pending: boolean("pending").notNull(),
    pendingTransactionId: text("pending_transaction_id"),
    removedAt: tstz("removed_at"),
    createdAt: tstz("created_at").notNull().defaultNow(),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("transaction_account_date_idx").on(t.accountId, t.date),
    foreignKey({
      name: "transaction_account_fk",
      columns: [t.accountId, t.userId],
      foreignColumns: [account.id, account.userId],
    }).onDelete("cascade"),
  ],
);

/** Market data, shared by everyone: no user_id. */
export const security = pgTable("security", {
  id: text("id").primaryKey(), // Plaid security_id
  name: text("name"),
  tickerSymbol: text("ticker_symbol"),
  type: text("type"),
  isCashEquivalent: boolean("is_cash_equivalent"),
  closePrice: numeric("close_price", { precision: 28, scale: 10 }),
  closePriceAsOf: date("close_price_as_of", { mode: "string" }),
  currency: text("currency"),
  updatedAt: tstz("updated_at").notNull().defaultNow(),
});

/** Latest known position per account and security. Replaced wholesale on each sync. */
export const holding = pgTable(
  "holding",
  {
    userId: userId(),
    accountId: uuid("account_id").notNull(),
    securityId: text("security_id")
      .notNull()
      .references(() => security.id),
    quantity: numeric("quantity", { precision: 28, scale: 10 }).notNull(),
    institutionPrice: numeric("institution_price", { precision: 28, scale: 10 }).notNull(),
    institutionValue: money("institution_value").notNull(),
    costBasis: money("cost_basis"),
    currency: text("currency"),
    asOf: tstz("as_of").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.securityId] }),
    foreignKey({
      name: "holding_account_fk",
      columns: [t.accountId, t.userId],
      foreignColumns: [account.id, account.userId],
    }).onDelete("cascade"),
  ],
);

export const liabilityKind = ["credit", "mortgage", "student"] as const;

/** Key payoff fields only. Account numbers from Plaid are deliberately not stored. */
export const liability = pgTable(
  "liability",
  {
    accountId: uuid("account_id").primaryKey(),
    userId: userId(),
    kind: text("kind", { enum: liabilityKind }).notNull(),
    aprPercentage: numeric("apr_percentage", { precision: 9, scale: 4 }),
    lastStatementBalance: money("last_statement_balance"),
    minimumPayment: money("minimum_payment"),
    nextPaymentDueDate: date("next_payment_due_date", { mode: "string" }),
    isOverdue: boolean("is_overdue"),
    asOf: tstz("as_of").notNull(),
  },
  (t) => [
    foreignKey({
      name: "liability_account_fk",
      columns: [t.accountId, t.userId],
      foreignColumns: [account.id, account.userId],
    }).onDelete("cascade"),
  ],
);

/**
 * Which catalog card (catalog/credit-cards.json) a linked credit card account is, as the user
 * said. Banks often report a generic name ("Ultimate Rewards"), so this is how the card
 * comparison knows what a card earns. Set from the admin page or CLI; agents only read it.
 */
export const cardAssignment = pgTable(
  "card_assignment",
  {
    accountId: uuid("account_id").primaryKey(),
    userId: userId(),
    cardId: text("card_id").notNull(),
    setAt: tstz("set_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "card_assignment_account_fk",
      columns: [t.accountId, t.userId],
      foreignColumns: [account.id, account.userId],
    }).onDelete("cascade"),
  ],
);

/**
 * Where the owner wants a cash account's spare money to go: a deposit product from
 * catalog/deposit-products.json, when they've picked one over the highest-paying option (SoFi
 * because it takes their paycheck, say). The deposit finding and its action follow this pick.
 * Set from the admin page; agents only read it.
 */
export const depositChoice = pgTable(
  "deposit_choice",
  {
    accountId: uuid("account_id").primaryKey(),
    userId: userId(),
    productId: text("product_id").notNull(),
    setAt: tstz("set_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "deposit_choice_account_fk",
      columns: [t.accountId, t.userId],
      foreignColumns: [account.id, account.userId],
    }).onDelete("cascade"),
  ],
);

/**
 * Investments no data source can reach (Treasuries held at TreasuryDirect, say), entered by the
 * owner: one value per holding, as of a date, in one asset class from catalog/securities.json.
 */
export const manualHolding = pgTable(
  "manual_holding",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userId(),
    name: text("name").notNull(),
    assetClass: text("asset_class").notNull(),
    value: money("value").notNull(),
    asOf: date("as_of", { mode: "string" }).notNull(),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [unique("manual_holding_user_name_unique").on(t.userId, t.name)],
);

/**
 * What a workplace retirement plan (a 401(k)) looks like from the inside, where no data source
 * reaches: contribution elections, year-to-date contributions, the match, where each paycheck is
 * invested and the plan's fund lineup with fees. One per plan account, replaced whole, as of a
 * date; the owner's agent reads it off the plan's site. Shape: src/retirement/workplace.ts.
 */
export const workplacePlan = pgTable(
  "workplace_plan",
  {
    accountId: uuid("account_id").primaryKey(),
    userId: userId(),
    facts: jsonb("facts").notNull(),
    asOf: date("as_of", { mode: "string" }).notNull(),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "workplace_plan_account_fk",
      columns: [t.accountId, t.userId],
      foreignColumns: [account.id, account.userId],
    }).onDelete("cascade"),
  ],
);

/**
 * What went into the user's IRAs for one tax year, where no data source reaches: Plaid shows IRA
 * balances but not which tax year a contribution counts for. Recorded when the owner's agent
 * finishes an IRA action, or by the owner (`tidysum ira set`). Shape: src/retirement/ira.ts.
 */
export const iraYear = pgTable(
  "ira_year",
  {
    userId: userId(),
    taxYear: integer("tax_year").notNull(),
    facts: jsonb("facts").notNull(),
    asOf: date("as_of", { mode: "string" }).notNull(),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.taxYear] })],
);

export const syncRunStatus = ["running", "succeeded", "failed"] as const;

/**
 * The owner's written plan for their money: goals, target mix, where each dollar goes, rules.
 * Markdown the owner writes; one per user, replaced whole. Agents read it so
 * their advice follows it, and the admin page shows it.
 */
export const financialPlan = pgTable("financial_plan", {
  userId: userId().primaryKey(),
  markdown: text("markdown").notNull(),
  updatedAt: tstz("updated_at").notNull().defaultNow(),
});

export const syncRun = pgTable(
  "sync_run",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: userId(),
    itemId: uuid("item_id").notNull(),
    startedAt: tstz("started_at").notNull().defaultNow(),
    finishedAt: tstz("finished_at"),
    status: text("status", { enum: syncRunStatus }).notNull().default("running"),
    added: integer("added").notNull().default(0),
    modified: integer("modified").notNull().default(0),
    removed: integer("removed").notNull().default(0),
    error: text("error"),
  },
  (t) => [
    foreignKey({
      name: "sync_run_item_fk",
      columns: [t.itemId, t.userId],
      foreignColumns: [item.id, item.userId],
    }).onDelete("cascade"),
  ],
);

/**
 * A user's policies, keyed by the sha256 of the canonical JSON. The active one is the most
 * recently activated; older versions stay because proposals record which one they were checked
 * against.
 */
export const policyVersion = pgTable(
  "policy_version",
  {
    userId: userId(),
    id: text("id").notNull(),
    content: jsonb("content").notNull(),
    loadedAt: tstz("loaded_at").notNull().defaultNow(),
    activatedAt: tstz("activated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.id] })],
);

/**
 * proposed -> approved | dismissed; blocked -> dismissed; approved -> done | dismissed; any of
 * proposed, approved, done -> confirmed. `approved` records the owner's yes, re-checked against the
 * policy and data at that moment. `done` is the owner saying the steps are carried out;
 * `confirmed` is a later sync showing the finding it fixes went away because it was acted on.
 * Nothing executes yet (Phase 4).
 */
export const proposalState = [
  "proposed",
  "blocked",
  "approved",
  "done",
  "confirmed",
  "dismissed",
] as const;

/**
 * One step of an action, in the order to do it. `by` says who carries it out (decision 0005):
 * "agent" steps are for the owner's own agent, working the approved action over MCP, which stops
 * for `needs_you` (an identity check, a code, a signature); "you" steps stay with the owner, who
 * can also do every step themselves.
 */
export interface ActionStep {
  text: string;
  by: "agent" | "you";
  needs_you?: string | undefined;
}
/** Conditions an action can wait for besides its days (decision 0008). */
export const proposalWaitFor = ["calm_markets"] as const;

/** What a proposal is about. "securities" is investment advice and is regulated as such. */
export const proposalCategory = ["cash", "card", "debt", "securities"] as const;

/**
 * An agent's suggestion, checked against the policy when it is created. `blocked` means it broke
 * a hard limit. The owner can approve an open one, which checks it again first. Nothing executes
 * a proposal yet; execution comes in Phase 4, which must re-check it against the data then.
 */
export const proposal = pgTable(
  "proposal",
  {
    id: uuid("id").primaryKey(),
    userId: userId(),
    policyVersionId: text("policy_version_id").notNull(),
    source: text("source").notNull(),
    title: text("title").notNull(),
    rationale: text("rationale").notNull(),
    state: text("state", { enum: proposalState }).notNull(),
    category: text("category", { enum: proposalCategory }).notNull(),
    /**
     * What the proposal is expected to save or earn per year, in the account currency. Null when
     * the proposer couldn't put a number on it. Compared later with what was actually realized.
     */
    expectedAnnualValue: money("expected_annual_value"),
    /** The misallocation finding this proposal fixes, e.g. "cash_buffer" or "card_statement:<id>". */
    findingKey: text("finding_key"),
    /** The policy engine's verdict at creation: violations, warnings and the numbers it used. */
    validation: jsonb("validation").notNull(),
    /** How to carry it out, for proposals Tidysum drafts from a finding. Null for agents' ones. */
    steps: jsonb("steps").$type<ActionStep[]>(),
    /** "Not now": left out of the queue until this day. */
    snoozedUntil: date("snoozed_until", { mode: "string" }),
    /**
     * A scheduled action (decision 0006) can't be carried out before this day: the owner may
     * approve it ahead, and it waits under Scheduled until then.
     */
    notBefore: date("not_before", { mode: "string" }),
    /** The last day it still does its job; past it, the Actions page says it's overdue. */
    dueBy: date("due_by", { mode: "string" }),
    /**
     * The action this one checks (decision 0006): a change no sync can see, like a 401(k)
     * election, is confirmed when its follow-up check is finished.
     */
    followUpOf: uuid("follow_up_of"),
    /**
     * A condition it waits for besides its days (decision 0008): `calm_markets` holds a sale
     * until the VIX has been calm for a few closes, so money sits out of the market only in a
     * quiet stretch.
     */
    waitFor: text("wait_for", { enum: proposalWaitFor }),
    createdAt: tstz("created_at").notNull().defaultNow(),
    decidedAt: tstz("decided_at"),
  },
  (t) => [
    unique("proposal_id_user_unique").on(t.id, t.userId),
    foreignKey({
      name: "proposal_policy_version_fk",
      columns: [t.userId, t.policyVersionId],
      foreignColumns: [policyVersion.userId, policyVersion.id],
    }),
    foreignKey({
      name: "proposal_follow_up_fk",
      columns: [t.followUpOf, t.userId],
      foreignColumns: [t.id, t.userId],
    }).onDelete("cascade"),
  ],
);

/**
 * Daily market readings Tidysum watches (decision 0008), like the VIX close from FRED's VIXCLS.
 * Market data, not personal data, so no row-level security (like `security`); the owner side
 * fetches it and agents only read it.
 */
export const marketReading = pgTable(
  "market_reading",
  {
    series: text("series").notNull(),
    day: date("day", { mode: "string" }).notNull(),
    value: numeric("value", { precision: 12, scale: 4 }).notNull(),
    fetchedAt: tstz("fetched_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.series, t.day] })],
);

/**
 * The owner's own order for their actions, set by dragging them on the Actions page. Keyed by the
 * finding an action fixes (its proposal id when it fixes none), so the place survives Tidysum
 * drafting the action again. Actions with no place here come first, in Tidysum's own order.
 * Set from the admin page; agents only read it, so they work through actions in that order too.
 */
export const actionOrder = pgTable(
  "action_order",
  {
    userId: userId(),
    key: text("key").notNull(),
    position: integer("position").notNull(),
    setAt: tstz("set_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

export const proposalActionKind = ["transfer", "payment", "trade"] as const;
export const tradeSide = ["buy", "sell"] as const;

export const proposalAction = pgTable(
  "proposal_action",
  {
    userId: userId(),
    proposalId: uuid("proposal_id").notNull(),
    seq: integer("seq").notNull(),
    kind: text("kind", { enum: proposalActionKind }).notNull(),
    /** transfer and payment: money leaves this account. trade: the brokerage account. */
    fromAccountId: uuid("from_account_id"),
    /** transfer: destination. payment: the card or loan being paid. */
    toAccountId: uuid("to_account_id"),
    side: text("side", { enum: tradeSide }),
    symbol: text("symbol"),
    amount: money("amount").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.proposalId, t.seq] }),
    foreignKey({
      name: "proposal_action_proposal_fk",
      columns: [t.proposalId, t.userId],
      foreignColumns: [proposal.id, proposal.userId],
    }).onDelete("cascade"),
    // Both account references carry user_id, so an action can only name the user's own accounts.
    foreignKey({
      name: "proposal_action_from_account_fk",
      columns: [t.fromAccountId, t.userId],
      foreignColumns: [account.id, account.userId],
    }),
    foreignKey({
      name: "proposal_action_to_account_fk",
      columns: [t.toAccountId, t.userId],
      foreignColumns: [account.id, account.userId],
    }),
  ],
);

export const misallocationCategory = ["cash", "card", "debt", "securities"] as const;
export const misallocationState = ["open", "dismissed", "resolved", "withdrawn"] as const;

/**
 * The recommendation ledger (decisions 0002 and 0003): one row per thing a detector found in the
 * wrong place, followed over time by its key. `open` while it is still found, `dismissed` when
 * the user says no, `resolved` when it went away because the user acted (they now hold the
 * suggested account or card, or the fee stopped), `withdrawn` when it went away for another
 * reason (rates moved, the balance left). Every transition is also an audit_event.
 */
export const misallocation = pgTable(
  "misallocation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userId(),
    key: text("key").notNull(),
    category: text("category", { enum: misallocationCategory }).notNull(),
    detector: text("detector").notNull(),
    summary: text("summary").notNull(),
    /** The latest yearly cost while open; the last one seen once closed. */
    annualCost: money("annual_cost").notNull(),
    accountIds: uuid("account_ids").array().notNull(),
    productId: text("product_id"),
    action: text("action").notNull(),
    /** The numbers behind annual_cost, including the catalog version it was priced on. */
    inputs: jsonb("inputs").notNull(),
    state: text("state", { enum: misallocationState }).notNull().default("open"),
    firstSeenAt: tstz("first_seen_at").notNull().defaultNow(),
    lastSeenAt: tstz("last_seen_at").notNull().defaultNow(),
    /** When it was dismissed, resolved or withdrawn. */
    decidedAt: tstz("decided_at"),
    /** What acting on it actually gained per year, measured from later data; null until then. */
    realizedAnnualValue: money("realized_annual_value"),
    realizedBasis: text("realized_basis"),
  },
  (t) => [unique("misallocation_user_key_unique").on(t.userId, t.key)],
);

/**
 * Append-only: a trigger rejects UPDATE and DELETE. No foreign keys, so it outlives what it logs.
 */
export const auditEvent = pgTable("audit_event", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: uuid("user_id").notNull(),
  at: tstz("at").notNull().defaultNow(),
  actor: text("actor").notNull(),
  event: text("event").notNull(),
  proposalId: uuid("proposal_id"),
  data: jsonb("data").notNull(),
});

/**
 * Research evidence from investment-miner (a separate, read-only research tool the owner runs),
 * imported from its saved JSON export (schema 2). Market research, shared by everyone like
 * `security`: no user_id. Only completed runs are stored; a partial or failed run is never
 * current. A miner score is research evidence, not a target weight or an instruction to trade.
 */
export const researchRun = pgTable("research_run", {
  runId: text("run_id").primaryKey(),
  /** The miner's product: `institutional` (conviction) or `assets` (price dislocation). */
  product: text("product").notNull(),
  /** The miner watchlist the run scanned; each watchlist is its own ranked list. */
  watchlist: text("watchlist").notNull(),
  status: text("status").notNull(),
  scoringVersion: text("scoring_version"),
  exportSchemaVersion: integer("export_schema_version").notNull(),
  /** The run's saved as-of time: what the evidence was current at, and what its age counts from. */
  asOf: tstz("as_of").notNull(),
  startedAt: tstz("started_at").notNull(),
  completedAt: tstz("completed_at"),
  /** The run's explicit limitations and fetch warnings, kept with every candidate. */
  limitations: jsonb("limitations").notNull(),
  warnings: jsonb("warnings").notNull(),
  coverage: jsonb("coverage"),
  /** How many signals the run saved; only the top ranks are imported. */
  signalCount: integer("signal_count").notNull(),
  importedAt: tstz("imported_at").notNull().defaultNow(),
});

/** One ranked candidate of a research run, with a summary of the evidence behind its score. */
export const researchCandidate = pgTable(
  "research_candidate",
  {
    runId: text("run_id")
      .notNull()
      .references(() => researchRun.runId, { onDelete: "cascade" }),
    rank: integer("rank").notNull(),
    ticker: text("ticker").notNull(),
    name: text("name"),
    /** The miner's saved score, 0 to 1; null when unavailable (never replaced with zero). */
    score: numeric("score"),
    /** Share of the score's inputs that were observed; not a probability. */
    scoreCoverage: numeric("score_coverage"),
    summary: text("summary").notNull(),
    evidence: jsonb("evidence").notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.rank] })],
);

/** Each attempt to read the miner: what it listed, what was imported, or why it failed. */
export const researchImport = pgTable("research_import", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  at: tstz("at").notNull().defaultNow(),
  ok: boolean("ok").notNull(),
  error: text("error"),
  /** Per watchlist: the newest run the miner listed and its status, and the run kept as current. */
  attempts: jsonb("attempts").notNull(),
  imported: text("imported").array().notNull(),
});

/**
 * What each mutual fund and ETF share class charges, from the SEC's prospectus risk/return data
 * sets (`tidysum facts refresh`). Market data, shared by everyone like `security`: no user_id.
 * One row per share class, from its latest filing in the data.
 */
export const fundFee = pgTable(
  "fund_fee",
  {
    classId: text("class_id").primaryKey(),
    seriesId: text("series_id").notNull(),
    ticker: text("ticker").notNull(),
    fundName: text("fund_name").notNull(),
    className: text("class_name"),
    /** Percent a year after any fee waiver, like 0.03: what holders pay. */
    expenseRatio: numeric("expense_ratio", { precision: 7, scale: 4 }).notNull(),
    /** Percent before waivers, when the fee table states one apart. */
    grossExpenseRatio: numeric("gross_expense_ratio", { precision: 7, scale: 4 }),
    asOf: date("as_of", { mode: "string" }).notNull(),
    filed: date("filed", { mode: "string" }).notNull(),
    sourceUrl: text("source_url").notNull(),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [index("fund_fee_ticker_idx").on(t.ticker)],
);

/**
 * Card fees and APRs from the CFPB's Terms of Credit Card Plans survey. Market data, shared by
 * everyone: no user_id. Replaced whole by each newer survey.
 */
export const cardTerms = pgTable("card_terms", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  institution: text("institution").notNull(),
  product: text("product").notNull(),
  reportDate: date("report_date", { mode: "string" }).notNull(),
  national: boolean("national").notNull(),
  secured: boolean("secured").notNull(),
  annualFee: money("annual_fee"),
  purchaseAprMin: numeric("purchase_apr_min", { precision: 6, scale: 2 }),
  purchaseAprMedian: numeric("purchase_apr_median", { precision: 6, scale: 2 }),
  purchaseAprMax: numeric("purchase_apr_max", { precision: 6, scale: 2 }),
  introApr: boolean("intro_apr").notNull(),
  foreignTransactionFee: numeric("foreign_transaction_fee", { precision: 5, scale: 2 }),
  rewards: text("rewards"),
  creditTiers: text("credit_tiers"),
  website: text("website"),
  sourceUrl: text("source_url").notNull(),
});

/** Each attempt to fetch a public data source: which file, how many rows, or why it failed. */
export const factImport = pgTable(
  "fact_import",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** sec_funds, cfpb_cards or treasury */
    source: text("source").notNull(),
    /** The file imported, when the source comes as files. */
    file: text("file"),
    ok: boolean("ok").notNull(),
    rows: integer("rows").notNull().default(0),
    error: text("error"),
    at: tstz("at").notNull().defaultNow(),
  },
  (t) => [index("fact_import_source_idx").on(t.source, t.at)],
);

/**
 * An agent's check of a catalog product against the provider's own page: still right, changed
 * (with the new values and the sentence quoted from the page), or not found there. Product terms
 * are public market data, so every user's catalog uses every check; `user_id` records whose agent
 * made it, and row-level security only lets an agent record checks as its own user.
 */
export const factCheck = pgTable(
  "fact_check",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** deposit or card: which catalog the product is in. */
    kind: text("kind").notNull(),
    productId: text("product_id").notNull(),
    /** confirmed, changed or not_found */
    outcome: text("outcome").notNull(),
    /** For changed: the new value of each field, as decimal strings. */
    changes: jsonb("changes").notNull().default({}),
    sourceUrl: text("source_url").notNull(),
    /** The sentence on the page that states the values. */
    quote: text("quote").notNull(),
    /** The "rates as of" date the page prints, when it prints one. */
    ratesAsOf: date("rates_as_of", { mode: "string" }),
    checkedOn: date("checked_on", { mode: "string" }).notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUser.id, { onDelete: "cascade" }),
    at: tstz("at").notNull().defaultNow(),
  },
  (t) => [index("fact_check_product_idx").on(t.kind, t.productId, t.at)],
);
