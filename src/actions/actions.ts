import { randomUUID } from "node:crypto";
import Big from "big.js";
import { and, desc, eq, gt, gte, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  type ActionStep,
  account,
  actionOrder,
  auditEvent,
  misallocation,
  policyVersion,
  proposal,
} from "../db/schema.js";
import { type Calm, readCalm } from "../market/calm.js";
import type { AgentDb } from "../mcp/agentDb.js";
import { canonical } from "../policy/policy.js";
import type { AllocationResult } from "../portfolio/allocation.js";
import { productLabel } from "../products/compare.js";
import { formatMoney } from "../region.js";
import { addToIraYear, type RothIraInputs, recordedBy } from "../retirement/ira.js";
import {
  describeSplit,
  paycheckMirror,
  planFundsFor,
  type StoredPlan,
} from "../retirement/workplace.js";
import { type ActionProgress, AGENT_EVENTS, type ProgressEvent, progressFrom } from "./progress.js";

// The Actions queue (decision 0005). Every open finding gets an action Tidysum drafts for it,
// with the steps that fix it; an agent's own proposal for the same finding replaces the draft.
// The owner decides one action at a time: approve, not now, or don't suggest again. Approved
// actions are carried out by the owner or by their own agent over MCP (agentRun.ts), marked done,
// and confirmed when a later sync shows the finding went away because it was acted on. Nothing
// here moves money.

/** Source of the actions Tidysum drafts itself, as opposed to `mcp:<client>` for agents. */
export const TIDYSUM_SOURCE = "tidysum";

/** States in which an action is still in play for its finding. */
const LIVE = ["proposed", "blocked", "approved", "done"] as const;

/** How long "Not now" keeps an action out of the queue. */
export const SNOOZE_DAYS = 7;

/** Done and confirmed actions stay on the page this long. */
const FINISHED_DAYS = 90;

type Finding = typeof misallocation.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Today as YYYY-MM-DD, the way the rest of Tidysum dates a day. */
export const isoToday = () => new Date().toISOString().slice(0, 10);

/** "$1,234" from a decimal string, for step text; "£1,234" for an amount in pounds. */
export function dollars(s: string | number | null | undefined, currency = "USD"): string {
  return formatMoney(s, currency);
}

interface DepositInputs {
  balance?: string;
  chosen_by_owner?: boolean;
  alternative?: { provider?: string; name?: string; requires?: string | null };
}

interface CardUsageInputs {
  payees?: { payee: string }[];
}

interface RetirementRateInputs {
  plan_name?: string;
  kind?: "raise" | "lower";
  year?: number;
  this_year?: boolean;
  new_percent?: string;
  bonus_too?: boolean;
  bonus_percent?: string;
  roth_to_pretax?: boolean;
  prefer?: "pretax" | "roth";
}

interface FundFeeInputs {
  plan_name?: string;
  fund?: string;
  into?: { fund: string; percent: number }[];
  paychecks_too?: boolean;
}

interface BrokerageWindowInputs {
  plan_name?: string;
  window_fund?: string;
  window_account?: { name?: string; institution?: string | null };
  funds?: { name: string }[];
  /** Funds the plan can't copy, which stay in the window (decision 0007). */
  stays?: { name: string }[];
  into?: { fund: string; percent: number }[];
  paychecks_too?: boolean;
  /** The owner's paychecks copy this plan fund instead of following the new-money card. */
  paychecks_mirror?: { fund: string; into: { fund: string; percent: number }[] } | null;
  /** The plan fund whose copy the window's money goes into, by the owner's choice. */
  matches?: string | null;
}

interface HoldingFeeInputs {
  account?: { name?: string };
  ticker?: string;
  alternative?: { ticker?: string };
  mutual_fund?: boolean;
}

interface BrokerageCashInputs {
  account?: { name?: string };
  alternative?: { ticker?: string };
  invest_toward_mix?: boolean;
}

/** Findings whose action is the new-money action rather than one drafted for them. */
const NEW_MONEY_FINDINGS = new Set(["allocation_drift"]);

/**
 * The steps that fix a finding, in order, and who does each once the owner's agent can carry
 * them out (decision 0005): it stops for whatever only the owner can do, named in `needs_you`.
 */
