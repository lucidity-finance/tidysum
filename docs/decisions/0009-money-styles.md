# 0009: Money styles fill the policy from a well-known philosophy

Date: 2026-11-19
Status: accepted (the owner: "tidysum can offer different money allocation/investment/saving
personas ... you select a persona, and tidysum changes your advice and actions based on the
persona you chose", then, on naming the people behind each, "can we put in parentheses typical
advisors who advocate that philosophy/style?")

## Context

People already know the big money philosophies and pick one by feel. Writing a policy by hand
asks them to choose a buffer, a debt order and a target mix one number at a time.

## Decision

1. **A style is a preset for the policy, nothing more.** Picking one writes its cash buffer, card
   and debt rules, target mix and drift band into the policy (`applyStyle` in
   `src/policy/styles.ts`); the checks still read only the policy, so every finding and action is
   explained by a rule the owner can see and change. Parts a style has no view on (All weather
   says nothing about cash; Safety first has no single mix) keep the owner's settings. Accounts,
   limits, the research sleeve, extra tickers and asset location (`taxable_new_money`) always stay.
2. **Neutral names, advocates as description.** Each style is named for the idea, with the people
   known for it after it ("Debt-free first", known from Dave Ramsey). Wherever styles are listed,
   Tidysum says it isn't affiliated with or endorsed by any of them, and uses no photos, logos or
   "Dave's plan" wording.
3. **Faithful to the published rules, and honest about the rest.** Each style lists its rules,
   how Tidysum applies each, the sources, and what it leaves to the owner and their agent
   (`left_to_you`), such as Ramsey's pause on investing during the debt snowball or the FIRE
   savings rate. Agents see these through `get_policy` and `list_styles` and keep advice in the
   style's spirit.
4. **The policy remembers its style.** `style: { id, age? }` labels the policy; the page and
   `get_policy` compare the policy with the style's preset and list the owner's tweaks. A policy
   with no `style` is the owner's own rules, and nothing changes for it.
5. **Only the owner switches.** On the Plan page (a preview of every change, then a confirm) or
   with `tidysum policy style <id>`. MCP can list styles but not apply one: an agent never rewrites
   the rules it is checked against.

## The styles

| Style            | Buffer                              | Spare cash          | Cards       | Mix                                                                                             | Sources                                    |
| ---------------- | ----------------------------------- | ------------------- | ----------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Adviser standard | 3 months                            | highest rate first  | unchanged   | stocks by age: 90% until 40, 50% at 65, 30% from 72; 60% US / 40% intl                          | Vanguard Target Retirement prospectuses    |
| Debt-free first  | $1,000 while in debt, then 3 months | smallest debt first | avoid       | 75% US, 25% intl (four fund types, 25% each)                                                    | Ramsey Solutions: 7 Baby Steps, fund types |
| Index and chill  | 6 months                            | highest rate first  | unchanged   | age in bonds; stocks 60% US / 40% intl                                                          | Bogleheads three-fund; Bogle Center        |
| Early retirement | 1 month                             | highest rate first  | unchanged   | 100% US stocks (JL Collins' wealth-building phase)                                              | JL Collins; Early Retirement Now           |
| All weather      | unchanged                           | unchanged           | unchanged   | 30% stocks, 40% long and 15% intermediate Treasuries, 7.5% gold, 7.5% commodities; 2-point band | Dalio via Tony Robbins                     |
| Safety first     | 8 months                            | highest rate first  | pay in full | unchanged                                                                                       | Suze Orman                                 |

Where a source gives a range (Ramsey's 3 to 6 months, Orman's 8 to 12), the style starts at the
low end; the owner can raise it.

## Update 2026-11-20: "Adviser standard" replaces "Classic 60/40"

The owner: "the classic 60/40 isn't actually representative of what most money managers/financial
advisors/wealth managers would do. we need that card to represent the strategy that nearly all
financial advisors/wealth managers/money managers do."

A fixed 60/40 is a benchmark and the mix of balanced funds, not what a typical adviser sets up for
a saver. The industry's default is an age-based glide path: it is how target-date funds work
($4.8 trillion at the end of 2025, Morningstar's 2026 Target-Date Fund Landscape), and advisers,
robo-advisers and their model portfolios start from the same idea (more stocks when retirement is
far away, steadily more bonds as it nears), then nudge it for the client's risk tolerance.

The style copies the largest series, Vanguard Target Retirement (37% of target-date assets), from
its own documents:

- **Stocks by age**, retiring at 65: 90% until 40, then a straight line to 50% at 65, then to
  30% seven years after retirement, where the Income fund stays (Vanguard's 2026 series fact
  sheet). Its January 2026 summary prospectuses (allocations at 2025-09-30) sit on that line
  within about 1.5 points of market drift: 2045 fund 83.5% stocks, 2040 76.2%, 2035 68.6%, 2030
  60.8%, 2025 50.7%, 2020 36.5%, Income 31.4%. Morningstar's median for the youngest savers is 93%.
- **40% of the stocks international** (every vintage: 37.1 of 91.5, 33.8 of 83.5, 20.6 of 50.7).
  Bonds, hedged international and inflation-protected ones included, are one bucket.
- **Cash and debt:** three to six months of expenses for an income shock (Vanguard); the style
  starts at 3, as with the other ranges here. Spare cash goes to the highest-rate debt.
- Stock share is rounded to a whole percent, and the US part too, so the card reads cleanly.

The mix is fixed at the age given when the style is picked; picking it again with a new age steps
it down. A stored `style: { id: "classic_60_40" }` label is dropped on read, so such a policy keeps
its rules and shows as the owner's own.

## New policy rules

- `debt.extra_payments: "smallest_balance"`: the debt snowball. Mortgages are left out.
- `cash.buffer_while_in_debt`: the buffer while there is consumer debt (a loan other than a
  mortgage, or a card that charged interest in the last year).
- `cards.avoid_credit_cards`: no `card_wallet` or `card_usage` findings. Open ones are withdrawn
  (not counted as fixed); card statements are still checked.

Also fixed on the way: extra payments (both orders) skip cards that charged no interest in the
last year. Paying such a card early saves nothing, so the old `highest_apr` finding priced a
saving that wasn't there.

## Not done

- Rebalancing by selling on a schedule (Adviser standard, All weather): Tidysum still steers new
  money first and suggests sells only when asked. The style says so in `left_to_you`.
- Ramsey's pause on investing while in debt, and savings-rate targets: advice for the agent, not
  enforced.
- Tax-loss harvesting.
