# 0014: Croatia: what an obrt and d.o.o. owner loses to how they are paid

Date: 2026-11-24
Status: proposed

## Context

Decision 0011 gave each user a country and switched US tax checks off elsewhere, leaving EU tax
wrappers "country by country" for later. For an owner in Croatia the biggest misallocation is
usually not a savings rate but tax: the same client work billed through an obrt dohodaš or a
d.o.o. leaves very different amounts in the owner's hands.

2026 rules (sources in `src/croatia/rules.ts`, checked 2026-11-24):

- d.o.o. profit tax 10% up to EUR 1,000,000 of revenue, 18% above; dividends to a resident 12%,
  final, no allowance.
- Income tax: personal allowance EUR 600 a month; the city's lower rate up to EUR 60,000 a year and
  its higher rate above (Zagreb 23% and 33%, NN 28/2025).
- Employment: pension 15% + 5% out of gross pay, health 16.5% on top.
- Obrt dohodaš: pension 20% and health 16.5% on a monthly base of last year's income / 12, between
  EUR 1,295.45 and EUR 11,958.00 (0.65 and 6 times the 2026 average wage); contributions are
  deducted from the income they are paid from.
- III. stup: the state adds 15% of up to EUR 663.61 contributed a year (EUR 99.54).
- Capital gains on shares and fund units 12%, none after holding them two years.

## Decision

1. **A calculator over facts the owner gives, not a detector over synced data.** Open banking
   doesn't say what an invoice was for or what the books' profit is, so the check reads a facts file
   (CLI) or tool input (MCP) with yearly figures from the books. It stores nothing and moves nothing.
2. **The loop's find and price steps, in euros a year** (decision 0003), in one finding shape with
   its inputs. The obrt is modeled in steady state (this year's income sets next year's base).
   Findings are each alone; the best combined scenario is reported beside them, since they overlap.
3. **Honest about what it doesn't price.** Moving work into the company pays less into the owner's
   pension; every billing finding says how much. Insurance, sick pay and contracts aren't priced,
   and every report says to confirm with an accountant.
4. **Rules are public facts with sources and a checked date,** per year, overridable in the file
   (city rates, contribution bases). A year without rules uses the newest, with a warning.
5. **Dividends across borders are investment advice, so gated.** With no US treaty in force, a US
   dividend to a Croatian resident loses 30% at source, and Croatia credits that only against its
   own 12%. An Irish accumulating UCITS fund loses 15% on its US dividends inside the fund (the
   Ireland-US treaty) and pays nothing in Croatia until it is sold, and nothing then after two
   years. The check prices each holding against that, and warns when US stocks and US funds near
   the USD 60,000 US estate tax limit for non-US persons. It runs for the owner's own CLI, and over
   MCP only with `app_user.investing_enabled` (decision 0002, principle 8). The holding-period list
   only says when a gain becomes tax-free.
6. **Personal figures stay out of the repository.** The facts go in `croatia.json` (git-ignored)
   or straight to the MCP tool; `croatia.example.json` holds made-up numbers only.

## Still to do

- Record findings in the misallocation ledger (a `tax` category and a facts table with an agent
  grant), so expected and realized savings are followed like the others.
- When the US-Croatia treaty enters into force (15% on dividends), set `us_treaty_in_force` and
  the rates in `src/croatia/rules.ts`.
- The JOPPD for dividends the company pays out.
- Other EU countries' owner rules, the same way.