export function stepsFor(f: Finding, accountName: (id: string) => string | null): ActionStep[] {
  const from = f.accountIds[0] ? accountName(f.accountIds[0]) : null;
  switch (f.detector) {
    case "deposit_rate": {
      const i = f.inputs as DepositInputs;
      const label = productLabel(
        i.alternative?.provider ?? "the better-paying bank",
        i.alternative?.name,
      );
      const product = /account$/i.test(label) ? label : `${label} account`;
      const old = from ?? "your old account";
      // The owner picked a bank whose rate needs their paycheck there: the paycheck moves, and
      // the bills with it. Tidysum's own suggestion doesn't assume that.
      const paycheck = !!i.chosen_by_owner && /direct deposit/i.test(i.alternative?.requires ?? "");
      return [
        {
          text: `Open a ${product}`,
          by: "agent",
          needs_you: "Identity check and signature",
        },
        { text: "Link the new account in Connections", by: "you" },
        ...(paycheck
          ? [
              {
                text: "Send your paycheck's direct deposit to it",
                by: "agent",
                needs_you: "Payroll sign-in",
              } satisfies ActionStep,
              {
                text: `Move the bills and autopays paid from ${old} to it, or leave enough in ${old} to cover them`,
                by: "agent",
                needs_you: "Sign-ins",
              } satisfies ActionStep,
            ]
          : []),
        {
          text: `Move about ${dollars(i.balance)}${from ? ` from ${from}` : ""} into it`,
          by: "agent",
          needs_you: "Two-factor code",
        },
      ];
    }
    case "card_usage": {
      const payees = (f.inputs as CardUsageInputs).payees ?? [];
      return [
        ...payees.map(
          (p): ActionStep => ({
            text: `Switch ${p.payee} to your best card`,
            by: "agent",
            needs_you: "Two-factor code",
          }),
        ),
        {
          text: "Turn on full-statement autopay for that card",
          by: "agent",
          needs_you: "Two-factor code",
        },
      ];
    }
    case "card_wallet": {
      const name = (f.inputs as { card_name?: string }).card_name ?? "the card";
      return [
        {
          text: `Apply for the ${name}`,
          by: "agent",
          needs_you: "Credit check consent and signature",
        },
        { text: "Link it in Connections when it arrives", by: "you" },
        { text: "Use it where it earns the most (the Cards page says where)", by: "you" },
      ];
    }
    case "foreign_fees":
      return [
        {
          text: "Use a card with no foreign transaction fee abroad and on sites that charge in other currencies",
          by: "you",
        },
      ];
    case "card_statement":
      return [
        {
          text: `Pay ${from ?? "the card's"} statement in full`,
          by: "agent",
          needs_you: "Two-factor code",
        },
        { text: "Turn on full-statement autopay", by: "agent", needs_you: "Two-factor code" },
      ];
    case "extra_payment":
      return [{ text: f.action, by: "agent", needs_you: "Two-factor code" }];
    case "retirement_rate": {
      const i = f.inputs as RetirementRateInputs;
      const plan = i.plan_name ?? "your 401(k)";
      const kind = i.prefer === "roth" ? "Roth" : "pre-tax";
      const pay = i.bonus_too ? "base and bonus pay" : "base pay";
      const when = i.this_year
        ? `for the rest of ${i.year}`
        : `starting with the first ${i.year} paycheck`;
      const of = i.bonus_percent
        ? `${i.new_percent}% of base pay and ${i.bonus_percent}% of bonus pay`
        : `${i.new_percent}% of ${pay}`;
      const steps: ActionStep[] = [
        {
          text: `In ${plan}, set ${kind} contributions to ${of} ${when}`,
          by: "agent",
          needs_you: "Sign-in",
        },
      ];
      if (i.roth_to_pretax) {
        steps.push({
          text: "Make every contribution pre-tax: set Roth to 0% and add it to pre-tax",
          by: "agent",
          needs_you: "Sign-in",
        });
      }
      if (i.kind === "raise" && i.this_year) {
        steps.push({
          text: "Check that checking stays above your cash buffer with the smaller paychecks",
          by: "agent",
        });
      }
      return steps;
    }
    case "fund_fee": {
      const i = f.inputs as FundFeeInputs;
      const plan = i.plan_name ?? "your 401(k)";
      const into = describeSplit(i.into ?? []);
      return [
        {
          text: `In ${plan}, exchange all of ${i.fund ?? "the fund"} into ${into}`,
          by: "agent",
          needs_you: "Sign-in",
        },
        ...(i.paychecks_too
          ? [
              {
                text: `Stop sending paychecks to ${i.fund ?? "the fund"}: put its share in the same funds`,
                by: "agent",
                needs_you: "Sign-in",
              } satisfies ActionStep,
            ]
          : []),
      ];
    }
    case "brokerage_window": {
      const i = f.inputs as BrokerageWindowInputs;
      const plan = i.plan_name ?? "your 401(k)";
      const at = i.window_account?.institution ? ` at ${i.window_account.institution}` : "";
      const where = `${i.window_account?.name ?? "the brokerage window"}${at}`;
      const funds = (i.funds ?? []).map((x) => x.name).join(" and ");
      const stays = (i.stays ?? []).map((x) => x.name).join(" and ");
      const steps: ActionStep[] = [
        {
          text: stays
            ? `In ${where}, ${plan}'s brokerage window, sell ${funds || "the funds the plan can copy"} and keep ${stays}`
            : `In ${where}, ${plan}'s brokerage window, sell everything${funds ? ` (${funds})` : ""}`,
          by: "agent",
          needs_you: "Sign-in",
        },
        {
          text: `Once the sale settles, move ${stays ? "that" : "all the"} cash back into ${plan} and put it into ${describeSplit(i.into ?? [])}${i.matches ? `, a copy of ${i.matches}` : ""}`,
          by: "agent",
          needs_you: "Sign-in",
        },
      ];
      if (i.paychecks_too) {
        steps.push({
          text: i.paychecks_mirror
            ? `Stop sending paychecks to ${i.window_fund ?? "the brokerage window"}: invest each whole paycheck ${describeSplit(i.paychecks_mirror.into)}, a copy of ${i.paychecks_mirror.fund}`
            : `Stop sending paychecks to ${i.window_fund ?? "the brokerage window"}: give its share to the funds on the new-money card`,
          by: "agent",
          needs_you: "Sign-in",
        });
      }
      steps.push({
        text: stays
          ? `Check that only ${stays} is left in ${where} and ${plan} holds the rest`
          : `Check that ${where} is empty and ${plan} holds the money`,
        by: "agent",
      });
      return steps;
    }
    case "roth_ira":
      return rothIraSteps(f.inputs as Partial<RothIraInputs>);
    case "holding_fee": {
      const i = f.inputs as HoldingFeeInputs;
      const acct = i.account?.name ?? from ?? "the account";
      const alt = i.alternative?.ticker ?? "the cheaper fund";
      return [
        {
          text: `In ${acct}, sell all of ${i.ticker ?? "the fund"}`,
          by: "agent",
          needs_you: SUBMIT,
        },
        {
          text: i.mutual_fund
            ? `Once the sale settles, buy ${alt} with all of the money`
            : `Buy ${alt} with all of the money, the same day`,
          by: "agent",
          needs_you: SUBMIT,
        },
        {
          text: `From now on, buy ${alt} wherever you'd have bought ${i.ticker ?? "the old fund"}`,
          by: "you",
        },
      ];
    }
    case "brokerage_cash": {
      const i = f.inputs as BrokerageCashInputs;
      const acct = i.account?.name ?? from ?? "the brokerage account";
      const alt = i.alternative?.ticker ?? "a Treasury bill fund";
      return [
        {
          text: i.invest_toward_mix
            ? `In ${acct}, invest the uninvested cash the way the new-money action splits each paycheck, and buy ${alt} with any part you want to keep as cash`
            : `In ${acct}, buy ${alt} with the uninvested cash you don't need to keep as cash`,
          by: "agent",
          needs_you: SUBMIT,
        },
      ];
    }
    default:
      return [{ text: f.action, by: "you" }];
  }
}

/** A Roth IRA contribution, straight in or through a traditional IRA (a backdoor Roth). */
export function rothIraSteps(i: Partial<RothIraInputs>): ActionStep[] {
  const year = i.tax_year ?? "the year";
  const amount = dollars(i.amount);
  const roth = i.roth_account?.name ?? "the Roth IRA";
  const traditional = i.traditional_account?.name ?? "the traditional IRA";
  const from = i.from_account
    ? ` from ${i.from_account.name}`
    : i.match?.bank_funded_only
      ? " from your bank account"
      : "";
  const at = i.roth_account?.institution ? ` at ${i.roth_account.institution}` : "";
  const backdoor = i.route !== "direct";
  const steps: ActionStep[] = [];
  if (!i.roth_account) {
    steps.push({ text: "Open a Roth IRA", by: "agent", needs_you: "Identity check and signature" });
  }
  if (backdoor && !i.traditional_account) {
    steps.push({
      text: `Open a traditional IRA${at}`,
      by: "agent",
      needs_you: "Identity check and signature",
    });
  }
  const match = i.kind === "convert" ? null : i.match;
  const matchPct = match ? `${new Big(match.rate).times(100).toFixed()}%` : "";
  if (match?.membership && !match.membership_held) {
    const fee = match.membership_annual_fee
      ? ` (${dollars(match.membership_annual_fee)} a year)`
      : match.membership_monthly_fee
        ? ` (${dollars(match.membership_monthly_fee)} a month)`
        : "";
    steps.push({
      text: `Turn on ${match.membership}${fee} if it isn't on, and keep it at least ${match.membership_keep_months ?? 12} months, so the contribution earns the ${matchPct} match`,
      by: "agent",
      needs_you: "Confirm the subscription",
    });
  }
  if (i.rollover_into && i.pretax_accounts?.length) {
    const names = i.pretax_accounts.map((a) => a.name).join(" and ");
    steps.push({
      text: `Move the pre-tax money in ${names} (about ${dollars(i.pretax_ira_balance)}) into ${i.rollover_into} first, so the conversion isn't taxed`,
      by: "agent",
      needs_you: "Sign-ins and signature",
    });
  }
  if (i.kind === "convert") {
    steps.push({
      text: `Convert all ${amount} in ${traditional} to ${roth}`,
      by: "agent",
      needs_you: "Two-factor code",
    });
  } else {
    if (!i.recorded && (i.roth_account || i.traditional_account)) {
      steps.push({
        text: `Check what's already been put in for ${year}, and lower the amount to match`,
        by: "agent",
        needs_you: "Sign-in",
      });
    }
    steps.push({
      text: backdoor
        ? `Contribute ${amount} to ${traditional} for ${year}${from}, keeping checking above your cash buffer`
        : `Contribute ${amount} to ${roth} for ${year}${from}, keeping checking above your cash buffer`,
      by: "agent",
      needs_you: "Two-factor code",
    });
    if (backdoor) {
      steps.push({
        text: match
          ? `Once ${match.provider}'s ${matchPct} match (about ${dollars(match.amount)}) arrives, usually within ${match.credited_within_days} days, convert everything in ${traditional} to ${roth}`
          : `Once it settles, convert all of it to ${roth}`,
        by: "agent",
        needs_you: "Two-factor code",
      });
    }
  }
  if (backdoor) {
    const yearEnd = i.year_end ? `December 31, ${i.year_end.slice(0, 4)}` : "December 31";
    steps.push({
      text: `Check that no traditional, SEP or SIMPLE IRA will hold pre-tax money on ${yearEnd}`,
      by: "agent",
    });
    steps.push({
      text: match
        ? "Report it on Form 8606 with your taxes; the converted match counts as taxable income (tax software asks about a backdoor Roth)"
        : "Report it on Form 8606 with your taxes (tax software asks about a backdoor Roth)",
      by: "you",
    });
  }
  return steps;
}

