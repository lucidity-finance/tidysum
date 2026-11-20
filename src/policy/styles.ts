import Big from "big.js";
import { type Policy, PolicySchema, STYLE_IDS, type StyleId } from "./policy.js";

// Money styles (decision 0009): well-known ways of running your money, each a preset that fills
// in the policy's rules. Picking one rewrites the cash buffer, card and debt rules and the target
// mix it has a view on, and leaves the rest of the policy (accounts, limits, research sleeve)
// alone. The checks only ever read the policy, so every action stays explained by a rule the
// owner can see and change. Each style follows its advocates' published rules; where Tidysum
// can't carry a rule out, it says so in `left_to_you`.

type Buffer = Policy["cash"]["buffer"];
type Bucket = Policy["allocation"] extends infer A
  ? A extends { buckets: Record<string, infer B> }
    ? B
    : never
  : never;

/** The parts of a policy a style has a view on. Anything left out keeps the owner's setting. */
export interface StylePreset {
  cash?: { buffer: Buffer; buffer_while_in_debt?: { amount: string } };
  cards?: { avoid_credit_cards: boolean };
  debt?: { extra_payments: Policy["debt"]["extra_payments"] };
  allocation?: { drift_band: string; buckets: Record<string, PresetBucket> };
}

interface PresetBucket {
  target: string;
  tickers: string[];
  asset_classes?: string[];
  cash_equivalents?: boolean;
  security_types?: Bucket["security_types"];
}

export interface MoneyStyle {
  id: StyleId;
  name: string;
  /** Who is known for it, said as a description only: Tidysum isn't affiliated with any of them. */
  advocates: string;
  /** A few words for the card, like "Pay off every debt, then invest". */
  tagline: string;
  summary: string;
  /** What the style says, each with how Tidysum applies it. */
  rules: { rule: string; applied: string }[];
  /** Rules Tidysum can't carry out itself, for the owner or their agent to keep in mind. */
  left_to_you: string[];
  sources: { title: string; url: string }[];
  /** The style's mix depends on the owner's age. */
  needs_age?: boolean;
  /** Said beside the age field, like "Bonds match your age". */
  age_note?: string;
  preset(opts: { age?: number }): StylePreset;
}

export const NOT_AFFILIATED =
  "Styles are named for the ideas, with the people known for them in parentheses. Tidysum isn't " +
  "affiliated with or endorsed by any of them, and a style is a starting point, not advice.";

// Tickers a bucket counts by name; funds the security catalog knows are counted anyway.
const US = ["VTI", "VOO", "ITOT", "SCHB", "FSKAX", "FXAIX", "SPY", "IVV", "VTSAX"];
const INTL = ["VXUS", "IXUS", "FTIHX", "VEA", "VWO", "SCHF", "VTIAX"];
const BONDS = ["BND", "AGG", "FXNAX", "SCHZ", "BNDX", "VBTLX"];
const METALS = ["GLDM", "GLD", "IAU", "SLV", "SIVR", "PALL", "PPLT"];

const us = (target: string): PresetBucket => ({
  target,
  tickers: US,
  security_types: ["equity"],
});
const intl = (target: string): PresetBucket => ({ target, tickers: INTL });
const bonds = (target: string): PresetBucket => ({
  target,
  tickers: BONDS,
  cash_equivalents: true,
});
const commodities = (target: string): PresetBucket => ({ target, tickers: METALS });

/**
 * Funds listed where the owner lives, put ahead of the US ones in a style's buckets so a new
 * contribution buys them (the first ticker held, or else the first one, is what gets bought).
 * The US tickers stay, so what the owner already holds is still counted. In Canada, Canadian
 * stocks sit in the international bucket: everything outside the US is international to these
 * styles' mixes. Each fund's make-up is in catalog/securities.json.
 */
const LOCAL: Record<string, Map<string[], string[]>> = {
  CA: new Map([
    [US, ["XUU", "VUN", "VFV", "XUS", "ZSP"]],
    [INTL, ["XEF", "VIU", "XEC", "VEE", "XIC", "VCN", "ZCN"]],
    [BONDS, ["ZAG", "VAB", "XBB"]],
  ]),
};

