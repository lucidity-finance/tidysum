# 0005: Bring your own agent; the owner decides one action at a time in Tidysum

Date: 2026-11-12
Status: accepted (the owner: "users should just be able to sign off on each of the things ... present
things like user friendly, like actions one by one, where the user just confirms, and then the
agent goes and does that", then "the agent should be able to do almost everything", identity
checks aside). Revised the same day to bring-your-own-agent only (the owner: "people bring their own
agent ... there's not two agents ... it becomes agent agnostic"), keeping approval and trades in
Tidysum.

## Decision

1. **No built-in agent.** Tidysum is the system of record and the rails, not a second agent. It
   holds the data (linked accounts), the knowledge (catalogs, the plan, the dollar math behind
   each finding), the action layer (proposals, approval, audit, verification) and the trade
   executor. The thinking and the hands-on work come from the owner's own agent: Claude, ChatGPT,
   Claude Code or any MCP client. For someone who doesn't run agents, "their agent" is just the
   assistant app they already use, with Tidysum added as a connector. Talking an idea through
   happens there too: the admin page has no chat (decision 0002, principle 1).
2. **Thin agent, thick tools.** Whatever has to be right every time is plain code in Tidysum:
   detection and pricing, the policy limits, the approval gate, the audit record, trades, and
   checking afterwards that a fix worked. The agent explains, weighs trade-offs and fills in
   forms.
3. **One action layer.** Every action, whoever thought of it, is a proposal. The owner's agent
   and Tidysum's detectors only suggest. Only the owner approves, on Tidysum's Actions page.
   There is no approve tool over MCP, because Tidysum can't tell whether a person or a model
   clicked a client's confirm prompt.
4. **Tidysum drafts an action for every open finding**, with its steps, after each detection
   (`src/actions/actions.ts`). This is a scheduled loop in code, not an agent: agents act only
   when asked, so something has to notice a new paycheck or a worse rate on its own. An agent's
   proposal for the same finding replaces the draft. Steps say who does each (`by: agent`
   for the owner's agent, `you` for the owner alone) and what only the owner can do
   (`needs_you`).
5. **One decision on screen at a time.** The Actions page shows the waiting actions one card at a
   time, biggest yearly value first until the owner drags them into their own order (kept per
   user in `action_order`, by finding, and followed by `list_actions` too, 2026-11-16): Approve, Not now (back in a week), Don't suggest again (also
   dismisses the finding). The Actions page is also the home page (2026-11-12): what the open
   findings cost, the card to decide with the rest of the queue beside it, what the owner's agent
   is doing with approved ones, and what a sync has confirmed. There is no separate findings list
   to decide from; the Plan page stays.
   Investing has a card too (owner, 2026-11-12: "shouldn't the investment stuff also be part of
   those cards?"): while the mix is under target, one action says where new money goes, in
   percentages with the fund to buy, never amounts or selling. While a bucket is outside the
   drift band it carries what the drift costs a year (decision 0012), otherwise no yearly value;
   it is confirmed when the mix reaches its target.
6. **States.** `proposed` → `approved` → `done` → `confirmed`, where `confirmed` means a later
   sync shows the finding went away because it was acted on (decision 0003, step 6). A waiting
   action whose finding goes away for another reason is withdrawn (`dismissed`, audited as
   `proposal.withdrawn`).
7. **Who carries out an approved action.**
   - **Trades: the owner's agent prepares, the owner submits** (owner, 2026-11-19: "it should be
     able to also place trades ... you end up clicking the button"). An approved buy, sell or
     fund exchange, the new-money action included, goes to the owner's agent like any other
     action. It fills in the order on the broker's or plan's own site, in the owner's browser,
     up to the final review screen, and hands over (`your_turn`, needs_you "Review the order and
     press Submit"); the owner checks it and presses Submit. The agent never presses the button
     that places an order: Tidysum can't see that button, so the human press is the enforcement.
     This is how the owner's 401(k) rebalance was done on 2026-11-16.
   - **Later, trades by Tidysum (Phase 4).** Plain code would place the order through the
     broker's API, re-validate against current data, be idempotent, and be the only holder of
     the broker login. Only investing actions with no steps for an agent wait for it.
   - **Workplace-plan elections: the owner's agent** (owner, 2026-11-13). Changing the 401(k)
     contribution rate, or which plan funds hold the balance and new paychecks, is done on the
     plan's own site with no brokerage order, so it goes to the owner's agent like any other
     approved action (`carriedBy` in `src/actions/actions.ts`, detectors `retirement_rate` and
     `fund_fee`). Emptying the plan's
     brokerage window back into the plan (detector `brokerage_window`, owner, 2026-11-16) sells
     mutual funds in the window, but only to put the same mix back in the same plan, tax-free
     and at the day's closing price, so it counts as a plan exchange and goes to the agent too.
   - **IRA contributions: the owner's agent** (owner, 2026-11-14). A Roth IRA contribution, or a
     backdoor Roth (a traditional IRA contribution converted to Roth), moves cash between the
     owner's own accounts with no order to buy or sell, so it goes to the owner's agent too
     (detector `roth_ira`). Plaid can't tell which tax year a contribution counts for, so
     finishing the action records it in `ira_year`, and the next detection confirms it.
   - **Everything else: the owner's agent**, using its own browser or computer tools: opening an
     account, moving bills onto a card, setting up autopay, moving cash. MCP tools let it work
     one approved action at a time: start it, report each step done, hand a step to the owner
     ("your turn") for identity checks, two-factor codes, SSN and signatures, and finish. Tidysum
     records each report in the audit log and shows progress on the Actions page, and a later
     sync confirms the fix. Tidysum can't see or stop what an outside agent does in a browser,
     so it enforces only what passes through it: an action can't start unless it is approved,
     and its result is checked against the accounts.
   - **A packaged skill** (instructions for the agent, shipped in this repo) says how to work an
     approved action: one at a time, only on its institutions' sites and within its amounts,
     stop and hand over for anything identity-related, never pass the owner's secrets to
     Tidysum, report every step. It is guidance, not a second agent, and any agent can follow it.
   - Automated actions are for the operator only for now: some banks forbid automated access,
     and doing it for others raises liability and adviser questions.

## Build order

1. Actions queue, no money moves (done: PRs #46 and #47).
2. Agent-carried actions over MCP (done): `start_action`, `report_step` (done or your turn),
   `finish_action` and `stop_action`, progress on the Actions page, and the packaged skill
   `skills/tidysum-actions` (also the MCP prompt `carry_out_action`). First job: the operator's agent opens the
   better-paying savings account behind a `deposit_rate` action and moves the spare cash there.
3. Trades prepared by the owner's agent up to the review screen, submitted by the owner (done,
   2026-11-19). Trades placed by Tidysum's own executor stay Phase 4 (needs the agentic
   Robinhood account and the spike).
   Actions with a day (approve ahead, Tidysum watches the date and can start the owner's agent)
   are [decision 0006](0006-scheduled-actions.md).
4. Standing rules for the operator ("invest each paycheck by my plan up to $X"). Decision 0003
   rules out standing approval for other users only.
5. Other people's agents and accounts: with productization, on hold.
