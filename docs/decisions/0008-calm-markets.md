# 0008: A sale that leaves the market waits for calm markets

Date: 2026-11-16
Status: accepted (the owner: "isn't it best to sell when volatility is low?", then "yeah that is best";
and for the window's money, "it should match the 2055 fund")

## Context

Moving the Schwab brokerage window in the owner's 401(k) back into the plan means selling the window's
funds, waiting for the sale to settle, and buying the plan's index funds with the cash: a few
days out of the market. On a jumpy day prices swing widely between the sale and the buy, so the
money can come back noticeably smaller (or bigger). In a calm stretch the gap is small. Nothing in
Tidysum knew what the market was doing, so an approved sale ran whenever the owner's agent was
next asked.

## Decision

1. **An action can wait for calm markets.** `wait_for: "calm_markets"` on a proposal holds it,
   like a `not_before` day (decision 0006), but for a condition. Detectors set it on a finding
   (`inputs.wait_for`); the owner's agent can set it with `schedule_action`. It is the only
   condition for now, enforced by a CHECK.
2. **Calm is the VIX, read every hour.** While `tidysum serve` runs, Tidysum records past closes
   from FRED (series `VIXCLS`, free, no key) at most every twelve hours, and today's level from
   Cboe's delayed quote every hour, into `market_reading`. Markets count as calm when the last
   five closes are each at or below 20, about the VIX's long-run average, no close in the last
   fifteen (about three weeks) is above 25, and the newest is at most four days old. A few quiet
   days after a spike aren't enough, because a spike's aftershocks come in the weeks after it, and
   an old reading (both sources down, the Mac asleep) never counts as calm.
3. **Approve ahead; it starts when calm.** The owner can approve a waiting action at any time. It
   sits under **Scheduled** with the latest VIX close, `start_action` refuses it, and the hourly
   check (decision 0006) leaves it alone. The first hour markets are calm, it turns due: the owner
   gets a "markets are calm" notification and an approved agent action goes to the owner's agent,
   within waking hours. Not approved yet, the notification asks for approval. If markets turn
   jumpy again before it's done, it goes back to waiting, `start_action` refuses it again, and the
   owner is told ("markets turned jumpy"); the next calm stretch makes it due afresh.
4. **It is a wait, not a forecast.** Tidysum doesn't predict the market or time a purchase of new
   money: paychecks and new money are invested when they arrive. Only a sale whose money comes
   straight back into the market waits, because there the days between are the risk.
5. **The brokerage-window move waits.** It is the first action with the condition. Its money also
   follows the owner's paycheck choice: with `paychecks_mirror` set, the window's money goes into
   the same copy of that plan fund (for the owner, 46% U.S. Large Cap Index, 12% U.S. Small/Mid Cap
   Index, 31% International Index and 11% Bond Index, a copy of The 2055 Retirement Fund), and
   the action says it changes the mix from what the window holds. Without it, the window's own
   funds are copied sleeve by sleeve (decision 0007).

## Consequences

- A waiting action can sit for weeks in a long stretch of high volatility. The Scheduled list
  shows the latest close, so it's clear why.
- Tidysum makes an outbound request an hour to Cboe and two a day to FRED. A failed fetch only
  delays calm; it never makes it calm.

## Revision, 2026-11-17

The first rule (three closes at or below 20 from FRED alone) called markets calm on the evening
of Monday 2026-11-16. FRED had closes only through Friday (19.30), the three before that were
just under 20, and a spike to 28.18 on Nov 5 was eleven days back. That Monday the VIX closed at
22.91 (24.52 at its high) as tech stocks sold off ahead of Nvidia's results. The owner: "wait i thought
markets were volatile currently". Hence today's level from Cboe, five closes instead of three, and
no spike above 25 in about three weeks. By the new rule the earliest calm day after the Nov 5
spike is around Nov 27.
- The VIX describes the US stock market. It is a fair stand-in for a sale of US and global stock
  funds; a bond-only sale wouldn't need to wait.