function localize(preset: StylePreset, country: string | undefined): StylePreset {
  const local = country ? LOCAL[country] : undefined;
  if (!local || !preset.allocation) return preset;
  const buckets = Object.fromEntries(
    Object.entries(preset.allocation.buckets).map(([name, b]) => {
      const own = local.get(b.tickers);
      return [name, own ? { ...b, tickers: [...own, ...b.tickers] } : b];
    }),
  );
  return { ...preset, allocation: { ...preset.allocation, buckets } };
}

/** Buckets for a stocks-and-bonds mix; zero-target buckets still count what is held there. */
const mix = (u: string, i: string, b: string) => ({
  us_stocks: us(u),
  intl_stocks: intl(i),
  bonds_and_cash: bonds(b),
  commodities: commodities("0"),
});

/**
 * The share in stocks at an age, as a whole percent: Vanguard Target Retirement's glide path, for
 * someone retiring at 65. 90% until 40, then a straight line to 50% at 65 (its funds 5, 10, 15
 * and 20 years out sit on that line, give or take market drift), then to 30% seven years after
 * retirement, where the Income fund stays.
 */
export function glidePath(age: number): Big {
  let pct: Big;
  if (age <= 40) pct = new Big(90);
  else if (age <= 65) pct = new Big(90).minus(new Big(age - 40).times("1.6"));
  else if (age < 72) pct = new Big(50).minus(new Big(age - 65).times(20).div(7));
  else pct = new Big(30);
  return pct.round(0, Big.roundHalfUp).div(100);
}

