import Big from "big.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { auditEvent, misallocation } from "../db/schema.js";
import type { AgentDb } from "../mcp/agentDb.js";
import { atInstitution } from "../products/catalog.js";
import {
  CARD_USAGE_METHOD,
  type Catalogs,
  type Detection,
  detectMisallocations,
  type Misallocation,
} from "./detect.js";

// The recommendation ledger: what each detector found, followed by key from first seen to acted
// on, with what acting on it gained. Owner side only (the serve loop and CLI), since agents can't
// write. Measuring outcomes is how Tidysum shows it works (decision 0002, principle 4).

type Row = typeof misallocation.$inferSelect;

const DAY_MS = 86_400_000;
/** Realized interest is measured once there is this much history after the switch. */
const MEASURE_AFTER_DAYS = 30;
const MEASURE_FOR_DAYS = 365;

/** A cost move worth an audit event: at least $5 and at least 10%. */
function changedEnough(before: string, after: string): boolean {
  const diff = new Big(after).minus(before).abs();
  return diff.gte(5) && diff.gte(new Big(before).times("0.1"));
}

type DepositInputs = {
  alternative?: { provider?: string; institutions?: string[] };
  current?: { annual_interest?: string };
};

/** Institution names that mean the user holds the suggested provider's account. */
function institutionsOf(inputs: DepositInputs): string[] {
  const alt = inputs.alternative;
  // Findings recorded before the catalog listed institutions only have the provider's name.
  return alt?.institutions ?? (alt?.provider ? [alt.provider.toLowerCase()] : []);
}

/** Whether a finding that went away did so because the user acted on it. */
export function actedOn(
  row: Pick<Row, "detector" | "inputs" | "accountIds" | "productId">,
  holdings: Detection["holdings"],
): boolean {
  switch (row.detector) {
    case "deposit_rate": {
      const wanted = institutionsOf(row.inputs as DepositInputs);
      return holdings.cash_institutions.some((i) => atInstitution(i, wanted));
    }
    case "card_wallet":
      return !!row.productId && holdings.card_ids.includes(row.productId);
    // The cost was observed in the user's own transactions and isn't any more, unless it was
    // found under rules since corrected: then it was never really there.
    case "card_usage":
      return (row.inputs as { method?: number } | null)?.method === CARD_USAGE_METHOD;
    // The contribution percent the finding asked to change has changed.
    case "retirement_rate": {
      const i = row.inputs as { current_percent?: string } | null;
      const now = row.accountIds[0] ? holdings.workplace_percents?.[row.accountIds[0]] : undefined;
      return !!now && !!i?.current_percent && !new Big(now).eq(i.current_percent);
    }
    // More is recorded as put into the year's IRAs than when it was found.
    case "roth_ira": {
      const i = row.inputs as { kind?: string; tax_year?: number; recorded_total?: string } | null;
      if (i?.kind === "convert") return true;
      const now = i?.tax_year ? holdings.ira_recorded?.[String(i.tax_year)] : undefined;
      return !!now && new Big(now).gt(i?.recorded_total ?? 0);
    }
    // The dear fund is gone from the plan account: it was swapped. Still held, the finding went
    // away for another reason (no faithful copy in the plan, say).
    case "fund_fee": {
      const fund = (row.inputs as { fund?: string } | null)?.fund;
      const held = row.accountIds[0] ? holdings.workplace_funds?.[row.accountIds[0]] : undefined;
      return !fund || !held?.includes(fund);
    }
    // The funds the finding said to sell are gone from the window: the money went back into the
    // plan. Still there, it went away for another reason (nothing the plan can copy, say).
    case "brokerage_window": {
      const i = row.inputs as { funds?: { ticker?: string | null }[] } | null;
      const held = row.accountIds[0]
        ? holdings.workplace_window_tickers?.[row.accountIds[0]]
        : undefined;
      const sell = (i?.funds ?? []).flatMap((x) => (x.ticker ? [x.ticker.toUpperCase()] : []));
      return !held || !sell.some((t) => held.includes(t));
    }
    case "foreign_fees":
    // The statement was paid, or the extra payment made.
    case "card_statement":
    case "extra_payment":
      return true;
    default:
      return false;
  }
}

/** Detectors that read all of the user's spending, so any out-of-date account can hide them. */
export const SPENDING_WIDE = new Set(["card_usage", "card_wallet"]);

/** Whether a finding's absence could just be missing data rather than a change. */
function mayBeMissingData(row: Row, stale: Set<string>): boolean {
  if (stale.size === 0) return false;
  return SPENDING_WIDE.has(row.detector) || row.accountIds.some((id) => stale.has(id));
}