export interface DraftResult {
  drafted: number;
  updated: number;
  superseded: number;
  confirmed: number;
  withdrawn: number;
}

const sameValue = (a: string | null, b: string | null) =>
  a === null || b === null ? a === b : new Big(a).eq(b);

/** The finding_key of the investing action, which fixes allocation drift rather than a finding. */
export const NEW_MONEY_KEY = "new_money";

/** The owner's part of a buy or sell: the agent fills in the order, the owner places it. */
export const SUBMIT = "Review the order and press Submit";
const NEW_MONEY_QUIET_DAYS = 30;

// Bucket labels can hold "and" themselves ("bonds and cash"), so several are joined with "+".
const joinWords = (words: string[]) => words.join(" + ");

/**
 * Where new money should go while some buckets are under target, as an action: percentages and
 * the fund to buy, never amounts, gains or selling (the owner asked for calm, hands-off investing).
 * Null when there is nothing to steer: investing is off, or the mix is on target.
 */
export function newMoneyDraft(allocation: AllocationResult, workplace: StoredPlan[] = []) {
  if (allocation.state !== "ready") return null;
  const m = allocation.new_money;
  if (m.basis !== "catch_up" || m.split.length === 0) return null;
  const label = (key: string) =>
    // "International stocks" reads as "international stocks" mid-sentence; "US stocks" stays.
    (allocation.buckets.find((b) => b.key === key)?.label ?? key).replace(/^[A-Z](?![A-Z])/, (c) =>
      c.toLowerCase(),
    );
  const names = m.split.map((r) => label(r.bucket));
  const steps: ActionStep[] = m.split.map((r) => ({
    text:
      m.split.length === 1
        ? `Put the money you invest from each paycheck into ${label(r.bucket)}${r.buy ? ` (${r.buy.ticker})` : ""}`
        : `Put ${r.percent}% of what you invest from each paycheck into ${label(r.bucket)}${r.buy ? ` (${r.buy.ticker})` : ""}`,
    by: "agent",
    needs_you: SUBMIT,
  }));
  // A workplace plan invests each paycheck by its own election, in its own funds: the same split,
  // in the plan's cheapest fund for each bucket (buckets it has no fund for are left out, and
  // the policy's cap on one bucket's share still holds once they are).
  for (const { facts } of workplace) {
    // The owner chose to have this plan's paychecks match one of its funds: they copy it, and the
    // target mix is steered with other money.
    const mirror = paycheckMirror(facts);
    if (mirror) {
      if (!("into" in mirror)) continue;
      const now = new Map(facts.paycheck_investments.map((p) => [p.fund, String(p.percent)]));
      const matches =
        mirror.into.length === now.size &&
        mirror.into.every(
          (p) => now.get(p.fund) !== undefined && new Big(now.get(p.fund) ?? 0).eq(p.percent),
        );
      if (!matches) {
        steps.push({
          text: `In ${facts.plan_name}, invest each paycheck ${describeSplit(mirror.into)}, a copy of ${mirror.fund}`,
          by: "agent",
          needs_you: "Sign-in",
        });
      }
      continue;
    }
    const split = planFundsFor(
      facts.lineup,
      m.split.map((r) => {
        const bucket = allocation.buckets.find((b) => b.key === r.bucket);
        return {
          classes: bucket?.classes ?? [r.bucket],
          share: new Big(r.percent),
          target: bucket ? new Big(bucket.target) : undefined,
        };
      }),
      1,
      m.max_share ? new Big(m.max_share) : undefined,
    );
    const current = new Map(facts.paycheck_investments.map((p) => [p.fund, String(p.percent)]));
    const same =
      split &&
      split.length === current.size &&
      split.every(
        (p) => current.get(p.fund) !== undefined && new Big(current.get(p.fund) ?? 0).eq(p.percent),
      );
    if (split && !same) {
      steps.push({
        text: `In ${facts.plan_name}, invest each paycheck ${describeSplit(split)}`,
        by: "agent",
        needs_you: "Sign-in",
      });
    }
  }
  steps.push({ text: "Leave everything you already hold as it is", by: "you" });
  return {
    title: "Invest new money toward your target mix",
    rationale: `Each paycheck you invest goes to ${joinWords(names)}, so your mix drifts back to its target with no selling.`,
    category: "securities" as const,
    expectedAnnualValue: null,
    steps,
  };
}

/**
 * When a finding's fix can be done (decision 0006): a detector that knows, like next year's
 * 401(k) percent, which must wait for this year's last payday, says so in `inputs.window`.
 */
export function windowOf(f: Pick<Finding, "inputs">): {
  notBefore: string | null;
  dueBy: string | null;
  waitFor: "calm_markets" | null;
} {
  const i = f.inputs as {
    window?: { not_before?: unknown; due_by?: unknown };
    wait_for?: unknown;
  } | null;
  const w = i?.window;
  const day = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  return {
    notBefore: day(w?.not_before),
    dueBy: day(w?.due_by),
    // A sale that leaves money out of the market for days waits for calm markets (decision 0008).
    waitFor: i?.wait_for === "calm_markets" ? "calm_markets" : null,
  };
}

// jsonb doesn't keep key order, so compare canonical forms.
const sameJson = (a: unknown, b: unknown) => canonical(a ?? null) === canonical(b ?? null);

/**
 * Brings the actions in line with the finding ledger, after each detection: an open finding with
 * no action gets a draft; a draft not yet decided follows its finding's latest numbers; a draft
 * gives way to an agent's proposal for the same finding; a finding resolved because it was acted
 * on confirms its actions; one that went away for another reason, or was dismissed, withdraws
 * the actions still waiting. Needs an active policy, which every proposal records.
 */