export const STYLES: readonly MoneyStyle[] = [
  {
    id: "adviser_standard",
    name: "Adviser standard",
    advocates: "most advisers and target-date funds",
    tagline: "An adviser's plan, without the fee",
    summary:
      "The age-based mix the industry treats as best practice: mostly stocks while you're young, " +
      "steadily more bonds as retirement nears, with a share of the stocks abroad.",
    rules: [
      {
        rule: "Hold more stocks the further you are from retirement: about 90% until 40, 50% at 65, and 30% from about 72.",
        applied:
          "Your age sets the stock share on the glide path of Vanguard Target Retirement, the largest target-date series: " +
          "90% until 40, 1.6 points less each year to 50% at 65, then down to 30% at 72.",
      },
      {
        rule: "Keep about 40% of the stocks international, and the rest of the money in a broad bond mix.",
        applied:
          "Stocks are split 60% US and 40% international. Bonds, including inflation-protected ones near retirement, are one bucket.",
      },
      {
        rule: "Keep three to six months of expenses in an emergency fund, and pay off high-interest debt.",
        applied:
          "The buffer is 3 months of your average spending (raise it to 6 if your income is uneven); spare cash goes to the highest-rate debt first.",
      },
      {
        rule: "Rebalance when the mix drifts, checking about once a year.",
        applied:
          "New money goes to whatever is under target. A bucket is flagged when it drifts 5 points.",
      },
    ],
    left_to_you: [
      "The path assumes you stop working around 65. An adviser would also nudge it a step up or down for how much risk you can live with; change the targets if you want that.",
      "The mix is worked out for the age you give. Pick the style again with your new age each year or so and it steps down.",
      "Advisers also harvest tax losses and put bonds in tax-advantaged accounts first.",
      "Rebalancing may mean selling; Tidysum suggests sells only when you ask for them.",
    ],
    sources: [
      {
        title: "Vanguard Target Retirement 2045 Fund, summary prospectus (January 2026)",
        url: "https://www.sec.gov/Archives/edgar/data/752177/000119312526025002/f43868d1.htm",
      },
      {
        title: "Vanguard Target Retirement Income Fund, summary prospectus (January 2026)",
        url: "https://www.sec.gov/Archives/edgar/data/752177/000119312526025010/f43862d1.htm",
      },
      {
        title: "Vanguard Target Retirement series fact sheet (2026)",
        url: "https://workplace.vanguard.com/content/dam/inst/iig-transformation/tdf/TDF_table_2026.pdf",
      },
      {
        title: "Morningstar: 2026 Target-Date Fund Landscape",
        url: "https://www.morningstar.com/content/cs-assets/v3/assets/blt9415ea4cc4157833/blte992700d742269f9/69b06bd2cb63a70008937aaf/Target_Date_Fund_Landscape_2026.pdf",
      },
      {
        title: "Vanguard: What's the right emergency fund amount?",
        url: "https://investor.vanguard.com/investor-resources-education/emergency-fund/whats-the-right-emergency-fund-amount",
      },
    ],
    needs_age: true,
    age_note: "The mix follows your age",
    preset: ({ age }) => {
      if (age === undefined)
        throw new Error("Adviser standard needs your age: its mix follows your age");
      const stocks = glidePath(age);
      const u = stocks.times("0.6").round(2, Big.roundHalfUp);
      return {
        cash: { buffer: { months_of_spending: 3 } },
        debt: { extra_payments: "highest_apr" },
        allocation: {
          drift_band: "0.05",
          buckets: mix(
            u.toString(),
            stocks.minus(u).toString(),
            new Big(1).minus(stocks).toString(),
          ),
        },
      };
    },
  },
  {
    id: "debt_free_first",
    name: "Debt-free first",
    advocates: "Dave Ramsey",
    tagline: "Pay off every debt, then invest",
    summary:
      "Clear every debt but the house before investing, smallest balance first, with a small " +
      "cash cushion until then. Then a full emergency fund and an all-stock mix.",
    rules: [
      {
        rule: "Save a $1,000 starter emergency fund (Baby Step 1).",
        applied: "While you have debt other than a mortgage, the cash buffer is $1,000.",
      },
      {
        rule: "Pay off all debt except the house with the debt snowball, smallest balance first (Baby Step 2).",
        applied:
          "Cash above the buffer goes to your smallest debt first, whatever its rate. Mortgages are left out.",
      },
      {
        rule: "Then save 3 to 6 months of expenses (Baby Step 3).",
        applied:
          "Once the debt is gone, the buffer becomes 3 months of your average spending. Raise it to 6 if you like.",
      },
      {
        rule: "Don't use credit cards.",
        applied:
          "Tidysum stops suggesting new cards or moving bills onto cards, and still makes sure statements get paid.",
      },
      {
        rule: "Invest evenly across growth and income, growth, aggressive growth and international funds.",
        applied:
          "Three of the four are US stock funds, so the mix is 75% US stocks and 25% international, with no bonds.",
      },
    ],
    left_to_you: [
      "Pause investing, even a 401(k) match, while paying off debt; then invest 15% of household income for retirement (Baby Step 4).",
      "Save for children's college (Baby Step 5), then pay off the home early (Baby Step 6).",
      "Ramsey picks actively managed funds through an investing pro; Tidysum counts any fund by what it holds and suggests low-cost index funds.",
    ],
    sources: [
      {
        title: "Ramsey Solutions: The 7 Baby Steps",
        url: "https://www.ramseysolutions.com/dave-ramsey-7-baby-steps",
      },
      {
        title: "Ramsey Solutions: How to choose the right mutual funds",
        url: "https://www.ramseysolutions.com/retirement/how-to-choose-the-right-mutual-funds",
      },
    ],
    preset: () => ({
      cash: { buffer: { months_of_spending: 3 }, buffer_while_in_debt: { amount: "1000.00" } },
      cards: { avoid_credit_cards: true },
      debt: { extra_payments: "smallest_balance" },
      allocation: { drift_band: "0.05", buckets: mix("0.75", "0.25", "0") },
    }),
  },
  {
    id: "index_and_chill",
    name: "Index and chill",
    advocates: "Jack Bogle, the Bogleheads",
    tagline: "Three index funds, held for good",
    summary:
      "Three low-cost index funds (US stocks, international stocks, bonds), roughly your age in " +
      "bonds, bought and held. Never time the market.",
    rules: [
      {
        rule: "Hold a total US stock fund, a total international stock fund and a total bond fund.",
        applied: "Three buckets, with the usual index funds for each.",
      },
      {
        rule: "Hold roughly your age in bonds.",
        applied:
          "Bonds are your age in percent. Stocks are split 60% US and 40% international, as Vanguard's LifeStrategy funds do.",
      },
      {
        rule: "First keep an emergency fund, take any employer match and pay off high-interest debt.",
        applied:
          "The buffer is 6 months of your average spending (how many is personal), and spare cash goes to the highest-rate debt first.",
      },
      {
        rule: "Rebalance rarely, with new money where you can.",
        applied:
          "New money goes to whatever is under target. A bucket is flagged when it drifts 5 points.",
      },
    ],
    left_to_you: [
      "Keep costs and taxes low: favor funds with tiny expense ratios, and hold bonds in tax-advantaged accounts.",
      "Stay the course in downturns. Don't sell to time the market.",
    ],
    sources: [
      {
        title: "Bogle Center: Prioritizing investments",
        url: "https://boglecenter.net/bogleheads-chapter-series-prioritizing-investments/",
      },
      {
        title: "Money Crashers: Bogleheads 3-fund portfolio",
        url: "https://www.moneycrashers.com/bogleheads-3-fund-portfolio/",
      },
    ],
    needs_age: true,
    age_note: "Bonds match your age",
    preset: ({ age }) => {
      if (age === undefined)
        throw new Error("Index and chill needs your age: it holds your age in bonds");
      const bond = new Big(age).div(100);
      const stocks = new Big(1).minus(bond);
      const u = stocks.times("0.6");
      return {
        cash: { buffer: { months_of_spending: 6 } },
        debt: { extra_payments: "highest_apr" },
        allocation: {
          drift_band: "0.05",
          buckets: mix(u.toString(), stocks.minus(u).toString(), bond.toString()),
        },
      };
    },
  },
  {
    id: "early_retirement",
    name: "Early retirement",
    advocates: "the FIRE movement, Mr. Money Mustache, JL Collins",
    tagline: "Save hard, all in stocks",
    summary:
      "A very high savings rate, all in a total US stock market index fund, and a small cash " +
      "cushion, so the money works as hard as it can.",
    rules: [
      {
        rule: "While building wealth, hold 100% in a total US stock market fund (JL Collins' VTSAX).",
        applied: "The mix is 100% US stocks.",
      },
      {
        rule: "Big cash piles are a drag; keep only what daily life and real emergencies need.",
        applied: "The buffer is 1 month of your average spending.",
      },
      {
        rule: "Get rid of high-interest debt.",
        applied: "Spare cash goes to the highest-rate debt first.",
      },
    ],
    left_to_you: [
      "Save as much of your income as you can; the savings rate decides how soon you can stop working.",
      "Aim for about 25 times your yearly spending (the 4% rule).",
      "Closer to stopping work, JL Collins moves to 75% stocks and 25% bonds.",
    ],
    sources: [
      {
        title: "JL Collins: The smoother path to wealth",
        url: "https://jlcollinsnh.com/2012/09/21/the-smoother-path-to-wealth/",
      },
      {
        title: "Early Retirement Now: The emergency fund is still useless",
        url: "https://earlyretirementnow.com/2021/05/26/the-emergency-fund-is-still-useless/",
      },
    ],
    preset: () => ({
      cash: { buffer: { months_of_spending: 1 } },
      debt: { extra_payments: "highest_apr" },
      allocation: { drift_band: "0.05", buckets: mix("1", "0", "0") },
    }),
  },
  {
    id: "all_weather",
    name: "All weather",
    advocates: "Ray Dalio, as popularized by Tony Robbins",
    tagline: "Steady through any economy",
    summary:
      "Fixed weights that balance risk across growth, recession, inflation and deflation: " +
      "mostly Treasuries, some stocks, gold and commodities.",
    rules: [
      {
        rule: "30% stocks, 40% long-term Treasuries, 15% intermediate Treasuries, 7.5% gold, 7.5% commodities.",
        applied:
          "Five buckets with those targets. Bond funds Tidysum can't tell apart count as long-term.",
      },
      {
        rule: "Rebalance to the fixed weights regularly.",
        applied:
          "The buckets are small, so one is flagged when it drifts 2 points. New money goes to whatever is under target.",
      },
    ],
    left_to_you: [
      "The style says nothing about cash or debt, so your buffer, card and debt rules stay as they are.",
      "Rebalancing back to the weights may mean selling; Tidysum suggests sells only when you ask.",
    ],
    sources: [
      {
        title: "Money Crashers: Ray Dalio's All Weather portfolio",
        url: "https://www.moneycrashers.com/ray-dalio-all-weather-portfolio/",
      },
    ],
    preset: () => ({
      allocation: {
        drift_band: "0.02",
        buckets: {
          us_stocks: us("0.3"),
          long_treasuries: {
            target: "0.4",
            tickers: ["TLT", "VGLT", "SPTL", "EDV", "GOVZ"],
            asset_classes: ["bonds"],
          },
          intermediate_treasuries: {
            target: "0.15",
            tickers: ["IEF", "VGIT", "SCHR", "SPTI", "IEI"],
            asset_classes: ["intermediate_treasuries"],
          },
          gold: {
            target: "0.075",
            tickers: ["GLDM", "GLD", "IAU", "SGOL", "AAAU"],
            asset_classes: ["gold"],
          },
          commodities: { target: "0.075", tickers: ["PDBC", "DBC", "GSG", "BCI", "CMDY"] },
          intl_stocks: intl("0"),
          cash: { target: "0", tickers: [], cash_equivalents: true },
        },
      },
    }),
  },
  {
    id: "safety_first",
    name: "Safety first",
    advocates: "Suze Orman",
    tagline: "A big cushion before anything",
    summary:
      "A big emergency fund of at least 8 months, no credit card debt, and only then investing.",
    rules: [
      {
        rule: "Keep an emergency fund of 8 to 12 months of expenses.",
        applied: "The buffer is 8 months of your average spending.",
      },
      {
        rule: "Have no credit card debt whatsoever.",
        applied:
          "Every statement is paid in full, and spare cash goes to the highest-rate debt first.",
      },
    ],
    left_to_you: [
      "Orman suggests using savings to pay down a card whose rate is at least 4 points above what the savings earn, while keeping enough to feel secure.",
      "The style has no single investment mix, so your target mix stays as it is.",
    ],
    sources: [
      {
        title: "Suze Orman: Stop living life on borrowed money",
        url: "https://www.suzeorman.com/blog/stop-living-life-on-borrowed-money/",
      },
      {
        title: "The Motley Fool: Suze Orman changed her mind on emergency savings",
        url: "https://www.fool.com/the-ascent/personal-finance/articles/suze-orman-changed-her-mind-on-emergency-savings-you-should-too/",
      },
    ],
    preset: () => ({
      cash: { buffer: { months_of_spending: 8 } },
      cards: { avoid_credit_cards: false },
      debt: { extra_payments: "highest_apr" },
    }),
  },
];

