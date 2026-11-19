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
| Debt-free first  | $1,000 while in debt, then 3 months | smallest debt first | avoid       | 75% US, 25% intl (four fund types, 25% each)                                                    | Ramsey Solutions: 7 Baby Steps, fund types |
| Index and chill  | 6 months                            | highest rate first  | unchanged   | age in bonds; stocks 60% US / 40% intl                                                          | Bogleheads three-fund; Bogle Center        |
| Early retirement | 1 month                             | highest rate first  | unchanged   | 100% US stocks (JL Collins' wealth-building phase)                                              | JL Collins; Early Retirement Now           |
| Classic 60/40    | 6 months                            | highest rate first  | unchanged   | 36% US, 24% intl, 40% bonds (Vanguard LifeStrategy MG)                                          | VSMGX prospectus                           |
| All weather      | unchanged                           | unchanged           | unchanged   | 30% stocks, 40% long and 15% intermediate Treasuries, 7.5% gold, 7.5% commodities; 2-point band | Dalio via Tony Robbins                     |
| Safety first     | 8 months                            | highest rate first  | pay in full | unchanged                                                                                       | Suze Orman                                 |

Where a source gives a range (Ramsey's 3 to 6 months, Orman's 8 to 12), the style starts at the
low end; the owner can raise it.

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

- Rebalancing by selling on a schedule (Classic 60/40, All weather): Tidysum still steers new
  money first and suggests sells only when asked. The style says so in `left_to_you`.
- Ramsey's pause on investing while in debt, and savings-rate targets: advice for the agent, not
  enforced.
- Tax-loss harvesting.