function fields(m: Misallocation) {
  return {
    category: m.category,
    detector: m.detector,
    summary: m.summary,
    annualCost: m.annual_cost,
    accountIds: m.account_ids,
    productId: m.product_id,
    action: m.action,
    inputs: m.inputs,
  };
}

export interface RecordResult {
  found: number;
  changed: number;
  reopened: number;
  resolved: number;
  withdrawn: number;
}

/**
 * Brings the ledger in line with a detection: new findings open, ones that are still found get
 * their latest cost, and open ones that are no longer found close as resolved or withdrawn.
 * Findings whose detector didn't run (a missing catalog), or whose accounts' data is out of
 * date, are left as they are: their absence isn't evidence that anything changed.
 */
export async function recordMisallocations(
  db: Db,
  userId: string,
  detection: Detection,
  now = new Date(),
): Promise<RecordResult> {
  const result: RecordResult = { found: 0, changed: 0, reopened: 0, resolved: 0, withdrawn: 0 };
  await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(misallocation)
      .where(eq(misallocation.userId, userId))
      .for("update");
    const byKey = new Map(existing.map((r) => [r.key, r]));
    const audit = (event: string, row: { id: string; key: string }, data: object = {}) =>
      tx.insert(auditEvent).values({
        userId,
        at: now,
        actor: "tidysum",
        event: `misallocation.${event}`,
        data: { misallocation_id: row.id, key: row.key, ...data },
      });

    for (const m of detection.items) {
      const row = byKey.get(m.key);
      if (!row) {
        const [created] = await tx
          .insert(misallocation)
          .values({ userId, key: m.key, ...fields(m), firstSeenAt: now, lastSeenAt: now })
          .returning();
        if (!created) throw new Error("insert returned nothing");
        await audit("found", created, {
          category: m.category,
          annual_cost: m.annual_cost,
          inputs: m.inputs,
        });
        result.found++;
        continue;
      }
      const reopen = row.state === "resolved" || row.state === "withdrawn";
      await tx
        .update(misallocation)
        .set({
          ...fields(m),
          lastSeenAt: now,
          ...(reopen
            ? { state: "open", decidedAt: null, realizedAnnualValue: null, realizedBasis: null }
            : {}),
        })
        .where(eq(misallocation.id, row.id));
      if (reopen) {
        await audit("reopened", row, { was: row.state, annual_cost: m.annual_cost });
        result.reopened++;
      } else if (row.state === "open" && changedEnough(row.annualCost, m.annual_cost)) {
        await audit("changed", row, {
          previous_annual_cost: new Big(row.annualCost).toFixed(2),
          annual_cost: m.annual_cost,
          inputs: m.inputs,
        });
        result.changed++;
      }
    }

    const seen = new Set(detection.items.map((m) => m.key));
    const ran = new Set<string>(detection.ran);
    const stale = new Set(detection.stale_account_ids);
    const undecided = new Set(detection.holdings.undecided_keys ?? []);
    for (const row of existing) {
      if (seen.has(row.key) || !ran.has(row.detector) || undecided.has(row.key)) continue;
      if (mayBeMissingData(row, stale)) continue;
      if (row.state !== "open" && row.state !== "dismissed") continue;
      const resolved = actedOn(row, detection.holdings);
      // A fee that stopped is measured: the user no longer pays what they paid.
      const measured =
        resolved && (row.detector === "foreign_fees" || row.detector === "card_usage");
      const realized = measured
        ? {
            realizedAnnualValue: row.annualCost,
            realizedBasis: "The cost was observed in your transactions and has stopped.",
          }
        : {};
      await tx
        .update(misallocation)
        .set({ state: resolved ? "resolved" : "withdrawn", decidedAt: now, ...realized })
        .where(eq(misallocation.id, row.id));
      await audit(resolved ? "resolved" : "withdrawn", row, {
        was: row.state,
        annual_cost: new Big(row.annualCost).toFixed(2),
        ...(measured ? { realized_annual_value: new Big(row.annualCost).toFixed(2) } : {}),
      });
      if (resolved) result.resolved++;
      else result.withdrawn++;
    }

    await measureDeposits(tx, userId, now);
  });
  return result;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * For each resolved deposit finding, the interest the new provider has actually paid since the
 * switch, annualized, minus what the old account was earning. It counts every account the user
 * has at that provider, so money that was already there or came from elsewhere counts too.
 */