export async function draftActions(
  db: Db,
  userId: string,
  now = new Date(),
  /** The allocation, when the caller read it: drives the new-money action (investing only). */
  allocation?: AllocationResult,
  /** Recorded workplace plans: the new-money action also sets how their paychecks are invested. */
  workplace: StoredPlan[] = [],
): Promise<DraftResult> {
  const result: DraftResult = { drafted: 0, updated: 0, superseded: 0, confirmed: 0, withdrawn: 0 };
  await db.transaction(async (tx) => {
    const [policy] = await tx
      .select({ id: policyVersion.id })
      .from(policyVersion)
      .where(eq(policyVersion.userId, userId))
      .orderBy(desc(policyVersion.activatedAt))
      .limit(1);
    const findings = await tx
      .select()
      .from(misallocation)
      .where(eq(misallocation.userId, userId))
      .for("update");
    const proposals = await tx
      .select({
        id: proposal.id,
        state: proposal.state,
        source: proposal.source,
        findingKey: proposal.findingKey,
        title: proposal.title,
        rationale: proposal.rationale,
        category: proposal.category,
        expectedAnnualValue: proposal.expectedAnnualValue,
        steps: proposal.steps,
        notBefore: proposal.notBefore,
        dueBy: proposal.dueBy,
        waitFor: proposal.waitFor,
      })
      .from(proposal)
      .where(and(eq(proposal.userId, userId), isNotNull(proposal.findingKey)))
      .for("update");
    await markAgentFinished(tx, userId, now, proposals);
    const accounts = await tx
      .select({ id: account.id, name: account.name, officialName: account.officialName })
      .from(account)
      .where(eq(account.userId, userId));
    const names = new Map(accounts.map((a) => [a.id, a.name || a.officialName || null]));
    const accountName = (id: string) => names.get(id) ?? null;

    const audit = (event: string, proposalId: string, data: object) =>
      tx.insert(auditEvent).values({
        userId,
        at: now,
        actor: TIDYSUM_SOURCE,
        event: `proposal.${event}`,
        proposalId,
        data,
      });
    const close = async (
      ids: string[],
      state: "confirmed" | "dismissed",
      event: string,
      data: object,
    ) => {
      for (const id of ids) {
        await tx
          .update(proposal)
          .set({ state, decidedAt: now })
          .where(and(eq(proposal.id, id), eq(proposal.userId, userId)));
        await audit(event, id, data);
      }
    };

    for (const f of findings) {
      // A mix off its target is fixed by the new-money action below, which carries its price.
      if (NEW_MONEY_FINDINGS.has(f.detector)) continue;
      const mine = proposals.filter((p) => p.findingKey === f.key);
      const live = mine.filter((p) => (LIVE as readonly string[]).includes(p.state));
      const ref = { misallocation_id: f.id, finding_key: f.key };

      if (f.state === "resolved") {
        const done = live.filter((p) => p.state !== "blocked").map((p) => p.id);
        await close(done, "confirmed", "confirmed", {
          ...ref,
          expected_annual_value: new Big(f.annualCost).toFixed(2),
          realized_annual_value: f.realizedAnnualValue
            ? new Big(f.realizedAnnualValue).toFixed(2)
            : null,
        });
        result.confirmed += done.length;
        continue;
      }
      if (f.state !== "open") {
        // Withdrawn by the data, or dismissed by the owner: what still waits for a decision goes.
        const waiting = live
          .filter((p) => p.state === "proposed" || p.state === "blocked")
          .map((p) => p.id);
        await close(waiting, "dismissed", "withdrawn", { ...ref, finding_state: f.state });
        result.withdrawn += waiting.length;
        continue;
      }

      const theirs = live.filter((p) => p.source !== TIDYSUM_SOURCE);
      const ours = live.filter((p) => p.source === TIDYSUM_SOURCE);
      if (theirs.length > 0) {
        // An agent's concrete plan replaces the generic one, unless the owner already said yes.
        const replaced = ours.filter((p) => p.state === "proposed").map((p) => p.id);
        await close(replaced, "dismissed", "superseded", {
          ...ref,
          by: theirs.map((p) => p.id),
        });
        result.superseded += replaced.length;
        continue;
      }

      const draft = {
        title: f.action,
        rationale: f.summary,
        category: f.category,
        expectedAnnualValue: new Big(f.annualCost).toFixed(2),
        steps: stepsFor(f, accountName),
        ...windowOf(f),
      };
      if (ours.length === 0) {
        if (!policy) continue;
        const [created] = await tx
          .insert(proposal)
          .values({
            id: randomUUID(),
            userId,
            policyVersionId: policy.id,
            source: TIDYSUM_SOURCE,
            state: "proposed",
            findingKey: f.key,
            validation: { violations: [], warnings: [], numbers: {} },
            createdAt: now,
            ...draft,
          })
          .returning({ id: proposal.id });
        if (!created) throw new Error("insert returned nothing");
        await audit("created", created.id, {
          state: "proposed",
          policy_version: policy.id,
          ...ref,
          ...draft,
          evidence: { finding_inputs: f.inputs },
        });
        result.drafted++;
        continue;
      }
      for (const p of ours.filter((x) => x.state === "proposed")) {
        const unchanged =
          p.title === draft.title &&
          p.rationale === draft.rationale &&
          p.category === draft.category &&
          sameValue(p.expectedAnnualValue, draft.expectedAnnualValue) &&
          sameJson(p.steps, draft.steps) &&
          p.notBefore === draft.notBefore &&
          p.dueBy === draft.dueBy &&
          p.waitFor === draft.waitFor;
        if (unchanged) continue;
        await tx.update(proposal).set(draft).where(eq(proposal.id, p.id));
        result.updated++;
      }
    }

    if (!allocation) return;
    // Investing (decision 0005): one action says where new money goes while the mix is under
    // target. It never suggests selling. While the mix is outside its band, the allocation_drift
    // finding prices the drift and the action carries that yearly value.
    const live = proposals.filter(
      (p) => p.findingKey === NEW_MONEY_KEY && (LIVE as readonly string[]).includes(p.state),
    );
    const ref = { finding_key: NEW_MONEY_KEY };
    const drafted = newMoneyDraft(allocation, workplace);
    // What the drift costs (allocation_drift), when the mix is outside its band: the value of
    // steering new money back to the target.
    const drift = findings.find((f) => NEW_MONEY_FINDINGS.has(f.detector) && f.state === "open");
    const draft = drafted && {
      ...drafted,
      expectedAnnualValue: drift ? new Big(drift.annualCost).toFixed(2) : null,
    };
    if (!draft) {
      if (allocation.state === "ready") {
        // The mix reached its target: what the owner approved worked.
        const done = live.filter((p) => p.state === "approved" || p.state === "done");
        await close(
          done.map((p) => p.id),
          "confirmed",
          "confirmed",
          { ...ref, basis: allocation.new_money.basis },
        );
        result.confirmed += done.length;
      }
      const waiting = live.filter((p) => p.state === "proposed" || p.state === "blocked");
      await close(
        waiting.map((p) => p.id),
        "dismissed",
        "withdrawn",
        { ...ref, allocation_state: allocation.state },
      );
      result.withdrawn += waiting.length;
      return;
    }
    if (live.length === 0) {
      if (!policy) return;
      // "Don't suggest again" holds for a month; the mix moves slowly.
      const dismissed = proposals
        .filter((p) => p.findingKey === NEW_MONEY_KEY && p.state === "dismissed")
        .map((p) => p.id);
      if (dismissed.length) {
        const since = new Date(now.getTime() - NEW_MONEY_QUIET_DAYS * 86_400_000);
        const [owner] = await tx
          .select({ id: auditEvent.id })
          .from(auditEvent)
          .where(
            and(
              inArray(auditEvent.proposalId, dismissed),
              eq(auditEvent.event, "proposal.dismissed"),
              gte(auditEvent.at, since),
            ),
          )
          .limit(1);
        if (owner) return;
      }
      const [created] = await tx
        .insert(proposal)
        .values({
          id: randomUUID(),
          userId,
          policyVersionId: policy.id,
          source: TIDYSUM_SOURCE,
          state: "proposed",
          findingKey: NEW_MONEY_KEY,
          validation: { violations: [], warnings: [], numbers: {} },
          createdAt: now,
          ...draft,
        })
        .returning({ id: proposal.id });
      if (!created) throw new Error("insert returned nothing");
      await audit("created", created.id, {
        state: "proposed",
        policy_version: policy.id,
        ...ref,
        ...draft,
        evidence: { new_money: allocation.state === "ready" ? allocation.new_money : null },
      });
      result.drafted++;
      return;
    }
    for (const p of live.filter((x) => x.state === "proposed" && x.source === TIDYSUM_SOURCE)) {
      if (
        p.title === draft.title &&
        p.rationale === draft.rationale &&
        sameJson(p.steps, draft.steps) &&
        sameValue(p.expectedAnnualValue, draft.expectedAnnualValue)
      )
        continue;
      await tx.update(proposal).set(draft).where(eq(proposal.id, p.id));
      result.updated++;
    }
    // An approved new-money action is a standing instruction to invest toward the target mix, not
    // a one-off trade: when the split changes (the policy changed, or the mix moved), it follows,
    // with the change in the audit log. Leaving it would keep buying what the owner since dropped.
    for (const p of live.filter((x) => x.state === "approved" && x.source === TIDYSUM_SOURCE)) {
      if (
        p.title === draft.title &&
        p.rationale === draft.rationale &&
        sameJson(p.steps, draft.steps)
      ) {
        // Only the price moved: keep it current without calling it a revision.
        if (!sameValue(p.expectedAnnualValue, draft.expectedAnnualValue)) {
          await tx
            .update(proposal)
            .set({ expectedAnnualValue: draft.expectedAnnualValue })
            .where(eq(proposal.id, p.id));
        }
        continue;
      }
      await tx
        .update(proposal)
        .set({ ...draft, ...(policy && { policyVersionId: policy.id }) })
        .where(eq(proposal.id, p.id));
      await audit("revised", p.id, {
        ...ref,
        why: "The new-money split changed; the approved action follows the target mix.",
        from_steps: p.steps,
        to_steps: draft.steps,
        evidence: { new_money: allocation.state === "ready" ? allocation.new_money : null },
      });
      result.updated++;
    }
  });
  return result;
}

