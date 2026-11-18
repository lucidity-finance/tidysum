# 0003: The misallocation loop is the architecture

Date: 2026-10-30
Status: accepted (the owner: "the goal of this project is to find any misallocated liquidity and
calculate how much that misallocation is costing and attempt to allocate it optimally. both mine
and other people's", then "not just liquidity but rather general financial misallocation")

## Decision

Tidysum exists to find money that is in the wrong place, say what that costs per year, and move
it to the right place, for its operator and later for other users. Every feature is one step of
this loop, per user:

1. **Find.** Detectors read synced data and flag a misallocation: cash above the buffer
   earning less than it could, a checking or savings account with fees or a low rate, a card
   that earns less than another on where the money is actually spent, card interest that a
   payment would stop, extra debt payments, investments off their target.
2. **Price.** Each finding states its cost in dollars per year, from observed data (interest
   actually credited, fees actually charged, spending actually made), with its inputs, so the
   number can be checked. A finding without a dollar figure is a warning, not a misallocation.
   Findings are ranked by that cost.
3. **Propose.** The fix is a proposal: its actions, the finding it fixes (`finding_key`), its
   expected yearly value (`expected_annual_value`), its category, the policy version, and the
   data it was checked against (the `evidence` in its audit event).
4. **Approve.** The user approves each proposal. No standing approval for other users.
5. **Act.** Execution happens on the user's own rails (the Robinhood agentic account for trades,
   later bank transfers), or the user acts themselves, for example opening a better savings
   account. Execution re-validates against the data at that moment.
6. **Verify.** Later syncs confirm the money moved and measure the value actually realized.
   Expected versus realized value is how Tidysum proves it works and, later, how it is priced
   (decision 0002, principle 4).

## Consequences

- A detector is only done when it produces a yearly dollar cost. "You are 97% in metals" is a
  warning until it says what the drift costs; "your checking earns 0% on $6,000, a 4% account
  would earn $240/yr" is a misallocation.
- Detectors live where their data lives (`src/policy/engine.ts` for cash, cards and debt from
  the policy; `src/products/` for accounts and cards compared with catalogs), but they emit one
  shape, so one tool can rank everything a user could fix:
  `{ key, category, summary, annual_cost, currency, account_ids, inputs }`.
- Categories (`cash`, `card`, `debt`, `securities`) follow decision 0002, principle 8.
  `securities` findings and proposals are investment advice, so they only run for users with
  `app_user.investing_enabled`, which is reserved for someone managing their own money until
  Tidysum is a registered adviser.
- Execution and verification (steps 5 and 6) are Phase 4. They add an execution record per
  proposal and a realized value next to the expected one.

## Done so far

- Steps 1 to 3 for policy findings: `check_policy` findings carry a stable `key`; proposals store
  `category`, `expected_annual_value` and `finding_key`; the audit event keeps the snapshot as
  `evidence`; investing is gated per user.
- Policy findings carry `category` and, where the data prices them, `annual_cost`: a card
  statement costs a year of its APR or the interest actually charged over the last year,
  whichever is more; an extra debt payment saves its amount times the APR. Cash above the buffer
  is priced by the deposit-rate detector, not here, so it isn't counted twice. Allocation drift
  stays unpriced: a dollar figure would be a guess about future returns.
- Pricing for accounts and cards exists in `compare_products` and `compare_cards`.
- Find and propose for allocation (2026-11-03): `get_allocation` and the Investments page compare
  holdings with the target, splitting funds across asset classes from `catalog/securities.json`,
  and suggest moves as percentages only (the owner asked not to see dollar amounts). Drift stays
  unpriced, so it sits beside the ranked list rather than in it.
- Allocation by new money (2026-11-06): the owner doesn't want to sell holdings they believe in to
  rebalance, "unless something really doesn't make sense", and wants contributions directed like
  an adviser would. The page now leads with where each new contribution goes (only to buckets
  under target, until they catch up) and shows no sells; selling moves stay in `get_allocation`
  for when they ask. Holdings no source reaches (TreasuryDirect) are entered by hand
  (`manual_holding`).

## Next

- A `find_misallocations` MCP tool that runs every detector and ranks findings by yearly cost,
  with the recommendation record from decision 0002 so each finding can be traced to an outcome.
- Phase 4: execution and realized value. Approval exists: the owner approves a proposal on the
  finding it fixes, which re-checks it and records `approved` with evidence.