async function measureDeposits(tx: Tx, userId: string, now: Date) {
  const rows = await tx
    .select()
    .from(misallocation)
    .where(
      and(
        eq(misallocation.userId, userId),
        eq(misallocation.detector, "deposit_rate"),
        eq(misallocation.state, "resolved"),
      ),
    );
  for (const row of rows) {
    if (!row.decidedAt) continue;
    const days = Math.floor((now.getTime() - row.decidedAt.getTime()) / DAY_MS);
    if (days < MEASURE_AFTER_DAYS || days > MEASURE_FOR_DAYS) continue;
    const inputs = row.inputs as DepositInputs;
    const institutions = institutionsOf(inputs);
    if (institutions.length === 0) continue;
    const since = row.decidedAt.toISOString().slice(0, 10);
    const result = await tx.execute<{ interest: string; accounts: number }>(sql`
      select coalesce(-sum(t.amount), 0)::text as interest, count(distinct a.id)::int as accounts
      from transaction t
      join account a on a.id = t.account_id
      join item i on i.id = a.item_id
      where t.user_id = ${userId} and a.type = 'depository'
        and t.category_detailed = 'INCOME_INTEREST_EARNED'
        and t.removed_at is null and not t.pending and t.date > ${since}::date
        and exists (
          select from jsonb_array_elements_text(${JSON.stringify(institutions)}::jsonb) f(name)
          where strpos(lower(i.institution_name), f.name) > 0
        )`);
    const interest = new Big(result.rows[0]?.interest ?? 0);
    const annual = interest.times(365).div(days);
    const before = new Big(inputs.current?.annual_interest ?? 0);
    await tx
      .update(misallocation)
      .set({
        realizedAnnualValue: annual.minus(before).toFixed(2),
        realizedBasis:
          `${interest.toFixed(2)} interest at ${inputs.alternative?.provider} over ${days} days ` +
          `since switching, annualized to ${annual.toFixed(2)}, minus the ${before.toFixed(2)} ` +
          "a year the old account earned.",
      })
      .where(eq(misallocation.id, row.id));
  }
}

/** The user dismisses a finding ("not for me") or takes the dismissal back. */
export async function setMisallocationState(
  db: Db,
  userId: string,
  id: string,
  state: "dismissed" | "open",
  actor: string,
  now = new Date(),
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(misallocation)
      .set({ state, decidedAt: state === "dismissed" ? now : null })
      .where(
        and(
          eq(misallocation.id, id),
          eq(misallocation.userId, userId),
          inArray(misallocation.state, [state === "dismissed" ? "open" : "dismissed"]),
        ),
      )
      .returning({ id: misallocation.id, key: misallocation.key });
    const [row] = updated;
    if (!row) return false;
    await tx.insert(auditEvent).values({
      userId,
      at: now,
      actor,
      event: state === "dismissed" ? "misallocation.dismissed" : "misallocation.undismissed",
      data: { misallocation_id: row.id, key: row.key },
    });
    return true;
  });
}

/** The ledger, newest first, with totals: what is open, and what acting on findings gained. */
export async function listMisallocations(
  db: AgentDb,
  opts: { state?: string | undefined; limit: number },
) {
  const { rows } = await db.query(
    `select id, key, category, detector, summary, annual_cost::numeric(19,2)::text as annual_cost,
       account_ids, product_id, action, state, first_seen_at, last_seen_at, decided_at,
       realized_annual_value::numeric(19,2)::text as realized_annual_value, realized_basis, inputs
     from misallocation
     where $1::text is null or state = $1
     order by last_seen_at desc, annual_cost desc
     limit $2`,
    [opts.state ?? null, opts.limit],
  );
  const { rows: totals } = await db.query<{
    open_annual_cost: string;
    resolved: number;
    resolved_annual_cost: string;
    realized_annual_value: string;
  }>(
    `select coalesce(sum(annual_cost) filter (where state = 'open'), 0)::numeric(19,2)::text
         as open_annual_cost,
       count(*) filter (where state = 'resolved')::int as resolved,
       coalesce(sum(annual_cost) filter (where state = 'resolved'), 0)::numeric(19,2)::text
         as resolved_annual_cost,
       coalesce(sum(realized_annual_value) filter (where state = 'resolved'), 0)::numeric(19,2)::text
         as realized_annual_value
     from misallocation`,
  );
  return { totals: totals[0], misallocations: rows };
}

/** Runs every detector for the user and records the result. */
export async function refreshMisallocations(
  db: Db,
  agentDb: AgentDb,
  userId: string,
  catalogs: Catalogs,
  today: string,
  now = new Date(),
): Promise<RecordResult> {
  return recordMisallocations(
    db,
    userId,
    await detectMisallocations(agentDb, catalogs, today),
    now,
  );
}