/**
 * An approved action the owner's agent reported finished is done, as if the owner had said so:
 * the agent can only report (it has no write on proposals), so the owner side moves the state.
 */
async function markAgentFinished(
  tx: Tx,
  userId: string,
  now: Date,
  proposals: { id: string; state: string }[],
) {
  const approved = await tx
    .select({ id: proposal.id, findingKey: proposal.findingKey, followUpOf: proposal.followUpOf })
    .from(proposal)
    .where(and(eq(proposal.userId, userId), eq(proposal.state, "approved")));
  const ids = approved.map((p) => p.id);
  if (!ids.length) return;
  const events = await tx
    .select({
      id: auditEvent.id,
      proposalId: auditEvent.proposalId,
      at: auditEvent.at,
      actor: auditEvent.actor,
      event: auditEvent.event,
      data: auditEvent.data,
    })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.userId, userId),
        inArray(auditEvent.proposalId, ids),
        inArray(auditEvent.event, [...AGENT_EVENTS]),
      ),
    )
    .orderBy(auditEvent.id);
  for (const id of ids) {
    const progress = progressFrom(
      events
        .filter((e) => e.proposalId === id)
        .map((e) => ({
          at: e.at.toISOString(),
          actor: e.actor,
          event: e.event as ProgressEvent["event"],
          data: e.data as ProgressEvent["data"],
        })),
    );
    if (progress?.status !== "finished") continue;
    // Another pass may have got here first (the page settles on load, the loop after a sync).
    const moved = await tx
      .update(proposal)
      .set({ state: "done", decidedAt: now })
      .where(and(eq(proposal.id, id), eq(proposal.state, "approved")))
      .returning({ id: proposal.id });
    if (!moved.length) continue;
    await tx.insert(auditEvent).values({
      userId,
      at: now,
      actor: progress.agent,
      event: "proposal.done",
      proposalId: id,
      data: { by_agent: true, note: progress.note },
    });
    for (const p of proposals) if (p.id === id) p.state = "done";
    const row = approved.find((p) => p.id === id);
    await recordIraAction(tx, userId, id, row?.findingKey, now);
    if (row?.followUpOf) await confirmFollowed(tx, userId, row.followUpOf, id, progress.note, now);
  }
}

/**
 * A change no sync can see, like a 401(k) election, is confirmed by its follow-up check
 * (decision 0006): once the agent finishes the check, and fixes what it found, the action it
 * checked is confirmed.
 */
async function confirmFollowed(
  tx: Tx,
  userId: string,
  followed: string,
  by: string,
  note: string | null,
  now: Date,
) {
  const confirmed = await tx
    .update(proposal)
    .set({ state: "confirmed", decidedAt: now })
    .where(
      and(
        eq(proposal.id, followed),
        eq(proposal.userId, userId),
        inArray(proposal.state, ["approved", "done"]),
      ),
    )
    .returning({ id: proposal.id });
  if (!confirmed.length) return;
  await tx.insert(auditEvent).values({
    userId,
    at: now,
    actor: TIDYSUM_SOURCE,
    event: "proposal.confirmed",
    proposalId: followed,
    data: { by_follow_up: by, note },
  });
}

/**
 * Marks done what the owner's agent finished, at once rather than on the next sync: the agent
 * can only report, so the owner side moves the state. Cheap; the Actions page calls it on load.
 */
export async function settleFinished(db: Db, userId: string, now = new Date()): Promise<void> {
  await db.transaction(async (tx) => markAgentFinished(tx, userId, now, []));
}

/**
 * Plaid doesn't say which tax year an IRA contribution counts for, so a finished IRA action is
 * what records it: the next detection then sees the year's room used and confirms the action.
 */
async function recordIraAction(
  tx: Tx,
  userId: string,
  proposalId: string,
  key: string | null | undefined,
  now: Date,
) {
  if (!key?.startsWith("roth_ira:")) return;
  const [finding] = await tx
    .select({ inputs: misallocation.inputs })
    .from(misallocation)
    .where(and(eq(misallocation.userId, userId), eq(misallocation.key, key)));
  const r = finding ? recordedBy(finding.inputs as Partial<RothIraInputs>) : null;
  if (!r) return;
  await addToIraYear(tx, userId, r.year, r.add, now.toISOString().slice(0, 10));
  await tx.insert(auditEvent).values({
    userId,
    at: now,
    actor: TIDYSUM_SOURCE,
    event: "ira.recorded",
    proposalId,
    data: { finding_key: key, tax_year: r.year, ...r.add },
  });
}