export function findStyle(id: string): MoneyStyle {
  const style = STYLES.find((s) => s.id === id);
  if (!style) throw new Error(`unknown style "${id}"; one of: ${STYLE_IDS.join(", ")}`);
  return style;
}

/** A starting policy for someone with none yet: the example's limits and no accounts named. */
const BLANK: Policy = PolicySchema.parse({
  version: 1,
  cash: { buffer: { months_of_spending: 3 } },
});

/**
 * The policy `current` becomes with `id`'s preset: the style's rules replace the owner's where it
 * has a view, the rest is kept. Same-named buckets keep the owner's extra tickers and where new
 * money may buy them; buckets the style doesn't name stay at a zero target, so what they hold is
 * still counted.
 */
export function applyStyle(
  current: Policy | null,
  id: StyleId,
  opts: { age?: number; country?: string } = {},
) {
  const style = findStyle(id);
  const country = opts.country === "US" ? undefined : opts.country;
  const preset = localize(style.preset(opts), country);
  const base = current ?? BLANK;
  const next: Record<string, unknown> = {
    ...base,
    style: {
      id,
      ...(style.needs_age && opts.age !== undefined ? { age: opts.age } : {}),
      ...(country && LOCAL[country] ? { country } : {}),
    },
  };
  if (preset.cash) {
    const { buffer_while_in_debt: _old, ...cash } = base.cash;
    next.cash = { ...cash, ...preset.cash };
  }
  if (preset.cards) {
    const { avoid_credit_cards: _old, ...cards } = base.cards;
    next.cards = {
      ...cards,
      pay_statement_in_full: true,
      ...(preset.cards.avoid_credit_cards ? { avoid_credit_cards: true } : {}),
    };
  }
  if (preset.debt) next.debt = { ...base.debt, ...preset.debt };
  if (preset.allocation) next.allocation = mergeAllocation(base, preset.allocation);
  return PolicySchema.parse(next);
}

