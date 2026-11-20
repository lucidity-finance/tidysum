# 0012: Fees, idle cash and drift priced in every brokerage

Date: 2026-11-20
Status: accepted (the owner, quoting the list of what Tidysum didn't check: "other brokerage fund
fees, idle brokerage cash and allocation are not priced yet ... we should fix this")

## Context

Investment fees were priced only inside a recorded workplace plan (`fund_fee`) and its brokerage
window (`brokerage_window`), where the plan's own lineup says what a fund can be swapped for and a
swap owes no tax. Three things a wealth manager looks at stayed unpriced:

- funds in an ordinary brokerage or IRA that cost more than another fund holding the same thing;
- cash left uninvested in a brokerage, which at most brokerages earns 0.01% or nothing;
- a mix that drifted from its target, which decision 0003 left without a dollar figure, since
  pricing it by expected returns would be a guess about which asset class does better.

## Decision

Three detectors, in `src/portfolio/brokerage.ts`, for every investment account that isn't a
workplace plan or its window. They are investment advice, so they run only with investing on.

1. **`holding_fee`: a cheaper fund that holds the same thing.** Faithful or not made (decision
   0007): a catalog fund names what it copies in `tracks` (`sp500`, `nasdaq100`, `us_total_market`,
   `gold_bullion`, `ftse_100` ...). Two funds with the same `tracks` hold the same companies in
   about the same weights, and only such a fund is offered. A fund nothing else copies (a sector
   or theme ETF) is never compared, however dear. The copy must be listed where the owner buys
   funds (`fundMarket`: a UK owner gets a UK-listed UCITS fund, never a US ETF), and in the US it
   is an ETF, since one family's mutual funds cost a fee at another brokerage. Fees come from the
   SEC's data for US funds and from the catalog otherwise.
   **Tax decides whether to sell.** In an IRA, 401(k)-style account, ISA, SIPP, TFSA, RRSP or
   similar, a swap owes nothing. In a taxable account a position below what was paid sells for no
   tax. At a gain, a US owner's swap is suggested only when the lower fee pays back the tax (15%
   federal long-term rate, assumed) within two years; otherwise Tidysum says to keep it and buy
   the cheaper fund with new money. Outside the US, selling at a gain isn't suggested, since those
   countries' capital gains rules aren't modeled. A brokerage that doesn't report cost basis leaves
   the swap undecided. Selling a mutual fund leaves the money out of the market until it settles,
   so that swap waits for calm markets (decision 0008); an ETF swap is sold and bought the same day.
2. **`brokerage_cash`: uninvested cash.** Cash Plaid reports as cash with no fund ticker
   (`CUR:USD`) is idle; a money market fund a brokerage uses as its cash (VMFXX, SPAXX) is a fund
   and isn't flagged. What the brokerage pays comes from `brokerage_cash` in
   `catalog/securities.json`, from its own rate page, including a membership that raises it
   (Robinhood Gold, recorded in the owner's IRA facts as `memberships`). The alternative is the
   country's cash fund (SGOV in the US) at the cash yardstick (Treasury bill, BoC bill, SONIA,
   €STR) less its fee. A brokerage the catalog doesn't list leaves the cash undecided rather than
   assumed to earn nothing. The action invests the cash toward the target mix the way the
   new-money action splits paychecks, with only what should stay cash in the fund; it is priced
   at the cash gap alone, which is a fact, not at what investing might earn.
3. **`allocation_drift`: risk the owner didn't choose.** While a bucket is outside the drift band,
   the drift is priced as the risk-adjusted return given up, without a return forecast: with the
   target taken as the owner's best mix, holding target + d instead costs ½·γ·dᵀΣd a year, where
   Σ comes from published volatilities and correlations (J.P. Morgan's 2026 Long-Term Capital
   Market Assumptions, in `risk` in the catalog) and γ is what the owner's own target pays per
   unit of risk (its expected return over cash divided by its variance). The cost is never
   negative, the same whichever way the mix drifted, and small: a 60/40 mix ten points heavy in
   stocks costs about 0.04% of the portfolio a year. The fix is the new-money action, which now
   carries this yearly value; nothing is sold.

## Consequences

- The ranked list now covers fees and idle cash in every account and drift outside the band, so a
  small total isn't mistaken for nothing to fix. What's still out: funds no catalog fund copies,
  brokerages whose cash rate isn't listed, and brokerages that report cash only in the balance.
- The catalog carries more facts to keep current: `tracks` and fees for funds outside the SEC's
  data (QQQ, gold trusts, UCITS and Canadian ETFs), brokerage cash rates, and the risk figures
  (refresh them when J.P. Morgan publishes its next assumptions).