/** Steps for an agent's proposal, from its structured actions. */
function stepsFromActions(actions: ActionRow[]): ActionStep[] {
  return actions.map((a) => {
    if (a.kind === "trade") {
      const side = a.side === "sell" ? "Sell" : "Buy";
      return {
        text: `${side} ${dollars(a.amount, a.currency ?? undefined)} of ${a.symbol}${a.from_account ? ` in ${a.from_account}` : ""}`,
        by: "agent",
        needs_you: SUBMIT,
      };
    }
    const verb = a.kind === "payment" ? "Pay" : "Move";
    return {
      text: `${verb} ${dollars(a.amount, a.currency ?? undefined)} from ${a.from_account ?? "an account"} to ${a.to_account ?? "an account"}`,
      by: "agent",
      needs_you: "Two-factor code",
    };
  });
}

interface ActionRow {
  seq: number;
  kind: "transfer" | "payment" | "trade";
  from_account_id: string | null;
  from_account: string | null;
  to_account_id: string | null;
  to_account: string | null;
  side: "buy" | "sell" | null;
  symbol: string | null;
  amount: string;
  /** The currency of the account the money leaves (or else arrives in). */
  currency: string | null;
}

export interface Action {
  id: string;
  title: string;
  rationale: string;
  state: (typeof proposal.$inferSelect)["state"];
  category: string;
  expected_annual_value: string | null;
  finding_key: string | null;
  source: string;
  validation: { violations: string[]; warnings: string[] };
  steps: ActionStep[];
  snoozed_until: string | null;
  /** Scheduled (decision 0006): not to be carried out before this day. */
  not_before: string | null;
  /** The last day it still does its job. */
  due_by: string | null;
  /** The action this one is a follow-up check of; finishing it confirms that one. */
  follow_up_of: string | null;
  /** A condition it waits for besides its days (decision 0008). */
  wait_for: "calm_markets" | null;
  /** For an action waiting for calm markets: the VIX reading it waits on. */
  market: Calm | null;
  /**
   * The day it waits for: `not_before`, or a later day the owner's agent paused it until (an
   * invite still to come, a paycheck still to land). Null when it waits for no day.
   */
  starts_on: string | null;
  /**
   * What happens next, in a few words: what the agent paused it for, or the first step not done
   * yet. The Actions page leads with it while the action waits or is part done. Null when every
   * step is done.
   */
  next_step: string | null;
  /**
   * What its card leads with instead of its title, when that's the next step (owner,
   * 2026-11-20: a scheduled "Checking earns nothing" didn't say the day's job was to
   * check the paycheck landed): a paused action's next step, and for an approved action about a
   * finding that waits for a day or is part done, its next step when it fits in a headline. The
   * title then goes underneath. Null to lead with the title, as for an action with its own title,
   * which already says what to do.
   */
  headline: string | null;
  /** Where it stands against those days, today: see `timingOf`. Null when it has neither. */
  timing: Timing | null;
  /** Its place in the owner's own order (action_order), or null when they haven't placed it. */
  position: number | null;
  created_at: string;
  decided_at: string | null;
  actions: ActionRow[];
  /** The owner's agent's progress on it, once one has started it (decision 0005). */
  progress: ActionProgress | null;
  /** Who carries it out once approved: see `carriedBy`. */
  carried_by: CarriedBy;
  /** The agent's reports, as stored; `progress` is what they add up to. */
  agent_events?: ProgressEvent[] | null;
  /** The ledger row this action fixes, when it fixes one. */
  finding: {
    id: string;
    key: string;
    detector: string;
    summary: string;
    action: string;
    annual_cost: string;
    account_ids: string[];
    product_id: string | null;
    inputs: Record<string, unknown>;
    state: string;
    realized_annual_value: string | null;
    realized_basis: string | null;
    first_seen_at: string;
  } | null;
}

const ACTION_SELECT = `
  select p.id, p.title, p.rationale, p.state, p.category,
    p.expected_annual_value::numeric(19,2)::text as expected_annual_value, p.finding_key,
    p.source, p.validation, p.steps, p.snoozed_until::text as snoozed_until,
    p.not_before::text as not_before, p.due_by::text as due_by, p.follow_up_of, p.wait_for,
    p.created_at, p.decided_at,
    (select o.position from action_order o
      where o.user_id = p.user_id and o.key = coalesce(p.finding_key, p.id::text)) as position,
    coalesce((
      select json_agg(json_build_object(
        'seq', a.seq, 'kind', a.kind, 'from_account_id', a.from_account_id,
        'from_account', fa.name, 'to_account_id', a.to_account_id, 'to_account', ta.name,
        'side', a.side, 'symbol', a.symbol, 'amount', a.amount::text,
        'currency', coalesce(fa.currency, ta.currency)) order by a.seq)
      from proposal_action a
      left join account fa on fa.id = a.from_account_id
      left join account ta on ta.id = a.to_account_id
      where a.proposal_id = p.id
    ), '[]') as actions,
    (select json_build_object(
        'id', m.id, 'key', m.key, 'detector', m.detector, 'summary', m.summary,
        'action', m.action, 'annual_cost', m.annual_cost::numeric(19,2)::text,
        'account_ids', m.account_ids, 'product_id', m.product_id, 'inputs', m.inputs,
        'state', m.state,
        'realized_annual_value', m.realized_annual_value::numeric(19,2)::text,
        'realized_basis', m.realized_basis, 'first_seen_at', m.first_seen_at)
      from misallocation m where m.key = p.finding_key) as finding,
    (select json_agg(json_build_object(
        'at', e.at, 'actor', e.actor, 'event', e.event, 'data', e.data) order by e.id)
      from audit_event e
      where e.proposal_id = p.id and e.event like 'action.%') as agent_events
  from proposal p`;

export type CarriedBy = "agent" | "tidysum" | "owner";

/**
 * Retirement account elections: the 401(k) contribution rate and which plan funds it holds, set
 * on the plan's own site (owner, 2026-11-13), and an IRA contribution and its Roth conversion
 * (owner, 2026-11-14). No order to buy or sell is placed, so the owner's agent may do them once
 * approved. Emptying the 401(k)'s brokerage window (owner, 2026-11-16) sells its mutual funds, but
 * only to move the money back into the same plan with the same mix: like a plan exchange, it
 * picks no price and owes no tax, so it counts as one.
 */
const PLAN_ELECTIONS = new Set(["retirement_rate", "fund_fee", "brokerage_window", "roth_ira"]);

/**
 * Who carries out an approved action (decision 0005): anything with steps for an agent goes to
 * the owner's agent, trades and other investing included (owner, 2026-11-19): the agent fills in
 * the order in the owner's browser up to the broker's or plan's review screen, and the owner
 * presses Submit. Investing with no steps for an agent waits for Tidysum's own executor (Phase 4),
 * and the rest is the owner's alone. The MCP tools refuse agents anything this doesn't give them.
 */
export function carriedBy(
  a: Pick<Action, "category" | "actions" | "steps"> & {
    finding?: { detector: string } | null;
    finding_key?: string | null;
  },
): CarriedBy {
  const forAgent = a.steps.some((s) => s.by === "agent");
  // A scheduled action can be about a finding that isn't (or isn't yet) in the ledger, like next
  // year's 401(k) percent: its key still names the detector.
  const detector = a.finding?.detector ?? a.finding_key?.split(":")[0];
  const election = !!detector && PLAN_ELECTIONS.has(detector);
  const investing =
    a.actions.some((x) => x.kind === "trade") || (a.category === "securities" && !election);
  if (investing && !forAgent) return "tidysum";
  return forAgent ? "agent" : "owner";
}