function mergeAllocation(base: Policy, preset: NonNullable<StylePreset["allocation"]>) {
  const mine = base.allocation;
  const sleeve = new Set((base.research_sleeve?.tickers ?? []).map((t) => t.toUpperCase()));
  // A ticker the style puts in one bucket can't stay listed in another.
  const claimed = new Map<string, string>();
  for (const [name, b] of Object.entries(preset.buckets)) {
    for (const t of b.tickers) claimed.set(t.toUpperCase(), name);
  }
  const free = (name: string) => (t: string) => {
    const owner = claimed.get(t.toUpperCase());
    return !sleeve.has(t.toUpperCase()) && (owner === undefined || owner === name);
  };
  const buckets: Record<string, Bucket> = {};
  for (const [name, b] of Object.entries(preset.buckets)) {
    const old = mine?.buckets[name];
    const tickers = dedupe([...(old?.tickers ?? []), ...b.tickers]).filter(free(name));
    buckets[name] = {
      target: b.target,
      tickers,
      taxable_new_money: old?.taxable_new_money ?? true,
      cash_equivalents: b.cash_equivalents ?? old?.cash_equivalents ?? false,
      security_types: b.security_types ?? old?.security_types ?? [],
      ...(b.asset_classes ? { asset_classes: b.asset_classes } : {}),
    };
  }
  for (const [name, b] of Object.entries(mine?.buckets ?? {})) {
    if (buckets[name]) continue;
    buckets[name] = { ...b, target: "0", tickers: b.tickers.filter(free(name)) };
  }
  return {
    ...(mine ?? {}),
    drift_band: preset.drift_band,
    buckets,
  };
}

