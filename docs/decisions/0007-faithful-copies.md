# 0007: A cheaper swap copies what the fund actually holds, or isn't made

Date: 2026-11-16
Status: accepted (the owner: "we need to make it a rule in tidysum to faithfully reproduce lower cost
funds/investments instead of just eyeballing it ... that should never be the case again")

## Context

The `fund_fee` detector proposed swapping the owner's 401(k) "The 2055 Retirement Fund" (0.27% a
year) for 55% U.S. Large Cap Equity Index, 35% International Equity Index and 10% Diversified
Bond Index, and said it "keeps the mix". It didn't. The 55/35/10 came from a generic Vanguard
glide path in `catalog/securities.json` that Tidysum used for any target-date fund without a
ticker, counted only by asset class. The fund's own fact sheet (Principal, 2026 target) holds
46.28% U.S. large caps, 11.56% U.S. small and mid caps, 31.16% international stocks and 11.00%
bonds. The swap dropped the small and mid caps and over-weighted international stocks, and the owner
only found out by asking.

The brokerage-window move (PR #70) had the same flaw at a smaller scale: it copied a global real
estate fund as "57% US stocks, 43% international stocks" in the plan's broad index funds, which
hold almost no real estate.

## Decision

1. **A swap is built from the fund's own published holdings.** For a fund that holds more than one
   kind of thing (a target-date fund, a balanced fund), the breakdown comes from its fact sheet or
   prospectus and is recorded with where it came from and the date it is for (`mix`,
   `mix_source`, `mix_as_of` on the plan's lineup; `mix`, `source_url`, `mix_as_of` in the
   catalog). A generic glide path is never used to copy a fund. It still counts the portfolio by
   class on the Investments page, where an estimate does no harm.
2. **Copies are matched sleeve by sleeve.** A breakdown names sleeves inside an asset class where
   they matter (`us_stocks.large`, `us_stocks.small_mid`, `us_stocks.real_estate`). Each sleeve
   goes to the cheapest plan fund holding exactly that sleeve and nothing else. A broader or
   neighbouring fund never stands in: an S&P 500 fund is copied by a large-cap index fund, a US
   total-market fund only by a fund recorded as the same thing, a real estate fund only by a real
   estate fund. Percentages are whole numbers by largest remainder, so each is within a point of
   what the fund holds.
3. **Unknown means ask, not guess.** When a fund that costs more than something in the plan has no
   recorded breakdown, or a several-sleeve breakdown older than about a year (target-date funds
   move every January), Tidysum makes no swap and asks for the fact sheet: a note on the Actions
   page that the owner's agent acts on by recording the mix. A finding already open stays as it
   was until then, rather than closing as if acted on.
4. **What can't be copied stays, unless the owner says otherwise.** A sleeve the plan has no fund
   for is not papered over: that fund isn't swapped (a note says why), and in a brokerage window
   it stays in the window while the funds the plan can copy move. Selling it anyway changes the
   mix, so it is the owner's call, recorded per ticker (`window_also_sell` in the plan's facts):
   its money then goes in the same split as the rest of the window, and the action says so.
   A finding that goes away because a copy can't be made is withdrawn, never counted as acted on;
   a fund swap or window move counts as done only once the funds it sells are gone.
5. **Show both sides.** Every swap's action shows, sleeve by sleeve, what the fund holds and what
   the copy puts in each plan fund, with the fact sheet and its date, so a wrong copy is visible
   before it's approved.

## Consequences

- The owner's 2055 swap becomes 46% U.S. Large Cap Equity Index, 12% U.S. Small/Mid Cap Equity Index,
  31% International Equity Index and 11% Diversified Bond Index (about 0.02% a year).
- The brokerage-window move copies the S&P 500 fund with the large-cap index fund. Principal's
  lineup has no real estate fund, so the global real estate fund can't be copied; the owner chose to
  sell it anyway with its money split like the rest ("just sell it and allocate proportionate with
  the rest", 2026-11-16), recorded as `window_also_sell: ["SFREX"]`.
- A copy of a target-date fund doesn't glide toward bonds by itself. The owner's plan does that
  with new money (the owner's plan), and the action says so.
- Recording a plan now takes a little more: each held fund's breakdown from its fact sheet, and
  sleeve names on the index funds (`us_stocks.large`, not `us_stocks`).
- Outside a plan (decision 0012), a fund in a brokerage or IRA is only swapped for a catalog fund
  recorded as copying the same thing (`tracks`: the same index, or indexes that hold the same
  market the same way). A fund nothing else copies isn't compared.