export type Timing = "scheduled" | "waiting" | "due" | "overdue";

/**
 * Where an action stands against its days (decision 0006) and what it waits for (decision
 * 0008): `scheduled` before its first day, `waiting` while markets aren't calm for one that waits
 * for them, `overdue` after its last day, `due` in between. Null for an action with neither day
 * nor condition.
 */
export function timingOf(
  a: {
    not_before: string | null;
    due_by: string | null;
    wait_for?: string | null;
    /** A later first day: the day a paused action goes on (see `startsOn`). */
    starts_on?: string | null;
  },
  today: string,
  calm?: Pick<Calm, "calm"> | null,
): Timing | null {
  const first = a.starts_on ?? a.not_before;
  if (!first && !a.due_by && !a.wait_for) return null;
  if (first && first > today) return "scheduled";
  if (a.wait_for === "calm_markets" && !calm?.calm) return "waiting";
  if (a.due_by && a.due_by < today) return "overdue";
  return "due";
}

/** The first day an action may go on: its own, or the later day its agent paused it until. */
export function startsOn(
  notBefore: string | null,
  progress: Pick<ActionProgress, "status" | "paused"> | null,
): string | null {
  const until = progress?.status === "paused" ? (progress.paused?.until ?? null) : null;
  if (!until) return notBefore;
  return !notBefore || until > notBefore ? until : notBefore;
}

/**
 * A step in a few words, for a headline: its first sentence, cut at a word under about 80
 * characters. "Check that a paycheck has landed in Savings" from a step that goes on
 * to say what to do if it hasn't.
 */
export function stepHeadline(text: string): string {
  const clean = firstSentence(text);
  if (clean.length <= HEADLINE_MAX) return clean;
  return `${clean.slice(0, HEADLINE_MAX).replace(/[\s,;:(]+\S*$/, "")}…`;
}

const HEADLINE_MAX = 80;

function firstSentence(text: string): string {
  const first = text.trim().split(/(?<=[a-z0-9)])[.;]\s+(?=[A-Z])/)[0] ?? text;
  return first.replace(/[.;:,\s]+$/, "");
}

/** What a card leads with instead of its title: see `Action.headline`. */
export function headlineOf(
  a: Pick<Action, "state" | "steps" | "timing"> & {
    progress: Pick<ActionProgress, "status" | "paused" | "done"> | null;
    finding: unknown;
  },
): string | null {
  const p = a.progress;
  if (p?.status === "paused" && p.paused?.next) return p.paused.next;
  if (a.state !== "approved" || p?.status === "finished" || !a.finding) return null;
  const waits = a.timing === "scheduled" || a.timing === "waiting" || !!p?.done.length;
  if (!waits) return null;
  const open = a.steps.findIndex((_, i) => !p?.done.includes(i + 1));
  const step = a.steps[open];
  if (!step) return null;
  const line = firstSentence(step.text);
  return line.length <= HEADLINE_MAX ? line : null;
}

/** What happens next on an action: what its agent paused it for, or its first open step. */
export function nextStep(
  steps: ActionStep[],
  progress: Pick<ActionProgress, "status" | "paused" | "done"> | null,
): string | null {
  if (progress?.status === "finished") return null;
  if (progress?.status === "paused" && progress.paused?.next) return progress.paused.next;
  const open = steps.findIndex((_, i) => !progress?.done.includes(i + 1));
  const step = steps[open];
  return step ? stepHeadline(step.text) : null;
}

function shape(row: Action, today: string, calm: Calm | null = null): Action {
  const steps = row.steps?.length ? row.steps : stepsFromActions(row.actions);
  const { agent_events, ...rest } = row;
  const progress = progressFrom(agent_events);
  const starts_on = startsOn(row.not_before, progress);
  const shaped = {
    ...rest,
    steps,
    progress,
    starts_on,
    next_step: nextStep(steps, progress),
    market: row.wait_for === "calm_markets" ? calm : null,
    timing: timingOf({ ...row, starts_on }, today, calm),
  };
  return { ...shaped, headline: headlineOf(shaped), carried_by: carriedBy(shaped) };
}

const value = (a: Action) => new Big(a.expected_annual_value ?? 0);

/**
 * The owner's order first (decision 0005 leaves the order to them): actions they haven't placed
 * yet lead, in Tidysum's own order, so something new is seen; the rest follow where they put them.
 */
function inOwnerOrder(actions: Action[], tidysum: (a: Action, b: Action) => number): Action[] {
  return actions.sort((a, b) => {
    if (a.position === null || b.position === null) {
      return Number(a.position !== null) - Number(b.position !== null) || tidysum(a, b);
    }
    return a.position - b.position || tidysum(a, b);
  });
}

export interface ActionQueue {
  /**
   * Waiting for the owner's decision, in their own order; ones they haven't placed come first,
   * biggest yearly value first.
   */
  queue: Action[];
  /** How many waiting actions "Not now" is holding back. */
  snoozed: number;
  /** Approved, being carried out, in the owner's order: the order to carry them out in. */
  in_progress: Action[];
  /**
   * Approved ahead, waiting for their first day (decision 0006), soonest first, then those
   * waiting for calm markets (decision 0008).
   */
  scheduled: Action[];
  /** Marked done or confirmed by a sync, in the last 90 days, newest first. */
  finished: Action[];
}

/** The owner's actions, as the Actions page and agents see them. Runs as tidysum_agent. */
export async function listActions(db: AgentDb, today: string): Promise<ActionQueue> {
  const { rows } = await db.query<Action>(
    `${ACTION_SELECT}
     where p.state in ('proposed', 'blocked', 'approved')
        or (p.state in ('done', 'confirmed')
            and p.decided_at >= $1::date - ${FINISHED_DAYS})
     order by p.created_at desc`,
    [today],
  );
  const calm = rows.some((r) => r.wait_for === "calm_markets") ? await readCalm(db, today) : null;
  const actions = rows.map((r) => shape(r, today, calm));
  const waiting = actions.filter((a) => a.state === "proposed" || a.state === "blocked");
  const awake = waiting.filter((a) => !a.snoozed_until || a.snoozed_until <= today);
  return {
    queue: inOwnerOrder(
      awake,
      (a, b) =>
        // Blocked ones can't be approved, so they go after everything that can.
        Number(a.state === "blocked") - Number(b.state === "blocked") ||
        value(b).cmp(value(a)) ||
        a.id.localeCompare(b.id),
    ),
    snoozed: waiting.length - awake.length,
    // Rows come newest first, and sort is stable.
    in_progress: inOwnerOrder(
      actions.filter(
        (a) => a.state === "approved" && a.timing !== "scheduled" && a.timing !== "waiting",
      ),
      () => 0,
    ),
    scheduled: actions
      .filter((a) => a.state === "approved" && (a.timing === "scheduled" || a.timing === "waiting"))
      .sort(
        (a, b) =>
          Number(a.timing === "waiting") - Number(b.timing === "waiting") ||
          String(a.starts_on).localeCompare(String(b.starts_on)),
      ),
    finished: actions
      .filter((a) => a.state === "done" || a.state === "confirmed")
      .sort((a, b) => String(b.decided_at).localeCompare(String(a.decided_at))),
  };
}