const dedupe = (list: string[]) => {
  const seen = new Set<string>();
  return list.filter((t) => {
    const k = t.toUpperCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

// Saying what a change does, in plain words ------------------------------------------------------

const pct = (fraction: string) => `${new Big(fraction).times(100).toString()}%`;
const dollars = (amount: string) =>
  `$${new Big(amount)
    .round(0)
    .toFixed(0)
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;

export function describeBuffer(b: Buffer): string {
  if ("amount" in b) return dollars(b.amount);
  return `${b.months_of_spending} month${b.months_of_spending === 1 ? "" : "s"} of spending`;
}

const ORDER: Record<Policy["debt"]["extra_payments"], string> = {
  none: "stays as cash",
  highest_apr: "goes to the highest-rate debt",
  smallest_balance: "goes to the smallest debt",
};

/** "75% US stocks, 25% international stocks", in the policy's order, buckets at zero left out. */
export function describeMix(allocation: Policy["allocation"]): string {
  if (!allocation) return "no target mix";
  return Object.entries(allocation.buckets)
    .filter(([, b]) => new Big(b.target).gt(0))
    .map(([name, b]) => `${pct(b.target)} ${name.replace(/_and_/g, " and ").replace(/_/g, " ")}`)
    .join(", ")
    .replace(/\bus\b/g, "US")
    .replace(/\bintl\b/g, "international");
}

/** The rules a style sets, said the same way for any policy, so two policies can be compared. */
function facts(p: Policy): Record<string, string> {
  return {
    "Cash buffer": describeBuffer(p.cash.buffer),
    "While in debt": p.cash.buffer_while_in_debt
      ? `${dollars(p.cash.buffer_while_in_debt.amount)} buffer`
      : "no separate buffer",
    "Spare cash": ORDER[p.debt.extra_payments],
    "Credit cards": p.cards.avoid_credit_cards
      ? "avoid them"
      : p.cards.pay_statement_in_full
        ? "pay in full, use for rewards"
        : "no rule",
    "Target mix": describeMix(p.allocation),
    "Drift flagged at": p.allocation ? `${pct(p.allocation.drift_band)} off target` : "n/a",
  };
}

export interface Change {
  rule: string;
  from: string;
  to: string;
}

/** What differs between two policies, in the terms a style sets. */
export function changesBetween(from: Policy | null, to: Policy): Change[] {
  const before = from ? facts(from) : {};
  return Object.entries(facts(to)).flatMap(([rule, value]) =>
    before[rule] === value ? [] : [{ rule, from: before[rule] ?? "not set", to: value }],
  );
}

export interface StyleStatus {
  id: StyleId;
  name: string;
  advocates: string;
  age?: number;
  /** Where the policy now differs from the style it started from. */
  tweaks: Change[];
}

/** The style a policy was filled from and what the owner changed since, or null for their own rules. */
export function styleStatus(policy: Policy): StyleStatus | null {
  const label = policy.style;
  if (!label) return null;
  const style = findStyle(label.id);
  let pure: Policy;
  try {
    pure = applyStyle(policy, label.id, {
      ...(label.age !== undefined ? { age: label.age } : {}),
      ...(label.country ? { country: label.country } : {}),
    });
  } catch {
    return { id: style.id, name: style.name, advocates: style.advocates, tweaks: [] };
  }
  return {
    id: style.id,
    name: style.name,
    advocates: style.advocates,
    ...(label.age !== undefined ? { age: label.age } : {}),
    tweaks: changesBetween(pure, policy),
  };
}

/** Every style, with what picking it would change in `current`. */
/** What a policy amounts to, at a glance: the mix as parts of a bar, and its key rules. */
export interface Glance {
  /** Buckets with a target, in the policy's order; null without an allocation. */
  mix: { key: string; label: string; percent: string }[] | null;
  cash: string;
  /** "$1,000 until debt-free", when the buffer is smaller until the debt is gone. */
  while_in_debt: string | null;
  debt: string | null;
  cards: string | null;
}

const bucketLabel = (key: string) =>
  key
    .replace(/_and_/g, " & ")
    .replace(/_/g, " ")
    .replace(/\bus\b/, "US")
    .replace(/\bintl\b/, "intl")
    .replace(/^./, (c) => c.toUpperCase());

export function glance(p: Policy): Glance {
  const mix = p.allocation
    ? Object.entries(p.allocation.buckets)
        .filter(([, b]) => new Big(b.target).gt(0))
        .map(([key, b]) => ({
          key,
          label: bucketLabel(key),
          percent: new Big(b.target).times(100).toString(),
        }))
    : null;
  const buffer = p.cash.buffer;
  return {
    mix,
    cash:
      "amount" in buffer
        ? `${dollars(buffer.amount)} cushion`
        : `${buffer.months_of_spending}-month cushion`,
    while_in_debt: p.cash.buffer_while_in_debt
      ? `${dollars(p.cash.buffer_while_in_debt.amount)} until debt-free`
      : null,
    debt:
      p.debt.extra_payments === "smallest_balance"
        ? "Smallest debt first"
        : p.debt.extra_payments === "highest_apr"
          ? "Highest rate first"
          : null,
    cards: p.cards.avoid_credit_cards ? "No credit cards" : null,
  };
}

export function listStyles(current: Policy | null, opts: { age?: number; country?: string } = {}) {
  const age = opts.age ?? current?.style?.age;
  const { country } = opts;
  return {
    current: current ? styleStatus(current) : null,
    /** The owner's rules as they are now, for the "Your own rules" card. */
    mine: current ? glance(current) : null,
    note: NOT_AFFILIATED,
    styles: STYLES.map((s) => {
      const { preset: _preset, ...about } = s;
      if (s.needs_age && age === undefined) {
        // Only the mix depends on the age; the other rules can be shown already.
        const rules = glance(
          applyStyle(current, s.id, { age: 40, ...(country ? { country } : {}) }),
        );
        return { ...about, changes: null, result: { ...rules, mix: null } };
      }
      const next = applyStyle(current, s.id, {
        ...(age !== undefined ? { age } : {}),
        ...(country ? { country } : {}),
      });
      return { ...about, changes: changesBetween(current, next), result: glance(next) };
    }),
  };
}