/**
 * The owner's own order for a list of their actions (dragged on the Actions page), first to last.
 * Each action keeps its place by the finding it fixes, so a fresh draft for the same finding stays
 * put. Ids that aren't the owner's open actions are ignored. Returns how many were placed.
 */
export async function setActionOrder(db: Db, userId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: proposal.id, findingKey: proposal.findingKey })
      .from(proposal)
      .where(
        and(
          eq(proposal.userId, userId),
          inArray(proposal.id, ids),
          inArray(proposal.state, ["proposed", "blocked", "approved"]),
        ),
      );
    const keyOf = new Map(rows.map((r) => [r.id, r.findingKey ?? r.id]));
    const placed = [...new Set(ids)].flatMap((id) => {
      const key = keyOf.get(id);
      return key === undefined ? [] : [key];
    });
    const now = new Date();
    for (const [position, key] of placed.entries()) {
      await tx
        .insert(actionOrder)
        .values({ userId, key, position, setAt: now })
        .onConflictDoUpdate({
          target: [actionOrder.userId, actionOrder.key],
          set: { position, setAt: now },
        });
    }
    return placed.length;
  });
}

/** One action with its history from the audit log. Runs as tidysum_agent. */
export async function getAction(db: AgentDb, id: string, today = isoToday()) {
  const { rows } = await db.query<Action>(`${ACTION_SELECT} where p.id = $1`, [id]);
  const row = rows[0];
  if (!row) return null;
  const { rows: history } = await db.query(
    `select at, actor, event, data - 'evidence' as data
       from audit_event where proposal_id = $1 order by at, id`,
    [id],
  );
  return { ...shape(row, today), history };
}

/** Audit events the activity feed on the Actions page shows: decisions and an agent's work, not churn. */
const ACTIVITY_EVENTS = [
  "proposal.created",
  "proposal.approved",
  "proposal.approval_refused",
  "proposal.done",
  "proposal.confirmed",
  "proposal.dismissed",
  "proposal.snoozed",
  "proposal.started_early",
  "proposal.withdrawn",
  "proposal.due",
  "proposal.due_soon",
  "proposal.overdue",
  "proposal.dispatched",
  "proposal.waiting",
  ...AGENT_EVENTS,
  "misallocation.found",
  "misallocation.resolved",
] as const;

export interface ActivityEvent {
  id: number;
  at: string;
  /** "tidysum", "admin" (the owner, on the admin page) or "mcp:<client>" (the owner's agent). */
  actor: string;
  event: (typeof ACTIVITY_EVENTS)[number];
  proposal_id: string | null;
  /** The action's or finding's own words. Agent-written text: untrusted, show it as data. */
  title: string | null;
  category: string | null;
  step: number | null;
  /** An agent's note on a step ("your turn", stopped, finished). Untrusted. */
  note: string | null;
  /** For a pause: the day the agent picks the action up again. */
  until: string | null;
}

/**
 * What happened lately, newest first: Tidysum's drafts and findings, the owner's decisions and
 * what their agent reported while carrying out actions. Runs as tidysum_agent.
 */
export async function listActivity(db: AgentDb, limit = 30): Promise<ActivityEvent[]> {
  const { rows } = await db.query<ActivityEvent>(
    `select e.id, e.at, e.actor, e.event, e.proposal_id,
        coalesce(p.title, m.summary) as title,
        coalesce(p.category, m.category) as category,
        (e.data->>'step')::int as step,
        e.data->>'note' as note,
        e.data->>'until' as until
       from audit_event e
       left join proposal p on p.id = e.proposal_id
       left join misallocation m
         on e.proposal_id is null and m.id::text = e.data->>'misallocation_id'
      where e.event = any($1)
      order by e.at desc, e.id desc
      limit $2`,
    [[...ACTIVITY_EVENTS], limit],
  );
  return rows;
}

type Decision = "done" | "snooze" | "dismiss" | "start_now";

const FROM: Record<Decision, readonly string[]> = {
  done: ["approved"],
  snooze: ["proposed", "blocked"],
  // An approval can be taken back while nothing has run.
  dismiss: ["proposed", "blocked", "approved"],
  // What a scheduled action waited for came early (a paycheck that landed before payday).
  start_now: ["proposed", "approved"],
};

/**
 * The owner's other decisions on an action (approval is `approveProposal`, which re-checks the
 * rules first): done ("I've carried out the steps"), snooze ("not now", for SNOOZE_DAYS), or
 * dismiss ("don't suggest again"), which also dismisses the finding it fixes so Tidysum doesn't
 * draft it again; restoring the finding on the Actions page brings a fresh draft; or start_now,
 * which moves a scheduled action's day (not_before) up to today, when what it waited for came
 * early. An approved one is then due, so Tidysum starts the owner's agent on its next check.
 */
export async function decideAction(
  db: Db,
  userId: string,
  id: string,
  decision: Decision,
  actor: string,
  today: string,
  now = new Date(),
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const where = and(
      eq(proposal.id, id),
      eq(proposal.userId, userId),
      inArray(proposal.state, [...FROM[decision]] as (typeof proposal.$inferSelect)["state"][]),
    );
    if (decision === "start_now") {
      const [row] = await tx
        .select({ notBefore: proposal.notBefore })
        .from(proposal)
        .where(and(where, gt(proposal.notBefore, today)))
        .for("update");
      if (!row?.notBefore) return false;
      await tx.update(proposal).set({ notBefore: today }).where(where);
      await logDecision(
        tx,
        userId,
        id,
        actor,
        "proposal.started_early",
        { not_before: { from: row.notBefore, to: today } },
        now,
      );
      return true;
    }
    if (decision === "snooze") {
      const until = new Date(`${today}T00:00:00Z`);
      until.setUTCDate(until.getUTCDate() + SNOOZE_DAYS);
      const day = until.toISOString().slice(0, 10);
      const updated = await tx
        .update(proposal)
        .set({ snoozedUntil: day })
        .where(where)
        .returning({ id: proposal.id });
      if (updated.length === 0) return false;
      await logDecision(tx, userId, id, actor, "proposal.snoozed", { until: day }, now);
      return true;
    }
    const updated = await tx
      .update(proposal)
      .set({ state: decision === "done" ? "done" : "dismissed", decidedAt: now })
      .where(where)
      .returning({ id: proposal.id, findingKey: proposal.findingKey });
    const [row] = updated;
    if (!row) return false;
    await logDecision(
      tx,
      userId,
      id,
      actor,
      decision === "done" ? "proposal.done" : "proposal.dismissed",
      {},
      now,
    );
    if (decision === "dismiss" && row.findingKey) {
      const dismissed = await tx
        .update(misallocation)
        .set({ state: "dismissed", decidedAt: now })
        .where(
          and(
            eq(misallocation.userId, userId),
            eq(misallocation.key, row.findingKey),
            eq(misallocation.state, "open"),
          ),
        )
        .returning({ id: misallocation.id, key: misallocation.key });
      for (const m of dismissed) {
        await tx.insert(auditEvent).values({
          userId,
          at: now,
          actor,
          event: "misallocation.dismissed",
          data: { misallocation_id: m.id, key: m.key, via_proposal: id },
        });
      }
    }
    return true;
  });
}

async function logDecision(
  tx: Tx,
  userId: string,
  proposalId: string,
  actor: string,
  event: string,
  data: object,
  at: Date,
) {
  await tx.insert(auditEvent).values({ userId, at, actor, event, proposalId, data });
}
